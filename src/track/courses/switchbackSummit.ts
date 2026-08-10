// Course 4 — Switchback Summit.
//
// The one with a hill in it. Cone Canyon moves 28 metres up and down over a
// lap; this moves **116**, and it does it in one direction at a time: a
// 1.6-kilometre climb up the eastern face and a 700-metre plunge down the
// western one. Half the lap is spent looking up at road you have not driven
// yet, and the other half looking down at road you already have.
//
// It is also the only circuit in the cup that runs anticlockwise, so every
// corner loads the other side of the kart.
//
//   T1  Culvert Kink        320m left along the valley floor, flat
//   T2  Batter Kink         300m left, still flat, still climbing nothing
//   T3  Foot of the Climb   110m left — and the road tips up to 11%
//   T4  First Traverse      130m RIGHT, the only right on the climb
//   T5  Spur Entry          60m left onto the promontory
//   T6  THE SPUR            26m through 120° at the tip. 20m wide, and level.
//   T7  Spur Exit           61° right, back onto the mountain
//   T8  Second Traverse     95m left, climbing at 8%
//   T9  Shoulder Left       85m, the road pinned to the side of the hill
//   T10 The Col             75m left over the saddle
//   T11 Summit Traverse     380m of left along the top, the only breather
//   T12 THE RIDGE           the crest. The road goes light and the valley opens
//   T13 Cutting Sweep       150m left, falling at 17%
//   T14 Spillway Left       170m, still falling
//   T15 Valley Sweep        90m left at the bottom, and the brakes matter
//
// **Two set pieces.**
//
// *The Spur* is a level out-and-back onto a rock promontory two thirds of the
// way up. It is the tightest corner on the circuit (26m radius, 20m of road)
// and it is deliberately the one place on the climb where the road stops
// climbing — you arrive with no speed, you leave with no speed, and the
// hundred metres either side of it are the same height to within two metres.
// That is not decoration: the embankment either side of a road is anchored to
// *that* road's elevation, so two legs of a switchback that pass within sixty
// metres of each other at different heights bury the lower one. Level legs are
// what makes a switchback buildable at all here.
//
// *The Ridge* is the crest at the top of the climb, at 116m — the highest point
// in the game. The road curves over it at about 12 milliradians per metre,
// which at the 50 m/s you arrive at is 31 m/s² of unloading against 34 of
// gravity: nine tenths of the kart's weight taken off the wheels in a car's
// length. It goes light, the camera lifts, and the whole west face appears at
// once. Sharper and it would be a jump; this is a brow, and a brow is scarier.
//
// Width follows speed, and here it follows *gradient* too: 30m on the valley
// floor where the karts are flat out, 24-26m on the traverses, 20m at the Spur.
// The longest dead straight is the 180m of descent immediately after the Ridge,
// which is pointing downhill at 17% and is not restful.
//
// ── the look, and why the numbers below are what they are ──────────────────
//
// A critic photographed this course and read it as "a works yard on a green
// hill next to a meringue". Both halves of that were the course's own fault,
// not the renderer's, because `render/theme.ts` paints the alpine surface off
// two things a *course* supplies: `theme.ground`, and how high the land stands
// relative to the nearest road (`rel`).
//
//   * **The meringue.** The snow ramp runs from about `rel` 35 to `rel` 135.
//     `rimHeight` was 200, which puts the *whole* rim between `rel` 79 and 207
//     — above the ramp before it starts — so every ridge on the circuit came
//     back one flat blue-white with no snowline and no rock under it. The rim
//     is 135 now: `plateau * terrace * erosion` spreads that across `rel` 56 to
//     142, which lands the ramp on the land itself. Bare schist in the saddles,
//     a broken snowline up the flanks, white only on the tops.
//   * **The green hill.** The far field settles onto `groundY`, and `groundY`
//     was -35: thirty-five metres *below* the valley-floor road, which is
//     exactly the band `alpine.paint` reads as tussock, so a kilometre of
//     landscape came back saturated pasture green. The plain is level with the
//     valley floor now, which is what a valley floor is.
//   * **The warm tan.** `theme.ground` was 0x8f8c74, a warm olive-tan, and it
//     is both the far-field albedo *and* (via `sunRig`) the colour of the
//     bounce light on every object in the game. Warm tan on one side of the
//     road, pasture green on the other. It is cold blue-grey schist now, so the
//     tussock beside the shoulder mixes down to a dry alpine grey-green instead
//     of a golf course.
//
// The hero landforms follow from the same arithmetic: anything topping out much
// over `rel` 140 is a white lump, so the peaks are sized to *stand through* the
// snowline rather than to start above it, and two low rock buttresses sit close
// enough to the circuit to be looked at rather than admired from a distance.

import { loopFromWaypoints, type Waypoint } from './path.ts';
import type { CourseDefEx } from './types.ts';

/** The ring, driven from the valley floor at (-319, -311, 0). */
const WAYPOINTS: Waypoint[] = [
  { x: -319, z: -311, y: 0.6, width: 27 },
  { x: -287, z: -320, y: 0.4, width: 28 },
  { x: -255, z: -329, y: 0.7, width: 28 },
  { x: -223, z: -337, y: 1.1, width: 29 },
  // T1 Culvert Kink
  { x: -191, z: -346, y: 1.5, width: 29 },
  { x: -164, z: -352, y: 1.8, width: 29 },
  { x: -137, z: -356, y: 2.1, width: 29 },
  { x: -110, z: -357, y: 2.4, width: 29 },
  { x: -83, z: -356, y: 2.7, width: 29 },
  { x: -55, z: -353, y: 3, width: 29 },
  { x: -29, z: -348, y: 3.3, width: 29 },
  { x: 1, z: -340, y: 3.6, width: 29 },
  { x: 32, z: -332, y: 4, width: 29 },
  { x: 62, z: -325, y: 4.3, width: 30 },
  { x: 92, z: -317, y: 4.7, width: 30 },
  // T2 Batter Kink
  { x: 122, z: -310, y: 5, width: 30 },
  { x: 147, z: -302, y: 5.3, width: 30 },
  { x: 171, z: -293, y: 5.6, width: 30 },
  { x: 194, z: -281, y: 6.4, width: 30 },
  { x: 222, z: -266, y: 8.4, width: 29 },
  { x: 249, z: -251, y: 11.3, width: 28 },
  { x: 276, z: -235, y: 14.4, width: 27 },
  // T3 Foot of the Climb
  { x: 304, z: -220, y: 17.4, width: 26 },
  { x: 325, z: -205, y: 20.1, width: 26 },
  { x: 342, z: -184, y: 22.8, width: 26 },
  { x: 354, z: -161, y: 25.4, width: 26 },
  { x: 363, z: -135, y: 28.1, width: 26 },
  { x: 372, z: -110, y: 30.8, width: 25 },
  // T4 First Traverse
  { x: 381, z: -84, y: 33.5, width: 25 },
  { x: 392, z: -60, y: 36.2, width: 25 },
  { x: 409, z: -38, y: 38.9, width: 25 },
  { x: 429, z: -21, y: 41.6, width: 25 },
  { x: 453, z: -8, y: 44.4, width: 25 },
  { x: 485, z: 6, y: 47.7, width: 24 },
  { x: 517, z: 19, y: 51, width: 23 },
  // T5 Spur Entry
  { x: 549, z: 33, y: 53.4, width: 22 },
  { x: 564, z: 42, y: 54.2, width: 22 },
  { x: 576, z: 56, y: 54.4, width: 22 },
  // T6 THE SPUR
  { x: 594, z: 84, y: 54.6, width: 20 },
  { x: 598, z: 94, y: 54.8, width: 20 },
  { x: 597, z: 105, y: 54.9, width: 20 },
  { x: 592, z: 114, y: 55, width: 20 },
  { x: 583, z: 121, y: 55, width: 20 },
  { x: 573, z: 124, y: 55.2, width: 20 },
  { x: 547, z: 125, y: 55.4, width: 21 },
  { x: 521, z: 126, y: 55.6, width: 21 },
  // T7 Spur Exit
  { x: 496, z: 127, y: 55.8, width: 22 },
  { x: 482, z: 130, y: 56.1, width: 22 },
  { x: 470, z: 138, y: 56.7, width: 22 },
  { x: 461, z: 149, y: 58, width: 22 },
  { x: 449, z: 174, y: 59.8, width: 23 },
  { x: 437, z: 199, y: 62, width: 23 },
  { x: 424, z: 223, y: 64.1, width: 24 },
  // T8 Second Traverse
  { x: 412, z: 248, y: 66, width: 24 },
  { x: 403, z: 263, y: 67.6, width: 24 },
  { x: 391, z: 276, y: 69.2, width: 24 },
  { x: 367, z: 298, y: 71.4, width: 24 },
  { x: 342, z: 320, y: 74, width: 24 },
  { x: 318, z: 342, y: 76.5, width: 25 },
  { x: 294, z: 364, y: 79, width: 25 },
  // T9 Shoulder Left
  { x: 270, z: 386, y: 81.4, width: 25 },
  { x: 248, z: 400, y: 83.5, width: 25 },
  { x: 224, z: 407, y: 85.6, width: 25 },
  { x: 192, z: 412, y: 87.9, width: 25 },
  { x: 160, z: 416, y: 90.4, width: 25 },
  { x: 128, z: 420, y: 92.9, width: 25 },
  { x: 97, z: 424, y: 95.3, width: 24 },
  { x: 65, z: 428, y: 97.8, width: 24 },
  // T10 The Col
  { x: 33, z: 432, y: 99.9, width: 24 },
  { x: 20, z: 433, y: 101.2, width: 24 },
  { x: 7, z: 431, y: 102.5, width: 24 },
  // T11 Summit Traverse
  { x: -29, z: 423, y: 103.8, width: 26 },
  { x: -55, z: 416, y: 104.5, width: 26 },
  { x: -81, z: 407, y: 104.9, width: 26 },
  { x: -106, z: 397, y: 105.2, width: 26 },
  { x: -130, z: 385, y: 105.6, width: 26 },
  { x: -153, z: 371, y: 106.8, width: 26 },
  { x: -177, z: 355, y: 109.9, width: 26 },
  // T12 The Ridge
  { x: -201, z: 340, y: 113.6, width: 26 },
  { x: -215, z: 329, y: 116, width: 26 },
  { x: -227, z: 316, y: 115.2, width: 26 },
  { x: -246, z: 291, y: 111.4, width: 26 },
  { x: -264, z: 266, y: 106.3, width: 27 },
  { x: -283, z: 242, y: 101.1, width: 27 },
  { x: -302, z: 217, y: 95.9, width: 27 },
  { x: -321, z: 193, y: 90.6, width: 27 },
  { x: -339, z: 168, y: 85.4, width: 28 },
  // T13 Cutting Sweep
  { x: -358, z: 144, y: 80.3, width: 28 },
  { x: -373, z: 119, y: 75.2, width: 28 },
  { x: -384, z: 91, y: 70.2, width: 28 },
  { x: -392, z: 61, y: 64.9, width: 28 },
  { x: -400, z: 30, y: 59.5, width: 28 },
  { x: -408, z: -1, y: 54.1, width: 29 },
  { x: -416, z: -31, y: 48.7, width: 29 },
  // T14 Spillway Left
  { x: -425, z: -62, y: 43.5, width: 29 },
  { x: -430, z: -90, y: 38.5, width: 29 },
  { x: -430, z: -119, y: 33.6, width: 29 },
  { x: -425, z: -148, y: 28.7, width: 29 },
  { x: -416, z: -175, y: 23.7, width: 29 },
  { x: -403, z: -204, y: 18.5, width: 28 },
  { x: -390, z: -232, y: 13.2, width: 28 },
  // T15 Valley Sweep
  { x: -377, z: -261, y: 8.2, width: 27 },
  { x: -363, z: -283, y: 4.3, width: 27 },
  { x: -343, z: -301, y: 1.9, width: 27 },
];

export const switchbackSummit: CourseDefEx = {
  id: 'switchback-summit',
  name: 'Switchback Summit',
  cup: 'hazard',
  points: loopFromWaypoints(WAYPOINTS, {
    width: 26,
    step: 10,
    bankGain: 20,
    // A shade more camber than the flat circuits get. A road cut into a
    // hillside is banked by the hillside, and the traverses are where this
    // course does its overtaking.
    maxBank: 0.22,
    bankSmooth: 55,
  }),
  width: 26,
  laps: 3,
  vergeWidth: 7,
  vergeSurface: 'dirt',
  // Alpine scrub: the slowest surface in the game short of water. On a mountain
  // road, leaving it should not be a detour.
  offSurface: 'grass',
  walls: true,
  wallHeight: 1.6,
  groundSize: 5600,
  // The plain the valley floor road runs across, and nothing more ambitious
  // than that. It used to be -35, on the reasoning that a datum below the start
  // straight gives the climb something to be measured against — but the climb
  // is measured against the *road*, which gains 116m either way, and the only
  // thing the low datum bought was a kilometre of far field sitting five to
  // thirty metres under the nearest tarmac, which is the exact band
  // `alpine.paint` reads as tussock. That is where the pasture green came from.
  groundY: 4,
  startDistance: 50,
  checkpoints: 36,

  features: {
    // Every strip on this circuit is on the way *up*. Climbing at 8-11% costs
    // roughly a fifth of the kart's acceleration, and a boost pad halfway up a
    // traverse is worth twice what the same pad is worth on the flat.
    pads: [
      { at: 0.130, lateral: 0.30, width: 6, length: 20 },
      { at: 0.258, lateral: -0.30, width: 6, length: 20 },
      { at: 0.455, lateral: 0.30, width: 6, length: 20 },
      { at: 0.600, lateral: -0.28, width: 6, length: 20 },
    ],
    // Across the inside of the Spur. The cut is laid on the gravel shoulder, so
    // it holds you to 70% of top speed while saving the tip of the promontory —
    // worth it out of a mini-turbo, and free with a mushroom in the slot.
    shortcuts: [{ from: 0.371, to: 0.403, side: 1 }],
    kerbCurvature: 0.0048,

    // A real mountain, not a rim. 200m of relief starting 200m off the
    // shoulder, and a massif inside the ring tall enough that you cannot see
    // across the circuit — which is what makes a lap feel like a journey
    // instead of a loop.
    terrain: {
      rimStart: 200,
      rimEnd: 760,
      rimHeight: 200,
      landmarks: [
        // The peak the whole circuit is wrapped around. Its foot is held clear
        // of the road by the same gate as the rim, so it rises out of the
        // middle of the ring rather than through the tarmac.
        { x: 70, z: 60, radius: 320, height: 215, kind: 'mesa' },
        // The far side of the valley, seen from the whole descent.
        { x: -1050, z: 480, radius: 430, height: 300, kind: 'mesa' },
        // Behind the Spur, so the promontory has something to be a promontory
        // in front of.
        { x: 1150, z: -180, radius: 380, height: 265, kind: 'mesa' },
        // A needle past the Col, on the skyline of the climb.
        { x: 320, z: 1020, radius: 260, height: 290, kind: 'spire' },
      ],
    },
  },

  theme: {
    ground: 0x8f8c74,
    // Altitude: the zenith goes almost navy and the horizon goes to a cold
    // white. Nothing else in the cup has a sky this dark at the top.
    sky: { top: 0x0c47a4, bottom: 0xb6def6, horizon: 0xeaf4ff },
    // Cool, deep aerial perspective. The far ridges have to grey out or the
    // 300m peaks read as cardboard cut-outs stood behind the track.
    fog: { color: 0xc6dcee, near: 480, far: 3000 },
    sun: { color: 0xfff6e8, intensity: 2.95, azimuth: 5.25, elevation: 0.6 },
    // Dark cold tarmac with white edge marking — a mountain road is kerbed in
    // white paint and snow poles, not in hazard yellow.
    road: { base: '#3C3F47', line: '#FFF8F0', edge: '#FFF8F0' },
    props: {
      alpine: true, cones: true, crowds: true,
      snowPoles: true, pines: true, avalancheFence: true,
    },
  },
};

export default switchbackSummit;
