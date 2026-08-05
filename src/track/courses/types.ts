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
  /** -1 cuts the left verge, +1 the right. */
  side: -1 | 1;
}

export interface TrackFeatures {
  pads?: BoostPadDef[];
  patches?: SurfacePatchDef[];
  shortcuts?: ShortcutDef[];
  /** Lap fraction of the start gantry; defaults to the start line. */
  gantryAt?: number;
  /** Curvature above which a kerb is laid on the inside of a corner. */
  kerbCurvature?: number;
}

export interface CourseDefEx extends CourseDef {
  features?: TrackFeatures;
}

export const features = (course: CourseDef): TrackFeatures =>
  (course as CourseDefEx).features ?? {};
