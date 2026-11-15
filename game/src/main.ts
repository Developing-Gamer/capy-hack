import './style.css';
import { createChamber } from './games/chamber';
import { createDinner } from './games/dinner';
import { onAppMessage, inApp, send } from './shared/bridge';
import type { GameContext, GameFactory } from './shared/game';
import { Hud } from './shared/hud';
import type { DeathRecord, StartMessage } from './shared/protocol';
import { Engine } from './shared/renderer';
import { Rng } from './shared/util';

/** Register new games here; the key is the `game` field of the start message. */
const GAMES: Record<string, GameFactory> = {
  dinner: createDinner,
  chamber: createChamber,
};

const app = document.getElementById('app')!;
const engine = new Engine(document.getElementById('gl') as HTMLCanvasElement);
const hud = new Hud(app);
engine.start();

let started = false;

function begin(msg: StartMessage) {
  if (started) return;
  const factory = GAMES[msg.game];
  if (!factory) {
    hud.setStatus(`UNKNOWN SIMULATION: ${msg.game}`, 'danger');
    return;
  }
  started = true;
  let gameTime = 0;
  const deaths: DeathRecord[] = [];
  let finished = false;
  const ctx: GameContext = {
    engine,
    hud,
    rng: new Rng(msg.seed),
    start: msg,
    surface: app,
    haptic: (kind) => send({ type: 'haptic', kind }),
    death(id, cause) {
      const rec = { id, cause, t: Math.round(gameTime * 10) / 10 };
      deaths.push(rec);
      send({ type: 'death', ...rec });
      if (id === msg.you) send({ type: 'haptic', kind: 'death' });
    },
    finish(placements) {
      if (finished) return;
      finished = true;
      send({ type: 'result', game: msg.game, placements, deaths, perf: engine.perf() });
    },
    elapsed: () => gameTime,
  };
  const game = factory(ctx);
  const speed = Number(new URLSearchParams(location.search).get('speed')) || 1;
  engine.onUpdate = (dt, t) => {
    for (let i = 0; i < speed; i++) {
      gameTime += dt;
      game.update(dt, t + i * dt);
    }
  };
}

onAppMessage((msg) => {
  if (msg.type === 'start') begin(msg);
});
send({ type: 'ready' });

if (!inApp()) {
  const q = new URLSearchParams(location.search);
  if (q.has('nohud')) document.body.classList.add('nohud');
  Object.assign(window, { mm: { engine } });
  if (q.has('debug')) setInterval(() => console.log('[perf]', JSON.stringify(engine.perf())), 3000);
  setTimeout(
    () =>
      begin({
        type: 'start',
        game: q.get('game') ?? 'dinner',
        seed: Number(q.get('seed')) || Math.floor(Math.random() * 1e6),
        you: 'you',
        pot: 40,
        players: [
          { id: 'you', name: 'You', hat: 'cone', limbs: ['ra', 'la', 'rl', 'll'], isBot: false },
          { id: 'b1', name: 'Bruno', hat: 'top', limbs: ['ra', 'la', 'rl', 'll'], isBot: true },
          { id: 'b2', name: 'Maude', hat: 'bucket', limbs: ['ra', 'la', 'rl', 'll'], isBot: true },
          { id: 'b3', name: 'Dex', hat: 'cone', limbs: ['ra', 'la', 'rl', 'll'], isBot: true },
        ],
      }),
    250,
  );
}
