// The quality governor: what the game gives up, when, and on whose evidence.
//
// ── Why this is measured and not chosen ─────────────────────────────────────
//
// `config.quality` has always held three tiers and `harness.setQuality` has
// always been able to pick one, and between them that is a settings menu, not a
// frame budget. Nothing in the game had ever *looked* at how long a frame took
// on the machine it was running on. The tier was decided once, at boot, by a
// literal — `makeQuality('high')` in main.ts — and a laptop that could not hold
// sixty frames a second ran the same shadow map, the same draw distance and the
// same particle budget as one that could, and hitched.
//
// ── The instrument comes before the ladder ─────────────────────────────────
//
// The first version of this file walked a ladder against `budget.meanMs`, which
// is *CPU work*: the time spent inside `fixedUpdate`, inside the systems'
// `update`, and inside the call to `renderer.render()`. That last one is the
// trap. `renderer.render()` returns when the command buffer has been handed to
// the driver, not when the picture exists, so on a machine whose GPU is the
// bottleneck it returns almost immediately and the frame's cost lands in the
// *gap before the next callback* where nothing was looking.
//
// Measured live, at 1600x900 on a software rasteriser, that gap was everything:
// `meanMs` averaged 23ms while real frames were arriving 250ms apart. The
// governor read 23, called it "in band", and sat at the top rung for five and a
// half minutes while the player watched four frames a second. A ten-fold
// under-read is not a tuning problem, it is the wrong instrument.
//
// So the verdict is taken from **wall time between delivered frames**, sampled
// here rather than read off `budget.wallMs`, for two reasons: this file needs a
// short window it can reset the moment it changes something, and it needs the
// spread — the worst frame and the share of frames that hitched — not just a
// mean. A game that averages 12ms and stutters to 40ms every twentieth frame is
// not a game running well, and a mean cannot say so.
//
// ── ...and the instrument must not throw away the evidence ─────────────────
//
// Twice now this file has been failed for a *gate* rather than for a ladder,
// and both times the gate had the same shape: a threshold that a slow machine
// could not cross, sitting in front of the machinery that exists for slow
// machines. First a warm-up counted in 240 rendered frames — four seconds at
// sixty and two minutes twenty at 1.7. Then, one layer down, a rule that any
// frame longer than two seconds "was not a frame": on a machine delivering
// frames 1.7 to 2.6 seconds apart, that discarded most of them, and the
// seconds-counted warm-up it was feeding accrued **1.66 seconds in 200 seconds
// of wall time**. The probe read `priming, samples 0` for three minutes.
//
// The rule now: **nothing about a frame's duration is ever evidence that it was
// not a frame.** A frame is discarded only when something observable says the
// page was not running through it — a `visibilitychange` edge, or the harness
// having stepped the simulation inside the gap (`budget.benchSteps`). Both are
// causes, not symptoms, and both are counted and reported in `probe()` as
// `suspended` and `hijacked`, because an instrument that silently throws things
// away is exactly how the last two rounds were lost.
//
// `budget.meanMs`, `meanSimMs` and `meanDrawMs` are still read, but only to
// *attribute* a frame the wall clock has already convicted: work above about
// two thirds of the frame means the CPU is the problem and says which half of
// it, and work far below it means the cost is downstream — the GPU, or vsync.
//
// ── The unit rule: a gate is denominated in the thing it gates ─────────────
//
// Three rounds have now been lost in this file to three different mechanisms
// that share one shape. A warm-up counted in 240 rendered frames, which a
// machine too slow to render cannot reach. A stall filter counted in
// milliseconds, which discarded the exact frames the governor exists to
// measure. And a moment gate that read `race.phase` — which ARCHITECTURE §11a
// says outright cannot see the front-end — with a ceremony grace counted in
// delivered-play seconds against a beat measured in race seconds.
//
// The class is not "counted in frames" or "counted in milliseconds". It is a
// gate denominated in a **different unit from the thing it gates**, in a file
// where the available clocks come apart by three orders of magnitude the
// moment the machine gets slow. At 0.7 delivered frames a second — the state
// this file exists for — one delivered frame is 1.43 seconds of wall time and
// 0.067 seconds of *race* time, because `engine.ts` caps the fixed step at
// eight per frame and the simulation drops into slow motion underneath. A
// second is not a second is not a second.
//
// Four units, and the rule for choosing between them:
//
//   a statistic         → delivered frames. Samples are what a median has.
//   a beat of the game  → race seconds (`ctx.race.time`). The countdown is
//                         three race-seconds long at every frame rate.
//   a person waiting    → wall seconds of delivered play (`liveSeconds`).
//   a machine's speed   → milliseconds between delivered frames.
//
// ...and the corollary, which is the other half of the third round: **a gate
// needs a valve only when the thing it waits for depends on the frame rate.**
// The intro sweep ends when the simulation reaches the end of it, and the
// simulation is slowed by the very cost the governor is trying to cut — a
// genuine circle, and why `CEREMONY_PATIENCE` exists. The front-end ends when
// the player presses a key, and the flag's grace ends after 1.2 race-seconds
// that *every* delivered frame buys 0.067 of. Both are bounded without a
// valve, and fitting them with one would only put the bug back.
//
// ── The audit ──────────────────────────────────────────────────────────────
//
// Every gate, threshold and accumulator in this file, what it is denominated
// in, and what it is worth at 0.7fps. This is the list the third round was
// lost for not having written down:
//
//   WARMUP_S 3             wall s of delivered play   2 frames        ok (*)
//   PANIC_ARM_S 1.4        wall s of delivered play   1 frame         ok (*)
//   MIN_SAMPLES 6          delivered frames           8.6s            ok
//   PANIC_SAMPLES 4        delivered frames           5.7s            ok
//   VERDICT_SAMPLES 14     delivered frames           20s             ok
//   SKIP_FRAMES 3          delivered frames           4.3s            ok (now measured)
//   WALL_WINDOW 64         delivered frames           91s of history  ok
//   DOWN/LATE/PANIC/UP     ms between delivered frames   unchanged    ok
//   UP_WORK_MS, UP_WORST   ms of CPU work             unchanged       ok
//   FUTILE_* , RETRY       dimensionless ratios       unchanged       ok
//   BENCH_HOLD 4, BURST 1  wall s                     3 / 1 frames    ok
//   UP_DWELL 9             wall s under budget        unreachable     ok
//   liveSeconds            wall s of delivered play   honest          ok
//   CEREMONY_PATIENCE 20   wall s inside the sweep    a valve         ok
//
// ...and the five that were wrong, every one of them in the same direction —
// a protection that shrinks to nothing exactly when the machine needs it:
//
//   CEREMONY_GRACE 1.2     was delivered-play seconds, so one frame of cover
//                          for a beat that is 1.2 *race*-seconds long. Now
//                          race seconds, read straight off `ctx.race.time`.
//                          Measured before the fix: rung 3→4 fired between
//                          race time 0.0 and 0.2s, on GO, and rung 4→5 at 1.2s.
//   pictureLocked()        was `race.phase` and nothing else, so the whole
//                          front-end was invisible to it: three of five rung
//                          changes in a live 180-second session were made with
//                          the title screen and the roster on the display, all
//                          three logged `phase: intro`. Now the `ui:menu`
//                          edges and the `race:pause` edges, the way
//                          `race/director.ts` has always done it, with the
//                          phase as the third opinion rather than the only one.
//   VERDICT_ABANDON        was 30 wall seconds, against a window that fills in
//                          *frames*: SKIP_FRAMES + VERDICT_SAMPLES is 17 of
//                          them, which is 24s at 0.7fps and 34s at 0.5 — so
//                          below about 0.55fps every verdict was abandoned and
//                          the futility check could never run at all. Now
//                          delivered frames, and it fires only when frames are
//                          genuinely being discarded.
//   DOWN_DWELL 1.2         wall seconds over budget, which is one frame at
//   PANIC_DWELL 0.35       0.7fps: "never act on a single hitch" had become
//                          "act on a single hitch". Now a wall dwell *and* a
//                          frame count, and the slow machine is bound by the
//                          frames.
//   SETTLE 2.2             wall seconds since a change, which is one frame at
//   PANIC_SETTLE 0.9       0.7fps — so the settle that exists to let a change's
//                          own transient pass could be satisfied by the
//                          transient itself. Now both, same shape.
//
//   (*) `WARMUP_S` and `PANIC_ARM_S` stay in wall seconds on purpose. They
//   gate a statistic, the sample counts beside them are what actually binds on
//   a slow machine, and the thing they are waiting out — shader compilation,
//   texture upload, the JIT — is wall-clock work.
//
// ── The three things that make a governor either useful or a menace ─────────
//
// **0. It must not be a cliff.** Every rung on this ladder keeps the shadow
// map, the post stack and the atmosphere; what comes off is resolution, shadow
// map *size*, particle density, draw distance and — at the floor — the bloom
// pyramid. Nothing on it turns a feature off, which means nothing on it
// recompiles the game: the previous floor rung took the program count from 75
// to 110 and cost a 762ms frame, so the ladder's rescue move was the worst
// hitch of the session, and it left the cone standing on the dirt casting no
// shadow at all while `world/`, `track/` and `render/` all still believed in the
// one shadow policy ARCHITECTURE §12 describes. A governor may spend the game's
// looks; it may not contradict the game's art direction.
//
// **1. It must not oscillate.** A ladder that drops a rung, gets faster, climbs
// back, gets slower and drops again is worse than no ladder at all: the player
// watches the shadows and the draw distance breathe. Four mechanisms stop it.
// The thresholds are far apart. The dwells are asymmetric — a rung is lost
// after 1.2s over budget and regained only after 9s under it, so a single hitch
// can cost a rung but can never win one back on its own. Every change is
// followed by a lockout long enough for the change's own transient to pass. And
// climbing back demands more than the wall clock: the frame has to be arriving
// on time *and* have measured headroom underneath it, because a vsync-locked
// 16.7ms says nothing about how close to the edge the machine is.
//
// **2. It must not change at a moment the player is looking at.** This is the
// one a purely numerical governor gets wrong, and it has two halves.
//
// The first is the corner. The frames that blow the budget are exactly the
// frames where a lot is happening — a hairpin with the pack alongside, a
// mini-turbo firing, dust in the air — so a naive ladder does all its switching
// at the precise moments the player is concentrating hardest, and the draw
// distance pops at the apex. Changes wait for a straight.
//
// The second is the ceremony, and it was found the expensive way. `onAStraight`
// was the only "not now" this file had, and it was consulted on the *ordinary*
// path only — while the emergency path, which is the sole path a machine slow
// enough to need this file ever takes, called `applyRung` directly. Measured
// live over two hundred seconds: all seven rung changes logged
// `dropped (panic)` or `stalled`, so the moment gate was never consulted once
// in a real session, and two of the seven landed inside the countdown — one on
// the numeral "1" and one on "GO!". The picture went 1088x612 -> 927x522 ->
// 768x432 and lost its bloom across the two seconds the player is timing a
// rocket start, in front of a near-static grid camera with nothing to mask it.
//
// So the gate is now a *phase* gate as well as a curvature one, it is consulted
// by both paths, and it is the first thing either of them asks. The countdown,
// the finish and the results sheet are sealed — the game is being watched
// rather than played, and a machine that has been at 1.5fps for forty seconds
// can wait a few more for the flag. `CEREMONY_GRACE` carries the refusal a
// little past the flag, because the beat the flag falls on is exactly as
// precious as the "1" before it.
//
// The third half of that — and the reason this round was lost — is that the
// phase cannot see the front-end. **ARCHITECTURE §11a says so outright**: the
// race is built at boot and keeps simulating behind an opaque title screen, so
// `race.phase` walks `intro` → `countdown` → `racing` while the player is still
// looking at the roster, and anything drawing over the game must stand off on
// the `ui:menu` edges instead. `race/director.ts` has always done this
// (`frontEndOpen`) and `ui/coach.ts` was fixed to; this file asked the race
// director what was on screen and believed the answer. Measured live over 180
// seconds: three of five rung changes were made with the title screen and the
// machine roster on the display, all three logged `phase: intro`, and the
// remaining two landed within two tenths of a second of the flag. Every change
// the session made was made at a moment this gate exists to refuse.
//
// So the gate now asks three questions in the order they can be trusted: is
// the front-end up (an edge, published by the module that owns the screen), is
// the game paused (an edge, likewise), and only then what the race thinks it
// is doing.
//
// The intro sweep is composed too and is gated with them, but it is the one
// that carries a valve, because a phase gate on a starved simulation can
// deadlock — see `CEREMONY_PATIENCE`, which is the second thing this round
// measured and the reason the sweep is not sealed with the rest.
//
// The emergency path keeps everything else it was given: it sits *above* the
// warm-up gate rather than below it, because a machine delivering twenty frames
// a second does not need another three seconds of evidence to prove it, and it
// skips the curvature lookahead, because at 2fps there is no such thing as
// between corners. It does not get to skip the ceremony.
//
// **3. It must never touch the simulation.** There is no `fixedUpdate` in this
// file and there never may be. Everything the governor writes — `ctx.quality`,
// the renderer's shadow flag, the render resolution — is read only from
// `update` and from the draw. Nothing in physics, ai, items, race or track
// reads `ctx.quality` at all, which is what makes "the same seed puts every
// racer in the same place at every rung" a property of the design rather than a
// hope. `tools/qualitydiff.mjs` proves it by running one seed at both ends of
// the ladder and diffing the snapshots.
//
// ── What it will not do ────────────────────────────────────────────────────
//
// It parks itself the moment anything drives the game through `window.__GAME`.
// A capture renders six fixed steps at a time from a Node round trip on a
// software rasteriser at two hundred milliseconds a frame; read as gameplay
// that is an argument for the bottom rung, and the review sheet would quietly
// photograph the wrong game. `budget.benchFrames` is how the engine tells the
// two apart, and two of them inside a second latch this page as a bench for
// good.
//
// It also stands down permanently the moment a human or a reviewer picks a tier
// by hand, because that is a decision and this is only a measurement.
//
// And it stops cutting when cutting stops working. Every drop records what the
// frame cost before it and checks, once the change has settled, whether the
// frame actually got cheaper. Two drops in a row that buy nothing and the
// governor puts the last one back and stands down: the machine is being held up
// by something this ladder does not own, and carrying on down it would spend
// the game's looks on nothing at all.
//
// **That check has to be able to count.** It is the one place in this file that
// compares two measurements rather than a measurement against a constant, and
// the first version of it did so with a four-sample *mean* against a 4% bar. On
// the machine it exists for, delivered frames run 17ms to 1233ms around a 483ms
// median — the instrument's own spread is wider than anything it is being asked
// to resolve — and it mis-fired live: a drop that an interleaved three-pass
// measurement puts at 21-31% cheaper was scored at 3.5%, called "drops buy
// nothing", rolled back, and the player was held forty seconds at a rung a
// fifth slower than the one the governor had just taken away from them.
//
// Three things fix that, and they are worth stating separately because each one
// alone would still have been a coin toss:
//
//   - **A median, not a mean.** Two thirds of that spread is one tail; the mean
//     read 642ms where the median read 483.
//   - **Enough samples, unconditionally.** The four-sample escape hatch is
//     gone. `VERDICT_SAMPLES` or no verdict.
//   - **A bar the window itself has to clear.** The gain has to beat
//     `FUTILE_GAIN` *or* the standard error of the difference of the two
//     medians, whichever is larger. When the window is too noisy to resolve a
//     real rung — `FUTILE_RESOLVE`, above which even a working cut would read
//     as nothing — the verdict is `unresolved` and no verdict is taken at all.
//
// The asymmetry in that last one is deliberate and is the whole design. A false
// "it worked" costs the player one rung of resolution on a ladder whose every
// rung keeps the shadows, the post stack, the grade and the fog. A false "it
// bought nothing" costs them a third of their frame rate for as long as they
// keep playing. So when the instrument cannot tell, it says so, the ladder
// carries on, and the futility check stays sharp for the case it was built for
// — a vsync-locked panel, where the frame is 33ms with almost no spread, the
// standard error is a rounding error, and two cuts that move it by nothing are
// unambiguous.
//
// That last mechanism is also the answer to the one thing wall time genuinely
// cannot tell you. A display running at 30Hz delivers a 33ms frame no matter
// how idle the machine is, and from inside the page it is indistinguishable
// from a GPU taking 33ms — there is no web API for the refresh rate, and a
// `render()` that returns in 8ms says nothing about what the driver did next.
// So the governor assumes it is at fault, which is the right way round: guessing
// wrong on a 30Hz panel costs a soft rung, and guessing wrong on a slow GPU is
// the five-out-of-ten this file was sent back for. The futile check then cleans
// it up — two cuts that move a vsync-locked 33ms by nothing, and the ladder
// puts one back and leaves it alone.

import { config } from './config.ts';
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
}

function rung(
  label: string, tier: QualitySettings['tier'], scale: number,
  trim: Partial<QualitySettings> = {},
): Rung {
  return { label, scale, settings: { tier, ...config.quality[tier], ...trim } };
}

/**
 * Rung 0 is the most expensive. The governor only ever moves one step.
 *
 * ── Why resolution leads ───────────────────────────────────────────────────
 *
 * An earlier ladder gave up draw distance first, then particles, then the
 * shadow map, and it was measured — at one frozen sim state, one rung at a
 * time — to be worth almost nothing: rung 0 to rung 3 moved the frame from 359
 * draw calls and 638k triangles to 367 and 610k, and a pixel diff of the two
 * frames put the difference at 5% of pixels and a mean delta of 4/765. Three
 * visible steps, four percent of the geometry, and no measurable time.
 *
 * That is what a triangle-shaped ladder looks like on a machine that is not
 * triangle-bound. The machines this file exists for are *fill*-bound: they are
 * drawing a 1600x900 scene into an HDR target, a bright pass, five downsample
 * mips, five upsample mips, a composite and an FXAA resolve, and a shadow map
 * on top, and every one of those costs pixels rather than vertices. Culling a
 * floodlight tower two hundred metres away removes ninety triangles from a
 * pass that was never counting triangles.
 *
 * Resolution is the one lever that scales *all* of it at once — the scene, the
 * composite, the resolve and the entire bloom chain, quadratically — and it is
 * by a long way the least visible thing on this list per millisecond bought,
 * because the game is already resolving through FXAA and a bloom. So each rung
 * takes a bite out of the render scale first, and the authored looks come off
 * alongside it in much smaller pieces.
 *
 * ── Why there is no cliff at the bottom any more ───────────────────────────
 *
 * There used to be. The floor rung was `config.quality.low`, which drops
 * shadows, the whole post stack and AA in one step, and every part of that was
 * a mistake that measurement found:
 *
 *   - **It recompiled the game.** Turning the post stack off puts
 *     `THREE.FogExp2` back on the scene, so every material in view rebuilds.
 *     Measured live: programs 75 -> 110 and a **762ms first frame**, in the one
 *     frame the governor had picked to rescue a machine that was already
 *     failing. The ladder's rescue move was the worst hitch of the session.
 *   - **It broke the one shadow policy.** `render/lighting.ts` derives the sun,
 *     `track/terrain.ts` receives from it and `world/index.ts` casts into it,
 *     and each of those depends on the other two. A rung that switches the map
 *     off is a rung on which the cone stands on the dirt casting nothing while
 *     the barriers beside it also cast nothing — see ARCHITECTURE §12. Shadow
 *     *resolution* is a dial; the shadow map is not.
 *   - **The step above it bought nothing.** Measured at 1600x900 under
 *     SwiftShader, the old rung 3 (scale 0.72) ran at 1041ms and the old rung 4
 *     (scale 0.62) at 1067ms — a drop that made the frame *worse*, which is
 *     precisely the reading the futility check exists to catch and precisely
 *     the path it could not reach.
 *
 * So every rung on this ladder now carries the same shadow policy and the same
 * post stack, and **the whole ladder compiles one program set**. Nothing below
 * rung 0 introduces a shader the top rung has not already drawn: the tier only
 * moves between `high` and `med`, which differ in numbers rather than in
 * features, `aa` picks between two programs that are both built at boot, and
 * `bloom` skips passes rather than changing any material. A rung change is a
 * few render-target resizes and a shadow-map realloc, and nothing else.
 *
 * What is given up instead, in the order it comes off: resolution, then the
 * shadow map's *size* (2048 down to 256 — still a map, still contact), then
 * particle density and draw distance, and last the bloom pyramid, which is
 * nine blits of pure fill and the single most expensive thing in the frame
 * that nobody can name when it is missing.
 *
 * ── What it measured ───────────────────────────────────────────────────────
 *
 * Median real rAF period, one frozen sim state at 1600x900 under a software
 * rasteriser, interleaved passes so page warm-up could not flatter the rung
 * that happened to go first (it very nearly did once: walked in order, rung 0
 * read 1383ms against the same rung's 683ms after twenty warm-up frames, and
 * the whole ladder looked twice as good as it is).
 *
 * **Each lever, isolated** (`__QUALITY.try`, frozen sim, median rAF period,
 * three interleaved passes, against the 986ms top rung):
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
 * Two things fall straight out of that table. Resolution is not merely the best
 * lever, it is worth more than every other lever on the ladder put together —
 * so it leads every rung. And the shadow *map size* is nearly free in both
 * directions: 2048 to 256 is two percent, which is why the ladder can hand the
 * whole range back to the art direction and keep a real shadow at every rung
 * for almost nothing. What shadows actually cost is the second draw of every
 * caster (462 draw calls to 290), and that is a cost the game has decided to
 * pay everywhere — see ARCHITECTURE §12.
 *
 * **The ladder itself**, walked strictly downwards on a fresh page — which is
 * the only order that can answer the program question honestly, because an
 * interleaved pass compiles the lower rungs' variants before it measures them:
 *
 *   rung 0  high    1147ms   —      456 draws  816k tris   84 programs
 *   rung 1  high-    975ms   -15%   453 draws  810k tris   84
 *   rung 2  med      719ms   -26%   431 draws  805k tris   84
 *   rung 3  med-     576ms   -20%   429 draws  799k tris   84
 *   rung 4  low      497ms   -14%   398 draws  779k tris   84
 *   rung 5  floor    404ms   -19%   393 draws  780k tris   84
 *                            -65% end to end
 *
 * Every step buys more than `FUTILE_GAIN`, which is the bar the ladder this
 * replaces could not clear — its rung 3 to rung 4 measured *worse*. And the
 * program count is **flat for the whole descent**, against 75 -> 101 before: the
 * ladder no longer compiles anything, so it cannot hitch on the way down. (The
 * one variant that used to appear at rung 3 — the composite drawn straight to
 * the back buffer when `aa` goes off, which is a different program from the
 * same composite drawn into a target — is now built at boot by
 * `warmPrograms()` in `render/post.ts`.)
 *
 * The numbers move with the course; the shape does not. Every rung has to buy
 * more than `FUTILE_GAIN` or it is not a rung, and the futility check will now
 * actually notice — see where it sits relative to the panic branch.
 */
const LADDER: readonly Rung[] = [
  rung('high', 'high', 1.00),
  rung('high-', 'high', 0.88, { shadowSize: 1536, drawDistance: 0.95 }),
  rung('med', 'med', 0.78, { shadowSize: 1024, particles: 0.75, drawDistance: 0.88 }),
  rung('med-', 'med', 0.68, { shadowSize: 768, aa: false, particles: 0.55, drawDistance: 0.76 }),
  rung('low', 'med', 0.58, { shadowSize: 512, aa: false, particles: 0.4, drawDistance: 0.64 }),
  // The floor. Still shadowed, still composited, still graded, still fogged by
  // the same depth-driven atmosphere as the top rung — a quarter of the pixels,
  // a 256px shadow map and no glow. It is the cheapest frame this game can draw
  // that is still recognisably this game.
  rung('floor', 'med', 0.48, {
    shadowSize: 256, aa: false, bloom: false, particles: 0.28, drawDistance: 0.52,
  }),
];

/** Where the game starts. Top of the ladder — the governor's job is to earn
 *  its way down, not to guess a machine's class before it has drawn a frame. */
const START_RUNG = 0;

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
 * The phases the picture is **sealed** in: composed, watched, and not to be
 * touched at any frame rate, for any reason, by either path.
 *
 * `countdown` is three beats and a flag in front of a near-static rig with the
 * player timing a rocket start; `finished` is the letterbox and the victory
 * lens; `results` is the standings sheet. `loading` is both the boot and — see
 * ARCHITECTURE §11a — the pause screen, which is a still frame of the game with
 * a plate over it and therefore the single worst surface in the product to
 * change the resolution on: nothing is moving to hide it and the player is
 * looking straight at it.
 *
 * Nothing here is about how fast the machine is. It is about whether anyone is
 * driving.
 */
function isSealed(phase: string | undefined): boolean {
  return phase === 'countdown' || phase === 'finished'
    || phase === 'results' || phase === 'loading';
}
/** ...and the intro sweep, which is composed too but carries the valve below. */
function isComposed(phase: string | undefined): boolean {
  return phase === 'intro' || isSealed(phase);
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
 * It cannot deadlock and needs no valve — see the corollary in the header. On
 * a machine that is fine, sim time and wall time are the same thing and this is
 * 1.2 seconds. On one slow enough for `engine.ts`'s eight-step cap to bind,
 * every delivered frame buys exactly eight fixed steps, so a frame is worth
 * 0.067 sim-seconds and the gate opens after eighteen of them however long each
 * one takes. Bounded in pictures, either way.
 */
const CEREMONY_GRACE = 1.2;
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
 * countdown that follows is shorter *and* sealed.
 */
const CEREMONY_PATIENCE = 20;

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
   * `true` on this line is the round-3 failure, in one field: a change made
   * with the title screen on the display. It is here rather than inferred so
   * that a reviewer never has to take the screenshot again.
   */
  frontEnd: boolean;
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
  /** 'worked' | 'futile' | 'unresolved' | 'abandoned'. */
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
  /** Render resolution as a fraction of the display's. */
  scale: number;
  drawDistance: number;
  particles: number;
  shadowSize: number;

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
  /** Every change this session, most recent last. */
  log: QualityChange[];
  /** ...and every judgement of a change, whether or not it moved anything. */
  verdicts: QualityVerdict[];
}

export function createQualitySystem(ctx: GameContext): GameSystem {
  let index = START_RUNG;
  let auto = true;
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

  /** Seconds over budget / under it. One of the two is always zero. */
  let overFor = 0;
  let underFor = 0;
  let panicFor = 0;
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
  /** Seconds of delivered play spent inside the composed picture currently on
   *  screen. Zero while the game is being played, and zero behind the
   *  front-end — a sweep nobody can see is not a sweep anybody is waiting out.
   *  Only the intro's valve reads it. */
  let ceremonyFor = 0;

  // ── the cost of the governor's own action ────────────────────────────────
  /** Worst delivered frame among the `SKIP_FRAMES` discarded after a change. */
  let changeCost = 0;
  /** ...that number for the most recent completed change, and the worst of the
   *  session. Both in wall milliseconds; 0 before the first change. */
  let lastChangeMs = 0;
  let changeWorst = 0;
  /** The log entry still being measured into, or null. Never allocated here —
   *  it is the entry `applyRung` already pushed. */
  let changeEntry: QualityChange | null = null;

  const log: QualityChange[] = [];
  const verdicts: QualityVerdict[] = [];

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
   * Render resolution.
   *
   * `setPixelRatio` re-sizes the drawing buffer itself, and the post stack sizes
   * its targets off `getDrawingBufferSize`, so one call moves the scene pass,
   * every bloom mip, the composite and the resolve together. The DOM HUD is
   * unaffected — it measures the viewport, not the canvas.
   */
  function applyScale(scale: number): void {
    const want = baseRatio() * scale;
    const have = ctx.renderer.getPixelRatio();
    if (have > want - 1e-3 && have < want + 1e-3) return;
    ctx.renderer.setPixelRatio(want);
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
    b.renderScale = LADDER[index]?.scale ?? 1;
    b.liveWallMs = wallMean;
    b.liveWorstMs = wallWorst;
    b.liveSeconds = liveSeconds;
    b.governor = holding;
  }

  /** Record why the governor is standing still, and publish it. Returns void so
   *  the call sites can be `return hold('...')` — one statement, no fallthrough
   *  and no way to leave without the budget agreeing with the decision. */
  function hold(why: string): void {
    holding = why;
    publish();
  }

  function clearWindow(): void {
    wallCount = 0;
    wallIdx = 0;
    wallMean = 0;
    wallWorst = 0;
    wallBest = 0;
    workMean = 0;
    lateFrac = 0;
    skipFrames = SKIP_FRAMES;
    // A change measurement that never completed belongs to nothing. Dropping
    // the entry pointer leaves its `changeMs` at 0, which reads as "not
    // measured" rather than as "free".
    changeCost = 0;
    changeEntry = null;
  }

  function applyRung(next: number, why: string): void {
    const from = index;
    index = next < 0 ? 0 : next >= LADDER.length ? LADDER.length - 1 : next;
    const r = LADDER[index]!;
    const q: QualitySettings = { ...r.settings };
    ctx.quality = q;
    applied = q;
    ctx.renderer.shadowMap.enabled = q.shadows;
    ctx.renderer.shadowMap.needsUpdate = true;
    applyScale(r.scale);

    let entry: QualityChange | null = null;
    if (from !== index) {
      const b = ctx.budget;
      if (log.length >= 24) log.shift();
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
    ctx.bus.emit('quality:changed', { quality: q });
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
   * Is the game showing a picture the player is being *shown* rather than one
   * they are driving through?
   *
   * **Both paths consult this, the ordinary one and the emergency one**, and it
   * is the first question either of them asks. See the header: for two rounds
   * the only moment gate in this file sat on the ordinary path, which is the
   * path a machine slow enough to need a governor never takes.
   *
   * It costs three field reads and three comparisons, it never allocates, and
   * it is deliberately not clever: no lookahead, no camera test, nothing that
   * could fail open. The whole of it is "is anybody driving, and has the flag
   * been down long enough to look away from".
   *
   * ── The order of the three questions is the fix ────────────────────────────
   *
   * It used to ask one, `ctx.race?.phase`, and ARCHITECTURE §11a says in as
   * many words that the phase cannot answer it: the race is built at boot and
   * simulates behind the front-end, so it reports `intro`/`countdown`/`racing`
   * over a title screen, and it reports `loading` for both the boot and the
   * pause screen. Measured live: three of five rung changes in a 180-second
   * session were made with the roster on the display and logged `phase:
   * intro`. The two edges come first now because they are *published by the
   * modules that own those screens* — the same signals `race/director.ts` and
   * `ui/coach.ts` stand off — and the phase is the third opinion rather than
   * the only one.
   *
   * Neither of the first two carries a valve, and that is on purpose: see the
   * unit rule in the header. A valve is needed only where the thing being
   * waited for is itself slowed by the cost the governor is trying to cut. The
   * front-end ends when a player presses a key and the pause screen ends when
   * they press another; no amount of governing makes either arrive sooner, and
   * a valve on them would only put back the bug of changing the picture while
   * somebody is looking straight at a still frame of it.
   */
  function pictureLocked(): boolean {
    // Nobody is driving, and the 3D behind the front-end is a different scene
    // from the one this ladder is tuning.
    if (frontEndOpen || paused) return true;
    const phase = ctx.race?.phase;
    if (isSealed(phase)) return true;
    // The one door, and it is on the sweep only. See `CEREMONY_PATIENCE`.
    if (phase === 'intro') return ceremonyFor < CEREMONY_PATIENCE;
    // The flag's own beat, on the fixed-step clock rather than on the wall
    // clock — see `CEREMONY_GRACE`. `flagAt` is latched on the `race:racing`
    // edge, so this is the same beat at every frame rate instead of one frame
    // at 0.7fps, and a seek re-arms it instead of walking straight past it.
    return ctx.time.elapsed - flagAt < CEREMONY_GRACE;
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
   * Compile every program any rung can ask for, before any rung asks for it.
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
   *     transitions move it. It stays, because `LADDER`'s lever table prices
   *     the whole 2048 -> 256 range at 2% of a steady frame and 2% of a
   *     thousand-millisecond frame pays a 262ms hitch back inside twenty
   *     frames; but it is the one lever here whose hitch is comparable to what
   *     it buys, and it is the first thing to take off the ladder if a rung
   *     change ever has to get cheaper.
   *
   * What remains is one drawing-buffer reallocation per rung change, which is
   * what changing the render resolution *is*. It cannot be removed from this
   * file. The structural fix is to hold every target at the top rung's size and
   * render into a viewport sub-rectangle with each post pass sampling through a
   * uv scale — real dynamic resolution — which is a `render/post.ts` change and
   * moves the final resolve to full resolution, a lever the same table prices
   * at 7% of every frame for ever. That is a trade for a coherence pass to make
   * with the render module, not for a governor to make on its own.
   *
   * So the number is published instead of hidden: every change carries its own
   * `changeMs`, and `probe().changeWorstMs` is the worst of the session.
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
      scale: LADDER[index]?.scale ?? 1,
      drawDistance: +q.drawDistance.toFixed(3),
      particles: +q.particles.toFixed(3),
      shadowSize: q.shadows ? q.shadowSize : 0,

      wallMs: +wallMean.toFixed(2),
      wallMedianMs: +wallMedian.toFixed(2),
      wallMadMs: +wallMad.toFixed(2),
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
      suspended,
      hijacked,
      phase: ctx.race?.phase ?? '',
      locked: pictureLocked(),
      frontEnd: frontEndOpen,
      paused,
      raceTime: +(ctx.race?.time ?? 0).toFixed(2),
      sinceFlag: sinceFlag(),
      changeMs: +lastChangeMs.toFixed(1),
      changeWorstMs: +changeWorst.toFixed(1),
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
  }
  function audit(): { total: AuditRow; groups: AuditRow[] } {
    const rows = new Map<string, AuditRow>();
    const total: AuditRow = {
      group: 'all', calls: 0, triangles: 0, instances: 0, meshes: 0, nodes: 0, casts: 0,
    };
    const row = (name: string): AuditRow => {
      let r = rows.get(name);
      if (!r) {
        r = {
          group: name, calls: 0, triangles: 0, instances: 0, meshes: 0, nodes: 0, casts: 0,
        };
        rows.set(name, r);
      }
      r.nodes++;
      return r;
    };

    interface DrawableLike {
      isMesh?: boolean;
      isInstancedMesh?: boolean;
      isPoints?: boolean;
      isLine?: boolean;
      count?: number;
      castShadow?: boolean;
      geometry?: {
        index?: { count: number } | null;
        getAttribute?(name: string): { count: number } | undefined;
      };
      material?: unknown;
    }

    for (const top of ctx.scene.children) {
      const r = row(top.name || top.type);
      top.traverseVisible((o) => {
        const mesh = o as unknown as DrawableLike;
        if (!mesh.isMesh && !mesh.isPoints && !mesh.isLine) return;
        const geo = mesh.geometry;
        if (!geo) return;
        const verts = geo.index?.count ?? geo.getAttribute?.('position')?.count ?? 0;
        const n = mesh.isInstancedMesh ? (mesh.count ?? 0) : 1;
        // A multi-material mesh is one draw per group.
        const groups = Array.isArray(mesh.material) ? mesh.material.length : 1;
        r.meshes++;
        r.instances += n;
        if (n > 0) r.calls += groups;
        r.triangles += ((verts / 3) | 0) * n;
        if (mesh.castShadow && n > 0) r.casts += groups;
      });
      // Shadow casters are drawn a second time, into the map.
      if (ctx.quality.shadows) r.calls += r.casts;
    }

    for (const r of rows.values()) {
      total.calls += r.calls;
      total.triangles += r.triangles;
      total.instances += r.instances;
      total.meshes += r.meshes;
      total.nodes += r.nodes;
      total.casts += r.casts;
    }
    const groups = [...rows.values()].sort((a, b) => b.triangles - a.triangles);
    return { total, groups };
  }

  return {
    name: 'quality',
    // After everything that draws and before the HUD, so a readout that wants
    // to show the tier sees this frame's answer rather than last frame's.
    order: 95,

    init(): void {
      here = blankSample(ctx);
      ahead = blankSample(ctx);
      // Start from a known rung rather than inheriting whatever main.ts built,
      // so `index` and `ctx.quality` cannot disagree from the first frame.
      applyRung(START_RUNG, 'settling');

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
        abandonVerdict();
        clearWindow();
        overFor = 0; underFor = 0; panicFor = 0;
        overFrames = 0; underFrames = 0; panicFrames = 0;
        settleFor = 0; settleFrames = 0;
      });
      // The flag itself, from the module that drops it. `setPhase` emits this
      // on the transition into `racing` and `setPhaseQuiet` does not, so a
      // resume from pause cannot counterfeit a start. See `CEREMONY_GRACE`.
      ctx.bus.on('race:racing', () => { flagAt = ctx.time.elapsed; });
      ctx.bus.on<{ on: boolean }>('race:pause', (e) => {
        const on = e?.on === true;
        if (on === paused) return;
        paused = on;
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
        applyScale(LADDER[index]!.scale);
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
          return auto;
        },
        /** Pin a rung by index. For the bench — a player picks a tier. */
        set(i: number): number {
          auto = false;
          applyRung(i, 'pinned');
          holding = 'pinned';
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
          if (typeof scale === 'number') applyScale(scale);
          clearWindow();
          holding = 'pinned';
          ctx.bus.emit('quality:changed', { quality: q });
          return probe();
        },
        /** What the frame is made of, by scene group. See `audit`. */
        audit,
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
      // The world is built by the time `resetAll` runs, so this is the first
      // moment there is anything to compile — and it lands immediately before
      // main.ts's own priming render rather than on a frame a player is
      // watching. Once per course per session; see `precompileLadder`.
      precompileLadder();
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

      // ── sample the frame ─────────────────────────────────────────────────
      //
      // `liveFrames` is incremented by the engine at the *top* of `renderFrame`,
      // so by the time we run it already counts this frame. A frame the rAF loop
      // did not drive is a frame whose spacing means nothing.
      const live = b.liveFrames !== seenLive;
      seenLive = b.liveFrames;

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
        const spoiled = resumed || pageHidden || harnessSince;
        if (spoiled) {
          if (resumed || pageHidden) suspended++; else hijacked++;
          resumed = false;
          harnessSince = false;
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
            if (changeEntry) {
              if (gap > changeCost) changeCost = gap;
              if (skipFrames === 0) {
                lastChangeMs = changeCost;
                if (changeCost > changeWorst) changeWorst = changeCost;
                changeEntry.changeMs = +changeCost.toFixed(1);
                changeEntry = null;
              }
            }
          } else {
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
      // What remains is the intro valve's, and it is in wall seconds because
      // the valve is about a *person waiting* — see `CEREMONY_PATIENCE`. It is
      // held at zero behind the front-end: a sweep nobody can see is not a
      // sweep anybody is sitting through.
      if (frontEndOpen || paused) ceremonyFor = 0;
      else if (isComposed(ctx.race?.phase)) ceremonyFor += secs;
      else ceremonyFor = 0;

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
          } else if (bar <= FUTILE_RESOLVE || gain <= -bar) {
            // Either the window is tight enough that a gain this small is
            // genuinely a gain this small, or the frame got *worse* by more
            // than the noise — which is evidence in the same direction and the
            // one reading no amount of spread can explain away.
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
          if (call === 'futile' && futile >= FUTILE_LIMIT && index > 0) {
            // Two cuts in a row that changed nothing. Whatever is holding this
            // machine up is not on this ladder, so put the last one back and
            // stop spending the game's looks on it.
            stalled = true;
            stalledAt = wallMean;
            futile = 0;
            applyRung(index - 1, 'stalled (drops buy nothing)');
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
      const canDrop = index < LADDER.length - 1 && !stalled && !verdictPending;
      if (panic && canDrop && liveSeconds >= PANIC_ARM_S
        && settleFor >= PANIC_SETTLE && settleFrames >= PANIC_SETTLE_FRAMES) {
        // **The line the last two rounds were about.** The emergency path may
        // skip the curvature lookahead — at two frames a second there is no
        // such thing as between corners — but it does not get to change the
        // picture while the game is showing one, and "showing one" now includes
        // the front-end and the pause screen, which `race.phase` cannot report.
        // The dwell restarts rather than banking, so the drop lands a beat into
        // the racing rather than on the frame the gate opens.
        if (pictureLocked()) {
          panicFor = 0;
          panicFrames = 0;
          return hold(frontEndOpen ? 'front-end' : paused ? 'paused' : 'mid-ceremony');
        }
        panicFor += secs;
        panicFrames += frameTick;
        if (panicFor >= PANIC_DWELL && panicFrames >= PANIC_DWELL_FRAMES) {
          markDrop();
          applyRung(index + 1, 'dropped (panic)');
          return;
        }
        return hold('panic');
      }
      panicFor = 0;
      panicFrames = 0;
      if (panic && verdictPending) return hold('panic (judging last cut)');

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
        applyRung(index - 1, 'raised');
      }
    },

    dispose(): void {
      offVisibility?.();
      offVisibility = null;
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
