import { httpRouter } from "convex/server";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  path: "/buyin/return",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const playerId = url.searchParams.get("player");
    const to = url.searchParams.get("to") ?? "";
    if (playerId) await ctx.runAction(api.buyin.confirm, { playerId: playerId as Id<"players"> }).catch(() => false);
    const location = /^(meatmarket|exps?):\/\//.test(to) ? to : "meatmarket://";
    return new Response(null, { status: 302, headers: { Location: location } });
  }),
});

export default http;
