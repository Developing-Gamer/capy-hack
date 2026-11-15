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
}

export interface StartMessage {
  type: 'start';
  game: string;
  seed: number;
  /** Id of the local player. */
  you: string;
  players: PlayerInfo[];
  pot?: number;
}

export type AppToGame = StartMessage;

export type HapticKind = 'light' | 'heavy' | 'death';

export interface Placement {
  id: string;
  /** 1 is best. */
  place: number;
  status: 'survived' | 'dead';
  score: number;
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
  | { type: 'result'; game: string; placements: Placement[]; deaths: DeathRecord[]; perf: { fps: number; minFps: number } };
