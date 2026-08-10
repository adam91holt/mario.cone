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
// **2. It must not change mid-corner.** This is the one a purely numerical
// governor gets wrong. The frames that blow the budget are exactly the frames
// where a lot is happening — a hairpin with the pack alongside, a mini-turbo
// firing, dust in the air — so a naive ladder does all its switching at the
// precise moments the player is concentrating hardest, and the draw distance
// pops at the apex. Changes wait for a straight. The exception is a genuine
// emergency, and the emergency path is real now: it sits *above* the warm-up
// gate rather than below it, because a machine delivering twenty frames a
// second does not need another three seconds of evidence to prove it.
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

/** Seconds over budget before a rung is given up. Real seconds. */
const DOWN_DWELL = 1.2;
/** ...and under it before one is taken back. Deliberately much longer: a hitch
 *  may cost a rung, but nothing wins one back by accident. */
const UP_DWELL = 9;
/** ...and in an emergency, where the evidence is already overwhelming. */
const PANIC_DWELL = 0.35;
/** Seconds after any change during which nothing is decided. */
const SETTLE = 2.2;
/** ...and after an emergency change, where waiting is its own cost. */
const PANIC_SETTLE = 0.9;
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
/** ...and before a *drop* is judged to have bought anything. */
const VERDICT_SAMPLES = 14;
/**
 * ...or this many seconds, whichever comes first, with `PANIC_SAMPLES` frames
 * behind it.
 *
 * Fourteen frames is a quarter of a second on a machine that is fine and half a
 * minute on one delivering 1.7 a second — and the second machine is the one the
 * futility check is *for*. Half a minute of not noticing that a cut bought
 * nothing is three more cuts on the way down, which is the whole of the game's
 * looks spent on a bottleneck this ladder does not own.
 */
const VERDICT_WAIT_S = 2.5;

/**
 * A drop that buys less than this fraction of the frame back bought nothing.
 *
 * Set under the smallest step the ladder actually contains — rung 0 to rung 1
 * measured 7% — and well over the step the previous ladder's cheapest rungs
 * measured, which was zero. It is a detector for "this lever does not apply to
 * this machine", not a quality bar on the ladder.
 */
const FUTILE_GAIN = 0.04;
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
  /** Every change this session, most recent last. */
  log: QualityChange[];
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

  /** Seconds over budget / under it. One of the two is always zero. */
  let overFor = 0;
  let underFor = 0;
  let panicFor = 0;
  let settleFor = SETTLE;
  /** -1 until the first frame we observe, so boot's own primed frame is free. */
  let benchFrames = -1;
  let benchQuietFor = 0;
  /** Latched: this page is a bench, and nothing it measures is about a player. */
  let benched = false;
  let holding = 'settling';

  // ── did the last cut buy anything ────────────────────────────────────────
  /** The frame's wall cost immediately before the last drop. */
  let wallBefore = 0;
  let verdictPending = false;
  let futile = 0;
  let stalled = false;
  /** The wall cost when the governor gave up, so it can notice things changing. */
  let stalledAt = 0;

  const log: QualityChange[] = [];

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

    if (from !== index) {
      const b = ctx.budget;
      if (log.length >= 24) log.shift();
      log.push({
        t: +liveSeconds.toFixed(2),
        from,
        to: index,
        why,
        wallMs: +wallMean.toFixed(1),
        workMs: +workMean.toFixed(2),
        bound: b ? boundBy(b) : '',
      });
    }

    overFor = 0;
    underFor = 0;
    panicFor = 0;
    settleFor = 0;
    // Everything measured before a change was measured about a different game.
    clearWindow();
    holding = why;
    publish();
    // The same channel main.ts's own `setQuality` uses, so lighting, fx, the
    // contact pass and the menus' 3D set all re-read on one event as they
    // already do. Nothing new has to subscribe for this file to work.
    ctx.bus.emit('quality:changed', { quality: q });
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
   * Is this a moment the player would forgive a visible change?
   *
   * Straight road under them, straight road ahead of them, planted, and nothing
   * in flight. A corner is where every frame this governor is trying to save
   * gets spent, so it is also exactly where a naive one would do all of its
   * switching.
   */
  function onAStraight(): boolean {
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
      log,
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
      settleFor = 0;
      benchQuietFor = 0;
      verdictPending = false;
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
          liveSeconds += secs;
          // The frames right after a change are the change reallocating itself,
          // not the game. They still count as time; they are not evidence.
          if (skipFrames > 0) {
            skipFrames--;
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
        return hold('priming');
      }

      settleFor += secs;
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
      // Its evidence gate is a disjunction for the same reason the warm-up gate
      // is counted in seconds: `VERDICT_SAMPLES` frames is a third of a second
      // at sixty and half a minute at 1.7, and waiting half a minute to notice
      // that a cut did nothing is the same failure in a different unit. Either
      // enough frames, or enough seconds with enough frames to mean anything.
      if (verdictPending
        && settleFor >= PANIC_SETTLE
        && (wallCount >= VERDICT_SAMPLES
          || (wallCount >= PANIC_SAMPLES && settleFor >= VERDICT_WAIT_S))) {
        verdictPending = false;
        const gain = wallBefore > 0 ? (wallBefore - wallMean) / wallBefore : 1;
        if (gain < FUTILE_GAIN) {
          futile++;
          if (futile >= FUTILE_LIMIT && index > 0) {
            // Two cuts in a row that changed nothing. Whatever is holding this
            // machine up is not on this ladder, so put the last one back and
            // stop spending the game's looks on it.
            stalled = true;
            stalledAt = wallMean;
            futile = 0;
            applyRung(index - 1, 'stalled (drops buy nothing)');
            return;
          }
        } else {
          futile = 0;
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
      if (panic && canDrop && liveSeconds >= PANIC_ARM_S && settleFor >= PANIC_SETTLE) {
        panicFor += secs;
        if (panicFor >= PANIC_DWELL) {
          wallBefore = wallMean;
          verdictPending = true;
          applyRung(index + 1, 'dropped (panic)');
          return;
        }
        return hold('panic');
      }
      panicFor = 0;
      if (panic && verdictPending) return hold('panic (judging last cut)');

      if (wallCount < MIN_SAMPLES) return hold('warming');
      if (liveSeconds < WARMUP_S) return hold('warming');
      if (settleFor < SETTLE) return hold('settling');

      // ── the ordinary verdict ─────────────────────────────────────────────
      const over = wallMean > TARGET_MS * DOWN_FACTOR || lateFrac > DOWN_LATE_FRAC;
      const under = wallMean < TARGET_MS * UP_FACTOR
        && lateFrac < 0.03
        && workMean < UP_WORK_MS
        && b.worstMs < UP_WORST_MS;

      if (over) {
        overFor += secs;
        underFor = 0;
      } else if (under) {
        underFor += secs;
        overFor = 0;
      } else {
        overFor = 0;
        underFor = 0;
        return hold('in band');
      }

      // `!verdictPending` on the way down: a cut that has not been judged yet
      // is a cut whose `wallBefore` a second cut would overwrite, and the pair
      // would then be scored against each other instead of against the frame
      // they were both meant to improve. One cut at a time, judged, then the
      // next. Climbing is unaffected — a climb clears the pending verdict
      // because the thing it was judging has been undone.
      const wantDown = overFor >= DOWN_DWELL && index < LADDER.length - 1
        && !stalled && !verdictPending;
      const wantUp = underFor >= UP_DWELL && index > 0;
      if (!wantDown && !wantUp) {
        return hold(over
          ? (stalled ? 'over budget (stalled)'
            : verdictPending ? 'over budget (judging last cut)' : 'over budget')
          : 'under budget');
      }
      if (!onAStraight()) return hold('mid-corner');
      if (wantDown) {
        wallBefore = wallMean;
        verdictPending = true;
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
