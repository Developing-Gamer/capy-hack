import type { Engine } from './renderer';
import type { Hud } from './hud';
import type { HapticKind, Limb, Placement, StartMessage } from './protocol';
import type { Rng } from './util';

export interface GameContext {
  engine: Engine;
  hud: Hud;
  rng: Rng;
  start: StartMessage;
  /** Element that receives touch input (the whole screen). */
  surface: HTMLElement;
  haptic(kind: HapticKind): void;
  /** Report a death to the app (also fires the death haptic when it is the local player). */
  death(id: string, cause: string): void;
  /**
   * End the round: sends `result` with placements, every reported death and perf stats, plus the
   * limbs each subject kept when the game maims (optional).
   */
  finish(placements: Placement[], limbs?: Record<string, Limb[]>): void;
  /** Seconds since the game was created (scaled time). */
  elapsed(): number;
  /**
   * Online rounds only (`start.startAt` set): `send` goes to this game's server authority through the
   * app, and `on` receives the authority's latest view (also replayed to a late listener).
   */
  net?: {
    send(data: unknown): void;
    on(fn: (data: unknown) => void): void;
  };
}

export interface Game {
  update(dt: number, t: number): void;
}

export type GameFactory = (ctx: GameContext) => Game;
