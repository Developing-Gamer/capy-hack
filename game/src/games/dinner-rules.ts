import type { Purchase } from '../shared/protocol';
import { Rng } from '../shared/util';

/*
 * Dinner Party rules with no rendering: the host's newspaper schedule, the bots' eating plans and
 * the referee that decides who is shot or excused. Everything here is a pure function of the seed
 * (plus the humans' reported fork moves), uses only exact arithmetic, and runs identically in the
 * WebView and on the Convex server, so every phone sees the same table.
 */

export const PEAS = 20;
export const MAX_LOAD = 4;
export const ROUND = 75;
export const STAB = 0.25;
export const RAISE = 0.42;
export const CHEW = 0.36;
export const LOWER = 0.3;
export const DROP = 0.14;
/** Seconds of being observed before movement counts (human reaction). */
export const GRACE = 0.3;
/** Seconds Short Fuse takes off the victim's dinner. */
export const FUSE = 3;
/** Host down-ness at which he can see the table. */
const SEES = 0.55;
const RAISE_DUR = 0.4;
const STEPS_PER_SECOND = 60;

export type Fork = 'idle' | 'stab' | 'raise' | 'chew' | 'lower' | 'drop';
export type HostPhase = 'read' | 'rustle' | 'fold' | 'lower' | 'look' | 'raise';
export type Kind = 'greedy' | 'cautious' | 'reckless';

export const CAUSE = {
  stab: 'Observed stabbing peas',
  eat: 'Observed eating',
  last: 'Last plate at the table',
  time: 'Still eating when dinner ended',
} as const;

export interface Segment {
  phase: HostPhase;
  t0: number;
  dur: number;
  /** Host down-ness when the segment starts. */
  d0: number;
  /** A sudden lower without a tell. */
  snap: boolean;
}

export interface HostState {
  seg: Segment;
  index: number;
  pt: number;
  down: number;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** The host's newspaper routine for the whole round (and a little past it). */
export function hostSchedule(seed: number): Segment[] {
  const rng = new Rng((seed ^ 0x5bd1e995) >>> 0);
  const segs: Segment[] = [];
  let t = 0;
  let d = 0;
  let phase: HostPhase = 'read';
  let snap = false;
  let first = true;
  while (t < ROUND + 20) {
    let dur: number;
    let next: HostPhase;
    let nextSnap = false;
    if (phase === 'read') {
      dur = first ? 2.4 : rng.range(2, 4.5) * (1 - 0.35 * clamp(t / ROUND, 0, 1));
      first = false;
      const r = rng.next();
      if (r < 0.45 || t + dur < 12) next = r < 0.6 ? 'rustle' : 'fold';
      else if (r < 0.78) next = 'fold';
      else {
        next = 'lower';
        nextSnap = true;
      }
    } else if (phase === 'rustle' || phase === 'fold') {
      dur = phase === 'rustle' ? 0.65 : 0.75;
      next = rng.chance(phase === 'rustle' ? 0.7 : 0.6) ? 'lower' : 'read';
    } else if (phase === 'lower') {
      dur = snap ? 0.2 : 0.26;
      next = 'look';
    } else if (phase === 'look') {
      dur = rng.chance(0.12) ? rng.range(3, 4) : rng.range(1, 2);
      next = 'raise';
    } else {
      const doubleTake = rng.chance(0.18);
      dur = doubleTake ? RAISE_DUR * 0.55 : RAISE_DUR;
      next = doubleTake ? 'lower' : 'read';
      nextSnap = doubleTake;
    }
    const seg: Segment = { phase, t0: t, dur, d0: d, snap };
    segs.push(seg);
    d = downIn(seg, dur);
    t += dur;
    phase = next;
    snap = nextSnap;
  }
  return segs;
}

function downIn(seg: Segment, pt: number) {
  if (seg.phase === 'read') return Math.max(0, seg.d0 - pt / 0.2);
  if (seg.phase === 'lower') return Math.max(seg.d0, Math.min(1, pt / seg.dur));
  if (seg.phase === 'look') return 1;
  if (seg.phase === 'raise') return Math.max(0, 1 - pt / RAISE_DUR);
  return seg.d0;
}

/** Host state at time t; pass the previous index to make sequential lookups O(1). */
export function hostAt(segs: Segment[], t: number, hint = 0): HostState {
  let i = Math.min(Math.max(0, hint), segs.length - 1);
  if (segs[i].t0 > t) i = 0;
  while (i + 1 < segs.length && segs[i + 1].t0 <= t) i++;
  const seg = segs[i];
  const pt = Math.max(0, t - seg.t0);
  return { seg, index: i, pt, down: downIn(seg, pt) };
}

/** Intervals [a, b] in which the host can see the table. Movement from a + GRACE to b is fatal. */
export function watchWindows(segs: Segment[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (const s of segs) {
    if (s.phase === 'lower' && start < 0) start = s.t0 + (s.d0 >= SEES ? 0 : SEES * s.dur);
    if (s.phase === 'raise' && start >= 0) {
      out.push([start, s.t0 + Math.min(s.dur, (1 - SEES) * RAISE_DUR)]);
      start = -1;
    }
  }
  return out;
}

/** How far up the fork is (0 plate, 1 mouth) for a fork state entered forkT seconds ago. */
export function liftOf(fork: Fork, forkT: number, dropFrom = 1) {
  if (fork === 'raise') return clamp(forkT / RAISE, 0, 1);
  if (fork === 'chew') return 1;
  if (fork === 'lower') return 1 - clamp(forkT / LOWER, 0, 1);
  if (fork === 'drop') return dropFrom * (1 - clamp(forkT / DROP, 0, 1));
  return 0;
}

interface Personality {
  kind: Kind;
  react: [number, number];
  heed: number;
  startDelay: number;
  load: [number, number];
  pick: number;
  resume: number;
  twitch: number;
  /** Only lift the fork within this many seconds of him going back to reading. */
  raiseWindow: number;
  /** Chance to keep chewing (instead of dropping the fork) when the paper comes down mid-bite. */
  finishBite: number;
}

const PERSONALITIES: Record<Kind, Personality> = {
  greedy: { kind: 'greedy', react: [0.25, 0.45], heed: 0.8, startDelay: 0.1, load: [3, 4], pick: 0.62, resume: 0.1, twitch: 0.02, raiseWindow: 99, finishBite: 0.3 },
  cautious: { kind: 'cautious', react: [0.12, 0.26], heed: 0.97, startDelay: 0.55, load: [2, 3], pick: 0.55, resume: 0.5, twitch: 0, raiseWindow: 2.2, finishBite: 0 },
  reckless: { kind: 'reckless', react: [0.15, 0.35], heed: 0.5, startDelay: 0, load: [2, 4], pick: 0.62, resume: 0.03, twitch: 0.04, raiseWindow: 99, finishBite: 0.3 },
};

/** Personality of the n-th bot at the table (0-based), shuffled by the seed. */
export function botKinds(seed: number): Kind[] {
  const rng = new Rng((seed ^ 0x27d4eb2f) >>> 0);
  const kinds: Kind[] = ['greedy', 'cautious', 'reckless'];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  return kinds;
}

export interface Keyframe {
  t: number;
  fork: Fork;
  loaded: number;
  eaten: number;
  /** Lift when a drop started. */
  from: number;
}

export interface BotPlan {
  kind: Kind;
  frames: Keyframe[];
  /** When the host catches this bot moving, if he does. */
  deathT: number;
  deathCause: string;
  /** When it cleans its plate, if it does. */
  doneT: number;
}

/**
 * Simulates one bot through the whole round at a fixed step, reacting only to the host schedule,
 * so the same seed gives the same plan on every device.
 */
export function botPlan(seed: number, index: number, kind: Kind, segs = hostSchedule(seed), windows = watchWindows(segs), grace = GRACE): BotPlan {
  const rng = new Rng((seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const p = PERSONALITIES[kind];
  const dt = 1 / STEPS_PER_SECOND;
  let fork = 'idle' as Fork;
  let forkT = 0;
  let lift = 0;
  let dropFrom = 0;
  let loaded = 0;
  let eaten = 0;
  let remaining = PEAS;
  let target = rng.int(...p.load);
  let react = 0.3;
  let heeding = true;
  let seenAlert = -1;
  let frozen = false;
  let finishing = false;
  let alertAt = -1;
  let clearAt = 0;
  let readSince = 0;
  let downSince = -1;
  let hint = 0;
  let lastSeg = -1;
  let w = 0;
  const frames: Keyframe[] = [{ t: 0, fork, loaded, eaten, from: 0 }];
  const set = (f: Fork, t: number) => {
    if (f === 'drop') dropFrom = lift;
    fork = f;
    forkT = 0;
  };
  const plan: BotPlan = { kind, frames, deathT: -1, deathCause: '', doneT: -1 };

  for (let n = 1; n <= (ROUND + 1) * STEPS_PER_SECOND; n++) {
    const t = n / STEPS_PER_SECOND;
    const host = hostAt(segs, t, hint);
    hint = host.index;
    const phase = host.seg.phase;
    if (host.index !== lastSeg) {
      lastSeg = host.index;
      if (phase === 'read') readSince = clearAt = host.seg.t0;
      if (phase === 'rustle' || phase === 'fold' || (phase === 'lower' && host.seg.snap)) alertAt = host.seg.t0;
    }
    if (host.down > 0.3 && downSince < 0) downSince = t;
    else if (host.down <= 0.3) downSince = -1;

    const startFork: Fork = fork;
    const startLoaded = loaded;
    const startEaten = eaten;

    if (alertAt > clearAt && seenAlert !== alertAt) {
      seenAlert = alertAt;
      react = rng.range(...p.react);
      heeding = rng.chance(p.heed);
    }
    const alertFor = alertAt > clearAt ? t - alertAt : -1;
    const sawTell = alertFor >= react && heeding;
    const sawLook = downSince >= 0 && t - downSince >= react * 0.8;
    if (sawTell || sawLook) frozen = true;
    const readFor = t - readSince;
    if (frozen && phase === 'read' && readFor >= p.resume) frozen = false;
    if (frozen) {
      if (fork === 'stab') {
        const twitch = (phase === 'look' || phase === 'lower') && rng.chance(p.twitch * dt * 10);
        if (!twitch) set('idle', t);
      } else if ((fork === 'raise' || fork === 'chew' || fork === 'lower') && !finishing) {
        if (rng.chance(p.finishBite)) finishing = true;
        else set('drop', t);
      } else if (fork === 'idle' && phase === 'look' && rng.chance(p.twitch * dt)) set(loaded > 0 && kind === 'reckless' ? 'raise' : 'stab', t);
    } else if (!(phase === 'read' && readFor < p.startDelay)) {
      if (fork === 'idle') {
        if (loaded < target && remaining > 0 && eaten + loaded < PEAS) set('stab', t);
        else if (loaded > 0 && (phase !== 'read' || readFor < p.raiseWindow || kind !== 'cautious')) set('raise', t);
      } else if (fork === 'stab' && (loaded >= target || remaining === 0 || eaten + loaded >= PEAS)) {
        if (kind === 'cautious' && readFor > p.raiseWindow) set('idle', t);
        else set('raise', t);
      }
      if (fork === 'lower' && forkT === 0) target = rng.int(...p.load);
    }
    if (fork === 'idle') finishing = false;

    forkT += dt;
    let excused = false;
    if (fork === 'stab') {
      while (forkT >= STAB) {
        forkT -= STAB;
        if (loaded < MAX_LOAD && remaining > 0 && rng.chance(p.pick)) {
          loaded++;
          remaining--;
        }
      }
      lift = 0;
    } else if (fork === 'raise') {
      lift = liftOf(fork, forkT);
      if (forkT >= RAISE) {
        eaten += loaded;
        loaded = 0;
        set('chew', t);
      }
    } else if (fork === 'chew') {
      lift = 1;
      if (forkT >= CHEW) set('lower', t);
    } else if (fork === 'lower') {
      lift = liftOf(fork, forkT);
      if (forkT >= LOWER) {
        set('idle', t);
        excused = eaten >= PEAS;
      }
    } else if (fork === 'drop') {
      lift = liftOf(fork, forkT, dropFrom);
      if (forkT >= DROP) {
        remaining += loaded;
        loaded = 0;
        set('idle', t);
        excused = eaten >= PEAS;
      }
    } else lift = 0;

    if (fork !== startFork || loaded !== startLoaded || eaten !== startEaten) frames.push({ t, fork, loaded, eaten, from: dropFrom });
    if (excused) {
      plan.doneT = t;
      return plan;
    }
    while (w < windows.length && windows[w][1] < t) w++;
    if (fork !== 'idle' && w < windows.length && t >= windows[w][0] + grace && t <= windows[w][1]) {
      plan.deathT = t;
      plan.deathCause = fork === 'stab' ? CAUSE.stab : CAUSE.eat;
      return plan;
    }
  }
  return plan;
}

/** Bot state at time t from its plan (frozen at its last frame once it is done or dead). */
export function botFrame(plan: BotPlan, t: number) {
  const f = plan.frames;
  let lo = 0;
  let hi = f.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (f[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return { ...f[lo], forkT: Math.max(0, t - f[lo].t) };
}

// ---------------------------------------------------------------------------------------------
// Referee

export interface Act {
  /** Round seconds. */
  t: number;
  fork: Fork;
  loaded: number;
  eaten: number;
}

export interface Seat {
  id: string;
  bot: boolean;
  /** Whether the subject still has its right (fork) arm. */
  arm: boolean;
  /** Marked: the host looks at this subject first, so it gets no reaction time. */
  marked?: boolean;
  /** Short Fuse: seconds cut from this subject's dinner. */
  fuse?: number;
}

/** Applies the sabotage Dinner Party understands (Marked, Short Fuse) to the seats. */
export function sabotage(seats: Seat[], purchases: Purchase[] = []): Seat[] {
  return seats.map((s) => {
    const on = purchases.filter((p) => p.victim === s.id);
    const fuse = on.filter((p) => p.offer === 'short_fuse').length * FUSE;
    return { ...s, ...(on.some((p) => p.offer === 'marked') && { marked: true }), ...(fuse && { fuse }) };
  });
}

/** Seconds a subject has to clean its plate. */
export const deadline = (seat: Seat) => ROUND - (seat.fuse ?? 0);

export interface Outcome {
  id: string;
  t: number;
  status: 'excused' | 'dead';
  cause: string;
  eaten: number;
  /** Limbs blown off before the kill shot. */
  lost: string[];
}

export interface Placement {
  id: string;
  place: number;
  status: 'survived' | 'dead';
  score: number;
}

export interface Referee {
  seed: number;
  seats: Seat[];
  /** Each human's fork moves, oldest first; trimmed to what is still undecided. */
  acts: Record<string, Act[]>;
  outcomes: Outcome[];
  /** Round time up to which everything is decided. */
  checked: number;
  lastPlate: boolean;
  timeUp: boolean;
  over: boolean;
}

export function newReferee(seed: number, seats: Seat[]): Referee {
  const acts: Record<string, Act[]> = {};
  for (const s of seats) if (!s.bot) acts[s.id] = [];
  return { seed, seats, acts, outcomes: [], checked: 0, lastPlate: false, timeUp: false, over: false };
}

/** Records a human's fork move. Moves are never placed before what is already decided. */
export function recordAct(ref: Referee, id: string, act: Act) {
  const list = ref.acts[id];
  if (!list || ref.over || ref.outcomes.some((o) => o.id === id)) return;
  const prev = list[list.length - 1];
  list.push({ ...act, t: Math.max(act.t, ref.checked, prev?.t ?? 0) });
}

export interface Table {
  segs: Segment[];
  windows: [number, number][];
  plans: Map<string, BotPlan>;
}

const tables = new Map<string, Table>();

/** Host schedule, watch windows and every bot's plan for a referee (cached per seed and seating). */
export function tableFor(seed: number, seats: Seat[]): Table {
  const key = seed + ':' + seats.map((s) => (s.bot ? 'b' : 'h') + (s.marked ? 'm' : '')).join('');
  const hit = tables.get(key);
  if (hit) return hit;
  const segs = hostSchedule(seed);
  const windows = watchWindows(segs);
  const kinds = botKinds(seed);
  const plans = new Map<string, BotPlan>();
  seats.filter((s) => s.bot).forEach((s, i) => plans.set(s.id, botPlan(seed, i, kinds[i % kinds.length], segs, windows, s.marked ? 0 : GRACE)));
  const table = { segs, windows, plans };
  if (tables.size > 16) tables.clear();
  tables.set(key, table);
  return table;
}

const forkAt = (acts: Act[], t: number) => {
  let f: Act | undefined;
  for (const a of acts) {
    if (a.t > t) break;
    f = a;
  }
  return f;
};

/**
 * Decides everything that happened up to round time `horizon` and returns the new outcomes.
 * Call it as often as you like; work before `checked` is never redone.
 */
export function advance(ref: Referee, horizon: number): Outcome[] {
  if (ref.over || horizon <= ref.checked) return [];
  const table = tableFor(ref.seed, ref.seats);
  const from = ref.checked;
  const to = horizon;
  const resolved = (id: string) => ref.outcomes.some((o) => o.id === id);
  const candidates: { t: number; id: string; status: Outcome['status']; cause: string }[] = [];

  for (const seat of ref.seats) {
    if (resolved(seat.id)) continue;
    const end = deadline(seat);
    if (end < ROUND && end > from && end <= to) candidates.push({ t: end, id: seat.id, status: 'dead', cause: CAUSE.time });
    if (seat.bot) {
      const plan = table.plans.get(seat.id)!;
      if (plan.deathT > from && plan.deathT <= to) candidates.push({ t: plan.deathT, id: seat.id, status: 'dead', cause: plan.deathCause });
      if (plan.doneT > from && plan.doneT <= to) candidates.push({ t: plan.doneT, id: seat.id, status: 'excused', cause: '' });
      continue;
    }
    const acts = ref.acts[seat.id];
    const done = acts.find((a) => a.t > from && a.t <= to && a.fork === 'idle' && a.eaten >= PEAS);
    if (done) candidates.push({ t: done.t, id: seat.id, status: 'excused', cause: '' });
    for (const [a, b] of table.windows) {
      const i0 = Math.max(a + (seat.marked ? 0 : GRACE), from);
      const i1 = Math.min(b, to);
      if (i0 > i1) continue;
      const at = forkAt(acts, i0);
      let hit: Act | undefined = at && at.fork !== 'idle' ? { ...at, t: i0 } : undefined;
      if (!hit) hit = acts.find((x) => x.t > i0 && x.t <= i1 && x.fork !== 'idle');
      if (hit) {
        candidates.push({ t: hit.t, id: seat.id, status: 'dead', cause: hit.fork === 'stab' ? CAUSE.stab : CAUSE.eat });
        break;
      }
    }
  }
  if (!ref.timeUp && ROUND > from && ROUND <= to) candidates.push({ t: ROUND, id: '', status: 'dead', cause: CAUSE.time });
  candidates.sort((x, y) => x.t - y.t);

  const added: Outcome[] = [];
  const eatenOf = (id: string, t: number) => {
    const seat = ref.seats.find((s) => s.id === id)!;
    if (seat.bot) return botFrame(table.plans.get(id)!, t).eaten;
    return forkAt(ref.acts[id], t)?.eaten ?? 0;
  };
  const resolve = (id: string, t: number, status: Outcome['status'], cause: string) => {
    const seat = ref.seats.find((s) => s.id === id)!;
    const lost = status === 'dead' && cause === CAUSE.stab && seat.arm ? ['ra'] : [];
    const o: Outcome = { id, t, status, cause, eaten: eatenOf(id, t), lost };
    ref.outcomes.push(o);
    added.push(o);
  };
  const active = () => ref.seats.filter((s) => !resolved(s.id));

  for (const c of candidates) {
    if (c.id === '') {
      ref.timeUp = true;
      for (const s of active()) resolve(s.id, c.t, 'dead', CAUSE.time);
      break;
    }
    if (resolved(c.id)) continue;
    resolve(c.id, c.t, c.status, c.cause);
    const left = active();
    if (!ref.lastPlate && !ref.timeUp && left.length === 1 && ref.outcomes.some((o) => o.status === 'excused')) {
      ref.lastPlate = true;
      resolve(left[0].id, c.t, 'dead', CAUSE.last);
    }
  }

  ref.checked = to;
  for (const id of Object.keys(ref.acts)) {
    const list = ref.acts[id];
    let keep = 0;
    while (keep + 1 < list.length && list[keep + 1].t <= to) keep++;
    if (keep > 0) list.splice(0, keep);
  }
  if (active().length === 0) ref.over = true;
  return added;
}

/** Final order: excused diners by finishing time, then the dead, last to die first. */
export function placements(ref: Referee): Placement[] {
  const done = ref.outcomes.filter((o) => o.status === 'excused').sort((a, b) => a.t - b.t);
  const dead = ref.outcomes.filter((o) => o.status === 'dead').sort((a, b) => b.t - a.t);
  return [...done, ...dead].map((o, i) => ({ id: o.id, place: i + 1, status: o.status === 'excused' ? 'survived' : 'dead', score: o.eaten }));
}

/** What the server sends every phone: decided outcomes and each human's latest fork move. */
export interface DinnerView {
  outcomes: Outcome[];
  acts: Record<string, Act>;
  over: boolean;
  placements: Placement[];
}

export function viewOf(ref: Referee): DinnerView {
  const acts: Record<string, Act> = {};
  for (const [id, list] of Object.entries(ref.acts)) if (list.length) acts[id] = list[list.length - 1];
  return { outcomes: ref.outcomes, acts, over: ref.over, placements: ref.over ? placements(ref) : [] };
}
