// Course 4 — Switchback Summit.
//
// The one with a hill in it. Cone Canyon moves 29 metres up and down over a
// lap; this moves **116**, and it does it in one direction at a time: a
// 1.9-kilometre climb up the eastern face and a kilometre-long plunge back down
// the western one. Half the lap is spent looking up at road you have not driven
// yet, and the other half looking down at road you already have.
//
// It is also the only circuit in the cup that runs anticlockwise, so every
// corner loads the other side of the kart.
//
// **...and it is now actually a switchback road.** For two rounds this course
// was called Switchback Summit and had exactly one switchback in it. Fifteen
// corners, fourteen of them between 80 and 380 metres of radius, all taken flat
// — a fixed-seed autopilot lap of the whole field produced eighteen drifts and
// three purple mini-turbos, the worst numbers in the cup after the saltpan, and
// the longest slide anybody held was 1.38 seconds. The corner the critic
// singled out, the 380-metre "Summit Traverse" along the top, was doing what
// every other corner here was doing: nothing.
//
// A road that climbs 116 metres up a face does it in **hairpins**, because that
// is the only way a road gains height on a slope, and a hairpin is the corner
// this game's drift is built for. So the traverses are now joined by seven
// corners between 44 and 54 metres of radius, each holding one radius the whole
// way through — see `ring.ts` for why that last part is the whole fix.
//
//   T1  Culvert Kink      R539 left along the valley floor, flat
//   T2  Batter Kink       R195 left, still flat, still climbing nothing
//   T3  Foot of the Climb R48, 110° — and the road tips up to 11%
//   T4  First Traverse    R52, 145° RIGHT, the only right on the way up
//   T5  Spur Entry        R130 left onto the promontory
//   T6  THE SPUR          R30 through 165° at the tip. 20m wide, and level
//   T7  Spur Exit         R54, 100° right, back onto the mountain
//   T8  Second Traverse   R222 left, climbing at 8%
//   T9  Shoulder Left     R46, 150° — the road pinned to the side of the hill
//   T10 The Col           R180, 100° right over the saddle
//   T11 SUMMIT TRAVERSE   R44, 175° and 134 metres of one radius along the top.
//                         The breather is now the purple corner
//   T12 THE RIDGE         the crest at 116m. The road goes light, the valley opens
//   T13 Cutting Sweep     R50, 155° right, falling at 17%
//   --- THE KICKER        24 metres of level shelf and a 3.6m lip, and then the
//                         mountain is not there any more
//   T14 Spillway Left     R170, the landing, with the washout on its exit
//   T15 Valley Sweep      R48, 120° at the bottom, and the brakes matter
//
// ── THE KICKER: round four's signature ─────────────────────────────────────
//
// **The only place in the cup a kart leaves the ground because somebody built
// it a ramp**, and the reason the noun had to exist at all.
//
// A critic measured this course against the other three and found that the one
// with 116 metres of climb and a 40% plunge in it produced **less airtime than
// the flat quarry** — 5.9% against 7.9% — and fired five `kart:launch` events
// in a whole race. Every metre of air on this mountain was an accident: a kart
// falling off the back of a gradient change, never a kart *aimed* at anything.
// `TrackFeatures` could express paint, material, a gravel cut and a gantry, and
// nothing whatsoever that took a kart off the ground on purpose.
//
// Eighty metres out of the Cutting Sweep are now a run-in, a shelf and a gap.
// The shelf is the trick and it is a *negative* number — the road stops
// descending for twenty-four metres — because you cannot launch a kart off a
// road that is already pointing at the ground. Then 3.6 metres of lip, and then
// the west face falls at 63%.
//
// Measured on the built spline: the road climbs to **+24.7%** at the lip,
// crests at 2631m and 82.4 metres of altitude, and is at **-62.8%** nine
// metres later. A kart arrives at fifty metres a second, cannot follow a crest
// tighter than `v²/g` — 73 metres of radius — and leaves climbing at 11°. The
// ballistic arc against the road's own profile puts it back down **73 metres
// and 1.5 seconds later**, in the first third of the Spillway.
//
// Across a race that took the field from 12 landed tricks to **36**, tier-3
// mini-turbos from 80 to 100, and the longest single flight anybody holds from
// 1.28 to 1.73 seconds. See `RAMPS` below, `ramp.ts` for the profile and why it
// is not a smoothstep, and `RampDef` for why the shape has to live in the
// centreline rather than in a wedge of mesh.
//
// **Four set pieces.**
//
// *The Spur* is a level out-and-back onto a rock promontory two thirds of the
// way up. It is the tightest corner on the circuit (30m radius, 20m of road)
// and it is deliberately the one place on the climb where the road stops
// climbing — you arrive with no speed, you leave with no speed, and the hundred
// metres either side of it are the same height to within a metre. That is not
// decoration: the embankment either side of a road is anchored to *that* road's
// elevation, so two legs of a switchback that pass within sixty metres of each
// other at different heights bury the lower one. Level legs are what makes a
// switchback buildable here at all.
//
// *Summit Traverse* is the new one and it is the answer to the round's verdict.
// A hundred and thirty-four metres of 44-metre radius held flat along the top
// of the mountain at 107 metres, with nothing either side of it — the longest
// single sustained drift in the cup, on the highest road in the game, on the
// last corner before the crest.
//
// *The Ridge* is that crest, at 116m — the highest point in the game. The road
// curves over it at about 12 milliradians per metre, which at the speed you
// arrive is most of the kart's weight taken off the wheels in a car's length.
// It goes light, the camera lifts, and the whole west face appears at once.
// Sharper and it would be a jump; this is a brow, and a brow is scarier.
//
// Width follows speed, and here it follows *gradient* too: 28-30m on the valley
// floor where the karts are flat out, 24-26m on the traverses, 20m at the Spur,
// and 23m across the kicker's deck — a road that pinches into a ramp and opens
// out behind it, because a take-off you do not have to aim at is a bump. The
// longest dead straight on the lap is 130 metres.
//
// ── the look, and why the numbers below are what they are ──────────────────
//
// A critic once photographed this course and read it as "a works yard on a
// green hill next to a meringue". Both halves of that were the course's own
// fault, because `render/theme.ts` paints the alpine surface off two things a
// *course* supplies: `theme.ground`, and how high the land stands relative to
// the nearest road (`rel`).
//
//   * **The meringue.** The snow ramp runs from about `rel` 35 to `rel` 135.
//     `rimHeight` was 200, which puts the *whole* rim above the ramp before it
//     starts, so every ridge came back one flat blue-white with no snowline and
//     no rock under it. The rim is 95: `plateau * terrace * erosion` spreads
//     that across `rel` 2 to 115, which lands the ramp on the land itself.
//   * **The green hill.** The far field settles onto `groundY`, and `groundY`
//     was -35 — thirty-five metres *below* the valley-floor road, which is
//     exactly the band `alpine.paint` reads as tussock. The plain is level with
//     the valley floor now, which is what a valley floor is.
//   * **The warm tan.** `theme.ground` was a warm olive-tan, and it is both the
//     far-field albedo *and* (via `sunRig`) the colour of the bounce light on
//     every object in the game. It is cold blue-grey schist now.

import { loopFromWaypoints } from './path.ts';
import { applyRamps } from './ramp.ts';
import { ring } from './ring.ts';
import type { CourseDefEx, RampDef } from './types.ts';

/**
 * The ring, driven from the valley floor at (-309, -314).
 *
 * Positive turns go left, which is most of them: this is the anticlockwise one.
 * `y` is the elevation the road reaches by the end of each segment, so the
 * ledger below reads as the climb it is — 0.8 on the floor, 55 level across the
 * Spur, 116 on the Ridge, and back to 2 in the valley.
 */
const RING = ring(
  { x: -309, z: -314, heading: -16.2, y: 0.6, width: 27 },
  [
    { run: 55, width: 28, y: 0.8, name: 'm0' },
    { radius: 539, turn: 20, width: 29, y: 1.5, name: 'T1 CULVERT KINK' },
    { run: 75, width: 29, y: 3, name: 'm1' },
    { radius: 195, turn: 12, width: 30, y: 5, name: 'T2 BATTER KINK' },
    { run: 55, width: 28, y: 9, name: 'm2' },
    { radius: 48, turn: 110, width: 26, y: 15, name: 'T3 FOOT OF THE CLIMB' },
    { run: 90, width: 26, y: 22, name: 'm3' },
    { radius: 52, turn: -145, width: 25, y: 31, name: 'T4 FIRST TRAVERSE' },
    { run: 40, width: 24, y: 42, name: 'm4' },
    { radius: 130, turn: 30, width: 22, y: 50, name: 'T5 SPUR ENTRY' },
    // The Spur, and the hundred metres either side of it, are level on purpose.
    { run: 35, width: 20, y: 54.5, name: 'm5' },
    { radius: 30, turn: 165, width: 20, y: 55, name: 'T6 THE SPUR' },
    { run: 35, width: 21, y: 55.5, name: 'm6' },
    { radius: 54, turn: -100, width: 22, y: 58, name: 'T7 SPUR EXIT' },
    { run: 90, width: 24, y: 64, name: 'm7' },
    { radius: 222, turn: 24, width: 24, y: 70, name: 'T8 SECOND TRAVERSE' },
    { run: 115, width: 25, y: 78, name: 'm8' },
    { radius: 46, turn: 150, width: 24, y: 84, name: 'T9 SHOULDER LEFT' },
    { run: 125, width: 25, y: 94, name: 'm9' },
    { radius: 180, turn: -100, width: 25, y: 101, name: 'T10 THE COL' },
    { run: 130, width: 26, y: 104, name: 'm10' },
    // The finale's purple corner. 134 metres of 44-metre radius at 107m of
    // altitude, and the reason this course stopped being the flattest-driving
    // circuit in the cup on the one instrument that matters.
    { radius: 44, turn: 175, width: 25, y: 107, name: 'T11 SUMMIT TRAVERSE' },
    { run: 65, width: 26, y: 112, name: 'm11' },
    { radius: 240, turn: 24, width: 26, y: 116, name: 'T12 THE RIDGE' },
    { run: 65, width: 27, y: 103, name: 'm12' },
    { radius: 50, turn: -155, width: 26, y: 88, name: 'T13 CUTTING SWEEP' },
    // ── THE KICKER ────────────────────────────────────────────────────────
    // The eighty metres out of the Cutting Sweep used to be one straight
    // falling at 25%. It is now a run-in, a **shelf**, and a gap.
    //
    // The shelf is the whole trick, and it is a negative number: the road stops
    // descending for twenty-four metres. That is what a take-off is — you
    // cannot launch a kart off a road that is already pointing at the ground,
    // and the lip itself (2.8m of it, applied to the waypoints by `applyRamps`)
    // only works because it sits on something level. The 23m width is the
    // aiming mark: the road pinches into the deck and opens out behind it.
    //
    // Then the mountain goes. `m13b` drops 11.4 metres in 32, peaking past 50%,
    // which is not a road a kart can follow at fifty metres a second — and is
    // not meant to be. It is the gap. The landing is the first twenty metres of
    // the Spillway, a 170-metre sweeper wide enough to come down sideways in.
    //
    // Note the floors: `ring.ts` refuses a straight shorter than 20 metres
    // after closure, which is the right rule and the reason the shelf is 24
    // rather than the 18 it wants to be.
    { run: 24, width: 27, y: 80, name: 'm13' },
    { run: 24, width: 23, y: 79.4, name: 'THE KICKER' },
    { run: 32, width: 28, y: 68, name: 'm13b' },
    { radius: 170, turn: 30, width: 29, y: 52, name: 'T14 SPILLWAY LEFT' },
    { run: 105, width: 28, y: 26, name: 'm14' },
    { radius: 48, turn: 120, width: 27, y: 12, name: 'T15 VALLEY SWEEP' },
    { run: 55, width: 27, y: 2, name: 'm15' },
  ],
  { step: 15 },
);

/** Metres from the ring's origin to the start/finish line. */
const START = 0;
const on = (name: string, along = 0.5): number =>
  ((RING.distanceAlong(name, along) - START) / RING.length + 1) % 1;

/**
 * **The signature, and the only one of its kind in the cup.**
 *
 * The lip sits on the last metre of the shelf — `on('THE KICKER', 1)` — with
 * twenty-two metres of deck behind it and 2.8 metres of rise across them,
 * which is a run-up slope of `2 × 2.8 / 22` = 25% at the lip and zero at its
 * foot. See `ramp.ts` for why the maximum has to be at the *top*: an eased
 * hands the kart a level road at exactly the instant it should be pointing at
 * the sky, and `kart:launch` wants 3 m/s along the ground normal, which a crest
 * cannot give you and this can.
 *
 * This array is read twice. `applyRamps` below puts the deck into the
 * centreline, which is the only place kart physics can feel it — it rebuilds
 * the ground from the spline and never looks at a triangle. `buildRoad` reads
 * the same array to paint the chevrons and the lip bar onto it. There is no
 * second copy of the shape.
 */
const RAMPS: RampDef[] = [
  { at: on('THE KICKER', 1), length: 22, lip: 3.6, fall: 0.30, width: 15 },
];

export const switchbackSummit: CourseDefEx = {
  id: 'switchback-summit',
  name: 'Switchback Summit',
  cup: 'hazard',
  points: loopFromWaypoints(applyRamps(RING.waypoints, RAMPS, {
    length: RING.length, startDistance: START,
  }), {
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
  // The plain the valley-floor road runs across, and nothing more ambitious
  // than that. It used to be -35, on the reasoning that a datum below the start
  // straight gives the climb something to be measured against — but the climb
  // is measured against the *road*, which gains 116m either way, and the only
  // thing the low datum bought was a kilometre of far field sitting five to
  // thirty metres under the nearest tarmac, which is the exact band
  // `alpine.paint` reads as tussock. That is where the pasture green came from.
  groundY: 4,
  startDistance: START,
  checkpoints: 36,

  features: {
    // **Five strips, every one of them on the way up, none on the way down.**
    // That asymmetry is the lap structure here, and it is the opposite of Cone
    // Canyon's — where the strips are the reward for a clean corner, these are
    // compensation for a gradient. Climbing at 8-11% costs roughly a fifth of
    // the kart's acceleration, so a pad halfway up a traverse is worth twice
    // what the same pad is worth on the flat; the descent is 17% downhill and
    // has more speed than anybody can use already.
    pads: [
      { at: on('m3', 0.45), lateral: 0.30, width: 6, length: 20 },
      { at: on('m7', 0.45), lateral: -0.30, width: 6, length: 20 },
      { at: on('m8', 0.40), lateral: 0.28, width: 6, length: 18 },
      { at: on('m9', 0.40), lateral: 0.30, width: 6, length: 20 },
      { at: on('m10', 0.40), lateral: -0.28, width: 6, length: 20 },
    ],
    // Across the inside of the Spur. The cut is laid on the gravel shoulder, so
    // it holds you to 70% of top speed while saving the tip of the promontory —
    // worth it out of a mini-turbo, and free with a mushroom in the slot.
    // `side: 1` is the driver's left, which is the apex of this left-hander.
    shortcuts: [{ from: on('T6 THE SPUR', 0.1), to: on('T6 THE SPUR', 0.9), side: 1 }],
    // **The washout, in the Spillway.** Half the road on the fastest part of
    // the descent is under the scree that comes off the cutting above it — you
    // arrive at 17% downhill and have to decide whether to give up the inside
    // line or take the loose stuff. It is the only place in the cup where a
    // corner is *narrowed by its surface* rather than by its barriers. See
    // `SurfacePatchDef` for the lateral frame; this is the uphill (left) half
    // of the road, which is also the geometrically quick side.
    //
    // Cold grey schist, the same rock the cutting above it is made of, so it
    // reads as something that fell rather than as something that was painted.
    // **The kicker.** See `RAMPS` above and `ramp.ts`; the deck itself is in
    // the centreline, and this is what paints it.
    ramps: RAMPS,
    // The washout has been moved down the hill and out of the landing zone,
    // and the numbers are measured rather than guessed. A kart leaves the lip
    // at 2631m climbing at 11°, and the ballistic arc against the road's own
    // profile puts it back down about **73 metres later**, at 2700m — which was
    // four metres inside the old leading edge of the scree. Landing at fifty
    // metres a second on loose rock is not a decision, it is a coin toss, and
    // the entire point of a jump is that you get to aim it.
    //
    // So the scree now sits in the last third of the Spillway, thirty-five
    // metres of it across the outer quarter of the road, and it is deliberately
    // a *smaller* hazard than it was. Measured: the first attempt put it across
    // 60% of the road from the corner exit onto the straight below, and the
    // field's time on loose surfaces went from 14% of the race to 29% while
    // mean speed fell from 51.8 to 44.5 m/s. A mountain with a launch ramp on
    // it does not also need the biggest surface hazard in the cup a second
    // later; one set piece per hundred metres, and this hundred metres already
    // has one.
    patches: [
      {
        from: on('T14 SPILLWAY LEFT', 0.62), to: on('T14 SPILLWAY LEFT', 0.99),
        latFrom: 0.46, latTo: 1, surface: 'dirt', tint: '#9AA2B4',
      },
    ],
    // Seven corners here run 1/44 to 1/54 of curvature and the traverses 1/130
    // to 1/539, so a threshold at 1/85 kerbs the switchbacks and leaves the
    // fast road along the face unmarked.
    kerbCurvature: 0.0118,

    // ── the mountain ──────────────────────────────────────────────────────
    //
    // Sized against the snow ramp in `render/theme.ts`, which runs from roughly
    // `rel` 35 to `rel` 135 above the nearest road. **Every number here is
    // chosen so that the land crosses that ramp rather than starting above it.**
    // At 95 the rim spreads from `rel` 2 to 115: grey schist near the circuit,
    // the snowline arriving about five hundred metres out, white only past
    // that. The line moves *with the distance from the road*, which is the one
    // thing that reads as altitude from inside a kart.
    //
    // The heroes are sized the same way. The bottom fifth of any landform is
    // hidden behind the embankment and the barrier, so a peak whose rock band
    // lives down there has no rock band at all as far as a player is concerned.
    // The near ones are therefore 100-145m — their visible middle is scree,
    // their top quarter is snow — and only the far ones, seen through a
    // kilometre of aerial perspective and which *should* be white, are allowed
    // to stand clear of the ramp entirely.
    //
    // `rimStart` is also what holds the landscape off the 50-160m band the
    // world module fills with `room()` — conveyors, berms, parked plant — which
    // tests whether a spot is free and not whether it is level. Nothing steep
    // may begin inside it, which is why the rim waits until 180m and the hero
    // gate (`rimStart * 0.7` to `rimStart * 1.5`) does not open until 126.
    terrain: {
      rimStart: 180,
      rimEnd: 620,
      rimHeight: 95,
      landmarks: [
        // A rock tooth outside the Foot of the Climb — the near landmark the
        // first traverse is aimed at, and the one place on this course you see
        // exposed schist at eye level instead of on a skyline.
        { x: 610, z: -520, radius: 195, height: 105, kind: 'spire' },
        // The bluff on the outside of the Cutting Sweep, so the descent has a
        // wall on it rather than open air on both sides.
        { x: -790, z: 250, radius: 250, height: 100, kind: 'mesa' },
        // The far side of the valley, seen from the whole descent.
        { x: -1180, z: 520, radius: 430, height: 200, kind: 'mesa' },
        // Behind the Spur, so the promontory has something to be a promontory
        // in front of.
        { x: 1150, z: 120, radius: 380, height: 185, kind: 'mesa' },
        // A needle past the Col, on the skyline of the climb.
        { x: 180, z: 1080, radius: 260, height: 215, kind: 'spire' },
      ],
    },
  },

  theme: {
    // **Cold schist, and it has to be declared cold.** `theme.ground` is not
    // only the far-field albedo: `sunRig()` turns it into the ground half of
    // the hemisphere fill, so it is the colour of the light bouncing back up
    // onto every kart, cone and barrier on the circuit.
    //
    // The exact value is solved backwards rather than picked. `alpine.paint`
    // lays `ALPINE_TURF` (0x67704a — a properly saturated pasture green) over
    // the base at about 45% for every metre of ground that sits below the
    // nearest road, which is *all* of the 26m embankment band and most of what
    // a chase camera can see. So what a player looks at is not this colour, it
    // is `0.55 * this + 0.45 * turf`, and the only way that mix comes back as
    // dry alpine grey-green is if the declared colour leans the other way. At
    // 0x9490a8 the mix lands on roughly rgb(126,128,121): neutral, with the
    // green left in it as a tint rather than as the subject.
    ground: 0x9490a8,
    // Altitude: the zenith goes almost navy and the horizon goes to a cold
    // white. Nothing else in the cup has a sky this dark at the top.
    sky: { top: 0x0a3a9a, bottom: 0xc6e2f8, horizon: 0xf2f9ff },
    // Cool, deep aerial perspective. The far ridges have to grey out or the
    // 250m peaks read as cardboard cut-outs stood behind the track.
    fog: { color: 0xbdd6ec, near: 440, far: 3000 },
    // Morning, and low: the elevation is clamped to the house band by
    // `sunRig()`, so the only thing a course really controls is *where* the
    // light comes from. This one rakes across the traverses from the west,
    // which is a quarter turn away from the quarry's and a half from the
    // canyon's — four courses, four shadow directions.
    sun: { color: 0xfff4e6, intensity: 2.85, azimuth: 5.25, elevation: 0.55 },
    // **The pale one, and it is the only pale road in the game.** A mountain
    // pass is not fresh bitumen: it is weathered chipseal that has had thirty
    // winters of grit and salt on it, and going *up* in value is the one
    // direction none of the other three can go. White edge marking, because a
    // mountain road is kerbed in paint and snow poles, not in hazard yellow.
    road: { base: '#6B7383', line: '#FFF8F0', edge: '#FFF8F0' },
    props: {
      alpine: true, cones: true, crowds: true,
      snowPoles: true, pines: true, avalancheFence: true,
    },
  },
};

export default switchbackSummit;
