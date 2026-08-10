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
// `budget.meanMs`, `meanSimMs` and `meanDrawMs` are still read, but only to
// *attribute* a frame the wall clock has already convicted: work above about
// two thirds of the frame means the CPU is the problem and says which half of
// it, and work far below it means the cost is downstream — the GPU, or vsync.
//
// ── The three things that make a governor either useful or a menace ─────────
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
 * The previous ladder gave up draw distance first, then particles, then the
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
 * post stack and the entire bloom chain, quadratically — and it is by a long
 * way the least visible thing on this list per millisecond bought, because the
 * game is already resolving through FXAA and a bloom. So each rung takes a bite
 * out of the render scale first, and the authored looks — shadow map, draw
 * distance, particle density — come off alongside it in much smaller pieces.
 *
 * ── Why `low` is split in two ──────────────────────────────────────────────
 *
 * `config.quality.low` drops shadows, post-processing and AA in a single step.
 * That is three different losses at once: every cast shadow in the scene (the
 * barriers stop marking the dirt, the kart loses its thrown shadow), the
 * additive halo around every item box, and the edge resolve — and because
 * turning the post stack off puts `THREE.FogExp2` back on the scene, it also
 * recompiles about thirty shader programs in the single frame the governor
 * picked to rescue a machine that was already failing.
 *
 * So the last rung is genuinely last, four cheaper steps sit above it, and the
 * step before it keeps shadows and the halo and only gives up resolution. A
 * machine that reaches the floor was never going to be saved by anything above
 * it.
 *
 * ── What it measured ───────────────────────────────────────────────────────
 *
 * Median real rAF period, one frozen sim state at 1600x900 under a software
 * rasteriser, three interleaved passes so page warm-up could not flatter the
 * rung that happened to go first (it very nearly did: walked once in order,
 * rung 0 read 1383ms against the same rung's 683ms once twenty warm-up frames
 * had gone by, and the whole ladder looked twice as good as it is).
 *
 *   rung 0  high    683ms   —
 *   rung 1  high-   633ms   -7%
 *   rung 2  med     533ms   -16%
 *   rung 3  med-    467ms   -12%
 *   rung 4  low     350ms   -25%
 *   rung 5  floor   267ms   -24%     61% off the top rung, end to end
 *
 * Every step buys time, which is the bar the ladder it replaces could not
 * clear: three of that one's four steps moved the frame by zero.
 */
const LADDER: readonly Rung[] = [
  rung('high', 'high', 1.00),
  rung('high-', 'high', 0.90, { shadowSize: 1024, drawDistance: 0.95 }),
  rung('med', 'med', 0.82, { particles: 0.75 }),
  rung('med-', 'med', 0.72, { shadowSize: 768, aa: false, particles: 0.55, drawDistance: 0.74 }),
  // Still shadowed, still composited, still haloed. Only smaller.
  rung('low', 'med', 0.62, { shadowSize: 512, aa: false, particles: 0.4, drawDistance: 0.66 }),
  // The floor: the cliff, taken deliberately and only once everything above it
  // has been tried and measured.
  rung('floor', 'low', 0.55),
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
/** A gap longer than this was not a frame — an alt-tab, a breakpoint, a
 *  harness stall — and averaging it in would convict the machine of it. */
const STALL_MS = 2000;

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
      log,
    };
  };

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
        ladder: LADDER.map((r) => ({
          label: r.label,
          scale: r.scale,
          tier: r.settings.tier,
          shadows: r.settings.shadows,
          shadowSize: r.settings.shadowSize,
          postfx: r.settings.postfx,
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

      let secs = 0;
      if (live) {
        const t = nowMs();
        const gap = lastFrameAt > 0 ? t - lastFrameAt : 0;
        lastFrameAt = t;
        const visible = typeof document === 'undefined'
          || document.visibilityState !== 'hidden';
        if (gap > 0 && gap < STALL_MS && visible) {
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
      // this page is a bench for good.
      if (b.benchFrames !== benchFrames) {
        if (benchFrames >= 0 && benchQuietFor < BENCH_BURST) benched = true;
        benchFrames = b.benchFrames;
        benchQuietFor = 0;
      } else {
        benchQuietFor += secs;
      }

      if (!auto) { holding = 'pinned'; return; }
      if (benched) { holding = 'bench'; return; }
      if (benchQuietFor < BENCH_HOLD) {
        holding = 'priming';
        overFor = 0;
        underFor = 0;
        return;
      }

      settleFor += secs;
      if (wallCount < PANIC_SAMPLES) { holding = 'warming'; return; }

      // ── the emergency path ───────────────────────────────────────────────
      //
      // Above the warm-up gate and above the settle, because those exist to
      // stop the governor acting on thin evidence and a machine delivering
      // twenty-seven frames a second is not thin evidence. It still needs a
      // fresh window — `PANIC_SAMPLES` frames since the last change emptied it,
      // and `SKIP_FRAMES` of reallocation discarded before those — and a short
      // dwell on top, so no single stalled frame can walk the ladder.
      const panic = wallMean > TARGET_MS * PANIC_FACTOR;
      const canDrop = index < LADDER.length - 1 && !stalled;
      if (panic && canDrop && liveSeconds >= PANIC_ARM_S && settleFor >= PANIC_SETTLE) {
        panicFor += secs;
        if (panicFor >= PANIC_DWELL) {
          wallBefore = wallMean;
          verdictPending = true;
          applyRung(index + 1, 'dropped (panic)');
          return;
        }
        holding = 'panic';
        return;
      }
      panicFor = 0;

      if (wallCount < MIN_SAMPLES) { holding = 'warming'; return; }
      if (liveSeconds < WARMUP_S) { holding = 'warming'; return; }
      if (settleFor < SETTLE) { holding = 'settling'; return; }

      // ── did the last cut buy anything ────────────────────────────────────
      if (verdictPending && wallCount >= VERDICT_SAMPLES) {
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
        holding = 'in band';
        return;
      }

      const wantDown = overFor >= DOWN_DWELL && index < LADDER.length - 1 && !stalled;
      const wantUp = underFor >= UP_DWELL && index > 0;
      if (!wantDown && !wantUp) {
        holding = over ? (stalled ? 'over budget (stalled)' : 'over budget') : 'under budget';
        return;
      }
      if (!onAStraight()) {
        holding = 'mid-corner';
        return;
      }
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
