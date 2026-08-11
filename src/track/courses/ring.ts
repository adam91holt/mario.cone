// Circuit authoring: straights and *exact circular arcs*, in the units a
// corner is actually argued about.
//
// ── why this exists ────────────────────────────────────────────────────────
//
// `loopFromWaypoints` takes a ring of points on the map and turns it into a
// spline. That is the right way to sketch a shape and the wrong way to state a
// radius, and a whole review round was lost to the difference.
//
// A corner authored as five hand-placed points has no radius. It has a *peak*
// curvature somewhere in the middle and a long tail either side, and the two
// are not close: measured across all four circuits in this cup, the mean radius
// through a corner ran about 1.4x its tightest point, and not one corner in the
// game held a single radius for as much as a hundred metres. That is invisible
// on a map and fatal to the drift:
//
//   * the widest arc a committed drift can be steered to is
//     `counterSteer * yawBonus * turnRate(v) / v` — about 56m at 45 m/s — and
//     the tightest is about 23m. A drift is holdable only *between* those.
//   * so a corner that runs 70m → 37m → 70m is outside the band at both ends.
//     The driver lays the drift, the road opens under it, the slide runs wide,
//     and the charge is thrown away. That is the `strain` ending the AI bench
//     counts, and it was ending drifts at 1.3 seconds on three of four
//     circuits — against the 2.5s the mechanic is designed around.
//
// The cure is not longer corners. It is corners that hold **one radius all the
// way through**, sat in the middle of the drift band. That cannot be authored
// by eye, so it is authored as a number: `{ radius: 47, turn: -165 }` is a
// hundred and thirty-five metres of road that is 47 metres of radius at every
// point on it, and the course file states it in the units the census measures.
//
// ── how it closes ──────────────────────────────────────────────────────────
//
// A ring of arcs and straights joins up only if headings and positions both
// come back. Headings are the author's job and cheap to check: the turns must
// sum to ±360°, and `ring()` throws if they do not, which catches a typo at
// module load instead of shipping a circuit with a kink in it.
//
// Position is not cheap by hand — it is two equations in whatever the author is
// willing to move — so it is **adjusted**, the way a surveyor closes a
// traverse: the leftover gap is distributed across the straights by weighted
// least squares, so each one gives up a share of the error proportional to its
// own length and no corner is touched at all. A well-formed circuit closes with
// a metre or two on each straight. A malformed one wants tens of metres, and
// `maxAdjust` turns that into an error rather than a silently wrong shape.
//
// Nothing here is fitted to data, nothing reads a clock, and the same
// declaration always produces the same circuit.

import type { Waypoint } from './path.ts';

const DEG = Math.PI / 180;

export interface RingStart {
  x: number;
  z: number;
  /** Heading in degrees, `atan2(dz, dx)`. 0 points along +x. */
  heading: number;
  /** Elevation at the ring's first point, metres. */
  y?: number;
  /** Road width at the ring's first point, metres. */
  width: number;
}

/** What the road becomes by the end of a segment. */
interface SegCommon {
  /**
   * Width in metres at the end of this segment, ramped across it from whatever
   * the previous one left. A corner declares the width it is taken at and the
   * run-in declares the same number, so the pinch arrives with the corner
   * rather than at a ruled line halfway down a straight.
   */
  width?: number;
  /** Elevation in metres at the end of the segment, ramped the same way. */
  y?: number;
  /** Extra banking multiplier through this segment. 1 = automatic. */
  bank?: number;
  /** Name, for `at()` / `span()` and the geometry report. */
  name?: string;
}

export interface StraightSeg extends SegCommon {
  /** Metres. The closure adjustment moves this by a metre or two. */
  run: number;
}

export interface ArcSeg extends SegCommon {
  /** Metres. Constant for the whole segment — that is the entire point. */
  radius: number;
  /** Degrees swept. **Negative turns to the driver's right.** */
  turn: number;
}

export type RingSeg = StraightSeg | ArcSeg;

const isArc = (s: RingSeg): s is ArcSeg => (s as ArcSeg).radius !== undefined;

export interface RingOptions {
  /** Target spacing of emitted waypoints, metres. */
  step?: number;
  /** Metres any one straight may be moved by the closure adjustment. */
  maxAdjust?: number;
}

export interface RingLeg {
  name: string;
  kind: 'corner' | 'run';
  d0: number;
  len: number;
  /** 0 on a straight. */
  radius: number;
  /** Degrees. Negative turns to the driver's right. */
  turn: number;
  /** Metres the closure adjustment moved this straight. */
  adjust: number;
}

export interface Ring {
  waypoints: Waypoint[];
  /** Length of the closed ring, metres. Within ~0.1% of the built spline. */
  length: number;
  /** Lap fraction of the middle of a named segment, measured from `startDistance`. */
  at(name: string, startDistance?: number): number;
  /** `[from, to]` lap fractions spanning a named segment, padded in metres. */
  span(name: string, startDistance?: number, pad?: number): [number, number];
  /** Distance in metres, a fraction of the way along a named segment. */
  distanceAlong(name: string, along?: number): number;
  legs(): RingLeg[];
}

/**
 * Where a segment ends, and what heading it leaves behind.
 *
 * The arc is parameterised off its own centre, so the emitted points sit on the
 * circle rather than on a polygon inscribed in it: a 47m corner measures 47m at
 * the apex *and* fifty metres either side of it, which is the only property
 * this module exists to guarantee.
 */
function walk(
  seg: RingSeg, len: number, h0: number, x0: number, z0: number, u: number,
): [number, number, number] {
  if (!isArc(seg)) return [x0 + Math.cos(h0) * u, z0 + Math.sin(h0) * u, h0];
  const turn = seg.turn * DEG;
  const s = turn >= 0 ? 1 : -1;
  const cx = x0 + Math.cos(h0 + s * Math.PI / 2) * seg.radius;
  const cz = z0 + Math.sin(h0 + s * Math.PI / 2) * seg.radius;
  const phi0 = h0 - s * Math.PI / 2;
  const t = len > 0 ? u / len : 0;
  return [
    cx + Math.cos(phi0 + t * turn) * seg.radius,
    cz + Math.sin(phi0 + t * turn) * seg.radius,
    h0 + t * turn,
  ];
}

export function ring(start: RingStart, segs: RingSeg[], opts: RingOptions = {}): Ring {
  const step = opts.step ?? 14;
  const maxAdjust = opts.maxAdjust ?? 90;

  let sweep = 0;
  for (const s of segs) if (isArc(s)) sweep += s.turn;
  if (Math.abs(Math.abs(sweep) - 360) > 1e-6) {
    throw new Error(`[ring] turns sum to ${sweep.toFixed(3)}°, not ±360 — the circuit would not join up`);
  }

  const lenOf = (s: RingSeg): number =>
    isArc(s) ? Math.abs(s.turn) * DEG * s.radius : s.run;

  // ── the traverse, and the gap it leaves ──────────────────────────────────
  let h = start.heading * DEG;
  let gx = 0, gz = 0;
  const dirs: Array<[number, number]> = [];
  const idx: number[] = [];
  segs.forEach((s, i) => {
    const len = lenOf(s);
    if (!isArc(s)) { dirs.push([Math.cos(h), Math.sin(h)]); idx.push(i); }
    const [nx, nz, nh] = walk(s, len, h, gx, gz, len);
    gx = nx; gz = nz; h = nh;
  });
  if (dirs.length < 2) throw new Error('[ring] a circuit needs at least two straights to close on');

  // Weighted least squares: minimise Σ Δ²/L, so a long straight absorbs
  // proportionally more of the gap than a short one and nothing gets shoved
  // through zero. Δ = W·Dᵀ(D·W·Dᵀ)⁻¹·(-gap).
  let a = 0, b = 0, c = 0;
  dirs.forEach(([u, v], j) => {
    const w = Math.max(1, lenOf(segs[idx[j]!]!));
    a += w * u * u; b += w * u * v; c += w * v * v;
  });
  const det = a * c - b * b;
  if (Math.abs(det) < 1e-6) throw new Error('[ring] every straight points the same way — nothing to close on');
  const m0 = (c * -gx - b * -gz) / det;
  const m1 = (-b * -gx + a * -gz) / det;

  const adjust = new Map<number, number>();
  dirs.forEach(([u, v], j) => {
    const i = idx[j]!;
    const w = Math.max(1, lenOf(segs[i]!));
    const d = w * (u * m0 + v * m1);
    if (Math.abs(d) > maxAdjust) {
      throw new Error(
        `[ring] closing this circuit wants ${d.toFixed(0)}m off "${segs[i]!.name ?? `straight ${i}`}" ` +
        `(gap ${Math.hypot(gx, gz).toFixed(0)}m). Re-cut the corners; do not raise maxAdjust.`);
    }
    const run = (segs[i] as StraightSeg).run + d;
    if (run < 20) {
      throw new Error(`[ring] closure leaves "${segs[i]!.name ?? `straight ${i}`}" ${run.toFixed(0)}m long — that is not a road`);
    }
    adjust.set(i, d);
  });

  // ── resolve, then emit ───────────────────────────────────────────────────
  interface Resolved { seg: RingSeg; len: number; h0: number; x0: number; z0: number; d0: number }
  const res: Resolved[] = [];
  h = start.heading * DEG;
  let px = start.x, pz = start.z, d = 0;
  segs.forEach((s, i) => {
    const len = lenOf(s) + (adjust.get(i) ?? 0);
    res.push({ seg: s, len, h0: h, x0: px, z0: pz, d0: d });
    const [nx, nz, nh] = walk(s, len, h, px, pz, len);
    px = nx; pz = nz; h = nh; d += len;
  });
  const total = d;

  const waypoints: Waypoint[] = [];
  let w = start.width;
  let y = start.y ?? 0;
  for (const r of res) {
    const wEnd = r.seg.width ?? w;
    const yEnd = r.seg.y ?? y;
    // A third of the radius keeps the centripetal Catmull-Rom through the
    // points *on* the circle. On a straight the points are exactly collinear at
    // any density, so the cap costs nothing there.
    const pitch = isArc(r.seg) ? Math.min(step, r.seg.radius * 0.33) : step;
    const n = Math.max(1, Math.round(r.len / pitch));
    for (let i = 0; i < n; i++) {
      const u = (i / n) * r.len;
      const t = r.len > 0 ? u / r.len : 0;
      const e = t * t * (3 - 2 * t);
      const [x, z] = walk(r.seg, r.len, r.h0, r.x0, r.z0, u);
      waypoints.push({
        x: Math.round(x * 1e3) / 1e3,
        z: Math.round(z * 1e3) / 1e3,
        y: Math.round((y + (yEnd - y) * e) * 1e3) / 1e3,
        width: Math.round((w + (wEnd - w) * e) * 1e3) / 1e3,
        ...(r.seg.bank !== undefined ? { bank: r.seg.bank } : {}),
      });
    }
    w = wEnd; y = yEnd;
  }

  const find = (name: string): Resolved => {
    const hit = res.find((r) => r.seg.name === name);
    if (!hit) throw new Error(`[ring] no segment named "${name}"`);
    return hit;
  };
  const frac = (dist: number, startDistance: number): number => {
    const v = ((dist - startDistance) / total) % 1;
    return Math.round((v < 0 ? v + 1 : v) * 1e4) / 1e4;
  };

  return {
    waypoints,
    length: total,
    at: (name, startDistance = 0) => {
      const r = find(name);
      return frac(r.d0 + r.len * 0.5, startDistance);
    },
    span: (name, startDistance = 0, pad = 0) => {
      const r = find(name);
      return [frac(r.d0 - pad, startDistance), frac(r.d0 + r.len + pad, startDistance)];
    },
    distanceAlong: (name, along = 0.5) => {
      const r = find(name);
      return r.d0 + r.len * along;
    },
    legs: () => res.map((r, i) => ({
      name: r.seg.name ?? '',
      kind: isArc(r.seg) ? 'corner' as const : 'run' as const,
      d0: Math.round(r.d0),
      len: Math.round(r.len),
      radius: isArc(r.seg) ? r.seg.radius : 0,
      turn: isArc(r.seg) ? r.seg.turn : 0,
      adjust: Math.round((adjust.get(i) ?? 0) * 10) / 10,
    })),
  };
}
