// Course 2 — Jackhammer Quarry.
//
// The technical one. Cone Canyon is a fast circuit that happens to have a
// hairpin in it; this is the opposite — a working aggregate pit with a road
// threaded round its rim and back and forth across its floor, where the
// question every corner asks is *how early can you get back on the throttle*
// rather than *how fast can you carry this in*.
//
// Fifteen corners in 2.1km. Nine of them under 40 metres of radius. Nothing on
// the lap is wider than 24m and the pinch point is 16m — a metre narrower than
// anywhere on Cone Canyon.
//
//   T1  Weighbridge Kink  a 105m right you take flat, aimed at a rock face
//   T2  Screed Kink       the road unwinds left for a moment
//   T3  Hopper Sweep      95m right, the last fast corner before the benches
//   T4  Tipping Right     38m right, hard on the brakes, the road narrows to 19
//   T5  Bench One         a 24m LEFT, straight off a hard right. 17m of road.
//   T6  Bench Two         a 24m right straight back out of it. 17m wide.
//   T7  Pit Entry         the lip. The floor drops 19m in 160m — 20% at its steepest.
//   T8  Floor One         a fast left across the pit floor at its widest, 21m
//   T9  THE CRUSHER       24m right at 16m wide — the narrowest road in the cup
//   T10 Crusher Exit      and immediately 26m the same way. 188° in 100 metres.
//   T11 Floor Two         a flick, barely a corner, taken at full lean
//   T12 Floor Three       127° of left around the sump — the slowest point
//   T13 Sump Left         opening out onto the haul road
//   T14 Haul Road         117° right, climbing, blind over the lip
//   T15 Gate Sweep        the long right back up to the weighbridge
//
// The two rules Cone Canyon is held to hold here too, and both bite harder.
// *Width follows speed*: 24m on the weighbridge straight, 21m on the fast run
// across the floor, 17m through the benches, 16m through the Crusher. And
// *nothing is dead straight for longer than the run to the first corner*: the
// longest true straight on the lap is the 130m plunge into the pit, and it is
// pointing downhill at a corner you cannot see the exit of. The run from the
// line to T1 is 83 metres.
//
// The elevation is the pit, and only the pit: the rim road is level to within
// a metre for the first half of the lap, then the floor falls away 19m through
// T7, stays flat for the whole floor section, and climbs back out at about 5%
// up the haul road. That shape is not free-hand — the rim road and the pit
// floor pass within 160m of each other, and the embankment either side of a
// road is anchored to *that* road's height, so a bigger difference there would
// stand the rim's bank over the top of the floor road. 19m is what fits.
//
// Waypoints are authored on the map; `loopFromWaypoints` resamples them and
// derives the banking from the measured turn rate.

import { loopFromWaypoints, type Waypoint } from './path.ts';
import type { CourseDefEx } from './types.ts';

/** The ring, driven from the weighbridge straight at (-312, 140). */
const WAYPOINTS: Waypoint[] = [
  { x: -312, z: 140, y: -0.3, width: 23 },
  { x: -276, z: 162, y: -0.1, width: 23 },
  { x: -239, z: 185, y: -0.1, width: 24 },
  // T1 Weighbridge Kink
  { x: -203, z: 208, y: -0.1, width: 24 },
  { x: -163, z: 222, y: -0.2, width: 24 },
  { x: -119, z: 220, y: -0.2, width: 24 },
  { x: -85, z: 210, y: -0.2, width: 24 },
  { x: -50, z: 200, y: -0.3, width: 24 },
  { x: -15, z: 190, y: -0.3, width: 23 },
  // T2 Screed Kink
  { x: 20, z: 181, y: -0.3, width: 23 },
  { x: 58, z: 175, y: -0.4, width: 23 },
  { x: 97, z: 178, y: -0.4, width: 23 },
  // T3 Hopper Sweep
  { x: 149, z: 188, y: -0.5, width: 22 },
  { x: 190, z: 187, y: -0.5, width: 22 },
  { x: 227, z: 169, y: -0.5, width: 22 },
  { x: 252, z: 137, y: -0.6, width: 22 },
  { x: 266, z: 110, y: -0.6, width: 21 },
  // T4 Tipping Right
  { x: 279, z: 83, y: -0.6, width: 19 },
  { x: 283, z: 68, y: -0.6, width: 19 },
  { x: 280, z: 52, y: -0.7, width: 19 },
  { x: 271, z: 39, y: -0.7, width: 19 },
  { x: 242, z: 11, y: -0.7, width: 18 },
  // T5 Bench One
  { x: 212, z: -17, y: -0.7, width: 17 },
  { x: 206, z: -26, y: -0.8, width: 17 },
  { x: 204, z: -36, y: -0.8, width: 17 },
  { x: 208, z: -47, y: -0.8, width: 17 },
  { x: 230, z: -85, y: -0.8, width: 17 },
  // T6 Bench Two
  { x: 252, z: -123, y: -0.9, width: 17 },
  { x: 255, z: -132, y: -0.9, width: 17 },
  { x: 254, z: -141, y: -0.9, width: 17 },
  { x: 250, z: -150, y: -0.9, width: 17 },
  { x: 242, z: -156, y: -0.9, width: 17 },
  { x: 208, z: -174, y: -1.1, width: 18 },
  { x: 174, z: -193, y: -1.7, width: 18 },
  // T7 Pit Entry
  { x: 139, z: -212, y: -2.7, width: 19 },
  { x: 128, z: -215, y: -4.4, width: 19 },
  { x: 116, z: -215, y: -7.1, width: 19 },
  { x: 74, z: -203, y: -10.9, width: 20 },
  { x: 32, z: -191, y: -14.8, width: 20 },
  { x: -10, z: -180, y: -17.9, width: 21 },
  // T8 Floor One
  { x: -52, z: -168, y: -19.4, width: 21 },
  { x: -66, z: -167, y: -19.9, width: 21 },
  { x: -79, z: -170, y: -19.8, width: 21 },
  { x: -110, z: -185, y: -19.8, width: 19 },
  { x: -140, z: -200, y: -19.7, width: 18 },
  // T9 THE CRUSHER
  { x: -171, z: -215, y: -19.6, width: 16 },
  { x: -179, z: -217, y: -19.6, width: 16 },
  { x: -188, z: -216, y: -19.6, width: 16 },
  { x: -196, z: -212, y: -19.6, width: 16 },
  { x: -202, z: -206, y: -19.5, width: 16 },
  { x: -220, z: -178, y: -19.5, width: 16 },
  // T10 Crusher Exit
  { x: -238, z: -150, y: -19.4, width: 16 },
  { x: -241, z: -142, y: -19.4, width: 16 },
  { x: -242, z: -132, y: -19.4, width: 16 },
  { x: -238, z: -123, y: -19.3, width: 16 },
  { x: -232, z: -116, y: -19.3, width: 16 },
  { x: -224, z: -111, y: -19.3, width: 16 },
  { x: -187, z: -99, y: -19.2, width: 17 },
  { x: -151, z: -87, y: -19.1, width: 19 },
  // T11 Floor Two
  { x: -114, z: -75, y: -19.1, width: 20 },
  { x: -110, z: -74, y: -18.9, width: 20 },
  { x: -106, z: -72, y: -18.6, width: 20 },
  // T12 Floor Three
  { x: -74, z: -51, y: -18.1, width: 18 },
  { x: -66, z: -43, y: -17.6, width: 18 },
  { x: -61, z: -33, y: -17.1, width: 18 },
  { x: -61, z: -22, y: -16.6, width: 18 },
  { x: -64, z: -12, y: -16.1, width: 18 },
  { x: -71, z: -3, y: -15.5, width: 18 },
  { x: -80, z: 3, y: -14.6, width: 18 },
  { x: -122, z: 18, y: -13.1, width: 19 },
  { x: -165, z: 34, y: -11.5, width: 20 },
  // T13 Sump Left
  { x: -207, z: 50, y: -10, width: 21 },
  { x: -224, z: 53, y: -8.7, width: 21 },
  { x: -240, z: 49, y: -7.5, width: 21 },
  // T14 Haul Road
  { x: -286, z: 29, y: -6.4, width: 21 },
  { x: -302, z: 25, y: -5.4, width: 21 },
  { x: -318, z: 28, y: -4.5, width: 21 },
  { x: -332, z: 36, y: -3.8, width: 21 },
  { x: -343, z: 49, y: -3.1, width: 21 },
  { x: -347, z: 64, y: -2.4, width: 21 },
  { x: -346, z: 81, y: -1.8, width: 21 },
  // T15 Gate Sweep
  { x: -341, z: 101, y: -1.2, width: 23 },
  { x: -330, z: 123, y: -0.6, width: 23 },
];

export const jackhammerQuarry: CourseDefEx = {
  id: 'jackhammer-quarry',
  name: 'Jackhammer Quarry',
  cup: 'hazard',
  points: loopFromWaypoints(WAYPOINTS, {
    width: 21,
    step: 10,
    bankGain: 20,
    maxBank: 0.21,
    // Same 55-60m of easing Cone Canyon needs: the kart's contact test reads a
    // surface rolling out from under it as a launch, so camber has to arrive
    // slowly even when the corner it belongs to is short.
    bankSmooth: 55,
  }),
  width: 21,
  laps: 3,
  // Five metres narrower on the shoulder than Cone Canyon, so the barrier is
  // genuinely close. On a circuit this tight the run-off is the punishment.
  vergeWidth: 6,
  // Gravel first, then loose aggregate. Two metres narrower than Cone Canyon's
  // shoulder but no harsher per metre — a circuit this tight needs its mistakes
  // to be recoverable, or the whole field spends the race in the run-off.
  vergeSurface: 'dirt',
  offSurface: 'sand',
  walls: true,
  wallHeight: 1.5,
  // Small world, fine grid: 3000/176 puts a terrain cell at 17m rather than
  // Cone Canyon's 24m, which is what lets the pit walls read as rock faces with
  // edges instead of dunes.
  groundSize: 3000,
  groundY: -10,
  startDistance: 45,
  checkpoints: 32,

  features: {
    // Four strips, and every one of them is somewhere the circuit has just
    // taken your speed away: the run off the Screed Kink, the exit of the
    // Crusher, the way out of the sump — the slowest corner on the lap — and
    // the haul road, where you are climbing at 5% with nothing left.
    pads: [
      { at: 0.270, lateral: 0.30, width: 5.5, length: 18 },
      { at: 0.735, lateral: 0.32, width: 5.5, length: 18 },
      { at: 0.830, lateral: -0.28, width: 5.5, length: 18 },
      { at: 0.945, lateral: -0.30, width: 5.5, length: 18 },
    ],
    // Across the inside of the Crusher's first apex, where the road is 16m —
    // the narrowest tarmac in the cup. The cut saves about twenty metres and
    // holds you to 70% of top speed while you are on it: free out of a
    // mini-turbo, a disaster if you arrive already slow.
    shortcuts: [{ from: 0.632, to: 0.672, side: -1 }],
    // A shade higher than Cone Canyon's, because half this circuit is under
    // 40m of radius and kerbing all of it would leave nothing to aim at.
    kerbCurvature: 0.005,

    // The pit. `rimStart` at 85m puts the rock inside the first thing a driver
    // looks at rather than out on the horizon, and 138m of it stands well over
    // the highest part of the circuit — so the sky is a lid, not a backdrop.
    terrain: {
      rimStart: 85,
      rimEnd: 310,
      rimHeight: 138,
      landmarks: [
        // The stack the Crusher runs round. 160m off the apex — close enough to
        // be the thing you brake at, far enough to clear the barrier.
        { x: -330, z: -300, radius: 110, height: 88, kind: 'spire' },
        // The screening plant's face, at the vanishing point of the bench run.
        { x: 430, z: 120, radius: 130, height: 76, kind: 'spire' },
        // The high wall behind the weighbridge, closing the start straight.
        { x: -120, z: 500, radius: 230, height: 138, kind: 'mesa' },
        // The overburden dump, seen across the pit from the whole floor section.
        { x: -560, z: -430, radius: 300, height: 152, kind: 'mesa' },
      ],
    },
  },

  theme: {
    ground: 0xb08a4e,
    // A harder, hotter sky than the canyon's: deeper at the zenith, and the
    // haze band is dust rather than warm air.
    sky: { top: 0x1e70c4, bottom: 0xcde6f2, horizon: 0xeed9a4 },
    // Half the visibility of Cone Canyon, on purpose. A working pit has its own
    // weather, and it is the reason the far wall reads as far.
    fog: { color: 0xd9c79e, near: 240, far: 1450 },
    sun: { color: 0xfff4dc, intensity: 3.05, azimuth: 2.15, elevation: 0.56 },
    // Grey, dust-scoured tarmac with an orange edge — the canyon's is warmer
    // asphalt with a yellow one, and at speed that is the whole difference.
    road: { base: '#4B4C50', line: '#FFF8F0', edge: '#FF6B1A' },
    props: {
      quarry: true, cones: true, crowds: true,
      machinery: 'heavy', dust: true, conveyors: true,
    },
  },
};

export default jackhammerQuarry;
