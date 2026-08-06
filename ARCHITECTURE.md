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

---

## 7. Event bus

```js
ctx.bus.on('race:start', fn)      // subscribe, returns unsubscribe fn
ctx.bus.once('race:finish', fn)
ctx.bus.emit('item:used', payload)
```

Events are delivered **synchronously**. Emitting from `fixedUpdate` keeps sim
determinism; emitting from `update` must never mutate sim state.

Canonical events — add new ones to this list when you introduce them:

| event | payload | emitted by |
|---|---|---|
| `race:countdown` | `{ n }` (3,2,1,GO) | race |
| `race:start` | `{}` | race |
| `race:lap` | `{ racer, lap }` | race |
| `race:finish` | `{ racer, place, time }` | race |
| `race:results` | `{ standings }` | race |
| `kart:drift:start` | `{ racer, dir }` | physics |
| `kart:drift:charge` | `{ racer, tier }` 1,2,3 | physics |
| `kart:boost` | `{ racer, source, power }` | physics |
| `kart:land` | `{ racer, impact }` | physics |
| `kart:offroad` | `{ racer, surface }` | physics |
| `kart:hit` | `{ racer, by, kind }` | items |
| `item:get` | `{ racer, item }` | items |
| `item:use` | `{ racer, item }` | items |
| `coin:get` | `{ racer, total }` | items |

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
