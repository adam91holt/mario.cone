// Course 1 — Cone Canyon Speedway.
//
// **The opening circuit, and the one the drift is taught on.**
//
// For two rounds this course was tuned for *speed* and measured for speed, and
// the thing it was quietly failing at was the mechanic the whole game is built
// around. A fixed-seed autopilot lap across the field produced 35 drifts and
// eight purple mini-turbos, with the longest slide anybody held anywhere on the
// lap lasting 1.75 seconds. Three corners out of eleven were tight enough to
// drift at all; the other eight were taken flat, because a kart at this game's
// top speed will hold a 62-metre radius without lifting and every one of them
// was 90 metres or wider.
//
// The fix is not longer corners and it is not more of them. It is **radius**,
// and it is *held* radius:
//
//   * a committed drift can be steered between about a 23m arc at full lock and
//     a 56m arc fully counter-steered. Inside that band the slide is a line you
//     choose. Outside it the slide drives the kart, and the charge is thrown
//     away before it tiers.
//   * a hand-placed corner has no radius — it has a peak somewhere and a long
//     tail either side. Measured across this cup, corners ran a mean radius
//     about 1.4x their tightest point, so a "45m corner" was 70m at turn-in,
//     45m at the apex and 70m again at the exit: outside the band, inside it,
//     outside it. The drift was being asked to change radius by two thirds
//     mid-slide, and it broke every time the road opened.
//
// So this circuit is now authored in `ring.ts`: a ledger of straights and
// **exact circular arcs**, where `{ radius: 47, turn: -185 }` is a hundred and
// fifty-two metres of road that is 47 metres of radius at every point on it.
// Eight of the nine corners now sit inside the band a drift can be steered in,
// and every one of them holds a single radius from turn-in to exit.
//
//   T1  Hi-Vis Right    R50, 160° — the braking point at the end of the pit
//                       straight. A 330-metre run at a 50-metre corner: this is
//                       where the lap is overtaken, and it did not exist before
//   T2  The Kink        R58 left, the camber letting go halfway up the climb
//   T3  Cone Crest      R66 right over the brow — the road goes light and the
//                       whole south rim appears at once
//   T4  Rimrock Sweep   R126 left, the one corner here that is genuinely flat
//                       out and still has to be aimed
//   T5  THE CAROUSEL    R47, 185°, 152 metres of one radius. The signature:
//                       a full horseshoe round the head of the canyon, banked,
//                       and long enough to hold a purple with room left over
//   T6  The Long Left   R52, 140° the other way — the same corner mirrored, and
//                       the only place on the lap you drift left
//   T7  Digger's Elbow  R32 hairpin at 19m of road, with the gravel cut
//   T8  The Notch       R60 left, the long climb out of the pit
//   T10 Cone Corner     R46, 146° — the corner that pays for the pit straight
//
// The two rules this circuit is held to are unchanged and both still bite.
// *Width follows speed*: 30m across the start line where the pack fans out, 19m
// at the hairpin apex, 22-26m through the drift corners. And *nothing is dead
// straight for longer than the run to the first corner* — that run **is** the
// pit straight, at 250 metres from the line, and no other straight on the lap
// reaches 180.
//
// **This is the warm one, and it is still the plain one.** Round one of a cup
// teaches the vocabulary: three laps, four strips, one gravel cut, no surface
// hazard on the racing line. Everything the other three rounds do differently
// is measured against this.

import { loopFromWaypoints } from './path.ts';
import { ring } from './ring.ts';
import type { CourseDefEx } from './types.ts';

/**
 * The ring, driven east from the start/finish line at (-206, 254).
 *
 * `run` is a straight in metres; `radius`/`turn` is a constant-radius arc, and
 * a negative turn goes right. `width` and `y` are what the road *becomes* by
 * the end of the segment, so a corner and its run-in declare the same width and
 * the pinch arrives with the corner. Turns sum to -360 and the closure is
 * adjusted across the straights — see `ring.ts`.
 */
const RING = ring(
  { x: -206, z: 254, heading: 0, y: 0, width: 30 },
  [
    // The pit straight. 250m from the line to the braking board — 330m of
    // uninterrupted road once the run out of Cone Corner is counted — and the
    // widest tarmac on the circuit, with a mesa parked on its vanishing point.
    { run: 190, width: 30, y: 0.5, name: 'PIT STRAIGHT' },
    { run: 60, width: 25, y: 1, name: 'BRAKING BOARD' },
    // T1. **The braking point that was missing.** A 330-metre straight whose
    // first corner is taken flat has nothing at the end of it — no braking, no
    // overtaking, nowhere to lay a drift. This is 50 metres of radius held
    // through 160 degrees, arrived at flat out.
    { radius: 50, turn: -160, width: 24, y: 4, name: 'T1 HI-VIS RIGHT' },
    { run: 130, width: 26, y: 8, name: 'r1' },
    { radius: 58, turn: 80, width: 25, y: 13, name: 'T2 THE KINK' },
    { run: 175, width: 25, y: 16, name: 'r2' },
    // T3. The vertical here is deliberate and deliberately *just* short of a
    // jump: +7% into the crest, -9% out of it. At the speed this arrives at
    // that unloads most of the kart's weight for the length of a car — the road
    // goes light, the camera lifts — and puts none of it in the air. Sharper
    // reads as a ramp, and a ramp mid-corner is a wreck; the brow was flattened
    // from 22m to 19m when the corner under it came down from 100m of radius to
    // 66, because a tight corner and a big unload in the same hundred metres is
    // two set pieces fighting.
    { radius: 66, turn: -110, width: 24, y: 19, name: 'T3 CONE CREST' },
    { run: 71, width: 26, y: 15, name: 'r3' },
    // The one corner on the lap that is genuinely flat out and still has to be
    // aimed. Every circuit needs one; this is it.
    { radius: 126, turn: 52, width: 26, y: 11, name: 'T4 RIMROCK SWEEP' },
    { run: 146, width: 23, y: 7, name: 'r4' },
    // T5. The signature. 152 metres of 47-metre radius, which is a shade under
    // three seconds at the speed it is taken — a purple needs about one — and
    // it never changes radius, so the drift laid at turn-in is the drift that
    // comes out the far side.
    { radius: 47, turn: -185, width: 21, y: 4, name: 'T5 THE CAROUSEL' },
    { run: 147, width: 24, y: 1, name: 'r5' },
    { radius: 52, turn: 140, width: 24, y: -2, name: 'T6 THE LONG LEFT' },
    { run: 52, width: 20, y: -5, name: 'r6' },
    { radius: 32, turn: -170, width: 19, y: -7, name: 'T7 DIGGERS ELBOW' },
    { run: 169, width: 24, y: -6, name: 'r7' },
    { radius: 60, turn: 139, width: 25, y: -2, name: 'T8 THE NOTCH' },
    { run: 63, width: 26, y: 0, name: 'r8' },
    { radius: 46, turn: -146, width: 26, y: 0, name: 'T10 CONE CORNER' },
    { run: 80, width: 30, y: 0, name: 'r10' },
  ],
  { step: 14 },
);

/** Metres from the ring's origin to the start/finish line. */
const START = 0;
/** Lap fraction of a fraction of the way along a named segment. */
const on = (name: string, along = 0.5): number =>
  ((RING.distanceAlong(name, along) - START) / RING.length + 1) % 1;

export const coneCanyon: CourseDefEx = {
  id: 'cone-canyon',
  name: 'Cone Canyon Speedway',
  cup: 'hazard',
  points: loopFromWaypoints(RING.waypoints, {
    width: 26,
    step: 10,
    bankGain: 20,
    maxBank: 0.21,
    // Banking has to arrive slowly. The kart's contact test treats the surface
    // rolling out from under it as a launch, so a fast camber transition pops
    // the whole field into the air mid-corner; ~60m of easing keeps the drift
    // corners properly banked without ever throwing a kart off the road.
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
  groundY: -9,
  startDistance: START,
  checkpoints: 32,

  features: {
    // Four strips, and none of them on the pit straight — a boost pad where the
    // kart is already at terminal velocity is decoration. Each one is laid on
    // the way *out* of a corner you had to work for, so the pad is the payment
    // for the drift rather than a thing you drive over.
    pads: [
      { at: on('r1', 0.45), lateral: -0.32, width: 5.5, length: 20 },
      { at: on('r5', 0.35), lateral: 0.30, width: 5.5, length: 22 },
      { at: on('r7', 0.30), lateral: 0.30, width: 5.5, length: 18 },
      { at: on('r10', 0.45), lateral: -0.32, width: 5.5, length: 22 },
    ],
    // Digger's Elbow. Cutting the inside gravel saves about 25 metres and costs
    // you a third of your top speed while you are on it — worth it out of a
    // mini-turbo, a disaster from a standing start. `side: -1` is the driver's
    // right, which is the apex of this right-hander; see `ShortcutDef`.
    shortcuts: [{ from: on('T7 DIGGERS ELBOW', 0.12), to: on('T7 DIGGERS ELBOW', 0.88), side: -1 }],
    // Raised from 0.005. Eight corners run 1/32 to 1/66 of curvature and the
    // Rimrock Sweep runs 1/126, so a threshold at 1/125 puts a rumble strip on
    // everything a player brakes for and leaves the one flat-out sweeper clean.
    kerbCurvature: 0.008,

    // The canyon the course is named after. The rim starts 165m off the
    // shoulder — clear of the circuit, close enough to stand over it — and four
    // buttes are placed so every corner exit has a different thing at its
    // vanishing point. All four moved with the layout: a landform is only a
    // landmark if it is at the end of a straight somebody is actually driving.
    terrain: {
      rimStart: 165,
      rimEnd: 520,
      rimHeight: 105,
      landmarks: [
        // Dead ahead down the pit straight, and the reason that straight is
        // worth 250 metres: you spend all of it driving at a mesa.
        { x: 760, z: 252, radius: 260, height: 140, kind: 'mesa' },
        // Beyond the Carousel, so the horseshoe has a wall behind it and the
        // exit has something to be aimed at.
        { x: -240, z: -880, radius: 300, height: 150, kind: 'mesa' },
        // Over Digger's Elbow, at the far west end of the lap.
        { x: -1010, z: -260, radius: 280, height: 145, kind: 'mesa' },
        // A needle east of the climb, which is what the Kink and the Crest are
        // driven at. It used to stand in the middle of the ring — the old
        // layout had four hundred metres of empty desert in there — and this
        // one wraps tighter: the widest gap anywhere inside it is 118 metres,
        // and `terrain.ts` will not let a landform *start* rising until it is
        // `rimStart * 0.7` clear of the road. A hero placed in there would have
        // had its foot inside the barriers and its shape multiplied by zero.
        { x: 470, z: -110, radius: 130, height: 96, kind: 'spire' },
      ],
    },
  },

  theme: {
    // Hot terracotta. `theme.ground` is the far-field albedo *and* the ground
    // half of the hemisphere fill, so this is also why everything on this
    // circuit is lit warm from below — the opposite of the quarry, whose fill
    // is neutral rock flour, and of the mountain, whose fill is cold schist.
    ground: 0xcf8f4a,
    sky: { top: 0x2e86d6, bottom: 0xbfe7ff, horizon: 0xffd79a },
    // Thin haze: the mesas are the point of the horizon, and fog that reaches
    // them at 400m turns the canyon back into a khaki blur. Warm, and
    // deliberately so — it is the tell that separates this round from round two
    // at a glance, and round two's is a flat mineral grey.
    fog: { color: 0xe7c99c, near: 620, far: 2600 },
    sun: { color: 0xfff2d8, intensity: 2.6, azimuth: 0.7, elevation: 0.85 },
    // **A warm road, and that is a deliberate separation.** All four courses
    // once ran a base between #2B2D34 and #3A3D46, which a critic photographed
    // side by side and called indistinguishable — correctly. This one is the
    // warm one: a desert road laid on ironstone, brown in the shadows, against
    // the quarry's cold basalt, the saltpan's blue-black fresh bitumen and the
    // mountain's pale weathered grey.
    road: { base: '#4A403A', line: '#FFF8F0', edge: '#FFC300' },
    props: { canyon: true, cones: true, crowds: true },
  },
};

export default coneCanyon;
