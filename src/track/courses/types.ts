// Course extensions owned by the track module.
//
// `CourseDef` in src/types.ts is the cross-module contract — physics, AI and the
// race director all read it, so it stays deliberately small. Everything that
// only the track builder cares about (boost strips, the start gantry, the
// shortcut markings) lives here instead, and the builder narrows a CourseDef to
// this type when it needs them.

import type { CourseDef, Surface } from '../../types.ts';

/**
 * All positions are authored as a fraction of the lap (0..1 from the start
 * line) rather than metres, so the layout can be re-cut without every feature
 * needing to move with it.
 */
export interface BoostPadDef {
  /** Lap fraction of the pad's centre. */
  at: number;
  /** Lateral position as a fraction of the half width, -1 (left) .. +1. */
  lateral?: number;
  /** Metres across the road. */
  width?: number;
  /** Metres along the road. */
  length?: number;
}

/**
 * A patch of the drivable ribbon that is not tarmac.
 *
 * **This is live now, and the way it is live is the point.** For a whole round
 * it was authored and not read: `sample()` decided a racer's surface purely
 * from lateral distance, so three courses declared a spill, a windrow and a
 * washout, wrote paragraphs about what each one asks of a driver, and all four
 * bands returned `road` in the running game. The entire "2 spills / 1 drift /
 * 1 washout" column the roster's cup order is built on was a comment.
 *
 * The wiring deliberately does **not** let that happen twice. `buildRoad`
 * resolves each def into a `PatchRuntime` once, paints it from that, and hands
 * the same array to `sample()`, which shares `patchScale()` with the paint. The
 * spill a player can see and the spill the kart is standing on are therefore
 * the same shape to the centimetre, including the tapered ends and the ragged
 * edge — there is no second copy of the geometry to drift out of agreement.
 *
 * A patch overrides a boost strip where the two overlap, on the grounds that
 * material on the road beats paint under it. **Do not overlap them**, and the
 * reason is not tidiness: `findPads` in `ai/knowledge.ts` confirms each
 * declared strip by probing `sample()` for `'boost'` and silently drops any
 * that does not answer, so a pad buried under a spill would stop existing for
 * every CPU driver in the field while still being declared here. No pad in the
 * cup is within four hundredths of a lap of a patch; keep it that way.
 */
export interface SurfacePatchDef {
  /** Lap fraction of the leading edge, measured from the start line. */
  from: number;
  to: number;
  /**
   * Lateral band, as fractions of the half width, **in the spline's frame** —
   * the same frame `ShortcutDef.side` uses and therefore the mirror of the
   * driver's. `-1` is the driver's right edge, `+1` is the driver's left.
   *
   * The band is what is declared; what is *built* is that band with its ends
   * faded in over a third of its length and its edge broken up by noise, so a
   * spill fans out of the shoulder instead of starting at a ruled line. It
   * never grows past the declaration, only inside it.
   */
  latFrom: number;
  latTo: number;
  surface: Surface;
  /**
   * CSS colour of the material. There is no sensible default across four
   * places — crusher fines on a grey pit floor, blown salt on a white lake and
   * schist scree on a cold mountain are the same `dirt`/`sand` to physics and
   * three different colours to a player — so each course names its own. Falls
   * back to a generic per-surface tone.
   */
  tint?: string;
}

/** The gravel line across the inside of a corner: shorter, slower, marked. */
export interface ShortcutDef {
  from: number;
  to: number;
  /**
   * Which shoulder the cut runs down, in the *spline's* lateral frame — and
   * that frame is the opposite of the driver's, because `TrackSpline` builds
   * `right` as `tangent × up`, which points to the driver's **left**. So `-1`
   * is the driver's right and `+1` is the driver's left, and the value you
   * want is whichever side the corner's apex is on: `-1` for a right-hander,
   * `+1` for a left.
   *
   * Getting it backwards is silent rather than loud: the ribbon is painted on
   * the outside of the corner, `ai/knowledge.ts` measures a chord *longer*
   * than the arc, `save` clamps to zero, and no driver ever takes it.
   */
  side: -1 | 1;
}

/**
 * A hero landform: a butte, a mesa or a spire, placed on the map so it sits at
 * the vanishing point of a straight. Landmarks are what a lap is navigated by —
 * without one, every corner exit looks like every other corner exit.
 */
export interface LandmarkDef {
  x: number;
  z: number;
  /** Footprint radius, metres. */
  radius: number;
  /** Height above the surrounding land, metres. */
  height: number;
  /** 'mesa' is a flat-topped block; 'spire' is a needle. */
  kind?: 'mesa' | 'spire';
}

/** Shaping of the landscape the circuit is cut into. */
export interface TerrainDef {
  /** Metres beyond the shoulder at which the canyon rim starts to rise. */
  rimStart?: number;
  /** Metres beyond which it is at full height. */
  rimEnd?: number;
  /** Peak height of the rim above the local datum, metres. */
  rimHeight?: number;
  landmarks?: LandmarkDef[];
}

export interface TrackFeatures {
  pads?: BoostPadDef[];
  patches?: SurfacePatchDef[];
  shortcuts?: ShortcutDef[];
  /** Lap fraction of the start gantry; defaults to the start line. */
  gantryAt?: number;
  /** Curvature above which a kerb is laid on the inside of a corner. */
  kerbCurvature?: number;
  terrain?: TerrainDef;
}

export interface CourseDefEx extends CourseDef {
  features?: TrackFeatures;
}

export const features = (course: CourseDef): TrackFeatures =>
  (course as CourseDefEx).features ?? {};
