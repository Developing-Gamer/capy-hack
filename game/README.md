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
Y shoots you. In The Grinder (`?game=grinder`), A / D or the arrow keys are the left / right
hands, keys 1-3 feed bot 1-3 to the grinder, Y feeds you, and `?tp` swaps in a side camera
for checking poses.

## Bridge

Types live in `src/shared/protocol.ts`, imported by both sides.

- RN → web: `{ type: 'start', game, seed, you, players: [{ id, name, hat, limbs, isBot }], pot? }`.
  `limbs` lists the limbs a subject still has (`'ra' | 'la' | 'rl' | 'll'`). Send it after
  the page posts `ready`.
- web → RN: `ready`, `haptic` (`light | heavy | death`), `death` (`{ id, cause, t }`),
  `result` (`{ game, placements: [{ id, place, status, score }], deaths, perf }`).
- Online rounds (added, backward compatible): `start.startAt` is the device-clock epoch ms of
  round time 0, and `{ type: 'net', data }` flows both ways. `ctx.net` exists only then:
  `ctx.net.send(data)` goes to the game's server adapter, `ctx.net.on(fn)` receives its latest
  view. Games that ignore `net` still work online (see below).

## Online trials

`convex/trials.ts` runs a room through `TRIALS` (dinner → machine → grinder → machine → chamber
→ payout). Each trial is a `matches` row with a seed, a server `startAt`, the seats (living
humans, then bots up to the game's table size, with the limbs they still have) and the adapter's
state. The app's `/trials` screen follows `room.matchId` on every phone and remounts the WebView
for each trial. When a trial ends, the runner kills and maims players for real (`players.alive`,
`players.lost`), waits for the assessment card, then starts the next trial, or calls
`payout.settle` once one subject is left.

Server adapters live in `convex/games.ts` (`GAMES`). A game without one is skipped until it is
added. Two kinds exist:

- **Refereed** (Dinner Party): the server runs the same pure rules module as the page
  (`src/games/dinner-rules.ts`), decides every death and sends one view to all phones.
- **Self-reported** (`selfReported()`): every phone plays its own copy against bots and the app
  forwards its `result` (plus an optional `limbs: { [id]: Limb[] }` of what each subject kept);
  the trial ends when every human has reported. The Grinder runs this way (`grinder:
  selfReported()`).

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

### Shared-layer additions (all optional, existing games unaffected)

- `Surface.vel` (`gore.ts`): a conveyor velocity. Decals and resting gibs on that surface ride
  along with it and drop off its edges; mutate it as the belt changes speed.
- `Sound.grind`, `scrape`, `grab`, `klaxon`, and a looping `motor(on)` with `motorLoad(0..1)`
  (`audio.ts`).
- `BoardRow.label` (`hud.ts`) overrides the right-hand value text of a scoreboard row.
- `ctx.finish(placements, limbs?)` (`game.ts`): pass the limbs each survivor kept and `result`
  carries them as `limbs`, so the trial runner maims players for real. The Grinder reports a leg
  whose foot went into the teeth as lost.

## Games

- `dinner` (`src/games/dinner.ts`): Dinner Party. Eat while the host reads; he shoots movers.
- `grinder` (`src/games/grinder.ts`): The Grinder. Alternate left / right taps to haul back along
  the rails of a conveyor that feeds a meat grinder feet first; the same hand twice slips. The
  belt speeds up and surges, and it stops when 2 of 4 are left (1 of 2–3). The sim runs on a
  fixed 60 Hz step from the seed plus the human tap log, so it can be replayed or synced.

`src/games/dinner.ts` is the reference: room building, a scripted antagonist, bots, an execution
queue with slow-mo kills, and the round result. Its rules live in `src/games/dinner-rules.ts`, which
has no three.js and is imported by the Convex server too.
