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
  { x: -154, z: -18, heading: 0, y: -0.4, width: 22 },
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
    // The narrowest, tightest corner in the game: 28 metres of radius on 16
    // metres of road, with the gravel cut across its apex.
    { radius: 30, turn: 180, width: 19, y: -28, name: 'T3 THE CRUSHER' },
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
    { radius: 45, turn: -90, width: 21, y: -4, name: 'T9 RAMP RIGHT' },
    { run: 85.5, width: 22, y: -2, name: 'h4' },
    { radius: 45, turn: -90, width: 22, y: -0.4, name: 'T10 GATE SWEEP' },
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
  groundY: -10,
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
      barrier: 'jersey',
      kerb: { a: '#23262E', b: '#F2B705', pitch: 3.2 },
      paint: '#EFE9D8',
      chequer: { dark: '#23262E', light: '#EFE9D8' },
      steel: 0x6d777e,
      accent: 0xf2b705,
      banner: { field: '#2C3038', ink: '#F2B705', strip: '#B9C1C8' },
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
    // "The embankment either side is anchored to its own road" is the whole
    // bug. `terrain.ts` sweeps that skirt **150 metres** either side without
    // ever asking what else is nearby, so on a pit forty-two metres deep and
    // two hundred wide the weighbridge's skirt is a shelf hanging in open air
    // over the pit floor. `tools/underground.mjs` put the chase lens inside the
    // landscape on 51 of 171 samples here, and a player reported it in their
    // own words: *"the screen just went brown above the racer."*
    //
    // It was tempting to answer it in this ledger — flatten the pit until the
    // stack is inside the roughly nine metres a skirt clears — and that is
    // measurably the wrong trade: it costs the quarry its staircase to work
    // around a construction fault in the landscape builder. `unfoldSkirt` in
    // `kit.ts` gives the skirt the answer the field mesh already has instead.
    // The benches stay. See the comment there.
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
    terrain: {
      rimStart: 150,
      rimEnd: 430,
      rimHeight: 52,
      landmarks: [
        // ── the high wall: eleven faces on a ring, footprints overlapping ──
        { x: 980, z: 30, radius: 330, height: 175, kind: 'mesa' },
        { x: 830, z: -470, radius: 300, height: 150, kind: 'mesa' },
        { x: 470, z: -830, radius: 320, height: 195, kind: 'mesa' },
        { x: -30, z: -960, radius: 300, height: 160, kind: 'mesa' },
        { x: -530, z: -800, radius: 330, height: 185, kind: 'mesa' },
        { x: -870, z: -430, radius: 300, height: 205, kind: 'mesa' },
        { x: -980, z: 90, radius: 320, height: 170, kind: 'mesa' },
        { x: -800, z: 590, radius: 310, height: 190, kind: 'mesa' },
        { x: -390, z: 900, radius: 300, height: 155, kind: 'mesa' },
        { x: 200, z: 960, radius: 330, height: 200, kind: 'mesa' },
        { x: 700, z: 690, radius: 310, height: 165, kind: 'mesa' },
        // ── and three stacks standing inside the wall ─────────────────────
        //
        // A wall with nothing in front of it is a backdrop. These are the
        // un-blasted stacks left standing on the pit floor — a different
        // silhouette at a different distance, which is the whole of what makes
        // a landscape read as deep. All three sit past the hero gate.
        { x: -640, z: 250, radius: 130, height: 118, kind: 'spire' },
        { x: 560, z: 430, radius: 140, height: 104, kind: 'spire' },
        { x: 330, z: -560, radius: 120, height: 96, kind: 'spire' },
      ],
    },
  },

  theme: {
    // Rock flour, not sand. See the header: this is both the dust film on the
    // pit floor and the colour of the bounce light on every machine in the
    // race, and at a saturated tan it made a grey pit photograph as a desert.
    ground: 0x9d9a90,
    // A harder, colder sky than the canyon's: deeper at the zenith, and the
    // haze band is mineral dust rather than warm air.
    sky: { top: 0x14549e, bottom: 0xa9c8dc, horizon: 0xd4d1c7 },
    // Half the visibility of Cone Canyon, on purpose — a working pit has its
    // own weather, and it is the reason the far wall reads as far. Pale rock
    // dust: neutral, a touch on the warm side of it, and nowhere near either of
    // the two hazes it has to be told apart from — the canyon's gold and the
    // mountain's blue.
    fog: { color: 0xc7c2b6, near: 230, far: 1300 },
    sun: { color: 0xfff3e0, intensity: 2.85, azimuth: 2.15, elevation: 0.52 },
    // The darkest road in the cup after the saltpan's. The floor is pale, so
    // the tarmac has to carry the contrast — a haul road cut through light
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
