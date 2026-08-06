// Course layout: waypoints in, evenly spaced control points out.
//
// A circuit is authored as a ring of waypoints on the map — that is how a track
// designer actually thinks, and a closed ring can never fail to join up. This
// module turns that ring into what TrackSpline wants:
//
//   * a *centripetal* Catmull-Rom through the waypoints, which (unlike the
//     uniform variety) cannot loop back on itself when the spacing is uneven —
//     the difference between a hairpin and a knot;
//   * resampled at a constant arc-length step, because TrackSpline maps control
//     index straight onto distance when it interpolates width and bank. Uneven
//     spacing there slides the banking away from the corner it belongs to;
//   * banking derived from the measured turn rate, so every corner leans into
//     itself by exactly as much as it is tight, then smoothed so the transitions
//     are something a kart can be driven through.
//
// Nothing here is random and nothing reads a clock: the same waypoints always
// produce the same circuit, which is what keeps replays and captures honest.

import type { ControlPoint } from '../../types.ts';

export interface Waypoint {
  x: number;
  z: number;
  /** Elevation, metres. Interpolated along the curve like position. */
  y?: number;
  /** Road width here, metres. Also interpolated. */
  width?: number;
  /** Extra banking multiplier through this part of the lap. 1 = automatic. */
  bank?: number;
}

export interface LoopOptions {
  /** Width used where a waypoint does not name one. */
  width: number;
  /** Spacing of the emitted control points, metres. */
  step?: number;
  /** Radians of bank per 1/metre of curvature. */
  bankGain?: number;
  maxBank?: number;
  /** Half-length of the bank smoothing window, metres. */
  bankSmooth?: number;
}

interface Dense {
  x: number; z: number; y: number; w: number; b: number; d: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * One centripetal Catmull-Rom span, evaluated with the Barry-Goldman
 * recurrence. Works on an arbitrary number of channels so elevation, width and
 * the bank multiplier ride along with x/z instead of needing their own pass.
 */
function spanAt(p0: number[], p1: number[], p2: number[], p3: number[], t: number, out: number[]): void {
  const knot = (a: number[], b: number[]): number => {
    const dx = b[0]! - a[0]!, dz = b[1]! - a[1]!;
    return Math.pow(Math.hypot(dx, dz) || 1e-4, 0.5);
  };
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const tt = t1 + (t2 - t1) * t;

  const n = out.length;
  for (let c = 0; c < n; c++) {
    const a1 = ((t1 - tt) * p0[c]! + (tt - t0) * p1[c]!) / (t1 - t0);
    const a2 = ((t2 - tt) * p1[c]! + (tt - t1) * p2[c]!) / (t2 - t1);
    const a3 = ((t3 - tt) * p2[c]! + (tt - t2) * p3[c]!) / (t3 - t2);
    const b1 = ((t2 - tt) * a1 + (tt - t0) * a2) / (t2 - t0);
    const b2 = ((t3 - tt) * a2 + (tt - t1) * a3) / (t3 - t1);
    out[c] = ((t2 - tt) * b1 + (tt - t1) * b2) / (t2 - t1);
  }
}

export function loopFromWaypoints(wps: Waypoint[], opts: LoopOptions): ControlPoint[] {
  const n = wps.length;
  if (n < 4) throw new Error('a circuit needs at least four waypoints');

  const step = opts.step ?? 10;
  const gain = opts.bankGain ?? 4.6;
  const maxBank = opts.maxBank ?? 0.21;
  const smoothM = opts.bankSmooth ?? 34;

  const chan = (i: number): number[] => {
    const w = wps[((i % n) + n) % n]!;
    return [w.x, w.z, w.y ?? 0, w.width ?? opts.width, w.bank ?? 1];
  };

  // ── dense sampling ──────────────────────────────────────────────────────
  const SUB = 48;
  const dense: Dense[] = [];
  const out = [0, 0, 0, 0, 0];
  let total = 0;
  let px = 0, pz = 0;

  for (let i = 0; i < n; i++) {
    const p0 = chan(i - 1), p1 = chan(i), p2 = chan(i + 1), p3 = chan(i + 2);
    for (let s = 0; s < SUB; s++) {
      spanAt(p0, p1, p2, p3, s / SUB, out);
      if (dense.length > 0) total += Math.hypot(out[0]! - px, out[1]! - pz);
      px = out[0]!; pz = out[1]!;
      dense.push({ x: px, z: pz, y: out[2]!, w: out[3]!, b: out[4]!, d: total });
    }
  }
  // Close the ring: the wrap span back to the first sample.
  const first = dense[0]!;
  total += Math.hypot(first.x - px, first.z - pz);

  // ── resample at a constant step ─────────────────────────────────────────
  const count = Math.max(8, Math.round(total / step));
  const spacing = total / count;
  const pts: ControlPoint[] = [];
  let cursor = 0;

  for (let i = 0; i < count; i++) {
    const target = i * spacing;
    while (cursor < dense.length - 1 && dense[cursor + 1]!.d < target) cursor++;
    const a = dense[cursor]!;
    const b = dense[cursor + 1] ?? first;
    const span = (cursor + 1 < dense.length ? b.d : total) - a.d;
    const f = span > 1e-6 ? clamp((target - a.d) / span, 0, 1) : 0;
    pts.push({
      x: a.x + (b.x - a.x) * f,
      z: a.z + (b.z - a.z) * f,
      y: a.y + (b.y - a.y) * f,
      width: a.w + (b.w - a.w) * f,
      bank: a.b + (b.b - a.b) * f, // carries the multiplier until banking is solved
    });
  }

  // ── banking from the measured turn rate ─────────────────────────────────
  // Curvature sign matches TrackSpline's: positive is a left-hand corner, and a
  // left-hander wants its right-hand side lifted, so bank tracks curvature
  // directly.
  const m = pts.length;
  const raw = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const a = pts[(i - 1 + m) % m]!, c = pts[(i + 1) % m]!;
    const h0 = Math.atan2(pts[i]!.z - a.z, pts[i]!.x - a.x);
    const h1 = Math.atan2(c.z - pts[i]!.z, c.x - pts[i]!.x);
    let dh = h1 - h0;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const ds = Math.hypot(c.x - a.x, c.z - a.z) * 0.5 || spacing;
    raw[i] = clamp(-(dh / ds) * gain, -maxBank, maxBank) * (pts[i]!.bank ?? 1);
  }

  // Smooth so the road rolls into a corner instead of snapping to it.
  const half = Math.max(1, Math.round(smoothM / spacing));
  const bank = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let sum = 0, weight = 0;
    for (let k = -half; k <= half; k++) {
      const w = 1 - Math.abs(k) / (half + 1);
      sum += raw[(i + k + m * 2) % m]! * w;
      weight += w;
    }
    bank[i] = sum / weight;
  }
  for (let i = 0; i < m; i++) pts[i]!.bank = Math.round(bank[i]! * 1e4) / 1e4;

  return pts;
}
