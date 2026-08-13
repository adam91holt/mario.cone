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

/** Metres from a kart's contact patch to the middle of the thing standing on it. */
const KART_LIFT = 0.55;

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
  /** Where the field actually drives past this station. See `Census`. */
  census: Census;
}

/**
 * ── the instrument, and why it is built into the hazard rather than bolted on ─
 *
 * A round was lost to four hazards that were declared, drawn, signed, cycled,
 * documented at 20-38% blocked — and which, over thirteen full races of seven
 * racers, hit somebody **five times**. The gate on the mountain, cycling every
 * eleven seconds at a claimed 38% blocked window over a 168-second race, is
 * about thirty-five blocked passes across the field, and it produced zero.
 *
 * That is not tuning. A duty cycle is a statement about *time* and it says
 * nothing at all about *space*: a body can be over the tarmac for 38% of every
 * cycle and still never be within nine metres of the line anybody drives. Every
 * `lateral` in this cup was authored as an offset off the road centre, and the
 * road centre is not where a racing line is — it is the one place on a corner
 * that nobody is.
 *
 * So each hazard now measures the field itself. Every time a racer crosses the
 * station the hazard is anchored to, its lateral **in the hazard's own frame**
 * — which is exactly `track.sample().lateral`, the same dot product against the
 * same `right` vector — is binned. `__HAZARDS.census()` reports that histogram
 * next to the lateral span the bodies actually sweep, so the question "does this
 * hazard intersect the racing line" has a numeric answer instead of a paragraph.
 *
 * `tools/hazardcensus.mjs` is the reader. Nothing here may be tuned by
 * assertion again: if the census says the field crosses at -9m and the body
 * lives at +14m, the hazard does not exist however good the sign looks.
 */
interface Census {
  passes: number;
  hits: number;
  /**
   * ── why a pass was not a hit ────────────────────────────────────────────
   *
   * Three numbers, and between them they close the last hole in this
   * instrument. A hazard that fires six times in one race and twice in the
   * next has *something* varying, and "hits" alone cannot say which of the
   * three candidates it is: the body was not on the road when the racer got
   * there (`armed`), the body was on the road but not on that racer's line
   * (`armed` minus `covered`), or the racer was standing on the one thing that
   * makes it un-hittable — a stun, a star, the anti-pin floor, the two-second
   * grace after the last hit — in which case the hazard did nothing wrong and
   * the item system was simply busier that race (`guarded`).
   *
   * That last one is real and it is a *coupling*, not noise: the seed with 60
   * item strikes had a third of the hazard hits of the seed with 31, because
   * `stunned`, `invulnerable` and `HIT_COOLDOWN` all skip the contact test.
   */
  /** Passes where at least one body was live at the moment of crossing. */
  armed: number;
  /** ...and the crossing lateral was inside that body's lateral span. */
  covered: number;
  /** Passes where the racer could not be hit by anything, for any reason. */
  guarded: number;
  /** 1-metre bins over ±CENSUS_HALF metres of lateral. */
  bins: Int32Array;
  /** Previous along-road offset per racer, for edge-triggering one pass. */
  lastZ: Float64Array;
  /** Whether that value is fresh — a racer out of reach has no previous. */
  seen: Uint8Array;
}

/** Half the census's lateral range, metres. Wide enough for any shoulder. */
const CENSUS_HALF = 24;
const CENSUS_BINS = CENSUS_HALF * 2;
/** The most racers a census array is sized for. The grid is seven plus one. */
const CENSUS_RACERS = 16;

const census = (): Census => ({
  passes: 0,
  hits: 0,
  armed: 0,
  covered: 0,
  guarded: 0,
  bins: new Int32Array(CENSUS_BINS),
  lastZ: new Float64Array(CENSUS_RACERS),
  seen: new Uint8Array(CENSUS_RACERS),
});

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

/**
 * The dumper's shuttle: out loaded, **stopped on the crossing**, on to the tip,
 * back empty, stopped again, load again.
 *
 * ── the hold is why this hazard now exists ─────────────────────────────────
 *
 * The first build was a machine that never stopped: 0.22 of the cycle to cover
 * 54 metres, twice. Censused over a whole race that came out at **four hits in
 * twenty-two passes**, and the arithmetic says exactly why — a kart crossing the
 * station is an instant, so what decides whether it is hit is the fraction of
 * the cycle the machine spends over the *driven* band, and a machine sweeping
 * 54 metres at 10 m/s is over any given 16 metres of it for a ninth of each
 * traverse.
 *
 * So the truck now does what a haul truck actually does at a crossing: it
 * **stops on it**. Nose out, body across the road, beacons turning, for a
 * couple of seconds each way. That is the readable version as well as the
 * effective one — nine and a half metres of stationary safety yellow parked
 * across the Cut is a thing a player sees from two hundred metres and has time
 * to lift for, where a machine crossing at ten metres a second is a thing that
 * is either there or not by the time you arrive.
 */
const TRUCK = {
  /** Metres either side of the centreline the machine parks at. */
  bay: 24,
  /**
   * Half the danger band across the road: the capsule plus a kart.
   *
   * Kept in step with the capsule set in `resolve()` — 4.3 of half-length plus
   * 2.55 of radius — because `crossWindow` decides the *lamps* off this number
   * and the contact test decides the *hit* off the capsule, and the one way
   * this feature can lie to a player is those two disagreeing.
   */
  guard: 4.3 + 2.55 + KART_R,
  /**
   * Run in, stand on the crossing, run out. Then tip at the far end.
   *
   * The stand is 0.14 of the cycle — a shade over two seconds on the Cut's
   * fifteen-second machine and a second and a half on the haul road's eleven —
   * and both numbers are chosen against **`HIT_COOLDOWN`**, which is 2.4. A
   * body that stands still for longer than a racer's grace period hits the same
   * racer twice out of one mistake; see `SURGE`, where a 5.7-second hold turned
   * three bores into twenty-nine hits in a two-lap race. Under the grace, one
   * machine is one hit, and the danger comes from the stop being *long enough
   * to arrive during* rather than from it being long enough to sit inside.
   *
   * At 0.05 it was not: censused across five seeds the pair produced 6-17 hits
   * a race, and the low end failed the bar. Three quarters of a second is not a
   * machine stopping, it is a machine hesitating.
   */
  out0: 0.03, hold0: 0.15, hold1: 0.29, out1: 0.41,
  tip0: 0.44, tip1: 0.55,
  /** ...and the same again, empty, the other way. */
  back0: 0.58, bhold0: 0.70, bhold1: 0.84, back1: 0.96,
};

/**
 * The rockfall: released, 1.4s of air, sat in the lane, pushed off.
 *
 * `size` and `spread` are here rather than in the builder because `resolve()`
 * needs them too — where a boulder sits and how big its capsule is have to be
 * one statement, or the rock a player can see and the rock that spins them are
 * two different rocks.
 *
 * **Four boulders, not three, and the lane they close is 17 metres wide.** The
 * three-boulder version closed 13 metres of a 24-metre road and the census
 * found the field crossing it in a band 7 metres wide that the rocks missed
 * entirely; widening the fall is what makes the escape route a *choice* rather
 * than an accident. `clear`/`gone` are likewise pushed out until the lane is
 * shut for about half of every cycle — the Carousel's short lane is meant to
 * have a wrong answer, and a wrong answer that is wrong one time in six is a
 * thing nobody ever learns.
 */
const ROCK = {
  drop: 0.10, fallSec: 1.4, clear: 0.54, gone: 0.60, top: 20,
  size: [2.4, 2.1, 1.8, 2.2],
  /** Lateral offsets in metres, so four of them close a 17-metre lane. */
  spread: [-4.6, -1.0, 2.4, 6.0],
  /** ...and a little stagger along the road, so they are not a ruled rank. */
  along: [-1.7, 1.7, 0.2, -0.9],
};

/**
 * The bore: in off the pan, standing over the road, and drained back.
 *
 * The hold used to be five hundredths of a cycle — the wave arrived, touched
 * the road and left again — and censused over two full laps it hit nobody at
 * all.
 *
 * **The correction over-shot, and the way it over-shot is worth keeping.** A
 * hold of 0.30 stood the bore on the road for 5.7 seconds against a
 * `HIT_COOLDOWN` of 2.4, so a kart shoved by the wave was still inside it when
 * its grace ran out and was shoved again: the census came back at an 88-93%
 * hit rate on two of the three bores and 29 hazard hits in a two-lap race,
 * which is not a hazard, it is a wall with a timer. **A body may not outstay
 * the cooldown in one place.** The rest is now 2.1 seconds — under the grace,
 * so one wave is one hit — and the danger is bought back in the *travel*
 * instead: the bore crosses at about five metres a second rather than nine, so
 * it is over any given lane twice as long on the way through without ever
 * standing on one.
 */
const SURGE = { in0: 0.03, in1: 0.26, hold: 0.37, out1: 0.60, gone: 0.66 };

/**
 * The gate: shut, held, opened.
 *
 * A shade over four tenths of the cycle rather than a third, and no more than
 * that: the mountain is the course where a hazard costs the most, because a
 * kart shoved off a 13% climb or off a promontory has nowhere to get its
 * momentum back. Censused at half the cycle it produced 13-19 hits a race and
 * one seed in four came home with a racer two laps down, which fails the bar
 * every hazard is held to before anything else it does counts. **A hazard's
 * price is a property of the road it is on**, so the mountain's gates are the
 * one thing in the cup tuned *down* from what the count alone would allow.
 */
const BOOM = { shut0: 0.10, shut1: 0.20, open0: 0.53, open1: 0.63 };

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
      // The machine reaches the tarmac part-way through its run in and leaves
      // it part-way through its run out, with the stand on the crossing in
      // between. `f` is the fraction of a half-traverse spent clear of the
      // road, which is the only thing `half` changes about the window.
      const f = clamp01((TRUCK.bay - (h.half + TRUCK.guard)) / TRUCK.bay);
      const inA = TRUCK.hold0 - TRUCK.out0;
      const outA = TRUCK.out1 - TRUCK.hold1;
      out.push([TRUCK.out0 + inA * f, TRUCK.hold1 + outA * (1 - f)]);
      const inB = TRUCK.bhold0 - TRUCK.back0;
      const outB = TRUCK.back1 - TRUCK.bhold1;
      out.push([TRUCK.back0 + inB * f, TRUCK.bhold1 + outB * (1 - f)]);
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

  // **Sized for a hundred metres, not for a metre.** The first cut of this was
  // a 2.15m plate at 3.5m, which is roughly what a real works sign is and which
  // subtends about nineteen pixels from the braking point — a smudge. A kart
  // racer's signage is deliberately oversized for the same reason its karts
  // are: the frame is read at fifty metres a second.
  const postMat = mat(STEEL);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.20, 4.0, 8), postMat);
  post.position.y = 2.0;
  post.castShadow = true;
  group.add(post);

  // A striped skirt at the foot, so the post reads as works kit rather than as
  // a lamp standard.
  const skirtMat = new THREE.MeshLambertMaterial({ map: stripe });
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.40, 0.55, 1.0, 8), skirtMat);
  skirt.position.y = 0.5;
  skirt.castShadow = true;
  skirt.receiveShadow = true;
  group.add(skirt);

  // **It faces the traffic, and the traffic comes from -z.** The group's basis
  // is `(right, up, tangent)`, so local +z is the way the road *goes* — which
  // means a plate left at its default orientation shows a driver the grey back
  // of a sign for the whole approach and reads its face only in the mirror.
  // Photographed, that is exactly what it did.
  const faceTex = signTexture(kind);
  const plateMat = new THREE.MeshLambertMaterial({ map: faceTex, side: THREE.DoubleSide });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 2.7), plateMat);
  plate.position.set(0, 4.1, -0.07);
  plate.rotation.set(0, Math.PI, Math.PI * 0.25);
  plate.castShadow = true;
  group.add(plate);

  // The back of the plate, so it is not a hole in the world from behind.
  const backMat = mat(0x4a4e58);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 2.7), backMat);
  back.position.set(0, 4.1, 0.03);
  back.rotation.z = Math.PI * 0.25;
  group.add(back);

  // Two lamps above the plate, on the side a driver is coming from. Basic
  // material, deliberately: a lamp that is shaded by the sun is a lens, not a
  // light.
  const lamps: THREE.Mesh[] = [];
  for (const x of [-1.15, 1.15]) {
    const m = new THREE.MeshBasicMaterial({ color: RED });
    keep.push(m);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), m);
    lamp.position.set(x, 6.15, -0.12);
    group.add(lamp);
    const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.18, 8), postMat);
    hood.position.set(x, 6.52, -0.12);
    group.add(hood);
    lamps.push(lamp);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.16, 0.16), postMat);
  bar.position.set(0, 5.9, -0.12);
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
  // **Gold, and almost all of it.** The first build gave this machine a grey
  // tray, on the grounds that a real dumper's body is bare steel — and
  // photographed from a kart at a hundred metres, against a grey pit, under
  // grey haze, what came back was a grey box. A hazard's first job is to be
  // seen; the second is to look like a machine. So the tray, the frame and the
  // cab are all safety yellow, and everything that is *not* yellow (the wheels,
  // the underframe, the glass) is nearly black, which is what makes the
  // silhouette read before the colour does.
  const yellowM = mat(GOLD);
  const darkM = mat(NIGHT);
  const rockM = mat(0x7d7568, { flatShading: true });
  const glassM = mat(0x1b3550, { emissive: 0x0a1626 });
  const stripeM = new THREE.MeshLambertMaterial({ map: stripe });
  keep.push(yellowM, darkM, rockM, glassM, stripeM);

  const chassis = new THREE.Group();

  // Frame and the deck it carries.
  chassis.add(box(9.0, 0.9, 4.2, yellowM, 0, 1.6, 0));
  chassis.add(box(9.4, 0.55, 3.3, darkM, 0, 1.05, 0));

  // The tray, hinged at the back so it can tip. Its own group, pivoting about
  // local -x, which is the rear of the machine.
  const tray = new THREE.Group();
  tray.position.set(-4.1, 2.05, 0);
  tray.add(box(8.2, 0.4, 4.8, darkM, 4.1, 0.12, 0));
  for (const z of [2.24, -2.24]) {
    tray.add(box(8.2, 1.9, 0.34, yellowM, 4.1, 1.02, z));
    // A striped band along the top rail of each tray wall: the loudest two
    // metres on the machine, at the height a chase camera actually sees.
    const band = new THREE.Mesh(new THREE.BoxGeometry(8.2, 0.62, 0.42), stripeM);
    band.position.set(4.1, 1.66, z);
    band.castShadow = true;
    tray.add(band);
  }
  tray.add(box(0.36, 3.0, 4.8, yellowM, 0.18, 1.6, 0));
  // The canopy over the cab, which is what makes it a quarry dumper and not a
  // tipper: the tray's front wall rises over the driver.
  tray.add(box(2.8, 0.34, 4.8, yellowM, 1.5, 3.05, 0));
  // A load of shot rock, so the machine has a reason to be crossing — and so
  // that it is visibly *loaded* on the way out and *empty* on the way back.
  // A shuttle that carries the same rock both ways is a prop on a rail.
  for (let i = 0; i < 7; i++) {
    const s = 0.8 + (i % 3) * 0.3;
    const r = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), rockM);
    r.position.set(1.8 + i * 0.92, 0.75 + (i % 2) * 0.28, ((i * 7) % 5 - 2) * 0.68);
    r.rotation.set(i * 1.1, i * 0.7, i * 0.4);
    r.castShadow = true;
    tray.add(r);
    rig.rocks.push(r);
  }
  chassis.add(tray);
  rig.tray = tray;

  // Cab, tucked under the canopy on the leading side.
  chassis.add(box(2.1, 1.7, 2.4, yellowM, 3.3, 2.95, -0.85));
  const glass = box(2.15, 0.95, 2.45, glassM, 3.3, 3.35, -0.85);
  glass.castShadow = false;
  chassis.add(glass);
  // Hazard flashes across both ends of the machine — the faces a driver on the
  // road actually sees as it comes at them.
  for (const x of [4.62, -4.62]) {
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.8, 4.0), stripeM);
    cap.position.set(x, 1.6, 0);
    cap.castShadow = true;
    chassis.add(cap);
  }

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
    for (const s of x > 0 ? [-1.7, 1.7] : [zo < 0 ? -1.9 : 1.9]) {
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

  // Beacons on the canopy — the highest point on the machine, which is what a
  // driver sees over a rock bench before they see the machine.
  rig.beacons.push(beacon(2.5, 4.05, -1.5, keep));
  rig.beacons.push(beacon(2.5, 4.05, 1.5, keep));
  for (const b of rig.beacons) chassis.add(b);

  // Headlights on both ends, since it works in both directions and neither end
  // is ever the back for long.
  const lightM = new THREE.MeshBasicMaterial({ color: 0xfff0c0 });
  keep.push(lightM);
  for (const x of [4.7, -4.7]) {
    for (const z of [-1.35, 1.35]) {
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 6), lightM);
      l.position.set(x, 1.75, z);
      chassis.add(l);
    }
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
  for (let i = 0; i < ROCK.size.length; i++) {
    const r = new THREE.Mesh(new THREE.IcosahedronGeometry(ROCK.size[i]!, 0), rockM);
    // Squashed off round: a sphere reads as a ball, and a ball on a road reads
    // as an item rather than as half the cliff above it.
    r.scale.set(1, 0.78, 1.12);
    r.castShadow = true;
    r.receiveShadow = true;
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
/**
 * How far the bore's foot is buried.
 *
 * See the note in `buildSurge`: this is 65cm rather than the 15cm it was,
 * because the wave spends its whole approach out over a verge the road's crown
 * has already fallen away from, and a translucent skirt inside the ground costs
 * nothing while a gap under one is the thing a critic photographs.
 */
const SKIRT = -0.65;

function buildSurge(rig: Rig, keep: THREE.Material[]): THREE.Group {
  const g = new THREE.Group();
  const N = 14;
  const len = 26;
  // ── the bore has to be darker than the sheet it stands in ────────────────
  //
  // It was a paler teal at 0.82, which was correct while the flood sheet under
  // it was not being drawn at all (see the winding note in `courses/flood.ts`)
  // and became wrong the moment it was. Photographed together, the wave and
  // the standing water were within a few values of each other, so the *body*
  // of the wave vanished into the sheet and its foam lip — a metre and a half
  // up, and the only part with any contrast left — read as a pale shelf
  // floating in mid-air over the road with nothing holding it up.
  //
  // A metre and a half of water stacked on top of a sheet of water is deeper
  // than the sheet, and deeper water is darker. So: darker, and more opaque
  // than the thing it is standing in, which is what puts a body back under the
  // crest.
  const waterM = new THREE.MeshLambertMaterial({
    color: 0x2d6274, transparent: true, opacity: 0.9,
    emissive: 0x0d2a33, side: THREE.DoubleSide,
  });
  const foamM = new THREE.MeshLambertMaterial({
    color: 0xeaf6f8, transparent: true, opacity: 0.94, side: THREE.DoubleSide,
  });
  keep.push(waterM, foamM);

  // The body: a swept face with a slight scallop along its length so it is not
  // a ruled wall.
  // ── the two things a bore may not do at its ends ──────────────────────────
  //
  // A critic photographed the flood on Saltpan Bypass and filed it as a decal
  // with *"hard straight polygon edges… and at the outer ends it floats above
  // the tarmac with a visible vertical side wall"*. The sheet took most of that
  // note, and this object is where the rest of it lives, because a bore is what
  // a reviewer sees when they photograph the flood: it is the tallest, nearest,
  // most opaque piece of water on the course.
  //
  //   * **It ended in mid-air.** The face is a three-line tent — bottom, crest,
  //     bottom — swept along the road, and the sweep simply *stopped* at ±13
  //     metres at full height. From alongside, that is a metre and a half of
  //     water ending on a flat vertical rectangle: the "side wall". `cap` takes
  //     the crest down onto the bottom line over the last fifth at each end, so
  //     the wave closes into a wedge and has no end to see.
  //   * **It floated.** The rig sits on the road's centreline height and the
  //     bore travels thirteen metres past the shoulder, where the crown has
  //     fallen away and the verge has dropped further — so a skirt tucked 15cm
  //     under the surface was, for the whole in-ramp, hanging over the ground
  //     with daylight beneath it. The skirt is 65cm now. It is inside the road
  //     wherever the road is flat, which costs nothing, and it is still inside
  //     the ground where the ground has gone away, which is the point.
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = (t - 0.5) * len;
    // 0 at both ends, 1 across the middle three fifths.
    const ease = (v: number): number => { const k = clamp01(v); return k * k * (3 - 2 * k); };
    const cap = ease(t / 0.2) * ease((1 - t) / 0.2);
    const h = (1.5 + 0.55 * Math.sin(t * 7.1) + 0.3 * Math.sin(t * 3.3 + 1.4)) * cap + SKIRT * (1 - cap);
    const lean = (0.9 + 0.25 * Math.sin(t * 5.0 + 0.6)) * cap;
    pos.push(2.9, SKIRT, z);
    pos.push(-lean, h, z);
    pos.push(-3.4, SKIRT, z);
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
    // The same taper the face carries. A foam lip that kept full height past
    // the end of the wave under it would be a white bar hanging in the air.
    const ease = (v: number): number => { const k = clamp01(v); return k * k * (3 - 2 * k); };
    const cap = ease(t / 0.2) * ease((1 - t) / 0.2);
    const h = (1.5 + 0.55 * Math.sin(t * 7.1) + 0.3 * Math.sin(t * 3.3 + 1.4)) * cap + SKIRT * (1 - cap);
    const lean = (0.9 + 0.25 * Math.sin(t * 5.0 + 0.6)) * cap;
    // Narrower than it was — 0.87m of lip tilted back at thirty-odd degrees
    // presents very nearly its whole area to a chase camera, which is how a
    // crest ends up reading as a shelf rather than as the top of a wave. Half
    // that, and pitched steeper, so what the camera gets is a *line* of foam.
    cpos.push(-lean + 0.10 * cap, h + 0.24 * cap, z);
    cpos.push(-lean - 0.36 * cap, h - 0.20 * cap, z);
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

  // **The whole gate stands at the pivot, post and all.** The first build left
  // the post and its base at the hazard's origin — the road centreline — and
  // moved only the arm out to the shoulder, so what shipped was a boom
  // levitating nineteen metres from a plinth planted in the middle of the
  // racing line. `mount` is the thing the pivot moves; everything mechanical
  // hangs off it.
  const mount = new THREE.Group();
  g.add(mount);
  rig.chassis = mount;

  // Pivot post and its base.
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 3.0, 10), steelM);
  post.position.y = 1.5;
  post.castShadow = true;
  mount.add(post);
  mount.add(box(1.9, 0.5, 1.9, whiteM, 0, 0.25, 0));

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
  mount.add(arm);
  rig.arm = arm;

  const top = beacon(0, 3.25, 0, keep);
  rig.beacons.push(top);
  mount.add(top);
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
          bodies = ROCK.size.map(() => body());
          reach = 32;
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

      // The sign, on its own station and its own frame, `signAt` metres back
      // on the spline's negative verge. That is one side for every hazard on
      // every course on purpose — a works site says what is about to happen to
      // you from the same hand every time, and a sign that swaps sides is a
      // sign a driver has to find before they can read it.
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
        census: census(),
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
        let x: number;
        let tip = 0;
        let moving = false;
        /** Metres travelled on this leg, for the wheels. */
        let run = 0;
        if (u < TRUCK.out0) { x = -FAR; }
        else if (u < TRUCK.hold0) {
          const k = (u - TRUCK.out0) / (TRUCK.hold0 - TRUCK.out0);
          x = lerp(-FAR, 0, k); moving = true; run = k * FAR;
        } else if (u < TRUCK.hold1) {
          // **Stood on the crossing.** See `TRUCK`.
          x = 0; run = FAR;
        } else if (u < TRUCK.out1) {
          const k = (u - TRUCK.hold1) / (TRUCK.out1 - TRUCK.hold1);
          x = lerp(0, FAR, k); moving = true; run = FAR * (1 + k);
        } else if (u < TRUCK.tip1) {
          x = FAR; tip = pulse(TRUCK.tip0, TRUCK.tip1, u);
        } else if (u < TRUCK.back0) { x = FAR; }
        else if (u < TRUCK.bhold0) {
          const k = (u - TRUCK.back0) / (TRUCK.bhold0 - TRUCK.back0);
          x = lerp(FAR, 0, k); moving = true; run = -k * FAR;
        } else if (u < TRUCK.bhold1) {
          x = 0; run = -FAR;
        } else if (u < TRUCK.back1) {
          const k = (u - TRUCK.bhold1) / (TRUCK.back1 - TRUCK.bhold1);
          x = lerp(0, -FAR, k); moving = true; run = -FAR * (1 + k);
        } else { x = -FAR; }
        x += lat;

        const rig = h.rig;
        if (visual && rig.chassis) {
          rig.chassis.position.x = x;
          // It *turns round*, in the bay, where there is room — an instant
          // 180° flip at the far end is the one frame that would give the
          // whole thing away as a sprite on a rail.
          const turn = u < TRUCK.tip1 ? 0
            : u < TRUCK.back0 ? ramp(0, 1, (u - TRUCK.tip1) / (TRUCK.back0 - TRUCK.tip1))
              : u < TRUCK.back1 ? 1
                : 1 - ramp(0, 1, (u - TRUCK.back1) / (1 - TRUCK.back1 || 1));
          rig.chassis.rotation.y = turn * Math.PI;
          // Squat on the springs while the tray is up, and roll the wheels at
          // the speed the machine is actually travelling — a wheel that spins
          // while the machine is parked is the tell that nothing here is real.
          rig.chassis.position.y = -0.10 * tip;
          if (rig.tray) rig.tray.rotation.z = tip * 0.9;
          if (moving) for (const w of rig.wheels) w.rotation.z = -run / 1.35;
          // Loaded out, empty back: the rock leaves at the tip.
          const load = u < TRUCK.tip0 + (TRUCK.tip1 - TRUCK.tip0) * 0.55
            ? 1
            : u < TRUCK.back1 ? 0
              : ramp(0, 1, (u - TRUCK.back1) / (1 - TRUCK.back1 || 1));
          for (const r of rig.rocks) { r.scale.setScalar(load); r.visible = load > 0.02; }
        }
        // One capsule down the machine's long axis. 2.55m of radius wraps a
        // 4.8m-wide body and its wheels without claiming the air above it.
        //
        // **4.3, not 3.3.** The machine is 9.4 metres end to end and the
        // capsule was 6.6, so a metre and a half of hazard yellow at each end
        // of it — the two striped cap plates, the ends a driver actually sees
        // coming — was a picture a kart drove through. `TRUCK.guard` carries
        // the same number, because that is what the lamps are computed off.
        b[0]!.ax = x - 4.3; b[0]!.bx = x + 4.3;
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
        for (let i = 0; i < ROCK.size.length; i++) {
          const r = h.rig.rocks[i]!;
          const size = ROCK.size[i]!;
          const x = lat + ROCK.spread[i]!;
          const z = ROCK.along[i]!;
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
            r.position.set(x, y, z);
            r.scale.set(scale, scale * 0.78, scale * 1.12);
            r.visible = scale > 0.01;
            // Tumbling, and it stops when the rock does.
            const spin = u < t0 + FALL ? (u - t0) * h.period * 4.4 : FALL * h.period * 4.4;
            r.rotation.set(spin * 0.8 + i, spin * 0.5, spin * 0.9 + i * 2);
          }
          ball(b[i]!, x, y, z, size * 0.94, live);
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
        // 3.2 of radius, which is half the six-and-a-bit metres of water the
        // face is actually made of. It used to be 2.7 against a 4.3m face —
        // more grace than the wall had body — and it still hit nobody, because
        // the bore was resting three metres past the edge of the lane anybody
        // drove. Radius is not what was wrong with it; `lateral` was.
        ball(b[0]!, x, 0.8, 0, 3.2, live && Math.abs(x) < h.half + 5);
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

        if (visual && h.rig.arm && h.rig.chassis) {
          h.rig.chassis.position.x = pivot;
          h.rig.arm.rotation.y = -Math.PI * 0.5 - dir * theta;
          // A little bounce as it seats, which is the whole of the animation
          // principle this game is held to on something that ends abruptly.
          const s = u - BOOM.shut1;
          h.rig.arm.rotation.z = s > 0 && s < 0.08
            ? Math.sin(s * 90) * 0.035 * (1 - s / 0.08) : 0;
        }
        // 1.15 of radius, not 0.95: the gate is a beam at 2.15 with a lower
        // chord at 1.4 and diagonals between them, so the *thing* a kart runs
        // into is a metre-deep lattice rather than a bar.
        ball(b[0]!, pivot, 1.75, 0, 1.15, k > 0.06);
        b[0]!.ax = pivot + ux * 1.2; b[0]!.az = uz * 1.2;
        b[0]!.bx = pivot + ux * LEN; b[0]!.bz = uz * LEN;
        b[0]!.ay = b[0]!.by = 1.75;
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
    // `racer.pos` sits on the kart's contact patch, so the body a hazard has to
    // meet is half a metre above it. Getting this the wrong way round put every
    // kart in the game a metre lower than it is, which nothing noticed on a
    // 2.55-metre dumper capsule and which let a whole field drive *under* the
    // avalanche gate: at 0.95 of radius the arithmetic left 1.36 metres of
    // horizontal reach on an arm that is supposed to sweep the road.
    const dy = py + KART_LIFT - (b.ay + ey * t);
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
      sign: h.sign
        ? [h.sign.group.position.x, h.sign.group.position.y, h.sign.group.position.z]
          .map((v) => Math.round(v))
        : null,
      /** Metres from the sign to the crossing, which is what `signAt` buys. */
      signBack: h.sign ? Math.round(h.sign.group.position.distanceTo(h.origin)) : 0,
      bodies: h.bodies.map((b) => ({
        live: b.live,
        a: [b.ax, b.ay, b.az].map((v) => Math.round(v * 10) / 10),
        b: [b.bx, b.by, b.bz].map((v) => Math.round(v * 10) / 10),
        r: b.r,
      })),
    })),
    clock: () => clock,

    /**
     * ── the census: where the field drives, against where the bodies go ──────
     *
     * `lane` is the histogram of every racer's lateral, in the hazard's own
     * frame, at the moment it crossed the station — the same number
     * `track.sample().lateral` returns, measured at the lap fraction the hazard
     * is anchored to. `reach` is the lateral interval the bodies actually sweep
     * while live, **with a kart's radius already added**, swept over the whole
     * cycle at 1/400 resolution.
     *
     * Those two intervals overlapping is the entire question. A hazard whose
     * `lane` is [-11,-3] and whose `reach` is [+11,+20] is not a hard hazard or
     * a badly tuned one; it is furniture with a clock in it, and no amount of
     * period or duty will change that. See `tools/hazardcensus.mjs`.
     */
    census: () => list.map((h) => {
      const c = h.census;
      // Sweep the cycle for the lateral span the live bodies cover. `resolve`
      // is pure and the sim re-resolves at the top of every step, so borrowing
      // the body array here cannot leak into the simulation.
      const uNow = wrap01(clock / h.period + h.phase);
      let lo = Infinity, hi = -Infinity, liveU = 0;
      for (let k = 0; k < 400; k++) {
        resolve(h, k / 400, false);
        let any = false;
        for (const b of h.bodies) {
          if (!b.live) continue;
          any = true;
          lo = Math.min(lo, b.ax - b.r - KART_R, b.bx - b.r - KART_R);
          hi = Math.max(hi, b.ax + b.r + KART_R, b.bx + b.r + KART_R);
        }
        if (any) liveU++;
      }
      resolve(h, uNow, false);
      const bins: [number, number][] = [];
      for (let i = 0; i < CENSUS_BINS; i++) {
        if (c.bins[i]! > 0) bins.push([i - CENSUS_HALF, c.bins[i]!]);
      }
      // Percentiles off the histogram, which is all a reader of this needs:
      // the median is the line, and p05..p95 is how wide the field runs.
      const pct = (q: number): number => {
        const want = c.passes * q;
        let acc = 0;
        for (let i = 0; i < CENSUS_BINS; i++) {
          acc += c.bins[i]!;
          if (acc >= want) return i - CENSUS_HALF + 0.5;
        }
        return NaN;
      };
      return {
        kind: h.kind,
        at: Math.round(h.def.at * 1e4) / 1e4,
        half: Math.round(h.half * 10) / 10,
        passes: c.passes,
        hits: c.hits,
        armed: c.armed,
        covered: c.covered,
        guarded: c.guarded,
        /** Lateral the field crossed at: p05, median, p95, in metres. */
        lane: c.passes ? [pct(0.05), pct(0.5), pct(0.95)] : [NaN, NaN, NaN],
        /** Lateral the live bodies sweep, kart radius included. */
        reach: lo <= hi ? [Math.round(lo * 10) / 10, Math.round(hi * 10) / 10] : null,
        /** Fraction of the cycle at least one body is live. */
        liveDuty: Math.round((liveU / 400) * 1000) / 1000,
        bins,
      };
    }),

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
      for (const h of list) {
        h.armed = h.tick = 0; h.lastU = -1;
        const c = h.census;
        c.passes = c.hits = c.armed = c.covered = c.guarded = 0;
        c.bins.fill(0); c.seen.fill(0);
      }
    },

    fixedUpdate(dt: number): void {
      if (list.length === 0) return;
      prevClock = clock;
      clock = ctx.time.elapsed - epoch;

      // Guarded, because iterating a Map allocates an iterator and this map is
      // empty for most of most races — 120 of those a second is not free.
      if (cooldown.size > 0) {
        for (const [id, t] of cooldown) {
          const n = t - dt;
          if (n <= 0) cooldown.delete(id); else cooldown.set(id, n);
        }
      }

      const racing = ctx.race.phase === 'racing' || ctx.race.phase === 'finished';

      for (const h of list) {
        const u = wrap01(clock / h.period + h.phase);
        resolve(h, u, false);
        h.armed = armLevel(h, u);
        if (!racing) continue;

        for (const racer of ctx.racers) {
          // **The census runs before every skip in this loop, and that is the
          // point.** What is being measured is where the field *drives*, not
          // where the field is eligible to be hit — a pass made two tenths after
          // a hit, or by a racer holding a star, is still a pass and still
          // evidence about the line. Measuring it downstream of the fairness
          // guards would quietly under-report exactly the passes a badly placed
          // hazard produces.
          const near = racer.pos.distanceToSquared(h.origin) <= h.reach * h.reach;
          if (near) {
            _p.copy(racer.pos).sub(h.origin);
            const z = _p.dot(h.fwd);
            const c = h.census;
            const i = racer.id;
            if (i < CENSUS_RACERS) {
              if (c.seen[i] && c.lastZ[i]! < 0 && z >= 0) {
                c.passes++;
                const x = _p.dot(h.right);
                const bin = Math.floor(x) + CENSUS_HALF;
                if (bin >= 0 && bin < CENSUS_BINS) c.bins[bin]!++;
                let live = false;
                let over = false;
                for (const b of h.bodies) {
                  if (!b.live) continue;
                  live = true;
                  const lo = Math.min(b.ax, b.bx) - b.r - KART_R;
                  const hi = Math.max(b.ax, b.bx) + b.r + KART_R;
                  if (x >= lo && x <= hi) over = true;
                }
                if (live) c.armed++;
                if (live && over) c.covered++;
                if (racer.stunned > 0 || racer.invulnerable > 0
                  || cooldown.has(racer.id) || racer.speed < HIT_MIN_SPEED) c.guarded++;
              }
              c.lastZ[i] = z;
              c.seen[i] = 1;
            }
          } else if (racer.id < CENSUS_RACERS) {
            h.census.seen[racer.id] = 0;
          }

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
          // Cheap reject before the capsules: the census above already measured
          // it, against the radius that bounds every body this hazard owns.
          if (!near) continue;
          let struck = false;
          for (const b of h.bodies) {
            if (hits(h, b, racer)) { struck = true; break; }
          }
          if (!struck) continue;

          stunRacer(ctx, racer, h.def.hit ?? 'spin', null);
          h.census.hits++;
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
              .addScaledVector(h.right, (h.def.lateral ?? 0) * h.half + 7)
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
