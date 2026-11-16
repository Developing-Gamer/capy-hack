import { Infer } from "convex/values";
import { type Act, advance, type Fork, newReferee, placements, recordAct, type Referee, sabotage, viewOf } from "../game/src/games/dinner-rules";
import type { OfferId } from "../game/src/shared/protocol";
import { purchase, seat } from "./schema";

export type SeatInfo = Infer<typeof seat>;
export type Purchase = Infer<typeof purchase>;
const OFFERS: OfferId[] = ["short_fuse", "marked", "one_more_round", "limb_swap"];

export interface SeatResult {
  id: string;
  dead: boolean;
  /** Limbs lost in this trial. */
  lost: string[];
}

/**
 * How the server runs one game. `t` is round time in seconds (server clock). State must be plain
 * JSON; it is stored on the match and mutated in place by act/tick.
 */
export interface ServerGame {
  /** Seats at the table; bots fill whatever the humans leave empty. */
  seats: number;
  /** True when every phone plays one shared round; false when each phone plays its own copy. */
  shared: boolean;
  /** Sabotage this game applies itself (Limb Swap is applied by the runner before any trial). */
  applies: OfferId[];
  /** How often tick runs while the round is live. */
  tickMs: number;
  init(seed: number, seats: SeatInfo[], purchases: Purchase[]): unknown;
  act(state: unknown, playerId: string, data: unknown, t: number): void;
  tick(state: unknown, t: number): void;
  over(state: unknown): boolean;
  /** What every phone receives (as a `net` message) on each change. */
  view(state: unknown): unknown;
  /** Every seat's fate, best placed first. */
  results(state: unknown): SeatResult[];
  /** Sabotage bought during the round, for the next trial. */
  purchases?(state: unknown): Purchase[];
}

/** Server time is the authority, but a phone's fork move is judged when it happened, up to this late. */
const SLACK = 0.35;
const FORKS: Fork[] = ["idle", "stab", "raise", "chew", "lower", "drop"];

/** Dinner Party: the server referees with the same rules module the WebView runs. */
const dinner: ServerGame = {
  seats: 4,
  shared: true,
  applies: ["marked", "short_fuse"],
  tickMs: 250,
  init: (seed, seats, purchases) =>
    newReferee(
      seed,
      sabotage(
        seats.map((s) => ({ id: s.id, bot: s.bot, arm: s.limbs.includes("ra") })),
        purchases,
      ),
    ),
  act(state, playerId, data, t) {
    const d = data as Partial<Act> & { kind?: string };
    if (d?.kind !== "act" || !FORKS.includes(d.fork as Fork)) return;
    const at = Math.min(t, Math.max(t - SLACK, Number(d.t) || 0));
    recordAct(state as Referee, playerId, { t: at, fork: d.fork as Fork, loaded: Number(d.loaded) || 0, eaten: Number(d.eaten) || 0 });
  },
  tick: (state, t) => void advance(state as Referee, t - SLACK),
  over: (state) => (state as Referee).over,
  view: (state) => viewOf(state as Referee),
  results: (state) => {
    const ref = state as Referee;
    return placements(ref).map((p) => {
      const o = ref.outcomes.find((x) => x.id === p.id)!;
      return { id: o.id, dead: o.status === "dead", lost: o.lost };
    });
  },
};

interface SelfReport {
  humans: string[];
  bots: string[];
  reports: Record<string, SeatResult>;
  bought: Purchase[];
  deadline: number;
}

const isPurchase = (p: unknown): p is Purchase => {
  const x = p as Purchase;
  return !!x && typeof x.buyer === "string" && typeof x.victim === "string" && OFFERS.includes(x.offer);
};

/**
 * Any other game: every phone plays its own copy against bots and reports its own subject's fate
 * through the standard `result` message. The round ends when every human has reported. Each
 * phone's own purchases count; the bots' come from the first human's phone.
 */
export function selfReported(seats = 4, deadline = 240): ServerGame {
  return {
    seats,
    shared: false,
    applies: [],
    tickMs: 1000,
    init: (_seed, seats): SelfReport => ({
      humans: seats.filter((s) => !s.bot).map((s) => s.id),
      bots: seats.filter((s) => s.bot).map((s) => s.id),
      reports: {},
      bought: [],
      deadline,
    }),
    act(state, playerId, data) {
      const s = state as SelfReport;
      const d = data as { kind?: string; placements?: { id: string; status: string; limbs?: string[] }[]; limbs?: Record<string, string[]>; purchases?: unknown[] };
      if (d?.kind !== "result" || !s.humans.includes(playerId) || s.reports[playerId]) return;
      const mine = d.placements?.find((p) => p.id === playerId);
      const kept = d.limbs?.[playerId] ?? mine?.limbs;
      const counts = (p: Purchase) => p.buyer === playerId || (playerId === s.humans[0] && s.bots.includes(p.buyer));
      for (const p of (d.purchases ?? []).filter(isPurchase).filter(counts)) s.bought.push({ buyer: p.buyer, offer: p.offer, victim: p.victim });
      const lost = kept ? ["ra", "la", "rl", "ll"].filter((l) => !kept.includes(l)) : [];
      s.reports[playerId] = { id: playerId, dead: mine?.status === "dead", lost };
    },
    tick(state, t) {
      const s = state as SelfReport;
      if (t < s.deadline) return;
      for (const id of s.humans) s.reports[id] ??= { id, dead: false, lost: [] };
    },
    over: (state) => {
      const s = state as SelfReport;
      return s.humans.every((id) => s.reports[id]);
    },
    view: (state) => ({ reported: Object.keys((state as SelfReport).reports) }),
    results: (state) => Object.values((state as SelfReport).reports).sort((a, b) => Number(a.dead) - Number(b.dead)),
    purchases: (state) => (state as SelfReport).bought,
  };
}

const CHAMBER_ACTIONS = ["pull", "pass", "turn"];

interface Lockstep {
  humans: string[];
  /** Each human choice by turn number; the first proposal for a turn wins. */
  actions: Record<string, string>;
  reported: string[];
  placements: { id: string; status: string }[] | null;
  deadline: number;
}

/**
 * Last Chamber: every phone runs the same seeded table and the server only orders the humans'
 * choices (`{ kind: "act", turn, action }`). Every phone reaches the same ending, so the first
 * `result` decides the placements; the round ends when every human has reported.
 */
const chamber: ServerGame = {
  seats: 4,
  shared: true,
  applies: ["one_more_round", "marked", "short_fuse"],
  tickMs: 1000,
  init: (_seed, seats): Lockstep => ({ humans: seats.filter((s) => !s.bot).map((s) => s.id), actions: {}, reported: [], placements: null, deadline: 900 }),
  act(state, playerId, data) {
    const s = state as Lockstep;
    const d = data as { kind?: string; turn?: unknown; action?: unknown; placements?: { id: string; status: string }[] };
    if (d?.kind === "act" && Number.isInteger(d.turn) && CHAMBER_ACTIONS.includes(d.action as string)) s.actions[String(d.turn)] ??= d.action as string;
    if (d?.kind !== "result" || s.reported.includes(playerId)) return;
    s.reported.push(playerId);
    s.placements ??= (d.placements ?? []).map((p) => ({ id: String(p.id), status: String(p.status) }));
  },
  tick(state, t) {
    const s = state as Lockstep;
    if (t >= s.deadline) s.reported = [...s.humans];
  },
  over: (state) => (state as Lockstep).humans.every((id) => (state as Lockstep).reported.includes(id)),
  view: (state) => ({ actions: (state as Lockstep).actions }),
  results: (state) => {
    const s = state as Lockstep;
    const order = s.placements ?? [];
    const rank = (id: string) => (order.findIndex((p) => p.id === id) + order.length + 1) % (order.length + 1);
    return [...s.humans]
      .sort((a, b) => rank(a) - rank(b))
      .map((id) => ({ id, dead: order.find((p) => p.id === id)?.status === "dead", lost: [] }));
  },
};

/** Server adapters by game key (the `game` field of the start message). */
export const GAMES: Record<string, ServerGame> = {
  dinner,
  machine: selfReported(4, 240),
  grinder: selfReported(),
  chamber,
};
