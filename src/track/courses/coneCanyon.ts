// Course 1 — Cone Canyon Speedway.
//
// The opening circuit. It still hands the player one distinct problem at a
// time, but it no longer hands them nothing: the two long straights are gone,
// replaced by fast kinks you take flat but have to aim, and the road pinches
// where the corner is tight instead of opening out.
//
//   T1  Hi-Vis Sweep    long banked right, flat if you trust the camber
//   T2  The Kink        a left flick mid-climb that unloads the bank
//   T3  Cone Crest      a tight right over a brow; the road drops away
//   T4  Chicane Cuts    three real esses, 19m wide, drift-cancel-drift
//   T5  Cone Chute      a long descending left onto the bottom of the map
//   T6  Detour Straight boost strips, two fast kinks, the quickest part of the lap
//   T7  Digger's Elbow  a 28m hairpin at 17m wide — the tightest, narrowest point
//   T8  The Notch       a right-left snap off the hairpin exit
//   T9  Canyon Wall     the long banked sweeper home
//
// Two rules the layout is held to. *Width follows speed*: 30m where the pack
// fans out on the start straight, 17m at the hairpin apex, 19m through the
// esses, because a corner that is also the widest part of the circuit asks
// nothing of anybody. And *nothing is dead straight for longer than the run to
// the first corner*: the connecting sections carry 250-450m of radius, which is
// flat out but still has to be aimed.
//
// Waypoints are authored on the map; `loopFromWaypoints` resamples them into
// evenly spaced control points and derives the banking from the turn rate, so
// the numbers below say what the corner *is*, not what the spline needs.
//
// **This is the warm one, and it is also the plain one.** Round one of a cup
// teaches the vocabulary: three laps, four strips, one gravel cut, no surface
// hazard on the racing line. Everything the other three rounds do differently
// — four laps and six short strips in the pit, two laps and three long ramps on
// the pan, five strips on the climb and none on the descent — is measured
// against this. So the layout stays put; the only thing pushed here is the
// palette, and it is pushed *away from the quarry's*: hot terracotta against
// cold rock flour, gold haze against mineral grey.

import { loopFromWaypoints, type Waypoint } from './path.ts';
import type { CourseDefEx } from './types.ts';

/** The ring, driven from the start/finish line at (-100, 254). */
const WAYPOINTS: Waypoint[] = [
  // Start/finish straight. Short — the grid needs 40m behind the line and the
  // player needs a corner to aim at, not five seconds of held throttle.
  { x: -100, z: 254, y: 0, width: 30 },
  { x: -44, z: 254, y: 0, width: 30 },
  { x: 6, z: 250, y: 0.4, width: 29 },
  // T1 Hi-Vis Sweep — 300m of banked right, opening then tightening.
  { x: 84, z: 238, y: 1.4, width: 28 },
  { x: 156, z: 214, y: 3.0, width: 27 },
  { x: 218, z: 176, y: 5.0, width: 26 },
  { x: 262, z: 124, y: 7.2, width: 25 },
  // T2 The Kink — the camber lets go for a moment, halfway up the climb.
  { x: 278, z: 66, y: 10.4, width: 24 },
  { x: 272, z: 16, y: 13.6, width: 23 },
  { x: 288, z: -28, y: 16.6, width: 23 },
  // T3 Cone Crest — tight right over the brow, then the floor disappears.
  { x: 312, z: -58, y: 19.6, width: 22 },
  { x: 322, z: -86, y: 21.4, width: 22 },
  { x: 318, z: -112, y: 17.0, width: 23 },
  { x: 300, z: -130, y: 14.0, width: 22 },
  // T4 Chicane Cuts — a 210m base with one and a half sine cycles laid over
  // it, sampled every twelfth. Three direction changes at R≈45m and 19m of
  // road: you cannot hold one drift through it, you have to cancel and re-lay.
  { x: 285.8, z: -143.3, y: 12.6, width: 20 },
  { x: 270.3, z: -151.8, y: 11.6, width: 19 },
  { x: 252.5, z: -153.6, y: 10.8, width: 19 },
  { x: 233.3, z: -150.7, y: 10.0, width: 19 },
  { x: 214.2, z: -147.7, y: 9.2, width: 19 },
  { x: 196.5, z: -149.5, y: 8.4, width: 19 },
  { x: 180.8, z: -158.1, y: 7.6, width: 19 },
  { x: 166.7, z: -171.3, y: 6.8, width: 19 },
  { x: 152.5, z: -184.6, y: 6.0, width: 19 },
  { x: 136.9, z: -193.2, y: 5.4, width: 19 },
  { x: 119.2, z: -194.9, y: 4.8, width: 20 },
  { x: 100.0, z: -192.0, y: 4.2, width: 21 },
  // T5 Cone Chute — a long left that funnels the esses onto the bottom straight.
  { x: 62, z: -201, y: 3.2, width: 23 },
  { x: 26, z: -224, y: 2.0, width: 25 },
  { x: -8, z: -250, y: 0.6, width: 26 },
  // T6 Detour Straight — boost strips, and two ~270m-radius kinks so the
  // fastest part of the lap is still a part of the lap.
  { x: -60, z: -260, y: -1.4, width: 27 },
  { x: -130, z: -266, y: -3.0, width: 28 },
  { x: -196, z: -256, y: -4.4, width: 27 },
  { x: -262, z: -262, y: -5.6, width: 28 },
  { x: -320, z: -258, y: -6.4, width: 26 },
  // T7 Digger's Elbow — R=28m at 17m wide, the pinch point of the circuit, with
  // the gravel cut across its apex.
  { x: -382, z: -259, y: -7.0, width: 20 },
  { x: -402, z: -251, y: -7.0, width: 18 },
  { x: -410, z: -231, y: -7.0, width: 17 },
  { x: -402, z: -211, y: -7.0, width: 18 },
  { x: -382, z: -203, y: -6.8, width: 20 },
  // T8 The Notch — a right then an immediate left. Get the hairpin exit wrong
  // and you arrive here pointing at the barrier.
  { x: -352, z: -209, y: -6.2, width: 22 },
  { x: -318, z: -202, y: -5.4, width: 24 },
  { x: -286, z: -182, y: -4.4, width: 24 },
  { x: -262, z: -152, y: -3.4, width: 25 },
  { x: -248, z: -116, y: -2.4, width: 25 },
  // T9 Canyon Wall — the long banked sweeper home, under the rim.
  { x: -244, z: -72, y: -1.4, width: 26 },
  { x: -248, z: -24, y: -0.6, width: 26 },
  { x: -258, z: 26, y: 0.2, width: 27 },
  { x: -266, z: 78, y: 0.8, width: 27 },
  { x: -272, z: 130, y: 1.0, width: 28 },
  { x: -262, z: 182, y: 0.8, width: 28 },
  { x: -250, z: 216, y: 0.4, width: 29 },
  { x: -226, z: 240, y: 0.1, width: 30 },
  { x: -192, z: 250, y: 0, width: 30 },
  { x: -150, z: 254, y: 0, width: 30 },
];

export const coneCanyon: CourseDefEx = {
  id: 'cone-canyon',
  name: 'Cone Canyon Speedway',
  cup: 'hazard',
  points: loopFromWaypoints(WAYPOINTS, {
    width: 26,
    step: 10,
    bankGain: 20,
    maxBank: 0.21,
    // Banking has to arrive slowly. The kart's contact test treats the surface
    // rolling out from under it as a launch, so a fast camber transition pops
    // the whole field into the air mid-corner; ~60m of easing keeps the sweepers
    // properly banked without ever throwing a kart off the road.
    bankSmooth: 60,
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
    // Lap fractions. Two on the Detour Straight are the reward for a clean esse
    // section; one sits on the exit of the hairpin, where you have no speed and
    // badly want some, and the last is the run to the line.
    pads: [
      { at: 0.605, lateral: -0.40, width: 5.5, length: 20 },
      { at: 0.638, lateral: 0.28, width: 5.5, length: 20 },
      { at: 0.735, lateral: 0.30, width: 5.5, length: 18 },
      { at: 0.962, lateral: -0.34, width: 5.5, length: 20 },
    ],
    // Digger's Elbow. Cutting the inside gravel saves about 25 metres and costs
    // you a third of your top speed while you are on it — worth it out of a
    // mini-turbo, a disaster from a standing start.
    shortcuts: [{ from: 0.679, to: 0.716, side: -1 }],
    kerbCurvature: 0.0042,

    // The canyon the course is named after. The rim starts 165m off the
    // shoulder — clear of the circuit, close enough to stand over it — and
    // three buttes are placed at the ends of the straights so every corner exit
    // has a different thing at its vanishing point.
    terrain: {
      rimStart: 165,
      rimEnd: 520,
      rimHeight: 105,
      landmarks: [
        // Beyond T1, closing the view down the start/finish straight.
        { x: 620, z: 250, radius: 250, height: 135, kind: 'mesa' },
        // Ahead of the Detour Straight, over the hairpin.
        { x: -760, z: -300, radius: 280, height: 150, kind: 'mesa' },
        // The wall the Canyon Wall sweeper runs under, on the driver's left.
        { x: -560, z: 120, radius: 230, height: 120, kind: 'mesa' },
        // A needle in the middle of the loop — visible from three quarters of
        // the lap, which is what makes the circuit legible from the air.
        { x: -40, z: 20, radius: 150, height: 96, kind: 'spire' },
      ],
    },
  },

  theme: {
    // Hot terracotta, pushed a full step off where it was. `theme.ground` is
    // the far-field albedo *and* the ground half of the hemisphere fill, so
    // this is also why everything on this circuit is lit warm from below — the
    // opposite of the quarry, whose fill is neutral rock flour, and of the
    // mountain, whose fill is cold schist.
    ground: 0xcf8f4a,
    sky: { top: 0x2e86d6, bottom: 0xbfe7ff, horizon: 0xffd79a },
    // Thinner haze than before: the mesas are the point of the horizon now, and
    // fog that reaches them at 400m turns the canyon back into a khaki blur.
    // Warm, and deliberately so — it is the tell that separates this round from
    // round two at a glance, and round two's is a flat mineral grey.
    fog: { color: 0xe7c99c, near: 620, far: 2600 },
    sun: { color: 0xfff2d8, intensity: 2.6, azimuth: 0.7, elevation: 0.85 },
    road: { base: '#3A3D46', line: '#FFF8F0', edge: '#FFC300' },
    props: { canyon: true, cones: true, crowds: true },
  },
};

export default coneCanyon;
