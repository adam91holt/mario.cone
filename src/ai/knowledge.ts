// What a CPU knows about the circuit before the flag drops.
//
// The old brain read one spline sample ahead of itself and guessed. That is why
// it spent a quarter of every race in the gravel: a lookahead point tells you
// where the road goes, not how fast you may arrive there, and a kart that
// arrives at Digger's Elbow at 58 m/s is off the road no matter how well it
// steers.
//
// A real driver knows the lap. So this module walks the circuit once, at track
// build, and produces two things:
//
//   TrackKnowledge  driver-agnostic geometry — the worn line, road width, the
//                   curvature of that line, where the corners start and end,
//                   where the boost strips and the gravel cut are.
//   DriverPlan      one per CPU: *their* line through it, and the speed they
//                   intend to be doing at every metre of the lap.
//
// The speed plan is the important half, and it is built against this game's
// actual handling model rather than a generic friction circle. A kart here is
// limited by *yaw rate*, not grip: `turnRate` falls away with speed on a curve
// (config.kart.steerSpeedFalloff), so the tightest path curvature available at
// speed v is turnRate(v)/v. Inverting that gives the honest corner speed, and a
// backward pass down the lap turns it into braking points. The result is a CPU
// that brakes because the corner is coming, at a distance that is *correct for
// the kart it is driving* — a train plans differently from a helicopter without
// a single per-vehicle constant being written down.
//
// A note on sign, because everything here depends on it. The track spline's
// `right` vector points to the *driver's left*, so a positive lateral offset is
// to the driver's left, and positive curvature is a corner that turns to the
// driver's right. Every lateral in this module is in that frame, which is the
// frame `spline.pointAt` and `spline.nearest` already speak.
//
// Everything here runs at build/reset. Nothing in it allocates per frame.

import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/math.ts';
import { buildRacingLine, type RacingLine } from '../track/racingline.ts';
import type { TrackSpline } from '../track/spline.ts';
import { features } from '../track/courses/types.ts';
import type { Config } from '../core/config.ts';
import type { SplineSample, Track, VehicleStats } from '../types.ts';

/** Station pitch, metres. Fine enough for a 28m hairpin, cheap enough to be free. */
const STEP = 4;
/** How close to the barrier a plan is willing to put the kart. */
const EDGE_MARGIN = 2.6;
/** Curvature above which a station counts as "in a corner" (R ≈ 200m). */
const CORNER_K = 0.005;
/** A flat patch shorter than this, inside a corner, is still the corner. */
const CORNER_MERGE = 18;
/** Shorter than this and there is nothing to plan for. */
const CORNER_MIN = 16;

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _sample: SplineSample = blankSample();

function blankSample(): SplineSample {
  return {
    pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
    right: new THREE.Vector3(), up: new THREE.Vector3(),
    width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
  };
}

/** A single corner, in the terms a driver plans one: turn in, apex, get out. */
export interface CornerSeg {
  /** Spline distance where the road starts to bend. */
  d0: number;
  /** ...and where it stops. May exceed the lap length; reads wrap. */
  d1: number;
  apex: number;
  /** Arc length, metres. */
  len: number;
  /** +1 turns to the driver's right, -1 to their left. */
  dir: -1 | 1;
  /** Peak curvature of the worn line through it, 1/m. */
  k: number;
}

/** A boost strip, in track coordinates. */
export interface PadSeg {
  d0: number;
  d1: number;
  /** Lateral offset of the strip's centre, metres. */
  lat: number;
}

/** The gravel line across the inside of a corner. */
export interface CutSeg {
  /** Where the kart must already be on the gravel. */
  d0: number;
  d1: number;
  /** Lateral offset of the cut, metres. */
  lat: number;
  /** Where a kart has to start moving over to make it. */
  approach: number;
  /** Where it is back on tarmac. */
  rejoin: number;
  /** Metres of lap this saves. */
  save: number;
}

export interface TrackKnowledge {
  readonly id: string;
  readonly length: number;
  readonly n: number;
  readonly step: number;
  /** Lateral offset of the worn racing line, per station. */
  readonly baseLat: Float32Array;
  /** Road half-width, per station. */
  readonly half: Float32Array;
  /** Curvature of the worn line, per station, signed. */
  readonly baseK: Float32Array;
  readonly corners: readonly CornerSeg[];
  readonly pads: readonly PadSeg[];
  readonly cuts: readonly CutSeg[];
  /** Corner index owning each station, or -1. */
  readonly cornerOf: Int16Array;
  readonly line: RacingLine;
  /** Station index for a lap distance. */
  station(d: number): number;
  /** Linear-interpolated read of any per-station table. */
  read(table: Float32Array, d: number): number;
}

const wrapIndex = (i: number, n: number): number => ((i % n) + n) % n;

function readTable(table: Float32Array, d: number, L: number, n: number): number {
  const u = ((((d % L) + L) % L) / L) * n;
  const i0 = wrapIndex(Math.floor(u), n);
  const i1 = wrapIndex(i0 + 1, n);
  const f = u - Math.floor(u);
  return table[i0] + (table[i1] - table[i0]) * f;
}

function smooth(src: Float32Array, half: number): Float32Array {
  const n = src.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, weight = 0;
    for (let k = -half; k <= half; k++) {
      const w = 1 - Math.abs(k) / (half + 1);
      sum += src[wrapIndex(i + k, n)] * w;
      weight += w;
    }
    out[i] = sum / weight;
  }
  return out;
}

/**
 * Curvature of a driven line, not of the centreline.
 *
 * This is the whole reason a racing line is worth driving: swinging wide on
 * entry and clipping the apex turns a 28m corner into a 45m one, and a driver
 * has to plan against the radius they are actually going to travel or they
 * brake for a corner they were never going to take. Three consecutive points on
 * the line, the signed curvature of the circle through them, negated so the
 * sign matches the spline's own convention.
 */
function pathCurvature(track: Track, lat: Float32Array, step: number, n: number): Float32Array {
  const raw = new Float32Array(n);
  const spline = track.spline;
  for (let i = 0; i < n; i++) {
    const a = wrapIndex(i - 1, n);
    const c = wrapIndex(i + 1, n);
    spline.pointAt(a * step, lat[a], 0, _p0);
    spline.pointAt(i * step, lat[i], 0, _p1);
    spline.pointAt(c * step, lat[c], 0, _p2);
    const ax = _p1.x - _p0.x, az = _p1.z - _p0.z;
    const bx = _p2.x - _p1.x, bz = _p2.z - _p1.z;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    const lc = Math.hypot(_p2.x - _p0.x, _p2.z - _p0.z);
    const denom = la * lb * lc;
    raw[i] = denom < 1e-6 ? 0 : -(2 * (ax * bz - az * bx)) / denom;
  }
  // The spline's own sample noise shows up as curvature chatter, and chatter in
  // the plan becomes chatter on the throttle.
  return smooth(raw, 3);
}

/**
 * Cut the lap into corners.
 *
 * A "corner" here is a run of stations bending the same way hard enough to
 * matter, with short straight bits inside it swallowed — Cone Canyon's T1 dips
 * below the threshold twice in the middle and is still, to a driver, one long
 * banked right.
 */
function segmentCorners(k: Float32Array, step: number, n: number): CornerSeg[] {
  const sideOf = (i: number): number =>
    (Math.abs(k[i]) < CORNER_K ? 0 : k[i] > 0 ? 1 : -1);

  // Start the walk on a genuinely straight station so no corner is cut in half
  // by the array's own seam.
  let origin = 0;
  for (let i = 0; i < n; i++) {
    if (sideOf(i) === 0 && sideOf(wrapIndex(i + 1, n)) === 0) { origin = i; break; }
  }

  const mergeSteps = Math.max(1, Math.round(CORNER_MERGE / step));
  const out: CornerSeg[] = [];
  let i = 0;
  while (i < n) {
    const side = sideOf(wrapIndex(origin + i, n));
    if (side === 0) { i++; continue; }

    let j = i;
    for (;;) {
      if (j + 1 >= n) break;
      const next = sideOf(wrapIndex(origin + j + 1, n));
      if (next === side) { j++; continue; }
      if (next !== 0) break;
      // A flat patch: swallow it only if the same corner resumes on the far side.
      let gap = 1;
      while (gap <= mergeSteps && j + 1 + gap < n
        && sideOf(wrapIndex(origin + j + 1 + gap, n)) === 0) gap++;
      if (gap > mergeSteps) break;
      if (j + 1 + gap >= n) break;
      if (sideOf(wrapIndex(origin + j + 1 + gap, n)) !== side) break;
      j += gap + 1;
    }

    const len = (j - i + 1) * step;
    if (len >= CORNER_MIN) {
      let apexIdx = i;
      let peak = 0;
      for (let s = i; s <= j; s++) {
        const a = Math.abs(k[wrapIndex(origin + s, n)]);
        if (a > peak) { peak = a; apexIdx = s; }
      }
      const d0 = wrapIndex(origin + i, n) * step;
      out.push({
        d0,
        d1: d0 + len,
        apex: wrapIndex(origin + apexIdx, n) * step,
        len,
        // Positive curvature turns to the driver's right.
        dir: side > 0 ? 1 : -1,
        k: peak,
      });
    }
    i = j + 1;
  }
  return out;
}

/**
 * Where the boost strips are.
 *
 * Read from the course's own feature list rather than probed off the surface
 * query: the declaration is exact and free. The single probe confirms the
 * placement maths still agrees with the track builder's, so a strip the AI
 * cannot find is simply a strip it does not divert for — a graceful failure
 * rather than a kart aiming at bare tarmac.
 */
function findPads(track: Track, L: number): PadSeg[] {
  const feat = features(track.course);
  const start = track.course.startDistance ?? 0;
  const out: PadSeg[] = [];
  for (const def of feat.pads ?? []) {
    const d = (((start + def.at * L) % L) + L) % L;
    track.spline.atDistance(d, _sample);
    const lat = (def.lateral ?? 0) * _sample.width * 0.5;
    const halfLen = (def.length ?? 16) * 0.5;
    track.spline.pointAt(d, lat, 0.4, _probe);
    if (track.sample(_probe, _sample).surface !== 'boost') continue;
    out.push({ d0: d - halfLen, d1: d + halfLen, lat });
  }
  return out;
}

/**
 * Where the lap can be cut.
 *
 * The gravel line across a corner's inside is shorter and slower — worth it
 * carrying a boost, a disaster from a standing start. `save` is the honest
 * saving in metres, which is what lets a driver make that trade rather than
 * treating the cut as a landmark to visit every lap.
 */
function findCuts(track: Track, L: number): CutSeg[] {
  const feat = features(track.course);
  const start = track.course.startDistance ?? 0;
  const verge = track.course.vergeWidth ?? 5;
  const out: CutSeg[] = [];
  for (const sc of feat.shortcuts ?? []) {
    const d0 = (((start + sc.from * L) % L) + L) % L;
    const span = (sc.to - sc.from) * L;
    track.spline.atDistance(d0 + span * 0.5, _sample);
    // The worn cut runs from 0.12 to 0.95 of the verge; its middle is where a
    // kart sits without either brushing the tarmac or falling off the far edge
    // into the sand.
    const lat = sc.side * (_sample.width * 0.5 + verge * 0.52);
    // Chord against arc: the cut travels a straighter path across the same
    // corner, and the saving is what that straightening is worth.
    track.spline.pointAt(d0, lat, 0, _p0);
    track.spline.pointAt(d0 + span, lat, 0, _p1);
    out.push({
      d0,
      d1: d0 + span,
      lat,
      approach: d0 - 34,
      rejoin: d0 + span + 16,
      save: Math.max(0, span - _p0.distanceTo(_p1)),
    });
  }
  return out;
}

// ── track knowledge ─────────────────────────────────────────────────────────

const cache = new Map<string, TrackKnowledge>();

/** Built once per course and shared by the whole field. */
export function knowledgeFor(track: Track): TrackKnowledge {
  const key = `${track.id}:${Math.round(track.length)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // One course is the common case, a cup is a handful. Never unbounded.
  if (cache.size > 6) cache.clear();
  const built = buildKnowledge(track);
  cache.set(key, built);
  return built;
}

function buildKnowledge(track: Track): TrackKnowledge {
  const spline = track.spline;
  const L = track.length;
  const n = Math.max(16, Math.round(L / STEP));
  const step = L / n;

  const line = buildRacingLine(spline as unknown as TrackSpline, EDGE_MARGIN + 0.5);
  const baseLat = new Float32Array(n);
  const half = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const d = i * step;
    spline.atDistance(d, _sample);
    half[i] = _sample.width * 0.5;
    const lim = Math.max(1, half[i] - EDGE_MARGIN);
    baseLat[i] = clamp(line.lateralAt(d), -lim, lim);
  }

  const baseK = pathCurvature(track, baseLat, step, n);
  const corners = segmentCorners(baseK, step, n);
  const cornerOf = new Int16Array(n).fill(-1);
  for (let c = 0; c < corners.length; c++) {
    const seg = corners[c];
    for (let d = seg.d0; d < seg.d1; d += step) {
      cornerOf[wrapIndex(Math.round(d / step), n)] = c;
    }
  }

  return {
    id: track.id,
    length: L,
    n,
    step,
    baseLat,
    half,
    baseK,
    corners,
    cornerOf,
    line,
    pads: findPads(track, L),
    cuts: findCuts(track, L),
    station: (d) => wrapIndex(Math.floor((((d % L) + L) % L) / step), n),
    read: (table, d) => readTable(table, d, L, n),
  };
}

// ── per-driver plan ─────────────────────────────────────────────────────────

export interface PlanInputs {
  /** 0..1 how close to the limit this driver plans. */
  bravery: number;
  driftLove: number;
  /** Metres the apex is shifted along the road. */
  apexShift: number;
  lineGain: number;
  /** Constant lateral bias, metres. */
  linePreference: number;
  skill: number;
  stats: VehicleStats;
  /** Top-speed multiplier for the engine class. */
  classMul: number;
}

export interface DriverPlan {
  readonly know: TrackKnowledge;
  /** This driver's target lateral offset, per station. */
  readonly lat: Float32Array;
  /** Curvature of that line. */
  readonly k: Float32Array;
  /** Speed this driver intends to be doing, per station. */
  readonly v: Float32Array;
  /** Mini-turbo tier this driver is aiming for in each corner; 0 = no drift. */
  readonly tier: Uint8Array;
  /** Fraction of full lock this driver holds in reserve for corrections. */
  readonly authority: number;
  latAt(d: number): number;
  vAt(d: number): number;
  kAt(d: number): number;
  /** Corner containing `d`, or null. */
  cornerAt(d: number): CornerSeg | null;
  cornerIndexAt(d: number): number;
}

/** Yaw authority at a given speed — the kart model's own steering curve. */
export function turnRateAt(cfg: Config, speed: number, handling: number): number {
  const K = cfg.kart;
  const h = lerp(0.85, 1.18, handling);
  const frac = clamp01(Math.abs(speed) / Math.max(1, K.maxSpeed));
  return K.steerRate * h * (1 - K.steerSpeedFalloff * Math.pow(frac, K.steerFalloffCurve));
}

/**
 * The fastest a kart may travel and still hold curvature `k`.
 *
 * turnRate/v is strictly decreasing in v, so a bisection converges in a couple
 * of dozen halvings and needs no closed form — which matters, because a closed
 * form would have to be rewritten every time the handling curve is retuned, and
 * this must never drift out of sync with the physics.
 */
function speedForCurvature(
  cfg: Config, k: number, handling: number, authority: number, ceiling: number,
): number {
  if (k < 1e-5) return ceiling;
  if (authority * turnRateAt(cfg, ceiling, handling) / ceiling >= k) return ceiling;
  let lo = 2, hi = ceiling;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) * 0.5;
    if (authority * turnRateAt(cfg, mid, handling) / mid > k) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Build one driver's line and speed plan.
 *
 * Order matters: the line comes first because the speed depends on the radius
 * of the line, then the drift intent (a committed drift holds more curvature
 * than the tyres alone), then the backward pass that turns corner speeds into
 * braking points.
 */
export function buildPlan(
  cfg: Config, track: Track, know: TrackKnowledge, p: PlanInputs,
): DriverPlan {
  const n = know.n;
  const L = know.length;
  const step = know.step;
  const K = cfg.kart;

  // ── the line ──────────────────────────────────────────────────────────
  // The apex shift is a phase shift on the worn line, which is exactly what
  // cornering style is: the same swing, arriving early or late. An early-apex
  // driver has already turned in where a late-apex driver is still running
  // wide, and they are physically in different places on the road — which is
  // what makes one of them passable on the exit and the other on the entry.
  const lat = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = i * step;
    const lim = Math.max(1.2, know.half[i] - EDGE_MARGIN);
    lat[i] = clamp(
      know.line.lateralAt(d - p.apexShift) * p.lineGain + p.linePreference, -lim, lim);
  }

  const k = pathCurvature(track, lat, step, n);

  // ── where this driver drifts ──────────────────────────────────────────
  const handling = p.stats.handling;
  const topSpeed = K.maxSpeed * lerp(0.86, 1.14, p.stats.speed) * p.classMul;
  // Authority the driver leaves for corrections. Brave drivers leave almost
  // none, which is why they are the ones who run wide when something goes
  // slightly wrong.
  const authority = clamp(lerp(0.70, 0.95, p.bravery) * lerp(0.90, 1, p.skill), 0.55, 0.96);
  const chargeRate = K.drift.chargeRate * lerp(0.8, 1.2, handling);
  const tier = new Uint8Array(know.corners.length);
  const drifting = new Uint8Array(n);

  for (let c = 0; c < know.corners.length; c++) {
    const seg = know.corners[c];
    const gripV = speedForCurvature(cfg, seg.k, handling, authority, topSpeed);
    // How much charge this corner is actually good for, at the speed it will be
    // taken. A corner that cannot bank a tier is not worth going sideways in.
    const charge = chargeRate * (seg.len / Math.max(8, gripV)) * 0.85;
    let want = 0;
    for (let t = 0; t < K.drift.tiers.length; t++) if (charge >= K.drift.tiers[t].at) want = t + 1;
    const appetite = p.driftLove > 0.8 ? 3 : p.driftLove > 0.5 ? 2 : 1;
    const worth = seg.k > lerp(0.017, 0.006, p.driftLove);
    if (!worth || want === 0 || gripV < K.drift.minSpeed * 1.25) continue;
    tier[c] = Math.min(want, appetite);
    for (let d = seg.d0; d < seg.d1; d += step) drifting[wrapIndex(Math.round(d / step), n)] = 1;
  }

  // ── the speed plan ────────────────────────────────────────────────────
  const v = new Float32Array(n);
  // A boosted kart may legitimately be doing far more than its own top speed on
  // a straight, and must not be told to brake for that.
  const ceiling = topSpeed * 1.45;
  for (let i = 0; i < n; i++) {
    // A committed drift rotates the chassis faster than the tyres alone can, so
    // it carries more curvature — but it also throws away most of the lateral
    // grip, so the gain is nothing like the raw 1.7x yaw bonus.
    v[i] = speedForCurvature(
      cfg, Math.abs(k[i]), handling, authority * (drifting[i] ? 1.28 : 1), ceiling);
  }

  // Braking. Walk the lap backwards twice — twice because the limit set by the
  // hairpin has to propagate back across the array's own seam — and never let a
  // station ask for more speed than can be shed before the next one.
  //
  // `decel` is deliberately below what the brakes can actually do (30 m/s² plus
  // engine braking). A driver who plans for the absolute limit has no margin
  // left when they arrive a metre late, and the visible result is a kart that
  // misses its braking point and ploughs into the gravel.
  const decel = lerp(15, 26, p.bravery);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const next = v[wrapIndex(i + 1, n)];
      const reach = Math.sqrt(next * next + 2 * decel * step);
      if (v[i] > reach) v[i] = reach;
    }
  }

  const cornerIndexAt = (d: number): number => know.cornerOf[know.station(d)];

  return {
    know,
    lat,
    k,
    v,
    tier,
    authority,
    latAt: (d) => readTable(lat, d, L, n),
    vAt: (d) => readTable(v, d, L, n),
    kAt: (d) => readTable(k, d, L, n),
    cornerIndexAt,
    cornerAt: (d) => {
      const idx = cornerIndexAt(d);
      return idx >= 0 ? know.corners[idx] : null;
    },
  };
}
