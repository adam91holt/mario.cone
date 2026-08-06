// The ideal line, measured off the circuit.
//
// This exists for one reason: a driver reads the road ahead by looking for
// where everybody else has been. Without that, tarmac between the painted
// markings carries no information at all — you cannot tell a corner you can
// take flat from one that needs the brakes until you are in it. Every real
// track, and every Mario Kart track, has a dark polished band worn through the
// apexes, and the player uses it to commit before the corner opens up.
//
// So: derive a plausible line from the geometry, then bake it into the tarmac's
// vertex colours (see road.ts). Geometry rather than texture, because a tiled
// asphalt texture is an averaged grey by twenty metres out and twenty metres
// out is exactly where the driver is looking.
//
// The shape comes from an unsharp mask. Blur the "apex here" signal twice, once
// narrow and once wide, then subtract a fraction of the wide blur from the
// narrow one. The subtraction overshoots on both sides of every corner, which
// is precisely the out-in-out swing a driver takes: wide on entry, tight at the
// apex, wide again on exit. Nothing here is random and nothing reads a clock.

import type { TrackSpline } from './spline.ts';

export interface RacingLine {
  /** Lateral offset of the ideal line at a distance along the lap, metres. */
  lateralAt(distance: number): number;
  /** 0..1 — how hard the line is loaded there. 0 on a straight, 1 at an apex. */
  loadAt(distance: number): number;
}

/** Sampling pitch, metres. Fine enough for a hairpin, coarse enough to be free. */
const STEP = 4;
/** Curvature at which a corner is taken at full commitment (R ≈ 70m). */
const KREF = 0.0143;
/** Half-width of the narrow blur, metres — the apex itself. */
const NEAR = 26;
/** Half-width of the wide blur, metres — the approach and the exit. */
const FAR = 88;
/** How much of the wide blur is subtracted. Higher swings wider on entry. */
const OVERSHOOT = 0.92;

/** Triangular blur over a wrapped array. */
function blur(src: Float32Array, halfWidth: number): Float32Array {
  const n = src.length;
  const half = Math.max(1, Math.round(halfWidth / STEP));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, weight = 0;
    for (let k = -half; k <= half; k++) {
      const w = 1 - Math.abs(k) / (half + 1);
      sum += src[(i + k + n * 2) % n]! * w;
      weight += w;
    }
    out[i] = sum / weight;
  }
  return out;
}

/**
 * `margin` is how close to the edge the line is allowed to run. Karts are ~2m
 * wide and clip the kerb, so ~3m of centreline offset from the edge puts the
 * inside wheels on the paint — which is where the worn line belongs.
 */
export function buildRacingLine(spline: TrackSpline, margin = 3.1): RacingLine {
  const L = spline.length;
  const n = Math.max(8, Math.round(L / STEP));
  const raw = new Float32Array(n);
  const halfWidth = new Float32Array(n);
  const load = new Float32Array(n);
  const s = spline.atDistance(0);

  for (let i = 0; i < n; i++) {
    spline.atDistance((i / n) * L, s);
    const commit = Math.min(1, Math.abs(s.curvature) / KREF);
    halfWidth[i] = Math.max(1, s.width * 0.5 - margin);
    // Curvature is positive through a left-hander, whose apex is on the left.
    raw[i] = -Math.sign(s.curvature) * commit * halfWidth[i]!;
    load[i] = commit;
  }

  const near = blur(raw, NEAR);
  const far = blur(raw, FAR);
  const lateral = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = near[i]! * (1 + OVERSHOOT) - far[i]! * OVERSHOOT;
    const lim = halfWidth[i]!;
    lateral[i] = v < -lim ? -lim : v > lim ? lim : v;
  }
  const smoothLoad = blur(load, 22);

  const read = (table: Float32Array, distance: number): number => {
    const u = (((distance / L) % 1) + 1) % 1 * n;
    const i0 = Math.floor(u) % n;
    const i1 = (i0 + 1) % n;
    const f = u - Math.floor(u);
    return table[i0]! + (table[i1]! - table[i0]!) * f;
  };

  return {
    lateralAt: (d) => read(lateral, d),
    loadAt: (d) => read(smoothLoad, d),
  };
}
