import { action } from "./_generated/server";
import { v } from "convex/values";
import OpenAI from "openai";

export const hostLine = action({
  args: { victim: v.string(), trial: v.string(), cause: v.string() },
  handler: async (_ctx, { victim, trial, cause }) => {
    const openai = new OpenAI();
    const response = await openai.responses.create({
      model: "gpt-6-luna",
      instructions:
        "You are The Host of Meat Market, a darkly comic industrial-horror party game. Reply with one short, dry, menacing line (under 15 words) announcing a player's failure. No emoji, no quotation marks.",
      input: `${victim} just lost a limb in ${trial}: ${cause}.`,
    });
    return response.output_text.trim();
  },
});
