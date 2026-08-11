// The things on this cup that move, and the only things on it that can touch
// you.
//
// ── why this file exists ───────────────────────────────────────────────────
//
// A critic played the four rounds and rejected them on one sentence: *"nothing
// on any of the four courses can ever touch the player, so each course is a
// shape to be driven rather than a place that fights back."* The proof was a
// single grep. `stunRacer` — physics' own published entry point for "something
// just happened to this kart" — had **exactly one caller in the entire game**,
// `src/items/index.ts`, and neither `track/` nor `world/` imported physics at
// all. Four circuits stamped `cup: 'hazard'` and not one hazard between them.
//
// This is the second caller.
//
// ── what a hazard is, mechanically ─────────────────────────────────────────
//
// A `HazardDef` (see `types.ts`) is a lap fraction, a lateral, a kind and a
// **period**. Everything else is derived. Each fixed step this system resolves
// every hazard's cycle phase from `ctx.time.elapsed`, moves its bodies, and
// tests them against every racer. There is no `Math.random` anywhere in the
// file and no wall-clock read anywhere in the file, so the dumper is in the
// same place at t=41.7s on a reviewer's software rasteriser as it is on a
// gaming laptop, and a capture of the same seed twice is the same picture.
//
// ── how it hits ────────────────────────────────────────────────────────────
//
// Through `stunRacer`, which is the whole point. That routine already writes
// `stunned`, `effects`, `invulnerable`, the speed cut and — crucially — emits
// `kart:hit`, which `fx/`, `render/camera.ts` and `ui/hud.ts` are all already
// listening for. Reimplementing any of that here would have produced a hazard
// that stopped a kart without shaking the camera or marking the HUD, which is
// how you can tell a bolt-on from a feature. The one thing `kart:hit` does not
// carry a listener for is sound (audio hangs its impacts off `item:strike`,
// which belongs to items and would be a lie coming from a rock), so the cue is
// played from here, by id, off the same bank everything else uses.
//
// ── the contact test, and why it is capsules ───────────────────────────────
//
// Every body in this file — a dumper, a boulder, a wall of brine, a boom arm —
// is a **capsule in the hazard's own road frame**: a segment and a radius. One
// routine tests all of them, it costs four dot products and a clamp per body
// per racer, and with at most four bodies on any course and eight racers that
// is 32 tests a step. The alternative was four different swept-volume tests
// with four different bugs in them.
//
// The frame is built once, at `track:built`, from the spline sample at the
// crossing: `+x` is the spline's `right` (the driver's *left* — the same frame
// every other feature in `types.ts` is quoted in), `+y` is `up`, `+z` is the
// tangent. Nothing queries the spline again after the build, so a hazard costs
// no spline work at all in the hot path.
//
// ── the two fairness rules, and where they are enforced ────────────────────
//
// *Readable at 100m* is geometry: nothing here is under six metres in its long
// axis, everything is painted in the cup's black-and-gold hazard livery, and
// everything moves — the eye finds motion in the periphery before it finds
// colour. *Telegraphed a full second before arrival* is the sign: every hazard
// plants a diamond on the verge `signAt` metres upstream with two lamps on it,
// and the lamps come on `lead` seconds before the body reaches the tarmac.
// `armed` is computed in the simulation and only *drawn* per frame, so what the
// lamps say and what the hazard is about to do cannot come apart.

import * as THREE from 'three';
import { stunRacer } from '../../physics/kart.ts';
import { surfaceHeight } from '../geom.ts';
import { features, type HazardDef, type HazardKind } from './types.ts';
import type { GameContext, GameSystem, Racer, SplineSample, Track } from '../../types.ts';

// ── house livery ───────────────────────────────────────────────────────────
const GOLD = 0xffc300;
const ORANGE = 0xff6b1a;
const NIGHT = 0x22242b;
const STEEL = 0x8d93a2;
const WHITE = 0xfff8f0;
const RED = 0xe03a2a;

/** Metres of kart, for the contact test. Half a kart plus a little grace. */
const KART_R = 1.15;

/**
 * Metres a second below which a racer cannot be hit by anything in this file.
 *
 * The anti-pin rule. See the note at the call site: without it a hazard on a
 * cycle shorter than its own stun is a trap a kart never gets out of.
 */
const HIT_MIN_SPEED = 4;

/** Seconds before the same racer can be hit again by anything here. */
const HIT_COOLDOWN = 2.4;

/** Default metres upstream the warning sign stands. */
const SIGN_BACK = 78;

const TAU = Math.PI * 2;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const wrap01 = (v: number): number => v - Math.floor(v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** 0 below `a`, 1 above `b`, eased between. */
const ramp = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a || 1));
  return t * t * (3 - 2 * t);
};
/** A triangular pulse: 0 at the ends of `[a,b]`, 1 in the middle. */
const pulse = (a: number, b: number, v: number): number =>
  v <= a || v >= b ? 0 : 1 - Math.abs((v - a) / (b - a) - 0.5) * 2;

// ── scratch ────────────────────────────────────────────────────────────────
// Nothing in `fixedUpdate` or `update` may allocate; these are the whole of it.
const _p = new THREE.Vector3();
const _basis = new THREE.Matrix4();

/**
 * One moving part, in its hazard's local road frame.
 *
 * `a`→`b` is the segment and `r` the radius, so a boulder is a capsule with
 * `a === b` and a dumper is a capsule seven metres long. `live` is whether it
 * can hurt anybody this step — a boulder still twenty metres up in the air is
 * drawn and is not live.
 */
interface Body {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  r: number;
  live: boolean;
}

const body = (): Body => ({ ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, r: 1, live: false });

/** A capsule set to a single point — a boulder, a rock, a spray head. */
function ball(b: Body, x: number, y: number, z: number, r: number, live: boolean): void {
  b.ax = b.bx = x; b.ay = b.by = y; b.az = b.bz = z; b.r = r; b.live = live;
}

interface Hazard {
  def: HazardDef;
  kind: HazardKind;
  /** Road frame at the crossing. */
  origin: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  fwd: THREE.Vector3;
  /** Half the road, metres, at the crossing. */
  half: number;
  /** Every body, in local coordinates. Fixed length — never reallocated. */
  bodies: Body[];
  /** Radius that bounds every body, for the cheap reject. */
  reach: number;
  group: THREE.Group;
  sign: SignRig | null;
  /** Moving parts the visual pass drives. */
  rig: Rig;
  /** 0..1: how loudly the sign is warning, this step. */
  armed: number;
  /** Seconds; counts down while the sign is lit, for the ticking cue. */
  tick: number;
  /** Cycle phase at the previous rendered frame, for the one-shot accents. */
  lastU: number;
  /** The cue this hazard plays when it first arms, and when it lands a hit. */
  period: number;
  phase: number;
}

/** The animated nodes each kind needs. Unused slots stay null. */
interface Rig {
  chassis: THREE.Object3D | null;
  tray: THREE.Object3D | null;
  wheels: THREE.Object3D[];
  rocks: THREE.Object3D[];
  wall: THREE.Object3D | null;
  crest: THREE.Object3D | null;
  arm: THREE.Object3D | null;
  beacons: THREE.Mesh[];
}

const emptyRig = (): Rig => ({
  chassis: null, tray: null, wheels: [], rocks: [],
  wall: null, crest: null, arm: null, beacons: [],
});

interface SignRig {
  group: THREE.Group;
  lamps: THREE.Mesh[];
  plate: THREE.Mesh;
}

// ── the cycle ──────────────────────────────────────────────────────────────
//
// Every kind reads one number, `u` — 0..1 through the period — and every kind's
// motion is written once, here, as a handful of cycle fractions. `resolve()`
// moves the bodies off them and `crossWindow()` computes the telegraph off the
// *same* numbers, so the lamps and the machine cannot come apart. Mirroring the
// window as a second hand-written pair was the obvious build and it is the one
// way this feature can lie to a player.

/** The dumper's shuttle: out loaded, tip, back empty, load again. */
const TRUCK = {
  /** Metres either side of the centreline the machine parks at. */
  bay: 27,
  /** Half the danger band across the road: the capsule plus a kart. */
  guard: 3.3 + 2.55 + KART_R,
  // 0.22 of a 24-second cycle to cover 54 metres is 10 m/s, which is what a
  // loaded articulated dumper actually does. Tuning this is tuning the truck's
  // *speed*, and a machine that size crossing at forty is a cartoon.
  out0: 0.05, out1: 0.27,
  tip0: 0.31, tip1: 0.47,
  back0: 0.52, back1: 0.74,
};

/** The rockfall: released, 1.4s of air, sat in the lane, pushed off. */
const ROCK = { drop: 0.20, fallSec: 1.4, clear: 0.40, gone: 0.47, top: 20 };

/** The bore: in off the pan, over the lane, and drained back. */
const SURGE = { in0: 0.10, in1: 0.24, hold: 0.29, out1: 0.40, gone: 0.46 };

/** The gate: shut, held, opened. */
const BOOM = { shut0: 0.14, shut1: 0.24, open0: 0.44, open1: 0.52 };

/**
 * `[start, end]` windows, in cycle fraction, where the body is over tarmac.
 *
 * Derived, never declared. For the dumper that means solving for the two
 * fractions of its traverse at which a machine `guard` metres wide first and
 * last overlaps a road `half` metres wide — which is why a hazard has to be
 * passed in rather than only its kind.
 */
function crossWindow(h: Hazard, out: [number, number][]): [number, number][] {
  out.length = 0;
  switch (h.kind) {
    case 'truck': {
      const f = clamp01((TRUCK.bay - (h.half + TRUCK.guard)) / (2 * TRUCK.bay));
      const a = TRUCK.out1 - TRUCK.out0;
      const b = TRUCK.back1 - TRUCK.back0;
      out.push([TRUCK.out0 + a * f, TRUCK.out0 + a * (1 - f)]);
      out.push([TRUCK.back0 + b * f, TRUCK.back0 + b * (1 - f)]);
      break;
    }
    case 'rockfall':
      out.push([ROCK.drop, ROCK.gone]);
      break;
    case 'surge':
      out.push([SURGE.in0, SURGE.out1]);
      break;
    case 'boom':
      out.push([BOOM.shut0, BOOM.open1]);
      break;
  }
  return out;
}

// ── build ──────────────────────────────────────────────────────────────────

function mat(color: number, opts: THREE.MeshLambertMaterialParameters = {}): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, ...opts });
}

function box(
  w: number, h: number, d: number, m: THREE.Material,
  x = 0, y = 0, z = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * The hazard stripe, painted as a texture rather than as geometry.
 *
 * Diagonal gold-on-black at 45°, which is the cup's own livery — the gate
 * blocks in `road.ts` use the same two colours — and the single most legible
 * thing this game can put on a moving object. One canvas, shared by every
 * striped part of every hazard on the course.
 */
function stripeTexture(a = NIGHT, b = GOLD): THREE.Texture {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = `#${a.toString(16).padStart(6, '0')}`;
  g.fillRect(0, 0, S, S);
  g.strokeStyle = `#${b.toString(16).padStart(6, '0')}`;
  g.lineWidth = S * 0.32;
  g.lineCap = 'square';
  for (let i = -1; i < 3; i++) {
    g.beginPath();
    g.moveTo(i * S - S, S * 2);
    g.lineTo(i * S + S, 0);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The warning sign's face: a black pictogram on the hazard yellow diamond.
 *
 * Four pictograms, one per kind, drawn as flat shapes at a size that survives
 * a hundred metres of perspective — a lorry seen from the side, three rocks
 * coming off a slope, three waves, a barrier arm coming down. Anything with
 * more detail than this is a grey smudge from the braking point, which is the
 * only place the sign is ever read from.
 */
function signTexture(kind: HazardKind): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#FFC300';
  g.fillRect(0, 0, S, S);
  // The black rim, inset, following the square (the plate is rotated 45° in
  // world space so this comes out as a diamond border).
  g.strokeStyle = '#22242B';
  g.lineWidth = S * 0.075;
  g.strokeRect(S * 0.085, S * 0.085, S * 0.83, S * 0.83);
  g.fillStyle = '#22242B';
  g.strokeStyle = '#22242B';
  g.lineCap = 'round';
  g.lineJoin = 'round';

  const cx = S * 0.5;
  if (kind === 'truck') {
    // A dumper, side on: tray, cab, two big wheels.
    g.beginPath();
    g.moveTo(S * 0.20, S * 0.58); g.lineTo(S * 0.80, S * 0.58);
    g.lineTo(S * 0.74, S * 0.34); g.lineTo(S * 0.34, S * 0.34);
    g.closePath(); g.fill();
    g.fillRect(S * 0.16, S * 0.46, S * 0.16, S * 0.16);
    g.beginPath(); g.arc(S * 0.30, S * 0.66, S * 0.09, 0, TAU); g.fill();
    g.beginPath(); g.arc(S * 0.66, S * 0.66, S * 0.09, 0, TAU); g.fill();
  } else if (kind === 'rockfall') {
    // Rocks coming off a slope, which is the international sign for it.
    g.lineWidth = S * 0.055;
    g.beginPath(); g.moveTo(S * 0.26, S * 0.22); g.lineTo(S * 0.26, S * 0.74);
    g.lineTo(S * 0.80, S * 0.74); g.stroke();
    const rock = (x: number, y: number, r: number): void => {
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + 0.4;
        const rr = r * (i % 2 ? 0.78 : 1);
        const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath(); g.fill();
    };
    rock(S * 0.42, S * 0.34, S * 0.085);
    rock(S * 0.58, S * 0.52, S * 0.11);
    rock(S * 0.70, S * 0.68, S * 0.07);
  } else if (kind === 'surge') {
    // Three waves.
    g.lineWidth = S * 0.06;
    for (let i = 0; i < 3; i++) {
      const y = S * (0.36 + i * 0.15);
      g.beginPath();
      g.moveTo(S * 0.20, y);
      g.bezierCurveTo(S * 0.35, y - S * 0.10, S * 0.45, y + S * 0.10, S * 0.58, y);
      g.bezierCurveTo(S * 0.68, y - S * 0.08, S * 0.74, y + S * 0.06, S * 0.82, y);
      g.stroke();
    }
  } else {
    // A barrier arm coming down onto its post.
    g.lineWidth = S * 0.055;
    g.beginPath(); g.moveTo(S * 0.24, S * 0.30); g.lineTo(S * 0.24, S * 0.76); g.stroke();
    g.save();
    g.translate(S * 0.24, S * 0.36);
    g.rotate(0.42);
    g.fillRect(0, -S * 0.045, S * 0.56, S * 0.09);
    g.restore();
    g.beginPath(); g.arc(cx * 0.48, S * 0.36, S * 0.045, 0, TAU); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The sign, and it is the same object on all four rounds.
 *
 * That sameness is the design. A works site says *what is about to happen to
 * you* with one shape of plate in one colour, everywhere, and a player who
 * learns the diamond on round one reads it on round four without being taught
 * again. Only the pictogram and the lamps' rhythm change.
 */
function buildSign(kind: HazardKind, stripe: THREE.Texture, keep: THREE.Material[]): SignRig {
  const group = new THREE.Group();

  const postMat = mat(STEEL);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 3.1, 8), postMat);
  post.position.y = 1.55;
  post.castShadow = true;
  group.add(post);

  // A striped skirt at the foot, so the post reads as works kit rather than as
  // a lamp standard.
  const skirtMat = new THREE.MeshLambertMaterial({ map: stripe });
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.46, 0.85, 8), skirtMat);
  skirt.position.y = 0.42;
  skirt.castShadow = true;
  skirt.receiveShadow = true;
  group.add(skirt);

  const faceTex = signTexture(kind);
  const plateMat = new THREE.MeshLambertMaterial({ map: faceTex, side: THREE.DoubleSide });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(2.15, 2.15), plateMat);
  plate.position.set(0, 3.5, 0.06);
  plate.rotation.z = Math.PI * 0.25;
  plate.castShadow = true;
  group.add(plate);

  // The back of the plate, so it is not a hole in the world from behind.
  const backMat = mat(0x4a4e58);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(2.15, 2.15), backMat);
  back.position.set(0, 3.5, -0.02);
  back.rotation.set(0, Math.PI, Math.PI * 0.25);
  group.add(back);

  // Two lamps above the plate. `MeshBasicMaterial` deliberately: a lamp that
  // is shaded by the sun is a lens, not a light.
  const lamps: THREE.Mesh[] = [];
  for (const x of [-0.9, 0.9]) {
    const m = new THREE.MeshBasicMaterial({ color: RED });
    keep.push(m);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), m);
    lamp.position.set(x, 5.0, 0.1);
    group.add(lamp);
    const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.16, 8), postMat);
    hood.position.set(x, 5.28, 0.1);
    group.add(hood);
    lamps.push(lamp);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.12), postMat);
  bar.position.set(0, 4.86, 0.1);
  group.add(bar);

  keep.push(postMat, skirtMat, plateMat, backMat);
  return { group, lamps, plate };
}

/** A beacon: the orange dome on a machine's roof. Basic, so it never goes dark. */
function beacon(x: number, y: number, z: number, keep: THREE.Material[]): THREE.Mesh {
  const m = new THREE.MeshBasicMaterial({ color: ORANGE });
  keep.push(m);
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8, 0, TAU, 0, Math.PI * 0.62), m);
  b.position.set(x, y, z);
  return b;
}

/**
 * The dumper. Nine and a half metres of articulated quarry truck, and the
 * largest single object that moves in this game.
 *
 * Built long-axis along local **x**, because it crosses the road rather than
 * driving down it: the 4.8m that a kart has to get past is measured along the
 * road, and the 9.5m that make it unmissable are measured across it.
 */
function buildTruck(rig: Rig, stripe: THREE.Texture, keep: THREE.Material[]): THREE.Group {
  const g = new THREE.Group();
  const yellowM = mat(GOLD);
  const darkM = mat(NIGHT);
  const trayM = mat(0x585c66);
  const rockM = mat(0x7d7568, { flatShading: true });
  const glassM = mat(0x1b3550, { emissive: 0x0a1626 });
  const stripeM = new THREE.MeshLambertMaterial({ map: stripe });
  keep.push(yellowM, darkM, trayM, rockM, glassM, stripeM);

  const chassis = new THREE.Group();

  // Frame and the deck it carries.
  chassis.add(box(9.0, 0.85, 4.0, yellowM, 0, 1.55, 0));
  chassis.add(box(9.4, 0.5, 3.2, darkM, 0, 1.05, 0));

  // The tray, hinged at the back so it can tip. Its own group, pivoting about
  // local -x, which is the rear of the machine.
  const tray = new THREE.Group();
  tray.position.set(-4.1, 2.0, 0);
  const shell = box(8.2, 0.35, 4.4, trayM, 4.1, 0.1, 0);
  tray.add(shell);
  tray.add(box(8.2, 1.5, 0.32, trayM, 4.1, 0.85, 2.05));
  tray.add(box(8.2, 1.5, 0.32, trayM, 4.1, 0.85, -2.05));
  tray.add(box(0.32, 2.6, 4.4, trayM, 0.16, 1.4, 0));
  // The canopy over the cab, which is what makes it a quarry dumper and not a
  // tipper: the tray's front wall rises over the driver.
  tray.add(box(2.6, 0.3, 4.4, trayM, 1.4, 2.65, 0));
  // A load of shot rock, so the machine has a reason to be crossing.
  for (let i = 0; i < 7; i++) {
    const s = 0.75 + (i % 3) * 0.28;
    const r = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), rockM);
    r.position.set(1.6 + i * 0.95, 0.55 + (i % 2) * 0.25, ((i * 7) % 5 - 2) * 0.62);
    r.rotation.set(i * 1.1, i * 0.7, i * 0.4);
    r.castShadow = true;
    tray.add(r);
  }
  chassis.add(tray);
  rig.tray = tray;

  // Cab, tucked under the canopy on the leading side.
  chassis.add(box(2.0, 1.5, 2.3, yellowM, 3.3, 2.75, -0.7));
  const glass = box(2.05, 0.85, 2.35, glassM, 3.3, 3.05, -0.7);
  glass.castShadow = false;
  chassis.add(glass);
  // Hazard flashes down both flanks, which is what reads from a kart.
  const flank = new THREE.Mesh(new THREE.BoxGeometry(9.0, 0.72, 0.14), stripeM);
  (flank.material as THREE.MeshLambertMaterial).map!.repeat.set(10, 1);
  flank.position.set(0, 1.5, 2.09);
  chassis.add(flank);
  const flank2 = flank.clone();
  flank2.position.z = -2.09;
  chassis.add(flank2);

  // Wheels: two front, four rear in pairs. Cylinders lying along z, because
  // the machine travels along x.
  const tyreM = mat(0x191b20);
  const hubM = mat(0xb9bec8);
  keep.push(tyreM, hubM);
  const tyreGeo = new THREE.CylinderGeometry(1.35, 1.35, 1.0, 14);
  const hubGeo = new THREE.CylinderGeometry(0.5, 0.5, 1.06, 10);
  const at = [
    [3.2, 0], [-2.3, -0.62], [-2.3, 0.62], [-3.7, -0.62], [-3.7, 0.62],
  ] as const;
  for (const [x, zo] of at) {
    for (const s of x > 0 ? [-1.55, 1.55] : [zo < 0 ? -1.75 : 1.75]) {
      const w = new THREE.Group();
      const t = new THREE.Mesh(tyreGeo, tyreM);
      t.rotation.x = Math.PI * 0.5;
      t.castShadow = true;
      w.add(t);
      const h = new THREE.Mesh(hubGeo, hubM);
      h.rotation.x = Math.PI * 0.5;
      w.add(h);
      w.position.set(x, 1.35, s);
      chassis.add(w);
      rig.wheels.push(w);
    }
  }

  rig.beacons.push(beacon(3.3, 3.72, -0.7, keep));
  rig.beacons.push(beacon(2.2, 3.4, 1.0, keep));
  for (const b of rig.beacons) chassis.add(b);

  // Headlights on the leading face, so the machine is read head-on as well as
  // in silhouette.
  const lightM = new THREE.MeshBasicMaterial({ color: 0xfff0c0 });
  keep.push(lightM);
  for (const z of [-1.2, 1.2]) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), lightM);
    l.position.set(4.55, 1.7, z);
    chassis.add(l);
  }

  g.add(chassis);
  rig.chassis = chassis;
  return g;
}

/** The boulders, and the scar the loader keeps having to clear. */
function buildRockfall(
  rig: Rig, def: HazardDef, keep: THREE.Material[],
): THREE.Group {
  const g = new THREE.Group();
  const rockM = mat(def.tint ?? 0x9a5a38, { flatShading: true });
  keep.push(rockM);
  const size = [2.05, 1.65, 1.35];
  const spread = [-0.95, 0.15, 1.05];
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(new THREE.IcosahedronGeometry(size[i]!, 0), rockM);
    r.castShadow = true;
    r.receiveShadow = true;
    r.userData.spread = spread[i]!;
    g.add(r);
    rig.rocks.push(r);
  }
  return g;
}

/**
 * A bore of brine — a wall of water that rolls across the dry lane and drains
 * back off it.
 *
 * Built as a ribbon of quads standing on edge with a foam lip along the top,
 * so it has a *crest*: a flat translucent slab reads as a pane of glass and a
 * curled one reads as water. The face is 26 metres along the road, which is
 * what makes it unmissable, and about five metres thick, which is what makes it
 * survivable.
 */
function buildSurge(rig: Rig, keep: THREE.Material[]): THREE.Group {
  const g = new THREE.Group();
  const N = 14;
  const len = 26;
  const waterM = new THREE.MeshLambertMaterial({
    color: 0x4e8b9c, transparent: true, opacity: 0.82,
    emissive: 0x0d2a33, side: THREE.DoubleSide,
  });
  const foamM = new THREE.MeshLambertMaterial({
    color: 0xeaf6f8, transparent: true, opacity: 0.94, side: THREE.DoubleSide,
  });
  keep.push(waterM, foamM);

  // The body: a swept face with a slight scallop along its length so it is not
  // a ruled wall.
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = (t - 0.5) * len;
    const h = 1.5 + 0.55 * Math.sin(t * 7.1) + 0.3 * Math.sin(t * 3.3 + 1.4);
    const lean = 0.9 + 0.25 * Math.sin(t * 5.0 + 0.6);
    pos.push(1.9, -0.15, z);
    pos.push(-lean, h, z);
    pos.push(-2.4, -0.15, z);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 3;
    idx.push(a, a + 1, a + 3, a + 3, a + 1, a + 4);
    idx.push(a + 1, a + 2, a + 4, a + 4, a + 2, a + 5);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const wall = new THREE.Mesh(geo, waterM);
  wall.receiveShadow = true;
  g.add(wall);
  rig.wall = wall;

  // The crest: a thin foam lip riding the top edge, drawn slightly proud so it
  // catches the sun even when the wall behind it is in shadow.
  const cpos: number[] = [];
  const cidx: number[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = (t - 0.5) * len;
    const h = 1.5 + 0.55 * Math.sin(t * 7.1) + 0.3 * Math.sin(t * 3.3 + 1.4);
    const lean = 0.9 + 0.25 * Math.sin(t * 5.0 + 0.6);
    cpos.push(-lean + 0.12, h + 0.34, z);
    cpos.push(-lean - 0.75, h - 0.28, z);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 2;
    cidx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  const cgeo = new THREE.BufferGeometry();
  cgeo.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3));
  cgeo.setIndex(cidx);
  cgeo.computeVertexNormals();
  const crest = new THREE.Mesh(cgeo, foamM);
  g.add(crest);
  rig.crest = crest;

  return g;
}

/** The avalanche gate: a lattice boom on a counterweighted pivot. */
function buildBoom(
  rig: Rig, len: number, stripe: THREE.Texture, keep: THREE.Material[],
): THREE.Group {
  const g = new THREE.Group();
  const steelM = mat(STEEL);
  const stripeM = new THREE.MeshLambertMaterial({ map: stripe });
  const whiteM = mat(WHITE);
  keep.push(steelM, stripeM, whiteM);

  // Pivot post and its base.
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 3.0, 10), steelM);
  post.position.y = 1.5;
  post.castShadow = true;
  g.add(post);
  const base = box(1.9, 0.5, 1.9, whiteM, 0, 0.25, 0);
  g.add(base);

  // The arm, in its own group so the whole thing swings about local y.
  const arm = new THREE.Group();
  arm.position.y = 2.15;
  const LEN = len;
  const beam = new THREE.Mesh(new THREE.BoxGeometry(LEN, 0.42, 0.42), stripeM);
  (beam.material as THREE.MeshLambertMaterial).map!.repeat.set(Math.round(LEN * 1.4), 1);
  beam.position.x = LEN * 0.5;
  beam.castShadow = true;
  arm.add(beam);
  // A lower chord and diagonals: a lattice reads at distance where a bar does
  // not, and it is what an avalanche gate is actually made of.
  const chord = new THREE.Mesh(new THREE.BoxGeometry(LEN, 0.2, 0.2), steelM);
  chord.position.set(LEN * 0.5, -0.75, 0);
  arm.add(chord);
  const bays = Math.max(4, Math.round(LEN / 1.45));
  for (let i = 0; i < bays; i++) {
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.02, 0.14), steelM);
    d.position.set((i + 0.5) * (LEN / bays), -0.38, 0);
    d.rotation.z = i % 2 ? 0.62 : -0.62;
    arm.add(d);
  }
  // Counterweight behind the pivot, which is what stops it reading as a stick.
  arm.add(box(1.5, 0.9, 0.9, steelM, -1.15, -0.1, 0));
  // Tip lamp.
  const tipM = new THREE.MeshBasicMaterial({ color: RED });
  keep.push(tipM);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), tipM);
  tip.position.set(LEN, 0.16, 0);
  arm.add(tip);
  rig.beacons.push(tip);
  g.add(arm);
  rig.arm = arm;

  rig.beacons.push(beacon(0, 3.25, 0, keep));
  g.add(rig.beacons[rig.beacons.length - 1]!);
  return g;
}

// ── the system ─────────────────────────────────────────────────────────────

export function createHazardSystem(ctx: GameContext): GameSystem {
  let root: THREE.Group | null = null;
  let list: Hazard[] = [];
  let materials: THREE.Material[] = [];
  let textures: THREE.Texture[] = [];
  /** `ctx.time.elapsed` when this race's clock started. */
  let epoch = 0;
  /** Sim time this hazard set has been running, seconds. Written in fixedUpdate. */
  let clock = 0;
  /** ...and the value it had one fixed step ago, for the render blend. */
  let prevClock = 0;
  /** Per-racer cooldown so one pass through a body is one hit. */
  const cooldown = new Map<number, number>();

  function dispose(): void {
    if (root) {
      ctx.scene.remove(root);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
      });
      root = null;
    }
    for (const m of materials) m.dispose();
    for (const t of textures) t.dispose();
    materials = [];
    textures = [];
    list = [];
    cooldown.clear();
  }

  /**
   * Build every hazard the active course declares.
   *
   * Called on `track:built` — the road is rebuilt whenever the course changes,
   * and a hazard is anchored to a station on it, so it has to be rebuilt with
   * it. Everything the hot path needs is resolved here: the frame, the reach,
   * the body array. `fixedUpdate` allocates nothing and queries nothing.
   */
  function build(track: Track): void {
    dispose();
    const defs = features(track.course).hazards;
    if (!defs || defs.length === 0) return;

    root = new THREE.Group();
    root.name = 'hazards';
    const stripe = stripeTexture();
    textures.push(stripe);

    const L = track.spline.length;
    const start = track.course.startDistance ?? 0;
    const verge = track.course.vergeWidth ?? 5;
    const s: SplineSample = track.spline.atDistance(0);

    for (const def of defs) {
      const d = ((start + def.at * L) % L + L) % L;
      track.spline.atDistance(d, s);
      const half = s.width * 0.5;

      // The crossing's frame, taken now and cloned: `s` is a single reusable
      // sample and it is about to be moved back up the road for the sign.
      const origin = s.pos.clone();
      const right = s.right.clone();
      const up = s.up.clone();
      const fwd = s.tangent.clone();

      const group = new THREE.Group();
      _basis.makeBasis(right, up, fwd);
      group.quaternion.setFromRotationMatrix(_basis);
      group.position.copy(origin);

      const rig = emptyRig();
      let bodies: Body[];
      let reach: number;
      switch (def.kind) {
        case 'truck':
          group.add(buildTruck(rig, stripe, materials));
          bodies = [body()];
          reach = 34;
          break;
        case 'rockfall':
          group.add(buildRockfall(rig, def, materials));
          bodies = [body(), body(), body()];
          reach = 30;
          break;
        case 'surge':
          group.add(buildSurge(rig, materials));
          bodies = [body()];
          reach = 30;
          break;
        case 'boom':
          group.add(buildBoom(rig, def.width ?? 10.4, stripe, materials));
          bodies = [body()];
          reach = 30;
          break;
      }
      root.add(group);

      // The sign, on its own station and its own frame, `signAt` metres back on
      // the driver's right-hand verge — which is the spline's negative side,
      // and the side of the road a driver's eyes are already on through the
      // corner every one of these hazards sits in.
      const backD = ((d - (def.signAt ?? SIGN_BACK)) % L + L) % L;
      track.spline.atDistance(backD, s);
      const sign = buildSign(def.kind, stripe, materials);
      _basis.makeBasis(s.right, s.up, s.tangent);
      sign.group.quaternion.setFromRotationMatrix(_basis);
      // Out on the shoulder, close to the barrier — a sign a kart can drive
      // through is a sign in the wrong place — and standing on the *shoulder's*
      // height rather than the centreline's, which on a crowned road banked
      // into a corner is up to half a metre of daylight under the post.
      const off = s.width * 0.5 + Math.min(verge - 1.1, 4.4);
      sign.group.position.copy(s.pos)
        .addScaledVector(s.right, -off)
        .addScaledVector(s.up, surfaceHeight(-off, s.width, verge) - 0.1);
      root.add(sign.group);

      list.push({
        def, kind: def.kind,
        origin, right, up, fwd,
        half, bodies, reach, group, sign, rig,
        armed: 0, tick: 0, lastU: -1,
        period: Math.max(1, def.period),
        phase: def.phase ?? 0,
      });
    }

    ctx.scene.add(root);
  }

  // ── the cycle, resolved ──────────────────────────────────────────────────

  /**
   * Move one hazard's bodies for a cycle phase `u`, in local coordinates.
   *
   * Pure: the same `u` always produces the same bodies, which is what lets the
   * simulation call it at the fixed clock and the visual pass call it again at
   * the blended one without the two ever disagreeing about where the dumper is.
   */
  function resolve(h: Hazard, u: number, visual: boolean): void {
    const def = h.def;
    const b = h.bodies;
    const lat = (def.lateral ?? 0) * h.half;

    switch (h.kind) {
      case 'truck': {
        // A shuttle: loaded across, tip at the far end, empty back, load again.
        // The haul road it crosses on is the *hazard's* x axis, so the nine and
        // a half metres that make it unmissable lie across the racing road and
        // the four and a bit that a kart has to get past lie along it.
        const FAR = TRUCK.bay;
        const speed = 2 * FAR / ((TRUCK.out1 - TRUCK.out0) * h.period);
        let x: number;
        let facing: number;
        let tip = 0;
        let moving = false;
        if (u < TRUCK.out0) { x = -FAR; facing = 1; }
        else if (u < TRUCK.out1) {
          x = lerp(-FAR, FAR, (u - TRUCK.out0) / (TRUCK.out1 - TRUCK.out0));
          facing = 1; moving = true;
        } else if (u < TRUCK.tip1) {
          x = FAR; facing = 1; tip = pulse(TRUCK.tip0, TRUCK.tip1, u);
        } else if (u < TRUCK.back0) { x = FAR; facing = -1; }
        else if (u < TRUCK.back1) {
          x = lerp(FAR, -FAR, (u - TRUCK.back0) / (TRUCK.back1 - TRUCK.back0));
          facing = -1; moving = true;
        } else { x = -FAR; facing = -1; }
        x += lat;

        const rig = h.rig;
        if (visual && rig.chassis) {
          rig.chassis.position.x = x;
          rig.chassis.rotation.y = facing > 0 ? 0 : Math.PI;
          // Squat on the springs while the tray is up, and roll the wheels at
          // the speed the machine is actually travelling — a wheel that spins
          // while the machine is parked is the tell that nothing here is real.
          rig.chassis.position.y = -0.10 * tip;
          if (rig.tray) rig.tray.rotation.z = tip * 0.9;
          if (moving) {
            const travelled = facing > 0
              ? (u - TRUCK.out0) * h.period * speed
              : (u - TRUCK.back0) * h.period * speed;
            for (const w of rig.wheels) w.rotation.z = -facing * travelled / 1.35;
          }
        }
        // One capsule down the machine's long axis. 2.55m of radius wraps a
        // 4.8m-wide body and its wheels without claiming the air above it.
        b[0]!.ax = x - 3.3; b[0]!.bx = x + 3.3;
        b[0]!.ay = b[0]!.by = 1.7;
        b[0]!.az = b[0]!.bz = 0;
        b[0]!.r = 2.55;
        b[0]!.live = Math.abs(x) < h.half + TRUCK.guard + 2;
        break;
      }

      case 'rockfall': {
        // Released at the top of the cut, 1.4 seconds of fall, then the lane is
        // shut until the loader has pushed them off.
        const T0 = ROCK.drop;
        const FALL = ROCK.fallSec / h.period;
        const CLEAR = ROCK.clear;
        const GONE = ROCK.gone;
        const H0 = ROCK.top;
        for (let i = 0; i < 3; i++) {
          const r = h.rig.rocks[i]!;
          const size = [2.05, 1.65, 1.35][i]!;
          const spread = (r.userData.spread as number) * 3.4;
          const x = lat + spread;
          // A small stagger so they do not land as a rank.
          const t0 = T0 + i * 0.012;
          let y: number;
          let live: boolean;
          let scale = 1;
          if (u < t0) { y = H0; live = false; scale = 0; }
          else if (u < t0 + FALL) {
            const k = (u - t0) / FALL;
            y = H0 * (1 - k * k);
            live = k > 0.72;
          } else if (u < CLEAR) {
            // Settled, with a short bounce so the landing has weight.
            const s2 = (u - t0 - FALL) * h.period;
            y = size * 0.62 + Math.max(0, 0.9 - s2 * 3.2) * Math.abs(Math.sin(s2 * 11));
            live = true;
          } else if (u < GONE) {
            const k = (u - CLEAR) / (GONE - CLEAR);
            y = size * 0.62 - k * size * 1.4;
            live = k < 0.5;
            scale = 1 - k * 0.35;
          } else { y = H0; live = false; scale = 0; }

          if (visual) {
            r.position.set(x, y, ((i * 5) % 3 - 1) * 2.1);
            r.scale.setScalar(scale);
            r.visible = scale > 0.01;
            // Tumbling, and it stops when the rock does.
            const spin = u < t0 + FALL ? (u - t0) * h.period * 4.4 : (FALL * h.period) * 4.4;
            r.rotation.set(spin * 0.8 + i, spin * 0.5, spin * 0.9 + i * 2);
          }
          ball(b[i]!, x, y, ((i * 5) % 3 - 1) * 2.1, size * 0.92, live);
        }
        break;
      }

      case 'surge': {
        // In from the pan, over the dry lane, and back out. The sign of the
        // travel is the sign of `lateral`: a band whose dry lane is on the
        // driver's left is flooded from the left.
        // For a bore, `lateral` is where it **rests** — the middle of the dry
        // lane it is there to close — and the side of that tells it which edge
        // of the road the lake is on and therefore which way it comes in from.
        // It is not a swept path with a hazard somewhere in it: it arrives, it
        // sits on the one lane that was not already under water, and it drains.
        const dir = (def.lateral ?? 1) >= 0 ? 1 : -1;
        const out = dir * (h.half + 13);
        const inn = lat;
        let x: number;
        let live = false;
        if (u < SURGE.in0) { x = out; }
        else if (u < SURGE.in1) {
          x = lerp(out, inn, ramp(0, 1, (u - SURGE.in0) / (SURGE.in1 - SURGE.in0)));
          live = true;
        } else if (u < SURGE.hold) { x = inn; live = true; }
        else if (u < SURGE.out1) {
          x = lerp(inn, out, ramp(0, 1, (u - SURGE.hold) / (SURGE.out1 - SURGE.hold)));
          live = true;
        } else { x = out; }

        if (visual && h.rig.wall && h.rig.crest) {
          // The wall is dragged flat as it drains, so the retreat reads as
          // water losing energy rather than as a wall reversing.
          const bulk = u < SURGE.hold ? 1 : 1 - 0.55 * clamp01((u - SURGE.hold) / 0.12);
          const s = Math.max(0.12, bulk);
          h.rig.wall.position.set(x, 0, 0);
          h.rig.wall.scale.set(1, s, 1);
          h.rig.crest.position.set(x, 0, Math.sin(u * TAU * 3) * 0.8);
          h.rig.crest.scale.set(1, s, 1);
          h.rig.wall.visible = h.rig.crest.visible = u > SURGE.in0 - 0.04 && u < SURGE.gone;
        }
        ball(b[0]!, x, 0.8, 0, 2.7, live && Math.abs(x) < h.half + 4);
        b[0]!.az = -12; b[0]!.bz = 12;
        b[0]!.ax = b[0]!.bx = x;
        break;
      }

      case 'boom': {
        // Swings shut across the cut, holds, swings open. `theta` is measured
        // from lying along the road (open) to lying across it (shut).
        const dir = (def.lateral ?? 1) >= 0 ? 1 : -1;
        const pivot = lat + dir * 5.6;
        let k: number;
        if (u < BOOM.shut0) k = 0;
        else if (u < BOOM.shut1) k = ramp(0, 1, (u - BOOM.shut0) / (BOOM.shut1 - BOOM.shut0));
        else if (u < BOOM.open0) k = 1;
        else if (u < BOOM.open1) k = 1 - ramp(0, 1, (u - BOOM.open0) / (BOOM.open1 - BOOM.open0));
        else k = 0;
        const theta = k * Math.PI * 0.5;
        // Local direction of the arm: along +z when open (stowed along the
        // verge), swung in toward the road when shut. `dir` flips which side of
        // the road the gate lives on, and the mesh's own +x is rotated to match
        // — `y = -π/2 - dir·θ` is the one line that has to agree with the two
        // components below, so they are written next to each other.
        const ux = -dir * Math.sin(theta);
        const uz = Math.cos(theta);
        const LEN = def.width ?? 10.4;

        if (visual && h.rig.arm) {
          h.rig.arm.position.x = pivot;
          h.rig.arm.rotation.y = -Math.PI * 0.5 - dir * theta;
          // A little bounce as it seats, which is the whole of the animation
          // principle this game is held to on something that ends abruptly.
          const s = u - BOOM.shut1;
          h.rig.arm.rotation.z = s > 0 && s < 0.08
            ? Math.sin(s * 90) * 0.035 * (1 - s / 0.08) : 0;
        }
        ball(b[0]!, pivot, 1.55, 0, 0.95, k > 0.06);
        b[0]!.ax = pivot + ux * 1.2; b[0]!.az = uz * 1.2;
        b[0]!.bx = pivot + ux * LEN; b[0]!.bz = uz * LEN;
        b[0]!.ay = b[0]!.by = 1.55;
        break;
      }
    }
  }

  /** Scratch for `crossWindow`, so the telegraph allocates nothing per step. */
  const _win: [number, number][] = [];

  /**
   * Is the sign warning at cycle phase `u`?
   *
   * The lamps run from `lead` seconds before the body reaches the tarmac to the
   * moment it leaves it, measured on the cycle's own circle so a window that
   * straddles the wrap still lights them. This is the fairness contract in one
   * function: dark lamps mean the road is yours.
   */
  function armLevel(h: Hazard, u: number): number {
    const lead = (h.def.lead ?? 1.6) / h.period;
    for (const w of crossWindow(h, _win)) {
      const from = w[0] - lead;
      const rel = wrap01(u - from);
      const span = wrap01(w[1] - from) || 1;
      if (rel < span) return 1;
    }
    return 0;
  }

  // ── contact ──────────────────────────────────────────────────────────────

  /**
   * Squared distance from a racer to one capsule, in the hazard's frame.
   *
   * The racer is transformed rather than the capsule because there are eight of
   * the former and up to three of the latter, and because the frame is
   * orthonormal so the transform is three dot products.
   */
  function hits(h: Hazard, b: Body, racer: Racer): boolean {
    if (!b.live) return false;
    _p.copy(racer.pos).sub(h.origin);
    const px = _p.dot(h.right);
    const py = _p.dot(h.up);
    const pz = _p.dot(h.fwd);
    const ex = b.bx - b.ax, ey = b.by - b.ay, ez = b.bz - b.az;
    const len2 = ex * ex + ey * ey + ez * ez;
    let t = 0;
    if (len2 > 1e-6) {
      t = ((px - b.ax) * ex + (py - b.ay) * ey + (pz - b.az) * ez) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const dx = px - (b.ax + ex * t);
    const dy = py - (b.ay + ey * t) - 0.55;
    const dz = pz - (b.az + ez * t);
    const r = b.r + KART_R;
    return dx * dx + dy * dy + dz * dz < r * r;
  }

  ctx.bus.on<{ track: Track }>('track:built', ({ track }) => build(track));

  /**
   * The bench, in the house pattern — `__AI`, `__ITEMS` and `__RACE` all keep
   * one, and for the same reason: a thing that only exists for two seconds at a
   * time cannot be reviewed from a screenshot. `__HAZARDS.probe()` says where
   * every body is, whether it is live, and whether its lamps are lit, at the
   * exact simulation instant a reviewer stopped the clock.
   */
  (globalThis as unknown as Record<string, unknown>).__HAZARDS = {
    probe: () => list.map((h) => ({
      kind: h.kind,
      at: h.def.at,
      period: h.period,
      u: Math.round(wrap01(clock / h.period + h.phase) * 1e4) / 1e4,
      armed: h.armed > 0,
      half: Math.round(h.half * 10) / 10,
      origin: [h.origin.x, h.origin.y, h.origin.z].map((v) => Math.round(v)),
      bodies: h.bodies.map((b) => ({
        live: b.live,
        a: [b.ax, b.ay, b.az].map((v) => Math.round(v * 10) / 10),
        b: [b.bx, b.by, b.bz].map((v) => Math.round(v * 10) / 10),
        r: b.r,
      })),
    })),
    clock: () => clock,
    /** Fraction of one full cycle each hazard's body spends over the tarmac. */
    duty: () => list.map((h) => {
      const w = crossWindow(h, []);
      return {
        kind: h.kind,
        blocked: Math.round(w.reduce((a, x) => a + wrap01(x[1] - x[0]), 0) * 1000) / 1000,
        seconds: Math.round(w.reduce((a, x) => a + wrap01(x[1] - x[0]), 0) * h.period * 10) / 10,
      };
    }),
  };

  return {
    name: 'hazards',
    // After physics (30), the AI (40) and items (50): the contact test wants
    // the positions the karts actually ended the step at, and a stun written
    // here is picked up by physics' own `stunned` handling on the next step,
    // exactly as an item strike is.
    order: 55,

    reset(): void {
      // The race's own clock. `ctx.time.elapsed` is the engine's accumulation
      // of fixed steps — deterministic, never a wall-clock read — and taking
      // an epoch off it here is what makes the dumper stand in the same place
      // at the flag of every race rather than wherever the title screen left
      // it. See ARCHITECTURE §11a: the race simulates behind the front-end, so
      // `elapsed` at the first flag of a session is not zero.
      epoch = ctx.time.elapsed;
      clock = prevClock = 0;
      cooldown.clear();
      for (const h of list) h.armed = h.tick = 0;
    },

    fixedUpdate(dt: number): void {
      if (list.length === 0) return;
      prevClock = clock;
      clock = ctx.time.elapsed - epoch;

      for (const [id, t] of cooldown) {
        const n = t - dt;
        if (n <= 0) cooldown.delete(id); else cooldown.set(id, n);
      }

      const racing = ctx.race.phase === 'racing' || ctx.race.phase === 'finished';

      for (const h of list) {
        const u = wrap01(clock / h.period + h.phase);
        resolve(h, u, false);
        h.armed = armLevel(h, u);
        if (!racing) continue;

        for (const racer of ctx.racers) {
          if (racer.finished || racer.stunned > 0 || racer.invulnerable > 0) continue;
          if (cooldown.has(racer.id)) continue;
          // **A hazard may not pin.** The first build of the avalanche gate
          // parked a CPU driver under it for a whole race: the arm is shut for
          // four seconds of an eleven-second cycle, a `bump` is 0.55s of stun
          // and 0.4s of grace, so a kart that stopped underneath it was hit
          // again, and again, and finished the race on lap zero. A hazard is
          // something you drive into; if there is no closing speed there is no
          // collision, and the racer gets the road back.
          if (racer.speed < HIT_MIN_SPEED) continue;
          // Cheap reject before the capsules: one length compare against the
          // radius that bounds every body this hazard owns.
          if (racer.pos.distanceToSquared(h.origin) > h.reach * h.reach) continue;
          let struck = false;
          for (const b of h.bodies) {
            if (hits(h, b, racer)) { struck = true; break; }
          }
          if (!struck) continue;

          stunRacer(ctx, racer, h.def.hit ?? 'spin', null);
          cooldown.set(racer.id, HIT_COOLDOWN);
          // `kart:hit` reaches fx, the camera and the HUD on its own. Sound
          // does not: `audio/index.ts` hangs its impacts off `item:strike`,
          // which is the item system's word for its own thirteen items and
          // would be a lie coming from a boulder. So the cue is played here,
          // by id, off the same bank.
          const kind = h.def.hit ?? 'spin';
          ctx.audio?.play(kind === 'bump' ? 'hit.bump' : 'hit.spin', { pos: racer.pos });
          ctx.fx?.spawn(h.kind === 'surge' ? 'splash' : 'dust', racer.pos, { scale: 1.5 });
          if (racer.isPlayer) ctx.fx?.shake(0.45, 0.5);
        }
      }
    },

    /**
     * Visuals only, and every one of them is a pure function of the clock.
     *
     * `alpha` blends the previous fixed state into the current one, so the
     * render phase is the *simulation's* phase a fraction of a step back — the
     * same rule every interpolated transform in this game follows. Resolving
     * the bodies a second time here rather than caching the sim's answer is
     * what removes judder from a 27-metre-a-second dumper.
     */
    update(dt: number, alpha: number): void {
      if (list.length === 0) return;
      const t = prevClock + (clock - prevClock) * alpha;
      for (const h of list) {
        const u = wrap01(t / h.period + h.phase);
        resolve(h, u, true);

        // The lamps. Two of them, alternating, at 2.2Hz — the works-site rhythm
        // — and dark the instant the road is clear again. A lamp that is on all
        // lap is a lamp nobody reads.
        const on = h.armed > 0;
        const beat = Math.sin(t * 13.8) > 0;
        if (h.sign) {
          const a = h.sign.lamps[0]!.material as THREE.MeshBasicMaterial;
          const bm = h.sign.lamps[1]!.material as THREE.MeshBasicMaterial;
          a.color.setHex(on && beat ? 0xff5b3a : 0x571512);
          bm.color.setHex(on && !beat ? 0xff5b3a : 0x571512);
        }
        // Machine beacons rotate rather than blink, so the two signals are
        // different animals at a glance.
        const sweep = 0.55 + 0.45 * Math.sin(t * 7.4);
        for (const b of h.rig.beacons) {
          const m = b.material as THREE.MeshBasicMaterial;
          m.color.setRGB(1, 0.42 * sweep + 0.12, 0.05);
        }

        // The ticking cue, on the player's approach only: the sign is the
        // contract, and a contract nobody can hear from inside a kart at fifty
        // metres a second is not one. One tick per flash, and only when the
        // player is close enough for it to be about them.
        h.tick -= dt;
        const p = ctx.player;
        if (on && p && h.tick <= 0 && p.pos.distanceToSquared(h.origin) < 150 * 150) {
          h.tick = 0.45;
          ctx.audio?.play('warn.tick', { volume: 0.5, pos: h.origin });
        }

        // ── the accents ─────────────────────────────────────────────────────
        //
        // Two rules. A continuous one (spray off a bore that is moving, dust
        // off wheels that are turning) rides a cheap oscillator; a *one-shot*
        // one — the boulders landing, the tray dumping — is edge-triggered off
        // the cycle crossing a phase, which is the only way to fire something
        // once from a pass that runs at whatever rate the machine manages.
        const crossed = (at: number): boolean =>
          h.lastU >= 0 && wrap01(at - h.lastU) < wrap01(u - h.lastU) + 1e-9
            && wrap01(u - h.lastU) < 0.5;

        if (h.kind === 'surge' && h.bodies[0]!.live && Math.sin(t * 9.1) > 0.9) {
          _p.copy(h.origin)
            .addScaledVector(h.right, h.bodies[0]!.ax)
            .addScaledVector(h.fwd, (wrap01(t * 0.37) - 0.5) * 22)
            .addScaledVector(h.up, 0.9);
          ctx.fx?.spawn('splash', _p, { scale: 1.1 });
        }
        if (h.kind === 'rockfall') {
          // The whole point of a hazard that falls: it has to *land*. One dust
          // ring per boulder at the moment the fall ends, and a puff off the
          // cut face when they are released so the eye is already up there.
          if (crossed(ROCK.drop + ROCK.fallSec / h.period)) {
            for (const b of h.bodies) {
              _p.copy(h.origin)
                .addScaledVector(h.right, b.ax)
                .addScaledVector(h.fwd, b.az)
                .addScaledVector(h.up, 0.2);
              ctx.fx?.spawn('dust', _p, { scale: 1.9 });
            }
            const p2 = ctx.player;
            if (p2 && p2.pos.distanceToSquared(h.origin) < 120 * 120) ctx.fx?.shake(0.3, 0.6);
          }
          if (crossed(ROCK.drop)) {
            _p.copy(h.origin)
              .addScaledVector(h.right, (h.def.lateral ?? 0) * h.half - 6)
              .addScaledVector(h.up, ROCK.top * 0.9);
            ctx.fx?.spawn('smoke', _p, { scale: 1.5 });
          }
        }
        if (h.kind === 'truck' && crossed((TRUCK.tip0 + TRUCK.tip1) * 0.5)) {
          // The tip. Twenty tonnes of shot rock going over the edge, which is
          // the reason the machine keeps coming back.
          _p.copy(h.origin)
            .addScaledVector(h.right, TRUCK.bay + 6)
            .addScaledVector(h.up, 1.2);
          ctx.fx?.spawn('dust', _p, { scale: 2.6 });
        }
        h.lastU = u;
      }
    },

    dispose,
  };
}
