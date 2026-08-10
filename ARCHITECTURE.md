# MARIO.CONE — Architecture Contract

**Read this fully before editing anything.** Many agents work on this repo in parallel.
The single rule that keeps that from exploding: **you edit only the files you own.**

---

## 1. What this is

A browser racing game in the spirit of Mario Kart 8 Deluxe, built in Three.js.
Racers are roadworks / transport machines: **Road Cone, Plane, Helicopter, Digger,
Train, Truck, Car**. Target quality bar is Nintendo first-party — not "good for a
web demo". If it would embarrass a Nintendo art director, it is not done.

Runs as a **static site with zero build step**. `three` is vendored in `vendor/`
and wired via an importmap in `index.html`. Open `index.html` through any static
server and it plays.

---

## 2. Golden rules

1. **Own your files.** The ownership table (§6) is authoritative. Never edit a file
   another module owns. If you need something from it, use the event bus or ctx.
2. **Never break `window.__GAME`.** The automated critics drive the game through it.
   If you break the harness, your work cannot be judged and will be reverted.
3. **Deterministic simulation.** All gameplay logic runs in `fixedUpdate(dt)` with a
   constant `dt`. Never use `Math.random()` in sim code — use `ctx.rng`. Never read
   wall-clock time in sim code.
4. **No network at runtime.** No CDNs, no fetch of remote assets. Everything is
   procedural or vendored. The game must run offline from `file://`-adjacent static
   hosting.
5. **60fps budget on a mid laptop.** Instance anything that appears more than ~20
   times. No per-frame allocation in hot paths — reuse scratch vectors.
6. **Leave it running.** Every commit must leave the game playable. Verify with
   `node tools/capture.mjs --smoke` before you finish.
7. **No backticks inside a CSS template literal — not even in a comment.** Most of
   the UI in this codebase is a several-hundred-line `` const CSS_X = `…` ``. A
   backtick inside one *closes* it, and because these are written in prose-commented
   style the offender is usually a pair of them quoting a property name inside a
   `/* … */`. The literal reopens on the second one, so the count stays even and
   the file looks balanced — meanwhile the text between them is parsed as
   TypeScript. `#race .row { flex: 1 1 0 }` quoted that way cost a green build and
   read as three unrelated syntax errors on one line. Quote with `"` inside CSS.

---

## 3. Frame model

Two clocks, never mixed:

- **`fixedUpdate(dt)`** — `dt` is always `1/120`s. All physics, AI, items, race
  logic, collision. Deterministic. Driven by an accumulator, may run 0..N times per
  frame (capped at 8 to avoid spirals).
- **`update(dt, alpha)`** — once per rendered frame. Visuals only: interpolation,
  cameras, particles, HUD, animation. `alpha` is the 0..1 blend between the previous
  and current fixed state. **Interpolate visual transforms with it** or motion will
  judder.

Anything that affects who wins the race goes in `fixedUpdate`. Anything that only
affects what it looks like goes in `update`.

---

## 4. System interface

Every system is a factory taking `ctx` and returning a system object. All hooks are
optional.

```js
export function createFooSystem(ctx) {
  let scratch = new ctx.THREE.Vector3();
  return {
    name: 'foo',
    order: 50,                  // lower runs first; see §4.1
    async init() {},            // build meshes, allocate. May await.
    reset(raceCfg) {},          // called at the start of every race
    fixedUpdate(dt) {},         // deterministic sim
    update(dt, alpha) {},       // per-frame visuals
    dispose() {},               // free GPU resources
  };
}
```

### 4.1 Execution order

Systems run sorted by `order`. Slots are reserved so ordering is predictable:

| order | stage |
|---|---|
| 10 | input sampling |
| 20 | track / world queries |
| 30 | kart physics |
| 40 | AI drivers |
| 50 | items & projectiles |
| 60 | collision resolution |
| 70 | race director (laps, positions, state) |
| 80 | camera |
| 90 | fx / particles / audio |
| 100 | HUD / UI |

---

## 5. The `ctx` object

Constructed once in `src/main.js` and passed to every system. Read freely; only the
owning system writes to its own slot.

```js
ctx = {
  THREE,                  // the three namespace
  scene, camera, renderer,
  bus,                    // event bus — see §7
  rng,                    // seeded deterministic RNG. rng.next(), rng.range(a,b), rng.pick(arr)
  config,                 // tuning constants (src/core/config.js)
  quality,                // { tier:'low'|'med'|'high', shadows, postfx, particles }
  input,                  // sampled input state (§8)
  time,                   // { elapsed, dt, alpha, frame }

  // filled in by the systems that own them:
  track,                  // active track instance (track/*)
  racers,                 // array of racer objects (§9)
  player,                 // shortcut to the human racer
  race,                   // race director state (§10)
  audio, fx, hud, ui, assets,
}
```

---

## 6. File ownership

**Edit only your row.** Shared files at the bottom need coordination.

| Module | Owns | Provides |
|---|---|---|
| **core** | `src/core/*`, `src/main.js`, `index.html` | engine, loop, harness, math, input, bus, config |
| **track** | `src/track/**` | spline, road mesh, surfaces, checkpoints, courses |
| **physics** | `src/physics/**` | kart controller, drift, collision |
| **vehicles** | `src/vehicles/**` | the 7 racer models, stats, animation rigs |
| **ai** | `src/ai/**` | CPU drivers, racing lines, rubber-banding |
| **items** | `src/items/**` | item roulette, all item behaviours, projectiles |
| **race** | `src/race/**` | countdown, laps, positions, results, minimap |
| **render** | `src/render/**` | lighting, sky, post-processing, materials, colour grade |
| **fx** | `src/fx/**` | particles, drift sparks, trails, impacts, confetti |
| **audio** | `src/audio/**` | engine sound, music, SFX — all synthesized |
| **ui** | `src/ui/**` | HUD, menus, transitions, fonts |
| **world** | `src/world/**` | scenery, crowds, props, animated set dressing |
| *shared* | `ARCHITECTURE.md`, `tools/**`, `progress.html` | coordinate before editing |

Need a change in someone else's file? Either emit an event they already listen for,
or state the request in your final report so the orchestrator routes it.

### The one exception: the coherence pass

Strict ownership is what lets many agents edit this repo at once, and it has a
cost that nothing above can pay. No row in that table owns the space *between*
the rows. Two agents each pick a defensible yellow, each passes its own critic,
and the game ends up looking like it was made by people who never met.

So `tools/coherence.workflow.mjs` runs one agent with **whole-repo ownership** and
no restrictions, judged by a critic who scores the game as a single work rather
than as a piece. It runs between waves and **never during one** — whole-repo
ownership and strict ownership cannot both be true at the same time, and the
builder loses that race silently.

If you are a wave builder, this is not your exception. It is not available to you
and asking for it is the same as asking to edit someone else's file.

---

## 7. Event bus

```js
ctx.bus.on('race:racing', fn)     // subscribe, returns unsubscribe fn
ctx.bus.once('race:finish', fn)
ctx.bus.emit('item:used', payload)
ctx.bus.inspect()                 // { event: listenerCount } — the dead-event check
```

Events are delivered **synchronously**. Emitting from `fixedUpdate` keeps sim
determinism; emitting from `update` must never mutate sim state.

Canonical events — add new ones to this list when you introduce them:

| event | payload | emitted by |
|---|---|---|
| `race:countdown` | `{ n }` (3,2,1,GO) | race |
| `race:phase` | `{ phase }` — a statement of state, safe to repeat | race |
| `race:<phase>` | `{}` — the *transition* into a phase: `race:intro`, `race:racing`, `race:finished`, `race:results`. Emitted as a template literal off `setPhase`, so a grep for the literal string finds nothing — `race:racing` is what the mixer plays the GO fanfare on | race |
| `race:lap` | `{ racer, lap }` — carries `lap`, which is also how the final lap is known; there is no separate event for it | race |
| `race:finish` | `{ racer, place, time, podium }` — fires once **per racer**, so anything that celebrates must test `isPlayer` first | race |
| `race:results` | `{ standings }` | race |
| `race:seek` | `{ phase }` — the harness jumped the race somewhere | race |
| `kart:drift:start` | `{ racer, dir }` | physics |
| `kart:drift:charge` | `{ racer, tier }` 1,2,3 | physics |
| `kart:boost` | `{ racer, source, power }` | physics |
| `kart:hop` | `{ racer }` | physics |
| `kart:land` | `{ racer, impact }` | physics |
| `kart:launch` | `{ racer }` — left the ground with air under it | physics |
| `kart:trick:start` / `kart:trick` | `{ racer, … }` | physics |
| `kart:bump` | `{ racer, other, … }` — kart on kart | physics |
| `kart:wall` | `{ racer, … }` | physics |
| `kart:slipstream` | `{ racer, … }` | physics |
| `kart:offroad` | `{ racer, surface }` | physics |
| `kart:hit` | `{ racer, by, kind }` | items |
| `item:box` | `{ racer, pos }` — a box was taken | items |
| `item:roulette` | `{ racer, phase:'start'\|'settle', duration?, item? }` | items |
| `item:reel` | `{ racer, index, remaining, total }` — one per face of the drum | items |
| `item:get` | `{ racer, item, count }` | items |
| `item:use` | `{ racer, item, count, forward }` | items |
| `item:bounce` | `{ kind, pos, bounces }` — shell off a barrier | items |
| `item:blast` | `{ pos, ownerId, radius }` — a gas bottle (`bomb`) went off | items |
| `item:strike` | `{ racer, by, item, kind }` — *what* hit you, before the stun | items |
| `item:reaction` | `{ racer, kind, force }` — the spin-out that follows a strike | items |
| `item:block` | `{ racer, by, item, blocked }` — a carried item ate the hit | items |
| `item:effect` | `{ racer, effect, on }` — star/bullet/shrunk/inked/boo | items |
| `item:steal` | `{ racer, from, item }` | items |
| `item:warn` | `{ racer, on, item, level, bearing }` — something is about to hit the player | items |
| `coin:get` | `{ racer, total }` | items |
| `coin:lose` | `{ racer, count, total }` | items |
| `race:bestlap` | `{ racer, time, lap }` | race |
| `race:jumpstart` | `{ racer, held }` — early, but not bogged | race |
| `race:rocketStart` | `{ racer, held, quality, tier, time, power }` | race |
| `race:burnout` | `{ racer, held, duration }` | race |
| `race:wrongway` | `{ racer, on }` — **edges only** | race |
| `race:pause` | `{ on }` | race |
| `race:handoff` | `{ to }` — the curtain is closing on this layer | race |
| `camera:mode` | `{ mode }` — the *player's* control | race / render |
| `camera:shot` | `{ shot, … }` — see below | race |
| `kart:onroad` | `{ racer, surface, from }` — tarmac regained | physics |
| `track:built` | `{ track }` | track |
| `quality:changed` | `{ quality }` | core |
| `engine:resize` | `{ width, height }` | core |
| `ui:menu` | `{ open, screen }` — **both edges.** The race sits behind the front-end and keeps simulating while it is up, so anything that draws over the game must stand off on this rather than infer it from `race.phase` | ui |
| `ui:menu:open` | `{ from }` — raise the front-end | anyone |

**Shots, not modes.** `camera:mode` is the player's own control — chase, far,
look-behind — and the race has no business spending it on ceremony. `camera:shot`
is the channel for the moments the race can compose better than a follow rig
can, and `render/camera.ts` answers all four: `grid`, `countdown`, `podium` and
`finish`. The director used to *borrow* `camera:mode 'near'` for the finish
because nothing answered the shot it was already emitting in full — racer,
place, podium, hold and lead — and the borrow silently took the lens off a
player holding look-behind or a reviewer who had asked for `overhead`. The lens
that borrow was lending now lives in `config.camera.victory` and the borrow
apparatus is gone. **Emitting a fully-specified request that nobody has
subscribed to is the same bug as an event with no listener**, and it is harder
to see, because a `bus.inspect()` count of zero looks like every other unused
channel rather than like a feature that was built twice and delivered never.

**An event with no listener is a bug, not a feature.** Eleven of the events
above were emitted every race into a room that had never had anybody in it, and
three of them were things a player *watched happen in silence*: the wrong-way
sign the director calls an alarm, the jump-start verdict, and a new best lap. If
you add an event, either wire something to it in the same pass or delete it —
an unheard emit costs frame time, costs the next agent's reading time, and makes
this table lie about what the game is.

**...and an event in this table that nothing emits is the same bug, pointed the
other way.** Cleaning up the unheard emits left five rows behind here —
`race:start`, `race:grid`, `race:finallap`, `race:exit` and `menu:launch` — all
correctly deleted from the code and all still advertised in this table, which is
worse than the disease. `race:start` is the name a new agent reaches for first,
and it would have waited for it forever; the flag is `race:racing`, and the
final lap is a number inside `race:lap`. Twelve live events were missing from
the table at the same time, so on the day this was checked the contract was
wrong in both directions at once.

Check it, don't trust it. `ctx.bus.inspect()` returns `{ event: listenerCount }`
for a live game and is the only honest answer for the listener side; note that
`grep` is **not** the honest answer for the emit side, because `setPhase` emits
`` `race:${phase}` `` as a template literal and audio subscribes through a local
`on()` wrapper. `node tools/journey.mjs` plays the game front to back and prints
both sides at the end.

**Hit kinds.** `item:strike` and `item:reaction` carry a `kind` from
`HitKind` (exported by `src/items/index.ts`), and it is the item system's
authoritative statement of *what the hit looks like*: `spin` (a slip — one
lazy turn, no launch, tyre smoke: a wheel chock), `flip` (a smash — launched, a
turn and a quarter, sparks: a hard hat or a gas bottle), `bump` (a shove —
mostly sideways, almost no rotation: a safety award, a pile driver, an air horn)
and `squish` (flattened on the spot: a power cut). Anything hanging a sound, a
particle or a camera move off a hit should read `item:strike`, not `kart:hit` —
physics emits the latter from `stunRacer` and only knows its own three-value
vocabulary.

**The roster is named in this game's own words, and the ids are not.** The item
set is a Wheel Chock, a Hard Hat, a Foreman's Hat, an Air Canister, a Safety
Award, a Pile Driver, a Power Cut, a Tar Sprayer, a Dust Sheet, a Gas Bottle, a
Coin and an Air Horn — every one of them a thing off a work site, like the
machines that throw them. The `ItemId` union in `types.ts` still reads `banana`,
`greenShell`, `bomb`, `blooper`, `boo`; those are the *identifiers* the whole
game switches on and renaming them would be churn no player could see, so
`banana` is the id of a wheel chock. `ITEMS[id].name` in `src/items/defs.ts` is
the only thing that may be shown to a player, and `src/items/models.ts` is what
each one actually is. Anything drawing an item — an icon, a slot, a menu — draws
the object in `models.ts`, not the object in the id.

**Timing the reel.** `item:roulette` `start` carries `duration` — the seconds
that spin will actually run — and `item:reel` fires once per face of the drum
with `remaining` counting down to zero on the settle. A slot drawn by another
module can therefore decelerate on the item system's own clock instead of
mirroring `SPIN_PLAYER` as a constant of its own. Note that the reel's length is
**simulation** time: the engine's rAF loop steps the sim off the wall clock, so
any tool that renders a frame and then does something slow (a screenshot under
software GL costs 100-300ms) advances the game underneath itself. Call
`__GAME.setTimeScale(0)` before timing anything frame by frame, and read
`__ITEMS.probe().spin` / `.spinTotal` rather than inferring the duration from
when `racer.item` changed.

**A cancelled roulette.** `item:roulette` always comes in pairs: a `start` is
always followed by a `settle`, so anything that begins a loop on the first can
end it on the second without a timeout of its own. A `settle` that carries **no
`item`** means the spin was thrown away rather than landed — lightning struck
the racer mid-draw, the flag fell, or the reviewer's bench put something
straight into the slot. Treat it as "the reel stopped and there is nothing in
the slot", never as a draw.

**Invulnerability vs immunity.** `racer.invulnerable` is a *short* timer with a
visual meaning attached: the vehicle rig blinks any racer carrying it, which is
correct for the second after a hit and wrong for anything longer. The item
system therefore keeps its long protections — a star, a bullet bill, a boo — in
`racer.effects` and only hands the last fraction of a second to
`invulnerable`, as the tell that it is about to run out. Anything asking "can
this racer be hurt" must check `effects` for `star`, `bullet` and `boo` as well
as `invulnerable`, or use the item system's own `strike` path, which does.

**The incoming warning.** `item:warn` fires on the two *edges* only — once when
something starts being on course to hit the player and once when it stops — so a
siren can be started and stopped without polling. It is a **time-to-impact**
signal, not a proximity one: nothing is reported unless closest approach puts it
inside a kart's width of the player within the next 1.6s, so it is silent for
most of a lap and means something every time it is not. `level` is 0..1 and
reaches 1 on the frame of impact; `bearing` is where the threat is in the
player's own frame — 0 dead ahead, positive to the right, ±π behind.

The item system integrates the spin-out itself, in `fixedUpdate` at order 50,
*after* the kart model has stepped: it holds the racer's world-space direction
of travel fixed, rotates the heading about it, decays the speed, and writes
`pos`/`vel`/`yaw`/`quat`/`stunned` for the duration. Nothing else may drive a
stunned racer at the same time.

---

## 8. Input

`ctx.input` is sampled once per fixed step. **Never read the keyboard directly** —
the critics inject synthetic input through the harness, and direct DOM reads bypass
it, making your feature untestable.

```js
ctx.input = {
  steer: -1..1,       // analog
  accel: 0..1,
  brake: 0..1,
  drift: bool,        // held
  item: bool,         // pressed this step
  look: -1..1,        // look behind / camera
  pressed: { drift, item, pause, ... },  // edge-triggered, true for one step
}
```

---

## 9. Racer object

Shared shape produced by `physics` + `vehicles`, read by everyone.

```js
racer = {
  id, name, vehicleId, isPlayer,
  pos, vel, quat,         // THREE.Vector3 / Quaternion — sim truth
  prevPos, prevQuat,      // previous fixed step, for render interpolation
  visual,                 // THREE.Object3D — the thing on screen
  speed, maxSpeed, steerAngle,
  drift: { active, dir, charge, tier },
  boost: { time, power, source },
  grounded, surface,      // 'road'|'dirt'|'grass'|'rail'|'water'|'air'
  lap, checkpoint, place, progress,  // race director writes these
  coins, item, stunned,
  stats: { speed, accel, weight, handling, traction },
}
```

---

## 10. Race director state

```js
ctx.race = {
  phase: 'intro'|'countdown'|'racing'|'finished'|'results',
  time, laps, totalLaps,
  standings: [racerId...],   // sorted, index 0 = 1st
}
```

---

## 11. The test harness — `window.__GAME`

This is how every critic sees your work. **Do not break it.**

```js
window.__GAME = {
  ready: bool,
  version: string,

  // deterministic control — advances the sim without needing realtime
  step(seconds),              // run fixed steps totalling `seconds`, no render
  render(),                   // render one frame
  advance(seconds),           // step + render, for capture sequences
  reset(opts),                // { track, vehicle, racers, seed, class }

  setInput(partial),          // { accel:1, steer:-0.5, drift:true } — sticky until changed
  press(name),                // one-shot edge input

  snapshot(),                 // plain-JSON dump of race + racer state
  stats(),                    // { fps, drawCalls, triangles, programs, ms }
  setCamera(mode),            // 'chase'|'far'|'cinematic'|'free'|'front'
  setQuality(tier),
  seek(phase),                // jump straight to 'racing' | 'results' etc.
}
```

`step()` must be pure sim — no `requestAnimationFrame`, no wall-clock. That is what
makes screenshots reproducible on a software renderer.

---

## 11a. One product, two halves — the rules that hold them together

Everything before the flag is `ui/menus`; everything after it is `race/` plus
the HUD. They are two codebases with a curtain between them, and every seam a
coherence pass has ever found lives on that curtain. Six things are now shared
rather than reimplemented, and they are shared *as code*, not as a convention:

- **The plate.** `plateCss(scope)` in `src/ui/theme.ts`, called by `#hud`,
  `#menu`, `#race` and `#coach`. This was the last one, and it was the loudest:
  the same twenty lines existed in four hand-copies, and they had already come
  apart. The race's corner radius was 10% tighter than the other two and its
  drop shadow a different alpha; the coach card had abandoned the shared parts
  altogether — a 1px hairline where every other sign carries a `.12u` black rim,
  no chevron texture, and a hazard strip made of *separated dashes* against
  everybody else's solid gold bar. Photographed together on the pause screen,
  the CONTROLS card and the PAUSED plate four hundred pixels away read as two
  products. `theme.ts` was already the answer for the curtain, the cursor, the
  rail and the map and stopped one item short of the thing all four layers are
  actually made of.

- **Type.** `src/ui/letters.ts` is the game's display face and `src/ui/glyphs.ts`
  is its numerals. The rule: anything that **names** something is drawn from one
  of those two; anything that **describes** — a blurb, a class copy line, a unit
  caption, a keycap legend — is set in Trebuchet. Nothing sits between. The
  front-end used to imitate the drawn face in stacked text-shadows, and the
  imitation did not survive a hand-off one second wide.
- **The curtain.** `curtainCss` / `curtainTransform` / `CURTAIN_IN` /
  `CURTAIN_OUT` in `src/ui/theme.ts`. The menu's launch board and the race's
  results hand-off are the same gesture and are now the same object; the hold is
  the only per-caller argument.
- **The cursor.** `cursorRing` and `CURSOR_CHEVRON` in `ui/theme.ts`. A gold
  outline ring with a chevron on its leading edge, on both sides of the flag. A
  fill was the alternative and it cannot go on a cell that is a picture.
- **The prompt rail.** `hintKey` and `hintCss` in `ui/theme.ts`. One set of
  keycaps, and every rail states only keys that do something from where the
  player is standing.
- **The circuit diagram.** `MAP` in `ui/theme.ts`, drawn by `courseMap()` on the
  select cards and by `ui/minimap.ts` in the HUD. The same road, the same
  chequer on the start.

The colour pipeline is shared too: the menus' 3D set runs `installFilmStock`
from `render/grade.ts` at `EXPOSURE_TRIM`, which is the same grade and the same
exposure the race is composited through. Note that "shared" means *every* write:
the set's wipe dimmer rebuilt its base exposure from the literal the fix had
just removed, so the constructor set the shared value and the next frame put the
old one back. A shared constant with a second copy downstream of it is not
shared, it is decorated.

**The race does not stop when the menus come up.** It is built at boot and keeps
simulating behind an opaque front-end, so `ctx.race.phase` walks `intro` →
`countdown` → `racing` while the player is still on the title screen. Anything
in `ui/` or `race/` that draws over the game, or runs a clock, must therefore
stand off on the **`ui:menu`** edges — never infer it from `race.phase`, which
cannot tell you. `race/director.ts` does this (`frontEndOpen`) and `ui/coach.ts`
now does too; before it did, the controls card appeared over the title screen
and the machine roster for a few seconds and then vanished, sat on the launch
card *during the hand-off curtain*, and — worst — burned its one-shot tutorial
cues on an empty title screen, since every cue fires once per page load and the
race behind the menu had been "racing" for nineteen seconds.

`race.phase === 'loading'` is likewise **not** "the front-end is up": `pause`
uses the same value. Pause has its own edges on `race:pause`.

---

## 12. Art direction

The look is **Nintendo-clean, saturated, readable, joyful**. Specifics:

- **Silhouette first.** Every racer must be identifiable as a black shape.
- **Bold flat colour + soft gradient**, not photoreal PBR. Materials read as
  painted vinyl/plastic. Low roughness variation, strong rim light.
- **Warm key, cool fill.** Sun is warm; sky bounce is cool. Never flat ambient.
- **Contact is everything.** Every object needs a grounded shadow. Floating objects
  look fake instantly.
- **Readability over detail.** The road must always be obvious at speed. Track
  edges get high-contrast trim. Hazards read in peripheral vision.
- **Squash, stretch, anticipation.** Nothing moves linearly. Karts lean into turns,
  dip on landing, recoil on hits.
- **Constant micro-motion.** Flags ripple, crowds bob, dust drifts, banners sway.
  A still frame should still feel alive.
- **Celebrate everything.** Boost = screen effects + sound + particles + camera kick.
  Reward the player's eyes for every input.

Palette anchor (roadworks/high-vis, distinct from Nintendo's own IP):
safety orange `#FF6B1A`, hazard yellow `#FFC300`, asphalt `#3A3D46`,
sky cyan `#5FC8F5`, grass `#6FCF4A`, white `#FFF8F0`.

---

## 13. Definition of done for any piece

- Runs at 60fps in the target budget.
- Looks intentional from every camera angle a player can reach.
- Has motion, sound, and feedback — no silent, static state changes.
- `node tools/capture.mjs --smoke` passes.
- Nothing in the console. No warnings, no errors.
