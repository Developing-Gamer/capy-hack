import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, type MutationCtx, query } from "./_generated/server";
import { GAMES, type SeatInfo } from "./games";

/** The run, in order. Keys are game keys; "payout" ends the run. */
export const TRIALS = ["dinner", "machine", "grinder", "machine", "chamber", "payout"];
/** Time between the host pressing start (or the previous trial ending) and round time 0. */
const LEAD_MS = 5000;
/** How long everyone looks at the assessment card before the next trial loads. */
const ASSESS_MS = 9000;
const ALL_LIMBS = ["ra", "la", "rl", "ll"];
const HATS: Record<string, string> = { cone: "cone", "top hat": "top", bucket: "bucket", none: "none" };
const BOTS = [
  { name: "Bruno", hat: "top" },
  { name: "Maude", hat: "bucket" },
  { name: "Dex", hat: "cone" },
];

const alive = (p: Doc<"players">) => p.alive !== false;

/** First trial at or after `index` whose game has a server adapter (unbuilt games are skipped). */
const playable = (index: number) => {
  let i = index;
  while (i < TRIALS.length && TRIALS[i] !== "payout" && !GAMES[TRIALS[i]]) i++;
  return Math.min(i, TRIALS.length - 1);
};

/** Starts trial `i` with the room's living subjects, bots filling the empty seats. */
export async function startTrial(ctx: MutationCtx, roomId: Id<"rooms">, i: number) {
  const players = await ctx.db.query("players").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
  const living = players.filter(alive);
  const game = TRIALS[i];
  const server = GAMES[game];
  const seed = Math.floor(Math.random() * 2 ** 31);
  const seats: SeatInfo[] = living.slice(0, server.seats).map((p) => ({
    id: p._id,
    name: p.name,
    hat: HATS[p.hat] ?? "none",
    limbs: ALL_LIMBS.filter((l) => !(p.lost ?? []).includes(l)),
    bot: false,
  }));
  BOTS.slice(0, server.seats - seats.length).forEach((b, n) => seats.push({ id: `bot-${n + 1}`, name: b.name, hat: b.hat, limbs: ALL_LIMBS, bot: true }));
  const matchId = await ctx.db.insert("matches", {
    roomId,
    game,
    trial: i,
    seed,
    startAt: Date.now() + LEAD_MS,
    seats,
    state: server.init(seed, seats),
    over: false,
  });
  await ctx.db.patch(roomId, { status: "playing", trial: i, matchId, seed });
  await ctx.scheduler.runAfter(LEAD_MS, internal.trials.tick, { matchId });
}

export const tick = internalMutation({
  args: { matchId: v.id("matches") },
  handler: async (ctx, { matchId }) => {
    const match = await ctx.db.get(matchId);
    if (!match || match.over) return null;
    const server = GAMES[match.game];
    const t = (Date.now() - match.startAt) / 1000;
    server.tick(match.state, t);
    if (!server.over(match.state)) {
      await ctx.db.patch(matchId, { state: match.state });
      await ctx.scheduler.runAfter(server.tickMs, internal.trials.tick, { matchId });
      return null;
    }
    await ctx.db.patch(matchId, { state: match.state, over: true });
    const results = server.results(match.state);
    for (const r of results) {
      const seat = match.seats.find((s) => s.id === r.id);
      if (!seat || seat.bot) continue;
      const player = await ctx.db.get(r.id as Id<"players">);
      if (!player) continue;
      const lost = [...new Set([...(player.lost ?? []), ...r.lost])];
      await ctx.db.patch(player._id, { alive: player.alive !== false && !r.dead, lost, limbs: 4 - lost.length });
    }
    const ranking = results.filter((r) => match.seats.some((s) => s.id === r.id && !s.bot)).map((r) => r.id as Id<"players">);
    await ctx.scheduler.runAfter(ASSESS_MS, internal.trials.next, { roomId: match.roomId, after: match.trial, ranking });
    return null;
  },
});

/**
 * After a trial's assessment: the next trial, or the payout once one subject is left (or the run is
 * over). If the last trial left nobody alive, the pot goes to whoever placed best in it.
 */
export const next = internalMutation({
  args: { roomId: v.id("rooms"), after: v.number(), ranking: v.array(v.id("players")) },
  handler: async (ctx, { roomId, after, ranking }) => {
    const room = await ctx.db.get(roomId);
    if (!room || room.status !== "playing" || room.trial !== after) return null;
    const players = await ctx.db.query("players").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect();
    const living = players.filter(alive).map((p) => p._id);
    const i = playable(after + 1);
    if (living.length > 1 && TRIALS[i] !== "payout") {
      await startTrial(ctx, roomId, i);
      return null;
    }
    const winnerId = living.length === 1 ? living[0] : (ranking.find((id) => living.length === 0 || living.includes(id)) ?? living[0] ?? ranking[0]);
    await ctx.db.patch(roomId, { trial: i });
    if (winnerId) await ctx.runMutation(internal.payout.settle, { roomId, winnerId });
    else await ctx.db.patch(roomId, { status: "done" });
    return null;
  },
});

/** A phone's move (or, for self-reported games, its result), passed to the game's server adapter. */
export const act = mutation({
  args: { matchId: v.id("matches"), playerId: v.id("players"), data: v.any() },
  handler: async (ctx, { matchId, playerId, data }) => {
    const match = await ctx.db.get(matchId);
    if (!match || match.over) return null;
    if (!match.seats.some((s) => s.id === playerId && !s.bot)) return null;
    GAMES[match.game].act(match.state, playerId, data, (Date.now() - match.startAt) / 1000);
    await ctx.db.patch(matchId, { state: match.state });
    return null;
  },
});

/** Everything a phone needs to render the current trial. */
export const watch = query({
  args: { matchId: v.id("matches") },
  handler: async (ctx, { matchId }) => {
    const match = await ctx.db.get(matchId);
    if (!match) return null;
    return {
      matchId,
      game: match.game,
      trial: match.trial,
      seed: match.seed,
      startAt: match.startAt,
      seats: match.seats,
      over: match.over,
      view: GAMES[match.game].view(match.state),
    };
  },
});

/** Server clock, for phones to line their clocks up with the trial schedule. */
export const clock = mutation({
  args: {},
  handler: async () => Date.now(),
});
