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
Y shoots you. In Last Chamber (`?game=chamber`), Space / P / T pull, pass and turn it on your turn,
and K makes the next trigger pull a live round. In The Grinder (`?game=grinder`), A / D or the arrow keys
are the left / right hands, keys 1-3 feed bot 1-3 to the grinder, Y feeds you, and `?tp` swaps in a
side camera for checking poses.

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

`convex/trials.ts` runs a room through `TRIALS` (dinner → smoke → grinder → chamber → payout). Each trial is a `matches` row with a seed, a server `startAt`, the seats (living
humans, then bots up to the game's table size, with the limbs they still have) and the adapter's
state. The app's `/trials` screen follows `room.matchId` on every phone and remounts the WebView
for each trial. When a trial ends, the runner kills and maims players for real (`players.alive`,
`players.lost`), waits for the assessment card, then starts the next trial, or calls
`payout.settle` once one subject is left.

Server adapters live in `convex/games.ts` (`GAMES`). A game without one is skipped until it is
added. Three kinds exist:

- **Refereed** (Dinner Party): the server runs the same pure rules module as the page
  (`src/games/dinner-rules.ts`), decides every death and sends one view to all phones.
- **Self-reported** (`selfReported()`): every phone plays its own copy against bots and the app
  forwards its `result` (plus an optional `limbs: { [id]: Limb[] }` of what each subject kept);
  the trial ends when every human has reported. The Grinder runs this way (`grinder:
  selfReported()`); other humans are played by bots on each phone.
- **Lockstep** (Last Chamber): every phone runs the same seeded table, and the server only orders
  the humans' choices. The holder's phone sends `net` `{ kind: 'act', turn, action }`, the first
  proposal per turn wins, and every phone applies `view.actions[turn]` when it reaches that turn.
  If a holder's choice hasn't arrived 6 s after their clock runs out, another living human's phone
  proposes a pull for them. The first `result` decides the placements.

The page only accepts one `start`; to replay, remount the WebView (the play screen bumps its
`key`).

## Shared layer (`src/shared/`)

| file | what it gives you |
| --- | --- |
| `renderer.ts` | `Engine`: the Machine Party look (scene → ~1/3-res target → dither/posterize, grain, vignette, red danger `tint`, lens blood, flashes), `shake()`, `slowmo()`, `flash()`, fps `perf()`. `Flicker` for buzzing practical lights. `LensBlood` (`engine.lens`): `splat`, `burst`, `cover`. |
| `gore.ts` | `Gore`: blood particles that leave persistent decals on the `Surface`s and `Wall`s you give it, bouncing gibs, pulsing `stump`s, `explodeHead`, `gutSpill` (verlet intestines), `pool`, `muzzleFlash`, `throwObject`. Particles passing the camera splat the lens on their own. Call `update(dt)` every frame. |
| `rig.ts` | `Subject`: low-poly test subject in a numbered jumpsuit with a hat, seated or standing. Drive it with `eat`, `stab`, `chew`, `freeze`, `relaxed`, `lookAt`, `flinch()`, `die()`; gore via `explodeHead`, `severLimb`, `gutSpill`. `hand()` is the attach point for props. |
| `textures.ts` | Procedural low-res canvas textures: concrete, floor, rust, metal, wood, cloth, hazard, numbered jumpsuit, newspaper, blood splats. |
| `audio.ts` | `sound`: procedural WebAudio drone, mechanical beat (`intensity`, `bpm`), gunshot, squelch, crunch, splat, rustle, snap, clink, chew, sting, ring, `muffle`, and the revolver set: `spin`, `insert`, `cock`, `click`, `slide`, `coins`, `heartbeat`. Unlocks on first touch. |
| `hud.ts` | `Hud`: timer, pot, limbs, status line, scoreboard (a row's optional `label` replaces its `value/max` text), feed, stamp, rules card (`intro`), clinical `assessment` card. |
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



## Smoke Break (`src/games/smoke.ts`)

Machine Party's cigarette game. Hold to drag (the lung meter fills), let go inside the green zone for a
puff, then wait out the exhale before pressing again. Dragging to the end of the meter or pressing
during the exhale coughs: the subject is stuck for 1.7 s, the camera shakes and later coughs spray
blood. Five puffs finish a cigarette. After 55 s the subject with the fewest puffs (fewer coughs,
then a seeded tiebreak) is shot by the gun on the trolley; the others keep their limbs. Bots are a
chain smoker (greedy, coughs a lot), a careful one (slow and steady) and a panicky one (rushes when
last). Each bot has its own `Rng` seeded from the round seed, so a round replays identically from
the same seed plus the human's presses. Desktop: `?game=smoke` (hold mouse or Space); `&auto`
lets a careful bot play for you. No engine changes.

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

- `smoke` (`src/games/smoke.ts`): Smoke Break. Drag, exhale, don't cough; the fewest puffs is shot.
- `dinner` (`src/games/dinner.ts`): Dinner Party. Eat while the host reads; he shoots movers.
- `chamber` (`src/games/chamber.ts`): Last Chamber, Russian roulette for the pot (below).
- `grinder` (`src/games/grinder.ts`): The Grinder. Alternate left / right taps to haul back along
  the rails of a conveyor that feeds a meat grinder feet first; the same hand twice slips. The
  belt speeds up and surges, and it stops when 2 of 4 are left (1 of 2–3). The sim runs on a
  fixed 60 Hz step from the seed plus the human tap log, so it can be replayed or synced.

`src/games/dinner.ts` is the reference: room building, a scripted antagonist, bots, an execution
queue with slow-mo kills, and the round result. Its rules live in `src/games/dinner-rules.ts`, which
has no three.js and is imported by the Convex server too.

`src/games/chamber.ts` (Last Chamber) is turn-based: it fills empty seats with bots up to four,
draws from `ctx.rng` only when loading the cylinder and when a bot's turn starts, and applies every
choice through one `act(action)` call, so the round replays from the seed plus the ordered human
actions. Online, other humans' choices arrive from the server keyed by turn number (see Online trials);
without a server, other humans are played by a bot brain.
