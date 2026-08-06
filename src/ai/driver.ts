// CPU drivers.
//
// The AI does not cheat by driving on rails: it produces the same input struct a
// human produces and hands it to the same physics. That keeps the field honest —
// if the karts feel bad to drive, the AI looks bad too, which is a useful alarm.
//
// Each driver aims at a point ahead on the racing line, offset by a personal
// bias so the pack fans out through corners instead of forming a single-file
// train.

import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/math.ts';
import type { AiDriver, GameContext, GameSystem, Racer, SplineSample } from '../types.ts';
import type { InputState } from '../core/input.ts';

const _target = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _sample: SplineSample = {
  pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
  right: new THREE.Vector3(), up: new THREE.Vector3(),
  width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
};

function blankInput(): InputState {
  return {
    steer: 0, accel: 0, brake: 0, drift: false, item: false, look: 0,
    pressed: {}, anyInput: false, source: 'keyboard',
  };
}

export function createAiDriver(ctx: GameContext, skill: number, linePreference: number): AiDriver {
  let driftHold = 0;
  let driftCooldown = 0;
  let reaction = 0;
  let steerMemory = 0;

  return {
    skill,
    linePreference,

    update(racer: Racer, dt: number): void {
      const track = ctx.track;
      const input = (racer.aiInput ??= blankInput());
      input.pressed = {};

      if (!track || racer.finished) {
        input.accel = racer.finished ? 0 : 1;
        input.steer = 0;
        input.brake = 0;
        input.drift = false;
        return;
      }

      const here = track.spline.nearest(racer.pos, _sample);

      // Look further ahead the faster we are going, so high speed reads as
      // smoother lines rather than frantic corrections.
      const speedFrac = clamp01(racer.speed / Math.max(1, ctx.config.kart.maxSpeed));
      const lookahead = ctx.config.ai.lookahead * lerp(0.55, 1.5, speedFrac);
      const aheadSample = track.spline.atDistance(here.distance + lookahead, undefined);

      // Aim wide on entry and tight at the apex — a crude but effective line.
      const curvature = aheadSample.curvature;
      const apexBias = clamp(-curvature * 320, -1, 1) * (aheadSample.width * 0.28);
      const lateral = clamp(
        apexBias + linePreference,
        -aheadSample.width * 0.42,
        aheadSample.width * 0.42);

      track.spline.pointAt(here.distance + lookahead, lateral, 0.5, _target);

      _toTarget.subVectors(_target, racer.pos);
      _toTarget.y = 0;
      _fwd.set(Math.sin(racer.yaw), 0, Math.cos(racer.yaw));

      // Signed angle to the target: positive means it is to our right.
      const cross = _fwd.x * _toTarget.z - _fwd.z * _toTarget.x;
      const dot = _fwd.dot(_toTarget);
      const angle = Math.atan2(-cross, dot);

      // Reaction delay stops the AI from being inhumanly precise.
      reaction -= dt;
      if (reaction <= 0) {
        reaction = ctx.config.ai.reactionTime * lerp(1.6, 0.4, skill);
        steerMemory = clamp(angle * 2.1, -1, 1);
      }
      input.steer = steerMemory;

      // Brake for corners that are genuinely too fast to take flat.
      const cornerSeverity = Math.abs(aheadSample.curvature) * 240;
      const comfortable = lerp(0.55, 1.0, skill);
      const tooFast = speedFrac > comfortable / Math.max(0.35, cornerSeverity);
      input.accel = tooFast ? 0.35 : 1;
      input.brake = tooFast && speedFrac > 0.85 ? 0.4 : 0;

      // Recover if we have drifted off the road entirely.
      if (!here.onRoad && Math.abs(here.lateral ?? 0) > here.width * 0.7) {
        input.accel = 1;
        input.brake = 0;
      }

      // Drift through sustained corners, weighted by skill.
      driftCooldown = Math.max(0, driftCooldown - dt);
      const wantsDrift =
        Math.abs(angle) > 0.22 &&
        cornerSeverity > 0.5 &&
        racer.speed > ctx.config.kart.drift.minSpeed * 1.2 &&
        ctx.config.ai.driftSkill * skill > 0.4;

      if (wantsDrift && driftCooldown <= 0) {
        driftHold += dt;
        // Hold long enough to bank a mini-turbo, then release.
        const tiers = ctx.config.kart.drift.tiers;
        const targetTier = skill > 0.85 ? 2 : skill > 0.65 ? 1 : 0;
        const targetCharge = tiers[targetTier]!.at + 0.15;
        input.drift = racer.drift.charge < targetCharge;
        if (!input.drift) { driftHold = 0; driftCooldown = 0.5; }
      } else {
        input.drift = false;
        driftHold = 0;
      }

      input.anyInput = true;
    },
  };
}

export function createAiSystem(ctx: GameContext): GameSystem {
  return {
    // Must run before physics (order 30): the AI authors the input that physics
    // then consumes in the same step. Running after would lag it by one frame.
    name: 'ai',
    order: 25,

    fixedUpdate(dt: number): void {
      if (ctx.race.phase !== 'racing' && ctx.race.phase !== 'countdown' && ctx.race.phase !== 'finished') return;

      for (const racer of ctx.racers) {
        if (!racer.ai) continue;

        if (ctx.race.phase === 'countdown') {
          // Hold accelerate near the end of the countdown for a rocket start.
          const input = (racer.aiInput ??= blankInput());
          const wantsRocket = racer.ai.skill > 0.5;
          input.accel = wantsRocket && ctx.race.countdown <= 1 ? 1 : 0;
          input.steer = 0;
          input.brake = 0;
          input.drift = false;
          continue;
        }

        racer.ai.update(racer, dt);
      }

      applyRubberBand();
    },
  };

  /**
   * Keeps the race close. Racers behind the player get a small speed bonus and
   * racers ahead get a small penalty, scaled by how far apart they are — enough
   * to prevent blowouts, gentle enough that it is not visible.
   *
   * This writes `rubberBand`, which physics folds into top speed. Writing
   * `maxSpeed` directly would not survive: physics recomputes it every step.
   */
  function applyRubberBand(): void {
    const player = ctx.player;
    if (!player || !ctx.track) return;
    const rb = ctx.config.ai.rubberBand;

    for (const racer of ctx.racers) {
      if (!racer.ai) continue;
      const gap = racer.progress - player.progress;
      const t = clamp01(Math.abs(gap) / rb.range);
      racer.rubberBand = gap > 0 ? lerp(1, rb.ahead, t) : lerp(1, rb.behind, t);
    }
  }
}
