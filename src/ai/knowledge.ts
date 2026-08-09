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
/**
 * How close to the barrier a plan is willing to put the kart.
 *
 * A kart is a little over two metres wide and the line is authored to its
 * centre, so this is roughly "outside wheel on the kerb". The driver tightens
 * it further at speed (driver.ts, `laneLimit`) — a plan that runs to the paint
 * at 25 m/s is racing, the same plan at 75 m/s is a kart in the gravel.
 */
const EDGE_MARGIN = 2.8;
/** Curvature above which a station counts as "in a corner" (R ≈ 200m). */
const CORNER_K = 0.005;
/** A flat patch shorter than this, inside a corner, is still the corner. */
const CORNER_MERGE = 18;
/** Shorter than this and there is nothing to plan for. */
const CORNER_MIN = 16;
/**
 * The steepest angle, as a gradient, at which a line may cross the road.
 * 0.16 is a shade over nine degrees — about what a kart can actually hold
 * against the tarmac while still pointing down the circuit.
 */
const MAX_LINE_SLOPE = 0.16;

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
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

/**
 * The circuit's geometry, flattened into plain arrays.
 *
 * Every line this module builds is `centre(d) + right(d) * lat(d)`, and the
 * relaxation below evaluates that a few thousand times. Going through
 * `spline.pointAt` for each of those means a binary search per sample; caching
 * the station positions and their right vectors turns the whole thing into
 * arithmetic, which is what makes it affordable to iterate.
 */
interface LineGeom {
  px: Float32Array;
  pz: Float32Array;
  rx: Float32Array;
  rz: Float32Array;
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
  /** Curvature of the road's own centreline, same sign convention. */
  readonly roadK: Float32Array;
  readonly geom: LineGeom;
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

function smooth(src: Float32Array, half: number, into?: Float32Array): Float32Array {
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
  if (!into) return out;
  into.set(out);
  return into;
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
 *
 * The stencil is two stations wide rather than one: at a 4m pitch the spline's
 * own sampling noise is the same size as the bend being measured, and a plan
 * built on noisy curvature brakes for corners that are not there.
 */
function pathCurvature(g: LineGeom, lat: Float32Array, n: number, out?: Float32Array): Float32Array {
  const raw = out ?? new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = wrapIndex(i - 2, n);
    const c = wrapIndex(i + 2, n);
    const p0x = g.px[a] + g.rx[a] * lat[a], p0z = g.pz[a] + g.rz[a] * lat[a];
    const p1x = g.px[i] + g.rx[i] * lat[i], p1z = g.pz[i] + g.rz[i] * lat[i];
    const p2x = g.px[c] + g.rx[c] * lat[c], p2z = g.pz[c] + g.rz[c] * lat[c];
    const ax = p1x - p0x, az = p1z - p0z;
    const bx = p2x - p1x, bz = p2z - p1z;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    const lc = Math.hypot(p2x - p0x, p2z - p0z);
    const denom = la * lb * lc;
    raw[i] = denom < 1e-6 ? 0 : -(2 * (ax * bz - az * bx)) / denom;
  }
  // Chatter in the plan becomes chatter on the throttle.
  return smooth(raw, 2, raw);
}

/**
 * Straight-line the chicane.
 *
 * The worn line is built by an unsharp mask, which is right for a corner and
 * badly wrong for a quick esse: it swings the full width of the road for every
 * bend, and through three bends in ninety metres that swing demands a radius no
 * kart owns. A plan built on it brakes to 27 m/s for a section that can be
 * taken at 55, and the driver chasing it ends up in the gravel on the way out.
 *
 * So: wherever the *line* bends appreciably harder than the road it is drawn
 * on, relax it toward its neighbours. A hairpin is untouched — there the road
 * is already the tightest thing about the corner — while an esse collapses
 * toward a straight, which is exactly what a driver does with one.
 */
function relaxLine(
  g: LineGeom, lat: Float32Array, roadK: Float32Array, half: Float32Array,
  n: number, step: number,
): void {
  const k = new Float32Array(n);
  const next = new Float32Array(n);
  // The stencil is deliberately wide. What has to go is a swing forty metres
  // long, and a three-point Laplacian only reaches a couple of stations however
  // many times it is applied — it rounds the corners off the swing and leaves
  // the swing.
  const REACH = 4;
  for (let pass = 0; pass < 14; pass++) {
    pathCurvature(g, lat, n, k);
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const limit = Math.abs(roadK[i]) * 1.3 + 0.0032;
      const excess = Math.abs(k[i]) - limit;
      if (excess <= 0) { next[i] = lat[i]; continue; }
      const a = lat[wrapIndex(i - REACH, n)];
      const c = lat[wrapIndex(i + REACH, n)];
      const w = clamp01(excess / (limit + 0.004)) * 0.5;
      next[i] = lerp(lat[i], (a + c) * 0.5, w);
      moved++;
    }
    for (let i = 0; i < n; i++) {
      const lim = Math.max(1.2, half[i] - EDGE_MARGIN);
      lat[i] = clamp(next[i], -lim, lim);
    }
    limitSlope(lat, n, step);
    if (moved === 0) break;
  }
  limitSlope(lat, n, step);
}

/**
 * How fast the line is allowed to cross the road.
 *
 * Curvature alone does not catch the thing that actually hurts: a line that
 * slides sixteen metres across the road in forty is asking the kart to travel
 * at twenty degrees to the tarmac, and no amount of steering makes that happen
 * at seventy metres a second. The driver simply lags it, and the lag *is* the
 * kart running wide. A racing line moves across the road at a shallow angle;
 * this is that angle, swept forwards and then backwards so neither end of a
 * swing survives it.
 */
function limitSlope(lat: Float32Array, n: number, step: number): void {
  const maxStep = MAX_LINE_SLOPE * step;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const a = wrapIndex(i - 1, n);
      if (lat[i] - lat[a] > maxStep) lat[i] = lat[a] + maxStep;
      else if (lat[a] - lat[i] > maxStep) lat[i] = lat[a] - maxStep;
    }
    for (let i = n - 1; i >= 0; i--) {
      const c = wrapIndex(i + 1, n);
      if (lat[i] - lat[c] > maxStep) lat[i] = lat[c] + maxStep;
      else if (lat[c] - lat[i] > maxStep) lat[i] = lat[c] - maxStep;
    }
  }
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
    // The worn cut runs from 0.12 to 0.95 of the verge, and the kart wants to
    // sit inside its own width of the middle: brushing the tarmac wastes the
    // shortcut, and a metre too far the other way is the sand, which is half
    // again as slow as the gravel and ends at a barrier.
    const lat = sc.side * (_sample.width * 0.5 + verge * 0.42);
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

  const line = buildRacingLine(spline as unknown as TrackSpline, EDGE_MARGIN + 0.4);
  const baseLat = new Float32Array(n);
  const half = new Float32Array(n);
  const geom: LineGeom = {
    px: new Float32Array(n), pz: new Float32Array(n),
    rx: new Float32Array(n), rz: new Float32Array(n),
  };
  /** All zeros: the centreline is the line with no lateral offset at all. */
  const centre = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const d = i * step;
    spline.atDistance(d, _sample);
    half[i] = _sample.width * 0.5;
    geom.px[i] = _sample.pos.x; geom.pz[i] = _sample.pos.z;
    geom.rx[i] = _sample.right.x; geom.rz[i] = _sample.right.z;
    const lim = Math.max(1, half[i] - EDGE_MARGIN);
    baseLat[i] = clamp(line.lateralAt(d), -lim, lim);
  }
  // The road's own curvature, measured the same way and at the same scale as
  // every line curvature here. `SplineSample.curvature` is available and would
  // be free, but the spline measures it over a much longer baseline, so it
  // under-reports a tight corner by a factor of two — and every rule below
  // compares a line against the road, so the two have to be measured with the
  // same ruler or the comparison is meaningless.
  const roadK = pathCurvature(geom, centre, n);

  relaxLine(geom, baseLat, roadK, half, n, step);
  const baseK = pathCurvature(geom, baseLat, n);
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
    roadK,
    geom,
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
  /** Per boost strip: is leaving the line for it actually worth it here? */
  readonly padWorth: readonly boolean[];
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
 * The tightest path curvature the kart can hold at `speed`.
 *
 * The inverse of `speedForCurvature`, and the number a driver needs when the
 * question is "can I still make this" rather than "how fast may I arrive".
 */
export function curvatureLimit(
  cfg: Config, speed: number, handling: number, authority = 1,
): number {
  return (authority * turnRateAt(cfg, speed, handling)) / Math.max(4, Math.abs(speed));
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
  // `apexShift` and `lineGain` can re-break a line the shared pass already
  // straightened — shifting a swing along the road puts its steepest part
  // somewhere new — so each driver's own line gets the same treatment.
  relaxLine(know.geom, lat, know.roadK, know.half, n, step);

  const k = pathCurvature(know.geom, lat, n);

  // ── where this driver drifts ──────────────────────────────────────────
  const handling = p.stats.handling;
  const topSpeed = K.maxSpeed * lerp(0.86, 1.14, p.stats.speed) * p.classMul;
  // Authority the driver leaves for corrections. Brave drivers leave almost
  // none, which is why they are the ones who run wide when something goes
  // slightly wrong.
  const authority = clamp(lerp(0.70, 0.94, p.bravery) * lerp(0.88, 1, p.skill), 0.56, 0.94);
  const chargeRate = K.drift.chargeRate * lerp(0.8, 1.2, handling);
  const tier = new Uint8Array(know.corners.length);
  const drifting = new Uint8Array(n);

  for (let c = 0; c < know.corners.length; c++) {
    const seg = know.corners[c];
    // The curvature *this* driver's line asks for through the corner, not the
    // worn line's: an early-apex driver and a late-apex one are on different
    // radii and one of them may need a drift where the other does not.
    const kNeed = Math.max(Math.abs(readTable(k, seg.apex, L, n)), seg.k * 0.6);
    const gripV = speedForCurvature(cfg, kNeed, handling, authority, topSpeed);
    // How much charge this corner is actually good for, at the speed it will be
    // taken. A corner that cannot bank a tier is not worth going sideways in.
    const charge = chargeRate * (seg.len / Math.max(8, gripV)) * 0.85;
    let want = 0;
    for (let t = 0; t < K.drift.tiers.length; t++) if (charge >= K.drift.tiers[t].at) want = t + 1;
    const appetite = p.driftLove > 0.8 ? 3 : p.driftLove > 0.5 ? 2 : 1;

    // Is a drift even the right shape for this corner?
    //
    // A committed drift cannot be driven straight: steering all the way *out*
    // of it still holds `counterSteer * yawBonus` of the kart's turn rate, and
    // that arc is the widest one on offer. Through a 116m kink at 62 m/s the
    // widest drift available is a 82m radius — so a driver who commits there is
    // choosing to turn a third harder than the corner asks, and the only way
    // out of the resulting arc is to stop drifting. Measured, that one kink was
    // enough to put the whole field on the dirt for the next two hundred
    // metres. So: only where the corner is genuinely tighter than a drift's
    // widest arc, which is the same thing as saying only where a drift is a
    // tool rather than a decoration.
    const widest = K.drift.counterSteer * K.drift.yawBonus
      * turnRateAt(cfg, gripV, handling) / Math.max(8, gripV);
    // Margin on top, so the stick lands inside the band rather than pinned to
    // the wide end of it, where a kart has no answer left if it arrives a
    // fraction hot. And nothing that can be taken flat: a drift through a
    // corner that did not need one is a slide, a scrub and a lost second.
    const worth = kNeed > widest * lerp(1.14, 0.96, p.driftLove)
      && gripV < topSpeed * 0.97;
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
    // A speed plan may never *depend* on a drift.
    //
    // A committed drift does rotate the chassis faster than the tyres alone
    // can, and pricing the corner at that speed is tempting. But the drift is
    // the one part of this plan the driver is allowed to decide against at the
    // last moment — because the road is busy, because it is already fighting
    // for grip, because it arrived at the wrong angle — and a plan that has
    // already spent the drift's curvature sends it into the corner ten m/s too
    // fast with no way of paying. Measured, that mismatch alone was most of the
    // remaining off-road time. So the drift is a bonus the driver banks, never
    // a promise the plan makes.
    //
    // The tighter the corner, the more of the limit is held back: the same
    // metre of tracking error is a much larger fraction of a 40m radius than of
    // a 130m one, and a hairpin is where an optimistic plan gets found out.
    const kHere = Math.abs(k[i]);
    const margin = 1 - 0.26 * clamp01(kHere / 0.028);
    v[i] = speedForCurvature(cfg, kHere, handling, authority * margin, ceiling);
    // ...but a line is a promise the kart has to keep, and no kart keeps one
    // exactly. Swinging out-in-out genuinely opens a corner up — that is the
    // whole point of a racing line — yet the plan reads that opening off a
    // geometric ideal the driver is never precisely on, and every metre it is
    // off puts the real radius back toward the road's own. A corner may
    // therefore be planned as up to a third wider than the tarmac it is cut
    // into, and no wider. Without this ceiling the plan arrives at a 66m bend
    // believing it is a 91m one, and is a car's width into the gravel before it
    // finds out otherwise.
    const roadCap = speedForCurvature(
      cfg, Math.abs(know.roadK[i]) * 0.72, handling, 0.98, ceiling);
    if (v[i] > roadCap) v[i] = roadCap;
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

  // ── which boost strips are worth having ───────────────────────────────
  // A pad is 0.9s of held speed, and `boost.pull` drags the kart *up* to that
  // speed whether or not the brake is down. Sixteen metres before a hairpin
  // that is not a reward, it is a trap: the strip carries the kart through its
  // own braking zone at full noise and deposits it in the gravel on the far
  // side. So a driver checks what the road does with the boost before deciding
  // to leave the line for it — the same call a player makes on lap two.
  const padWorth = know.pads.map((pad) => {
    const here = readTable(v, pad.d0, L, n);
    let low = Infinity;
    for (let i = 0; i <= 7; i++) {
      const vi = readTable(v, pad.d1 + i * 10, L, n);
      if (vi < low) low = vi;
    }
    return low > here * 0.6;
  });

  return {
    know,
    lat,
    k,
    v,
    tier,
    authority,
    padWorth,
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
