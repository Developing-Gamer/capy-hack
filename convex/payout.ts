import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, MutationCtx, query } from "./_generated/server";
import { whop } from "./whop";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Transfer = { id: string; status: "processing" | "succeeded" | "failed"; failure_code: string | null; failure_reason: string | null };

async function endRoom(ctx: MutationCtx, roomId: Id<"rooms">, winnerId: Id<"players">) {
  const existing = await ctx.db.query("payouts").withIndex("by_room", (q) => q.eq("roomId", roomId)).unique();
  if (existing) return existing._id;
  const room = await ctx.db.get(roomId);
  if (!room) throw new Error("No such room");
  if (room.status !== "playing") throw new Error(`Room is ${room.status}, not playing`);
  const winner = await ctx.db.get(winnerId);
  if (!winner || winner.roomId !== roomId) throw new Error("The winner is not in this room");
  await ctx.db.patch(roomId, { status: "done", winnerId });
  const payoutId = await ctx.db.insert("payouts", { roomId, winnerId, amount: room.pot, currency: "usd", status: "sending" });
  await ctx.scheduler.runAfter(0, internal.payout.send, { payoutId });
  return payoutId;
}

/** Ends the room with its sole survivor and pays them the pot. Called by the trial runner; safe to call more than once. */
export const settle = internalMutation({
  args: { roomId: v.id("rooms"), winnerId: v.id("players") },
  handler: (ctx, { roomId, winnerId }) => endRoom(ctx, roomId, winnerId),
});

/** Dev only: ends a playing room with a chosen winner so the payout can be tested without playing. Refused against production Whop. */
export const devEnd = mutation({
  args: { code: v.string(), winnerId: v.id("players") },
  handler: async (ctx, { code, winnerId }) => {
    if (process.env.WHOP_ENVIRONMENT === "production") throw new Error("devEnd is disabled in production");
    const room = await ctx.db.query("rooms").withIndex("by_code", (q) => q.eq("code", code.toUpperCase())).unique();
    if (!room) throw new Error("No room with that code");
    return endRoom(ctx, room._id, winnerId);
  },
});

/** Re-sends an owed payout, for example after the Whop key gains the payout:transfer_funds scope. Reuses the same idempotency key. */
export const retry = internalMutation({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => {
    const payout = await ctx.db.query("payouts").withIndex("by_room", (q) => q.eq("roomId", roomId)).unique();
    if (!payout || payout.status !== "owed") return null;
    await ctx.db.patch(payout._id, { status: "sending", reason: undefined });
    await ctx.scheduler.runAfter(0, internal.payout.send, { payoutId: payout._id });
    return payout._id;
  },
});

export const forSend = internalQuery({
  args: { payoutId: v.id("payouts") },
  handler: async (ctx, { payoutId }) => {
    const payout = await ctx.db.get(payoutId);
    if (!payout) return null;
    const winner = await ctx.db.get(payout.winnerId);
    return { ...payout, winnerName: winner!.name, paymentId: winner!.paymentId };
  },
});

export const record = internalMutation({
  args: {
    payoutId: v.id("payouts"),
    status: v.union(v.literal("processing"), v.literal("paid"), v.literal("owed")),
    whopUserId: v.optional(v.string()),
    transferId: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { payoutId, ...fields }) => {
    await ctx.db.patch(payoutId, fields);
  },
});

const outcome = (t: Transfer) => (t.status === "succeeded" ? "paid" : t.status === "failed" ? "owed" : "processing");

/** Moves the pot from the company balance to the winner's Whop user, found through their buy-in payment. */
export const send = internalAction({
  args: { payoutId: v.id("payouts") },
  handler: async (ctx, { payoutId }) => {
    const payout = await ctx.runQuery(internal.payout.forSend, { payoutId });
    if (!payout || payout.status !== "sending") return null;
    let whopUserId: string | undefined;
    try {
      if (!payout.paymentId) throw new Error(`${payout.winnerName} has no buy-in payment on record`);
      const payment: { user: { id: string } | null } = await whop(`/payments/${payout.paymentId}`);
      whopUserId = payment.user?.id;
      if (!whopUserId) throw new Error(`Payment ${payout.paymentId} has no Whop user`);
      let transfer: Transfer = await whop("/transfers", {
        method: "POST",
        headers: { "Idempotency-Key": payoutId },
        body: JSON.stringify({
          type: "balance",
          origin_id: process.env.WHOP_COMPANY_ID,
          destination_id: whopUserId,
          amount: payout.amount,
          currency: payout.currency,
          idempotence_key: payoutId,
          notes: `Meat Market pot: sole survivor ${payout.winnerName}`,
          metadata: { room_id: payout.roomId, player_id: payout.winnerId },
        }),
      });
      console.log("Whop transfer", JSON.stringify(transfer));
      for (let i = 0; i < 10 && transfer.status === "processing"; i++) {
        await sleep(3000);
        transfer = await whop(`/transfers/${transfer.id}`);
      }
      await ctx.runMutation(internal.payout.record, {
        payoutId,
        status: outcome(transfer),
        whopUserId,
        transferId: transfer.id,
        reason: transfer.failure_reason ?? transfer.failure_code ?? undefined,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error("Whop payout failed", reason);
      await ctx.runMutation(internal.payout.record, { payoutId, status: "owed", whopUserId, reason });
    }
    return null;
  },
});

export const room = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const room = await ctx.db.query("rooms").withIndex("by_code", (q) => q.eq("code", code.toUpperCase())).unique();
    if (!room) return null;
    const players = await ctx.db.query("players").withIndex("by_room", (q) => q.eq("roomId", room._id)).collect();
    const payout = await ctx.db.query("payouts").withIndex("by_room", (q) => q.eq("roomId", room._id)).unique();
    return { room, players, payout };
  },
});
