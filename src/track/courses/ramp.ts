// Launch ramps, applied to the waypoints before the spline is built.
//
// ── the one fact this module exists for ────────────────────────────────────
//
// `physics/kart.ts` rebuilds the ground it stands on from four things and four
// things only: the spline's position, its `up`, its width, and the 16cm crown
// across it. It never reads a triangle. So a ramp modelled as a wedge of mesh
// laid on the tarmac — which is the obvious way to build one, and the way a
// review directive asked for it — is a *picture* of a ramp that every kart in
// the field drives straight through.
//
// A ramp is therefore a shape of the **centreline**. `applyRamps` takes the
// waypoint ring a course authored, splices a dense run of waypoints through the
// ramp's window, and lifts their elevation by `rampLift`. Everything downstream
// — the road mesh, the barriers, the terrain, the AI's racing line, and the
// kart's own ground query — picks the ramp up for free, because all of them
// already agree that the road is where the spline says it is.
//
// ── the profile, and why it is not a smoothstep ────────────────────────────
//
//   lift(u) = lip · u²      u = 0 at the foot of the run-up, 1 at the lip
//
// The square is doing two jobs at the two ends and the second one is the whole
// feature. At the foot its slope is zero, so the deck grows out of the road
// rather than starting at a lip a kart trips over on the way *in*. At the top
// its slope is `2·lip/length` and that is the **maximum** — which is exactly
// what every easing curve in this codebase refuses to do. `ring.ts` ramps
// elevation across a segment with a smoothstep, whose derivative is zero at
// *both* ends, so a road authored as "climb here, then plunge" hands the kart a
// dead-level metre at precisely the moment it should be pointing at the sky.
//
// That is not a stylistic point. `kart:launch` fires only if the kart leaves
// with 3 m/s along the ground normal (`K.air.trickMinLaunch`), and a level
// take-off over a falling road produces about 1.5 — measured. The course
// climbed 116 metres, plunged back down, threw karts into the air on every
// gradient change, and fired five launches in a whole race, because none of
// that air was ever *aimed*. A kart wants to be pointing upward at the instant
// the road stops holding it down; a crest cannot do that and a ramp must.
//
// Behind the lip the deck falls back to the road linearly over `0.55·length`,
// which leaves a real crease at the top instead of a dome. The crease survives
// the two rounds of smoothing between here and the road surface —
// `loopFromWaypoints`' centripetal Catmull-Rom and then `TrackSpline`'s — as a
// short, sharp brow, which is what a ramp lip actually looks like once it has
// been built out of tarmac rather than out of scaffolding.
//
// Nothing here is random and nothing reads a clock.

import type { Waypoint } from './path.ts';
import type { RampDef } from './types.ts';

/** Default run-up, metres. */
const LENGTH = 26;
/** Default rise at the lip, metres. */
const LIP = 2.2;
/** Fraction of the run-up over which the deck falls back to the road. */
const FALL = 0.34;
/** Spacing the ramp's own waypoints are laid at, metres. */
const STEP = 2.5;
/** Metres either side of the ramp that are rebuilt with it, for a clean join. */
const PAD = 8;

export const rampLength = (r: RampDef): number => r.length ?? LENGTH;
export const rampLip = (r: RampDef): number => r.lip ?? LIP;
export const rampFall = (r: RampDef): number => rampLength(r) * (r.fall ?? FALL);

/**
 * Metres the deck stands above the road, `rel` metres from the lip.
 *
 * Negative `rel` is the run-up. Positive is the short fall back to the road
 * behind the lip. **Exported because two things read it** — `applyRamps` below,
 * which puts the shape into the spline, and `buildRoad`, which paints the deck
 * onto it. A ramp whose paint and whose take-off were two separate pieces of
 * arithmetic would drift apart the first time either was tuned.
 */
export function rampLift(ramp: RampDef, rel: number): number {
  const len = rampLength(ramp);
  const lip = rampLip(ramp);
  const fall = rampFall(ramp);
  if (rel <= -len || rel >= fall) return 0;
  if (rel <= 0) {
    const u = 1 + rel / len;
    return lip * u * u;
  }
  return lip * (1 - rel / fall);
}

export interface RampApplyOptions {
  /**
   * Length of the ring in metres, in the same distance space `RampDef.at` is
   * quoted in. Defaults to the summed chord length of the waypoints.
   */
  length?: number;
  /** Metres from the ring origin to the start line, since `at` is measured from it. */
  startDistance?: number;
}

interface Node {
  /** Distance along the waypoint ring, metres. */
  d: number;
  wp: Waypoint;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Splice each ramp's deck into a waypoint ring and return the new ring.
 *
 * The window `[lip - length - PAD, lip + fall + PAD]` is rebuilt at `STEP`
 * spacing — the ring's own waypoints are 14-16m apart, which cannot carry a
 * 26-metre feature with a crease in it — with x, z and width interpolated along
 * the original polyline and `rampLift` added to y.
 *
 * **Put ramps on straights.** Rebuilding a window interpolates the centreline
 * as a chord, so a ramp laid across an arc would cut a few centimetres off the
 * corner. On a straight the interpolation is exact. Nothing enforces this
 * because nothing sensible can be done about it if you break it; it is a
 * property of what a ramp is for.
 */
export function applyRamps(
  wps: Waypoint[], ramps: RampDef[] | undefined, opts: RampApplyOptions = {},
): Waypoint[] {
  if (!ramps || ramps.length === 0) return wps;

  const n = wps.length;
  const nodes: Node[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = wps[i]!;
    nodes.push({ d: total, wp: a });
    const b = wps[(i + 1) % n]!;
    total += Math.hypot(b.x - a.x, b.z - a.z);
  }
  // `at` is quoted against the ring's traverse length, which differs from the
  // summed chord by the sagitta of every arc on the lap — about a tenth of a
  // per cent. Scaling by it puts a 26-metre deck within a metre or two of where
  // the ledger says it is, which is the same tolerance every boost strip and
  // every surface patch on this circuit is already placed to.
  const ringLength = opts.length ?? total;
  const k = total / ringLength;
  const start = (opts.startDistance ?? 0) * k;

  /** Position, width and the ring's own elevation at a distance along it. */
  const at = (d: number): Waypoint => {
    const dd = ((d % total) + total) % total;
    let lo = 0, hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (nodes[mid]!.d <= dd) lo = mid; else hi = mid - 1;
    }
    const a = nodes[lo]!;
    const b = nodes[(lo + 1) % nodes.length]!;
    const span = (lo + 1 < nodes.length ? b.d : total) - a.d;
    const t = span > 1e-6 ? (dd - a.d) / span : 0;
    return {
      x: lerp(a.wp.x, b.wp.x, t),
      z: lerp(a.wp.z, b.wp.z, t),
      y: lerp(a.wp.y ?? 0, b.wp.y ?? 0, t),
      ...(a.wp.width !== undefined || b.wp.width !== undefined
        ? { width: lerp(a.wp.width ?? b.wp.width ?? 0, b.wp.width ?? a.wp.width ?? 0, t) }
        : {}),
      ...(a.wp.bank !== undefined ? { bank: a.wp.bank } : {}),
    };
  };

  // Resolve each ramp to a window in the ring's own distance space.
  interface Window { ramp: RampDef; lip: number; d0: number; d1: number }
  const windows: Window[] = ramps.map((r) => {
    const lip = ((start + r.at * total) % total + total) % total;
    return {
      ramp: r,
      lip,
      d0: lip - rampLength(r) * k - PAD,
      d1: lip + rampFall(r) * k + PAD,
    };
  }).sort((a, b) => a.d0 - b.d0);

  const inWindow = (d: number): Window | null => {
    for (const w of windows) {
      const rel = d - w.d0;
      const span = w.d1 - w.d0;
      const wrapped = ((rel % total) + total) % total;
      if (wrapped <= span) return w;
    }
    return null;
  };

  // Keep every waypoint outside the windows; rebuild the windows densely.
  const out: Array<{ d: number; wp: Waypoint }> = [];
  for (const node of nodes) if (!inWindow(node.d)) out.push({ d: node.d, wp: node.wp });

  for (const w of windows) {
    const span = w.d1 - w.d0;
    const count = Math.max(4, Math.round(span / STEP));
    for (let i = 0; i <= count; i++) {
      const d = w.d0 + (span * i) / count;
      const wp = at(d);
      // `rel` is measured in the ring's distance space, which is what the deck
      // profile is quoted in; the window itself was widened by `k` to match.
      wp.y = (wp.y ?? 0) + rampLift(w.ramp, (d - w.lip) / k);
      out.push({ d: ((d % total) + total) % total, wp });
    }
  }

  out.sort((a, b) => a.d - b.d);
  return out.map((o) => o.wp);
}
