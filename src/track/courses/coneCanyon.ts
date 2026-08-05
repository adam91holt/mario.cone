// Course 1 — Cone Canyon Speedway.
//
// The tutorial circuit: wide, forgiving, one big banked sweeper and a crested
// hill that pops the karts airborne. Layout is authored as radius/elevation/width
// bands around a ring, which keeps it guaranteed non-self-intersecting while
// still reading as a designed circuit rather than an oval.

import type { ControlPoint, CourseDef } from '../../types.ts';

/** 16 stations around the loop, starting at the start/finish line heading east. */
const RADIUS = [230, 246, 262, 250, 212, 176, 160, 172, 202, 236, 256, 240, 206, 176, 164, 196];
const ELEVATION = [0, 0, 3, 9, 16, 19, 15, 8, 2, 0, 0, 1, 7, 12, 7, 2];
const WIDTH = [30, 28, 26, 24, 22, 20, 20, 22, 26, 28, 26, 23, 21, 22, 25, 28];
/** Positive banks the outside of the turn up. Zero on the straights. */
const BANK = [0, 0, 0.05, 0.14, 0.18, 0.12, 0.04, 0, 0, 0.06, 0.15, 0.16, 0.08, 0, 0, 0];

function ring(): ControlPoint[] {
  const pts: ControlPoint[] = [];
  const n = RADIUS.length;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = RADIUS[i]!;
    pts.push({
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      y: ELEVATION[i]!,
      width: WIDTH[i]!,
      bank: BANK[i]!,
    });
  }
  return pts;
}

export const coneCanyon: CourseDef = {
  id: 'cone-canyon',
  name: 'Cone Canyon Speedway',
  cup: 'hazard',
  points: ring(),
  width: 26,
  laps: 3,
  vergeWidth: 6,
  vergeSurface: 'dirt',
  offSurface: 'grass',
  walls: true,
  wallHeight: 1.7,
  groundSize: 4000,
  groundY: -1.2,
  startDistance: 0,
  checkpoints: 32,
  theme: {
    ground: 0xC9A063,
    sky: { top: 0x2E86D6, bottom: 0xBFE7FF, horizon: 0xFFE2B0 },
    fog: { color: 0xCFE6F5, near: 320, far: 1600 },
    sun: { color: 0xFFF2D8, intensity: 2.6, azimuth: 0.7, elevation: 0.85 },
    road: { base: '#3A3D46', line: '#FFF8F0', edge: '#FFC300' },
    props: { canyon: true, cones: true, crowds: true },
  },
};

export default coneCanyon;
