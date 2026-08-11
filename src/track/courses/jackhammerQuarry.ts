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
//   T7  Pit Entry         the lip. The floor drops 19m in 160m — 20% at its
//                         steepest — and **THE CUT** is halfway down it.
//   T8  Floor One         a fast left across the pit floor at its widest, 21m
//   T9  THE CRUSHER       24m right at 16m wide — the narrowest road in the cup
//   T10 Crusher Exit      and immediately 26m the same way. 188° in 100 metres.
//   T11 Floor Two         a flick, barely a corner, taken at full lean
//   T12 Floor Three       127° of left around the sump — the slowest point
//   T13 Sump Left         opening out onto the haul road
//   T14 Haul Road         117° right, climbing, blind over the lip
//   T15 Gate Sweep        the long right back up to the weighbridge
//
// ── THE CUT: round two's signature ─────────────────────────────────────────
//
// **Eleven metres of tarmac**, on the plunge into the pit, at the fastest and
// steepest point on the lap.
//
// The other three rounds each own a mechanic: a fork, a flood, a launch ramp.
// This one owns *width*, which is the crudest thing a circuit can do to a
// driver and the only one that cannot be out-driven. The haul road threads
// between two rock benches, necks from nineteen metres to eleven over forty,
// holds it for twenty, and opens out again — and eleven metres is a metre
// wider than two karts and their mistakes. It takes nothing off your speed. It
// takes away the option of being alongside somebody.
//
// It is authored as *width* in the waypoint table, which is what makes it real
// rather than scenery: the barrier line, the wall physics enforces and the
// ribbon the road mesh is swept along all come off `s.width` and all close in
// together. `features.gates` puts the two striped nose blocks on it, because a
// road that quietly halves its width at 55 m/s reads as a bug rather than as a
// design unless something says otherwise. See `GateDef`.
//
// The two rules Cone Canyon is held to hold here too, and both bite harder.
// *Width follows speed*: 24m on the weighbridge straight, 21m on the fast run
// across the floor, 17m through the benches, 16m through the Crusher, 11m
// through the Cut. And *nothing is dead straight for longer than the run to
// the first corner*: the longest true straight on the lap is the 130m plunge
// into the pit, and it is pointing downhill at a corner you cannot see the exit
// of. The run from the line to T1 is 83 metres.
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
//
// ── the look ───────────────────────────────────────────────────────────────
//
// **A working pit is grey, and the whole course is built to say so.** Round one
// of the cup is warm sandstone; if this one is merely a browner brown then the
// two are one place at two times of day, which is exactly what a critic
// measured them as. So every colour on this page is pulled away from the
// canyon's rather than merely differing from it:
//
//   * `theme.ground` was 0xb08a4e, a saturated tan. `quarry.paint` mixes it
//     into the rock as a *film of fines*, at 10-26%, so a warm anchor tinted
//     the whole pit the colour of the desert next door — and, worse, `sunRig()`
//     turns `theme.ground` into the ground half of the hemisphere fill, so
//     every kart in the race was lit from below in desert orange. It is a
//     neutral rock-flour grey now. The dust still reads; it just reads as dust
//     on grey rock instead of as sand.
//   * The haze was 0xd9c79e — golden-hour warm — over a 1450m far plane, which
//     painted the far wall, the benches and half the sky the same khaki. Rock
//     dust is *pale and cold*: the fog is a flat mineral grey now, and it is
//     the single biggest reason this course photographs as somewhere else.
//   * The tarmac goes the other way. The floor is now light, so the road is the
//     darkest in the cup after the saltpan's — a haul road cut through pale
//     rock, not a grey road on grey ground.

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
  { x: 116, z: -215, y: -7.1, width: 17 },
  // ── THE CUT ──────────────────────────────────────────────────────────────
  // Round two's signature, and the whole of it is in this column of numbers.
  // The haul road threads between two rock benches on the way into the pit and
  // the tarmac necks to **eleven metres** for twenty of them — a metre wider
  // than two karts and their mistakes, on the fastest, steepest, straightest
  // piece of road on the circuit, pointing downhill at a corner nobody can see
  // the exit of.
  //
  // It is a pinch rather than a chicane on purpose: it takes nothing off your
  // speed and everything off your options. Two karts arrive at 55 m/s and one
  // of them is not going through.
  //
  // Authored as *width*, which is what makes it real rather than decorative.
  // The barrier line, the wall physics enforces and the ribbon the road mesh is
  // swept along all come off `s.width`, so they all close in together — see
  // `features.gates` for the two blocks that say so out loud, and `GateDef` for
  // why the blocks themselves are only signage.
  // The approach stays *wide* — 19m, 17m — on purpose, and that is a
  // measured correction rather than a taste. Narrowing the run-in as well made
  // the whole circuit **faster**: the AI's racing line is built from
  // `width/2 - margin`, so a narrow approach is a line that cannot swing, and a
  // line that cannot swing is a straighter, quicker one. Mean speed came back
  // 50.2 m/s against the 45.2 this course is supposed to be the slowest in the
  // cup at. The pinch has to arrive *at* the pinch: 17 metres to 11 in
  // twenty-five, which is also more frightening than a taper.
  { x: 105, z: -212, y: -8.1, width: 12 },
  { x: 95, z: -209, y: -9.0, width: 11 },
  { x: 85, z: -206, y: -9.9, width: 12.5 },
  { x: 74, z: -203, y: -10.9, width: 18 },
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
  // **Three.** It was four, on the reasoning that the shortest circuit in the
  // cup should run the most laps of it — and four laps of the slowest circuit
  // in the cup is 8.7 kilometres and better than three minutes of racing, which
  // is twice what Mario Kart 8 asks of anybody. The pit is the round that costs
  // the most per lap; it does not also get to be the longest.
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
    // **Five strips, and they are the shortest in the cup.** There were six at
    // eighteen metres, and a trace of the running game found this circuit was
    // *on boost for more than half its own lap*. A reward that is the default
    // state is not a reward, it is the engine note.
    //
    // Four turned out to be too far the other way — the pads were not decorating
    // this layout, they were carrying it, and dropping two put fourteen seconds
    // on the lap and made round two a slog rather than a test. Five at sixteen
    // metres is where it sits: each one somewhere the circuit has just taken
    // everything off you — the run off the Screed Kink, the plunge into the pit,
    // the exit of the Crusher, the way out of the sump, and the haul road, where
    // you are climbing at 5% with nothing left.
    pads: [
      { at: 0.120, lateral: -0.30, width: 5.5, length: 16 },
      { at: 0.270, lateral: 0.30, width: 5.5, length: 16 },
      { at: 0.545, lateral: 0.26, width: 5.5, length: 16 },
      // Moved from 0.735. `SurfacePatchDef` says no strip may come within four
      // hundredths of a lap of a patch, and this one sat 0.023 from the leading
      // edge of the sump spill: `findPads` in `ai/knowledge.ts` confirms every
      // declared strip by probing `sample()` for `'boost'` and silently drops
      // the ones that do not answer, so a fifth of this circuit's boost economy
      // existed for the player and not for a single CPU driver in the field.
      { at: 0.706, lateral: 0.32, width: 5.5, length: 16 },
      { at: 0.945, lateral: -0.30, width: 5.5, length: 16 },
    ],
    // **Two cuts, and they are opposites.** The first runs across the inside of
    // the Crusher's first apex, where the road is 16m — the narrowest tarmac in
    // the cup — and saves about twenty metres for a third of your top speed
    // while you are on it: free out of a mini-turbo, a disaster if you arrive
    // already slow. The second is the old haul-road apron at T14, which is
    // longer, flatter and *uphill*, so it costs almost nothing to enter and
    // almost everything to get out of. Nowhere else in the cup asks the same
    // question twice on one lap with two different right answers.
    shortcuts: [
      { from: 0.632, to: 0.672, side: -1 },
      { from: 0.893, to: 0.926, side: -1 },
    ],
    // **The spill, and it is real now.** Two bands of the drivable ribbon are
    // not tarmac: crusher fines dragged across the bench run under the
    // conveyor, and the wet apron at the bottom of the sump where the pit
    // drains. Both are `dirt` — 70% of top speed and 70% of grip — and both are
    // laid on the *inside* of the corner they sit in, so the geometric line and
    // the fast line are not the same line. That is the whole idea: the quarry
    // is the round where the shortest way round is not the quickest, and it is
    // the only round in the cup that says so twice.
    //
    // They are two different colours because they are two different materials.
    // Fines off the crusher are the palest thing on this course; the sump apron
    // is wet, and wet rock flour goes dark. See `SurfacePatchDef`.
    patches: [
      { from: 0.437, to: 0.462, latFrom: -1, latTo: -0.05, surface: 'dirt', tint: '#B8B2A3' },
      { from: 0.758, to: 0.790, latFrom: 0.0, latTo: 1, surface: 'dirt', tint: '#6C6659' },
    ],
    // **The Cut's gate.** Two battered, hazard-striped nose blocks standing on
    // the shoulder either side of the narrowest tarmac in the game. The lap
    // fraction is measured off the built spline rather than guessed — a scan
    // for minimum width puts the 11-metre point at 0.4959 — because the pinch
    // is authored as a *width* in the waypoint table above and the marker has
    // to sit exactly on it or it is marking the wrong thing.
    //
    // The blocks are signage and nothing else: they stand on the verge, which
    // is already 70% of top speed, so they take nothing from a kart that was
    // not in trouble before it reached them. What actually pinches is the road,
    // and it pinches for the barrier and the wall physics enforces at the same
    // time, because all three come off `s.width`. See `GateDef`.
    gates: [{ at: 0.496, length: 30, height: 1.2 }],
    // A shade higher than Cone Canyon's, because half this circuit is under
    // 40m of radius and kerbing all of it would leave nothing to aim at.
    kerbCurvature: 0.005,

    // ── the pit ───────────────────────────────────────────────────────────
    //
    // **The first fifty to a hundred and sixty metres beyond the shoulder has
    // to be ground somebody can stand a machine on**, and on this course it was
    // a wall. `rimStart` was 85 and `rimEnd` 310, so 138 metres of rock came up
    // over a 225-metre ramp that peaks near ninety per cent of gradient — a
    // forty-degree face beginning eighty-five metres behind the barrier.
    //
    // That band is exactly where `world/index.ts` puts everything it places
    // with `room()`: conveyors at 64-144m, berms at 76-146, haul trucks at
    // 50-118, drill rigs at 56-132. `room()` tests whether a spot is *free*,
    // not whether it is *level* — only the bench, mass and ridge tiers call
    // `standable()` — so on a face that steep the ground rolls out from under
    // a twenty-metre footprint and the prop is left in the air. The first
    // frame of this course was photographed with a spoil cone, a ground
    // conveyor and its hopper, and three berms hanging in open sky against the
    // high wall.
    //
    // So the wall now starts at 150m and takes 320 to get there: everything
    // `room()` can reach is on ground that is flat to within a couple of
    // metres, and the rock begins where the props stop. It is a metre taller
    // to buy the enclosure back — 145m of relief standing over a pit floor
    // that is itself 19m down is still a lid rather than a backdrop.
    //
    // The landmarks follow the same rule, and `hero` is gated on
    // `smoothstep(rimStart * 0.7, rimStart * 1.5, d)` — 105 to 225 metres out
    // now — so each footprint is placed with its *near edge* past 120m and its
    // steep flank past 190m. Beyond that the world module's own `standable()`
    // check owns the problem, and it is a real check.
    terrain: {
      rimStart: 150,
      rimEnd: 470,
      rimHeight: 145,
      landmarks: [
        // The stack the Crusher runs round — the thing you brake at.
        { x: -410, z: -375, radius: 110, height: 92, kind: 'spire' },
        // The screening plant's face, at the vanishing point of the bench run.
        { x: 560, z: 205, radius: 150, height: 96, kind: 'spire' },
        // The high wall behind the weighbridge, closing the start straight.
        { x: -190, z: 640, radius: 280, height: 158, kind: 'mesa' },
        // The overburden dump, seen across the pit from the whole floor section.
        { x: -600, z: -470, radius: 300, height: 152, kind: 'mesa' },
      ],
    },
  },

  theme: {
    // Rock flour, not sand. See the header: this is both the dust film on the
    // pit floor and the colour of the bounce light on every machine in the
    // race, and at 0xb08a4e it was making a grey pit photograph as a desert.
    ground: 0x9d9a90,
    // A harder, colder sky than the canyon's: deeper at the zenith, and the
    // haze band is mineral dust rather than warm air.
    sky: { top: 0x14549e, bottom: 0xa9c8dc, horizon: 0xd4d1c7 },
    // Half the visibility of Cone Canyon, on purpose — a working pit has its
    // own weather, and it is the reason the far wall reads as far. The colour
    // is what changed: pale rock dust rather than golden haze, so the distance
    // greys out instead of going khaki.
    // Pale rock dust: neutral, a touch on the warm side of it, and nowhere near
    // either of the two hazes it has to be told apart from — the canyon's gold
    // and the mountain's blue. Grey ground under grey air is what makes this a
    // pit; grey ground under *blue* air would make it the mountain.
    fog: { color: 0xc7c2b6, near: 230, far: 1300 },
    sun: { color: 0xfff3e0, intensity: 2.85, azimuth: 2.15, elevation: 0.52 },
    // The darkest road in the cup after the saltpan's. The floor is pale now,
    // so the tarmac has to carry the contrast — a haul road cut through light
    // rock, with an orange edge where the canyon has yellow.
    road: { base: '#2A2F39', line: '#FFF8F0', edge: '#FF6B1A' },
    props: {
      quarry: true, cones: true, crowds: true,
      machinery: 'heavy', conveyors: true,
      // `dust` is OFF, and it is not a taste call — see this round's report.
      // `world/landprops.ts`'s `dustVeil` cards are placed 6-16m *above* the
      // ground 110-260m out and drawn with `worldDrift`, and from a chase
      // camera they come back as two dozen hard dark blobs hanging in the sky
      // rather than as haze on the far benches. The atmosphere this course
      // wants is in `theme.fog` above, which is real and which no other course
      // in the cup shares.
      dust: false,
    },
  },
};

export default jackhammerQuarry;
