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
// So this file reads `ctx.budget`, which the engine now fills in every rendered
// frame with the three costs of that frame kept apart (see `FrameBudget`), and
// walks a ladder.
//
// ── The three things that make a governor either useful or a menace ─────────
//
// **1. It must not oscillate.** A ladder that drops a rung, gets faster, climbs
// back, gets slower and drops again is worse than no ladder at all: the player
// watches the shadows and the draw distance breathe. Three separate mechanisms
// stop it, and all three are needed. The thresholds are far apart (a 6ms dead
// band between "too slow" and "there is room"); the dwells are asymmetric —
// a rung is lost after 1.2s over budget and regained only after 6s under it, so
// a single hitch can cost a rung but can never win one back on its own; and
// every change is followed by a lockout long enough for the change's *own*
// transient (a shadow map reallocating, a shader recompiling, a batch of
// dressing coming back into range) to pass before anything is measured again.
//
// **2. It must not change mid-corner.** This is the one a purely numerical
// governor gets wrong. The frames that blow the budget are exactly the frames
// where a lot is happening — a hairpin with the pack alongside, a mini-turbo
// firing, dust in the air — so a naive ladder does all its switching at the
// precise moments the player is concentrating hardest, and the draw distance
// pops at the apex. Changes wait for a straight: the road under the player and
// the road for the next second and a bit both have to be straight, and the
// player has to be planted, not drifting, not boosting and not spun out. The
// exception is a genuine emergency — under forty frames a second the game is
// already failing the player worse than a pop ever could, and the rung goes
// immediately.
//
// **3. It must never touch the simulation.** There is no `fixedUpdate` in this
// file and there never may be. Everything the governor writes — `ctx.quality`,
// the renderer's shadow flag — is read only from `update` and from the draw:
// `world` scales its draw distances, `fx` its particle density, `lighting` its
// shadow map, `render/post` its stack. Nothing in physics, ai, items, race or
// track reads `ctx.quality` at all, which is what makes "the same seed puts
// every racer in the same place at every tier" a property of the design rather
// than a hope. `tools/qualitydiff` proves it by running one seed at both ends
// of the ladder and diffing the snapshots.
//
// ── What it will not do ────────────────────────────────────────────────────
//
// It parks itself the moment anything drives the game through `window.__GAME`.
// A capture renders six fixed steps at a time from a Node round trip on a
// software rasteriser at two hundred milliseconds a frame; read as gameplay
// that is an argument for the low tier, and the review sheet would quietly
// photograph the wrong game. `budget.benchFrames` is how the engine tells the
// two apart, and a bench frame parks the governor for two seconds.
//
// It also stands down permanently the moment a human or a reviewer picks a tier
// by hand, because that is a decision and this is only a measurement.

import { config } from './config.ts';
import type {
  GameContext, GameSystem, QualitySettings, RaceConfig, SplineSample,
} from '../types.ts';

// ── the ladder ─────────────────────────────────────────────────────────────

/**
 * A rung is a complete `QualitySettings`, derived from `config.quality` rather
 * than written out again — the three tiers stay the authored anchors and the
 * two rungs between them are trims on top, so a change to `config.quality`
 * moves the whole ladder with it.
 *
 * Five rungs rather than three because three is too coarse to settle on: the
 * step from `high` to `med` halves the shadow map, drops the draw distance a
 * fifth and takes 40% of the particles all at once, which is both very visible
 * and usually far more than the frame actually needed.
 */
interface Rung {
  /** Shown in `stats()` and in the probe. */
  readonly label: string;
  readonly settings: QualitySettings;
}

function rung(
  label: string, tier: QualitySettings['tier'], trim: Partial<QualitySettings> = {},
): Rung {
  return { label, settings: { tier, ...config.quality[tier], ...trim } };
}

/**
 * Rung 0 is the most expensive. The governor only ever moves one step.
 *
 * The trims are chosen so each step down buys roughly the same amount back:
 * draw distance is the cheapest thing to give up (the dressing that goes is
 * beyond the range at which it is anything but a smudge — see the `far`
 * distances in world/index.ts), particles the next cheapest, and the shadow map
 * last, because contact is the thing this game's art direction is least willing
 * to lose.
 */
const LADDER: readonly Rung[] = [
  rung('high', 'high'),
  rung('high-', 'high', { shadowSize: 1024, particles: 0.8, drawDistance: 0.86 }),
  rung('med', 'med'),
  rung('med-', 'med', { shadowSize: 512, particles: 0.45, drawDistance: 0.66 }),
  rung('low', 'low'),
];

/** Where the game starts. Top of the ladder — the governor's job is to earn
 *  its way down, not to guess a machine's class before it has drawn a frame. */
const START_RUNG = 0;

// ── the thresholds ─────────────────────────────────────────────────────────
//
// All in milliseconds of *measured work* (sim + update + draw), which is what
// `ctx.budget` reports. That number excludes the idle a frame spends waiting
// for vsync, so it is smaller than a wall-clock frame time by design: 16.7ms of
// work is a frame with no headroom at all, not a frame that just made it.

/** Sustained work above this is a machine that is not making sixty. */
const DOWN_MS = 14.5;
/** ...and below this there is room for a rung back. The gap is the dead band. */
const UP_MS = 8.5;
/** Below forty frames a second the ladder stops waiting for a straight. */
const PANIC_MS = 25;

/** Seconds over `DOWN_MS` before a rung is given up. */
const DOWN_DWELL = 1.2;
/** ...and under `UP_MS` before one is taken back. Deliberately five times as
 *  long: a hitch may cost a rung, but nothing wins one back by accident. */
const UP_DWELL = 6;
/** Seconds after any change during which nothing is measured or decided. */
const SETTLE = 2.5;
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
 * down to the low tier one rung at a time.
 *
 * What actually separates the two is *burstiness*. `advance()` and the capture's
 * `settle()` render eighteen to twenty-eight frames back to back; the front end
 * renders exactly one, once, to prime shaders at the start of a race. So a
 * second bench frame arriving within a second of the first is a bench, full
 * stop, and no measurement taken on this page is about a player's machine.
 */
const BENCH_BURST = 1;
/** Live frames before any verdict. Four seconds at sixty: shader compilation,
 *  texture upload and the JIT all happen in the first second of a race, and
 *  none of them are evidence about the machine. */
const WARMUP_FRAMES = 240;
/** Curvature that still counts as straight. ~250m radius. */
const STRAIGHT = 0.004;
/** Seconds of road ahead that also has to be straight. */
const LOOKAHEAD = 1.3;

export interface QualityProbe {
  auto: boolean;
  rung: number;
  label: string;
  tier: QualitySettings['tier'];
  drawDistance: number;
  particles: number;
  shadowSize: number;
  meanMs: number;
  worstMs: number;
  simMs: number;
  drawMs: number;
  /** Seconds the current verdict has been held. Negative while settling. */
  dwell: number;
  /** Why the governor is not acting right now, or '' when it is free to. */
  holding: string;
}

export function createQualitySystem(ctx: GameContext): GameSystem {
  let index = START_RUNG;
  let auto = true;
  /** The exact object we last wrote to `ctx.quality`, so a tier set by anyone
   *  else is recognisable by identity rather than by comparing fields. */
  let applied: QualitySettings | null = null;

  /** Seconds over `DOWN_MS` / under `UP_MS`. One of the two is always zero. */
  let overFor = 0;
  let underFor = 0;
  let settleFor = SETTLE;
  /** -1 until the first frame we observe, so boot's own primed frame is free. */
  let benchFrames = -1;
  let benchQuietFor = 0;
  /** Latched: this page is a bench, and nothing it measures is about a player. */
  let benched = false;
  let holding = 'settling';

  // Our own sample buffers. `track.sample()` and `spline.atDistance()` both
  // hand back a shared scratch when none is supplied, and the camera and the
  // contact pass are reading theirs in the same frame — see the note in
  // render/contact.ts. Nothing here allocates after init.
  let here: SplineSample | null = null;
  let ahead: SplineSample | null = null;

  function applyRung(next: number, why: string): void {
    index = next < 0 ? 0 : next >= LADDER.length ? LADDER.length - 1 : next;
    const q: QualitySettings = { ...LADDER[index]!.settings };
    ctx.quality = q;
    applied = q;
    ctx.renderer.shadowMap.enabled = q.shadows;
    ctx.renderer.shadowMap.needsUpdate = true;
    overFor = 0;
    underFor = 0;
    settleFor = 0;
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
      rung: index,
      label: LADDER[index]?.label ?? String(q.tier),
      tier: q.tier,
      drawDistance: +q.drawDistance.toFixed(3),
      particles: +q.particles.toFixed(3),
      shadowSize: q.shadows ? q.shadowSize : 0,
      meanMs: +(b?.meanMs ?? 0).toFixed(3),
      worstMs: +(b?.worstMs ?? 0).toFixed(3),
      simMs: +(b?.meanSimMs ?? 0).toFixed(3),
      drawMs: +(b?.meanDrawMs ?? 0).toFixed(3),
      dwell: +(settleFor < SETTLE ? settleFor - SETTLE : overFor || underFor).toFixed(2),
      holding,
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
        holding = 'pinned';
      });

      (globalThis as unknown as Record<string, unknown>).__QUALITY = {
        probe,
        /** Hand the ladder back to the measurement, or take it away. */
        auto(on: boolean): boolean {
          auto = on !== false;
          if (auto) { overFor = 0; underFor = 0; settleFor = 0; }
          return auto;
        },
        /** Pin a rung by index. For the bench — a player picks a tier. */
        set(i: number): number {
          auto = false;
          applyRung(i, 'pinned');
          holding = 'pinned';
          return index;
        },
        ladder: LADDER.map((r) => r.label),
      };
    },

    reset(_cfg: RaceConfig): void {
      // A fresh race gets a fresh verdict: whatever the previous one measured
      // was measured against a different course, a different field and, if the
      // harness reset us, a different machine's worth of work.
      overFor = 0;
      underFor = 0;
      settleFor = 0;
      benchQuietFor = 0;
      // `benched` is deliberately *not* cleared: a page that has been driven by
      // the harness once stays a bench. `benchFrames` is, so the frame the
      // front end primes for this race reads as the first one again.
      benchFrames = -1;
      // The rung itself is *not* reset. A machine that earned its way down to
      // `med` in the last race has not become faster by starting another one,
      // and re-climbing the ladder every race is the oscillation this whole
      // file exists to avoid — just spread over minutes instead of seconds.
      if (auto && applied !== ctx.quality) applyRung(index, 'settling');
    },

    /**
     * Visuals only, and only ever a read of the budget. Nothing here is allowed
     * to reach the simulation, and nothing here allocates: the sample buffers
     * are owned, the probe object is built only when somebody asks for it.
     */
    update(dt: number): void {
      const b = ctx.budget;
      if (!b) return;
      const step = dt > 0.25 ? 0.25 : dt > 0 ? dt : 0;

      // `benchFrames` only moves when `renderFrame` was called from outside the
      // rAF loop: the front end primes exactly one such frame per race start,
      // and the test harness renders them in bursts. Two inside a second and
      // this page is a bench for good.
      if (b.benchFrames !== benchFrames) {
        if (benchFrames >= 0 && benchQuietFor < BENCH_BURST) benched = true;
        benchFrames = b.benchFrames;
        benchQuietFor = 0;
      } else {
        benchQuietFor += step;
      }

      if (!auto) { holding = 'pinned'; return; }
      if (benched) { holding = 'bench'; return; }
      if (benchQuietFor < BENCH_HOLD) {
        holding = 'priming';
        overFor = 0;
        underFor = 0;
        return;
      }
      if (settleFor < SETTLE) {
        settleFor += step;
        holding = 'settling';
        return;
      }
      // A frame the loop never drove tells us nothing about how fast it can go.
      if (b.liveFrames < WARMUP_FRAMES) { holding = 'warming'; return; }

      const ms = b.meanMs;
      if (ms > DOWN_MS) {
        overFor += step;
        underFor = 0;
      } else if (ms < UP_MS) {
        underFor += step;
        overFor = 0;
      } else {
        overFor = 0;
        underFor = 0;
        holding = 'in band';
        return;
      }

      const wantDown = overFor >= DOWN_DWELL && index < LADDER.length - 1;
      const wantUp = underFor >= UP_DWELL && index > 0;
      if (!wantDown && !wantUp) {
        holding = wantDownSoon(overFor, underFor);
        return;
      }

      // The one case that does not wait for a straight: below forty frames a
      // second the player is already being failed harder than a pop would fail
      // them, and holding the rung to protect the apex protects nothing.
      if (wantDown && ms > PANIC_MS) {
        applyRung(index + 1, 'dropped (panic)');
        return;
      }
      if (!onAStraight()) {
        holding = 'mid-corner';
        return;
      }
      applyRung(index + (wantDown ? 1 : -1), wantDown ? 'dropped' : 'raised');
    },

    dispose(): void {
      delete (globalThis as unknown as Record<string, unknown>).__QUALITY;
    },
  };
}

/** Short reason string without building one per frame. */
function wantDownSoon(over: number, under: number): string {
  return over > 0 ? 'over budget' : under > 0 ? 'under budget' : 'in band';
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
