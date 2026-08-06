// Chase camera.
//
// In a kart racer the camera *is* half the feel, so this file is built around
// five promises it will not break:
//
//   1. It trails the direction the kart is *travelling*, never the direction the
//      chassis happens to be pointing. A drift shows the kart's flank; a spin-out
//      spins the kart, not the world.
//   2. The kart is framed, not merely followed. The aim is derived from the
//      camera→kart vector every frame and then rotated by a screen-space anchor,
//      so no amount of positional lag, teleporting or airtime can push the kart
//      out of shot — and that anchor is what the camera *composes* with.
//   3. Committing to a drift is a camera event. Nineteen degrees of swing, a
//      pull-in, a drop, a roll and a sixth of the frame's width of throw, all on
//      one eased 0.3s clock that starts when the player asks for it. A frame
//      mid-drift must never be mistakable for the same instant driving straight.
//   4. Speed reads through the lens. Pull-back, a widening FOV and a hard punch
//      on boost — a boost has to be unmistakable with the sound off — while the
//      horizon stays put, so going faster never means seeing less road.
//   5. Nothing moves linearly. Landing dips, banking and impacts are springs and
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

  // The drift commit. This is the one move in the game that has to land on the
  // frame the player asks for it, and the smoothing constants above are an order
  // of magnitude too slow to stage it — they exist to absorb the road. So the
  // swing runs on its own eased clock and every part of it is applied *outside*
  // the dampers: the settled boom is rotated and pulled in after the fact, and
  // the screen offset is a lead on the aim. Committing is a decision, not a lag.
  let swingDir = 0;      // -1/+1, armed on the hop, confirmed on the commit
  let swingNext = 0;     // a flipped drift unwinds through zero before swinging back
  let swingU = 0;        // linear 0..1 clock
  let swingHop = 0;      // fraction of the swing the hop alone is worth
  let swingHopT = 0;     // ...and how long a hop that never lands keeps it
  let swingDepth = 1;    // how deep the drift was while it was held
  let swing = 0;         // signed, shaped — the term everything else reads

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
    const p = clamp01(power / C.boost.powerRef);
    punch(0.45 + p * 0.55);
    addTrauma(p * ctx.config.kart.boost.shake);
  });

  // The hop is the anticipation beat, and the direction is already decided by
  // then — physics arms it off the same steer threshold. Spending part of the
  // swing here is what makes the lens move with the *button* rather than with
  // the touchdown a third of a second later; the rest lands on the commit.
  ctx.bus.on<{ racer: Racer }>('kart:hop', ({ racer }) => {
    if (!racer.isPlayer) return;
    const s = ctx.inputState.steer;
    if (Math.abs(s) <= 0.2) return;
    const dir = s > 0 ? 1 : -1;
    if (swingU <= 0.02 || dir === swingDir) { swingDir = dir; swingNext = 0; }
    else swingNext = dir;
    swingHop = C.chase.driftHopLead;
    swingHopT = C.chase.driftHopGrace;
    swingDepth = 1;
  });

  ctx.bus.on<{ racer: Racer; dir: -1 | 1 }>('kart:drift:start', ({ racer, dir }) => {
    if (!racer.isPlayer) return;
    if (swingU <= 0.02 || dir === swingDir) { swingDir = dir; swingNext = 0; }
    else swingNext = dir;
    swingHop = 0;
    // A flick of trauma on the commit. The kart just changed what it is doing;
    // the lens should admit it noticed.
    addTrauma(0.05);
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

  /** The commit curve. Front-loaded rather than eased-in, so the move leaves on
   *  the first frame, and flat at the top, so it arrives without a bounce. */
  function swingShape(u: number): number {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    const e = lerp(smootherstep(u), ease.outCubic(u), C.chase.driftSwingBias);
    return clamp01(e + C.chase.driftSwingLead * Math.sin(Math.PI * u) * (1 - u));
  }

  /** An angle off the view axis expressed as a fraction of the half-frame's
   *  *width*. Keeping screen offsets in frame fractions rather than radians is
   *  what stops them breathing with the FOV. */
  function frameSide(frac: number): number {
    return Math.atan(frac * cam.aspect * Math.tan(cam.fov * DEG * 0.5));
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
      swingDir = 0; swingNext = 0; swingU = 0; swingHop = 0; swingDepth = 1; swing = 0;
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
      // stair-stepping. Clamped, because `alpha` is a blend and this rig may not
      // trust it to be one: the engine derives it from an accumulator that goes
      // negative after the harness steps the simulation without drawing, and a
      // measured alpha of -400 extrapolates the anchor two hundred metres behind
      // the kart — the camera then faithfully frames a patch of empty desert.
      // The fix belongs in the engine (vehicles interpolate off the same number),
      // but losing the kart is the one thing this file may never do.
      _pos.lerpVectors(racer.prevPos, racer.pos, clamp01(alpha));

      if (kickT < 9) kickT += dt;
      if (celebT >= 0) celebT += dt;

      if (introActive) { updateIntro(dt, racer); return; }

      const track = ctx.track;
      const K = ctx.config.kart;
      const cls = ctx.config.race.classes[ctx.race.engineClass];
      const refSpeed = Math.max(1, K.maxSpeed * cls.speedMul);
      const speedFrac = clamp01(Math.abs(racer.speed) / refSpeed);
      const boostFrac = racer.boost.time > 0 ? clamp01(racer.boost.power / C.boost.powerRef) : 0;
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

      const celeb = celebT >= 0 ? ease.inOutCubic(clamp01(celebT / C.victory.time)) : 0;

      const lookBack = ctx.inputState.look > 0.5;
      const lookWas = lookAmt;
      lookAmt = moveToward(lookAmt, lookBack ? 1 : 0, dt / 0.09);
      if (lookAmt !== lookWas) lookSnap = 0.14;
      else lookSnap = Math.max(0, lookSnap - dt);
      const lookRot = Math.PI * smootherstep(lookAmt);

      // ── the drift commit ───────────────────────────────────────────────
      // One eased 0..1 clock drives the whole gesture — swing, pull in, drop,
      // roll, and the throw across the frame — so they arrive as a single move
      // instead of four springs finding their own way there. It runs to full in
      // `driftSwingTime`, monotonically, from the moment the kart commits.
      const drifting = racer.drift.active && swingNext === 0;
      if (racer.drift.active) {
        // Missed the event (a camera built mid-drift, a replayed state): the
        // direction is on the racer either way.
        if (swingDir === 0 && racer.drift.dir !== 0) swingDir = racer.drift.dir;
        swingDepth = lerp(C.chase.driftSwingFloor, 1,
          clamp01(racer.drift.angle / K.drift.maxAngle));
      } else if (swingHop > 0) {
        // A hop that never became a drift — released, or too slow to commit —
        // gives the anticipation back rather than leaving the rig leaning on it.
        swingHopT -= dt;
        if (swingHopT <= 0 || !ctx.inputState.drift) swingHop = 0;
      }
      const swingWant = drifting ? 1 : swingNext !== 0 ? 0 : swingHop;
      swingU = moveToward(swingU, swingWant, dt / Math.max(0.02,
        swingWant > swingU ? C.chase.driftSwingTime : C.chase.driftSwingRelease));
      if (swingNext !== 0 && swingU <= 0) { swingDir = swingNext; swingNext = 0; }
      // Looking behind is a different shot; the commit has no business in it.
      swing = swingShape(swingU) * swingDepth * swingDir * (1 - lookAmt);

      const targetYaw = travelYaw + celeb * C.victory.orbit;
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

      // The boom is aimed at the *unswung* heading and the commit is rotated on
      // afterwards, so the smoothing never has to chase the swing and the swing
      // never has to wait for the smoothing.
      const rigSwing = mode === 'free' ? 0 : swing;
      const swingYaw = rigSwing * C.chase.driftYawOffset;
      const baseYaw = rigYaw + lookRot + (mode === 'front' ? Math.PI : 0);
      const viewYaw = baseYaw + swingYaw;
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

      let targetDist = baseDist + speedFrac * C.chase.speedPullback
        + boostFrac * C.boost.distance + countIn + celeb * C.victory.distance;
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
        const a = mode === 'cinematic' ? baseYaw + ctx.time.elapsed * M.cinematic.orbit : baseYaw;
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

      // The commit rides outside the boom's smoothing, exactly like the boost
      // punch below it. Rotating the *settled* boom around the kart and pulling
      // it in means the whole gesture lands on the authored curve rather than on
      // the road-absorbing damper: swing, close in, drop, in three tenths of a
      // second. Through the lens it reads as one decision.
      let armX = boomX, armZ = boomZ;
      const commit = Math.abs(rigSwing);
      if (swingYaw !== 0) {
        const cs = Math.cos(swingYaw), sn = Math.sin(swingYaw);
        armX = boomX * cs + boomZ * sn;
        armZ = boomZ * cs - boomX * sn;
      }
      if (commit > 0) {
        const len = Math.hypot(armX, armZ);
        if (len > 0.01) {
          const k = Math.max(0.3, (len - commit * C.chase.driftPullIn) / len);
          armX *= k; armZ *= k;
        }
      }

      // Never let the lens sink into the road behind a crest, or under the world.
      const floorY = surfaceYAt(_pos.x + armX, _pos.z + armZ, camY) + C.chase.groundClearance;
      if (camY < floorY) camY = floorY;
      // The boost punch rides *outside* the damped boom, exactly like the FOV
      // kick: run it through the smoothing and the smoothing eats it, which is
      // the difference between the kart tearing away from the lens and the lens
      // politely easing back. Snapping back and dropping at the same instant is
      // the whole shot. The drops may eat into the ground clearance, never
      // through it.
      const drop = commit * C.chase.driftDrop + kick * C.boost.drop;
      cam.position.set(
        _pos.x + armX - Math.sin(viewYaw) * kick * C.boost.pullback,
        Math.max(camY - drop, floorY - Math.min(drop, 0.6)),
        _pos.z + armZ - Math.cos(viewYaw) * kick * C.boost.pullback);

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
        const hereYaw = Math.atan2(s.tangent.x * along, s.tangent.z * along);
        const aheadYaw = Math.atan2(a.tangent.x * along, a.tangent.z * along);
        // Measured road-against-road, not travel-against-road. Against travel it
        // *inverts* the instant the kart out-rotates the corner — which is
        // precisely what a committed drift does — so the aim used to throw the
        // kart to the inside of the frame at the one moment the shot has to be
        // decisive, and the drift swing would be fighting it.
        cornerLead = clamp(angleDelta(hereYaw, aheadYaw) * C.chase.cornerLeadGain,
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
        - swing * C.chase.driftRoll
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
      fov = damp(fov, targetFov, targetFov > fov ? C.fovAttack : C.fovSmoothing, dt);
      // The punch is added *after* damping. Damping a transient would swallow it,
      // and the whole point is that it lands on the frame the boost fires.
      setFov(clamp(fov + kick * C.boost.kickFov, 20, 110));

      // ── framing ────────────────────────────────────────────────────────
      // Lateral lead: the road's own bend plus the drift commit. Both throw the
      // kart toward the *outside* of the corner, which is what opens the road it
      // is turning into — the composition the genre is built on. Bounded
      // together so a drift through a hairpin cannot pin the kart to the edge.
      const sideMax = frameSide(C.chase.maxFrameSide);
      const side = clamp(cornerLead + swing * aimFade * frameSide(C.chase.driftFrameSide),
        -sideMax, sideMax);

      // Horizon anchor. The pull-back and the drop between them flatten the
      // angle down to the kart as speed rises, so an uncorrected rig gives up
      // more and more of the frame to sky exactly when the player most needs to
      // read the road — you see the most sky at the moment you are fastest,
      // which is backwards. Solve for the pitch that puts the true horizon where
      // it belongs, then hold most of the way to it. Bounded so framing always
      // wins in the end, and released in the air, where following the kart
      // matters more than keeping the world level.
      let pitchLead = framePitch() + slopeAim;
      if (mode !== 'cinematic' && mode !== 'free') {
        _tmp.subVectors(_anchor, cam.position);
        const aimPitch = Math.atan2(_tmp.y, Math.hypot(_tmp.x, _tmp.z)) + pitchLead;
        const want = -Math.atan((1 - 2 * C.chase.horizonAnchor) * Math.tan(cam.fov * DEG * 0.5));
        const hold = C.chase.horizonHold * (racer.grounded ? 1 : 0.4) * aimFade * (1 - celeb);
        pitchLead += clamp((want - aimPitch) * hold, -C.chase.horizonMax, C.chase.horizonMax);
      }

      frame(_anchor, side + shakeYaw, pitchLead + shakePitch, _upRef, roll + shakeRoll);
    },
  };
}
