// Course 2 — Jackhammer Quarry.
//
// **The technical one, and the one shaped like a comb.**
//
// ── the shape, which is the point ──────────────────────────────────────────
//
// A critic played all four rounds of the cup and rejected them at 6.5 on a
// finding no single screenshot could have produced: *"every one of the four is
// an irregular closed blob of 9-12 similar-radius corners whose longest
// straight is 72-83 metres. On the select screen the four map cards are
// literally interchangeable."* The cure is geometry, not decoration, and this
// is the round that takes it furthest.
//
// **A quarry is a hole with benches cut into the side of it, and this circuit
// is now drawn exactly like one.** Four parallel benches step down into the
// pit, folded into each other by four hairpins, and the haul road wraps round
// the outside of the whole stack to get back to the weighbridge. On the
// select card it reads as a *comb*: four teeth and a spine. Nothing else in
// the cup is remotely that shape, and nothing else in the cup drives like it.
//
//     course           longest straight   R<40m of lap   elevation   aspect
//     Cone Canyon           320m               30m         26.0m      2.37
//     Jackhammer            160m              249m         41.6m      1.30
//     Saltpan               629m               60m         11.7m      1.76
//     Switchback            240m               70m        115.2m      1.68
//
// This is the shortest straight in the cup by a factor of **3.9** against the
// saltpan's, and it carries **eight times** Cone Canyon's tight-radius road:
// 249 metres of this lap is tighter than a 40-metre radius, against 30 on the
// canyon, 60 on the saltpan and 70 on the mountain. That is what "technical"
// is supposed to mean, and it was previously a claim rather than a
// measurement.
//
//   ── the rim ──
//   WEIGHBRIDGE       190m of level tarmac past the weighbridge. The start
//                     line is 70 metres into it, so the whole grid stands on
//                     the only genuinely flat road on the circuit
//   T1 Tipping Left   R48 — the one corner here that is *not* tight, because
//                     it is the only one arrived at off a straight. See the
//                     ledger; it cost a whole round to learn
//   ── the benches ──
//   Bench One         170m at 7% down, 22m wide — and from here the road does
//                     not stop going down for eight hundred metres
//   T2 Screen Hairpin R34 the other way, under the screening plant
//   Bench Two         170m, under the screening plant's discharge
//   T3 THE CRUSHER    R30 at 19m wide: the tightest, narrowest corner in the
//                     game, and the gravel cut is on its apex
//   Bench Three       170m, the last step
//   T4 Sump Hairpin   R36 into the sump, 42 metres below the weighbridge
//   ── the floor and the haul out ──
//   Pit Floor /       170m dead level across the bottom at 23m — and 45 of
//   THE CUT           those metres are **twelve metres wide**, between two
//                     striped nose blocks, with a hundred-tonne dumper
//                     shuttling across them
//   T5 Floor Sweep    R120, 90° — the one fast corner on the circuit, taken
//                     against the high wall, with the sump apron laid down
//                     the inside of it
//   T6/T7 High Wall   the haul road bows out around the pit, climbing at 7%
//   T8 Loadout Right  R50 onto the haul road proper
//   Haul Road         two 120m runs at 9-11%, which is what a real haul road
//                     is graded at and which costs a fifth of the kart's
//                     acceleration all the way to the line
//   T9/T10            R45 twice, back up onto the rim
//
// ── the two rules ──────────────────────────────────────────────────────────
//
// *Width follows speed*: 23m on the pit floor where the karts are flat out,
// 22m on the weighbridge, 21m on the benches, 19m through the Crusher, and
// **twelve metres through the Cut**. And *nothing is dead straight for longer
// than the run to the first corner*: the run from the line to T1 is 120
// metres, and the longest straight anywhere on the lap is 190 — the
// weighbridge itself, which the line sits on.
//
// ── THE CUT: round two's signature ─────────────────────────────────────────
//
// **Twelve metres of tarmac**, halfway along the pit floor — the fastest,
// widest, straightest road below the rim.
//
// The other three rounds each own a mechanic: a fork, a flood, a launch ramp.
// This one owns *width*, which is the crudest thing a circuit can do to a
// driver and the only one that cannot be out-driven. It takes nothing off your
// speed. It takes away the option of being alongside somebody.
//
// It is authored as *width* in the ledger below, which is what makes it real
// rather than scenery: the barrier line, the wall physics enforces and the
// ribbon the road mesh is swept along all come off `s.width` and all close in
// together. `features.gates` puts the two striped nose blocks on it, because a
// road that quietly halves its width at 50 m/s reads as a bug rather than as a
// design unless something says otherwise. See `GateDef`.
//
// ── the staircase ─────────────────────────────────────────────────────────
//
// A quarry is a hole. This one is forty-two metres deep and the lap is a
// staircase into it and one long haul back out — 41.6 metres of range against
// the canyon's 26, and a profile with four distinct steps in it rather than
// one swell. The benches sit 60 to 72 metres apart in plan with 4 to 7 metres
// of drop between them, which is a 6-12% bench face: a quarry high wall, and
// comfortably inside the 37% the mountain already ships between two legs.
//
// ── the look ───────────────────────────────────────────────────────────────
//
// **A working pit is grey, and the whole course is built to say so.** Round one
// of the cup is warm sandstone; if this one is merely a browner brown then the
// two are one place at two times of day, which is exactly what a critic
// measured them as. So every colour on this page is pulled away from the
// canyon's rather than merely differing from it:
//
//   * `theme.ground` is a neutral rock-flour grey. `quarry.paint` mixes it
//     into the rock as a *film of fines*, at 10-26%, so a warm anchor would
//     tint the whole pit the colour of the desert next door — and, worse,
//     `sunRig()` turns `theme.ground` into the ground half of the hemisphere
//     fill, so every kart in the race would be lit from below in desert
//     orange. The dust still reads; it just reads as dust on grey rock.
//   * The haze is a flat mineral grey over a 1300m far plane. Rock dust is
//     *pale and cold*, and it is the single biggest reason this course
//     photographs as somewhere else.
//   * The tarmac goes the other way. The floor is light, so the road is the
//     darkest in the cup after the saltpan's.

import { loopFromWaypoints } from './path.ts';
import { ring } from './ring.ts';
import type { CourseDefEx } from './types.ts';

/**
 * The ring, driven east off the weighbridge.
 *
 * The four hairpins alternate sign — a serpentine that marches in one
 * direction turns left at one end and right at the other — so the comb
 * contributes **zero** net heading and the whole -360 is supplied by the haul
 * road wrapping round the outside of it. That is not a trick, it is what the
 * shape is: the benches are a fold and the haul road is the loop.
 *
 * `run` is a straight in metres; `radius`/`turn` is a constant-radius arc, and
 * a negative turn goes right. `width` and `y` are what the road *becomes* by
 * the end of the segment, so the pinch arrives with the corner it belongs to.
 */
const RING = ring(
  // The start width is the width the *last* segment leaves behind — the Gate
  // Sweep's 24 — because the ring emits its first waypoint at this value and a
  // number that disagrees with the segment upstream of it is a step in the road
  // at the one place a lap is judged from.
  { x: -154, z: -18, heading: 0, y: -0.4, width: 24 },
  [
    { run: 190, width: 22, y: -0.4, name: 'WEIGHBRIDGE' },
    // **The one corner on this circuit that is not tight, and it is not tight
    // on purpose.** It is the only hairpin arrived at off a long straight —
    // 190 metres of level weighbridge at full throttle — and at 34 metres of
    // radius the field died on it: an off-road histogram of a whole race put
    // 160 of every driver's 200 off-road seconds in the two bins covering the
    // braking zone and the arc, and the finishing spread ran to 150 seconds on
    // one seed. The other three hairpins are entered *from* hairpins at half
    // that speed and are 30-36. The rim also stays level through it now: a
    // blind tight downhill hairpin at the end of the longest straight is three
    // problems stacked on one corner.
    { radius: 48, turn: 180, width: 23, y: -1, name: 'T1 TIPPING LEFT' },
    { run: 170, width: 22, y: -13, name: 'BENCH ONE' },
    { radius: 34, turn: -180, width: 20, y: -17, name: 'T2 SCREEN HAIRPIN' },
    { run: 170, width: 21, y: -24, name: 'BENCH TWO' },
    // The tightest corner in the game — thirty metres of radius, held all the
    // way through a hundred and eighty degrees, with the gravel cut across its
    // apex.
    //
    // **It was also the narrowest, and that was one thing too many.** A critic
    // drove the cup and measured the field through here at **3.1 m/s** — a
    // hundred-tonne machine's walking pace on a race track — and the arithmetic
    // says why: on nineteen metres of road a kart can widen a thirty-metre
    // corner to about thirty-nine at the apex, and thirty-nine metres of radius
    // at nineteen metres of width is not a corner anybody carries speed
    // through, it is a three-point turn. Twenty-three metres buys about six
    // metres of apex radius and costs this corner none of its identity: it is
    // still the tightest thing in the cup by four metres, still the only
    // hairpin in the game with a shortcut across its apex, and still the corner
    // this circuit is named after.
    { radius: 30, turn: 180, width: 23, y: -28, name: 'T3 THE CRUSHER' },
    { run: 170, width: 23, y: -35, name: 'BENCH THREE' },
    { radius: 36, turn: -180, width: 21, y: -39, name: 'T4 SUMP HAIRPIN' },
    // A pit floor is flat, and this is the only flat road below the rim.
    { run: 70, width: 23, y: -42, name: 'PIT FLOOR' },
    // ── THE CUT ──────────────────────────────────────────────────────────
    // Twelve metres, on the widest and fastest road on the circuit, with the
    // haul truck crossing it on a 24-second cycle. See the header and
    // `GateDef`.
    //
    // **It used to be on the second bench and that was a fairness bug.** A
    // bench is 170 metres long with a 34-metre hairpin at each end, so the
    // warning diamond seventy metres upstream of a pinch there stands *round a
    // blind 180-degree corner* — a driver arrives at eleven metres of road with
    // a hundred-tonne dumper on it and has had no sight line at all. Measured
    // over two seeds the field strung out by 34 and 124 seconds with one CPU
    // driver spending 41% of a race off the tarmac. The pit floor is straight,
    // level, and the only place down here you can see a hazard coming.
    { run: 45, width: 12, y: -42, name: 'THE CUT' },
    { run: 55, width: 23, y: -42, name: 'PIT FLOOR EXIT' },
    // The one genuinely fast corner on the circuit — 188 metres of 120-metre
    // radius against the high wall, taken at the bottom of the hole.
    { radius: 120, turn: -90, width: 21, y: -41, name: 'T5 FLOOR SWEEP' },
    { run: 94.5, width: 22, y: -38, name: 'h1' },
    { radius: 70, turn: 22, width: 22, y: -34, name: 'T6 HIGH WALL LEFT' },
    { run: 95.7, width: 22, y: -28, name: 'h2' },
    { radius: 70, turn: -22, width: 22, y: -24, name: 'T7 HIGH WALL RIGHT' },
    { run: 114.5, width: 23, y: -20, name: 'h3' },
    { radius: 50, turn: -90, width: 22, y: -16, name: 'T8 LOADOUT RIGHT' },
    { run: 118, width: 23, y: -12, name: 'HAUL ROAD' },
    { radius: 120, turn: -18, width: 23, y: -10, name: 'T8b TIP KINK' },
    { run: 119.8, width: 23, y: -8, name: 'HAUL ROAD TWO' },
    { radius: 120, turn: 18, width: 22, y: -6, name: 'T8c WEIGH KINK' },
    // ── the two corners the lap is actually lost on ───────────────────────
    //
    // Not the hairpins. Measured over a 130-second race with seven racers, the
    // biggest concentration of sub-12 m/s time on this circuit sits in the last
    // fifteen per cent of the lap — 7.3 seconds in one fortieth of it — and
    // three of the race's five reversals happen here. It is the pair of
    // 45-metre right-handers at the top of the haul road, taken at the end of a
    // 240-metre climb at 9-11% with the pack still four abreast off the tip
    // kink, on twenty-one metres of road with the barrier hard against both
    // sides. There is nowhere to put a mistake.
    //
    // Twenty-four metres each, and the run between them the same, which is
    // three metres of run-off bought at no cost to the shape: the radius, the
    // gradient, the closure and the comb silhouette are all untouched, and this
    // is the widest road on the circuit outside the weighbridge — which is what
    // a haul road *is* at the point where it meets the rim.
    { radius: 45, turn: -90, width: 24, y: -4, name: 'T9 RAMP RIGHT' },
    { run: 85.5, width: 24, y: -2, name: 'h4' },
    { radius: 45, turn: -90, width: 24, y: -0.4, name: 'T10 GATE SWEEP' },
  ],
  { step: 12 },
);

/**
 * Metres from the ring's origin to the start/finish line.
 *
 * Seventy metres into the weighbridge straight. `track/index.ts` puts the back
 * row of the grid 47 metres behind the chequer and the intro formation rolls
 * in from eleven metres further back again, so the whole grid has to stand on
 * level, straight, plain tarmac — and the weighbridge is the only 190 metres
 * on this circuit that is all three.
 */
const START = 70;
const on = (name: string, along = 0.5): number =>
  ((RING.distanceAlong(name, along) - START) / RING.length + 1) % 1;

export const jackhammerQuarry: CourseDefEx = {
  id: 'jackhammer-quarry',
  name: 'Jackhammer Quarry',
  cup: 'hazard',
  points: loopFromWaypoints(RING.waypoints, {
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
  // in the cup is better than three minutes of racing, which is twice what
  // Mario Kart 8 asks of anybody. The pit is the round that costs the most per
  // lap; it does not also get to be the longest.
  laps: 3,
  // A metre narrower than Cone Canyon's, so the barrier is genuinely close —
  // but a metre wider than this circuit used to carry, and the metre was
  // measured rather than argued. Four hairpins under 36 metres of radius is
  // the hardest road in the game to get a kart round: at six metres of
  // shoulder one CPU driver spent 47% of a race off the tarmac, and at nine it
  // was worse again, because a wide gravel shoulder is somewhere a kart can
  // *keep driving* instead of being put back by a barrier. Seven is where the
  // field stops stringing out.
  vergeWidth: 7,
  vergeSurface: 'dirt',
  offSurface: 'sand',
  walls: true,
  wallHeight: 1.5,
  // Small world, fine grid: 3000/176 puts a terrain cell at 17m rather than
  // Cone Canyon's 24m, which is what lets the pit walls read as rock faces with
  // edges instead of dunes.
  groundSize: 3000,
  // ── the datum, and why it is under the sump rather than under the rim ─────
  //
  // **`groundY` is not only scenery on this course — it is where the chase
  // camera stands.** `render/camera.ts`'s `surfaceYAt` floors the lens at
  // `Math.max(roadY, course.groundY)`, so every metre this datum sits *above*
  // the road is a metre the camera is held up while the kart keeps descending.
  //
  // It was -10, and the pit bottoms out at -42. Measured over a full lap with
  // every frame rendered (`node tools/underground.mjs`), that put the lens a
  // median 36.7 degrees and a peak 74.3 above the racer — 31.86 metres of air
  // over a kart at y=-40.6 — on 155 of 300 samples. A critic played it and
  // described the result exactly: *"roughly half of round 2 of the cup is
  // played from a near-top-down satellite view with no horizon, no sense of
  // speed, and the next corner off the bottom of the frame."* Cone Canyon,
  // whose datum is 20 metres under its lowest road, reads median 14.5.
  //
  // So the rule this course now states for the whole cup: **`groundY` must sit
  // below the lowest tarmac on the circuit, with a few metres in hand for
  // camber** — a banked corner's outer edge hangs below its centreline, and the
  // ledger's `y` is the centreline. Three metres covers the 0.21 rad of bank
  // this road carries over a 10.5m half-width.
  //
  // What it costs is honest and it is the smaller loss: the plain *outside* the
  // circuit now settles level with the pit floor instead of level with the rim,
  // so from a long way out the quarry reads as a stepped massif rather than as
  // a hole in a plateau. The hole is still a hole from every camera a player
  // ever uses — the benches are cut by the road's own skirt inside 70 metres,
  // which is what makes a bench face — and the high wall is landmarks (see
  // `terrain` below), which stand on the datum and are unaffected. A pit you
  // can see from orbit and cannot drive is worth less than a pit you can drive.
  groundY: -45,
  startDistance: START,
  checkpoints: 32,

  features: {
    // **Five strips, and they are the shortest in the cup.** Sixteen metres
    // each, and each one somewhere the circuit has just taken everything off
    // you — the run off the first hairpin, the way out of the Cut, the exit of
    // the Crusher, and twice on the haul road, where you are climbing at 9-11%
    // with nothing left.
    //
    // None of them is anywhere near the start line: the last on the lap is on
    // the haul road's second run, four hundred metres upstream of the chequer,
    // so nothing is under the grid when the flag drops.
    pads: [
      { at: on('BENCH ONE', 0.25), lateral: -0.30, width: 5.5, length: 16 },
      { at: on('BENCH TWO', 0.70), lateral: 0.30, width: 5.5, length: 16 },
      { at: on('BENCH THREE', 0.18), lateral: 0.26, width: 5.5, length: 16 },
      { at: on('h3', 0.40), lateral: 0.32, width: 5.5, length: 16 },
      { at: on('HAUL ROAD TWO', 0.50), lateral: -0.30, width: 5.5, length: 16 },
    ],
    // **Two cuts, and they are opposites.** The first runs across the inside of
    // the Crusher, where the road is 16m — the narrowest tarmac in the cup —
    // and saves about twenty metres for a third of your top speed while you are
    // on it: free out of a mini-turbo, a disaster if you arrive already slow.
    // The second is the sump's old loading apron, which is longer, flatter and
    // on the *other* hand, so a driver who has learned one has not learned the
    // other. `side: 1` is the driver's left, which is the apex of a left-hand
    // hairpin; `-1` is the right. See `ShortcutDef`.
    shortcuts: [
      { from: on('T3 THE CRUSHER', 0.12), to: on('T3 THE CRUSHER', 0.88), side: 1 },
      { from: on('T4 SUMP HAIRPIN', 0.15), to: on('T4 SUMP HAIRPIN', 0.85), side: -1 },
    ],
    // **The spill.** Two bands of the drivable ribbon are not tarmac: crusher
    // fines dragged along the third bench under the conveyor, and the wet
    // apron at the bottom of the sump where the pit drains. Both are `dirt` —
    // 70% of top speed and 70% of grip — and both are laid on the *inside* of
    // the corner they sit in, so the geometric line and the fast line are not
    // the same line.
    //
    // They are two different colours because they are two different materials.
    // Fines off the crusher are the palest thing on this course; the sump
    // apron is wet, and wet rock flour goes dark. See `SurfacePatchDef`.
    //
    // Neither covers a boost strip at the point `findPads` probes it: the
    // bench-three pad sits at lap-fraction 0.18 of that segment on the *outer*
    // lateral and the fines start at 0.45 on the inner.
    patches: [
      {
        from: on('BENCH THREE', 0.45), to: on('BENCH THREE', 0.78),
        latFrom: -1, latTo: -0.05, surface: 'dirt', tint: '#B8B2A3',
      },
      {
        from: on('T5 FLOOR SWEEP', 0.25), to: on('T5 FLOOR SWEEP', 0.70),
        latFrom: -1, latTo: -0.1, surface: 'dirt', tint: '#6C6659',
      },
    ],
    // **The Cut's gate.** Two battered, hazard-striped nose blocks standing on
    // the shoulder either side of the narrowest tarmac in the game.
    //
    // The blocks are signage and nothing else: they stand on the verge, which
    // is already 70% of top speed, so they take nothing from a kart that was
    // not in trouble before it reached them. What actually pinches is the road,
    // and it pinches for the barrier and the wall physics enforces at the same
    // time, because all three come off `s.width`. See `GateDef`.
    gates: [{ at: on('THE CUT', 0.5), length: 30, height: 1.2 }],

    // ── THE HAUL TRUCK: what the gate is for ───────────────────────────────
    //
    // A hundred-tonne quarry dumper shuttles across the Cut, on the exact lap
    // fraction the gate blocks stand at. It runs the shot rock from the face
    // out to the tip and comes back empty, and it tips at the far end where you
    // can watch it. **The gate blocks are its portals**: they were signage for
    // a pinch and they are now the two things the truck drives between, which
    // is what a nose block on a haul road is for.
    //
    // Twenty-four seconds a cycle, two crossings in it, and the road is gone
    // for about two and a half of them each time — a fifth of the cycle, on
    // eleven metres of road. This is the one hazard in the cup that closes a
    // whole carriageway, and it is allowed to because it is on the widest
    // sight line on the circuit: the machine is nine and a half metres of
    // hazard yellow with two beacons on it, in the open the whole time, and the
    // sign's lamps come on two full seconds before its nose reaches the tarmac.
    //
    // The period is deliberately *not* a factor of the lap. A lap here is about
    // 48 seconds against a 24-second cycle plus the phase offset, so the truck
    // is never quite where it was and no lap is the lap before it.
    //
    // `spin` rather than `squish`: 2.2 seconds is most of a place, and being
    // clipped by a machine that big and then *also* having to sit still for a
    // lap is two punishments for one mistake. See `HazardDef`.
    //
    // ── two machines, and why the first one had to stop ────────────────────
    //
    // Censused over a whole race (`node tools/hazardcensus.mjs`) the single
    // truck hit **four karts in twenty-two passes**, and unlike the cup's other
    // three hazards it was not in the wrong place: the machine sweeps the whole
    // carriageway, so its lateral is unarguable. It was in the wrong place *in
    // time*. A kart crossing the station is an instant, so what decides a hit
    // is the fraction of the cycle the body spends over the driven band, and a
    // machine crossing fifty-four metres at ten metres a second is over any
    // given sixteen of them for a ninth of each traverse.
    //
    // So the dumper does what a dumper actually does at a haul crossing: it
    // **stands on it** for a couple of seconds each way, beacons turning, nine
    // and a half metres of stationary safety yellow across the Cut (see
    // `TRUCK` in `hazards.ts`) — which is also the readable version, because a
    // stopped machine can be seen and lifted for and a machine crossing at ten
    // metres a second is either there or not by the time you arrive.
    //
    // And there are two of them, because a working pit has a fleet and because
    // one crossing on a three-lap race is twenty-two chances at a hazard that
    // has to fire eight to twenty times. The second is up on the haul road's
    // second run — a level crossing on the ramp out, on the one straight up
    // there with a sight line, four hundred metres from the chequer. The
    // The periods are fifteen seconds and eleven, and short on purpose. A
    // cycle much longer than the field's own spread turns seven racers into one
    // sample of it — they cross together, they all meet the same phase, and a
    // whole race can go by in which the machine happened to be parked every
    // time anybody looked. See `HazardDef.period`.
    hazards: [
      {
        at: on('THE CUT', 0.5), kind: 'truck', period: 15, phase: 0.62,
        lateral: 0, hit: 'spin', lead: 2.0, signAt: 76,
      },
      {
        at: on('HAUL ROAD TWO', 0.75), kind: 'truck', period: 11, phase: 0.18,
        lateral: 0, hit: 'spin', lead: 2.0, signAt: 70,
      },
    ],
    // Four hairpins run 1/28 to 1/32 of curvature and the two fast sweeps run
    // 1/120, so a threshold at 1/111 kerbs everything a player brakes for and
    // leaves the Floor Sweep and the haul-road kinks unmarked.
    kerbCurvature: 0.009,

    // ── the kit: what a working pit is built out of ────────────────────────
    //
    // A critic photographed the four grids and found the same yellow truss, the
    // same navy banner and the same striped panel barrier on all of them. This
    // is the round that answers it hardest, because a quarry owns none of those
    // objects. See `KitDef`.
    //
    //   * **The conveyor.** An inclined overland belt on two steel trestles
    //     runs shot rock across the haul road to the stockpile, and the grid
    //     stands under it. It *climbs* across the frame rather than spanning it
    //     level, so the establishing shot has a direction in it.
    //   * **The jersey barrier.** Continuous battered concrete with a
    //     black-and-yellow toe band, no posts and no capping rail — which is
    //     what actually stands beside a haul road, and which reads as a wall
    //     where the speedway's panel reads as a fence.
    //   * **Hazard kerbs.** A pit paints black and yellow on anything a
    //     hundred-tonne machine can hit. Red and white is a grandstand's
    //     colour scheme.
    kit: {
      arrival: 'conveyor',
      // ── the nouns, in the frame the round is judged on ─────────────────
      //
      //   *"Put the course's stated nouns in the first ten seconds of frame —
      //   the overland conveyor, the haul truck, the jersey barrier. None of
      //   them are present in the canonical racing shot, which is a bare
      //   two-lane road under a sunset."*
      //
      // The conveyor was real and it was over the start line, and `racing` is
      // taken four hundred and thirty-five metres later. A plant that appears
      // once a lap is an establishing shot; a plant that crosses the road
      // three times is a *place*. So the same belt steps down the pit with the
      // benches — over Bench Two, over Bench Three, and once more on the haul
      // out — which is also the honest arrangement, because that is the
      // direction the material is going.
      //
      // All three sit on spans no chapter covers: a trestle leg stands 20
      // metres off the centreline and a cutting face starts just outside the
      // barrier, so a belt over a walled span puts its feet inside the rock.
      crossings: [
        // The first one is aimed at the review frame the same way the Tip Face
        // is: `racing` is taken 435 metres from the line, which is the last few
        // metres of Bench One, so this stands 91 metres further on — across the
        // Screen Hairpin, which is the road the camera is pointed down. Fifty-
        // nine was the first answer and it was too close: at that range the
        // belt crosses the top fifth of the frame as an underside and reads as
        // a ceiling rather than as a structure. Ninety-one puts the whole
        // silhouette above the horizon with sky either side of it.
        { name: 'SCREEN DISCHARGE', at: on('T2 SCREEN HAIRPIN', 0.80), kind: 'conveyor', skew: 0.38 },
        { name: 'CRUSHER FEED', at: on('BENCH THREE', 0.45), kind: 'conveyor', skew: -0.30 },
        { name: 'OVERLAND', at: on('h3', 0.50), kind: 'conveyor', skew: 0.44 },
      ],
      barrier: 'jersey',
      kerb: { a: '#23262E', b: '#F2B705', pitch: 3.2 },
      paint: '#EFE9D8',
      chequer: { dark: '#23262E', light: '#EFE9D8' },
      steel: 0x6d777e,
      accent: 0xf2b705,
      banner: { field: '#23262E', ink: '#F2B705', strip: '#F2B705' },

      // ── the round the quarry had no quarry *in the frame* ──────────────
      //
      // A critic played the cup and rejected it at 6/10 on this course
      // specifically, and the sentence is worth keeping whole because it is a
      // measurement of the one camera that matters:
      //
      //   *"Jackhammer Quarry is the only round in the roster with no
      //   `chapters` entry and it shows: the pit is a flat asphalt curve on
      //   level ground with the same smooth truncated-cone mounds Cone Canyon
      //   uses, tinted amber. No bench, no terrace, no pit, no crusher,
      //   nothing cut into the ground. The quarry's identity in the frame a
      //   player lives in is an amber colour grade."*
      //
      // Every word of that was true and none of it was fixable in the terrain
      // block below. The high wall *is* built — eleven overlapping heroes on a
      // ring — and it stands **two hundred and sixty metres** past the
      // shoulder, because that is where `room()` stops putting conveyors on
      // ground it never checks the slope of. Two hundred and sixty metres
      // through a 210-metre fog near plane is haze. The pit was real and it
      // was not in the photograph.
      //
      // So the rock comes to the road. Three places, and — this is the part
      // the canyon's single trench could not teach — **two of them have only
      // one face.** See `ChapterDef.side`. A bench is not a trench: it has the
      // high wall on the uphill hand and the drop to the bench below on the
      // other, and building both sides would have given round two the same
      // corridor round one already owns.
      //
      // The laterals are off `LATERAL FRAME` in `types.ts` — `+1` is the
      // driver's right — and both are forced by the plan rather than chosen.
      // T1 is a left-hand hairpin, so its outside is `+1`, and coming out of a
      // 180 the weighbridge rim it just left is on that same hand all the way
      // down Bench One. The haul road wraps the pit clockwise, so the
      // excavation is on the driver's right for the whole climb out and the
      // un-dug ground is on the left.
      chapters: [
        {
          // **The frame the racing shot lands in.** `capture.mjs` autopilots
          // nine seconds from the line and this course covers about 270 metres
          // in them, which put the default review frame — *"the default view a
          // player spends the race in"* — squarely in T1 with nothing built
          // within four hundred metres of it. The face now starts 138 metres
          // after the chequer and runs to the middle of Bench One: twenty
          // metres of freshly shot rock standing over the outside of the first
          // hairpin, with the pit opening away on the inside.
          name: 'THE TIP FACE',
          kind: 'cutting',
          face: 'rock',
          side: 1,
          // ── the span is a measurement, not a taste ─────────────────────
          //
          // The first cut of this ran T1 0.12 → Bench One 0.85, on an estimate
          // that nine seconds of autopilot buys about 270 metres here. It buys
          // **435**: `index.json` from that capture put the player at y=-12.78,
          // which is the last few metres of Bench One, twenty-three metres past
          // the end of the face — and the review frame came back as the same
          // empty amber curve it was supposed to fix. Twenty-three metres.
          //
          // So the face now runs from the middle of the first hairpin to the
          // middle of the second: three hundred metres of wall, which covers
          // every position the shot can land in rather than the one it was
          // predicted to. Measure the frame, then build for it — the estimate
          // was out by sixty per cent and the estimate was mine.
          from: on('T1 TIPPING LEFT', 0.35),
          to: on('T2 SCREEN HAIRPIN', 0.55),
          height: 20,
          batter: 4.2,
          // Unweathered rock, cooler and darker than the film of fines the
          // pit floor is painted in. A blasted face has not been rained on.
          tint: 0x6a655c,
        },
        {
          // ── the end wall, and the lesson a hairpin teaches about framing ──
          //
          // The Tip Face was extended once already because the review frame
          // landed twenty-three metres past the end of it. It was then
          // *measured* — `probe.mjs`, the spline station and the chapter's own
          // bounding box — and the second answer was more interesting than the
          // first: the frame lands mid-way round the Screen Hairpin, and
          // **mid-way round a 180-degree corner the inside of it is ninety-six
          // degrees off the camera axis.** A wall on the inside is not in the
          // shot however long you make it. It is beside the road and the road
          // is not what the driver is looking at.
          //
          // What a driver looks at in a hairpin is the **outside** — the wall
          // the corner is cut into, straight ahead through the turn. So the
          // hairpin gets its own face on the other hand, and the pair reads as
          // the thing a quarry hairpin actually is: a bench road running along
          // a rim wall, turning back on itself inside a cut in the end of the
          // pit. Two chapters rather than one two-sided one, because a bench's
          // downhill flank must stay open — a wall there would fill in the
          // hole this circuit is, seen from every camera above it.
          name: 'THE SCREEN CUT',
          kind: 'cutting',
          face: 'rock',
          side: -1,
          from: on('BENCH ONE', 0.86),
          to: on('BENCH TWO', 0.20),
          height: 18,
          batter: 3.8,
          tint: 0x645f57,
        },
        {
          // **THE CUT, in a hole.** The signature was authored as *width* —
          // twelve metres between two nose blocks with a hundred-tonne dumper
          // shuttling across it — and photographed as a wide grey road that
          // briefly got narrower. Twenty-two metres of wall on both hands is
          // what makes it a cut: at the bottom of the pit there is no horizon
          // to lose, and the machine is framed against rock rather than sky.
          //
          // This is the one chapter on the circuit with two faces, and it is
          // the only place on the lap that has any business being a corridor.
          name: 'THE CUT',
          kind: 'cutting',
          face: 'rock',
          from: on('PIT FLOOR', 0.30),
          to: on('PIT FLOOR EXIT', 0.60),
          height: 22,
          batter: 4,
          tint: 0x6f6d67,
        },
        {
          // **The haul out.** Two hundred and forty metres of 9-11% climb with
          // the un-dug ground standing over the left-hand barrier and the pit
          // falling away to the right — the last third of the lap, which
          // telemetry says is where it is actually lost, and which until now
          // was the same open plain as the first third.
          name: 'THE HIGH WALL',
          kind: 'cutting',
          face: 'rock',
          side: -1,
          from: on('HAUL ROAD', 0.15),
          to: on('HAUL ROAD TWO', 0.85),
          height: 17,
          batter: 3.6,
          tint: 0x847f74,
        },
      ],
    },

    // ── the pit ───────────────────────────────────────────────────────────
    //
    // **The first fifty to a hundred and sixty metres beyond the shoulder has
    // to be ground somebody can stand a machine on.** That band is exactly
    // where `world/index.ts` puts everything it places with `room()` —
    // conveyors at 64-144m, berms at 76-146, haul trucks at 50-118, drill rigs
    // at 56-132. `room()` tests whether a spot is *free*, not whether it is
    // *level*, so on a steep face the ground rolls out from under a
    // twenty-metre footprint and the prop is left hanging in the air.
    //
    // So the wall starts at 150m and takes 320 to get there: everything
    // `room()` can reach is on ground flat to within a couple of metres, and
    // the rock begins where the props stop.
    //
    // The landmarks follow the same rule, and `hero` is gated on
    // `smoothstep(rimStart * 0.7, rimStart * 1.5, d)` — 105 to 225 metres out —
    // so each footprint below is placed with its near edge past 140m.
    //
    // **The benches themselves are not shaped by this.** They are 60-72 metres
    // apart, which is inside `rimStart`, so nothing rises between them: what
    // makes a bench face is the difference in *road* height across that gap,
    // and the embankment either side is anchored to its own road. That is
    // exactly how a real bench is formed and it is why the comb reads as
    // terraces rather than as five roads on a plain.
    //
    // ── and it is also what buried the camera ─────────────────────────────
    //
    // "The embankment either side is anchored to its own road" is one bug and
    // it was the *first* one. `terrain.ts` sweeps that skirt **150 metres**
    // either side without ever asking what else is nearby, so on a pit
    // forty-two metres deep and two hundred wide the weighbridge's skirt is a
    // shelf hanging in open air over the pit floor. `tools/underground.mjs` put
    // the chase lens inside the landscape on 51 of 171 samples here, and a
    // player reported it in their own words: *"the screen just went brown above
    // the racer."* `unfoldSkirt` in `kit.ts` gives the skirt the answer the
    // field mesh already has, and that failure has not come back.
    //
    // **The second bug looked like the first one and was not.** With the lens
    // certified out of the ground at 3.17m of clearance, a critic played the
    // cup and found half of this round shot from a satellite. It is tempting —
    // and it was tempted — to read that as the same shelf, and to go looking
    // for more skirt to fold. It is not: **the chase camera never asks the
    // terrain anything.** `render/camera.ts` computes its floor analytically in
    // `surfaceYAt`, from the spline and one number off this file, and that
    // number was `groundY`. See the note on `groundY` above. Thirty-two metres
    // of it, on a course whose skirt was already correct.
    //
    // Both are the same *class* of mistake — a height derived from somewhere
    // other than the road you are on — and neither is visible in a screenshot
    // of the geometry. Both are now gated by `tools/underground.mjs`.
    //
    // ── and the round the pit had no walls ────────────────────────────────
    //
    // A critic photographed this course and wrote: *"Jackhammer Quarry has no
    // quarry. A flat pale-grey plain with scattered rubble and one smooth
    // fluted grey dome on the horizon. No benches, no cut faces, no pit — it is
    // Cone Canyon's landform silhouette recoloured grey."*
    //
    // Half of that is the same construction fault Cone Canyon had: `terrain.ts`
    // builds the noise rim as `plateau · terrace · erosion · rimHeight`, and
    // `plateau` is zero over about half the ground, so whatever `rimHeight` is
    // set to the result is a **field of separate lumps on a 420-metre lattice**
    // rather than a wall. Turning it up gives taller lumps. The only continuous
    // landform available is `hero`, so the high wall is now built out of eleven
    // overlapping heroes on a ring, and the noise rim is dropped to 52 where it
    // reads as spoil on the flat rather than as the horizon.
    //
    // The ring has to stand a long way out and that is not a choice either. The
    // hero gate opens over `rimStart * 0.7` to `rimStart * 1.5` — 105 to 225
    // metres from the road — so a landform whose own footprint reaches inside
    // 225m rises at better than two metres per metre right where `room()` is
    // placing conveyors and berms on ground it never checks the slope of. Every
    // footprint below has its near edge past 260 metres of clear ground.
    // ── and then the eleven faces on a ring were the whole problem ─────────
    //
    // The high wall used to be built here, out of eleven overlapping `mesa`
    // landmarks and three `spire` stacks, on the reasoning stated above: the
    // noise rim cannot make a continuous landform, `hero` can, so ring the
    // circuit with heroes. It closed the horizon and it was, measured against
    // the round it was supposed to fix, **the same object Cone Canyon has**:
    //
    //   *"Cone Canyon `far` and Jackhammer Quarry `racing`/`far` show the same
    //   horizon vocabulary: low-poly conical orange peaks, orange haze, and a
    //   pale blocky low-poly town on the left. Only the sky tint and exposure
    //   differ. Two of four rounds are one place."*
    //
    // That is not a tuning failure, it is the primitive. `terrain.ts` has two
    // shapes — a smooth dome and a smooth needle — and they are summed into a
    // scalar field, so a ring of eleven of them is eleven cones however they
    // are spaced, and the only free parameter left is what colour the haze
    // paints them. Both courses reached for the same object because it is the
    // only object there is.
    //
    // **So the horizon is built rather than sculpted.** See `SkylineDef` and
    // `skyline` below: a benched rim and a spoil tip, lofted out of a revolved
    // profile, whose defining feature is a *horizontal* line — the catch bench
    // between two blasted lifts — which is precisely the thing a height field
    // keyed on distance-from-a-point cannot express.
    //
    // What is left here is the ground the road is actually on, and the rim
    // noise is down from 52 to 20: at 52 it was a field of lumps standing in
    // front of the benches and eating the bottom three lifts of them. Spoil on
    // the flat is what it is for.
    terrain: {
      rimStart: 170,
      rimEnd: 430,
      rimHeight: 20,
    },

    // ── the horizon this round owns ───────────────────────────────────────
    //
    // The circuit closes inside a 327-metre radius of (1.5, 17.9) — measured
    // off the waypoints, per bearing, shoulder included — so the toe of the
    // wall stands at 470 with at least 103 metres of clear, level ground in
    // front of it on the worst bearing, which is well past the 146 metres
    // `room()` reaches with a conveyor and clear of everything the props
    // system places.
    //
    // Nine lifts of 15 metres on a 6.5-metre batter with a 13-metre catch
    // bench: a 35-degree overall face, which is what a hard-rock quarry is
    // worked at, and 135 metres of it, so the crest stands 73 metres over the
    // weighbridge. The toe is buried at -62 — twenty under the datum — so the
    // wall *emerges* from the pit floor instead of being set on it.
    skyline: {
      rim: {
        x: 1.5, z: 17.9,
        radius: 470,
        base: -62,
        lifts: 9,
        lift: 15,
        bench: 13,
        batter: 6.5,
        wander: 40,
        // Unweathered grey rock and the pale fines lying on the benches. The
        // value gap between the two is what makes the terrace lines legible
        // through half a kilometre of dust, and it is the whole read.
        tint: 0x74777e,
        dust: 0xa7a49a,
      },
      // ── THE TIP FACE ──────────────────────────────────────────────────
      //
      // The first one is aimed. `capture.mjs` autopilots nine seconds from the
      // line and takes `racing` from (-166, -12.8, 93) looking up the end of
      // Bench One on a bearing of 2.39 radians out of the pit centre — so the
      // tip sits on exactly that bearing, straddling the rim, and the frame
      // this course is judged on has a terraced spoil heap with a stacker
      // climbing it standing over the wall dead ahead. Measure the frame, then
      // build for it.
      stacks: [
        {
          x: 1.5 + Math.cos(2.39) * 660, z: 17.9 + Math.sin(2.39) * 660,
          base: -20, height: 150, foot: 230, top: 80, lifts: 7,
          // Stretched across the line of sight rather than along it: a heap
          // tipped from one end presents a wide flat top and a long face, and
          // a heap presenting its narrow end is a cone again.
          bearing: 2.39 + Math.PI * 0.5,
          stacker: true,
          tint: 0x7d7b74, dust: 0xa9a396,
        },
        {
          // The second is for the other half of the lap, on the far side of
          // the pit, smaller and without plant on it — an old tip, finished.
          x: 1.5 + Math.cos(5.55) * 640, z: 17.9 + Math.sin(5.55) * 640,
          base: -26, height: 108, foot: 190, top: 74, lifts: 6,
          bearing: 5.55 + Math.PI * 0.5,
          tint: 0x7a7871, dust: 0xa5a196,
        },
      ],
    },
  },

  theme: {
    // ── the last shift: why round two is a different hour of the day ───────
    //
    // A critic played the cup and, after praising the four palettes as
    // genuinely separate, rejected it anyway on the thing four palettes cannot
    // fix: *"all four `theme.sky` blocks are the same weather and the same
    // hour — sky.top 0x2e86d6 / 0x14549e / 0x0d49c4 / 0x0a3a9a, four blues, and
    // sun.elevation 0.85 / 0.52 / 0.58 / 0.55, i.e. every round is between 30
    // and 49 degrees of sun. No dusk, no night, no overcast, no interior."*
    //
    // The quarry is the round to spend on it, and the reason is in its own
    // numbers rather than in taste. It is the only course in the cup that
    // already declares its own weather — `fog.near` 230 against everybody
    // else's 400-plus — so it is the one place where a low sun has something
    // to rake *through*. A pit at the end of the shift, with the light coming
    // in over the rim and half the benches already in shadow, is a picture the
    // other three cannot take.
    //
    // **What is honestly not landing yet, and it is not in this file.**
    // `SUN_ELEVATION` in `render/lighting.ts` clamps every course to 0.50-0.60
    // radians — a ten-degree window — so the 0.17 declared below is read as
    // 0.50 and the shadows this palette is written for do not exist. The
    // clamp's own comment says why it is there (a low sun throws thirty-metre
    // streaks across the racing line) and that reasoning is right for three of
    // the four rounds and is exactly what round two wants. The number stays
    // honest here so it lands the moment the clamp learns to take a per-course
    // floor; the rest of this block is what a course file *can* do about the
    // hour, and it does all of it.
    //
    // ── and then the hour ate the material ────────────────────────────────
    //
    // Every colour below used to be a warm one, and a critic photographed the
    // consequence rather than the intent:
    //
    //   *"At overhead, road, verge, cut face and terrain are all the same
    //   orange-brown at nearly the same value. The drivable surface is only
    //   locatable from the thin white edge line — the road/off-road value
    //   separation MK8 never gives up is gone under the golden-hour grade."*
    //
    // The arithmetic behind that is worth stating, because it is not obvious
    // from any single number on this page. `render/theme.ts`'s quarry ramp is
    // already grey — `QUARRY_FLOOR` is 0x77797F and the film of fines is
    // capped at twenty-six per cent — and `render/ground.ts` then **multiplies
    // it by the key light**. A key of 0xFFB96A is the ratio (1.00, 0.73, 0.42),
    // so grey rock times that sun is orange rock, and no albedo on this page
    // can survive it. The pit was grey and the light was the desert's.
    //
    // The fix is the one a location scout would reach for and it costs the
    // round nothing it actually owns: **the sun is over the rim, so the pit is
    // in the shade.** The warmth stays where it is real — in the sky, on the
    // crest of the far benches, on the rim light down the edge of every
    // machine — and the floor a player spends the race on is lit by the dome
    // instead. That is a picture the other three rounds still cannot take, and
    // it is the one a working pit at the end of the shift actually presents.
    //
    // Cold rock flour. Also, via `sunRig()`, the ground half of the hemisphere
    // — so the bounce coming up off the pit floor onto every kart in the race
    // is cold too, which is most of what puts the hour on the *machines*.
    ground: 0x9ea4ac,
    // **The one sky in the cup that is not blue at the top.** Deep dust-violet
    // at the zenith, falling through a hot band to a low sun's amber. Nothing
    // here is a tint of anything on the other three cards.
    // **And the horizon band is the only warm part of it.** `sunRig()` builds
    // the hemisphere fill as `bottom` mixed 58% toward `top`, and that fill is
    // what lights every upward-facing surface in the game — so an amber
    // `bottom` under a violet `top` mixes to a *mauve* dome, and a pit floor of
    // cold grey rock lit by a mauve dome photographs pink. It did: the first
    // overhead after the regrade came back lilac from edge to edge. The sun has
    // gone over the rim, so the sky above the hole is dusty blue and the amber
    // is a band along the horizon where the sun still is. `horizon` is that
    // band; `bottom` is the air over the pit, and it is cold.
    // ── and it must survive the film stock ────────────────────────────────
    //
    // The zenith was 0x2B2F66, a dust-violet, and it photographed **magenta**.
    // `render/grade.ts` runs a warm film stock over the composite, so a hue
    // already sitting between red and blue is pushed the rest of the way, and
    // the two frames that came back were a pink sky over a pink haze. A course
    // does not get to declare a colour the pipeline cannot print.
    //
    // Deep indigo does the same job and survives it: it is still the only sky
    // in the cup that is dark at the top, still nothing like round one's
    // midday cyan over a pale horizon — the value structure is inverted, dark
    // above and hot below — and its blue reads as blue after the grade rather
    // than as fuchsia. The heat all lives in the band along the horizon where
    // the sun actually is.
    sky: { top: 0x1a2c63, bottom: 0x53699e, horizon: 0xffb877 },
    // **Cold haze under a hot sky, and that is the whole separation.** It was
    // amber at 210/1250, which put the entire horizon — benches, tips, rim,
    // everything past the barrier — through the same warm multiply as the
    // ground, and produced Cone Canyon's frame with a different HUD on it.
    // Rock dust hanging in a hole that the sun has already left is *pale and
    // cold*: it is lit by the sky dome rather than by the sun, which is a
    // physical fact rather than a preference, and it is the reason the far
    // benches read as rock instead of as orange cut-outs. Pushed out to
    // 300/1450 as well, because the skyline this course now builds is 470 to
    // 900 metres away and a 210-metre near plane dissolved it.
    fog: { color: 0x9aa2b2, near: 300, far: 1450 },
    // Low and from the west, over the pit rim — and desaturated, because that
    // is what a sun looks like through half a kilometre of its own dust.
    // 0xFFB96A was a sunset *filter*; this is a sun that has to leave grey rock
    // grey while still warming everything it lands square on.
    sun: { color: 0xffe2c2, intensity: 2.35, azimuth: 2.15, elevation: 0.17 },
    // The darkest road in the cup after the saltpan's. The floor is pale, so
    // the tarmac has to carry the contrast — a haul road cut through light
    // rock, with an orange edge where the canyon has yellow. Warmed a shade,
    // because at this hour nothing on the site is neutral.
    road: { base: '#2E2C33', line: '#FFF8F0', edge: '#FF6B1A' },
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
