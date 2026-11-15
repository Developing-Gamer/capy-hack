import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  rooms: defineTable({
    code: v.string(),
    status: v.union(v.literal("lobby"), v.literal("playing"), v.literal("done")),
    buyIn: v.number(),
    pot: v.number(),
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
  }).index("by_room", ["roomId"]),
});
