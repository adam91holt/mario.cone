// Kart physics — the single most important system for how the game feels.
//
// This is an arcade model, not a simulation. The kart has a heading, a scalar
// speed along that heading, and a small amount of lateral slip that grip eats
// away. Drift deliberately breaks that model: it decouples the chassis yaw from
// the travel direction and pays out a boost for holding it, which is the whole
// risk/reward loop of a Mario Kart-style racer.
//
// Everything here runs in fixedUpdate at a constant dt. No wall clock, no
// Math.random — the automated critics replay runs and diff them.

import * as THREE from 'three';
import { clamp01, damp, lerp, sign } from '../core/math.ts';
import type {
  GameContext, GameSystem, Racer, Surface, SplineSample, BoostSource, VehicleStats,
} from '../types.ts';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _v = new THREE.Vector3();
const _lat = new THREE.Vector3();
const _groundPoint = new THREE.Vector3();
const _groundNormal = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _sample: SplineSample = {
  pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
  right: new THREE.Vector3(), up: new THREE.Vector3(),
  width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
};

const RIDE_HEIGHT = 0.55;

/** Friction and top-speed multipliers per surface. */
const SURFACE: Record<Surface, { drag: number; maxMul: number; grip: number }> = {
  road:  { drag: 0,    maxMul: 1.00, grip: 1.00 },
  boost: { drag: 0,    maxMul: 1.00, grip: 1.00 },
  dirt:  { drag: 14,   maxMul: 0.72, grip: 0.72 },
  sand:  { drag: 22,   maxMul: 0.60, grip: 0.60 },
  grass: { drag: 26,   maxMul: 0.55, grip: 0.65 },
  rail:  { drag: 0,    maxMul: 1.00, grip: 1.30 },
  water: { drag: 34,   maxMul: 0.45, grip: 0.50 },
  air:   { drag: 0.35, maxMul: 1.00, grip: 0.00 },
};

export function createRacer(
  id: number, name: string, vehicleId: Racer['vehicleId'],
  stats: VehicleStats, isPlayer: boolean,
): Racer {
  return {
    id, name, vehicleId, isPlayer,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    prevPos: new THREE.Vector3(),
    prevQuat: new THREE.Quaternion(),
    visual: null,
    model: null,
    speed: 0,
    maxSpeed: 0,
    steerAngle: 0,
    yaw: 0,
    drift: { active: false, dir: 0, charge: 0, tier: 0, angle: 0, hopTime: 0 },
    boost: { time: 0, power: 0, source: null },
    grounded: true,
    airTime: 0,
    surface: 'road',
    lap: 0,
    checkpoint: 0,
    place: 1,
    progress: 0,
    finished: false,
    finishTime: 0,
    lapTimes: [],
    coins: 0,
    item: null,
    itemCount: 0,
    stunned: 0,
    invulnerable: 0,
    effects: new Set<string>(),
    stats,
    ai: null,
  };
}

export function createKartPhysics(ctx: GameContext): GameSystem {
  const K = ctx.config.kart;

  /**
   * Where the ground is beneath a racer, and which way it faces.
   * The road, the verge and the open ground each have their own answer.
   */
  function sampleGround(racer: Racer): Surface {
    const track = ctx.track;
    if (!track) {
      _groundPoint.set(racer.pos.x, 0, racer.pos.z);
      _groundNormal.set(0, 1, 0);
      return 'road';
    }
    const s = track.sample(racer.pos, _sample);
    const lateral = s.lateral ?? 0;
    const half = s.width * 0.5;
    const vergeW = track.course.vergeWidth ?? 5;
    const a = Math.abs(lateral);

    if (a <= half) {
      const f = clamp01((lateral / s.width) + 0.5);
      const crown = Math.cos((f - 0.5) * Math.PI) * 0.16;
      _groundPoint.copy(s.pos).addScaledVector(s.right, lateral).addScaledVector(s.up, crown);
      _groundNormal.copy(s.up);
      return 'road';
    }
    if (a <= half + vergeW) {
      const t = (a - half) / vergeW;
      _groundPoint.copy(s.pos).addScaledVector(s.right, lateral).addScaledVector(s.up, t * -0.35);
      _groundNormal.copy(s.up);
      return (track.course.vergeSurface ?? 'dirt') as Surface;
    }
    _groundPoint.set(racer.pos.x, track.course.groundY ?? -0.6, racer.pos.z);
    _groundNormal.set(0, 1, 0);
    return (track.course.offSurface ?? 'grass') as Surface;
  }

  /** Effective top speed, folding in stats, coins, class and surface. */
  function topSpeed(racer: Racer, surf: Surface): number {
    const cls = ctx.config.race.classes[ctx.race.engineClass];
    const statMul = lerp(0.86, 1.14, racer.stats.speed);
    const coinMul = 1 + Math.min(racer.coins, K.coins.max) * K.coins.speedPerCoin;
    const band = racer.rubberBand ?? 1;
    return K.maxSpeed * statMul * coinMul * cls.speedMul * SURFACE[surf].maxMul * band;
  }

  function applyBoost(racer: Racer, source: BoostSource, time: number, power: number): void {
    // A new boost never shortens an active one — stacking should feel generous.
    if (time >= racer.boost.time) {
      racer.boost.time = time;
      racer.boost.source = source;
    }
    racer.boost.power = Math.max(racer.boost.power, power);
    ctx.bus.emit('kart:boost', { racer, source, power });
  }

  function releaseDrift(racer: Racer): void {
    const d = racer.drift;
    if (d.tier > 0) {
      const tier = K.drift.tiers[d.tier - 1]!;
      applyBoost(racer, `drift${d.tier}` as BoostSource, tier.boost, tier.power);
    }
    d.active = false;
    d.dir = 0;
    d.charge = 0;
    d.tier = 0;
  }

  function stepRacer(racer: Racer, dt: number): void {
    racer.prevPos.copy(racer.pos);
    racer.prevQuat.copy(racer.quat);

    // A CPU driver, when present, authors this racer's input — including for the
    // player's kart under autopilot. Only a driverless racer reads the human.
    const input = racer.ai ? (racer.aiInput ?? ctx.inputState) : ctx.inputState;

    const racing = ctx.race.phase === 'racing';
    const frozen = !racing || racer.finished;

    let accelIn = frozen ? 0 : input.accel;
    let brakeIn = frozen ? 0 : input.brake;
    let steerIn = frozen ? 0 : input.steer;
    const driftHeld = !frozen && input.drift;

    // Being hit takes control away and spins the chassis.
    if (racer.stunned > 0) {
      racer.stunned = Math.max(0, racer.stunned - dt);
      accelIn = 0;
      brakeIn = 0;
      steerIn = 0;
      if (racer.drift.active) releaseDrift(racer);
      // Clearing here rather than on a timer keeps the sim deterministic.
      if (racer.stunned === 0) {
        racer.effects.delete('spin');
        racer.effects.delete('squish');
        racer.effects.delete('bump');
      }
    }
    if (racer.invulnerable > 0) racer.invulnerable = Math.max(0, racer.invulnerable - dt);

    // ── ground ────────────────────────────────────────────────────────────
    const surf = sampleGround(racer);
    _v.subVectors(racer.pos, _groundPoint);
    const height = _v.dot(_groundNormal);

    const wasGrounded = racer.grounded;
    racer.grounded = height <= RIDE_HEIGHT + 0.02;

    if (racer.grounded) {
      racer.surface = surf;
      if (!wasGrounded) {
        const impact = clamp01(racer.airTime / 1.2);
        ctx.bus.emit('kart:land', { racer, impact });
        // Landing scrubs a little speed, more the longer the flight.
        racer.speed *= 1 - impact * 0.06;
      }
      racer.airTime = 0;
      // Correct ride height *along the surface normal only*. Rebuilding the
      // position from the spline projection would also discard the kart's
      // along-track residual, which at speed cancels forward motion outright.
      racer.pos.addScaledVector(_groundNormal, RIDE_HEIGHT - height);
      const into = racer.vel.dot(_groundNormal);
      if (into < 0) racer.vel.addScaledVector(_groundNormal, -into);
    } else {
      racer.surface = 'air';
      racer.airTime += dt;
      racer.vel.y -= K.air.gravity * dt;
      if (racer.vel.y < -K.air.terminal) racer.vel.y = -K.air.terminal;
    }

    const sp = SURFACE[racer.surface];

    // ── steering ──────────────────────────────────────────────────────────
    racer.steerAngle = damp(racer.steerAngle, steerIn, K.steerSmoothing, dt);

    const speedFrac = clamp01(Math.abs(racer.speed) / Math.max(1, K.maxSpeed));
    const handling = lerp(0.85, 1.18, racer.stats.handling);
    let turnRate = K.steerRate * handling * (1 - speedFrac * K.steerSpeedFalloff);
    if (!racer.grounded) turnRate *= K.air.control / K.steerRate;

    // ── drift ─────────────────────────────────────────────────────────────
    const d = racer.drift;

    if (d.hopTime > 0) {
      d.hopTime = Math.max(0, d.hopTime - dt);
    }

    if (!frozen && racer.stunned <= 0) {
      const fastEnough = racer.speed > K.drift.minSpeed;
      if (driftHeld && !d.active && racer.grounded && fastEnough) {
        if (Math.abs(steerIn) > 0.15) {
          // Committed: hop, then lock the drift to the steering direction.
          d.active = true;
          d.dir = steerIn > 0 ? 1 : -1;
          d.charge = 0;
          d.tier = 0;
          d.hopTime = K.drift.hopTime;
          racer.vel.addScaledVector(_groundNormal, K.drift.hopHeight * 3.2);
          racer.grounded = false;
          ctx.bus.emit('kart:drift:start', { racer, dir: d.dir });
        } else if (d.hopTime <= 0 && racer.grounded) {
          // Hop with no steering input — the standard MK "bunny hop".
          d.hopTime = K.drift.hopTime;
          racer.vel.addScaledVector(_groundNormal, K.drift.hopHeight * 2.6);
          racer.grounded = false;
        }
      }

      if (d.active) {
        if (!driftHeld || racer.speed < K.drift.minSpeed * 0.6) {
          releaseDrift(racer);
        } else {
          // Steering into the drift tightens it; steering out opens it up but
          // never flips it — you have to release to change direction.
          const into = steerIn * d.dir;
          const targetAngle = lerp(K.drift.enterAngle, K.drift.maxAngle, clamp01(into * 0.5 + 0.5));
          d.angle = damp(d.angle, targetAngle, 0.0001, dt);

          turnRate *= K.drift.yawBonus;
          // The chassis carries a constant baseline turn in the drift direction.
          steerIn = d.dir * lerp(0.55, 1.0, clamp01(into * 0.5 + 0.5));

          const chargeRate = K.drift.chargeRate * lerp(0.75, 1.25, racer.stats.handling)
            * clamp01(racer.speed / (K.maxSpeed * 0.55));
          d.charge += chargeRate * dt;

          const tiers = K.drift.tiers;
          let tier: 0 | 1 | 2 | 3 = 0;
          for (let i = 0; i < tiers.length; i++) if (d.charge >= tiers[i]!.at) tier = (i + 1) as 1 | 2 | 3;
          if (tier !== d.tier) {
            d.tier = tier;
            ctx.bus.emit('kart:drift:charge', { racer, tier });
          }
        }
      }
    } else if (d.active) {
      releaseDrift(racer);
    }

    if (!d.active) d.angle = damp(d.angle, 0, 0.0001, dt);

    // Spin-out overrides steering entirely.
    if (racer.stunned > 0 && racer.effects.has('spin')) {
      racer.yaw += 12 * dt;
    } else {
      racer.yaw += steerIn * turnRate * dt * (racer.speed < 0 ? -1 : 1);
    }

    _fwd.set(Math.sin(racer.yaw), 0, Math.cos(racer.yaw));
    // Project the heading onto the ground plane so banked corners hold the kart.
    _fwd.addScaledVector(_groundNormal, -_fwd.dot(_groundNormal)).normalize();
    _right.crossVectors(_fwd, _groundNormal).normalize().negate();

    // ── longitudinal ──────────────────────────────────────────────────────
    const boosting = racer.boost.time > 0;
    if (boosting) racer.boost.time = Math.max(0, racer.boost.time - dt);
    else { racer.boost.power = 0; racer.boost.source = null; }

    const baseMax = topSpeed(racer, racer.surface);
    racer.maxSpeed = boosting ? Math.max(baseMax, racer.boost.power + baseMax * 0.15) : baseMax;

    const accelStat = lerp(0.82, 1.2, racer.stats.accel);
    const coinAccel = 1 + Math.min(racer.coins, K.coins.max) * K.coins.accelPerCoin;

    if (racer.grounded) {
      if (boosting) {
        // Boost is an authority, not an impulse: it drags speed up to its target.
        const target = racer.maxSpeed;
        racer.speed = damp(racer.speed, target, 0.02, dt);
      } else if (accelIn > 0) {
        const frac = clamp01(racer.speed / Math.max(1, racer.maxSpeed));
        const curve = Math.pow(1 - frac, K.accelCurve);
        racer.speed += K.accel * accelStat * coinAccel * curve * accelIn * dt;
      }

      if (brakeIn > 0) {
        racer.speed -= K.brakeForce * brakeIn * dt;
        const revMax = -K.reverseSpeed;
        if (racer.speed < revMax) racer.speed = revMax;
      }

      if (accelIn <= 0 && brakeIn <= 0) {
        racer.speed = damp(racer.speed, 0, Math.pow(0.5, K.coastDrag), dt);
      }

      // Off-road bleeds speed hard, and caps it lower.
      if (sp.drag > 0) {
        racer.speed -= sp.drag * dt * clamp01(Math.abs(racer.speed) / 20);
        if (racer.speed > racer.maxSpeed) {
          racer.speed = damp(racer.speed, racer.maxSpeed, 0.0001, dt);
        }
      }
      if (racer.speed > racer.maxSpeed && !boosting) {
        racer.speed = damp(racer.speed, racer.maxSpeed, 0.02, dt);
      }
      if (racer.speed < 0 && racer.speed < -K.reverseSpeed) racer.speed = -K.reverseSpeed;
    }

    // ── velocity integration ──────────────────────────────────────────────
    if (racer.grounded) {
      // Split velocity into "along the heading" and "sideways", then eat the
      // sideways part. How fast it is eaten *is* the handling model.
      _v.copy(racer.vel);
      const vertical = _v.dot(_groundNormal);
      _v.addScaledVector(_groundNormal, -vertical);

      _lat.copy(_v).addScaledVector(_fwd, -_v.dot(_fwd));
      const gripBase = d.active ? K.driftGrip : K.grip;
      const grip = gripBase * sp.grip * lerp(0.85, 1.15, racer.stats.traction);
      const latSpeed = _lat.length();
      if (latSpeed > 0.0001) {
        const reduce = Math.min(latSpeed, grip * dt);
        _lat.multiplyScalar((latSpeed - reduce) / latSpeed);
      }

      racer.vel.copy(_fwd).multiplyScalar(racer.speed).add(_lat).addScaledVector(_groundNormal, vertical);
    } else {
      // Airborne: keep momentum, let the nose swing a little.
      const horiz = _v.copy(racer.vel);
      horiz.y = 0;
      racer.speed = horiz.length() * sign(horiz.dot(_fwd) >= 0 ? 1 : -1);
      const drift = SURFACE.air.drag * dt;
      racer.vel.x = damp(racer.vel.x, _fwd.x * racer.speed, Math.pow(0.5, drift), dt);
      racer.vel.z = damp(racer.vel.z, _fwd.z * racer.speed, Math.pow(0.5, drift), dt);
    }

    racer.pos.addScaledVector(racer.vel, dt);

    // ── barriers ──────────────────────────────────────────────────────────
    if (ctx.track && ctx.track.course.walls !== false) {
      const s = ctx.track.spline.nearest(racer.pos, _sample);
      const limit = s.width * 0.5 + (ctx.track.course.vergeWidth ?? 5) - 0.8;
      const lateral = s.lateral ?? 0;
      if (Math.abs(lateral) > limit) {
        const over = Math.abs(lateral) - limit;
        racer.pos.addScaledVector(s.right, -sign(lateral) * over);
        // Scrub speed by how square the hit was — a graze should barely cost.
        const intoWall = racer.vel.dot(s.right) * sign(lateral);
        if (intoWall > 0) {
          racer.vel.addScaledVector(s.right, -sign(lateral) * intoWall * 1.35);
          const squareness = clamp01(intoWall / Math.max(4, Math.abs(racer.speed)));
          racer.speed *= 1 - 0.55 * squareness;
          if (squareness > 0.25) {
            ctx.bus.emit('kart:wall', { racer, force: squareness });
            if (racer.drift.active) releaseDrift(racer);
          }
        }
      }
    }

    // ── orientation ───────────────────────────────────────────────────────
    // Chassis yaw includes the drift offset, so the kart visibly points into the
    // slide while still travelling along its heading.
    const visualYaw = racer.yaw - d.angle * d.dir;
    _fwd.set(Math.sin(visualYaw), 0, Math.cos(visualYaw));
    _fwd.addScaledVector(_groundNormal, -_fwd.dot(_groundNormal)).normalize();
    if (racer.grounded) _up.copy(_groundNormal);
    else _up.set(0, 1, 0);
    _right.crossVectors(_up, _fwd).normalize();
    _m.makeBasis(_right, _up, _fwd);
    _q.setFromRotationMatrix(_m);
    // Ease into the target orientation so kerbs and crests do not snap the kart.
    racer.quat.slerp(_q, 1 - Math.pow(0.0001, dt));

    if (racer.surface === 'dirt' || racer.surface === 'grass') {
      ctx.bus.emit('kart:offroad', { racer, surface: racer.surface });
    }
  }

  /** Racer-vs-racer bumping. O(n^2) is fine for 12 karts. */
  function resolveContacts(): void {
    const rs = ctx.racers;
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i]!, b = rs[j]!;
        _v.subVectors(b.pos, a.pos);
        const dist = _v.length();
        const minDist = 2.4;
        if (dist > minDist || dist < 1e-5) continue;
        _v.divideScalar(dist);
        const push = (minDist - dist) * 0.5;
        a.pos.addScaledVector(_v, -push);
        b.pos.addScaledVector(_v, push);
        // Heavier karts shove lighter ones around.
        const wa = lerp(0.7, 1.3, a.stats.weight);
        const wb = lerp(0.7, 1.3, b.stats.weight);
        const total = wa + wb;
        const impulse = 6;
        a.vel.addScaledVector(_v, -impulse * (wb / total));
        b.vel.addScaledVector(_v, impulse * (wa / total));
        ctx.bus.emit('kart:bump', { a, b, force: push });
      }
    }
  }

  return {
    name: 'physics',
    order: 30,

    fixedUpdate(dt: number): void {
      for (const racer of ctx.racers) stepRacer(racer, dt);
      resolveContacts();
    },
  };
}

/** Applied by the item system and the race director; kept here so the rules live
 *  next to the model they perturb. */
export function boostRacer(
  ctx: GameContext, racer: Racer, source: BoostSource, time: number, power: number,
): void {
  if (time >= racer.boost.time) {
    racer.boost.time = time;
    racer.boost.source = source;
  }
  racer.boost.power = Math.max(racer.boost.power, power);
  ctx.bus.emit('kart:boost', { racer, source, power });
}

export function stunRacer(
  ctx: GameContext, racer: Racer, kind: 'spin' | 'squish' | 'bump', by: Racer | null = null,
): void {
  if (racer.invulnerable > 0 || racer.effects.has('star')) return;
  const K = ctx.config.kart.hitStun;
  const time = kind === 'spin' ? K.spin : kind === 'squish' ? K.squish : K.bump;
  racer.stunned = Math.max(racer.stunned, time);
  racer.effects.add(kind);
  racer.invulnerable = time + 0.4;
  racer.speed *= kind === 'bump' ? 0.6 : 0.15;
  racer.boost.time = 0;
  ctx.bus.emit('kart:hit', { racer, by, kind });
  // The effect flag is cleared inside the physics step when `stunned` hits zero,
  // so nothing here depends on a timer.
}
