import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, mutation } from "./_generated/server";
import { whop } from "./whop";

export const player = internalQuery({
  args: { playerId: v.id("players") },
  handler: async (ctx, { playerId }) => {
    const player = await ctx.db.get(playerId);
    if (!player) return null;
    const room = await ctx.db.get(player.roomId);
    return { ...player, buyIn: room!.buyIn };
  },
});

export const saveCheckout = internalMutation({
  args: { playerId: v.id("players"), planId: v.string() },
  handler: async (ctx, { playerId, planId }) => {
    await ctx.db.patch(playerId, { planId });
  },
});

export const markPaid = internalMutation({
  args: { playerId: v.id("players"), paymentId: v.string() },
  handler: async (ctx, { playerId, paymentId }) => {
    const player = await ctx.db.get(playerId);
    if (!player || player.paid) return;
    const room = await ctx.db.get(player.roomId);
    await ctx.db.patch(playerId, { paid: true, paymentId });
    await ctx.db.patch(player.roomId, { pot: room!.pot + room!.buyIn });
  },
});

export const start = action({
  args: { playerId: v.id("players"), returnTo: v.string() },
  handler: async (ctx, { playerId, returnTo }): Promise<string | null> => {
    const player = await ctx.runQuery(internal.buyin.player, { playerId });
    if (!player || player.paid) return null;
    const redirect = new URL("/buyin/return", process.env.CONVEX_SITE_URL);
    redirect.searchParams.set("player", playerId);
    redirect.searchParams.set("to", returnTo);
    const checkout = await whop("/checkout_configurations", {
      method: "POST",
      body: JSON.stringify({
        account_id: process.env.WHOP_COMPANY_ID,
        metadata: { player_id: playerId, room_id: player.roomId },
        redirect_url: redirect.toString(),
        variant: {
          title: "Waiver of life and limb",
          initial_price: player.buyIn,
          currency: "usd",
          billing_type: "one_time",
          force_create_new_plan: true,
        },
      }),
    });
    await ctx.runMutation(internal.buyin.saveCheckout, { playerId, planId: checkout.variant.id });
    return checkout.purchase_url;
  },
});

export const confirm = action({
  args: { playerId: v.id("players") },
  handler: async (ctx, { playerId }): Promise<boolean> => {
    const player = await ctx.runQuery(internal.buyin.player, { playerId });
    if (!player?.planId) return false;
    if (player.paid) return true;
    const query = new URLSearchParams({ account_id: process.env.WHOP_COMPANY_ID!, variant_id: player.planId, status: "paid" });
    const payments: { data: { id: string; status: string; variant_id: string; metadata: { player_id?: string } | null }[] } =
      await whop(`/payments?${query}`);
    const payment = payments.data.find(
      (p) => p.status === "paid" && p.variant_id === player.planId && p.metadata?.player_id === playerId,
    );
    if (!payment) return false;
    await ctx.runMutation(internal.buyin.markPaid, { playerId, paymentId: payment.id });
    return true;
  },
});

/** Dev only: signs a player without a Whop checkout, for multi-client testing. Refused against production Whop. */
export const devSign = mutation({
  args: { playerId: v.id("players") },
  handler: async (ctx, { playerId }) => {
    if (process.env.WHOP_ENVIRONMENT === "production") throw new Error("devSign is disabled in production");
    await ctx.runMutation(internal.buyin.markPaid, { playerId, paymentId: "dev" });
    return null;
  },
});
