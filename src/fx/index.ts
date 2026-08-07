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
const POOL = 2600;
const LAYER_ADD = 1900;
const LAYER_ALPHA = 1250;
const LAYER_RUSH = 240;
const MARK_QUADS = 1400;

/** How a surface answers to a tyre. `rate` is puffs per second at top speed;
 *  `slip` is the extra that only happens when the tyres are actually sliding,
 *  which is why tarmac throws almost nothing until you commit to a drift. */
interface SurfaceFx {
  color: number;
  rate: number;
  slip: number;
  size: number;
  grow: number;
  alpha: number;
  /** Metal on metal: sparks rather than dust. */
  sparky: boolean;
  /** Multiplier on tyre-mark darkness, and the mark's own tint. */
  mark: number;
  markTint: number;
}

const SURFACE_FX: Record<Surface, SurfaceFx> = {
  road:  { color: 0x9aa2ae, rate: 0,  slip: 44, size: 0.55, grow: 3.4, alpha: 0.26, sparky: false, mark: 1.00, markTint: 0x4b4a52 },
  boost: { color: 0xc8b49a, rate: 0,  slip: 38, size: 0.58, grow: 3.4, alpha: 0.28, sparky: false, mark: 0.80, markTint: 0x4b4a52 },
  dirt:  { color: 0xC08B4E, rate: 30, slip: 34, size: 0.80, grow: 3.6, alpha: 0.52, sparky: false, mark: 0.75, markTint: 0x9a7448 },
  sand:  { color: 0xE3C88E, rate: 34, slip: 36, size: 0.85, grow: 3.8, alpha: 0.56, sparky: false, mark: 0.65, markTint: 0xa98f5e },
  grass: { color: 0x7FB44E, rate: 24, slip: 28, size: 0.70, grow: 3.0, alpha: 0.44, sparky: false, mark: 0.55, markTint: 0x6d8a4c },
  water: { color: 0xDCF0FA, rate: 46, slip: 42, size: 0.62, grow: 2.8, alpha: 0.50, sparky: false, mark: 0.00, markTint: 0xffffff },
  rail:  { color: 0xCFE2FF, rate: 0,  slip: 22, size: 0.22, grow: 1.4, alpha: 0.90, sparky: true,  mark: 0.00, markTint: 0xffffff },
  air:   { color: 0xffffff, rate: 0,  slip: 0,  size: 0.40, grow: 2.0, alpha: 0.00, sparky: false, mark: 0.00, markTint: 0xffffff },
};

/** Confetti. High-vis roadworks, not a birthday party. */
const CONFETTI = [0xFF6B1A, 0xFFC300, 0xFFF8F0, 0x5FC8F5, 0x6FCF4A, 0xE33B2E, 0xE040FB];

/** Per-racer bookkeeping. Nothing here is simulation state — it is all either a
 *  fractional emission accumulator or an impulse waiting to be spent. */
interface RacerFx {
  spark: number;
  dust: number;
  flame: number;
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
  bumpX: number; bumpY: number; bumpZ: number;

  /** Seconds left of barrier-scrape sparks, and which flank they come from. */
  grind: number;
  grindSide: number;
  /** Recomputed each frame: how much this racer's effects are worth drawing. */
  near: number;
}

function newRacerFx(): RacerFx {
  return {
    spark: 0, dust: 0, flame: 0, glow: 0, pop: 0, popTier: 0,
    pendDriftStart: 0, pendTier: 0, pendBoost: 0, boostTier: 0,
    pendLand: 0, pendHop: 0, pendOffroad: 0, pendWall: 0, pendHit: 0,
    pendTrick: 0, pendBump: 0, bumpX: 0, bumpY: 0, bumpZ: 0,
    grind: 0, grindSide: 1, near: 1,
  };
}

// ── scratch. Nothing in this file may allocate per frame ────────────────────
const _pos = new THREE.Vector3();
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
  const TIER = [
    new THREE.Color(0xFFF2D8),
    new THREE.Color(K.drift.tiers[0]!.color),
    new THREE.Color(K.drift.tiers[1]!.color),
    new THREE.Color(K.drift.tiers[2]!.color),
  ];
  const TIER_HEX = [
    0xFFF2D8, K.drift.tiers[0]!.color, K.drift.tiers[1]!.color, K.drift.tiers[2]!.color,
  ];
  /** Sparks per second, summed over both rear wheels, per tier. */
  const TIER_RATE = [64, 140, 185, 230];

  const FLAME_HOT = new THREE.Color(0xFFF0C0);
  const FLAME_MID = new THREE.Color(0xFF7A18);
  const FLAME_END = new THREE.Color(0x8C2A06);
  const SMOKE = new THREE.Color(0x6B6258);
  const WARM_WHITE = new THREE.Color(0xFFE7C0);
  const GOLD = new THREE.Color(0xFFD24D);
  const RAIL_SPARK = new THREE.Color(0xFFE9C0);
  const surfaceColors = new Map<Surface, THREE.Color>();
  for (const key of Object.keys(SURFACE_FX) as Surface[]) {
    surfaceColors.set(key, new THREE.Color(SURFACE_FX[key].color));
  }
  const markTints = new Map<Surface, THREE.Color>();
  for (const key of Object.keys(SURFACE_FX) as Surface[]) {
    markTints.set(key, new THREE.Color(SURFACE_FX[key].markTint));
  }
  const confettiColors = CONFETTI.map((h) => new THREE.Color(h));

  // ── specs. One preset per effect, mutated in place and never replaced ──────
  const sparkSpec = makeSpec({
    cell: CELL.spark, mode: MODE.velocity, additive: true,
    life: 0.34, size0: 0.20, size1: 0.03, alpha: 1,
    gravity: 15, drag: 2.0, stretch: 0.012, fadeIn: 0,
  });
  const emberSpec = makeSpec({
    cell: CELL.glow, mode: MODE.billboard, additive: true,
    life: 0.22, size0: 0.34, size1: 0.05, alpha: 0.85,
    gravity: 6, drag: 3.0, fadeIn: 0,
  });
  const dustSpec = makeSpec({
    cell: CELL.puff, mode: MODE.billboard, additive: false,
    life: 0.8, size0: 0.6, size1: 2.2, alpha: 0.5,
    gravity: -0.9, drag: 2.6, fadeIn: 0.22,
  });
  const flameSpec = makeSpec({
    cell: CELL.glow, mode: MODE.billboard, additive: true,
    life: 0.28, size0: 0.5, size1: 1.25, alpha: 0.95,
    gravity: -3, drag: 4.5, fadeIn: 0.07,
  });
  const smokeSpec = makeSpec({
    cell: CELL.puff, mode: MODE.billboard, additive: false,
    life: 0.85, size0: 0.55, size1: 2.6, alpha: 0.24,
    gravity: -1.4, drag: 2.2, fadeIn: 0.2,
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

  /** Contact patch of a rear wheel, `lift` metres clear of the road. */
  function rearWheel(racer: Racer, side: number, lift: number, out: THREE.Vector3): THREE.Vector3 {
    const s = sizeOf(racer);
    return local(side * s.halfW * 0.86, -RIDE_HEIGHT + lift, -s.len * 0.34, out);
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

  /** The hero effect. Requires `frameOf(racer)`. */
  function driftSparks(racer: Racer, fx: RacerFx, dt: number): void {
    const d = racer.drift;
    const tier = d.tier;
    const col = TIER[tier]!;

    // Rate rises with the tier and with how deep the chassis is thrown, so a
    // shallow counter-steered drift sizzles and a committed one roars.
    const depth = 0.55 + 0.45 * clamp01(Math.abs(d.angle) / K.drift.maxAngle);
    const rate = TIER_RATE[tier]! * depth * density * fx.near;
    fx.spark += rate * dt;
    let n = Math.floor(fx.spark);
    fx.spark -= n;
    if (n > 16) n = 16;

    const outward = -d.dir;
    const speed = Math.abs(racer.speed);
    const inv = n > 0 ? 1 / n : 0;

    for (let i = 0; i < n; i++) {
      // Biased to the outside wheel: that is the one being dragged.
      const side = rng.next() < 0.66 ? outward : -outward;
      rearWheel(racer, side, 0.10, _p);
      // Spread the frame's worth of sparks back along the path the kart took
      // during it. Without this every spark in a frame is born at the same
      // point, and at 55 m/s and 20fps that is a dotted line of clumps three
      // metres apart instead of a stream. The review harness renders at 20fps.
      const back = (i + 0.5) * inv * dt;
      sparkSpec.px = _p.x - racer.vel.x * back + rng.range(-0.10, 0.10);
      sparkSpec.py = _p.y - racer.vel.y * back + rng.range(-0.04, 0.10);
      sparkSpec.pz = _p.z - racer.vel.z * back + rng.range(-0.10, 0.10);

      const kick = rng.range(2.2, 6.5) * (0.6 + 0.4 * clamp01(speed / 45));
      sparkSpec.vx = racer.vel.x * 0.14 + _right.x * outward * kick - _fwd.x * rng.range(0.5, 4)
        + rng.range(-1.2, 1.2);
      sparkSpec.vy = rng.range(1.4, 4.8);
      sparkSpec.vz = racer.vel.z * 0.14 + _right.z * outward * kick - _fwd.z * rng.range(0.5, 4)
        + rng.range(-1.2, 1.2);

      sparkSpec.life = rng.range(0.26, 0.50);
      sparkSpec.size0 = rng.range(0.20, 0.36);
      setHdr(sparkSpec.color0, col, rng.range(2.8, 4.6));
      setHdr(sparkSpec.color1, col, 0.35);
      pool.emit(sparkSpec);

      // Every few sparks gets a soft companion, purely so the bloom pyramid has
      // something with area to find. Pinpoints alone do not glow.
      if (tier > 0 && rng.next() < 0.3) {
        emberSpec.px = sparkSpec.px; emberSpec.py = sparkSpec.py; emberSpec.pz = sparkSpec.pz;
        emberSpec.vx = sparkSpec.vx * 0.5;
        emberSpec.vy = sparkSpec.vy * 0.5;
        emberSpec.vz = sparkSpec.vz * 0.5;
        emberSpec.life = rng.range(0.16, 0.30);
        emberSpec.size0 = rng.range(0.34, 0.62);
        setHdr(emberSpec.color0, col, 2.2);
        setHdr(emberSpec.color1, col, 0.2);
        pool.emit(emberSpec);
      }
    }
  }

  /** The steady glow at the wheels while a drift is held, and the flare that
   *  marks a tier locking in. Immediate-mode: rebuilt every frame. */
  function driftGlow(racer: Racer, fx: RacerFx, add: SpriteLayer): void {
    const g = fx.glow;
    if (g < 0.02) return;
    const tier = racer.drift.active ? racer.drift.tier : fx.popTier;
    const col = TIER[tier]!;
    // A fast flicker, off simulation time so a capture reproduces it exactly.
    const flick = 0.82 + 0.18 * Math.sin(ctx.time.elapsed * 47 + racer.id);
    const k = 2.6 * g * flick * (0.6 + 0.4 * tier / 3);

    for (let s = -1; s <= 1; s += 2) {
      rearWheel(racer, s, 0.14, _p);
      // Hot core...
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        col.r * k, col.g * k, col.b * k, 0.95 * g,
        0.5 + 0.28 * g * flick, 0, 0, CELL.glow, MODE.billboard,
      );
      // ...inside a wide soft halo, which is what the bloom pyramid can find.
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        col.r * k * 0.42, col.g * k * 0.42, col.b * k * 0.42, 0.6 * g,
        1.25 + 0.5 * g * flick, 0, 0, CELL.glow, MODE.billboard,
      );
      // ...and a pool of its own light on the road under it. Contact, again:
      // sparks that do not light the surface they come off read as stickers.
      rearWheel(racer, s, 0.03, _p);
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        col.r * k * 0.5, col.g * k * 0.5, col.b * k * 0.5, 0.45 * g,
        1.8 + 0.6 * g, 0, 0, CELL.glow, MODE.ground,
      );
    }

    if (fx.pop > 0.01) {
      const c = TIER[fx.popTier]!;
      const p = fx.pop;
      const size = lerp(2.6, 0.6, 1 - p);
      local(0, -0.05, -sizeOf(racer).len * 0.4, _p);
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        c.r * 3.4 * p, c.g * 3.4 * p, c.b * 3.4 * p, p,
        size, 0, 0, CELL.flare, MODE.billboard,
      );
    }
  }

  /** Dust, spray or scrape off whatever the tyres are on. */
  function surfaceDust(racer: Racer, fx: RacerFx, dt: number): void {
    const sfx = SURFACE_FX[racer.surface];
    const slip = Math.max(slipOf(racer), racer.drift.active ? 0.45 : 0);
    const speedFrac = clamp01(Math.abs(racer.speed) / 48);
    const boosting = racer.boost.time > 0 ? 1 : 0;

    const rate = (sfx.rate * speedFrac
      + sfx.slip * slip * speedFrac
      + boosting * 14 * speedFrac) * density * fx.near;
    if (rate <= 0) return;

    fx.dust += rate * dt;
    let n = Math.floor(fx.dust);
    fx.dust -= n;
    if (n > 14) n = 14;
    if (n <= 0) return;

    const col = surfaceColors.get(racer.surface)!;
    const inv = 1 / n;

    for (let i = 0; i < n; i++) {
      const side = rng.next() < 0.5 ? -1 : 1;
      rearWheel(racer, side, 0.14, _p);
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

      dustSpec.px = _p.x + rng.range(-0.2, 0.2);
      dustSpec.py = _p.y;
      dustSpec.pz = _p.z + rng.range(-0.2, 0.2);
      dustSpec.vx = racer.vel.x * 0.10 - _fwd.x * rng.range(0.5, 3)
        + _right.x * side * rng.range(0.4, 2.6);
      dustSpec.vy = rng.range(0.8, 2.8);
      dustSpec.vz = racer.vel.z * 0.10 - _fwd.z * rng.range(0.5, 3)
        + _right.z * side * rng.range(0.4, 2.6);
      dustSpec.life = rng.range(0.55, 1.15);
      dustSpec.size0 = sfx.size * rng.range(0.8, 1.5);
      dustSpec.size1 = dustSpec.size0 * sfx.grow;
      dustSpec.rot = rng.next() * TAU;
      dustSpec.rotVel = rng.range(-1.3, 1.3);
      dustSpec.alpha = sfx.alpha * rng.range(0.7, 1.1);
      setHdr(dustSpec.color0, col, 1.05);
      setHdr(dustSpec.color1, col, 0.62);
      pool.emit(dustSpec);
    }
  }

  /** The plume. A boost has to be unmistakable with the sound off. */
  function boostFlame(racer: Racer, fx: RacerFx, dt: number, add: SpriteLayer): void {
    const power = clamp01(racer.boost.power / 46);
    const s = sizeOf(racer);
    const tint = fx.boostTier > 0 ? TIER[fx.boostTier]! : FLAME_HOT;

    const rate = (70 + 70 * power) * density * fx.near;
    fx.flame += rate * dt;
    let n = Math.floor(fx.flame);
    fx.flame -= n;
    if (n > 12) n = 12;

    const inv = n > 0 ? 1 / n : 0;
    for (let i = 0; i < n; i++) {
      const off = rng.range(-0.55, 0.55) * s.halfW;
      local(off, -0.16 + rng.range(0, 0.3), -s.len * (0.45 + rng.range(0, 0.12)), _p);
      _p.addScaledVector(racer.vel, -(i + 0.5) * inv * dt);
      flameSpec.px = _p.x; flameSpec.py = _p.y; flameSpec.pz = _p.z;
      const back = rng.range(5, 13) * (0.7 + 0.5 * power);
      flameSpec.vx = racer.vel.x * 0.32 - _fwd.x * back + rng.range(-1.6, 1.6);
      flameSpec.vy = rng.range(0.4, 2.2);
      flameSpec.vz = racer.vel.z * 0.32 - _fwd.z * back + rng.range(-1.6, 1.6);
      flameSpec.life = rng.range(0.18, 0.34);
      flameSpec.size0 = rng.range(0.34, 0.62) * (0.85 + 0.4 * power);
      flameSpec.size1 = flameSpec.size0 * rng.range(2.0, 3.2);
      setHdr(flameSpec.color0, tint, rng.range(3.0, 4.4));
      setHdr(flameSpec.color1, FLAME_END, 1.1);
      pool.emit(flameSpec);

      // A quarter of it turns over into smoke, so the plume has a tail and the
      // frame does not simply go bright behind the kart.
      if (rng.next() < 0.28) {
        smokeSpec.px = _p.x; smokeSpec.py = _p.y + 0.15; smokeSpec.pz = _p.z;
        smokeSpec.vx = flameSpec.vx * 0.35;
        smokeSpec.vy = rng.range(0.6, 2.0);
        smokeSpec.vz = flameSpec.vz * 0.35;
        smokeSpec.life = rng.range(0.6, 1.0);
        smokeSpec.size0 = rng.range(0.4, 0.7);
        smokeSpec.size1 = smokeSpec.size0 * 3.6;
        smokeSpec.rot = rng.next() * TAU;
        smokeSpec.rotVel = rng.range(-1, 1);
        setHdr(smokeSpec.color0, SMOKE, 1.0);
        setHdr(smokeSpec.color1, SMOKE, 0.5);
        pool.emit(smokeSpec);
      }
    }

    // The nozzle itself: a hot core that does not flicker out between particles.
    const flick = 0.85 + 0.15 * Math.sin(ctx.time.elapsed * 61 + racer.id * 2.3);
    local(0, -0.1, -s.len * 0.46, _p);
    const k = (3.4 + 2.0 * power) * flick;
    add.push(
      _p.x, _p.y, _p.z, 0, 0, 0,
      tint.r * k, tint.g * k, tint.b * k, 0.95,
      (0.75 + 0.5 * power) * flick, 0, 0, CELL.glow, MODE.billboard,
    );
    add.push(
      _p.x, _p.y, _p.z, 0, 0, 0,
      FLAME_MID.r * k * 0.5, FLAME_MID.g * k * 0.5, FLAME_MID.b * k * 0.5, 0.8,
      (1.6 + 1.0 * power) * flick, 0, 0, CELL.glow, MODE.billboard,
    );
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
    dustSpec.px = x; dustSpec.py = y; dustSpec.pz = z;
    dustSpec.vx = 0; dustSpec.vy = 0.9; dustSpec.vz = 0;
    dustSpec.life = 0.9;
    dustSpec.size0 = sfx.size * 1.2 * scale;
    dustSpec.size1 = dustSpec.size0 * sfx.grow;
    dustSpec.alpha = Math.max(sfx.alpha, 0.32);
    dustSpec.rotVel = 0.8;
    setHdr(dustSpec.color0, col, 1.05);
    setHdr(dustSpec.color1, col, 0.6);
    pool.burst(dustSpec, Math.round(n * density), speed, 0.22, rng);
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

  function spendBoost(racer: Racer, fx: RacerFx): void {
    const s = sizeOf(racer);
    const power = clamp01(fx.pendBoost / 46);
    const tint = fx.boostTier > 0 ? TIER[fx.boostTier]! : WARM_WHITE;

    local(0, -RIDE_HEIGHT + 0.06, -s.len * 0.35, _p);
    ring(_p.x, _p.y, _p.z, 1.4, 5.5 + 5 * power, 0.42, tint, 2.6, 0.95);
    ring(_p.x, _p.y, _p.z, 0.8, 3.0 + 3 * power, 0.26, WARM_WHITE, 3.2, 0.8);

    local(0, -0.1, -s.len * 0.45, _p);
    sparkBurst(_p.x, _p.y, _p.z, 24 + Math.round(16 * power), 11 + 8 * power, tint, 3.4);
    dustRing(_p.x, _p.y - 0.4, _p.z, 12, 6 + 5 * power, racer.surface, 1.1);

    if (racer.isPlayer) {
      screen.flash(0xFFD9A0, 0.16 + 0.14 * power);
    }
  }

  function spendLand(racer: Racer, fx: RacerFx): void {
    const impact = clamp01(fx.pendLand);
    if (impact < 0.03) return;
    local(0, -RIDE_HEIGHT + 0.05, 0, _p);

    ring(_p.x, _p.y, _p.z, 1.0, 3.0 + 6.5 * impact, 0.28 + 0.2 * impact,
      surfaceColors.get(racer.surface) ?? WARM_WHITE, 1.6 + 1.4 * impact, 0.55 * impact + 0.12);
    dustRing(_p.x, _p.y, _p.z, 6 + Math.round(18 * impact), 2.5 + 8 * impact, racer.surface,
      0.9 + 0.5 * impact);

    if (impact > 0.4 && (racer.surface === 'road' || racer.surface === 'rail' || racer.surface === 'boost')) {
      sparkBurst(_p.x, _p.y + 0.05, _p.z, Math.round(10 * impact), 6 * impact, RAIL_SPARK, 2.6);
    }
    if (racer.isPlayer && impact > 0.35) screen.flash(0xFFFFFF, 0.05 + 0.09 * impact);
  }

  function spendWall(racer: Racer, fx: RacerFx): void {
    const force = clamp01(fx.pendWall);
    const s = sizeOf(racer);
    local(fx.grindSide * s.halfW, -0.1, rng.range(-0.4, 0.4) * s.len, _p);
    sparkBurst(_p.x, _p.y, _p.z, 8 + Math.round(20 * force), 5 + 9 * force, RAIL_SPARK, 3.4);
    ring(_p.x, _p.y - 0.4, _p.z, 0.6, 2.4 + 3 * force, 0.24, WARM_WHITE, 1.4, 0.4 * force);
    if (racer.isPlayer) screen.flash(0xFFE0B0, 0.06 + 0.14 * force);
  }

  function spendHit(racer: Racer, fx: RacerFx): void {
    const k = clamp01(fx.pendHit);
    local(0, 0.1, 0, _p);
    ring(_p.x, _p.y - RIDE_HEIGHT + 0.06, _p.z, 1.0, 7.0, 0.4, WARM_WHITE, 2.4, 0.8 * k);
    sparkBurst(_p.x, _p.y, _p.z, 22, 10, GOLD, 3.0);

    starSpec.px = _p.x; starSpec.py = _p.y + 0.4; starSpec.pz = _p.z;
    starSpec.vx = 0; starSpec.vy = 2.5; starSpec.vz = 0;
    starSpec.life = 0.8;
    starSpec.size0 = 0.55;
    setHdr(starSpec.color0, GOLD, 3.0);
    setHdr(starSpec.color1, GOLD, 0.4);
    pool.burst(starSpec, Math.round(7 * density), 5, 0.6, rng);

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

  /** Stars orbiting a spun-out kart. Immediate mode — they are a state, not an
   *  event, and the state is `racer.stunned`. */
  function spinStars(racer: Racer, add: SpriteLayer): void {
    const s = sizeOf(racer);
    const t = ctx.time.elapsed;
    const fade = clamp01(racer.stunned * 2.2);
    for (let i = 0; i < 4; i++) {
      const a = t * 5.4 + (i * TAU) / 4;
      const r = 0.75 + s.halfW * 0.5;
      local(Math.cos(a) * r, s.height * 0.62, Math.sin(a) * r, _p);
      const pulse = 0.75 + 0.25 * Math.sin(t * 13 + i);
      const k = 3.0 * pulse * fade;
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        GOLD.r * k, GOLD.g * k, GOLD.b * k, fade,
        0.36 * pulse, 0, a * 0.8, CELL.star, MODE.billboard,
      );
    }
  }

  function confettiBurst(x: number, y: number, z: number, n: number): void {
    for (let i = 0; i < n; i++) {
      flakeSpec.px = x + rng.range(-9, 9);
      flakeSpec.py = y + rng.range(2.5, 9);
      flakeSpec.pz = z + rng.range(-9, 9);
      flakeSpec.vx = rng.range(-5, 5);
      flakeSpec.vy = rng.range(1, 8);
      flakeSpec.vz = rng.range(-5, 5);
      flakeSpec.life = rng.range(2.4, 4.4);
      flakeSpec.size0 = rng.range(0.17, 0.30);
      flakeSpec.size1 = flakeSpec.size0;
      flakeSpec.rot = rng.next() * TAU;
      flakeSpec.rotVel = rng.range(-11, 11);
      const c = confettiColors[rng.int(0, confettiColors.length - 1)]!;
      // Confetti catches the light: born a little hot, settling to its own hue.
      setHdr(flakeSpec.color0, c, 1.5);
      setHdr(flakeSpec.color1, c, 0.85);
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
    lineAcc += amount * 120 * density * dt;
    let n = Math.floor(lineAcc);
    lineAcc -= n;
    if (n > 10) n = 10;
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
      const u = rng.range(0.66, 1.20);
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
      lineData[o + 9] = rng.range(0.12, 0.26) * d * 0.08;
      lineData[o + 10] = d * tanH * rng.range(0.10, 0.32);
      lineData[o + 11] = rng.range(0.25, 0.55) * amount;
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
        WARM_WHITE.r * 2.2, WARM_WHITE.g * 2.2, WARM_WHITE.b * 2.2, a,
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

  ctx.bus.on<{ n: number }>('race:countdown', ({ n }) => {
    if (n > 0) pendCountdown = n;
    else pendGo = 1;
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

      pool.update(dt);
      add.reset();
      alp.reset();
      rush.reset();

      drainQueue();

      const cam = ctx.camera;
      const player = ctx.player;

      for (const racer of ctx.racers) {
        const fx = fxOf(racer);
        frameOf(racer, alpha);

        // How much this racer's effects are worth. The player always pays full
        // price; everyone else fades out with distance, which is what keeps a
        // pack of eight drifting through a hairpin inside budget.
        const d2 = _pos.distanceToSquared(cam.position);
        fx.near = racer.isPlayer ? 1
          : d2 > 26000 ? 0
          : d2 < 900 ? 1
          : clamp01(1 - (Math.sqrt(d2) - 30) / 130) * 0.9 + 0.1;

        // ── impulses ────────────────────────────────────────────────────
        if (fx.pendTier > 0) {
          const tier = fx.pendTier as 1 | 2 | 3;
          fx.pendTier = 0;
          fx.pop = 1;
          fx.popTier = tier;
          const col = TIER[tier]!;
          const s = sizeOf(racer);
          local(0, -0.1, -s.len * 0.34, _p);
          sparkBurst(_p.x, _p.y, _p.z, 14 + 6 * tier, 7 + 2.5 * tier, col, 3.6);
          local(0, -RIDE_HEIGHT + 0.05, -s.len * 0.34, _p);
          ring(_p.x, _p.y, _p.z, 0.8, 3.4 + 0.8 * tier, 0.34, col, 2.6, 0.85);
          if (racer.isPlayer) screen.flash(TIER_HEX[tier]!, 0.07 + 0.035 * tier);
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
        if (fx.pendBoost > 0) { spendBoost(racer, fx); fx.pendBoost = 0; }
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

        // ── continuous ──────────────────────────────────────────────────
        fx.glow = damp(fx.glow, racer.drift.active && racer.grounded ? 1 : 0,
          racer.drift.active ? 0.0004 : 0.0000004, dt);
        fx.pop = Math.max(0, fx.pop - dt * 3.6);

        if (fx.near > 0.02) {
          if (racer.drift.active && racer.grounded) driftSparks(racer, fx, dt);
          driftGlow(racer, fx, add);
          if (racer.grounded) surfaceDust(racer, fx, dt);
          if (racer.boost.time > 0) boostFlame(racer, fx, dt, add);
          else fx.boostTier = 0;
          if (racer.stunned > 0 && racer.effects.has('spin')) spinStars(racer, add);
        }

        if (racer.isPlayer) playerGrind(racer, fx, dt);
        if (fx.grind > 0) {
          fx.grind = Math.max(0, fx.grind - dt);
          const s = sizeOf(racer);
          const n = Math.min(3, Math.round(60 * density * dt) + 1);
          for (let i = 0; i < n; i++) {
            local(fx.grindSide * s.halfW, rng.range(-0.35, 0.05), rng.range(-0.4, 0.3) * s.len, _p);
            sparkSpec.px = _p.x; sparkSpec.py = _p.y; sparkSpec.pz = _p.z;
            sparkSpec.vx = racer.vel.x * 0.2 + _right.x * fx.grindSide * rng.range(1, 4);
            sparkSpec.vy = rng.range(0.5, 3);
            sparkSpec.vz = racer.vel.z * 0.2 + _right.z * fx.grindSide * rng.range(1, 4);
            sparkSpec.life = rng.range(0.16, 0.34);
            sparkSpec.size0 = rng.range(0.11, 0.2);
            setHdr(sparkSpec.color0, RAIL_SPARK, 3.4);
            setHdr(sparkSpec.color1, RAIL_SPARK, 0.3);
            pool.emit(sparkSpec);
          }
        }

        // ── tyre marks ──────────────────────────────────────────────────
        const sfx = SURFACE_FX[racer.surface];
        const markable = racer.grounded && sfx.mark > 0 && d2 < 18000;
        if (markable) {
          const slip = slipOf(racer);
          const strength = clamp01(
            (racer.drift.active ? 0.85 : 0)
            + slip * 2.4
            + (racer.boost.time > 0 ? 0.35 : 0)
            + (racer.stunned > 0 ? 0.5 : 0),
          ) * sfx.mark * clamp01(Math.abs(racer.speed) / 16);
          if (strength > 0.05) {
            const tint = markTints.get(racer.surface)!;
            const s = sizeOf(racer);
            for (let side = -1; side <= 1; side += 2) {
              rearWheel(racer, side, 0.032, _p);
              marks.stroke(
                racer.id * 2 + (side > 0 ? 1 : 0),
                _p.x, _p.y, _p.z,
                _right.x, _right.y, _right.z,
                clamp(s.halfW * 0.34, 0.20, 0.42),
                strength * 0.9, tint,
              );
            }
          } else {
            marks.lift(racer.id * 2);
            marks.lift(racer.id * 2 + 1);
          }
        } else {
          marks.lift(racer.id * 2);
          marks.lift(racer.id * 2 + 1);
        }
      }

      // ── global beats ──────────────────────────────────────────────────
      if (pendCountdown > 0) {
        screen.flash(0xFFF0C8, 0.10);
        pendCountdown = 0;
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
          confettiBurst(_pos.x, _pos.y, _pos.z, Math.round(170 * density * strength));
          local(0, 0.4, 0, _p);
          sparkBurst(_p.x, _p.y, _p.z, Math.round(30 * strength), 12, GOLD, 3.6);
          ring(_pos.x, _pos.y - RIDE_HEIGHT + 0.05, _pos.z, 1.5, 14, 0.6, GOLD, 2.4, 0.9);
          screen.flash(0xFFF3D0, 0.32 * strength);
        }
      }

      // ── the lens ──────────────────────────────────────────────────────
      let rushAmt = 0;
      let chargeAmt = 0;
      if (player) {
        const cls = ctx.config.race.classes[ctx.race.engineClass];
        const refSpeed = Math.max(1, K.maxSpeed * cls.speedMul);
        const speedFrac = clamp01(Math.abs(player.speed) / refSpeed);
        const boostFrac = player.boost.time > 0
          ? 0.55 + 0.45 * clamp01((player.boost.power - 20) / 30)
          : 0;
        rushAmt = clamp01(boostFrac * clamp01(player.boost.time / 0.16)
          + clamp01((speedFrac - 0.78) / 0.22) * 0.35);
        // Deliberately restrained. The sparks are the meter; this is the frame
        // agreeing with them out of the corner of the player's eye, and a tint
        // strong enough to reach the middle of the sky would be reading the
        // charge to them in block capitals.
        chargeAmt = player.drift.active ? 0.34 + 0.22 * player.drift.tier : 0;
        screen.setChargeTier(player.drift.tier);
      }
      screen.setRush(rushAmt);
      screen.setCharge(chargeAmt);
      spawnLines(rushAmt, dt);
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
