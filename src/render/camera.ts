// Chase camera.
//
// In a kart racer the camera *is* half the feel, so this file is built around
// four promises it will not break:
//
//   1. It trails the direction the kart is *travelling*, never the direction the
//      chassis happens to be pointing. A drift shows the kart's flank; a spin-out
//      spins the kart, not the world.
//   2. The kart is framed, not merely followed. The aim is derived from the
//      camera→kart vector every frame and then rotated by a fixed screen-space
//      anchor, so no amount of positional lag, teleporting or airtime can push
//      the kart out of shot.
//   3. Speed reads through the lens. Pull-back, a widening FOV and a hard punch
//      on boost — a boost has to be unmistakable with the sound off.
//   4. Nothing moves linearly. Landing dips, banking and impacts are springs and
//      decaying impulses; only the sweep is keyframed, and that is deliberate.
//
// Orientation is built as an explicit basis rather than via `lookAt`, because
// `lookAt` degenerates when the view axis approaches the up vector — exactly what
// happens at the top of a crest or in the overhead view. Building the basis by
// hand also gives exact control of roll.
//
// All of it runs in `update`, never `fixedUpdate` — the camera must never be able
// to influence the simulation.

import * as THREE from 'three';
import {
  DEG, angleDelta, clamp, clamp01, damp, dampAngle, ease, fbm1, lerp, moveToward, smootherstep,
} from '../core/math.ts';
import { getVehicle } from '../vehicles/registry.ts';
import type {
  CameraMode, GameContext, GameSystem, RaceConfig, RacePhase, Racer, SplineSample,
} from '../types.ts';

// Scratch. Nothing in this file may allocate per frame.
const _pos = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _upRef = new THREE.Vector3();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _m = new THREE.Matrix4();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

function blankSample(): SplineSample {
  return {
    pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
    right: new THREE.Vector3(), up: new THREE.Vector3(),
    width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
  };
}
const _sNear = blankSample();
const _sAhead = blankSample();
const _sGround = blankSample();

const DEFAULT_SIZE = { length: 2.2, width: 1.6, height: 1.8 };

export function createCameraSystem(ctx: GameContext): GameSystem {
  const C = ctx.config.camera;
  const M = C.modes;
  const cam = ctx.camera;

  let mode: CameraMode = 'chase';
  let phase: RacePhase = 'loading';

  // ── rig state ────────────────────────────────────────────────────────────
  // The boom is stored as an offset from the kart rather than as a world
  // position, and damped in that space. Damping a world position means the rig
  // is forever chasing a moving target, so at 55 m/s it settles five metres
  // further back than it was asked to — the kart shrinks and the framing the
  // whole file is built on quietly stops being true. In offset space steady
  // travel costs nothing and only *changes* to the pose are smoothed, which
  // leaves the speed cues to the parts of this file that are authored: the
  // pull-back curve, the lens, and the boost punch.
  let rigYaw = 0;
  let boomX = 0, boomZ = 0, camY = 0;
  let distance = C.chase.distance;
  let height = C.chase.height;
  let fov = C.fov;

  // Springs. Impulses arrive from simulation events but only ever integrate on
  // rendered frames, so every accumulator here is bounded at the source: a run
  // of events between two frames (stalled tab, frame spike, headless capture
  // stepping without drawing) must not be able to launch the rig into orbit.
  let dip = 0, dipVel = 0;
  let roll = 0, rollVel = 0;
  let trauma = 0;

  // Boost punch: a one-shot envelope rather than a damped target, so the hit
  // lands on the frame the boost fires instead of fading up over a quarter second.
  let kickT = 99, kickAmp = 0;

  // Look-behind is a snap, not a swing — 90ms of eased rotation reads as a cut
  // you can follow, and it comes back just as fast. `lookSnap` stiffens the boom
  // for the duration so the rig actually performs that rotation instead of
  // oozing around the kart over the next third of a second.
  let lookAmt = 0;
  let lookSnap = 0;

  // Drift lead survives the release of the drift: `drift.dir` clears the instant
  // the button comes up but `drift.angle` decays, so the rig eases back out.
  let lastDriftDir = 0;

  let introT = 0, introActive = false;
  let celebT = -1;

  // Framing derived from the player's vehicle. VehicleDef.size exists for this.
  let baseDist = C.chase.distance;
  let baseHeight = C.chase.height;
  let lookHeight = 1.0;

  function refreshFraming(): void {
    const p = ctx.player;
    const size = p ? getVehicle(p.vehicleId).size : DEFAULT_SIZE;
    baseDist = C.chase.distance + size.length * C.chase.distancePerLength;
    baseHeight = C.chase.height + size.height * C.chase.heightPerHeight;
    lookHeight = size.height * C.chase.lookHeight;
  }

  // ── impulses ─────────────────────────────────────────────────────────────

  function addTrauma(v: number): void {
    trauma = clamp(trauma + v, 0, 1);
  }

  function punch(power: number): void {
    kickAmp = Math.max(kickAmp * Math.exp(-kickT * C.boost.decay), clamp01(power));
    kickT = 0;
  }

  ctx.bus.on<{ mode: CameraMode }>('camera:mode', ({ mode: m }) => { mode = m; });

  ctx.bus.on<{ phase: RacePhase }>('race:phase', ({ phase: p }) => {
    phase = p;
    // Seeking straight to the countdown or the flag cuts the sweep short. The
    // aim is derived from the camera→kart vector, so the hand-off stays smooth
    // wherever in the sweep it happens.
    if (p === 'countdown' || p === 'racing') introActive = false;
  });

  ctx.bus.on('race:intro', () => { introActive = true; introT = 0; });

  ctx.bus.on<{ racer: Racer; impact: number }>('kart:land', ({ racer, impact }) => {
    if (!racer.isPlayer) return;
    dipVel = clamp(dipVel - impact * C.chase.landingDip * 26, -18, 18);
    addTrauma(impact * 0.35);
  });

  ctx.bus.on<{ racer: Racer; power: number }>('kart:boost', ({ racer, power }) => {
    if (!racer.isPlayer) return;
    const p = clamp01(power / 60);
    punch(0.45 + p * 0.55);
    addTrauma(p * ctx.config.kart.boost.shake);
  });

  ctx.bus.on<{ racer: Racer; tier: number }>('kart:drift:charge', ({ racer, tier }) => {
    // A flick as each mini-turbo tier locks in — the charge should be felt, not
    // just seen in the sparks.
    if (racer.isPlayer && tier > 0) addTrauma(0.06 * tier);
  });

  ctx.bus.on<{ racer: Racer }>('kart:hit', ({ racer }) => {
    if (racer.isPlayer) addTrauma(0.7);
  });

  ctx.bus.on<{ racer: Racer; force: number }>('kart:wall', ({ racer, force }) => {
    if (racer.isPlayer) addTrauma(force * 0.4);
  });

  ctx.bus.on<{ a: Racer; b: Racer; force: number }>('kart:bump', ({ a, b, force }) => {
    if (a.isPlayer || b.isPlayer) addTrauma(clamp01(force) * 0.18);
  });

  ctx.bus.on<{ racer: Racer }>('race:finish', ({ racer }) => {
    if (racer.isPlayer) celebT = 0;
  });

  // ── geometry helpers ─────────────────────────────────────────────────────

  /** Yaw of the kart's actual motion, falling back to its heading at low speed
   *  where the velocity vector is mostly noise. This is the single change that
   *  keeps a spin-out from spinning the whole world. */
  function travelYawOf(racer: Racer): number {
    _fwd.set(Math.sin(racer.yaw), 0, Math.cos(racer.yaw));
    const vx = racer.vel.x, vz = racer.vel.z;
    const hs = Math.hypot(vx, vz);
    if (hs < 3) return racer.yaw;
    const forwardish = vx * _fwd.x + vz * _fwd.z >= 0;
    const velYaw = forwardish ? Math.atan2(vx, vz) : Math.atan2(-vx, -vz);
    return racer.yaw + angleDelta(racer.yaw, velYaw) * clamp01((hs - 3) / 9);
  }

  /** World height of the drivable surface under an XZ position. Used to stop the
   *  lens sinking through the road on a crest or through a banked wall. */
  function surfaceYAt(x: number, z: number, probeY: number): number {
    const track = ctx.track;
    if (!track) return probeY - 100;
    _tmp.set(x, probeY, z);
    const s = track.spline.nearest(_tmp, _sGround);
    const groundY = track.course.groundY ?? 0;
    const lat = s.lateral ?? 0;
    if (Math.abs(lat) <= s.width * 0.5 + (track.course.vergeWidth ?? 5)) {
      _tmp.copy(s.pos).addScaledVector(s.right, lat);
      return Math.max(_tmp.y - 0.35, groundY);
    }
    return groundY;
  }

  /** Point the camera down `dir`, rolled by `rollAmt` about its own view axis.
   *  Explicit basis rather than lookAt: no gimbal flip looking straight down. */
  function orient(dir: THREE.Vector3, upRef: THREE.Vector3, rollAmt: number): void {
    _bz.copy(dir).normalize().negate();
    _bx.crossVectors(upRef, _bz);
    if (_bx.lengthSq() < 1e-8) {
      // View axis parallel to the reference up — pick any perpendicular.
      _bx.set(_bz.z, 0, -_bz.x);
      if (_bx.lengthSq() < 1e-8) _bx.set(1, 0, 0);
    }
    _bx.normalize();
    _by.crossVectors(_bz, _bx).normalize();
    if (rollAmt !== 0) {
      const c = Math.cos(rollAmt), s = Math.sin(rollAmt);
      const xx = _bx.x * c + _by.x * s, xy = _bx.y * c + _by.y * s, xz = _bx.z * c + _by.z * s;
      const yx = _by.x * c - _bx.x * s, yy = _by.y * c - _bx.y * s, yz = _by.z * c - _bx.z * s;
      _bx.set(xx, xy, xz);
      _by.set(yx, yy, yz);
    }
    _m.makeBasis(_bx, _by, _bz);
    cam.quaternion.setFromRotationMatrix(_m);
    cam.up.copy(_by);
  }

  /**
   * Aim at a world point, then rotate off it by a yaw and pitch lead. Because the
   * base direction is measured from wherever the camera actually ended up, the
   * subject cannot leave the frame — positional lag turns into a little parallax
   * instead of a lost kart.
   */
  function frame(target: THREE.Vector3, yawLead: number, pitchLead: number,
                 upRef: THREE.Vector3, rollAmt: number): void {
    _dir.subVectors(target, cam.position);
    const len = _dir.length();
    if (len < 1e-4) _dir.set(Math.sin(rigYaw), 0, Math.cos(rigYaw));
    else _dir.divideScalar(len);
    const aimYaw = Math.atan2(_dir.x, _dir.z) + yawLead;
    const aimPitch = clamp(Math.asin(clamp(_dir.y, -1, 1)) + pitchLead, -1.4, 1.4);
    const cp = Math.cos(aimPitch);
    _dir.set(Math.sin(aimYaw) * cp, Math.sin(aimPitch), Math.cos(aimYaw) * cp);
    orient(_dir, upRef, rollAmt);
  }

  /** Screen-space anchor expressed as an angle for the current lens. Keeping it
   *  a *fraction of the frame* rather than a fixed angle means the kart holds its
   *  position on screen while the FOV breathes with speed. */
  function framePitch(): number {
    return Math.atan(C.chase.frameLow * Math.tan(cam.fov * DEG * 0.5));
  }

  function setFov(v: number): void {
    if (Math.abs(cam.fov - v) > 0.005) {
      cam.fov = v;
      cam.updateProjectionMatrix();
    }
  }

  /** Drop the rig straight behind the kart, no damping. Used on reset and on a
   *  teleport, where chasing across the map would look broken. */
  function cutBehind(racer: Racer): void {
    rigYaw = racer.yaw;
    distance = baseDist;
    height = baseHeight;
    boomX = -Math.sin(rigYaw) * distance;
    boomZ = -Math.cos(rigYaw) * distance;
    camY = racer.pos.y + height;
    cam.position.set(racer.pos.x + boomX, camY, racer.pos.z + boomZ);
    _anchor.copy(racer.pos);
    _anchor.y += lookHeight;
    setFov(C.fov);
    fov = C.fov;
    frame(_anchor, 0, framePitch(), WORLD_UP, 0);
  }

  // ── the pre-race sweep ───────────────────────────────────────────────────

  /**
   * Three authored beats with hard cuts between them, MK-style: a low hero pass
   * across the grid, a crane down the road ahead, then a settle onto the chase
   * pose. The last beat *ends exactly on that pose*, so the hand-off into the
   * countdown is invisible rather than a snap.
   *
   * The clock is frame time, but every beat is a pure function of it, so a
   * headless capture that renders at 20fps sees the same composition as a
   * player's 60.
   */
  function updateIntro(dt: number, racer: Racer): void {
    introT += dt;
    const D = C.intro.duration;
    const t = clamp01(introT / D);
    const A = C.intro.beatA / D;
    const B = C.intro.beatB / D;

    const yaw = racer.yaw;
    _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    _right.set(_fwd.z, 0, -_fwd.x);

    let useFraming = false;
    let beatFov = C.fov;

    if (t < A) {
      // Beat 1 — low and ahead of the grid, tracking left across the field.
      // A gentle ease at each end of an otherwise constant dolly: a camera
      // operator's move, not a spreadsheet's.
      const u = t / A;
      const m = lerp(u, smootherstep(u), 0.45);
      _desired.copy(racer.pos)
        .addScaledVector(_fwd, 11.5 - 2.6 * m)
        .addScaledVector(_right, 7.0 - 2.6 * m);
      _desired.y += 1.65 + 0.7 * m;
      _anchor.copy(racer.pos).addScaledVector(_fwd, -5.5 + 1.5 * m);
      _anchor.y += 1.15;
      beatFov = 42;
    } else if (t < B) {
      // Beat 2 — CUT. Crane over the line, descending, reading the road ahead.
      const u = (t - A) / (B - A);
      const m = ease.inOutCubic(u);
      _desired.copy(racer.pos)
        .addScaledVector(_fwd, -11 + 17 * m)
        .addScaledVector(_right, -6.5 + 3.5 * m);
      _desired.y += 24 - 9.5 * m;
      _anchor.copy(racer.pos).addScaledVector(_fwd, 20 + 12 * m);
      _anchor.y += 1.0;
      beatFov = 54;
    } else {
      // Beat 3 — CUT. High behind, craning down and in, decelerating onto the
      // exact chase pose. Framed by the same code the chase uses, so the moment
      // the sweep ends nothing moves.
      const u = (t - B) / (1 - B);
      const m = ease.outCubic(u);
      _desired.copy(racer.pos)
        .addScaledVector(_fwd, -(baseDist + 12 * (1 - m)))
        .addScaledVector(_right, 5.0 * (1 - m));
      _desired.y += baseHeight + 8.0 * (1 - m);
      _anchor.copy(racer.pos);
      _anchor.y += lookHeight;
      beatFov = lerp(58, C.fov, m);
      useFraming = true;
    }

    // A breath of handheld drift. Deterministic noise, tiny amplitude — it only
    // has to stop the frame from looking nailed to a tripod.
    const n = ctx.time.elapsed * 0.7;
    _desired.x += fbm1(n) * 0.10;
    _desired.y += fbm1(n + 31.4) * 0.07;
    _desired.z += fbm1(n + 77.7) * 0.10;

    const surfY = surfaceYAt(_desired.x, _desired.z, _desired.y);
    cam.position.copy(_desired);
    cam.position.y = Math.max(cam.position.y, surfY + 0.8);

    fov = beatFov;
    setFov(beatFov);
    frame(_anchor, 0, useFraming ? framePitch() : 0, WORLD_UP, fbm1(n + 5.1) * 0.012);

    // Keep the chase rig primed so a cut-short sweep resumes cleanly: the boom
    // tracks wherever the sweep has put the lens, so when the countdown cuts in
    // the chase damps out of that pose instead of snapping to a stale one.
    rigYaw = racer.yaw;
    distance = baseDist;
    height = baseHeight;
    boomX = cam.position.x - racer.pos.x;
    boomZ = cam.position.z - racer.pos.z;
    camY = cam.position.y;

    if (t >= 1) introActive = false;
  }

  // ── main ─────────────────────────────────────────────────────────────────

  return {
    name: 'camera',
    order: 80,

    reset(cfg: RaceConfig): void {
      // Mode is sticky by design (a player can hold look-back across a lap), so
      // a new race has to put it back or a capture inherits the last shot's view.
      mode = 'chase';
      phase = ctx.race.phase;
      trauma = 0;
      dip = 0; dipVel = 0;
      roll = 0; rollVel = 0;
      kickT = 99; kickAmp = 0;
      lookAmt = 0;
      lookSnap = 0;
      lastDriftDir = 0;
      celebT = -1;
      // The race director resets first and emits `race:intro` from inside that
      // reset, so the sweep has to be armed from the config rather than from the
      // event — otherwise this line would cancel a sweep that just started.
      introActive = !cfg.instant;
      introT = 0;

      refreshFraming();
      if (ctx.player) cutBehind(ctx.player);
    },

    update(rawDt: number, alpha: number): void {
      const racer = ctx.player;
      if (!racer) return;

      // A backgrounded tab or a shader stall hands us an enormous dt. Damping
      // survives it; spring integration does not.
      const dt = clamp(rawDt, 0, 0.1);
      const sdt = Math.min(dt, 1 / 30);

      // The simulation runs at 120Hz; without this the camera inherits its
      // stair-stepping.
      _pos.lerpVectors(racer.prevPos, racer.pos, alpha);

      if (kickT < 9) kickT += dt;
      if (celebT >= 0) celebT += dt;

      if (introActive) { updateIntro(dt, racer); return; }

      const track = ctx.track;
      const K = ctx.config.kart;
      const cls = ctx.config.race.classes[ctx.race.engineClass];
      const refSpeed = Math.max(1, K.maxSpeed * cls.speedMul);
      const speedFrac = clamp01(Math.abs(racer.speed) / refSpeed);
      const boostFrac = racer.boost.time > 0 ? clamp01(racer.boost.power / 60) : 0;
      const kick = kickT < 9 && kickAmp > 0
        ? kickAmp * (kickT < C.boost.attack
            ? ease.outQuad(kickT / C.boost.attack)
            : Math.exp(-(kickT - C.boost.attack) * C.boost.decay))
        : 0;

      _anchor.copy(_pos);
      _anchor.y += lookHeight;

      // ── overhead: its own rig entirely ─────────────────────────────────
      if (mode === 'overhead') {
        cam.position.set(_pos.x, _pos.y + M.overhead.height, _pos.z);
        _fwd.set(Math.sin(racer.yaw), 0, Math.cos(racer.yaw));
        setFov(C.fov);
        fov = C.fov;
        // Straight down. `lookAt` would gimbal here; an explicit basis oriented
        // along travel makes the map read like a map.
        orient(_tmp.set(0, -1, 0), _fwd, 0);
        return;
      }

      // ── heading ────────────────────────────────────────────────────────
      const travelYaw = travelYawOf(racer);

      if (racer.drift.dir !== 0) lastDriftDir = racer.drift.dir;
      const driftAmt = clamp01(racer.drift.angle / K.drift.maxAngle);
      const driftLead = lastDriftDir * C.chase.driftYawOffset * driftAmt;

      const celeb = celebT >= 0 ? ease.inOutCubic(clamp01(celebT / C.victory.time)) : 0;

      const lookBack = ctx.inputState.look > 0.5;
      const lookWas = lookAmt;
      lookAmt = moveToward(lookAmt, lookBack ? 1 : 0, dt / 0.09);
      if (lookAmt !== lookWas) lookSnap = 0.14;
      else lookSnap = Math.max(0, lookSnap - dt);
      const lookRot = Math.PI * smootherstep(lookAmt);

      const targetYaw = travelYaw + driftLead + celeb * C.victory.orbit;
      const airEase = racer.grounded ? 1 : C.chase.airEase;

      // Two ways the kart can stop having *driven* to where it is: a respawn or
      // warp inside one fixed step, or the harness stepping the simulation for
      // seconds without drawing. Either way the rig cuts rather than sweeping
      // across the map. The single-step test catches a respawn that lands close
      // enough to slip under the distance test but still faces a new direction.
      const warped = racer.pos.distanceToSquared(racer.prevPos)
        > (4 + Math.abs(racer.speed) * ctx.config.sim.fixedDt * 3) ** 2;
      const cut = warped || cam.position.distanceToSquared(_pos) > C.chase.cutDistance ** 2;
      // Heading is corrected *before* the pose is derived from it, or the cut
      // lands the right distance away along the old heading.
      rigYaw = cut ? targetYaw
        : dampAngle(rigYaw, targetYaw, Math.min(0.9, C.chase.yawSmoothing * airEase), dt);

      const viewYaw = rigYaw + lookRot + (mode === 'front' ? Math.PI : 0);
      _fwd.set(Math.sin(viewYaw), 0, Math.cos(viewYaw));
      _right.set(_fwd.z, 0, -_fwd.x);

      // ── rig distance & height ──────────────────────────────────────────
      const md = mode === 'far' ? M.far
        : mode === 'near' ? M.near
        : mode === 'cinematic' ? M.cinematic
        : null;
      // Each beat of the countdown creeps the rig in — a tiny anticipation the
      // player reads as "about to go".
      const countIn = phase === 'countdown'
        ? C.countdown.pullback * clamp01(ctx.race.countdown / 3) : 0;

      let targetDist = baseDist + speedFrac * C.chase.speedPullback + boostFrac * 1.2
        + countIn + celeb * C.victory.distance;
      let targetHeight = baseHeight - speedFrac * C.chase.speedDrop
        + celeb * C.victory.height;
      if (md) {
        targetDist += md.distance;
        targetHeight += md.height;
      }
      if (lookAmt > 0) {
        // Looking back wants a shorter, lower lens: you are checking for a shell,
        // not admiring the scenery.
        targetDist -= lookAmt * 1.4;
        targetHeight -= lookAmt * 0.5;
      }

      distance = damp(distance, targetDist, Math.min(0.9, C.chase.posSmoothing * airEase), dt);
      height = damp(height, targetHeight, Math.min(0.9, C.chase.heightSmoothing * airEase), dt);

      // Landing dip: a spring, so it overshoots and settles rather than snapping.
      dipVel += (0 - dip) * C.chase.dipStiffness * sdt - dipVel * C.chase.dipDamping * sdt;
      dip = clamp(dip + dipVel * sdt, -3, 3);

      const effHeight = height + dip;

      // ── boom ───────────────────────────────────────────────────────────
      if (mode === 'free') {
        // Detached: hold station and keep the kart framed. Useful for looking at
        // the world without losing the subject. The boom is kept in sync so
        // switching back to a chase does not snap.
        boomX = cam.position.x - _pos.x;
        boomZ = cam.position.z - _pos.z;
        camY = cam.position.y;
      } else {
        // A slow trackside orbit on a long lens in cinematic; straight behind
        // otherwise. Deterministic either way: sim time, never a wall clock.
        const a = mode === 'cinematic' ? viewYaw + ctx.time.elapsed * M.cinematic.orbit : viewYaw;
        const wantX = -Math.sin(a) * distance;
        const wantZ = -Math.cos(a) * distance;
        // Rigid while the look-behind rotation is in flight, smoothed otherwise.
        const s = lookSnap > 0 ? 1e-7 : Math.min(0.9, C.chase.posSmoothing * airEase);
        const sy = Math.min(0.9, C.chase.heightSmoothing * airEase);
        if (cut) {
          boomX = wantX; boomZ = wantZ; camY = _pos.y + effHeight;
        } else {
          boomX = damp(boomX, wantX, s, dt);
          boomZ = damp(boomZ, wantZ, s, dt);
          // Height stays absolute rather than boom-relative: the kart's Y is the
          // noisy channel, and damping it in world space is what keeps kerbs and
          // crown out of the frame.
          camY = damp(camY, _pos.y + effHeight, sy, dt);
        }
      }

      // Never let the lens sink into the road behind a crest, or under the world.
      const floorY = surfaceYAt(_pos.x + boomX, _pos.z + boomZ, camY) + C.chase.groundClearance;
      if (camY < floorY) camY = floorY;
      // The boost punch rides *outside* the damped boom, exactly like the FOV
      // kick: run it through the smoothing and the smoothing eats it, which is
      // the difference between the kart tearing away from the lens and the lens
      // politely easing back. Snapping back and dropping at the same instant is
      // the whole shot.
      cam.position.set(
        _pos.x + boomX - Math.sin(viewYaw) * kick * C.boost.pullback,
        camY - kick * C.boost.drop,
        _pos.z + boomZ - Math.cos(viewYaw) * kick * C.boost.pullback);

      // ── aim ────────────────────────────────────────────────────────────
      // Read the road ahead and lead the aim into the corner, so the apex is on
      // screen before the kart gets there. Bounded, and faded out while looking
      // behind or in the reversed front view.
      let cornerLead = 0;
      let slopeAim = 0;
      _upRef.copy(WORLD_UP);
      if (track) {
        const s = track.spline.nearest(_pos, _sNear);
        _upRef.lerp(s.up, C.chase.trackBank).normalize();

        const ahead = C.chase.lookAhead + speedFrac * C.chase.lookAheadSpeed;
        // The spline's tangent points one way around the loop; the kart may not.
        const along = Math.sign(s.tangent.x * Math.sin(travelYaw) + s.tangent.z * Math.cos(travelYaw)) || 1;
        const a = track.spline.atDistance(s.distance + ahead * along, _sAhead);
        const aheadYaw = Math.atan2(a.tangent.x * along, a.tangent.z * along);
        cornerLead = clamp(angleDelta(travelYaw, aheadYaw) * 0.55,
          -C.chase.cornerLead, C.chase.cornerLead);
        // Follow the gradient: tip down over a crest so the landing stays in
        // frame, tip up on a climb so you can see over it.
        slopeAim = clamp(a.tangent.y * along * 0.55, -C.chase.slopeAim, C.chase.slopeAim);
      }
      const aimFade = (1 - lookAmt) * (mode === 'front' ? 0 : 1);
      cornerLead *= aimFade;
      slopeAim *= aimFade;

      // ── roll: a spring, never a lerp ───────────────────────────────────
      const targetRoll = (-racer.steerAngle * C.chase.bankRoll * (0.35 + 0.65 * speedFrac)
        - lastDriftDir * C.chase.driftRoll * driftAmt
        + kick * C.boost.roll) * (1 - 2 * lookAmt);
      rollVel += (targetRoll - roll) * C.chase.rollStiffness * sdt
        - rollVel * C.chase.rollDamping * sdt;
      roll = clamp(roll + rollVel * sdt, -0.5, 0.5);

      // ── trauma shake ───────────────────────────────────────────────────
      // One scalar decays; everything reads off its square, so a small knock
      // stays subtle while a big one genuinely rattles. Mostly rotational —
      // shoving the camera through the scenery is not a shake.
      trauma = Math.max(0, trauma - C.shake.decay * dt * 0.35);
      let shakeYaw = 0, shakePitch = 0, shakeRoll = 0;
      const sh = trauma * trauma;
      if (sh > 1e-4) {
        const n = ctx.time.elapsed * C.shake.frequency;
        const a = fbm1(n), b = fbm1(n + 19.7), c = fbm1(n + 41.3);
        cam.position.addScaledVector(_right, a * sh * C.shake.maxOffset);
        cam.position.y += b * sh * C.shake.maxOffset * 0.8;
        shakeYaw = c * sh * C.shake.maxAim;
        shakePitch = a * sh * C.shake.maxAim * 0.7;
        shakeRoll = b * sh * C.shake.maxRoll;
      }

      // ── lens ───────────────────────────────────────────────────────────
      const targetFov = C.fov
        + (md ? md.fov : 0)
        + speedFrac * C.chase.speedFov
        + boostFrac * ctx.config.kart.boost.fovKick * C.boost.fovScale
        + (phase === 'countdown' ? C.countdown.fov : 0)
        + celeb * C.victory.fov;
      fov = damp(fov, targetFov, C.fovSmoothing, dt);
      // The punch is added *after* damping. Damping a transient would swallow it,
      // and the whole point is that it lands on the frame the boost fires.
      setFov(clamp(fov + kick * C.boost.kickFov, 20, 110));

      frame(_anchor, cornerLead + shakeYaw, framePitch() + slopeAim + shakePitch,
        _upRef, roll + shakeRoll);
    },
  };
}
