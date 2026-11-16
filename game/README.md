# game/

The minigames, as one self-contained web page (Vite + TypeScript + three.js, inlined by
vite-plugin-singlefile). The Expo app embeds it in a WebView on `src/app/play/[game].tsx`.

```bash
npm run game:dev     # from the repo root: Vite dev server on :5173 (desktop browser)
npm run game:build   # typecheck, build, and regenerate src/game/html.ts (commit that file)
```

The app never builds this package: `src/game/html.ts` is the generated HTML string and is
committed, so Revyl/Xcode builds only need the usual `npm install`. Rebuild and commit it
whenever you change anything under `game/`.

Dev URL params (desktop only, outside the WebView): `?game=dinner` picks the game,
`?seed=7` fixes the seed, `?auto` lets a bot play for you, `?speed=4` runs 4 sim steps per
frame, `?nohud` hides the HUD for clean captures, `?debug` logs fps. In Dinner Party,
keys 1-3 / Z-C / V-N make the host shoot bot 1-3 (head / arm then head / gut then head) and
Y shoots you.

## Bridge

Types live in `src/shared/protocol.ts`, imported by both sides.

- RN → web: `{ type: 'start', game, seed, you, players: [{ id, name, hat, limbs, isBot }], pot? }`.
  `limbs` lists the limbs a subject still has (`'ra' | 'la' | 'rl' | 'll'`). Send it after
  the page posts `ready`.
- web → RN: `ready`, `haptic` (`light | heavy | death`), `death` (`{ id, cause, t }`),
  `result` (`{ game, placements: [{ id, place, status, score }], deaths, perf }`).

The page only accepts one `start`; to replay, remount the WebView (the play screen bumps its
`key`).

## Shared layer (`src/shared/`)

| file | what it gives you |
| --- | --- |
| `renderer.ts` | `Engine`: the Machine Party look (scene → ~1/3-res target → dither/posterize, grain, vignette, red danger `tint`, lens blood, flashes), `shake()`, `slowmo()`, `flash()`, fps `perf()`. `Flicker` for buzzing practical lights. `LensBlood` (`engine.lens`): `splat`, `burst`, `cover`. |
| `gore.ts` | `Gore`: blood particles that leave persistent decals on the `Surface`s and `Wall`s you give it, bouncing gibs, pulsing `stump`s, `explodeHead`, `gutSpill` (verlet intestines), `pool`, `muzzleFlash`, `throwObject`. Particles passing the camera splat the lens on their own. Call `update(dt)` every frame. |
| `rig.ts` | `Subject`: low-poly test subject in a numbered jumpsuit with a hat, seated or standing. Drive it with `eat`, `stab`, `chew`, `freeze`, `relaxed`, `lookAt`, `flinch()`, `die()`; gore via `explodeHead`, `severLimb`, `gutSpill`. `hand()` is the attach point for props. |
| `textures.ts` | Procedural low-res canvas textures: concrete, floor, rust, metal, wood, cloth, hazard, numbered jumpsuit, newspaper, blood splats. |
| `audio.ts` | `sound`: procedural WebAudio drone, mechanical beat (`intensity`), gunshot, squelch, crunch, splat, rustle, snap, clink, chew, sting, ring, `muffle`. Unlocks on first touch. |
| `hud.ts` | `Hud`: timer, pot, limbs, status line, scoreboard, feed, stamp, rules card (`intro`), clinical `assessment` card. |
| `input.ts` | `TouchPad`: full-screen one-thumb hold / flick-up / flick-down, with Space / W / S on desktop. |
| `game.ts` | `GameContext` and `GameFactory`. |
| `util.ts` | Seeded `Rng` (use it for anything gameplay; `rand` is for cosmetics), `clamp`, `lerp`, `damp`, `smooth`. |

## Adding a game

1. Create `src/games/<name>.ts` exporting a `GameFactory`:

   ```ts
   export const createGrinder: GameFactory = (ctx) => {
     const { engine, hud, rng, start } = ctx;
     // build engine.scene (lights, room, Subjects), new Gore(engine, surfaces, walls)
     // input: new TouchPad(ctx.surface, { down, up, swipeUp })
     return {
       update(dt, t) {
         // sim, gore.update(dt), subject.update(dt, t), camera, hud
       },
     };
   };
   ```

2. Register it in `GAMES` in `src/main.ts`; the key is the `game` field of `start`.
3. Report deaths with `ctx.death(id, cause)` as they happen and end with
   `ctx.finish(placements)` once, then show `hud.assessment(...)`.
4. Use `ctx.rng` for all gameplay randomness so a seed replays the same round.
5. `npm run game:build`, commit `src/game/html.ts`, and open it from the app with
   `router.push({ pathname: '/play/[game]', params: { game: '<name>' } })`.

## The Machine (`src/games/machine.ts`)

The intermission shop. Each subject picks an offer and a victim, then holds a hand in a toothed
payment slot to feed coins (one every 1.5 s). When the CRT eye goes amber then red every slot bites:
the first bite takes the arm, the second gets the subject crushed by the press overhead. Stock is
one short of the batch, so the last subject still shopping is "stocked"; anyone unpaid at 1:00 is
collected. Desktop: `?game=machine`, keys 1-4 pick an offer, 5-7 a victim, B forces a bite.

Hand-off to later trials (types in `src/shared/protocol.ts`):

- `result.purchases`: `[{ buyer, offer, victim }]`, player ids plus an `OfferId`
  (`short_fuse` -3 s on the victim's next timer, `marked` the next antagonist watches them first,
  `one_more_round` an extra bullet in their next chamber pull, `limb_swap` buyer and victim trade
  limb sets). Purchases are secret: only the buyer's own phone shows what it bought.
- `result.placements[].limbs`: limbs left after the shop (bites remove arms).
- The app forwards both into the next `start`: `players[].limbs` and `start.purchases`. A trial
  applies the purchases it understands and ignores the rest, and skips victims who are dead.
- `players[].coins` is optional (defaults to 12).

Shared-engine additions (backward compatible): `sound.raw` exposes the WebAudio context, buses,
reverb send and noise buffer for game-specific synthesis, and `ctx.finish(placements, extra?)`
spreads `extra` (`purchases`) into the `result` message.

`src/games/dinner.ts` is the reference: room building, a scripted antagonist, bot brains with
personalities, an execution queue with slow-mo kills, and the round result.
