// Kart physics — the single most important system for how the game feels.
//
// This is an arcade model, not a simulation. The kart has a heading, a scalar
// speed along that heading, and a small amount of lateral slip that grip eats
// away. Drift deliberately breaks that model: it decouples the chassis yaw from
// the travel direction and pays out a boost for holding it, which is the whole
// risk/reward loop of a Mario Kart-style racer.
//
// The shape everything is tuned toward:
//   - a hard shove off the line, then a long grinding approach to top speed, so
//     the kart always feels like it is straining for the last few m/s;
//   - hop -> latch -> commit -> charge -> release, with the release *felt* as an
//     instant shove and not just a larger number;
//   - steering authority that falls away with speed and comes back in a drift;
//   - every state change punctuated — landings scrub, walls bite in proportion
//     to how square the hit was, leaving tarmac bites immediately.
//
// Everything here runs in fixedUpdate at a constant dt. No wall clock, no
// Math.random — the automated critics replay runs and diff them.

import * as THREE from 'three';
import {
  angleDelta, clamp, clamp01, damp, lerp, moveToward, sign, smoothstep, spring,
} from '../core/math.ts';
import { getVehicle } from '../vehicles/registry.ts';
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
const _draftFwd = new THREE.Vector3();
const _draftTo = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qLean = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
/** Chassis-local axes: roll is about the nose, pitch about the axle. */
const AXIS_ROLL = new THREE.Vector3(0, 0, 1);
const AXIS_PITCH = new THREE.Vector3(1, 0, 0);
const _sample: SplineSample = {
  pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
  right: new THREE.Vector3(), up: new THREE.Vector3(),
  width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
};

const _sample2: SplineSample = {
  pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
  right: new THREE.Vector3(), up: new THREE.Vector3(),
  width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
};

const RIDE_HEIGHT = 0.55;

/** Friction and top-speed multipliers per surface. */
const SURFACE: Record<Surface, { drag: number; maxMul: number; grip: number }> = {
  road:  { drag: 0,    maxMul: 1.00, grip: 1.00 },
  boost: { drag: 0,    maxMul: 1.00, grip: 1.00 },
  dirt:  { drag: 12,   maxMul: 0.70, grip: 0.70 },
  sand:  { drag: 19,   maxMul: 0.58, grip: 0.58 },
  grass: { drag: 22,   maxMul: 0.53, grip: 0.62 },
  rail:  { drag: 0,    maxMul: 1.00, grip: 1.30 },
  water: { drag: 34,   maxMul: 0.45, grip: 0.50 },
  air:   { drag: 0,    maxMul: 1.00, grip: 0.00 },
};

/** Surfaces that should read as "you have made a mistake". */
const isOffroad = (s: Surface): boolean => SURFACE[s].drag > 0;

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

/**
 * Per-racer physics bookkeeping that no other module needs to see. Kept here
 * rather than on `Racer` so the shared contract does not grow a field for every
 * internal timer. Anything another system genuinely needs is published as an
 * event or an `effects` flag.
 */
interface KartRuntime {
  /** Held-drift state last step, so the rising edge works for AI and human alike. */
  prevDrift: boolean;
  /** Time left in which a hop can still turn into a committed drift. */
  hopGrace: number;
  /** Direction latched during the hop, applied on touchdown. */
  armedDir: -1 | 0 | 1;
  /** This flight started as a drift hop, so it does not qualify for a trick. */
  fromHop: boolean;
  /** Seconds left of the extra yaw rate that sells the drift snapping in. */
  kickTime: number;
  launchVy: number;
  trickWindow: number;
  trickArmed: boolean;
  /** 0..1 progress toward a slipstream boost. */
  draft: number;
  /** 0..1 how deep in the wake we are right now. */
  draftAmount: number;
  draftTarget: number;
  draftCooldown: number;
  offroad: boolean;
  /** Standing on a boost strip, so it refreshes instead of re-firing. */
  onPad: boolean;
  /** Already scraping the barrier, so the big scrub only lands once. */
  wallContact: boolean;
  /** Eased ceiling on sideways travel, as a fraction of forward speed. */
  slipCap: number;
  /** Sign of last step's lateral slip, so counter-steer can be detected before
   *  the heading is rotated. One 120Hz step of latency is invisible. */
  slipDir: number;
  /** Levelled chassis orientation, before lean and pitch are laid on top. */
  base: THREE.Quaternion;
  baseSet: boolean;
  /** The surface normal the kart is actually riding on — the raw one, eased.
   *  This is the suspension: it is what stops a seam in the road model from
   *  reading as a ramp. */
  normal: THREE.Vector3;
  normalSet: boolean;
  /** Body roll about the nose, and the spring driving it. Positive leans left. */
  roll: number;
  rollVel: number;
  /** Weight transfer about the axle. Positive is nose-down. */
  pitch: number;
  pitchVel: number;
  /** Smoothed longitudinal acceleration, -1..1, feeding that pitch. */
  accelFeel: number;
  /** Consecutive steps with daylight under the wheels. */
  airSteps: number;
  /** Seconds during which a held drift button may not start a new hop. Set when
   *  a barrier knocks a drift loose, so the kart does not hop straight back into
   *  the wall it just bounced off. */
  driftLockout: number;
  /** Half the vehicle's own width, cached off its definition. */
  halfWidth: number;
  /** Last step's contact test, recorded for the diagnostics probe only. */
  lastHeight: number;
  lastRising: number;
}

function newRuntime(): KartRuntime {
  return {
    prevDrift: false, hopGrace: 0, armedDir: 0, fromHop: false, kickTime: 0,
    launchVy: 0, trickWindow: 0, trickArmed: false,
    draft: 0, draftAmount: 0, draftTarget: -1, draftCooldown: 0,
    offroad: false, onPad: false, wallContact: false, slipCap: 0.3, slipDir: 0,
    base: new THREE.Quaternion(), baseSet: false,
    normal: new THREE.Vector3(0, 1, 0), normalSet: false,
    roll: 0, rollVel: 0, pitch: 0, pitchVel: 0, accelFeel: 0,
    airSteps: 0, halfWidth: 0.8, driftLockout: 0, lastHeight: 0, lastRising: 0,
  };
}

export function createKartPhysics(ctx: GameContext): GameSystem {
  const K = ctx.config.kart;
  const runtime = new Map<number, KartRuntime>();

  const stateOf = (racer: Racer): KartRuntime => {
    let s = runtime.get(racer.id);
    if (!s) {
      s = newRuntime();
      // A barrier has to hold the kart's *flank*, not its centre, or a wide
      // machine ends up visibly inside the panels. Cached once: the definition
      // never changes for the life of a racer.
      s.halfWidth = clamp(getVehicle(racer.vehicleId).size.width * 0.5, 0.7, 1.5);
      s.base.copy(racer.quat);
      s.baseSet = true;
      runtime.set(racer.id, s);
    }
    return s;
  };

  /**
   * Where the ground is beneath a racer, and which way it faces.
   * The road, the verge and the open ground each have their own answer.
   */
  function sampleGround(racer: Racer): Surface {
    const surf = rawGround(racer);
    // Suspension. The road is a resampled spline, and where two of its segments
    // meet the normal can swing several degrees inside a single 8ms step. The
    // launch test reads exactly that swing, so an un-eased normal turns every
    // seam on a descent into a jump and the kart skips down the hill three
    // times a second. A real chassis cannot react that fast, and neither should
    // this one — but the ease is quick enough that the lip of a genuine ramp
    // still reads as a ramp two steps later.
    const st = stateOf(racer);
    if (!st.normalSet) { st.normal.copy(_groundNormal); st.normalSet = true; }
    st.normal.lerp(_groundNormal, 1 - Math.exp(-K.air.normalRate * ctx.config.sim.fixedDt))
      .normalize();
    _groundNormal.copy(st.normal);
    return surf;
  }

  function rawGround(racer: Racer): Surface {
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
      // The track owns what the tarmac *is* — boost strips, rails, painted
      // surfaces. Physics only owns what each of those does to a kart.
      return (s.surface as Surface | undefined) ?? 'road';
    }
    if (a <= half + vergeW) {
      const t = (a - half) / vergeW;
      _groundPoint.copy(s.pos).addScaledVector(s.right, lateral).addScaledVector(s.up, t * -0.35);
      _groundNormal.copy(s.up);
      return (track.course.vergeSurface ?? 'dirt') as Surface;
    }
    // Beyond the shoulder the world is the terrain module's embankment: it falls
    // away from the shoulder edge and only settles to the ground datum hundreds
    // of metres out. Snapping straight to that datum here would put a ten-metre
    // cliff one centimetre past the verge, and a kart brushing that line reads as
    // airborne for a step, planted the next, forever. Follow the embankment
    // instead, and level the frame off as it flattens.
    const beyond = a - half - vergeW;
    const emb = 0.35 + 5.4 * smoothstep(beyond / 26);
    _groundPoint.copy(s.pos).addScaledVector(s.right, lateral).addScaledVector(s.up, -0.35);
    _groundPoint.y -= emb - 0.35;
    _groundNormal.copy(s.up).lerp(WORLD_UP, clamp01(beyond / 20)).normalize();
    return (track.course.offSurface ?? 'grass') as Surface;
  }

  /**
   * A boost's `power` is a strength scalar shared with the HUD, camera and item
   * system — not a speed. This is the one place it becomes one.
   */
  const boostMultiplier = (power: number): number => 1 + power * K.boost.powerScale;

  /** Effective top speed, folding in stats, coins, class, surface and draft. */
  function topSpeed(racer: Racer, surf: Surface): number {
    const cls = ctx.config.race.classes[ctx.race.engineClass];
    const statMul = lerp(0.86, 1.14, racer.stats.speed);
    const coinMul = 1 + Math.min(racer.coins, K.coins.max) * K.coins.speedPerCoin;
    const band = racer.rubberBand ?? 1;
    const draftMul = 1 + stateOf(racer).draftAmount * K.slipstream.pull;
    return K.maxSpeed * statMul * coinMul * cls.speedMul * SURFACE[surf].maxMul * band * draftMul;
  }

  /**
   * Boosts stack generously — a new one never shortens an active one — and land
   * as an immediate shove as well as a raised ceiling. The shove is what makes a
   * mini-turbo read as an event instead of a slow drift upward.
   */
  function applyBoost(racer: Racer, source: BoostSource, time: number, power: number): void {
    if (time >= racer.boost.time) {
      racer.boost.time = time;
      racer.boost.source = source;
    }
    racer.boost.power = Math.max(racer.boost.power, power);

    const ceiling = topSpeed(racer, racer.surface) * boostMultiplier(racer.boost.power);
    if (racer.speed < ceiling) {
      racer.speed = Math.min(ceiling, racer.speed + power * K.boost.kick);
    }
    ctx.bus.emit('kart:boost', { racer, source, power });
  }

  function releaseDrift(racer: Racer, payOut = true): void {
    const d = racer.drift;
    if (payOut && d.tier > 0) {
      const tier = K.drift.tiers[d.tier - 1]!;
      applyBoost(racer, `drift${d.tier}` as BoostSource, tier.boost, tier.power);
    }
    d.active = false;
    d.dir = 0;
    d.charge = 0;
    d.tier = 0;
    const st = stateOf(racer);
    st.armedDir = 0;
    st.hopGrace = 0;
    st.kickTime = 0;
  }

  /** A hop: real air under the tyres, sized so `hopHeight` and `hopTime` agree. */
  function hop(racer: Racer, st: KartRuntime): void {
    const vy = Math.sqrt(2 * K.air.gravity * K.drift.hopHeight);
    racer.vel.addScaledVector(_groundNormal, vy - racer.vel.dot(_groundNormal));
    racer.grounded = false;
    racer.airTime = 0;
    racer.drift.hopTime = K.drift.hopTime;
    st.hopGrace = K.drift.hopGrace;
    st.fromHop = true;
    st.launchVy = vy;
    st.trickWindow = 0;
    st.trickArmed = false;
    ctx.bus.emit('kart:hop', { racer });
  }

  function commitDrift(racer: Racer, dir: -1 | 1): void {
    const d = racer.drift;
    const st = stateOf(racer);
    d.active = true;
    d.dir = dir;
    d.charge = 0;
    d.tier = 0;
    d.angle = K.drift.snapAngle;
    st.kickTime = K.drift.kickTime;
    st.armedDir = 0;
    racer.speed *= 1 - K.drift.entryScrub;
    ctx.bus.emit('kart:drift:start', { racer, dir });
  }

  // ── slipstream ────────────────────────────────────────────────────────────
  //
  // Runs across the whole field before anyone steps, so `topSpeed` can read a
  // draft value that is consistent for every racer in the same tick.
  function updateSlipstream(dt: number): void {
    const S = K.slipstream;
    const racing = ctx.race.phase === 'racing' || ctx.race.phase === 'finished';
    const cosLimit = Math.cos(S.halfAngle);
    const minSpeed = K.maxSpeed * S.minSpeedFrac;

    for (const racer of ctx.racers) {
      const st = stateOf(racer);
      st.draftCooldown = Math.max(0, st.draftCooldown - dt);

      let best = -1;
      let bestScore = 0;
      if (racing && racer.grounded && racer.speed > minSpeed && racer.stunned <= 0) {
        _draftFwd.set(Math.sin(racer.yaw), 0, Math.cos(racer.yaw));
        for (const other of ctx.racers) {
          if (other === racer || other.speed < minSpeed * 0.6) continue;
          _draftTo.subVectors(other.pos, racer.pos);
          _draftTo.y = 0;
          const dist = _draftTo.length();
          if (dist < 1.6 || dist > S.distance) continue;
          _draftTo.divideScalar(dist);
          const cone = _draftTo.dot(_draftFwd);
          if (cone < cosLimit) continue;
          // Only a rival travelling the same way leaves a wake worth sitting in.
          const align = Math.cos(angleDelta(racer.yaw, other.yaw));
          if (align < 0.65) continue;
          // Deepest right behind the rival, fading out to nothing at the edges.
          const near = 1 - (dist - 1.6) / (S.distance - 1.6);
          const score = near * clamp01((cone - cosLimit) / (1 - cosLimit) + 0.35) * align;
          if (score > bestScore) { bestScore = score; best = other.id; }
        }
      }

      // Ramp in quickly, fall out quickly — the draft should be something you can
      // aim for, not something that lingers after you have left the wake.
      st.draftAmount = damp(st.draftAmount, clamp01(bestScore), bestScore > 0 ? 0.02 : 0.0002, dt);
      if (st.draftAmount < 0.01) st.draftAmount = 0;

      const wasDrafting = st.draftTarget >= 0;
      const drafting = bestScore > 0.12;
      if (drafting) {
        if (!wasDrafting) {
          st.draftTarget = best;
          racer.effects.add('draft');
          ctx.bus.emit('kart:slipstream', { racer, target: best, state: 'enter' });
        }
        if (st.draftCooldown <= 0) {
          st.draft = clamp01(st.draft + (dt / S.chargeTime) * st.draftAmount);
          if (st.draft >= 1) {
            st.draft = 0;
            st.draftCooldown = S.cooldown;
            applyBoost(racer, 'slipstream', K.boost.slipstream.time, K.boost.slipstream.power);
          }
        }
      } else {
        st.draft = Math.max(0, st.draft - dt * 0.6);
        if (wasDrafting) {
          st.draftTarget = -1;
          racer.effects.delete('draft');
          ctx.bus.emit('kart:slipstream', { racer, target: -1, state: 'exit' });
        }
      }
    }
  }

  function stepRacer(racer: Racer, dt: number): void {
    racer.prevPos.copy(racer.pos);
    racer.prevQuat.copy(racer.quat);

    const st = stateOf(racer);
    const d = racer.drift;
    const speed0 = racer.speed;

    // A CPU driver, when present, authors this racer's input — including for the
    // player's kart under autopilot. Only a driverless racer reads the human.
    const input = racer.ai ? (racer.aiInput ?? ctx.inputState) : ctx.inputState;

    const racing = ctx.race.phase === 'racing';
    const frozen = !racing || racer.finished;

    let accelIn = frozen ? 0 : input.accel;
    let brakeIn = frozen ? 0 : input.brake;
    let steerIn = frozen ? 0 : input.steer;
    const driftHeld = !frozen && input.drift;
    const driftPressed = driftHeld && !st.prevDrift;
    st.prevDrift = driftHeld;

    // Being hit takes control away and spins the chassis.
    if (racer.stunned > 0) {
      racer.stunned = Math.max(0, racer.stunned - dt);
      accelIn = 0;
      brakeIn = 0;
      steerIn = 0;
      if (d.active) releaseDrift(racer, false);
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
    // A kart hugs the road. Crests, banking transitions and kerbs all lift the
    // body a few centimetres clear of the surface, and treating every one of
    // those as a jump costs the player steering, throttle and a landing scrub
    // several times a lap. So: stay planted while we are close to the ground and
    // not genuinely climbing away from it.
    const rising = racer.vel.dot(_groundNormal);
    st.lastHeight = height;
    st.lastRising = rising;
    const planted = height <= RIDE_HEIGHT + 0.02
      || (wasGrounded && height <= RIDE_HEIGHT + K.air.groundStick && rising < K.air.stickRise);
    if (planted) st.airSteps = 0; else st.airSteps++;
    // ...and one clear step is never a jump. A seam in the surface model, a
    // camber transition or a kerb can open a few centimetres of daylight for a
    // single 8ms step, and calling that 'air' makes the surface flag chatter
    // uselessly for anything reading it. A kart that is actually climbing away
    // still leaves on the very first step — this grace only holds down a kart
    // that is falling or level.
    racer.grounded = planted
      || (wasGrounded && rising <= 0 && st.airSteps <= K.air.airGrace
        && height <= RIDE_HEIGHT + K.air.groundStick * 2);

    if (racer.grounded) {
      const prevSurface = racer.surface;
      racer.surface = surf;

      if (!wasGrounded) {
        // Two different numbers, because they answer two different questions.
        //
        // `impact` is what the landing *looks* like — how hard the wheels came
        // down. Every landing has one, including a drift hop, because the squash,
        // the dust and the thump all key off this payload and a landing that
        // reports zero is a landing nobody can see or hear.
        //
        // `cost` is what it takes off the clock, and there the free energy the
        // hop itself put in is refunded: hops happen dozens of times a lap and
        // must never feel like a tax.
        const down = Math.max(0, -racer.vel.dot(_groundNormal));
        const free = st.fromHop ? Math.sqrt(2 * K.air.gravity * K.drift.hopHeight) : 0;
        const hang = Math.max(0, racer.airTime - (st.fromHop ? K.drift.hopTime : 0));
        const impact = clamp01(down / K.air.impactScale + hang * 0.30);
        const cost = clamp01(Math.max(0, down - free) / K.air.impactScale + hang * 0.30);
        const tricked = st.trickArmed && racer.airTime >= K.air.trickMinAir;

        if (tricked) {
          // A landed trick replaces the scrub with a shove. That trade is the
          // whole reason to touch the button in the air.
          applyBoost(racer, 'trick', K.boost.trick.time, K.boost.trick.power);
          ctx.bus.emit('kart:trick', { racer, impact });
        } else {
          racer.speed *= 1 - cost * K.air.landingScrub;
        }
        racer.effects.delete('trick');
        st.trickArmed = false;
        st.trickWindow = 0;
        st.fromHop = false;
        // The landing squash the fx and vehicle rigs play is sized off `impact`,
        // and `airTime` tells them whether it was a hop or a flight.
        ctx.bus.emit('kart:land', {
          racer, impact, tricked, airTime: racer.airTime, surface: racer.surface,
        });
      }

      racer.airTime = 0;
      // Correct ride height *along the surface normal only*. Rebuilding the
      // position from the spline projection would also discard the kart's
      // along-track residual, which at speed cancels forward motion outright.
      racer.pos.addScaledVector(_groundNormal, RIDE_HEIGHT - height);
      // Glue the velocity to the surface. Removing only the *downward* part left
      // the outward part intact, so on every descent the kart carried its old
      // horizontal velocity off the falling road, went ballistic, landed, and
      // did it again — a kart skipping down the hill at three hops a second.
      // A launch does not need that leak: a kart rolling up a ramp already has
      // its velocity in the ramp's plane, which points at the sky, so the moment
      // the lip stops holding it down it leaves on a proper arc.
      racer.vel.addScaledVector(_groundNormal, -racer.vel.dot(_groundNormal));

      // Leaving tarmac has to read on the very first frame, not two seconds
      // later once drag has done its work.
      // Boost strips: fire once on contact, then hold while the wheels stay on
      // them, so a long strip is one continuous shove rather than a stutter.
      if (racer.surface === 'boost') {
        if (!st.onPad) {
          applyBoost(racer, 'pad', K.boost.pad.time, K.boost.pad.power);
        } else {
          racer.boost.time = Math.max(racer.boost.time, K.boost.pad.time);
          racer.boost.power = Math.max(racer.boost.power, K.boost.pad.power);
        }
        st.onPad = true;
      } else {
        st.onPad = false;
      }

      const nowOff = isOffroad(racer.surface);
      if (nowOff && !st.offroad) {
        racer.speed *= 1 - K.offroadEntryScrub * clamp01(Math.abs(racer.speed) / 25);
        ctx.bus.emit('kart:offroad', { racer, surface: racer.surface });
      } else if (!nowOff && st.offroad) {
        ctx.bus.emit('kart:onroad', { racer, surface: racer.surface, from: prevSurface });
      }
      st.offroad = nowOff;
    } else {
      if (wasGrounded) {
        // Just left the ground. A real launch opens the trick window; a drift hop
        // does not (the button that hops is the button that tricks).
        st.launchVy = racer.vel.dot(_groundNormal);
        st.trickWindow = st.fromHop ? 0 : K.air.trickWindow;
        st.trickArmed = false;
        if (!st.fromHop && st.launchVy >= K.air.trickMinLaunch) {
          ctx.bus.emit('kart:launch', { racer, power: st.launchVy });
        }
      }
      racer.surface = 'air';
      racer.airTime += dt;
      racer.vel.y -= K.air.gravity * dt;
      if (racer.vel.y < -K.air.terminal) racer.vel.y = -K.air.terminal;
    }

    const sp = SURFACE[racer.surface];

    // ── tricks ────────────────────────────────────────────────────────────
    if (!racer.grounded && !frozen && racer.stunned <= 0) {
      st.trickWindow = Math.max(0, st.trickWindow - dt);
      // A drift hop is not a jump. Anything else is — including simply driving
      // off the lip of a crest, where the launch velocity is near zero and only
      // the hang time says it was a jump at all.
      const bigAir = racer.airTime > K.drift.hopTime * 1.7;
      const eligible = !st.fromHop || bigAir;
      if (eligible && !st.trickArmed) {
        // A human flicks the hop button. A CPU that knows what it is doing takes
        // the same trick — deterministically, off its own skill rating.
        const wants = racer.ai ? racer.ai.skill > 0.55 : (driftPressed || (st.trickWindow > 0 && d.active));
        if (wants && (st.trickWindow > 0 || d.active || racer.ai)) {
          st.trickArmed = true;
          racer.effects.add('trick');
          ctx.bus.emit('kart:trick:start', { racer });
        }
      }
    }

    // ── steering ──────────────────────────────────────────────────────────
    const steerSmooth = d.active ? K.driftSteerSmoothing : K.steerSmoothing;
    racer.steerAngle = damp(racer.steerAngle, steerIn, steerSmooth, dt);

    const speedFrac = clamp01(Math.abs(racer.speed) / Math.max(1, K.maxSpeed));
    const handling = lerp(0.85, 1.18, racer.stats.handling);
    // Authority bleeds away with speed on a curve, not a straight line, so the
    // mid-range still turns in while the top end goes deliberately heavy.
    const falloff = 1 - K.steerSpeedFalloff * Math.pow(speedFrac, K.steerFalloffCurve);
    let turnRate = K.steerRate * handling * falloff;
    // In the air the same speed falloff applies, scaled so a hop can never be a
    // cheaper way to turn than the tyres are.
    if (!racer.grounded) turnRate = K.air.control * handling * falloff;
    // Catching a slide is a skill the model should reward. `slipDir` is which
    // side of the nose the kart is actually travelling; steering that way is the
    // driver pointing the nose back down its own velocity, and gets quick hands.
    // Steering the other way is just more understeer, and gets nothing.
    if (!d.active && st.slipDir !== 0 && sign(steerIn) === st.slipDir) {
      turnRate *= K.counterSteerBoost;
    }

    // ── drift ─────────────────────────────────────────────────────────────
    if (d.hopTime > 0) d.hopTime = Math.max(0, d.hopTime - dt);
    if (st.hopGrace > 0) st.hopGrace = Math.max(0, st.hopGrace - dt);
    if (st.kickTime > 0) st.kickTime = Math.max(0, st.kickTime - dt);
    if (st.driftLockout > 0) st.driftLockout = Math.max(0, st.driftLockout - dt);

    if (!frozen && racer.stunned <= 0) {
      // A kart still pressed against a barrier, or one a barrier has just
      // knocked out of a drift, may not start a new one. Without this a player
      // holding the button hops straight back into the wall they just hit,
      // every step, and each hop hands the airborne branch a velocity that is
      // pointing the wrong way relative to the nose.
      const mayStart = st.driftLockout <= 0 && !st.wallContact;
      const fastEnough = racer.speed > K.drift.minSpeed && mayStart;

      // 1. Press hops. Always. The hop is the anticipation beat — the kart leaves
      //    the ground before it commits to anything.
      if (driftPressed && !d.active && racer.grounded && fastEnough) {
        hop(racer, st);
        if (Math.abs(steerIn) > 0.2) st.armedDir = steerIn > 0 ? 1 : -1;
      }

      // 2. Steering during the hop latches the direction. Latch the *latest*
      //    input, so a late flick still counts.
      if (!d.active && driftHeld && st.hopGrace > 0 && Math.abs(steerIn) > 0.2) {
        st.armedDir = steerIn > 0 ? 1 : -1;
      }

      // 2b. Holding the button and *then* turning in should also work — a player
      //     who never lets go of drift still gets the hop and the drift, just
      //     late. Unforgiving input rules are how a kart racer loses people.
      if (!d.active && driftHeld && !driftPressed && racer.grounded && fastEnough
          && st.hopGrace <= 0 && d.hopTime <= 0 && Math.abs(steerIn) > 0.35) {
        hop(racer, st);
        st.armedDir = steerIn > 0 ? 1 : -1;
      }

      // 3. Touchdown commits it. No second hop — the chassis just pivots out.
      if (!d.active && driftHeld && racer.grounded && st.armedDir !== 0 && fastEnough) {
        commitDrift(racer, st.armedDir);
      }
      if (!driftHeld) st.armedDir = 0;

      if (d.active) {
        if (!driftHeld || racer.speed < K.drift.minSpeed * 0.6) {
          releaseDrift(racer);
        } else {
          // Steering into the drift tightens it; steering out opens it up but
          // never flips it — you have to release to change direction.
          const into = clamp01(steerIn * d.dir * 0.5 + 0.5);
          const targetAngle = lerp(K.drift.enterAngle, K.drift.maxAngle, into);
          d.angle = moveToward(d.angle, targetAngle, K.drift.angleRate * dt);

          turnRate *= K.drift.yawBonus;
          // The chassis carries a baseline turn in the drift direction. Leaning
          // in pulls a hairpin-tight arc; counter-steering opens it out to about
          // the radius of a fast sweeper, which is what lets a drift be *held*
          // through a long corner instead of spinning across the road.
          steerIn = d.dir * lerp(K.drift.counterSteer, 1.0, into);
          if (st.kickTime > 0) {
            turnRate *= lerp(1, K.drift.yawKick, st.kickTime / K.drift.kickTime);
          }

          const chargeRate = K.drift.chargeRate
            * lerp(0.8, 1.2, racer.stats.handling)
            * lerp(0.85, 1.12, into)
            * clamp01(racer.speed / (K.maxSpeed * 0.5))
            * (racer.grounded ? 1 : K.drift.airChargeMul);
          d.charge = Math.min(d.charge + chargeRate * dt, K.drift.chargeCap);

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
      releaseDrift(racer, false);
    }

    if (!d.active) d.angle = moveToward(d.angle, 0, K.drift.angleRate * dt);

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
    racer.maxSpeed = boosting ? baseMax * boostMultiplier(racer.boost.power) : baseMax;

    const accelStat = lerp(0.70, 1.32, racer.stats.accel);
    const coinAccel = 1 + Math.min(racer.coins, K.coins.max) * K.coins.accelPerCoin;

    if (racer.grounded) {
      if (accelIn > 0) {
        // Punchy low end, long soft top end. The exponent does all the work: at
        // rest the engine has its full authority, near the ceiling it has almost
        // none, and the band in between is where the race is actually won.
        const frac = clamp01(racer.speed / Math.max(1, racer.maxSpeed));
        const curve = Math.pow(1 - frac, K.accelCurve);
        racer.speed += K.accel * accelStat * coinAccel * curve * accelIn * dt;
      }

      if (boosting && racer.speed < racer.maxSpeed) {
        // A boost is an authority, not just a raised ceiling: it drags the kart
        // up to its target whether or not the throttle is down.
        racer.speed = damp(racer.speed, racer.maxSpeed, K.boost.pull, dt);
      }

      if (brakeIn > 0) {
        racer.speed -= K.brakeForce * brakeIn * dt;
        const revMax = -K.reverseSpeed;
        if (racer.speed < revMax) racer.speed = revMax;
      }

      if (accelIn <= 0 && brakeIn <= 0 && !boosting) {
        // Coasting should feel like lifting off, not like an anchor: engine
        // braking is strong at speed and nearly nothing at walking pace.
        const u = clamp01(Math.abs(racer.speed) / Math.max(1, baseMax));
        const drag = K.coastDrag * lerp(K.coastDragLow, 1, u);
        racer.speed -= sign(racer.speed) * Math.min(Math.abs(racer.speed), drag * dt);
      }

      // Off-road bleeds speed hard on top of its lower ceiling.
      if (sp.drag > 0) {
        racer.speed -= sign(racer.speed) * sp.drag * dt * clamp01(Math.abs(racer.speed) / 14);
      }

      if (racer.speed > racer.maxSpeed) {
        // Overspeed always decays, so a boost carries out of the corner instead
        // of evaporating the instant the timer runs out.
        racer.speed = damp(racer.speed, racer.maxSpeed, boosting ? 0.02 : K.boost.carry, dt);
      }
      if (racer.speed < -K.reverseSpeed) racer.speed = -K.reverseSpeed;
    }

    // ── velocity integration ──────────────────────────────────────────────
    if (racer.grounded) {
      // Split velocity into "along the heading" and "sideways", then eat the
      // sideways part. How fast it is eaten *is* the handling model.
      _v.copy(racer.vel);
      _v.addScaledVector(_groundNormal, -_v.dot(_groundNormal));

      _lat.copy(_v).addScaledVector(_fwd, -_v.dot(_fwd));
      const gripBase = d.active ? K.driftGrip : K.grip;
      const grip = gripBase * sp.grip * lerp(0.85, 1.15, racer.stats.traction);
      let latSpeed = _lat.length();

      // Remember which way we are sliding; next step's steering reads it to
      // decide whether the driver is catching the slide or feeding it.
      st.slipDir = latSpeed > 0.6 ? sign(_lat.dot(_right)) : 0;

      // Ploughing sideways without committing to a drift costs speed. Drifting
      // is the way to go sideways for free; a boost hooks the tyres back up.
      if (!d.active && !boosting && latSpeed > 0.2) {
        const slipFrac = latSpeed / Math.max(6, Math.abs(racer.speed));
        if (slipFrac > K.slideThreshold) {
          racer.speed -= K.slideScrub * (slipFrac - K.slideThreshold) * Math.abs(racer.speed) * dt;
        }
      }

      // Hard ceiling on sideways travel — otherwise a full-lock corner at top
      // speed turns the kart into a brick flying sideways at 90 m/s. The ceiling
      // itself eases between its gripping and drifting values, so releasing a
      // drift settles the kart down instead of yanking it straight.
      st.slipCap = damp(st.slipCap, d.active ? K.driftSlip : K.maxSlip, K.slipBleed, dt);
      const slipCeiling = Math.min(
        st.slipCap * Math.max(Math.abs(racer.speed), 4),
        Math.abs(racer.speed) * 0.88,
      );
      if (latSpeed > slipCeiling) {
        _lat.multiplyScalar(slipCeiling / Math.max(latSpeed, 1e-6));
        latSpeed = slipCeiling;
      }

      if (latSpeed > 0.0001) {
        const reduce = Math.min(latSpeed, grip * dt);
        _lat.multiplyScalar((latSpeed - reduce) / latSpeed);
        latSpeed -= reduce;
      }

      // `speed` is how fast the kart moves through the world, not how fast it
      // points forward. Sideways travel therefore *costs* forward progress
      // instead of being added on top of it — which is what stops a drift from
      // being free speed and makes the mini-turbo the thing you are paid with.
      const along = Math.sqrt(Math.max(0, racer.speed * racer.speed - latSpeed * latSpeed))
        * (racer.speed < 0 ? -1 : 1);
      racer.vel.copy(_fwd).multiplyScalar(along).add(_lat);
    } else {
      // Airborne: momentum rules, but the nose still drags the trajectory around
      // a little so a jump is steerable rather than a cutscene.
      _v.copy(racer.vel);
      _v.y = 0;
      const horizSpeed = _v.length();
      // Signed ground speed — but the sign is *sticky*. A barrier strips the
      // into-wall part of the velocity, which can leave the trajectory pointing
      // behind the nose for a step or two; a naive sign test then rewrites
      // +46 m/s as -46 m/s in one step and the kart is suddenly doing 170 km/h
      // backwards. Reversing has to be something the kart *did*, so it takes a
      // trajectory within ~30° of dead astern to flip, and much less to flip
      // back.
      const alongNose = _v.dot(_fwd);
      const back = racer.speed < -0.5
        ? alongNose < 0.3 * horizSpeed
        : alongNose < -0.85 * horizSpeed;
      racer.speed = horizSpeed * (back ? -1 : 1);
      if (horizSpeed > 0.001) {
        const pull = Math.min(1, (K.air.steerPull * dt) / Math.max(1, horizSpeed));
        racer.vel.x = lerp(racer.vel.x, _fwd.x * racer.speed, pull);
        racer.vel.z = lerp(racer.vel.z, _fwd.z * racer.speed, pull);
      }
    }

    racer.pos.addScaledVector(racer.vel, dt);

    // ── barriers ──────────────────────────────────────────────────────────
    if (ctx.track && ctx.track.course.walls !== false) {
      const s = ctx.track.spline.nearest(racer.pos, _sample);
      // The barrier stops the kart's *flank*, not the point at its centre.
      // Holding the centre on the old line left a wide machine standing inside
      // the panels, which reads as the collision being fake.
      const limit = s.width * 0.5 + (ctx.track.course.vergeWidth ?? 5)
        - st.halfWidth - K.wall.gap;
      const lateral = s.lateral ?? 0;
      let touching = false;
      if (Math.abs(lateral) > limit) {
        const outward = sign(lateral);
        // Push straight back out along the barrier's own normal, to the line and
        // no further, so a kart held against the rail rides along it rather than
        // being flicked off it.
        racer.pos.addScaledVector(s.right, -outward * (Math.abs(lateral) - limit));
        const intoWall = racer.vel.dot(s.right) * outward;
        if (intoWall > 0) {
          touching = true;
          // 0 is a graze down the rail, 1 is dead head-on. Everything the wall
          // does is weighted by it, quadratically, so the punishment tracks the
          // mistake instead of being a flat tax on touching the scenery.
          const squareness = clamp01(intoWall / Math.max(8, Math.abs(racer.speed)));
          // Kill the component going into the barrier, and only give a square hit
          // anything back. A rail that bounces a drifting kart across the road is
          // worse than no rail at all.
          const rest = K.wall.restitution * squareness * squareness;
          racer.vel.addScaledVector(s.right, -outward * intoWall * (1 + rest));

          if (!st.wallContact) {
            // The impact itself: one bite, sized by how square the hit was. A
            // graze costs almost nothing; a head-on should feel like a mistake
            // you made. Charging this every step instead would compound at
            // 120Hz and stop the kart dead, which is not a wall — that is glue.
            racer.speed *= 1 - K.wall.scrub * squareness * squareness;
            if (squareness > 0.08) {
              ctx.bus.emit('kart:wall', { racer, force: squareness, surface: racer.surface });
            }
            // Only a real hit knocks the drift loose. Brushing the rail
            // mid-corner is part of driving a kart racer, and losing a charged
            // mini-turbo to it is the single most demoralising thing a barrier
            // can do — so a shallow scrape just eats into the charge instead.
            if (squareness > K.wall.driftBreak && d.active) {
              releaseDrift(racer, false);
              st.driftLockout = K.wall.driftLockout;
            }
          } else {
            // Scraping along it: a steady rub you can drive out of.
            racer.speed -= K.wall.grind * (0.12 + squareness) * dt;
            if (racer.speed < 0) racer.speed = 0;
          }
          if (d.active && squareness <= K.wall.driftBreak) {
            d.charge = Math.max(0, d.charge - K.wall.driftBleed * squareness * dt);
          }

          // Deflect the nose along the barrier instead of leaving the kart
          // ploughing into it at an angle — that is what stops a wall from being
          // a trap the player cannot drive out of.
          const wallYaw = Math.atan2(s.tangent.x, s.tangent.z);
          const facing = Math.abs(angleDelta(racer.yaw, wallYaw)) > Math.PI * 0.5 ? Math.PI : 0;
          const align = clamp01(squareness * K.wall.deflect) * K.wall.deflectRate * dt;
          racer.yaw += angleDelta(racer.yaw, wallYaw + facing) * Math.min(0.4, align);
        }
      }
      st.wallContact = touching;
    }

    // Whatever just happened — barrier, landing, gravel — no single 8.3ms step
    // may delete more than this much speed. Instantaneous losses of 25 m/s do
    // not read as a crash; they read as the game reaching in and stopping the
    // kart. The full loss still lands, it just takes a few steps to arrive.
    if (racer.grounded && speed0 - racer.speed > K.maxSpeedLoss) {
      racer.speed = speed0 - K.maxSpeedLoss;
    }

    // ── orientation ───────────────────────────────────────────────────────
    // Chassis yaw includes the drift offset, so the kart visibly points into the
    // slide while still travelling along its heading.
    const visualYaw = racer.yaw - d.angle * d.dir;
    _fwd.set(Math.sin(visualYaw), 0, Math.cos(visualYaw));
    _fwd.addScaledVector(_groundNormal, -_fwd.dot(_groundNormal)).normalize();
    if (racer.grounded) _up.copy(_groundNormal);
    else _up.copy(WORLD_UP);
    _right.crossVectors(_up, _fwd).normalize();
    _m.makeBasis(_right, _up, _fwd);
    _q.setFromRotationMatrix(_m);
    // Ease into the levelled orientation so kerbs and crests do not snap the
    // kart. Lean and pitch are laid on top of *this*, not folded into it, so
    // they keep their own — much faster — springs.
    if (!st.baseSet) { st.base.copy(_q); st.baseSet = true; }
    st.base.slerp(_q, 1 - Math.pow(K.orientSmoothing, dt));

    // ── lean ──────────────────────────────────────────────────────────────
    // The loudest thing the drift says. Under grip the body tips *into* the
    // corner the way a driver does — a few degrees, barely conscious. Committed
    // to a drift it is thrown the other way, hard, and the amount tracks the
    // chassis angle, so a player reads how deep they are from the lean alone
    // before a single spark has been drawn.
    //
    // Sign: a positive rotation about the nose tips the roof toward the kart's
    // left. A right-hand drift (dir +1) therefore leans left — outward, away
    // from the corner — and a right-hand grip turn leans right, into it.
    const angFrac = clamp01(Math.abs(d.angle) / Math.max(0.01, K.drift.maxAngle));
    const leanSpeed = clamp01(Math.abs(racer.speed) / (K.maxSpeed * 0.42));
    let rollTarget = d.dir !== 0
      ? K.drift.roll * d.dir * angFrac * lerp(0.55, 1, leanSpeed)
      : -K.leanRoll * racer.steerAngle * leanSpeed;
    if (!racer.grounded) rollTarget *= K.air.leanMul;

    // Asymmetric spring: it snaps out in about five steps and settles back over
    // ten. Weight goes on quickly and comes off slowly — the other way round
    // reads as a glitch.
    const growing = Math.abs(rollTarget) > Math.abs(st.roll);
    const stiff = growing ? K.drift.rollStiffness : K.drift.rollStiffness * K.drift.rollReleaseMul;
    const damping = growing ? K.drift.rollDamping : K.drift.rollDamping * K.drift.rollReleaseDamp;
    [st.roll, st.rollVel] = spring(st.roll, st.rollVel, rollTarget, stiff, damping, dt);

    // Weight transfer. The nose lifts under power, dives under braking, and in
    // the air follows the trajectory so a jump has an arc rather than a slide.
    st.accelFeel = damp(
      st.accelFeel, clamp((racer.speed - speed0) / dt / 40, -1, 1), K.pitchSmoothing, dt);
    let pitchTarget = -K.pitchAccel * st.accelFeel;
    if (!racer.grounded) pitchTarget -= K.air.pitch * clamp(racer.vel.y / 18, -1, 1);
    [st.pitch, st.pitchVel] = spring(
      st.pitch, st.pitchVel, pitchTarget, K.drift.rollStiffness * 0.35, K.drift.rollDamping * 0.7, dt);

    racer.quat.copy(st.base)
      .multiply(_qLean.setFromAxisAngle(AXIS_ROLL, st.roll))
      .multiply(_qLean.setFromAxisAngle(AXIS_PITCH, st.pitch));
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

  // ── diagnostics ───────────────────────────────────────────────────────────
  //
  // `window.__GAME.snapshot()` is core's contract with the review pipeline and is
  // deliberately small and stable. This is physics' own instrument panel: the
  // numbers you need to answer "is the drift model actually doing what it says"
  // — lean, slip angle, wall contact, ride height — without attaching a
  // debugger. Read-only, computed on demand, costs nothing when nobody asks.
  const probe = (id = 0): Record<string, number | string | boolean> | null => {
    const racer = ctx.racers.find((r) => r.id === id) ?? ctx.player;
    if (!racer) return null;
    const st = stateOf(racer);
    _v.copy(racer.vel); _v.y = 0;
    _fwd.set(Math.sin(racer.yaw), 0, Math.cos(racer.yaw));
    const slip = _v.length() > 0.5 ? Math.acos(clamp(_v.dot(_fwd) / _v.length(), -1, 1)) : 0;
    _up.set(0, 1, 0).applyQuaternion(racer.quat);
    const s = ctx.track ? ctx.track.sample(racer.pos, _sample) : null;
    return {
      t: ctx.race.time,
      speed: racer.speed,
      surface: racer.surface,
      grounded: racer.grounded,
      airTime: racer.airTime,
      y: racer.pos.y,
      lateral: s?.lateral ?? 0,
      halfWidth: s ? s.width * 0.5 : 0,
      /** Straight-line distance from the kart to the centreline point the
       *  surface query matched. It should never exceed the road half-width plus
       *  the verge; if it does, the kart and the road it thinks it is on have
       *  come apart. */
      splineDist: s ? racer.pos.distanceTo(s.pos) : 0,
      sx: s ? s.pos.x : 0, sy: s ? s.pos.y : 0, sz: s ? s.pos.z : 0,
      px: racer.pos.x, py: racer.pos.y, pz: racer.pos.z,
      /** Brute-force truth, for cross-checking the accelerated query above. */
      ...(() => {
        const t = ctx.track;
        if (!t) return { trueDist: 0, trueLateral: 0, trueD: 0 };
        let bestD = Infinity, bestAt = 0;
        for (let d = 0; d < t.spline.length; d += 2) {
          const q = t.spline.atDistance(d, _sample2);
          const dd = q.pos.distanceTo(racer.pos);
          if (dd < bestD) { bestD = dd; bestAt = d; }
        }
        const q = t.spline.atDistance(bestAt, _sample2);
        _v.subVectors(racer.pos, q.pos);
        return { trueDist: bestD, trueLateral: _v.dot(q.right), trueD: bestAt };
      })(),
      curvature: s?.curvature ?? 0,
      driftActive: racer.drift.active,
      dir: racer.drift.dir,
      charge: racer.drift.charge,
      tier: racer.drift.tier,
      angle: racer.drift.angle,
      roll: st.roll,
      /** Degrees the chassis leans against the surface it is standing on. */
      leanDeg: st.roll * 180 / Math.PI,
      pitch: st.pitch,
      // Degrees the roof is off vertical — the number a reviewer measures the
      // bank with, straight off the published quaternion.
      bankDeg: Math.acos(clamp(_up.y, -1, 1)) * 180 / Math.PI,
      slipDeg: slip * 180 / Math.PI,
      steerAngle: racer.steerAngle,
      vy: racer.vel.y,
      height: st.lastHeight,
      rising: st.lastRising,
      nose: _v.length() > 0.5 ? _v.dot(_fwd) / _v.length() : 1,
      boostTime: racer.boost.time,
      boostSource: racer.boost.source ?? '',
      draft: st.draftAmount,
      wall: st.wallContact,
    };
  };
  if (typeof globalThis !== 'undefined') {
    (globalThis as unknown as Record<string, unknown>).__PHYSICS = { probe };
  }

  return {
    name: 'physics',
    order: 30,

    reset(): void {
      runtime.clear();
      for (const racer of ctx.racers) {
        racer.effects.delete('draft');
        racer.effects.delete('trick');
      }
    },

    fixedUpdate(dt: number): void {
      updateSlipstream(dt);
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
  // Match the in-system shove so an item boost lands as hard as a mini-turbo.
  // The bound here is deliberately loose — the physics step recomputes the real
  // ceiling next tick and decays anything above it.
  const K = ctx.config.kart;
  const ceiling = K.maxSpeed * 1.2 * (1 + racer.boost.power * K.boost.powerScale);
  if (racer.speed < ceiling) {
    racer.speed = Math.min(ceiling, racer.speed + power * K.boost.kick);
  }
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
