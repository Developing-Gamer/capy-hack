import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const seat = v.object({
  id: v.string(),
  name: v.string(),
  hat: v.string(),
  limbs: v.array(v.string()),
  bot: v.boolean(),
});

export default defineSchema({
  rooms: defineTable({
    code: v.string(),
    status: v.union(v.literal("lobby"), v.literal("playing"), v.literal("done")),
    buyIn: v.number(),
    pot: v.number(),
    /** Index into TRIALS of the trial being played (or just played). */
    trial: v.optional(v.number()),
    matchId: v.optional(v.id("matches")),
    seed: v.optional(v.number()),
    winnerId: v.optional(v.id("players")),
  }).index("by_code", ["code"]),
  players: defineTable({
    roomId: v.id("rooms"),
    name: v.string(),
    hat: v.string(),
    limbs: v.number(),
    coins: v.number(),
    paid: v.boolean(),
    planId: v.optional(v.string()),
    paymentId: v.optional(v.string()),
    /** False once the subject dies in a trial; dead subjects spectate and are out of the pot. */
    alive: v.optional(v.boolean()),
    /** Limbs lost so far ('ra' | 'la' | 'rl' | 'll'); `limbs` is 4 minus its length. */
    lost: v.optional(v.array(v.string())),
  }).index("by_room", ["roomId"]),
  /** One trial (minigame round) in a room. `state` belongs to the game's server adapter in games.ts. */
  matches: defineTable({
    roomId: v.id("rooms"),
    game: v.string(),
    trial: v.number(),
    seed: v.number(),
    /** Server epoch ms of round time 0. */
    startAt: v.number(),
    seats: v.array(seat),
    state: v.any(),
    over: v.boolean(),
    /** Each human's fate once the trial is over. */
    results: v.optional(v.array(v.object({ id: v.string(), dead: v.boolean(), lost: v.array(v.string()) }))),
  }).index("by_room", ["roomId"]),
  payouts: defineTable({
    roomId: v.id("rooms"),
    winnerId: v.id("players"),
    amount: v.number(),
    currency: v.string(),
    status: v.union(v.literal("sending"), v.literal("processing"), v.literal("paid"), v.literal("simulated"), v.literal("owed")),
    whopUserId: v.optional(v.string()),
    transferId: v.optional(v.string()),
    reason: v.optional(v.string()),
  }).index("by_room", ["roomId"]),
});
