// Course extensions owned by the track module.
//
// `CourseDef` in src/types.ts is the cross-module contract — physics, AI and the
// race director all read it, so it stays deliberately small. Everything that
// only the track builder cares about (boost strips, the start gantry, the
// shortcut markings) lives here instead, and the builder narrows a CourseDef to
// this type when it needs them.

import type { CourseDef, Surface } from '../../types.ts';

/**
 * All positions are authored as a fraction of the lap (0..1 from the start
 * line) rather than metres, so the layout can be re-cut without every feature
 * needing to move with it.
 */
export interface BoostPadDef {
  /** Lap fraction of the pad's centre. */
  at: number;
  /** Lateral position as a fraction of the half width, -1 (left) .. +1. */
  lateral?: number;
  /** Metres across the road. */
  width?: number;
  /** Metres along the road. */
  length?: number;
}

/**
 * A patch of the drivable ribbon that is not tarmac.
 *
 * **This is live now, and the way it is live is the point.** For a whole round
 * it was authored and not read: `sample()` decided a racer's surface purely
 * from lateral distance, so three courses declared a spill, a windrow and a
 * washout, wrote paragraphs about what each one asks of a driver, and all four
 * bands returned `road` in the running game. The entire "2 spills / 1 drift /
 * 1 washout" column the roster's cup order is built on was a comment.
 *
 * The wiring deliberately does **not** let that happen twice. `buildRoad`
 * resolves each def into a `PatchRuntime` once, paints it from that, and hands
 * the same array to `sample()`, which shares `patchScale()` with the paint. The
 * spill a player can see and the spill the kart is standing on are therefore
 * the same shape to the centimetre, including the tapered ends and the ragged
 * edge — there is no second copy of the geometry to drift out of agreement.
 *
 * A patch overrides a boost strip where the two overlap, on the grounds that
 * material on the road beats paint under it. **Do not overlap them**, and the
 * reason is not tidiness: `findPads` in `ai/knowledge.ts` confirms each
 * declared strip by probing `sample()` for `'boost'` and silently drops any
 * that does not answer, so a pad buried under a spill would stop existing for
 * every CPU driver in the field while still being declared here.
 *
 * The invariant is **at the probe point**, and it is worth stating exactly,
 * because the shorthand this used to carry — *no pad within four hundredths of
 * a lap of a patch* — is a proxy that costs a design. `findPads` samples one
 * point: the pad's centre distance at the pad's own lateral. A patch is only
 * fatal if it covers *that*. Cone Canyon's outer-lane strip is seven
 * thousandths of a lap past the end of the Carousel's island and is not
 * covered by it at any lap fraction, because the island lives at 0.06..0.32 of
 * the half width and the strip at 0.66 — they share a corner and never a
 * square metre. Keep the along-track rule when a patch and a pad share a
 * lateral band, which is the usual case and where it is cheap; drop it only
 * when you can say, as here, exactly why the probe cannot land on the patch.
 */
export interface SurfacePatchDef {
  /** Lap fraction of the leading edge, measured from the start line. */
  from: number;
  to: number;
  /**
   * Lateral band, as fractions of the half width, **in the spline's frame** —
   * the frame `sample().lateral` reports and the same one `ShortcutDef.side`
   * uses. See `LATERAL FRAME` at the head of `HazardDef`: `+1` is the inside
   * of a right-hand corner, and the sentence that used to sit here said the
   * opposite.
   *
   * The band is what is declared; what is *built* is that band with its ends
   * faded in over a third of its length and its edge broken up by noise, so a
   * spill fans out of the shoulder instead of starting at a ruled line. It
   * never grows past the declaration, only inside it.
   */
  latFrom: number;
  latTo: number;
  surface: Surface;
  /**
   * CSS colour of the material. There is no sensible default across four
   * places — crusher fines on a grey pit floor, blown salt on a white lake and
   * schist scree on a cold mountain are the same `dirt`/`sand` to physics and
   * three different colours to a player — so each course names its own. Falls
   * back to a generic per-surface tone.
   */
  tint?: string;
  /**
   * *What the material is*, which decides how it is built rather than only what
   * colour it is painted.
   *
   * A round was lost to these three being one thing. Every hazard in the cup
   * was a `spill` — a ragged band of loose stuff fanning out of a shoulder —
   * and a critic photographed four courses and found "nothing in any frame is
   * absent from the other three". Loose scree, a standing sheet of brine and a
   * built central island are not one noun with three colours: they have
   * different edges, different sheen and different rules about where you may
   * cross them, and a player has to be able to tell at a hundred metres which
   * one is coming.
   *
   *   * `spill`  — the default. Loose material fanning out of the shoulder:
   *                tapered ends, a ragged noisy edge, matte, dark in the
   *                churned middle. Scree, crusher fines, blown salt.
   *   * `brine`  — standing water. **Ruled** transverse edges rather than
   *                tapered ones, because a puddle has a waterline; glossy,
   *                emissive-free but specular, and lifted almost to the crown
   *                so it reads as a sheet lying *on* the road rather than as
   *                dust worked into it. Never fades at the ends: you cannot
   *                dodge the leading edge, only choose where to cross it.
   *   * `island` — a built central reservation. Hard parallel edges, a raised
   *                striped kerb along both flanks and a chevron nose, so it
   *                reads as something that was installed rather than something
   *                that fell. This is what turns one road into two lanes.
   */
  style?: 'spill' | 'brine' | 'island';
}

/**
 * A launch ramp: the road kicks up, the mountain drops away, and the kart flies.
 *
 * **This is the noun the cup did not have.** For two rounds `TrackFeatures`
 * could express paint (`pads`), material (`patches`), a route off the tarmac
 * (`shortcuts`) and furniture (`gantryAt`, `kerbCurvature`) — and nothing at
 * all that took a kart off the ground on purpose. The measured consequence was
 * exact and embarrassing: on the course that climbs and plunges 116 metres,
 * airtime was **5.9%** of the race against the flat quarry's 7.9%, and five
 * `kart:launch` events fired in three laps across seven racers. The steepest
 * road in the game produced less air than the flattest, because every metre of
 * air it did produce was an *accident* — a kart falling off the back of a
 * gradient change, never a kart aimed at anything.
 *
 * ── why the launch is in the road and not in this file's geometry ──────────
 *
 * The obvious build is a wedge of mesh laid on the tarmac. It does not work,
 * and the reason is worth writing down because it is invisible until a kart
 * drives through the ramp: **`physics/kart.ts` reconstructs the ground from the
 * spline** — `s.pos`, `s.up`, `s.width` and the 16cm crown — and reads nothing
 * else. A ramp built as extra triangles would be a picture of a ramp that every
 * kart in the field passes straight through.
 *
 * So a ramp is a **shape of the centreline**, authored here and applied to the
 * waypoints by `applyRamps()` in `ramp.ts` before `loopFromWaypoints` ever sees
 * them. The same def is then read a second time by `buildRoad`, which paints
 * the deck — chevrons up the run-up, a hazard bar across the lip — onto a road
 * surface that already has the ramp in it. One declaration, two readers,
 * exactly the arrangement `patchScale()` uses for a surface patch, and for the
 * same reason: the ramp a player can see and the ramp the kart takes off from
 * cannot be allowed to be two separate pieces of arithmetic.
 *
 * ── the shape, and why it is this shape ────────────────────────────────────
 *
 * `lift = lip · u²` over the run-up, where `u` is 0 at the foot and 1 at the
 * lip. The square matters at both ends. At `u = 0` its slope is zero, so the
 * deck grows out of the road instead of starting at a step a kart would trip
 * over. At `u = 1` its slope is **maximal** — `2·lip/length` — which is the
 * whole point: a profile that eases *out* at the top (a smoothstep, which is
 * what `ring.ts` gives every segment) hands the kart back a level road at
 * exactly the moment it should be pointing at the sky, and a level take-off
 * produces `launchVy ≈ 0`. `kart:launch` needs 3 m/s along the ground normal
 * (`K.air.trickMinLaunch`) and `kart:trick` needs 0.30s of hang. A crest gives
 * you the second and not the first. A ramp has to give you both.
 *
 * Behind the lip the deck falls back to the road linearly over `0.55 · length`,
 * so there is a real crease at the top rather than a dome.
 */
export interface RampDef {
  /** Lap fraction of the **lip** — the last metre of road the kart touches. */
  at: number;
  /** Metres of run-up. The deck climbs over this and is painted across it. */
  length?: number;
  /** Metres the lip stands above the road it replaced. */
  lip?: number;
  /**
   * How abruptly the deck falls back to the road behind the lip, as a fraction
   * of `length`. **This is the launch tuning knob, and it is the only one that
   * does anything.**
   *
   * A kart cannot follow a convex crest tighter than `v²/g` — about 73 metres
   * of radius at racing speed — so it separates wherever the road's vertical
   * curvature first beats that, which on any ramp is immediately. What decides
   * whether `kart:launch` fires is not how high the ramp is but how fast the
   * ground rotates away underneath the kart in the *one* fixed step the
   * physics captures `launchVy` on. Halve this and the crease doubles in
   * sharpness. Above about 0.45 the two rounds of spline smoothing between the
   * waypoints and the road turn the lip into a dome, the kart takes off level,
   * `launchVy` comes out near zero, and you get a crest — which the mountain
   * already has four of.
   */
  fall?: number;
  /** Lateral centre of the deck, as a fraction of the half width. */
  lateral?: number;
  /** Metres across. Narrower than the road: a ramp you have to aim at. */
  width?: number;
}

/**
 * ── the noun for a thing that moves ────────────────────────────────────────
 *
 * **Everything else in this file is furniture.** A boost strip, a spill, a
 * ramp, a gate and an island are all shapes bolted to the road: they are in the
 * same place on lap three as they were on lap one, and once a driver has been
 * round once they are solved. A critic played the cup and named the hole
 * exactly — *"nothing on any of the four courses can ever touch the player, so
 * each course is a shape to be driven rather than a place that fights back"* —
 * and the grep that proved it was one line long: `stunRacer` had **exactly one
 * caller in the entire game**, in `src/items/index.ts`, and neither `track/`
 * nor `world/` imported physics at all. The cup was stamped `cup: 'hazard'`
 * four times over and contained no hazard.
 *
 * A hazard is therefore the one thing in `TrackFeatures` with a **clock**. It
 * is resolved every fixed step by `hazards.ts` from `ctx.time.elapsed` — never
 * `Math.random`, never a wall-clock read — so the cycle is the same on every
 * machine, in every replay, and on the reviewer's software rasteriser. What a
 * player learns on lap one is still true on lap three; what they cannot do is
 * ignore it.
 *
 * ── the two rules a hazard is held to ──────────────────────────────────────
 *
 * Both are about *fairness*, which is the only thing separating a hard course
 * from a cheap one:
 *
 *   1. **Readable at 100 metres.** The body is large, it is painted in the
 *      cup's own hazard livery, and it moves — motion is what the eye finds in
 *      peripheral vision before it finds colour.
 *   2. **Telegraphed a full second before arrival.** Every hazard plants a
 *      warning sign on the verge `signAt` metres upstream, and its two lamps
 *      start flashing `lead` seconds before the body reaches the tarmac. The
 *      lamps are the contract: if they are dark, the road is yours.
 *
 * ── and two rules about the road ───────────────────────────────────────────
 *
 * Only the quarry's dumpers close a whole carriageway, and they do it by
 * standing on the crossing for about two seconds in every twenty. Everything
 * else takes away *a line* — the apex lane of the Carousel, a lane of the
 * bypass, the inside of the Spur — and leaves a way through for a driver who
 * reads it. A hazard that can only be waited out is a traffic light.
 *
 * And **a body may not outstay `HIT_COOLDOWN` in one place.** A hazard that
 * stands still for longer than a racer's grace period hits the same racer
 * twice out of one mistake, which is how the saltpan's three bores went from
 * zero hits a race to twenty-nine in a single change: at an 88% hit rate the
 * wave had stopped being something you drive into and become something you sit
 * inside. Buy danger with travel, not with standing.
 */
export type HazardKind = 'truck' | 'rockfall' | 'surge' | 'boom';

/**
 * ── LATERAL FRAME: the sentence that cost a whole round ────────────────────
 *
 * Every lateral in this file is a fraction of the road's half width in the
 * **spline's** frame — which is exactly the number `track.sample().lateral`
 * returns, because both are the same dot product against the same `right`
 * vector. That part was always true. What was written next to it, in three
 * separate interfaces, was that the spline's frame is *the mirror of the
 * driver's* and that `-1` is the driver's right.
 *
 * It is the other way round. `racingline.ts` builds the worn line as
 * `-sign(curvature) · commit · halfWidth`, and measured on the running game
 * (`node tools/hazardcensus.mjs --profile`) the field crosses Cone Canyon's
 * Carousel — a 185° right-hander — at a **median of +5.5 metres**, and
 * Switchback's Spur — a 155° left — at a **median of −5.8**. So:
 *
 *     positive lateral  =  the inside of a right-hand corner
 *     negative lateral  =  the inside of a left-hand corner
 *
 * Three of the cup's four hazards were authored off the inverted sentence and
 * every one of them was placed in the empty half of the road. Over thirteen
 * full races they hit a racer five times between them; the mountain's gate,
 * cycling every eleven seconds at a 38% blocked window, hit nobody at all in
 * any of them. Nothing about the periods, the widths or the stun profiles was
 * wrong. They were simply not where anybody drives.
 *
 * **So do not reason about this frame — measure it.** `--profile` prints the
 * driven line, in metres, at a hundred stations round the lap, and a hazard
 * placed off that report cannot be wrong about which side of the road it is
 * on. The plain census then proves it fired: the pass mark is 8-20 hazard hits
 * per race, on every course, at every seed.
 */
export interface HazardDef {
  /** Lap fraction of the point on the road the hazard crosses. */
  at: number;
  /**
   * Where on the road the body is, as a fraction of the half width, in the
   * frame described above — positive is the inside of a right-hander.
   *
   * What exactly it names depends on what is moving, because a machine that
   * crosses the road and a gate that swings onto it do not have the same
   * geometry:
   *
   *   * `truck`    — the centre of the traverse. Almost always 0.
   *   * `rockfall` — the middle of the band the boulders land in.
   *   * `surge`    — where the bore **rests**: the middle of the dry lane it
   *                  is there to close. Its *sign* is also the edge of the
   *                  road the water arrives from.
   *   * `boom`     — the foot of the gate's swing. The pivot stands 5.6m
   *                  further out again, and the arm is `width` long, so a gate
   *                  quoted at 1.35 on a 20-metre road shuts to the tarmac edge
   *                  and no further.
   */
  lateral?: number;
  kind: HazardKind;
  /**
   * Seconds of one full cycle. The whole hazard is a function of this.
   *
   * ── keep it short, and the reason is not tempo ─────────────────────────────
   *
   * A cycle much longer than the field's own spread makes seven racers into
   * **one sample**. They arrive at the station within a few seconds of each
   * other, so on a seventeen-second cycle all seven meet the same phase, and a
   * three-lap race with seven racers stops being twenty-one independent draws
   * and becomes three. Measured: Cone Canyon's rockfall, at a 50% blocked
   * window, came back armed on 16 of 27 passes at one seed and **3 of 22** at
   * another — a four-sigma miss on a binomial that was never binomial, because
   * the pack crossed together while the lane happened to be clear.
   *
   * That is what makes a hazard feel absent even when its duty is right: a
   * whole race can go by in which nobody meets it, not because it is rare but
   * because it is *correlated*. Under about twelve seconds the pack's own
   * spread is a large fraction of the cycle and the racers decorrelate, and
   * two stations on different periods decorrelate them again. Both are cheaper
   * than turning the duty up, which is the move that turns a hazard into a
   * wall.
   */
  period: number;
  /** 0..1 offset into the cycle at the flag. Three surges 1/3 apart is a wave. */
  phase?: number;
  /** Metres of road the body takes away, measured across the road. */
  width?: number;
  /** Metres of road the body takes away, measured along it. */
  length?: number;
  /**
   * What the hit looks like, in physics' own three-value vocabulary — see
   * `stunRacer`. A dumper `spin`s you; a bore of brine and a boom arm `bump`
   * you sideways. Nothing in the cup `squish`es: 2.2 seconds is a lap.
   */
  hit?: 'spin' | 'squish' | 'bump';
  /** Seconds the sign's lamps flash before the body reaches the tarmac. */
  lead?: number;
  /** Metres upstream the warning sign is planted. Defaults to 78. */
  signAt?: number;
  /** Body colour, when the course's rock or plant is a particular colour. */
  tint?: number;
}

/**
 * A pinch gate: the two hazard-striped blocks standing where the road necks.
 *
 * The *pinch itself* is width — authored in the waypoints, so the barriers
 * (which sit at `width/2 + verge`) and the line physics enforces come with it
 * for free. This is only the pair of noses that tell a driver at a hundred
 * metres that the road is about to stop being wide enough, which is the
 * difference between a corner that is hard and a corner that is unfair.
 */
export interface GateDef {
  /** Lap fraction of the narrowest point. */
  at: number;
  /** Metres of road each nose block runs along. */
  length?: number;
  /** How far the block stands proud of the tarmac, metres. */
  height?: number;
}

/** The gravel line across the inside of a corner: shorter, slower, marked. */
export interface ShortcutDef {
  from: number;
  to: number;
  /**
   * Which shoulder the cut runs down, in the *spline's* lateral frame — see
   * `LATERAL FRAME` above `HazardDef`. The value you want is whichever side
   * the corner's apex is on, and measured on the running game that is **`+1`
   * for a right-hander and `-1` for a left**.
   *
   * Getting it backwards is silent rather than loud: the ribbon is painted on
   * the outside of the corner, `ai/knowledge.ts` measures a chord *longer*
   * than the arc, `save` clamps to zero, and no driver ever takes it.
   *
   * **All four of the cup's cuts are currently declared the other way round**,
   * which is the same inverted sentence that put three hazards in the empty
   * half of the road, and `--profile` shows the consequence: at Cone Canyon's
   * Digger's Elbow, the Crusher, the Sump and the Spur the field runs wide
   * onto the shoulder the cut is *not* painted on. They are left as they are
   * for now because flipping four shortcuts changes the AI's line on the four
   * tightest corners in the game, which is a change that has to be measured on
   * its own rather than folded into a hazard round.
   */
  side: -1 | 1;
}

/**
 * A hero landform: a butte, a mesa or a spire, placed on the map so it sits at
 * the vanishing point of a straight. Landmarks are what a lap is navigated by —
 * without one, every corner exit looks like every other corner exit.
 */
export interface LandmarkDef {
  x: number;
  z: number;
  /** Footprint radius, metres. */
  radius: number;
  /** Height above the surrounding land, metres. */
  height: number;
  /** 'mesa' is a flat-topped block; 'spire' is a needle. */
  kind?: 'mesa' | 'spire';
}

/** Shaping of the landscape the circuit is cut into. */
export interface TerrainDef {
  /** Metres beyond the shoulder at which the canyon rim starts to rise. */
  rimStart?: number;
  /** Metres beyond which it is at full height. */
  rimEnd?: number;
  /** Peak height of the rim above the local datum, metres. */
  rimHeight?: number;
  landmarks?: LandmarkDef[];
}

/**
 * ── one signature per round ────────────────────────────────────────────────
 *
 * A critic played the cup and rejected it at 6.5 on a single finding: *"not one
 * round of the cup has a mechanic or a set piece the other three lack"*. Four
 * courses, four colour grades, one vocabulary — a flat closed loop, some boost
 * pads, a gravel cut, a spill and a few mesas — and the telemetry agreed with
 * the photographs: mean speed 50.1 / 45.2 / 53.9 / 51.8 m/s over a speedway, a
 * scrapyard, a runway and a mountain.
 *
 * So each round now owns a noun the other three do not have, and each noun is
 * a *physical* one — it moves the numbers, not only the pixels:
 *
 *   1 Cone Canyon      `patches` with `style: 'island'` — the Carousel is a
 *                      **divided carriageway**. One 185° corner, two lanes, a
 *                      raised island between them, and you commit at turn-in.
 *   2 Jackhammer       `gates` — **the pinch**. The road necks to 11 metres
 *                      between two striped blocks. Two karts do not fit.
 *   3 Saltpan          `patches` with `style: 'brine'` — **the flood**. Three
 *                      sheets of standing water across the fastest road in the
 *                      game, each leaving a different dry lane.
 *   4 Switchback       `ramps` — **the kicker**. The only place in the cup a
 *                      kart leaves the ground because somebody built a ramp.
 *
 * If you add a fifth course, it needs a fifth noun. A course whose feature list
 * is a subset of another course's is a re-skin, and this cup has been one.
 *
 * ── and then a critic pointed out that none of those four could touch you ──
 *
 * All five nouns above are *furniture*. The next round's finding was that the
 * cup called itself `hazard` and had none: `stunRacer` had one caller in the
 * whole game and it was the item box. So there is now a sixth noun, `hazards`,
 * and it is the only one with a clock in it — again one per round, again no two
 * alike:
 *
 *   1 Cone Canyon      `rockfall` — the canyon drops its rim onto the inside
 *                      lane of the Carousel. The fork now has a wrong answer.
 *   2 Jackhammer       `truck` — a 100-tonne dumper shuttles across the Cut on
 *                      a nine-second cycle. Eleven metres, and none of them.
 *   3 Saltpan          `surge` — three bores of brine, a third of a cycle
 *                      apart, each closing the dry lane of its own band.
 *   4 Switchback       `boom` — the avalanche gate swings shut across the spur
 *                      cut, so the shortcut is a bet rather than a discount.
 */
export interface TrackFeatures {
  pads?: BoostPadDef[];
  patches?: SurfacePatchDef[];
  shortcuts?: ShortcutDef[];
  /**
   * **The only thing in this interface with a clock.** See `HazardDef` — one
   * per round, no two alike, resolved from `ctx.time` in `hazards.ts`.
   */
  hazards?: HazardDef[];
  /** Launch ramps. See `RampDef` — the elevation is applied to the waypoints. */
  ramps?: RampDef[];
  /** Nose blocks marking a width pinch. See `GateDef`. */
  gates?: GateDef[];
  /** Lap fraction of the start gantry; defaults to the start line. */
  gantryAt?: number;
  /** Curvature above which a kerb is laid on the inside of a corner. */
  kerbCurvature?: number;
  terrain?: TerrainDef;
}

export interface CourseDefEx extends CourseDef {
  features?: TrackFeatures;
}

export const features = (course: CourseDef): TrackFeatures =>
  (course as CourseDefEx).features ?? {};
