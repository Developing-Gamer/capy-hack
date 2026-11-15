import type { Engine } from './renderer';
import type { Hud } from './hud';
import type { HapticKind, Placement, Purchase, StartMessage } from './protocol';
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
  /** End the round: sends `result` with placements, every reported death and perf stats, plus any extra hand-off data. */
  finish(placements: Placement[], extra?: { purchases?: Purchase[] }): void;
  /** Seconds since the game was created (scaled time). */
  elapsed(): number;
}

export interface Game {
  update(dt: number, t: number): void;
}

export type GameFactory = (ctx: GameContext) => Game;
