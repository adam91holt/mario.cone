// Course 1 — Cone Canyon Speedway.
//
// **The opening circuit, and it is the fast one again.** For a round it was
// documented as "fast, wide, one hairpin — the circuit you learn the kart on"
// and traced as the slowest, twitchiest lap in the cup: 46.4s against the
// quarry's 37.0, a 47.2 m/s median against 59.9, forty-six per cent of the lap
// under seventy per cent of top speed, fifteen slow zones, and a longest
// straight of fifty-four metres. Round one was harder work than the round
// billed as the technical one, which is not a difficulty curve, it is an
// inversion. The layout below is the fix, and it is a fix in three moves:
//
//   * **A pit straight you can see the whole circuit from.** Measured on the
//     built spline it is 214 metres of genuinely dead-straight road — the
//     longest in the game; the saltpan, the circuit whose whole premise is
//     speed, tops out at 174 — and 168 of those metres are between the start
//     line and the first bend. There was nothing over 54m anywhere on the old
//     lap, so the player never once got a second to look up and the field never
//     got a place to draft. It is also the widest road here at 30m, with a mesa
//     parked on its vanishing point.
//   * **The esses are gone.** T4 used to be three direction changes at 45m of
//     radius on 19m of road — drift, cancel, re-lay, three times, on the
//     circuit that is supposed to teach drifting. It is now one long rimrock
//     sweep and two 370m-radius arcs that are flat out and still have to be
//     aimed. Five slow zones removed in one edit.
//   * **Eight slow zones, not fifteen**, and the ninetieth-percentile curvature
//     drops from 0.0199 to 0.0156 against the quarry's 0.0262, on a minimum
//     radius of 27m against the quarry's 13.
//
// What the trace will *not* show is round one running away from round two on
// the clock: this circuit laps in ~43.2s to the quarry's ~44.2, on 60 more
// metres of road. That is a 3% edge per metre rather than the 25% deficit it
// started with, and the honest reading is that the two rounds are now separated
// by *shape* — half the slow zones, twice the minimum radius, a third less
// curvature at P90, a 214m straight against 84 — rather than by lap time.
// Chasing the clock further meant tuning round two's boost strips, and those
// move its lap by ±2s run to run, which is not a lever, it is noise.
//
// The one thing this layout gives up is drift: 6.3% of a lap against the
// quarry's 23.6%. Four braking points on a 2.2km circuit is what "fast and
// readable" costs, and the attempt to buy some of it back — a 63m corner at the
// end of the pit straight — is written up at T2 below, along with why it is not
// in the build.
//
// What is *kept* is the one hairpin. Digger's Elbow is still 27m of radius at
// 19m of road, still the narrowest tarmac in the cup outside the quarry, and
// still the only place on this circuit where you are properly slow. One
// hairpin on a fast circuit is a feature; nine corners under 50m is a different
// course.
//
//   T1  Hi-Vis Sweep    300m of banked right off the pit straight, opening
//                       then holding. Flat, and aimed the whole way.
//   T2  The Kink        a left flick mid-climb that unloads the bank
//   T3  Cone Crest      a 45m right over the brow at the top of the climb —
//                       the road goes light and the whole south rim appears
//   T4  Rimrock Sweep   the long fast left along the top of the drop
//   T5  The Long Right  370m of radius, taken flat, aimed the whole way
//   T6  The Long Left   370m the other way, into the braking point
//   T7  Digger's Elbow  27m at 19m wide — the pinch, with the gravel cut
//   T8  The Notch       one long left out of the hairpin exit
//   T9  Canyon Wall     the banked sweeper home, under the rim
//   T10 Cone Corner     the slow right that pays for the pit straight
//
// Two rules the layout is held to. *Width follows speed*: 30m down the pit
// straight where the pack fans out, 19m at the hairpin apex, 25-27m through
// the fast arcs. And *no straight is longer than the run
// to the first corner* — the pit straight **is** that run, and every other
// section carries 370 to 600m of radius, which is flat out but is not a
// straight.
//
// Waypoints are authored on the map; `loopFromWaypoints` resamples them into
// evenly spaced control points and derives the banking from the turn rate, so
// the numbers below say what the corner *is*, not what the spline needs.
//
// **This is the warm one, and it is also the plain one.** Round one of a cup
// teaches the vocabulary: three laps, four strips, one gravel cut, no surface
// hazard on the racing line. Everything the other three rounds do differently
// — three laps and five short strips in the pit with two spills on the floor,
// two laps and three long ramps on the pan with a salt windrow across a
// flat-out sweeper, five strips on the climb and a washout on the descent — is
// measured against this. Those hazards are live now rather than declared; see
// `SurfacePatchDef`.

import { loopFromWaypoints, type Waypoint } from './path.ts';
import type { CourseDefEx } from './types.ts';

/**
 * The ring, driven from the start/finish line at (-206, 254).
 *
 * The first five entries are the pit straight and they are *collinear on
 * purpose* — z is exactly 254 through all of them, because a centripetal
 * Catmull-Rom will happily put four millirad of curvature through a run of
 * points that merely look straight, and four millirad is the difference
 * between a straight and a corner as far as `findCorners` is concerned. The
 * last two entries are the same line, west of the flag, so the grid is on
 * level tarmac too.
 */
const WAYPOINTS: Waypoint[] = [
  // ── The pit straight ── 214m dead straight, the line 46m into it.
  { x: -206, z: 254, y: 0, width: 30 },
  { x: -152, z: 254, y: 0, width: 30 },
  { x: -98, z: 254, y: 0, width: 30 },
  { x: -44, z: 254, y: 0, width: 30 },
  { x: -10, z: 254, y: 0, width: 29 },
  // T1 Hi-Vis Sweep — 300m of banked right, opening then holding.
  { x: 50, z: 249, y: 0.8, width: 28 },
  { x: 110, z: 236, y: 2.0, width: 28 },
  { x: 166, z: 213, y: 3.6, width: 27 },
  { x: 214, z: 180, y: 5.4, width: 27 },
  { x: 252, z: 138, y: 7.6, width: 26 },
  // T2 The Kink — the camber lets go for a moment, halfway up the climb.
  //
  // **There was a braking point here for one build and it is deliberately gone
  // again.** A 214-metre straight whose corner is taken flat has nothing at the
  // end of it — no braking point, no overtaking, nowhere to lay a drift — so T1
  // was given a 63m exit at 24m of road, and the drift share went 6.3% to 10.1%
  // exactly as intended. It also put a repeatable stall thirty metres past the
  // corner: the field arrived out of T1 at 58-65 m/s and a trace has the player
  // going 58.9 to 8.1 m/s in three quarters of a second, on tarmac, grounded,
  // with no item in flight. `capture.mjs --smoke` fails on it. Whatever that is
  // — a kerb at the apex of a corner nothing had ever kerbed, the camber
  // reversing into the kink, the AI carrying speed it cannot then place — it is
  // not a course-file fix, and a layout that reads well in a diagram and stops
  // the whole grid in the game is not a layout. It is in this round's report as
  // a physics/AI question; the sweeper stays flat until it is answered.
  { x: 276, z: 92, y: 10.0, width: 26 },
  { x: 285, z: 44, y: 12.8, width: 26 },
  { x: 281, z: -4, y: 15.6, width: 26 },
  // T3 Cone Crest — a 45m right over the brow, then the floor disappears.
  // The vertical is deliberate and it is deliberately *just* short of a jump:
  // +8.5% into the crest, -11% out of it, which is about 4.5 milliradians per
  // metre. At the 80 m/s this circuit arrives at, that unloads roughly seven
  // tenths of the kart's weight for the length of a car — the road goes light,
  // the camera lifts, the whole south rim opens up — and puts none of it in
  // the air. Sharper reads as a ramp, and a ramp mid-corner is a wreck.
  { x: 287, z: -46, y: 19.0, width: 25 },
  { x: 300, z: -84, y: 21.4, width: 25 },
  { x: 298, z: -124, y: 18.2, width: 26 },
  { x: 280, z: -160, y: 13.6, width: 26 },
  // T4 Rimrock Sweep — the long fast left along the top of the drop, opening
  // into a shallow counter-swing that sets up the two arcs.
  { x: 250, z: -190, y: 11.0, width: 26 },
  { x: 212, z: -210, y: 9.0, width: 26 },
  { x: 168, z: -218, y: 7.4, width: 26 },
  { x: 124, z: -213, y: 6.2, width: 25 },
  { x: 78, z: -205, y: 5.2, width: 25 },
  // T5 The Long Right — a 370m arc bowed south. Four points across 220 metres
  // rather than eight: a shallow curve authored at close spacing is where a
  // centripetal Catmull-Rom finds curvature nobody asked for, and the version
  // of this section that had a waypoint every 48m measured as three separate
  // 60m corners.
  { x: 30, z: -207, y: 4.2, width: 25 },
  { x: -18, z: -222, y: 3.0, width: 26 },
  { x: -68, z: -239, y: 1.6, width: 26 },
  { x: -121, z: -250, y: 0.2, width: 27 },
  // T6 The Long Left — 370m the other way, bowed north, into the braking point.
  { x: -176, z: -252, y: -1.2, width: 27 },
  { x: -227, z: -244, y: -2.6, width: 27 },
  { x: -278, z: -243, y: -4.0, width: 26 },
  { x: -328, z: -249, y: -5.4, width: 26 },
  // T7 Digger's Elbow — 27m of radius at 19m wide, the pinch point of the
  // circuit, with the gravel cut across its apex.
  { x: -378, z: -262, y: -6.6, width: 22 },
  { x: -406, z: -252, y: -7.0, width: 20 },
  { x: -424, z: -230, y: -7.0, width: 19 },
  { x: -424, z: -206, y: -7.0, width: 19 },
  { x: -406, z: -186, y: -6.9, width: 20 },
  { x: -378, z: -178, y: -6.6, width: 22 },
  // T8 The Notch — one long left off the hairpin exit. It was three flicks and
  // measured as three separate corners; a circuit with one hairpin on it does
  // not also need a chicane forty metres past the hairpin exit.
  { x: -338, z: -168, y: -6.1, width: 24 },
  { x: -308, z: -138, y: -5.2, width: 25 },
  { x: -294, z: -98, y: -4.2, width: 25 },
  // T9 Canyon Wall — the long banked sweeper home, under the rim.
  { x: -291, z: -52, y: -3.2, width: 26 },
  { x: -289, z: -6, y: -2.2, width: 26 },
  { x: -293, z: 40, y: -1.2, width: 27 },
  { x: -303, z: 86, y: -0.4, width: 27 },
  { x: -319, z: 132, y: 0.3, width: 28 },
  { x: -340, z: 170, y: 0.55, width: 28 },
  // T10 Cone Corner — 42m of radius, and the slowest thing on the lap after
  // the hairpin. A long straight is only worth having if the corner onto it is
  // worth getting right: this is where the lap is won and where the kart behind
  // gets a tow all the way to T1.
  { x: -344, z: 200, y: 0.45, width: 27 },
  { x: -334, z: 228, y: 0.28, width: 27 },
  { x: -310, z: 247, y: 0.1, width: 28 },
  { x: -282, z: 254, y: 0, width: 29 },
  { x: -244, z: 254, y: 0, width: 30 },
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
    // Lap fractions. Four strips, and none of them on the pit straight — a
    // boost pad where the kart is already at terminal velocity is decoration.
    // Two pay for the two fast arcs, one is the way out of the hairpin where
    // you have no speed and badly want some, and the last fires you off Cone
    // Corner onto the longest straight in the cup.
    pads: [
      { at: 0.515, lateral: -0.34, width: 5.5, length: 22 },
      { at: 0.618, lateral: 0.30, width: 5.5, length: 22 },
      { at: 0.738, lateral: 0.30, width: 5.5, length: 18 },
      { at: 0.966, lateral: -0.32, width: 5.5, length: 22 },
    ],
    // Digger's Elbow. Cutting the inside gravel saves about 25 metres and costs
    // you a third of your top speed while you are on it — worth it out of a
    // mini-turbo, a disaster from a standing start. `side: -1` is the driver's
    // right, which is the apex of this right-hander; see `ShortcutDef`.
    shortcuts: [{ from: 0.668, to: 0.712, side: -1 }],
    // Raised from 0.0042. The layout is a third less curved than it was, so the
    // old threshold would now lay a rumble strip down half the circuit and the
    // three corners that matter would stop standing out.
    kerbCurvature: 0.005,

    // The canyon the course is named after. The rim starts 165m off the
    // shoulder — clear of the circuit, close enough to stand over it — and
    // four buttes are placed so every corner exit has a different thing at its
    // vanishing point. All four moved with the layout: a landform is only a
    // landmark if it is at the end of a straight somebody is actually driving.
    terrain: {
      rimStart: 165,
      rimEnd: 520,
      rimHeight: 105,
      landmarks: [
        // Dead ahead down the pit straight, and the reason that straight is
        // worth 204 metres: you spend all of it driving at a mesa.
        { x: 620, z: 250, radius: 250, height: 135, kind: 'mesa' },
        // At the far end of The Long Left, over the hairpin.
        { x: -820, z: -330, radius: 280, height: 150, kind: 'mesa' },
        // The wall the Canyon Wall sweeper runs under, on the driver's left.
        { x: -700, z: 110, radius: 220, height: 120, kind: 'mesa' },
        // A needle in the middle of the loop — visible from three quarters of
        // the lap, which is what makes the circuit legible from the air.
        { x: -25, z: 10, radius: 115, height: 88, kind: 'spire' },
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
    // **A warm road, and that is a deliberate separation.** All four courses
    // ran a base between #2B2D34 and #3A3D46, which a critic photographed side
    // by side and called indistinguishable — correctly. Four dark neutrals
    // differing by five per cent of luminance is one road surface with rounding
    // error. This one is the warm one: a desert road laid on ironstone, brown
    // in the shadows, against the quarry's cold basalt, the saltpan's blue-black
    // fresh bitumen and the mountain's pale weathered grey.
    road: { base: '#4A403A', line: '#FFF8F0', edge: '#FFC300' },
    props: { canyon: true, cones: true, crowds: true },
  },
};

export default coneCanyon;
