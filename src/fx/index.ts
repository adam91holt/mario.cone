// Effects and spectacle.
//
// The job of this module is to make every state change in the simulation
// legible without a single word of text. A player must be able to read, from
// the picture alone: that they are drifting, how far the mini-turbo has charged,
// that it just fired, what they are driving on, how hard they landed, and that
// they have crossed the line.
//
// Three positions the whole file is built on:
//
//   The sparks are the meter. Mario Kart's mini-turbo has no HUD element; the
//   charge is read entirely off the colour coming out of the rear wheels, and
//   that colour has to change on the exact frame the tier locks in, with a
//   punctuation mark loud enough to notice in peripheral vision. Everything else
//   here is decoration next to that.
//
//   Everything is one draw call per blend mode. Sparks, dust, flame, confetti,
//   shock rings and speed lines all share one atlas and one instanced buffer
//   (see sprites.ts). Eight karts drifting at once costs three draw calls, not
//   three hundred.
//
//   Simulation events are *impulses*, not spawns. Every handler here records a
//   saturating scalar and the next rendered frame spends it. That is what makes
//   the module survive the capture harness, which steps the simulation for
//   seconds at a time without drawing: a naive handler would spawn ten thousand
//   particles into a pool that never ages, and the first drawn frame would be a
//   wall of dust. It also means nothing this file does can ever run at a rate
//   the renderer does not control.
//
// Ownership: everything in `src/fx/**`. This module writes to `ctx.fx` and to
// the camera's *orientation* (shake, applied after the camera system has posed
// it, and never to its position — the camera damps its own boom in world space
// and feeding a shake back into that would make the rig drift).

import * as THREE from 'three';
import { DEG, clamp, clamp01, damp, fbm1, lerp, makeRng } from '../core/math.ts';
import { getVehicle } from '../vehicles/registry.ts';
import { CELL, createAtlas } from './atlas.ts';
import { MODE, createSpriteLayer } from './sprites.ts';
import { createParticlePool, makeSpec } from './particles.ts';
import { createTyreMarks } from './marks.ts';
import { createScreenFx } from './screen.ts';
import { portsFor } from './exhaust.ts';
import type { Rng } from '../core/math.ts';
import type { SpriteLayer } from './sprites.ts';
import type {
  FxSystem, GameContext, GameSystem, RaceConfig, Racer, Surface, SplineSample,
} from '../types.ts';

/** Mirrors RIDE_HEIGHT in physics/kart.ts: how far a racer's simulated origin
 *  floats above the surface it is standing on. Wheel contact points are derived
 *  from it, so if physics changes its suspension this has to follow. */
const RIDE_HEIGHT = 0.55;

const TAU = Math.PI * 2;

/** Pool sizes. Generous — the whole point of a pool is that a spectacular
 *  moment is never the moment it runs out. */
// The alpha layer carries the whole continuous half of the module now — dust,
// exhaust from eight machines, tyre haze, smoke, confetti — so it is the one
// with the most headroom. A layer that silently drops pushes past its cap
// thins the effect exactly when the frame is busiest, which is the frame the
// reviewer photographs.
const POOL = 3800;
const LAYER_ADD = 1900;
const LAYER_ALPHA = 2400;
const LAYER_RUSH = 240;
const MARK_QUADS = 2600;

/**
 * How a surface answers to a tyre. `rate` is puffs per second at top speed;
 * `slip` is the extra that only happens when the tyres are actually sliding,
 * which is why tarmac throws almost nothing until you commit to a drift.
 *
 * `color` is deliberately *not* the surface's own colour. Dust the colour of
 * the ground it came off is invisible against that ground — which is exactly
 * what happened here: tan dust over Cone Canyon's tan verge produced a kart
 * running through dirt at 90km/h with nothing visible behind it at all. Real
 * dust is lit from every direction at once and always reads paler than the
 * surface, so each of these is its ground colour lifted well toward white.
 *
 * `deep` is where it settles as it thins out — and the hard rule this table now
 * obeys is that **`deep` is still paler than the lit surface**. It used to be
 * the ground's own mid-tone, which meant every puff spent the back half of its
 * life crossing from paler-than-the-road to darker-than-the-road, and since a
 * puff is at its largest at the end of its life, what a screenshot caught was
 * a near-black soft disc lying flat on the asphalt. Reviewers read those as oil
 * stains, and they were right to: nothing suspended in air and lit by the sky
 * can be darker than the ground it is floating over. Smoke can be *grey*; it
 * cannot be *dark*.
 *
 * `alpha` is roughly half what it was and the rates are roughly double, which
 * is the same total density arranged as wisps rather than as lumps. A cloud
 * that is fifteen faint sprites has an edge and a shape; the same opacity in
 * four solid ones is a smudge on the lens.
 */
interface SurfaceFx {
  color: number;
  deep: number;
  /** How much this surface throws *upward*. Tarmac smoke stays on the deck;
   *  loose dirt and sand billow. One value for all of them left a kart running
   *  through dirt at 100km/h trailing a decal painted on the verge. */
  lift: number;
  rate: number;
  slip: number;
  /**
   * Puffs per second from *speed alone*, at the top of the range.
   *
   * The term that did not exist. Dust used to require either a loose surface or
   * a sliding tyre, so a machine tracking straight and true down the tarmac at
   * 240 km/h disturbed precisely nothing — which is why a pack shot at racing
   * speed photographed as a set of parked models. Anything moving that fast
   * over a road drags a wake off it, and that wake is most of what tells a
   * still frame how fast the frame is.
   */
  wake: number;
  size: number;
  grow: number;
  alpha: number;
  /**
   * Fraction of the emission that comes off as *solid matter* rather than as
   * dust — clods, gravel, torn grass. Dust alone has no edge in it: seven soft
   * lobes at 60% alpha, however many of them you stack up, is a smudge, and a
   * kart crossing a gravel trap at 90km/h behind a smudge reads as a rendering
   * artefact rather than as a mistake with a cost. The grit is what tells the
   * eye the ground came apart. Tarmac has none of it; it has nothing loose to
   * give.
   */
  grit: number;
  /** Metal on metal: sparks rather than dust. */
  sparky: boolean;
  /** Multiplier on tyre-mark darkness, and the mark's own tint. */
  mark: number;
  markTint: number;
}

const SURFACE_FX: Record<Surface, SurfaceFx> = {
  road:  { color: 0xEAEEF6, deep: 0xCED4E0, lift: 0.18, rate: 0,   slip: 132, wake: 26, size: 0.26, grow: 2.2, alpha: 0.12, grit: 0.00, sparky: false, mark: 1.00, markTint: 0x272630 },
  boost: { color: 0xF3E8D6, deep: 0xDCD1BE, lift: 0.20, rate: 0,   slip: 116, wake: 26, size: 0.28, grow: 2.2, alpha: 0.13, grit: 0.00, sparky: false, mark: 0.80, markTint: 0x2a2833 },
  dirt:  { color: 0xF7E6C6, deep: 0xDCBE93, lift: 1.00, rate: 156, slip: 124, wake: 58, size: 0.42, grow: 2.4, alpha: 0.28, grit: 0.42, sparky: false, mark: 0.85, markTint: 0x8a6236 },
  sand:  { color: 0xFDF4E0, deep: 0xEBD9AF, lift: 1.10, rate: 168, slip: 128, wake: 62, size: 0.44, grow: 2.5, alpha: 0.30, grit: 0.26, sparky: false, mark: 0.72, markTint: 0x9c8050 },
  grass: { color: 0xE3F0CC, deep: 0xB2CE8C, lift: 0.75, rate: 108, slip: 96,  wake: 42, size: 0.38, grow: 2.2, alpha: 0.24, grit: 0.36, sparky: false, mark: 0.62, markTint: 0x5c7a3e },
  water: { color: 0xF8FDFF, deep: 0xD7EFFA, lift: 1.25, rate: 172, slip: 132, wake: 58, size: 0.34, grow: 2.1, alpha: 0.26, grit: 0.30, sparky: false, mark: 0.00, markTint: 0xffffff },
  rail:  { color: 0xCFE2FF, deep: 0xCFE2FF, lift: 0.20, rate: 0,   slip: 22,  wake: 0,  size: 0.22, grow: 1.4, alpha: 0.90, grit: 0.00, sparky: true,  mark: 0.00, markTint: 0xffffff },
  air:   { color: 0xffffff, deep: 0xffffff, lift: 0.00, rate: 0,   slip: 0,   wake: 0,  size: 0.40, grow: 2.0, alpha: 0.00, grit: 0.00, sparky: false, mark: 0.00, markTint: 0xffffff },
};

/** Confetti. High-vis roadworks, not a birthday party. */
const CONFETTI = [0xFF6B1A, 0xFFC300, 0xFFF8F0, 0x5FC8F5, 0x6FCF4A, 0xE33B2E, 0xE040FB];

/** Per-racer bookkeeping. Nothing here is simulation state — it is all either a
 *  fractional emission accumulator or an impulse waiting to be spent. */
interface RacerFx {
  spark: number;
  dust: number;
  /** Fractional emitter for the clods thrown off a loose surface. */
  grit: number;
  flame: number;
  /** Fractional emitter for the always-on exhaust. One per port. */
  exhaust: number;
  exhaust2: number;
  /** Fractional emitter for the tyre haze under the drift sparks. */
  scrub: number;
  /** Fractional emitter for the speed wake. */
  wake: number;
  /** Charge this racer was carrying last frame, so a *release* can be seen
   *  without physics having to announce one. */
  lastCharge: number;
  lastTier: number;
  /** Decaying acknowledgement of a drift release, and the tier it was worth. */
  release: number;
  releaseTier: number;
  /**
   * "I am boosting", as an envelope this module owns rather than as a read of
   * `boost.time`. Set when a boost fires, held, then released slowly. The point
   * is that every boost source — pad, mushroom, mini-turbo, trick, rocket start
   * — produces the same shape, so the state reads one way instead of four.
   */
  boostEnv: number;
  /** Eased 0..1 drift intensity, driving the wheel glow. */
  glow: number;
  /** Decaying pop when a mini-turbo tier locks in, and which tier it was. */
  pop: number;
  popTier: number;

  pendDriftStart: number;
  pendTier: number;
  pendBoost: number;
  boostTier: number;
  pendLand: number;
  pendHop: number;
  pendOffroad: number;
  pendWall: number;
  pendHit: number;
  pendTrick: number;
  pendBump: number;
  pendBurnout: number;
  pendLaunch: number;
  pendDraft: number;
  pendCoin: number;
  pendCoinLoss: number;
  pendPowerUp: number;
  bumpX: number; bumpY: number; bumpZ: number;

  /** 1 while this racer is in someone's slipstream. */
  draft: number;
  /** Eased draft, so the wind builds and lets go rather than snapping. */
  draftEase: number;
  /** Fractional emitter for the star-power sparkle. */
  sparkle: number;

  /** Seconds left of barrier-scrape sparks, and which flank they come from. */
  grind: number;
  grindSide: number;
  /** Recomputed each frame: how much this racer's effects are worth drawing. */
  near: number;
}

function newRacerFx(): RacerFx {
  return {
    spark: 0, dust: 0, grit: 0, flame: 0, exhaust: 0, exhaust2: 0, scrub: 0, wake: 0,
    lastCharge: 0, lastTier: 0, release: 0, releaseTier: 0, boostEnv: 0,
    glow: 0, pop: 0, popTier: 0,
    pendDriftStart: 0, pendTier: 0, pendBoost: 0, boostTier: 0,
    pendLand: 0, pendHop: 0, pendOffroad: 0, pendWall: 0, pendHit: 0,
    pendTrick: 0, pendBump: 0, pendBurnout: 0, pendLaunch: 0, pendDraft: 0,
    pendCoin: 0, pendCoinLoss: 0, pendPowerUp: 0,
    bumpX: 0, bumpY: 0, bumpZ: 0,
    draft: 0, draftEase: 0, sparkle: 0,
    grind: 0, grindSide: 1, near: 1,
  };
}

// ── scratch. Nothing in this file may allocate per frame ────────────────────
const _pos = new THREE.Vector3();
/** The player's interpolated position, kept after the racer loop has moved on. */
const _playerPos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _p = new THREE.Vector3();
const _lat = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _shakeQ = new THREE.Quaternion();
const _shakeE = new THREE.Euler();
const _tint = new THREE.Color();
const _sample: SplineSample = {
  pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
  right: new THREE.Vector3(), up: new THREE.Vector3(),
  width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
};

/** Deferred `ctx.fx.spawn` calls. Fixed capacity: a caller in a runaway loop
 *  must never be able to make this module allocate. */
const QUEUE = 32;

export function createFxSystem(ctx: GameContext): GameSystem {
  const K = ctx.config.kart;

  // Mini-turbo colours, straight off the tuning table so the sparks and the
  // physics can never disagree about what "tier 2" looks like. Index 0 is the
  // uncharged state: small white sparks, exactly as in MK8 — the drift is doing
  // something before it is worth anything.
  //
  // Two adjustments, both about surviving the pipe rather than about taste.
  //
  // Normalised to a peak channel of 1: the three tuning colours differ by a
  // third in brightness, and unnormalised the tier read partly as "brighter"
  // instead of purely as "a different colour", which is the wrong axis — the
  // player is being told *which* tier, not *how much*.
  //
  // Then a per-tier gain, because the frame is graded through ACES. ACES pulls
  // anything much past 2.5 toward white, and it does it fastest on warm hues:
  // at the old gain of 4.6 the orange tier arrived on screen as a white blob,
  // which is to say the middle third of the mini-turbo had no colour at all.
  // These gains are the brightest each hue can be pushed and still land as that
  // hue. Purple gets more headroom because magenta is the darkest of the three
  // and would otherwise read as the weakest tier.
  const norm = (hex: number): THREE.Color => {
    const c = new THREE.Color(hex);
    const peak = Math.max(c.r, c.g, c.b);
    if (peak > 1e-4) c.multiplyScalar(1 / peak);
    return c;
  };
  const TIER = [
    norm(0xFFF2D8),
    norm(K.drift.tiers[0]!.color),
    norm(K.drift.tiers[1]!.color),
    norm(K.drift.tiers[2]!.color),
  ];
  const TIER_HEX = [
    0xFFF2D8, K.drift.tiers[0]!.color, K.drift.tiers[1]!.color, K.drift.tiers[2]!.color,
  ];
  /** Peak HDR gain per tier — above this the hue starts bleaching. */
  const TIER_GAIN = [2.0, 2.3, 2.05, 2.9];
  /** Sparks per second, summed over both rear wheels, per tier. */
  const TIER_RATE = [90, 210, 265, 320];

  const FLAME_HOT = new THREE.Color(0xFFF0C0);
  const FLAME_MID = new THREE.Color(0xFF7A18);
  const FLAME_END = new THREE.Color(0x8C2A06);
  // Smoke, and the deeper tone it thins out to.
  //
  // Both are *pale*. The old value was 0x6B6258 fading to half of that, which
  // in linear radiance is darker than sunlit tarmac — so the loudest moment in
  // the game left a row of near-black discs lying on the road behind the kart.
  // Real tyre smoke is a suspension lit from the sky in every direction; it
  // reads as a light haze against dark ground and only ever goes grey where it
  // is thick. Anything in this module that is *airborne* is now bound by that:
  // never darker than the surface it is floating over.
  const SMOKE = new THREE.Color(0xD9DCE3);
  const SMOKE_DEEP = new THREE.Color(0xADB3C0);
  const WARM_WHITE = new THREE.Color(0xFFE7C0);
  const WHITE_HOT = new THREE.Color(1, 1, 1);
  const GOLD = new THREE.Color(0xFFD24D);
  const RAIL_SPARK = new THREE.Color(0xFFE9C0);
  const surfaceColors = new Map<Surface, THREE.Color>();
  const surfaceDeep = new Map<Surface, THREE.Color>();
  for (const key of Object.keys(SURFACE_FX) as Surface[]) {
    surfaceColors.set(key, new THREE.Color(SURFACE_FX[key].color));
    surfaceDeep.set(key, new THREE.Color(SURFACE_FX[key].deep));
  }
  const markTints = new Map<Surface, THREE.Color>();
  for (const key of Object.keys(SURFACE_FX) as Surface[]) {
    markTints.set(key, new THREE.Color(SURFACE_FX[key].markTint));
  }
  const confettiColors = CONFETTI.map((h) => new THREE.Color(h));

  // ── specs. One preset per effect, mutated in place and never replaced ──────
  // `stretch` is now metres of half-length per m/s of camera-relative speed, so
  // 0.05 turns a spark thrown clear at 14 m/s into a streak about 1.4m long and
  // leaves one keeping pace with the kart as a point. That difference is the
  // whole silhouette of a mini-turbo.
  const sparkSpec = makeSpec({
    cell: CELL.spark, mode: MODE.velocity, additive: true,
    life: 0.34, size0: 0.20, size1: 0.03, alpha: 1,
    gravity: 15, drag: 2.0, stretch: 0.05, fadeIn: 0,
  });
  const emberSpec = makeSpec({
    cell: CELL.glow, mode: MODE.billboard, additive: true,
    life: 0.22, size0: 0.34, size1: 0.05, alpha: 0.85,
    gravity: 6, drag: 3.0, fadeIn: 0,
  });
  // Dust wants to *sit* where the tyre threw it and spread, not climb. The old
  // -0.9 gravity floated every puff a metre and a half up over its life, which
  // left the road behind a drifting kart hung with grey blobs at windscreen
  // height. -0.2 is enough to keep it from sinking through the tarmac and no
  // more.
  // `fadeIn` used to be nearly a quarter of the life. A puff is only inside the
  // frame for the first half of its life — after that the kart has driven out
  // from under it and the chase camera has gone with the kart — so a long fade
  // in means the only part of the cloud a player ever sees is the part that has
  // not arrived yet.
  const dustSpec = makeSpec({
    cell: CELL.puff, mode: MODE.billboard, additive: false,
    life: 0.8, size0: 0.45, size1: 1.5, alpha: 0.22,
    gravity: -0.2, drag: 1.5, fadeIn: 0.12,
  });
  const flameSpec = makeSpec({
    cell: CELL.glow, mode: MODE.billboard, additive: true,
    life: 0.28, size0: 0.5, size1: 1.25, alpha: 0.95,
    gravity: -3, drag: 4.5, fadeIn: 0.07,
  });
  const smokeSpec = makeSpec({
    cell: CELL.puff, mode: MODE.billboard, additive: false,
    life: 0.85, size0: 0.38, size1: 1.5, alpha: 0.12,
    gravity: -1.4, drag: 2.2, fadeIn: 0.2,
  });
  // Exhaust. Its own preset rather than a borrowed smoke spec: it is the only
  // emitter in the module that runs on every machine on the track for the whole
  // race, so it has to be the cheapest and the quietest thing here.
  const exhaustSpec = makeSpec({
    cell: CELL.puff, mode: MODE.billboard, additive: false,
    life: 0.5, size0: 0.16, size1: 0.5, alpha: 0.12,
    // Negative gravity: hot gas rises, and rising is what lifts the plume out
    // of the machine's own shadow and puts it against the road or the sky where
    // it can actually be seen. Low drag so it keeps climbing rather than
    // stalling in place a metre behind the pipe.
    gravity: -1.6, drag: 1.6, fadeIn: 0.14,
  });
  // The speed wake.
  //
  // Its own shape, and the shape is the point. Emitted as round puffs it came
  // out as a line of pale cotton balls trailing the machine — the exact "grey
  // blobs that look like smudges on the lens" this module was rejected for.
  // What is actually happening is air and fine grit being *dragged*, so it is
  // drawn in velocity mode: each particle stretches along the path it takes
  // across the frame, which at 240 km/h turns it into a soft streak pointing
  // back down the road and at a standstill leaves nothing at all. A shape that
  // only exists when the machine is moving fast is a shape that can only ever
  // read as speed.
  const wakeSpec = makeSpec({
    cell: CELL.puff, mode: MODE.velocity, additive: false,
    life: 0.42, size0: 0.30, size1: 0.75, alpha: 0.10,
    gravity: -0.2, drag: 1.1, stretch: 0.035, fadeIn: 0.14,
  });
  // Tyre scrub. The pale haze that lives *under* the mini-turbo sparks. Wide,
  // flat and very faint: it is a bed for the sparks to sit on, and the moment
  // it is dense enough to notice on its own it is competing with them.
  const scrubSpec = makeSpec({
    cell: CELL.puff, mode: MODE.billboard, additive: false,
    life: 0.55, size0: 0.42, size1: 1.5, alpha: 0.13,
    gravity: -0.35, drag: 2.4, fadeIn: 0.1,
  });
  const ringSpec = makeSpec({
    cell: CELL.ring, mode: MODE.ground, additive: true,
    life: 0.42, size0: 1.2, size1: 7.0, alpha: 0.9, fadeIn: 0.04,
  });
  const flakeSpec = makeSpec({
    cell: CELL.flake, mode: MODE.billboard, additive: false,
    life: 3.2, size0: 0.26, size1: 0.26, alpha: 1,
    gravity: 9, drag: 0.7, fadeIn: 0.03,
  });
  const starSpec = makeSpec({
    cell: CELL.star, mode: MODE.billboard, additive: true,
    life: 0.7, size0: 0.5, size1: 0.1, alpha: 1,
    gravity: 8, drag: 1.4, fadeIn: 0,
  });
  // Clods, gravel, torn turf. The spark cell on the *alpha* layer, opaque and
  // dark: additive matter is a contradiction, and it is the darkness that gives
  // the pale dust something to be pale against. Heavy gravity and almost no
  // drag, so each one draws a ballistic arc out of the cloud and back down —
  // which is the read the dust alone can never deliver, because a cloud has no
  // trajectory, only a shape.
  const gritSpec = makeSpec({
    cell: CELL.spark, mode: MODE.velocity, additive: false,
    life: 0.5, size0: 0.16, size1: 0.10, alpha: 0.95,
    gravity: 24, drag: 0.25, stretch: 0.012, fadeIn: 0,
  });
  // ── owned objects ─────────────────────────────────────────────────────────
  let atlas: THREE.Texture | null = null;
  let addLayer: SpriteLayer | null = null;
  let alphaLayer: SpriteLayer | null = null;
  let rushLayer: SpriteLayer | null = null;
  const pool = createParticlePool(POOL);
  const marks = createTyreMarks(ctx, MARK_QUADS);
  const screen = createScreenFx();

  // A private stream. Emission runs at render rate, and pulling from `ctx.rng`
  // here would let the number of frames drawn change the simulation.
  let rng: Rng = makeRng(0x9e37);

  const state = new Map<number, RacerFx>();
  const bumpAt = new Map<number, number>();
  const sizeCache = new Map<string, { halfW: number; len: number; height: number }>();

  let density = 1;
  let trauma = 0;
  let traumaDecay = 3;
  let lineAcc = 0;

  // The camera's own world velocity, so velocity-mode quads can streak against
  // the frame rather than against the world. Differenced from its position
  // rather than read off the camera system, which owns no such number.
  const camPrev = new THREE.Vector3();
  const camVel = new THREE.Vector3();
  let camPrimed = false;

  // Global impulses.
  let pendCountdown = 0;
  let pendGo = 0;
  let pendConfetti = 0;
  let pendLapPop = 0;

  const qId: string[] = new Array(QUEUE).fill('');
  const qX = new Float32Array(QUEUE);
  const qY = new Float32Array(QUEUE);
  const qZ = new Float32Array(QUEUE);
  const qScale = new Float32Array(QUEUE);
  const qColor = new Int32Array(QUEUE);
  let qCount = 0;

  const fxOf = (racer: Racer): RacerFx => {
    let s = state.get(racer.id);
    if (!s) { s = newRacerFx(); state.set(racer.id, s); }
    return s;
  };

  function sizeOf(racer: Racer): { halfW: number; len: number; height: number } {
    let s = sizeCache.get(racer.vehicleId);
    if (!s) {
      const size = getVehicle(racer.vehicleId).size;
      s = {
        halfW: clamp(size.width * 0.5, 0.5, 1.6),
        len: clamp(size.length, 1.5, 5.5),
        height: clamp(size.height, 1, 3.2),
      };
      sizeCache.set(racer.vehicleId, s);
    }
    return s;
  }

  /** Load the shared frame for a racer: interpolated transform plus its axes. */
  function frameOf(racer: Racer, alpha: number): void {
    _pos.lerpVectors(racer.prevPos, racer.pos, alpha);
    _quat.copy(racer.prevQuat).slerp(racer.quat, alpha);
    _right.set(1, 0, 0).applyQuaternion(_quat);
    _up.set(0, 1, 0).applyQuaternion(_quat);
    _fwd.set(0, 0, 1).applyQuaternion(_quat);
  }

  /** A point in the racer's own frame. Requires `frameOf` first. */
  function local(sx: number, sy: number, sz: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(_pos)
      .addScaledVector(_right, sx)
      .addScaledVector(_up, sy)
      .addScaledVector(_fwd, sz);
  }

  /** Contact patch of a rear wheel, `lift` metres clear of the road. This is
   *  where rubber meets road: tyre marks and the pool of light a mini-turbo
   *  throws on the tarmac key off it. */
  function rearWheel(racer: Racer, side: number, lift: number, out: THREE.Vector3): THREE.Vector3 {
    const s = sizeOf(racer);
    return local(side * s.halfW * 0.86, -RIDE_HEIGHT + lift, -s.len * 0.34, out);
  }

  /**
   * Where the sparks actually come out. Not the contact patch — *outboard* of
   * the rear tyre and behind its trailing edge.
   *
   * This is the single correction that took the mini-turbo from a rumour to an
   * effect. Emitting at the contact patch puts the dense bright core of the
   * drift — the two thirds of it that never leaves the wheel, and the part that
   * carries the tier colour — thirteen centimetres off the road, dead centre of
   * a tyre a third of a metre wide, behind a metre of bodywork. It is drawn
   * every frame and the depth buffer eats all of it. What reached the screen
   * was the thin tail that had already escaped sideways, which is why a
   * committed tier-two drift photographed as an orange smudge under the machine
   * instead of as twin jets coming off the wheels.
   *
   * The offsets are relative to the same wheel the contact patch uses — half a
   * tyre width further out, a hand's breadth further back — so this stays welded
   * to the axle it belongs to across a cast whose track widths differ by three
   * to one, rather than being a number tuned against one model's silhouette.
   */
  function sparkPort(racer: Racer, side: number, lift: number, out: THREE.Vector3): THREE.Vector3 {
    const s = sizeOf(racer);
    return local(side * (s.halfW * 0.86 + 0.17), -RIDE_HEIGHT + lift, -(s.len * 0.34 + 0.22), out);
  }

  /** Sideways travel as a fraction of forward travel — how hard the tyres are
   *  actually scrubbing, which is what dust and marks key off. */
  function slipOf(racer: Racer): number {
    _lat.copy(racer.vel);
    _lat.y = 0;
    const along = _lat.dot(_fwd);
    _lat.addScaledVector(_fwd, -along);
    return clamp01(_lat.length() / Math.max(7, Math.abs(racer.speed)));
  }

  const setHdr = (out: THREE.Color, src: THREE.Color, k: number): THREE.Color =>
    out.copy(src).multiplyScalar(k);

  // ── emitters ──────────────────────────────────────────────────────────────

  /**
   * The hero effect. Requires `frameOf(racer)`.
   *
   * Two populations, because a mini-turbo has two silhouettes at once and one
   * emitter cannot make both:
   *
   *   the *jet* keeps most of the kart's velocity, so it hangs at the tyre as a
   *   dense bright wedge and dies inside a fifth of a second. This is the part
   *   that reads at a glance, and the part that has to change colour cleanly.
   *
   *   the *fliers* keep almost none of it, so they are flung clear, arc down
   *   under heavy gravity and streak hard across the frame. Perhaps a quarter
   *   of the emission, and they are what stops the effect looking like a lamp
   *   bolted to the axle.
   *
   * Both are short-lived on purpose. The previous pass gave sparks half a second
   * of life against a drag that stopped them in three tenths, so the tail of
   * every spark's life was spent as a stationary glowing dot on the tarmac —
   * eight metres behind a kart doing 60 m/s, in a neat dotted line. Nothing here
   * may outlive its own motion.
   *
   * Both come out of `sparkPort`, not out of the contact patch — see the note
   * there. The jet in particular lives and dies within a metre of where it is
   * born, so it is entirely at the mercy of whether that point is somewhere the
   * camera can see.
   */
  function driftSparks(racer: Racer, fx: RacerFx, dt: number): void {
    const d = racer.drift;
    const tier = d.tier;
    const col = TIER[tier]!;
    const gain = TIER_GAIN[tier]!;

    // Rate rises with the tier and with how deep the chassis is thrown, so a
    // shallow counter-steered drift sizzles and a committed one roars.
    const depth = 0.55 + 0.45 * clamp01(Math.abs(d.angle) / K.drift.maxAngle);
    const rate = TIER_RATE[tier]! * depth * density * fx.near;
    fx.spark += rate * dt;
    let n = Math.floor(fx.spark);
    fx.spark -= n;
    // The cap is per racer per frame. It has to clear the worst case the review
    // harness produces — 20fps against tier three — or the sheet photographs a
    // thinner effect than the game has.
    if (n > 26) n = 26;

    const outward = -d.dir;
    const speed = Math.abs(racer.speed);
    const bite = 0.55 + 0.45 * clamp01(speed / 45);
    const inv = n > 0 ? 1 / n : 0;

    for (let i = 0; i < n; i++) {
      // Biased to the outside wheel: that is the one being dragged.
      const side = rng.next() < 0.7 ? outward : -outward;
      sparkPort(racer, side, 0.16, _p);
      // Spread the frame's worth of sparks back along the path the kart took
      // during it. Without this every spark in a frame is born at the same
      // point, and at 55 m/s and 20fps that is a dotted line of clumps three
      // metres apart instead of a stream. The review harness renders at 20fps.
      const back = (i + 0.5) * inv * dt;
      sparkSpec.px = _p.x - racer.vel.x * back + rng.range(-0.09, 0.09);
      sparkSpec.py = _p.y - racer.vel.y * back + rng.range(-0.03, 0.09);
      sparkSpec.pz = _p.z - racer.vel.z * back + rng.range(-0.09, 0.09);

      const flier = rng.next() < 0.28;
      const keep = flier ? 0.26 : 0.82;
      const kick = (flier ? rng.range(8, 17) : rng.range(2.4, 6.2)) * bite;
      const drop = flier ? rng.range(0.4, 2.6) : rng.range(0.6, 3.4);

      sparkSpec.vx = racer.vel.x * keep + _right.x * outward * kick
        - _fwd.x * drop + _up.x * rng.range(1.0, 4.2) + rng.range(-1.0, 1.0);
      sparkSpec.vy = racer.vel.y * keep + _right.y * outward * kick
        - _fwd.y * drop + _up.y * rng.range(1.0, 4.2) + rng.range(0.6, 2.6);
      sparkSpec.vz = racer.vel.z * keep + _right.z * outward * kick
        - _fwd.z * drop + _up.z * rng.range(1.0, 4.2) + rng.range(-1.0, 1.0);

      sparkSpec.life = flier ? rng.range(0.22, 0.38) : rng.range(0.09, 0.19);
      sparkSpec.size0 = flier ? rng.range(0.13, 0.24) : rng.range(0.17, 0.32);
      sparkSpec.gravity = flier ? 26 : 9;
      sparkSpec.drag = flier ? 0.6 : 1.1;
      sparkSpec.stretch = flier ? 0.055 : 0.045;
      // A white-hot head fading to the tier's own hue. Both ends matter: the
      // head is what makes it read as hot, the tail is what makes it read as
      // *blue*, and a spark that is only ever one of the two reads as neither.
      sparkSpec.color0.lerpColors(col, WHITE_HOT, 0.30).multiplyScalar(gain * rng.range(0.85, 1.15));
      setHdr(sparkSpec.color1, col, gain * 0.30);
      pool.emit(sparkSpec);

      // Every few sparks gets a soft companion, purely so the bloom pyramid has
      // something with area to find. Pinpoints alone do not glow. Kept small and
      // brief — at the old size they merged into one wash and swallowed the
      // sparks they were supposed to be flattering.
      if (tier > 0 && !flier && rng.next() < 0.34) {
        emberSpec.px = sparkSpec.px; emberSpec.py = sparkSpec.py; emberSpec.pz = sparkSpec.pz;
        emberSpec.vx = sparkSpec.vx * 0.85;
        emberSpec.vy = sparkSpec.vy * 0.85;
        emberSpec.vz = sparkSpec.vz * 0.85;
        emberSpec.life = rng.range(0.08, 0.16);
        emberSpec.size0 = rng.range(0.22, 0.40);
        setHdr(emberSpec.color0, col, gain * 0.9);
        setHdr(emberSpec.color1, col, 0.15);
        pool.emit(emberSpec);
      }
    }
    // Restore the shared preset: every other caller expects the defaults back.
    sparkSpec.gravity = 15;
    sparkSpec.drag = 2.0;
    sparkSpec.stretch = 0.05;
  }

  /**
   * The steady light at the wheels while a drift is held, and the flare that
   * marks a tier locking in. Immediate-mode: rebuilt every frame.
   *
   * A crisp four-point flare over a soft halo, rather than the stack of soft
   * balls this used to be. Three overlapping gaussians two metres across is a
   * coloured smear on the road; the flare gives the effect an *edge*, and an
   * edge is what peripheral vision can pick a colour off. It turns slowly, in
   * opposite directions on the two wheels, so the pair never reads as decals.
   */
  function driftGlow(racer: Racer, fx: RacerFx, add: SpriteLayer): void {
    const g = fx.glow;
    if (g < 0.02) return;
    const tier = racer.drift.active ? racer.drift.tier : fx.popTier;
    const col = TIER[tier]!;
    const gain = TIER_GAIN[tier]!;
    // A fast flicker, off simulation time so a capture reproduces it exactly.
    const flick = 0.82 + 0.18 * Math.sin(ctx.time.elapsed * 47 + racer.id);
    const k = gain * g * flick * (0.62 + 0.38 * tier / 3);
    const spin = ctx.time.elapsed * 2.1 + racer.id;
    // Scale to the machine. The train is three times the cone's width, and one
    // absolute size makes this a bonfire on one and a pilot light on the other.
    const rig = clamp(sizeOf(racer).halfW / 0.85, 0.72, 1.5);

    for (let s = -1; s <= 1; s += 2) {
      // At the outer sidewall, at axle height: high enough and wide enough to
      // clear the tyre it is coming off, so the flare reads against the road
      // behind the machine instead of against the rubber in front of it.
      sparkPort(racer, s, 0.30, _p);
      // The shape. Bright enough at the centre to bloom, pointed enough at the
      // edges to still be a shape when it is forty pixels wide.
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        col.r * k * 1.05, col.g * k * 1.05, col.b * k * 1.05, 0.95 * g,
        (0.80 + 0.55 * g * flick) * rig, 0, spin * s, CELL.flare, MODE.billboard,
      );
      // A tight white core inside it, so "hot" is carried by a handful of white
      // pixels instead of by bleaching the tier's hue out of the whole effect.
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        2.5 * g * flick, 2.45 * g * flick, 2.35 * g * flick, 0.9 * g,
        (0.20 + 0.10 * g) * rig, 0, 0, CELL.glow, MODE.billboard,
      );
      // ...inside a soft halo, which is what the bloom pyramid can find.
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        col.r * k * 0.34, col.g * k * 0.34, col.b * k * 0.34, 0.5 * g,
        (1.10 + 0.45 * g * flick) * rig, 0, 0, CELL.glow, MODE.billboard,
      );
      // ...and a pool of its own light on the road under it. Contact, again:
      // sparks that do not light the surface they come off read as stickers.
      // Kept tight — wide and soft was reading as spilled paint.
      rearWheel(racer, s, 0.03, _p);
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        col.r * k * 0.42, col.g * k * 0.42, col.b * k * 0.42, 0.34 * g,
        (1.0 + 0.35 * g) * rig, 0, 0, CELL.glow, MODE.ground,
      );
    }

    // ── the climb ─────────────────────────────────────────────────────────
    //
    // From the front camera at maximum charge the ultra mini-turbo used to be a
    // handful of magenta flecks at one rear wheel: everything the effect had
    // lived within a hand's breadth of the axle, so the loudest state in the
    // drift system was invisible from any angle that could see the machine's
    // face. In MK8 the pink tier *climbs the kart* — it wraps the flanks and
    // crowns the roof, and that is what makes a fully charged drift feel like
    // something about to be spent rather than like a wheel that is warm.
    //
    // So from tier two up, a ladder of licks runs up each flank from the axle
    // toward the roof, and tier three closes it with a crown over the top. The
    // ladder is immediate-mode sprites — no pool, no allocation — and the count
    // is small enough that eight racers all at tier three is under a hundred
    // extra quads in the one draw call the layer already costs.
    if (racer.drift.active && tier >= 2) {
      const s = sizeOf(racer);
      const climb = (tier - 1) * g;              // 0..1 at tier 2, 0..2 at tier 3
      const rungs = tier >= 3 ? 4 : 3;
      const roof = s.height - RIDE_HEIGHT;
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < rungs; i++) {
          // Up the flank and slightly forward as it rises, so the ladder leans
          // with the machine instead of standing beside it like a fence.
          const u = (i + 1) / (rungs + 1);
          const wob = Math.sin(ctx.time.elapsed * 15 + i * 2.1 + side + racer.id);
          const lx = side * (s.halfW * (0.92 - 0.26 * u)) + side * 0.06 * wob;
          const ly = -RIDE_HEIGHT + 0.24 + roof * 0.86 * u;
          const lz = -s.len * (0.30 - 0.16 * u);
          local(lx, ly, lz, _p);
          // Fading and shrinking as it climbs: a ladder of equal blobs reads as
          // a string of lights, a taper reads as fire being dragged upward.
          const fade = (1 - u * 0.55) * clamp01(climb);
          const kk = gain * fade * flick * 1.15;
          add.push(
            _p.x, _p.y, _p.z, 0, 0, 0,
            col.r * kk, col.g * kk, col.b * kk, 0.72 * fade,
            (0.42 + 0.30 * (1 - u)) * rig, 0, 0, CELL.glow, MODE.billboard,
          );
          if (i === 0 || tier >= 3) {
            add.push(
              _p.x, _p.y, _p.z, 0, 0, 0,
              col.r * kk * 1.5, col.g * kk * 1.5, col.b * kk * 1.5, 0.7 * fade,
              (0.30 + 0.22 * (1 - u)) * rig, 0, spin * side + i, CELL.flare, MODE.billboard,
            );
          }
        }
      }
      if (tier >= 3) {
        // The crown. One wide soft halo over the roof and a ring of embers
        // turning around it, so the machine is wearing the charge rather than
        // trailing it.
        local(0, -RIDE_HEIGHT + roof + 0.30, -s.len * 0.06, _p);
        const ck = gain * g * flick;
        add.push(
          _p.x, _p.y, _p.z, 0, 0, 0,
          col.r * ck * 0.55, col.g * ck * 0.55, col.b * ck * 0.55, 0.42 * g,
          (1.7 + 0.5 * g) * rig, 0, 0, CELL.glow, MODE.billboard,
        );
        for (let i = 0; i < 5; i++) {
          const a = ctx.time.elapsed * 3.4 + (i * TAU) / 5 + racer.id;
          const r = (0.5 + s.halfW * 0.62) * rig;
          local(Math.cos(a) * r, -RIDE_HEIGHT + roof + 0.30 + Math.sin(a * 2) * 0.10,
            -s.len * 0.06 + Math.sin(a) * r, _p);
          add.push(
            _p.x, _p.y, _p.z, 0, 0, 0,
            col.r * ck * 1.7, col.g * ck * 1.7, col.b * ck * 1.7, 0.85 * g,
            0.30 * rig, 0, a, CELL.flare, MODE.billboard,
          );
        }
      }
    }

    // The lock-in punctuation: a flare at each wheel that opens wide and snaps
    // shut, with a white kicker inside it. This is the frame the whole system
    // exists to sell, so for a tenth of a second it is the loudest thing on
    // screen. It sits at the wheels, not at the tail, because that is where the
    // player is already looking for the colour.
    if (fx.pop > 0.01) {
      const c = TIER[fx.popTier]!;
      const cg = TIER_GAIN[fx.popTier]!;
      const p = fx.pop;
      const ease = p * p;
      for (let s = -1; s <= 1; s += 2) {
        sparkPort(racer, s, 0.34, _p);
        const size = lerp(0.9, 3.8, p) * rig;
        add.push(
          _p.x, _p.y, _p.z, 0, 0, 0,
          c.r * cg * 1.6 * ease, c.g * cg * 1.6 * ease, c.b * cg * 1.6 * ease, p,
          size, 0, spin * 0.5 + s, CELL.flare, MODE.billboard,
        );
        add.push(
          _p.x, _p.y, _p.z, 0, 0, 0,
          3.0 * ease, 2.9 * ease, 2.8 * ease, p,
          size * 0.20, 0, 0, CELL.glow, MODE.billboard,
        );
      }
    }
  }

  /**
   * The continuous layer. Every machine on the track, always, including the AI.
   *
   * The single biggest hole in the previous pass. Outside the third of a second
   * around a boost or a hit the whole fx layer was empty: a pack shot at 148
   * km/h and a chase shot at 242 km/h both photographed eight machines with
   * nothing attached to any of them, and a still frame of a racing game with
   * nothing moving in it is a diorama. Everything else this module does is an
   * *event*; this is the part that makes the seconds between events feel like a
   * race.
   *
   * It is anchored to a real hole in the bodywork — see `exhaust.ts` — because
   * a puff that is not welded to a pipe is precisely the detached grey blob the
   * module has already been rejected for. Cheap by construction: one small
   * short-lived alpha sprite per emission, no glow except on the turbines, and
   * the rate scales with distance so a machine at the back of the pack costs
   * almost nothing.
   */
  function exhaustPuffs(racer: Racer, fx: RacerFx, dt: number): void {
    const ports = portsFor(racer.vehicleId);
    const speedFrac = clamp01(Math.abs(racer.speed) / 46);
    // Under boost a machine is being asked for everything it has, and the stack
    // answers. This is also the cheapest way to make a CPU racer's boost
    // readable from behind, where the flame plume is edge-on.
    const load = clamp01(0.3 + 0.7 * speedFrac + (racer.boost.time > 0 ? 0.9 : 0));
    // Exhaust reads at a distance where a spark does not — it is a silhouette
    // against the sky rather than a pinpoint — so it keeps far more of its rate
    // out in the pack than the `near` gate would otherwise give it.
    const far = 1 - fx.near;
    const reach = 0.25 + 0.75 * fx.near;
    // Cap per port. Six was fine when a port emitted eight a second; a diesel
    // stack at fifty would be clipped by it at any frame rate below 8fps, and
    // clipping the rate is how a capture at 20fps photographs a thinner effect
    // than the game actually has.
    const cap = 12;

    for (let pi = 0; pi < ports.length; pi++) {
      const p = ports[pi]!;
      const rate = (p.idle + p.drive * load) * density * reach;
      let acc = (pi === 0 ? fx.exhaust : fx.exhaust2) + rate * dt;
      let n = Math.floor(acc);
      acc -= n;
      if (pi === 0) fx.exhaust = acc; else fx.exhaust2 = acc;
      if (n > cap) n = cap;
      if (n <= 0) continue;

      const inv = 1 / n;
      for (let i = 0; i < n; i++) {
        local(p.x, p.y - RIDE_HEIGHT, p.z, _p);
        // Spread the frame's worth back along the path the machine took during
        // it, exactly as the sparks and the dust do. Without it a capture at
        // 20fps gets clumps three metres apart instead of a stream.
        _p.addScaledVector(racer.vel, -(i + 0.5) * inv * dt);

        exhaustSpec.px = _p.x + rng.range(-0.05, 0.05);
        exhaustSpec.py = _p.y + rng.range(-0.03, 0.05);
        exhaustSpec.pz = _p.z + rng.range(-0.05, 0.05);
        // Most of the machine's own velocity, plus the gas leaving the pipe.
        // The inheritance is what keeps the plume attached: at 0.9 the head of
        // it is still over the chimney a third of a second later, which is the
        // difference between steam coming out of a funnel and a cloud parked in
        // the air behind a locomotive.
        const out = p.speed * rng.range(0.6, 1.35) * (0.55 + 0.75 * load);
        exhaustSpec.vx = racer.vel.x * 0.9
          + (_right.x * p.dx + _up.x * p.dy + _fwd.x * p.dz) * out + rng.range(-0.5, 0.5);
        exhaustSpec.vy = racer.vel.y * 0.9
          + (_right.y * p.dx + _up.y * p.dy + _fwd.y * p.dz) * out + rng.range(0.1, 0.9);
        exhaustSpec.vz = racer.vel.z * 0.9
          + (_right.z * p.dx + _up.z * p.dy + _fwd.z * p.dz) * out + rng.range(-0.5, 0.5);
        exhaustSpec.life = p.life * rng.range(0.75, 1.3);
        exhaustSpec.size0 = p.size * rng.range(0.7, 1.25) * (0.8 + 0.4 * load) * (1 + 0.5 * far);
        exhaustSpec.size1 = exhaustSpec.size0 * p.grow;
        // Denser with distance, which is not a cheat: the same volume of gas
        // covers fewer pixels the further away it is, so the optical depth
        // through it per pixel genuinely goes up. Without this a plume tuned to
        // be a wisp beside the player is nothing at all on the machine four
        // places ahead, which is where most of the field always is.
        exhaustSpec.alpha = p.alpha * rng.range(0.7, 1.15) * (1 + 1.8 * far);
        exhaustSpec.rot = rng.next() * TAU;
        exhaustSpec.rotVel = rng.range(-1.1, 1.1);
        _tint.setHex(p.color);
        setHdr(exhaustSpec.color0, _tint, 1.0);
        _tint.setHex(p.tail);
        setHdr(exhaustSpec.color1, _tint, 0.95);
        if (!pool.emit(exhaustSpec)) break;
      }
    }
  }

  /** The heat at a turbine lip. Immediate mode; only the hot ports get one. */
  function exhaustGlow(racer: Racer, fx: RacerFx, add: SpriteLayer): void {
    const ports = portsFor(racer.vehicleId);
    const load = clamp01(0.25 + 0.75 * clamp01(Math.abs(racer.speed) / 46));
    const flick = 0.8 + 0.2 * Math.sin(ctx.time.elapsed * 37 + racer.id * 1.7);
    for (let i = 0; i < ports.length; i++) {
      const p = ports[i]!;
      if (!p.hot) continue;
      local(p.x, p.y - RIDE_HEIGHT, p.z, _p);
      const k = 0.9 * load * flick * fx.near;
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        FLAME_MID.r * k, FLAME_MID.g * k * 0.85, FLAME_MID.b * k * 0.6, 0.5 * load,
        p.size * 1.9, 0, 0, CELL.glow, MODE.billboard,
      );
    }
  }

  /**
   * The bed the sparks sit on.
   *
   * A mini-turbo used to emit onto bare asphalt with nothing underneath it, so
   * tier one read as a floating cyan glow rather than as a wheel scrubbing —
   * the light was there but the *cause* of it was not. A tyre dragged sideways
   * across tarmac at 130 km/h boils its own tread off, and that haze is the
   * thing that makes the sparks look like they came out of rubber.
   *
   * Deliberately faint and deliberately flat. It hugs the deck (almost no
   * lift), spreads sideways rather than climbing, and dies inside half a second
   * — anything that rises into the sparks turns the hero effect into fog.
   */
  function driftScrub(racer: Racer, fx: RacerFx, dt: number): void {
    const sfx = SURFACE_FX[racer.surface];
    if (sfx.sparky) return;
    const speedFrac = clamp01(Math.abs(racer.speed) / 44);
    if (speedFrac < 0.12) return;
    const depth = 0.5 + 0.5 * clamp01(Math.abs(racer.drift.angle) / K.drift.maxAngle);
    // Backed off on loose ground, where `surfaceDust` is already throwing a
    // cloud off the same wheels for the same reason. The scrub exists to give
    // sparks something to sit on where nothing else would be there at all,
    // which is tarmac.
    const loose = sfx.rate > 0 ? 0.35 : 1;
    const rate = (54 + 26 * racer.drift.tier) * depth * speedFrac * loose * density * fx.near;
    fx.scrub += rate * dt;
    let n = Math.floor(fx.scrub);
    fx.scrub -= n;
    if (n > 10) n = 10;
    if (n <= 0) return;

    const col = surfaceColors.get(racer.surface)!;
    const deep = surfaceDeep.get(racer.surface)!;
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      const side = rng.next() < 0.5 ? -1 : 1;
      rearWheel(racer, side, 0.10, _p);
      _p.addScaledVector(racer.vel, -(i + 0.5) * inv * dt);
      scrubSpec.size0 = sfx.size * rng.range(0.9, 1.5);
      scrubSpec.px = _p.x + rng.range(-0.14, 0.14);
      // Lifted by its own radius so the depth test cannot slice the sprite
      // along the road plane and leave it with one perfectly straight edge.
      scrubSpec.py = _p.y + scrubSpec.size0 * 0.5;
      scrubSpec.pz = _p.z + rng.range(-0.14, 0.14);
      // Nearly all the machine's velocity, thrown outward and barely upward.
      scrubSpec.vx = racer.vel.x * 0.88 + _right.x * side * rng.range(0.8, 2.6)
        - _fwd.x * rng.range(0, 1.6);
      scrubSpec.vy = rng.range(0.25, 0.95);
      scrubSpec.vz = racer.vel.z * 0.88 + _right.z * side * rng.range(0.8, 2.6)
        - _fwd.z * rng.range(0, 1.6);
      scrubSpec.life = rng.range(0.34, 0.62);
      scrubSpec.size1 = scrubSpec.size0 * 3.0;
      scrubSpec.rot = rng.next() * TAU;
      scrubSpec.rotVel = rng.range(-1.4, 1.4);
      scrubSpec.alpha = (sfx.sparky ? 0 : 0.14) * rng.range(0.75, 1.2);
      setHdr(scrubSpec.color0, col, 1.0);
      setHdr(scrubSpec.color1, deep, 0.98);
      if (!pool.emit(scrubSpec)) break;
    }
  }

  /**
   * Speed alone, no slip required.
   *
   * The term that did not exist. A machine tracking dead straight down the
   * tarmac at 240 km/h disturbed precisely nothing, so a still frame at full
   * chat was indistinguishable from a still frame at walking pace. This ramps
   * in over the top half of the range and is spread across the whole width of
   * the machine rather than thrown from two points, which is the difference
   * between a veil and a rope of blobs.
   */
  function speedWake(
    racer: Racer, fx: RacerFx, dt: number, sfx: SurfaceFx, speedFrac: number,
  ): void {
    if (sfx.wake <= 0) return;
    const w = clamp01((speedFrac - 0.50) / 0.42);
    if (w <= 0) return;
    const rate = sfx.wake * w * w * density * fx.near;
    fx.wake += rate * dt;
    let n = Math.floor(fx.wake);
    fx.wake -= n;
    if (n > 10) n = 10;
    if (n <= 0) return;

    const s = sizeOf(racer);
    const col = surfaceColors.get(racer.surface)!;
    const deep = surfaceDeep.get(racer.surface)!;
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      // Anywhere across the back of the machine and just off the deck: a veil
      // being pulled along under it, not a jet coming out of one hole.
      local(
        rng.range(-1.05, 1.05) * s.halfW,
        -RIDE_HEIGHT + rng.range(0.10, 0.42),
        -s.len * rng.range(0.32, 0.62),
        _p,
      );
      _p.addScaledVector(racer.vel, -(i + 0.5) * inv * dt);
      wakeSpec.px = _p.x; wakeSpec.py = _p.y; wakeSpec.pz = _p.z;
      // Deliberately *less* than the machine's own velocity: the difference is
      // what the vertex shader turns into streak length, and a wake that kept
      // pace with the kart would be a round dot.
      wakeSpec.vx = racer.vel.x * 0.52 + rng.range(-0.8, 0.8);
      wakeSpec.vy = racer.vel.y * 0.52 + rng.range(0.1, 1.0) + sfx.lift * rng.range(0.4, 1.6);
      wakeSpec.vz = racer.vel.z * 0.52 + rng.range(-0.8, 0.8);
      wakeSpec.life = rng.range(0.28, 0.5);
      wakeSpec.size0 = sfx.size * rng.range(0.55, 0.95);
      wakeSpec.size1 = wakeSpec.size0 * 2.1;
      wakeSpec.alpha = sfx.alpha * 1.7 * rng.range(0.7, 1.15);
      setHdr(wakeSpec.color0, col, 1.0);
      setHdr(wakeSpec.color1, deep, 0.98);
      if (!pool.emit(wakeSpec)) break;
    }
  }

  /** Dust, spray or scrape off whatever the tyres are on. */
  function surfaceDust(racer: Racer, fx: RacerFx, dt: number): void {
    const sfx = SURFACE_FX[racer.surface];
    const slip = Math.max(slipOf(racer), racer.drift.active ? 0.45 : 0);
    const speedFrac = clamp01(Math.abs(racer.speed) / 48);
    const boosting = racer.boost.time > 0 ? 1 : 0;

    // The wake runs on its own accumulator and its own shape — see below. It
    // is the only part of this that is about speed rather than about what the
    // tyres are doing.
    speedWake(racer, fx, dt, sfx, speedFrac);

    // Tyres taking forty extra metres a second of thrust smoke, and on a
    // surface with nothing loose to give, that smoke is the only tell the
    // ground gets that the loudest thing in the game just happened.
    const rate = (sfx.rate * speedFrac
      + sfx.slip * slip * speedFrac
      + boosting * 70 * speedFrac) * density * fx.near;
    if (rate <= 0) return;

    fx.dust += rate * dt;
    let n = Math.floor(fx.dust);
    fx.dust -= n;
    if (n > 22) n = 22;
    if (n <= 0) return;

    const col = surfaceColors.get(racer.surface)!;
    const deep = surfaceDeep.get(racer.surface)!;
    const inv = 1 / n;

    for (let i = 0; i < n; i++) {
      const side = rng.next() < 0.5 ? -1 : 1;
      // Off the back edge of the tyre and just outboard of it, for the same
      // reason the sparks are — a puff born under the machine spends the first
      // third of its life inside the bodywork, and a clod born there is small
      // enough to spend all of it there.
      sparkPort(racer, side, 0.14, _p);
      // Same sub-frame spread as the sparks: a dust trail has to be a trail.
      const back = (i + 0.5) * inv * dt;
      _p.addScaledVector(racer.vel, -back);

      if (sfx.sparky) {
        sparkSpec.px = _p.x; sparkSpec.py = _p.y; sparkSpec.pz = _p.z;
        sparkSpec.vx = racer.vel.x * 0.12 + rng.range(-3, 3);
        sparkSpec.vy = rng.range(1, 4);
        sparkSpec.vz = racer.vel.z * 0.12 + rng.range(-3, 3);
        sparkSpec.life = rng.range(0.18, 0.34);
        sparkSpec.size0 = rng.range(0.10, 0.18);
        setHdr(sparkSpec.color0, RAIL_SPARK, 3.2);
        setHdr(sparkSpec.color1, RAIL_SPARK, 0.3);
        pool.emit(sparkSpec);
        continue;
      }

      dustSpec.size0 = sfx.size * rng.range(0.8, 1.5);
      dustSpec.px = _p.x + rng.range(-0.2, 0.2);
      // Born clear of the road by half its own radius. The sprite layer depth-
      // tests, so a soft ball centred on the tarmac is sliced along the plane
      // it intersects and what reaches the screen is a puff with one perfectly
      // straight edge — the single most obvious "these are quads" tell the
      // module can produce. Lifting the centre by its own size costs nothing
      // and moves the cut out to where the alpha is already near zero.
      dustSpec.py = _p.y + dustSpec.size0 * 0.5;
      dustSpec.pz = _p.z + rng.range(-0.2, 0.2);
      // Velocity inheritance is the whole difference between a rooster tail and
      // nothing at all, and the number wants to be much higher than physics
      // suggests. At 0.14 a puff was born already falling 25 m/s behind the
      // machine that made it. The chase camera sits six to eight metres back,
      // so the puff crossed behind the lens inside a third of a second — before
      // it had finished fading in, before it had grown, and before it had
      // climbed. The game was emitting a perfectly good dust trail every single
      // frame and the player could not see one metre of it.
      //
      // Real dust is entrained in the wake and travels with the car for a while
      // before it lets go, which is exactly the behaviour that is also needed
      // here: at 0.75 the head of the cloud stays within three or four metres
      // of the machine for the first half of its life — in frame, at full size
      // — and only then drops away.
      dustSpec.vx = racer.vel.x * 0.75 - _fwd.x * rng.range(0.5, 3)
        + _right.x * side * rng.range(0.6, 3.0);
      // ...and the climb is the other half. A cloud that tops out a metre off
      // the deck sits below the sight line of a camera that is looking over the
      // roof of the kart, so on a loose surface it has to actually get up: two
      // to four metres, which puts it against the sky and the road behind
      // rather than against the identically-coloured ground it came off.
      dustSpec.vy = rng.range(0.4, 1.4) + sfx.lift * rng.range(1.8, 4.6);
      dustSpec.vz = racer.vel.z * 0.75 - _fwd.z * rng.range(0.5, 3)
        + _right.z * side * rng.range(0.6, 3.0);
      // Shorter-lived and smaller than they were, and there are more of them.
      // One puff that grows to five metres across, born four metres from the
      // lens, *is* the frame — a boost through gravel photographed as a smear
      // of fog over the bottom third of the screen. A cloud has to be made of
      // enough pieces to have a silhouette, and each piece has to be small
      // enough that losing one is not losing the shot.
      dustSpec.life = rng.range(0.42, 0.88);
      dustSpec.size1 = dustSpec.size0 * sfx.grow;
      dustSpec.rot = rng.next() * TAU;
      dustSpec.rotVel = rng.range(-1.3, 1.3);
      // Loose ground hangs in the air; tarmac smoke settles almost at once.
      dustSpec.gravity = -0.12 - 0.5 * sfx.lift;
      dustSpec.alpha = sfx.alpha * rng.range(0.7, 1.1);
      setHdr(dustSpec.color0, col, 1.0);
      setHdr(dustSpec.color1, deep, 0.85);
      pool.emit(dustSpec);
    }
    dustSpec.gravity = -0.2;

    // ── the solid half ────────────────────────────────────────────────────
    // On its own accumulator rather than as a coin flip inside the dust loop.
    // Piggybacked on the dust it came out at three clods a second, which is
    // three clods nobody will ever notice; matter and powder come off a tyre in
    // quite different quantities and there is no reason to tie them together.
    if (sfx.grit <= 0) return;
    const gritRate = sfx.grit * (66 + 96 * slip) * speedFrac * density * fx.near;
    fx.grit += gritRate * dt;
    let gn = Math.floor(fx.grit);
    fx.grit -= gn;
    if (gn > 12) gn = 12;
    const ginv = gn > 0 ? 1 / gn : 0;

    for (let i = 0; i < gn; i++) {
      const side = rng.next() < 0.5 ? -1 : 1;
      sparkPort(racer, side, 0.10, _p);
      _p.addScaledVector(racer.vel, -(i + 0.5) * ginv * dt);
      gritSpec.px = _p.x; gritSpec.py = _p.y + 0.05; gritSpec.pz = _p.z;
      // Thrown up and out hard enough to clear the cloud it came out of. A clod
      // that stays inside the dust is a clod nobody sees, and the point of it is
      // to be the thing with an edge on it.
      const out = rng.range(1.5, 6.0);
      gritSpec.vx = racer.vel.x * 0.72 - _fwd.x * rng.range(1.5, 7)
        + _right.x * side * out;
      gritSpec.vy = rng.range(3.0, 10.0) * (0.45 + 0.6 * sfx.lift);
      gritSpec.vz = racer.vel.z * 0.72 - _fwd.z * rng.range(1.5, 7)
        + _right.z * side * out;
      gritSpec.life = rng.range(0.34, 0.72);
      gritSpec.size0 = rng.range(0.10, 0.26);
      gritSpec.size1 = gritSpec.size0 * 0.8;
      // The ground's own colour, not the dust's: this is the surface itself
      // rather than the powder off it, and the contrast between the two is the
      // whole effect. Two tones, so the spray is not one material stamped out.
      setHdr(gritSpec.color0, deep, rng.range(0.55, 1.0));
      gritSpec.color1.copy(gritSpec.color0);
      if (!pool.emit(gritSpec)) break;
    }
  }

  /**
   * The plume. A boost has to be unmistakable with the sound off.
   *
   * Three things stacked, because fire is three things: a body that grows and
   * cools as it falls behind, a nozzle that never flickers out between
   * particles, and a spray of sparks fast enough to streak. The body is where
   * the volume is, but the sparks are what make it read as *thrust* rather than
   * as a coloured cloud stuck to the back of the kart.
   *
   * The flame body keeps a big share of the kart's velocity so the plume has
   * length instead of being left behind in a lump, and it is thrown backwards
   * hard on top of that so the length is visible.
   */
  function boostFlame(racer: Racer, fx: RacerFx, dt: number, add: SpriteLayer): void {
    const power = clamp01(racer.boost.power / 46);
    const s = sizeOf(racer);
    const tier = fx.boostTier;
    const tint = tier > 0 ? TIER[tier]! : FLAME_HOT;
    const gain = tier > 0 ? TIER_GAIN[tier]! : 2.6;
    const rig = clamp(s.halfW / 0.85, 0.75, 1.6);

    const rate = (110 + 110 * power) * density * fx.near;
    fx.flame += rate * dt;
    let n = Math.floor(fx.flame);
    fx.flame -= n;
    if (n > 20) n = 20;

    const inv = n > 0 ? 1 / n : 0;
    for (let i = 0; i < n; i++) {
      // Out of one throat or the other, with enough jitter that the two plumes
      // merge into one body a metre behind the machine.
      const off = (rng.next() < 0.5 ? -1 : 1) * s.halfW * 0.42 + rng.range(-0.22, 0.22) * s.halfW;
      local(off, -0.16 + rng.range(0, 0.3), -s.len * (0.45 + rng.range(0, 0.12)), _p);
      _p.addScaledVector(racer.vel, -(i + 0.5) * inv * dt);
      flameSpec.px = _p.x; flameSpec.py = _p.y; flameSpec.pz = _p.z;
      const back = rng.range(7, 17) * (0.7 + 0.5 * power);
      flameSpec.vx = racer.vel.x * 0.70 - _fwd.x * back + rng.range(-1.6, 1.6);
      flameSpec.vy = racer.vel.y * 0.70 + rng.range(0.2, 1.6);
      flameSpec.vz = racer.vel.z * 0.70 - _fwd.z * back + rng.range(-1.6, 1.6);
      flameSpec.life = rng.range(0.13, 0.24);
      flameSpec.size0 = rng.range(0.30, 0.54) * (0.85 + 0.4 * power) * rig;
      flameSpec.size1 = flameSpec.size0 * rng.range(1.7, 2.5);
      // The body of the plume burns *hot*, with only a wash of the tier colour
      // through it. A plume that is purple all the way out reads as a cloud of
      // magic stuck to the back of the machine rather than as fire; the tier is
      // carried by the nozzle and the sparks, which are the parts with an edge
      // on them and therefore the parts a colour can actually be read off.
      flameSpec.color0.lerpColors(tint, FLAME_HOT, 0.55)
        .multiplyScalar(gain * rng.range(0.95, 1.3));
      setHdr(flameSpec.color1, FLAME_END, 1.1);
      pool.emit(flameSpec);

      // Sparks out of the exhaust. Almost all of the kart's velocity, so they
      // hang in the plume, plus a hard shove backwards that the camera-relative
      // stretch turns into streaks pointing straight down the road behind.
      if (rng.next() < 0.55) {
        sparkSpec.px = _p.x; sparkSpec.py = _p.y; sparkSpec.pz = _p.z;
        const kick = rng.range(9, 22) * (0.7 + 0.5 * power);
        sparkSpec.vx = racer.vel.x * 0.80 - _fwd.x * kick + rng.range(-2.2, 2.2);
        sparkSpec.vy = racer.vel.y * 0.80 + rng.range(0.4, 3.0);
        sparkSpec.vz = racer.vel.z * 0.80 - _fwd.z * kick + rng.range(-2.2, 2.2);
        sparkSpec.life = rng.range(0.12, 0.26);
        sparkSpec.size0 = rng.range(0.13, 0.24);
        sparkSpec.gravity = 8;
        sparkSpec.drag = 0.8;
        sparkSpec.color0.lerpColors(tint, WHITE_HOT, 0.28).multiplyScalar(gain * 1.1);
        setHdr(sparkSpec.color1, tint, gain * 0.25);
        pool.emit(sparkSpec);
        sparkSpec.gravity = 15;
        sparkSpec.drag = 2.0;
      }

      // Part of it turns over into smoke, so the plume has a tail and the
      // frame does not simply go bright behind the kart. More of them and each
      // far fainter than before: the old one-in-four at a quarter opacity and
      // two and a half metres across was what left a row of dark discs lying on
      // the asphalt behind every boost.
      if (rng.next() < 0.55) {
        smokeSpec.px = _p.x; smokeSpec.py = _p.y + 0.15; smokeSpec.pz = _p.z;
        smokeSpec.vx = flameSpec.vx * 0.55;
        smokeSpec.vy = rng.range(0.4, 1.6);
        smokeSpec.vz = flameSpec.vz * 0.55;
        smokeSpec.life = rng.range(0.6, 1.0);
        smokeSpec.size0 = rng.range(0.26, 0.46);
        smokeSpec.size1 = smokeSpec.size0 * 3.0;
        smokeSpec.rot = rng.next() * TAU;
        smokeSpec.rotVel = rng.range(-1, 1);
        setHdr(smokeSpec.color0, SMOKE, 1.0);
        setHdr(smokeSpec.color1, SMOKE_DEEP, 0.95);
        pool.emit(smokeSpec);
      }
    }

    // The nozzles: hot cores that do not flicker out between particles.
    //
    // Two of them, not one. The camera a player actually has is sitting almost
    // directly behind the machine, and from there a plume aimed straight away
    // from the lens has no length at all — every metre of it lands on the same
    // handful of pixels. A single stack of round quads on the centreline
    // foreshortens to a dot and the whole boost reads as the kart being lit
    // orange from inside. A pair set out at the flanks has *width*, which is
    // the one dimension the chase camera cannot take away, and width is what
    // makes the shape read as exhaust rather than as a tint.
    const flick = 0.85 + 0.15 * Math.sin(ctx.time.elapsed * 61 + racer.id * 2.3);
    const k = (gain * 1.15 + 0.9 * power) * flick;
    const spread = s.halfW * 0.42;
    for (let side = -1; side <= 1; side += 2) {
      local(side * spread, -0.1, -s.len * 0.46, _p);
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        tint.r * k, tint.g * k, tint.b * k, 0.95,
        (0.62 + 0.42 * power) * flick * rig, 0, 0, CELL.glow, MODE.billboard,
      );
      // A white pinpoint at each throat. Everything else here is broad and
      // soft, and without something hard at the centre the plume reads as fog
      // lit from inside rather than as a jet coming out of a hole.
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        3.2 * flick, 3.1 * flick, 2.9 * flick, 0.95,
        (0.17 + 0.12 * power) * rig, 0, 0, CELL.glow, MODE.billboard,
      );
    }
    // One broad wash across both of them, so the pair reads as a single fire
    // with two throats rather than as two lamps.
    local(0, -0.1, -s.len * 0.46, _p);
    add.push(
      _p.x, _p.y, _p.z, 0, 0, 0,
      FLAME_MID.r * k * 0.5, FLAME_MID.g * k * 0.5, FLAME_MID.b * k * 0.5, 0.8,
      (1.7 + 1.1 * power) * flick * rig, 0, 0, CELL.glow, MODE.billboard,
    );
    // ...and the light it throws on the road, which is what welds the plume to
    // the ground instead of leaving it hovering behind the machine.
    if (racer.grounded) {
      local(0, -RIDE_HEIGHT + 0.04, -s.len * 0.62, _p);
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        tint.r * k * 0.34, tint.g * k * 0.34, tint.b * k * 0.34, 0.42,
        (2.0 + 1.2 * power) * rig, (1.6 + 1.2 * power) * rig, groundYaw(), CELL.glow, MODE.ground,
      );
    }
  }

  /** Rotation that lays a `MODE.ground` quad's long axis down the racer's
   *  heading. The shader's ground branch spans (cos, 0, sin), so this is
   *  atan2(z, x) — not the yaw convention the rest of the game uses. */
  function groundYaw(): number {
    return Math.atan2(_fwd.z, _fwd.x);
  }

  /** Ground shock ring. The single cheapest way to make an event feel physical. */
  function ring(
    x: number, y: number, z: number, from: number, to: number,
    life: number, color: THREE.Color, k: number, alpha: number, additive = true,
  ): void {
    ringSpec.px = x; ringSpec.py = y; ringSpec.pz = z;
    ringSpec.vx = 0; ringSpec.vy = 0; ringSpec.vz = 0;
    ringSpec.size0 = from;
    ringSpec.size1 = to;
    ringSpec.life = life;
    ringSpec.alpha = alpha;
    ringSpec.additive = additive;
    ringSpec.rot = rng.next() * TAU;
    setHdr(ringSpec.color0, color, k);
    setHdr(ringSpec.color1, color, k * 0.12);
    pool.emit(ringSpec);
  }

  /** A ring of dust thrown outward along the ground. */
  function dustRing(
    x: number, y: number, z: number, n: number, speed: number, surface: Surface, scale: number,
  ): void {
    const sfx = SURFACE_FX[surface] ?? SURFACE_FX.road;
    const col = surfaceColors.get(surface) ?? surfaceColors.get('road')!;
    const deep = surfaceDeep.get(surface) ?? surfaceDeep.get('road')!;
    dustSpec.size0 = sfx.size * 1.35 * scale;
    dustSpec.px = x; dustSpec.py = y + dustSpec.size0 * 0.5; dustSpec.pz = z;
    dustSpec.vx = 0; dustSpec.vy = 1.2 + 2.6 * sfx.lift; dustSpec.vz = 0;
    dustSpec.life = 0.75;
    dustSpec.size1 = dustSpec.size0 * sfx.grow;
    dustSpec.alpha = Math.max(sfx.alpha, 0.16);
    dustSpec.rotVel = 0.8;
    setHdr(dustSpec.color0, col, 1.0);
    setHdr(dustSpec.color1, deep, 0.85);
    pool.burst(dustSpec, Math.round(n * density), speed, 0.22, rng);

    // Matter as well as powder. A landing that punches a ring of dust out of
    // gravel and throws nothing solid with it reads as a smoke machine going
    // off under the kart.
    if (sfx.grit > 0) {
      gritSpec.px = x; gritSpec.py = y + 0.06; gritSpec.pz = z;
      gritSpec.vx = 0; gritSpec.vy = 2.0 + 2.5 * sfx.lift; gritSpec.vz = 0;
      gritSpec.life = 0.55;
      gritSpec.size0 = 0.17 * scale;
      gritSpec.size1 = gritSpec.size0 * 0.8;
      setHdr(gritSpec.color0, deep, 0.85);
      gritSpec.color1.copy(gritSpec.color0);
      pool.burst(gritSpec, Math.round(n * sfx.grit * density), speed * 1.15, 0.45, rng);
    }
  }

  function sparkBurst(
    x: number, y: number, z: number, n: number, speed: number, color: THREE.Color, k: number,
  ): void {
    sparkSpec.px = x; sparkSpec.py = y; sparkSpec.pz = z;
    sparkSpec.vx = 0; sparkSpec.vy = 0.5; sparkSpec.vz = 0;
    sparkSpec.life = 0.42;
    sparkSpec.size0 = 0.22;
    setHdr(sparkSpec.color0, color, k);
    setHdr(sparkSpec.color1, color, 0.3);
    pool.burst(sparkSpec, Math.round(n * density), speed, 0.75, rng);
  }

  // ── spending impulses ─────────────────────────────────────────────────────

  /**
   * The frame a boost fires. Everything a player is given to notice it: a
   * shockwave welded to the road, a fan of sparks thrown backwards out of the
   * exhaust, dust punched off the surface, and — for the player only — a flash
   * and a kick of camera shake.
   *
   * The sparks are aimed rather than scattered. A symmetric burst reads as an
   * explosion at the back of the kart; a cone thrown *backwards* reads as the
   * kart being shoved forwards, which is the thing that actually happened.
   */
  function spendBoost(racer: Racer, fx: RacerFx): void {
    const s = sizeOf(racer);
    const power = clamp01(fx.pendBoost / 46);
    const tier = fx.boostTier;
    const tint = tier > 0 ? TIER[tier]! : WARM_WHITE;
    const gain = tier > 0 ? TIER_GAIN[tier]! : 2.6;
    const rig = clamp(s.halfW / 0.85, 0.75, 1.6);

    local(0, -RIDE_HEIGHT + 0.06, -s.len * 0.35, _p);
    ring(_p.x, _p.y, _p.z, 1.4, (5.5 + 5 * power) * rig, 0.42, tint, gain, 0.95);
    ring(_p.x, _p.y, _p.z, 0.8, (3.0 + 3 * power) * rig, 0.26, WARM_WHITE, 2.8, 0.8);

    // The exhaust cone.
    local(0, -0.08, -s.len * 0.46, _p);
    const n = Math.round((26 + 24 * power) * density);
    for (let i = 0; i < n; i++) {
      sparkSpec.px = _p.x + rng.range(-0.25, 0.25);
      sparkSpec.py = _p.y + rng.range(-0.2, 0.25);
      sparkSpec.pz = _p.z + rng.range(-0.25, 0.25);
      const kick = rng.range(11, 30) * (0.7 + 0.6 * power);
      const spread = rng.range(-3.4, 3.4);
      sparkSpec.vx = racer.vel.x * 0.55 - _fwd.x * kick + _right.x * spread;
      sparkSpec.vy = racer.vel.y * 0.55 + rng.range(0.5, 4.5);
      sparkSpec.vz = racer.vel.z * 0.55 - _fwd.z * kick + _right.z * spread;
      sparkSpec.life = rng.range(0.16, 0.34);
      sparkSpec.size0 = rng.range(0.15, 0.30);
      sparkSpec.gravity = 12;
      sparkSpec.drag = 0.7;
      sparkSpec.color0.lerpColors(tint, WHITE_HOT, 0.28).multiplyScalar(gain * 1.2);
      setHdr(sparkSpec.color1, tint, gain * 0.25);
      if (!pool.emit(sparkSpec)) break;
    }
    sparkSpec.gravity = 15;
    sparkSpec.drag = 2.0;

    dustRing(_p.x, _p.y - 0.4, _p.z, 14, 6 + 5 * power, racer.surface, 1.1 * rig);

    // Every boost source lights the same envelope. That is the whole reason it
    // exists: a pad, a mushroom, a trick and a mini-turbo were producing four
    // different amounts of frame effect for the same "I am boosting" state, and
    // a player cannot learn a signal that changes shape depending on where it
    // came from.
    fx.boostEnv = 1;

    if (racer.isPlayer) {
      screen.flash(tier > 0 ? TIER_HEX[tier]! : 0xFFD9A0, 0.18 + 0.16 * power);
      // A short, sharp kick. Long enough to feel, over before it can get in the
      // way of the corner the player is usually already in.
      trauma = clamp01(trauma + 0.16 + 0.16 * power);
      traumaDecay = 6.5;
    }
  }

  /**
   * Letting go of a drift.
   *
   * Releasing a fully charged tier three off-road used to produce *literally
   * nothing*: the sparks stopped, the speedo ring went back to yellow, and
   * three and a half seconds of investment evaporated without a frame of
   * acknowledgement, because the only thing watching for a release was the
   * boost — and off-road the boost is denied.
   *
   * A player cannot tell "I was refused" from "the game did not notice". So the
   * release itself is now an event. It is quieter than a boost by design — a
   * puff of spent rubber and the charge blowing off the wheels in its own
   * colour, with no ring, no flash and no shake — but it is never silent, and
   * at tier three it is loud enough to feel like something was thrown away.
   */
  function spendRelease(racer: Racer, fx: RacerFx, granted: boolean): void {
    const tier = fx.releaseTier;
    if (tier <= 0) return;
    const col = TIER[tier]!;
    const gain = TIER_GAIN[tier]!;
    const s = sizeOf(racer);

    for (let side = -1; side <= 1; side += 2) {
      sparkPort(racer, side, 0.20, _p);
      // Blown outward and upward off the wheel: the charge leaving, rather than
      // the kart being pushed. A boost throws its sparks straight back; this
      // one deliberately does not, so the two moments cannot be confused.
      const n = Math.round((granted ? 5 : 11) * tier * density);
      for (let i = 0; i < n; i++) {
        sparkSpec.px = _p.x + rng.range(-0.1, 0.1);
        sparkSpec.py = _p.y + rng.range(-0.05, 0.12);
        sparkSpec.pz = _p.z + rng.range(-0.1, 0.1);
        const out = rng.range(2.5, 7.5);
        sparkSpec.vx = racer.vel.x * 0.55 + _right.x * side * out + rng.range(-1.2, 1.2);
        sparkSpec.vy = racer.vel.y * 0.55 + rng.range(1.6, 5.2);
        sparkSpec.vz = racer.vel.z * 0.55 + _right.z * side * out + rng.range(-1.2, 1.2);
        sparkSpec.life = rng.range(0.2, 0.42);
        sparkSpec.size0 = rng.range(0.12, 0.24);
        sparkSpec.gravity = 18;
        sparkSpec.drag = 1.0;
        sparkSpec.color0.lerpColors(col, WHITE_HOT, 0.25).multiplyScalar(gain * 1.05);
        setHdr(sparkSpec.color1, col, gain * 0.22);
        if (!pool.emit(sparkSpec)) break;
      }
      // ...and the rubber it was standing on, letting go. Only if there *is*
      // rubber on anything: a puff of tarmac smoke under a machine that is
      // three metres in the air is a puff coming out of nowhere.
      if (!racer.grounded) continue;
      rearWheel(racer, side, 0.06, _p);
      scrubSpec.size0 = SURFACE_FX[racer.surface].size * 1.5;
      scrubSpec.px = _p.x; scrubSpec.py = _p.y + scrubSpec.size0 * 0.5; scrubSpec.pz = _p.z;
      scrubSpec.vx = racer.vel.x * 0.8; scrubSpec.vy = 0.8; scrubSpec.vz = racer.vel.z * 0.8;
      scrubSpec.life = 0.6;
      scrubSpec.size1 = scrubSpec.size0 * 3.4;
      scrubSpec.alpha = 0.13;
      setHdr(scrubSpec.color0, surfaceColors.get(racer.surface)!, 1.0);
      setHdr(scrubSpec.color1, surfaceDeep.get(racer.surface)!, 0.98);
      pool.burst(scrubSpec, Math.round(7 * density), 2.4, 0.35, rng);
    }
    sparkSpec.gravity = 15;
    sparkSpec.drag = 2.0;

    // A single soft flare at each wheel, snapping shut. Without a shape with an
    // edge on it the release is just a few more sparks in a frame that already
    // had hundreds.
    if (!granted) {
      local(0, -RIDE_HEIGHT + 0.05, -s.len * 0.34, _p);
      ring(_p.x, _p.y, _p.z, 1.0, 2.4 + 0.7 * tier, 0.26, col, gain * 0.7, 0.45);
      if (racer.isPlayer) screen.flash(TIER_HEX[tier]!, 0.05 + 0.02 * tier);
    }
  }

  /**
   * Touching down.
   *
   * Landing at 190 km/h used to produce a single pale wisp — no ring, no dust,
   * no weight. A landing is the one moment where the whole mass of the machine
   * arrives somewhere at once, and it has to be the ground that answers: a
   * hard ring punched flat across the surface, a low skirt of dust thrown
   * outward rather than upward, and a jolt in the hands.
   */
  function spendLand(racer: Racer, fx: RacerFx): void {
    const impact = clamp01(fx.pendLand);
    if (impact < 0.03) return;
    const s = sizeOf(racer);
    const rig = clamp(s.halfW / 0.85, 0.75, 1.6);
    local(0, -RIDE_HEIGHT + 0.05, 0, _p);

    // Two rings, fast and slow. One expanding hard edge reads as a shockwave;
    // a second, wider and softer behind it, reads as the dust it displaced.
    ring(_p.x, _p.y, _p.z, 1.0, (2.6 + 7.0 * impact) * rig, 0.22 + 0.14 * impact,
      WARM_WHITE, 2.2 + 1.6 * impact, 0.42 * impact + 0.14);
    ring(_p.x, _p.y, _p.z, 1.6, (4.5 + 11 * impact) * rig, 0.42 + 0.22 * impact,
      surfaceColors.get(racer.surface) ?? WARM_WHITE, 1.2 + 0.9 * impact, 0.3 * impact + 0.08);
    // Thrown *outward*, low and flat: dust that climbs on a landing reads as an
    // explosion under the kart, dust that spreads reads as weight arriving.
    dustRing(_p.x, _p.y, _p.z, 14 + Math.round(30 * impact), 4 + 11 * impact, racer.surface,
      0.85 + 0.55 * impact);

    if (impact > 0.4 && (racer.surface === 'road' || racer.surface === 'rail' || racer.surface === 'boost')) {
      sparkBurst(_p.x, _p.y + 0.05, _p.z, Math.round(14 * impact), 7 * impact, RAIL_SPARK, 2.6);
    }
    if (racer.isPlayer) {
      if (impact > 0.3) screen.flash(0xFFFFFF, 0.04 + 0.09 * impact);
      // The jolt. A landing with no kick in it is a landing the hands never
      // felt, and the camera module damps its own boom in world space — the
      // only thing this module may move is the lens angle.
      trauma = clamp01(trauma + 0.10 + 0.34 * impact);
      traumaDecay = 7.5;
    }
  }

  function spendWall(racer: Racer, fx: RacerFx): void {
    const force = clamp01(fx.pendWall);
    const s = sizeOf(racer);
    local(fx.grindSide * (s.halfW + 0.14), -0.1, rng.range(-0.4, 0.4) * s.len, _p);
    sparkBurst(_p.x, _p.y, _p.z, 8 + Math.round(20 * force), 5 + 9 * force, RAIL_SPARK, 3.4);
    ring(_p.x, _p.y - 0.4, _p.z, 0.6, 2.4 + 3 * force, 0.24, WARM_WHITE, 1.4, 0.4 * force);
    if (racer.isPlayer) screen.flash(0xFFE0B0, 0.06 + 0.14 * force);
  }

  function spendHit(racer: Racer, fx: RacerFx): void {
    const k = clamp01(fx.pendHit);
    local(0, 0.1, 0, _p);
    ring(_p.x, _p.y - RIDE_HEIGHT + 0.06, _p.z, 1.0, 7.0, 0.4, WARM_WHITE, 2.4, 0.8 * k);
    sparkBurst(_p.x, _p.y, _p.z, 22, 10, GOLD, 3.0);

    // No loose stars here. This used to throw seven pooled ones at five
    // different sizes with no velocity inheritance, and since the kart carries
    // on at fifty metres a second while they hang where they were born, what a
    // screenshot a fifth of a second later caught was flat yellow cardboard
    // strewn across the road *ahead* of the player, floating a metre off the
    // tarmac and attached to nothing. The spin-out already has a ring — see
    // `spinStars` — which orbits the machine and travels with it. One
    // vocabulary per idea: stars mean "this racer is stunned", and they live on
    // the racer.

    if (racer.isPlayer) {
      screen.flash(0xFFE8C0, 0.3);
      trauma = clamp01(trauma + 0.45);
      traumaDecay = 2.6;
    }
  }

  function spendBump(racer: Racer, fx: RacerFx): void {
    const k = clamp01(fx.pendBump);
    ring(fx.bumpX, fx.bumpY - RIDE_HEIGHT + 0.06, fx.bumpZ, 0.6, 2.6, 0.24, WARM_WHITE, 1.8, 0.5 * k);
    sparkBurst(fx.bumpX, fx.bumpY, fx.bumpZ, 6 + Math.round(8 * k), 5, WARM_WHITE, 2.2);
    if (racer.isPlayer) screen.flash(0xFFF0D0, 0.06 + 0.08 * k);
  }

  /**
   * A bogged start. The tyres spin, the machine does not move, and a wall of
   * smoke comes off the back — the one moment in the game where a big slow
   * cloud is the right answer rather than a lazy one.
   */
  function spendBurnout(racer: Racer): void {
    const s = sizeOf(racer);
    for (let side = -1; side <= 1; side += 2) {
      rearWheel(racer, side, 0.10, _p);
      smokeSpec.px = _p.x; smokeSpec.py = _p.y; smokeSpec.pz = _p.z;
      smokeSpec.vx = -_fwd.x * 2.5; smokeSpec.vy = 1.1; smokeSpec.vz = -_fwd.z * 2.5;
      smokeSpec.life = 1.5;
      smokeSpec.size0 = 0.6;
      smokeSpec.size1 = 2.6;
      smokeSpec.alpha = 0.16;
      smokeSpec.rotVel = 0.7;
      setHdr(smokeSpec.color0, SMOKE, 1.1);
      setHdr(smokeSpec.color1, SMOKE_DEEP, 1.0);
      pool.burst(smokeSpec, Math.round(34 * density), 3.2, 0.3, rng);
      // A few rubber flecks, which is what tells the eye the smoke came off a
      // tyre rather than out of an engine.
      sparkBurst(_p.x, _p.y, _p.z, 5, 4, SMOKE_DEEP, 0.35);
    }
    smokeSpec.alpha = 0.12;
    local(0, -RIDE_HEIGHT + 0.04, -s.len * 0.3, _p);
    dustRing(_p.x, _p.y, _p.z, 10, 4, racer.surface, 1.3);
  }

  /** Coins. A short gold sparkle at the collector's shoulder — enough to notice
   *  in the corner of the eye, not enough to compete with the sparks. */
  function spendCoin(racer: Racer, n: number): void {
    const s = sizeOf(racer);
    local(rng.range(-0.5, 0.5) * s.halfW, s.height * 0.5, 0, _p);
    for (let i = 0; i < Math.round(5 * n * density); i++) {
      starSpec.px = _p.x + rng.range(-0.3, 0.3);
      starSpec.py = _p.y + rng.range(-0.2, 0.3);
      starSpec.pz = _p.z + rng.range(-0.3, 0.3);
      // Full inheritance and a very short life: a coin is a glint on the
      // machine, and anything that lags behind it turns into gold litter
      // strewn down the road.
      starSpec.vx = racer.vel.x + rng.range(-1.6, 1.6);
      starSpec.vy = racer.vel.y + rng.range(1.2, 3.2);
      starSpec.vz = racer.vel.z + rng.range(-1.6, 1.6);
      starSpec.life = rng.range(0.16, 0.30);
      starSpec.size0 = rng.range(0.14, 0.24);
      starSpec.size1 = 0.02;
      setHdr(starSpec.color0, GOLD, 2.6);
      setHdr(starSpec.color1, GOLD, 0.4);
      if (!pool.emit(starSpec)) break;
    }
    starSpec.size1 = 0.1;
  }

  /** Coins knocked loose. The same gold, thrown away from the kart and falling —
   *  the shape of the effect is the whole message. */
  function spendCoinLoss(racer: Racer, k: number): void {
    local(0, 0.45, 0, _p);
    starSpec.px = _p.x; starSpec.py = _p.y; starSpec.pz = _p.z;
    starSpec.vx = racer.vel.x * 0.3;
    starSpec.vy = 3.5;
    starSpec.vz = racer.vel.z * 0.3;
    starSpec.life = 0.9;
    starSpec.size0 = 0.34;
    setHdr(starSpec.color0, GOLD, 2.6);
    setHdr(starSpec.color1, GOLD, 0.5);
    pool.burst(starSpec, Math.round((4 + 8 * k) * density), 6, 0.5, rng);
  }

  /** Star / bullet pick-up: a rising column of light off the machine. */
  function spendPowerUp(racer: Racer): void {
    const s = sizeOf(racer);
    local(0, -RIDE_HEIGHT + 0.06, 0, _p);
    ring(_p.x, _p.y, _p.z, 0.8, 6.5, 0.45, GOLD, 2.6, 0.9);
    for (let i = 0; i < Math.round(26 * density); i++) {
      const a = rng.next() * TAU;
      const r = rng.range(0.2, 1.0) * s.halfW * 1.6;
      starSpec.px = _p.x + Math.cos(a) * r;
      starSpec.py = _p.y + rng.range(0, 0.3);
      starSpec.pz = _p.z + Math.sin(a) * r;
      starSpec.vx = racer.vel.x * 0.85 + Math.cos(a) * 1.2;
      starSpec.vy = racer.vel.y * 0.85 + rng.range(4, 9);
      starSpec.vz = racer.vel.z * 0.85 + Math.sin(a) * 1.2;
      starSpec.life = rng.range(0.35, 0.7);
      starSpec.size0 = rng.range(0.2, 0.42);
      setHdr(starSpec.color0, GOLD, 3.0);
      setHdr(starSpec.color1, WARM_WHITE, 0.4);
      if (!pool.emit(starSpec)) break;
    }
  }

  /** The sparkle that trails a racer under a star or a bullet. A state, not an
   *  event: it runs for as long as the effect is on them. */
  function powerTrail(racer: Racer, fx: RacerFx, dt: number): void {
    const s = sizeOf(racer);
    fx.sparkle += 40 * density * fx.near * dt;
    let n = Math.floor(fx.sparkle);
    fx.sparkle -= n;
    if (n > 6) n = 6;
    for (let i = 0; i < n; i++) {
      local(
        rng.range(-1, 1) * s.halfW * 1.1,
        rng.range(-0.3, 1) * s.height * 0.6,
        rng.range(-0.6, 0.5) * s.len,
        _p,
      );
      starSpec.px = _p.x; starSpec.py = _p.y; starSpec.pz = _p.z;
      starSpec.vx = racer.vel.x * 0.55 + rng.range(-1, 1);
      starSpec.vy = racer.vel.y * 0.55 + rng.range(0.5, 2.5);
      starSpec.vz = racer.vel.z * 0.55 + rng.range(-1, 1);
      starSpec.life = rng.range(0.25, 0.5);
      starSpec.size0 = rng.range(0.16, 0.32);
      setHdr(starSpec.color0, GOLD, 2.8);
      setHdr(starSpec.color1, GOLD, 0.3);
      if (!pool.emit(starSpec)) break;
    }
  }

  /** Stars orbiting a spun-out kart. Immediate mode — they are a state, not an
   *  event, and the state is `racer.stunned`. */
  function spinStars(racer: Racer, add: SpriteLayer): void {
    const s = sizeOf(racer);
    const t = ctx.time.elapsed;
    const fade = clamp01(racer.stunned * 2.2);
    // Above the machine, not around its axles. `size.height` is measured from
    // the contact point, and the racer's origin already floats RIDE_HEIGHT off
    // the ground, so clearing the roof means the full height less that offset —
    // plus a little air, because a halo that grazes the bodywork reads as part
    // of the bodywork.
    const lift = s.height - RIDE_HEIGHT + 0.30;
    // Tight. The radius used to scale with the machine, which on the plane —
    // four and a half metres across the wings — threw the ring out past the
    // wingtips, and from a chase camera that is indistinguishable from stars
    // lying on the road beside the kart. A halo is a halo: it is about the same
    // size whatever is wearing it, and it has to be small enough that no part
    // of it can ever be mistaken for something on the ground.
    const r = 0.62 + Math.min(s.halfW, 1.1) * 0.30;
    for (let i = 0; i < 6; i++) {
      const a = t * 5.4 + (i * TAU) / 6;
      // Tilted, so the ring reads as a ring rather than as six sprites in a
      // line whenever the camera is level with it.
      local(Math.cos(a) * r, lift + Math.sin(a) * r * 0.30, Math.sin(a) * r, _p);
      // One size for every star, and the pulse only moves the brightness. Five
      // stars at five different sizes read as five different objects; six
      // identical ones read as one halo turning.
      const pulse = 0.72 + 0.28 * Math.sin(t * 13 + i);
      const k = 3.0 * pulse * fade;
      // A soft halo behind each, so they bloom into a ring rather than sitting
      // there as six opaque decals — which was the other half of the cardboard.
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        GOLD.r * k * 0.4, GOLD.g * k * 0.4, GOLD.b * k * 0.34, 0.55 * fade,
        0.62, 0, 0, CELL.glow, MODE.billboard,
      );
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        GOLD.r * k, GOLD.g * k, GOLD.b * k, 0.95 * fade,
        0.40, 0, a * 0.8, CELL.star, MODE.billboard,
      );
    }
  }

  /**
   * The finish. Two thirds of it is thrown *up out of the kart* and the rest
   * rains from above, because a burst that only falls has no moment of origin
   * and reads as weather.
   *
   * Flakes are large and the spread is tight. The first pass scattered small
   * ones over an eighteen-metre box, which is the correct size for a stadium
   * and completely wrong for something meant to fill the frame the player is
   * looking at: from a chase camera it produced a dozen visible specks.
   *
   * The falling half is thrown *forward*, down the direction of travel, and the
   * flakes are half the size they were. Both because of where the lens is. A
   * box centred on the kart is also a box centred on the camera six metres
   * behind it, so a third of the burst was spawning inside the near plane: one
   * flake at arm's length is thirty centimetres of solid magenta across a
   * quarter of the frame, and the finish read as the screen being hit by a
   * paint bomb rather than as confetti. Ahead of the machine they fall through
   * the shot instead of onto the glass.
   */
  function confettiBurst(
    x: number, y: number, z: number, n: number,
    vx = 0, vy = 0, vz = 0,
  ): void {
    // Which way "ahead" is, taken from the bulk velocity the caller threw the
    // burst with. Zero for a standing burst, which then falls straight down as
    // it always did.
    const speed = Math.hypot(vx, vz);
    const ax = speed > 0.5 ? vx / speed : 0;
    const az = speed > 0.5 ? vz / speed : 0;
    const lead = Math.min(14, speed * 0.5);

    for (let i = 0; i < n; i++) {
      const fountain = i * 3 < n * 2;
      if (fountain) {
        // Out of the machine, in a cone.
        const a = rng.next() * TAU;
        const r = rng.range(0, 0.9);
        flakeSpec.px = x + Math.cos(a) * r;
        flakeSpec.py = y + rng.range(0.2, 1.2);
        flakeSpec.pz = z + Math.sin(a) * r;
        const out = rng.range(3, 11);
        flakeSpec.vx = vx + Math.cos(a) * out;
        flakeSpec.vy = vy * 0.4 + rng.range(4.5, 9.5);
        flakeSpec.vz = vz + Math.sin(a) * out;
        flakeSpec.life = rng.range(2.6, 4.6);
      } else {
        // Ahead of the machine and well above it, so the fall happens in front
        // of the lens rather than on it.
        const along = lead + rng.range(-2, 9);
        const across = rng.range(-7, 7);
        flakeSpec.px = x + ax * along - az * across;
        flakeSpec.py = y + rng.range(3.0, 8.0);
        flakeSpec.pz = z + az * along + ax * across;
        flakeSpec.vx = vx * 0.35 + rng.range(-2.5, 2.5);
        flakeSpec.vy = rng.range(-1, 2);
        flakeSpec.vz = vz * 0.35 + rng.range(-2.5, 2.5);
        flakeSpec.life = rng.range(2.2, 4.0);
      }
      flakeSpec.size0 = rng.range(0.20, 0.34);
      flakeSpec.size1 = flakeSpec.size0;
      flakeSpec.rot = rng.next() * TAU;
      flakeSpec.rotVel = rng.range(-11, 11);
      const c = confettiColors[rng.int(0, confettiColors.length - 1)]!;
      // Confetti catches the light: born a little hot, settling to its own hue.
      setHdr(flakeSpec.color0, c, 1.7);
      setHdr(flakeSpec.color1, c, 0.9);
      if (!pool.emit(flakeSpec)) break;
    }
  }

  // ── speed lines ───────────────────────────────────────────────────────────
  //
  // Kept out of the particle pool. A streak wants a *fixed screen-space*
  // orientation and a length measured in fractions of the frame, and the pool's
  // stretch is derived from world velocity — which for a line sitting still in
  // front of a camera doing 60 m/s is exactly zero. So this is its own tiny
  // simulation: one flat buffer, spawn, integrate, fill.
  //
  // [ x, y, z, vx, vy, vz, age, life, rot, size, stretch, alpha ]
  const LINE_STRIDE = 12;
  const lineData = new Float32Array(LAYER_RUSH * LINE_STRIDE);
  let lineCount = 0;

  function spawnLines(amount: number, dt: number): void {
    lineAcc += amount * 260 * density * dt;
    let n = Math.floor(lineAcc);
    lineAcc -= n;
    if (n > 22) n = 22;
    if (n <= 0) return;

    const cam = ctx.camera;
    _camFwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _camRight.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _camUp.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const tanH = Math.tan(cam.fov * DEG * 0.5);

    for (let i = 0; i < n; i++) {
      if (lineCount >= LAYER_RUSH) return;
      const d = rng.range(9, 26);
      // A constant fraction of the *frame*, whatever the depth: the streaks form
      // a ring around the edge rather than a cloud in front of the kart.
      //
      // The floor matters more than it looks. A streak is placed by its centre
      // and drawn radially, so its inner tip reaches `u - stretch` toward the
      // vanishing point: at an old floor of 0.78 against a half-length of up to
      // 0.46, streaks were routinely landing a third of the way from the middle
      // of the frame — across the road the player is trying to read, and across
      // the machine they are trying to place.
      //
      // But 1.02 put the *centre* of every streak outside the glass, so all
      // that ever reached the frame was the last centimetre of an inner tip and
      // two hundred and forty km/h had no visible cue at all. 1.00 with the
      // half-length below capped at 0.30 is the compromise: the body of every
      // streak lands in the outer band, no inner tip reaches past 0.70 of the
      // half-frame, and the middle — the part the game is played in — is
      // arithmetically guaranteed to stay clean.
      const u = rng.range(1.00, 1.55);
      const a = rng.next() * TAU;
      const hy = d * tanH * u;
      const ox = Math.cos(a) * hy * cam.aspect;
      const oy = Math.sin(a) * hy;

      _p.copy(cam.position)
        .addScaledVector(_camFwd, d)
        .addScaledVector(_camRight, ox)
        .addScaledVector(_camUp, oy);

      const o = lineCount * LINE_STRIDE;
      lineData[o] = _p.x; lineData[o + 1] = _p.y; lineData[o + 2] = _p.z;
      // A little motion of their own, so the effect still reads if the boost
      // fires before the kart has picked the speed up.
      lineData[o + 3] = -_camFwd.x * 10;
      lineData[o + 4] = -_camFwd.y * 10;
      lineData[o + 5] = -_camFwd.z * 10;
      lineData[o + 6] = 0;
      lineData[o + 7] = rng.range(0.20, 0.38);
      // The long axis is the view-space direction out from the vanishing point,
      // which is exactly the path the world takes across the frame.
      lineData[o + 8] = Math.atan2(oy, ox);
      lineData[o + 9] = rng.range(0.16, 0.34) * d * 0.08;
      lineData[o + 10] = d * tanH * rng.range(0.12, 0.30);
      lineData[o + 11] = rng.range(0.72, 1.15) * amount;
      lineCount++;
    }
  }

  function updateLines(dt: number, rush: SpriteLayer): void {
    let i = 0;
    while (i < lineCount) {
      const o = i * LINE_STRIDE;
      const age = lineData[o + 6] + dt;
      const life = lineData[o + 7];
      if (age >= life) {
        lineCount--;
        if (i !== lineCount) {
          lineData.copyWithin(o, lineCount * LINE_STRIDE, lineCount * LINE_STRIDE + LINE_STRIDE);
        }
        continue;
      }
      lineData[o + 6] = age;
      lineData[o] += lineData[o + 3] * dt;
      lineData[o + 1] += lineData[o + 4] * dt;
      lineData[o + 2] += lineData[o + 5] * dt;

      // In and out on one hump: a streak that pops into existence at full
      // brightness reads as a scratch on the lens.
      const a = lineData[o + 11] * Math.sin(Math.PI * (age / life));
      rush.push(
        lineData[o], lineData[o + 1], lineData[o + 2],
        0, 0, 0,
        WARM_WHITE.r * 3.2, WARM_WHITE.g * 3.1, WARM_WHITE.b * 2.9, a,
        lineData[o + 9], lineData[o + 10], lineData[o + 8],
        CELL.streak, MODE.billboard,
      );
      i++;
    }
  }

  // ── bus wiring. Handlers record impulses only ─────────────────────────────

  ctx.bus.on<{ racer: Racer }>('kart:drift:start', ({ racer }) => {
    fxOf(racer).pendDriftStart = 1;
  });

  ctx.bus.on<{ racer: Racer; tier: number }>('kart:drift:charge', ({ racer, tier }) => {
    if (tier <= 0) return;
    const fx = fxOf(racer);
    fx.pendTier = Math.max(fx.pendTier, tier);
  });

  ctx.bus.on<{ racer: Racer; source: string; power: number }>('kart:boost', ({ racer, source, power }) => {
    const fx = fxOf(racer);
    fx.pendBoost = Math.max(fx.pendBoost, power);
    const tier = source === 'drift1' ? 1 : source === 'drift2' ? 2 : source === 'drift3' ? 3 : 0;
    if (tier > fx.boostTier) fx.boostTier = tier;
  });

  ctx.bus.on<{ racer: Racer; impact: number }>('kart:land', ({ racer, impact }) => {
    const fx = fxOf(racer);
    fx.pendLand = Math.max(fx.pendLand, impact);
  });

  ctx.bus.on<{ racer: Racer }>('kart:hop', ({ racer }) => {
    fxOf(racer).pendHop = 1;
  });

  ctx.bus.on<{ racer: Racer }>('kart:offroad', ({ racer }) => {
    fxOf(racer).pendOffroad = 1;
  });

  ctx.bus.on<{ racer: Racer; force: number }>('kart:wall', ({ racer, force }) => {
    const fx = fxOf(racer);
    fx.pendWall = Math.max(fx.pendWall, force);
    fx.grind = Math.max(fx.grind, 0.28);
  });

  ctx.bus.on<{ racer: Racer }>('kart:hit', ({ racer }) => {
    fxOf(racer).pendHit = 1;
  });

  ctx.bus.on<{ racer: Racer }>('kart:trick', ({ racer }) => {
    fxOf(racer).pendTrick = 1;
  });

  ctx.bus.on<{ a: Racer; b: Racer; force: number }>('kart:bump', ({ a, b, force }) => {
    // Contact resolution fires this every fixed step while two karts overlap —
    // 120 times a second for as long as they are touching. One pop per pair per
    // fifth of a second is the event a player actually perceives.
    const key = Math.min(a.id, b.id) * 64 + Math.max(a.id, b.id);
    const last = bumpAt.get(key) ?? -99;
    if (ctx.time.elapsed - last < 0.2) return;
    bumpAt.set(key, ctx.time.elapsed);
    const target = a.isPlayer || !b.isPlayer ? a : b;
    const fx = fxOf(target);
    fx.pendBump = Math.max(fx.pendBump, clamp01(force * 3));
    fx.bumpX = (a.pos.x + b.pos.x) * 0.5;
    fx.bumpY = (a.pos.y + b.pos.y) * 0.5;
    fx.bumpZ = (a.pos.z + b.pos.z) * 0.5;
  });

  // The director counts `ceil(timer - 1)`, so it reaches zero a whole second
  // before the lights actually go out. Treating that zero as "GO" — which this
  // used to — fired the launch burst while the field was still stationary, and
  // then the real start had nothing at all. The beats come off the number; the
  // start comes off the phase change, which is the only thing that happens at
  // the same instant the karts are allowed to move.
  ctx.bus.on<{ n: number }>('race:countdown', ({ n }) => {
    pendCountdown = Math.max(pendCountdown, 4 - clamp(n, 0, 3));
  });

  let lastPhase: string = ctx.race.phase;
  ctx.bus.on<{ phase: string }>('race:phase', ({ phase }) => {
    // Only a real countdown → racing transition. A capture reset drops straight
    // into 'racing', and a starting-line burst under a kart already at 60 m/s
    // reads as a bug rather than as a start.
    if (phase === 'racing' && lastPhase === 'countdown') pendGo = 1;
    lastPhase = phase;
  });

  ctx.bus.on<{ racer: Racer }>('race:finish', ({ racer }) => {
    if (racer.isPlayer) pendConfetti = 1;
    else pendConfetti = Math.max(pendConfetti, 0.35);
  });

  ctx.bus.on<{ racer: Racer }>('race:lap', ({ racer }) => {
    if (racer.isPlayer) pendLapPop = 1;
  });

  ctx.bus.on<{ racer: Racer }>('race:rocketStart', ({ racer }) => {
    const fx = fxOf(racer);
    fx.pendBoost = Math.max(fx.pendBoost, 42);
  });

  // Bogged the start: a cloud of wasted rubber and no forward motion. Loud,
  // because the punishment being legible is the whole point of the mechanic.
  ctx.bus.on<{ racer: Racer }>('race:burnout', ({ racer }) => {
    fxOf(racer).pendBurnout = 1;
  });

  ctx.bus.on<{ racer: Racer; power: number }>('kart:launch', ({ racer, power }) => {
    const fx = fxOf(racer);
    fx.pendLaunch = Math.max(fx.pendLaunch, clamp01(power / 9));
  });

  // Drafting. The tell is on the *frame*, not on the kart: the air the player is
  // sitting in starts moving. A pulse on entry and a held wind while it lasts.
  ctx.bus.on<{ racer: Racer; state: string }>('kart:slipstream', ({ racer, state }) => {
    const fx = fxOf(racer);
    if (state === 'enter') { fx.draft = 1; fx.pendDraft = 1; } else fx.draft = 0;
  });

  ctx.bus.on<{ racer: Racer }>('kart:trick:start', ({ racer }) => {
    fxOf(racer).pendHop = 1;
  });

  // ── items. Every one of these is a moment the item module announces and,
  // until now, nothing drew. The item system builds its own blast and burst
  // *meshes*; what is added here is the particle half — the debris, the sparks
  // and the dust that stop those meshes reading as a decal popping in place.

  ctx.bus.on<{ pos: THREE.Vector3; radius: number }>('item:blast', ({ pos, radius }) => {
    const scale = clamp(radius / 6, 0.6, 2.2);
    api.spawn('explosion', pos, { scale });
  });

  ctx.bus.on<{ pos: THREE.Vector3 }>('item:box', ({ pos }) => {
    api.spawn('boxBreak', pos, { scale: 1 });
  });

  ctx.bus.on<{ pos: THREE.Vector3; kind: string }>('item:bounce', ({ pos, kind }) => {
    api.spawn('impact', pos, { scale: 0.7, color: kind === 'greenShell' ? 0x8CE06A : 0xFF7A6A });
  });

  ctx.bus.on<{ racer: Racer; total: number }>('coin:get', ({ racer }) => {
    fxOf(racer).pendCoin = Math.min(3, fxOf(racer).pendCoin + 1);
  });

  ctx.bus.on<{ racer: Racer; count: number }>('coin:lose', ({ racer, count }) => {
    const fx = fxOf(racer);
    fx.pendCoinLoss = Math.max(fx.pendCoinLoss, Math.min(1, count / 3));
  });

  ctx.bus.on<{ racer: Racer; effect: string; on: boolean }>('item:effect', ({ racer, effect, on }) => {
    if (!on) return;
    const fx = fxOf(racer);
    if (effect === 'star' || effect === 'bullet') fx.pendPowerUp = 1;
  });

  ctx.bus.on<{ standings: number[] }>('race:results', () => {
    pendConfetti = Math.max(pendConfetti, 1);
  });

  ctx.bus.on('quality:changed', () => {
    density = clamp01(ctx.quality.particles);
    marks.applyQuality();
  });

  // ── the public face ───────────────────────────────────────────────────────

  const api: FxSystem = {
    spawn(id: string, pos: THREE.Vector3, opts?: Record<string, unknown>): void {
      if (qCount >= QUEUE) return;
      qId[qCount] = id;
      qX[qCount] = pos.x; qY[qCount] = pos.y; qZ[qCount] = pos.z;
      qScale[qCount] = typeof opts?.scale === 'number' ? (opts.scale as number) : 1;
      qColor[qCount] = typeof opts?.color === 'number' ? (opts.color as number) : -1;
      qCount++;
    },

    shake(amount: number, duration = 0.4): void {
      trauma = clamp01(trauma + clamp01(amount));
      traumaDecay = 1 / Math.max(0.05, duration);
    },

    flash(color: number, amount = 0.4): void {
      screen.flash(color, amount);
    },
  };
  ctx.fx = api;

  function drainQueue(): void {
    for (let i = 0; i < qCount; i++) {
      const id = qId[i]!;
      const x = qX[i]!, y = qY[i]!, z = qZ[i]!;
      const scale = qScale[i]!;
      const hex = qColor[i]!;
      const col = hex >= 0 ? _tint.setHex(hex) : WARM_WHITE;

      switch (id) {
        case 'spark':
        case 'sparks':
          sparkBurst(x, y, z, 16 * scale, 8 * scale, col, 3.0);
          break;
        case 'dust':
        case 'smoke':
          dustRing(x, y, z, 10 * scale, 4 * scale, 'dirt', scale);
          break;
        case 'splash':
          dustRing(x, y, z, 16 * scale, 6 * scale, 'water', scale);
          break;
        case 'explosion':
          ring(x, y, z, 1.5 * scale, 12 * scale, 0.5, FLAME_MID, 3.0, 1);
          sparkBurst(x, y + 0.4, z, 34 * scale, 16 * scale, FLAME_HOT, 4.0);
          dustRing(x, y, z, 18 * scale, 9 * scale, 'dirt', 1.5 * scale);
          screen.flash(0xFFC070, 0.34);
          trauma = clamp01(trauma + 0.6);
          traumaDecay = 2.4;
          break;
        case 'boost':
          ring(x, y, z, 1.2 * scale, 7 * scale, 0.4, col, 2.6, 0.9);
          sparkBurst(x, y, z, 22 * scale, 12 * scale, col, 3.2);
          break;
        case 'impact':
          ring(x, y, z, 0.7 * scale, 4 * scale, 0.3, col, 2.0, 0.7);
          sparkBurst(x, y, z, 12 * scale, 7 * scale, col, 2.6);
          break;
        case 'ring':
          ring(x, y, z, 0.8 * scale, 8 * scale, 0.45, col, 2.4, 0.9);
          break;
        case 'stars':
          starSpec.px = x; starSpec.py = y; starSpec.pz = z;
          starSpec.vx = 0; starSpec.vy = 2; starSpec.vz = 0;
          starSpec.life = 0.8; starSpec.size0 = 0.5;
          setHdr(starSpec.color0, col, 3.0);
          setHdr(starSpec.color1, col, 0.4);
          pool.burst(starSpec, Math.round(8 * density * scale), 6, 0.6, rng);
          break;
        case 'confetti':
          confettiBurst(x, y, z, Math.round(90 * density * scale));
          break;
        case 'boxBreak':
          // An item box coming apart. The item module draws the box shattering;
          // this is the glitter and the puff of road dust it kicks up, which is
          // what stops the mesh reading as a model being switched off.
          ring(x, y, z, 0.5 * scale, 3.2 * scale, 0.3, WARM_WHITE, 2.2, 0.75);
          sparkBurst(x, y, z, Math.round(16 * scale), 7 * scale, GOLD, 2.8);
          sparkBurst(x, y, z, Math.round(8 * scale), 5 * scale, TIER[1]!, 2.4);
          for (let k = 0; k < Math.round(10 * density * scale); k++) {
            flakeSpec.px = x + rng.range(-0.3, 0.3);
            flakeSpec.py = y + rng.range(-0.3, 0.3);
            flakeSpec.pz = z + rng.range(-0.3, 0.3);
            flakeSpec.vx = rng.range(-4, 4);
            flakeSpec.vy = rng.range(1, 6);
            flakeSpec.vz = rng.range(-4, 4);
            flakeSpec.life = rng.range(0.5, 1.1);
            flakeSpec.size0 = rng.range(0.12, 0.22);
            flakeSpec.size1 = flakeSpec.size0;
            flakeSpec.rot = rng.next() * TAU;
            flakeSpec.rotVel = rng.range(-14, 14);
            const c = confettiColors[rng.int(0, confettiColors.length - 1)]!;
            setHdr(flakeSpec.color0, c, 1.4);
            setHdr(flakeSpec.color1, c, 0.8);
            if (!pool.emit(flakeSpec)) break;
          }
          break;
        case 'shine':
        case 'sparkle':
          sparkBurst(x, y, z, 10 * scale, 4 * scale, GOLD, 3.2);
          ring(x, y, z, 0.4 * scale, 2.2 * scale, 0.3, GOLD, 2.0, 0.7);
          break;
        default:
          // An unknown id still has to show something: a silent effect is a bug
          // nobody finds until a reviewer asks why the item does nothing.
          sparkBurst(x, y, z, 10 * scale, 6 * scale, col, 2.6);
          break;
      }
    }
    qCount = 0;
  }

  /** Barrier scrape for the player. Physics reports the first contact and then
   *  goes quiet for as long as the kart is rubbing along the rail, so the grind
   *  itself has to be detected here — a kart riding a barrier with no sparks is
   *  the clearest "nothing is happening" signal the game can send. */
  function playerGrind(racer: Racer, fx: RacerFx, dt: number): void {
    const track = ctx.track;
    if (!track || track.course.walls === false || !racer.grounded) return;
    const s = track.spline.nearest(racer.pos, _sample);
    const halfW = sizeOf(racer).halfW;
    const limit = s.width * 0.5 + (track.course.vergeWidth ?? 5) - halfW - K.wall.gap;
    const lateral = s.lateral ?? 0;
    if (Math.abs(lateral) < limit - 0.22 || Math.abs(racer.speed) < 6) return;
    fx.grindSide = lateral > 0 ? 1 : -1;
    fx.grind = Math.max(fx.grind, dt + 0.02);
  }

  return {
    name: 'fx',
    order: 90,

    init(): void {
      atlas = createAtlas();
      addLayer = createSpriteLayer({
        name: 'fxAdditive', atlas, capacity: LAYER_ADD,
        blending: THREE.AdditiveBlending, renderOrder: 20,
      });
      alphaLayer = createSpriteLayer({
        name: 'fxAlpha', atlas, capacity: LAYER_ALPHA,
        blending: THREE.NormalBlending, renderOrder: 18,
      });
      rushLayer = createSpriteLayer({
        name: 'fxRush', atlas, capacity: LAYER_RUSH,
        blending: THREE.AdditiveBlending, renderOrder: 900, depthTest: false,
      });
      ctx.scene.add(alphaLayer.mesh, addLayer.mesh, rushLayer.mesh, marks.mesh);
      density = clamp01(ctx.quality.particles);
      marks.applyQuality();
    },

    reset(cfg: RaceConfig): void {
      // A private stream, but still seeded off the race so a capture of the
      // same seed photographs the same sparks.
      rng = makeRng(((cfg.seed ?? 1) * 2654435761) >>> 0 || 0x9e37);
      pool.clear();
      marks.reset();
      screen.reset();
      state.clear();
      bumpAt.clear();
      lineCount = 0;
      lineAcc = 0;
      trauma = 0;
      camPrimed = false;
      qCount = 0;
      pendCountdown = 0;
      pendGo = 0;
      pendConfetti = 0;
      pendLapPop = 0;
      density = clamp01(ctx.quality.particles);
      marks.applyQuality();
    },

    update(rawDt: number, alpha: number): void {
      const add = addLayer, alp = alphaLayer, rush = rushLayer;
      if (!add || !alp || !rush) return;

      const dt = clamp(rawDt, 0, 0.1);
      // A pool close to full starves the effects that matter most, so emission
      // is throttled before it gets there rather than dropped at random.
      const headroom = pool.load > 0.82 ? clamp01((1 - pool.load) / 0.18) : 1;
      const baseDensity = clamp01(ctx.quality.particles) * headroom;
      density = baseDensity;

      // Camera velocity for the streak shader. A cut or a reset teleports the
      // rig, and one frame of a 400 m/s "velocity" would turn every spark in
      // the pool into a screen-long dash, so an implausible jump is treated as
      // a cut and reported as zero.
      if (camPrimed && dt > 1e-4) {
        camVel.subVectors(ctx.camera.position, camPrev).divideScalar(dt);
        if (camVel.lengthSq() > 200 * 200) camVel.set(0, 0, 0);
      } else {
        camVel.set(0, 0, 0);
      }
      camPrev.copy(ctx.camera.position);
      camPrimed = true;

      pool.update(dt);
      add.reset();
      alp.reset();
      rush.reset();
      add.setCameraVelocity(camVel.x, camVel.y, camVel.z);
      alp.setCameraVelocity(camVel.x, camVel.y, camVel.z);
      rush.setCameraVelocity(camVel.x, camVel.y, camVel.z);

      drainQueue();

      const cam = ctx.camera;
      const player = ctx.player;

      for (const racer of ctx.racers) {
        const fx = fxOf(racer);
        frameOf(racer, alpha);
        if (racer.isPlayer) _playerPos.copy(_pos);

        // How much this racer's effects are worth. The player always pays full
        // price; everyone else fades out with distance, which is what keeps a
        // pack of eight drifting through a hairpin inside budget.
        const d2 = _pos.distanceToSquared(cam.position);
        fx.near = racer.isPlayer ? 1
          : d2 > 26000 ? 0
          : d2 < 900 ? 1
          : clamp01(1 - (Math.sqrt(d2) - 30) / 130) * 0.9 + 0.1;

        // ── letting go of a drift ───────────────────────────────────────
        // Physics announces the start of a drift and the tier it reaches, but
        // never the end of one, and the end is a moment the player has just
        // spent three seconds earning. Watching the state here is a read, not a
        // write — nothing below touches the simulation.
        const drifting = racer.drift.active;
        if (fx.lastCharge > 0 && !drifting) {
          fx.release = 1;
          fx.releaseTier = fx.lastTier;
        }
        fx.lastCharge = drifting ? Math.max(0.001, racer.drift.charge) : 0;
        if (drifting) fx.lastTier = racer.drift.tier;

        // ── impulses ────────────────────────────────────────────────────
        if (fx.pendTier > 0) {
          const tier = fx.pendTier as 1 | 2 | 3;
          fx.pendTier = 0;
          fx.pop = 1;
          fx.popTier = tier;
          const col = TIER[tier]!;
          const gain = TIER_GAIN[tier]!;
          const s = sizeOf(racer);
          // A burst at each wheel rather than one at the tail: the tier is read
          // off the wheels, so that is where the announcement has to happen.
          for (let side = -1; side <= 1; side += 2) {
            sparkPort(racer, side, 0.26, _p);
            sparkBurst(_p.x, _p.y, _p.z, 12 + 5 * tier, 6.5 + 2.5 * tier, col, gain * 1.2);
          }
          local(0, -RIDE_HEIGHT + 0.05, -s.len * 0.34, _p);
          ring(_p.x, _p.y, _p.z, 0.8, 3.4 + 0.9 * tier, 0.34, col, gain, 0.85);
          if (racer.isPlayer) {
            screen.flash(TIER_HEX[tier]!, 0.07 + 0.035 * tier);
            // A whisper of shake, so the tier lands in the hands as well as the
            // eyes. Any more and holding a long drift becomes seasick.
            trauma = clamp01(trauma + 0.05 + 0.025 * tier);
            traumaDecay = 9;
          }
        }
        if (fx.pendDriftStart > 0) {
          fx.pendDriftStart = 0;
          local(0, -RIDE_HEIGHT + 0.04, -sizeOf(racer).len * 0.3, _p);
          dustRing(_p.x, _p.y, _p.z, 5, 3.5, racer.surface, 0.8);
        }
        if (fx.pendHop > 0) {
          fx.pendHop = 0;
          local(0, -RIDE_HEIGHT + 0.04, 0, _p);
          dustRing(_p.x, _p.y, _p.z, 4, 3, racer.surface, 0.7);
        }
        const boosted = fx.pendBoost > 0;
        if (boosted) { spendBoost(racer, fx); fx.pendBoost = 0; }
        // After the boost, so a granted mini-turbo can tone its own release
        // down rather than doubling up on the same frame.
        if (fx.release > 0) { spendRelease(racer, fx, boosted); fx.release = 0; }
        if (fx.pendLand > 0) { spendLand(racer, fx); fx.pendLand = 0; }
        if (fx.pendOffroad > 0) {
          fx.pendOffroad = 0;
          local(0, -RIDE_HEIGHT + 0.06, -sizeOf(racer).len * 0.3, _p);
          dustRing(_p.x, _p.y, _p.z, 12, 5, racer.surface, 1.2);
        }
        if (fx.pendWall > 0) { spendWall(racer, fx); fx.pendWall = 0; }
        if (fx.pendHit > 0) { spendHit(racer, fx); fx.pendHit = 0; }
        if (fx.pendBump > 0) { spendBump(racer, fx); fx.pendBump = 0; }
        if (fx.pendTrick > 0) {
          fx.pendTrick = 0;
          local(0, 0.2, 0, _p);
          sparkBurst(_p.x, _p.y, _p.z, 14, 7, GOLD, 3.0);
        }
        if (fx.pendBurnout > 0) { spendBurnout(racer); fx.pendBurnout = 0; }
        if (fx.pendLaunch > 0) {
          const k = fx.pendLaunch;
          fx.pendLaunch = 0;
          local(0, -RIDE_HEIGHT + 0.05, 0, _p);
          ring(_p.x, _p.y, _p.z, 0.9, 3.5 + 5 * k, 0.3, WARM_WHITE, 2.0, 0.5 + 0.3 * k);
          dustRing(_p.x, _p.y, _p.z, 6 + Math.round(10 * k), 3 + 6 * k, racer.surface, 1.0);
        }
        if (fx.pendCoin > 0) { spendCoin(racer, fx.pendCoin); fx.pendCoin = 0; }
        if (fx.pendCoinLoss > 0) { spendCoinLoss(racer, fx.pendCoinLoss); fx.pendCoinLoss = 0; }
        if (fx.pendPowerUp > 0) { spendPowerUp(racer); fx.pendPowerUp = 0; }
        if (fx.pendDraft > 0) {
          fx.pendDraft = 0;
          if (racer.isPlayer) screen.flash(0xD8ECFF, 0.07);
        }

        // ── continuous ──────────────────────────────────────────────────
        fx.glow = damp(fx.glow, racer.drift.active && racer.grounded ? 1 : 0,
          racer.drift.active ? 0.0004 : 0.0000004, dt);
        fx.pop = Math.max(0, fx.pop - dt * 3.6);
        fx.draftEase = damp(fx.draftEase, fx.draft, 0.02, dt);
        // Outside the `near` gate on purpose: a racer whose boost ended while
        // they were too far away to draw would otherwise keep the old tier tint
        // and fire their next pad boost in purple.
        if (racer.boost.time <= 0) fx.boostTier = 0;
        // The boost envelope. Held up by the live boost, and released over
        // about a third of a second once it ends, so the state has a shape of
        // its own instead of vanishing between one rendered frame and the next.
        fx.boostEnv = racer.boost.time > 0
          ? 1
          : Math.max(0, fx.boostEnv - dt * 3.0);

        if (fx.near > 0.02) {
          if (racer.drift.active && racer.grounded) {
            // Order matters: the haze goes down first so the sparks land on top
            // of it. Both are in different layers, but the alpha layer draws
            // under the additive one, and the read is "sparks coming out of
            // smoke" rather than "sparks in front of smoke".
            driftScrub(racer, fx, dt);
            driftSparks(racer, fx, dt);
          }
          driftGlow(racer, fx, add);
          if (racer.grounded) surfaceDust(racer, fx, dt);
          // Always on, every machine, player and CPU alike — the layer that
          // makes the seconds between events look like a race rather than a
          // diorama. It is the only emitter here that does not need a reason.
          exhaustPuffs(racer, fx, dt);
          exhaustGlow(racer, fx, add);
          if (racer.boost.time > 0) boostFlame(racer, fx, dt, add);
          // Any stun, not only a spin. A squish and a bump leave a kart just as
          // helpless, and a silent one reads as the game having hung.
          if (racer.stunned > 0) spinStars(racer, add);
          if (racer.effects.has('star') || racer.effects.has('bullet')) {
            powerTrail(racer, fx, dt);
          }
        }

        if (racer.isPlayer) playerGrind(racer, fx, dt);
        if (fx.grind > 0) {
          fx.grind = Math.max(0, fx.grind - dt);
          const s = sizeOf(racer);
          // Grinding a barrier at 90km/h is one of the loudest things that can
          // happen to a kart, and three sparks a frame was a polite cough.
          const n = Math.min(9, Math.round(220 * density * dt) + 2);
          const bite = clamp01(Math.abs(racer.speed) / 40);
          // Outboard of the flank, not on it: sparks born inside the bodywork
          // are sparks the depth buffer eats.
          const flank = fx.grindSide * (s.halfW + 0.14);
          for (let i = 0; i < n; i++) {
            local(flank, rng.range(-0.35, 0.05), rng.range(-0.4, 0.3) * s.len, _p);
            sparkSpec.px = _p.x; sparkSpec.py = _p.y; sparkSpec.pz = _p.z;
            // Most of the kart's speed, so the sparks stream back along the wall
            // instead of hanging in the air the moment they leave it.
            const out = rng.range(2, 7) * (0.5 + 0.5 * bite);
            sparkSpec.vx = racer.vel.x * 0.62 + _right.x * fx.grindSide * out;
            sparkSpec.vy = racer.vel.y * 0.62 + rng.range(0.5, 3.4);
            sparkSpec.vz = racer.vel.z * 0.62 + _right.z * fx.grindSide * out;
            sparkSpec.life = rng.range(0.12, 0.26);
            sparkSpec.size0 = rng.range(0.12, 0.24);
            sparkSpec.gravity = 20;
            sparkSpec.drag = 0.8;
            setHdr(sparkSpec.color0, RAIL_SPARK, 2.9);
            setHdr(sparkSpec.color1, RAIL_SPARK, 0.3);
            pool.emit(sparkSpec);
          }
          sparkSpec.gravity = 15;
          sparkSpec.drag = 2.0;
          // The hot point where the bodywork is actually touching. Without it
          // the sparks look like they are coming off nothing.
          local(flank, -0.12, rng.range(-0.2, 0.2) * s.len, _p);
          const flick = 0.7 + 0.3 * Math.sin(ctx.time.elapsed * 53 + racer.id);
          const gk = 2.6 * flick * bite;
          add.push(
            _p.x, _p.y, _p.z, 0, 0, 0,
            RAIL_SPARK.r * gk, RAIL_SPARK.g * gk, RAIL_SPARK.b * gk, 0.85 * bite,
            0.55 * flick, 0, 0, CELL.glow, MODE.billboard,
          );
        }

        // ── tyre marks ──────────────────────────────────────────────────
        //
        // The track's memory. Everything above lives for a fraction of a second;
        // this is the only thing the fx module leaves behind, and it is what
        // makes a corner look like it has been raced through rather than
        // arrived at. The previous pass laid marks that were technically there
        // and visually not: a spike-profiled ribbon half a metre wide whose
        // full darkness existed only along the exact centreline, which from
        // overhead on tarmac is indistinguishable from the road's own
        // aggregate. Wider, flatter across its width (see marks.ts), darker on
        // asphalt, and laid by all four wheels once the tyres are genuinely
        // scrubbing rather than by the rears alone.
        const sfx = SURFACE_FX[racer.surface];
        const markable = racer.grounded && sfx.mark > 0 && d2 < 30000;
        if (markable) {
          const slip = slipOf(racer);
          const strength = clamp01(
            (racer.drift.active ? 1.0 : 0)
            + slip * 3.0
            + (racer.boost.time > 0 ? 0.45 : 0)
            + (racer.stunned > 0 ? 0.7 : 0),
          ) * sfx.mark * clamp01(Math.abs(racer.speed) / 14);
          if (strength > 0.04) {
            const tint = markTints.get(racer.surface)!;
            const s = sizeOf(racer);
            // A tyre lays about a third of a metre of rubber; the quad has to be
            // wider than the contact patch because its shoulders are soft — but
            // not so wide that the two rear marks merge into one band. Two
            // parallel arcs read as a machine that was sliding; one broad
            // smear reads as a paint roller.
            const halfW = clamp(s.halfW * 0.34, 0.22, 0.44);
            for (let side = -1; side <= 1; side += 2) {
              rearWheel(racer, side, 0.032, _p);
              marks.stroke(
                racer.id * 4 + (side > 0 ? 1 : 0),
                _p.x, _p.y, _p.z,
                _right.x, _right.y, _right.z,
                halfW, strength, tint,
              );
            }
            // The fronts, once the whole machine is sliding rather than the back
            // end alone. Four marks through a corner is what a scrub looks like
            // from above; two is what a handbrake turn looks like.
            if (slip > 0.16) {
              const fs = clamp01((slip - 0.16) / 0.3) * strength * 0.7;
              for (let side = -1; side <= 1; side += 2) {
                local(side * s.halfW * 0.84, -RIDE_HEIGHT + 0.032, s.len * 0.32, _p);
                marks.stroke(
                  racer.id * 4 + 2 + (side > 0 ? 1 : 0),
                  _p.x, _p.y, _p.z,
                  _right.x, _right.y, _right.z,
                  halfW * 0.82, fs, tint,
                );
              }
            } else {
              marks.lift(racer.id * 4 + 2);
              marks.lift(racer.id * 4 + 3);
            }
          } else {
            for (let k = 0; k < 4; k++) marks.lift(racer.id * 4 + k);
          }
        } else {
          for (let k = 0; k < 4; k++) marks.lift(racer.id * 4 + k);
        }
      }

      // ── global beats ──────────────────────────────────────────────────
      // Each light escalates: the last beat before the start is nearly twice the
      // first. A countdown where every number lands identically has no rhythm,
      // and rhythm is the only thing a countdown is for.
      if (pendCountdown > 0) {
        const beat = pendCountdown;
        pendCountdown = 0;
        screen.flash(beat >= 4 ? 0xFFE9A0 : 0xFFF0C8, 0.07 + 0.05 * beat);
        if (player) {
          frameOf(player, alpha);
          local(0, -RIDE_HEIGHT + 0.05, 0, _p);
          ring(_p.x, _p.y, _p.z, 1.0, 3.0 + 0.9 * beat, 0.34,
            beat >= 4 ? GOLD : WARM_WHITE, 2.0, 0.28 + 0.12 * beat);
        }
      }
      if (pendGo > 0) {
        pendGo = 0;
        screen.flash(0xB8FFA0, 0.34);
        for (const racer of ctx.racers) {
          frameOf(racer, alpha);
          local(0, -RIDE_HEIGHT + 0.05, -sizeOf(racer).len * 0.35, _p);
          ring(_p.x, _p.y, _p.z, 0.8, 4.5, 0.4, WARM_WHITE, 2.4, 0.8);
          dustRing(_p.x, _p.y, _p.z, 8, 5, racer.surface, 1.0);
        }
      }
      if (pendLapPop > 0) {
        pendLapPop = 0;
        if (player) {
          frameOf(player, alpha);
          local(0, 0.6, 0, _p);
          sparkBurst(_p.x, _p.y, _p.z, 18, 8, GOLD, 3.2);
          screen.flash(0xFFE9A8, 0.12);
        }
      }
      if (pendConfetti > 0) {
        const strength = pendConfetti;
        pendConfetti = 0;
        if (player) {
          frameOf(player, alpha);
          // Thrown *with* the kart. Confetti born at rest beside a machine still
          // doing 32 m/s is behind the chase camera in a quarter of a second,
          // which is exactly how a burst of four hundred flakes managed to be
          // completely invisible in every screenshot of the finish.
          confettiBurst(
            _pos.x, _pos.y, _pos.z, Math.round(420 * density * strength),
            player.vel.x * 0.8, player.vel.y * 0.8, player.vel.z * 0.8,
          );
          local(0, 0.4, 0, _p);
          sparkBurst(_p.x, _p.y, _p.z, Math.round(40 * strength), 12, GOLD, 3.0);
          ring(_pos.x, _pos.y - RIDE_HEIGHT + 0.05, _pos.z, 1.5, 16, 0.7, GOLD, 2.4, 0.9);
          screen.flash(0xFFF3D0, 0.32 * strength);
        }
      }

      // ── the lens ──────────────────────────────────────────────────────
      let rushAmt = 0;
      let lineAmt = 0;
      let chargeAmt = 0;
      if (player) {
        const pfx = fxOf(player);
        const cls = ctx.config.race.classes[ctx.race.engineClass];
        const refSpeed = Math.max(1, K.maxSpeed * cls.speedMul);
        const speedFrac = clamp01(Math.abs(player.speed) / refSpeed);
        // Off the envelope, not off `boost.time`. A pad boost, a mushroom, a
        // trick and each mini-turbo tier now light this to exactly the same
        // height and let go at the same rate, which is the difference between a
        // signal a player learns and four separate things that happen sometimes.
        // The envelope also survives a frame drawn a tenth of a second after
        // the boost expired, which the raw state does not.
        rushAmt = clamp01(pfx.boostEnv * (0.62 + 0.38 * clamp01((player.boost.power - 18) / 34)));
        // Sitting in someone's slipstream is worth a few streaks of its own —
        // it is a speed the player did not ask for, and it should look like it.
        // Streaks only: the warm edge glow belongs to a boost, and lighting it
        // up for a draft would spend the game's loudest signal on its quietest
        // event.
        //
        // And raw speed earns streaks too. Two hundred and forty km/h with no
        // cue of any kind on the frame was one of the loudest complaints about
        // the last pass: the machine and the road were the only things moving,
        // so a still frame at full chat looked exactly like a still frame at
        // walking pace. The threshold starts well below the top so it is a
        // *gradient* the player feels building, and the streaks stay out at the
        // rim where they cannot cover the driving line.
        const fast = clamp01((speedFrac - 0.58) / 0.36);
        lineAmt = clamp01(rushAmt + fast * 0.62 + pfx.draftEase * 0.3);
        // Speed lines are a *lens* effect: they belong to a camera riding on
        // the machine. Spawned around the frustum of a camera parked forty
        // metres overhead they read as scratches drawn across the world, which
        // is exactly how the overhead review shot photographs them. Distance
        // from the thing the effect is about is the honest test, and it turns
        // them off for overhead, free and cinematic without this module needing
        // to know the camera system's mode names.
        const camDist = cam.position.distanceTo(_playerPos);
        lineAmt *= clamp01(1 - (camDist - 26) / 16);
        // Deliberately restrained. The sparks are the meter; this is the frame
        // agreeing with them out of the corner of the player's eye, and a tint
        // strong enough to reach the middle of the sky would be reading the
        // charge to them in block capitals.
        chargeAmt = player.drift.active ? 0.34 + 0.22 * player.drift.tier : 0;
        screen.setChargeTier(player.drift.tier);
      }
      screen.setRush(rushAmt);
      screen.setCharge(chargeAmt);
      spawnLines(lineAmt, dt);
      updateLines(dt, rush);

      pool.fill(add, alp);
      add.commit();
      alp.commit();
      rush.commit();

      marks.update(ctx.time.elapsed);
      screen.update(dt);

      // ── shake ─────────────────────────────────────────────────────────
      // Orientation only, applied after the camera system has posed the rig.
      // The camera rebuilds its quaternion from scratch every frame, so nothing
      // here can feed back into it; its *position* is damped in world space and
      // is deliberately left alone.
      if (trauma > 0) {
        trauma = Math.max(0, trauma - traumaDecay * dt);
        const sh = trauma * trauma;
        if (sh > 1e-4) {
          const n = ctx.time.elapsed * 17;
          _shakeE.set(
            fbm1(n) * sh * 0.055,
            fbm1(n + 23.7) * sh * 0.055,
            fbm1(n + 51.1) * sh * 0.07,
          );
          _shakeQ.setFromEuler(_shakeE);
          cam.quaternion.multiply(_shakeQ);
        }
      }
    },

    dispose(): void {
      if (addLayer) { ctx.scene.remove(addLayer.mesh); addLayer.dispose(); addLayer = null; }
      if (alphaLayer) { ctx.scene.remove(alphaLayer.mesh); alphaLayer.dispose(); alphaLayer = null; }
      if (rushLayer) { ctx.scene.remove(rushLayer.mesh); rushLayer.dispose(); rushLayer = null; }
      ctx.scene.remove(marks.mesh);
      marks.dispose();
      screen.dispose();
      atlas?.dispose();
      atlas = null;
      if (ctx.fx === api) ctx.fx = null;
    },
  };
}
