// Chase camera.
//
// In a kart racer the camera *is* half the feel. The rules it follows here:
//   - it trails the kart's travel direction, not its chassis yaw, so drifting
//     shows the kart side-on instead of swinging the whole world around;
//   - it pulls back and widens as speed rises, so fast feels fast;
//   - it dips on landing and kicks on boost, because unpunctuated motion reads
//     as floaty.
// All of it runs in `update`, never `fixedUpdate` — the camera must never be
// able to influence the simulation.

import * as THREE from 'three';
import { clamp, clamp01, damp, dampAngle, lerp, ease } from '../core/math.ts';
import type { CameraMode, GameContext, GameSystem, Racer } from '../types.ts';

const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export function createCameraSystem(ctx: GameContext): GameSystem {
  const C = ctx.config.camera;
  const cam = ctx.camera;

  let mode: CameraMode = 'chase';
  let yaw = 0;
  let height = C.chase.height;
  let distance = C.chase.distance;
  let fov = C.fov;
  let roll = 0;
  let dip = 0;
  let dipVel = 0;

  // Trauma-based shake: one scalar decays, and everything reads off its square
  // so small knocks stay subtle while big ones genuinely rattle.
  let trauma = 0;
  const shakeSeed = 137.17;

  let introT = 0;
  let introActive = false;

  ctx.bus.on<{ mode: CameraMode }>('camera:mode', ({ mode: m }) => { mode = m; });
  ctx.bus.on<{ racer: Racer; impact: number }>('kart:land', ({ racer, impact }) => {
    if (!racer.isPlayer) return;
    // Impulses arrive from the simulation but only integrate on rendered frames.
    // If many land between two frames — a stalled tab, a frame spike, or a
    // headless capture stepping without drawing — an unclamped accumulator
    // launches the camera into orbit. Bound it at the source.
    dipVel = clamp(dipVel - impact * C.chase.landingDip * 26, -18, 18);
    trauma = Math.min(1, trauma + impact * 0.35);
  });
  ctx.bus.on<{ racer: Racer; power: number }>('kart:boost', ({ racer, power }) => {
    if (!racer.isPlayer) return;
    trauma = Math.min(1, trauma + clamp01(power / 60) * ctx.config.kart.boost.shake);
  });
  ctx.bus.on<{ racer: Racer }>('kart:hit', ({ racer }) => {
    if (racer.isPlayer) trauma = Math.min(1, trauma + 0.7);
  });
  ctx.bus.on<{ racer: Racer; force: number }>('kart:wall', ({ racer, force }) => {
    if (racer.isPlayer) trauma = Math.min(1, trauma + force * 0.4);
  });
  ctx.bus.on('race:start', () => { introActive = false; });
  ctx.bus.on('race:intro', () => { introActive = true; introT = 0; });

  function snapBehind(racer: Racer): void {
    yaw = racer.yaw;
    _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    cam.position.copy(racer.pos).addScaledVector(_fwd, -distance).add(_v.set(0, height, 0));
    cam.lookAt(racer.pos.x, racer.pos.y + C.chase.lookHeight, racer.pos.z);
  }

  /** Sweeping pre-race flyaround, MK-style. */
  function updateIntro(dt: number, racer: Racer): void {
    introT += dt;
    const t = clamp01(introT / 3.2);
    const a = racer.yaw + Math.PI * 0.85 - t * Math.PI * 0.85;
    const r = lerp(26, C.chase.distance, ease.inOutCubic(t));
    const h = lerp(11, C.chase.height, ease.inOutCubic(t));
    _fwd.set(Math.sin(a), 0, Math.cos(a));
    cam.position.copy(racer.pos).addScaledVector(_fwd, -r).add(_v.set(0, h, 0));
    cam.lookAt(racer.pos.x, racer.pos.y + 1.0, racer.pos.z);
    cam.fov = lerp(52, C.fov, ease.inOutCubic(t));
    cam.updateProjectionMatrix();
    if (t >= 1) introActive = false;
  }

  return {
    name: 'camera',
    order: 80,

    reset(): void {
      const p = ctx.player;
      // Mode is sticky by design (the player can hold look-back across a lap),
      // so a new race has to put it back or a capture inherits the previous
      // shot's camera.
      mode = 'chase';
      introActive = false;
      trauma = 0; dip = 0; dipVel = 0; roll = 0;
      distance = C.chase.distance;
      height = C.chase.height;
      fov = C.fov;
      if (p) snapBehind(p);
    },

    update(dt: number, alpha: number): void {
      const racer = ctx.player;
      if (!racer) return;

      // Interpolate the kart's rendered position, or the camera inherits the
      // 120Hz sim's stair-stepping.
      _v.lerpVectors(racer.prevPos, racer.pos, alpha);

      if (introActive) { updateIntro(dt, racer); return; }

      if (mode === 'overhead') {
        cam.position.set(_v.x, _v.y + 60, _v.z + 0.01);
        cam.lookAt(_v);
        return;
      }

      const speedFrac = clamp01(racer.speed / Math.max(1, ctx.config.kart.maxSpeed));
      const boostFrac = racer.boost.time > 0 ? clamp01(racer.boost.power / 60) : 0;

      // Follow the direction of travel where there is meaningful speed, so a
      // drift shows the kart's flank instead of whipping the camera around.
      let targetYaw = racer.yaw;
      if (racer.drift.active) {
        targetYaw = racer.yaw + racer.drift.dir * C.chase.driftYawOffset;
      }
      if (mode === 'front') targetYaw += Math.PI;

      const lookBack = ctx.inputState.look > 0.5;
      if (lookBack) targetYaw += Math.PI;

      // Beyond a sane trailing distance the kart did not drive away — it was
      // teleported (respawn, warp, or a headless capture stepping the simulation
      // without rendering). Chasing that across the map looks broken, so the
      // whole rig cuts to the new position. Heading has to be corrected *before*
      // the desired position is derived from it, or the cut lands the camera the
      // right distance away along the old heading.
      const teleported = cam.position.distanceToSquared(_v) > 80 * 80;

      const yawSmooth = racer.grounded ? C.chase.yawSmoothing : C.chase.yawSmoothing * 4;
      yaw = teleported ? targetYaw : dampAngle(yaw, targetYaw, yawSmooth, dt);

      const modeDist = mode === 'far' ? 4.5 : mode === 'near' ? -2.2 : 0;
      const targetDist = C.chase.distance + modeDist
        + speedFrac * C.chase.speedPullback + boostFrac * 1.4;
      const targetHeight = C.chase.height + (mode === 'far' ? 1.6 : 0) + speedFrac * 0.5;
      distance = damp(distance, targetDist, C.chase.posSmoothing, dt);
      height = damp(height, targetHeight, C.chase.posSmoothing, dt);

      // Landing dip as a spring, so it overshoots and settles instead of snapping.
      dipVel += (0 - dip) * 90 * dt - dipVel * 11 * dt;
      dip = clamp(dip + dipVel * dt, -3, 3);

      _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
      _desired.copy(_v)
        .addScaledVector(_fwd, -distance)
        .add(_up.clone().multiplyScalar(height + dip));

      // Position is damped rather than snapped; the kart can out-run the camera
      // for a few frames on a hard boost, which is exactly what sells the speed.
      if (teleported) {
        cam.position.copy(_desired);
      } else {
        const posSmooth = racer.grounded ? C.chase.posSmoothing : C.chase.posSmoothing * 6;
        cam.position.x = damp(cam.position.x, _desired.x, posSmooth, dt);
        cam.position.y = damp(cam.position.y, _desired.y, posSmooth * 0.6, dt);
        cam.position.z = damp(cam.position.z, _desired.z, posSmooth, dt);
      }

      _look.copy(_v)
        .addScaledVector(_fwd, C.chase.lookAhead * (lookBack ? -0.4 : 1))
        .add(_up.clone().multiplyScalar(C.chase.lookHeight));

      // Bank the camera into the turn — small, but it reads as weight.
      const targetRoll = -racer.steerAngle * C.chase.bankRoll
        - (racer.drift.active ? racer.drift.dir * 0.05 : 0);
      roll = damp(roll, targetRoll, 0.002, dt);

      // Shake: decays quadratically, drives offset and roll together.
      trauma = Math.max(0, trauma - C.shake.decay * dt * 0.35);
      const shake = trauma * trauma;
      if (shake > 0.0001) {
        const t = ctx.time.elapsed * 34;
        const sx = Math.sin(t * 1.7 + shakeSeed) * Math.sin(t * 0.9);
        const sy = Math.sin(t * 2.3 + shakeSeed * 2) * Math.sin(t * 1.1);
        cam.position.x += sx * shake * C.shake.maxOffset;
        cam.position.y += sy * shake * C.shake.maxOffset * 0.7;
        roll += sx * shake * C.shake.maxRoll;
      }

      cam.up.set(Math.sin(roll), Math.cos(roll), 0).applyAxisAngle(_up, yaw);
      cam.lookAt(_look);

      // FOV widens with speed and punches on boost — the cheapest, strongest
      // speed cue there is.
      const targetFov = C.fov + speedFrac * C.chase.speedFov
        + boostFrac * ctx.config.kart.boost.fovKick;
      fov = damp(fov, targetFov, 0.02, dt);
      if (Math.abs(cam.fov - fov) > 0.01) {
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
    },
  };
}
