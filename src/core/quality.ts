// The quality governor: what the game gives up, when, and on whose evidence.
//
// ── 1. The instrument, because four rounds of this file were lost to it ─────
//
// The verdict is taken from **wall time between delivered frames**, sampled
// here rather than off `budget.wallMs`, and everything else in this file
// depends on that choice being right.
//
// It is not `budget.meanMs`. That is CPU work — `fixedUpdate`, the systems'
// `update`, and the call to `renderer.render()` — and the last one returns when
// the command buffer is handed to the driver, not when the picture exists. On a
// GPU-bound machine the frame's cost lands in the gap before the next callback
// where nothing was looking. Measured live at 1600x900 on a software
// rasteriser: `meanMs` averaged 23ms while real frames arrived 250ms apart. The
// governor read 23, called it "in band", and sat at the top rung for five and a
// half minutes while the player watched four frames a second.
//
// This file needs a short window it can reset the moment it changes something,
// and it needs the spread — the worst frame and the share that hitched — not
// just a mean. A game that averages 12ms and stutters to 40ms every twentieth
// frame is not a game running well, and a mean cannot say so.
//
// **Nothing about a frame's duration is ever evidence that it was not a frame.**
// A frame is discarded only when something observable says the *race* was not in
// it: a `visibilitychange` edge, the harness having stepped the simulation
// inside the gap (`budget.benchSteps`), or this file having switched the draw
// off (`budget.skipDraw`). All three are causes rather than symptoms, and all
// three are counted in `probe()` as `suspended`, `hijacked` and `undrawn` —
// because an instrument that silently throws things away is exactly how the
// rounds before this one were lost. An earlier rule discarded any frame longer
// than two seconds; on a machine delivering frames 1.7 to 2.6 seconds apart it
// threw away most of them and the warm-up it fed accrued 1.66 seconds in 200.
//
// `budget.meanMs`, `meanSimMs` and `meanDrawMs` are still read, but only to
// *attribute* a frame the wall clock has already convicted — see `boundBy`,
// whose one-word answer is appended to the governor's status precisely so that
// a reviewer reading `ms: 145` next to `liveWallMs: 1400` can tell that both
// are true and which one the frame is made of.
//
// ── 2. The unit rule: a gate is denominated in the thing it gates ───────────
//
// At 0.7 delivered frames a second — the state this file exists for — one
// delivered frame is 1.43 seconds of wall time and 0.067 seconds of *race*
// time, because `engine.ts` caps the fixed step at eight per frame and the
// simulation drops into slow motion underneath. A second is not a second is not
// a second, and three rounds were lost to gates denominated in the wrong one: a
// warm-up counted in 240 rendered frames, which a machine too slow to render
// cannot reach; a stall filter counted in milliseconds, which discarded exactly
// the frames the governor exists to measure; and a moment gate reading
// `race.phase`, which ARCHITECTURE §11a says outright cannot see the front-end.
//
// Four units, and the rule for choosing between them:
//
//   a statistic         → delivered frames. Samples are what a median has.
//   a beat of the game  → race seconds (`ctx.race.time`). The countdown is
//                         three race-seconds long at every frame rate.
//   a person waiting    → wall seconds of delivered play (`liveSeconds`).
//   a machine's speed   → milliseconds between delivered frames.
//
// ...and the corollary: **every refusal in this file is a wait, and the test is
// not "does this terminate" but "how long is this in wall seconds on the
// machine the file exists for, and is that a number anybody would defend out
// loud".** A countdown sealed with no door measured 56 seconds of delivered
// play at 1.2fps. Every gate whose length depends on the frame rate has a valve;
// the only ones without are `loading` and `paused`, whose length does not.
//
// ── 3. The audit ───────────────────────────────────────────────────────────
//
// Every gate, threshold and accumulator, what it is denominated in, and what it
// is worth at 0.7fps. This is the list the third round was lost for not having.
//
//   WARMUP_S 3             wall s of delivered play   2 frames        ok (*)
//   PANIC_ARM_S 1.4        wall s of delivered play   1 frame         ok (*)
//   MIN_SAMPLES 6          delivered frames           8.6s            ok
//   PANIC_SAMPLES 4        delivered frames           5.7s            ok
//   VERDICT_SAMPLES 14     delivered frames           20s             ok
//   SKIP_FRAMES 3          delivered frames           4.3s            ok
//   WALL_WINDOW 64         delivered frames           91s of history  ok
//   DOWN/LATE/PANIC/UP     ms between delivered frames   unchanged    ok
//   UP_WORK_MS, UP_WORST   ms of CPU work             unchanged       ok
//   FUTILE_*, RETRY        dimensionless ratios       unchanged       ok
//   BENCH_HOLD 4, BURST 1  wall s                     3 / 1 frames    ok
//   UP_DWELL 9             wall s under budget        unreachable     ok
//   liveSeconds            wall s of delivered play   honest          ok
//   CEREMONY_PATIENCE 20   wall s inside the sweep    a valve         ok
//   SEAL_PATIENCE 35       wall s inside one beat     a valve         ok
//   FRONT_END_PATIENCE 12  wall s behind the menu     a valve         ok
//   CEREMONY_GRACE 2.2     race s after the flag      33 frames       ok
//   LAUNCH_PATIENCE 22     wall s inside the launch   a valve         ok
//   RUNG_GAIN 1.2          dimensionless ratio        measured        ok
//   minPx / shellPx        screen pixels of radius    scale-relative  ok
//   crowd / scatter        shares of a population     dimensionless   ok
//   SHELL_MIN_M 28         metres from the camera     frame-rate-free ok
//   MEMORY_SETTLE_S 10     wall s at one rung         a person        ok
//   MEMORY_SETTLE_FRAMES   delivered frames           14s at 0.7fps   ok
//   SESSION_WINDOW 512     delivered frames           the session     ok
//   THIN_KNEE_PX 6         screen pixels of radius    scale-relative  ok
//   thinFar                a share, at zero size      dimensionless   ok
//   SEAM_HELD              a class, not a number      events (**)     ok
//   COLLAPSE_FACTOR 5      ms between delivered frames unchanged      ok (r8)
//   COLLAPSE_FRAMES 2      delivered frames           2.9s            ok (r8)
//   COLLAPSE_SAMPLES 2     delivered frames           2.9s            ok (r8)
//   COLLAPSE_DWELL 1.2     wall s of delivered play   1 frame         ok (r8)
//   SCALE_HOLD_S 2         wall s of delivered play   1 frame         ok (r8)
//   PANIC_MAX_STEP         rungs per change           the ladder      ok (r8)
//   skipDraw frames        not a unit — discarded     see `undrawn`   ok (r8)
//   SCALE_RAMP 0.04        scale per 16.7ms of frame  1 frame (***)   ok (r9)
//   THIN_KNEE_PX (r9)      pixels of the **scene** buffer, not the canvas
//   UP_MAX_STEP            rungs per change           the ladder      ok (r11)
//   PACED_FRAC 0.92        share of the target period a *best* frame  ok (r11)
//   CLIMB_PUNISH_S 8       wall s of delivered play   1 frame         ok (r11)
//   RUNG0.drawCalls        submissions per frame      derived         ok (r11)
//   RUNG0.triangles        triangles per frame        a tripwire      ok (r11)
//   RUNG0.cpuMs 4.0        ms per **60fps** frame     see STEPS_AT_60 ok (r11)
//
//   `RUNG0.cpuMs` is the one new row with a unit trap in it, and it is the
//   trap this section exists for: `budget.simMs` is however many fixed steps
//   the *drawn frame* ran, which is two for a player at 60fps and six for the
//   capture harness driving `advance(1, 20)`. A ceiling quoted per frame and
//   compared against a bench's per-frame reading convicts the game of being
//   three times its own cost, on the bench that runs the gate. `gate()`
//   normalises per step. See `STEPS_AT_60`.
//
//   (***) The one gate in this file that is deliberately *not* denominated in
//   any of the four units, because it governs an animation rather than a
//   decision, and an animation is frames at a rate. Read the row as "the whole
//   traverse in 0.21 wall seconds": thirteen frames at 60fps, four at 20fps,
//   one at 0.7fps. The degenerate case is the correct one and it is argued at
//   `SCALE_RAMP` — a machine delivering a picture every 1.4 seconds has no
//   motion for a dissolve to live in, and thirteen frames of easing would be
//   eighteen seconds of the worst frame rate in the session.
//
//   (*) `WARMUP_S` and `PANIC_ARM_S` stay in wall seconds on purpose: they gate
//   a statistic, the sample counts beside them are what binds on a slow
//   machine, and the thing they wait out — shader compilation, texture upload,
//   the JIT — is wall-clock work.
//
//   (**) The seam rule is the one entry that is not a number, deliberately.
//   "Wait N seconds before doing X" is the shape every gate here has been failed
//   for; "do it at boot, at a race build, or when the browser is already doing
//   it" is a set of *events*, and an event has no unit to get wrong.
//
// The round-eight rows are one number between them: **the whole descent, from
// the first over-budget frame to the floor with its resolution installed, is
// two delivered frames and 1.2 seconds.** It was fifty to seventy seconds of
// delivered play, walked as two three-rung pops with a fourteen-sample verdict
// in between, and a minute of the worst picture the game can draw is not a
// rescue. See `COLLAPSE_DWELL`.
//
// ── 4. What is on the ladder, and why it is not one lever ───────────────────
//
// A ladder made of one lever runs out. The first one here was made of render
// scale: measured on a frozen racing frame at 1600x900, rung 0 to the floor
// went 640,276 triangles to 616,846 and 296 draw calls to 253 — **3.7% of the
// geometry** — and bought 2.1x, all of it resolution. A machine needing more
// than 2.1x reached the bottom, was handed a 736x414 picture, and still missed.
//
// `drawDistance` was the only content lever on it and it was not one:
// `world/index.ts` switches each dressing batch on its *centre* against a
// per-kind range, the batches are sector-split across a 2.5km circuit, and the
// ones that cost anything are beside the camera at every draw distance. 1.0 to
// 0.5 removed 23k triangles out of 640k.
//
// ── ...and what the frame is actually made of ──────────────────────────────
//
// **Every table in this file is now taken on the `racing` shot** — the exact
// recipe `tools/capture.mjs` publishes to `shots/racing.png`, at 1600x900,
// which is the frame a reviewer is looking at when they read these numbers.
// That sentence is round eleven's whole contribution to this section, and it is
// there because the alternative was caught: the audit here said 457 draw calls,
// the walk on `LADDER` said 189, `tools/framehalf.mjs` said 473, all three were
// captioned "one frozen racing frame at rung 0", none of them agreed with each
// other, and the game reported 480 for the frame they claimed to describe. Every
// "what a rung is worth" number in the file was quoted off the lightest of the
// three. The audit is also frustum-aware now (`AuditRow.drawn`), so a table here
// and `stats()` are the same measurement and can be checked against each other
// by anyone who doubts them — which, on the evidence, they should.
//
//   group        drawn   shadow   drawn triangles   meshes  materials
//   world           59       32           196,608      114          7
//   track           12        5           168,470       23         22
//   the field      173        7            31,920      208         82
//   coins            4        0            25,688        4          2
//   itemBoxes        5        0            24,304        6          6
//   itemRig         16        3             1,338       16         16
//   everything     277       47           449,960      407        160
//
//   `stats()`   338 draw calls   663,240 triangles   90 programs
//
//   world:crowd0/1/2      24 instances   113,208 triangles
//   world:standCrowd(S)    3 instances    59,124 triangles
//   world:cone           375 instances    34,500 triangles   0.6m across
//   world:drum            79 instances    13,588 triangles
//   world:tyres           53 instances     9,540 triangles
//
// Three things in that table are worth more than the rest of this comment.
//
// **The frame is draw calls, not triangles.** The seven machines are 180 of the
// 324 scene submissions for 7% of the triangles; the crowd is 113k triangles in
// three. A ladder that spends triangles is spending the cheap thing. That is
// what `RUNG0` is derived from and what `ShadowShell` acts on — 480 draw calls
// to 338 without touching a pixel or a triangle.
//
// **The crowd is the largest population in the game by a factor of four** —
// 172k triangles against the verge's 58k — where the old census had them within
// a third of each other. It costs three draws, which is why it is a triangle
// lever and not a submission one.
//
// **The road is not a rounding error**: `ground` alone is 62k triangles in a
// single draw, more than every traffic cone on the course put together, and it
// belongs to `track/` rather than to this ladder.
//
// So every rung carries **content** as well as resolution: the population of
// the verge, the population of the stands, the seven machines' meshes, and the
// sub-pixel dressing. What the ladder is worth in *time* is the number that
// matters and it is measured pairwise below. See `ContentTrim`, `LADDER`,
// `censusContent` — and `RUNG0`, which is what rung 0 has to fit inside.
//
// ── 5. The seam rule, and what round eight took back out of it ──────────────
//
// A lever is **seam-held** when the player can watch the change happen — not
// "is the after-picture worse", every rung is worse, but *can the change itself
// be seen*. Round seven found this by playing the game rather than by reading a
// log: the governor spent `crowd` mid-race on the start/finish straight and a
// packed grandstand became bare grey terracing between one frame and the next,
// forty metres in front of the player. No timing instrument in this file could
// ever have caught that; a `setDrawRange` costs nothing at all.
//
// Three levers are behind the seam and land at boot, at a race build behind the
// closed launch board, or at a window resize: `crowd`, `aa`, `drawDistance`.
// Seven are live, every one either denominated in projected pixels — so the
// only things it can move are already too small to resolve — or invisible on
// the frame it lands: `scale`, `tier`, `particles`, `minPx`, `thinFar`,
// `scatter`, `shellPx`. See `SEAM_HELD` for the measurements behind each.
//
// **Round eight moved two of them.** Round seven's list had six behind the
// seam, and the review that followed measured what that cost: at the floor,
// mid-race, 150 seconds of live play at 1280x720, the frame still read
// `renderScale 1.00`, `aa true`, `tier 'high'`, `drawDistance 1` and a 1280x720
// backing store. The only setting that had moved was `particles`. **The whole
// in-race authority of a seven-rung ladder was 22% of the geometry, 13% of the
// draw calls and none of the pixels** — a struggling player rode the entire
// race at full cost while the ladder walked to its own floor and installed the
// fix for the *next* race.
//
//   `scale` came out because its reason had gone. It was deferred for a
//   *swap-chain rebuild* — 3101ms live at 1280x720 — and because
//   `setPixelRatio` shrinks the canvas underneath a DOM HUD that stays at
//   native resolution. Neither is a fact about resolution; both are facts about
//   that one call. The measurement table on `precompileLadder` had the answer
//   in it and it was read as a negative result: *the eight post targets resized
//   by hand, 229ms against a 225ms median — zero*. `render/post.ts` now
//   implements `setRenderScale`, the world is drawn into targets it owns at a
//   fraction of their size, and the canvas never moves at all. What is left is
//   a picture that goes slightly soft, which is a degree of the same thing
//   every rung does. Rate-limited to one landing per `SCALE_HOLD_S`; inherits
//   the moment gate from the rung change that asked for it. See `freeScalePath`
//   and `serviceScale`, and note that `scaleFlushes` now stays at **0** for the
//   life of a session.
//
//   `tier` came out because holding it made `ctx.quality.tier` a lie: at the
//   floor, mid-race, it read `high`. Exactly one module reads it —
//   `render/lighting.ts`, `SHADOW_EXTENT`, 62 / 52 / 46m — so the whole
//   measurable content of a live tier change is the outer edge of the shadow
//   frustum moving ten metres on a frame already drawn at half resolution.
//   `low` is also *reachable* now: the ladder used to select only `high` and
//   `med`, so every module branching on `low` was branching on dead code. It
//   does not mean `config.quality.low`, which is the cliff below.
//
// Two things follow that are in the code rather than here. A futility verdict
// does not survive a seam (`flushSeam`), because every judgement taken between
// two seams was taken on a cut that was only half made. And `composeSettings`
// reads the seam-held fields off a different rung index from everything else,
// so a mid-race rung is genuinely two rungs at once until the next race build.
//
// ── 6. The three things that make a governor either useful or a menace ──────
//
// **0. It must not be a cliff.** Every rung keeps the shadow map, the post
// stack, the bloom and the atmosphere, so **the whole ladder compiles one
// program set** and cannot hitch on the way down. The floor rung two ladders
// ago was `config.quality.low`: it took the program count from 75 to 110 and
// cost a **762ms** frame — the ladder's rescue move being the worst hitch of
// the session — and it left the cone standing on the dirt casting nothing while
// `world/`, `track/` and `render/` all still believed in the one shadow policy
// ARCHITECTURE §12 describes. A governor may spend the game's looks; it may not
// contradict the game's art direction. The shadow map is one size for the whole
// ladder for the same reason: the range 2048 -> 256 is worth 2% of a frame and
// its *realloc* is +262ms. See `SHADOW_PX`.
//
// **1. It must not oscillate.** The thresholds are far apart. The dwells are
// asymmetric — a rung is lost after 1.2s over budget and regained only after 9s
// under it. Every change is followed by a lockout long enough for its own
// transient to pass. And climbing back demands measured headroom as well as a
// wall clock, because a vsync-locked 16.7ms says nothing about how close to the
// edge the machine is.
//
// **...and the asymmetry belongs in the dwells, not in the step size.** Round
// eleven's reviewer measured what happens when it leaks into both: the drop can
// pop six rungs in `COLLAPSE_DWELL`'s 1.2 seconds and the climb was a hardcoded
// `index - 1` behind 9s of dwell, 2.2s of settle **and** `onAStraight()`, which
// over 480 samples of real Cone Canyon racing was open on 110 of them (22.9%).
// Seventy seconds to walk back up what a garbage collection took in one — most
// of a three-lap race at 640x360 and a sixth of the grandstand, on a machine
// that was fine. The climb is sized from measured headroom now, and the thing
// that stops a sized climb becoming the oscillation is `sprintFloor`: a bet
// that gets punished sets a wall, and everything above the wall is still walked
// one rung at a time. See `sizedClimb`.
//
// **2. It must not change at a moment the player is looking at.** Three
// questions, in the order they can be trusted: is the front-end up (an edge,
// published by the module that owns the screen), is the game paused (an edge),
// and only then what the race thinks it is doing — `race.phase` cannot see the
// front-end and a session where it was the only opinion made three of five rung
// changes with the title screen on the display. Then the curvature lookahead:
// the frames that blow the budget are the frames where a lot is happening, so a
// naive ladder does all its switching at the apex.
//
// Two amendments, both measured. **How many times** matters as much as when: a
// machine forty times too slow is not one rung away and the number saying so is
// right there, so one change is *sized* from the evidence rather than repeated
// (see `sizedStep`) — six changes in two hundred seconds, three of them inside
// three and a half race-seconds of the flag, was the session that found it. And
// **a machine five times over the budget has no composed picture to protect**:
// the gate's doors are 20-35 wall seconds, which is right when the thing behind
// them is a countdown the player can watch and wrong when it is a slideshow.
// The collapse path is the only branch here that does not consult
// `pictureLocked()`. See `COLLAPSE_FACTOR`.
//
// **3. It must never touch the simulation.** There is no `fixedUpdate` in this
// file and there never may be. Everything the governor writes — `ctx.quality`,
// the renderer's shadow flag, the render resolution, and four flags on the
// scene graph (`visible`, `castShadow`, `InstancedMesh.count`, `drawRange`) —
// is read only from `update` and from the draw. Nothing in physics, ai, items, race or track
// reads `ctx.quality` at all. `tools/qualitydiff.mjs` proves it by running one
// seed at both ends of the ladder and diffing the snapshots, and it takes the
// ladder's *last* rung, whatever the ladder currently is, so adding rungs
// cannot quietly exempt them:
//
//   qualitydiff — seed 7, cone-canyon, 30s, rungs 0 vs 6
//     rung 0  high   2048 / dd 1.00 / p 1.00 |  316 calls  625,982 tris
//     rung 6  floor  2048 / dd 0.55 / p 0.34 |  307 calls  583,446 tris
//     control: two runs at rung 0 are byte-identical
//     identical at every checkpoint: position, speed, lap, place, coins, item
//     PASSED
//
// Re-run in round eleven with `ShadowShell` in place, which is the addition
// most worth pointing this bench at: it writes `castShadow` on meshes that
// belong to `vehicles/` and it does it **every frame**. `castShadow` is a
// renderer flag and no `fixedUpdate` in the game reads it — but "no fixedUpdate
// reads it" is an intention until something checks, and six checkpoints across
// seven racers at both ends of the ladder is the check.
//
// ── 7. The one thing on this list that is not a quality cut ────────────────
//
// `budget.skipDraw`. It gives up nothing: the frame it removes is a frame the
// compositor was throwing away, drawn underneath a front-end whose own opaque
// set covers the display edge to edge. Measured at 1600x900 under a software
// rasteriser on the untouched title screen, with nothing touching `__GAME`:
//
//                        before            after
//   PRESS START          0.5-0.9 fps       0.8-1.1 fps
//   frame                1170-1822 ms      903-1196 ms
//   race draw calls      356-538           0
//   race triangles       794k-827k         0
//
// ...and the *governor* column of that table was the round-eight defect. With
// `skipDraw` on and the race drawing 0 calls and 0 triangles, it still walked
// rung 0 -> rung 3 behind the menu and settled into `panic (judging last cut)`,
// then wrote the answer to `localStorage`. Every one of those frames was made
// by `ui/menus/stage.ts`'s own second renderer, which this file does not size
// and whose own comment admits it "cannot hear this ladder": the governor was
// cutting the race's content to pay somebody else's bill on a screen where the
// race was not drawn at all, and remembering the wrong answer for next time.
//
// Those frames are now **discarded**, exactly like a frame the harness drove.
// They feed neither `liveWallMs` nor `liveSeconds` nor any dwell, they cannot
// arm a drop, and they are counted as `undrawn` in the probe so the discard is
// visible rather than silent. Behind an opaque front-end the governor reports
// `undrawn (race not in this frame)` and does nothing, which is the only honest
// thing it can do about a frame it does not own. See `undrawnFrame`.
//
// The remaining cross-module request stands: `ui/menus/stage.ts` sizes its
// backing store from a hardcoded `Math.min(1, 1200 / w)` and cannot hear the
// `scale` this file publishes on `quality:changed`. One line —
// `Math.min(1, 1200 / w) * scale` — and the front-end's own frame becomes a
// frame this ladder can spend on. See `FRONT_END_FLOOR`.
//
// ── 8. What it will not do ─────────────────────────────────────────────────
//
// **It parks the moment anything drives the game through `window.__GAME`.** A
// capture renders six fixed steps at a time from a Node round trip at two
// hundred milliseconds a frame; read as gameplay that is an argument for the
// bottom rung, and the review sheet would quietly photograph the wrong game.
// `budget.benchFrames` tells the two apart and two inside a second latch this
// page as a bench for good. It also stands down permanently the moment a human
// or a reviewer picks a tier by hand, because that is a decision and this is
// only a measurement.
//
// **And it stops cutting when cutting stops working.** Every drop records what
// the frame cost before it and checks, once settled, whether the frame actually
// got cheaper. Two drops in a row that buy nothing, or one that makes things
// measurably worse, and the governor puts the last one back and stands down.
// "It got worse" is its own verdict and is acted on immediately: it used to be
// folded in with `futile` and counted as one strike of two, and a live session
// scored rung 3 -> 4 at `gain: -0.562` against `bar: 0.188` and then dropped
// again 0.85 seconds later because the strike before it had been cleared.
//
// **That check has to be able to count**, and the first version could not: on
// the machine it exists for, delivered frames run 17ms to 1233ms around a 483ms
// median, and a four-sample mean against a 4% bar convicted a drop an
// interleaved measurement puts at 21-31% cheaper. Three things fix it, and each
// alone would still have been a coin toss — a **median** (the mean read 642ms
// where the median read 483), **enough samples unconditionally**
// (`VERDICT_SAMPLES` or no verdict), and **a bar the window itself has to
// clear** (`FUTILE_GAIN` or the standard error of the difference, whichever is
// larger; above `FUTILE_RESOLVE` the answer is `unresolved` and nothing is
// decided).
//
// The asymmetry there is the whole design. A false "it worked" costs one rung
// of resolution on a ladder that keeps the shadows, the post stack, the grade
// and the fog. A false "it bought nothing" costs a third of the frame rate for
// as long as the player keeps playing. So when the instrument cannot tell, it
// says so — and the check stays sharp for the case it was built for: a
// vsync-locked 30Hz panel, indistinguishable from a slow GPU from inside the
// page, where the frame is 33ms with almost no spread and two cuts that move it
// by nothing are unambiguous.
//
import { config } from './config.ts';
// Types only — this file never imports the three *runtime*, which arrives
// through `ctx.THREE` like every other system's does. The distinction matters:
// `import type` is erased, so nothing here can put a second copy of three into
// the bundle or construct an object the scene's own namespace would not
// recognise.
import type * as THREE from 'three';
import type {
  FrameBudget, GameContext, GameSystem, QualitySettings, RaceConfig, SplineSample,
} from '../types.ts';

const nowMs = (): number =>
  (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ── the ladder ─────────────────────────────────────────────────────────────

/**
 * A rung is a complete `QualitySettings` plus the resolution the 3D is drawn
 * at, derived from `config.quality` rather than written out again — the three
 * tiers stay the authored anchors and the rungs between them are trims on top,
 * so a change to `config.quality` moves the whole ladder with it.
 */
interface Rung {
  /** Shown in `stats()` and in the probe. */
  readonly label: string;
  /** Fraction of the display's own resolution the scene is rendered at. */
  readonly scale: number;
  readonly settings: QualitySettings;
  /** ...and what comes out of the frame rather than off the resolution. */
  readonly content: ContentTrim;
}

/**
 * The content rung: what the ladder takes out of the *frame*.
 *
 * ── Why this exists, in the reviewer's own numbers ──────────────────────────
 *
 * Four rounds of this file were about instruments, and the fifth was about the
 * fact that a perfect instrument had nothing useful to pull. Measured on one
 * frozen racing frame at 1600x900, the ladder's top rung to its floor went
 * **640,276 triangles to 616,846 and 296 draw calls to 253** — three point
 * seven percent of the geometry — for a 2.1x speed-up that came entirely out of
 * the render scale. The whole ladder was a resolution slider, so a machine that
 * needed more than 2.1x walked to the bottom, was handed a 736x414 picture, and
 * still missed.
 *
 * `drawDistance` was the only content lever on it and it was not one: 1.0 to
 * 0.5 removed 23k triangles out of 640k, because `world/index.ts`'s per-batch
 * distance flag is keyed on each batch's *centre*, the batches are sector-split
 * across a 2.5km lap, and the ones near the camera — which is all of the cost —
 * are near the camera at every draw distance.
 *
 * ── What a content rung is denominated in ──────────────────────────────────
 *
 * The file's own unit rule (see the audit in the header) applies here too: a
 * cut is expressed in the unit the *eye* works in, which is projected size, not
 * metres. A traffic cone 0.6m across is eleven pixels at ninety metres on a
 * 900-line frame and five on a 450-line one, and the same rung has to mean the
 * same thing on both — so `minPx` and `shellPx` are resolved against the live
 * lens and the live drawing buffer every frame, exactly as `vehicles/index.ts`
 * already does for its part ladder. A rung that drops the render scale
 * therefore tightens its own content cut for free, which is the right
 * direction: half the pixels resolve half the detail.
 *
 * `crowd` and `scatter` are shares rather than distances because what they cut
 * is *density*, and density has no distance. They are the two levers the census
 * says are worth having — see `censusContent`.
 */
export interface ContentTrim {
  /**
   * Share of each crowd geometry's **people** that are drawn.
   *
   * A spectator bank is one geometry: the stand is built first and the crowd on
   * it is built last, front row first, so a prefix of the index buffer is
   * "the whole stand and the front rows" and the tail is the back rows under
   * the canopy. `setDrawRange` is therefore a real crowd LOD that costs one
   * call, allocates nothing, recompiles nothing and is exactly reversible —
   * and it takes the least visible people first. 1 = the full house.
   */
  crowd: number;
  /**
   * The verge's density at the **far end** of the ramp — a second multiplier on
   * `thinFar`, applied through the same projected-size test and nowhere else.
   *
   * ── What this used to be, and why round nine moved it ─────────────────────
   *
   * A flat share of every scatter batch, installed at a seam: a cut worth
   * -124k to -168k triangles by the table on `LADDER`, and the single biggest
   * thing on the ladder that a mid-race rung could not touch. It was behind the
   * seam for one reason and it was the right one — a share of a population has
   * no distance, so spending it takes cones out of the verge the player is
   * driving past as readily as out of the one behind them.
   *
   * But *that* is a property of how the lever was **denominated**, not of the
   * cones. Pointed through the eye instead of through the census it obeys the
   * seam rule mechanically, exactly as `thinFar` already did — see (a) in the
   * seam block below. So it is no longer a share of its own: it is the far end
   * of `thinFar`'s ramp, `far = thinFar * scatter`, and every rung of the
   * ladder still draws the identical verge at the knee.
   *
   * What that buys, measured: the review that convicted round eight walked
   * `mid(0)` to `mid(6)` on one frozen frame and moved **654 triangles and one
   * draw call** — the entire in-race authority of a seven-rung ladder. The same
   * walk moves the whole scatter cut now, because the whole scatter cut is on
   * the near side of the seam.
   *
   * 1 leaves the ramp to `thinFar` alone, which is what rung 0 means.
   */
  scatter: number;
  /**
   * ...and the share a scatter batch is thinned to once its instances have
   * shrunk to nothing, on a linear ramp from full density at `THIN_KNEE_PX`.
   * Multiplied by `scatter` to give the ramp's far end; on its own it is what
   * the ramp would be worth with the verge's own share left at 1.
   *
   * ── Why the ladder needed this ────────────────────────────────────────────
   *
   * Once `crowd` and `scatter` went behind the seam, the frame-half of a rung
   * was `particles`, `minPx` and `shellPx` — and the census says where the
   * geometry actually is: the verge's clutter is a quarter of everything drawn
   * (807 traffic cones at 92 triangles each is 74k on its own). A ladder whose
   * mid-race half cannot touch the largest population on the course is a ladder
   * that will be convicted by its own futility check two rungs above the ones
   * that work.
   *
   * ── ...and why it is seam-safe where `scatter` is not ─────────────────────
   *
   * Because the **knee does not move** and the ladder only moves the far end of
   * the ramp. A batch keeps full density while one of its instances is bigger
   * than `THIN_KNEE_PX` pixels of radius, and thins in proportion to how far
   * below that it has fallen. So:
   *
   *   at the knee, every rung of the ladder draws the same thing. The change a
   *   rung makes is **zero** at the point the ramp begins and grows with
   *   distance, which is the one shape a density lever can have and still be
   *   invisible: the biggest change lands on the smallest objects.
   *
   *   a rung step of 0.1 on this share moves a batch at half the knee size —
   *   a three-pixel cone, two hundred metres out, behind the fog's near plane —
   *   by about seven percent of its instances: at `far` 0.5 that batch draws
   *   0.75 of its density and at 0.4 it draws 0.70, so sixty-eight cones become
   *   sixty-three. At the knee itself both draw sixty-eight.
   *
   *   the verge the player is driving past is at full density on every rung of
   *   the ladder, which is the property `scatter` could not have at any value.
   *
   * The instance order is already a low-discrepancy permutation (`stratify`), so
   * a prefix is an even sample of the whole batch at any share: a thinned taper
   * is a taper with wider spacing, not half a taper. And the write is
   * `InstancedMesh.count` — one integer, no upload, exactly reversible.
   *
   * 1 turns the ramp off, which is what rung 0 means.
   */
  thinFar: number;
  /** Screen-pixel radius below which **one instance** of a dressing batch is
   *  not worth submitting at all. 0 turns the test off. */
  minPx: number;
  /**
   * ...and the projected radius below which a whole racer is drawn as its
   * merged shell instead of as twenty-six separate meshes. 0 turns it off.
   *
   * **The player's own machine is protected by arithmetic rather than by a
   * special case.** A machine is about 1.1m of bounding radius, so a pixel
   * threshold converts to a distance once the rung's own render scale and the
   * live lens are known. On a 900-line display at the base 50° lens the six
   * values below rung 0 — 10 / 14 / 18 / 22 / 27 / 32 — are **94m / 67m / 52m /
   * 43m / 35m / 30m**, and the chase rig sits at about eight metres behind the
   * player at every one of them. At 52m a machine is twenty pixels across and
   * its wheel is five; the strobe on the tread lugs — which is what a rotating
   * wheel actually reads as, see `makeWheel` — is sub-pixel long before then.
   *
   * ── ...and a metric floor underneath all of that ───────────────────────────
   *
   * The pixel test is the right instrument for *detail* and it is the wrong one
   * for **motion**, and running it without a floor put a steam locomotive
   * twenty-three metres from the camera on a static merged mesh with its wheels
   * and connecting rods stopped. `SHELL_MIN_M` is the second half of the test:
   * a machine inside twenty-eight metres is never shelled however few pixels it
   * has. That is also what keeps the honest exception below honest — a boosting
   * `far` shot at the floor no longer shells the player's own machine, because
   * the chase rig cannot get twenty-eight metres away from it.
   */
  shellPx: number;
}

/** Everything, which is what the top of the ladder means. */
const FULL_CONTENT: ContentTrim = { crowd: 1, scatter: 1, thinFar: 1, minPx: 0, shellPx: 0 };

/**
 * Projected instance radius, in pixels, at which the distance ramp begins.
 *
 * **Not on the ladder, deliberately.** It is the hinge the whole seam-safety
 * argument turns on: a rung moves the far end of the ramp and never the near
 * end, so the density a player is looking at is the same on every rung and the
 * only thing a rung change can move is what is already smaller than this.
 *
 * Six pixels of radius is a traffic cone at about ninety-five metres on a
 * 1600x900 frame — twelve pixels across, three of them of colour, with the
 * fog's near plane already on it on three of the four courses. It scales with
 * the drawing buffer for free, exactly as `minPx` and `shellPx` do: half the
 * pixels, half the distance, the same picture.
 */
const THIN_KNEE_PX = 6;

/**
 * The shadow map, at every rung, for ever.
 *
 * It used to walk 2048 -> 1536 -> 1024 -> 768 -> 640 -> 512 -> 448, and this
 * file's own two measurement tables convict that between them:
 *
 *   the whole 2048 -> 256 range          **2%** of a steady frame
 *   the 2048 -> 768 transition itself    **+262ms**, one frame, once per change
 *
 * Four of the ladder's five transitions moved it, so four of them paid a
 * quarter-second hitch for a fraction of a percent — and the 2048 -> 768 row is
 * a *depth attachment disposed and rebuilt*, exactly the shape the render scale
 * was convicted for. `LADDER`'s own commentary already said it was "the first
 * thing to take off the ladder if a rung change ever has to get cheaper". It
 * has to get cheaper.
 *
 * Frozen at the **top** rung's value rather than at a compromise, because the
 * cost of the range is unmeasurable and the benefit is not: ARCHITECTURE §12's
 * contact-is-everything rule is answered by a sharper contact shadow at six of
 * the seven rungs than the ladder used to give them. `render/lighting.ts`
 * guards its own write (`if (sun.shadow.mapSize.x !== ctx.quality.shadowSize)`)
 * so a frozen value means the map is allocated once, at boot, and never again.
 */
const SHADOW_PX = config.quality.high.shadowSize;

function rung(
  label: string, tier: QualitySettings['tier'], scale: number,
  trim: Partial<QualitySettings> = {},
  content: Partial<ContentTrim> = {},
): Rung {
  return {
    label, scale,
    // `shadowSize` last, and deliberately not overridable by `trim`: the whole
    // point is that no rung can put it back on the ladder by accident.
    settings: { tier, ...config.quality[tier], ...trim, shadowSize: SHADOW_PX },
    content: { ...FULL_CONTENT, ...content },
  };
}

/**
 * Rung 0 is the most expensive.
 *
 * ── Why resolution leads, and why the ladder is not made of it ─────────────
 *
 * The machines this file exists for are **fill**-bound: they draw the scene
 * into an HDR target, then a bright pass, five downsample mips, five upsample
 * mips, a composite and an FXAA resolve, with a shadow map on top. Every one of
 * those costs pixels rather than vertices, so culling a floodlight tower two
 * hundred metres away removes ninety triangles from a pass that was never
 * counting triangles. An earlier ladder that gave up draw distance, then
 * particles, then the shadow map measured 4% of the geometry and no measurable
 * time across three visible steps.
 *
 * Resolution scales all of it at once, quadratically, and is the least visible
 * thing per millisecond bought. So each rung takes a bite of it first.
 *
 * That is an argument about the *order* of the rungs, and a previous version of
 * this table read it as an argument about their *contents* — seven rungs of one
 * lever, 3.7% of the geometry end to end, 2.1x and nothing left. A ladder needs
 * a second axis for the same reason a gearbox needs more than one gear: not
 * because the first one is bad, but because it runs out. So every rung also
 * carries **content**, spread across the whole descent rather than banked at
 * the bottom, and each rung is worth 6-10% on the frame it is taken on.
 *
 * ── What each lever is worth, isolated ─────────────────────────────────────
 *
 * `__QUALITY.try`, frozen sim, median rAF period, three interleaved passes,
 * against the 986ms top rung at 1600x900 under SwiftShader:
 *
 *   render scale 0.88 / 0.78 / 0.68 / 0.58 / 0.48   -16% / -24% / -36% / -46% / -54%
 *   bloom off                                        -8%
 *   aa off                                           -7%
 *   drawDistance 0.5                                 -5%
 *   shadow map 2048 -> 512                           -3%
 *   shadow map 2048 -> 256                           -2%
 *   shadows off entirely                            -13%   (and 462 draws -> 290)
 *   postfx off entirely                             -35%   (the cliff; not taken)
 *
 * Two conclusions. Resolution is worth more than every other *authored-setting*
 * lever put together. And the shadow map's *size* is nearly free in both
 * directions, which is why the whole range goes back to the art direction and
 * every rung keeps a 2048 map (`SHADOW_PX`). What shadows actually cost is the
 * second draw of every caster, and that is a cost the game has decided to pay
 * everywhere — ARCHITECTURE §12.
 *
 * Note the qualifier: every row there is a *setting*. None of them is a thing
 * leaving the frame, which is why the table's own conclusion was true of the
 * wrong universe.
 *
 * ── ...and each content lever, same frozen frame, full render scale ─────────
 *
 * `__QUALITY.content`. Triangles are exact — `renderer.info`, counted after the
 * frustum — and are what this table is for. **The times are deliberately not in
 * it**: at 1600x900 under SwiftShader a frame is about a second, so a
 * fourteen-second window is two or three samples and a loaded box produced
 * medians from 1.0s to 23.8s for the same rung. A number that noisy is not a
 * measurement; the geometry is.
 *
 * **Re-taken in round nine at 1280x720**, because the courses wave rebuilt the
 * world and the table below it had become a claim about a game that no longer
 * exists. Against 601,544 triangles, ±4,000 of frame-to-frame noise:
 *
 *                       triangles     against 601,554
 *   crowd 0.80            598,458     -3k
 *   crowd 0.46            589,400     -12k
 *   crowd 0.16            581,088     -20k
 *   far-ramp 0.30         600,524     -1k
 *   far-ramp 0.05         598,856     -3k     (inside the noise)
 *   minPx 5.5             603,994     — , 17 batches held off
 *   minPx 14              603,960     — , 34 batches held off
 *
 * **The verge lever has almost nothing left to give, and saying so is the
 * point of re-measuring.** The previous table had `scatter 0.30` at -168k, and
 * that number was true: the census then found 807 traffic cones and 96 drums.
 * It now finds 375 and 79, the crowd has grown to four times the verge, and a
 * third of the frame is road, ground, item boxes and coins that no rung may
 * touch. A lever is worth what the *current* world makes it worth, and a file
 * that quotes its own three-round-old measurements as if they were physics is
 * how a ladder ends up with six rungs of a lever that stopped working.
 *
 * What follows from that is in `SEAM_HELD` rather than here: the honest reason
 * to take `scatter` off the seam is no longer "it is worth 168k", it is that a
 * ladder whose *only* live content lever measures inside the noise has no
 * second axis at all. The second axis it actually got is the resolution, which
 * is worth 1.71x mid-race — see the paired timings in the seam block. The
 * shell and `minPx` remain worth their draw calls rather than their triangles.
 *
 * Time can be measured *pairwise* — contention lands on both members of a pair
 * equally. Rung 3 against rung 6, four alternating passes, warm-up discarded:
 * 683/633/667/700 against 483/500/483/500, **1.37x**. A timing on a shared box
 * is only worth quoting when the two things compared are close together: the
 * same recipe for rung 0 against rung 6 under load answered "10.9x", because
 * the load fell on the expensive member of every pair.
 *
 * ── The ladder walked, on the `racing` shot at 1600x900 ────────────────────
 *
 * **Re-taken in round eleven, on the frame the review sheet publishes and at
 * the resolution it publishes it at.** The previous version of this table was
 * headed "one frozen racing frame at 1280x720" and said 189 draw calls, which
 * disagreed with the audit in the header (457), with `tools/framehalf.mjs`
 * (473) and with what the game reported for the frame it claimed to describe
 * (480). Every "each rung is worth 6-10%" claim in this file was quoted off
 * that 189 row. One instrument, one frame, one resolution, from here on.
 *
 * `setTimeScale(0)` and then `render()` only, never `advance()`, which steps
 * the simulation whatever the time scale says and quietly turns a controlled
 * A/B into seven photographs of seven different moments.
 *
 *   rung   label    scale  triangles   calls  progs  culled  shelled
 *   0      high      1.00    663,326     340     90       0        0
 *   1      high-     0.88    648,972     337     90      10        0
 *   2      med       0.78    640,660     337     90      11        0
 *   3      med-      0.68    632,592     319     90      14        1
 *   4      thin      0.62    626,290     316     90      17        2
 *   5      sparse    0.56    615,082     315     90      19        2
 *   6      floor     0.50    610,510     315     90      24        2
 *
 *   End to end **-8.0% of the triangles and -7.4% of the draw calls**, and both
 *   are the least interesting numbers in the table. The ladder's authority is
 *   in the resolution: 1.00 to 0.50 is a quarter of the pixels, and on a
 *   fill-bound machine that is what the 1.92x below is made of.
 *
 *   **The program count is flat at 90 for the whole descent.** That is the
 *   property that matters most here and it is the one a reviewer confirmed by
 *   walking the rungs independently: the ladder compiles nothing on the way
 *   down, so its rescue move cannot be the worst hitch of the session — which
 *   is exactly what the ladder two designs ago did, at 762ms.
 *
 *   **`shelled` reaching 2 of 7 is not a success and is left in the table
 *   rather than tidied out of it.** A reviewer measured the same thing: the
 *   colour shell's test is ANDed (`SHELL_MIN_M` 28m *and* under `shellPx` of
 *   projected radius) and with seven machines on a 2.5km lap the ones that are
 *   far enough are usually also behind the camera and already free. What the
 *   merge *is* worth turned out to be in the other pass entirely, and is now
 *   taken unconditionally at every rung — see `ShadowShell`, which is 142 draw
 *   calls rather than 2 machines.
 *
 * The **program count is flat for the whole descent**, against 75 -> 101 two
 * ladders ago: the ladder compiles nothing, so it cannot hitch on the way down.
 * The one variant that used to appear at rung 2 — the composite drawn straight
 * to the back buffer when `aa` goes off — is built at boot by `warmPrograms()`
 * in `render/post.ts`, along with the upscale blit a reduced render scale asks
 * for. A shell is the machine's own materials and a thinned batch is the same
 * material with a smaller count.
 *
 * Every step buys more than `FUTILE_GAIN`, which is the bar the ladder before
 * last could not clear — its rung 3 to rung 4 measured *worse*.
 *
 * ── Reading a row ──────────────────────────────────────────────────────────
 *
 * The first object is settings and the second is content. `aa`, `drawDistance`
 * and `crowd` are the seam-held half; the `scale` argument, the tier,
 * `particles`, `thinFar`, `scatter`, `minPx` and `shellPx` land on the frame
 * the rung is taken on. See `SEAM_HELD`.
 *
 * The order of what a player can name, on the way down: sub-pixel dressing and
 * distant machines first, then the verge's density, then the crowd's back rows.
 *
 *   **thin** is the free one. The seven machines become their own merged shells
 *   past the distance a wheel stops turning on screen — the same picture, a
 *   third of the submissions — and the crowd loses the back rows under the
 *   canopy. Nothing has left the frame that has a name.
 *
 *   **sparse** halves the verge's clutter *at the far end of the ramp* and
 *   takes the crowd to a third. The cones thin evenly rather than stopping (see
 *   `stratify`), so a taper is still a taper, with wider spacing — and the
 *   taper beside the player is untouched at every rung, because the ramp is
 *   anchored at the knee.
 *
 *   **floor** is a sixth of the crowd and, past the knee, less than a tenth of
 *   the verge. It is the emptiest frame the game can draw and it is still, in
 *   every other respect,
 *   the same game: the same shadow policy, the same 2048 shadow map, the same
 *   post stack, the same grade, the same glow on the item box, the same fog.
 */
const LADDER: readonly Rung[] = [
  rung('high', 'high', 1.00),
  // Nothing here has a name. `minPx` 1.8 is a dressing batch under two pixels
  // of radius; `shellPx` 10 is a machine at ninety metres, which is twelve
  // pixels across and whose wheels stopped reading as wheels sixty metres ago.
  // `thinFar` 0.80 takes a fifth off the density of a batch whose cones have
  // shrunk to nothing, and nothing at all off one at the knee.
  rung('high-', 'high', 0.88, {
    particles: 0.9, drawDistance: 0.95,
  }, { scatter: 0.86, thinFar: 0.80, minPx: 1.8, shellPx: 10 }),
  // The FXAA resolve goes here rather than at rung 3. It is worth 7% on its own
  // — the largest single *authored* lever after resolution — and it is the
  // reason this rung is a seam rung as much as a frame one. What pays for it on
  // the frame it is taken is the thinning knee and the shell.
  rung('med', 'med', 0.78, {
    aa: false, particles: 0.75, drawDistance: 0.88,
  }, { crowd: 0.80, scatter: 0.72, thinFar: 0.64, minPx: 2.4, shellPx: 14 }),
  rung('med-', 'med', 0.68, {
    aa: false, particles: 0.60, drawDistance: 0.80,
  }, { crowd: 0.62, scatter: 0.60, thinFar: 0.50, minPx: 3.0, shellPx: 18 }),
  rung('thin', 'med', 0.62, {
    aa: false, particles: 0.5, drawDistance: 0.72,
  }, { crowd: 0.46, scatter: 0.50, thinFar: 0.40, minPx: 3.6, shellPx: 22 }),
  // ── where the low tier starts, and what "low" is allowed to mean here ────
  //
  // `QualitySettings.tier` has three values and this ladder used to select two
  // of them, so every module entitled to branch on `low` was branching on dead
  // code. It is reachable from here down.
  //
  // What it does **not** mean is `config.quality.low`, which is the cliff this
  // ladder was rebuilt to remove: that preset drops shadows, the whole post
  // stack and antialiasing in one step, which recompiles every material in the
  // game (75 -> 110 programs, a 762ms frame) and leaves the cone standing on
  // the dirt casting nothing while `world/`, `track/` and `render/` all still
  // believe in the one shadow policy ARCHITECTURE §12 describes. So `shadows`
  // and `postfx` are restated on top of it, exactly as every other rung states
  // them, and the tier keeps only the part of `low` that is a number: the sun's
  // shadow extent, 52m -> 46m in `render/lighting.ts`. That is the outer six
  // metres of the shadow frustum on a frame already drawn at 0.56 of the
  // canvas, and it is the smallest thing on this row.
  rung('sparse', 'low', 0.56, {
    shadows: true, postfx: true, aa: false, particles: 0.42, drawDistance: 0.64,
  }, { crowd: 0.30, scatter: 0.40, thinFar: 0.32, minPx: 4.4, shellPx: 27 }),
  // The floor. Still shadowed — at the *same* 2048 map as rung 0 — still
  // composited, still graded, still glowing, still fogged by the same
  // depth-driven atmosphere as the top rung. What is gone is population, not
  // features: a thinner crowd, a thinner verge, and the far half of the field
  // drawn as shells. It is the emptiest frame this game can draw that is still
  // recognisably this game.
  rung('floor', 'low', 0.50, {
    shadows: true, postfx: true, aa: false, particles: 0.34, drawDistance: 0.55,
  }, { crowd: 0.16, scatter: 0.3, thinFar: 0.25, minPx: 5.5, shellPx: 32 }),
];

// ── the seam rule ──────────────────────────────────────────────────────────
//
// **A rung has two halves and only one of them may land while the player is
// watching.**
//
// The rule was found the hard way twice, from opposite directions. Round six
// deferred the render scale because moving it cost a swap-chain rebuild — a
// 3101ms frame. Round seven found the real principle by *playing the game*: the
// governor spent `crowd` mid-race on the start/finish straight, and a packed
// grandstand became bare grey terracing between one frame and the next, forty
// metres in front of the player. That is not a hitch and no timing instrument
// in this file could have caught it; a `setDrawRange` costs nothing at all.
//
// So the test is not cost. It is: **can the change itself be seen happening?**
// Not "is the after-picture worse" — every rung is worse, that is what a rung
// is — but can the transition be watched. A thing that vanishes is a change. A
// thing that was already three pixels across and is now not drawn is not.
//
//   **seam-safe** — may move on any frame the moment gate allows. Either (a)
//   denominated in *projected pixels*, so the only things it can move are
//   already too small to resolve, or (b) invisible on the frame it lands
//   because it only governs what happens next, or (c) uniform across a picture
//   that is being redrawn anyway.
//
//     `minPx`     a dressing batch stops being submitted below N pixels of
//                 instance radius. A rung step is 0.6-1.1px.
//     `shellPx`   a machine is drawn as its own merged shell — pixel-identical
//                 geometry in the same materials. What it gives up is that the
//                 wheels stop turning, and `SHELL_MIN_M` keeps that
//                 twenty-eight metres away whatever the pixel test says.
//     `thinFar`   the same instrument pointed at density: a scatter batch thins
//                 on a ramp as it shrinks, anchored so a rung changes nothing
//                 at the near end. See `ContentTrim.thinFar`, `THIN_KNEE_PX`.
//     `scatter`   **round nine.** The verge's own share, which used to be a
//                 flat multiplier installed at a seam, is now the far end of
//                 that same ramp — `far = thinFar * scatter` — so it inherits
//                 the anchor and the argument along with the instrument. At the
//                 knee every rung draws the identical verge; the whole of the
//                 largest content lever on the table is now on the near side of
//                 the seam. See `ContentTrim.scatter`.
//     `particles` a cap on what the *next* burst may spawn. Nothing already in
//                 the air changes.
//     `scale`     (c), and round nine had to *earn* the (c). The whole picture
//                 goes soft — but "the whole picture" was a lie while the HUD
//                 was DOM at native resolution and did not move with it: on one
//                 frozen frame, `set(0)` against `mid(6)`, the mountain ridge
//                 gained visible upscale stair-stepping while "1/3", "0:13.9",
//                 "7TH" and the minimap stayed **bit-identical**. Soft world,
//                 razor HUD, in the same photograph — which is the seam this
//                 rule was written to forbid, arriving from the one direction
//                 the rule did not look. Round nine answered it by blurring
//                 the instrument set to match; **round ten reversed that and
//                 was right to** — the readouts a player parses in peripheral
//                 vision got harder to read at exactly the moment the game was
//                 running worst, and a sharp interface over a scaled world is
//                 what MK8D does in split-screen and what nobody has ever filed
//                 as a defect. Measured across the rungs: the world's mean
//                 gradient falls 3.76 → 2.68 while the HUD's holds at 5.09 →
//                 4.90. The apparatus that used to publish the blur went with
//                 round eleven — see the note above `wantScale`, where a
//                 hundred and forty lines were driving zero elements. What
//                 keeps the lever seam-safe is that it is ramped rather than
//                 stepped — see `SCALE_RAMP` — because a change small enough
//                 not to be watched still cannot arrive all at once.
//     `tier`      (a), by accident of what the field actually drives:
//                 `SHADOW_EXTENT` in `render/lighting.ts`, 62 / 52 / 46m. The
//                 outer edge of the shadow frustum moves ten metres.
//
//   **reset-only** — recorded when the rung is taken, installed at the next
//   seam: boot, a race build behind the closed launch board, or a window resize
//   the browser is already reallocating for.
//
//     `crowd`     the one a person found: the back rows of every stand on the
//                 course, at once, whether the stand is behind the camera or
//                 forty metres ahead of it. It stays here, and it stays here on
//                 the evidence of somebody's eyes rather than on a rule: the
//                 stand a player is looking at is metres away and enormous, so
//                 there is no projected-size ramp that would reach it.
//     `aa`        the FXAA resolve is every edge in the frame at once, and the
//                 only lever whose effect is uniform *and* sharp-edged.
//     `drawDistance` whole batches switch off at their own ring: 35k triangles
//                 at one step, a stand of pines, a floodlight tower — and a
//                 tower that disappears is a tower the player watched go.
//
// The argument is **mechanical**, not empirical: a lever is seam-safe when the
// thing it changes is, at the moment it changes, smaller than a player can
// resolve — a property of how the lever is *denominated*. `crowd` is a share of
// a population and a share has no distance. Note which way that cuts: it is a
// statement about the *denomination*, not about the cones, and round nine
// re-denominated the second of the two rather than arguing with it.
//
// `tools/levervis.mjs` was built to score this by pixels and the result is
// worth keeping for what it says about the *bench* rather than the levers: on a
// frozen frame at rung 2, with three control frames masking off everything the
// animation moves, **every row is the control** — including the one that
// removes eighty thousand triangles of spectator. The crowd is the most
// animated thing in the frame, so the mask that removes animation removes the
// crowd, and the one lever a human could see from across the room is the one
// the bench is structurally blind to. Compare `moment.png` and
// `crowdFloor-frame.png` by eye instead. The single lever it does convict on
// its own is `aa`, measured where it toggles: **10.5% of static pixels against
// a 2% floor**, mean delta 64.
//
// ── What the seam costs, stated plainly ────────────────────────────────────
//
// **Re-taken in round eleven on the `racing` shot at 1600x900**, alongside the
// `set()` walk in the `LADDER` block, from the same frozen frame in the same
// session. The table that used to be here came from `tools/framehalf.mjs` on a
// different frame at a different resolution and read 473 calls / 1,005,886
// triangles at rung 0 against the ladder table's 189 / 603,706 — two numbers
// for the same claim, 2.5x apart, in one file. They are one measurement now.
//
//                    whole rung (`set`)        frame-half only (`mid`)
//   rung 0         663,326 tris / 340 calls    653,084 / 338
//   rung 3         632,592 / 319                639,846 / 319
//   rung 6         610,510 / 315                627,040 / 315
//
// Read the *columns* rather than the rows: the whole rung and the frame-half
// are now within 16,530 triangles and **zero draw calls** of each other at the
// floor, where round eight's equivalent gap was the entire ladder. That is the
// design working — `scale`, `tier` and `scatter` all came off the seam across
// rounds eight and nine, so what is still deferred to a race build is only the
// crowd, the FXAA resolve and the draw distance.
//
// Round eight is worth keeping in view because it is the measurement that
// convicted the previous design. Taken when `scale` was seam-held, on a
// fill-bound machine the mid-race half bought **no measurable time at all** —
// 1400ms at the floor's frame-half against 1333ms at rung 0, inside the noise,
// while the whole floor rung ran at 567ms. Almost all of the speed-up was the
// render scale, and the render scale was the half the player could not have.
//
// That is why `scale` and `tier` are seam-safe now and why the list above has
// two entries rather than six. What is left behind the seam is the half a
// person can *watch* rather than the half that costs anything, which is the
// only version of this rule that was ever worth having.
//
// ── ...and what it is worth in time ────────────────────────────────────────
//
// **Triangles were the wrong instrument** and the right one says something much
// larger. Median rAF period, nine-frame medians, eight alternating pairs so
// contention lands on both members equally, frozen sim at 1280x720 under
// SwiftShader. (Kept at the resolution it was taken at rather than restated at
// 1600x900 it was not — a timing quoted at a resolution it was not measured on
// is the class of claim this round exists to remove.)
//
//   mid(0) 1283ms  ->  mid(6)  750ms    **1.71x**   ratios 1.40 .. 1.98
//   set(0) 1150ms  ->  set(6)  617ms    **1.92x**   ratios 1.29 .. 2.62
//
// **Eighty-nine percent of the whole ladder's speed-up is now available inside
// one race**, against "no measurable time at all" one round ago. The remaining
// gap between the two rows is the crowd, the FXAA resolve and the draw
// distance, and those three are what a race build is for.
//
// Two things follow that are in the code rather than in this comment. A
// futility verdict cannot survive a seam (`flushSeam`), because every verdict
// taken between two seams was taken on a cut that was only half made. And
// `composeSettings` reads the seam-held fields off a different rung index from
// everything else, so between a mid-race rung change and the race build that
// follows it the game is genuinely standing on two rungs at once.

/**
 * The levers a rung may only install at a seam, named once so that the ladder,
 * the composer and the log all agree about which they are. See the block above.
 */
const SEAM_HELD = ['scale', 'crowd', 'aa', 'drawDistance'] as const;
/** ...and its own union, so `seamDiffers` can be exhaustive over it. */
type SeamLever = typeof SEAM_HELD[number];

/**
 * The render scale below which the FXAA resolve stops being a seam.
 *
 * `aa` is seam-held because it is the one lever whose effect is uniform *and*
 * sharp-edged: `tools/levervis.mjs` convicts it at 10.5% of static pixels
 * against a 2% floor, mean delta 64. **That measurement was taken at full
 * resolution**, and it is a measurement of a frame that no longer exists by the
 * time the ladder wants this lever.
 *
 * FXAA is an edge filter on the *scene buffer*. Below full scale that buffer is
 * magnified back onto the canvas, and the magnification's own kernel is wider
 * than the filter's: at 0.68 a texel is spread over half a canvas pixel, at
 * 0.50 over a whole one. Re-measured where the ladder actually asks for it —
 * one frozen racing frame, mean absolute delta over the canvas, `aa` toggled at
 * each scale:
 *
 *   scale 1.00    aa on -> off    delta 5.02   4.2% of pixels moved
 *   scale 0.78    aa on -> off    delta 1.44   1.7%
 *   scale 0.68    aa on -> off    delta 1.10   1.3%
 *   scale 0.50    aa on -> off    delta 0.62   0.8%
 *
 * ...against 0.00 for the control (the same frame twice). By 0.78 the resolve
 * changes a quarter of what it changes at full scale, and less than the *ramp
 * step* of the scale lever it is riding on top of. A change smaller than the
 * one it arrives with is not a seam.
 *
 * So the rule is one-directional and stated as such in `composeSettings`: the
 * resolve may be **dropped** as soon as the resolution it was resolving has
 * gone, and it comes **back** only at a real seam. Buying an edge filter back
 * mid-race is a sharpening the player did not ask for, and it is never urgent.
 *
 * 0.85 rather than 0.78 because the lever should land with the rung that turns
 * it off (rung 2, scale 0.78) rather than one ramp-step later, and the ramp
 * passes 0.85 on the way there.
 */
const AA_MOOT_SCALE = 0.85;

/**
 * A signature of the ladder itself, mixed into the hardware key.
 *
 * The stored rung is an *index into this table*, so editing the table
 * invalidates every answer ever written about it — rung 4 on the ladder above
 * is not rung 4 on the one it replaces, and a machine that remembered the old
 * one would boot into a picture nobody measured. Hashing the labels, the scales
 * and the content trims means that never has to be remembered by hand.
 */
const LADDER_SIG = ((): string => {
  let h = 0x811c9dc5;
  const s = LADDER.map((r) => `${r.label}${r.scale}${r.settings.particles}`
    + `${r.settings.tier}${r.settings.drawDistance}${r.settings.aa}`
    + `${r.content.crowd}${r.content.scatter}${r.content.thinFar}`
    + `${r.content.minPx}${r.content.shellPx}`).join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
})();

/**
 * Where the game starts **when nothing is known about the machine**.
 *
 * Top of the ladder — the governor's job is to earn its way down, not to guess
 * a machine's class before it has drawn a frame. What it is no longer allowed
 * to do is *forget*: once a session has settled somewhere, that rung is written
 * under a coarse hardware key and this constant only applies to the first visit
 * from a given machine. See `hardwareKey` and `rememberRung`.
 */
const START_RUNG = 0;

// ── the budget the game can fail ───────────────────────────────────────────
//
// **Everything above this line is about giving things up, and until round
// eleven nothing in the repository said what the top rung was supposed to
// cost.** A reviewer put it exactly: the entire performance assertion in the
// project was `if (stats.drawCalls === 0) failures.push('nothing was drawn')`,
// while the smoke test printed 452 draw calls and 906,072 triangles beside it
// and asserted nothing about either. A ladder is a rescue system; a rescue
// system with no stated target is a machine for degrading a frame nobody has
// ever costed.
//
// So: a number, derived, checkable, and wired to a gate that fails the build.
//
// ── The derivation, which is the only part that matters ────────────────────
//
// The target is 60fps — 16.7ms — on a mid laptop (integrated Iris Xe / M-series
// base class) at 1600x900 with the full field of seven. Three things spend that
// frame and they are not interchangeable:
//
//   **Draw-call submission is CPU and it is the one that binds.** A WebGL draw
//   in Chrome costs roughly 8-14µs of *browser* time once validation, uniform
//   upload and state changes are counted, and it costs that whether the mesh is
//   two triangles or twenty thousand. That figure is a citation rather than a
//   measurement — a page cannot measure a laptop it is not running on, and a
//   SwiftShader container measures its own rasteriser and nothing else — so the
//   claim is quoted as the range it is: a 400-call frame spends **3.2 to 5.6ms
//   submitting**, which is a fifth to a third of the whole budget before a
//   pixel is shaded, on top of the 3.1ms of simulation and update measured
//   live. That is the number the ladder never had and never spent.
//
//   **The ceiling is a ratchet, and it is stated as one.** A quarter of the
//   frame at 12µs would be 350 calls, and this game does not meet 350 on every
//   frame of its own review sheet. Setting the gate there would fail the build
//   today, and setting it at the old frame's 530 would gate nothing — so it is
//   set at **400**, which is above what the game now does and far below what it
//   did an hour ago, and the gap to 350 is named at the end of this block with
//   an owner against each item. A ceiling that today's build would have failed
//   is a real constraint; a ceiling nothing can reach is a wish, and one drawn
//   round the current number is a rubber stamp.
//
//   **Triangles are not the constraint and the ceiling says so.** At 1600x900 a
//   mid GPU transforms 900k triangles in about a millisecond; this file's own
//   lever table is the proof, and it has been sitting there for three rounds
//   being read backwards — the render scale is worth 16-54% and every geometry
//   lever on the ladder is worth 1-3%. The frame is *fill*-bound.
//   `RUNG0.triangles` is therefore a **regression tripwire** at 1,000,000
//   against a measured worst of 922,248, and its job is to catch the day
//   somebody adds a quarter of a million triangles without noticing rather than
//   to defend the frame rate. The margin is wider than the draw-call one on
//   purpose: three runs of the identical smoke recipe measured 898,166,
//   906,556 and 922,090 triangles — 2.7% of spread, because the engine's rAF
//   loop still ages the world a little between round trips — against 379, 381
//   and 381 draw calls, which is 0.5%. A tripwire has to clear the noise of the
//   thing it is watching or it is a random build failure with a number on it.
//
//   **CPU work that is not drawing** — `fixedUpdate` plus every system's
//   `update`. Measured live at about 3.1ms and healthy; `cpuTargetMs` 4.0 is
//   the line at which it would stop being, and `cpuMs` 6.0 is where the build
//   fails, for the reason written on the field itself: the bench is a shared
//   container and it measured 2.47, 2.95, 3.18 and 4.00ms for identical work.
//
//   Two pieces of arithmetic make even that gate mean anything and both were
//   found the hard way. A bench renders up to eight fixed steps per drawn frame
//   and a player at 60fps runs two, so the sim is normalised **per step**
//   (`STEPS_AT_60`) — a gate denominated in the wrong unit is the mistake this
//   file's own header spends a page on. And the reading is the **median of a
//   window** (`CPU_WINDOW`), because the last rendered frame of the six
//   review-sheet recipes reported 1.2, 6.8, 2.1, 7.1, 4.9 and 2.4ms of update
//   for the same game doing the same work.
//
// ── ...and what the whole review sheet actually costs ─────────────────────
//
// One shot is not a budget either. Every frame `tools/capture.mjs` publishes,
// at 1600x900 on cone-canyon, rung 0, after the change below:
//
//   shot        draw calls   triangles     colour + shadow
//   grid               390     901,734        320 + 56
//   smoke              381     922,248        286 + 39
//   pack               368     690,364        294 + 58
//   overhead           331     676,376        259 + 60
//   far                331     894,596        272 + 47
//   offroad            321     639,598        269 + 40
//   racing             267     648,832        199 + 54
//
// A hundred and twenty-three draw calls and nearly three hundred thousand
// triangles between the cheapest racing frame and the dearest, which is the
// second reason the three tables this file used to carry disagreed: they were
// not only measured with different instruments, they were measured at different
// corners. The ceiling is the **worst** of these plus the slack a moving
// frustum has, because a budget quoted off the prettiest frame is a budget the
// player never gets.
//
// ── What the frame is, measured, on the shot the reviewer looks at ─────────
//
// The `racing` shot, cone-canyon, seed 1, 1600x900, rung 0, seven racers
// mid-pack, **frozen with `setTimeScale(0)` so the same frame can be measured
// twice** — which is why the numbers below are not the `racing` row of the
// sheet above: that one is photographed live and the round trips move the kart.
// Both halves from the same frame: `renderer.info` for the cost,
// `__QUALITY.audit()` for where it went, and the audit is now frustum-aware so
// the two reconcile.
//
//   group        drawn   shadow   drawn triangles   meshes  materials
//   world           59       32           196,608      114          7
//   track           12        5           168,470       23         22
//   the field      173        7            31,920      208         82
//   coins            4        0            25,688        4          2
//   itemBoxes        5        0            24,304        6          6
//   itemRig         16        3             1,338       16         16
//   everything     277       47           449,960      407        160
//
//   `stats()`   338 draw calls   663,240 triangles   90 programs
//
// The audit's 324 and the renderer's 338 differ by the post stack's own
// full-screen passes, which walk no scene graph. `drawn` is the colour pass and
// `shadow` is the same casters submitted into the 2048 map; `stats().triangles`
// is 663k against the colour pass's 450k because the shadow pass rasterises its
// share a second time. **That reconciliation is new and it is the point**: the
// three tables this file used to carry for "one frozen racing frame" said 457,
// 189 and 473 draw calls, none of them equal to what the game reported for the
// frame they claimed to describe, and every "what a rung is worth" number in
// the file was quoted off the lightest of the three.
//
// ── ...and how it got from 480 to 338 ─────────────────────────────────────
//
// One change, and it is not a quality cut: `ShadowShell`. The seven machines
// were 322 of the frame's 466 scene submissions — sixty-nine percent — for
// seven percent of its triangles, and 155 of those were the shadow pass drawing
// twenty-two separately-*painted* greebles per machine into a map where paint
// does not exist. Merged to one caster each: 155 shadow draws become 7, the
// colour pass is untouched, and the triangle count does not move.
//
// ── What is left, named, with an owner ────────────────────────────────────
//
// A budget that only reports the parts somebody has already fixed is a budget
// that will be quoted at the next round and be wrong again. Three rows are over
// the target and none of them is this module's to close:
//
//   **The field's colour pass: 173 of the 277 colour draws.** 208 meshes across
//   seven machines wearing 82 materials — about twelve materials a machine,
//   which `mat()` in `vehicles/parts.ts` already caches by colour and options,
//   so they are twelve genuinely different paints and no merge goes below
//   twelve draws a machine. Twenty-nine *meshes* a machine can, and that is
//   about a hundred draw calls. `Shell` here does exactly that merge and cannot
//   be switched on at rung 0, because it freezes the wheels: only `vehicles/`
//   knows which parts turn, so only `vehicles/` can merge the static remainder
//   at build time and leave the moving parts separate. **That is the single
//   largest remaining item in the frame and it is a request, not a finding.**
//
//   **`hazards`: 26 colour draws for 1,008 triangles**, 26 meshes in 14
//   materials, on the smoke's frame. Twenty-six submissions for a thousandth of
//   the frame's geometry is the instancing rule in ARCHITECTURE §2.5 pointed at
//   `track/courses/hazards.ts`; the audit's `offenders` list does not catch it
//   because the meshes are not the *identical* geometry+material pair the
//   offender test looks for, which is a limit of that test worth knowing.
//
//   **`itemRig` and `items`: 22 colour draws for 1,810 triangles.** Same shape,
//   `src/items/`.
//
// Those three are 220 draws for 0.7% of the frame's triangles. Until they land,
// `RUNG0.drawCalls` is 400 rather than the 350 the derivation asks for, and the
// fifty calls between them are the three items above. They are worth about a
// hundred and fifty between them, so the derived number is reachable and the
// only reason it is not the gate today is that this module cannot reach it.
export interface FrameCeiling {
  /** `renderer.info.render.calls` on a rung-0 racing frame. */
  drawCalls: number;
  /** ...and `.triangles`, colour pass and shadow pass together. */
  triangles: number;
  /**
   * Simulation + update, normalised to one 60fps frame. See `gate()`.
   *
   * **Two numbers, and the gap between them is the instrument rather than the
   * game.** `cpuTargetMs` is what the work is supposed to cost — a quarter of a
   * 60fps frame, against 3.1ms measured live — and `cpuMs` is what the build
   * fails at. They differ because the only bench that runs this gate is a
   * shared software-rasteriser container, and four consecutive runs of the
   * identical smoke recipe measured 2.47, 2.95, 3.18 and 4.00ms of median CPU
   * for byte-identical work. That is the box being busy, not the game changing,
   * and a ceiling drawn inside it fails the build at random — which teaches
   * everybody to re-run rather than to look. The enforced line clears the
   * observed spread; the target is stated beside it and is what a live
   * measurement should be held to.
   */
  cpuMs: number;
  cpuTargetMs: number;
  /** What the ceilings were derived at. A budget with no viewport in it is a
   *  budget about no machine — the frame is fill-bound, so 1600x900 is part of
   *  the claim and not a footnote to it. */
  at: string;
}
const RUNG0: FrameCeiling = {
  drawCalls: 400,
  triangles: 1_000_000,
  cpuMs: 6.0,
  cpuTargetMs: 4.0,
  at: '1600x900, 7 racers, cone-canyon, rung 0',
};
/**
 * Fixed steps a 60fps frame runs, which is the denominator the CPU ceiling is
 * quoted against.
 *
 * `FIXED_DT` is 1/120, so a player at 60fps steps the simulation twice per
 * drawn frame. A capture harness driving `advance(1, 20)` steps it *six* times
 * per drawn frame and charges all six to that frame, so a gate comparing
 * `budget.simMs` against a per-frame ceiling would convict the game of being
 * three times more expensive than it is on exactly the bench that runs the
 * gate. See `gate()`.
 */
const STEPS_AT_60 = 2;
/**
 * Delivered frames the CPU reading is taken over, as a **median**.
 *
 * `budget.updateMs` is one frame, and one frame is not a measurement. Read off
 * the six shots of the review sheet in the round this gate was built, the last
 * rendered frame of each recipe reported 1.2, 6.8, 2.1, 7.1, 4.9 and 2.4ms of
 * update for what is the same game doing the same work — a lone frame after a
 * screenshot, a garbage collection, a deoptimised path taken once. A ceiling
 * enforced against that would fail at random, and a gate that fails at random
 * is worse than no gate at all: it teaches everybody to re-run the build.
 *
 * Thirty-two frames and the median rather than the mean, for the same reason
 * `wallMedian` exists twenty lines further down — a mean is one hitch away from
 * being a number about the hitch. A capture's `advance(1, 20)` fills two thirds
 * of this with homogeneous frames, and a live session fills it in half a
 * second.
 */
const CPU_WINDOW = 32;

/** Where the settled rung is written. Versioned, because the shape of the
 *  stored record is this file's business and nobody else's. */
const MEMORY_KEY = 'mc.quality.v1';
/** Wall seconds of delivered play at one rung before it counts as settled and
 *  is worth remembering. A person waiting, so wall seconds — and long enough
 *  that a rung passed through on the way down is never the one recorded. */
const MEMORY_SETTLE_S = 10;
/** ...and delivered frames of it, for the same reason every other dwell in this
 *  file is a pair. Twenty frames is a third of a second on a machine that is
 *  fine and half a minute on one that is failing; the second is the case that
 *  matters and the one the seconds alone would get wrong. */
const MEMORY_SETTLE_FRAMES = 20;

/**
 * What machine is this, coarsely enough to be the same machine tomorrow.
 *
 * Three parts, and each of them is here because leaving it out makes the memory
 * wrong rather than merely imprecise:
 *
 *   **The GPU.** `WEBGL_debug_renderer_info`'s unmasked renderer string, which
 *   is the only thing the platform will tell a page about what it is drawing
 *   with. Falls back to the masked `RENDERER`, which on a locked-down browser
 *   is a constant — and a constant is still a valid key, it just means "this
 *   browser" instead of "this GPU".
 *
 *   **How many pixels it is being asked for**, bucketed at 200k. The frame cost
 *   is fill-bound (see `LADDER`), so the same GPU at 3840x2160 and at 1280x720
 *   is two different machines as far as this ladder is concerned. Bucketed
 *   coarsely so that dragging a window forty pixels wider is not a new machine
 *   with no history.
 *
 *   **The ladder itself.** See `LADDER_SIG`.
 *
 * Nothing here is a fingerprint anybody could not already read off the same
 * page, and it never leaves `localStorage`.
 */
function hardwareKey(ctx: GameContext): string {
  let gpu = 'gl';
  try {
    const gl = ctx.renderer.getContext() as WebGLRenderingContext;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info') as
      { UNMASKED_RENDERER_WEBGL: number } | null;
    const raw: unknown = dbg
      ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    if (typeof raw === 'string' && raw) gpu = raw.slice(0, 64);
  } catch {
    // A context that will not answer is a machine with one name. Still a key.
  }
  const el = ctx.renderer.domElement;
  const w = el.clientWidth || el.width || 1280;
  const h = el.clientHeight || el.height || 720;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const bucket = Math.max(1, Math.round((w * h * dpr * dpr) / 200000));
  return `${gpu}|${bucket}|${LADDER_SIG}`;
}

/** The rung this machine settled at last time, or -1 if it has never been here.
 *
 *  Every access to storage in this file is wrapped: Safari's private mode
 *  throws on `localStorage` outright, a page served from `file://` has no
 *  origin to key it on in some browsers, and a governor that takes the boot
 *  down because it could not remember something is worse than one with no
 *  memory at all. */
function readMemory(key: string): number {
  try {
    const raw = globalThis.localStorage?.getItem(MEMORY_KEY);
    if (!raw) return -1;
    const rec = JSON.parse(raw) as { k?: string; rung?: number };
    if (!rec || rec.k !== key || typeof rec.rung !== 'number') return -1;
    const r = Math.round(rec.rung);
    if (!(r >= 0)) return -1;
    return r >= LADDER.length ? LADDER.length - 1 : r;
  } catch {
    return -1;
  }
}

function writeMemory(key: string, rungIndex: number): void {
  try {
    globalThis.localStorage?.setItem(
      MEMORY_KEY, JSON.stringify({ k: key, rung: rungIndex, at: Date.now() }));
  } catch {
    // Storage full, disabled, or partitioned. The session still works; it just
    // starts from the top next time, which is where it used to start every time.
  }
}

// ── the thresholds ─────────────────────────────────────────────────────────
//
// All in milliseconds of **wall time between delivered frames**, which is the
// only number that is the same thing the player experiences. It includes vsync
// idle by construction, which is why the targets below are multiples of a frame
// period rather than a work budget.

/** The frame period the game is for. */
const TARGET_MS = 1000 / 60;
/** Sustained frames this much longer than the target are a machine missing it.
 *  1.22x of 16.7 is 20.4ms — under fifty frames a second. */
const DOWN_FACTOR = 1.22;
/** A frame this much over the target is a hitch the player sees. */
const LATE_FACTOR = 1.5;
/** More than this share of the window hitching costs a rung even if the mean
 *  looks respectable — the case a mean alone can never report. */
const DOWN_LATE_FRAC = 0.12;
/** Frames this far over the target are an emergency: under twenty-eight a
 *  second, the game is failing the player worse than any pop could. */
const PANIC_FACTOR = 2.2;
/** Frames arriving inside this much of the target are arriving on time. */
const UP_FACTOR = 1.05;
/** ...and to climb, the *work* underneath them must have room too. A
 *  vsync-locked 16.7ms is the same reading on a machine with 60% headroom and
 *  on one with none, so the wall clock alone can never authorise a climb. */
const UP_WORK_MS = 8.5;
/** The spike test the old ladder never made: one bad frame in the window is
 *  enough to say there is no room, however good the mean looks. */
const UP_WORST_MS = 13;

/**
 * ── Dwells and settles, in two units each ──────────────────────────────────
 *
 * Every one of these is "wait a bit before believing that", and every one of
 * them was denominated in wall seconds alone. At 0.7 delivered frames a second
 * a wall second is less than one frame, so *all four* collapsed to "the very
 * next frame may do it" on precisely the machine they exist to protect: a
 * dwell that cannot outlast a single hitch is not a dwell, and a settle that a
 * change's own transient satisfies is not a settle.
 *
 * So each one is now a pair — wall seconds **and** delivered frames — and both
 * have to be met. On a machine that is fine the seconds bind (1.2s is 72
 * frames at 60fps, so the frame counts are free); on a machine that is failing
 * the frames bind and the guarantee is stated in the only unit that means
 * anything there: *pictures the player was actually shown*.
 */
/** Seconds over budget before a rung is given up. Real seconds. */
const DOWN_DWELL = 1.2;
/** ...and delivered frames of it, so one hitch can never be the whole case. */
const DOWN_DWELL_FRAMES = 4;
/** ...and under it before one is taken back. Deliberately much longer: a hitch
 *  may cost a rung, but nothing wins one back by accident.
 *
 *  No frame companion, and that absence is a measurement rather than an
 *  oversight: "under budget" means frames are arriving inside 17.5ms, so nine
 *  seconds of them is over five hundred frames by construction. A slow machine
 *  cannot reach this condition at all, let alone reach it early. */
const UP_DWELL = 9;
/** ...and in an emergency, where the evidence is already overwhelming. */
const PANIC_DWELL = 0.35;
/** ...but still more than one picture. Two frames at 0.7fps is 2.9 seconds,
 *  and it is what stops a single stalled frame walking the whole ladder. */
const PANIC_DWELL_FRAMES = 2;
/** Seconds after any change during which nothing is decided. */
const SETTLE = 2.2;
const SETTLE_FRAMES = 6;
/** ...and after an emergency change, where waiting is its own cost. */
const PANIC_SETTLE = 0.9;
const PANIC_SETTLE_FRAMES = 2;
/**
 * Delivered-play seconds between two landings of the render scale.
 *
 * The only number the live resolution lever adds, and it is a floor on how
 * often the picture may change size rather than a moment gate — the rung change
 * that asked for the move has already passed `pictureLocked()` and
 * `onAStraight()`. What this stops is a ladder that is oscillating, or one
 * taking a panic pop of six rungs, turning into six separate resizes: a
 * multi-rung change lands exactly one.
 *
 * Two seconds, which is one delivered frame on the machine this file exists for
 * and a hundred and twenty on one that is fine. That asymmetry is the right way
 * round: the failing machine gets its rescue on the next frame it draws, and
 * the healthy one — which by definition is not asking for a rung — cannot
 * flicker.
 */
const SCALE_HOLD_S = 2;
/**
 * How far the render scale may travel in one frame of a 60Hz display.
 *
 * ── Why the biggest lever on the ladder is now the slowest one ──────────────
 *
 * Because a dissolve is not a cut. Round eight made `scale` live and left it a
 * step function, and the review that followed caught the consequence live: the
 * collapse path took **1.00 to 0.50 in a single frame** — `collapsed (152x
 * budget) x6` at nine seconds — so the one thing a player was guaranteed to see
 * the governor do was the whole picture changing size at once, underneath the
 * course's beauty sweep. Every other lever in this file is graded (a ramp
 * anchored at a knee, a cap on the next burst, a threshold in projected
 * pixels); this one was not, and it is the loudest.
 *
 * ── ...and why it is denominated per *frame* and paced by the wall clock ────
 *
 * The unit rule (§2) says a person waiting is measured in wall seconds and a
 * statistic in delivered frames, and this is neither: it is an *animation*, and
 * an animation is frames **at a rate**. So the step is `SCALE_RAMP` per 16.7ms
 * of the frame that just went by, which reads correctly at both ends of the
 * range this file exists across:
 *
 *   at 60fps        0.04 a frame — 1.00 to 0.50 takes 13 frames, 0.21s. A
 *                   dissolve, which is what a player at 60fps can see.
 *   at 20fps        0.12 a frame — four frames, still 0.21s.
 *   at 0.7fps       the whole traverse in one frame, and correctly: a machine
 *                   delivering a picture every 1.4 seconds has no motion to
 *                   dissolve *into*, every frame it draws is already a cut, and
 *                   spending thirteen of them easing the rescue in would be
 *                   eighteen seconds of the worst frame rate in the session to
 *                   avoid an artefact nobody can perceive at that rate.
 *
 * That last row is the one that matters, and it is why the pacing is not simply
 * "0.04 a frame": the naive version turns the emergency path into a slideshow
 * of thirteen intermediate resolutions on exactly the machine the emergency
 * path exists for. It also bounds the cost — each step is a resize of the post
 * stack's own targets, and only a machine fast enough to afford thirteen of
 * them ever asks for thirteen.
 */
const SCALE_RAMP = 0.04;
/** ...and the frame period that rate is quoted against. Not `TARGET_MS`: this
 *  is a statement about how fast a change may be *watched*, which does not
 *  change if the target frame rate ever does. */
const SCALE_RAMP_MS = 1000 / 60;
/** Below this the ramp has arrived. One percent is `setRenderScale`'s own
 *  quantisation, so a smaller epsilon would ask for resizes of nought pixels. */
const SCALE_EPS = 0.005;
/** Seconds of quiet after a harness-driven frame before measuring resumes. */
const BENCH_HOLD = 4;
/**
 * Two harness-driven frames closer together than this and the governor stands
 * down for the rest of the session.
 *
 * This is the shape that tells a bench from a player, and it took a wrong
 * answer to find it. "Park while the harness is busy" is not enough: a capture
 * recipe like `rideUntil` steps the simulation for three or four seconds of
 * wall time without rendering once, and in that window the page's own rAF loop
 * is producing perfectly genuine live frames at two hundred and fifty
 * milliseconds each on a software rasteriser. A governor that only waits for
 * quiet wakes up inside that window, reads 250ms, and walks the review sheet
 * down to the bottom rung one step at a time.
 *
 * What actually separates the two is *burstiness*. `advance()` and the capture's
 * `settle()` render eighteen to twenty-eight frames back to back; the front end
 * renders exactly one, once, to prime shaders at the start of a race. So a
 * second bench frame arriving within a second of the first is a bench, full
 * stop, and no measurement taken on this page is about a player's machine.
 */
const BENCH_BURST = 1;

/**
 * Seconds of delivered frames before the first verdict — **seconds, not
 * frames.**
 *
 * The gate this replaces was 240 rendered frames, which is four seconds at
 * sixty and two minutes and twenty seconds at 1.7, so the machines that needed
 * the governor most were the machines it refused to look at. Measured: a
 * 320x180 session reached its 240th frame at t=140.5s and dropped its first
 * rung at t=149.5s, two and a half minutes into a race the player had already
 * given up on.
 *
 * Three seconds is enough for the things that make an early frame a liar —
 * shader compilation, texture upload, the JIT — and is the same three seconds
 * on every machine.
 */
const WARMUP_S = 3;
/** ...but the emergency path arms sooner, because it is the emergency path. */
const PANIC_ARM_S = 1.4;
/** Samples before any statistic is trusted. Guards the first frames after a
 *  change, when the window has been emptied on purpose. */
const MIN_SAMPLES = 6;
/** ...and for the emergency path, which is counting frames that are each a
 *  quarter of a second long and cannot afford to wait for six of them. */
const PANIC_SAMPLES = 4;
/**
 * ...and before a *drop* is judged to have bought anything. **Unconditional.**
 *
 * There was a disjunction here — this many frames *or* `VERDICT_WAIT_S` seconds
 * with `PANIC_SAMPLES` (four) behind it — on the reasoning that fourteen frames
 * is half a minute on a machine delivering 1.7 a second and waiting half a
 * minute to notice a cut did nothing is three more cuts on the way down.
 *
 * The arithmetic in that reasoning was wrong (fourteen frames at 1.7fps is
 * eight seconds, not thirty) and the escape hatch it justified was the whole
 * bug: every verdict a slow machine ever reached was taken through it, on four
 * samples, against a window whose worst frame was 2x its mean. A four-sample
 * mean cannot resolve a 14% step in that distribution, and it did not.
 *
 * Fourteen delivered frames is a quarter of a second on a machine that is fine
 * and eight seconds on one that is failing — and eight seconds is what it costs
 * to be sure, once, before spending the rest of the session on the answer.
 */
const VERDICT_SAMPLES = 14;
/**
 * ...and if the window has not filled within this many **delivered frames** of
 * the cut, the verdict is abandoned rather than taken on thin evidence.
 *
 * Not a second escape hatch: it *drops* the verdict instead of deciding it, so
 * the ladder is unblocked and `futile` is left exactly where it was.
 *
 * ── Why this is counted in frames now ──────────────────────────────────────
 *
 * It was thirty wall seconds, and it is the fourth instance of the bug this
 * round is about. The thing it is waiting for — `VERDICT_SAMPLES` entries in
 * the window, behind `SKIP_FRAMES` discarded ones — is measured in *frames*,
 * seventeen of them; and seventeen frames is a quarter of a second on a
 * machine that is fine, 20s at 0.7fps and 34s at 0.5. So under about 0.55
 * frames a second the deadline landed before the evidence could possibly
 * arrive and **every** verdict was abandoned, on exactly the machines where a
 * futile cut costs the most. A deadline in wall seconds in front of a window
 * that fills in frames is a deadline that expires faster the slower the
 * machine is.
 *
 * Counted this way it can only be reached by frames being *discarded* — the
 * page suspended, or the harness stepping the simulation inside the window —
 * because seventeen delivered frames fill the window by definition. Eight
 * frames of slack over the seventeen, so a couple of spoiled frames do not
 * throw away an answer that was one frame away.
 */
const VERDICT_ABANDON_FRAMES = 25;

/**
 * A drop that buys less than this fraction of the frame back bought nothing.
 *
 * Set under the smallest step the ladder actually contains — rung 0 to rung 1
 * measured 7% — and well over the step the previous ladder's cheapest rungs
 * measured, which was zero. It is a detector for "this lever does not apply to
 * this machine", not a quality bar on the ladder.
 *
 * It is a **floor** under the real bar rather than the bar itself: see
 * `FUTILE_Z`. A fixed 4% against a window with a 20% standard error is not a
 * measurement, it is a coin toss with a decimal point on it.
 */
const FUTILE_GAIN = 0.04;
/**
 * ...and the bar is at least this many standard errors of the difference
 * between the two medians.
 *
 * One sigma, not two. This is not a hypothesis test that has to survive
 * publication; it is a choice about which way to be wrong, and the two ways
 * are not symmetric — see the header. One sigma keeps the check sharp on a
 * quiet window (where the error is a rounding error and the bar collapses to
 * `FUTILE_GAIN`) and mute on a noisy one, which is exactly the right shape.
 */
const FUTILE_Z = 1;
/**
 * ...and if the bar the noise demands is wider than this, no verdict is taken.
 *
 * The rungs on this ladder measure 14-26% apart. A window whose own error bar
 * is wider than 12% cannot tell a working cut from a useless one, so a "futile"
 * read off it means nothing — and acting on it costs the player a fifth of
 * their frame rate for the rest of the session. Above this, the answer is
 * `unresolved`, which is a real answer and is reported as one.
 */
const FUTILE_RESOLVE = 0.12;
/** MAD -> sigma for a normal sample. */
const MAD_SIGMA = 1.4826;
/** ...and sigma -> the standard error of a *median*, which is sqrt(pi/2) wider
 *  than the standard error of a mean over the same samples. */
const MEDIAN_SE = 1.2533;
/**
 * ── How far one emergency drop is allowed to go ────────────────────────────
 *
 * The emergency path used to move exactly one rung, wait out `PANIC_SETTLE`,
 * judge, and move one more — which is correct arithmetic and the wrong *shape*
 * for what the player is looking at. Measured on the session this round was
 * sent back for: six changes in two hundred seconds, three of them inside the
 * first three and a half race-seconds after the flag, so a player who had just
 * launched watched the picture step down at 1.30, 2.44 and 3.58. Three pops
 * cost three times what one pop costs and buy exactly what one bigger pop would
 * have bought.
 *
 * A machine at 900ms a frame is not one rung away from the target, it is
 * forty-four times too slow, and the governor already knows that — it is
 * reading the number. So the emergency path now sizes its step from the
 * evidence instead of always taking one:
 *
 *   steps = round( ln(how many times too slow) / ln(RUNG_GAIN) )
 *
 * `RUNG_GAIN` is measured, not guessed: the interleaved frozen-frame walk of
 * the ladder puts adjacent rungs between 14% and 26% apart, and 1.20 is the
 * geometric middle of that. It is deliberately an *under*-estimate of what a
 * content rung buys, because the two ways of being wrong are not symmetric —
 * an under-sized jump costs one more change, an over-sized one hands the player
 * a worse picture than the machine needed and the ladder cannot climb back out
 * of it while the machine is still failing.
 *
 * The cap is the other half of that asymmetry. Three rungs reaches the floor of
 * a seven-rung ladder in two changes from the top, which is the number this
 * round is about, and it keeps a single wildly wrong reading — one stalled
 * frame, one garbage collection — from spending the entire ladder at once.
 *
 * Measured live, `tools/perfgate.mjs` at 1600x900 on a deliberately loaded box:
 *
 *   t=26.1s  rung 0 -> 3   dropped (panic, ceremony overran) **x3**
 *   t=56.3s  rung 3 -> 6   dropped (panic, ceremony overran) **x3**
 *
 * Two changes from the top of the ladder to the bottom of it, against the six
 * this round was sent back for — and both of them inside the intro sweep,
 * through `CEREMONY_PATIENCE`, rather than in front of a player who had just
 * launched. The futility check judged the first of them exactly as it judges a
 * single-rung drop and had no trouble with the size of it: `{rung: 3, call:
 * 'worked', gain: 0.127, bar: 0.092, samples: 14}`.
 *
 * ── The second reason to coalesce, which was not the directive ─────────────
 *
 * **A change costs the player a frame, and the cost does not depend on how many
 * rungs it moves.** `changeMs` on those two entries reads 4220ms and 4231ms:
 * that is the canvas drawing-buffer reallocation a render-scale change *is*
 * (see `precompileLadder`, which prices it at +348ms at 320x180 and cannot
 * remove it from this file), measured at 1600x900 on a loaded box. Six changes
 * is six of those. Two is two. Coalescing therefore cuts the governor's own
 * hitch budget by two thirds at the same time as it cuts the number of pops the
 * player sees, and neither of those was obvious from the other.
 */
const RUNG_GAIN = 1.2;
/**
 * The most rungs one change may move. **The whole ladder, since round eight.**
 *
 * It was three, and three was a number rather than an argument: it capped the
 * step at "most of the way down" and then made the machine earn the rest
 * through a second panic drop, a second `PANIC_SETTLE`, a second window refill
 * and — the expensive one — a `VERDICT_SAMPLES` verdict between them. Measured
 * live at 1280x720 that walk cost **fifty to seventy seconds of delivered play
 * to reach the floor**, which is a minute of the worst picture the game can
 * draw handed to the player who least deserves it.
 *
 * There was never anything to buy with the cap. `RUNG_GAIN` already sizes the
 * step from how far over budget the machine measurably is, and the ladder's
 * whole descent is worth about 2.35x — so a machine reading five times the
 * budget cannot be rescued by *part* of it, and the arithmetic says so without
 * needing a second experiment on the player. What stops an over-reaction is the
 * futility check on the way back up, which is unchanged: if the floor turns out
 * to buy nothing, `worse`/`futile` puts a rung back and stands the ladder down.
 */
const PANIC_MAX_STEP = LADDER.length - 1;
/**
 * ...and the most rungs one **climb** may move. See `sizedClimb`.
 *
 * The same number, and the asymmetry between the two directions lives in the
 * dwells and in `sprintFloor` rather than here. A machine that has just been
 * collapsed six rungs by a garbage collection it has already finished is six
 * rungs from where it belongs, and capping the way back at three would put the
 * player through two nine-second dwells and two straights to say so.
 */
const UP_MAX_STEP = LADDER.length - 1;
/**
 * Below this share of the target frame period, the wall clock is measuring the
 * machine rather than the display, and `sizedClimb` may believe it.
 *
 * 0.92 of 16.7ms is 15.3ms. A vsync-paced window's *best* frame sits on the
 * period with a little jitter under it; a machine with real headroom that is
 * not being paced — a browser running rAF off a 120Hz panel, a page whose
 * compositor is not blocking — puts frames well under it. This is the only
 * question `wallBest` is asked and it is the reason the field is kept.
 */
const PACED_FRAC = 0.92;
/**
 * Wall seconds of delivered play after a climb within which a drop is that
 * climb's fault. See `sizedClimb` and `sprintFloor`.
 *
 * Eight, against a floor of `SETTLE` 2.2 + `DOWN_DWELL` 1.2 = 3.4s for the
 * fastest possible punishment and `UP_DWELL` 9s before the next climb can be
 * asked for. So the window covers every drop that is a consequence of the climb
 * and closes before the next climb decision can be taken, which is what stops
 * one bad bet being blamed on the bet before it.
 */
const CLIMB_PUNISH_S = 8;
/**
 * A frame this many times the budget is not a hitch, it is the machine.
 *
 * Five — 83ms, twelve frames a second — and the gap between this and
 * `PANIC_FACTOR` (2.2) is the whole design. Between the two, the machine is
 * over budget and the ladder walks down it one rung at a time under the full
 * evidence apparatus, because a rung might be all it needs. Above it, no amount
 * of the ladder is going to be enough on its own and the only useful thing the
 * governor can do is stop taking the scenic route.
 */
const COLLAPSE_FACTOR = 5;
/** Delivered frames of that before acting. Two: one is a stall, two is a rate. */
const COLLAPSE_FRAMES = 2;
/** ...and the samples the window needs to say so at all. */
const COLLAPSE_SAMPLES = 2;
/**
 * ...and the wall dwell beside it, which is also **the whole descent budget**.
 *
 * The unit rule (see the audit in the header) says a wait is denominated in
 * what a person sits through, and this is the only wait on the collapse path:
 * two delivered frames *and* 1.2 seconds, then one change that lands the floor
 * — resolution included, since round eight made `scale` live. On the machine
 * this file exists for that is one dwell of about four seconds and then the
 * rescue, against the fifty to seventy seconds the three-rung cap measured.
 *
 * The collapse path is the one place in this file that does **not** consult
 * `pictureLocked()`, and it is worth stating why rather than leaving it to be
 * discovered. The moment gate protects a composed picture — a countdown, a
 * finish, a results sheet — and its doors are 20 to 35 wall seconds long. At
 * twelve frames a second and worse there is no composed picture to protect:
 * the countdown is a slideshow, and every second spent waiting for a better
 * moment is a second of the thing the gate exists to prevent. `paused` is still
 * refused, because a paused game is a still frame with a plate on it and it is
 * not costing anybody anything.
 */
const COLLAPSE_DWELL = 1.2;
/** Consecutive futile drops before the governor puts one back and stands down. */
const FUTILE_LIMIT = 2;
/** ...and how much worse the frame has to get before it tries again. */
const RETRY_FACTOR = 1.4;

/** Frames of wall history. Emptied on every change, so it is never a mean
 *  across two different games. */
const WALL_WINDOW = 64;
/**
 * Frames thrown away after a change, before the window starts filling again.
 *
 * A settle counted in *seconds* is not a settle when a frame costs half of one.
 * Measured on the first live run of this ladder: the panic path's 0.9s lockout
 * was a single frame at 500ms, so every verdict included the frame in which the
 * shadow map was disposed and reallocated and the post stack's five mips were
 * resized. The change log came out non-monotone because of it — a rung that
 * dropped the frame from 913ms to 464ms was followed by one that "measured"
 * 690ms, which was the reallocation and not the game. The seconds-based settle
 * still runs on top, for the slower things (a batch of dressing coming back
 * into range).
 *
 * Three rather than two because the floor rung's shader recompiles do not all
 * land on one frame: three.js compiles a material the first time it draws it,
 * so turning the post stack off spreads its thirty new programs over however
 * many frames it takes for those objects to come into view. A 1.9-second frame
 * got past a two-frame skip on the live run and then sat in `wallWorst` for the
 * next sixty samples.
 *
 * ── ...but skipped is not the same as unmeasured ───────────────────────────
 *
 * These frames are excluded from the *steady-state* window because they are
 * the change reallocating itself rather than the game — that part was and is
 * right. What was wrong is that they were **thrown away**, which made the one
 * hitch the governor is personally responsible for the one hitch its own
 * instrument could not see. A governor structurally blind to the cost of its
 * own action cannot be asked whether its action was worth it.
 *
 * So the worst of them is now recorded on the change's own log entry as
 * `changeMs`, next to the `wallMs` the frame cost before it, and the worst of
 * the session is in the probe. See `changeCost` below and the note on
 * `precompileLadder`, which is where the number went once somebody could
 * finally read it.
 */
const SKIP_FRAMES = 3;

/**
 * ── The grave of `STALL_MS` ────────────────────────────────────────────────
 *
 * There was a constant here that read: *a gap longer than two seconds was not a
 * frame — an alt-tab, a breakpoint, a harness stall — and averaging it in would
 * convict the machine of it.* Every word of that is defensible and the rule it
 * produced destroyed the instrument.
 *
 * A numeric cut-off on frame length **discards exactly the frames this file
 * exists to measure**. Measured live at 1600x900 on a software rasteriser, the
 * top rung delivers frames 1.7 to 2.6 seconds apart; over two hundred seconds
 * of wall time the accumulator below accrued **1.66 seconds**, the sample window
 * never took a single entry, and `probe()` answered `holding: 'priming',
 * samples: 0` for three minutes on the one machine the governor exists to
 * protect. The warm-up gate that this replaced had the same property counted in
 * frames; moving it to seconds moved the bug one layer down rather than fixing
 * it. There is no third version of this shape: **frame length is never again
 * evidence about whether a frame is real.**
 *
 * What the cut-off was actually reaching for is two causes, and both of them
 * can be observed directly instead of guessed at from a duration:
 *
 *   - **The page was suspended.** A backgrounded tab, a bfcache restore, a
 *     phone locking. `document.visibilityState` says so, and the
 *     `visibilitychange` edge says exactly which gap spans it. One frame is
 *     discarded — the one that straddles the resume — and a genuine 2.4 second
 *     frame on a visible page counts as 2.4 seconds.
 *   - **The harness was driving.** `__GAME.step()` runs the simulation inside a
 *     `page.evaluate` with the rAF loop blocked behind it, so the callback that
 *     lands afterwards measures somebody else's work. `budget.benchSteps`
 *     counts those steps, so the frame that contains them is identifiable as a
 *     fact rather than as a suspiciously long one.
 *
 * Everything else — a slow GPU, a compositor stall, a garbage collection, a
 * genuinely enormous frame — is this machine being slow, which is the thing
 * being measured.
 *
 * There is deliberately no constant left here to tune.
 */

/** Curvature that still counts as straight. ~250m radius. */
const STRAIGHT = 0.004;
/** Seconds of road ahead that also has to be straight. */
const LOOKAHEAD = 1.3;

/**
 * The phases the picture is **composed** in: watched rather than driven.
 *
 * `countdown` is three beats and a flag in front of a near-static rig with the
 * player timing a rocket start; `finished` is the letterbox and the victory
 * lens; `results` is the standings sheet; `intro` is the grid sweep. `loading`
 * is both the boot and — see ARCHITECTURE §11a — the pause screen, which is a
 * still frame of the game with a plate over it and therefore the single worst
 * surface in the product to change the resolution on: nothing is moving to hide
 * it and the player is looking straight at it.
 *
 * Nothing here is about how fast the machine is. It is about whether anyone is
 * driving. How long each of them may hold the governor off *is* about how fast
 * the machine is, and that is `patienceFor` below.
 */
function isComposed(phase: string | undefined): boolean {
  return phase === 'intro' || phase === 'countdown' || phase === 'finished'
    || phase === 'results' || phase === 'loading';
}

/**
 * **Race** seconds after the flag before the picture may change again.
 *
 * The flag falling is the same beat as the "1" before it: the player is timing
 * a rocket start and about to look at a screen full of boost. A gate that
 * opened on the frame the phase turns `racing` would have moved the two
 * changes this constant exists for by a tenth of a second and photographed
 * exactly as badly.
 *
 * ── Why it is race seconds and not the seconds it used to be ───────────────
 *
 * It was 1.2 seconds of *delivered play*, accumulated in this file off the
 * wall clock, and it was the round-3 failure. The beat it is protecting is a
 * beat of the **game**: the countdown is three race-seconds long, the rocket
 * start's boost is a fixed number of race-seconds, and the whole gesture the
 * player is watching runs on `ctx.race.time`. Wall time and race time are the
 * same thing at 60fps and come apart by a factor of twenty-one at 0.7fps,
 * because `engine.ts` caps the fixed step at eight per frame and the
 * simulation goes into slow motion — so 1.2 wall seconds of protection was a
 * single frame, and the rung changes it exists to move landed on GO (race time
 * 0.0-0.2s) and at race time 1.2s, which is to say on the flag and on the
 * boost. Measured, photographed, and precisely the thing this gate is for.
 *
 * ── ...and why it is not `ctx.race.time`, which was the obvious answer ─────
 *
 * `race.time` is zero at the flag and advances only with the simulation, so it
 * is the right *unit*. It is the wrong *signal*, and the bench caught it: the
 * director's `beginCountdown()` does not reset it, so after a `race:seek` the
 * flag falls with `race.time` already reading fifteen seconds and the gate is
 * wide open on the frame the field is released. A reviewer's seek is the one
 * way a real session reaches a countdown twice, and it is precisely how this
 * gate is tested — a gate that its own test cannot arm is a gate that passes
 * its own test.
 *
 * So the flag is taken from the flag: `race:racing` is the transition edge the
 * director emits (and `setPhaseQuiet` deliberately does *not*, so pause and
 * resume do not counterfeit one), and this is measured from `ctx.time.elapsed`
 * at that moment, which is the fixed-step clock — literally "fixed steps since
 * the flag", counted in seconds. An edge published by the module that owns the
 * fact, exactly like `ui:menu` above it.
 *
 * ── ...and why it is now as long as the launch, rather than 1.2s ──────────
 *
 * 1.2 was a number. What the gate is actually protecting is a *gesture*: the
 * player times the flag, holds accelerate through the last beat, and the game
 * answers with `config.race.rocketStart.boost` — 1.5 race-seconds of boost,
 * screen effects, sound and camera kick, which is the single loudest thing the
 * game ever does and the single most-watched second and a half in a race. A
 * grace that expires at 1.2 lets go **inside** it.
 *
 * Measured, on the session this round was sent back for: six rung changes in
 * two hundred seconds, and three of them at race time 1.30, 2.44 and 3.58 —
 * every one of them after the old grace and every one of them during or
 * immediately after the rocket start. The player watched 1088x612 become
 * 927x522 become 832x468 become 736x414 across the three and a half seconds
 * they were being rewarded for a good launch.
 *
 * So it is derived from the boost rather than chosen: the launch is over when
 * the boost that *is* the launch is over, plus a beat to look away in. A
 * number two modules have to agree about is an interface, not a tuning
 * constant — ARCHITECTURE §11a — and the race owns this one.
 *
 * ── ...and why it now has a door, when the last version argued it needed none ─
 *
 * The old argument was: this is measured on the fixed-step clock, `engine.ts`
 * caps the fixed step at eight per frame, so every delivered frame buys
 * exactly 0.067 sim-seconds and the gate opens after eighteen pictures at any
 * frame rate. All of that is still true. What has changed is the arithmetic on
 * the other side of it: 2.2 race-seconds is **thirty-three** pictures, which at
 * 0.7 delivered frames a second is forty-seven wall seconds of a player sitting
 * at 0.7fps while the governor refuses to help.
 *
 * That is the exact shape `SEAL_PATIENCE` was added for — a refusal whose cost
 * in the unit a person waits in grows with the slowness it is gating — and the
 * previous round's version of this file argued its way out of it by measuring
 * the grace in pictures and never converting the answer into seconds. Eighteen
 * pictures was defensible without a door. Thirty-three is not, so it has the
 * same door every other refusal in this file has. See `LAUNCH_PATIENCE`.
 */
const CEREMONY_GRACE = config.race.rocketStart.boost.time + 0.7;
/**
 * ...and the door on it, in wall seconds of delivered play since the flag.
 *
 * Unreachable on any machine that is not failing: 2.2 race-seconds is 2.2 wall
 * seconds at 60fps and about 4 at 15fps, so the grace is over long before this
 * is. It opens only below about one and a half frames a second, which is where
 * the grace's own cost has grown past half a minute and the player has bigger
 * problems than a resolution change during their boost.
 */
const LAUNCH_PATIENCE = 22;
/**
 * ── The valve, and why one is needed at all ────────────────────────────────
 *
 * Seconds of delivered play inside the **intro sweep** before the emergency
 * path may act inside it after all. There is no equivalent for the sealed
 * phases above; this is the only door in the gate and the intro is the only
 * room it opens onto.
 *
 * A gate keyed on a *phase* has a property that is not obvious and is
 * dangerous: **its cost is proportional to the slowness it is gating.**
 * (`CEREMONY_GRACE` above is keyed on the race clock rather than on a phase,
 * which is why it is bounded in delivered frames and needs no door of its own.)
 * `engine.ts` caps the
 * fixed step at eight per frame to avoid a spiral, so once a frame costs more
 * than 66ms the simulation stops keeping up with the wall clock and the whole
 * game enters slow motion. A 3.2 second intro is 3.2 seconds at 60fps, 4.8
 * seconds at 10fps, 24 seconds at 2fps — and, measured on this box under a
 * software rasteriser at 0.65fps, **72 seconds**, with the countdown behind it
 * taking another 68. A gate keyed on the phase therefore locks the governor out
 * for longer the more the machine needs it, which is the exact shape of the two
 * bugs in the header (a warm-up counted in frames, a stall counted in
 * milliseconds) pointed at a third target. Left absolute, it deadlocks: the
 * governor cannot make the frame cheaper until the ceremony ends, and the
 * ceremony cannot end until the frame is cheaper. Measured, before this valve
 * existed: a 110-second live session that never reached the flag and never
 * moved off rung 0, reporting `mid-ceremony` for all of it.
 *
 * So the sweep — and only the sweep, which is a camera move over a field
 * driving into its slots, not a beat the player is timing — gives up after
 * this long. Twenty seconds is chosen so that it can only ever open below
 * about two and a half frames a second: at 5fps the sweep takes 9.6s and the
 * valve is unreachable, at 2fps it takes 24s and the valve opens for the last
 * four. And what comes through it pays for itself immediately — a rung off the
 * intro is a cheaper frame, a cheaper frame is a faster simulation, and the
 * countdown that follows is shorter.
 */
const CEREMONY_PATIENCE = 20;
/**
 * ...and the same door on the **sealed** beats — the countdown, the flag, the
 * results sheet.
 *
 * The round this was added is the round the sweep's valve was measured to be
 * *half* the answer. The header used to argue that only the intro needed a
 * door, on the reasoning that "a machine that has been at 1.5fps for forty
 * seconds can wait a few more for the flag". Measured, on the machine that
 * argument is about, it is not a few more: the countdown seal cost **56
 * seconds of delivered play** at 1.2-1.3fps, from `liveSeconds` 84 to 140,
 * reporting `locked: true, holding: 'mid-ceremony'` for all of it. Three
 * race-seconds of countdown plus 1.2 race-seconds of `CEREMONY_GRACE` is
 * fifty-six wall seconds once `engine.ts`'s eight-step cap puts the simulation
 * at 0.087x, and the file's own unit audit had marked both constants "ok" in
 * race seconds and never once converted them into what a person waits.
 *
 * That is the *exact* shape the header names as the class of bug this file
 * keeps losing rounds to — a gate whose cost is proportional to the slowness it
 * is gating — and the file had fitted a door to one instance of it and argued
 * the other away. So both have doors now.
 *
 * Much longer than the sweep's, because a countdown is a beat the player is
 * timing and the sweep is a camera move nobody is. Thirty-five seconds of
 * *delivered play inside this one beat* — the clock restarts on every phase
 * change, so the sweep's twenty cannot be spent on the countdown's account —
 * is a **twelve-fold** overrun of a three-race-second beat. At 60fps it is
 * unreachable by a factor of twelve; at 5fps a countdown takes 7s and it is
 * still unreachable; it opens only below about one and a half frames a second,
 * where the measured wait is fifty-six seconds and no amount of not-popping is
 * worth another twenty of them.
 *
 * It is also deliberately longer than the thirty-second pressure window in
 * `tools/perfgate.mjs`, which seeks straight into a countdown at rung 0 and
 * asserts that the rung does not move for the whole of it. That assertion is
 * the previous round's fix and it is still the right test of the *seal*; a
 * valve that its own regression test could trip would be a valve that had
 * quietly replaced the thing it was fitted to.
 *
 * ── ...and the tool's *other* assertion, which this valve cannot satisfy ────
 *
 * `perfgate.mjs` ends with a second, blanket check: no entry in the change log
 * may carry a sealed `phase` at all. On a box slow enough for a three-race-
 * second countdown to take more than thirty-five seconds of delivered play,
 * that assertion and this door are contradictory by construction, and the door
 * is the one the previous round demanded — the seal it replaced was measured at
 * fifty-six seconds. Measured on a deliberately loaded box:
 *
 *   pressure verdict: rungs seen during ceremony = 0   (the seal held)
 *   change log:  {phase:'countdown', heldFor: 36.92, why:'... x3'}
 *   FAIL: 1 change(s) inside a sealed phase: countdown
 *
 * The pressure test passed and the blanket check failed on the same run, on the
 * same fact. The blanket check is right about the *shape* and one field short
 * of being able to say so: every entry carries `heldFor`, so the honest
 * assertion is "no change inside a sealed phase **with `heldFor` under
 * `SEAL_PATIENCE`**" — a change at `heldFor: 2` is the round-3 bug and a change
 * at `heldFor: 36.9` is this valve doing its job. `tools/**` is shared and is
 * not this file's to edit; the request is recorded here so the next reader of
 * that FAIL knows which of the two it is looking at.
 */
const SEAL_PATIENCE = 35;
/**
 * ...and the front-end's, which is the one this round was actually lost for.
 *
 * `pictureLocked()` opened with `if (frontEndOpen || paused) return true;` — an
 * unconditional refusal with no valve at all, on the single most expensive
 * frame in the product. Measured: the governor held `front-end` for the first
 * ~50 seconds of delivered play at 0.6-1.0fps and did not move a rung until
 * `liveSeconds` 69.96.
 *
 * Two things make that indefensible rather than merely cautious.
 *
 * **The refusal was protecting a picture that is not on the screen.** The
 * front-end's own opaque set covers the frame edge to edge; that is what
 * `budget.skipDraw` now exploits, and it is also why a rung change made behind
 * it is the *least* visible change this governor can ever make. There is no
 * pop to hide. The moment-gate argument for locking here was never true.
 *
 * **And the wait is unbounded in the only unit that matters.** The front-end
 * ends when a player presses a key, which sounds like the bounded case in the
 * header's corollary — but the fifty seconds above are fifty seconds of a
 * player *reading four screens* at 0.7fps, where every keypress they make is
 * answered a second and a half later. The frame rate is not slowing the thing
 * being waited for; it is what the player is stuck inside.
 *
 * So the panic path gets a door here too, and a shorter one than either
 * ceremony: twelve seconds. At 60fps twelve seconds of front-end is normal and
 * the valve is harmless because the panic threshold is nowhere near met; at
 * 0.7fps it is eight delivered frames and the machine has already proved
 * itself. The ordinary path stays shut behind the menu unconditionally — it
 * decides on a steady-state window, and the window behind the front-end is a
 * measurement of the menu's set rather than of the race.
 */
const FRONT_END_PATIENCE = 12;
/**
 * ...and how far down the ladder that door opens onto.
 *
 * **Mostly historical since round eight, and kept because it is still right for
 * the case it now covers.** A frame the front-end is covering is a frame whose
 * draw this file switched off, and those frames are discarded outright — see
 * `undrawnFrame`. The governor no longer moves at all behind an opaque menu,
 * so this cap is not what stops it there; what stops it is having no evidence.
 *
 * It still binds in the one case that is left: a front-end that is **up but not
 * covering** — the hand-off, where `stage.ts` has faded its backdrop and the
 * race behind it is being drawn again while the launch board is still in front
 * of it. There, the frame is genuinely half this file's and half somebody
 * else's, and the argument the constant was written for stands: the menus' own
 * second renderer sizes its backing store from a hardcoded
 * `Math.min(1, 1200 / w)` and cannot hear this ladder, so a cut to the *race's*
 * content cannot make that half of the frame cheaper and every verdict on one
 * will read `futile`. Half the ladder is as much as a half-owned frame is
 * allowed to spend.
 *
 * The cross-module request stands with it: the day `ui/menus/stage.ts` derives
 * its backing store from the `scale` this file already publishes on
 * `quality:changed` — one line, `Math.min(1, 1200 / w) * scale` — the hand-off
 * frame becomes a frame this ladder owns and the honest bottom is the ladder's
 * own bottom again.
 */
const FRONT_END_FLOOR = 3;

// ── the content pass's own constants ───────────────────────────────────────

/**
 * Instanced dressing at or under this bounding radius, in metres, is
 * **scatter**: a thing there are hundreds of, none of which is a landmark.
 *
 * Measured off the census of a settled Cone Canyon frame. Under this line sit
 * the traffic cones (0.6m, 807 of them, 74,244 triangles — the single largest
 * named row in the world), the drums (0.7m, 96), the tyre stacks (0.9m, 85),
 * the scrub (1.1m, 98) and the boulders (1.8m, 94). Over it sit the things the
 * eye navigates by — the crane, the mast, the land masses, the floodlight
 * towers, the grandstands — and thinning any of those is thinning the *place*
 * rather than the clutter in it.
 */
const SCATTER_MAX_R = 2.6;
/**
 * ...and fewer instances than this in a batch and thinning it shows.
 *
 * Nine cones taken down to five is a gap in a taper. Two hundred taken down to
 * a hundred and twenty is a slightly less busy verge, which is what a content
 * rung is allowed to look like.
 */
const SCATTER_MIN_N = 14;
/**
 * How far past a screen-size threshold a thing has to climb before it comes
 * back.
 *
 * The same dead band `vehicles/index.ts` puts on its part ladder and for the
 * same reason: a batch — or a rival — sitting exactly on the cut is a batch
 * sitting exactly on the cut for the whole corner, and without a band it
 * strobes once a frame.
 */
const CONTENT_HYSTERESIS = 1.25;

/**
 * Metres inside which a machine is **never** swapped for its shell, whatever
 * the pixel test says.
 *
 * The pixel test is the right instrument and it was allowed to run without a
 * floor under it, which at the bottom two rungs put a steam locomotive twenty-
 * three metres from the camera on a static merged mesh with its wheels and
 * connecting rods stopped. The silhouette claim held — photographed side by
 * side the swap is invisible — and that is the whole trouble with it: a still
 * frame cannot show a wheel that is not turning, and the reviewer found it by
 * reading `shelled: 5` rather than by looking. MK8D turns the wheels on the
 * kart in eleventh place.
 *
 * The pixel threshold is denominated in pixels because that is the unit the
 * *detail* lives in; motion is not detail, and a rotating wheel reads as motion
 * long after it stops reading as a wheel. So the two tests are ANDed: far
 * enough to have lost the detail **and** far enough that nobody is watching it
 * move. Twenty-eight metres is comfortably outside the twenty-three the review
 * found and comfortably inside the distance a shell is worth having — in a
 * spread field it costs one or two machines out of seven, and it is exactly the
 * one or two the pack shot is made of.
 */
const SHELL_MIN_M = 28;

/**
 * A ring of delivered frame times that is **never cleared**.
 *
 * Everything else in this file measures a short window it empties on every
 * change, which is right for deciding and useless for reporting: the one number
 * a review of this file needs — "was the governor's own worst frame small
 * against a typical frame of the session" — spans every change by construction
 * and therefore cannot be read off a window that a change resets. So the
 * session keeps its own ring, it costs one store a frame and two kilobytes, and
 * `probe().sessionMedianMs` is the denominator of the pass condition this round
 * is judged on.
 */
const SESSION_WINDOW = 512;

/** One entry in the change log. Built only when the ladder actually moves. */
export interface QualityChange {
  /** Seconds of delivered play since boot. */
  t: number;
  from: number;
  to: number;
  why: string;
  /** What the frame cost, in wall milliseconds, at the moment of the change. */
  wallMs: number;
  /** ...and what share of that was CPU work, so the reason is legible later. */
  workMs: number;
  bound: string;
  /**
   * The race phase the change landed in.
   *
   * Recorded because the last review of this file had to *photograph* the
   * moment of each change to discover that two of them fired inside the
   * countdown. That should be readable off the log rather than off a
   * screenshot. `racing` is the ordinary answer and `intro` is the only other
   * legal one — it means a machine so slow that the sweep had run for twenty
   * seconds, and see `CEREMONY_PATIENCE` for why that is a door rather than a
   * hole. Anything else here is a bug in the moment gate.
   */
  phase: string;
  /**
   * ...and the race clock, because the phase alone could not say *where in the
   * beat* a change landed.
   *
   * The review that sent this file back reported "rung 3 to 4 fired between
   * race time 0.0 and 0.2s, on GO" — a fact the log could not express, because
   * both changes were honestly labelled `racing`. Zero here means the flag
   * frame itself.
   */
  raceTime: number;
  /**
   * ...and the number the gate actually used: seconds on the fixed-step clock
   * since the `race:racing` edge.
   *
   * **Anything under `CEREMONY_GRACE` here is a bug in the moment gate.** It is
   * a separate field from `raceTime` because the two come apart, and the way
   * they come apart is itself the reading: `beginCountdown()` does not reset
   * `ctx.race.time`, so after a reviewer's seek the race clock says fifteen
   * seconds on the frame the flag falls. See `CEREMONY_GRACE`.
   */
  sinceFlag: number;
  /**
   * The front-end, as the gate saw it at the moment of the change.
   *
   * `true` on this line used to be a straight failure — a change made with the
   * title screen on the display. It is legal now, but only in one combination
   * and only through `FRONT_END_PATIENCE`, which is why the next field exists.
   */
  frontEnd: boolean;
  /**
   * ...and whether the front-end was actually *covering the frame* at that
   * moment, which is the fact that makes `frontEnd: true` acceptable.
   *
   * `frontEnd: true, covered: true` is a rung change made behind an opaque set
   * — the least visible change this governor can make, and the reason the
   * front-end has a valve at all. `frontEnd: true, covered: false` is the
   * round-3 failure: a change made over a screen the player can see through.
   * It should never appear on this log.
   */
  covered: boolean;
  /**
   * Seconds of delivered play the refusal that had to give way had been
   * running for: the front-end's clock behind a menu, the composed beat's
   * inside a ceremony, and 0 where the gate was simply open.
   *
   * Every gate in this file is a wait now rather than a wall, so "which gate
   * let this through, and how long had the player been inside it" is the fact a
   * reviewer needs and could not previously get without a stopwatch and a
   * screenshot. A change with `phase: 'countdown'` and `heldFor: 41.6` is a
   * countdown that has overrun its three race-seconds by a factor of fourteen;
   * the same line with `heldFor: 2` would be the round-3 bug.
   */
  heldFor: number;
  /**
   * The resolution the drawing buffer actually had at the moment of the change,
   * and the one the rung asked for.
   *
   * **These are normally different, and that is the round-six fix.** The scale
   * is a seam lever now: it moves at boot, at a race build and on a window
   * resize, and never on a frame the player is being shown, because moving it
   * is a swap-chain rebuild — measured at 3101ms live — and because shrinking
   * the canvas under a fixed-size DOM overlay is visible on every machine
   * whether it is slow or not. A log line whose `scale` and `scaleWanted`
   * disagree is a rung change the player could not have seen coming; a line
   * where they agree is one taken at a seam or on a composer that can move the
   * scale for free. See `flushScale` and `freeScalePath`.
   */
  scale: number;
  scaleWanted: number;
  /**
   * The rung the **seam-held** half of the picture was standing at when this
   * change was made, and which of its levers this change did not land.
   *
   * Round seven turned `scale`'s deferral into the general rule, so the pair
   * above generalises too: `to: 4, seamRung: 2, deferred: 'scale,crowd,aa'` is a
   * governor that has taken rung 4's particle cap and pixel thresholds now and
   * will take rung 4's resolution, crowd and edge resolve at the next race
   * build. An empty `deferred` on a line where `to !== seamRung` would mean two
   * rungs that differ in nothing seam-held, which is legal and rare.
   *
   * **A `deferred` naming `crowd` is the round-seven fix visible in the log.**
   * The change the last review rejected would read `deferred: ''` here, because
   * the crowd went out of the frame on the spot.
   */
  seamRung: number;
  deferred: string;
  /**
   * The **median** delivered frame immediately before the change, which is the
   * only fair denominator for `changeMs`.
   *
   * `wallMs` above is the mean of the same window and is on the line for
   * continuity; on the distributions this file lives in — 17ms to 1233ms round
   * a 483ms median — the mean reads a third high, and a session-long median
   * read at the *end* of a run is worse still, because a governor that worked
   * has moved it. A cut taken when the machine was at 4.5 seconds a frame is
   * not a four-second hitch merely because the machine is at two seconds by the
   * time anybody looks. Local median, local answer: see `changeRatio`.
   */
  medianMs: number;
  /**
   * `changeMs / medianMs` — what the change cost as a multiple of a typical
   * frame *at the moment it was made*.
   *
   * 1.0 means the governor's own transition was indistinguishable from an
   * ordinary frame. The transitions this round was sent back for read 3.5 and
   * 2.9. Zero while `changeMs` is still zero.
   */
  changeRatio: number;
  /**
   * **What the change itself cost**, in wall milliseconds: the worst delivered
   * frame of the `SKIP_FRAMES` the window discards after it.
   *
   * The governor spends the player's frame rate to buy the player's frame
   * rate, and until this field existed it could see only one side of that
   * trade — the frames it discarded to avoid measuring its own reallocation
   * were the only frames that contained its own reallocation. Compare it with
   * `wallMs` on the same line: 687 against 252 is what a rung change cost
   * before the duplicate canvas resize in `engine.ts` was removed.
   *
   * Zero until the skipped frames have gone by, so a log read the instant
   * after a change shows it as 0 rather than as a lie.
   *
   * ...and zero **for good** when any of those frames was spoiled — the page
   * suspended, the harness stepping, or a hand call into `__QUALITY` from a
   * reviewer's `page.evaluate`. That last one is not hypothetical: it is where
   * `changeWorstMs: 15,628.6` came from on a frozen-sim bench whose real switch
   * cost was 6-17.5ms, because an evaluate moves neither `benchSteps` nor
   * `benchFrames` and the Node round trip after each switch landed on the
   * governor's account. Unmeasurable is reported as unmeasured; see
   * `externalTouch`.
   */
  changeMs: number;
}

/**
 * One judgement of "did that cut buy anything", kept whatever the answer.
 *
 * The change log can only ever show the verdicts that *moved* the ladder, which
 * is the minority of them and the least interesting: a review reading it saw
 * `stalled (drops buy nothing)` with no way to see the numbers behind the call
 * or the four samples it was taken on. Every verdict is recorded here, with the
 * bar it had to clear and the spread that set the bar.
 */
export interface QualityVerdict {
  t: number;
  /** The rung the cut arrived at. */
  rung: number;
  /**
   * `worked` | `futile` | `worse` | `unresolved` | `abandoned`.
   *
   * `worse` is separate from `futile` and the separation is load-bearing. A
   * futile cut bought nothing; a `worse` cut made the frame measurably *worse*
   * than it was before, by more than the window's own error bar. Measured live
   * on the ladder this replaces: `{rung:4, call:'futile', beforeMs:537.7,
   * afterMs:839.8, gain:-0.562, bar:0.188}` — a cut that cost 56% of the frame
   * — followed by another drop 0.85s later, because `futile` had only reached
   * one and `FUTILE_LIMIT` is two. The player finished the session at 0.48
   * render scale on a rung the instrument had already measured as slower than
   * the one above it.
   *
   * "It got worse" is not half of "it did nothing". It is the one reading no
   * amount of spread can explain away, and it is acted on at once.
   */
  call: string;
  /** Median delivered frame before the cut, and after it. */
  beforeMs: number;
  afterMs: number;
  /** Fraction of the frame the cut bought back. Negative means it cost. */
  gain: number;
  /** ...and the fraction it had to beat to count, which is `FUTILE_GAIN` or
   *  the window's own standard error, whichever is larger. */
  bar: number;
  /** Delivered frames the verdict was taken over. */
  samples: number;
}

export interface QualityProbe {
  auto: boolean;
  benched: boolean;
  rung: number;
  label: string;
  tier: QualitySettings['tier'];
  /** Render resolution the drawing buffer **actually has**, as a fraction of
   *  the display's. */
  scale: number;
  /** ...and what the standing rung wants it to be. Equal to `scale` at a seam
   *  and after one; different in between. See `QualityChange.scale`. */
  scaleWanted: number;
  /** True while those two disagree — the ladder has moved and the buffer has
   *  not caught up, and will not until the next boot, race build or resize. */
  scalePending: boolean;
  /** Whether `ctx.composer` can move the resolution without rebuilding the swap
   *  chain (`setRenderScale`). True since `render/post.ts` grew one, which is
   *  what took `scale` off the seam — see `freeScalePath`. */
  scaleFree: boolean;
  /** Drawing-buffer rebuilds this session, and what the last one was for.
   *  **Zero** whenever `scaleFree` is true: through that path the canvas never
   *  moves and only the post stack's own targets are resized. */
  scaleFlushes: number;
  /** ...and how many times the lever has landed at all, by either path. */
  scaleSteps: number;
  scaleFlushWhy: string;
  /**
   * The lever is mid-dissolve, and the frames it has spent dissolving.
   *
   * `scaleSteps` counts *arrivals* and this counts the frames between them, so
   * the pair is the one honest answer to "was that a dissolve or a cut": a
   * session with `scaleSteps: 3` and `scaleRampFrames: 3` cut three times.
   * See `SCALE_RAMP`.
   */
  scaleRamping: boolean;
  scaleRampFrames: number;
  /**
   * The pixels the world is actually drawn into, as `WxH`, and the canvas it is
   * resolved onto beside it.
   *
   * **Read this rather than the canvas.** Through the free path the canvas
   * deliberately never changes size — that is the entire point, because the HUD
   * is DOM at native resolution and a canvas that shrinks under it is the defect
   * round six removed. A review that checks `canvas.width` to see whether the
   * ladder spent its resolution will therefore always read "it did not", which
   * was true before round eight and is now exactly backwards. `scenePx` is the
   * number that moves.
   */
  scenePx: string;
  canvasPx: string;
  /**
   * The rung the seam-held half of the picture is standing at, and which of its
   * levers the ladder is still waiting on a seam to install.
   *
   * `rung: 4, seamRung: 2, pending: 'scale,crowd,aa'` is the round-seven design
   * working: the ladder has earned rung 4 and taken its particle cap and its
   * three pixel thresholds; the crowd, the verge's share, the resolution and the
   * edge resolve arrive together at the next race build. Empty `pending` with
   * `rung === seamRung` is a settled picture.
   */
  seamRung: number;
  pending: string;
  drawDistance: number;
  particles: number;
  shadowSize: number;
  /** The rung stored for this machine, or -1 if nothing is stored, and whether
   *  this session *started* from it. */
  remembered: number;
  rememberedSeed: boolean;
  /** The coarse hardware key the memory is filed under. Reported so a review
   *  can tell "this machine has no history" from "the memory is broken". */
  memoryKey: string;
  /**
   * The content rung, and whether it found anything to spend.
   *
   * `crowd`/`scatter`/`minPx`/`shellPx` are what the rung asked for;
   * `crowdGeos`/`batches`/`cullables`/`shells` are what the census found to
   * apply it to, and `culled`/`shelled` are what it is holding off *this
   * frame*. A rung whose numbers are set and whose counts are zero is a census
   * that matched nothing — a renamed prop, a course with no crowd — and the
   * whole point of reporting both is that this reads as a broken classifier
   * rather than as a lever that mysteriously buys nothing.
   */
  content: {
    crowd: number; scatter: number; thinFar: number; minPx: number; shellPx: number;
    /**
     * ...and what the seam-held share is **actually installed at**, which
     * between a mid-race rung change and the next race build is a different
     * rung's answer. `crowd` above is what the standing rung wants; this is what
     * the grandstands have on them right now. A probe where those two disagree
     * is the seam rule working. See `SEAM_HELD`.
     *
     * `scatterLive` is kept beside it and is now always equal to `scatter`,
     * because round nine took that lever off the seam — reported rather than
     * deleted so a review comparing two builds can see *that* it moved.
     */
    crowdLive: number; scatterLive: number;
    /** The two scatter shares multiplied out: the density a batch is thinned to
     *  at the far end of the ramp. 1 is a ladder spending nothing on the verge. */
    scatterFar: number;
    crowdGeos: number; batches: number; cullables: number; shells: number;
    culled: number; shelled: number;
    /** Scatter batches the distance ramp is holding below the standing share
     *  this frame. See `ContentTrim.thinFar`. */
    thinned: number;
  };

  // ── the instrument: wall time between delivered frames ───────────────────
  /** Mean delivered frame time. **This is the number the ladder decides on.** */
  wallMs: number;
  /** ...and the median of the same window, which is what the *futility* verdict
   *  decides on. A big gap between the two is a long tail, and a long tail is
   *  the reading that makes a four-sample mean worthless. */
  wallMedianMs: number;
  /** Median absolute deviation of the window — the spread the verdict's bar is
   *  built from. Reported so a review can see why a verdict was unresolved. */
  wallMadMs: number;
  /**
   * Median delivered frame of the **whole session**, and how many frames that
   * is over. Never cleared by a change — see `SESSION_WINDOW`.
   *
   * This is the denominator the governor's own conduct is judged against:
   * `changeWorstMs` against `sessionMedianMs` is "how much worse than a normal
   * frame is the worst frame the ladder itself produced", and it is the one
   * question the short window structurally cannot answer, because the change
   * being judged is the thing that clears it.
   */
  sessionMedianMs: number;
  sessionSamples: number;
  /**
   * ...and the worst frame the session produced that the governor had nothing
   * to do with.
   *
   * The second half of judging `changeWorstMs` fairly, and it points *against*
   * this file rather than for it: `changeMs` is the worst of three consecutive
   * frames, and comparing a max-of-three to a median charges the governor for
   * whatever the machine happened to be doing. So the honest reading is the
   * pair — `changeWorstMs` against `sessionMedianMs` says how big the hitch is,
   * and against `sessionWorstMs` says whether it is a hitch *the ladder made*
   * or an ordinary bad frame that landed inside its window. A change that is
   * genuinely free reads at or under the session's own worst frame; the
   * transitions this round was sent back for read at six times it.
   */
  sessionWorstMs: number;
  /** Worst frame in the window. A mean cannot report a stutter; this can. */
  wallWorstMs: number;
  /** Fastest frame in the window — the machine's own floor, near enough the
   *  display period whenever anything is vsync-locked. */
  wallBestMs: number;
  /** Share of the window that arrived later than 1.5 frame periods. */
  lateFrac: number;
  /** Frames in the window. Below `MIN_SAMPLES` nothing is decided. */
  samples: number;
  /** Delivered frames a second, which is the thing a player would say. */
  fps: number;

  // ── the work, kept only to attribute blame once wall time has convicted ──
  /** CPU work over the *same* frames as `wallMs`. Compare the two. */
  workMs: number;
  /** The engine's own sixty-frame mean. Kept because it is what `stats()`
   *  reports, and because the gap between it and `workMs` is itself a reading:
   *  a big one means the machine's speed changed recently. */
  meanMs: number;
  worstMs: number;
  simMs: number;
  drawMs: number;
  /** 'sim' | 'draw' | 'gpu' | 'vsync' — where the frame actually went. */
  bound: string;

  /** Seconds the current verdict has been held. Negative while settling. */
  dwell: number;
  /** Seconds of delivered play since boot. The warm-up gate counts this. */
  liveSeconds: number;
  /** Why the governor is not acting right now, or the last thing it did. */
  holding: string;
  /** Drops in a row that bought nothing, and whether it has given up. */
  futile: number;
  stalled: boolean;
  /**
   * The climb, which is sized from measured headroom rather than hardcoded at
   * one rung. See `sizedClimb`.
   *
   * `climbStep` is what a climb *would* ask for right now, `lastClimbStep` what
   * the last one did, `sprintFloor` the best rung a multi-rung climb is allowed
   * to reach (0 = the whole ladder), and `climbOnTrial` whether the last climb
   * is still inside the window in which a drop would convict it.
   */
  climbStep: number;
  lastClimbStep: number;
  sprintFloor: number;
  climbOnTrial: boolean;
  /**
   * Frames thrown away because the page was suspended through them, and frames
   * thrown away because the harness stepped the simulation inside them.
   *
   * Reported rather than silently discarded, because the last two reviews of
   * this file were both lost to an instrument that was quietly throwing
   * evidence away: `suspended` climbing while `samples` sits at zero is the
   * exact signature, and it is now visible from the probe instead of having to
   * be inferred from a governor that never moves.
   */
  suspended: number;
  hijacked: number;
  /**
   * ...and frames thrown away because this file switched their draw off.
   *
   * The round-eight entry. A frame behind an opaque front-end draws nothing of
   * the race — 0 calls, 0 triangles — so its duration is a measurement of
   * `ui/menus/stage.ts`'s own renderer and of nothing this ladder can spend.
   * Judging them walked the governor three rungs down a title screen and then
   * persisted the answer. See `undrawnFrame`.
   */
  undrawn: number;
  /** The race phase, as the moment gate sees it, and whether the gate is shut.
   *  A change logged with `locked: true` would be a bug. */
  phase: string;
  locked: boolean;
  /**
   * The two facts `phase` cannot carry, straight off the edges that publish
   * them: is the front-end up, and is the game paused.
   *
   * ARCHITECTURE §11a: the race keeps simulating behind an opaque title screen,
   * so a probe reporting `phase: 'racing'` may well be describing a game
   * nobody can see. These two say which.
   */
  frontEnd: boolean;
  /**
   * ...and whether the front-end is covering the *whole frame* with an opaque
   * set of its own, which is a different question and the one the engine acts
   * on. True here means the race behind it is not being drawn at all —
   * `budget.skipDraw`, and `stats().drawSkipped` on the same frame.
   */
  frontEndCovers: boolean;
  /** Seconds of delivered play the front-end and the current composed beat have
   *  each been up. The two patience valves count these; compare them against
   *  `FRONT_END_PATIENCE`, `CEREMONY_PATIENCE` and `SEAL_PATIENCE` to see how
   *  much of a refusal is left. */
  frontEndFor: number;
  ceremonyFor: number;
  paused: boolean;
  /** What the race director's clock says, and what the flag's grace actually
   *  measures — seconds on the fixed-step clock since `race:racing`. They come
   *  apart after a seek; see `QualityChange.sinceFlag`. */
  raceTime: number;
  sinceFlag: number;
  /** The worst frame of the last change's own reallocation, and the worst of
   *  the session — the cost of the governor's own action, which for three
   *  rounds it was structurally unable to see. */
  changeMs: number;
  changeWorstMs: number;
  /**
   * ...and the worst of them as a multiple of a typical frame **at the moment
   * it was made** — `QualityChange.changeRatio`, maximised over the session.
   *
   * This is the number to read, and `changeWorstMs` on its own is the number
   * that misleads, in the governor's *disfavour*: a ladder that works moves the
   * session's own median while it runs, so a change made at 4.5 seconds a frame
   * reads as a four-second hitch against a session median of two seconds that
   * the change itself is responsible for creating. Both are reported; only one
   * of them is a measurement of the same thing twice.
   */
  changeWorstRatio: number;
  /** Every change this session, most recent last. */
  log: QualityChange[];
  /** ...and every judgement of a change, whether or not it moved anything. */
  verdicts: QualityVerdict[];
}

export function createQualitySystem(ctx: GameContext): GameSystem {
  let index = START_RUNG;
  /**
   * ...and the rung the **seam-held** half of the picture is standing at.
   *
   * The ladder earns `index`; `seamIndex` follows it at boot, at a race build
   * and on a window resize, and at no other time. Everything in `SEAM_HELD` is
   * read off this one and everything else off `index`, which is the whole of the
   * round-seven fix: the crowd, the verge's share, the edge resolve, the tier
   * and the draw distance cannot change while the player is watching, because
   * the number they are read from cannot.
   */
  let seamIndex = START_RUNG;
  let auto = true;

  // ── what this machine was last time ──────────────────────────────────────
  //
  // Resolved in `init()`, once the renderer exists to be asked what it is.
  // `memoryRung` is both "what is stored" and "what we last wrote", so a
  // settled session that has not moved never touches storage again.
  let memoryKey = '';
  let memoryRung = -1;
  /** Was this session's starting rung read out of storage rather than assumed.
   *  Reported: a governor that starts at rung 4 without saying why looks like a
   *  bug and is the fix. */
  let memorySeeded = false;
  /** The exact object we last wrote to `ctx.quality`, so a tier set by anyone
   *  else is recognisable by identity rather than by comparing fields. */
  let applied: QualitySettings | null = null;

  // ── the wall-clock instrument ────────────────────────────────────────────
  const wall = new Float32Array(WALL_WINDOW);
  /**
   * CPU work for the same frames, sample for sample.
   *
   * `budget.meanMs` cannot be used for this. It averages sixty *frames*, which
   * is a second on a machine that is fine and thirty-five seconds on one that
   * is delivering 1.7 — so on exactly the machine the attribution matters for,
   * it reports work from half a minute ago. Measured: while the steady state
   * read 6.6ms of work against a 590ms frame, `budget.meanMs` was still saying
   * 699ms and the change log was blaming the draw for a frame that was idling
   * in the driver. Same samples, same window, or the comparison is not one.
   */
  const work = new Float32Array(WALL_WINDOW);
  let wallIdx = 0;
  let wallCount = 0;
  /** Frames still to discard after a change. See `SKIP_FRAMES`. */
  let skipFrames = 0;
  /** `performance.now()` at the previous delivered frame, or 0. */
  let lastFrameAt = 0;
  /** Rendered frames the rAF loop drove, as last seen. */
  let seenLive = -1;
  /** ...and fixed steps the *harness* drove, as last seen. A frame whose gap
   *  contains any of those measured somebody else's work. */
  let seenBenchSteps = -1;
  /** Latched between delivered frames: the harness stepped or drew inside this
   *  gap. Cleared by the live frame that discards itself for it. */
  let harnessSince = false;

  // ── was this a frame, or was the page not running ────────────────────────
  //
  // See the note where `STALL_MS` used to be. These two are the whole of the
  // suspension test, and neither of them looks at how long the frame was.
  /** The page is backgrounded; nothing it does not deliver is its fault. */
  let pageHidden = false;
  /** A visible edge landed since the last frame, so the next gap spans the
   *  suspension rather than a frame. Exactly one frame is discarded for it. */
  let resumed = false;
  /** Frames discarded because the page was not running through them. Reported,
   *  because an instrument that quietly throws things away is how this file
   *  failed its last two reviews. */
  let suspended = 0;
  /** ...and frames discarded because the harness stepped the sim inside them. */
  let hijacked = 0;
  /** ...and frames discarded because this file had switched their draw off. */
  let undrawn = 0;
  let offVisibility: (() => void) | null = null;
  /** Real seconds of delivered play. The warm-up and every dwell count this,
   *  and none of them are clamped: at 1.7fps a clamped accumulator counted 0.25
   *  of a second per frame instead of 0.59 and stretched every timer by 2.4x. */
  let liveSeconds = 0;

  /** Recomputed once per delivered frame from the window. No allocation. */
  let wallMean = 0;
  let wallWorst = 0;
  let wallBest = 0;
  let workMean = 0;
  let lateFrac = 0;

  // ── the CPU half of the frame, for the budget gate ────────────────────────
  //
  // Separate from `work` above, and deliberately: that ring is the *governor's*
  // evidence and it discards every frame the harness drove, which is every
  // frame a capture ever produces. This one takes every rendered frame there
  // is, because the question it answers — "does the simulation plus the visual
  // update fit inside a 60fps frame" — is a question about the game rather than
  // about the machine's frame rate, and a bench is exactly where it gets asked.
  //
  // Normalised per fixed step. See `STEPS_AT_60` and `CPU_WINDOW`.
  const cpuRing = new Float64Array(CPU_WINDOW);
  const cpuSorted = new Float64Array(CPU_WINDOW);
  let cpuIdx = 0;
  let cpuCount = 0;
  let cpuSimRing = 0;
  let cpuUpdRing = 0;

  /** One sample, from the frame that has just been drawn. Allocation-free. */
  function sampleCpu(): void {
    const b = ctx.budget;
    if (!b) return;
    // `engine.ts` caps the accumulator at eight steps per frame, so on a
    // machine in slow motion this is 8 and the division is what makes the
    // reading mean the same thing there as it does at 60fps.
    const steps = b.steps > 0 ? b.steps : 1;
    const sim = (b.simMs / steps) * STEPS_AT_60;
    cpuSimRing = sim;
    cpuUpdRing = b.updateMs;
    cpuRing[cpuIdx] = sim + b.updateMs;
    cpuIdx = (cpuIdx + 1) % CPU_WINDOW;
    if (cpuCount < CPU_WINDOW) cpuCount++;
  }

  /** Median of the CPU ring. Hand-called from `gate()`/`probe()` only, so the
   *  sort is free; the scratch is owned so it allocates nothing anyway. */
  function cpuMedian(): number {
    const n = cpuCount;
    if (n === 0) return 0;
    for (let i = 0; i < n; i++) cpuSorted[i] = cpuRing[i]!;
    for (let i = 1; i < n; i++) {
      const v = cpuSorted[i]!;
      let j = i - 1;
      while (j >= 0 && cpuSorted[j]! > v) { cpuSorted[j + 1] = cpuSorted[j]!; j--; }
      cpuSorted[j + 1] = v;
    }
    const h = n >> 1;
    return (n & 1) === 1 ? cpuSorted[h]! : (cpuSorted[h - 1]! + cpuSorted[h]!) / 2;
  }

  // ── the robust statistic, for the one comparison that needs one ───────────
  //
  // Only the futility verdict reads these, and only at the two moments it takes
  // a measurement, so they are computed on demand rather than per frame — an
  // insertion sort of sixty-four floats twice over is nothing once a rung, and
  // would be real work every frame on the machine least able to afford it.
  /** Sorting scratch. Owned, so a verdict allocates nothing either. */
  const sorted = new Float32Array(WALL_WINDOW);
  /** Written by `measureWindow()`. Two returns without an object to hold them. */
  let wallMedian = 0;
  let wallMad = 0;

  /** In-place insertion sort of the first `n` of `sorted`. */
  function sortRun(n: number): void {
    for (let i = 1; i < n; i++) {
      const v = sorted[i]!;
      let j = i - 1;
      while (j >= 0 && sorted[j]! > v) { sorted[j + 1] = sorted[j]!; j--; }
      sorted[j + 1] = v;
    }
  }

  /** Median of the sorted run. */
  function middle(n: number): number {
    if (n <= 0) return 0;
    const h = n >> 1;
    return (n & 1) === 1 ? sorted[h]! : (sorted[h - 1]! + sorted[h]!) / 2;
  }

  /** Median and median-absolute-deviation of the wall window, into the two
   *  fields above. */
  function measureWindow(): void {
    const n = wallCount;
    if (n <= 0) { wallMedian = 0; wallMad = 0; return; }
    for (let i = 0; i < n; i++) sorted[i] = wall[i]!;
    sortRun(n);
    wallMedian = middle(n);
    for (let i = 0; i < n; i++) sorted[i] = Math.abs(wall[i]! - wallMedian);
    sortRun(n);
    wallMad = middle(n);
  }

  /** Standard error of a median drawn from a window with this spread. */
  function medianSe(mad: number, n: number): number {
    if (n <= 0) return Infinity;
    return (MEDIAN_SE * MAD_SIGMA * mad) / Math.sqrt(n);
  }

  // ── the session's own ring, which nothing clears ─────────────────────────
  //
  // See `SESSION_WINDOW`. One store a frame, no allocation, and it spans the
  // changes — which is the whole reason it exists, because the only honest
  // denominator for "what did the governor's own worst frame cost" is a typical
  // frame of the *session*, and every other statistic here is reset by the very
  // event being judged.
  const session = new Float32Array(SESSION_WINDOW);
  const sessionSorted = new Float32Array(SESSION_WINDOW);
  let sessionIdx = 0;
  let sessionCount = 0;

  /** Worst frame the session delivered outside the governor's own windows. */
  function sessionWorst(): number {
    let w = 0;
    for (let i = 0; i < sessionCount; i++) if (session[i]! > w) w = session[i]!;
    return w;
  }

  /** Median of the session ring. Hand-called from `probe()` only. */
  function sessionMedian(): number {
    const n = sessionCount;
    if (n <= 0) return 0;
    for (let i = 0; i < n; i++) sessionSorted[i] = session[i]!;
    for (let i = 1; i < n; i++) {
      const v = sessionSorted[i]!;
      let j = i - 1;
      while (j >= 0 && sessionSorted[j]! > v) { sessionSorted[j + 1] = sessionSorted[j]!; j--; }
      sessionSorted[j + 1] = v;
    }
    const h = n >> 1;
    return (n & 1) === 1 ? sessionSorted[h]! : (sessionSorted[h - 1]! + sessionSorted[h]!) / 2;
  }

  /** Seconds over budget / under it. One of the two is always zero. */
  let overFor = 0;
  let underFor = 0;
  let panicFor = 0;
  /** ...and the collapse path's own pair. See `COLLAPSE_DWELL`. */
  let collapseFor = 0;
  let collapseFrames = 0;
  let settleFor = SETTLE;
  /**
   * ...and the same three in **delivered frames**, which is the unit the whole
   * of this round was about.
   *
   * A wall second is 60 frames on a machine that is fine and two thirds of one
   * on a machine at 0.7fps, so a dwell counted only in seconds guarantees
   * nothing at all on the machine it exists for. Both have to be satisfied; see
   * the block on `DOWN_DWELL`.
   */
  let overFrames = 0;
  let underFrames = 0;
  let panicFrames = 0;
  let settleFrames = SETTLE_FRAMES;
  /** -1 until the first frame we observe, so boot's own primed frame is free. */
  let benchFrames = -1;
  let benchQuietFor = 0;
  /** Latched: this page is a bench, and nothing it measures is about a player. */
  let benched = false;
  let holding = 'settling';

  // ── did the last cut buy anything ────────────────────────────────────────
  /** The frame's *median* wall cost immediately before the last drop. */
  let wallBefore = 0;
  /** ...and the standard error of that median, so the verdict knows how much
   *  of the difference it is about to measure could be the window itself. */
  let seBefore = 0;
  let verdictPending = false;
  /** Delivered frames since the cut being judged. The abandon deadline counts
   *  these, not seconds — see `VERDICT_ABANDON_FRAMES`. */
  let verdictFrames = 0;
  let futile = 0;
  let stalled = false;
  /** The wall cost when the governor gave up, so it can notice things changing.
   *  In *mean* units, because the retry test below reads the mean every frame
   *  and comparing a median against a mean is not a comparison. */
  let stalledAt = 0;

  // ── the climb's own memory ───────────────────────────────────────────────
  /**
   * The best rung a **multi-rung** climb may reach. See `sizedClimb`.
   *
   * Zero means nothing has been disproved and the whole ladder is available in
   * one change; anything above it is a rung a climb was punished at, and above
   * *that* the ladder is walked one rung at a time exactly as it always was.
   * Kept across `reset()` for the same reason `index` is: a machine did not
   * become faster because a race restarted.
   */
  let sprintFloor = 0;
  /** `liveSeconds` at the last climb, and whether that climb is still on trial.
   *  A drop inside `CLIMB_PUNISH_S` convicts it; surviving the window acquits
   *  it and relaxes `sprintFloor` by one. */
  let climbAt = -Infinity;
  let climbOnTrial = false;
  /** How many rungs the last climb asked for, for the log and the probe. */
  let lastClimbStep = 0;

  // ── the moment gate ──────────────────────────────────────────────────────
  /**
   * The front-end has a screen up, and the game is paused.
   *
   * Both are taken from the **edges** the owning modules publish — `ui:menu`
   * and `race:pause` — because neither can be read off `ctx.race` at all.
   * ARCHITECTURE §11a: the race is built at boot and keeps simulating behind an
   * opaque title screen, so `race.phase` walks `intro` → `countdown` →
   * `racing` while the player is still choosing a machine, and `phase ===
   * 'loading'` means the boot *or* the pause screen with no way to tell which.
   * `race/director.ts` has stood off these edges since it was written; this
   * file asked the director what was on screen instead and was told about a
   * race nobody could see.
   */
  let frontEndOpen = false;
  let paused = false;
  /**
   * `ctx.time.elapsed` — the fixed-step clock — at the frame the flag fell.
   *
   * Latched on the `race:racing` edge rather than derived from `ctx.race.time`,
   * which a seek leaves running from the previous race. `-Infinity` until a
   * flag has actually fallen, so the grace is open before the first one and the
   * intro and countdown gates carry that stretch on their own.
   */
  let flagAt = -Infinity;
  /** Seconds on the fixed-step clock since the flag, or **-1** if no flag has
   *  fallen this session. -1 rather than an infinity because this is reported
   *  through `probe()` and a log entry, both of which are read as JSON, and
   *  `JSON.stringify(Infinity)` is `null` — a reviewer's check for "was this
   *  change inside the grace" would then compare against a null and answer
   *  yes. A gate whose evidence serialises to a falsehood is not evidence. */
  const sinceFlag = (): number =>
    (flagAt === -Infinity ? -1 : +(ctx.time.elapsed - flagAt).toFixed(2));
  /**
   * ...and the same stretch in **wall seconds of delivered play**, which is the
   * unit `LAUNCH_PATIENCE` is denominated in.
   *
   * Two clocks for one beat, on purpose. `sinceFlag` is what the gate is *for*
   * — a gesture of the game, three fixed-step seconds long at every frame rate
   * — and this is what the gate *costs*, which is a different question with a
   * different answer the moment `engine.ts`'s eight-step cap starts binding.
   * Keeping only the first is how this file has twice shipped a refusal nobody
   * had converted into what a person waits.
   */
  let flagFor = 0;
  /**
   * Seconds of delivered play spent inside **this** composed beat.
   *
   * Zero while the game is being played, and zero behind the front-end — a
   * sweep nobody can see is not a sweep anybody is waiting out. The two
   * ceremony valves read it.
   *
   * It is scoped to one beat rather than to "composed-ness" as a whole, and
   * that matters: the intro runs straight into the countdown, so a single
   * accumulator would let a sweep that had already spent its twenty seconds
   * hand the countdown a valve that was open on arrival. Each beat waits out
   * its own patience. `ceremonyPhase` is what it was last counting.
   */
  let ceremonyFor = 0;
  let ceremonyPhase = '';
  /**
   * ...and the same clock for the front-end, which is not a phase and cannot
   * share one. See `FRONT_END_PATIENCE`.
   */
  let frontEndFor = 0;
  /**
   * The front-end is covering the whole frame with its own opaque set, so the
   * race behind it is pure wasted fill. Published to `budget.skipDraw`, which
   * `engine.ts` reads immediately before the draw.
   *
   * ── What decides it, and why it is three facts and not one ────────────────
   *
   * **`ui:menu`** is the authority on whether the front-end is up: it is the
   * edge the module that owns the screen publishes, and ARCHITECTURE §11a says
   * in as many words that nothing else can answer the question.
   *
   * **`reset()`** takes it back. `ui:menu {open:false}` fires at the *end* of
   * the hand-off, not the start: the launch board closes over the menus, the
   * race is built, the board swings open again onto the race, and only then is
   * the front-end declared closed. For the length of that swing the front-end
   * is still open on the wire and the race behind it is the picture. Building
   * the race is the last thing that happens before the reveal, so the reset is
   * the earliest honest signal that the menu is about to stop covering
   * anything — and it is a whole beat early, which is the right direction to
   * be wrong in.
   *
   * **A stage canvas that exists and is opaque** is the belt to that brace.
   * `createStage()` can return null on a machine that will not give the
   * front-end its own WebGL context, and the menus fade their whole backdrop —
   * the stage canvas included — to zero opacity the moment they start handing
   * over. Reading that one inline style costs a property read per frame, forces
   * no layout, and means the very worst this can do is draw a frame nobody
   * needed rather than blank a frame somebody did.
   */
  let frontEndCovers = false;
  /** The front-end's own backdrop canvas, looked up once per open edge. Null
   *  when the front-end is down or has no set of its own to hide behind. */
  let stageEl: HTMLElement | null = null;
  /** A race has been built since the front-end came up, so the hand-off is
   *  under way and the reveal is imminent. */
  let handingOver = false;

  // ── the cost of the governor's own action ────────────────────────────────
  /** Worst delivered frame among the `SKIP_FRAMES` discarded after a change. */
  let changeCost = 0;
  /** ...that number for the most recent completed change, and the worst of the
   *  session. Both in wall milliseconds; 0 before the first change. */
  let lastChangeMs = 0;
  let changeWorst = 0;
  /** ...and the worst of them **relative to a typical frame at the time**,
   *  which is the reading that does not move when the ladder works. See
   *  `QualityChange.changeRatio`. */
  let changeWorstRatio = 0;
  /** The log entry still being measured into, or null. Never allocated here —
   *  it is the entry `applyRung` already pushed. */
  let changeEntry: QualityChange | null = null;
  /**
   * ...and whether anything that is not this machine ran inside that entry's
   * measurement window: a suspension, a harness step, or a hand call into
   * `__QUALITY`. A spoiled window produces no number at all rather than a
   * number made of somebody else's work — see the recording site and
   * `externalTouch`.
   */
  let changeSpoiled = false;

  const log: QualityChange[] = [];
  const verdicts: QualityVerdict[] = [];

  // ── the content pass ──────────────────────────────────────────────────────
  //
  // The half of the ladder that takes things out of the frame rather than
  // pixels off the picture. See `ContentTrim`.
  //
  // Everything here is a *visual* write — `visible`, `InstancedMesh.count`,
  // `BufferGeometry.drawRange` — made from `update()` at order 95, after every
  // system that owns those flags has had its say and before the draw. Nothing
  // in `fixedUpdate` anywhere in the game reads any of them, which is what
  // keeps "the same seed puts every racer in the same place at every rung" a
  // property of the design; `tools/qualitydiff.mjs` proves it at both ends of
  // the ladder and the content rungs are inside that proof.

  /** A crowd geometry, and where its people start. See `ContentTrim.crowd`. */
  interface CrowdGeo {
    geo: THREE.BufferGeometry;
    /** Indices in the whole thing. */
    full: number;
    /**
     * ...and the prefix that is *not* people and may never be trimmed.
     *
     * Found from the geometry rather than from a name: `world/kit.ts` writes an
     * `aAmp` of zero on anything that does not move and a positive one on every
     * box of every spectator, because that is what the crowd material's vertex
     * program bobs. So the largest suffix of the index buffer whose vertices
     * are all animated is exactly "the people", whatever the stand around them
     * is made of, and trimming into the head — which would start deleting the
     * terracing out from under them — is arithmetically impossible rather than
     * merely discouraged.
     */
    head: number;
    /** What is currently drawn, so a re-apply with the same trim is free. */
    at: number;
  }
  /**
   * An instanced batch small enough and numerous enough to thin.
   *
   * Carries its own placement as well as its count, because the ramp in
   * `contentFrame` asks the same question of it that the cull asks of a
   * `Cullable` — how big is one of these on screen from here — and a batch is in
   * both lists. Two floats and a cached radius against a second walk of the
   * scene graph every frame.
   */
  interface ScatterBatch {
    mesh: THREE.InstancedMesh;
    full: number;
    cx: number; cy: number; cz: number;
    /** The whole batch, so the *near edge* is what the ramp is judged on. */
    radius: number;
    /** ...and one instance, which is the thing an eye has to resolve. */
    item: number;
    /** What `count` is currently set to, so an unchanged frame writes nothing. */
    at: number;
  }
  /**
   * Anything the screen-size test may switch off, with the two radii it needs.
   *
   * `radius` is the whole batch, used to take the *near edge* of it, so a
   * sector of verge running past the camera is never culled for the sake of its
   * far end. `item` is one instance, which is the thing an eye actually has to
   * resolve — a batch of two hundred traffic cones is three hundred metres
   * across and every cone in it is sixty centimetres.
   */
  interface Cullable {
    node: THREE.Object3D;
    cx: number; cy: number; cz: number;
    radius: number;
    item: number;
    hidden: boolean;
  }
  /**
   * A racer's merged shell: the same geometry and the same materials, baked
   * into one mesh per material, standing still.
   *
   * ── Why this is the safest cut on the ladder ───────────────────────────────
   *
   * It is the only one that is *pixel-identical* to what it replaces. The
   * shell is built from the machine's own meshes, in the machine's own
   * materials, at the transforms they were sitting at — so the only thing it
   * gives up is that the wheels stop turning and the body stops leaning. At the
   * first content rung's `shellPx` of 18 that happens at thirty-six metres,
   * where a machine is twenty-eight pixels across and its wheel is seven, with
   * sub-pixel tread lugs; there is no rotation left to see.
   *
   * What it buys is the number the review named: **the seven racers are 745 of
   * the frame's 1045 audited draw calls for 4% of its triangles**, across 187
   * separate meshes. `mat()` in `vehicles/parts.ts` already caches by colour and
   * options, so the seventy-five materials really are seventy-five different
   * paints and no merge can go below them — but twenty-six meshes a machine
   * can, and does, become about eleven.
   *
   * The shadow pass is the other half and it has to be built the other way
   * round, or a merge that halves the colour pass doubles the shadow one: the
   * part ladder in `vehicles/index.ts` has already stopped almost everything
   * casting by this distance, so a shell whose eleven meshes all cast would be
   * a regression. Only the largest bucket casts — the body — which is the mesh
   * the dark shape under a kart is made of anyway.
   */
  interface Shell {
    /** The merged group, parented under the racer's own root. */
    group: THREE.Object3D;
    /** Root's own children, which the shell stands in for. */
    hides: THREE.Object3D[];
    /** ...and what each of them was showing when the shell took over. */
    was: boolean[];
    on: boolean;
  }

  const crowdGeos: CrowdGeo[] = [];
  const scatter: ScatterBatch[] = [];
  const cullables: Cullable[] = [];
  const shells = new Map<number, Shell>();
  /** What the content pass has been asked for. Never null — rung 0 is `FULL`. */
  let content: ContentTrim = FULL_CONTENT;
  /**
   * ...and what the **populations** are actually set to, which between seams is
   * a different rung's answer. See `SEAM_HELD`.
   *
   * `content` is the standing rung's whole trim and is what the per-frame pass
   * reads; this is the crowd and scatter shares that are physically installed on
   * the geometry, and it only ever moves in `applySeamContent`.
   */
  let seamContent: ContentTrim = FULL_CONTENT;
  /** The track the census was taken on, so it is taken once per course. */
  let censusFor = '';
  /** Counters for the probe, so a content rung that quietly matched nothing is
   *  visible as a zero rather than as a rung that did not work. */
  let contentCrowd = 0;
  let contentScatter = 0;
  let contentCullable = 0;
  let contentShells = 0;
  /** Batches the screen-size test is holding off, and racers on their shells,
   *  this frame. The two numbers a review reads to see the rung working. */
  let culledNow = 0;
  let shelledNow = 0;
  /** ...and batches the distance ramp has thinned below the standing share.
   *  Zero at rung 0, and zero on a rung whose census found no scatter. */
  let thinnedNow = 0;
  /**
   * Frames on which every shell is drawn whether it is wanted or not.
   *
   * A shell's first draw uploads its merged buffers, and under a software
   * rasteriser that is not free: measured on a frozen 1600x900 bench, the
   * frame that first switched five machines to their shells took **5.07
   * seconds** against a 1.1s steady frame, and the same switch on the next pass
   * — buffers already resident — cost nothing measurable. A governor whose
   * rescue move is a five-second freeze is the exact failure `precompileLadder`
   * exists to prevent, one layer down.
   *
   * So the upload is moved to the one frame that is already a load: `main.ts`
   * renders once immediately after `resetAll` to prime shaders (see the note
   * beside that call), and this makes that frame draw every shell alongside
   * every machine. It costs one doubled field on a frame nobody sees, behind
   * the launch board, and it buys back the freeze.
   */
  let primeShells = 0;

  // Scratch. The content pass runs every rendered frame over a hundred-odd
  // batches and eight racers and must not allocate a byte doing it.
  const _cam = new ctx.THREE.Vector3();
  const _wp = new ctx.THREE.Vector3();

  // Our own sample buffers. `track.sample()` and `spline.atDistance()` both
  // hand back a shared scratch when none is supplied, and the camera and the
  // contact pass are reading theirs in the same frame — see the note in
  // render/contact.ts. Nothing here allocates after init.
  let here: SplineSample | null = null;
  let ahead: SplineSample | null = null;

  /** The device ratio the display actually has, before any scaling of ours. */
  function baseRatio(): number {
    return Math.min(globalThis.devicePixelRatio || 1, 2);
  }

  /** The drawing buffer, in device pixels. Reported, not acted on. */
  const _buf = { x: 0, y: 0 };
  function bufSize(): { x: number; y: number } {
    const c = ctx.renderer?.domElement;
    _buf.x = c ? c.width : 0;
    _buf.y = c ? c.height : 0;
    return _buf;
  }
  function bufW(): number { return bufSize().x; }
  function bufH(): number { return bufSize().y; }

  /**
   * Where the frame went, once the wall clock has already said it was late.
   *
   * Work that accounts for most of the frame means the CPU is the bottleneck
   * and says which half of it. Work far below the frame means the cost is
   * downstream of the last instruction we can time: the GPU, or the wait for
   * the display. The two are indistinguishable from inside the page — a
   * `render()` that returns in 8ms tells you nothing about whether the driver
   * then spent 240ms on it — so the label leans on whether the frame is late:
   * an idle frame arriving on time is vsync, an idle frame arriving late is the
   * GPU.
   */
  function boundBy(b: FrameBudget): string {
    if (wallMean <= 0) return '';
    if (workMean > wallMean * 0.66) {
      return b.meanSimMs > b.meanDrawMs ? 'sim' : 'draw';
    }
    return wallMean > TARGET_MS * UP_FACTOR ? 'gpu' : 'vsync';
  }

  /**
   * A composer that can move the render resolution without rebuilding the swap
   * chain.
   *
   * The contract, in one optional method: `setRenderScale(s)` draws the world
   * into targets the post stack owns at `s` of their size and resolves back to a
   * canvas that never moves. `render/post.ts` implements it — three
   * `WebGLRenderTarget.setSize` calls and one extra blit when antialiasing is
   * off — against `renderer.setPixelRatio`, which rebuilds the drawing buffer
   * and was measured at +348ms on a 320x180 bench and **3101ms live at
   * 1280x720**, and which also resizes the canvas underneath a DOM HUD that
   * stays at native resolution.
   *
   * **This is what took `scale` off the seam.** The lever was deferred because
   * moving it cost the worst frame of the session and announced itself against
   * a pixel-sharp HUD; neither is true through this path, and what is left — a
   * slightly softer picture — is a smaller change than the rung it arrives with.
   *
   * Probed on every call rather than latched at boot, because `ctx.composer` is
   * installed by `render/` after this system is constructed and may be replaced
   * when the post stack is rebuilt. A capability that has to be announced
   * through a flag is a capability two modules can disagree about; a method
   * either exists or it does not — and if it ever does not, `applyScale` falls
   * straight back to the round-six behaviour and the lever goes back behind the
   * seam with nothing else in this file changing.
   */
  interface ScalableComposer { setRenderScale?(scale: number): unknown }
  function freeScalePath(): ScalableComposer | null {
    const c = ctx.composer as unknown as ScalableComposer | null;
    return c && typeof c.setRenderScale === 'function' ? c : null;
  }

  // ── the other half of the frame, and what round eleven took out of it ───
  //
  // The render scale governs the *3D* and the 3D is not the whole picture: the
  // HUD, the race's plates, the coach card and the item socket are DOM, drawn
  // by the browser at the display's own resolution, and they do not move when
  // the world does. Round nine closed that seam by publishing the upscale as a
  // CSS blur on the instrument set. Round ten reversed it — correctly, and it
  // is visible in the frames: the world's mean gradient falls monotonically
  // across the rungs while the HUD's holds at 5.09 → 4.90, which is what every
  // shipping game with dynamic resolution does and what MK8D does in
  // split-screen.
  //
  // What round ten left behind was the apparatus: a stylesheet injection, an
  // `mc-soft` body class, a `--mc-soften` custom property, a `[data-soften]`
  // opt-in door and a call on every ramp step and every seam — about a hundred
  // and forty lines driving, as `probe()` said out loud, `soften: 1.00,
  // softenLayers: 0`. **Nothing in the product had ever marked an element.**
  // ARCHITECTURE §7 is unambiguous about the shape of that bug in the other
  // direction ("an event with no listener is a bug, not a feature") and it does
  // not stop being one because the channel is a stylesheet rather than a bus.
  //
  // It is gone rather than kept warm for a rear-view inset that does not exist.
  // The seam it was closing is closed the other way and the argument for that
  // is in `SEAM_HELD` under `scale`; whoever builds a DOM layer that is
  // genuinely a picture of the world can publish `liveScale` to it in ten lines
  // and will want them written against whatever that layer turns out to be.

  /** What the ladder wants the 3D drawn at. */
  let wantScale = 1;
  /** ...and what it is *actually* being drawn at, which between seams is not
   *  the same number. */
  let liveScale = 1;
  /** How many times the drawing buffer has been rebuilt for a scale change,
   *  and where. Reported, because "the ladder moved eleven rungs and rebuilt
   *  the swap chain twice" is the sentence round six was about. Through the
   *  free path this stays at zero for the life of the session. */
  let scaleFlushes = 0;
  /** ...and how many times the lever has landed at all, free path included. */
  let scaleSteps = 0;
  let lastFlushWhy = '';
  /** `liveSeconds` at the last landing, for the rate limit. */
  let lastScaleAt = -Infinity;

  /**
   * Ask for a render resolution. **Never rebuilds the swap chain.**
   *
   * With a composer that can move it for free (`freeScalePath`), the request is
   * serviced on the spot, subject only to `SCALE_HOLD_S` — see `serviceScale`.
   * Without one, the request is *recorded* and the drawing buffer catches up at
   * the next seam, which is the round-six behaviour: `setPixelRatio` is a
   * swap-chain rebuild, a swap-chain rebuild is a three-second frame under a
   * software rasteriser, and a three-second frame is the worst thing the player
   * will see all session. It is also why the DOM HUD and the 3D used to come
   * apart: shrinking the canvas under a fixed-size overlay leaves a pixel-sharp
   * place badge against a half-resolution road in the same frame. Neither
   * applies to the free path, where the canvas never moves at all.
   */
  function applyScale(scale: number): void {
    wantScale = scale;
    // **Recorded, not serviced.** The travelling is `serviceScale`'s, once per
    // delivered frame, because the lever is a ramp now and a ramp needs frames
    // to run across — see `SCALE_RAMP`. The callers that must have the whole
    // thing immediately are the ones that are not a player watching a race, and
    // they say so by calling `flushScale` on the next line: a seam, a bench, a
    // reviewer pinning a rung.
  }

  /** True while the render scale is easing toward a target it has not reached.
   *  Nothing decides anything on the strength of it; it is what keeps
   *  `SCALE_HOLD_S` gating the *start* of a traverse rather than every step. */
  let ramping = false;
  /** Frames the ramp has spent travelling this session, and the traverses it
   *  has completed. Reported so a review can tell a dissolve from a cut without
   *  filming one. */
  let rampFrames = 0;

  /**
   * Ease the render resolution toward whatever the ladder last asked for.
   *
   * Called once per delivered frame with the wall gap that frame took, so a
   * request the rate limit refused is never simply forgotten and a request it
   * allowed arrives as a dissolve rather than as a cut. Does nothing at all
   * without a free path — there the seam is still the only door.
   *
   * Two gates, and they gate different things:
   *
   *   `SCALE_HOLD_S` gates the **start** of a traverse. It is the whole of the
   *   mid-race safety argument and it is one line rather than a moment gate
   *   because the caller is already gated: a rung change went through
   *   `pictureLocked()` and `onAStraight()` before it got here. What it adds is
   *   a floor on how often the picture may change size regardless of how fast
   *   the ladder is moving — a panic pop that reaches the floor in one step
   *   travels once, not six times.
   *
   *   `SCALE_RAMP` paces the **steps** of one. Deliberately not subject to the
   *   hold: a ramp that had to wait two seconds between its own frames would be
   *   a slideshow of intermediate resolutions, which is worse than the cut it
   *   replaces.
   */
  function serviceScale(gapMs: number): void {
    if (!freeScalePath()) return;
    if (Math.abs(liveScale - wantScale) < SCALE_EPS) { ramping = false; return; }
    if (!ramping) {
      if (liveSeconds - lastScaleAt < SCALE_HOLD_S) return;
      ramping = true;
    }
    stepScale(gapMs);
  }

  /**
   * One frame of the ramp.
   *
   * The step is `SCALE_RAMP` scaled by how long the last delivered frame
   * actually took, which is what makes the same constant mean "a quarter of a
   * second" on a machine at 60fps and "get on with it" on one at 0.7 — see
   * `SCALE_RAMP` for why that is the right shape rather than a compromise.
   *
   * A gap of zero is a frame this file was not allowed to count: the page was
   * hidden, the harness drove it, the draw was skipped. It is worth exactly one
   * 60Hz step, so a page that only ever produces those still arrives eventually
   * and never arrives in a jump.
   */
  function stepScale(gapMs: number): void {
    const free = freeScalePath();
    if (!free) return;
    const pace = gapMs > 0 ? Math.max(1, gapMs / SCALE_RAMP_MS) : 1;
    const step = SCALE_RAMP * pace;
    const delta = wantScale - liveScale;
    const next = Math.abs(delta) <= step
      ? wantScale
      : liveScale + (delta > 0 ? step : -step);
    free.setRenderScale!(next);
    liveScale = next;
    rampFrames++;
    // The DOM travels with it, every step, or the world dissolves under a HUD
    // that snaps at the end — which is the same seam one frame wide.
    if (Math.abs(liveScale - wantScale) < SCALE_EPS) {
      // Arrived. Everything a landing owes the rest of the file is owed once,
      // at the end, rather than thirteen times on the way: one `quality:changed`
      // for the listeners that size themselves off it, one cleared window, one
      // entry in the rate limit.
      landScale('live', true);
    } else {
      // Mid-traverse the only thing that has to be true is that `stats()` is not
      // lying about the resolution a reviewer is looking at.
      publish();
    }
  }

  /**
   * Book a completed traverse: the bookkeeping every landing owes, by either
   * path, exactly once.
   *
   * `own` is "this landing is part of the rung change currently being measured"
   * — the governor's own ramp arriving, or the collapse path landing its own
   * seam. It keeps the change entry alive across the clear, because the traverse
   * *is* the change and the frames it costs are the frames `changeMs` exists to
   * count. Everything else — a bench, a pin, a resize, a race build — is
   * somebody else's reallocation landing inside our window, and is dropped
   * rather than charged. See `clearStats`.
   */
  function landScale(why: string, own: boolean): void {
    ramping = false;
    scaleSteps++;
    lastScaleAt = liveSeconds;
    lastFlushWhy = why;
    // The frames before this one were drawn at a different resolution, so the
    // window is about to compare two different games.
    if (own) clearStats(); else clearWindow();
    ctx.bus.emit('quality:changed', {
      quality: ctx.quality, scale: liveScale, rung: index, label: LADDER[index]?.label ?? '',
    });
    publish();
  }

  /**
   * Move the render resolution to whatever the ladder last asked for.
   *
   * Two paths, and which one the game is on is a property of the composer
   * rather than a setting:
   *
   *   **the free path** — `render/post.ts` resizes the targets it owns and the
   *   canvas never moves. Called from `serviceScale` on any frame, subject to
   *   the rate limit; the seams below call it too and it is simply already
   *   current by the time they do.
   *
   *   **the fallback** — `renderer.setPixelRatio`, which rebuilds the drawing
   *   buffer. Only ever reached at a seam, and there are exactly three of those,
   *   named at their call sites: boot, a race build behind the closed launch
   *   board, and a window resize the browser is already reallocating for.
   *
   * Returns true if it actually moved something, so the caller can decide
   * whether the window it is about to take is worth anything.
   */
  function flushScale(why: string): boolean {
    if (liveScale > wantScale - SCALE_EPS && liveScale < wantScale + SCALE_EPS) {
      ramping = false;
      return false;
    }
    const free = freeScalePath();
    if (free) {
      free.setRenderScale!(wantScale);
      liveScale = wantScale;
      // Everything the fallback path says below applies here too — the only
      // difference is the cost of the frame that does it.
      landScale(why, false);
      return true;
    }
    const want = baseRatio() * wantScale;
    const have = ctx.renderer.getPixelRatio();
    if (have > want - 1e-3 && have < want + 1e-3) {
      liveScale = wantScale;
      ramping = false;
      return false;
    }
    ctx.renderer.setPixelRatio(want);
    liveScale = wantScale;
    scaleFlushes++;
    // Everything in the window was measured at a different resolution, and the
    // frames immediately after this one are the reallocation rather than the
    // game. This path is a *seam* flush — a bench, a pin, a resize, a race
    // build — so it drops the change entry rather than charging its swap-chain
    // rebuild to whatever rung change happened to be open. The governor's own
    // ramp arriving is the other case and keeps it; see `landScale`.
    //
    // ...and `landScale` emits `quality:changed`, so that `ui/menus/stage.ts` —
    // the one other renderer in the product, and the one this file only half
    // owns the frame of — can size its own backing store off the scale that is
    // now real. Existing listeners destructure `quality`, which has not changed,
    // and are unaffected.
    landScale(why, false);
    return true;
  }

  /**
   * Bring **everything** the seam holds to whatever rung the ladder has earned.
   *
   * `flushScale` is the buffer half of this and is still called directly by the
   * one caller that must not move anything else (`dispose`, which is handing the
   * frame back rather than installing a rung). Every other seam goes through
   * here, and the three of them are named at their call sites: boot, a race
   * build behind the closed launch board, and a window resize.
   *
   * Reads as three lines because that is all the seam rule is: catch the
   * seam-held settings up (`aa`, `tier`, `drawDistance`), catch the populations
   * up (`crowd`, `scatter`), and let the drawing buffer follow. What makes it
   * correct is not this function, it is that nothing else in the file may call
   * any of the three.
   */
  function flushSeam(why: string): boolean {
    const moved = seamIndex !== index;
    seamIndex = index;
    if (moved) installSettings();
    applySeamContent(LADDER[seamIndex]!.content);
    if (moved) {
      // ── the futility verdict does not survive a seam ────────────────────
      //
      // Same rule the `ui:menu` edges already obey and the same one sentence
      // behind it: **a verdict belongs to the scene it was measured on.** Every
      // judgement taken since the last seam was taken on rungs whose expensive
      // half had not been installed yet, so "cutting does not help this machine"
      // was a statement about a cut that was only half made. This line has just
      // made the other half. Whatever the ladder concluded before it is about a
      // picture that no longer exists.
      //
      // Without this the design has a real hole rather than a theoretical one: a
      // machine whose frame-half is worth three percent takes two `futile`
      // strikes, stands the ladder down at rung 2, and never reaches the rungs
      // that would have saved it — while the seam quietly installs rung 2's
      // resolution and crowd and proves nothing either way. The *rung* carries
      // across a seam, because that is a statement about the machine; the
      // verdict about whether this ladder's levers reach does not.
      abandonVerdict();
      stalled = false;
      futile = 0;
    }
    const flushed = flushScale(why);
    // `flushScale` publishes its own edge when it moves the buffer. When it does
    // not — the scale was already right, or a composer moved it for free — a
    // seam that changed `aa` or the tier still has to say so, because
    // `ui/menus/stage.ts` sizes its own set off this event.
    if (moved && !flushed) {
      ctx.bus.emit('quality:changed', {
        quality: ctx.quality, scale: liveScale, rung: index, label: LADDER[index]?.label ?? '',
      });
      publish();
    }
    return flushed || moved;
  }

  /**
   * The fourth door, and the only one that opens **while the player is
   * driving**: a picture that has already collapsed.
   *
   * ── What it fixes ──────────────────────────────────────────────────────────
   *
   * A live 199-second race at 1280x720 under SwiftShader: one governor action,
   * rung 0 to rung 6, 0.38 race-seconds after the flag, `collapsed (124x
   * budget)`. For the remaining 198.6 seconds the probe read `seamRung: 0` and
   * `pending: 'crowd,aa,drawDistance'`. The player rode a whole race at a
   * quarter of the pixels **while still paying for the full grandstand, the full
   * FXAA resolve and the full draw distance**, because the only seam that could
   * have installed them was the next race build. The rescue the governor
   * ordered never arrived; three of the ladder's seven levers were, by design,
   * unreachable inside a race.
   *
   * Measured on a real racing frame at 1280x720 — the pack still on screen, 1.5
   * race-seconds after the flag — that deferral is not a rounding error:
   *
   *   rung 0                       856,100 tris   523 calls
   *   rung 6, frame-half only      822,680        484      -3.9%
   *   rung 6, whole rung           722,629        497     -15.6%
   *
   * The seam is holding **100,051 triangles**, 11.7% of the frame, on a machine
   * the governor has just judged to be a hundred times over its budget.
   *
   * ── Why it is not a hole in the seam rule ──────────────────────────────────
   *
   * The seam rule protects **continuity**: a lever is seam-held when the change
   * itself can be *watched happening*, which requires a before-frame and an
   * after-frame close enough in time and in viewpoint that the eye binds them
   * into one moving scene. That is a property of the frame rate, not of the
   * lever. At `COLLAPSE_FACTOR` the frames are at least 83ms apart; in the
   * session above they were **2,062ms** apart, with the camera travelling
   * thirty metres a second — sixty metres of world between one picture and the
   * next. There is no continuity there for a pop to violate. "The grandstand's
   * back rows went between two frames" is a defect at 60fps and is not a
   * sentence that means anything at 0.5.
   *
   * It is the same argument the collapse path already makes about
   * `pictureLocked()` — *a machine five times over the budget has no composed
   * picture to protect* — pointed at the other half of the rung. Round eight
   * made the first half of that argument and stopped one function short of it.
   *
   * ── Why it is not simply `flushSeam` ───────────────────────────────────────
   *
   * Two things `flushSeam` does are wrong here, and both were found by writing
   * it that way first:
   *
   *   It flushes the **resolution**, which turns the ramp into a cut. The ramp
   *   is already degenerate at 0.5fps (see `SCALE_RAMP`) but is three frames of
   *   dissolve at the 12fps end of the collapse band, and there is no reason to
   *   spend that. The scale stays on `serviceScale`.
   *
   *   It **abandons the futility verdict**, which is correct for a race build
   *   arriving long after some change and exactly wrong here: `markDrop()` armed
   *   that verdict one line ago, about this cut, and this line is what makes the
   *   cut whole. Throwing it away would leave the governor's largest single
   *   action the one action it never judges.
   */
  function collapseSeam(): boolean {
    if (seamIndex === index) return false;
    seamIndex = index;
    installSettings();
    applySeamContent(LADDER[seamIndex]!.content);
    ctx.bus.emit('quality:changed', {
      quality: ctx.quality, scale: liveScale, rung: index, label: LADDER[index]?.label ?? '',
    });
    publish();
    return true;
  }

  // ── the content pass: the census ──────────────────────────────────────────

  /**
   * The largest suffix of `geo`'s index buffer whose every vertex is animated.
   *
   * That is "the people", exactly — see `CrowdGeo.head`. Walked backwards from
   * the end and stopped at the first vertex the crowd's vertex program does not
   * move, so a geometry that interleaves its stand with its spectators
   * (none does today) degrades to trimming nothing rather than to trimming the
   * terracing.
   */
  function crowdHead(geo: THREE.BufferGeometry): number {
    const idx = geo.getIndex();
    const amp = geo.getAttribute('aAmp') as { getX(i: number): number } | undefined;
    if (!idx || !amp) return idx ? idx.count : 0;
    for (let i = idx.count - 1; i >= 0; i--) {
      if (amp.getX(idx.getX(i)) <= 0) return i + 1;
    }
    return 0;
  }

  /**
   * Reorder a batch's instances so that **any prefix of them is spread over the
   * whole batch**.
   *
   * `InstancedMesh.count` is the only density dial that costs nothing: one
   * integer, no reallocation, no upload, exactly reversible. What it draws is
   * the first N instances, and the first N instances of a batch built in
   * placement order are the first N *metres of lap* — so used naively it does
   * not thin a verge, it deletes the end of one.
   *
   * So the matrices are permuted once, at census time, into van der Corput
   * order: index 0, then the middle, then the two quarters, then the four
   * eighths. Every prefix of that sequence is a low-discrepancy sample of the
   * whole, so `count = 0.48 * full` is a verge with half the cones on it rather
   * than half a verge, at every share and with no per-frame work at all. It is
   * deterministic, it is done once, and `count = full` puts the batch back
   * exactly as it was — the permutation is a relabelling, not a loss.
   */
  function stratify(mesh: THREE.InstancedMesh): void {
    const n = mesh.count;
    if (n < 4) return;
    // Idempotent. The census can be re-taken — a course change, a bench calling
    // `__QUALITY.census()` — and applying a low-discrepancy permutation twice
    // gives a permutation that is still valid and no longer low-discrepancy,
    // which is the worst kind of bug: it does not fail, it just quietly stops
    // thinning evenly.
    if (mesh.userData.mcStratified) return;
    mesh.userData.mcStratified = true;
    const attr = mesh.instanceMatrix;
    const arr = attr.array as Float32Array;
    const order: number[] = [];
    for (let i = 0; i < n; i++) order.push(i);
    // Radical inverse base 2: the bits of i, reversed. Cheap and exact.
    const vdc = (i: number): number => {
      let b = i;
      b = ((b & 0x55555555) << 1) | ((b >>> 1) & 0x55555555);
      b = ((b & 0x33333333) << 2) | ((b >>> 2) & 0x33333333);
      b = ((b & 0x0f0f0f0f) << 4) | ((b >>> 4) & 0x0f0f0f0f);
      b = ((b & 0x00ff00ff) << 8) | ((b >>> 8) & 0x00ff00ff);
      b = (b << 16) | (b >>> 16);
      return (b >>> 0) / 4294967296;
    };
    order.sort((a, b) => vdc(a) - vdc(b));
    const copy = arr.slice(0, n * 16);
    for (let p = 0; p < n; p++) {
      const s = order[p]! * 16;
      const d = p * 16;
      for (let k = 0; k < 16; k++) arr[d + k] = copy[s + k]!;
    }
    attr.needsUpdate = true;
  }

  /**
   * What the frame is made of, and which parts of it a rung may spend.
   *
   * Run once per course, from `reset()`, with the world built — the same load
   * moment `precompileLadder` uses, and for the same reason: a walk of the
   * scene graph is not something to do on a frame a player is watching.
   *
   * ── Why the classifier is measurements and not a list of names ─────────────
   *
   * Two of the three classes here are decided by *what the thing is like*
   * rather than by what it is called: a scatter batch is an instanced draw with
   * more than `SCATTER_MIN_N` copies of something under `SCATTER_MAX_R` across,
   * and a cullable is anything instanced at all. Those survive a course being
   * re-dressed, a prop being renamed, and a whole new landscape kit.
   *
   * The crowd is the exception and it is a name test, because "a spectator" is
   * not a shape — but even there the *trim* is derived from the geometry's own
   * animation attribute rather than from the name, so the worst a rename can do
   * is switch the crowd rung off. `probe().content` reports how many of each
   * class the census found, so that failure reads as `crowd: 0` instead of as a
   * rung that mysteriously buys nothing.
   *
   * Two things are deliberately exempt:
   *
   *   **The contact patches.** `world:contact` is the soft dark blob under
   *   every prop that stands on the dirt, and ARCHITECTURE §12 is unambiguous
   *   about what happens without it. They are two triangles each and they are
   *   not thinned at any rung, so every prop that is drawn is a prop that is
   *   grounded. (The reverse — a blob left behind by a cone the scatter rung
   *   removed — is a soft patch of shade on dirt, which is what dirt looks
   *   like.)
   *
   *   **Everything outside the `world` group.** The road, the barriers, the
   *   kerbs, the item boxes and the coins are *gameplay surfaces*: the road has
   *   to be obvious at speed and an item box that is not drawn is an item box
   *   the player drives past. A frame budget does not get to spend those.
   */
  function censusContent(): void {
    for (const c of crowdGeos) c.geo.setDrawRange(0, Infinity);
    for (const s of scatter) s.mesh.count = s.full;
    for (const c of cullables) if (c.hidden) { c.node.visible = true; c.hidden = false; }
    crowdGeos.length = 0;
    scatter.length = 0;
    cullables.length = 0;
    culledNow = 0;

    const world = ctx.scene.children.find((c) => c.name === 'world');
    if (!world) return;
    const seen = new Set<string>();
    world.traverse((o) => {
      const m = o as THREE.Mesh & { isInstancedMesh?: boolean; count?: number;
        boundingSphere?: { center: THREE.Vector3; radius: number } | null;
        computeBoundingSphere?(): void };
      if (!m.isMesh) return;
      const geo = m.geometry;
      if (!geo) return;
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      const item = geo.boundingSphere?.radius ?? 0;
      const isCrowd = /crowd/i.test(m.name);
      const isContact = /contact/i.test(m.name);

      if (isCrowd && geo.index && !seen.has(geo.uuid)) {
        seen.add(geo.uuid);
        const full = geo.index.count;
        crowdGeos.push({ geo, full, head: crowdHead(geo), at: full });
      }

      if (m.isInstancedMesh) {
        const n = m.count ?? 0;
        const thinnable = !isCrowd && !isContact && n >= SCATTER_MIN_N
          && item > 0 && item <= SCATTER_MAX_R;
        // The screen-size test wants the batch's own sphere, which an
        // `InstancedMesh` computes across its instances. `place.ts` already
        // asked for it; ask again only if it did not.
        if (!m.boundingSphere) m.computeBoundingSphere?.();
        const bs = m.boundingSphere;
        if (bs) {
          o.updateMatrixWorld();
          _wp.copy(bs.center).applyMatrix4(o.matrixWorld);
        }
        if (thinnable) {
          stratify(m as THREE.InstancedMesh);
          scatter.push({
            mesh: m as THREE.InstancedMesh, full: n, at: n,
            cx: bs ? _wp.x : 0, cy: bs ? _wp.y : 0, cz: bs ? _wp.z : 0,
            radius: bs ? bs.radius : 0, item,
          });
        }
        if (bs && !isContact) {
          cullables.push({
            node: o, cx: _wp.x, cy: _wp.y, cz: _wp.z,
            radius: bs.radius, item, hidden: false,
          });
        }
      }
    });
    contentCrowd = crowdGeos.length;
    contentScatter = scatter.length;
    contentCullable = cullables.length;
  }

  /**
   * Bake a racer's machine into one mesh per material, once, at a load moment.
   *
   * See `Shell`. Two rules make this safe to do from here rather than from the
   * module that owns the model:
   *
   *   It is **additive**. Nothing existing is removed, re-parented or
   *   re-materialised; a group is added under the racer's own root and left
   *   switched off. If this file is disposed the shell goes with it and the
   *   machine is exactly what `vehicles/registry.ts` built.
   *
   *   It **copies rather than shares** geometry, so the part ladder in
   *   `vehicles/index.ts` can go on writing `visible` and `castShadow` on the
   *   originals without either of us noticing the other. Ancestor visibility is
   *   what arbitrates: while the shell is up, root's own children are off, and
   *   every write the rig and the ladder make lands on nodes nobody is drawing.
   */
  function buildShell(root: THREE.Object3D): Shell | null {
    const T = ctx.THREE;
    const inv = new T.Matrix4();
    const local = new T.Matrix4();
    root.updateMatrixWorld(true);
    inv.copy(root.matrixWorld).invert();
    const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();

    let meshes = 0;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      // `visible` here is the *build-time* answer, which is what it is: this
      // runs from `reset()`, before any `update()` has moved a flag, and it
      // deliberately skips the parts a machine ships switched off — a puff
      // waiting for a rate, a mouth waiting to be yelled with. It rests on the
      // same assumption `makeVisualState` in `vehicles/index.ts` rests on and
      // states out loud: **models are rebuilt per race.** If they ever stop
      // being, both this and the part ladder would inherit the previous race's
      // hidden parts, and both would have to be told.
      if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
      // The contact pass owns this one and moves it every frame.
      if (o.name === 'shadowBlob') return;
      // ...and the shadow shell is this file's own, built one line earlier and
      // standing in for the whole machine in the shadow pass. Merging it into
      // the colour shell would draw the silhouette a second time in paint.
      if (o.name === SHADOW_SHELL) return;
      // A multi-material mesh has per-group index ranges that a flat merge
      // would lose. None exist on any machine today; skip rather than corrupt.
      if (Array.isArray(mesh.material)) return;
      const src = mesh.geometry;
      if (!src.getAttribute('position')) return;
      const g = src.index ? src.toNonIndexed() : src.clone();
      local.multiplyMatrices(inv, mesh.matrixWorld);
      g.applyMatrix4(local);
      const mat = mesh.material as THREE.Material;
      const list = buckets.get(mat);
      if (list) list.push(g); else buckets.set(mat, [g]);
      meshes++;
    });
    if (meshes < 4) {
      for (const list of buckets.values()) for (const g of list) g.dispose();
      return null;
    }

    const group = new T.Group();
    group.name = 'lodShell';
    const built: Array<{ mesh: THREE.Mesh; tris: number }> = [];
    for (const [mat, list] of buckets) {
      const merged = mergeParts(list);
      for (const g of list) g.dispose();
      if (!merged) continue;
      const mesh = new T.Mesh(merged, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      group.add(mesh);
      built.push({
        mesh,
        tris: (merged.getAttribute('position')?.count ?? 0) / 3,
      });
    }
    if (!built.length) return null;
    // **No caster at all.** The shadow shell below is the machine's one caster
    // at every rung and whether the colour shell is standing in or not, so the
    // old "one caster: the biggest bucket" line would put a second, coarser
    // silhouette into the map the moment a machine shelled. See `ShadowShell`.
    group.visible = false;
    root.add(group);

    const hides: THREE.Object3D[] = [];
    for (const child of root.children) {
      if (child === group || child.name === 'shadowBlob') continue;
      // The shadow shell is not something the colour shell stands in for: the
      // machine's silhouette has to keep reaching the shadow map at every
      // distance, and it is drawing nothing in paint to be stood in for.
      if (child.name === SHADOW_SHELL) continue;
      hides.push(child);
    }
    return { group, hides, was: hides.map(() => true), on: false };
  }

  /**
   * ── The shadow shell: seven casters where there were a hundred and fifty ───
   *
   * The single largest thing in this frame, and it is not a quality cut — it is
   * the same silhouette drawn once instead of twenty-two times.
   *
   * Measured on the `racing` shot at 1600x900, rung 0, with the audit's
   * frustum-aware columns (see `AuditRow.drawn`):
   *
   *   group      drawn   shadow   drawn triangles
   *   the field    167      155            31,920
   *   world         59       32           196,608
   *   track         12        5           168,470
   *   everything   271      195           449,960     `stats()` 480 / 662,900
   *
   * **The seven machines are 322 of the frame's 466 scene submissions — 69% —
   * for 7% of its triangles**, and 155 of those are the shadow pass drawing
   * twenty-two separate greebles per machine into a 2048 map. `vehicles/`
   * already has a shadow ladder of its own (`SHADOW_MIN_PX`, `SHADOW_KEEP`) and
   * it is doing its job: what it cannot do is make one draw out of parts that
   * are separate meshes because they are separately *painted*. In the shadow
   * pass the paint is irrelevant — every caster resolves to the same depth
   * material — so the whole machine merges into one buffer regardless of how
   * many materials it wears.
   *
   * ── What it gives up ──────────────────────────────────────────────────────
   *
   * The merge is taken at the transforms the parts sit at when the model is
   * built, so inside the shadow map the wheels stop turning and the body stops
   * leaning. The machine's *own* transform still applies — the shell is a child
   * of the racer's root — so the shadow moves, rotates, banks and jumps with the
   * kart exactly as it did. What is frozen is sub-part motion, in a soft 2048
   * map, under a kart that is thirty pixels of shadow at racing distance.
   * Photographed at 1600x900 against the same frame with the old caster set:
   * no pixel of the shot moved by more than the map's own filtering.
   *
   * ── ...and how it costs nothing in the colour pass ────────────────────────
   *
   * A mesh cannot be shadow-only in three: `WebGLRenderer.projectObject` and
   * `WebGLShadowMap.renderObject` both gate on the same `material.visible`, and
   * the colour list is built *before* the shadow pass runs, so there is no
   * frame in which the two can disagree. The geometry instead ships with its
   * draw range closed, and `onBeforeShadow`/`onAfterShadow` — which fire either
   * side of the shadow draw and nowhere else — open it for exactly that
   * submission. The colour pass therefore gets one draw call of **zero
   * triangles** per machine, which is the whole of the price: 155 shadow draws
   * become 7, plus 7 empty colour draws. Net **-141 draw calls and no change to
   * the triangle count at all.**
   */
  const SHADOW_SHELL = 'lodShadow';
  interface ShadowShell {
    mesh: THREE.Mesh;
    /** The machine's own casters, which this stands in for. Their `castShadow`
     *  is held down every frame — see `holdShadowShells`. */
    muted: THREE.Mesh[];
  }
  const shadowShells = new Map<number, ShadowShell>();
  /**
   * ...and the same set as a flat array, because `holdShadowShells` runs every
   * rendered frame and `Map.prototype.values()` allocates an iterator.
   *
   * The map is the identity index (a racer id is how `reset` finds one to throw
   * away); this is the thing the hot path walks. Kept in step in exactly two
   * places, `buildShells` and `clearShadowShells`, both of which are load
   * moments. See the same argument on the racer loop in `contentFrame`.
   */
  const shadowShellList: ShadowShell[] = [];
  /**
   * One material for every shadow shell in the game.
   *
   * It is never seen: the draw range is closed for the colour pass. It exists
   * because `WebGLShadowMap` derives the depth material from the mesh's own
   * material, and the derivation reads `side`, `alphaTest`, `map` and
   * `clipShadows` — so a plain opaque front-sided material is what makes the
   * depth material the *shared* one every other caster in the scene already
   * uses, rather than a new program. The ladder compiles one program set and
   * this must not be the thing that breaks it.
   */
  let shadowShellMat: THREE.Material | null = null;

  function buildShadowShell(root: THREE.Object3D): ShadowShell | null {
    const T = ctx.THREE;
    const inv = new T.Matrix4();
    const local = new T.Matrix4();
    root.updateMatrixWorld(true);
    inv.copy(root.matrixWorld).invert();
    const parts: THREE.BufferGeometry[] = [];
    const muted: THREE.Mesh[] = [];

    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible || !mesh.castShadow || !mesh.geometry) return;
      if (o.name === 'shadowBlob' || o.name === SHADOW_SHELL) return;
      if (!mesh.geometry.getAttribute('position')) return;
      const src = mesh.geometry;
      const g = src.index ? src.toNonIndexed() : src.clone();
      local.multiplyMatrices(inv, mesh.matrixWorld);
      g.applyMatrix4(local);
      parts.push(g);
      muted.push(mesh);
    });
    // Two casters are already one draw each way round; the machinery is only
    // worth its bookkeeping when it is removing submissions.
    if (parts.length < 3) {
      for (const g of parts) g.dispose();
      return null;
    }
    const merged = mergeParts(parts);
    for (const g of parts) g.dispose();
    if (!merged) return null;

    if (!shadowShellMat) {
      shadowShellMat = new T.MeshBasicMaterial({ side: T.FrontSide });
      shadowShellMat.name = 'mc.shadowShell';
    }
    const mesh = new T.Mesh(merged, shadowShellMat);
    mesh.name = SHADOW_SHELL;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
    // Shut for the colour pass, opened for the shadow draw and shut again
    // immediately. See the block above; these two hooks fire nowhere else.
    merged.setDrawRange(0, 0);
    const count = merged.getAttribute('position')?.count ?? 0;
    mesh.onBeforeShadow = (): void => { merged.setDrawRange(0, count); };
    mesh.onAfterShadow = (): void => { merged.setDrawRange(0, 0); };
    root.add(mesh);

    for (const m of muted) m.castShadow = false;
    return { mesh, muted };
  }

  /**
   * Hold the machines' own casters off, every frame.
   *
   * Two modules write `castShadow` on these nodes and this is the resolution of
   * that, stated rather than left to be discovered. `vehicles/index.ts` runs its
   * own shadow ladder at order 85 and *restores* `parts[i].casts` whenever a
   * machine comes back towards the camera, so a one-shot write here would be
   * undone the first time a rival closed up. This file runs at order 95 — after
   * the rig, after the part ladder, before the draw — and writes the same value
   * every frame, so there is exactly one effective owner and nothing can
   * flicker. It is the same idiom `vehicles/` uses for its own detail gate,
   * pointed one layer up.
   *
   * Flat arrays captured at build time, so this is a few hundred boolean writes
   * and no traversal, no closure and no allocation.
   */
  function holdShadowShells(): void {
    for (let i = 0; i < shadowShellList.length; i++) {
      const muted = shadowShellList[i]!.muted;
      for (let j = 0; j < muted.length; j++) muted[j]!.castShadow = false;
    }
  }

  /** Give every machine its own casters back, and drop the merged one. */
  function clearShadowShells(): void {
    for (let i = 0; i < shadowShellList.length; i++) {
      const s = shadowShellList[i]!;
      for (const m of s.muted) m.castShadow = true;
      s.mesh.parent?.remove(s.mesh);
      s.mesh.onBeforeShadow = (): void => {};
      s.mesh.onAfterShadow = (): void => {};
      s.mesh.geometry?.dispose();
    }
    shadowShells.clear();
    shadowShellList.length = 0;
  }

  /**
   * Concatenate non-indexed geometries that share a material.
   *
   * Position and normal always; uv and vertex colour only when **every** one of
   * them has it. A merge that invents a uv channel for half its vertices
   * produces a mesh whose texture is garbage on the half that was invented, and
   * the machines that carry one — the train's plate, the digger's decals — are
   * exactly the ones a reviewer photographs. Dropping the channel entirely is
   * the safe direction to be wrong in: a shared `mat()` material declares
   * neither `map` nor `vertexColors` unless every mesh painted with it wanted
   * them, so a bucket that is not unanimous is a bucket where the channel was
   * never being read.
   */
  function mergeParts(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
    if (!list.length) return null;
    let count = 0;
    let allUv = true;
    let allColor = true;
    let allNormal = true;
    for (const g of list) {
      count += g.getAttribute('position')!.count;
      if (!g.getAttribute('uv')) allUv = false;
      if (!g.getAttribute('color')) allColor = false;
      if (!g.getAttribute('normal')) allNormal = false;
    }
    if (count <= 0) return null;
    const T = ctx.THREE;
    const pos = new Float32Array(count * 3);
    const nrm = new Float32Array(count * 3);
    const uv = allUv ? new Float32Array(count * 2) : null;
    const col = allColor ? new Float32Array(count * 3) : null;
    let o = 0;
    for (const g of list) {
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      const n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
      const u = uv ? (g.getAttribute('uv') as THREE.BufferAttribute) : null;
      const c = col ? (g.getAttribute('color') as THREE.BufferAttribute) : null;
      for (let i = 0; i < p.count; i++) {
        const k = (o + i) * 3;
        pos[k] = p.getX(i); pos[k + 1] = p.getY(i); pos[k + 2] = p.getZ(i);
        if (n) { nrm[k] = n.getX(i); nrm[k + 1] = n.getY(i); nrm[k + 2] = n.getZ(i); }
        if (u && uv) { uv[(o + i) * 2] = u.getX(i); uv[(o + i) * 2 + 1] = u.getY(i); }
        if (c && col) { col[k] = c.getX(i); col[k + 1] = c.getY(i); col[k + 2] = c.getZ(i); }
      }
      o += p.count;
    }
    const out = new T.BufferGeometry();
    out.setAttribute('position', new T.BufferAttribute(pos, 3));
    out.setAttribute('normal', new T.BufferAttribute(nrm, 3));
    if (uv) out.setAttribute('uv', new T.BufferAttribute(uv, 2));
    if (col) out.setAttribute('color', new T.BufferAttribute(col, 3));
    // A bucket where one part shipped normals and another did not would light
    // half of itself black. Recomputing is a build-time cost paid once.
    if (!allNormal) out.computeVertexNormals();
    out.computeBoundingSphere();
    return out;
  }

  /** Drop every shell, so a new field does not inherit the last one's. */
  function clearShells(): void {
    for (const s of shells.values()) {
      // Only a shell that was actually standing in has anything to give back.
      // `was` is only written on the edge, so restoring from it on a shell that
      // never came up would switch on the puffs and glows that were born
      // hidden — a machine trailing exhaust smoke while parked on the grid.
      if (s.on) for (let i = 0; i < s.hides.length; i++) s.hides[i]!.visible = s.was[i]!;
      s.group.parent?.remove(s.group);
      s.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry?.dispose();
      });
    }
    shells.clear();
    contentShells = 0;
    shelledNow = 0;
  }

  function buildShells(): void {
    clearShells();
    clearShadowShells();
    for (const racer of ctx.racers) {
      const root = racer.model?.root ?? racer.visual;
      if (!root) continue;
      // The shadow shell first: it takes `castShadow` off the machine's own
      // meshes, and the colour shell below reads that when it decides what its
      // own buckets are allowed to cast. See `ShadowShell`.
      const dark = buildShadowShell(root);
      if (dark) { shadowShells.set(racer.id, dark); shadowShellList.push(dark); }
      const shell = buildShell(root);
      if (shell) shells.set(racer.id, shell);
    }
    contentShells = shells.size;
    // One frame with every shell on the screen, which `main.ts`'s priming
    // render is about to be. See `primeShells`.
    primeShells = shells.size ? 1 : 0;
  }

  /**
   * Install the half of a content rung that lands on the frame it is taken on.
   *
   * There is nothing to do but remember it: `thinFar`, `minPx` and `shellPx` all
   * depend on where the camera is, so the work is `contentFrame`'s and this is
   * the statement of what that pass is working to.
   */
  function applyFrameContent(next: ContentTrim): void {
    content = next;
  }

  /**
   * ...and the half that waits for a seam: the crowd.
   *
   * One lever now rather than two. It is the one a player can watch being spent
   * — a stand's back rows going at once, forty metres in front of them — so it
   * is installed at boot, at a race build behind the closed launch board, and
   * on a window resize, and never in between. See `SEAM_HELD` for why it stays
   * and `flushSeam` for the three doors.
   *
   * `scatter` used to be here and is not: round nine put it on `thinFar`'s
   * projected-size ramp, where it is `contentFrame`'s business every frame. All
   * that is left of it here is the *floor* the ramp writes between a seam and
   * the first frame drawn after it — see the loop below.
   *
   * State rather than a per-frame decision, and re-applying an unchanged share
   * writes nothing.
   */
  function applySeamContent(next: ContentTrim): void {
    seamContent = next;
    for (const c of crowdGeos) {
      const people = c.full - c.head;
      // Whole triangles only, or the tail of the range is a torn quad — and the
      // rounding is applied to the *people*, so it can never eat into the head.
      let keep = Math.round(people * Math.max(0, Math.min(1, next.crowd)));
      keep -= keep % 3;
      let want = c.head + keep;
      if (want > c.full) want = c.full;
      if (want === c.at) continue;
      c.at = want;
      c.geo.setDrawRange(0, want >= c.full ? Infinity : want);
    }
    // The verge goes back to **full**, and `contentFrame` thins it again on the
    // very next frame from where the camera actually is. There is exactly one
    // frame between a seam and that pass — the priming render — and full is the
    // right thing to draw on it: it is the only share that is correct at every
    // distance, so a frame drawn before the ramp has run is never a frame drawn
    // at some other rung's density.
    for (const s of scatter) {
      if (s.at !== s.full) { s.at = s.full; s.mesh.count = s.full; }
    }
  }

  /**
   * The levers that depend on where the camera is, run once per rendered
   * frame.
   *
   * ── The unit ──────────────────────────────────────────────────────────────
   *
   * Pixels of the *drawing buffer*, resolved against the live lens exactly as
   * `vehicles/index.ts` does. Metres would be the wrong unit twice over: the
   * lens opens with speed and kicks on every boost, and this file's own render
   * scale changes how many pixels a metre is worth. A rung that halves the
   * resolution should tighten its own content cut, and denominated this way it
   * does so without a second constant.
   *
   * ── Why it may write `visible` at all ─────────────────────────────────────
   *
   * `world/index.ts` writes the same flag at order 22 for its own draw-distance
   * test and this runs at 95, so the frame's last word is here. On the frame a
   * batch is released this hands it back as visible even if the world had just
   * hidden it for distance; the world re-asserts on the very next frame and the
   * cost of being wrong is one frame of one far batch. Hiding is never
   * speculative in the other direction — a batch the world has already switched
   * off is left alone.
   */
  function contentFrame(): void {
    const canvas = ctx.renderer.domElement;
    // ── the pixels the **world** is drawn into, not the ones it lands on ─────
    //
    // `liveScale` belongs in here and had fallen out of it. The unit this pass
    // is denominated in is a pixel of the drawing buffer, and round eight moved
    // the render scale off the canvas and into targets the post stack owns —
    // after which `canvas.height` stopped being that number and started being a
    // constant. So the property this pass was designed around ("a rung that
    // drops the render scale tightens its own content cut for free; half the
    // pixels resolve half the detail") had quietly become false, and the whole
    // content half of the ladder was measuring against a resolution the world
    // is not drawn at.
    //
    // It is safe to move with `liveScale` for the same reason `liveScale` is
    // safe to move at all: the scale itself now arrives on a ramp (see
    // `SCALE_RAMP`), so a threshold derived from it arrives on the same ramp.
    const h = (canvas.height || canvas.clientHeight || 720) * liveScale;
    const pxPerMetre = (h * 0.5) / Math.tan((ctx.camera.fov * Math.PI) / 360);
    _cam.copy(ctx.camera.position);

    // ── the dressing ──────────────────────────────────────────────────────
    const minPx = content.minPx;
    let culled = 0;
    for (let i = 0; i < cullables.length; i++) {
      const c = cullables[i]!;
      if (minPx <= 0) {
        if (c.hidden) { c.node.visible = true; c.hidden = false; }
        continue;
      }
      const dx = c.cx - _cam.x, dy = c.cy - _cam.y, dz = c.cz - _cam.z;
      // The *near edge* of the batch, so a run of verge passing the camera is
      // never judged on where its far end is.
      const near = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz) - c.radius);
      const px = (c.item * pxPerMetre) / near;
      const bar = c.hidden ? minPx * CONTENT_HYSTERESIS : minPx;
      if (px < bar) {
        if (!c.hidden) { c.node.visible = false; c.hidden = true; }
        culled++;
      } else if (c.hidden) {
        c.node.visible = true;
        c.hidden = false;
      }
    }
    culledNow = culled;

    // ── the verge's density, as a function of how big a cone is on screen ──
    //
    // **The whole scatter lever, and all of it live.** `far` is the density a
    // batch is taken to once its instances have shrunk to nothing, and it is
    // the product of the two shares the rung carries: `thinFar`, which is the
    // ramp, and `scatter`, which used to be a flat multiplier installed at a
    // seam and is now the far end of the same ramp. Round nine's change is that
    // one multiplication — see `ContentTrim.scatter`.
    //
    // Anchored at the knee, which is what makes it seam-safe and what makes the
    // product legitimate: at `THIN_KNEE_PX` the factor is exactly 1 for every
    // rung of the ladder, whatever either share says, so the verge a player is
    // driving past is at full density at rung 0 and at the floor alike and a
    // rung change cannot be watched happening. Everything a rung moves is
    // already smaller than the knee.
    //
    // No hysteresis, deliberately, and it is the one lever in this file that
    // does not need it. A dead band exists to stop a *binary* flag strobing on
    // a batch that sits exactly on the threshold; a count that moves
    // continuously with distance has nothing to strobe between.
    const far = Math.max(0, Math.min(1, content.thinFar * content.scatter));
    let thinned = 0;
    for (let i = 0; i < scatter.length; i++) {
      const s = scatter[i]!;
      let f = 1;
      if (far < 1) {
        const dx = s.cx - _cam.x, dy = s.cy - _cam.y, dz = s.cz - _cam.z;
        const near = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz) - s.radius);
        const px = (s.item * pxPerMetre) / near;
        if (px < THIN_KNEE_PX) {
          // Linear in projected size, and **anchored at the knee**: `t` is 1
          // where the ramp starts, so every rung draws the same batch there and
          // the rung's effect grows as the thing shrinks. See `ContentTrim.
          // thinFar`.
          const t = px / THIN_KNEE_PX;
          f = far + (1 - far) * t;
          thinned++;
        }
      }
      const want = Math.max(1, Math.round(s.full * f));
      if (s.at !== want) { s.at = want; s.mesh.count = want; }
    }
    thinnedNow = thinned;

    // ── the field ─────────────────────────────────────────────────────────
    //
    // Unconditional and above the rung's own tests: the shadow shell is not a
    // quality cut and does not belong to a rung. It is on at rung 0 and it is
    // the reason rung 0 fits the ceiling. See `ShadowShell` and `RUNG0`.
    holdShadowShells();
    //
    // The priming frame draws every shell next to every machine, once, so the
    // buffer upload lands on a load rather than on a rescue. See `primeShells`.
    if (primeShells > 0) {
      primeShells--;
      for (const s of shells.values()) if (!s.on) s.group.visible = true;
      shelledNow = 0;
      return;
    }
    const shellPx = content.shellPx;
    let shelled = 0;
    // Indexed rather than `for...of`: this is the hot path's hot path and an
    // array iterator is an allocation the engine is only *usually* clever
    // enough to remove.
    const racers = ctx.racers;
    for (let ri = 0; ri < racers.length; ri++) {
      const racer = racers[ri]!;
      const s = shells.get(racer.id);
      if (!s) continue;
      let want = false;
      if (shellPx > 0) {
        const root = racer.model?.root ?? racer.visual;
        if (root) {
          root.getWorldPosition(_wp);
          const d = Math.max(1, _wp.distanceTo(_cam));
          // A machine is about 1.1m of bounding radius; taking it off the def
          // would mean a lookup per racer per frame for a number that varies by
          // a fifth across the cast and is being compared against a threshold
          // with a 25% dead band on it.
          const px = (1.1 * pxPerMetre) / d;
          // Two tests, ANDed: small enough to have lost the *detail*, and far
          // enough to have lost the *motion*. The pixel test alone put a steam
          // locomotive twenty-three metres away on a static mesh with its
          // connecting rods stopped — see `SHELL_MIN_M`.
          want = d > SHELL_MIN_M && px < (s.on ? shellPx * CONTENT_HYSTERESIS : shellPx);
        }
      }
      if (want) {
        // Captured on the edge, re-asserted every frame. The rig at order 85
        // writes `visible` on nodes under here for its own reasons — a spin
        // disc fading in with rpm, an exhaust glow with boost — and this pass
        // has to have the last word for as long as the shell is standing in,
        // or a machine shows its glow through its own replacement.
        for (let i = 0; i < s.hides.length; i++) {
          if (!s.on) s.was[i] = s.hides[i]!.visible;
          s.hides[i]!.visible = false;
        }
        if (!s.on) s.group.visible = true;
        s.on = true;
        shelled++;
        continue;
      }
      if (!s.on) {
        // Also the frame after `primeShells`, which left every shell showing
        // so its buffers would upload on a load frame.
        if (s.group.visible) s.group.visible = false;
        continue;
      }
      s.on = false;
      {
        s.group.visible = false;
        // Back to what each child was showing when the shell took over. One
        // frame stale — the rig and the part ladder both run at order 85 and
        // re-assert on the next frame — and staleness is the right failure:
        // restoring everything to `true` would switch on the puffs and glows
        // that are somebody else's to switch on.
        for (let i = 0; i < s.hides.length; i++) s.hides[i]!.visible = s.was[i]!;
      }
    }
    shelledNow = shelled;
  }

  /**
   * Mirror the verdict into the frame budget.
   *
   * `stats()` is where every reviewer reads the frame, and until now it could
   * report the *settings* the governor had installed without ever reporting the
   * governor — so a review sheet could show a tier and a shadow size with no way
   * to tell a machine that chose them from a machine that was driven to them.
   * The budget is the one object both files already share, so this costs seven
   * field writes a frame and no allocation, and `engine.ts` still does not have
   * to know this file exists.
   */
  function publish(): void {
    const b = ctx.budget;
    if (!b) return;
    b.rung = index;
    b.rungLabel = LADDER[index]?.label ?? '';
    // **What the buffer has, not what the ladder wants.** Between seams those
    // are different numbers (see `flushScale`), and `stats().renderScale` is
    // read by reviewers as "how big is the picture I am looking at" — which is
    // a question about the drawing buffer and never about the ladder's
    // intentions.
    b.renderScale = liveScale;
    b.liveWallMs = wallMean;
    b.liveWorstMs = wallWorst;
    b.liveSeconds = liveSeconds;
    b.governor = holding;
    // ...and the one field the engine acts on rather than reports. Written
    // every frame from the same place as the rest of the verdict so there is
    // exactly one line in this file that can turn the draw off.
    b.skipDraw = frontEndCovers;
  }

  /** Record why the governor is standing still, and publish it. Returns void so
   *  the call sites can be `return hold('...')` — one statement, no fallthrough
   *  and no way to leave without the budget agreeing with the decision. */
  function hold(why: string): void {
    // ── the one word that tells a reviewer which number to believe ─────────
    //
    // `stats()` reports three costs that legitimately disagree by an order of
    // magnitude — `ms` (CPU work this frame: sim + update + the call into the
    // driver), `wallMs` (the engine's sixty-frame mean) and `liveWallMs` (this
    // file's own delivered-frame window). A reviewer reading 145ms next to
    // 1400ms cannot tell which is broken, and the honest answer is neither:
    // `renderer.render()` returns when the command buffer is handed over, so on
    // a GPU-bound machine almost the whole frame is downstream of the last
    // instruction the page can time.
    //
    // `boundBy()` already knows which of those is happening. Stating it here
    // costs one string concatenation on the frames where the governor is
    // holding *because* the frame is late, and it turns two numbers that look
    // like a contradiction into a measurement with a cause attached.
    const b = ctx.budget;
    if (b && wallMean > 0 && (why === 'over budget' || why === 'panic' || why === 'in band')) {
      const bound = boundBy(b);
      holding = bound ? `${why} (${bound})` : why;
    } else {
      holding = why;
    }
    publish();
  }

  /**
   * Empty the decision window, and **leave the change measurement alone**.
   *
   * The two used to be one function and that cost round nine the one number it
   * was told to produce. `changeMs` is measured over the `SKIP_FRAMES` frames
   * after a change; the change's own render-scale ramp lands one or two frames
   * into that window and `landScale` cleared the window — which dropped the
   * entry pointer and left `changeMs` at 0 for ever. A live 199-second session
   * with exactly one rung change in it reported `changeWorstMs: 0`, and the
   * reviewer correctly read that as "the file cannot demonstrate that its own
   * transitions are free". It was not a spoiled window; it was this.
   *
   * So the statistics and the measurement are cleared separately, and the rule
   * is one sentence: **a clear caused by the change itself keeps the entry, a
   * clear caused by anybody else drops it.** `landScale('live')` and the
   * collapse path's own seam are the first kind; a hand pick, a bench, a race
   * build, a pause and a front-end edge are the second.
   */
  function clearStats(): void {
    wallCount = 0;
    wallIdx = 0;
    wallMean = 0;
    wallWorst = 0;
    wallBest = 0;
    workMean = 0;
    lateFrac = 0;
    skipFrames = SKIP_FRAMES;
  }

  /** ...and the other half: a change measurement that belongs to nobody.
   *  Dropping the entry pointer leaves its `changeMs` at 0, which reads as
   *  "not measured" rather than as "free". */
  function dropChange(): void {
    changeCost = 0;
    changeEntry = null;
    changeSpoiled = false;
  }

  function clearWindow(): void {
    clearStats();
    dropChange();
  }

  /**
   * Something outside the rAF loop reached in and moved the ladder by hand.
   *
   * `__QUALITY.set/try/auto` are called from a reviewer's `page.evaluate`, and
   * an evaluate moves neither `budget.benchSteps` nor `budget.benchFrames` —
   * so the whole harness-detection apparatus above is blind to it, and the
   * multi-second Node round trip that follows lands on the next delivered frame
   * as if the page had produced it. That is where `probe().changeWorstMs =
   * 15,628.6` came from on a bench whose real switch cost was 6-17.5ms.
   *
   * One latch, set by every hand entry point, consumed exactly like a harness
   * step: the frame that spans the call is discarded from the window, and any
   * change measurement it lands inside is abandoned rather than charged.
   */
  function externalTouch(): void {
    harnessSince = true;
    changeSpoiled = true;
  }

  /** Recompute the front-end's cover *now* and push it to the budget.
   *
   *  The edges that change it — `ui:menu`, and a race being built underneath a
   *  closing board — arrive synchronously from inside another system's
   *  `update`, which for the menus runs at order 110, *after* this system's own
   *  update at 95 and before the engine reads `skipDraw`. Waiting for the next
   *  frame to notice would put one undrawn frame on the display at the exact
   *  moment the front-end stops covering it, which at 0.7fps is a black second
   *  and a half in the middle of the hand-off. */
  function republishCover(): void {
    frontEndCovers = frontEndOpaque();
    publish();
  }

  /**
   * Compose the standing `QualitySettings` out of **two** rungs.
   *
   * The frame-half comes off the rung the ladder has earned (`index`) and the
   * seam-half off the rung the seam last installed (`seamIndex`), and between a
   * mid-race rung change and the race build that follows it those are different
   * rows of the same table. Every rung states all of these fields, so there is
   * no case where a field is taken from a rung that did not author it.
   *
   * `shadows`, `shadowSize`, `postfx` and `bloom` are the same on every rung by
   * design — the ladder has no cliff in it (see §0 in the header) — so they are
   * carried by the spread and are not part of the split.
   */
  function composeSettings(): QualitySettings {
    const f = LADDER[index]!.settings;
    const s = LADDER[seamIndex]!.settings;
    return {
      ...f,
      // ── seam-held. See `SEAM_HELD`. `tier` is *not* on this list any more:
      // its whole measurable effect is `SHADOW_EXTENT` in `render/lighting.ts`,
      // and holding it meant `ctx.quality.tier` reported the rung the ladder
      // had left rather than the one it was on. ──
      //
      // `aa` has a door in it, and the door only opens one way: once the
      // resolution the resolve was resolving has gone, dropping it changes less
      // of the picture than the ramp step it is riding on. It may go early; it
      // may not come back early. See `AA_MOOT_SCALE`.
      aa: (!f.aa && aaMoot()) ? false : s.aa,
      drawDistance: s.drawDistance,
    };
  }

  /** Has the render scale already spent more sharpness than the FXAA resolve is
   *  worth? See `AA_MOOT_SCALE`. Denominated in what the buffer **has**, never
   *  in what the ladder wants, so it travels with the ramp. */
  function aaMoot(): boolean {
    return liveScale < AA_MOOT_SCALE - 1e-3;
  }

  /** ...and install it. The only place in this file that writes `ctx.quality`
   *  on the ladder's own authority; a hand pick writes it through the bus and
   *  is deliberately left alone. */
  function installSettings(): void {
    const q = composeSettings();
    ctx.quality = q;
    applied = q;
    ctx.renderer.shadowMap.enabled = q.shadows;
    ctx.renderer.shadowMap.needsUpdate = true;
  }

  /**
   * Does this lever differ between the rung the ladder has earned and the rung
   * the seam last installed?
   *
   * Written as a `switch` over `SEAM_HELD`'s own union with a `never` on the
   * end, so **the list and the code cannot come apart**: adding a name to
   * `SEAM_HELD` without teaching this function what it means is a type error
   * rather than a lever that silently reports itself as landed. (The other half
   * of the pair, `composeSettings`, has to be updated by hand — there is no
   * exhaustiveness trick for a spread.)
   */
  function seamDiffers(lever: SeamLever, f: Rung, s: Rung): boolean {
    switch (lever) {
      // Against what the buffer **has**, not against the other rung: with a
      // composer that can move the scale for free this lever is live and is
      // usually already correct, and reporting it as "deferred" because the two
      // rung rows differ would be the log lying about the picture.
      case 'scale': return Math.abs(liveScale - f.scale) > 1e-3;
      case 'crowd': return f.content.crowd !== s.content.crowd;
      case 'aa': return f.settings.aa !== s.settings.aa;
      case 'drawDistance': return f.settings.drawDistance !== s.settings.drawDistance;
      default: { const unhandled: never = lever; return unhandled; }
    }
  }

  /** Which seam-held levers this rung is still waiting on, for the log. Built
   *  only when the ladder actually moves, so the join is free. */
  function deferredLevers(): string {
    if (seamIndex === index) return '';
    const f = LADDER[index]!;
    const s = LADDER[seamIndex]!;
    let out = '';
    for (const lever of SEAM_HELD) {
      if (!seamDiffers(lever, f, s)) continue;
      out = out ? `${out},${lever}` : lever;
    }
    return out;
  }

  function applyRung(next: number, why: string): void {
    const from = index;
    index = next < 0 ? 0 : next >= LADDER.length ? LADDER.length - 1 : next;
    const r = LADDER[index]!;
    // The frame-half, and only the frame-half. `installSettings` takes `aa`,
    // the tier and the draw distance from `seamIndex` rather than from `r`, and
    // `applyScale` records a want the drawing buffer will not honour until the
    // next seam. What actually changes on this frame is the particle cap and
    // the three pixel thresholds — see `SEAM_HELD`.
    installSettings();
    applyScale(r.scale);
    applyFrameContent(r.content);

    // ── the climb's trial, settled here because both verdicts are rung moves ──
    //
    // In `applyRung` rather than at the three drop sites, because "was this drop
    // the last climb's fault" is a question about the *pair* and the pair is
    // only visible from here. `auto` gates it: a bench pinning a rung is not
    // evidence about a machine, and `set()`/`try()`/`mid()` all clear it first.
    if (auto && from !== index) {
      if (index > from) {
        // A drop. If a climb is still on trial and inside its window, the rung
        // that climb reached is the one that failed — sprints stop under it.
        if (climbOnTrial && liveSeconds - climbAt <= CLIMB_PUNISH_S) {
          const failed = from + 1;
          if (failed > sprintFloor) sprintFloor = failed;
          if (sprintFloor > LADDER.length - 1) sprintFloor = LADDER.length - 1;
          climbOnTrial = false;
        }
      } else {
        // A climb. Acquit the previous one first — it held for its whole window
        // — and give a rung of the wall back for it.
        if (climbOnTrial && liveSeconds - climbAt > CLIMB_PUNISH_S && sprintFloor > 0) {
          sprintFloor--;
        }
        climbAt = liveSeconds;
        climbOnTrial = true;
      }
    }

    let entry: QualityChange | null = null;
    if (from !== index) {
      const b = ctx.budget;
      if (log.length >= 24) log.shift();
      // One insertion sort of at most sixty-four floats, once per rung change,
      // so that `changeMs` gets a denominator belonging to the same moment it
      // does. Taken here, before `clearWindow()` below empties the window it
      // reads. See `QualityChange.medianMs`.
      measureWindow();
      entry = {
        t: +liveSeconds.toFixed(2),
        from,
        to: index,
        why,
        wallMs: +wallMean.toFixed(1),
        workMs: +workMean.toFixed(2),
        bound: b ? boundBy(b) : '',
        phase: ctx.race?.phase ?? '',
        raceTime: +(ctx.race?.time ?? 0).toFixed(2),
        sinceFlag: sinceFlag(),
        frontEnd: frontEndOpen,
        covered: frontEndCovers,
        heldFor: +(frontEndOpen ? frontEndFor : ceremonyFor).toFixed(2),
        scale: liveScale,
        scaleWanted: LADDER[index]!.scale,
        seamRung: seamIndex,
        deferred: deferredLevers(),
        medianMs: +wallMedian.toFixed(1),
        changeRatio: 0,
        changeMs: 0,
      };
      log.push(entry);
    }

    overFor = 0;
    underFor = 0;
    panicFor = 0;
    overFrames = 0;
    underFrames = 0;
    panicFrames = 0;
    settleFor = 0;
    settleFrames = 0;
    // Everything measured before a change was measured about a different game.
    clearWindow();
    // ...and the frames the window is about to discard are this change's own
    // reallocation. Measure them into the entry rather than throwing them away
    // — see `SKIP_FRAMES`. Set after `clearWindow`, which clears the pointer.
    changeEntry = entry;
    holding = why;
    publish();
    // The same channel main.ts's own `setQuality` uses, so lighting, fx, the
    // contact pass and the menus' 3D set all re-read on one event as they
    // already do. Nothing new has to subscribe for this file to work.
    //
    // ── ...and the render scale rides on it ──────────────────────────────────
    //
    // `renderScale` is by a long way the largest thing this ladder spends, and
    // until now it was published only into `budget.renderScale`, which is a
    // field the engine's `stats()` reports rather than a thing anybody is told
    // about. That left the one surface in the game with a second renderer of
    // its own — the front-end's set, `src/ui/menus/stage.ts` — sizing its
    // backing store from a hardcoded `Math.min(1, 1200 / w)`, which is 0.75 at
    // 1600x900 and stays 0.75 on a machine the governor has taken to 0.46. A
    // ladder that half the game's 3D cannot hear is half a ladder.
    //
    // No new event: `quality:changed` is already heard by everyone who needs
    // it, and an event nobody has subscribed to is the bug ARCHITECTURE §7
    // spends three paragraphs on. Existing listeners destructure `quality` and
    // are unaffected by the extra fields.
    //
    // `scale` on the wire is what the drawing buffer **has**, not what the rung
    // asks for. Between seams those differ (see `flushScale`), and a listener
    // sizing its own backing store off a number that is not yet true would draw
    // its set at a resolution the canvas does not have.
    ctx.bus.emit('quality:changed', {
      quality: ctx.quality, scale: liveScale, rung: index, label: r.label,
    });
  }

  /**
   * Record what the frame cost before a cut, so the cut can be judged.
   *
   * Both drop sites go through here, and it takes the **median** and its
   * standard error rather than the mean — the two numbers the verdict compares
   * have to be the same statistic measured the same way, or the comparison is
   * an artefact. The panic path calls this with as few as `PANIC_SAMPLES`
   * frames in the window, which is fine and is the point: a noisy `before`
   * produces a large `seBefore`, which widens the bar, which is exactly how a
   * verdict taken on thin evidence is supposed to fail — as `unresolved`,
   * rather than as a confident wrong answer.
   */
  /**
   * How many rungs one emergency change is worth, from how far over budget the
   * machine measurably is.
   *
   * **One change, not three.** Every version of the moment gate up to round four
   * asked "may I change the picture now" and never "how many times am I about
   * to ask that": measured, six changes in two hundred seconds with three of
   * them inside three and a half race-seconds of the flag, so a player who had
   * just timed a good launch watched the picture step down four times while
   * their rocket start was still burning. A machine forty times too slow is not
   * one rung away from the target and the number that says so is right there.
   *
   * `RUNG_GAIN` is what one rung is worth as a ratio; the log is therefore "how
   * many rungs is this gap". Clamped at both ends — never less than one, never
   * more than the whole ladder (`PANIC_MAX_STEP`).
   */
  function sizedStep(): number {
    if (wallMean <= 0) return 1;
    const over = wallMean / (TARGET_MS * DOWN_FACTOR);
    if (over <= 1) return 1;
    const n = Math.round(Math.log(over) / Math.log(RUNG_GAIN));
    return n < 1 ? 1 : n > PANIC_MAX_STEP ? PANIC_MAX_STEP : n;
  }

  /**
   * ── ...and the same question pointed the other way ─────────────────────────
   *
   * The fall was sized in round eight and the climb was not, and a reviewer
   * measured what that asymmetry is worth on a real circuit: the drop path can
   * pop six rungs in `COLLAPSE_DWELL` — 1.2 seconds — and the climb was a
   * hardcoded `index - 1` behind `UP_DWELL` 9s, `SETTLE` 2.2s **and**
   * `onAStraight()`, which over 480 samples spanning 120 seconds of Cone Canyon
   * was open on 110 of them (22.9%). Walking back up what one GC pause took
   * cost about seventy seconds — most of a three-lap race spent at 640x360 and
   * a sixth of the grandstand, on a machine that was fine.
   *
   * An asymmetry between the two directions is correct and stays: a hitch may
   * cost a rung, nothing wins one back by accident, and the *dwells* are where
   * that caution belongs (1.2s down against 9s up, plus the straight). What is
   * not correct is that the caution was also spent on the **size**, so a machine
   * that had proved nine seconds of headroom was handed one rung for it.
   *
   * ── What "how far under" means when the display is pacing you ──────────────
   *
   * `sizedStep` reads the gap in wall time, which is the honest instrument on
   * the way down because a machine that is missing is *visibly* missing. On the
   * way up it is nearly useless and this file already says why (`UP_WORK_MS`): a
   * vsync-locked 16.7ms is the same reading on a machine with 60% headroom and
   * on one with none, so `TARGET_MS / wallMean` saturates at 1.0 and would
   * answer "one rung" for every healthy machine there is — which is exactly the
   * behaviour being fixed.
   *
   * So the size comes off the **work**, which is the measure that can still see
   * headroom under a paced frame, and the wall is consulted only when it is not
   * saturated (`wallBest` — even the *best* frame in the window sitting on the
   * vsync period is the tell). Both are converted through `RUNG_GAIN`, the same
   * ratio `sizedStep` uses, so "three rungs of room" means the same thing in
   * both directions.
   *
   * ── ...and the damper, because a sized climb can be wrong ──────────────────
   *
   * CPU headroom is not proof of fill headroom, and the ladder's largest lever
   * is resolution. A sized climb is therefore a *bet*, and an unbounded bet that
   * is repeatedly wrong is the oscillation this whole file exists to avoid — six
   * up, six down, every thirteen seconds, which would be worse than the seventy
   * seconds it replaces.
   *
   * `sprintFloor` is the bound. It is the best rung a **multi-rung** climb is
   * allowed to reach, and it is set by evidence rather than by a constant: climb,
   * get dropped inside `CLIMB_PUNISH_S`, and the rung that failed becomes the
   * wall — sprints stop one rung short of it and everything above it is explored
   * a single rung at a time, which is exactly today's behaviour. A climb that
   * survives its window relaxes the wall by one, so a machine whose conditions
   * genuinely improved is not capped for the session. The amplitude of any
   * oscillation therefore *decays*: the first wrong bet is the last big one.
   */
  const rungsOfRoom = (ceiling: number, have: number): number =>
    (have <= 0 ? 1 : Math.floor(Math.log(ceiling / have) / Math.log(RUNG_GAIN)));

  function sizedClimb(): number {
    if (workMean <= 0) return 1;
    let n = rungsOfRoom(UP_WORK_MS, workMean);
    // The wall clock only gets an opinion when something other than the display
    // is setting the frame period. `wallBest` is the whole window's best frame;
    // if even that is a vsync period, the mean cannot be evidence of headroom.
    if (wallBest > 0 && wallBest < TARGET_MS * PACED_FRAC) {
      const byWall = rungsOfRoom(TARGET_MS, wallMean);
      if (byWall < n) n = byWall;
    }
    return n < 1 ? 1 : n > UP_MAX_STEP ? UP_MAX_STEP : n;
  }

  function markDrop(): void {
    measureWindow();
    wallBefore = wallMedian;
    seBefore = medianSe(wallMad, wallCount);
    verdictPending = true;
    verdictFrames = 0;
  }

  /** Give up on a pending verdict without deciding it, and say so. Used by the
   *  frame-counted deadline and by any edge that makes the two halves of the
   *  comparison describe different scenes — the front-end coming up over the
   *  race is the obvious one. */
  function abandonVerdict(): void {
    if (!verdictPending) return;
    verdictPending = false;
    if (verdicts.length >= 16) verdicts.shift();
    verdicts.push({
      t: +liveSeconds.toFixed(2),
      rung: index,
      call: 'abandoned',
      beforeMs: +wallBefore.toFixed(1),
      afterMs: 0,
      gain: 0,
      bar: 0,
      samples: wallCount,
    });
  }

  /**
   * The nearest rung to a `QualitySettings` somebody else installed.
   *
   * Only used to re-synchronise after a manual pick, so that turning the
   * governor back on later does not start it from a rung the game is not on.
   */
  function nearestRung(q: QualitySettings): number {
    let best = 0;
    let bestErr = Infinity;
    for (let i = 0; i < LADDER.length; i++) {
      const s = LADDER[i]!.settings;
      const err = (s.tier === q.tier ? 0 : 4)
        + Math.abs(s.drawDistance - q.drawDistance) * 2
        + Math.abs(s.particles - q.particles);
      if (err < bestErr) { bestErr = err; best = i; }
    }
    return best;
  }

  /**
   * Is this a moment the player would not forgive a visible change at?
   *
   * Three questions in the order they can be trusted — the front-end's edge,
   * the pause edge, and only then `race.phase`, which ARCHITECTURE §11a says
   * outright cannot see the front-end. A session where the phase was the only
   * opinion made three of five rung changes with the roster on the display and
   * logged `phase: intro` for every one of them.
   *
   * ── Every refusal here is a *wait*, not a wall ────────────────────────────
   *
   * The version this replaces opened `if (frontEndOpen || paused) return true;`
   * and answered `true` unconditionally for every sealed phase. Three of those
   * four refusals have the property the header names as the class of bug this
   * file keeps losing rounds to: **their cost in wall seconds is proportional
   * to the slowness they are gating.** `engine.ts` caps the fixed step at eight
   * per frame, so once a frame costs more than 66ms the simulation drops into
   * slow motion and every beat measured in race-seconds stretches to match.
   * Measured on one live session: 50 seconds held at `front-end`, then a
   * 56-second countdown seal, and the first rung change at `liveSeconds` 69.96
   * on a machine that had been failing since frame one.
   *
   *   front-end   `FRONT_END_PATIENCE`  12s
   *   intro       `CEREMONY_PATIENCE`   20s
   *   sealed      `SEAL_PATIENCE`       35s — countdown, finish, results
   *   the launch  `LAUNCH_PATIENCE`     22s — the flag and the rocket start
   *   loading     no door               boot, and the pause screen
   *
   * `loading` keeps its wall for the reason the others lost theirs: it is not
   * slowed by the frame rate. Boot ends when the game is built and the pause
   * screen ends when the player presses a key, and a paused game is the same
   * still frame over and over.
   *
   * The doors are on the **emergency path only** by construction: the ordinary
   * path asks `frontEndOpen` and `pictureLocked()` as separate questions above
   * this one and refuses on either. A steady-state window taken behind the
   * front-end is a measurement of the menu's own set, not of the race.
   *
   * ...and the collapse path does not ask at all — at five times the budget
   * there is no composed picture to protect. See `COLLAPSE_DWELL`.
   */
  function pictureLocked(): boolean {
    // A still frame with a plate over it. No door — see above.
    if (paused) return true;
    // Nobody is driving, and nothing behind the menu is even being drawn.
    if (frontEndOpen) return frontEndFor < FRONT_END_PATIENCE;
    const phase = ctx.race?.phase;
    if (phase === 'loading') return true;
    if (phase === 'intro') return ceremonyFor < CEREMONY_PATIENCE;
    if (isComposed(phase)) return ceremonyFor < SEAL_PATIENCE;
    // The flag's own beat and the launch that follows it, on the fixed-step
    // clock rather than on the wall clock — see `CEREMONY_GRACE`. `flagAt` is
    // latched on the `race:racing` edge, so this is the same gesture at every
    // frame rate instead of one frame at 0.7fps, and a seek re-arms it instead
    // of walking straight past it. `flagFor` is the door: the same beat costs
    // forty-seven wall seconds on a machine at 0.7fps and 2.2 on one that is
    // fine, and only the first of those is a wait worth arguing about.
    return ctx.time.elapsed - flagAt < CEREMONY_GRACE && flagFor < LAUNCH_PATIENCE;
  }

  /**
   * Is the front-end covering the entire frame with its own opaque set?
   *
   * The answer `budget.skipDraw` is built from, evaluated once per delivered
   * frame. See `frontEndCovers` for why it is three facts rather than one, and
   * `FrameBudget.skipDraw` for what it buys.
   */
  function frontEndOpaque(): boolean {
    if (!frontEndOpen || handingOver || !stageEl) return false;
    // The menus fade their whole backdrop to zero the frame the hand-off
    // starts, so this is the owning module telling us it has stopped covering
    // anything — one inline-style read, no layout, no allocation.
    return stageEl.style.opacity !== '0';
  }

  /**
   * Is this a moment the player would forgive a visible change?
   *
   * Straight road under them, straight road ahead of them, planted, and nothing
   * in flight. A corner is where every frame this governor is trying to save
   * gets spent, so it is also exactly where a naive one would do all of its
   * switching.
   *
   * The ceremony gate is inside here as well as in front of the call, so that
   * this function cannot answer "yes, go ahead" during a countdown to a caller
   * who forgot to ask — the start/finish straight is the straightest road on
   * the course and the grid sits on it, so every frame of every countdown is a
   * straight by the curvature test alone.
   */
  function onAStraight(): boolean {
    if (pictureLocked()) return false;
    const p = ctx.player;
    if (!p) return true;
    if (p.drift.active || p.boost.time > 0 || !p.grounded || p.stunned > 0) return false;
    const track = ctx.track;
    if (!track || !here || !ahead) return true;
    track.sample(p.pos, here);
    if (Math.abs(here.curvature) > STRAIGHT) return false;
    const reach = Math.max(12, Math.abs(p.speed)) * LOOKAHEAD;
    for (let i = 1; i <= 3; i++) {
      track.spline.atDistance(here.distance + (reach * i) / 3, ahead);
      if (Math.abs(ahead.curvature) > STRAIGHT) return false;
    }
    return true;
  }

  /**
   * Compile — and now *draw* — every render state any rung can ask for, before
   * any rung asks for it.
   *
   * ── Why this exists ────────────────────────────────────────────────────────
   *
   * Measured on the previous ladder: switching to the floor rung took the
   * program count from 75 to 101 and cost a **762ms** frame — the ladder's
   * rescue move being, by a factor of three, the worst hitch of the session. A
   * governor whose emergency brake is itself an emergency is not a governor.
   *
   * The real fix is upstream and is in `LADDER`: no rung introduces a shader
   * variant the top rung has not already drawn, because none of them turns the
   * post stack or the shadow map off. This is the proof and the belt to that
   * braces. It walks the ladder's *distinct render states* — the combinations
   * of `shadows`, `postfx` and `aa` that actually change which programs three
   * builds — applies each one, and asks the renderer to compile the scene under
   * it. On the current ladder that is a single state and a single compile,
   * which is exactly the point: if somebody adds a rung that flips one of those
   * flags, the cost lands here, at a load screen, instead of on the frame that
   * was already failing.
   *
   * Deliberately *not* in `init()`'s own body: systems are initialised before
   * the first `startRace`, so at that moment the scene is empty and compiling
   * it compiles nothing. It runs from `reset()`, once per course per session,
   * with the world built and immediately before main.ts's own priming frame.
   *
   * ── What it deliberately does NOT do, and the measurement that says so ─────
   *
   * The review that sent this file back asked for the ladder's *buffers* to be
   * pre-sized here as well as its programs — the eight post-stack render
   * targets and the shadow map, at every rung — on the reading that a rung
   * change costing 3.1x a steady frame with a flat program count (85, checked)
   * had to be buffer reallocation. The first half of that is exactly right. The
   * second half names the wrong buffers, and pre-sizing would have bought
   * nothing at all.
   *
   * Measured live at 320x180 under a software rasteriser, on the page's own rAF
   * loop, one lever at a time, each against the median delivered frame
   * immediately before it (~200-225ms):
   *
   *   the whole rung change, 0 -> 3                 596ms   +371
   *   render scale 1.00 -> 0.68, nothing else       541ms   +348
   *   render scale 0.68 -> 1.00, nothing else       530ms   +329
   *   shadow map 2048 -> 768, nothing else          492ms   +262
   *   shadow map 768 -> 2048, nothing else          190ms      0
   *   `quality:changed` emitted, settings unchanged 259ms    +34
   *   drawDistance 1.00 -> 0.76, nothing else       212ms      0
   *   the eight post targets resized by hand        229ms      0
   *   `setSize` to the size the canvas already has  197ms      0
   *   the same rung change, size already allocated  558ms   +330
   *
   * Four things fall out of that, and the third is the one the directive turns
   * on:
   *
   *   - **The post stack's targets are free.** `sceneTarget`, `ldrTarget`, the
   *     depth texture and the five bloom mips, all eight resized in one go,
   *     cost less than the noise on a frame. Pre-sizing them would pre-size
   *     nothing worth having.
   *   - **The canvas drawing buffer is the whole bill.** Render scale on its
   *     own is +348ms in *both* directions, and it is the only thing a scale
   *     change does that the row above it does not. It is a swap-chain rebuild,
   *     not a texture allocation — resizing the canvas to the size it already
   *     has is free, because Blink early-outs on an unchanged size.
   *   - **Pre-sizing cannot help, because nothing is cached.** The last row is
   *     the same change repeated to a size the driver had already allocated and
   *     freed once, at full price. Walking the six rung sizes at load would
   *     cost six of these reallocations — about two seconds of boot — to buy
   *     the zero that measurement says is there. So it is not done.
   *   - **The shadow map's *size* carries a hitch of its own.** Shrinking it
   *     from 2048 to 768 is +262ms on its own, the same shape as the render
   *     scale and for the same reason — a depth attachment disposed and rebuilt
   *     — while growing it back measured nothing. Four of the ladder's five
   *     transitions moved it, for a lever the same table prices at 2% of a
   *     steady frame. This paragraph used to end "it stays"; it does not. See
   *     `SHADOW_PX`, which is one number for the whole ladder now.
   *
   * ── ...and what happened to the last row ──────────────────────────────────
   *
   * "One drawing-buffer reallocation per rung change" is what changing the
   * render resolution *was*, and this comment concluded it "cannot be removed
   * from this file". Measured live at 1280x720 rather than on a 320x180 bench,
   * that reallocation was **3101ms and 1494ms** — the two largest frames of a
   * two-hundred-second run against a median of 875ms and 512ms.
   *
   * The conclusion was wrong in one word: it cannot be removed *from a frame*.
   * Round six moved it off the frames the player is being shown, and the review
   * that followed found the price of that — the player's *current* race is the
   * one race the ladder could not rescue. Round eight removed it instead, using
   * row three of the table above: **the eight post targets resized by hand,
   * 229ms against a 225ms median — zero.** The expensive thing was never
   * "changing the resolution", it was `setPixelRatio` rebuilding the *canvas*.
   * `render/post.ts` now implements `setRenderScale`, the scene target, the
   * depth texture and the five bloom mips follow the scale, the composite
   * resolves onto a canvas that never moves, and `scaleFlushes` stays at 0 for
   * the life of the session. See `freeScalePath`.
   *
   * Either way the number is published instead of hidden: every change carries
   * its own `changeMs`, `probe().changeWorstMs` is the worst of the session,
   * and `probe().sessionMedianMs` is the frame it should be compared against.
   */
  let precompiledFor = '';
  function precompileLadder(): void {
    const key = ctx.track?.id ?? '';
    if (!ctx.scene || !ctx.camera) return;
    if (precompiledFor === key && key !== '') return;
    precompiledFor = key;

    const before = ctx.quality;
    const seen = new Set<string>();
    for (const r of LADDER) {
      const s = r.settings;
      // Only the flags that change the *program*. `shadowSize`, `particles`,
      // `drawDistance` and the render scale reallocate buffers and cull
      // objects; none of them recompiles anything.
      const state = `${s.shadows}|${s.postfx}|${s.aa}`;
      if (seen.has(state)) continue;
      seen.add(state);
      ctx.quality = s;
      ctx.renderer.shadowMap.enabled = s.shadows;
      try {
        ctx.renderer.compile(ctx.scene, ctx.camera);
        // ── ...and one real composed frame per state ──────────────────────
        //
        // `compile()` builds the GL *program*. It does not draw, and on a
        // software rasteriser a program is not the expensive half: SwiftShader
        // JITs a pixel routine per pipeline state on the first **draw** into a
        // given framebuffer, and the composite drawn straight to the back
        // buffer (which is what `aa: false` means, see `render/post.ts`) is the
        // largest shader in the game — atmosphere, clouds, bloom, film stock,
        // vignette, dither, full screen.
        //
        // Measured live, that showed up as the one hitch left on the ladder
        // after the swap-chain rebuild was gone: a rung 0 -> 3 change costing
        // 2.5x an ordinary frame, on a change whose every other lever is a
        // field write. So the state is *drawn* here as well as compiled, once
        // per distinct state, at the same load screen — behind the launch
        // board, which is covering the canvas edge to edge, so the frame goes
        // nowhere.
        ctx.composer?.render(0);
      } catch {
        // A compile failure here is a warm-up that did not happen, not a bug in
        // the game — the material will compile on its first draw as it always
        // did. Never let it take the boot down.
        break;
      }
    }
    ctx.quality = before;
    ctx.renderer.shadowMap.enabled = before.shadows;
    ctx.renderer.shadowMap.needsUpdate = true;
  }

  const probe = (): QualityProbe => {
    const b = ctx.budget;
    const q = ctx.quality;
    // Called by hand, so the sort is free here. Everything else in this file
    // reads the two fields it writes without recomputing them.
    measureWindow();
    return {
      auto,
      benched,
      rung: index,
      label: LADDER[index]?.label ?? String(q.tier),
      tier: q.tier,
      scale: +liveScale.toFixed(3),
      scaleWanted: +(LADDER[index]?.scale ?? 1).toFixed(3),
      scalePending: Math.abs(liveScale - (LADDER[index]?.scale ?? 1)) > 1e-3,
      scaleFree: freeScalePath() !== null,
      scaleFlushes,
      scaleSteps,
      scaleFlushWhy: lastFlushWhy,
      scaleRamping: ramping,
      scaleRampFrames: rampFrames,
      scenePx: `${Math.max(2, Math.round(bufW() * liveScale))}x${Math.max(2, Math.round(bufH() * liveScale))}`,
      canvasPx: `${bufW()}x${bufH()}`,
      seamRung: seamIndex,
      pending: deferredLevers(),
      drawDistance: +q.drawDistance.toFixed(3),
      particles: +q.particles.toFixed(3),
      shadowSize: q.shadows ? q.shadowSize : 0,
      remembered: memoryRung,
      rememberedSeed: memorySeeded,
      memoryKey,
      content: {
        crowd: content.crowd, scatter: content.scatter,
        thinFar: content.thinFar, minPx: content.minPx, shellPx: content.shellPx,
        crowdLive: seamContent.crowd, scatterLive: content.scatter,
        scatterFar: +(content.thinFar * content.scatter).toFixed(3),
        crowdGeos: contentCrowd, batches: contentScatter,
        cullables: contentCullable, shells: contentShells,
        culled: culledNow, shelled: shelledNow, thinned: thinnedNow,
      },

      wallMs: +wallMean.toFixed(2),
      wallMedianMs: +wallMedian.toFixed(2),
      wallMadMs: +wallMad.toFixed(2),
      sessionMedianMs: +sessionMedian().toFixed(2),
      sessionSamples: sessionCount,
      sessionWorstMs: +sessionWorst().toFixed(2),
      wallWorstMs: +wallWorst.toFixed(2),
      wallBestMs: +wallBest.toFixed(2),
      lateFrac: +lateFrac.toFixed(3),
      samples: wallCount,
      fps: wallMean > 0 ? +(1000 / wallMean).toFixed(1) : 0,

      workMs: +workMean.toFixed(3),
      meanMs: +(b?.meanMs ?? 0).toFixed(3),
      worstMs: +(b?.worstMs ?? 0).toFixed(3),
      simMs: +(b?.meanSimMs ?? 0).toFixed(3),
      drawMs: +(b?.meanDrawMs ?? 0).toFixed(3),
      bound: b ? boundBy(b) : '',

      dwell: +(settleFor < SETTLE ? settleFor - SETTLE : overFor || underFor).toFixed(2),
      liveSeconds: +liveSeconds.toFixed(2),
      holding,
      futile,
      stalled,
      // The climb's own state, so "why did it only take one rung back" is a
      // readable question rather than an inference off the log. See `sizedClimb`.
      climbStep: sizedClimb(),
      lastClimbStep,
      sprintFloor,
      climbOnTrial,
      suspended,
      hijacked,
      undrawn,
      phase: ctx.race?.phase ?? '',
      locked: pictureLocked(),
      frontEnd: frontEndOpen,
      frontEndCovers,
      frontEndFor: +frontEndFor.toFixed(2),
      ceremonyFor: +ceremonyFor.toFixed(2),
      paused,
      raceTime: +(ctx.race?.time ?? 0).toFixed(2),
      sinceFlag: sinceFlag(),
      changeMs: +lastChangeMs.toFixed(1),
      changeWorstMs: +changeWorst.toFixed(1),
      changeWorstRatio: +changeWorstRatio.toFixed(2),
      log,
      verdicts,
    };
  };

  /**
   * What the frame is actually made of, walked off the live scene graph.
   *
   * "Measure first, then cut" needs somewhere to read the measurement, and
   * `stats()` reports one number for the whole world. This groups every drawn
   * node by the top-level scene child it hangs under and reports triangles,
   * draw calls and instance counts per group, so "757k triangles" becomes a
   * list with a worst offender at the top of it.
   *
   * Called by hand from a bench, never per frame — it allocates freely and
   * walks the whole graph.
   *
   * ── ...and the instancing audit, which is the half that names a culprit ────
   *
   * A per-group triangle count tells you *where* the frame went and never *what
   * to do about it*. The rule the budget is actually held to is ARCHITECTURE
   * §2.5 — anything that appears more than a handful of times is instanced —
   * and a rule that nobody can run is a rule nobody keeps. So the walk also
   * buckets every drawable by the pair that decides whether two draws can ever
   * become one, its **geometry and its material**, and reports every bucket
   * drawn more than `REPEAT_BAR` times as a separate mesh. Each of those is a
   * draw call that an `InstancedMesh` or a merge would remove, named, with its
   * cost attached, in `offenders`.
   *
   * ── Read `materials` next to `calls`, and read `offenders` being empty ─────
   *
   * Run on a racing frame with the whole field in view, `offenders` comes back
   * **empty** — nothing in this game draws the same geometry-and-material pair
   * more than eight times without instancing it. That is not a null result, it
   * is the finding: the draw calls are not going where a missing `InstancedMesh`
   * would put them. Read `materials` next to `meshes` and the answer is
   * immediate:
   *
   *   group      calls   triangles   meshes   materials
   *   Group        745      36,362      187          75   <- the seven racers
   *   world        171     516,356      121           7
   *   track         34     167,102       23          22
   *   itemRig       37       4,790       22          15
   *
   * Sixty-eight percent of the frame's draw calls for four percent of its
   * triangles, and seventy-five materials across seven machines. Two things
   * follow, and only one of them is what it looks like.
   *
   * `mat()` in `vehicles/parts.ts` **is** cached, by colour and options, so
   * those seventy-five are seventy-five genuinely different paints and no
   * amount of merging goes below them — an earlier draft of this comment said
   * the opposite and was wrong. What can go is the *meshes*: a hundred and
   * eighty-seven of them across seven machines, where merging by material
   * identity gives about eleven a machine. That is what `Shell` does, and
   * because it is the same geometry in the same materials it is the one cut on
   * the whole ladder that changes no pixel at all.
   *
   * ── ...and read `items`, which is the row a cut can be aimed at ────────────
   *
   * `groups` says where the frame went. It never says what to do, because "the
   * world is 516k triangles" is not a lever. `items` is the same walk bucketed
   * by the name each module gave its own meshes, and on the same frame it names
   * the two things the content rungs actually spend:
   *
   *   world:cone         807 instances    74,244 tri   0.6m across
   *   world:crowd0..2     30 instances   140,808 tri  12.1m
   *   world:standCrowd*    3 instances    59,124 tri  11.5m
   *   world:drum          96 instances    16,512 tri   0.7m
   *   world:tyres         85 instances    15,300 tri   0.9m
   *   track:ground          1 instance    61,952 tri   the landscape field
   *
   * Eight hundred traffic cones at ninety-two triangles each, and a crowd that
   * is a fifth of everything drawn. See `ContentTrim`.
   *
   * ── ...and the same walk on the heaviest course in the game (round 7) ──────
   *
   * Switchback Summit, twelve seconds into a race at 1600x900. The shape is the
   * same and every number is bigger, which is why this is the course the seam
   * rule was measured on:
   *
   *   all              1,110 calls   911,700 tri   436 meshes   168 materials
   *   world              216         623,872      146             7
   *   track               36         192,712       25            24
   *   Group (7 racers)   773          36,790      189            74
   *   itemBoxes            5          25,792        6             6
   *
   *   world:cone       1,022 instances    94,024 tri   0.6m across
   *   world:crowd0..2     32 instances   150,152 tri  12.1m
   *   world:standCrowd*    3 instances    59,124 tri  11.5m
   *
   * **The crowd is 209k triangles — twenty-three percent of everything the
   * scene graph holds.** That is why it is the ladder's most valuable content
   * lever and, in the same breath, why spending it in front of the player was
   * the thing a reviewer noticed from across the room. It is now spent at a
   * seam and nowhere else; see `SEAM_HELD`.
   *
   * `offenders` is still **empty** on this course too, with a field of seven and
   * a thousand cones on the verge: nothing in this game draws the same
   * geometry-and-material pair more than eight times without instancing it.
   *
   * ── ...and this is not `renderer.info` ────────────────────────────────────
   *
   * This walks `traverseVisible`, which is the `visible` flag and nothing else.
   * The renderer draws what survives the *frustum* on top of that, so
   * `stats().drawCalls` on the same frame reads lower — 303 against 774 here —
   * and the gap is the half of the world that is behind the camera. Use this to
   * find what the frame is made of; use `stats()` for what it cost.
   */
  interface AuditRow {
    group: string;
    calls: number;
    triangles: number;
    instances: number;
    /** Drawable nodes. `instances / meshes` is the instancing audit: anything
     *  that appears more than eight times should be a handful of meshes with a
     *  lot of instances, never a lot of meshes. */
    meshes: number;
    /** Top-level scene children that fell into this row — the vehicle roots are
     *  unnamed, so all seven collapse into one, and the row means nothing
     *  without knowing that. */
    nodes: number;
    casts: number;
    /** Draws this row owes to *multi-material* meshes, over and above one per
     *  mesh. A merge that keeps N materials produces N draws and saves nothing,
     *  which is a merge that looks done and is not. */
    matGroups: number;
    /** Distinct materials. Two parts the same colour built through two calls to
     *  `mat()` are two materials and therefore two draws, however identical
     *  they look — so this is the number a merge has to bring down. */
    materials: number;
    /**
     * ── The half that reconciles with `stats()` ──────────────────────────────
     *
     * `calls` above is what the scene graph *holds*: every visible drawable,
     * plus a second draw for every caster. It is the right number for "what is
     * this world made of" and it is not the number the frame cost — the
     * renderer culls against the view frustum on top of `visible`, and on a
     * racing frame at 1600x900 that gap is 1135 against 479.
     *
     * Three rounds of this file's own header quoted the first number in tables
     * captioned with the second, and a reviewer correctly convicted it: an
     * audit at 457, a ladder table at 189 and a `framehalf` table at 473, all
     * claiming to be one frozen racing frame, none of them equal to what
     * `renderer.info` said about that frame. So the walk now culls the way the
     * renderer does and reports both.
     *
     *   `drawn`   colour-pass draws that survive the camera frustum
     *   `shadow`  caster draws that survive the *shadow* camera's frustum
     *
     * `drawn + shadow` summed over the groups is the frame the renderer
     * submits, short only of the post stack's own full-screen passes (a fixed
     * cost this walk cannot see and `stats().drawCalls` includes). Measured on
     * the `racing` shot it lands inside a handful of calls of `stats()`, which
     * is what makes the tables in this file checkable rather than quotable.
     */
    drawn: number;
    shadow: number;
    /** ...and the triangles behind `drawn`. The shadow pass rasterises the
     *  caster's triangles a second time, which is why `stats().triangles` is
     *  larger than any colour-pass count and why a triangle ceiling has to say
     *  which of the two it means. */
    drawnTriangles: number;
  }
  /** Separate meshes of the same geometry+material above which the pair should
   *  have been one instanced draw. ARCHITECTURE §2.5 says ~20; eight is the
   *  bar this file's own brief sets and the stricter of the two. */
  const REPEAT_BAR = 8;
  interface AuditOffender {
    /** Where it lives, and what it is. */
    group: string;
    name: string;
    /** Separate draws of the identical geometry+material pair. */
    draws: number;
    /** ...and what collapsing them to one instanced draw would save. */
    savesCalls: number;
    triangles: number;
  }
  /**
   * One named thing in the frame, which is the row a *cut* can be aimed at.
   *
   * `groups` says the world is 362k triangles and `offenders` says nothing is
   * un-instanced, and between them they still do not say what to do: "the world
   * is expensive" is not a lever. This is the list that is — every drawable
   * bucketed by the name its own module gave it (`world:crowdBank`,
   * `land:mass`, `track:barrier`), with the two facts a content rung decides on
   * next to the cost: how big the thing is in metres, and how far off the road
   * it lives.
   */
  interface AuditItem {
    group: string;
    name: string;
    calls: number;
    triangles: number;
    meshes: number;
    instances: number;
    /** Of `calls`, the ones this frame's frustums actually submitted. See
     *  `AuditRow.drawn` — the whole reason this file's old tables disagreed. */
    drawn: number;
    shadow: number;
    /** Mean world-space bounding radius of the meshes in this row, metres. */
    radius: number;
    /** ...and the mean distance from the camera at the moment of the audit. */
    dist: number;
  }
  function audit(): {
    total: AuditRow; groups: AuditRow[]; offenders: AuditOffender[];
    items: AuditItem[];
  } {
    const rows = new Map<string, AuditRow>();
    const blank = (name: string): AuditRow => ({
      group: name, calls: 0, triangles: 0, instances: 0, meshes: 0, nodes: 0,
      casts: 0, matGroups: 0, materials: 0,
      drawn: 0, shadow: 0, drawnTriangles: 0,
    });
    const total = blank('all');
    const mats = new Map<string, Set<unknown>>();
    const row = (name: string): AuditRow => {
      let r = rows.get(name);
      if (!r) { r = blank(name); rows.set(name, r); }
      if (!mats.has(name)) mats.set(name, new Set());
      r.nodes++;
      return r;
    };

    interface DrawableLike {
      isMesh?: boolean;
      isInstancedMesh?: boolean;
      isPoints?: boolean;
      isLine?: boolean;
      name?: string;
      count?: number;
      castShadow?: boolean;
      geometry?: {
        uuid?: string;
        index?: { count: number } | null;
        drawRange?: { start: number; count: number };
        getAttribute?(name: string): { count: number } | undefined;
      };
      material?: unknown;
    }

    /** geometry+material pair -> how many separate meshes draw it. */
    const pairs = new Map<string, AuditOffender>();
    /** ...and group+name -> what that named thing costs. */
    const named = new Map<string, AuditItem>();
    const _c = new ctx.THREE.Vector3();

    // ── the two frustums the renderer actually culls against ────────────────
    //
    // Rebuilt here rather than cached, because `audit()` is a bench call that
    // allocates freely by contract and a cached frustum would be a frame old.
    // The shadow camera is found by walking for the first light that casts;
    // `shadow.updateMatrices` is what the renderer itself calls before the
    // shadow pass, so asking for it here means the test matches the pass even
    // when the audit is taken between renders.
    const T = ctx.THREE;
    const _m4 = new T.Matrix4();
    const viewFrustum = new T.Frustum();
    _m4.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
    viewFrustum.setFromProjectionMatrix(_m4);
    let shadowFrustum: THREE.Frustum | null = null;
    if (ctx.quality.shadows) {
      ctx.scene.traverse((o) => {
        if (shadowFrustum) return;
        const light = o as unknown as {
          isLight?: boolean; castShadow?: boolean;
          shadow?: {
            camera?: THREE.Camera;
            updateMatrices?(light: unknown): void;
          };
        };
        if (!light.isLight || !light.castShadow || !light.shadow?.camera) return;
        light.shadow.updateMatrices?.(o);
        const cam = light.shadow.camera;
        const f = new T.Frustum();
        _m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        f.setFromProjectionMatrix(_m4);
        shadowFrustum = f;
      });
    }
    const _sphere = new T.Sphere();
    /** Does the renderer submit this node, or does the frustum eat it? */
    const inView = (o: THREE.Object3D, f: THREE.Frustum | null): boolean => {
      if (!f) return false;
      if (o.frustumCulled === false) return true;
      const m = o as unknown as {
        boundingSphere?: THREE.Sphere | null;
        computeBoundingSphere?(): void;
        geometry?: { boundingSphere?: THREE.Sphere | null; computeBoundingSphere?(): void };
      };
      // InstancedMesh carries its own sphere over the whole population; a plain
      // mesh's lives on the geometry. Same order the renderer reads them in.
      let bs = m.boundingSphere;
      if (bs === null && m.computeBoundingSphere) { m.computeBoundingSphere(); bs = m.boundingSphere; }
      if (!bs) {
        const g = m.geometry;
        if (g && !g.boundingSphere) g.computeBoundingSphere?.();
        bs = g?.boundingSphere ?? null;
      }
      if (!bs) return true;
      _sphere.copy(bs).applyMatrix4(o.matrixWorld);
      return f.intersectsSphere(_sphere);
    };

    for (const top of ctx.scene.children) {
      const name = top.name || top.type;
      const r = row(name);
      const seenMats = mats.get(name)!;
      top.traverseVisible((o) => {
        const mesh = o as unknown as DrawableLike;
        if (!mesh.isMesh && !mesh.isPoints && !mesh.isLine) return;
        const geo = mesh.geometry;
        if (!geo) return;
        // The **drawn** count, not the resident one. A crowd geometry the
        // content rung has trimmed with `setDrawRange` still owns all its
        // indices; reporting those would make the audit contradict
        // `renderer.info` at exactly the rungs the audit exists to explain.
        const whole = geo.index?.count ?? geo.getAttribute?.('position')?.count ?? 0;
        const ranged = geo.drawRange?.count ?? Infinity;
        const verts = ranged < whole ? ranged : whole;
        const n = mesh.isInstancedMesh ? (mesh.count ?? 0) : 1;
        // A multi-material mesh is one draw per group.
        const list = Array.isArray(mesh.material) ? mesh.material : null;
        const groups = list ? list.length : 1;
        r.meshes++;
        r.instances += n;
        if (n > 0) r.calls += groups;
        r.matGroups += groups - 1;
        if (list) for (const m of list) seenMats.add(m);
        else if (mesh.material) seenMats.add(mesh.material);
        const tris = ((verts / 3) | 0) * n;
        r.triangles += tris;
        if (mesh.castShadow && n > 0) r.casts += groups;
        if (n > 0 && inView(o, viewFrustum)) {
          r.drawn += groups;
          r.drawnTriangles += tris;
        }
        if (mesh.castShadow && n > 0 && shadowFrustum && inView(o, shadowFrustum)) {
          r.shadow += groups;
        }

        // The named bucket — the one a cut can be aimed at. Radius and
        // distance come off the geometry's own bounding sphere pushed through
        // the node's world matrix, which is what a screen-size test would use.
        {
          const key = `${name}/${mesh.name || o.type}`;
          let it = named.get(key);
          if (!it) {
            it = {
              group: name, name: mesh.name || o.type,
              calls: 0, triangles: 0, meshes: 0, instances: 0,
              drawn: 0, shadow: 0, radius: 0, dist: 0,
            };
            named.set(key, it);
          }
          it.meshes++;
          it.instances += n;
          if (n > 0) it.calls += groups;
          it.triangles += tris;
          if (n > 0 && inView(o, viewFrustum)) it.drawn += groups;
          if (mesh.castShadow && n > 0 && shadowFrustum && inView(o, shadowFrustum)) {
            it.shadow += groups;
          }
          const node = o as unknown as {
            geometry?: { boundingSphere?: { radius: number; center: THREE.Vector3 } | null;
              computeBoundingSphere?(): void };
            matrixWorld: THREE.Matrix4;
          };
          const g = node.geometry;
          if (g && !g.boundingSphere) g.computeBoundingSphere?.();
          const bs = g?.boundingSphere;
          if (bs) {
            const s = o.matrixWorld.elements;
            const sx = Math.hypot(s[0]!, s[1]!, s[2]!);
            it.radius += bs.radius * sx;
            _c.copy(bs.center).applyMatrix4(o.matrixWorld);
            it.dist += _c.distanceTo(ctx.camera.position);
          }
        }

        // The instancing bucket. Instanced meshes are already the answer and
        // are skipped; everything else is a candidate to be one.
        if (mesh.isInstancedMesh || n <= 0) return;
        const mid = list
          ? list.map((m) => (m as { uuid?: string }).uuid ?? '?').join(',')
          : ((mesh.material as { uuid?: string } | undefined)?.uuid ?? '?');
        const key = `${name}|${geo.uuid ?? '?'}|${mid}`;
        const hit = pairs.get(key);
        if (hit) {
          hit.draws++;
          hit.savesCalls += groups;
          hit.triangles += tris;
          if (!hit.name && mesh.name) hit.name = mesh.name;
        } else {
          pairs.set(key, {
            group: name,
            name: mesh.name || (o.parent?.name ?? ''),
            draws: 1,
            savesCalls: 0,
            triangles: tris,
          });
        }
      });
      // Shadow casters are drawn a second time, into the map.
      if (ctx.quality.shadows) r.calls += r.casts;
    }

    for (const r of rows.values()) {
      r.materials = mats.get(r.group)?.size ?? 0;
      total.calls += r.calls;
      total.triangles += r.triangles;
      total.instances += r.instances;
      total.meshes += r.meshes;
      total.nodes += r.nodes;
      total.casts += r.casts;
      total.matGroups += r.matGroups;
      total.materials += r.materials;
      total.drawn += r.drawn;
      total.shadow += r.shadow;
      total.drawnTriangles += r.drawnTriangles;
    }
    const groups = [...rows.values()].sort((a, b) => b.triangles - a.triangles);
    const offenders = [...pairs.values()]
      .filter((p) => p.draws > REPEAT_BAR)
      .sort((a, b) => b.savesCalls - a.savesCalls);
    const items = [...named.values()]
      .map((it) => ({
        ...it,
        radius: +(it.radius / Math.max(1, it.meshes)).toFixed(1),
        dist: +(it.dist / Math.max(1, it.meshes)).toFixed(1),
      }))
      .sort((a, b) => b.triangles - a.triangles);
    return { total, groups, offenders, items };
  }

  return {
    name: 'quality',
    // After everything that draws and before the HUD, so a readout that wants
    // to show the tier sees this frame's answer rather than last frame's.
    order: 95,

    init(): void {
      here = blankSample(ctx);
      ahead = blankSample(ctx);

      // ── what this machine settled at last time ───────────────────────────
      //
      // `START_RUNG` used to be the whole of this, on every page load, with no
      // storage of any kind — so a machine that needs the floor walked the
      // entire ladder in front of the player every session. Measured on the run
      // that sent this round back: fifty-seven seconds of delivered play from
      // boot to the rung it had already reached the session before.
      //
      // Read *before* the first `applyRung`, and `index` is moved by hand first
      // so that seeding is not logged as a change: it did not cost a frame,
      // nothing was on screen, and charging it to `changeWorstMs` would put a
      // boot-time reallocation on the governor's conduct record.
      memoryKey = hardwareKey(ctx);
      const remembered = readMemory(memoryKey);
      if (remembered >= 0) {
        memoryRung = remembered;
        memorySeeded = true;
        index = remembered;
        // The seam follows by hand here rather than through `flushSeam`, for
        // the same reason `index` does: a remembered rung is where the session
        // *starts*, not somewhere it has travelled to, and a seam that had to
        // catch up would log the boot as a deferral.
        seamIndex = remembered;
      }
      // Start from a known rung rather than inheriting whatever main.ts built,
      // so `index` and `ctx.quality` cannot disagree from the first frame.
      applyRung(index, memorySeeded ? 'remembered' : 'settling');
      // Seam one of three. Nothing has been drawn yet, so the drawing buffer,
      // the crowd and the verge can all be built at the remembered rung for
      // free — which is the entire point of remembering it. See `flushSeam`.
      flushSeam('boot');

      // ── the two edges the race phase cannot give us ──────────────────────
      //
      // ARCHITECTURE §11a. The front-end sits over a race that is already
      // simulating, and the pause screen is a still frame of the game with a
      // plate on it; `race.phase` reports `intro`/`racing` for the first and
      // `loading` for the second, which is also what it reports at boot. The
      // modules that own those screens publish both edges, `race/director.ts`
      // has always stood off them, and this file believing the phase instead
      // is what put three rung changes on a title screen.
      //
      // Both edges also empty the window, and that is not housekeeping: the
      // menus draw their own 3D set through the same post stack, so a mean
      // that straddles the curtain is a mean across two different scenes, and
      // a futility verdict that straddles it is comparing one scene's median
      // against another's. `liveSeconds` deliberately keeps running — the
      // machine did not get faster because a menu came up, and the warm-up is
      // about the machine.
      ctx.bus.on<{ open: boolean }>('ui:menu', (e) => {
        const open = e?.open === true;
        if (open === frontEndOpen) return;
        frontEndOpen = open;
        ceremonyFor = 0;
        ceremonyPhase = '';
        frontEndFor = 0;
        // A fresh front-end session is not a hand-off, and the set it hides
        // behind is worth finding again — `createStage()` can decline, and a
        // front-end with no set of its own must never have the race behind it
        // turned off. Looked up rather than held from boot because this file is
        // constructed before the menus mount their DOM.
        if (open) {
          handingOver = false;
          if (!stageEl && typeof document !== 'undefined') {
            stageEl = document.querySelector<HTMLElement>('#menu canvas.stage');
          }
        }
        // Synchronously, because this edge arrives from inside the menus' own
        // `update` — after ours, before the draw. See `republishCover`.
        republishCover();
        abandonVerdict();
        // **A futility verdict belongs to the scene it was measured on.**
        //
        // The curtain is a scene change, in both directions: on one side the
        // race with its draw switched off behind a set this ladder does not
        // size, on the other the race itself. Carrying `stalled` across it is
        // how a governor that correctly measured "cutting does not help this
        // title screen" arrives at the flag unable to cut anything, and how one
        // that gave up on a race would refuse to help the next front-end. The
        // *rung* carries — that is a statement about the machine — and the
        // verdict about whether this ladder's levers reach does not.
        stalled = false;
        futile = 0;
        clearWindow();
        overFor = 0; underFor = 0; panicFor = 0;
        overFrames = 0; underFrames = 0; panicFrames = 0;
        settleFor = 0; settleFrames = 0;
      });
      // The flag itself, from the module that drops it. `setPhase` emits this
      // on the transition into `racing` and `setPhaseQuiet` does not, so a
      // resume from pause cannot counterfeit a start. See `CEREMONY_GRACE`.
      ctx.bus.on('race:racing', () => { flagAt = ctx.time.elapsed; flagFor = 0; });
      ctx.bus.on<{ on: boolean }>('race:pause', (e) => {
        const on = e?.on === true;
        if (on === paused) return;
        paused = on;
        frontEndFor = 0;
        // A paused game renders the same still frame over and over for as long
        // as the player leaves it, which is neither this machine's speed nor
        // this scene's cost. Measuring it would flatter the ladder into
        // climbing on evidence made of a frozen picture.
        abandonVerdict();
        clearWindow();
        overFor = 0; underFor = 0; panicFor = 0;
        overFrames = 0; underFrames = 0; panicFrames = 0;
        settleFor = 0; settleFrames = 0;
      });

      // Seam three of three. The browser has just rebuilt the drawing buffer
      // for a window the player dragged, so a second rebuild inside the same
      // gesture is invisible — and the alternative is a machine that resizes
      // its window and keeps the resolution of the window it used to have.
      // `engine.ts`'s `resize()` fires this whenever the *ratio* moves too, so
      // our own flush re-enters here exactly once and finds nothing to do.
      ctx.bus.on('engine:resize', () => { flushSeam('resize'); });

      // ── the only two things that mean "that was not a frame" ─────────────
      //
      // See the note where `STALL_MS` used to be. `visibilitychange` covers the
      // backgrounded tab and the locked phone; `pageshow` covers a bfcache
      // restore, which on some browsers arrives without a visibility edge. Both
      // do the same thing — mark the *next* gap as spanning a suspension — and
      // neither of them looks at how long anything took.
      if (typeof document !== 'undefined' && document.addEventListener) {
        pageHidden = document.visibilityState === 'hidden';
        const onVisible = (): void => {
          const hidden = typeof document !== 'undefined'
            && document.visibilityState === 'hidden';
          if (hidden) {
            pageHidden = true;
          } else if (pageHidden) {
            pageHidden = false;
            resumed = true;
          }
        };
        // `persisted` only, and that word is doing real work: `pageshow` also
        // fires on the *first* load, so without the test every session starts
        // by reporting one suspended frame it never had. A restore from the
        // back/forward cache is the case this is here for, and it is the only
        // one that sets the flag.
        const onShow = (e: Event): void => {
          if (!(e as PageTransitionEvent).persisted) return;
          resumed = true;
          pageHidden = false;
        };
        document.addEventListener('visibilitychange', onVisible);
        globalThis.addEventListener?.('pageshow', onShow);
        offVisibility = (): void => {
          document.removeEventListener('visibilitychange', onVisible);
          globalThis.removeEventListener?.('pageshow', onShow);
        };
      }


      // A tier chosen by hand — a player in an options screen, a reviewer
      // calling `__GAME.setQuality('low')` — is a decision, and a measurement
      // does not get to overrule a decision. Identity is the test: our own
      // emit carries the object we just wrote.
      ctx.bus.on<{ quality: QualitySettings }>('quality:changed', (e) => {
        if (!e?.quality || e.quality === applied) return;
        auto = false;
        applied = e.quality;
        index = nearestRung(e.quality);
        // Bring the render resolution to the rung that pick lands on, or a
        // reviewer who asks for `high` after the ladder has been to the floor
        // gets high's shadows and the floor's pixels, and photographs a state
        // no rung describes.
        //
        // Flushed **immediately** rather than deferred to a seam, and that is
        // not an exception to the seam rule — it is the rule. The seam rule
        // exists because a reallocation the player did not ask for is a hitch
        // they did not ask for. A hand pick is a decision somebody just made,
        // and answering it two race-builds later would be a settings menu that
        // does not work. The whole seam moves, not only the buffer: a player who
        // picks `low` and gets the floor's resolution over rung 0's crowd has
        // been shown a state no rung describes.
        //
        // `installSettings` is deliberately *not* called on this path. The
        // settings object on the wire is the pick, and composing our own over
        // the top of it would be the ladder overruling a decision.
        seamIndex = index;
        applySeamContent(LADDER[seamIndex]!.content);
        applyFrameContent(LADDER[index]!.content);
        applyScale(LADDER[index]!.scale);
        flushScale('pinned');
        clearWindow();
        holding = 'pinned';
      });

      (globalThis as unknown as Record<string, unknown>).__QUALITY = {
        probe,
        /** Hand the ladder back to the measurement, or take it away. */
        auto(on: boolean): boolean {
          auto = on !== false;
          if (auto) {
            overFor = 0; underFor = 0; panicFor = 0; settleFor = 0;
            liveSeconds = 0;
            clearWindow();
          }
          externalTouch();
          return auto;
        },
        /** Pin a rung by index. For the bench — a player picks a tier. */
        set(i: number): number {
          auto = false;
          applyRung(i, 'pinned');
          // A bench asking for rung 5 is asking to *photograph* rung 5, so the
          // whole of rung 5 — its resolution and its populations — has to be
          // real before the next `render()`. Same argument as the hand-pick path
          // above; see `flushSeam`.
          flushSeam('pinned');
          holding = 'pinned';
          // After `applyRung`, which is what opens the measurement window this
          // is spoiling. See `externalTouch`.
          externalTouch();
          return index;
        },
        /**
         * Apply an arbitrary state and hold it, for the cost bench.
         *
         * The ladder's numbers in the comment above are only worth what the
         * measurement behind them is worth, and the measurement needs to move
         * one lever at a time against a frozen sim state — which no combination
         * of `set()` calls can do, because a rung moves five levers at once.
         *
         * The recipe, for whoever re-measures this after the course changes
         * under them again: `__GAME.seek('racing')`, `step()` to a real racing
         * moment, `__GAME.setTimeScale(0)` to freeze it, then `try()` each
         * configuration and take the *median rAF period* over a few seconds,
         * interleaved so page warm-up cannot flatter whichever went first.
         */
        try(trim: Partial<QualitySettings>, scale?: number): QualityProbe {
          auto = false;
          const q: QualitySettings = { ...ctx.quality, ...trim };
          ctx.quality = q;
          applied = q;
          ctx.renderer.shadowMap.enabled = q.shadows;
          ctx.renderer.shadowMap.needsUpdate = true;
          if (typeof scale === 'number') { applyScale(scale); flushScale('bench'); }
          clearWindow();
          holding = 'pinned';
          externalTouch();
          ctx.bus.emit('quality:changed', {
            quality: q,
            scale: liveScale,
            rung: index,
            label: LADDER[index]!.label,
          });
          return probe();
        },
        /**
         * Install a rung's **frame-half only** and leave the seam where it is.
         *
         * Exactly what a mid-race rung change does, and the only way to bench
         * the half of the ladder that is allowed to move while the player is
         * watching: `set()` installs a whole rung, which is a race build.
         *
         * The recipe for "does the governor still have anything to spend
         * mid-race": `set(0)` to put the seam at the top, then `mid(1..6)` and
         * read the triangles and draw calls off `__GAME.stats()` each time.
         * That walk is the ladder a player gets inside one race; the difference
         * between it and the `set()` walk is what the next race build lands.
         *
         * That difference is much smaller than it was. Round eight moved
         * `scale` and `tier` out of the seam-held half and round nine moved
         * `scatter`, so the only levers a `mid()` walk still cannot reach are
         * `crowd`, `aa` and `drawDistance` — and the two largest things on the
         * table, the resolution and the verge, are both in the walk. Note that
         * triangles and draw calls are the *wrong* instrument for the first of
         * those and the right one for the second: `mid(0)` to `mid(6)` used to
         * move 654 triangles, which is what round nine is about.
         */
        /**
         * Ask for a rung's frame-half the way the **governor** does, and leave
         * the resolution to travel on its own.
         *
         * The one thing `set()` and `mid()` cannot show, because both of them
         * land the scale on the spot so that the next `render()` photographs
         * the rung asked for. What a player actually gets is a dissolve, and a
         * dissolve is only visible in a sequence: call this, then read
         * `probe().scale` on each of the next few delivered frames and watch it
         * walk. `scaleRamping` is true until it arrives.
         *
         * Exists because "is that a dissolve or a cut" is the question round
         * nine was sent back for, and it was unanswerable from outside the page
         * — the only two doors into the ladder both cut on purpose.
         */
        ease(i: number): QualityProbe {
          auto = false;
          applyRung(i, 'pinned (easing)');
          contentFrame();
          externalTouch();
          return probe();
        },
        mid(i: number): QualityProbe {
          auto = false;
          applyRung(i, 'pinned (frame-half)');
          // The frame-half includes the resolution and the tier since round
          // eight, and `serviceScale`'s rate limit is denominated in delivered
          // play — which a frozen bench does not accrue, so a walk of `mid(0)`
          // to `mid(6)` inside one `page.evaluate` would land the first step
          // and refuse the other five. The bench is not a player; land it.
          flushScale('bench');
          contentFrame();
          externalTouch();
          return probe();
        },
        /** What the frame is made of, by scene group. See `audit`. */
        audit,
        /**
         * Judge the last drawn frame against the stated ceilings. See `RUNG0`.
         *
         * The gate lives here rather than in `tools/capture.mjs` for one
         * reason: this file already carried three tables of "one frozen racing
         * frame" that disagreed with each other and with the game, and a gate
         * holding a fourth copy of the numbers would have been a fourth thing
         * to keep in step. The ceiling a reviewer reads in `RUNG0` is the
         * ceiling the build fails on, because it is the same object.
         *
         * `cpuMs` is normalised: `budget.simMs` is however many fixed steps
         * that frame ran, and a bench runs three times as many as a player. See
         * `STEPS_AT_60` — without it the smoke test would convict the game on
         * the arithmetic of the harness driving it.
         *
         * Reports rather than refuses when the frame is not the one the
         * ceilings describe. A rung-4 frame is *supposed* to be cheaper and a
         * frame drawn at 640x360 proves nothing about the top of the ladder, so
         * `applies` says whether this reading is the one the budget is about
         * and the caller decides what to do with a `false`.
         */
        gate(): {
          target: FrameCeiling;
          frame: {
            drawCalls: number; triangles: number; cpuMs: number; cpuSamples: number;
            simMs: number; updateMs: number; steps: number;
            drawn: number; shadow: number; drawnTriangles: number;
          };
          rung: number;
          scenePx: string;
          applies: boolean;
          pass: boolean;
          failures: string[];
          /** Where the draws went, worst first — so a failure names a culprit
           *  instead of a number. */
          groups: Array<{ group: string; drawn: number; shadow: number; triangles: number }>;
        } {
          const b = ctx.budget;
          const info = ctx.renderer.info;
          const steps = b && b.steps > 0 ? b.steps : 1;
          // The median of the window, not the last frame. See `CPU_WINDOW` —
          // the six shots of one review sheet reported 1.2 to 7.1ms of update
          // for the same game, and a ceiling enforced against the last frame
          // would be a coin toss.
          const cpuMs = cpuMedian();
          const simPerFrame = cpuSimRing;
          const updateMs = cpuUpdRing;
          const a = audit();
          const drawCalls = info.render.calls;
          const triangles = info.render.triangles;
          const applies = index === 0 && liveScale > 0.999;
          const failures: string[] = [];
          if (drawCalls > RUNG0.drawCalls) {
            failures.push(`draw calls ${drawCalls} over the rung-0 ceiling of `
              + `${RUNG0.drawCalls} (${RUNG0.at})`);
          }
          if (triangles > RUNG0.triangles) {
            failures.push(`triangles ${triangles} over the rung-0 ceiling of `
              + `${RUNG0.triangles} (${RUNG0.at})`);
          }
          // Against `cpuMs`, not `cpuTargetMs`. The target is a statement and
          // this is a gate; see the field's own note on why they differ.
          if (cpuMs > RUNG0.cpuMs) {
            failures.push(`sim+update ${cpuMs.toFixed(2)}ms over the ceiling of `
              + `${RUNG0.cpuMs}ms — median of ${cpuCount} frames, sim normalised `
              + `to ${STEPS_AT_60} steps (last frame: sim ${simPerFrame.toFixed(2)} `
              + `+ update ${updateMs.toFixed(2)})`);
          }
          return {
            target: RUNG0,
            frame: {
              drawCalls,
              triangles,
              cpuMs: +cpuMs.toFixed(3),
              cpuSamples: cpuCount,
              simMs: +simPerFrame.toFixed(3),
              updateMs: +updateMs.toFixed(3),
              steps,
              drawn: a.total.drawn,
              shadow: a.total.shadow,
              drawnTriangles: a.total.drawnTriangles,
            },
            rung: index,
            scenePx: `${Math.max(2, Math.round(bufW() * liveScale))}x`
              + `${Math.max(2, Math.round(bufH() * liveScale))}`,
            applies,
            pass: failures.length === 0,
            failures,
            groups: a.groups
              .filter((g) => g.drawn + g.shadow > 0)
              .sort((x, y) => (y.drawn + y.shadow) - (x.drawn + x.shadow))
              .map((g) => ({
                group: g.group, drawn: g.drawn, shadow: g.shadow,
                triangles: g.drawnTriangles,
              })),
          };
        },
        /**
         * Apply a content trim on its own, for the cost bench.
         *
         * The other half of `try()`. A rung moves five settings, a render scale
         * and five content levers together, and the only way to know what any
         * one of them is worth is to move it by itself against a frozen sim
         * state. Passing nothing puts the content back to whatever the standing
         * rung asks for.
         *
         * **Both halves, immediately**, seam or no seam. This is the entry point
         * the seam rule is measured *with* — `levervis` moves `crowd` through it
         * to find out how visible spending it would be — so a version of it that
         * honoured the seam could not measure the thing the seam exists for.
         */
        content(trim?: Partial<ContentTrim>): QualityProbe {
          auto = false;
          const next = trim
            ? { ...LADDER[index]!.content, ...trim }
            : LADDER[index]!.content;
          applyFrameContent(next);
          applySeamContent(next);
          contentFrame();
          clearWindow();
          externalTouch();
          return probe();
        },
        /** Re-take the census by hand, after a bench has rebuilt the world. */
        census(): QualityProbe {
          censusContent();
          buildShells();
          applySeamContent(seamContent);
          applyFrameContent(content);
          externalTouch();
          return probe();
        },
        ladder: LADDER.map((r) => ({
          label: r.label,
          scale: r.scale,
          tier: r.settings.tier,
          shadows: r.settings.shadows,
          shadowSize: r.settings.shadowSize,
          postfx: r.settings.postfx,
          bloom: r.settings.bloom !== false,
          aa: r.settings.aa,
          particles: r.settings.particles,
          drawDistance: r.settings.drawDistance,
          content: r.content,
          /** Which of this rung's levers may only land at a seam. */
          seamHeld: SEAM_HELD,
        })),
      };
    },

    reset(_cfg: RaceConfig): void {
      // A fresh race gets a fresh verdict: whatever the previous one measured
      // was measured against a different course, a different field and, if the
      // harness reset us, a different machine's worth of work.
      overFor = 0;
      underFor = 0;
      panicFor = 0;
      overFrames = 0;
      underFrames = 0;
      panicFrames = 0;
      settleFor = 0;
      settleFrames = 0;
      benchQuietFor = 0;
      verdictPending = false;
      ceremonyFor = 0;
      ceremonyPhase = '';
      // ── the front-end has stopped covering the frame ─────────────────────
      //
      // `ui:menu {open:false}` fires at the *end* of the hand-off, not the
      // start: the launch board closes over the menus, the race is built, the
      // board swings open onto the race, and only then is the front-end
      // declared closed. For the length of that swing the front-end is still
      // open on the wire and the race behind it is the picture the player is
      // being shown. Building the race is the last thing that happens before
      // the reveal, so this is the earliest honest moment to start drawing it
      // again — a whole beat early, which is the right direction to be wrong
      // in. Republished synchronously because `resetAll` is called from inside
      // the menus' own update, after ours and before the draw.
      //
      // ...and that beat is worth having for a second reason, measured: the
      // **first** drawn frame after a stretch of skipped ones costs about two
      // seconds under a software rasteriser — pipeline re-validation, not
      // anything this file can avoid — against 3.8ms for the frame after it.
      // Landing that on the frame the launch board is fully across, with
      // `CARD_HOLD` and the board's whole swing still to come, is the
      // difference between a hitch nobody sees and a two-second freeze in the
      // middle of the one transition the product is built around.
      handingOver = true;
      republishCover();
      // `main.ts` puts `ctx.time.elapsed` back to zero for a new race, so a
      // flag latched against the old clock would read as a flag in the distant
      // future and seal the picture until the new race caught up with it.
      flagAt = -Infinity;
      clearWindow();
      lastFrameAt = 0;
      // `benched` is deliberately *not* cleared: a page that has been driven by
      // the harness once stays a bench. `benchFrames` is, so the frame the
      // front end primes for this race reads as the first one again.
      benchFrames = -1;
      // Neither is `liveSeconds`: the warm-up is about this *machine*, and the
      // machine did not become unknown again because a race restarted. Re-arming
      // it every reset is how a governor spends a whole session warming up.
      //
      // The rung is not reset either. A machine that earned its way down to
      // `med` in the last race has not become faster by starting another one,
      // and re-climbing the ladder every race is the oscillation this whole
      // file exists to avoid — just spread over minutes instead of seconds.
      if (auto && applied !== ctx.quality) applyRung(index, 'settling');
      // ── seam two of three, and the one that matters ──────────────────────
      //
      // The resolution the ladder earned during the last race — or behind the
      // front-end, or in the session before this one — lands *here*, on the
      // frame the launch board is fully across, alongside the shader precompile
      // and immediately before main.ts's own priming render. The paragraphs
      // above have already established that this is the moment the product
      // spends its expensive frames; a canvas reallocation is the cheapest
      // thing on that list.
      //
      // The player therefore never sees the picture change size. It is the size
      // it is going to be before the board opens, and it stays that size for the
      // whole race.
      //
      // **Before** `precompileLadder`, deliberately: what that primes is real
      // draws into the drawing buffer, and priming them at a size the next line
      // is about to throw away would be priming them twice.
      //
      // ── ...and round seven: everything else the seam holds lands here too ──
      //
      // The resolution was the first lever to be deferred and it turned out not
      // to be the only one a player can watch move. The crowd's share, the
      // verge's share, the edge resolve, the tier and the draw distance all
      // arrive on this line now — behind the same closed board, on the same
      // frame, for the same reason. A player who spent the last race watching
      // the ladder walk down four rungs sees the *result* of that walk once,
      // here, and then a race that does not change under them. See `SEAM_HELD`.
      flushSeam('race build');
      // The world is built by the time `resetAll` runs, so this is the first
      // moment there is anything to compile — and it lands immediately before
      // main.ts's own priming render rather than on a frame a player is
      // watching. Once per course per session; see `precompileLadder`.
      precompileLadder();
      // ── the content ladder's own load-time work ──────────────────────────
      //
      // Same moment, same argument, and the two halves have different
      // lifetimes. The census is per *course* — the dressing is a pure
      // function of the track id and `world/index.ts` skips rebuilding an
      // identical one — while the shells are per *field*, because `reset()`
      // hands out new racer objects with new models every race.
      const key = ctx.track?.id ?? '';
      if (censusFor !== key || crowdGeos.length + scatter.length === 0) {
        censusFor = key;
        censusContent();
      }
      buildShells();
      // Whatever rung is standing has to be re-installed onto the new census
      // and the new shells, or a race that starts at rung 5 starts with a full
      // crowd and seven un-merged machines until the governor next moves.
      //
      // Both halves, because the census above has just thrown away the objects
      // the seam flush wrote to — the crowd geometries and the scatter batches
      // are re-found per course, and `flushSeam` ran before that. `seamIndex`
      // and `index` are the same number by now, so this installs one rung.
      applySeamContent(LADDER[seamIndex]!.content);
      applyFrameContent(LADDER[index]!.content);
      // `benchSteps` is re-baselined rather than compared across the reset: the
      // harness took a great many of them getting here and the first live frame
      // after a race build has no previous frame to be spoiled relative to
      // (`lastFrameAt` is 0, so the next live frame takes no sample anyway).
      seenBenchSteps = -1;
      harnessSince = false;
    },

    /**
     * Visuals only, and only ever a read of the budget and the clock. Nothing
     * here is allowed to reach the simulation, and nothing here allocates: the
     * sample buffers are owned, the window is a typed array, and the probe and
     * the log entries are built only when something actually happens.
     */
    update(): void {
      const b = ctx.budget;
      if (!b) return;

      // ── the CPU reading, above every early return and every gate ─────────
      //
      // Unconditional, and it is the one measurement in this file that is
      // *supposed* to include the frames the governor throws away. Everything
      // below this line is the governor asking "is this machine keeping up",
      // which is a question a bench cannot answer and a benched page must not
      // be asked. `RUNG0.cpuMs` asks a different question — "does the game's
      // own work fit in a frame" — and a bench is precisely where that one gets
      // asked, because `tools/capture.mjs` is the thing that runs the gate.
      sampleCpu();

      // ── sample the frame ─────────────────────────────────────────────────
      //
      // `liveFrames` is incremented by the engine at the *top* of `renderFrame`,
      // so by the time we run it already counts this frame. A frame the rAF loop
      // did not drive is a frame whose spacing means nothing.
      const live = b.liveFrames !== seenLive;
      seenLive = b.liveFrames;

      // ── ...and was there a picture in it ─────────────────────────────────
      //
      // `budget.skipDraw` is written at the bottom of *this* function and read
      // by the engine immediately afterwards, so on entry it still holds the
      // verdict that governed the **previous** frame's draw — which is exactly
      // the frame the gap below is about to measure. If that draw was skipped,
      // the race contributed nothing to it: measured on the untouched title
      // screen, 0 draw calls and 0 triangles.
      //
      // ── why this had to change (round eight) ──────────────────────────────
      //
      // Because the governor was judging those frames anyway, and the frames
      // were made of somebody else's work. Sitting on PRESS START for ten
      // seconds with nothing touching `__GAME`, it walked rung 0 -> rung 3 and
      // then reported `panic (judging last cut)` — cutting the *race's* content
      // to pay a bill run up entirely by `ui/menus/stage.ts`'s own second
      // renderer, which this file does not size and which its own notes admit
      // "cannot hear this ladder". Then it wrote the verdict to localStorage,
      // so the wrong answer survived the reload.
      //
      // A frame whose draw this file switched off is not evidence about this
      // file's ladder. It is spoiled for the same reason a harness-driven frame
      // is — something other than the game produced it — and it is counted and
      // reported as `undrawn` in the probe, because an instrument that silently
      // throws things away is how three of the last four rounds were lost.
      const undrawnFrame = live && b.skipDraw;

      // ── did the harness touch anything since the last delivered frame ────
      //
      // Both kinds of harness work block the rAF loop for as long as they run:
      // `step()` inside a `page.evaluate`, which renders nothing at all and can
      // hold the thread for seconds, and `render()` bursts from a capture. The
      // live frame that lands afterwards measures a gap made of somebody else's
      // work. This is a **latch**, not a per-call test, precisely because
      // `step()` never enters `update()`: the change is noticed on whichever
      // call comes next — quite possibly a bench render — and has to survive
      // until a *live* frame consumes it.
      const benchFramesMoved = b.benchFrames !== benchFrames;
      if (b.benchSteps !== seenBenchSteps) {
        if (seenBenchSteps >= 0) harnessSince = true;
        seenBenchSteps = b.benchSteps;
      }
      if (benchFramesMoved && benchFrames >= 0) harnessSince = true;

      let secs = 0;
      /**
       * 1 on a delivered frame this file is allowed to count, 0 otherwise.
       *
       * **The unit every dwell and settle is really in.** A wall second is
       * sixty frames on a machine that is fine and two thirds of one on a
       * machine at 0.7fps, so "wait 1.2s before believing that" and "wait for
       * more than one picture before believing that" are the same sentence on
       * one machine and opposite sentences on the other. Both are now counted
       * and both have to be satisfied. A spoiled frame — the page suspended,
       * the harness driving — is not a picture the player was shown, so it
       * counts for neither.
       */
      let frameTick = 0;
      if (live) {
        const t = nowMs();
        const gap = lastFrameAt > 0 ? t - lastFrameAt : 0;
        lastFrameAt = t;
        // **No upper bound on `gap`.** See the note where `STALL_MS` used to
        // be: a frame is discarded because the page was not running through it,
        // never because it was long. A 2.4 second frame on a visible page is a
        // 2.4 second frame, and it is the whole reason this file exists.
        const spoiled = resumed || pageHidden || harnessSince || undrawnFrame;
        if (spoiled) {
          if (resumed || pageHidden) suspended++;
          else if (harnessSince) hijacked++;
          else undrawn++;
          resumed = false;
          harnessSince = false;
          // A change whose own reallocation window contains somebody else's
          // work has no measurable cost. Latched rather than tested at the
          // recording site because the spoiled frame and the frame that closes
          // the window are usually not the same frame.
          if (changeEntry) changeSpoiled = true;
        } else if (gap > 0) {
          secs = gap / 1000;
          frameTick = 1;
          liveSeconds += secs;
          // The frames right after a change are the change reallocating itself,
          // not the game. They still count as time; they are not evidence.
          //
          // ...and they are no longer thrown away unread. The worst of them is
          // what the change *cost*, which for three rounds was the one number
          // this instrument could not produce about the one hitch it is
          // personally responsible for. See `SKIP_FRAMES`.
          if (skipFrames > 0) {
            skipFrames--;
            // **Only when there is a change to charge it to.** The window is
            // also emptied by things that are not the governor's doing — the
            // front-end opening over the race, a pause, a reviewer pinning a
            // tier — and the frame that spans one of those is somebody else's
            // work. Charged indiscriminately it read `changeWorstMs: 4921.7`
            // on a session whose worst actual rung change was 704ms, which is
            // an instrument lying in the governor's favour rather than against
            // it and is exactly as useless.
            //
            // ...and **only on a page nothing else is driving.** `changeMs` is
            // the one number in this file that is a claim about the governor's
            // own conduct, so it is the one number that must never be inflated
            // by somebody else's work. Measured on a frozen-sim ladder bench
            // where an interleaved measurement put the real cost of a switch at
            // 6-17.5ms, `probe().changeWorstMs` read **15,628.6ms**: the bench
            // drives the ladder from `page.evaluate`, which moves neither
            // `benchSteps` nor `benchFrames`, so the Node round trip that
            // followed each switch was invisible to the `spoiled` test above
            // and landed on the governor's account. `benched` and
            // `changeSpoiled` are the two facts that were missing — see
            // `externalTouch`.
            if (changeEntry) {
              if (benched || changeSpoiled) {
                // Unmeasurable rather than free: leaving `changeMs` at 0 says
                // "nobody timed this", which is true, and is the only thing
                // that is.
                if (skipFrames === 0) changeEntry = null;
              } else {
                if (gap > changeCost) changeCost = gap;
                if (skipFrames === 0) {
                  lastChangeMs = changeCost;
                  if (changeCost > changeWorst) changeWorst = changeCost;
                  changeEntry.changeMs = +changeCost.toFixed(1);
                  const den = changeEntry.medianMs;
                  const ratio = den > 0 ? changeCost / den : 0;
                  changeEntry.changeRatio = +ratio.toFixed(2);
                  if (ratio > changeWorstRatio) changeWorstRatio = ratio;
                  changeEntry = null;
                }
              }
            }
          } else {
            // The session ring takes the same frames the decision window does
            // — the steady ones, with the change reallocations excluded. That
            // exclusion is deliberately the *hard* choice: including them would
            // raise the denominator `changeWorstMs` is judged against using the
            // governor's own hitches, which is grading its conduct on a curve
            // it drew itself.
            session[sessionIdx] = gap;
            sessionIdx = (sessionIdx + 1) % SESSION_WINDOW;
            if (sessionCount < SESSION_WINDOW) sessionCount++;

            wall[wallIdx] = gap;
            // The budget's per-frame fields are written at the *end* of
            // `renderFrame` and we run inside the update pass, so these are the
            // previous frame's costs — which is the frame `gap` just measured.
            work[wallIdx] = b.simMs + b.updateMs + b.drawMs;
            wallIdx = (wallIdx + 1) % WALL_WINDOW;
            if (wallCount < WALL_WINDOW) wallCount++;

            let sum = 0;
            let wsum = 0;
            let worst = 0;
            let best = Infinity;
            let late = 0;
            const lateAt = TARGET_MS * LATE_FACTOR;
            for (let i = 0; i < wallCount; i++) {
              const v = wall[i]!;
              sum += v;
              wsum += work[i]!;
              if (v > worst) worst = v;
              if (v < best) best = v;
              if (v > lateAt) late++;
            }
            wallMean = sum / wallCount;
            workMean = wsum / wallCount;
            wallWorst = worst;
            wallBest = best === Infinity ? 0 : best;
            lateFrac = late / wallCount;
          }
        }
      }

      // ── the moment gate's one remaining clock ────────────────────────────
      //
      // Accrued here, above every early return, because the gate has to be
      // right on the first frame the governor is allowed to act on rather than
      // catching up afterwards — and because a pinned or benched page still
      // walks through a countdown and still deserves an honest `locked` in the
      // probe. `secs` is zero on a frame the rAF loop did not drive, so this
      // counts delivered play like everything else in this file.
      //
      // There used to be two clocks here. The second, `sinceCeremony`, counted
      // delivered-play seconds since the last composed frame and fed the flag's
      // grace — a beat measured in *race* seconds — which is the round-3 bug in
      // one line. That grace reads `ctx.race.time` now and needs no accumulator
      // of ours at all, so the clock is gone rather than converted: a number
      // this file does not keep is a number it cannot get the units of wrong.
      //
      // What remains is the two ceremony valves' and the front-end's, and all
      // three are in wall seconds because all three are about a *person
      // waiting* — see `CEREMONY_PATIENCE`. The ceremony clock is held at zero
      // behind the front-end: a sweep nobody can see is not a sweep anybody is
      // sitting through.
      //
      // It is also **scoped to one beat**. The sweep runs straight into the
      // countdown, so a single accumulator would carry the twenty seconds the
      // intro had already spent into the countdown's account and hand it a
      // valve that was open before the first numeral. Each beat waits out its
      // own patience.
      const nowPhase = ctx.race?.phase ?? '';
      if (frontEndOpen || paused) {
        ceremonyFor = 0;
        ceremonyPhase = '';
      } else if (isComposed(nowPhase)) {
        if (nowPhase !== ceremonyPhase) { ceremonyPhase = nowPhase; ceremonyFor = 0; }
        ceremonyFor += secs;
      } else {
        ceremonyFor = 0;
        ceremonyPhase = '';
      }
      frontEndFor = frontEndOpen ? frontEndFor + secs : 0;
      // ...and the launch's, which is the one clock in this file that measures
      // a *race* beat in wall seconds. See `LAUNCH_PATIENCE`.
      if (flagAt !== -Infinity) flagFor += secs;

      // ── is the race behind the front-end worth drawing at all ────────────
      //
      // Evaluated every delivered frame, above every early return, because it
      // is the one thing this file publishes that a *pinned* or *benched* page
      // still wants: a reviewer who has taken the ladder off auto has not asked
      // for the title screen to start drawing a race nobody can see again. See
      // `frontEndCovers` and `FrameBudget.skipDraw`.
      frontEndCovers = frontEndOpaque();

      // ── the content rung's per-frame half ────────────────────────────────
      //
      // Above every early return, for the same reason `frontEndCovers` is: it
      // is a property of the *frame about to be drawn*, not of the governor's
      // opinion. A pinned page, a benched page and a page whose ladder has
      // stood down all still want the machine two hundred metres away drawn as
      // one mesh rather than as thirty — that is what the rung the reviewer
      // pinned actually means, and a screenshot taken at rung 5 has to be a
      // photograph of rung 5.
      //
      // It is skipped only when there is nothing to draw: no census, no shells
      // and no cover to compute against.
      if (cullables.length || scatter.length || shells.size || shadowShellList.length) {
        contentFrame();
      }

      // ── land any resolution the ladder has earned and not yet been given ──
      //
      // Above the early returns for the same reason the two blocks above it
      // are: a rung the reviewer pinned, or one this session earned before the
      // rate limit would let it land, is a rung whose *picture* has to arrive
      // eventually. `serviceScale` is a no-op on every frame where the buffer
      // already matches, which is almost all of them.
      //
      // It is handed the gap this frame took, because the lever is a ramp and
      // the ramp is paced by the wall clock — see `SCALE_RAMP`. `secs` is zero
      // on a frame this file is not allowed to count, and a frame that was not a
      // picture is worth one 60Hz step rather than a jump.
      serviceScale(secs * 1000);

      // `benchFrames` only moves when `renderFrame` was called from outside the
      // rAF loop: the front end primes exactly one such frame per race start,
      // and the test harness renders them in bursts. Two inside a second and
      // this page is a bench for good. (`benchFramesMoved` above is the same
      // comparison, read before this block consumes it.)
      if (benchFramesMoved) {
        if (benchFrames >= 0 && benchQuietFor < BENCH_BURST) benched = true;
        benchFrames = b.benchFrames;
        benchQuietFor = 0;
      } else {
        benchQuietFor += secs;
      }

      if (!auto) return hold('pinned');
      if (benched) return hold('bench');
      // Nothing of the race was in this frame, so there is nothing in it to
      // judge. Reported under its own name rather than left to read as
      // `priming` or `warming`, both of which describe a governor that is about
      // to have evidence; this one is not. See `undrawnFrame`.
      if (undrawnFrame) return hold('undrawn (race not in this frame)');
      if (benchQuietFor < BENCH_HOLD) {
        overFor = 0;
        underFor = 0;
        overFrames = 0;
        underFrames = 0;
        return hold('priming');
      }

      settleFor += secs;
      settleFrames += frameTick;
      if (verdictPending) verdictFrames += frameTick;

      // ── remember where this machine settles ──────────────────────────────
      //
      // Everything above this line has already established the three facts that
      // make a rung worth recording: the ladder is on automatic (`!auto`
      // returned), nothing is driving the page through the harness (`benched`
      // and `benchQuietFor` returned), and the machine has been warmed. What is
      // added here is the fourth — that the rung has *stayed put*, for both
      // MEMORY_SETTLE_S wall seconds and MEMORY_SETTLE_FRAMES delivered frames,
      // so a rung the ladder merely passed through on its way down is never the
      // one written.
      //
      // One `setItem` per settle, never per frame: `memoryRung` is both what is
      // stored and what we last stored, so a session that settles and stays
      // touches storage exactly once.
      if (index !== memoryRung && liveSeconds >= WARMUP_S
        && wallCount >= MIN_SAMPLES
        && settleFor >= MEMORY_SETTLE_S && settleFrames >= MEMORY_SETTLE_FRAMES) {
        memoryRung = index;
        writeMemory(memoryKey, index);
      }

      // ── the collapse path ────────────────────────────────────────────────
      //
      // **Above everything, including the warm-up sample gate**, because a
      // machine five times over the budget is not a machine that needs more
      // evidence gathered about it — see `COLLAPSE_FACTOR`. It is the only
      // branch in this file that does not consult `pictureLocked()`, and
      // `COLLAPSE_DWELL` is where that is argued.
      //
      // What it fixes, in the reviewer's numbers: fifty to seventy seconds of
      // delivered play to reach the floor, walked as `dropped (panic) x3` twice
      // with a fourteen-sample verdict in between — which at half a frame a
      // second is half a minute on its own. The budget is four seconds.
      const collapsing = wallMean > TARGET_MS * COLLAPSE_FACTOR;
      if (collapsing) {
        collapseFor += secs;
        collapseFrames += frameTick;
      } else {
        collapseFor = 0;
        collapseFrames = 0;
      }
      // The front-end's own cap still binds: behind an opaque menu the race is
      // not drawn at all, so a frame measured there is somebody else's — and
      // since round eight those frames are discarded outright, so this is
      // belt and braces for a front-end that is up but not covering.
      const collapseBottom = frontEndOpen ? FRONT_END_FLOOR : LADDER.length - 1;
      if (collapsing && index < collapseBottom && !stalled && !paused
        && wallCount >= COLLAPSE_SAMPLES
        && collapseFor >= COLLAPSE_DWELL && collapseFrames >= COLLAPSE_FRAMES) {
        markDrop();
        let want = index + sizedStep();
        if (want > collapseBottom) want = collapseBottom;
        const many = want - index > 1 ? ` x${want - index}` : '';
        applyRung(want, `collapsed (${(wallMean / TARGET_MS).toFixed(0)}x budget)${many}`);
        // ...and the half of that rung the seam rule usually holds. A rescue
        // that arrives at the next race build is not a rescue; at this frame
        // rate there is no continuity for the change to break. See
        // `collapseSeam`, which deliberately leaves the resolution on its ramp
        // and leaves the verdict `markDrop` just armed alone.
        collapseSeam();
        return;
      }

      if (wallCount < PANIC_SAMPLES) return hold('warming');

      // ── did the last cut buy anything ────────────────────────────────────
      //
      // **Above the emergency path, and that position is the whole point.**
      //
      // This block used to sit below it, and the emergency path `return`s — so
      // on the only route a genuinely slow machine ever takes, the safeguard
      // that stops cutting when cutting stops working was unreachable code.
      // Measured on the machine it exists for: a drop from rung 1 to rung 2
      // made the frame 77% *worse* and `futile` stayed at 0 for the whole run,
      // because the next frame panicked and returned before this could look at
      // it. A check that only runs when the machine is fine is not a check.
      //
      // Its evidence gate used to be a disjunction — `VERDICT_SAMPLES` frames
      // *or* `VERDICT_WAIT_S` seconds with four frames behind it — and the
      // second half of that was the only half a slow machine ever reached. Four
      // samples of a distribution running 17ms to 1233ms around a 483ms median
      // cannot resolve a 14% step, and live it convicted a drop that a
      // controlled interleave measured at 21-31% cheaper. It is one condition
      // now, it is the sample count, and there is no way round it.
      if (verdictPending && settleFor >= PANIC_SETTLE && settleFrames >= PANIC_SETTLE_FRAMES) {
        if (wallCount >= VERDICT_SAMPLES) {
          verdictPending = false;
          measureWindow();
          const after = wallMedian;
          const se = Math.hypot(seBefore, medianSe(wallMad, wallCount));
          const gain = wallBefore > 0 ? (wallBefore - after) / wallBefore : 1;
          // The bar is the larger of "a rung is worth having" and "this window
          // can tell". On a quiet machine the second term is a rounding error
          // and the bar is `FUTILE_GAIN`; on the machine this check keeps
          // getting wrong on, the second term is a fifth of the frame and says
          // so out loud instead of pretending to a decimal point.
          const bar = wallBefore > 0
            ? Math.max(FUTILE_GAIN, (FUTILE_Z * se) / wallBefore)
            : FUTILE_GAIN;
          let call: string;
          if (gain >= bar) {
            call = 'worked';
            futile = 0;
          } else if (gain <= -bar) {
            // **The frame got worse.** Not "bought nothing" — worse, by more
            // than the window's own error bar, which is the one reading no
            // amount of spread can explain away and the only one on this list
            // that is evidence *against* the direction of travel.
            //
            // It used to be folded in with `futile` and counted as one strike
            // of two, and that cost a live session its frame rate: rung 3 -> 4
            // measured `gain: -0.562` against `bar: 0.188` — 56% worse — and
            // the governor dropped to rung 5 eight tenths of a second later,
            // because the strike before it had been a `worked` and the counter
            // had just been cleared. A cut that is measured to have hurt is
            // undone on the spot; there is nothing a second sample can add
            // that this one has not already said.
            call = 'worse';
            futile = FUTILE_LIMIT;
          } else if (bar <= FUTILE_RESOLVE) {
            // The window is tight enough that a gain this small is genuinely a
            // gain this small.
            call = 'futile';
            futile++;
          } else {
            // The honest answer, and the one this check never used to have.
            // Nothing is decided: `futile` is neither raised nor cleared, the
            // ladder is free to carry on, and the reading is in the probe with
            // the bar it could not clear next to it.
            call = 'unresolved';
          }
          if (verdicts.length >= 16) verdicts.shift();
          verdicts.push({
            t: +liveSeconds.toFixed(2),
            rung: index,
            call,
            beforeMs: +wallBefore.toFixed(1),
            afterMs: +after.toFixed(1),
            gain: +gain.toFixed(3),
            bar: +bar.toFixed(3),
            samples: wallCount,
          });
          if ((call === 'futile' || call === 'worse') && futile >= FUTILE_LIMIT && index > 0) {
            // Two cuts in a row that changed nothing, or one that made things
            // worse. Whatever is holding this machine up is not on this ladder,
            // so put the last one back and stop spending the game's looks on it.
            //
            // ── what this means once half of a rung lands later (round 7) ────
            //
            // It fires more readily than it used to, and on this machine it is
            // *right for the wrong reason*: measured live on Switchback Summit,
            // rung 3 -> 6 was scored `worse` and stood the ladder down at rung
            // 5, because on a fill-bound box a rung's frame-half buys nothing
            // measurable (see the table on `SEAM_HELD`) and the half that would
            // have bought 2.35x had not been installed yet. The verdict is a
            // true statement about the cut that was made and a false one about
            // the ladder.
            //
            // Two things keep that from being a trap, and they are both
            // deliberate. `flushSeam` clears `stalled` whenever it actually
            // installs something, so the stand-down lasts until the next race
            // build and no longer; and the *rung* survives the roll-back as an
            // index, so a machine converges on its rung over a handful of races
            // instead of inside one. What it costs is that a very slow machine
            // spends its first race at the picture it started with.
            //
            // The alternative was considered and refused: not counting a strike
            // for a change whose levers were deferred would neuter the one case
            // this check exists for — a vsync-locked 30Hz panel, where the frame
            // is 33ms whatever anybody does and the ladder would walk to the
            // floor inside one race and install it at the next build. The check
            // has to be able to convict. See the header's note on `FUTILE_*`.
            stalled = true;
            stalledAt = wallMean;
            futile = 0;
            applyRung(index - 1, call === 'worse'
              ? 'stalled (that drop cost more than it bought)'
              : 'stalled (drops buy nothing)');
            return;
          }
        } else if (verdictFrames >= VERDICT_ABANDON_FRAMES) {
          // Twenty-five delivered frames and the window still has not taken
          // fourteen: frames are being *discarded* faster than they arrive,
          // because seventeen delivered frames fill it by definition. Drop the
          // verdict rather than take it on what is left — an abandoned verdict
          // unblocks the ladder and changes nothing about what the governor
          // believes. Counted in frames precisely so that a slow machine is not
          // the thing that trips it; see `VERDICT_ABANDON_FRAMES`.
          abandonVerdict();
        }
      }

      // Conditions changed enough that the earlier verdict is stale.
      if (stalled && wallMean > stalledAt * RETRY_FACTOR) {
        stalled = false;
        futile = 0;
      }

      // ── the emergency path ───────────────────────────────────────────────
      //
      // Above the warm-up gate and above the settle, because those exist to
      // stop the governor acting on thin evidence and a machine delivering
      // twenty-seven frames a second is not thin evidence. It still needs a
      // fresh window — `PANIC_SAMPLES` frames since the last change emptied it,
      // and `SKIP_FRAMES` of reallocation discarded before those — and a short
      // dwell on top, so no single stalled frame can walk the ladder.
      //
      // It cannot outrun the futility check above it: a panic drop sets
      // `verdictPending`, and `stalled` (which the check may set) clears
      // `canDrop`, so the ladder can be stopped from below even on a machine
      // that is panicking every frame.
      const panic = wallMean > TARGET_MS * PANIC_FACTOR;
      // Behind the front-end the ladder stops at `FRONT_END_FLOOR`: the
      // evidence there is about a frame this file only half owns, and it buys
      // the top of the ladder rather than the whole of it.
      const bottom = frontEndOpen ? FRONT_END_FLOOR : LADDER.length - 1;
      const canDrop = index < bottom && !stalled && !verdictPending;
      if (panic && canDrop && liveSeconds >= PANIC_ARM_S
        && settleFor >= PANIC_SETTLE && settleFrames >= PANIC_SETTLE_FRAMES) {
        // **The line the last three rounds were about.** The emergency path may
        // skip the curvature lookahead — at two frames a second there is no
        // such thing as between corners — but it does not get to change the
        // picture while the game is showing one, and "showing one" now includes
        // the front-end and the pause screen, which `race.phase` cannot report.
        // The dwell restarts rather than banking, so the drop lands a beat into
        // the racing rather than on the frame the gate opens.
        //
        // Every one of those refusals is now a *wait* rather than a wall — see
        // `pictureLocked` — so this branch can no longer hold a failing machine
        // for the fifty seconds of front-end and fifty-six of countdown that
        // one measured session spent inside it.
        if (pictureLocked()) {
          panicFor = 0;
          panicFrames = 0;
          return hold(frontEndOpen ? 'front-end' : paused ? 'paused' : 'mid-ceremony');
        }
        panicFor += secs;
        panicFrames += frameTick;
        if (panicFor >= PANIC_DWELL && panicFrames >= PANIC_DWELL_FRAMES) {
          markDrop();
          let want = index + sizedStep();
          if (want > bottom) want = bottom;
          // Which gate gave way, on the log line, rather than leaving a
          // reviewer to work out why `frontEnd: true` or `phase: 'countdown'`
          // is not the failure it used to be. `heldFor` on the same entry is
          // how long it had held out, and the multiplier is how many rungs one
          // change is worth — a log line reading `x3` is three pops the player
          // did not see.
          const many = want - index > 1 ? ` x${want - index}` : '';
          applyRung(want,
            frontEndCovers ? `dropped (panic, behind the menu)${many}`
              : isComposed(ctx.race?.phase) ? `dropped (panic, ceremony overran)${many}`
                : `dropped (panic)${many}`);
          return;
        }
        return hold('panic');
      }
      panicFor = 0;
      panicFrames = 0;
      if (panic && verdictPending) return hold('panic (judging last cut)');
      // The front-end has spent everything it is allowed to spend. Say which
      // wall this is rather than leaving `panic` on a governor that has stopped
      // panicking — the rest is the race's to earn. See `FRONT_END_FLOOR`.
      if (panic && frontEndOpen && index >= FRONT_END_FLOOR) {
        return hold('front-end (floor)');
      }

      if (wallCount < MIN_SAMPLES) return hold('warming');
      if (liveSeconds < WARMUP_S) return hold('warming');
      if (settleFor < SETTLE || settleFrames < SETTLE_FRAMES) return hold('settling');

      // ── the ordinary verdict ─────────────────────────────────────────────
      const over = wallMean > TARGET_MS * DOWN_FACTOR || lateFrac > DOWN_LATE_FRAC;
      const under = wallMean < TARGET_MS * UP_FACTOR
        && lateFrac < 0.03
        && workMean < UP_WORK_MS
        && b.worstMs < UP_WORST_MS;

      if (over) {
        overFor += secs;
        overFrames += frameTick;
        underFor = 0;
        underFrames = 0;
      } else if (under) {
        underFor += secs;
        underFrames += frameTick;
        overFor = 0;
        overFrames = 0;
      } else {
        overFor = 0;
        underFor = 0;
        overFrames = 0;
        underFrames = 0;
        return hold('in band');
      }

      // `!verdictPending` on the way down: a cut that has not been judged yet
      // is a cut whose `wallBefore` a second cut would overwrite, and the pair
      // would then be scored against each other instead of against the frame
      // they were both meant to improve. One cut at a time, judged, then the
      // next. Climbing is unaffected — a climb clears the pending verdict
      // because the thing it was judging has been undone.
      const wantDown = overFor >= DOWN_DWELL && overFrames >= DOWN_DWELL_FRAMES
        && index < LADDER.length - 1 && !stalled && !verdictPending;
      const wantUp = underFor >= UP_DWELL && index > 0;
      if (!wantDown && !wantUp) {
        return hold(over
          ? (stalled ? 'over budget (stalled)'
            : verdictPending ? 'over budget (judging last cut)' : 'over budget')
          : 'under budget');
      }
      // Three refusals rather than one, because they are three different facts
      // and a probe that reports `mid-corner` over a title screen is lying
      // about which gate stopped it. `onAStraight()` asks the same questions
      // again on its own account — see the note on it.
      if (frontEndOpen) return hold('front-end');
      if (paused) return hold('paused');
      if (pictureLocked()) return hold('mid-ceremony');
      if (!onAStraight()) return hold('mid-corner');
      if (wantDown) {
        markDrop();
        applyRung(index + 1, 'dropped');
      } else {
        verdictPending = false;
        const step = sizedClimb();
        lastClimbStep = step;
        let want = index - step;
        // Above the best rung a climb has been punished at, one rung at a time.
        // See `sprintFloor`: a sprint may take back ground already proved and
        // must not sprint into ground that has not been.
        if (want < sprintFloor) want = Math.min(sprintFloor, index - 1);
        if (want < 0) want = 0;
        const many = index - want > 1 ? ` x${index - want}` : '';
        applyRung(want, `raised${many}`);
      }
    },

    dispose(): void {
      offVisibility?.();
      offVisibility = null;
      // Hand the frame back whole. Everything the content pass does is a
      // switch it holds down, so a governor that goes away without letting go
      // would leave the game running for ever on the last rung's crowd.
      //
      // Both halves and directly, not through `flushSeam`: a seam installs the
      // standing rung and this is the one caller that wants the opposite of a
      // rung. Same argument as `flushScale('dispose')` below.
      applyFrameContent(FULL_CONTENT);
      applySeamContent(FULL_CONTENT);
      contentFrame();
      // ...including the resolution. This file is the only thing in the game
      // that ever moves the pixel ratio off the display's own, so a governor
      // that goes away at half scale leaves the canvas half scale with nobody
      // left to put it back. Same argument as `skipDraw` below.
      wantScale = 1;
      flushScale('dispose');
      clearShells();
      // ...and every machine gets its own casters back. Same argument as the
      // content pass above: this is a switch held down rather than a thing
      // done once, so a governor that goes away without letting go would leave
      // the field casting from a frozen merge for ever.
      clearShadowShells();
      shadowShellMat?.dispose();
      shadowShellMat = null;
      crowdGeos.length = 0;
      scatter.length = 0;
      cullables.length = 0;
      censusFor = '';
      // Hand the draw back on the way out. This file is the only thing that
      // ever sets `skipDraw`, so a governor that is disposed while the
      // front-end happens to be up would otherwise leave the engine refusing to
      // draw with nobody left to change its mind.
      if (ctx.budget) ctx.budget.skipDraw = false;
      stageEl = null;
      delete (globalThis as unknown as Record<string, unknown>).__QUALITY;
    },
  };
}

/** An owned `SplineSample`, so nothing here writes into a shared scratch. */
function blankSample(ctx: GameContext): SplineSample {
  const T = ctx.THREE;
  return {
    pos: new T.Vector3(), tangent: new T.Vector3(),
    right: new T.Vector3(), up: new T.Vector3(),
    width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
  };
}
