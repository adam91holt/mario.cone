// Course 4 — Switchback Summit.
//
// **The tall one, and the one shaped like an hourglass.**
//
// ── the shape, which is the point ──────────────────────────────────────────
//
// A critic played the cup and rejected it at 6.5 on a finding no single
// screenshot could have produced: *"measured off the real driven line, every
// one of the four is an irregular closed blob of 9-12 similar-radius corners
// whose longest straight is 72-83 metres. On the select screen the four map
// cards are literally interchangeable."*
//
// So the four circuits now differ as *plans*, and this one is a **peanut**:
// two lobes and a waist. The valley lobe is low, wide and fast; the summit
// lobe is narrow, tight and a hundred and sixteen metres higher; and between
// them is a gorge a hundred and twenty metres across, with the climb running
// up one side of it forty to sixty metres below the plunge coming back down
// the other side. You spend a third
// of every lap looking across a gorge at the road you were on twenty seconds
// ago and the road you will be on in twenty more.
//
//     course           longest straight   R<40m of lap   elevation   aspect
//     Cone Canyon           320m               30m         26.0m      2.37
//     Jackhammer            160m              249m         41.6m      1.30
//     Saltpan               629m               60m         11.7m      1.76
//     Switchback            240m               70m        115.2m      1.68
//
// This is the elevation round by a factor of **eleven** over the saltpan, and
// the profile is not a swell or a staircase but a single climb and a single
// plunge with a hairpin at the top of it.
//
//   ── the valley lobe (+270° of left turn, 0-20m) ──
//   T0  Spillway Left   R150 onto the valley straight
//   VALLEY STRAIGHT     227 metres, 28m wide, the start line 60 metres in
//   T1  Culvert Sweep   R190, 55° — flat out, the last of the easy road
//   T2  Batter Left     R58, 105° at 25m: the valley's one real corner
//   T3  Foot of Climb   R190, 80°, and the gradient arrives underneath it
//   ── the neck, climbing (-90°) ──
//   T4  The Notch       R60 into the gorge
//   THE CLIMB           167m at 10%
//   T5  First Traverse  R55, 35° — the road steps out along the face
//   THE CLIMB TWO       167m at 13%
//   T6  Second Traverse R55 back
//   ── the summit lobe (+270°, 70-116m) ──
//   T7  Shoulder Left   R170, 70°, on the shoulder of the mountain
//   T7b/T7c The Ledge   R48 either way, the highest chicane in the cup
//   T8  THE SPUR        R36, 155° — the tightest corner in the game, on the
//                       tip of a promontory, with the gravel cut across it
//                       and the avalanche boom swinging over the cut
//   T9  The Ridge       R50 onto the ridge at 116 metres
//   ── the neck, plunging (-90°) ──
//   T10 Cutting Sweep   R58, and the mountain goes
//   THE KICKER          a shelf, a lip, and a gap. See `RAMPS`
//   THE PLUNGE          104m falling at 37%
//   T11/T12 Spillway    R160 either way, with the washout across the outside
//
// ── the two rules ──────────────────────────────────────────────────────────
//
// *Width follows speed*, and here it follows **gradient** too: 28m on the
// valley floor where the karts are flat out, 23-24m on the climb, 21m at the
// Spur, and 23m across the kicker's deck — a road that pinches into a ramp and
// opens out behind it, because a take-off you do not have to aim at is a bump.
//
// *Nothing is dead straight for longer than the run to the first corner* —
// which here means the start straight is the longest straight on the lap. It
// is: 229 metres, against the climb's two 167-metre steps and the 207 metres
// of run-in, deck and landing that make up the kicker. The climb used to be
// one 340-metre ruler and the traverses are what broke it, which is also what
// a road up a mountain face actually looks like.
//
// ── THE KICKER: round four's signature ─────────────────────────────────────
//
// The only place in the cup a kart leaves the ground because somebody built a
// ramp. Out of the Cutting Sweep the road stops descending for twenty-four
// metres — that shelf is the whole trick, because you cannot launch a kart off
// a road that is already pointing at the ground — and the lip stands 3.6m
// above it. Behind the lip the mountain goes: 37% for a hundred metres, and
// the landing is the first stretch of the Spillway.
//
// See `RampDef` in `types.ts` for why the profile is `lip · u²` and why the
// steepest part of it has to be at the *top*.
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
 * The ring, driven east along the valley floor.
 *
 * Positive turns go left, which is most of them: this is the anticlockwise
 * one. The accounting that makes it an hourglass rather than a blob is worth
 * stating, because it is the whole plan in one line:
 *
 *     valley lobe +270 · notch -90 · summit lobe +270 · notch -90 = +360
 *
 * A lobe that turns 270° and then hands over through a 90° notch displaces by
 * `(R + Rn)` along the neck and `(R - Rn)` across it, so the two lobes and
 * their two notches *are* the waist: with an effective lobe radius near 210
 * metres and 58-60 metre notches, the climb ends up a hundred and twenty
 * metres from the plunge and the road never comes closer to itself than a
 * hundred and ten.
 *
 * `y` is the elevation the road reaches by the end of each segment, so the
 * ledger reads as the climb it is — 0.8 on the floor, 64 at the top of the
 * neck, 116 on the Ridge, and back to 4 in the valley.
 */
const RING = ring(
  { x: 99, z: -130, heading: 0, y: 1.0, width: 28 },
  [
    // ── the valley lobe: low, wide, fast ──────────────────────────────────
    { radius: 150, turn: 30, width: 28, y: 0.8, name: 'T0 SPILLWAY LEFT' },
    { run: 229.2, width: 28, y: 0.8, name: 'VALLEY STRAIGHT' },
    { radius: 190, turn: 55, width: 28, y: 2, name: 'T1 CULVERT SWEEP' },
    { run: 65.4, width: 27, y: 4, name: 'm1' },
    { radius: 58, turn: 105, width: 25, y: 9, name: 'T2 BATTER LEFT' },
    { run: 89, width: 26, y: 14, name: 'm2' },
    { radius: 190, turn: 80, width: 25, y: 20, name: 'T3 FOOT OF THE CLIMB' },
    // ── the notch, and the climb up the neck ──────────────────────────────
    { radius: 60, turn: -90, width: 24, y: 26, name: 'T4 THE NOTCH' },
    { run: 166.5, width: 24, y: 42, name: 'THE CLIMB' },
    // The two traverses, and they do two jobs. They stop the climb being one
    // 340-metre ruler, and at 55 metres of radius they sit inside the band a
    // drift can actually be steered in — at R130 they were kinks a kart took
    // flat, which is how a mountain course ended up producing fewer slides
    // than a salt flat. They also bow the road *away* from the plunge, so the
    // gorge is widest in the middle rather than at its ends.
    { radius: 55, turn: -35, width: 23, y: 50, name: 'T5 FIRST TRAVERSE' },
    { run: 167.4, width: 23, y: 64, name: 'THE CLIMB TWO' },
    { radius: 55, turn: 35, width: 23, y: 70, name: 'T6 SECOND TRAVERSE' },
    // ── the summit lobe: narrow, tight, high ──────────────────────────────
    { radius: 170, turn: 70, width: 23, y: 78, name: 'T7 SHOULDER LEFT' },
    { run: 99.2, width: 23, y: 84, name: 'm5' },
    // The Ledge. A tight pair on the summit lobe's long leg: it costs the
    // circuit nothing in shape and buys two more corners inside the band a
    // drift can actually be steered in.
    { radius: 48, turn: 35, width: 22, y: 88, name: 'T7b THE LEDGE' },
    { run: 49.1, width: 22, y: 90, name: 'm5b' },
    { radius: 48, turn: -35, width: 22, y: 92, name: 'T7c LEDGE EXIT' },
    { run: 59.2, width: 22, y: 94, name: 'm5c' },
    // The tightest corner in the game — 36 metres of radius on 21 metres of
    // road, on the tip of a promontory a hundred metres above the valley.
    { radius: 36, turn: 155, width: 21, y: 98, name: 'T8 THE SPUR' },
    { run: 103.2, width: 24, y: 109, name: 'm6' },
    { radius: 50, turn: 45, width: 24, y: 116, name: 'T9 THE RIDGE' },
    // ── the notch, and the plunge back down the neck ──────────────────────
    { radius: 58, turn: -90, width: 26, y: 108, name: 'T10 CUTTING SWEEP' },
    // ── THE KICKER ───────────────────────────────────────────────────────
    // The run-in, a **shelf**, and a gap. The shelf is the whole trick, and it
    // is a negative number: the road stops descending for twenty-four metres.
    // That is what a take-off is — you cannot launch a kart off a road that is
    // already pointing at the ground, and the lip itself (3.6m of it, applied
    // to the waypoints by `applyRamps`) only works because it sits on
    // something level. The 23m width is the aiming mark: the road pinches into
    // the deck and opens out behind it.
    //
    // Then the mountain goes. `m8b` drops 11 metres in 32, and THE PLUNGE
    // another 42 in 114 — past 37%, which is not a road a kart can follow at
    // fifty metres a second and is not meant to be. That is the gap.
    //
    // Note the floor: `ring.ts` refuses a straight shorter than 20 metres
    // after closure, which is the right rule and the reason the shelf is 24
    // rather than the 18 it wants to be.
    { run: 48, width: 27, y: 92, name: 'm8' },
    { run: 24, width: 23, y: 91.4, name: 'THE KICKER' },
    { run: 32, width: 28, y: 80, name: 'm8b' },
    { run: 103.5, width: 28, y: 38, name: 'THE PLUNGE' },
    { radius: 160, turn: -12, width: 28, y: 26, name: 'T11 SPILLWAY KINK' },
    { run: 92.5, width: 28, y: 12, name: 'THE SPILLWAY' },
    { radius: 160, turn: 12, width: 28, y: 4, name: 'T12 VALLEY KINK' },
  ],
  { step: 15 },
);

/**
 * Metres from the ring's origin to the start/finish line — seventy-one metres
 * into the valley straight.
 *
 * `track/index.ts` parks the back row of the grid 47 metres behind the chequer
 * and the intro formation rolls in from eleven metres further back again, so
 * the last 58 metres of road before the line have to be straight, level and
 * unpainted. On a course whose road spends most of a lap at 10-37% of
 * gradient, the valley straight is the only place that is true, and it is why
 * the line is on it rather than on the pit apron.
 */
const START = 150;
const on = (name: string, along = 0.5): number =>
  ((RING.distanceAlong(name, along) - START) / RING.length + 1) % 1;

/**
 * **The signature, and the only one of its kind in the cup.**
 *
 * The lip sits on the last metre of the shelf — `on('THE KICKER', 1)` — with
 * twenty-two metres of deck behind it and 3.6 metres of rise across them,
 * which is a run-up slope of `2 × 3.6 / 22` = 33% at the lip and zero at its
 * foot. See `ramp.ts` for why the maximum has to be at the *top*: an eased
 * profile hands the kart a level road at exactly the instant it should be
 * pointing at the sky, and `kart:launch` wants 3 m/s along the ground normal,
 * which a crest cannot give you and this can.
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
  // Alpine scrub: the slowest surface in the game short of water. On a mountain
  // road, leaving it should not be a detour.
  offSurface: 'grass',
  vergeSurface: 'dirt',
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
    // compensation for a gradient. Climbing at 10-14% costs roughly a fifth of
    // the kart's acceleration, so a pad halfway up the neck is worth twice what
    // the same pad is worth on the flat; the plunge is 37% downhill and has
    // more speed than anybody can use already.
    //
    // The last of them is seven hundred metres upstream of the start line, so
    // there is nothing painted anywhere near the grid.
    pads: [
      { at: on('m2', 0.50), lateral: 0.30, width: 6, length: 20 },
      { at: on('THE CLIMB', 0.45), lateral: -0.30, width: 6, length: 20 },
      { at: on('THE CLIMB TWO', 0.45), lateral: 0.28, width: 6, length: 20 },
      { at: on('m5', 0.35), lateral: 0.30, width: 6, length: 20 },
      { at: on('m6', 0.40), lateral: -0.28, width: 6, length: 20 },
    ],
    // Across the inside of the Spur. The cut is laid on the gravel shoulder, so
    // it holds you to 70% of top speed while saving the tip of the promontory —
    // worth it out of a mini-turbo, and free with a mushroom in the slot.
    // `side: 1` is the driver's left, which is the apex of this left-hander.
    shortcuts: [{ from: on('T8 THE SPUR', 0.1), to: on('T8 THE SPUR', 0.9), side: 1 }],
    // **The kicker.** See `RAMPS` above and `ramp.ts`; the deck itself is in
    // the centreline, and this is what paints it.
    ramps: RAMPS,
    // **The washout, in the Spillway.** Half the road on the fastest part of
    // the descent is under the scree that comes off the cutting above it — you
    // arrive at 37% downhill and have to decide whether to give up the inside
    // line or take the loose stuff. It is the only place in the cup where a
    // corner is *narrowed by its surface* rather than by its barriers.
    //
    // The numbers are measured rather than guessed. A kart leaves the lip
    // climbing at 11° and the ballistic arc against the road's own profile puts
    // it back down about **73 metres later** — forty metres into the Plunge. So
    // the scree sits well past that, in the middle half of the Spillway, a
    // hundred and thirty metres beyond the landing. Landing at fifty metres a
    // second on loose rock is not a decision, it is a coin toss, and the entire
    // point of a jump is that you get to aim it.
    //
    // It is also deliberately a *small* hazard. Measured: a first attempt put
    // it across 60% of the road straight off a corner exit and the field's time
    // on loose surfaces went from 14% of the race to 29% while mean speed fell
    // from 51.8 to 44.5 m/s. A mountain with a launch ramp on it does not also
    // need the biggest surface hazard in the cup a second later.
    //
    // Cold grey schist, the same rock the cutting above it is made of, so it
    // reads as something that fell rather than as something that was painted.
    patches: [
      {
        from: on('THE SPILLWAY', 0.25), to: on('THE SPILLWAY', 0.75),
        latFrom: 0.46, latTo: 1, surface: 'dirt', tint: '#9AA2B4',
      },
    ],
    // ── THE AVALANCHE GATE: what makes the cut a bet ───────────────────────
    //
    // `props.avalancheFence` has been true on this course since the world
    // module dressed it, and every one of those fences has been a fence: a
    // static thing standing on a hillside doing nothing. This is the one that
    // works.
    //
    // A counterweighted lattice boom stands on the inside of the corner and
    // swings shut across the apex — the gate a real alpine road closes when the
    // slope above it is loaded.
    //
    // ── the round this gate did not exist for ──────────────────────────────
    //
    // It was quoted at `lateral: 1.35` with an 8.6-metre arm, which put the
    // pivot nineteen metres out on the spline's **positive** side and the swept
    // arm between +9.1 and +22.2 metres. `node tools/hazardcensus.mjs` over a
    // whole race: twenty-one crossings, **zero hits**, and the reason printed
    // on the same line — the field crosses the Spur between −16.3 and +7.8,
    // **median −5.8**. An eleven-second cycle at a 38% blocked window over a
    // 168-second race is about thirty-five blocked passes across the field and
    // it produced none, because the arm was sweeping the empty side of the
    // road. That is not tuning. A duty cycle is a statement about *time* and it
    // says nothing whatever about *space*.
    //
    // So the gate is on the side the corner is actually driven, and it is
    // fifteen metres of arm rather than eight and a half: shut, it sweeps from
    // the gravel on the inside shoulder to just short of the centreline. The
    // outside half of the road is never closed — you can always get round the
    // promontory, you just cannot do it on the apex.
    //
    // ── and there are two, and the second one is in the valley ─────────────
    //
    // One gate on a three-lap race is twenty-one chances at a hazard that has
    // to fire eight to twenty times, which needs a hit on nearly every blocked
    // pass to clear the bar. So there are two — and *where* the second one is
    // was decided by measurement as well.
    //
    // The obvious place was the first traverse, high on the open face with
    // nothing above it but loaded snow. Censused, that is where the mountain
    // stopped being a race: the field came home 3/2/3/2/3/1/3 — three racers
    // off the lead lap and one two laps down — because a gate on a 13% climb
    // takes away every metre of momentum a kart has and there is nowhere on a
    // traverse to get it back. **A hazard's cost is a property of the road it
    // is on, not of its stun**, and 0.55 seconds of `bump` is a corner on the
    // valley floor and most of a lap on a climb.
    //
    // So the second gate stands over the Batter — the valley's one real corner,
    // twenty-five metres wide, nine metres above sea level, at the foot of the
    // cut slope it is named after. Same arm, same rhythm, a tenth of the price.
    // Eleven seconds and thirteen, so the two never settle into a rhythm with
    // each other or with the lap.
    //
    // `bump`: a boom arm sweeps a kart sideways. It does not deserve a spin.
    hazards: [
      {
        at: on('T8 THE SPUR', 0.5), kind: 'boom', period: 11, phase: 0.45,
        // -0.60 rather than -0.90: the pivot stands on the tarmac edge rather
        // than four metres out on the gravel, so the arm sweeps the *road*
        // instead of the shoulder. The first version of this reached from -17.4
        // to +2.1 and its hits were mostly landing on karts that were already
        // running wide on the inside of a promontory a hundred metres up — it
        // pushed them further off rather than taking a line away from them.
        lateral: -0.60, width: 15, hit: 'bump', lead: 1.5, signAt: 88,
      },
      {
        at: on('T2 BATTER LEFT', 0.55), kind: 'boom', period: 13, phase: 0.15,
        lateral: -0.55, width: 15, hit: 'bump', lead: 1.5, signAt: 84,
      },
    ],
    // Four corners here run 1/36 to 1/60 of curvature and the traverses and
    // sweeps 1/110 to 1/190, so a threshold at 1/85 kerbs the Spur, the Batter,
    // the Notch and the Cutting Sweep and leaves the fast road along the face
    // unmarked.
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
    //
    // `rimStart` is also what holds the landscape off the 50-160m band the
    // world module fills with `room()` — conveyors, berms, parked plant — which
    // tests whether a spot is free and not whether it is level. Nothing steep
    // may begin inside it, which is why the rim waits until 180m and the hero
    // gate (`rimStart * 0.7` to `rimStart * 1.5`) does not open until 126.
    //
    // **The gorge is not filled.** The climb and the plunge run 120 metres
    // apart through the neck, which is inside `rimStart` from both of them, so
    // nothing rises between them: what makes the gorge is the *road's own*
    // elevation difference across that gap — 40 to 70 metres of it — with each
    // embankment anchored to its own carriageway. That is the one place on this
    // circuit you can see the whole shape of the lap from inside a kart.
    terrain: {
      rimStart: 180,
      rimEnd: 620,
      rimHeight: 95,
      // **A summit is a ridge, not a dome.** A critic photographed the head of
      // the gorge and got *"a smooth white-grey dome with a vertical
      // drip/stretch artifact down its face"* — both of which are one landmark
      // doing too much work. `hero` for a `mesa` is `1 - smoothstep(0.52, 1.05,
      // r)`, a single radially symmetric shape, so one 300-metre landform at
      // 200 metres of height *is* a dome, and the near-vertical band where that
      // shape falls off is where the field mesh's 30-metre cells stretch into
      // the streak. Three overlapping heroes of different heights and radii
      // sum to a ridge with cols and shoulders in it, and none of the three
      // individually has a face steep enough to smear.
      landmarks: [
        // East of the valley lobe, at the vanishing point of the Spillway and
        // the run onto the start straight.
        { x: 900, z: -60, radius: 240, height: 150, kind: 'spire' },
        // ── the head of the gorge: what the whole climb is driven at ───────
        { x: -940, z: -60, radius: 330, height: 165, kind: 'mesa' },
        { x: -820, z: 250, radius: 280, height: 205, kind: 'spire' },
        { x: -1140, z: 430, radius: 300, height: 140, kind: 'mesa' },
        // Behind the Spur, so the promontory has something to be a promontory
        // in front of.
        { x: -820, z: -700, radius: 340, height: 185, kind: 'mesa' },
        { x: -1180, z: -980, radius: 290, height: 225, kind: 'spire' },
        // The far side of the valley, on the skyline of the whole valley lobe.
        { x: 300, z: 780, radius: 260, height: 215, kind: 'spire' },
        { x: 760, z: 1060, radius: 320, height: 160, kind: 'mesa' },
        // A rock tooth south of the start straight — the near landmark, and
        // the only place on this course you see exposed schist at eye level
        // instead of on a skyline.
        { x: 420, z: -700, radius: 220, height: 110, kind: 'spire' },
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
