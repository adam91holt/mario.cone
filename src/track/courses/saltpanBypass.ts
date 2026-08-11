// Course 3 — Saltpan Bypass.
//
// A temporary two-lane bypass bulldozed across a dry salt lake while the real
// road is dug up: the widest, longest, emptiest circuit in the cup — 3.3km, up
// to 36 metres of road, and a horizon with nothing on it.
//
// **What changed, and why.** This course used to be built on one idea: fourteen
// corners between 190 and 420 metres of radius, taken absolutely flat, with a
// single 30-metre chicane as the only place anybody touched the brakes. On the
// page that reads as a design. Measured, it was the emptiest lap in the game:
// a fixed-seed autopilot lap of the whole field produced **nine drifts and not
// one purple mini-turbo**, because a kart at this game's top speed holds a
// 62-metre radius without lifting and *every corner here was three times that*.
// The circuit was not asking a question the kart could answer with the one
// mechanic the game is about.
//
// It is still the fast one. What has changed is that "fast" now means the
// **north half**, and the south half is what a bypass actually is: the bit
// where the temporary road threads through the works.
//
//   ── the pan (flat out, aimed the whole way) ──
//   T1  Windrow Kink    R340 right, a hundred metres after the line
//   T2  Mirage Kink     R360 right, the road at its widest — 36m
//   T3  Grader Kink     R350 left, the counter-swing
//   T4  Brine Sweep     R320 right, 223m of arc: the longest single corner
//                       here, and the one with the salt windrow across it
//   T5  Marker Right    R132, tightening — the first corner that loads a tyre
//   ── the works (four corners and a chicane) ──
//   T6  BEACON RIGHT    R50, 150° and 131 metres of one radius
//   T7  Culvert Left    R48, 135° back the other way
//   T8  Crust Sweep     R114, opening, and the run down to the chicane
//   T9  THE CONTRAFLOW  R30 LEFT at 21m wide. From 36m of road and 60 m/s
//   T10 Contraflow Exit R30 right straight back out of it
//   T11 Windsock Right  R52, 130°
//   T12 Survey Left     R54, 120°
//   T13 Pan Entry       R48, 125° — the last real corner
//   T14 Pan Sweep       R149, all the way round onto the line
//
// **The signature is still the Contraflow**, and it is still the only place two
// karts will not fit: the road pinches from 30 metres to 21 in the two hundred
// before it, and 30 metres of radius is less than two thirds of the tightest
// thing anywhere else on the lap. What it is no longer is the *only* corner —
// there are now six places on this circuit where the wheel is properly turned,
// which is what makes the chicane a climax instead of an anomaly.
//
// Width follows speed here more visibly than anywhere: 36m across the top of
// the map where eight karts fan out four abreast, 21m through the chicane where
// two of them will not fit, 25-28m through the works. And nothing is dead
// straight for longer than 170m — on a circuit where the karts are at 60 m/s
// that is under three seconds.
//
// The pan is flat: four metres of elevation across the whole lap, which is what
// a dry lake is, and what makes the horizon do the work instead of the terrain.
//
// **Two laps.** Every other round in the cup runs three; this one is 3.3
// kilometres of road, and a third lap of it is the same lap again. Two also
// changes what the race *is*: there is no settling-in lap here, the pack is
// still eight wide at the first chicane, and the only place on the circuit
// where a kart can be genuinely blocked gets used four times instead of six.
//
// The look is the other half of the design. A dry lake is the highest-key
// landscape there is — near-white ground throwing light back up into everything
// standing on it, a cobalt zenith because there is nothing in the air, and no
// haze worth the name out to three kilometres. Black bitumen on white salt is
// the highest road-to-ground contrast in the game, and that contrast is what
// keeps a 36m ribbon readable at 60 m/s.

import { loopFromWaypoints } from './path.ts';
import { ring } from './ring.ts';
import type { CourseDefEx } from './types.ts';

/**
 * The ring, driven from the start/finish line at (-461, 232).
 *
 * `run` is a straight in metres; `radius`/`turn` is a constant-radius arc, and
 * a negative turn goes right. See `ring.ts` for why a corner here is a declared
 * radius rather than a handful of points on the map.
 */
const RING = ring(
  { x: -461, z: 232, heading: 32.2, y: 1.7, width: 30 },
  [
    { run: 60, width: 32, y: 1.8, name: 's0' },
    { radius: 340, turn: -22, width: 34, y: 2.0, name: 'T1 WINDROW KINK' },
    { run: 55, width: 35, y: 2.3, name: 's1' },
    { radius: 360, turn: -18, width: 36, y: 2.7, name: 'T2 MIRAGE KINK' },
    { run: 55, width: 36, y: 3.1, name: 's2' },
    { radius: 350, turn: 20, width: 36, y: 3.5, name: 'T3 GRADER KINK' },
    { run: 55, width: 35, y: 3.7, name: 's3' },
    { radius: 320, turn: -40, width: 35, y: 3.8, name: 'T4 BRINE SWEEP' },
    { run: 55, width: 32, y: 3.2, name: 's4' },
    { radius: 132, turn: -40, width: 29, y: 2.6, name: 'T5 MARKER RIGHT' },
    { run: 45, width: 26, y: 2.0, name: 's5' },
    // T6/T7. The pair the whole rebuild turns on: 131 metres of 50-metre radius
    // and then 113 metres of 48 the other way, with a run between them long
    // enough that they are two corners rather than an esse. An esse cancels a
    // drift — you lay it, kill it and re-lay it, and nothing ever charges.
    { radius: 50, turn: -150, width: 25, y: 1.5, name: 'T6 BEACON RIGHT' },
    { run: 198, width: 26, y: 1.0, name: 's6' },
    { radius: 48, turn: 135, width: 26, y: 0.5, name: 'T7 CULVERT LEFT' },
    { run: 60, width: 29, y: 0.4, name: 's7' },
    { radius: 114, turn: -50, width: 30, y: 0.9, name: 'T8 CRUST SWEEP' },
    { run: 184, width: 22, y: 1.6, name: 's8' },
    { radius: 30, turn: 80, width: 21, y: 1.8, name: 'T9 THE CONTRAFLOW' },
    { run: 45, width: 21, y: 2.0, name: 's9' },
    { radius: 30, turn: -85, width: 21, y: 2.3, name: 'T10 CONTRAFLOW EXIT' },
    { run: 210, width: 28, y: 3.0, name: 's10' },
    { radius: 52, turn: -130, width: 28, y: 3.5, name: 'T11 WINDSOCK RIGHT' },
    { run: 210, width: 31, y: 4.1, name: 's11' },
    { radius: 54, turn: 120, width: 30, y: 4.3, name: 'T12 SURVEY LEFT' },
    { run: 210, width: 28, y: 3.7, name: 's12' },
    { radius: 48, turn: -125, width: 27, y: 3.0, name: 'T13 PAN ENTRY' },
    { run: 206, width: 30, y: 2.4, name: 's13' },
    { radius: 149, turn: -55, width: 30, y: 2.0, name: 'T14 PAN SWEEP' },
    { run: 60, width: 31, y: 1.7, name: 's14' },
  ],
  { step: 16 },
);

/** Metres from the ring's origin to the start/finish line. */
const START = 45;
const on = (name: string, along = 0.5): number =>
  ((RING.distanceAlong(name, along) - START) / RING.length + 1) % 1;

export const saltpanBypass: CourseDefEx = {
  id: 'saltpan-bypass',
  name: 'Saltpan Bypass',
  cup: 'hazard',
  points: loopFromWaypoints(RING.waypoints, {
    width: 32,
    step: 10,
    bankGain: 20,
    maxBank: 0.20,
    // Longer easing than the tighter circuits: half the corners here are
    // 300-360m arcs, so the camber has two hundred metres to arrive in and no
    // reason to hurry.
    bankSmooth: 70,
  }),
  width: 32,
  // Two. See the header — 3.3km, and the third lap is the second one again.
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
  startDistance: START,
  checkpoints: 40,

  features: {
    // **Three strips, and they are the longest in the cup.** Thirty-two metres
    // of ramp against Jackhammer Quarry's eighteen, because the question the
    // pan asks is not "can you get back on the throttle" — you never came off
    // it — but "did you aim the sweeper properly two hundred metres ago". Two
    // are laid on the north S where the racing line already is, so they pay the
    // driver who took the right line rather than whoever was nearest the
    // middle. The third is the way out of the chicane, which is where the lap's
    // slowest kart most wants a shove.
    //
    // None is within four hundredths of a lap of the windrow: a strip buried
    // under a patch stops existing for every CPU driver in the field. See
    // `SurfacePatchDef`.
    pads: [
      { at: on('T1 WINDROW KINK', 0.55), lateral: -0.30, width: 7, length: 32 },
      { at: on('T2 MIRAGE KINK', 0.50), lateral: 0.28, width: 7, length: 32 },
      { at: on('s10', 0.35), lateral: 0.26, width: 7, length: 30 },
    ],
    // The closed carriageway: the crust runs straight on past the chicane's
    // first apex. It is 58% of top speed while you are on it, so from 60 m/s it
    // is a trap — and with a mushroom it is the fastest thing on the circuit.
    // `side: 1` is the driver's left, which is the apex of this left-hander.
    shortcuts: [{ from: on('s8', 0.86), to: on('s9', 0.6), side: 1 }],
    // **The drift.** A dry lake is a wind machine, and what it moves is salt.
    // A metre-deep windrow has blown across the *outside* half of the Brine
    // Sweep — the longest single corner on the circuit, taken flat — and it is
    // `sand`, which is 58% of top speed. Nothing is blocking the road: the fast
    // line is still there, it is just narrower than it looks, and a kart pushed
    // wide by a rival at 60 m/s finds out where the edge of it is. It is the
    // only surface hazard in the cup that punishes *being overtaken* rather
    // than braking late.
    //
    // Near-white, because it is salt: on the darkest tarmac in the cup it is
    // the most legible hazard in the game, visible from most of the sweeper
    // before you reach it. You are meant to see it the whole way in and still
    // have to decide how close to run to it.
    patches: [
      {
        from: on('T4 BRINE SWEEP', 0.12), to: on('T4 BRINE SWEEP', 0.88),
        latFrom: 0.40, latTo: 1, surface: 'sand', tint: '#E4DECA',
      },
    ],
    // The works corners run 1/48 to 1/54 of curvature and the pan's sweepers
    // 1/320 to 1/360, so a threshold at 1/85 kerbs exactly the six corners a
    // player brakes for and leaves the flat-out half of the lap clean.
    kerbCurvature: 0.0118,

    // Almost nothing. The rim is 34m of low swell starting 700 metres out —
    // enough to stop the horizon being a ruled line, nowhere near enough to
    // enclose anything — and the only real landforms are three buttes far
    // enough away to read as scenery rather than as walls.
    terrain: {
      rimStart: 700,
      rimEnd: 1600,
      rimHeight: 34,
      landmarks: [
        // Sat on the horizon for the whole of the north S.
        { x: 900, z: 1250, radius: 420, height: 210, kind: 'mesa' },
        // Beyond the works, so the chicane has something behind it.
        { x: 1180, z: -980, radius: 340, height: 175, kind: 'mesa' },
        // A needle out west, past the Pan Sweep.
        { x: -1550, z: -120, radius: 210, height: 190, kind: 'spire' },
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
