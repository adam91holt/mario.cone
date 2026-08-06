// The animation rig every racer shares.
//
// A model is two things stacked: a `root` that carries nothing but the
// simulation's transform, and a `chassis` underneath it that carries all the
// lying. Suspension, lean, dive, squat, the shudder of a boost, the wobble of a
// hit — all of it happens on the chassis, so it can never fight the physics or
// leak back into it.
//
// Why the wheels sit on the root and not the chassis: wheels belong to the
// road. Keeping them planted while the body rolls above them is the entire
// read of a suspension, and it costs nothing but parenting them one level up.
//
// Everything in here is derived from simulation state that already exists on
// the racer — speed, steer, drift, boost, grounded, stunned. Nothing subscribes
// to events, nothing reads a clock, nothing allocates per frame. A model can
// therefore be built, driven and thrown away at any point in a frame, which is
// what makes the capture tooling able to photograph the cast on demand.

import * as THREE from 'three';
import { clamp, clamp01, damp, hash1 } from '../core/math.ts';
import type { Racer } from '../types.ts';
import type { FaceRig, FaceState } from './face.ts';

export interface WheelSpec {
  obj: THREE.Object3D;
  radius: number;
  /** 0 = fixed axle, 1 = full steering lock. */
  steer?: number;
  /** Metres the wheel droops when the vehicle is airborne. */
  droop?: number;
  /** Multiplier on roll rate. 0 for a wheel that is decorative. */
  spin?: number;
}

export interface RigOptions {
  /** Everything that leans. Usually the whole body minus the wheels. */
  chassis: THREE.Object3D;
  wheels?: WheelSpec[];
  /** Radians of body roll at full lock. */
  roll?: number;
  /** ...and the extra it gets from a committed drift. */
  driftRoll?: number;
  /** Radians of nose-up/nose-down from acceleration and braking. */
  pitch?: number;
  /** Metres the body squats when a boost fires. */
  squat?: number;
  /** Amplitude of the road buzz at speed, metres. */
  buzz?: number;
  /** How much the body stretches along its length under boost. */
  stretch?: number;
  /** Vertical spring stiffness / damping for landings. */
  stiffness?: number;
  damping?: number;
  /** Constant hover bob — helicopters and anything that never really lands. */
  hover?: number;
  hoverRate?: number;
  /** Yaw the body steals from the steering, radians. Sells a nimble machine. */
  yaw?: number;
  face?: FaceRig;
  /** Per-racer phase so eight of the same model never move in lockstep. */
  seed?: number;
  /** Override the default expression the rig derives from race state. */
  express?(racer: Racer, s: RigState): Partial<FaceState>;
}

/** Everything the rig worked out this frame, for a vehicle's own extras. */
export interface RigState {
  /** Seconds of visual time this model has existed. */
  t: number;
  /** 0..1 of top speed. */
  speedFrac: number;
  /** -1..1 smoothed steering, drift folded in. */
  turn: number;
  /** 0..1 boost strength. */
  boost: number;
  /** 0..1 airborne. */
  air: number;
  /** 0..1 spun out. */
  stun: number;
  /** Metres of body travel on the suspension spring. Negative = compressed. */
  bump: number;
  /** -1..1 longitudinal g. Positive is acceleration. */
  accel: number;
  /** 0..1 committed drift, signed by direction. */
  drift: number;
  /** 0..1 of the way to the next mini-turbo tier. */
  charge: number;
}

export interface Rig {
  state: RigState;
  update(racer: Racer, dt: number): void;
}

export function createRig(o: RigOptions): Rig {
  const chassis = o.chassis;
  const wheels = o.wheels ?? [];
  const roll = o.roll ?? 0.11;
  const driftRoll = o.driftRoll ?? 0.13;
  const pitchAmount = o.pitch ?? 0.045;
  const squat = o.squat ?? 0.05;
  const buzzAmount = o.buzz ?? 0.012;
  const stretch = o.stretch ?? 0.05;
  const stiffness = o.stiffness ?? 150;
  const damping = o.damping ?? 13;
  const hover = o.hover ?? 0;
  const hoverRate = o.hoverRate ?? 2.4;
  const yawAmount = o.yaw ?? 0;
  const seed = o.seed ?? 0;
  const phase = hash1(seed + 1.7) * 6.283;

  const restY = chassis.position.y;
  const spinAngle: number[] = wheels.map(() => 0);
  const wheelRestY: number[] = wheels.map((w) => w.obj.position.y);

  const state: RigState = {
    t: 0, speedFrac: 0, turn: 0, boost: 0, air: 0, stun: 0,
    bump: 0, accel: 0, drift: 0, charge: 0,
  };

  let bumpVel = 0;
  let lastSpeed = 0;
  let lastVelY = 0;
  let wasGrounded = true;
  let stunSpin = 0;

  return {
    state,

    update(racer: Racer, dt: number): void {
      // A capture harness can hand us a tenth of a second in one go. Clamp so
      // the springs stay stable, then substep them so the result is the same
      // shape at 20fps as at 120.
      dt = Math.min(Math.max(dt, 1 / 480), 0.1);
      state.t += dt;

      const top = Math.max(1, racer.maxSpeed);
      state.speedFrac = clamp01(Math.abs(racer.speed) / top);

      // ── inputs ──
      const d = racer.drift;
      const driftAmount = d.active ? 1 : 0;
      state.drift = damp(state.drift, d.active ? d.dir : 0, 0.0004, dt);
      state.charge = clamp01(d.charge / 2.6);

      const steer = clamp(racer.steerAngle, -1, 1);
      const turnTarget = clamp(steer * (1 - driftAmount * 0.35) + d.dir * driftAmount * 0.85, -1.4, 1.4);
      state.turn = damp(state.turn, turnTarget, 0.0009, dt);

      const boostTarget = racer.boost.time > 0 ? clamp01(0.55 + racer.boost.power / 70) : 0;
      // Fast attack, slow release: the punch lands on the frame it is earned.
      state.boost = damp(state.boost, boostTarget,
        boostTarget > state.boost ? 1e-7 : 0.015, dt);

      state.air = damp(state.air, racer.grounded ? 0 : 1, racer.grounded ? 0.0002 : 0.002, dt);
      state.stun = damp(state.stun, racer.stunned > 0 ? 1 : 0, racer.stunned > 0 ? 1e-6 : 0.004, dt);

      // Longitudinal g, from the only honest source available: the change in
      // speed. Braking dives the nose, power squats the tail.
      const raw = clamp((racer.speed - lastSpeed) / dt / 26, -1, 1);
      lastSpeed = racer.speed;
      state.accel = damp(state.accel, raw, 0.004, dt);

      // ── landing ──
      if (!racer.grounded) lastVelY = racer.vel.y;
      if (racer.grounded && !wasGrounded) {
        bumpVel -= clamp(Math.abs(lastVelY) * 0.055, 0.15, 1.5);
      }
      wasGrounded = racer.grounded;

      // ── suspension spring ──
      let remaining = dt;
      while (remaining > 0) {
        const h = Math.min(remaining, 1 / 120);
        bumpVel += (-state.bump * stiffness - bumpVel * damping) * h;
        state.bump += bumpVel * h;
        remaining -= h;
      }
      state.bump = clamp(state.bump, -0.42, 0.3);

      // ── the body ──
      const speedy = state.speedFrac;
      const buzz = racer.grounded
        ? (Math.sin(state.t * 31 + phase) * 0.6 + Math.sin(state.t * 17.3 + phase * 2)) * buzzAmount * speedy
        : 0;
      const bob = hover > 0 ? Math.sin(state.t * hoverRate + phase) * hover : 0;

      stunSpin += dt * state.stun * 11;
      const stunWobble = state.stun * Math.sin(stunSpin) * 0.32;

      chassis.position.y = restY + state.bump + buzz + bob - state.boost * squat;
      chassis.rotation.z = -state.turn * roll
        - state.drift * driftRoll * Math.abs(state.drift)
        + stunWobble;
      chassis.rotation.x = -state.accel * pitchAmount
        + state.air * 0.05
        + state.boost * 0.035
        - state.bump * 0.12;
      chassis.rotation.y = state.turn * yawAmount + state.stun * Math.sin(stunSpin * 0.7) * 0.2;

      // Squash on compression, stretch under power. Volume is roughly kept, so
      // it reads as a material rather than as a scale bug.
      const squash = clamp(-state.bump * 0.55, -0.18, 0.3);
      const pull = state.boost * stretch;
      chassis.scale.set(
        1 + squash * 0.5 - pull * 0.35,
        1 - squash + pull * 0.1,
        1 + squash * 0.5 + pull);

      // ── wheels ──
      const wheelSteer = steer * 0.44 + d.dir * driftAmount * 0.2;
      for (let i = 0; i < wheels.length; i++) {
        const w = wheels[i]!;
        const spin = w.spin ?? 1;
        if (spin !== 0) {
          // Contact-patch honest: an arc of road per second divided by the
          // radius. Wheels that lie about this are the first thing an eye
          // catches at speed.
          spinAngle[i] = (spinAngle[i]! + (racer.speed / Math.max(0.05, w.radius)) * dt * spin) % 6.283185;
          w.obj.rotation.x = spinAngle[i]!;
        }
        if (w.steer) w.obj.rotation.y = wheelSteer * w.steer;
        if (w.droop) w.obj.position.y = wheelRestY[i]! - state.air * w.droop;
      }

      // ── face ──
      if (o.face) {
        const custom = o.express?.(racer, state);
        o.face.update(dt, custom ?? {
          look: clamp(state.turn * 1.1, -1, 1),
          lookUp: state.air * 0.5 - state.boost * 0.2,
          squint: state.boost * 0.5 + speedy * 0.3,
          wide: state.air * 0.55 + state.stun * 0.8,
          angry: state.boost * 0.65 + Math.abs(state.turn) * 0.35,
          smile: 1 - state.stun * 1.6,
          open: state.boost * 0.75 + state.stun * 0.6 + state.air * 0.3,
          dizzy: state.stun,
        });
      }
    },
  };
}
