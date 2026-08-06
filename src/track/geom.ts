// Geometry plumbing shared by every piece of the track.
//
// Two ideas do all the work here:
//
//  1. `surfaceHeight` is the single source of truth for how high the ground is
//     at a given lateral offset. Kart physics reconstructs the road with its own
//     copy of that profile, so every ribbon we draw — tarmac, kerbs, painted
//     lines, boost strips — is built through this function and therefore lands
//     exactly where the karts actually drive. Draw it any other way and the
//     wheels float or sink.
//
//  2. Everything is a ribbon: a strip of lanes swept along the spline. Kerbs,
//     barriers, aprons and the road itself are all the same builder with
//     different lane profiles, which keeps the seams between them exact.
//
// Ribbons accumulate into a MeshBuilder so a dozen pieces can share one draw
// call, and normals are averaged per ribbon so the crease between (say) a kerb
// top and its outer face stays sharp.
//
// Ribbons can also carry a vertex colour. That is how the tarmac gets its
// large-scale structure — the polished racing line, the dusty off-line edges,
// the tonal breaks between one patch of asphalt and the next. Those have to
// live in geometry rather than in the texture: a tiled texture mipmaps to a
// flat average by twenty metres out, which is exactly the range at which a
// driver is reading the road.

import * as THREE from 'three';
import type { SplineSample } from '../types.ts';
import type { TrackSpline } from './spline.ts';

/** Height of the crown at the middle of the road, metres. */
export const CROWN = 0.16;
/** How far the outer edge of the verge sits below the road. */
export const VERGE_DROP = 0.35;

/**
 * Height above the spline plane at a lateral offset, matching the profile kart
 * physics uses. `width` is the drivable width, `verge` the shoulder beyond it.
 */
export function surfaceHeight(lateral: number, width: number, verge: number): number {
  const a = Math.abs(lateral);
  const half = width * 0.5;
  if (a <= half) return Math.cos((lateral / width) * Math.PI) * CROWN;
  const t = Math.min(1, (a - half) / Math.max(0.001, verge));
  return -VERGE_DROP * t;
}

const _p = new THREE.Vector3();

/** World position on the track surface at (distance, lateral), plus a lift. */
export function surfacePoint(
  s: SplineSample, lateral: number, verge: number, lift: number, out: THREE.Vector3,
): THREE.Vector3 {
  const h = surfaceHeight(lateral, s.width, verge) + lift;
  return out.copy(s.pos).addScaledVector(s.right, lateral).addScaledVector(s.up, h);
}

export interface Lane {
  /** Lateral offset in metres. `f` is 0..1 along the span, for tapers. */
  lat(s: SplineSample, f: number): number;
  /** Height above the surface profile, metres. */
  lift?(s: SplineSample, f: number): number;
  /** Texture u for this lane; a function keeps the tiling metric when the road
   *  changes width. */
  u: number | ((s: SplineSample, f: number) => number);
}

/** Fills `out` with the vertex tint at a point on a ribbon. */
export type RibbonTint = (s: SplineSample, lat: number, f: number, out: THREE.Color) => void;

export interface RibbonOptions {
  from?: number;
  to?: number;
  /** Along-track spacing of the rings, metres. */
  step?: number;
  /** Metres of track per unit of texture v. */
  vScale?: number;
  /** Shoulder width, needed by the height profile. */
  verge: number;
  /** Close the ribbon into a loop when it spans the whole lap. */
  closed?: boolean;
  /** Per-vertex tint. Multiplies the map, so 1,1,1 is "as authored". */
  tint?: RibbonTint;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _col = new THREE.Color();

export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  /** Set once any ribbon supplies a tint; gates the colour attribute. */
  tinted = false;

  get vertexCount(): number { return this.positions.length / 3; }

  /**
   * Sweep a set of lanes along the spline. Lanes must be ordered left to right;
   * that ordering is what makes the winding come out facing the sky.
   */
  addRibbon(spline: TrackSpline, lanes: Lane[], opts: RibbonOptions): void {
    const L = spline.length;
    const from = opts.from ?? 0;
    const to = opts.to ?? L;
    const span = opts.closed ? L : to - from;
    if (span <= 0.01 || lanes.length < 2) return;

    const step = opts.step ?? 3;
    const rings = Math.max(2, Math.round(span / step) + 1);
    const vScale = opts.vScale ?? 1;
    const base = this.vertexCount;
    const cols = lanes.length;
    const s: SplineSample = spline.atDistance(from);
    const tint = opts.tint;
    if (tint) this.tinted = true;

    for (let i = 0; i < rings; i++) {
      const f = i / (rings - 1);
      const d = from + span * f;
      spline.atDistance(d, s);
      for (let j = 0; j < cols; j++) {
        const lane = lanes[j]!;
        const lat = lane.lat(s, f);
        const lift = lane.lift ? lane.lift(s, f) : 0;
        surfacePoint(s, lat, opts.verge, lift, _p);
        this.positions.push(_p.x, _p.y, _p.z);
        this.normals.push(0, 0, 0);
        this.uvs.push(typeof lane.u === 'number' ? lane.u : lane.u(s, f), d / vScale);
        if (tint) {
          _col.setRGB(1, 1, 1);
          tint(s, lat, f, _col);
          this.colors.push(_col.r, _col.g, _col.b);
        } else {
          this.colors.push(1, 1, 1);
        }
      }
    }

    const iStart = this.indices.length;
    for (let i = 0; i < rings - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = base + i * cols + j;
        const b = a + cols;
        this.indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    this.accumulateNormals(base, this.vertexCount, iStart);
  }

  /** A single quad, wound a→b→c→d anticlockwise seen from the front. */
  addQuad(
    a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3,
    uv: [number, number, number, number] = [0, 0, 1, 1],
  ): void {
    const base = this.vertexCount;
    const start = this.indices.length;
    for (const v of [a, b, c, d]) {
      this.positions.push(v.x, v.y, v.z);
      this.normals.push(0, 0, 0);
      this.colors.push(1, 1, 1);
    }
    this.uvs.push(uv[0], uv[1], uv[2], uv[1], uv[0], uv[3], uv[2], uv[3]);
    this.indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    this.accumulateNormals(base, base + 4, start);
  }

  /**
   * A flat patch of paint on the road surface, subdivided in both axes.
   *
   * Anything laid on the tarmac has to be sampled across its width, not drawn
   * as a single chord: `surfaceHeight` crowns the road by 16cm at the
   * centreline, so a three-metre quad spanning that crown sinks under the
   * surface in the middle and disappears. Every transverse marking on the
   * circuit goes through here.
   */
  addPatch(
    spline: TrackSpline, verge: number,
    d0: number, d1: number, lat0: number, lat1: number, lift: number,
    uv: [number, number, number, number] = [0, 0, 1, 1],
  ): void {
    const cols = Math.max(2, Math.min(24, Math.ceil(Math.abs(lat1 - lat0) / 0.9) + 1));
    const rows = Math.max(2, Math.min(24, Math.ceil(Math.abs(d1 - d0) / 1.2) + 1));
    const base = this.vertexCount;
    const iStart = this.indices.length;
    const s: SplineSample = spline.atDistance(d0);

    for (let i = 0; i < rows; i++) {
      const fv = i / (rows - 1);
      spline.atDistance(d0 + (d1 - d0) * fv, s);
      for (let j = 0; j < cols; j++) {
        const fu = j / (cols - 1);
        surfacePoint(s, lat0 + (lat1 - lat0) * fu, verge, lift, _p);
        this.positions.push(_p.x, _p.y, _p.z);
        this.normals.push(0, 0, 0);
        this.colors.push(1, 1, 1);
        this.uvs.push(uv[0] + (uv[2] - uv[0]) * fu, uv[1] + (uv[3] - uv[1]) * fv);
      }
    }
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = base + i * cols + j;
        const b = a + cols;
        this.indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    this.accumulateNormals(base, this.vertexCount, iStart);
  }

  /** Face normals summed into the vertices a batch of triangles touches. */
  private accumulateNormals(vFrom: number, vTo: number, iFrom: number): void {
    const P = this.positions, N = this.normals, I = this.indices;
    for (let t = iFrom; t < I.length; t += 3) {
      const i0 = I[t]!, i1 = I[t + 1]!, i2 = I[t + 2]!;
      _a.set(P[i0 * 3]!, P[i0 * 3 + 1]!, P[i0 * 3 + 2]!);
      _b.set(P[i1 * 3]!, P[i1 * 3 + 1]!, P[i1 * 3 + 2]!);
      _c.set(P[i2 * 3]!, P[i2 * 3 + 1]!, P[i2 * 3 + 2]!);
      _b.sub(_a); _c.sub(_a);
      _n.crossVectors(_b, _c);
      for (const k of [i0, i1, i2]) {
        N[k * 3] += _n.x; N[k * 3 + 1] += _n.y; N[k * 3 + 2] += _n.z;
      }
    }
    for (let v = vFrom; v < vTo; v++) {
      const x = N[v * 3]!, y = N[v * 3 + 1]!, z = N[v * 3 + 2]!;
      const len = Math.hypot(x, y, z) || 1;
      N[v * 3] = x / len; N[v * 3 + 1] = y / len; N[v * 3 + 2] = z / len;
    }
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    if (this.tinted) {
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    }
    g.setIndex(this.indices);
    g.computeBoundingSphere();
    return g;
  }

  get isEmpty(): boolean { return this.indices.length === 0; }
}

/** Deterministic hash noise — no Math.random anywhere in the build. */
export function hash2(x: number, y: number): number {
  let h = Math.imul(Math.round(x * 131.7) ^ Math.imul(Math.round(y * 57.3), 0x27d4eb2d), 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}

/** Smooth value noise built from that hash. */
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** Fractal noise, 3 octaves. Returns roughly -1..1. */
export function fbm(x: number, y: number): number {
  return (noise2(x, y) - 0.5) * 1.2
    + (noise2(x * 2.13, y * 2.13) - 0.5) * 0.6
    + (noise2(x * 4.7, y * 4.7) - 0.5) * 0.3;
}

export const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};
