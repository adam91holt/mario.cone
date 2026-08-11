// Course 3 — Saltpan Bypass.
//
// The fast one. A temporary two-lane bypass bulldozed across a dry salt lake
// while the real road is dug up, and the widest, longest, emptiest circuit in
// the cup: 3.3km, up to 36 metres of road, and a horizon with nothing on it.
//
// The design problem a fast course has is that "fast" and "boring" are one
// mistake apart. The answer here is that there are no straights at all — the
// whole of the north side is a 900-metre S of 340 to 420-metre radii, taken
// absolutely flat but aimed the whole way — and there is exactly *one* place on
// the lap where you touch the brakes.
//
//   T1  Windrow Kink    340m right, a hundred metres after the line, flat
//   T2  Mirage Kink     380m right, 216m of arc, the road at its widest — 35m
//   T3  Grader Kink     420m left, the counter-swing
//   T4  Brine Sweep     380m right, 272m of arc: the longest single corner here
//   T5  Marker Right    300m, tightening
//   T6  Beacon Right    200m, 263m of arc — the first corner that loads a tyre
//   T7  Culvert Right   190m, the tightest of the fast corners
//   T8  Crust Right     340m, opening, and the run down to the braking point
//   T9  THE CONTRAFLOW  30m LEFT at 21m wide. From 36m of road and 60 m/s.
//   T10 Contraflow Exit 30m right straight back out of it
//   T11 Windsock Right  380m, opening the throttle again
//   T12 Survey Right    300m
//   T13 Pan Entry       210m right, the last real corner
//   T14 Pan Sweep       300m, 330m of arc, all the way round onto the line
//
// **The signature is the Contraflow.** Every other corner on this circuit is
// between 190 and 420 metres of radius; the chicane is 30, and the road pinches
// from 30 metres to 21 in the two hundred before it. It is the only braking
// point on the lap, which makes it the only overtaking point on the lap.
//
// It is also the only *left*. Twelve of the fourteen corners here turn right,
// so you spend two kilometres leaning on one set of tyres and then the circuit
// asks for the other set, hard, at 21 metres of road, at the end of the longest
// flat-out run in the game.
//
// Width follows speed here more visibly than anywhere: 36m across the top of
// the map where eight karts fan out four abreast, 21m through the chicane where
// two of them will not fit. And nothing is dead straight for longer than 130m —
// on a circuit where the karts are at 60 m/s that is two seconds.
//
// The pan is flat. Four metres of elevation across the whole lap, which is what
// a dry lake is, and what makes the horizon do the work instead of the terrain.
//
// **Two laps.** Every other round in the cup runs three or four; this one is
// 3.3 kilometres of road taken at sixty metres a second with one braking point
// on it, and a third lap of that is not a third act, it is the same lap again.
// Two also changes what the race *is*: there is no settling-in lap here, the
// pack is still eight wide at the first chicane, and the only overtaking place
// on the circuit gets used four times instead of six.
//
// The look is the other half of the design. A dry lake is the highest-key
// landscape there is — near-white ground throwing light back up into everything
// standing on it, a cobalt zenith because there is nothing in the air, and no
// haze worth the name out to three kilometres. Black bitumen on white salt is
// the highest road-to-ground contrast in the game, and that contrast is what
// keeps a 36m ribbon readable at 60 m/s.

import { loopFromWaypoints, type Waypoint } from './path.ts';
import type { CourseDefEx } from './types.ts';

/** The ring, driven from the start/finish line at (-461, 232). */
const WAYPOINTS: Waypoint[] = [
  { x: -461, z: 232, y: 0.2, width: 30 },
  { x: -431, z: 250, y: 0.2, width: 31 },
  { x: -401, z: 267, y: 0.2, width: 32 },
  // T1 Windrow Kink
  { x: -371, z: 284, y: 0.3, width: 33 },
  { x: -343, z: 299, y: 0.4, width: 33 },
  { x: -314, z: 311, y: 0.5, width: 33 },
  { x: -279, z: 323, y: 0.6, width: 34 },
  // T2 Mirage Kink
  { x: -244, z: 335, y: 0.7, width: 35 },
  { x: -203, z: 347, y: 0.9, width: 35 },
  { x: -161, z: 354, y: 1, width: 35 },
  { x: -118, z: 357, y: 1.1, width: 35 },
  { x: -75, z: 354, y: 1.2, width: 35 },
  { x: -32, z: 347, y: 1.4, width: 35 },
  { x: 9, z: 337, y: 1.5, width: 36 },
  // T3 Grader Kink
  { x: 50, z: 328, y: 1.6, width: 36 },
  { x: 90, z: 321, y: 1.7, width: 36 },
  { x: 131, z: 317, y: 1.9, width: 36 },
  { x: 171, z: 318, y: 2, width: 36 },
  // T4 Brine Sweep
  { x: 230, z: 321, y: 2.1, width: 35 },
  { x: 275, z: 321, y: 2.2, width: 35 },
  { x: 320, z: 316, y: 2.3, width: 35 },
  { x: 364, z: 305, y: 2.2, width: 35 },
  { x: 407, z: 289, y: 2.1, width: 35 },
  { x: 447, z: 269, y: 1.9, width: 35 },
  { x: 485, z: 243, y: 1.7, width: 35 },
  { x: 515, z: 220, y: 1.5, width: 34 },
  { x: 545, z: 197, y: 1.4, width: 33 },
  // T5 Marker Right
  { x: 575, z: 174, y: 1.2, width: 32 },
  { x: 604, z: 148, y: 1, width: 32 },
  { x: 630, z: 119, y: 0.8, width: 32 },
  // T6 Beacon Right
  { x: 662, z: 77, y: 0.6, width: 30 },
  { x: 685, z: 39, y: 0.3, width: 30 },
  { x: 699, z: -2, y: 0.1, width: 30 },
  { x: 703, z: -46, y: -0.1, width: 30 },
  { x: 698, z: -89, y: -0.3, width: 30 },
  { x: 684, z: -131, y: -0.5, width: 30 },
  { x: 661, z: -168, y: -0.7, width: 30 },
  // T7 Culvert Right
  { x: 651, z: -181, y: -0.9, width: 28 },
  { x: 618, z: -213, y: -1, width: 28 },
  { x: 579, z: -237, y: -1.2, width: 28 },
  { x: 534, z: -251, y: -1.2, width: 28 },
  { x: 497, z: -257, y: -1.2, width: 29 },
  { x: 460, z: -264, y: -1.1, width: 29 },
  // T8 Crust Right
  { x: 423, z: -271, y: -0.9, width: 30 },
  { x: 380, z: -275, y: -0.7, width: 30 },
  { x: 337, z: -275, y: -0.5, width: 30 },
  { x: 294, z: -269, y: -0.3, width: 30 },
  { x: 253, z: -257, y: -0.1, width: 30 },
  // T9 THE CONTRAFLOW
  { x: 234, z: -251, y: 0.1, width: 21 },
  { x: 222, z: -249, y: 0.2, width: 21 },
  { x: 210, z: -253, y: 0.3, width: 21 },
  { x: 201, z: -261, y: 0.4, width: 21 },
  { x: 179, z: -288, y: 0.5, width: 21 },
  // T10 Contraflow Exit
  { x: 156, z: -316, y: 0.6, width: 21 },
  { x: 149, z: -323, y: 0.8, width: 21 },
  { x: 140, z: -326, y: 0.9, width: 21 },
  { x: 100, z: -336, y: 1.1, width: 24 },
  { x: 60, z: -346, y: 1.3, width: 26 },
  { x: 20, z: -356, y: 1.5, width: 29 },
  // T11 Windsock Right
  { x: -20, z: -365, y: 1.7, width: 31 },
  { x: -59, z: -373, y: 1.9, width: 31 },
  { x: -99, z: -376, y: 2.1, width: 31 },
  { x: -140, z: -375, y: 2.3, width: 31 },
  { x: -180, z: -370, y: 2.5, width: 31 },
  { x: -219, z: -360, y: 2.7, width: 31 },
  { x: -255, z: -350, y: 2.8, width: 31 },
  { x: -291, z: -339, y: 2.8, width: 31 },
  { x: -327, z: -328, y: 2.7, width: 30 },
  // T12 Survey Right
  { x: -363, z: -317, y: 2.6, width: 30 },
  { x: -400, z: -303, y: 2.5, width: 30 },
  { x: -434, z: -285, y: 2.3, width: 30 },
  { x: -466, z: -262, y: 2.2, width: 30 },
  { x: -499, z: -235, y: 2, width: 29 },
  // T13 Pan Entry
  { x: -532, z: -209, y: 1.9, width: 28 },
  { x: -563, z: -178, y: 1.7, width: 28 },
  { x: -587, z: -141, y: 1.6, width: 28 },
  { x: -602, z: -100, y: 1.4, width: 28 },
  { x: -609, z: -57, y: 1.3, width: 28 },
  // T14 Pan Sweep
  { x: -610, z: -44, y: 1.2, width: 30 },
  { x: -609, z: -3, y: 1, width: 30 },
  { x: -603, z: 38, y: 0.9, width: 30 },
  { x: -591, z: 78, y: 0.7, width: 30 },
  { x: -574, z: 115, y: 0.6, width: 30 },
  { x: -552, z: 150, y: 0.4, width: 30 },
  { x: -526, z: 182, y: 0.3, width: 30 },
  { x: -495, z: 209, y: 0.2, width: 30 },
];

export const saltpanBypass: CourseDefEx = {
  id: 'saltpan-bypass',
  name: 'Saltpan Bypass',
  cup: 'hazard',
  points: loopFromWaypoints(WAYPOINTS, {
    width: 32,
    step: 10,
    bankGain: 20,
    maxBank: 0.20,
    // Longer easing than the tighter circuits: the corners here are 200-500m
    // arcs, so the camber has 200 metres to arrive in and no reason to hurry.
    bankSmooth: 70,
  }),
  width: 32,
  // Two. See the header — 3.3km at 60 m/s, and the third lap is the second one
  // again.
  laps: 2,
  // Twelve metres of salt crust either side. Running wide out here does not end
  // your race the way it does in the quarry — it just costs you the corner, and
  // that is the trade a wide-open circuit is supposed to offer.
  vergeWidth: 12,
  vergeSurface: 'sand',
  offSurface: 'sand',
  walls: true,
  // Low barriers. On a lake bed there is nothing to armco against, and a 1.5m
  // wall running the length of a 3.3km circuit would fence in the one view the
  // course is built around.
  wallHeight: 1.1,
  groundSize: 6400,
  groundY: 0,
  startDistance: 45,
  checkpoints: 40,

  features: {
    // **Three strips, and they are the longest in the cup.** Thirty-two metres
    // of ramp against Jackhammer Quarry's eighteen, because the question a fast
    // circuit asks is not "can you get back on the throttle" — you never came
    // off it — but "did you aim the sweeper properly two hundred metres ago".
    // Two are on the north S, laid where the racing line already is, so they
    // pay the driver who took the right line rather than whoever happened to be
    // nearest the middle. The third is the way out of the chicane, which is the
    // only place on the lap anybody is slow.
    pads: [
      { at: 0.120, lateral: -0.32, width: 7, length: 32 },
      { at: 0.270, lateral: 0.30, width: 7, length: 32 },
      { at: 0.645, lateral: 0.26, width: 7, length: 30 },
    ],
    // The closed carriageway: the crust runs straight on past the chicane's
    // first apex. It is 58% of top speed while you are on it, so from 60 m/s it
    // is a trap — and with a mushroom it is the fastest thing on the circuit.
    shortcuts: [{ from: 0.574, to: 0.606, side: 1 }],
    // **The drift.** A dry lake is a wind machine, and what it moves is salt.
    // A metre-deep windrow has blown across the *outside* half of the Brine
    // Sweep — the longest single corner on the circuit, 272m of arc taken flat
    // — and it is `sand`, which is 58% of top speed. Nothing is blocking the
    // road: the fast line is still there, it is just narrower than it looks,
    // and a kart pushed wide by a rival at 60 m/s finds out where the edge of
    // it is. It is the only surface hazard in the cup that punishes *being
    // overtaken* rather than braking late. See `SurfacePatchDef` for the frame.
    //
    // Near-white, because it is salt: on the darkest tarmac in the cup it is
    // the most legible hazard in the game, visible from most of the sweeper
    // before you reach it. You are meant to see it the whole way in and still
    // have to decide how close to run to it.
    patches: [
      { from: 0.208, to: 0.252, latFrom: 0.40, latTo: 1, surface: 'sand', tint: '#E4DECA' },
    ],
    // A third higher than Cone Canyon's threshold. At 0.0042 every 240m sweeper
    // on this course would grow a rumble strip and the two corners that matter
    // would stop standing out.
    kerbCurvature: 0.0065,

    // Almost nothing. The rim is 34m of low swell starting 700 metres out —
    // enough to stop the horizon being a ruled line, nowhere near enough to
    // enclose anything — and the only real landforms are three buttes far
    // enough away to read as scenery rather than as walls.
    terrain: {
      rimStart: 700,
      rimEnd: 1600,
      rimHeight: 34,
      landmarks: [
        // Down the length of the north S, sat on the horizon for 900 metres.
        { x: 1500, z: 900, radius: 420, height: 210, kind: 'mesa' },
        // Beyond the chicane, so the braking point has something behind it.
        { x: 260, z: -1450, radius: 340, height: 175, kind: 'mesa' },
        // A needle out west, past the Pan Sweep.
        { x: -1650, z: -260, radius: 210, height: 190, kind: 'spire' },
      ],
    },
  },

  theme: {
    // Near-white evaporite, and the highest-value ground in the game by a
    // distance. It is also, through `sunRig()`, the bounce light: a salt pan
    // throws most of the sun back up at whatever is standing on it, which is
    // why the karts here have almost no dark side and why nothing else in the
    // cup can be lit this way.
    ground: 0xe6e2d2,
    // Deep cobalt overhead falling to white at the horizon — the sky of a place
    // with nothing in the air and a lot of light coming back off the ground.
    sky: { top: 0x0d49c4, bottom: 0xecf7ff, horizon: 0xffffff },
    // The clearest air in the cup by a distance. The far plane is 3000m and the
    // haze is set to reach exactly that, so the buttes stay legible and the
    // circuit's own scale is what the distance reads as.
    fog: { color: 0xeef4f8, near: 900, far: 3000 },
    sun: { color: 0xfffdf4, intensity: 3.3, azimuth: 4.05, elevation: 0.58 },
    // Fresh black bitumen on white salt: the highest road-to-ground contrast in
    // the game, which is what keeps a 36m-wide ribbon readable at 60 m/s.
    road: { base: '#1E222C', line: '#FFF8F0', edge: '#FFC300' },
    props: {
      saltpan: true, cones: true, crowds: true,
      windsocks: true, heatShimmer: true, surveyPegs: true,
    },
  },
};

export default saltpanBypass;
