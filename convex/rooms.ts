import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const HATS = ["cone", "top hat", "bucket", "none"];
const BUY_IN = 10;

function roomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
}

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    let code = roomCode();
    while (await ctx.db.query("rooms").withIndex("by_code", (q) => q.eq("code", code)).unique()) code = roomCode();
    const roomId = await ctx.db.insert("rooms", { code, status: "lobby", buyIn: BUY_IN, pot: 0 });
    const playerId = await ctx.db.insert("players", { roomId, name, hat: HATS[0], limbs: 4, coins: 60, paid: false });
    return { code, playerId };
  },
});

export const join = mutation({
  args: { code: v.string(), name: v.string() },
  handler: async (ctx, { code, name }) => {
    const room = await ctx.db.query("rooms").withIndex("by_code", (q) => q.eq("code", code.toUpperCase())).unique();
    if (!room) throw new Error("No room with that code");
    if (room.status !== "lobby") throw new Error("That game already started");
    const players = await ctx.db.query("players").withIndex("by_room", (q) => q.eq("roomId", room._id)).collect();
    if (players.length >= 4) throw new Error("Room is full");
    const playerId = await ctx.db.insert("players", { roomId: room._id, name, hat: HATS[players.length], limbs: 4, coins: 60, paid: false });
    return { code: room.code, playerId };
  },
});

export const get = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const room = await ctx.db.query("rooms").withIndex("by_code", (q) => q.eq("code", code.toUpperCase())).unique();
    if (!room) return null;
    const players = await ctx.db.query("players").withIndex("by_room", (q) => q.eq("roomId", room._id)).collect();
    return { room, players };
  },
});
