// Arc-length parameterised track centreline.
//
// Everything spatial hangs off this: road mesh generation, surface queries, race
// progress, AI racing lines, homing projectiles, the minimap. It has to be both
// accurate and fast — `nearest()` runs for every racer every fixed step, so it
// uses a uniform grid rather than scanning the whole sample table.

import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../core/math.ts';
import type { ControlPoint, SplineSample, TrackSplineLike } from '../types.ts';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export interface SplineOptions {
  closed?: boolean;
  samples?: number;
  defaultWidth?: number;
  tension?: number;
}

function blankSample(): SplineSample {
  return {
    pos: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    right: new THREE.Vector3(),
    up: new THREE.Vector3(),
    width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
  };
}

export class TrackSpline implements TrackSplineLike {
  readonly closed: boolean;
  readonly defaultWidth: number;
  readonly controls: ControlPoint[];
  readonly curve: THREE.CatmullRomCurve3;

  length = 0;
  sampleCount = 0;

  private _pos!: Float32Array;
  private _tan!: Float32Array;
  private _right!: Float32Array;
  private _up!: Float32Array;
  private _cum!: Float32Array;
  private _width!: Float32Array;
  private _bank!: Float32Array;
  private _curv!: Float32Array;

  private _grid!: Array<number[] | undefined>;
  private _gMinX = 0;
  private _gMinZ = 0;
  private _gCell = 1;
  private _gW = 1;
  private _gH = 1;

  private _scratch: SplineSample = blankSample();

  constructor(points: ControlPoint[], opts: SplineOptions = {}) {
    this.closed = opts.closed !== false;
    this.defaultWidth = opts.defaultWidth ?? 22;
    this.controls = points;

    this.curve = new THREE.CatmullRomCurve3(
      points.map((p) => new THREE.Vector3(p.x, p.y ?? 0, p.z)),
      this.closed,
      'catmullrom',
      opts.tension ?? 0.5,
    );

    this._build(opts.samples ?? Math.max(1200, points.length * 24));
  }

  private _build(sampleCount: number): void {
    const N = sampleCount;
    this.sampleCount = N;

    const pos = new Float32Array(N * 3);
    const tan = new Float32Array(N * 3);
    const cum = new Float32Array(N);

    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    const prev = new THREE.Vector3();
    let total = 0;

    for (let i = 0; i < N; i++) {
      const u = i / (N - (this.closed ? 0 : 1));
      this.curve.getPoint(u, p);
      this.curve.getTangent(u, t).normalize();
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      tan[i * 3] = t.x; tan[i * 3 + 1] = t.y; tan[i * 3 + 2] = t.z;
      if (i > 0) total += p.distanceTo(prev);
      cum[i] = total;
      prev.copy(p);
    }
    if (this.closed) {
      total += Math.hypot(
        pos[0]! - pos[(N - 1) * 3]!,
        pos[1]! - pos[(N - 1) * 3 + 1]!,
        pos[2]! - pos[(N - 1) * 3 + 2]!);
    }

    this._pos = pos;
    this._tan = tan;
    this._cum = cum;
    this.length = total;

    // Per-sample width / bank, interpolated between control points.
    const width = new Float32Array(N);
    const bank = new Float32Array(N);
    const M = this.controls.length;
    for (let i = 0; i < N; i++) {
      const u = (i / N) * M;
      const a = Math.floor(u) % M;
      const b = (a + 1) % M;
      const f = u - Math.floor(u);
      const ca = this.controls[a]!, cb = this.controls[b]!;
      width[i] = lerp(ca.width ?? this.defaultWidth, cb.width ?? this.defaultWidth, f);
      bank[i] = lerp(ca.bank ?? 0, cb.bank ?? 0, f);
    }
    this._width = width;
    this._bank = bank;

    // Frames carry the up vector forward rather than using a raw Frenet frame,
    // which would barrel-roll the road through steep or straight sections.
    const right = new Float32Array(N * 3);
    const up = new Float32Array(N * 3);
    const r = new THREE.Vector3();
    const u2 = new THREE.Vector3();
    const tv = new THREE.Vector3();
    const carriedUp = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < N; i++) {
      tv.set(tan[i * 3]!, tan[i * 3 + 1]!, tan[i * 3 + 2]!);
      r.crossVectors(tv, carriedUp);
      if (r.lengthSq() < 1e-6) r.crossVectors(tv, _v1.set(0, 0, 1));
      r.normalize();
      u2.crossVectors(r, tv).normalize();
      carriedUp.copy(u2);

      const bk = bank[i]!;
      if (bk !== 0) {
        const c = Math.cos(bk), s = Math.sin(bk);
        const rx = r.x * c + u2.x * s, ry = r.y * c + u2.y * s, rz = r.z * c + u2.z * s;
        const ux = u2.x * c - r.x * s, uy = u2.y * c - r.y * s, uz = u2.z * c - r.z * s;
        r.set(rx, ry, rz); u2.set(ux, uy, uz);
      }
      right[i * 3] = r.x; right[i * 3 + 1] = r.y; right[i * 3 + 2] = r.z;
      up[i * 3] = u2.x; up[i * 3 + 1] = u2.y; up[i * 3 + 2] = u2.z;
    }
    this._right = right;
    this._up = up;

    this._buildGrid();
    this._buildCurvature();
  }

  /** Uniform XZ grid so `nearest()` is O(local samples) instead of O(N). */
  private _buildGrid(): void {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const P = this._pos, N = this.sampleCount;
    for (let i = 0; i < N; i++) {
      const x = P[i * 3]!, z = P[i * 3 + 2]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const pad = 200;
    this._gMinX = minX - pad;
    this._gMinZ = minZ - pad;
    const w = (maxX - minX) + pad * 2;
    const h = (maxZ - minZ) + pad * 2;
    this._gCell = Math.max(8, Math.min(w, h) / 64);
    this._gW = Math.ceil(w / this._gCell) + 1;
    this._gH = Math.ceil(h / this._gCell) + 1;

    const grid: Array<number[] | undefined> = new Array(this._gW * this._gH);
    for (let i = 0; i < N; i++) {
      const gx = Math.floor((P[i * 3]! - this._gMinX) / this._gCell);
      const gz = Math.floor((P[i * 3 + 2]! - this._gMinZ) / this._gCell);
      // Register in a 3x3 neighbourhood so a lookup near a cell edge still finds
      // the true closest sample without needing a widening search.
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cx = gx + dx, cz = gz + dz;
          if (cx < 0 || cz < 0 || cx >= this._gW || cz >= this._gH) continue;
          const k = cz * this._gW + cx;
          (grid[k] ??= []).push(i);
        }
      }
    }
    this._grid = grid;
  }

  /** Signed curvature per sample — AI braking and camera lean read this. */
  private _buildCurvature(): void {
    const N = this.sampleCount, T = this._tan;
    const curv = new Float32Array(N);
    const step = Math.max(2, Math.floor(N / 400));
    for (let i = 0; i < N; i++) {
      const a = (i - step + N) % N, b = (i + step) % N;
      _v1.set(T[a * 3]!, 0, T[a * 3 + 2]!).normalize();
      _v2.set(T[b * 3]!, 0, T[b * 3 + 2]!).normalize();
      const ang = Math.acos(clamp(_v1.dot(_v2), -1, 1));
      const side = _v1.x * _v2.z - _v1.z * _v2.x;
      const arc = ((this._cum[b]! - this._cum[a]! + this.length) % this.length) || 1;
      curv[i] = (ang / arc) * (side < 0 ? 1 : -1);
    }
    this._curv = curv;
  }

  // ── sampling ─────────────────────────────────────────────────────────────

  private _indexAtDistance(d: number): number {
    const cum = this._cum;
    let lo = 0, hi = this.sampleCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < d) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Sample at normalised distance t (0..1 around the loop). */
  at(t: number, out?: SplineSample): SplineSample {
    return this.atDistance(t * this.length, out);
  }

  /** Sample at absolute arc-length distance, in metres. Wraps. */
  atDistance(d: number, out?: SplineSample): SplineSample {
    const o = out ?? blankSample();
    const N = this.sampleCount;
    const L = this.length;
    d = ((d % L) + L) % L;

    const i1 = this._indexAtDistance(d);
    const i0 = (i1 - 1 + N) % N;
    const d0 = this._cum[i0]!, d1 = this._cum[i1]!;
    const f = d1 > d0 ? clamp01((d - d0) / (d1 - d0)) : 0;

    const P = this._pos, T = this._tan, R = this._right, U = this._up;
    o.pos.set(
      lerp(P[i0 * 3]!, P[i1 * 3]!, f),
      lerp(P[i0 * 3 + 1]!, P[i1 * 3 + 1]!, f),
      lerp(P[i0 * 3 + 2]!, P[i1 * 3 + 2]!, f));
    o.tangent.set(
      lerp(T[i0 * 3]!, T[i1 * 3]!, f),
      lerp(T[i0 * 3 + 1]!, T[i1 * 3 + 1]!, f),
      lerp(T[i0 * 3 + 2]!, T[i1 * 3 + 2]!, f)).normalize();
    o.right.set(
      lerp(R[i0 * 3]!, R[i1 * 3]!, f),
      lerp(R[i0 * 3 + 1]!, R[i1 * 3 + 1]!, f),
      lerp(R[i0 * 3 + 2]!, R[i1 * 3 + 2]!, f)).normalize();
    o.up.set(
      lerp(U[i0 * 3]!, U[i1 * 3]!, f),
      lerp(U[i0 * 3 + 1]!, U[i1 * 3 + 1]!, f),
      lerp(U[i0 * 3 + 2]!, U[i1 * 3 + 2]!, f)).normalize();

    o.width = lerp(this._width[i0]!, this._width[i1]!, f);
    o.bank = lerp(this._bank[i0]!, this._bank[i1]!, f);
    o.curvature = lerp(this._curv[i0]!, this._curv[i1]!, f);
    o.distance = d;
    o.t = d / L;
    o.index = i1;
    return o;
  }

  /**
   * Closest point on the centreline to a world position. Fills in the signed
   * lateral offset (+right), height above the road plane, and whether the point
   * is on the drivable ribbon.
   */
  nearest(worldPos: THREE.Vector3, out?: SplineSample): SplineSample {
    const gx = Math.floor((worldPos.x - this._gMinX) / this._gCell);
    const gz = Math.floor((worldPos.z - this._gMinZ) / this._gCell);
    let best = -1, bestD2 = Infinity;
    const P = this._pos;

    const cell = (gx >= 0 && gz >= 0 && gx < this._gW && gz < this._gH)
      ? this._grid[gz * this._gW + gx]
      : undefined;

    if (cell) {
      for (let k = 0; k < cell.length; k++) {
        const i = cell[k]!;
        const dx = P[i * 3]! - worldPos.x;
        const dy = P[i * 3 + 1]! - worldPos.y;
        const dz = P[i * 3 + 2]! - worldPos.z;
        // Weight Y down: a kart in the air is still "at" the road below it.
        const d2 = dx * dx + dy * dy * 0.25 + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
    }
    if (best < 0) {
      // Off the grid entirely (fell out of the world). Rare, so brute force.
      for (let i = 0; i < this.sampleCount; i += 4) {
        const dx = P[i * 3]! - worldPos.x;
        const dy = P[i * 3 + 1]! - worldPos.y;
        const dz = P[i * 3 + 2]! - worldPos.z;
        const d2 = dx * dx + dy * dy * 0.25 + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
    }

    // Refine between neighbouring samples by projecting onto the local segment.
    const N = this.sampleCount;
    const prev = (best - 1 + N) % N, next = (best + 1) % N;
    let d = this._cum[best]!;
    _v1.set(
      P[next * 3]! - P[prev * 3]!,
      P[next * 3 + 1]! - P[prev * 3 + 1]!,
      P[next * 3 + 2]! - P[prev * 3 + 2]!);
    const segLen = _v1.length();
    if (segLen > 1e-5) {
      _v1.divideScalar(segLen);
      _v2.set(
        worldPos.x - P[best * 3]!,
        worldPos.y - P[best * 3 + 1]!,
        worldPos.z - P[best * 3 + 2]!);
      d += clamp(_v2.dot(_v1), -segLen * 0.5, segLen * 0.5);
    }

    const o = this.atDistance(d, out);
    _v2.set(worldPos.x - o.pos.x, worldPos.y - o.pos.y, worldPos.z - o.pos.z);
    o.lateral = _v2.dot(o.right);
    o.height = _v2.dot(o.up);
    o.distanceTo = Math.sqrt(bestD2);
    o.onRoad = Math.abs(o.lateral) <= o.width * 0.5;
    o.edgeDistance = o.width * 0.5 - Math.abs(o.lateral);
    return o;
  }

  /** World position at (distance along, lateral offset, height above road). */
  pointAt(distance: number, lateral = 0, height = 0, out = new THREE.Vector3()): THREE.Vector3 {
    const s = this.atDistance(distance, this._scratch);
    out.copy(s.pos).addScaledVector(s.right, lateral).addScaledVector(s.up, height);
    return out;
  }

  /** Forward arc distance from a to b, always positive, wrapping the loop. */
  forwardDistance(a: number, b: number): number {
    const L = this.length;
    return (((b - a) % L) + L) % L;
  }

  /** Signed shortest arc distance, in [-L/2, L/2]. */
  signedDistance(a: number, b: number): number {
    const L = this.length;
    let d = this.forwardDistance(a, b);
    if (d > L / 2) d -= L;
    return d;
  }
}

export function createSpline(points: ControlPoint[], opts?: SplineOptions): TrackSpline {
  return new TrackSpline(points, opts);
}
