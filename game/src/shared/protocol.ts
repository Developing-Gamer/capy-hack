export type Hat = 'cone' | 'top' | 'bucket' | 'none';
export type Limb = 'ra' | 'la' | 'rl' | 'll';
export const ALL_LIMBS: Limb[] = ['ra', 'la', 'rl', 'll'];

export interface PlayerInfo {
  id: string;
  name: string;
  hat: Hat;
  /** Limbs the subject still has. */
  limbs: Limb[];
  isBot: boolean;
  /** Coins carried into The Machine's intermission shop. Defaults to 12. */
  coins?: number;
}

/**
 * Sabotage sold by The Machine between trials. Later trials apply the ones they understand:
 * - `short_fuse`: the victim's next timer runs 3 s short.
 * - `marked`: the next antagonist watches or targets the victim first.
 * - `one_more_round`: one extra bullet in the victim's next chamber pull.
 * - `limb_swap`: buyer and victim trade limb sets before the next trial starts.
 */
export type OfferId = 'short_fuse' | 'marked' | 'one_more_round' | 'limb_swap';

export interface Purchase {
  /** Player id of the buyer. */
  buyer: string;
  offer: OfferId;
  /** Player id of the victim (may have died since; check before applying). */
  victim: string;
}

export interface StartMessage {
  type: 'start';
  game: string;
  seed: number;
  /** Id of the local player. */
  you: string;
  players: PlayerInfo[];
  pot?: number;
  /** Sabotage bought at the last intermission, for this trial to apply. */
  purchases?: Purchase[];
}

export type AppToGame = StartMessage;

export type HapticKind = 'light' | 'heavy' | 'death';

export interface Placement {
  id: string;
  /** 1 is best. */
  place: number;
  status: 'survived' | 'dead';
  score: number;
  /** Limbs the subject still has at the end, when the game can take them. */
  limbs?: Limb[];
}

export interface DeathRecord {
  id: string;
  cause: string;
  /** Seconds since the round began. */
  t: number;
}

export type GameToApp =
  | { type: 'ready' }
  | { type: 'haptic'; kind: HapticKind }
  | ({ type: 'death' } & DeathRecord)
  | { type: 'result'; game: string; placements: Placement[]; deaths: DeathRecord[]; perf: { fps: number; minFps: number }; purchases?: Purchase[] };
