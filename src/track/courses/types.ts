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

/** A patch of the drivable ribbon that is not tarmac. */
export interface SurfacePatchDef {
  from: number;
  to: number;
  /** Lateral band as fractions of the half width. */
  latFrom: number;
  latTo: number;
  surface: Surface;
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
