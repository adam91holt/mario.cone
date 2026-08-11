// Course 3 — Saltpan Bypass.
//
// **The fast one, the open one, and the one shaped like a wedge.**
//
// A temporary two-lane bypass bulldozed across a dry salt lake while the real
// road is dug up: the widest, longest, emptiest circuit in the cup — 3.5km, up
// to 34 metres of road, and a horizon with nothing on it.
//
// ── the shape, which is the point ──────────────────────────────────────────
//
// A critic played the cup and rejected it at 6.5 on one finding: *"measured
// off the real driven line, every one of the four is an irregular closed blob
// of 9-12 similar-radius corners whose longest straight is 72-83 metres — an
// 11-metre spread, 1.4 seconds at 54 m/s."* The four circuits now differ on
// the axes MK8 differentiates on, and **this is the one that owns the
// straight**:
//
//     course           longest straight   R<40m of lap   elevation   aspect
//     Cone Canyon           320m               30m         26.0m      2.37
//     Jackhammer            160m              249m         41.6m      1.30
//     Saltpan               629m               60m         11.7m      1.76
//     Switchback            240m               70m        115.2m      1.68
//
// **640 metres of ruler-straight tarmac** against the quarry's 160 — 3.9x, on
// an axis the roster previously spread over eleven metres. It is not a cheat
// either: on a dry lake the temporary road *is* a bulldozed line between two
// survey pegs, and the plan of this circuit is a **wedge** — a right triangle
// with a 90-degree vertex at the Pan Entry, a 45 at the Beacon and a 45 at the
// Contraflow. Three enormous sides and one sharp point. On the select card it
// cannot be confused with a dogleg, a comb or an hourglass.
//
//   ── side one: THE BYPASS ──
//   THE BYPASS        640 metres, dead straight, 34 metres wide, and **three
//                     sheets of standing brine laid across it**. The start
//                     line is 110 metres in, so the run to the first corner is
//                     530 metres and the whole flood is in front of you
//   T1/T2 kinks       R220 either way, the only shape on this side
//   ── vertex: THE CONTRAFLOW (45°) ──
//   T3 Works Right    R60, the road pinching from 30 metres to 21
//   T4 THE CONTRAFLOW R30 LEFT at 21m wide. From 34m of road and 60 m/s
//   T5 Contraflow Exit R30 right straight back out of it
//   T6 Windsock Right R58 onto the works leg
//   ── side two: the works leg, with THE CAUSEWAY on it ──
//   CAUSEWAY          the levee, 12.5m up, with the kicker on the crest
//   T7/T8 kinks       R200 either way
//   ── vertex: PAN ENTRY (90°) ──
//   T9 Pan Entry      R55, 50° — the pan's braking point
//   T10 Pan Sweep     R60, 40°, with the salt windrow across its outside
//   ── side three: the west leg ──
//   T11/T12 kinks     R210 either way, two 330-metre runs between them
//   ── vertex: THE BEACON (45°) ──
//   T13 Culvert Right R58, 70°
//   T14 Beacon Right  R46, 65° — the tightest corner outside the chicane, and
//                     the one that fires you onto the bypass
//
// ── THE FLOOD: round three's signature, now on the straight ────────────────
//
// A dry lake is only dry until it is not.
//
// Three sheets of standing brine lie across the bypass — **the only water in
// the game**: `water` is 45% of top speed and half the grip, which at 60 m/s
// on the widest road in the cup is the largest single number any surface in
// this game does to a kart.
//
// They are on the *straight* on purpose, and that is the whole design of this
// round. A 640-metre straight is the most boring hundred metres a kart racer
// can contain and the most distinctive shape a map card can carry, and the way
// to have both is to make the straight a **slalom that is geometrically
// straight**. You cannot go round the sheets, only through them, and each one
// leaves a different dry lane — left, then right, then the middle — so the
// fast way down the bypass is a rhythm you learn on lap one and beat on lap
// two. Thirty-four metres each, about half a second at racing speed if you get
// it wrong.
//
// ── and then a critic drove it and said the straight was empty ─────────────
//
// *"Saltpan's 621m straight is ~11s of holding accelerate with nothing on it,
// and all three of its hazards sit between 163m and 419m of a 3519m lap,
// leaving 3100m empty."* Both halves of that were fair, and they are different
// faults:
//
//   * **The straight had only punishments on it.** Three sheets to avoid and a
//     bore to dodge is eleven seconds of not-losing, with nothing to win. So
//     the third band now has a reward on the far side of it: cross it on the
//     wide shoulder — the long way round — and thirty-two metres of boost ramp
//     is waiting where you land. The straight is a *choice* now rather than a
//     corridor.
//   * **The lake only flooded in one place.** A dry lake does not drain in the
//     first twelve per cent of a lap. There are two more crossings now, one on
//     the works leg and one out on the west leg, each leaving its dry lane on
//     the opposite hand from the other, so the four stations sit about a
//     kilometre apart the whole way round.
//
// The bypass is also the one straight in the cup with a **building** on it:
// the salt works' loading jetty crosses it at the start line, on timber piles,
// with two chutes hanging over the carriageway and a windrow of raw salt on
// the deck. See `kit`.
//
// Width follows speed here more visibly than anywhere: 34m on the bypass where
// eight karts fan out four abreast, 21m through the chicane where two of them
// will not fit, 26-30m through the works. And nothing on the lap is dead
// straight for longer than the run to the first corner, because the run to the
// first corner *is* the longest straight.
//
// The pan is flat: twelve metres of elevation across the whole lap, all but
// three of it in the causeway, which is what a dry lake is and what makes the
// horizon do the work instead of the terrain.
//
// **Two laps.** Every other round in the cup runs three; this one is 3.5
// kilometres of road, and a third lap of it is the same lap again.
//
// The look is the other half of the design. A dry lake is the highest-key
// landscape there is — near-white ground throwing light back up into everything
// standing on it, a cobalt zenith because there is nothing in the air, and no
// haze worth the name out to three kilometres. Black bitumen on white salt is
// the highest road-to-ground contrast in the game, and that contrast is what
// keeps a 34m ribbon readable at 60 m/s.

import { loopFromWaypoints } from './path.ts';
import { applyRamps } from './ramp.ts';
import { ring } from './ring.ts';
import type { CourseDefEx, RampDef } from './types.ts';

/**
 * The ring, driven east along the bypass.
 *
 * The three vertices turn -90, -135 and -135, which is a right isoceles
 * triangle: one side the hypotenuse and two equal legs. The kink pairs on each
 * side sum to zero, so the triangle stays a triangle and the sides are still
 * sides — a kink is there to stop 900 metres of road being one straight, not
 * to bend the shape.
 *
 * `run` is a straight in metres; `radius`/`turn` is a constant-radius arc, and
 * a negative turn goes right.
 */
const RING = ring(
  { x: -614, z: 397, heading: 0, y: 1.7, width: 34 },
  [
    // ── side one: the hypotenuse, and the fastest road in the game ────────
    { run: 640, width: 34, y: 2.2, name: 'THE BYPASS' },
    { radius: 220, turn: -20, width: 33, y: 2.4, name: 'T1 MIRAGE KINK' },
    { run: 170, width: 32, y: 2.6, name: 's1' },
    { radius: 220, turn: 20, width: 32, y: 2.6, name: 'T2 GRADER KINK' },
    { run: 126.7, width: 30, y: 2.6, name: 's2' },
    // ── vertex: THE CONTRAFLOW ────────────────────────────────────────────
    // The sharp point of the wedge, and the hardest corner on the circuit: the
    // road pinches from 30 metres to 21 in the two hundred before it, and 30
    // metres of radius is barely half the tightest thing anywhere else.
    { radius: 60, turn: -50, width: 26, y: 2.8, name: 'T3 WORKS RIGHT' },
    { run: 45, width: 22, y: 3.0, name: 's3' },
    { radius: 30, turn: 80, width: 21, y: 3.2, name: 'T4 THE CONTRAFLOW' },
    { run: 45, width: 21, y: 3.2, name: 's4' },
    { radius: 30, turn: -85, width: 21, y: 3.2, name: 'T5 CONTRAFLOW EXIT' },
    { run: 60, width: 26, y: 3.0, name: 's5' },
    { radius: 58, turn: -80, width: 28, y: 2.8, name: 'T6 WINDSOCK RIGHT' },
    // ── side two: the works leg ───────────────────────────────────────────
    { run: 124.9, width: 28, y: 3.0, name: 's6' },
    // ── THE CAUSEWAY ─────────────────────────────────────────────────────
    // The one vertical idea a dry lake is allowed to have, and it is *built*
    // rather than geological: the bypass has to get over the salt works' old
    // tramway embankment, so it climbs the levee at 16%, runs 26 metres along
    // the crest twelve and a half metres above the pan, and falls off the far
    // side at 22%. There is a kicker on the crest — see `RAMPS`.
    { run: 54, width: 25, y: 11.6, name: 'CAUSEWAY CLIMB' },
    { run: 26, width: 23, y: 12.5, name: 'CAUSEWAY TOP' },
    { run: 46, width: 29, y: 2.6, name: 'CAUSEWAY DROP' },
    { run: 90, width: 30, y: 2.2, name: 's7' },
    { radius: 200, turn: 20, width: 30, y: 2.0, name: 'T7 SURVEY KINK' },
    { run: 130, width: 30, y: 2.0, name: 's8' },
    { radius: 200, turn: -20, width: 30, y: 2.0, name: 'T8 CULVERT KINK' },
    { run: 69.9, width: 30, y: 2.0, name: 's9' },
    // ── vertex: PAN ENTRY, the right angle ────────────────────────────────
    { radius: 55, turn: -50, width: 29, y: 1.8, name: 'T9 PAN ENTRY' },
    { run: 90, width: 30, y: 1.8, name: 's10' },
    { radius: 60, turn: -40, width: 30, y: 1.8, name: 'T10 PAN SWEEP' },
    // ── side three: the west leg ──────────────────────────────────────────
    { run: 348, width: 31, y: 1.8, name: 's11' },
    { radius: 210, turn: 18, width: 31, y: 1.8, name: 'T11 CRUST KINK' },
    { run: 328.5, width: 30, y: 1.8, name: 's12' },
    { radius: 210, turn: -18, width: 30, y: 1.8, name: 'T12 MARKER KINK' },
    { run: 175, width: 28, y: 1.8, name: 's13' },
    // ── vertex: THE BEACON ────────────────────────────────────────────────
    { radius: 58, turn: -70, width: 28, y: 1.7, name: 'T13 CULVERT RIGHT' },
    { run: 90, width: 28, y: 1.7, name: 's14' },
    { radius: 46, turn: -65, width: 30, y: 1.7, name: 'T14 BEACON RIGHT' },
  ],
  { step: 16 },
);

/**
 * Metres from the ring's origin to the start/finish line — 110 into the
 * bypass, which leaves 530 metres of it in front of the grid and 110 behind.
 *
 * The number is chosen for the **grid**, not for the lap. `track/index.ts`
 * parks the back row 47 metres behind the chequer and the intro formation
 * rolls in from eleven metres further back again, so 58 metres of straight,
 * level, unpainted road behind the line is the minimum this course has to
 * provide. It provides 110, and there is no boost strip within a kilometre of
 * it in either direction.
 */
const START = 110;
const on = (name: string, along = 0.5): number =>
  ((RING.distanceAlong(name, along) - START) / RING.length + 1) % 1;

/**
 * The kicker on the causeway crest.
 *
 * The lip sits on the last metre of the level crest, so a kart leaves it
 * climbing with 12.5 metres of embankment and a 22% face underneath it and
 * nothing to land on for seventy. It is a shorter lip than the mountain's — 2.4
 * metres against 3.6 — because it is taken twenty metres a second faster and a
 * jump's length is a function of both.
 *
 * Read twice, like every ramp: `applyRamps` puts the deck into the centreline,
 * which is the only place kart physics can feel it, and `buildRoad` reads the
 * same array to paint the chevrons and the lip bar on top. See `ramp.ts`.
 */
const RAMPS: RampDef[] = [
  { at: on('CAUSEWAY TOP', 1), length: 20, lip: 2.4, fall: 0.30, width: 14 },
];

export const saltpanBypass: CourseDefEx = {
  id: 'saltpan-bypass',
  name: 'Saltpan Bypass',
  cup: 'hazard',
  points: loopFromWaypoints(applyRamps(RING.waypoints, RAMPS, {
    length: RING.length, startDistance: START,
  }), {
    width: 32,
    step: 10,
    bankGain: 20,
    maxBank: 0.20,
    // Longer easing than the tighter circuits: a third of the corners here are
    // 200-220m kinks, so the camber has two hundred metres to arrive in and no
    // reason to hurry.
    bankSmooth: 70,
  }),
  width: 32,
  // Two. See the header — 3.5km, and the third lap is the second one again.
  laps: 2,
  // Twelve metres of salt crust either side. Running wide out here does not end
  // your race the way it does in the quarry — it just costs you the corner, and
  // that is the trade a wide-open circuit is supposed to offer.
  vergeWidth: 12,
  vergeSurface: 'sand',
  offSurface: 'sand',
  walls: true,
  // Low barriers. On a lake bed there is nothing to armco against, and a 1.5m
  // wall running the length of a 3.5km circuit would fence in the one view the
  // course is built around.
  wallHeight: 1.1,
  groundSize: 6400,
  groundY: 0,
  startDistance: START,
  checkpoints: 40,

  features: {
    // **Three strips, and they are the longest in the cup.** Thirty metres of
    // ramp against Jackhammer Quarry's sixteen, because the question the pan
    // asks is not "can you get back on the throttle" — you never came off it —
    // but "did you aim the sweeper properly two hundred metres ago".
    //
    // None is on the bypass, and that is deliberate twice over: a boost pad on
    // the fastest road in the game is decoration, and the bypass is where the
    // brine is. A strip buried under a patch stops existing for every CPU
    // driver in the field — `findPads` in `ai/knowledge.ts` confirms each
    // declared strip by probing `sample()` for `'boost'` and silently drops the
    // ones that do not answer. See `SurfacePatchDef`.
    pads: [
      { at: on('s5', 0.45), lateral: -0.30, width: 7, length: 30 },
      { at: on('s7', 0.35), lateral: 0.26, width: 7, length: 32 },
      { at: on('s11', 0.30), lateral: 0.28, width: 7, length: 32 },
      // **The west leg's second strip.** A critic photographed this circuit at
      // 2493 metres of lap and got *"a black road running dead straight to a
      // white horizon with a low fence either side — no brine, no boost strip,
      // no set piece, nothing for its whole length"*, and they were looking at
      // exactly this stretch: two three-hundred-metre runs with one strip
      // between them, six hundred metres apart. There are two now.
      { at: on('s12', 0.55), lateral: -0.28, width: 7, length: 32 },
      // ── the payoff for reading the flood ────────────────────────────────
      //
      // A critic drove the bypass and reported *"621 metres of holding
      // accelerate with nothing on it"*. Three sheets of standing brine were
      // already on it, and the fault in that is real: a sheet is something to
      // **avoid**, and eleven seconds of avoiding things with no upside is a
      // corridor, not a straight. So the last sheet now has a reward on the
      // other side of it. Cross the third band on the far shoulder — the wide
      // side, the long way round — and thirty-two metres of ramp is waiting
      // where you land.
      //
      // It is fifteen metres past the sheet's trailing edge and on lateral
      // 0.76, and the sheet is declared to 0.52 and built with **ruled** edges
      // that never grow past the declaration (`style: 'brine'`), so the point
      // `findPads` probes — the pad's own centre, at the pad's own lateral —
      // cannot land on water. See `SurfacePatchDef` on why that is the
      // invariant rather than the along-track rule of thumb.
      { at: on('THE BYPASS', 0.895), lateral: 0.76, width: 7, length: 32 },
    ],
    // The closed carriageway: the crust runs straight on past the chicane's
    // first apex. It is 58% of top speed while you are on it, so from 60 m/s it
    // is a trap — and with a mushroom it is the fastest thing on the circuit.
    // `side: 1` is the driver's left, which is the apex of this left-hander.
    shortcuts: [{ from: on('s3', 0.30), to: on('s4', 0.60), side: 1 }],
    // **The kicker on the causeway.** See `RAMPS` above; the deck is in the
    // centreline and this is what paints it.
    ramps: RAMPS,
    patches: [
      // ── THE FLOOD: round three's signature ──────────────────────────────
      //
      // Three sheets of standing brine across the bypass, at 0.40, 0.60 and
      // 0.80 of its length — so from the line you cross the first at 145
      // metres, the second at 275, the third at 405, and you are back on dry
      // salt with 90 metres left to line up the Mirage Kink.
      //
      // **You cannot go round them, only through them**, and each one leaves a
      // different dry lane: the first leaves the driver's left, the second the
      // driver's right, the third both shoulders. So the fast way down the
      // longest straight in the game is a slalom — and the straight stays
      // geometrically straight, which is what keeps this circuit's silhouette.
      //
      // 34 metres each: about half a second at racing speed if you get it
      // wrong, which is a place, not a race. `style: 'brine'` builds it as a
      // sheet rather than a spill — ruled edges, glossy, transparent enough
      // that the centreline reads underneath it, because judging the depth of
      // a flooded road *is* the skill. Lateral is in the spline's frame, so
      // `-1` is the driver's right; see `SurfacePatchDef`.
      {
        from: on('THE BYPASS', 0.400), to: on('THE BYPASS', 0.453),
        latFrom: -1, latTo: 0.18, surface: 'water', tint: '#5D909C', style: 'brine',
      },
      {
        from: on('THE BYPASS', 0.600), to: on('THE BYPASS', 0.653),
        latFrom: -0.18, latTo: 1, surface: 'water', tint: '#5D909C', style: 'brine',
      },
      {
        from: on('THE BYPASS', 0.800), to: on('THE BYPASS', 0.853),
        latFrom: -0.52, latTo: 0.52, surface: 'water', tint: '#5D909C', style: 'brine',
      },

      // **The drift.** A dry lake is a wind machine, and what it moves is salt.
      // A metre-deep windrow has blown across the *outside* half of the Pan
      // Sweep — the long right that opens onto the west leg, taken flat — and
      // it is `sand`, which is 58% of top speed. Nothing is blocking the road:
      // the fast line is still there, it is just narrower than it looks, and a
      // kart pushed wide by a rival at 60 m/s finds out where the edge of it
      // is. It is the only surface hazard in the cup that punishes *being
      // overtaken* rather than braking late.
      //
      // Near-white, because it is salt: on the darkest tarmac in the cup it is
      // the most legible hazard in the game.
      {
        from: on('T10 PAN SWEEP', 0.12), to: on('T10 PAN SWEEP', 0.88),
        latFrom: 0.40, latTo: 1, surface: 'sand', tint: '#E4DECA',
      },

      // ── the other two thirds of the lake ────────────────────────────────
      //
      // **The flood used to stop at the bypass.** A critic measured it exactly:
      // *"all three of its hazards sit between 163m and 419m of a 3519m lap,
      // leaving 3100m empty"*. Every sheet, every bore and the whole signature
      // of round three lived in the first twelve per cent of the circuit, and
      // the works leg and the west leg — two thirds of the lap — were dry
      // tarmac with a kink in it.
      //
      // A lake does not drain in one place. These are the two crossings where
      // the pan comes over the bypass on the other two sides of the triangle:
      // one on the works leg between the culvert kinks, one out on the west leg
      // where the crust is thinnest. Each leaves its dry lane on the opposite
      // hand from the other, so neither teaches you the other, and the four
      // hazard stations now sit roughly a kilometre apart all the way round
      // instead of stacked in the first eleven seconds.
      //
      // Neither covers a boost strip at the point `findPads` probes: the west
      // leg's strip is at 0.55 of its segment and this sheet ends at 0.24.
      {
        from: on('s8', 0.30), to: on('s8', 0.52),
        latFrom: -1, latTo: 0.30, surface: 'water', tint: '#5D909C', style: 'brine',
      },
      {
        from: on('s12', 0.14), to: on('s12', 0.24),
        latFrom: -0.30, latTo: 1, surface: 'water', tint: '#5D909C', style: 'brine',
      },
    ],
    // ── THE SURGE: what stops the slalom being memorised ───────────────────
    //
    // Three sheets, each leaving a different dry lane, is a rhythm — and a
    // rhythm is a thing a player learns on lap one and then owns for the rest
    // of the race. On a two-lap circuit that means the signature of round three
    // is solved halfway through it.
    //
    // So the lake moves. A **bore** — a metre and a half of brine with a foam
    // crest on it, twenty-six metres of it along the road — rolls in off the
    // pan, crosses the road, and drains back. One per sheet, and the three are
    // a third of a cycle apart, so at any moment one of the three crossings is
    // being swept and the other two are as you left them. *Which* one is the
    // thing that changes.
    //
    // Eleven seconds a cycle against a lap of about seventy: six cycles a lap,
    // so lap two arrives well out of step with lap one and the pattern you
    // learned is off by a band. The period is short for a second reason as
    // well — a cycle longer than the field's own spread makes seven racers into
    // one sample of the phase, and a whole race can pass with the water out on
    // the pan every time anybody looks. See `HazardDef.period`.
    //
    // `bump` rather than `spin`: water shoves, it does not throw you. 0.55s and
    // most of your speed — which on the fastest road in the cup is still a
    // place.
    //
    // ── where a bore stands, and why it is not the dry lane ────────────────
    //
    // It used to rest in the middle of its own sheet's dry lane, which is a
    // tidy sentence and was measurably wrong. `node tools/hazardcensus.mjs`
    // over two full laps: three bores, forty-seven crossings, **zero hits**.
    // The reason is in the same report's driven line — the field comes down the
    // bypass at a **median of half a metre off the centreline**, with the
    // ninetieth percentile inside ±6, and it does not weave for the sheets at
    // all, because nothing in `ai/` reads a surface patch when it picks a line.
    // Three bores parked eight to thirteen metres out were three bores parked
    // where nobody was.
    //
    // A bore is a wave, so the honest fix is also the simpler one: it rolls in
    // off the pan on the side its own sheet drains from, **stands over the
    // middle of the carriageway** for a beat, and drains back. It takes about
    // nine metres of a thirty-four-metre road, so there is a way past on both
    // shoulders at every moment — it is a lane closure, not a traffic light —
    // and the way past is a different one for each of the three.
    //
    // `lateral` is where the bore rests, in the frame `sample().lateral`
    // reports. **Measure it, do not reason about it**: the sign convention in
    // `types.ts` was the wrong way round for a whole round and it cost this
    // course, Cone Canyon and Switchback Summit their entire hazard budget.
    hazards: [
      { at: on('THE BYPASS', 0.427), kind: 'surge', period: 11, phase: 0,
        lateral: -0.15, hit: 'bump', lead: 1.6, signAt: 96 },
      { at: on('THE BYPASS', 0.627), kind: 'surge', period: 11, phase: 1 / 3,
        lateral: 0.15, hit: 'bump', lead: 1.6, signAt: 96 },
      { at: on('THE BYPASS', 0.827), kind: 'surge', period: 11, phase: 2 / 3,
        lateral: -0.02, hit: 'bump', lead: 1.6, signAt: 96 },
      // The works leg and the west leg. Thirteen and seventeen seconds rather
      // than eleven, and prime against each other and against the bypass's
      // three, so no two stations on this circuit ever come round together —
      // see `HazardDef.period` on why a hazard whose cycle matches the field's
      // own spread turns seven racers into one sample.
      { at: on('s8', 0.41), kind: 'surge', period: 13, phase: 0.45,
        lateral: 0.22, hit: 'bump', lead: 1.6, signAt: 88 },
      { at: on('s12', 0.19), kind: 'surge', period: 17, phase: 0.80,
        lateral: -0.22, hit: 'bump', lead: 1.6, signAt: 88 },
    ],
    // The works corners run 1/30 to 1/60 of curvature and the pan's sweeps and
    // kinks 1/140 to 1/220, so a threshold at 1/85 kerbs exactly the five
    // corners a player brakes for and leaves the flat-out three quarters of the
    // lap clean.
    kerbCurvature: 0.0118,

    // ── the kit: a salt works, not a speedway ──────────────────────────────
    //
    // See `KitDef`. Two of the three pieces here exist to keep the *view* open,
    // which is the one thing this circuit has that the other three do not:
    //
    //   * **The jetty.** A timber-piled loading deck crossing the bypass, with
    //     two chutes hanging over the carriageway and a windrow of raw salt on
    //     the deck. Horizontal where the quarry's conveyor climbs, bleached
    //     where it is grey, and standing on piles rather than lattice.
    //   * **The salt wall.** 0.82 metres and no higher. A 1.5m panel run down
    //     3.5 kilometres of lake bed fences in the horizon this whole course is
    //     built around — the same reason `wallHeight` is already 1.1 here.
    //   * **Works blue on white**, on the kerb, the capping and the banner. The
    //     lines go hazard yellow: on the darkest tarmac in the cup under the
    //     brightest ground, white paint is the one colour that disappears.
    kit: {
      arrival: 'jetty',
      barrier: 'seawall',
      kerb: { a: '#1E5FA8', b: '#FFF8F0', pitch: 2.6 },
      paint: '#FFC300',
      chequer: { dark: '#123A63', light: '#FFFFFF' },
      steel: 0x2e6c9e,
      accent: 0xf3f1e8,
      banner: { field: '#F1EFE6', ink: '#1B4E7E', strip: '#2E6C9E' },
    },

    // Almost nothing, and that is the point of a dry lake — but *almost* is
    // load-bearing. The rim is 34m of low swell starting 700 metres out, enough
    // to stop the horizon being a ruled line and nowhere near enough to enclose
    // anything, and the landforms are buttes far enough away to read as scenery
    // rather than as walls.
    //
    // The west leg gets three of its own. Two three-hundred-metre runs with
    // nothing at the end of them is the one part of this circuit a critic
    // photographed and called empty, and a straight on a salt flat is navigated
    // entirely by what is sitting on the horizon at the end of it.
    terrain: {
      rimStart: 700,
      rimEnd: 1600,
      rimHeight: 34,
      landmarks: [
        // Sat on the horizon for the whole of the bypass. You spend the
        // longest straight in the game driving at this.
        { x: 1680, z: 320, radius: 400, height: 205, kind: 'mesa' },
        // Beyond the works, so the chicane and the causeway have something
        // behind them.
        { x: 980, z: -980, radius: 330, height: 175, kind: 'mesa' },
        // A needle out west, past the Pan Sweep and down the whole west leg.
        { x: -1500, z: -260, radius: 220, height: 195, kind: 'spire' },
        // ── the west leg's own skyline ────────────────────────────────────
        //
        // A pair of buttes at the far end of the two long runs, offset from
        // each other so the kink between them swings the horizon across the
        // frame instead of holding one shape dead ahead for six hundred
        // metres, and a low island out on the pan between them and the road so
        // there is something at a *near* distance to measure speed against.
        { x: -1820, z: 620, radius: 360, height: 230, kind: 'mesa' },
        { x: -1240, z: 1280, radius: 300, height: 165, kind: 'mesa' },
        { x: -980, z: 560, radius: 190, height: 62, kind: 'mesa' },
      ],
    },
  },

  theme: {
    // Near-white evaporite, and the highest-value ground in the game by a
    // distance. It is also, through `sunRig()`, the bounce light: a salt pan
    // throws most of the sun back up at whatever is standing on it, which is
    // why the karts here have almost no dark side and why nothing else in the
    // cup can be lit this way.
    // **White, and cold-white.** It was 0xE6E2D2, which is a beige, and a
    // critic photographed the result and asked for *"white evaporite instead of
    // beige haze"* — correctly: `saltpan.paint` in `render/theme.ts` mixes the
    // fresh crust *towards* this value over the whole near field, so a warm
    // anchor turns a lake bed the colour of a beach. Evaporite is a salt, and
    // salt under a cobalt sky is the one ground in this game that has more blue
    // in it than red. The number is also, through `sunRig()`, the bounce light
    // on every kart out here — which is why the machines on this course have
    // almost no dark side, and why that fill has to be white rather than tan.
    ground: 0xf1f0ea,
    // Deep cobalt overhead falling to white at the horizon — the sky of a place
    // with nothing in the air and a lot of light coming back off the ground.
    sky: { top: 0x0d49c4, bottom: 0xecf7ff, horizon: 0xffffff },
    // The clearest air in the cup by a distance. The far plane is 3000m and the
    // haze is set to reach exactly that, so the buttes stay legible and the
    // circuit's own scale is what the distance reads as.
    fog: { color: 0xeef4f8, near: 900, far: 3000 },
    sun: { color: 0xfffdf4, intensity: 3.3, azimuth: 4.05, elevation: 0.58 },
    // Fresh black bitumen on white salt: the highest road-to-ground contrast in
    // the game, which is what keeps a 34m-wide ribbon readable at 60 m/s.
    road: { base: '#1E222C', line: '#FFF8F0', edge: '#FFC300' },
    props: {
      saltpan: true, cones: true, crowds: true,
      windsocks: true, heatShimmer: true, surveyPegs: true,
    },
  },
};

export default saltpanBypass;
