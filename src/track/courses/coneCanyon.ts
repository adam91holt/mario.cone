// Course 1 — Cone Canyon Speedway.
//
// The opening circuit: a wide, generous start/finish straight so the pack fans
// out, then a lap that hands the player one distinct problem at a time.
//
//   T1  Hi-Vis Sweep    fast banked left, taken flat if you trust the camber
//   T2  The Long Climb  a 21m ascent that hides the horizon
//   T3  Cone Crest      the brow drops away and the karts go light
//   T4  Chicane Cuts    three quick esses, downhill, no room for mistakes
//   T5  Detour Straight boost strips, the fastest part of the lap
//   T6  Digger's Elbow  a 36m hairpin — and the gravel cut across its apex
//   T7  The Notch       a snap right off the hairpin exit
//   T8  Canyon Wall     the long banked sweeper back onto the straight
//
// Waypoints are authored on the map; `loopFromWaypoints` resamples them into
// evenly spaced control points and derives the banking from the turn rate, so
// the numbers below say what the corner *is*, not what the spline needs.

import { loopFromWaypoints, type Waypoint } from './path.ts';
import type { CourseDefEx } from './types.ts';

/** The ring, driven anticlockwise on the map from the start/finish line. */
const WAYPOINTS: Waypoint[] = [
  // Start/finish straight — flat, wide, dead ahead.
  { x: -150, z: 260, y: 0, width: 30 },
  { x: 0, z: 262, y: 0, width: 29 },
  { x: 120, z: 258, y: 1, width: 28 },
  // T1 Hi-Vis Sweep: long, fast, banked left.
  { x: 210, z: 250, y: 2, width: 27 },
  { x: 292, z: 214, y: 5, width: 26 },
  { x: 338, z: 146, y: 9, width: 25 },
  // The long climb up the canyon's east wall.
  { x: 352, z: 74, y: 13, width: 24 },
  { x: 350, z: 2, y: 17, width: 24 },
  // Cone Crest — the brow, then the road falls out from under you.
  { x: 338, z: -70, y: 21, width: 24 },
  { x: 320, z: -114, y: 12, width: 24 },
  { x: 296, z: -158, y: 6, width: 25 },
  // Chicane Cuts: three esses along the canyon rim, still descending.
  { x: 262, z: -192, y: 4, width: 24 },
  { x: 212, z: -198, y: 3, width: 23 },
  { x: 164, z: -228, y: 2, width: 23 },
  { x: 116, z: -206, y: 2, width: 23 },
  { x: 68, z: -236, y: 1, width: 23 },
  { x: 14, z: -250, y: 0, width: 25 },
  // Detour Straight — downhill, boost strips, the run to the hairpin.
  { x: -96, z: -260, y: -2, width: 27 },
  { x: -206, z: -266, y: -4, width: 28 },
  { x: -300, z: -266, y: -5, width: 30 },
  // Digger's Elbow — the hairpin. Wide tarmac, gravel across the apex.
  { x: -366, z: -258, y: -6, width: 30 },
  { x: -398, z: -222, y: -6, width: 30 },
  { x: -372, z: -190, y: -6, width: 30 },
  { x: -312, z: -178, y: -5, width: 28 },
  // The Notch: a snap right that punishes a lazy hairpin exit.
  { x: -252, z: -160, y: -3, width: 26 },
  { x: -210, z: -116, y: -1, width: 26 },
  { x: -198, z: -56, y: 0, width: 26 },
  // Canyon Wall — the long banked sweeper home.
  { x: -208, z: 20, y: 1, width: 26 },
  { x: -226, z: 92, y: 2, width: 27 },
  { x: -248, z: 156, y: 2, width: 28 },
  { x: -244, z: 212, y: 1, width: 29 },
  { x: -206, z: 248, y: 0, width: 30 },
];

export const coneCanyon: CourseDefEx = {
  id: 'cone-canyon',
  name: 'Cone Canyon Speedway',
  cup: 'hazard',
  points: loopFromWaypoints(WAYPOINTS, {
    width: 26,
    step: 10,
    bankGain: 5.2,
    maxBank: 0.20,
    bankSmooth: 38,
  }),
  width: 26,
  laps: 3,
  vergeWidth: 8,
  vergeSurface: 'dirt',
  offSurface: 'sand',
  walls: true,
  wallHeight: 1.5,
  groundSize: 4200,
  groundY: -8,
  startDistance: 0,
  checkpoints: 32,

  features: {
    // Lap fractions. The two on the Detour Straight are the reward for a clean
    // esse section; the third only lines up if you took the gravel cut.
    pads: [
      { at: 0.545, lateral: -0.42, width: 5.5, length: 16 },
      { at: 0.575, lateral: 0.30, width: 5.5, length: 16 },
      { at: 0.735, lateral: -0.55, width: 6, length: 15 },
      { at: 0.958, lateral: 0.34, width: 5.5, length: 16 },
    ],
    // Digger's Elbow. Cutting the inside gravel saves about 30 metres and costs
    // you a third of your top speed while you are on it — worth it out of a
    // mini-turbo, a disaster from a standing start.
    shortcuts: [{ from: 0.655, to: 0.725, side: -1 }],
    kerbCurvature: 0.0042,
  },

  theme: {
    ground: 0xc99a5b,
    sky: { top: 0x2e86d6, bottom: 0xbfe7ff, horizon: 0xffe2b0 },
    fog: { color: 0xd8c9a8, near: 420, far: 2100 },
    sun: { color: 0xfff2d8, intensity: 2.6, azimuth: 0.7, elevation: 0.85 },
    road: { base: '#3A3D46', line: '#FFF8F0', edge: '#FFC300' },
    props: { canyon: true, cones: true, crowds: true },
  },
};

export default coneCanyon;
