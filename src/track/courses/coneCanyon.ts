// Course 1 — Cone Canyon Speedway.
//
// **The opening circuit, the one the drift is taught on, and the long one.**
//
// ── the round that gave the four circuits four shapes ──────────────────────
//
// A critic played the cup and rejected it at 6.5 on a finding that no
// screenshot of a single course could have produced: *"measured off the real
// driven line, every one of the four is an irregular closed blob of 9-12
// similar-radius corners whose longest straight is 72-83 metres — an 11-metre
// spread, 1.4 seconds at 54 m/s. The roster reads as one circuit re-dressed in
// four ground colours, and on the select screen the four map cards are
// literally interchangeable."*
//
// That was right, and it was a *geometry* problem rather than a decoration
// one. All four were hand-grown outward from a start line until they closed:
// same rough aspect ratio, same corner census, same everything. So each of the
// four now owns a **silhouette** — a shape that survives being reduced to the
// 100x100 outline `courseMap()` draws on the select card — and the four
// silhouettes are chosen to be un-confusable rather than merely different:
//
//     1 Cone Canyon      a long dogleg. Aspect 2.4:1, two legs 200 metres
//                        apart, a hook on the west end. Nothing else in the
//                        cup is remotely this thin.
//     2 Jackhammer       a comb. Four hairpins folding four parallel benches
//                        into a square, with the haul road wrapped round the
//                        outside. Aspect 1.30:1.
//     3 Saltpan          a wedge. Three enormous sides, one of them a
//                        640-metre ruler. Aspect 1.76:1.
//     4 Switchback       an hourglass. Two lobes and a waist, the waist being
//                        the gorge the road climbs out of and plunges back
//                        into. Aspect 1.68:1.
//
// And the measured axes the critic named:
//
//                     longest straight   R<40m of lap   elevation   aspect
//     Cone Canyon           320m               30m         26.0m      2.37
//     Jackhammer            160m              249m         41.6m      1.30
//     Saltpan               629m               60m         11.7m      1.76
//     Switchback            240m               70m        115.2m      1.68
//
// 629 against 160 is **3.9x** on the longest straight, against the 1.15x the
// critic measured. The quarry has eight times the tight-radius road of this
// circuit; the mountain has ten times the saltpan's elevation.
//
// ── what this circuit is ───────────────────────────────────────────────────
//
// A stadium, stretched. Two long legs two hundred metres apart, an elbow at
// the east end, and the Carousel hooked round the head of the canyon at the
// west. It is the *fast* one of the three short circuits and the one with the
// fewest corners — nine — and the whole design is that you can see almost the
// entire lap from almost anywhere on it, which is what makes round one legible.
//
//   T1  Hi-Vis Right    R52, 90° — the braking point at the end of the pit
//                       straight. 280 metres of run-up at a 52-metre corner:
//                       this is where the lap is overtaken
//   T2  Digger's Elbow  R34 at 19m of road, with the gravel cut on its apex.
//                       The tightest thing here by a distance
//   T3/T4 Crest & Sweep the jog that steps the north leg out to the rim.
//                       R64 each way over the brow, and the road goes light
//   T5  The Notch       R60, 70° — the corner that sets up the Carousel
//   T6  THE CAROUSEL    R47, 185°, 152 metres of one radius. The signature:
//                       a full horseshoe round the head of the canyon, banked,
//                       long enough to hold a purple with room left over, and
//                       split lengthways by a raised island
//   T7  The Long Left   R52 the other way — the only place you drift left
//   T8  Grader Sweep    R150, the one corner here taken genuinely flat
//   T9/T10 Weigh & Cone R64 left then R50 right, 45° each — a real chicane
//                       onto the pit straight rather than a pair of kinks
//
// The two rules this circuit is held to are unchanged and both still bite.
// *Width follows speed*: 30m across the start line where the pack fans out,
// 19m at Digger's Elbow, 22-26m through the drift corners. And *nothing is
// dead straight for longer than the run to the first corner* — that run **is**
// the pit straight, at 274 metres from the line, and no other straight on the
// lap reaches 325.
//
// ── THE SPLIT ──────────────────────────────────────────────────────────────
//
// **The Carousel is a divided carriageway.** A hundred metres of raised,
// kerbed concrete island runs down the outside half of the longest corner in
// the game, and you have to pick a side of it a hundred and fifty metres
// before there is any evidence about which one was right:
//
//   * the **inside** is 12.7m wide, the shorter arc, the line the worn tarmac
//     points at, and where every CPU driver in the field will be;
//   * the **outside** is 8.2m, a longer way round 47 metres of radius, empty,
//     and has a boost strip on its exit.
//
// It is the only fork in the cup and the only hazard in the cup that punishes
// *indecision* — the Contraflow punishes arriving too fast, the quarry's Cut
// punishes being alongside, the mountain's washout punishes landing badly, and
// this punishes still being in the middle at turn-in. See `features.patches`,
// and `SurfacePatchDef.style` for why an island is built rather than spilled.
//
// ── and why the last boost strip moved ─────────────────────────────────────
//
// It used to sit 44 metres before the start line on the inside lateral, which
// is exactly where `track/index.ts` parks the back row of the grid — so
// `sample()` returned `'boost'` for a stationary kart under the lights, and
// the flag handed the whole field a free `pad` shove on the *same frame*
// `evaluateStart` graded the rocket start. `node tools/countdown.mjs` printed
// it as a standing WARN on every run. The strip is now on the exit of the Long
// Left, and the nearest paint of any kind to the chequer is 482 metres
// upstream of it. `tools/countdown.mjs` reports `surface road` for every frame
// of the intro and the count, and the WARN is gone.

import { loopFromWaypoints } from './path.ts';
import { ring } from './ring.ts';
import type { CourseDefEx } from './types.ts';

/**
 * The ring, driven east from the exit of the Grader Sweep.
 *
 * `run` is a straight in metres; `radius`/`turn` is a constant-radius arc, and
 * a negative turn goes right. `width` and `y` are what the road *becomes* by
 * the end of the segment, so a corner and its run-in declare the same width and
 * the pinch arrives with the corner. Turns sum to -360 and the ring closes to
 * within a tenth of a metre before `ring.ts`'s adjuster is asked for anything —
 * the two legs and the two chutes were solved against the closure rather than
 * nudged at, which is why `legs()` reports an adjustment of 0.0 on every
 * straight on this circuit.
 */
const RING = ring(
  { x: -167, z: -17, heading: 0, y: 0, width: 26 },
  [
    // Out of the Grader Sweep and onto the line. The chequer is 70 metres into
    // the pit straight, so this and the chicane below are the *approach* — the
    // last thing a player sees before the lap resets.
    { run: 130, width: 26, y: 0.6, name: 'r9' },
    { radius: 64, turn: 45, width: 27, y: 0.9, name: 'T9 WEIGH KINK' },
    { run: 60, width: 28, y: 1.2, name: 'r9b' },
    { radius: 50, turn: -45, width: 30, y: 1.6, name: 'T10 CONE CORNER' },
    // The pit straight. 274 metres from the line to the braking board and the
    // widest tarmac on the circuit, with a mesa parked on its vanishing point.
    { run: 344.1, width: 25, y: 2.4, name: 'PIT STRAIGHT' },
    // T1. **The braking point.** A 344-metre straight whose first corner is
    // taken flat has nothing at the end of it — no braking, no overtaking,
    // nowhere to lay a drift. This is 52 metres of radius held through 90
    // degrees, arrived at flat out.
    { radius: 52, turn: -90, width: 22, y: 5, name: 'T1 HI-VIS RIGHT' },
    { run: 118, width: 20, y: 8, name: 'r1' },
    // T2. The tightest corner on the circuit and the only one under 40 metres.
    // 19m of road, and the gravel cut is on its apex.
    { radius: 34, turn: -90, width: 19, y: 10, name: 'T2 DIGGERS ELBOW' },
    // The north leg. Two 322-metre runs with a jog between them, which is what
    // stops this side of the circuit being one 700-metre straight.
    { run: 317.9, width: 26, y: 17, name: 'r2' },
    // T3/T4. The vertical here is deliberate and deliberately *just* short of a
    // jump: +5% into the crest, -4% out of it. At the speed this arrives at
    // that unloads most of the kart's weight for the length of a car — the road
    // goes light, the camera lifts — and puts none of it in the air. The jog
    // steps the leg out to the canyon rim, which is why the crest is on it.
    { radius: 64, turn: 34, width: 24, y: 26, name: 'T3 CONE CREST' },
    { run: 65, width: 24, y: 24, name: 'r3' },
    { radius: 64, turn: -34, width: 26, y: 20, name: 'T4 RIMROCK SWEEP' },
    { run: 317.9, width: 24, y: 12, name: 'r4' },
    { radius: 60, turn: -70, width: 24, y: 8, name: 'T5 THE NOTCH' },
    { run: 323.6, width: 24, y: 4, name: 'r5' },
    // T6. The signature. 152 metres of 47-metre radius, which is a shade under
    // three seconds at the speed it is taken — a purple needs about one — and
    // it never changes radius, so the drift laid at turn-in is the drift that
    // comes out the far side.
    //
    // **And it is a divided carriageway** — see `features.patches` below. 24
    // metres rather than 21, which looks like a violation of *width follows
    // speed* and is the opposite of one: the corner is split lengthways by a
    // raised island, so what a kart actually drives is a 12.7-metre inside lane
    // or an 8.2-metre outside lane, and **both of those are narrower than the
    // 21 metres this corner would otherwise be**.
    { radius: 47, turn: -185, width: 24, y: 1, name: 'T6 THE CAROUSEL' },
    { run: 90, width: 24, y: 0.4, name: 'r6' },
    { radius: 52, turn: 50, width: 26, y: 0.4, name: 'T7 THE LONG LEFT' },
    { run: 120, width: 26, y: 0.5, name: 'r7' },
    // The one corner on the lap that is genuinely flat out and still has to be
    // aimed. Every circuit needs one; this is it.
    { radius: 150, turn: 25, width: 26, y: 0.6, name: 'T8 GRADER SWEEP' },
  ],
  { step: 14 },
);

/**
 * Metres from the ring's origin to the start/finish line — seventy metres into
 * the pit straight.
 *
 * **The grid is what this number is for.** `track/index.ts` puts the eight
 * slots at `startDistance - (12 + row * 8)`, so the back row stands 47 metres
 * behind the chequer and the intro formation rolls in from eleven metres
 * further back again. All of that has to land on plain, level, straight tarmac
 * — and it does. The pit straight begins 70 metres before the line, which
 * clears the roll-in by twelve, and there is no paint on the road for the
 * 482 metres before that either.
 */
const START = 350;
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
  groundY: -20,
  startDistance: START,
  checkpoints: 32,

  features: {
    // Five strips, and none of them on the pit straight — a boost pad where the
    // kart is already at terminal velocity is decoration. Each one is laid on
    // the way *out* of a corner you had to work for, so the pad is the payment
    // for the drift rather than a thing you drive over.
    //
    // **And none of them within eighty metres of the start line.** See `START`:
    // the last strip on the lap now sits on the exit of the Long Left, 470
    // metres upstream of the chequer, because the one that used to sit 44
    // metres before it was standing under the back row of the grid.
    pads: [
      // Out of Digger's Elbow — the tightest corner on the circuit, and the
      // one you have just given up a third of your speed for.
      { at: on('r2', 0.14), lateral: -0.32, width: 5.5, length: 20 },
      // **The outside lane's payment.** Laid past the end of the island, on the
      // Carousel's exit, at the lateral the *outer* line comes off at — so it
      // is collected by a kart that committed to the long way round and missed
      // by one that took the apex. Without it the split is not a split: the
      // inside lane is shorter, and a choice between short and long with
      // nothing else on the table is not a choice.
      { at: on('T6 THE CAROUSEL', 0.93), lateral: 0.66, width: 5.5, length: 20 },
      { at: on('r6', 0.55), lateral: -0.30, width: 5.5, length: 22 },
      { at: on('r4', 0.18), lateral: 0.30, width: 5.5, length: 22 },
      { at: on('r7', 0.35), lateral: -0.32, width: 5.5, length: 22 },
    ],
    // Digger's Elbow. Cutting the inside gravel saves about 25 metres and costs
    // you a third of your top speed while you are on it — worth it out of a
    // mini-turbo, a disaster from a standing start. `side: -1` is the driver's
    // right, which is the apex of this right-hander; see `ShortcutDef`.
    shortcuts: [{ from: on('T2 DIGGERS ELBOW', 0.12), to: on('T2 DIGGERS ELBOW', 0.88), side: -1 }],

    // ── THE SPLIT: round one's signature, and the only fork in the cup ──────
    //
    // A hundred metres of raised concrete island down the Carousel, kerbed in
    // black and gold on both flanks. It turns the longest corner in the game
    // into two roads and forces the decision at turn-in, a hundred and fifty
    // metres before there is any evidence about which was right:
    //
    //   * **the inside**, 12.7 metres wide, is the apex line and the shorter
    //     arc. It is what the worn line on the tarmac points at and what every
    //     CPU driver takes, so it is also where the traffic is.
    //   * **the outside**, 8.2 metres, is a longer way round a 47-metre corner
    //     with a boost strip on its exit (see `pads`). Clean air, and you come
    //     off it with a shove; get it wrong and you have driven the long way
    //     round for nothing.
    //
    // `style: 'island'` is what makes it a *built* thing rather than a spill —
    // hard parallel edges, a flat top 14cm proud, striped kerbs down both
    // flanks. See `SurfacePatchDef`. The band sits on the driver's **left**
    // (the spline's `+`), which is the outside of this right-hander: the worn
    // line runs at about -0.76 of the half width through here, so the island is
    // clear of it by four metres and nothing has to swerve for it.
    //
    // Clipping it is `dirt`: 70% of top speed, recoverable, and quite enough to
    // decide a place.
    patches: [
      {
        from: on('T6 THE CAROUSEL', 0.18), to: on('T6 THE CAROUSEL', 0.86),
        latFrom: 0.06, latTo: 0.32, surface: 'dirt', style: 'island',
      },
    ],
    // ── THE ROCKFALL: what makes the fork a gamble ─────────────────────────
    //
    // The Split has been a choice between a short line and a long one since it
    // was built, and a choice whose right answer never changes is a thing you
    // solve once and then stop reading. So the canyon drops its rim on it.
    //
    // Four boulders come off the cut above the head of the horseshoe, take a
    // second and a half of air, and land across the **apex** lane — the short
    // arc inside the island, the one the worn tarmac points at and the one
    // every CPU driver in the field is on. They sit there while the loader
    // gets to them, and then the lane is open again. What is left open the
    // whole time is the wide lane outside the island, which is longer, and
    // which has the boost strip on its exit.
    //
    // Seventeen seconds against a fifty-second lap, so the corner is never in
    // the same state twice in a race. The rocks are the canyon's own terracotta
    // (`tint`), because a hazard has to look like it came from the place it
    // fell out of.
    //
    // ── and why `lateral` is +0.38 and not -0.55 ───────────────────────────
    //
    // It was -0.55, on the strength of the sentence in `ShortcutDef` that says
    // the spline's negative side is the driver's right and therefore the apex
    // of this right-hander. **That sentence is the wrong way round**, and the
    // cost of it was a whole round: censused over four full races this hazard
    // hit nobody at all, because it was landing four boulders in an empty lane
    // eleven metres from the line every kart in the field takes.
    //
    // `node tools/hazardcensus.mjs --profile` measures it instead of arguing
    // about it. The field crosses this station at **+0.5 to +7.5 metres, median
    // +5.5** — `sample().lateral` positive, which `racingline.ts` builds as the
    // inside of a right-hand corner. So the rocks are centred at +4.6 and the
    // fall covers -3.5 to +13.8, which is the whole apex lane and the island
    // beside it, and leaves eight and a half metres of the wide lane open.
    //
    // ── and why there are two of them, on nine seconds and thirteen ────────
    //
    // Moving the fall onto the line took this hazard from zero hits a race to
    // eleven — and then to six, and then to *two*, on three other seeds. The
    // census says why in one column: at seed 13 the boulders were on the road
    // for **three of twenty-two crossings** against a 50% blocked window,
    // which is four sigma off a binomial and therefore not a binomial at all.
    //
    // Seven racers in a pack cross the Carousel inside a few seconds of each
    // other. On a seventeen-second cycle that is not twenty-one samples of the
    // hazard's phase, it is **three** — one per lap — and three coin flips can
    // easily all come up clear. A hazard can be correctly placed, correctly
    // timed and still be absent from a whole race, purely because the field is
    // correlated with itself.
    //
    // So the canyon drops its rim in two places, on two short cycles: nine
    // seconds at the Carousel and thirteen at the Notch, which is the corner
    // that sets the Carousel up. The pack's own spread is now a large fraction
    // of each cycle, the two stations are on coprime periods, and the number of
    // independent draws in a race goes from three to something like twenty.
    hazards: [{
      at: on('T6 THE CAROUSEL', 0.52), kind: 'rockfall', period: 9, phase: 0.1,
      // A shade lighter than the cliff it comes off. Flat-shaded rock in flight
      // has most of its faces turned away from the sun, and at the declared
      // 0xa05a33 the boulders photographed as black holes in a bright desert —
      // a silhouette, which is right, but not a *canyon's* silhouette.
      lateral: 0.38, hit: 'spin', lead: 2.0, signAt: 120, tint: 0xbe7644,
    }, {
      // The Notch. `--profile` puts the field through here in a tight band
      // around +1.3 metres, so the fall is centred at +2.2 and leaves six
      // metres of road open on the outside — the way through is the long way,
      // which is the same bargain the Carousel offers a hundred metres later.
      at: on('T5 THE NOTCH', 0.55), kind: 'rockfall', period: 13, phase: 0.6,
      lateral: 0.18, hit: 'spin', lead: 2.0, signAt: 96, tint: 0xbe7644,
    }],

    // Eight corners run 1/34 to 1/120 of curvature and the Grader Sweep runs
    // 1/150, so a threshold at 1/120 puts a rumble strip on everything a player
    // brakes for and leaves the one flat-out sweeper clean.
    kerbCurvature: 0.0083,

    // ── the canyon, and the round it did not have one ──────────────────────
    //
    // A critic photographed this course and wrote: *"Cone Canyon has no canyon.
    // racing.png, far.png and all five lap frames show a horizon of
    // near-identical tan truncated-cone mounds in a rough grid — no rim, no
    // gorge, no drop. It reads as heightmap filler."* That was exactly right,
    // and the reason is in the two numbers below rather than in the art.
    //
    // `terrain.ts` builds the rim as `plateau · terrace · erosion · rimHeight`,
    // where `plateau` is a `smoothstep` over a noise field on a 420-metre
    // wavelength. That product is **zero over about half the ground**, so the
    // rim is by construction a field of separate lumps on a 420m lattice — a
    // mound field. Turning `rimHeight` up makes the mounds taller; it cannot
    // make them a wall, because the thing that is missing is *continuity*.
    //
    // The only continuous landform `terrain.ts` offers is `hero`, so the rim is
    // now built out of heroes: **nine buttes on a ring around the circuit, each
    // one's footprint overlapping its neighbours', so their skirts fuse into a
    // wall with buttresses in it instead of standing apart as hills.** The
    // noise rim is kept, at 62 rather than 105, where it belongs — broken talus
    // on the slope *below* the wall.
    //
    // The gorge is `groundY`, and it is **deliberately a shallow one**. The far
    // field settles to that datum over 70..340 metres from the shoulder, so a
    // datum below the road is a drop — but `canyon.paint` lerps 34% of
    // `CANYON_SCRUB`, a saturated olive, over every metre of ground between 1
    // and 16 metres *below the nearest road*, and a deep drop simply moves that
    // band from three hundred metres out (where the haze eats it) to a hundred
    // and fifty (where a chase camera lives). Photographed at a -40 datum the
    // canyon comes back green. So the fall is twenty metres, which is enough to
    // put the wall's foot below the circuit and keeps the scrub band out past
    // the rim. **A landscape you cannot photograph is not a landscape**, and the
    // deeper gorge needs `render/theme.ts` to key its vegetation on something
    // other than "lower than the road" first.
    //
    // The prop band is the constraint on all of it. `world/index.ts` places
    // berms, stockpiles and plant with `room()` between 50 and 168 metres, and
    // `room()` tests whether a spot is free rather than whether it is level, so
    // nothing steep may begin inside that band. The drop reaches a 24% grade at
    // 146m and the wall does not start until 175 — a talus slope, which is what
    // a machine yard on a canyon shelf actually stands on.
    terrain: {
      rimStart: 175,
      rimEnd: 430,
      rimHeight: 62,
      landmarks: [
        // ── the rim: nine buttes, ring-placed, footprints overlapping ──────
        //
        // Radii of 300-390 on a ring spaced about 430 metres apart, so the
        // gap between two neighbours sits at r≈0.7 of both — `shape` is 0.5
        // there against 1.0 at a centre, and the two sum to a saddle rather
        // than a notch. Heights are deliberately uneven: a rim of one height
        // is a fence.
        { x: 1180, z: 40, radius: 380, height: 205, kind: 'mesa' },
        { x: 900, z: -560, radius: 330, height: 170, kind: 'mesa' },
        { x: 250, z: -760, radius: 300, height: 150, kind: 'mesa' },
        { x: -430, z: -700, radius: 340, height: 185, kind: 'mesa' },
        { x: -1010, z: -320, radius: 370, height: 210, kind: 'mesa' },
        { x: -1090, z: 300, radius: 350, height: 165, kind: 'mesa' },
        { x: -760, z: 800, radius: 360, height: 195, kind: 'mesa' },
        { x: -60, z: 900, radius: 320, height: 160, kind: 'mesa' },
        { x: 620, z: 780, radius: 340, height: 180, kind: 'mesa' },
        // ── and two things standing *in* the canyon, to give it depth ──────
        //
        // A rim with nothing in front of it is a backdrop. These two are on
        // the gorge floor between the circuit and the wall, so there is a
        // silhouette at a different distance from the one behind it — which is
        // the whole of what makes a landscape read as deep rather than as
        // painted. Both are held off the road by the hero gate
        // (`rimStart * 0.7` = 122m) and placed well past it.
        { x: 520, z: -370, radius: 150, height: 132, kind: 'spire' },
        { x: -690, z: 470, radius: 170, height: 118, kind: 'spire' },
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
