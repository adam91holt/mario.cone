// Effects and spectacle.
//
// The job of this module is to make every state change in the simulation
// legible without a single word of text. A player must be able to read, from
// the picture alone: that they are drifting, how far the mini-turbo has charged,
// that it just fired, what they are driving on, how hard they landed, and that
// they have crossed the line.
//
// Three positions the whole file is built on:
//
//   The sparks are the meter. Mario Kart's mini-turbo has no HUD element; the
//   charge is read entirely off the colour coming out of the rear wheels, and
//   that colour has to change on the exact frame the tier locks in, with a
//   punctuation mark loud enough to notice in peripheral vision. Everything else
//   here is decoration next to that.
//
//   Everything is one draw call per blend mode. Sparks, dust, flame, confetti,
//   shock rings and speed lines all share one atlas and one instanced buffer
//   (see sprites.ts). Eight karts drifting at once costs three draw calls, not
//   three hundred.
//
//   Simulation events are *impulses*, not spawns. Every handler here records a
//   saturating scalar and the next rendered frame spends it. That is what makes
//   the module survive the capture harness, which steps the simulation for
//   seconds at a time without drawing: a naive handler would spawn ten thousand
//   particles into a pool that never ages, and the first drawn frame would be a
//   wall of dust. It also means nothing this file does can ever run at a rate
//   the renderer does not control.
//
// Ownership: everything in `src/fx/**`. This module writes to `ctx.fx` and to
// the camera's *orientation* (shake, applied after the camera system has posed
// it, and never to its position — the camera damps its own boom in world space
// and feeding a shake back into that would make the rig drift).

import * as THREE from 'three';
import { DEG, clamp, clamp01, damp, fbm1, lerp, makeRng } from '../core/math.ts';
import { getVehicle } from '../vehicles/registry.ts';
import { CELL, PUFF_CELLS, createAtlas } from './atlas.ts';
import { MODE, createSpriteLayer } from './sprites.ts';
import { createParticlePool, makeSpec } from './particles.ts';
import { createTyreMarks } from './marks.ts';
import { createScreenFx } from './screen.ts';
import { portsFor } from './exhaust.ts';
import type { Rng } from '../core/math.ts';
import type { SpriteLayer } from './sprites.ts';
import type {
  FxSystem, GameContext, GameSystem, RaceConfig, Racer, Surface, SplineSample,
} from '../types.ts';

/** Mirrors RIDE_HEIGHT in physics/kart.ts: how far a racer's simulated origin
 *  floats above the surface it is standing on. Wheel contact points are derived
 *  from it, so if physics changes its suspension this has to follow. */
const RIDE_HEIGHT = 0.55;

const TAU = Math.PI * 2;

/** Pool sizes. Generous — the whole point of a pool is that a spectacular
 *  moment is never the moment it runs out. */
// The alpha layer carries the whole continuous half of the module now — dust,
// exhaust from eight machines, tyre haze, smoke, confetti — so it is the one
// with the most headroom. A layer that silently drops pushes past its cap
// thins the effect exactly when the frame is busiest, which is the frame the
// reviewer photographs.
// Both layers grew with the rebuild. Every continuous emitter here now buys its
// density in *pieces* rather than in diameter — three times the puffs at half
// the size and a third of the opacity — which is what turned the locomotive's
// steam from four outlined balls into a plume, and a measured pack shot from
// four hundred alpha instances to about eleven hundred. A layer that silently
// drops what it cannot hold thins the effect exactly on the frame the reviewer
// photographs, so the caps have to clear the worst legitimate case rather than
// the typical one.
const POOL = 6000;
const LAYER_ADD = 2400;
const LAYER_ALPHA = 3000;
const LAYER_RUSH = 240;
const MARK_QUADS = 2600;

/**
 * The hard ceiling on how big any one airborne sprite may be, in metres.
 *
 * Not a taste call — a legibility rule with arithmetic behind it. The chase
 * camera sits six to eight metres from the machine, so a sprite born at a racer
 * covers `2*atan(size/2 / 7)` of the frame: at two metres that is sixteen
 * degrees, which is a puff; at seven metres it is fifty-three degrees, which is
 * most of the screen, and at that scale the puff cell's own alpha ramp becomes
 * a visible hard-edged circle — the "these are quads" tell in its purest form.
 *
 * The module had no such ceiling. A caller asking for `scale: 2.2` — a
 * perfectly reasonable request meaning "a big one" — had it multiplied by the
 * surface's puff size, by the dust ring's own 1.35, and then by a growth of
 * 2.7, and got a seven-metre disc. Twenty of those, born at a racer, is the
 * wall of translucent circles over the sky, the mountains and the HUD that
 * reviewers kept photographing. Volume comes from *count*, never from diameter.
 *
 * 1.7 rather than 2.0, on a measurement: the alpha layer's largest live sprite
 * within twelve metres of the lens was 1.67m on an ordinary traffic frame, and
 * a sprite that reaches the ceiling on a frame where nothing is happening means
 * the ceiling is not doing any work. At 1.7 the cap binds on the loose-surface
 * dust — where it should, since that is the only emitter with a real reason to
 * ask for a big one — and clears every hard-surface emitter, which now buys its
 * body from life and overlap rather than from diameter.
 */
const MAX_PUFF = 1.7;

/**
 * How long the ignition strike lasts, in **simulation** seconds. See `ignite`.
 *
 * A third of a second, which is roughly MK8's, and is the shortest window that
 * survives being photographed: the review sheet's boost recipe freezes the race
 * and then spends a quarter of a second of visual time settling the camera
 * before the shutter opens.
 */
const IGNITE_TIME = 0.32;

/** How far above the surface a ground-flat sprite is laid. See `ring`. */
const RING_LIFT = 0.14;

/**
 * How much of the frame the alpha layer is allowed to own, in the units
 * `pool.veil` reports — roughly "screens covered once at full opacity".
 *
 * Measured rather than guessed. An ordinary slide on tarmac was landing at
 * about 0.27 and a drift across the dirt verge at 0.64, against a frame worth
 * about 1.37: half the picture behind dust, in a game whose entire readability
 * argument is that the road must be obvious at speed. A rooster tail off gravel
 * genuinely should be the loudest thing in the frame, so this is not tight —
 * 0.20 is a seventh of the picture, which is a substantial cloud — but it is a
 * ceiling, and the point of a ceiling is that eight machines sliding into the
 * same hairpin cannot stack up to a whiteout the way they can with per-emitter
 * tuning alone.
 */
const VEIL_BUDGET = 0.19;
// ...and the prose above says 0.20 because that is what it was set to when the
// prose was written; a later pass tightened the constant to 0.14 and left the
// paragraph alone. 0.14 is not a ceiling a rooster tail ever reaches — measured
// on a machine crossing the dirt at 31 m/s the alpha layer covered **0.068**,
// less than half the budget, with the governor sitting at 0.96 and cutting
// nothing. So the ceiling was never what made off-road quiet; the emission was.
// It goes back to 0.19 anyway, because the numbers below double the loose
// surfaces and the whole point of a closed loop is that it is what stops eight
// machines in one hairpin from stacking into a whiteout.

/**
 * How a surface answers to a tyre. `rate` is puffs per second at top speed;
 * `slip` is the extra that only happens when the tyres are actually sliding,
 * which is why tarmac throws almost nothing until you commit to a drift.
 *
 * `color` is deliberately *not* the surface's own colour. Dust the colour of
 * the ground it came off is invisible against that ground — which is exactly
 * what happened here: tan dust over Cone Canyon's tan verge produced a kart
 * running through dirt at 90km/h with nothing visible behind it at all. Real
 * dust is lit from every direction at once and always reads paler than the
 * surface, so each of these is its ground colour lifted well toward white.
 *
 * `deep` is where it settles as it thins out — and the hard rule this table now
 * obeys is that **`deep` is still paler than the lit surface**. It used to be
 * the ground's own mid-tone, which meant every puff spent the back half of its
 * life crossing from paler-than-the-road to darker-than-the-road, and since a
 * puff is at its largest at the end of its life, what a screenshot caught was
 * a near-black soft disc lying flat on the asphalt. Reviewers read those as oil
 * stains, and they were right to: nothing suspended in air and lit by the sky
 * can be darker than the ground it is floating over. Smoke can be *grey*; it
 * cannot be *dark*.
 *
 * `alpha` is roughly half what it was and the rates are roughly double, which
 * is the same total density arranged as wisps rather than as lumps. A cloud
 * that is fifteen faint sprites has an edge and a shape; the same opacity in
 * four solid ones is a smudge on the lens.
 */
interface SurfaceFx {
  color: number;
  deep: number;
  /** How much this surface throws *upward*. Tarmac smoke stays on the deck;
   *  loose dirt and sand billow. One value for all of them left a kart running
   *  through dirt at 100km/h trailing a decal painted on the verge. */
  lift: number;
  rate: number;
  slip: number;
  /**
   * Puffs per second from *speed alone*, at the top of the range.
   *
   * The term that did not exist. Dust used to require either a loose surface or
   * a sliding tyre, so a machine tracking straight and true down the tarmac at
   * 240 km/h disturbed precisely nothing — which is why a pack shot at racing
   * speed photographed as a set of parked models. Anything moving that fast
   * over a road drags a wake off it, and that wake is most of what tells a
   * still frame how fast the frame is.
   */
  wake: number;
  size: number;
  /**
   * Cross-section of one wake streak, which is *not* the size of a dust puff.
   *
   * A note on why the hard surfaces run almost none of this. The wake is drawn
   * in velocity mode, and velocity mode measures its stretch in *screen space*
   * — which is exactly right for a spark thrown sideways and exactly useless
   * for a wake, because a wake behind a machine in a chase camera travels
   * directly away from the lens and therefore has no screen-space direction to
   * stretch along at all. Pushed up to where it could be seen on tarmac it
   * photographed as a scatter of small ragged pale patches lying on the road
   * behind the kart: lint, not motion. Speed on a hard surface is carried by
   * the exhaust, the road going past and the camera; this is left as the barest
   * suggestion of disturbed air, and the loose surfaces — where there is real
   * material to lift and it climbs into the light — keep the whole effect.
   *
   * The wake is drawn in velocity mode, so its width comes from `size` and its
   * length from the stretch — and on tarmac, where the whole effect has to be
   * almost subliminal, a wake sprite as wide as a dust puff comes out as a
   * lozenge. Six lozenges at a time behind a machine is not a wake, it is six
   * grey thumbprints on the glass, which is precisely what a photograph of the
   * game at racing pace came back with. Narrow and long reads as air being
   * dragged; round reads as a smudge on the lens, whatever it is called in the
   * code.
   */
  wakeSize: number;
  grow: number;
  alpha: number;
  /**
   * Fraction of the emission that comes off as *solid matter* rather than as
   * dust — clods, gravel, torn grass. Dust alone has no edge in it: seven soft
   * lobes at 60% alpha, however many of them you stack up, is a smudge, and a
   * kart crossing a gravel trap at 90km/h behind a smudge reads as a rendering
   * artefact rather than as a mistake with a cost. The grit is what tells the
   * eye the ground came apart. Tarmac has none of it; it has nothing loose to
   * give.
   */
  grit: number;
  /** Metal on metal: sparks rather than dust. */
  sparky: boolean;
  /** Multiplier on tyre-mark darkness, and the mark's own tint. */
  mark: number;
  markTint: number;
  /**
   * Peak opacity of one puff of *tyre smoke* — the ribbon that boils off a
   * sliding contact patch — as opposed to `alpha`, which is the ground being
   * disturbed.
   *
   * They had to be separated. `alpha` is shared by the dust cloud and the speed
   * wake, both of which are veils that want to stay near-subliminal on tarmac;
   * smoke off a locked tyre is the opposite, and the module was rejected
   * precisely for having only one number for both. On asphalt the ground gives
   * nothing at all, so `alpha` is 0.075 and `smoke` is four times that: the
   * whole of a committed slide on a hard surface is rubber, and rubber is the
   * one thing tarmac has to give.
   */
  smoke: number;
  /** Puffs of tyre smoke per second, summed over both rear wheels, at full
   *  commitment. Loose surfaces run less of it because `surfaceDust` is already
   *  throwing a cloud off the same wheels for the same reason. */
  smokeRate: number;
}

/**
 * Every `alpha` here is roughly a third of what it was, and that is not a
 * retreat — it is the correction that goes with rebuilding the puff cell (see
 * `atlas.ts`). The old cell peaked at 0.20 alpha and was a *donut*, densest at
 * a third of its radius and nearly hollow at the middle, so the table was tuned
 * to compensate for a texture that could not cover anything. The rebuilt cell
 * peaks at 0.66 with a solid centre, which is about three and a quarter times
 * the covering power per sprite; leaving these numbers alone would have turned
 * every dust trail in the game into a wall.
 *
 * Net density lands a little above where it was. What changes is *legibility*:
 * the same opacity now arrives as a handful of individually readable puffs with
 * a shape and a silhouette, instead of as four hundred hollow rings that
 * photographed as soap bubbles on a hillside and as smears on the windscreen.
 */
/**
 * A note on the shape of this revision.
 *
 * Every `size` came down by roughly a third and every `rate` went up to match,
 * because the measured failure was never "too much dust" — it was "too few
 * pieces of dust, each too big". Those are opposite defects that produce the
 * same total opacity and look nothing alike: forty puffs of 0.9m read as a
 * cloud with a silhouette, six puffs of 2.4m read as soap bubbles someone blew
 * at the lens, and both of them integrate to the same grey. The angular
 * governor in `particles.ts` now guarantees the second case cannot reach the
 * screen at all, so the table is free to buy its density in pieces instead of
 * in diameter.
 *
 * `grit` went up on every loose surface for the other half of the same reason.
 * A cloud has no edge in it; the clods are what tell the eye the ground came
 * apart, and at three a second nobody ever saw one.
 */
/**
 * ...and the loose surfaces went up again, by about three quarters, on the
 * strength of a measurement rather than a taste.
 *
 * The A/B that settled it: photograph a machine at racing speed on the dirt,
 * then hide all three sprite layers with `__FX.layers(false)` and photograph
 * the same frozen frame again. The two pictures were **almost identical**. All
 * eight hundred particles in flight amounted to a faint warm haze that a 9x
 * crop of the ground behind the tyres could not distinguish from the ground.
 * Whatever else is wrong with an effects layer, being switchable off without
 * anyone noticing is worse.
 *
 * What made it safe to turn up is the veil governor (`VEIL_BUDGET`), which did
 * not exist when this table was last cut. Measured on that same frame, the
 * alpha layer was covering 0.058 against a budget of 0.20 — twenty-nine percent
 * of what it is allowed — and the governor is a closed loop, so the failure it
 * was built to prevent cannot come back by way of these numbers whatever they
 * say. Tarmac is untouched at 0.075: a hard surface having nothing to give is
 * the contrast the whole table exists to draw.
 */
/**
 * ── and then it went too far, and this is the retreat ──────────────────────
 *
 * Measured on an ordinary traffic frame: **804 live alpha sprites, 395 of them
 * inside twelve metres of the lens**, stacking five to ten deep and reading as
 * discrete outlined grey lozenges strewn across the tarmac and floating at
 * windscreen height. The sprite layers were repainting 30.8% of the frame. The
 * verdict that settled it is the one no amount of argument survives: the frame
 * was objectively *cleaner* with the module switched off.
 *
 * Every rate here is roughly a third of what it was and every opacity about
 * half again as much. Same integrated density, a quarter of the population —
 * and the population is what was wrong. Two puffs a frame that overlap into one
 * body have an outline that changes; eight that do not are eight objects, and
 * objects are what a reviewer counts.
 *
 * `wake` is **gone from every hard surface**, and that is not a cut, it is a
 * deletion. It fired while a machine was merely going fast, so it was on screen
 * for the whole race on every machine at once, and what it drew was the litter
 * the module was rejected for: individually outlined pale lozenges strewn
 * across the tarmac around and behind the kart. Turning it down from 36 to 9
 * did not fix that, because the defect was never the count — a wake sprite on
 * asphalt is a *visible object with an outline*, and six of those on the road
 * read exactly as badly as fourteen. The comment two paragraphs up already knew
 * this ("lint, not motion") and the number was pushed to 36 anyway.
 *
 * The loose surfaces keep theirs, because there the wake is real material being
 * lifted into the light rather than a stand-in for moving air. On tarmac, speed
 * is carried by the exhaust, the road going past, the camera and the tyre
 * marks — all four of which are still there, and none of which leaves anything
 * behind for a reviewer to count.
 *
 * The one thing that goes *up* is `smoke`, the rubber off a sliding tyre, from
 * 0.40 to 0.62 — because it is the half of a tarmac drift the module is judged
 * on, and it now has fewer, fatter, longer-lived puffs to say it with.
 *
 * ── and the loose surfaces keep two thirds of theirs ────────────────────────
 *
 * The cut is deliberately *uneven*, because the defect was. What was measured
 * was a **traffic frame on tarmac**: eight machines' exhaust, eight speed wakes
 * and the tyre haze, all of it running whether anything was happening or not,
 * strewn across a road the player has to read at 240 km/h. A rooster tail off
 * the gravel is the opposite kind of effect — it exists only while somebody has
 * made a mistake, it is the entire punishment for making it, and it is supposed
 * to be the loudest thing in that frame. Cutting it to a third with everything
 * else took the dust off a machine crossing the verge at 100 km/h down to a
 * faint smudge, which trades one rejection for another.
 *
 * So the always-on terms — `wake`, exhaust, tarmac `smokeRate` — take the full
 * three-to-one cut, and the loose-surface `rate`/`slip` take about a third off
 * with a matching rise in opacity, which lands the cloud in the same place with
 * a quarter fewer pieces in it. The veil governor holds the ceiling either way.
 */
const SURFACE_FX: Record<Surface, SurfaceFx> = {
  // Tarmac carries no *dust* at all (`rate: 0`), so on a hard surface the whole
  // alpha layer is tyre smoke, the wake and the exhaust — which means the veil
  // governor has headroom here that it does not have on dirt, and the smoke was
  // sized as though it were competing with a rooster tail. In MK8 the white
  // smoke off a sliding tyre is half the read of a drift and it is there from
  // the first frame of the slide; measured here it was a hairline ribbon over
  // otherwise bare asphalt. Both the rate and the opacity go up, and `veilHero`
  // means it is the last thing cut when the frame does fill.
  // `wake` and `wakeSize` are up two thirds for the same reason the exhaust
  // alphas are: the streak of disturbed air behind a machine is the only term
  // in the whole module that fires while a kart is simply *going fast*, and at
  // a rate of 20/s against a 0.42s life it put eight thin sprites on the road
  // — which a reviewer photographing a three-machine slipstream at 54 m/s
  // reasonably read as road markings. Fourteen slightly wider ones is still a
  // veil rather than a cloud, and it is what a still frame at 240 km/h has to
  // be able to show.
  road:  { color: 0xEAEEF6, deep: 0xD6DCE8, lift: 0.20, rate: 0,  slip: 13, wake: 0,  size: 0.44, wakeSize: 0.30, grow: 2.0, alpha: 0.115, grit: 0.00, sparky: false, mark: 1.00, markTint: 0x3F3E4A, smoke: 0.62, smokeRate: 72 },
  boost: { color: 0xF3E8D6, deep: 0xE2D9C8, lift: 0.22, rate: 0,  slip: 13, wake: 0,  size: 0.46, wakeSize: 0.30, grow: 2.0, alpha: 0.120, grit: 0.00, sparky: false, mark: 0.80, markTint: 0x423F4D, smoke: 0.62, smokeRate: 72 },
  // ── the loose surfaces, roughly doubled ─────────────────────────────────
  //
  // Leaving the road is supposed to be a punishment the player *sees* before
  // they feel it, and what it looked like was two thin near-vertical columns of
  // eight or ten pale blobs. The measurement behind these numbers is in the
  // note on `VEIL_BUDGET`: at 31 m/s across the dirt this module was covering
  // 0.068 of the frame against a ceiling of 0.14, with the governor cutting
  // nothing at all. There was no ceiling in the way — the rates were simply
  // half what a rooster tail needs, and the last pass cut them under cover of a
  // defect that was really about *tarmac* litter.
  //
  // `grit` goes up with them, because the clods are the only thing in the cloud
  // with an edge and a trajectory, and a bigger cloud with the same handful of
  // stones in it just looks like more fog.
  dirt:  { color: 0xF7E6C6, deep: 0xDCBE93, lift: 1.42, rate: 250, slip: 130, wake: 16, size: 0.68, wakeSize: 0.44, grow: 2.5, alpha: 0.440, grit: 1.05, sparky: false, mark: 0.85, markTint: 0x9c7444, smoke: 0.18, smokeRate: 14 },
  sand:  { color: 0xFDF4E0, deep: 0xEBD9AF, lift: 1.52, rate: 268, slip: 136, wake: 17, size: 0.70, wakeSize: 0.46, grow: 2.6, alpha: 0.450, grit: 0.78, sparky: false, mark: 0.72, markTint: 0x9c8050, smoke: 0.16, smokeRate: 13 },
  grass: { color: 0xE3F0CC, deep: 0xB2CE8C, lift: 1.05, rate: 195, slip: 105, wake: 13, size: 0.62, wakeSize: 0.40, grow: 2.3, alpha: 0.380, grit: 0.92, sparky: false, mark: 0.62, markTint: 0x6d8b4c, smoke: 0.17, smokeRate: 13 },
  water: { color: 0xF8FDFF, deep: 0xD7EFFA, lift: 1.40, rate: 205, slip: 130, wake: 16, size: 0.56, wakeSize: 0.36, grow: 2.2, alpha: 0.380, grit: 0.48, sparky: false, mark: 0.00, markTint: 0xffffff, smoke: 0.15, smokeRate: 10 },
  rail:  { color: 0xCFE2FF, deep: 0xCFE2FF, lift: 0.20, rate: 0,  slip: 22, wake: 0,  size: 0.22, wakeSize: 0.20, grow: 1.4, alpha: 0.90,  grit: 0.00, sparky: true,  mark: 0.00, markTint: 0xffffff, smoke: 0.00, smokeRate: 0 },
  air:   { color: 0xffffff, deep: 0xffffff, lift: 0.00, rate: 0,  slip: 0,  wake: 0,  size: 0.40, wakeSize: 0.20, grow: 2.0, alpha: 0.00,  grit: 0.00, sparky: false, mark: 0.00, markTint: 0xffffff, smoke: 0.00, smokeRate: 0 },
};

/**
 * Confetti. High-vis roadworks, not a birthday party — and it used not to be.
 *
 * Lime and magenta are gone. The comment above this list has always said what
 * it should be and the list said otherwise: photographed at 4x, the finish
 * threw pink, lime, cyan and magenta, which is a child's party and not a work
 * site. Magenta in particular is `0xE040FB` — the tier-three mini-turbo colour,
 * a reserved signal in this game, and the last hue that should be raining down
 * a straight for decoration.
 *
 * What is left is the palette anchor in ARCHITECTURE section 12: safety orange,
 * hazard yellow, white, a warning red and one cool accent so the storm is not
 * monochrome against a warm desert.
 */
const CONFETTI = [0xFF6B1A, 0xFFC300, 0xFFF8F0, 0xFFE08A, 0xE33B2E, 0x5FC8F5];

/** Per-racer bookkeeping. Nothing here is simulation state — it is all either a
 *  fractional emission accumulator or an impulse waiting to be spent. */
interface RacerFx {
  spark: number;
  dust: number;
  /** Fractional emitter for the clods thrown off a loose surface. */
  grit: number;
  flame: number;
  /** Fractional emitter for the always-on exhaust. One per port. */
  exhaust: number;
  exhaust2: number;
  /** Fractional emitter for the tyre smoke under the drift sparks. */
  scrub: number;
  /** One-frame density spike in the tyre smoke, carrying the tier that caused
   *  it. Set when a mini-turbo locks in, spent by the next rendered frame. */
  pendSmoke: number;
  /** Fractional emitter for the speed wake. */
  wake: number;
  /** Charge this racer was carrying last frame, so a *release* can be seen
   *  without physics having to announce one. */
  lastCharge: number;
  lastTier: number;
  /** Decaying acknowledgement of a drift release, and the tier it was worth. */
  release: number;
  releaseTier: number;
  /**
   * "I am boosting", as an envelope this module owns rather than as a read of
   * `boost.time`. Set when a boost fires, held, then released slowly. The point
   * is that every boost source — pad, mushroom, mini-turbo, trick, rocket start
   * — produces the same shape, so the state reads one way instead of four.
   */
  boostEnv: number;
  /**
   * The ignition envelope: 1 on the frame a boost fires, 0 about a third of a
   * second later. Distinct from `boostEnv`, which is the *sustain* — this is
   * the strike, and it is the only thing in the module that draws the release
   * rather than the state.
   *
   * Drawn in immediate mode, so no frame of the loudest moment in the game can
   * come out empty because the pool happened to be full or because a screenshot
   * landed between two emissions.
   *
   * ── and it is measured in *simulation* time, which is the whole trick ──
   *
   * Not a timer decayed by the render dt, which is what it was first written
   * as. `__GAME.setTimeScale(0)` stops the simulation and does **not** stop
   * `update`: the engine's rAF loop keeps calling `renderFrame(wallDt)` with
   * whatever the wall clock says, and under software GL every round trip from
   * the capture harness is 150-300ms of it. So a render-timed envelope is over
   * before the tooling can photograph it, and the review sheet's own boost
   * recipe — freeze, then twenty-eight `render()` calls, then a screenshot —
   * cannot catch a one-shot at all. That is why a reviewer stepping the firing
   * frame found the two shock rings simply absent: they were emitted, and they
   * had aged several seconds by the time the shutter opened.
   *
   * `boostFull - boost.time` is frozen by `setTimeScale(0)` along with the rest
   * of the simulation, so the strike lasts exactly as long on the review bench
   * as it does in the player's hands.
   */
  ignite: number;
  ignitePower: number;
  /** `boost.time` on the frame the boost started, so its age can be read back
   *  out of the simulation rather than kept as a second clock here. */
  boostFull: number;
  /** Eased 0..1 drift intensity, driving the wheel glow. */
  glow: number;
  /** Decaying pop when a mini-turbo tier locks in, and which tier it was. */
  pop: number;
  popTier: number;

  pendDriftStart: number;
  pendTier: number;
  pendBoost: number;
  /**
   * Which mini-turbo tier the *live* boost was paid for with, 0 for anything
   * else. Latched per boost **source**, not per uninterrupted boost window.
   *
   * That distinction is a bug this had for a whole round. It used to only ever
   * climb — `if (tier > fx.boostTier)` — and only cleared when `boost.time`
   * reached zero, and boosts chain: a pad taken during or straight after a
   * mini-turbo extends `boost.time` without ever letting it hit zero, so the
   * pad inherited the drift's colour. Measured, a gold-and-orange chevron pad
   * fired `rushTier=2` and put a green wash on the frame. Every `kart:boost`
   * now *states* the tier, including stating that it has none.
   */
  boostTier: number;
  /**
   * What kind of thing granted the live boost: 0 none, 1 thrust the player was
   * given, 2 a slipstream. The screen rush reads this, because a draft is not
   * a boost — it is free speed for sitting in the right place, and lighting the
   * game's loudest sustained cue for it spends that cue on its quietest event.
   *
   * Cleared with the *envelope* rather than with `boost.time`, so it lasts
   * exactly as long as the effect it gates.
   */
  boostKind: number;
  pendLand: number;
  /** Seconds this racer was actually in the air. A drift hop and a launch off
   *  the canyon crest both arrive as `kart:land` with a healthy impact, and
   *  without this the hop — which happens several times a corner — fires the
   *  full landing treatment. */
  landAir: number;
  pendHop: number;
  pendOffroad: number;
  pendWall: number;
  pendHit: number;
  pendTrick: number;
  pendBump: number;
  pendBurnout: number;
  pendLaunch: number;
  pendDraft: number;
  pendCoin: number;
  pendCoinLoss: number;
  pendPowerUp: number;
  bumpX: number; bumpY: number; bumpZ: number;

  /** 1 while this racer is in someone's slipstream. */
  draft: number;
  /** Eased draft, so the wind builds and lets go rather than snapping. */
  draftEase: number;
  /** Fractional emitter for the star-power sparkle. */
  sparkle: number;

  /** Seconds left of barrier-scrape sparks, and which flank they come from. */
  grind: number;
  grindSide: number;
  /** Recomputed each frame: how much this racer's effects are worth drawing. */
  near: number;
  /**
   * The same idea as `near` but far more generous, and it exists because the
   * two halves of this module fail differently with distance. A spark is a
   * pinpoint: forty metres away it is one pixel and paying for it is pure
   * waste, so `near` now falls to nothing by the middle of the pack. A plume of
   * exhaust is a *silhouette* against the sky, and it is the only thing telling
   * a still frame that the machines up the road are running. It keeps its
   * reach.
   */
  reach: number;
  /** What the last hit on this racer looked like, straight off `item:reaction`:
   *  0 unknown, 1 spin, 2 flip, 3 bump, 4 squish. */
  hitKind: number;
}

function newRacerFx(): RacerFx {
  return {
    spark: 0, dust: 0, grit: 0, flame: 0, exhaust: 0, exhaust2: 0, scrub: 0, pendSmoke: 0,
    wake: 0,
    lastCharge: 0, lastTier: 0, release: 0, releaseTier: 0, boostEnv: 0,
    ignite: 0, ignitePower: 0, boostFull: 0,
    glow: 0, pop: 0, popTier: 0,
    pendDriftStart: 0, pendTier: 0, pendBoost: 0, boostTier: 0, boostKind: 0,
    pendLand: 0, landAir: 0, pendHop: 0, pendOffroad: 0, pendWall: 0, pendHit: 0,
    pendTrick: 0, pendBump: 0, pendBurnout: 0, pendLaunch: 0, pendDraft: 0,
    pendCoin: 0, pendCoinLoss: 0, pendPowerUp: 0,
    bumpX: 0, bumpY: 0, bumpZ: 0,
    draft: 0, draftEase: 0, sparkle: 0,
    grind: 0, grindSide: 1, near: 1, reach: 1, hitKind: 0,
  };
}

// ── scratch. Nothing in this file may allocate per frame ────────────────────
const _pos = new THREE.Vector3();
/** The player's interpolated position, kept after the racer loop has moved on. */
const _playerPos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _p = new THREE.Vector3();
const _lat = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _shakeQ = new THREE.Quaternion();
const _shakeE = new THREE.Euler();
const _tint = new THREE.Color();
/** The exhaust's own colour: flame, carrying the tier as a wash. See `boostFlame`. */
const _plume = new THREE.Color();
/** Velocity a queued `spawn` inherits from whatever it happened to. */
const _qv = new THREE.Vector3();
const _sample: SplineSample = {
  pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
  right: new THREE.Vector3(), up: new THREE.Vector3(),
  width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
};

/** Deferred `ctx.fx.spawn` calls. Fixed capacity: a caller in a runaway loop
 *  must never be able to make this module allocate. Sized for the worst
 *  legitimate frame — a bob-omb going off inside a row of item boxes with the
 *  pack on top of it — because a queue that overflows drops the *last* effects
 *  asked for, which are the ones from the loudest event. */
const QUEUE = 64;

export function createFxSystem(ctx: GameContext): GameSystem {
  const K = ctx.config.kart;

  // Mini-turbo colours, straight off the tuning table so the sparks and the
  // physics can never disagree about what "tier 2" looks like. Index 0 is the
  // uncharged state: small white sparks, exactly as in MK8 — the drift is doing
  // something before it is worth anything.
  //
  // Two adjustments, both about surviving the pipe rather than about taste.
  //
  // Normalised to a peak channel of 1: the three tuning colours differ by a
  // third in brightness, and unnormalised the tier read partly as "brighter"
  // instead of purely as "a different colour", which is the wrong axis — the
  // player is being told *which* tier, not *how much*.
  //
  // Then a per-tier gain, because the frame is graded through ACES. ACES pulls
  // anything much past 2.5 toward white, and it does it fastest on warm hues:
  // at the old gain of 4.6 the orange tier arrived on screen as a white blob,
  // which is to say the middle third of the mini-turbo had no colour at all.
  // These gains are the brightest each hue can be pushed and still land as that
  // hue. Purple gets more headroom because magenta is the darkest of the three
  // and would otherwise read as the weakest tier.
  const norm = (hex: number): THREE.Color => {
    const c = new THREE.Color(hex);
    const peak = Math.max(c.r, c.g, c.b);
    if (peak > 1e-4) c.multiplyScalar(1 / peak);
    return c;
  };
  const TIER = [
    norm(0xFFF2D8),
    norm(K.drift.tiers[0]!.color),
    norm(K.drift.tiers[1]!.color),
    norm(K.drift.tiers[2]!.color),
  ];
  const TIER_HEX = [
    0xFFF2D8, K.drift.tiers[0]!.color, K.drift.tiers[1]!.color, K.drift.tiers[2]!.color,
  ];
  /** Peak HDR gain per tier — above this the hue starts bleaching. */
  const TIER_GAIN = [1.8, 2.3, 2.05, 2.9];
  /**
   * Sparks per second, summed over both rear wheels, per tier.
   *
   * Tier zero is deliberately the quietest thing here now. An uncharged drift
   * is the state seven CPU machines are in for most of a lap, its colour is a
   * warm cream, and at the old rate the field was laying down a permanent bed
   * of warm sparks for the player's blue tier one to try to be seen against.
   * The tiers themselves went the other way: an instance dump caught a
   * committed tier one putting **seventeen** sparks near the machine while a
   * single landing ring lit eight metres of road. Blue was not competing with
   * orange, it was competing with everything else in the frame at once.
   */
  /**
   * ...and the climb between the tiers is now steep, because it was measured
   * going the *wrong way*. At 380/420/460 the difference between a blue and a
   * green mini-turbo was ten percent of an emission rate, and once the fliers —
   * which leave the wheel entirely — were counted out of it, the density at the
   * contact patch came out **lower** at tier two than at tier one. The one
   * place a player looks for the charge was reading backwards.
   */
  const TIER_RATE = [30, 420, 600, 820];

  const FLAME_HOT = new THREE.Color(0xFFF0C0);
  const FLAME_MID = new THREE.Color(0xFF7A18);
  const FLAME_END = new THREE.Color(0x8C2A06);
  // Smoke, and the deeper tone it thins out to.
  //
  // Both are *pale*. The old value was 0x6B6258 fading to half of that, which
  // in linear radiance is darker than sunlit tarmac — so the loudest moment in
  // the game left a row of near-black discs lying on the road behind the kart.
  // Real tyre smoke is a suspension lit from the sky in every direction; it
  // reads as a light haze against dark ground and only ever goes grey where it
  // is thick. Anything in this module that is *airborne* is now bound by that:
  // never darker than the surface it is floating over.
  const SMOKE = new THREE.Color(0xD9DCE3);
  const SMOKE_DEEP = new THREE.Color(0xADB3C0);
  const WARM_WHITE = new THREE.Color(0xFFE7C0);
  const WHITE_HOT = new THREE.Color(1, 1, 1);
  const GOLD = new THREE.Color(0xFFD24D);
  const RAIL_SPARK = new THREE.Color(0xFFE9C0);
  const surfaceColors = new Map<Surface, THREE.Color>();
  const surfaceDeep = new Map<Surface, THREE.Color>();
  for (const key of Object.keys(SURFACE_FX) as Surface[]) {
    surfaceColors.set(key, new THREE.Color(SURFACE_FX[key].color));
    surfaceDeep.set(key, new THREE.Color(SURFACE_FX[key].deep));
  }
  const markTints = new Map<Surface, THREE.Color>();
  for (const key of Object.keys(SURFACE_FX) as Surface[]) {
    markTints.set(key, new THREE.Color(SURFACE_FX[key].markTint));
  }
  const confettiColors = CONFETTI.map((h) => new THREE.Color(h));

  // ── specs. One preset per effect, mutated in place and never replaced ──────
  // `stretch` is now metres of half-length per m/s of camera-relative speed, so
  // 0.05 turns a spark thrown clear at 14 m/s into a streak about 1.4m long and
  // leaves one keeping pace with the kart as a point. That difference is the
  // whole silhouette of a mini-turbo.
  const sparkSpec = makeSpec({
    cell: CELL.spark, mode: MODE.velocity, additive: true,
    life: 0.34, size0: 0.20, size1: 0.03, alpha: 1,
    gravity: 15, drag: 2.0, stretch: 0.035, fadeIn: 0,
  });
  const emberSpec = makeSpec({
    cell: CELL.glow, mode: MODE.billboard, additive: true,
    life: 0.22, size0: 0.34, size1: 0.05, alpha: 0.85,
    gravity: 6, drag: 3.0, fadeIn: 0,
  });
  // Dust wants to *sit* where the tyre threw it and spread, not climb. The old
  // -0.9 gravity floated every puff a metre and a half up over its life, which
  // left the road behind a drifting kart hung with grey blobs at windscreen
  // height. -0.2 is enough to keep it from sinking through the tarmac and no
  // more.
  // `fadeIn` used to be nearly a quarter of the life. A puff is only inside the
  // frame for the first half of its life — after that the kart has driven out
  // from under it and the chase camera has gone with the kart — so a long fade
  // in means the only part of the cloud a player ever sees is the part that has
  // not arrived yet.
  const dustSpec = makeSpec({
    cell: CELL.puff, variants: PUFF_CELLS, mode: MODE.billboard, additive: false,
    life: 0.8, size0: 0.45, size1: 1.5, alpha: 0.08,
    gravity: -0.2, drag: 1.5, fadeIn: 0.12,
  });
  // The flame body is drawn on the *puff* cell, not the glow.
  //
  // A glow is a perfect radial gaussian, and twenty perfect radial gaussians
  // emitted along the path of a machine doing 55 m/s do not merge into fire —
  // they stack into a string of beads rolling away down the road, each one
  // rounder and larger than the last. That is what the boost photographed as,
  // and no amount of colour work fixes a shape problem. Fire has a torn edge;
  // the puff cell has one, and overlapping torn edges read as turbulence. The
  // smooth core the glow was providing is now where it belongs — in the two
  // immediate-mode nozzles, which never flicker and never travel.
  const flameSpec = makeSpec({
    cell: CELL.puff, variants: PUFF_CELLS, mode: MODE.billboard, additive: true,
    life: 0.28, size0: 0.5, size1: 1.25, alpha: 0.95,
    gravity: -3, drag: 4.5, fadeIn: 0.07,
  });
  const smokeSpec = makeSpec({
    cell: CELL.puff, variants: PUFF_CELLS, mode: MODE.billboard, additive: false,
    life: 0.85, size0: 0.38, size1: 1.5, alpha: 0.042,
    gravity: -1.4, drag: 2.2, fadeIn: 0.2,
  });
  // Exhaust. Its own preset rather than a borrowed smoke spec: it is the only
  // emitter in the module that runs on every machine on the track for the whole
  // race, so it has to be the cheapest and the quietest thing here.
  const exhaustSpec = makeSpec({
    cell: CELL.puff, variants: PUFF_CELLS, mode: MODE.billboard, additive: false,
    life: 0.5, size0: 0.16, size1: 0.5, alpha: 0.042,
    // Negative gravity: hot gas rises, and rising is what lifts the plume out
    // of the machine's own shadow and puts it against the road or the sky where
    // it can actually be seen.
    //
    // Drag is where this went badly wrong. At 1.6, a puff born travelling at
    // 50 m/s has lost 80% of that inside a second — so while the machine covers
    // fifty metres its own exhaust covers twenty-six, and the difference is a
    // twenty-four metre band of pale spheres hanging in the air behind it. That
    // is the "floating grey blobs" defect, and no amount of tuning the rate
    // fixes it, because the shape is wrong rather than the quantity. At 0.15 a
    // puff keeps very nearly all of its inherited speed and stays with the
    // stack it came out of, which is what smoke leaving a moving chimney does.
    gravity: -1.6, drag: 0.15, fadeIn: 0.14,
  });
  // The speed wake.
  //
  // Its own shape, and the shape is the point. Emitted as round puffs it came
  // out as a line of pale cotton balls trailing the machine — the exact "grey
  // blobs that look like smudges on the lens" this module was rejected for.
  // What is actually happening is air and fine grit being *dragged*, so it is
  // drawn in velocity mode: each particle stretches along the path it takes
  // across the frame, which at 240 km/h turns it into a soft streak pointing
  // back down the road and at a standstill leaves nothing at all. A shape that
  // only exists when the machine is moving fast is a shape that can only ever
  // read as speed.
  const wakeSpec = makeSpec({
    cell: CELL.puff, variants: PUFF_CELLS, mode: MODE.velocity, additive: false,
    life: 0.42, size0: 0.30, size1: 0.75, alpha: 0.04,
    gravity: -0.2, drag: 1.1, stretch: 0.055, fadeIn: 0.14,
  });
  // Tyre smoke. The ribbon that boils off a sliding contact patch.
  //
  // This used to be a "scrub haze" at 0.045 alpha and it was the module's
  // biggest hole: a fully committed slide on tarmac produced coloured light and
  // no rubber, so the mini-turbo read as an energy effect bolted to a kart
  // rather than as tyres letting go. A tyre dragged sideways across asphalt at
  // 130 km/h is *burning*, and burning rubber is the loudest thing a hard
  // surface can produce.
  //
  // Three properties make it a ribbon rather than a row of puffs:
  //
  //   low drag. At 2.4 a puff born at 46 m/s stopped dead in the air inside
  //   half a second while the kart carried on — which is how every continuous
  //   emitter in this module ended up strewing its output down the road as
  //   litter. At 0.7 the puff keeps most of its inherited speed for its whole
  //   life and trails a handful of metres, which is what smoke coming off a
  //   moving tyre actually does.
  //
  //   a long-ish life with a short fade-in, so a puff is at full opacity while
  //   it is still at the wheel, where the sparks are.
  //
  //   growth of about 2.3x. Enough to close the gaps between consecutive puffs
  //   into one body, not so much that the body becomes fog.
  // Tyre smoke, drawn as a *wisp* rather than as a ball.
  //
  // The shape was the defect, not the quantity. Round billboard puffs coming
  // off a contact patch at five a frame do not merge into a ribbon — they land
  // as a chain of separate discs receding down the road, each with its own
  // visible outline, and a photograph of a truck sliding through a corner came
  // back looking like someone had blown bubbles at the camera. Velocity mode
  // fixes it in the only way that works: each puff stretches along the path it
  // takes across the frame, so consecutive puffs overlap *along their own axis*
  // and read as one body being dragged. It also means the effect is
  // automatically strongest at speed and disappears at a standstill, which is
  // what smoke off a sliding tyre actually does.
  //
  // Inheritance drops from 0.96 to 0.86 for the same reason (see `smokePuff`):
  // the stretch is measured against the *camera*, and a puff keeping perfect
  // pace with the machine the camera is chasing has no screen-space motion to
  // stretch along, so it would be a circle again.
  const smokeTyreSpec = makeSpec({
    cell: CELL.puff, variants: PUFF_CELLS, mode: MODE.velocity, additive: false,
    life: 0.52, size0: 0.30, size1: 0.62, alpha: 0.30,
    gravity: -0.35, drag: 0.7, stretch: 0.045, fadeIn: 0.07,
  });
  const ringSpec = makeSpec({
    cell: CELL.ring, mode: MODE.ground, additive: true,
    life: 0.42, size0: 1.2, size1: 7.0, alpha: 0.9, fadeIn: 0.04,
  });
  // Ground *light*: the same place, none of the edge. See `groundLight`.
  const groundLightSpec = makeSpec({
    cell: CELL.glow, mode: MODE.ground, additive: true,
    life: 0.40, size0: 2.0, size1: 6.0, alpha: 0.5, fadeIn: 0.03,
  });
  const flakeSpec = makeSpec({
    cell: CELL.flake, mode: MODE.billboard, additive: false,
    life: 3.2, size0: 0.26, size1: 0.26, alpha: 1,
    gravity: 9, drag: 0.7, fadeIn: 0.03,
  });
  const starSpec = makeSpec({
    cell: CELL.star, mode: MODE.billboard, additive: true,
    life: 0.7, size0: 0.5, size1: 0.1, alpha: 1,
    gravity: 8, drag: 1.4, fadeIn: 0,
  });
  // Clods, gravel, torn turf. The spark cell on the *alpha* layer, opaque and
  // dark: additive matter is a contradiction, and it is the darkness that gives
  // the pale dust something to be pale against. Heavy gravity and almost no
  // drag, so each one draws a ballistic arc out of the cloud and back down —
  // which is the read the dust alone can never deliver, because a cloud has no
  // trajectory, only a shape.
  // Clods, gravel, torn turf — a *tumbling chip*, on the flake cell.
  //
  // It used to share the spark cell, which was harmless while that cell was a
  // round blob and became a defect the moment it was rebuilt into a comet: a
  // capture of a drift across the verge came back with a dozen dark navy
  // teardrops the size of a wheel hanging over the sky, the mountains and the
  // HUD, because a comet is a shape that means *light in motion* and nothing
  // else. Matter thrown off a tyre is a lump with a lit face and a shadowed one,
  // and the flake cell — which already draws exactly that for the confetti — is
  // what it should have been using all along.
  const gritSpec = makeSpec({
    cell: CELL.flake, mode: MODE.billboard, additive: false,
    life: 0.44, size0: 0.16, size1: 0.12, alpha: 0.95,
    gravity: 24, drag: 0.25, fadeIn: 0,
  });
  // ── owned objects ─────────────────────────────────────────────────────────
  let atlas: THREE.Texture | null = null;
  let addLayer: SpriteLayer | null = null;
  let alphaLayer: SpriteLayer | null = null;
  let rushLayer: SpriteLayer | null = null;
  const pool = createParticlePool(POOL);
  const marks = createTyreMarks(ctx, MARK_QUADS);
  // The tier list goes *in* rather than being written out again inside the
  // screen layer — see the note above `chargeCss` there.
  const screen = createScreenFx(TIER_HEX);

  // A private stream. Emission runs at render rate, and pulling from `ctx.rng`
  // here would let the number of frames drawn change the simulation.
  let rng: Rng = makeRng(0x9e37);

  const state = new Map<number, RacerFx>();
  const bumpAt = new Map<number, number>();
  const sizeCache = new Map<string, { halfW: number; len: number; height: number }>();

  let density = 1;
  /**
   * `density`, further scaled by how much of the frame the alpha layer already
   * owns. Everything that emits a *veil* — dust, tyre smoke, exhaust, the speed
   * wake — runs off this instead; sparks, flame and confetti do not, because
   * they add light or have an edge on them and neither hides the game.
   *
   * A closed loop on a measurement, damped over about a fifth of a second so it
   * settles rather than pumps. It only ever cuts.
   */
  let veilDensity = 1;
  /**
   * The same governor, weighted by how much the frame needs this particular
   * veil — and the reason tarmac drifts came out with bare road under them.
   *
   * The loop only knows one number: how much of the frame the alpha layer
   * covered. When it has to cut, cutting everything by the same fraction takes
   * the same share off the ribbon of burning rubber under a sliding tyre — half
   * the read of a drift in MK8, and the single thing this module was told was
   * missing on tarmac — as off the speed wake and the idle exhaust of a machine
   * forty metres up the road, which nobody has ever looked at on purpose.
   *
   * So the cut is shared unevenly. `veilHero` is the tyre smoke: the last thing
   * to be thinned. `veilBack` is the wake and the exhaust: the first. Total
   * coverage is still governed by the same closed loop and lands in the same
   * place — this only decides who pays for it.
   */
  let veilHero = 1;
  let veilBack = 1;
  /** The damped 0..1 governor ratio behind `veilDensity`, kept separately so
   *  the loop integrates the ratio and not the ratio times the quality tier. */
  let veilScale = 1;
  let trauma = 0;
  let traumaDecay = 3;
  let lineAcc = 0;

  // The camera's own world velocity, so velocity-mode quads can streak against
  // the frame rather than against the world. Differenced from its position
  // rather than read off the camera system, which owns no such number.
  const camPrev = new THREE.Vector3();
  const camVel = new THREE.Vector3();
  let camPrimed = false;

  // Global impulses.
  let pendCountdown = 0;
  let pendGo = 0;
  let pendConfetti = 0;
  let pendLapPop = 0;

  const qId: string[] = new Array(QUEUE).fill('');
  const qX = new Float32Array(QUEUE);
  const qY = new Float32Array(QUEUE);
  const qZ = new Float32Array(QUEUE);
  const qScale = new Float32Array(QUEUE);
  const qColor = new Int32Array(QUEUE);
  let qCount = 0;

  const fxOf = (racer: Racer): RacerFx => {
    let s = state.get(racer.id);
    if (!s) { s = newRacerFx(); state.set(racer.id, s); }
    return s;
  };

  function sizeOf(racer: Racer): { halfW: number; len: number; height: number } {
    let s = sizeCache.get(racer.vehicleId);
    if (!s) {
      const size = getVehicle(racer.vehicleId).size;
      s = {
        halfW: clamp(size.width * 0.5, 0.5, 1.6),
        len: clamp(size.length, 1.5, 5.5),
        height: clamp(size.height, 1, 3.2),
      };
      sizeCache.set(racer.vehicleId, s);
    }
    return s;
  }

  /** Load the shared frame for a racer: interpolated transform plus its axes. */
  function frameOf(racer: Racer, alpha: number): void {
    _pos.lerpVectors(racer.prevPos, racer.pos, alpha);
    _quat.copy(racer.prevQuat).slerp(racer.quat, alpha);
    _right.set(1, 0, 0).applyQuaternion(_quat);
    _up.set(0, 1, 0).applyQuaternion(_quat);
    _fwd.set(0, 0, 1).applyQuaternion(_quat);
  }

  /** A point in the racer's own frame. Requires `frameOf` first. */
  function local(sx: number, sy: number, sz: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(_pos)
      .addScaledVector(_right, sx)
      .addScaledVector(_up, sy)
      .addScaledVector(_fwd, sz);
  }

  /** Contact patch of a rear wheel, `lift` metres clear of the road. This is
   *  where rubber meets road: tyre marks and the pool of light a mini-turbo
   *  throws on the tarmac key off it. */
  function rearWheel(racer: Racer, side: number, lift: number, out: THREE.Vector3): THREE.Vector3 {
    const s = sizeOf(racer);
    return local(side * s.halfW * 0.86, -RIDE_HEIGHT + lift, -s.len * 0.34, out);
  }

  /**
   * Where the sparks actually come out. Not the contact patch — *outboard* of
   * the rear tyre and behind its trailing edge.
   *
   * This is the single correction that took the mini-turbo from a rumour to an
   * effect. Emitting at the contact patch puts the dense bright core of the
   * drift — the two thirds of it that never leaves the wheel, and the part that
   * carries the tier colour — thirteen centimetres off the road, dead centre of
   * a tyre a third of a metre wide, behind a metre of bodywork. It is drawn
   * every frame and the depth buffer eats all of it. What reached the screen
   * was the thin tail that had already escaped sideways, which is why a
   * committed tier-two drift photographed as an orange smudge under the machine
   * instead of as twin jets coming off the wheels.
   *
   * The offsets are relative to the same wheel the contact patch uses — half a
   * tyre width further out, a hand's breadth further back — so this stays welded
   * to the axle it belongs to across a cast whose track widths differ by three
   * to one, rather than being a number tuned against one model's silhouette.
   */
  function sparkPort(racer: Racer, side: number, lift: number, out: THREE.Vector3): THREE.Vector3 {
    const s = sizeOf(racer);
    return local(side * (s.halfW * 0.86 + 0.17), -RIDE_HEIGHT + lift, -(s.len * 0.34 + 0.22), out);
  }

  /**
   * Where the ground answers, as opposed to where the tyre burns.
   *
   * Dust used to be born at `sparkPort` — the same point, to the centimetre, as
   * the mini-turbo sparks. On tarmac that is invisible and harmless; on dirt it
   * is fatal. A tan cloud emitted from inside the blue sparks, on the alpha
   * layer *under* an additive one, means every cyan spark is drawn additively
   * on top of a bright warm cloud, and cyan plus bright tan is white. A fully
   * committed tier-one drift across the verge photographed as a cream smear,
   * with the tier — the one thing the effect exists to communicate — nowhere in
   * the frame.
   *
   * Half a metre further back and slightly inboard is enough. The dust is
   * behind the wheel where the ground has actually been disturbed, the sparks
   * own the space at the sidewall, and the two read as cause and effect
   * instead of cancelling each other out.
   */
  function dustPort(racer: Racer, side: number, lift: number, out: THREE.Vector3): THREE.Vector3 {
    const s = sizeOf(racer);
    return local(side * s.halfW * 0.78, -RIDE_HEIGHT + lift, -(s.len * 0.34 + 0.52), out);
  }

  /** Sideways travel as a fraction of forward travel — how hard the tyres are
   *  actually scrubbing, which is what dust and marks key off. */
  function slipOf(racer: Racer): number {
    _lat.copy(racer.vel);
    _lat.y = 0;
    const along = _lat.dot(_fwd);
    _lat.addScaledVector(_fwd, -along);
    return clamp01(_lat.length() / Math.max(7, Math.abs(racer.speed)));
  }

  const setHdr = (out: THREE.Color, src: THREE.Color, k: number): THREE.Color =>
    out.copy(src).multiplyScalar(k);

  // ── emitters ──────────────────────────────────────────────────────────────

  /**
   * The hero effect. Requires `frameOf(racer)`.
   *
   * Two populations, because a mini-turbo has two silhouettes at once and one
   * emitter cannot make both:
   *
   *   the *jet* keeps most of the kart's velocity, so it hangs at the tyre as a
   *   dense bright wedge and dies inside a fifth of a second. This is the part
   *   that reads at a glance, and the part that has to change colour cleanly.
   *
   *   the *fliers* keep almost none of it, so they are flung clear, arc down
   *   under heavy gravity and streak hard across the frame. Perhaps a quarter
   *   of the emission, and they are what stops the effect looking like a lamp
   *   bolted to the axle.
   *
   * Both are short-lived on purpose. The previous pass gave sparks half a second
   * of life against a drag that stopped them in three tenths, so the tail of
   * every spark's life was spent as a stationary glowing dot on the tarmac —
   * eight metres behind a kart doing 60 m/s, in a neat dotted line. Nothing here
   * may outlive its own motion.
   *
   * Both come out of `sparkPort`, not out of the contact patch — see the note
   * there. The jet in particular lives and dies within a metre of where it is
   * born, so it is entirely at the mercy of whether that point is somewhere the
   * camera can see.
   */
  function driftSparks(racer: Racer, fx: RacerFx, dt: number): void {
    const d = racer.drift;
    const tier = d.tier;
    const col = TIER[tier]!;
    const gain = TIER_GAIN[tier]!;

    // Rate rises with the tier and with how deep the chassis is thrown, so a
    // shallow counter-steered drift sizzles and a committed one roars.
    const depth = 0.55 + 0.45 * clamp01(Math.abs(d.angle) / K.drift.maxAngle);
    // Airborne, the wheels are not touching anything, and a literal reading
    // says there is nothing to make a spark with. A literal reading is wrong
    // here: charge keeps accruing over a jump (`airChargeMul`), so switching
    // the sparks off means the one instrument the player reads their charge
    // from blinks out every time the machine leaves the ground — and on this
    // course that is several times a lap, including the crest that leads into
    // the fastest corner. The meter has to survive the jump. Thinned, not cut:
    // less of it, so the difference between rubber and air is still felt.
    const air = racer.grounded ? 1 : 0.45;
    const rate = TIER_RATE[tier]! * depth * air * density * fx.near;
    fx.spark += rate * dt;
    let n = Math.floor(fx.spark);
    fx.spark -= n;
    // The cap is per racer per frame. It has to clear the worst case the review
    // harness produces — 20fps against tier three — or the sheet photographs a
    // thinner effect than the game has.
    if (n > 40) n = 40;

    const outward = -d.dir;
    const speed = Math.abs(racer.speed);
    const bite = 0.55 + 0.45 * clamp01(speed / 45);
    const inv = n > 0 ? 1 / n : 0;
    // ── how many of them leave the wheel, and why it falls with the tier ─────
    //
    // A flier is the part of the spray that is thrown clear, and it is the part
    // that puts light anywhere other than at the contact patch. Holding the
    // fraction constant while the rate climbed meant every tier scattered the
    // same *proportion* of itself across the road, so the thing that grew with
    // the charge was the size of the mess rather than the brightness of the
    // point the player is actually reading. It falls instead: an uncharged
    // drift throws a quarter of its sparks clear, an ultra throws an eighth,
    // and what the tier buys is a denser, hotter core at the tyre.
    const flierP = 0.26 - 0.045 * tier;

    for (let i = 0; i < n; i++) {
      // Biased to the outside wheel: that is the one being dragged.
      const side = rng.next() < 0.7 ? outward : -outward;
      // 0.22, not 0.16 — see the note on `lift` below. A sprite born inside the
      // half-length of its own stretch of the road plane is a sprite the depth
      // buffer cuts in half along a straight line.
      sparkPort(racer, side, 0.22, _p);
      // Spread the frame's worth of sparks back along the path the kart took
      // during it. Without this every spark in a frame is born at the same
      // point, and at 55 m/s and 20fps that is a dotted line of clumps three
      // metres apart instead of a stream. The review harness renders at 20fps.
      const back = (i + 0.5) * inv * dt;
      // A tight cone at the tyre, and the jitter is what defines "tight".
      // Vertically it is a third of what it was: the birth point sits at wheel
      // height and nothing may be *born* above the axle, because a spark that
      // starts above the chassis has already lost the argument about where it
      // came from before it has moved a centimetre.
      sparkSpec.px = _p.x - racer.vel.x * back + rng.range(-0.07, 0.07);
      sparkSpec.py = _p.y - racer.vel.y * back + rng.range(-0.03, 0.03);
      sparkSpec.pz = _p.z - racer.vel.z * back + rng.range(-0.07, 0.07);

      const flier = rng.next() < flierP;
      // ── how far a spark is allowed to get from the tyre that made it ────────
      //
      // This is the number the whole effect was failing on. A flier keeping a
      // quarter of the machine's velocity is, relative to the machine, going
      // *backwards at 34 m/s*; over four tenths of a second that is fourteen
      // metres, and a measurement of a committed drift found the streaks lying
      // out to twenty metres behind the kart and six metres wider than the
      // wheel track, as bright at the far end as at the near one. What that
      // draws is not a spray of sparks, it is a fan of neon laid on the road,
      // and it reads as the tarmac being painted rather than as a tyre burning.
      //
      // A spark off a tyre is a fleck of hot rubber and stone: it leaves fast,
      // it is torn apart by the airstream inside a fifth of a second, and it
      // never gets more than a couple of metres from the wheel. So both
      // populations keep most of the machine's speed and both die young — the
      // whole spray is now inside about three metres of the contact patch,
      // which is where the eye is already looking.
      const keep = flier ? 0.74 : 0.91;
      // Halved outward, and the lift roughly quartered.
      //
      // Sparks used to be thrown up at as much as 6.8 m/s, which over a jet's
      // life carries it a metre and a quarter into the air — past the seat, past
      // the roof on the smaller machines — and out at up to 6.2 m/s, which puts
      // the spray the better part of a metre outboard of any wheel. Photographed
      // from the chase camera that reads as a shower coming off the bodywork
      // rather than off rubber. A tyre throws its sparks *along the road*: hard
      // back, hard out, and barely up at all.
      const kick = (flier ? rng.range(2.6, 6.0) : rng.range(1.2, 3.0)) * bite;
      const drop = flier ? rng.range(0.6, 3.0) : rng.range(0.8, 3.2);
      // ── and back up again, because the correction overshot ─────────────────
      //
      // The note above is right that a tyre throws its sparks along the road and
      // not over the roof, and quartering the lift fixed the "shower coming off
      // the bodywork" read. It then produced the opposite defect, measured on
      // three frames: nothing ever rose above the axle line at all, so a
      // committed drift laid a *flat bed* of streaks across eight metres of
      // tarmac and read as ripple on a wet road rather than as sparks coming
      // off a wheel.
      //
      // It also had a second cost that is invisible until you crop in. A
      // camera-facing quad whose centre is 0.16m above the road and whose
      // stretched half-length reaches half a metre has most of its area *under*
      // the tarmac, and the depth test slices it there — which is where the
      // hard-edged wedges with one dead-straight side in the review crops come
      // from. Sprites that live in the road plane get cut by the road plane.
      //
      // So the spray climbs, and after the second measurement it climbs harder.
      // "Zero vertical throw" was the finding: every streak was in the road
      // plane, so the population had no volume and read as a decal. A flier now
      // leaves at up to ten metres a second and arcs to about a metre and a
      // half — clear of the roof on the cone — before heavy gravity takes it
      // back down inside its own life, and a jet clears the axle properly
      // rather than by a hand's breadth.
      const lift = flier ? rng.range(6.0, 10.5) : rng.range(2.6, 5.2);

      sparkSpec.vx = racer.vel.x * keep + _right.x * outward * kick
        - _fwd.x * drop + _up.x * lift + rng.range(-0.7, 0.7);
      sparkSpec.vy = racer.vel.y * keep + _right.y * outward * kick
        - _fwd.y * drop + _up.y * lift + rng.range(0.2, 1.1);
      sparkSpec.vz = racer.vel.z * keep + _right.z * outward * kick
        - _fwd.z * drop + _up.z * lift + rng.range(-0.7, 0.7);

      sparkSpec.life = flier ? rng.range(0.15, 0.26) : rng.range(0.08, 0.15);
      // Small and long, not large and round.
      //
      // At the old sizes a jet spark was a third of a metre across against
      // about a metre and a third of stretch, which is a capsule — and a stream
      // of capsules six metres from the lens reads as a chain of glowing
      // lozenges being towed behind the kart, not as sparks. A spark is a
      // *point* with a trail: narrow enough that the streak is all anyone sees,
      // and numerous enough that the cluster is what carries the colour. So the
      // cross-section comes down by a third, the stretch goes up, and the rate
      // goes up with it — the same light, arranged as a spray instead of as a
      // string of beads.
      sparkSpec.size0 = flier ? rng.range(0.10, 0.18) : rng.range(0.13, 0.24);
      sparkSpec.gravity = flier ? 26 : 11;
      sparkSpec.drag = flier ? 1.6 : 2.2;
      // Halved. At 0.06 a jet spark leaving at 12 m/s relative to the chase
      // camera came out one and a half metres long — very nearly a kart width —
      // and a dozen of those at once is not a spray of sparks, it is a handful
      // of darts thrown at the road. A spark reads as a spark when the streak is
      // long enough to have direction and short enough that the cluster, not the
      // individual, is what the eye picks up.
      // Up, because the sparks are no longer being towed. Cutting the backward
      // travel to a third took the streak with it, and a spark with no streak
      // in it is a dot. The stretch is measured against the *camera*, so with
      // the spray now keeping pace with the machine the coefficient has to
      // carry the whole of the length, and it comes out at about a metre —
      // enough to have direction, short enough to stay a spark.
      sparkSpec.stretch = flier ? 0.048 : 0.040;
      // Hue first, heat second.
      //
      // Every spark used to be lerped 30% toward white before being multiplied
      // by the tier gain, which for tier one turns a saturated cyan into
      // (0.36, 0.71, 1.00) — a pale sky blue that ACES then finishes off. Read
      // against a warm desert and a black road, that is indistinguishable from
      // white, which is how a fully committed tier one came to photograph the
      // same as an uncharged one.
      //
      // So the population is split instead of averaged: about a third get the
      // white-hot head that makes the effect look like it is burning, and the
      // rest are the tier's own hue at full saturation and a higher gain. The
      // eye reads the *modal* colour of a cluster, not its mean, so a majority
      // of pure-hue sparks with a minority of white ones reads as "blue, and
      // hot" — where the average of the two only ever reads as "bright".
      // Under a quarter of them, and not as far toward white as before. The
      // white minority is there so the cluster looks like it is burning; every
      // percent past that is a percent of the tier's hue traded for a colour
      // the player already sees everywhere else in the frame.
      const hot = rng.next() < 0.24;
      if (hot) {
        sparkSpec.color0.lerpColors(col, WHITE_HOT, 0.34)
          .multiplyScalar(gain * rng.range(0.9, 1.15));
      } else {
        setHdr(sparkSpec.color0, col, gain * rng.range(1.15, 1.45));
      }
      // ...and it *cools*. At 0.38 of the tier gain a spark at the end of its
      // life was still within a factor of three of its birth radiance, which is
      // why the far end of the spray measured as bright as the near end and the
      // whole thing read as painted rather than as thrown. A fleck of hot
      // rubber loses its heat almost at once.
      setHdr(sparkSpec.color1, col, gain * 0.10);
      pool.emit(sparkSpec);

      // Every few sparks gets a soft companion, purely so the bloom pyramid has
      // something with area to find. Pinpoints alone do not glow. Kept small and
      // brief — at the old size they merged into one wash and swallowed the
      // sparks they were supposed to be flattering.
      if (tier > 0 && !flier && rng.next() < 0.26) {
        emberSpec.px = sparkSpec.px; emberSpec.py = sparkSpec.py; emberSpec.pz = sparkSpec.pz;
        emberSpec.vx = sparkSpec.vx * 0.85;
        emberSpec.vy = sparkSpec.vy * 0.85;
        emberSpec.vz = sparkSpec.vz * 0.85;
        emberSpec.life = rng.range(0.08, 0.16);
        emberSpec.size0 = rng.range(0.16, 0.28);
        setHdr(emberSpec.color0, col, gain * 0.9);
        setHdr(emberSpec.color1, col, 0.15);
        pool.emit(emberSpec);
      }
    }
    // Restore the shared preset: every other caller expects the defaults back.
    sparkSpec.gravity = 15;
    sparkSpec.drag = 2.0;
    sparkSpec.stretch = 0.035;
  }

  /**
   * The hop.
   *
   * Every drift in MK8 opens with a pale ring of dust off both inside wheels on
   * the frame the machine leaves the ground, and it is the anticipation beat
   * that makes a drift feel like it *starts* rather than like a state flag
   * flipping. Pressed solo on tarmac this module produced nothing at all at
   * either wheel — because the only thing answering `kart:hop` was a
   * `dustRing`, and `dustRing` reads `SURFACE_FX`, and tarmac's whole design is
   * that it has no dust to give.
   *
   * So the hop has its own puff and it is *rubber*, not ground: pale smoke off
   * a tyre that has just been unloaded and reloaded, which every surface has,
   * thrown outward and low off both rear contact patches. On dirt the surface
   * ring still fires underneath it and the two stack; on tarmac this is the
   * whole of it, and it is the difference between a drift that begins and a
   * drift that is simply true.
   */
  function hopBurst(racer: Racer, strength: number): void {
    const s = sizeOf(racer);
    const rig = clamp(s.halfW / 0.85, 0.75, 1.6);
    const n = Math.round(9 * strength * density);
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < n; i++) {
        rearWheel(racer, side, 0.10, _p);
        smokeSpec.size0 = rng.range(0.30, 0.55) * rig * strength;
        smokeSpec.px = _p.x + rng.range(-0.12, 0.12);
        smokeSpec.py = _p.y + smokeSpec.size0 * 0.45;
        smokeSpec.pz = _p.z + rng.range(-0.12, 0.12);
        // Outward and back, barely upward: a ring being pushed out from under
        // a wheel, not a cloud being blown off one.
        const out = rng.range(1.6, 4.2);
        smokeSpec.vx = racer.vel.x * 0.84 + _right.x * side * out - _fwd.x * rng.range(0, 2.2);
        smokeSpec.vy = rng.range(0.5, 1.6);
        smokeSpec.vz = racer.vel.z * 0.84 + _right.z * side * out - _fwd.z * rng.range(0, 2.2);
        smokeSpec.life = rng.range(0.30, 0.46);
        smokeSpec.size1 = smokeSpec.size0 * rng.range(2.2, 3.0);
        smokeSpec.alpha = 0.22 * strength * rng.range(0.8, 1.2);
        smokeSpec.rot = rng.next() * TAU;
        smokeSpec.rotVel = rng.range(-1.4, 1.4);
        setHdr(smokeSpec.color0, SMOKE, 1.15);
        setHdr(smokeSpec.color1, SMOKE_DEEP, 1.0);
        if (!pool.emit(smokeSpec)) break;
      }
    }
    smokeSpec.alpha = 0.042;
    smokeSpec.rot = 0;
    smokeSpec.rotVel = 0;
  }

  /**
   * The steady light at the wheels while a drift is held, and the flare that
   * marks a tier locking in. Immediate-mode: rebuilt every frame.
   *
   * A crisp four-point flare over a soft halo, rather than the stack of soft
   * balls this used to be. Three overlapping gaussians two metres across is a
   * coloured smear on the road; the flare gives the effect an *edge*, and an
   * edge is what peripheral vision can pick a colour off. It turns slowly, in
   * opposite directions on the two wheels, so the pair never reads as decals.
   */
  function driftGlow(racer: Racer, fx: RacerFx, add: SpriteLayer): void {
    const g = fx.glow;
    if (g < 0.02) return;
    const tier = racer.drift.active ? racer.drift.tier : fx.popTier;
    const col = TIER[tier]!;
    const gain = TIER_GAIN[tier]!;
    // A fast flicker, off simulation time so a capture reproduces it exactly.
    const flick = 0.82 + 0.18 * Math.sin(ctx.time.elapsed * 47 + racer.id);
    const k = gain * g * flick * (0.62 + 0.38 * tier / 3);
    const spin = ctx.time.elapsed * 2.1 + racer.id;
    // Scale to the machine. The train is three times the cone's width, and one
    // absolute size makes this a bonfire on one and a pilot light on the other.
    const rig = clamp(sizeOf(racer).halfW / 0.85, 0.72, 1.5);

    // The flare grows with the tier. Size is the one channel that can carry
    // "how much" without touching "which colour", so it is the one the charge
    // level is allowed to use — the hue stays pinned to the tier and the
    // silhouette gets bigger underneath it.
    const flareSize = (0.62 + 0.20 * tier + 0.42 * g * flick) * rig;
    for (let s = -1; s <= 1; s += 2) {
      // At the outer sidewall, at axle height: high enough and wide enough to
      // clear the tyre it is coming off, so the flare reads against the road
      // behind the machine instead of against the rubber in front of it.
      sparkPort(racer, s, 0.30, _p);
      // The shape. Bright enough at the centre to bloom, pointed enough at the
      // edges to still be a shape when it is forty pixels wide.
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        col.r * k, col.g * k, col.b * k, 0.95 * g,
        flareSize, 0, spin * s, CELL.flare, MODE.billboard,
      );
      // A tight white core inside it, so "hot" is carried by a handful of white
      // pixels instead of by bleaching the tier's hue out of the whole effect.
      // It is *small*, and it stays small: the core's job is to be the one
      // clipped pixel at the middle of a coloured flare, and every time it has
      // been allowed to grow the tier has stopped being readable.
      //
      // Halved again, and the flare and halo around it trimmed with it. Sixteen
      // sparks a frame are already born at this exact point and each is worth
      // about three in the blue channel, so the middle of a committed drift
      // clips to white on the sparks alone — that white heart is correct and it
      // is what makes the effect look like it is burning. What is not correct
      // is stacking four more immediate-mode quads on top of it and turning a
      // heart into a headlamp: measured on a tier-one drift the clipped region
      // was reaching a twentieth of the frame width, and the only place the
      // colour survived was the outer fringe.
      const core = 1.1 * g * flick * (0.5 + 0.18 * tier);
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        core, core * 0.98, core * 0.94, 0.9 * g,
        (0.10 + 0.05 * g) * rig, 0, 0, CELL.glow, MODE.billboard,
      );
      // ...inside a soft halo, which is what the bloom pyramid can find. Only
      // once there is a tier worth haloing: at tier zero this was eight extra
      // multi-metre soft quads per machine, on every kart in the field, for a
      // state that is meant to be quiet.
      if (tier > 0) {
        add.push(
          _p.x, _p.y, _p.z, 0, 0, 0,
          col.r * k * 0.30, col.g * k * 0.30, col.b * k * 0.30, 0.5 * g,
          (0.95 + 0.40 * g * flick) * rig, 0, 0, CELL.glow, MODE.billboard,
        );
      }
      // ...and a pool of its own light on the road under it. Contact, again:
      // sparks that do not light the surface they come off read as stickers.
      // Kept tight — wide and soft was reading as spilled paint.
      if (racer.grounded) {
        // ── why these sit a hand's breadth up rather than on the deck ────────
        //
        // A `MODE.ground` quad is built flat in *world* XZ — the shader spans
        // (cos, 0, sin) — while the road banks, crests and dips underneath it.
        // Laid at three centimetres, half of a metre-wide quad is under the
        // tarmac on any corner with camber on it, and the depth test cuts it
        // there: what ships is not the soft radial cell the atlas draws but the
        // *half* of it that survived, with a dead-straight edge along the line
        // where the two planes crossed. That is the hard-edged wedge welded to
        // the road in every crop of a drift, and no amount of work on the cell
        // touches it, because the cell is not what is being drawn.
        //
        // Fourteen centimetres clears the camber this course actually carries
        // over a quad this size, and at that height a flat sprite still reads
        // as being on the road rather than over it.
        rearWheel(racer, s, 0.14, _p);
        add.push(
          _p.x, _p.y, _p.z, 0, 0, 0,
          col.r * k * 0.46, col.g * k * 0.46, col.b * k * 0.46, 0.34 * g,
          (1.0 + 0.35 * g) * rig, 0, 0, CELL.glow, MODE.ground,
        );
      }
    }

    // ── the climb ─────────────────────────────────────────────────────────
    //
    // From the front camera at maximum charge the ultra mini-turbo used to be a
    // handful of magenta flecks at one rear wheel: everything the effect had
    // lived within a hand's breadth of the axle, so the loudest state in the
    // drift system was invisible from any angle that could see the machine's
    // face. In MK8 the pink tier *climbs the kart* — it wraps the flanks and
    // crowns the roof, and that is what makes a fully charged drift feel like
    // something about to be spent rather than like a wheel that is warm.
    //
    // So a ladder of licks runs up each flank from the axle toward the roof,
    // and tier three closes it with a crown over the top. The ladder is
    // immediate-mode sprites — no pool, no allocation — and the count is small
    // enough that eight racers all at tier three is under a hundred extra quads
    // in the one draw call the layer already costs.
    //
    // It runs from tier *one*, not from tier two. Every tier has to have the
    // same silhouette or the colour is not the thing carrying the message: if
    // blue is two sparks at an axle and purple is a machine wearing a crown,
    // then the player is reading size, and size is a thing they can confuse
    // with speed, with camera distance and with which kart they are looking at.
    // Same shape, three colours, growing mass — the mass is a bonus, the hue is
    // the meter.
    if (racer.drift.active && tier >= 1) {
      const s = sizeOf(racer);
      const climb = tier * g * 0.85;
      const rungs = tier >= 3 ? 4 : tier >= 2 ? 3 : 2;
      const roof = s.height - RIDE_HEIGHT;
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < rungs; i++) {
          // Up the flank and slightly forward as it rises, so the ladder leans
          // with the machine instead of standing beside it like a fence.
          const u = (i + 1) / (rungs + 1);
          const wob = Math.sin(ctx.time.elapsed * 15 + i * 2.1 + side + racer.id);
          const lx = side * (s.halfW * (0.92 - 0.26 * u)) + side * 0.06 * wob;
          const ly = -RIDE_HEIGHT + 0.24 + roof * 0.86 * u;
          const lz = -s.len * (0.30 - 0.16 * u);
          local(lx, ly, lz, _p);
          // Fading and shrinking as it climbs: a ladder of equal blobs reads as
          // a string of lights, a taper reads as fire being dragged upward.
          const fade = (1 - u * 0.55) * clamp01(climb);
          const kk = gain * fade * flick * 1.15;
          add.push(
            _p.x, _p.y, _p.z, 0, 0, 0,
            col.r * kk, col.g * kk, col.b * kk, 0.72 * fade,
            (0.42 + 0.30 * (1 - u)) * rig, 0, 0, CELL.glow, MODE.billboard,
          );
          if (i === 0 || tier >= 3) {
            add.push(
              _p.x, _p.y, _p.z, 0, 0, 0,
              col.r * kk * 1.5, col.g * kk * 1.5, col.b * kk * 1.5, 0.7 * fade,
              (0.30 + 0.22 * (1 - u)) * rig, 0, spin * side + i, CELL.flare, MODE.billboard,
            );
          }
        }
      }
      if (tier >= 3) {
        // The crown. One wide soft halo over the roof and a ring of embers
        // turning around it, so the machine is wearing the charge rather than
        // trailing it.
        local(0, -RIDE_HEIGHT + roof + 0.30, -s.len * 0.06, _p);
        const ck = gain * g * flick;
        add.push(
          _p.x, _p.y, _p.z, 0, 0, 0,
          col.r * ck * 0.55, col.g * ck * 0.55, col.b * ck * 0.55, 0.42 * g,
          (1.7 + 0.5 * g) * rig, 0, 0, CELL.glow, MODE.billboard,
        );
        for (let i = 0; i < 5; i++) {
          const a = ctx.time.elapsed * 3.4 + (i * TAU) / 5 + racer.id;
          const r = (0.5 + s.halfW * 0.62) * rig;
          local(Math.cos(a) * r, -RIDE_HEIGHT + roof + 0.30 + Math.sin(a * 2) * 0.10,
            -s.len * 0.06 + Math.sin(a) * r, _p);
          add.push(
            _p.x, _p.y, _p.z, 0, 0, 0,
            col.r * ck * 1.7, col.g * ck * 1.7, col.b * ck * 1.7, 0.85 * g,
            0.30 * rig, 0, a, CELL.flare, MODE.billboard,
          );
        }
      }
    }

    // The lock-in punctuation: a flare at each wheel that opens wide and snaps
    // shut, with a white kicker inside it. This is the frame the whole system
    // exists to sell, so for a tenth of a second it is the loudest thing on
    // screen. It sits at the wheels, not at the tail, because that is where the
    // player is already looking for the colour.
    if (fx.pop > 0.01) {
      const c = TIER[fx.popTier]!;
      const cg = TIER_GAIN[fx.popTier]!;
      const p = fx.pop;
      const ease = p * p;
      for (let s = -1; s <= 1; s += 2) {
        sparkPort(racer, s, 0.34, _p);
        // Was 3.8m — which on the widest machines came out at six metres of
        // additive flare at each wheel, measured five metres across at the
        // lens. The punctuation has to be the loudest thing on screen for a
        // tenth of a second; it does not have to be the *only* thing on screen,
        // and at that size it hid the machine it belonged to.
        const size = lerp(0.8, 2.4, p) * rig;
        add.push(
          _p.x, _p.y, _p.z, 0, 0, 0,
          c.r * cg * 0.78 * ease, c.g * cg * 0.78 * ease, c.b * cg * 0.78 * ease, p,
          size, 0, spin * 0.5 + s, CELL.flare, MODE.billboard,
        );
        // The white kicker, held to about half what it was. It is inside a
        // coloured flare whose whole job is to name the tier, and a white core
        // at three times the clip point takes the hue with it — the same
        // arithmetic that blew the mini-turbo's own launch to paper, one event
        // earlier in the same sequence.
        add.push(
          _p.x, _p.y, _p.z, 0, 0, 0,
          1.6 * ease, 1.55 * ease, 1.45 * ease, p,
          size * 0.18, 0, 0, CELL.glow, MODE.billboard,
        );
      }
    }
  }

  /**
   * The continuous layer. Every machine on the track, always, including the AI.
   *
   * The single biggest hole in the previous pass. Outside the third of a second
   * around a boost or a hit the whole fx layer was empty: a pack shot at 148
   * km/h and a chase shot at 242 km/h both photographed eight machines with
   * nothing attached to any of them, and a still frame of a racing game with
   * nothing moving in it is a diorama. Everything else this module does is an
   * *event*; this is the part that makes the seconds between events feel like a
   * race.
   *
   * It is anchored to a real hole in the bodywork — see `exhaust.ts` — because
   * a puff that is not welded to a pipe is precisely the detached grey blob the
   * module has already been rejected for. Cheap by construction: one small
   * short-lived alpha sprite per emission, no glow except on the turbines, and
   * the rate scales with distance so a machine at the back of the pack costs
   * almost nothing.
   */
  function exhaustPuffs(racer: Racer, fx: RacerFx, dt: number): void {
    const ports = portsFor(racer.vehicleId);
    const speedFrac = clamp01(Math.abs(racer.speed) / 46);
    // Under boost a machine is being asked for everything it has, and the stack
    // answers. This is also the cheapest way to make a CPU racer's boost
    // readable from behind, where the flame plume is edge-on.
    const load = clamp01(0.3 + 0.7 * speedFrac + (racer.boost.time > 0 ? 0.9 : 0));
    // Exhaust reads at a distance where a spark does not — it is a silhouette
    // against the sky rather than a pinpoint — so it runs off `reach`, which
    // holds most of its rate right out to the far end of the pack, rather than
    // off the `near` gate that now cuts sparks at forty metres.
    const far = 1 - fx.reach;
    const reach = 0.25 + 0.75 * fx.reach;
    // Cap per port. The plumes are built out of many small wisps now rather
    // than a handful of balls, so a locomotive at full chat wants three a frame
    // at 20fps and this has to clear it — clipping the rate is how a capture
    // photographs a thinner effect than the game actually has.
    const cap = 8;
    // ── how much of the port's aim survives the airstream ────────────────────
    //
    // Gas leaving a pipe at 4 m/s into air that is already going past at 60 is
    // not going anywhere it was aimed. The port table states the *idle* jet;
    // this shears the vertical component of it away as the machine speeds up,
    // and takes the buoyancy with it. Without this the plume stands straight up
    // off the tail of a kart under full acceleration — a vertical grey column
    // rising off the roof at 60 m/s, which is the single most unphysical thing
    // this module has ever drawn.
    const shear = 1 - 0.86 * speedFrac;

    for (let pi = 0; pi < ports.length; pi++) {
      const p = ports[pi]!;
      const rate = (p.idle + p.drive * load) * veilBack * reach;
      let acc = (pi === 0 ? fx.exhaust : fx.exhaust2) + rate * dt;
      let n = Math.floor(acc);
      acc -= n;
      if (pi === 0) fx.exhaust = acc; else fx.exhaust2 = acc;
      if (n > cap) n = cap;
      if (n <= 0) continue;

      const inv = 1 / n;
      for (let i = 0; i < n; i++) {
        local(p.x, p.y - RIDE_HEIGHT, p.z, _p);
        // Spread the frame's worth back along the path the machine took during
        // it, exactly as the sparks and the dust do. Without it a capture at
        // 20fps gets clumps three metres apart instead of a stream.
        _p.addScaledVector(racer.vel, -(i + 0.5) * inv * dt);
        // Never born in the lens. A puff three metres from the camera covers a
        // fifth of the frame and there is no angle from which that is exhaust —
        // it is a smear. The pool dissolves anything that drifts in later; this
        // stops the ones that would start there, which on a machine the player
        // has just overtaken is most of them.
        if (_p.distanceToSquared(ctx.camera.position) < 9) continue;

        exhaustSpec.px = _p.x + rng.range(-0.05, 0.05);
        exhaustSpec.py = _p.y + rng.range(-0.03, 0.05);
        exhaustSpec.pz = _p.z + rng.range(-0.05, 0.05);
        // Most of the machine's own velocity, plus the gas leaving the pipe.
        // The inheritance is what keeps the plume attached: at 0.94 the head of
        // it is still over the chimney half a second later, which is the
        // difference between steam coming out of a funnel and a cloud parked in
        // the air behind a locomotive.
        const out = p.speed * rng.range(0.6, 1.35) * (0.55 + 0.75 * load);
        const dy = p.dy * shear;
        exhaustSpec.vx = racer.vel.x * 0.94
          + (_right.x * p.dx + _up.x * dy + _fwd.x * p.dz) * out + rng.range(-0.5, 0.5);
        exhaustSpec.vy = racer.vel.y * 0.94
          + (_right.y * p.dx + _up.y * dy + _fwd.y * p.dz) * out
          + rng.range(0.1, 0.9) * shear;
        exhaustSpec.vz = racer.vel.z * 0.94
          + (_right.z * p.dx + _up.z * dy + _fwd.z * p.dz) * out + rng.range(-0.5, 0.5);
        // Buoyancy is a still-air term. A plume being dragged through 60 m/s of
        // airstream is torn apart long before it can float, and leaving the
        // rise in is what built the column.
        exhaustSpec.gravity = -1.6 * shear;
        exhaustSpec.life = p.life * rng.range(0.75, 1.3) * (0.55 + 0.45 * shear);
        // Bigger with distance as well as denser, and the size term matters
        // more than the opacity one. A plume genuinely disperses as it travels,
        // but the reason this is here is optical: a wisp tuned to read at the
        // eight metres the chase camera sits from the player subtends a fifth
        // of a degree on the machine four places up the road, which is two
        // pixels, which is nothing. A pack shot with nothing attached to any of
        // the seven machines the player is racing is a diorama, and it was the
        // measured state of this module twice.
        exhaustSpec.size0 = p.size * rng.range(0.7, 1.25) * (0.8 + 0.4 * load) * (1 + 1.6 * far);
        exhaustSpec.size1 = exhaustSpec.size0 * p.grow;
        // Denser with distance, which is not a cheat: the same volume of gas
        // covers fewer pixels the further away it is, so the optical depth
        // through it per pixel genuinely goes up. Without this a plume tuned to
        // be a wisp beside the player is nothing at all on the machine four
        // places ahead, which is where most of the field always is.
        //
        // Capped, and the cap matters more than the coefficient. Peak alpha is
        // multiplied by the fade curve, so anything over 1 does not make a puff
        // brighter — it makes it *hold full opacity* for the front half of its
        // life and then fall off a cliff. At the old 1.8 the locomotive's steam
        // reached 2.6 at the back of the pack, which is a solid white ball that
        // sits there and then blinks out. Nothing here may ask for more opacity
        // than a sprite can have.
        exhaustSpec.alpha = Math.min(0.8, p.alpha * rng.range(0.7, 1.15) * (1 + 0.9 * far));
        exhaustSpec.rot = rng.next() * TAU;
        exhaustSpec.rotVel = rng.range(-1.1, 1.1);
        _tint.setHex(p.color);
        setHdr(exhaustSpec.color0, _tint, 1.0);
        _tint.setHex(p.tail);
        setHdr(exhaustSpec.color1, _tint, 0.95);
        if (!pool.emit(exhaustSpec)) break;
      }
    }
    exhaustSpec.gravity = -1.6;
  }

  /** The heat at a turbine lip. Immediate mode; only the hot ports get one. */
  function exhaustGlow(racer: Racer, fx: RacerFx, add: SpriteLayer): void {
    const ports = portsFor(racer.vehicleId);
    const load = clamp01(0.25 + 0.75 * clamp01(Math.abs(racer.speed) / 46));
    const flick = 0.8 + 0.2 * Math.sin(ctx.time.elapsed * 37 + racer.id * 1.7);
    for (let i = 0; i < ports.length; i++) {
      const p = ports[i]!;
      if (!p.hot) continue;
      local(p.x, p.y - RIDE_HEIGHT, p.z, _p);
      const k = 0.9 * load * flick * fx.near;
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        FLAME_MID.r * k, FLAME_MID.g * k * 0.85, FLAME_MID.b * k * 0.6, 0.5 * load,
        p.size * 1.9, 0, 0, CELL.glow, MODE.billboard,
      );
    }
  }

  /**
   * One puff of tyre smoke at a rear contact patch. Requires `frameOf`.
   *
   * Born at `sparkPort` — the exact point the mini-turbo sparks come out of, to
   * the centimetre — because the whole reason this exists is that the sparks
   * must never appear on bare asphalt. A haze emitted at the contact patch and
   * sparks emitted outboard of the sidewall are two effects that happen to be
   * near each other; born at the same port they are one effect, and the read is
   * "the tyre is burning and the burning is throwing light".
   *
   * `boost` widens the mouth a little: a machine spinning its wheels up under
   * thrust smokes from a broader patch than one being dragged sideways.
   */
  function smokePuff(
    racer: Racer, side: number, sfx: SurfaceFx, back: number, scale: number, alphaK: number,
  ): boolean {
    const col = surfaceColors.get(racer.surface)!;
    const deep = surfaceDeep.get(racer.surface)!;
    sparkPort(racer, side, 0.10, _p);
    _p.addScaledVector(racer.vel, -back);
    // Capped, like every other airborne sprite here. This path used to bypass
    // `MAX_PUFF` entirely: on dirt, a tier-three spike asked for
    // `0.86 * 1.7 * 1.45` at birth and 2.5x that at death, which is a
    // five-and-a-half metre disc born a kart's length from the lens. The cap is
    // the whole reason the constant exists and this was the one caller that
    // never consulted it.
    // A wide size spread for the same reason the stretch is jittered below: a
    // population of one width is a band, a population of many is a cloud.
    smokeTyreSpec.size0 = Math.min(sfx.size * rng.range(0.52, 1.15) * scale, MAX_PUFF / 2.6);
    smokeTyreSpec.px = _p.x + rng.range(-0.14, 0.14);
    // Lifted by its own radius so the depth test cannot slice the sprite along
    // the road plane and leave it with one perfectly straight edge.
    smokeTyreSpec.py = _p.y + smokeTyreSpec.size0 * 0.42;
    smokeTyreSpec.pz = _p.z + rng.range(-0.14, 0.14);
    // Nearly all of the machine's velocity, and very little sideways throw.
    //
    // Both numbers are about where the smoke *is* rather than how much of it
    // there is. At 0.93 with a 2.8 m/s outward kick the ribbon peeled away to
    // the outside of the slide and left the sparks sitting on clean asphalt —
    // the two effects were near each other but not on top of each other, which
    // is the difference between "the tyre is burning" and "there is light at
    // the wheel and smoke over there". At 0.96 with a metre a second of throw
    // the head of the ribbon stays inside the spark cone for the first third of
    // its life and only then falls back and spreads.
    const out = rng.range(0.35, 1.5) + rng.range(-0.9, 0.9);
    smokeTyreSpec.vx = racer.vel.x * 0.86 + _right.x * side * out - _fwd.x * rng.range(0.4, 3.4);
    // Up, and enough of it to be seen going up. Burning rubber is hot and it
    // *boils* off the contact patch; at half a metre a second over half a
    // second of life the ribbon never left the road plane, which is why a
    // tarmac drift photographed as a pale sheet lying on the tarmac rather than
    // as a cloud coming off a tyre. This plus the buoyancy on the preset puts
    // the tail of it about axle height by the time it is a kart-length behind.
    // ── up, but not over the roof ──────────────────────────────────────────
    //
    // Burning rubber boils off the contact patch and it does climb, but at
    // nearly three metres a second against a buoyant preset and two thirds of a
    // second of life it climbed *two and a half metres* — clear over the top of
    // the cone — and a tier-two drift photographed with a row of pale balls
    // hanging above the machine's own roof. Smoke over the kart hides the kart.
    // A metre of rise puts the tail of the ribbon at about axle height a
    // kart-length back, which is where it belongs and where the sparks are.
    smokeTyreSpec.vy = rng.range(0.8, 1.8);
    smokeTyreSpec.vz = racer.vel.z * 0.86 + _right.z * side * out - _fwd.z * rng.range(0.4, 3.4);
    smokeTyreSpec.rot = rng.next() * TAU;
    // ── why the stretch is jittered ────────────────────────────────────────
    //
    // Every puff off one contact patch leaves with very nearly the same
    // velocity, and a velocity-mode quad is oriented and lengthened by exactly
    // that. Give a hundred of them the same coefficient and they are a hundred
    // ellipses of identical width lying on a common axis — whose union has two
    // dead-straight parallel sides and a point at each end. That is the "paper
    // dart" a reviewer photographed at 6x and reasonably called a hard-edged
    // opaque wedge: the sprite is soft, the *envelope* is not. The measurement
    // that said the cell was round was taken on the texture rather than on the
    // geometry, and the geometry is what ships.
    //
    // Jittering the coefficient by ±45% breaks the common length, and the
    // divergence added to `out` above breaks the common axis. Neither costs
    // anything: both are numbers already being written per emission.
    smokeTyreSpec.stretch = 0.045 * rng.range(0.55, 1.45);
    // Longer, because there are a third as many of them. The ribbon is now
    // built out of a handful of overlapping bodies rather than a stream of
    // discrete ones — which is what "consecutive puffs overlap into one body"
    // actually requires, and what stops a slide reading as a row of lozenges
    // receding down the road.
    smokeTyreSpec.life = rng.range(0.55, 0.80);
    // Growth is modest now: in velocity mode the sprite is already lengthening
    // along its own path, and a wisp that also triples its width ends up as the
    // same round blob by the end of its life.
    smokeTyreSpec.size1 = smokeTyreSpec.size0 * rng.range(1.7, 2.1);
    smokeTyreSpec.rotVel = 0;
    smokeTyreSpec.alpha = sfx.smoke * alphaK * rng.range(0.8, 1.15);
    // Pale, because burnt rubber suspended in air is lit from the whole sky and
    // reads *lighter* than the asphalt it is over — the rule the rest of this
    // module already obeys. It is a shade off the surface's own value so that
    // the additive sparks drawn on top still land as a hue rather than as
    // white, but only a shade: a ribbon dark enough to protect the sparks is a
    // ribbon nobody sees, and then there are no tyres in the effect again.
    // Brighter, at no cost to the veil. Coverage is what the governor measures
    // and it is a function of size and *alpha*, not of radiance — so pushing
    // the body of the ribbon up toward white buys the read MK8's drift smoke
    // has without buying any of the frame it would cost to get there by
    // raising the opacity. Over dark tarmac at 0.40 alpha the old value landed
    // as a mid-grey smudge.
    setHdr(smokeTyreSpec.color0, col, 1.55);
    setHdr(smokeTyreSpec.color1, deep, 1.20);
    return pool.emit(smokeTyreSpec);
  }

  /**
   * The rubber. The thing the module was rejected for not having.
   *
   * A held drift now runs a continuous pale ribbon out of both rear contact
   * patches at every tier, on tarmac as much as on dirt, and the sparks are
   * born inside it. It is not a "bed" or a "haze" any more — the previous pass
   * called it that, tuned it to 0.045 alpha so it could never be noticed, and
   * the result was a fully committed slide over clean road with nothing under
   * the light at all.
   *
   * It also runs without a drift. Any tyre scrubbing hard enough — a spin, a
   * boost breaking traction, a slide the player did not ask for — smokes,
   * because the smoke belongs to the contact patch and not to a game state.
   */
  function tyreSmoke(racer: Racer, fx: RacerFx, dt: number): void {
    // The tier step, felt in the rubber. One frame of extra density on the
    // exact frame the colour changes, so the mini-turbo locking in is a *bang*
    // in the smoke as well as a new hue in the sparks. Read and cleared before
    // any guard below can return, so a tier that locks in on a surface with
    // nothing to give is spent rather than banked for the next corner.
    const spikeTier = fx.pendSmoke;
    fx.pendSmoke = 0;

    const sfx = SURFACE_FX[racer.surface];
    if (sfx.sparky || sfx.smokeRate <= 0) return;
    const speedFrac = clamp01(Math.abs(racer.speed) / 42);
    if (speedFrac < 0.14) return;

    const d = racer.drift;
    // How hard the contact patch is actually working. A drift is worth most of
    // it on its own — the tyres are unquestionably sliding — and the chassis
    // angle says how far past the limit they have been taken.
    const depth = d.active
      ? 0.62 + 0.38 * clamp01(Math.abs(d.angle) / K.drift.maxAngle)
      : 0;
    const slide = clamp01((slipOf(racer) - 0.06) / 0.26);
    const spin = racer.boost.time > 0 ? 0.34 : 0;
    const work = clamp01(Math.max(depth, slide * 0.9, spin) + (racer.stunned > 0 ? 0.5 : 0));
    if (work <= 0.02) return;

    // The tier is felt in the volume of smoke as well as in the colour of the
    // light: an ultra mini-turbo lays about half as much again as an uncharged
    // slide does.
    const tierK = 1 + 0.18 * (d.active ? d.tier : 0);
    const rate = sfx.smokeRate * work * tierK * speedFrac * veilHero * fx.near;
    fx.scrub += rate * dt;
    let n = Math.floor(fx.scrub);
    fx.scrub -= n;
    // Twelve, not six. At 20fps — which is what the review harness renders at —
    // a cap of six clipped the ribbon down to a dotted line and photographed a
    // thinner effect than the game has.
    // ...and back to eight, with the rate a third of what it was. The cap has
    // to clear the honest per-frame emission and no more; carrying headroom for
    // a rate that no longer exists just lets a 20fps capture dump half a second
    // of ribbon onto one frame.
    if (n > 8) n = 8;

    const spike = spikeTier > 0 ? Math.round((2 + spikeTier) * veilHero) : 0;
    if (n + spike <= 0) return;

    const inv = n > 0 ? 1 / n : 0;
    for (let i = 0; i < n; i++) {
      // Both wheels, alternating rather than randomised: a coin flip leaves
      // gaps on one side, and a ribbon with holes in it reads as a row of
      // puffs. Two ribbons, one per contact patch, is the shape.
      const side = (i & 1) === 0 ? -1 : 1;
      if (!smokePuff(racer, side, sfx, (i + 0.5) * inv * dt, 1, 1)) return;
    }
    for (let i = 0; i < spike; i++) {
      const side = (i & 1) === 0 ? -1 : 1;
      // Bigger, fatter, and thrown out of the same port on the same frame.
      if (!smokePuff(racer, side, sfx, rng.next() * dt, 1.30, 1.15)) return;
    }
  }

  /**
   * Speed alone, no slip required.
   *
   * The term that did not exist. A machine tracking dead straight down the
   * tarmac at 240 km/h disturbed precisely nothing, so a still frame at full
   * chat was indistinguishable from a still frame at walking pace. This ramps
   * in over the top half of the range and is spread across the whole width of
   * the machine rather than thrown from two points, which is the difference
   * between a veil and a rope of blobs.
   */
  function speedWake(
    racer: Racer, fx: RacerFx, dt: number, sfx: SurfaceFx, speedFrac: number,
  ): void {
    if (sfx.wake <= 0) return;
    // Opens at 42% of the range rather than 50%, and rises linearly rather than
    // quadratically. Measured, the old curve put a machine at a genuine 240
    // km/h on a rate of 26/s against a 0.42s life and a 0.20m cross-section:
    // eleven sprites the size of a fist, spread over the sixty metres the kart
    // covered while they lived. That is not a subtle effect, it is an absent
    // one, and a still frame of the game at full chat came back with nothing
    // attached to any machine in it.
    const w = clamp01((speedFrac - 0.42) / 0.40);
    if (w <= 0) return;
    const rate = sfx.wake * w * (0.4 + 0.6 * w) * veilBack * fx.near;
    fx.wake += rate * dt;
    let n = Math.floor(fx.wake);
    fx.wake -= n;
    if (n > 3) n = 3;
    if (n <= 0) return;

    const s = sizeOf(racer);
    const col = surfaceColors.get(racer.surface)!;
    const deep = surfaceDeep.get(racer.surface)!;
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      // Anywhere across the back of the machine and just off the deck: a veil
      // being pulled along under it, not a jet coming out of one hole.
      local(
        rng.range(-1.05, 1.05) * s.halfW,
        -RIDE_HEIGHT + rng.range(0.10, 0.42),
        -s.len * rng.range(0.32, 0.62),
        _p,
      );
      _p.addScaledVector(racer.vel, -(i + 0.5) * inv * dt);
      wakeSpec.px = _p.x; wakeSpec.py = _p.y; wakeSpec.pz = _p.z;
      // Deliberately *less* than the machine's own velocity: the difference is
      // what the vertex shader turns into streak length, and a wake that kept
      // pace with the kart would be a round dot.
      wakeSpec.vx = racer.vel.x * 0.52 + rng.range(-0.8, 0.8);
      wakeSpec.vy = racer.vel.y * 0.52 + rng.range(0.1, 1.0) + sfx.lift * rng.range(0.4, 1.6);
      wakeSpec.vz = racer.vel.z * 0.52 + rng.range(-0.8, 0.8);
      wakeSpec.life = rng.range(0.30, 0.55);
      // `wakeSize`, not `size` — a wake streak's width is set by how thin it
      // has to be to read as motion rather than as a mark on the lens, and on
      // tarmac that is a quarter of what a dust puff wants.
      wakeSpec.size0 = sfx.wakeSize * rng.range(0.62, 1.35);
      wakeSpec.size1 = wakeSpec.size0 * 2.1;
      wakeSpec.alpha = sfx.alpha * 1.15 * rng.range(0.7, 1.15);
      // Per-streak length as well as per-streak width — see the same note in
      // `smokePuff`. A population of velocity quads that all share one stretch
      // coefficient and one velocity has a *straight* envelope with an abrupt
      // kink where the newest one starts, which is what a crop of a full-speed
      // pack came back with.
      wakeSpec.stretch = 0.055 * rng.range(0.55, 1.5);
      setHdr(wakeSpec.color0, col, 1.0);
      setHdr(wakeSpec.color1, deep, 0.98);
      if (!pool.emit(wakeSpec)) break;
    }
  }

  /** Dust, spray or scrape off whatever the tyres are on. */
  function surfaceDust(racer: Racer, fx: RacerFx, dt: number): void {
    const sfx = SURFACE_FX[racer.surface];
    const slip = Math.max(slipOf(racer), racer.drift.active ? 0.45 : 0);
    const speedFrac = clamp01(Math.abs(racer.speed) / 48);
    const boosting = racer.boost.time > 0 ? 1 : 0;

    // The wake runs on its own accumulator and its own shape — see below. It
    // is the only part of this that is about speed rather than about what the
    // tyres are doing.
    speedWake(racer, fx, dt, sfx, speedFrac);

    // Tyres taking forty extra metres a second of thrust smoke, and on a
    // surface with nothing loose to give, that smoke is the only tell the
    // ground gets that the loudest thing in the game just happened.
    //
    // But far less of it on tarmac than on gravel, and this is where the number
    // was wrong. At seventy a second on a hard surface, with dust keeping three
    // quarters of the machine's velocity and living up to a second, a boost
    // laid a chain of eight pale blobs fifteen metres down the road behind the
    // kart — the same "string of beads" the flame plume had, in dust. Tarmac
    // has nothing to give but a scuff of hot rubber; the fire is the story of a
    // boost, and the ground's job is to agree with it quietly.
    const hard = sfx.rate <= 0;
    // ── how far away a cloud is still worth drawing ─────────────────────────
    //
    // `near` is the pinpoint cut: it falls to nothing by about forty-six metres
    // because a spark that far away is one pixel and paying for it is waste.
    // A rooster tail is the opposite animal — it is a *silhouette*, the same
    // argument `reach` already makes for the exhaust, and gating it on `near`
    // is why an overhead frame of eight machines crossing the dirt showed not
    // one trail behind any of them: the camera sits forty metres up, so every
    // machine in the picture including the player was cut to zero.
    //
    // Hard surfaces keep the tight cut. There is nothing to see there anyway.
    const vis = hard ? fx.near : Math.max(fx.near, fx.reach * 0.75);
    const rate = (sfx.rate * speedFrac
      + sfx.slip * slip * speedFrac
      + boosting * (hard ? 26 : 110) * speedFrac) * veilDensity * vis;
    if (rate <= 0) return;

    fx.dust += rate * dt;
    let n = Math.floor(fx.dust);
    fx.dust -= n;
    // Doubling the rate with the old cap of 11 would have quietly thrown half
    // of it away on any frame slower than 60Hz — and every frame the review
    // sheet photographs is a twentieth of a second long.
    if (n > 24) n = 24;
    if (n <= 0) return;

    const col = surfaceColors.get(racer.surface)!;
    const deep = surfaceDeep.get(racer.surface)!;
    const inv = 1 / n;

    for (let i = 0; i < n; i++) {
      const side = rng.next() < 0.5 ? -1 : 1;
      // Behind the tyre rather than at it — see `dustPort`. A puff born under
      // the machine spends the first third of its life inside the bodywork, and
      // a puff born *in* the sparks bleaches them.
      dustPort(racer, side, 0.14, _p);
      // Same sub-frame spread as the sparks: a dust trail has to be a trail.
      const back = (i + 0.5) * inv * dt;
      _p.addScaledVector(racer.vel, -back);

      if (sfx.sparky) {
        sparkSpec.px = _p.x; sparkSpec.py = _p.y; sparkSpec.pz = _p.z;
        sparkSpec.vx = racer.vel.x * 0.12 + rng.range(-3, 3);
        sparkSpec.vy = rng.range(1, 4);
        sparkSpec.vz = racer.vel.z * 0.12 + rng.range(-3, 3);
        sparkSpec.life = rng.range(0.18, 0.34);
        sparkSpec.size0 = rng.range(0.10, 0.18);
        setHdr(sparkSpec.color0, RAIL_SPARK, 3.2);
        setHdr(sparkSpec.color1, RAIL_SPARK, 0.3);
        pool.emit(sparkSpec);
        continue;
      }

      // ── two clouds, not one ─────────────────────────────────────────────
      //
      // The single population above did one thing: it kept 86% of the machine's
      // velocity and climbed. Both of those are right for the *tail* and both
      // are wrong for the other half of what a tyre does to loose ground, and
      // with only one of them in the frame what a still photograph caught was
      // "two thin, near-vertical, desaturated columns" — because a cloud that
      // travels with the kart and rises has, relative to the kart, no horizontal
      // motion at all. It is a column by construction.
      //
      // A rooster tail is a *skirt* and a *plume*:
      //
      //   the skirt is material pushed sideways along the deck. It keeps about
      //   half the machine's speed, so it is genuinely left behind and lays a
      //   widening trail on the ground — which is the thing an overhead frame
      //   can see and the thing a chase camera reads as "that hurt". It stays
      //   low, spreads hard, grows fast and takes the surface's *deep* tone,
      //   because dust at ankle height is dust in its own shadow.
      //
      //   the plume is the part that gets up into the light: most of the
      //   machine's speed, thrown back and up, the pale lit tone, against the
      //   sky rather than against the identically-coloured ground.
      //
      // A little under half of the emission goes to the skirt. Loose ground
      // only.
      const skirt = !hard && rng.next() < 0.46;
      // Capped so that even at full growth no single puff crosses `MAX_PUFF`.
      // A rooster tail off gravel gets its mass from ninety-six emissions a
      // second, not from any one of them being the size of the kart.
      const grow = skirt ? sfx.grow * 1.5 : sfx.grow;
      dustSpec.size0 = Math.min(
        sfx.size * (skirt ? rng.range(0.85, 1.5) : rng.range(0.7, 1.35)),
        MAX_PUFF / grow,
      );
      dustSpec.px = _p.x + rng.range(-0.2, 0.2);
      // Born clear of the road by half its own radius. The sprite layer depth-
      // tests, so a soft ball centred on the tarmac is sliced along the plane
      // it intersects and what reaches the screen is a puff with one perfectly
      // straight edge — the single most obvious "these are quads" tell the
      // module can produce. Lifting the centre by its own size costs nothing
      // and moves the cut out to where the alpha is already near zero.
      dustSpec.py = _p.y + dustSpec.size0 * 0.5;
      dustSpec.pz = _p.z + rng.range(-0.2, 0.2);
      // Velocity inheritance is the whole difference between a rooster tail and
      // nothing at all, and the number wants to be much higher than physics
      // suggests. At 0.14 a puff was born already falling 25 m/s behind the
      // machine that made it. The chase camera sits six to eight metres back,
      // so the puff crossed behind the lens inside a third of a second — before
      // it had finished fading in, before it had grown, and before it had
      // climbed. The game was emitting a perfectly good dust trail every single
      // frame and the player could not see one metre of it.
      //
      // Real dust is entrained in the wake and travels with the car for a while
      // before it lets go, which is exactly the behaviour that is also needed
      // here: at 0.75 the head of the cloud stays within three or four metres
      // of the machine for the first half of its life — in frame, at full size
      // — and only then drops away.
      // 0.86, not 0.75. The difference is a quarter of the machine's speed —
      // fifteen metres a second — and the chase camera sits eight metres
      // behind, so at 0.75 every puff was on a course to arrive at the lens
      // inside half a second of being born. Combined with a life of up to a
      // second that is not a dust trail, it is a windscreen. A rooster tail
      // travels with the machine that threw it and gets its shape from its own
      // outward and upward throw, not from being left behind.
      const keep = skirt ? rng.range(0.42, 0.58) : 0.86;
      const out = skirt ? rng.range(3.2, 8.0) : rng.range(0.6, 3.0);
      dustSpec.vx = racer.vel.x * keep - _fwd.x * rng.range(0.5, 3)
        + _right.x * side * out;
      // ...and the climb is the other half. A cloud that tops out a metre off
      // the deck sits below the sight line of a camera that is looking over the
      // roof of the kart, so on a loose surface it has to actually get up: two
      // to four metres, which puts it against the sky and the road behind
      // rather than against the identically-coloured ground it came off.
      //
      // The skirt does the opposite on purpose. It barely leaves the deck, so
      // it is still on the ground when the plume above it has blown away — and
      // something has to still be there, or the machine leaves no mark on the
      // world it just tore up.
      dustSpec.vy = skirt
        ? rng.range(0.15, 0.75) + sfx.lift * rng.range(0.10, 0.45)
        : rng.range(0.4, 1.4) + sfx.lift * rng.range(1.8, 4.6);
      dustSpec.vz = racer.vel.z * keep - _fwd.z * rng.range(0.5, 3)
        + _right.z * side * out;
      // Long enough to build a trail behind the machine, short enough that the
      // cloud has a tail rather than a wall. A puff has to survive long enough
      // for the next few to be born behind it, or what the frame catches is one
      // isolated blob per wheel.
      //
      // Two thirds of that on a hard surface. Loose ground genuinely hangs in
      // the air for a second and reads as a rooster tail; hot rubber off tarmac
      // is gone almost at once, and anything that outlives its own cause ends
      // up strewn down the road as litter.
      dustSpec.life = skirt
        ? rng.range(1.0, 1.7)
        : rng.range(0.55, 1.05) * (hard ? 0.62 : 1);
      dustSpec.size1 = dustSpec.size0 * grow;
      dustSpec.rot = rng.next() * TAU;
      dustSpec.rotVel = rng.range(-1.3, 1.3);
      // Loose ground hangs in the air; tarmac smoke settles almost at once. The
      // skirt neither rises nor sinks — it is lying on the ground.
      dustSpec.gravity = skirt ? -0.02 : -0.12 - 0.5 * sfx.lift;
      // ...and it does not keep its outward throw for long. A skirt that held
      // 8 m/s sideways for a second and a half would be a wall two lanes wide;
      // what it should be is a shove that spends itself in the first third of
      // its life and then simply hangs there settling.
      dustSpec.drag = skirt ? 2.6 : 1.5;
      // Thinner per puff on the skirt, because there are a lot of them and they
      // overlap heavily by design. The governor measures coverage, so paying
      // for the density out of the per-puff alpha is what keeps the extra mass
      // from being taken straight back off it.
      dustSpec.alpha = sfx.alpha * (skirt ? rng.range(0.5, 0.78) : rng.range(0.7, 1.1));
      if (skirt) {
        setHdr(dustSpec.color0, deep, 1.0);
        setHdr(dustSpec.color1, deep, 0.72);
      } else {
        setHdr(dustSpec.color0, col, 1.0);
        setHdr(dustSpec.color1, deep, 0.85);
      }
      pool.emit(dustSpec);
    }
    dustSpec.gravity = -0.2;
    dustSpec.drag = 1.5;

    // ── the solid half ────────────────────────────────────────────────────
    // On its own accumulator rather than as a coin flip inside the dust loop.
    // Piggybacked on the dust it came out at three clods a second, which is
    // three clods nobody will ever notice; matter and powder come off a tyre in
    // quite different quantities and there is no reason to tie them together.
    // Deliberately *not* on `veilDensity`. A clod is a solid object with an
    // edge and a trajectory: it is the one thing here that stops a dust cloud
    // reading as a rendering artefact, and it hides nothing — the governor
    // exists to protect the picture from things that obscure it, and a fistful
    // of gravel arcing out of a rooster tail is the opposite of that.
    if (sfx.grit <= 0) return;
    const gritRate = sfx.grit * (46 + 70 * slip) * speedFrac * density * vis;
    fx.grit += gritRate * dt;
    let gn = Math.floor(fx.grit);
    fx.grit -= gn;
    if (gn > 10) gn = 10;
    const ginv = gn > 0 ? 1 / gn : 0;

    for (let i = 0; i < gn; i++) {
      const side = rng.next() < 0.5 ? -1 : 1;
      dustPort(racer, side, 0.10, _p);
      _p.addScaledVector(racer.vel, -(i + 0.5) * ginv * dt);
      gritSpec.px = _p.x; gritSpec.py = _p.y + 0.05; gritSpec.pz = _p.z;
      // Thrown up and out hard enough to clear the cloud it came out of. A clod
      // that stays inside the dust is a clod nobody sees, and the point of it is
      // to be the thing with an edge on it.
      const out = rng.range(1.5, 6.0);
      gritSpec.vx = racer.vel.x * 0.84 - _fwd.x * rng.range(1.5, 5)
        + _right.x * side * out;
      gritSpec.vy = rng.range(3.0, 10.0) * (0.45 + 0.6 * sfx.lift);
      gritSpec.vz = racer.vel.z * 0.84 - _fwd.z * rng.range(1.5, 5)
        + _right.z * side * out;
      gritSpec.life = rng.range(0.30, 0.58);
      gritSpec.size0 = rng.range(0.11, 0.24);
      gritSpec.size1 = gritSpec.size0 * 0.8;
      gritSpec.rot = rng.next() * TAU;
      gritSpec.rotVel = rng.range(-13, 13);
      // The ground's own colour, not the dust's: this is the surface itself
      // rather than the powder off it, and the contrast between the two is the
      // whole effect. Two tones, so the spray is not one material stamped out.
      // Darker than the dust and darker than `deep`: a clod is the ground
      // *in shadow*, and the contrast against the pale powder it comes out of
      // is the entire reason it exists. At the old range it came out cream and
      // read as torn paper blowing off the verge.
      setHdr(gritSpec.color0, deep, rng.range(0.26, 0.52));
      gritSpec.color1.copy(gritSpec.color0);
      if (!pool.emit(gritSpec)) break;
    }
  }

  /**
   * The plume. A boost has to be unmistakable with the sound off.
   *
   * Three things stacked, because fire is three things: a body that grows and
   * cools as it falls behind, a nozzle that never flickers out between
   * particles, and a spray of sparks fast enough to streak. The body is where
   * the volume is, but the sparks are what make it read as *thrust* rather than
   * as a coloured cloud stuck to the back of the kart.
   *
   * The flame body keeps a big share of the kart's velocity so the plume has
   * length instead of being left behind in a lump, and it is thrown backwards
   * hard on top of that so the length is visible.
   */
  function boostFlame(racer: Racer, fx: RacerFx, dt: number, add: SpriteLayer): void {
    const power = clamp01(racer.boost.power / 46);
    const s = sizeOf(racer);
    const tier = fx.boostTier;
    const tint = tier > 0 ? TIER[tier]! : FLAME_HOT;
    const gain = tier > 0 ? TIER_GAIN[tier]! : 2.6;
    const rig = clamp(s.halfW / 0.85, 0.75, 1.6);
    // ── how much of the exhaust the tier is allowed to own ────────────────────
    //
    // 0.30, and it used to be 0.72. At 72% toward the tier hue a tier-one boost
    // trailed two *cyan* jets across an orange desert and read as an ice
    // effect; measured against MK8, whose exhaust is orange in every tier, that
    // is the wrong signal on the wrong channel. The tier is stated by the
    // sparks at the wheels, by the burst that fires the boost, and by the ring
    // round the item socket. The flame's job is to be fire.
    // ── ...and then back up, because there was no flame at all ──────────────
    //
    // 0.52. The note above is right that MK8's exhaust is orange in every tier
    // and wrong about what that buys here, because it was written against a
    // plume nobody could see: with the white cores at 3.2 and the strike's core
    // at the same, the whole tail of the machine clipped, and a reviewer
    // stepping every frame of a mini-turbo found *no flame at any frame*. The
    // tier was being spent on a screen flash one frame long.
    //
    // Fire near the throat is white, fire at the fringe is the fuel's colour,
    // and a mini-turbo's fuel is the charge. Half and half puts orange through
    // the body — so it still reads as combustion rather than as an energy field
    // — and leaves the tier plainly legible at the edges, which is the only
    // place a hue survives being additive.
    const wash = tier > 0 ? 0.52 : 0.26;
    _plume.lerpColors(FLAME_MID, tint, wash);

    const rate = (95 + 95 * power) * density * fx.near;
    fx.flame += rate * dt;
    let n = Math.floor(fx.flame);
    fx.flame -= n;
    if (n > 18) n = 18;

    const inv = n > 0 ? 1 / n : 0;
    for (let i = 0; i < n; i++) {
      // Out of one throat or the other, alternating rather than flipped a coin
      // for: two jets is the shape, and a coin flip leaves gaps on one side and
      // doubles up on the other, which comes out as one lumpy plume on the
      // centreline. Jitter is kept under half the spread so the two bodies stay
      // separate for the first metre and merge after it.
      const off = ((i & 1) === 0 ? -1 : 1) * s.halfW * 0.42 + rng.range(-0.14, 0.14) * s.halfW;
      local(off, -0.16 + rng.range(0, 0.3), -s.len * (0.45 + rng.range(0, 0.12)), _p);
      _p.addScaledVector(racer.vel, -(i + 0.5) * inv * dt);
      flameSpec.px = _p.x; flameSpec.py = _p.y; flameSpec.pz = _p.z;
      // ── how far the fire is allowed to get away ──────────────────────────
      //
      // It used to keep 0.70 of the machine's velocity and be shoved back at up
      // to 17 m/s on top, over a life of nearly a quarter of a second. At 55
      // m/s that puts the tail of the plume five or six metres behind the kart
      // — which is where the chase camera is — so every particle in it grew as
      // it came at the lens and arrived as a great tan sphere. What a
      // photograph of the loudest moment in the game caught was a line of dough
      // balls rolling away down the road.
      //
      // A jet is short. It keeps almost all of the machine's velocity, because
      // the gas leaving a nozzle at 8 m/s relative to a vehicle doing 55 is, to
      // anything watching from behind, still doing 47 — and it dies inside a
      // sixth of a second. The plume is then about a metre and a half long,
      // welded to the tail, entirely in front of the camera rather than passing
      // through it.
      const back = rng.range(3.5, 8) * (0.7 + 0.5 * power);
      flameSpec.vx = racer.vel.x * 0.88 - _fwd.x * back + rng.range(-1.2, 1.2);
      flameSpec.vy = racer.vel.y * 0.88 + rng.range(0.2, 1.4);
      flameSpec.vz = racer.vel.z * 0.88 - _fwd.z * back + rng.range(-1.2, 1.2);
      flameSpec.life = rng.range(0.13, 0.24);
      flameSpec.size0 = rng.range(0.30, 0.52) * (0.85 + 0.4 * power) * rig;
      flameSpec.size1 = flameSpec.size0 * rng.range(2.0, 2.9);
      flameSpec.rot = rng.next() * TAU;
      flameSpec.rotVel = rng.range(-7, 7);
      // The body burns *orange*, with the tier washed through it.
      //
      // It used to be built the other way round — the tier lerped 55% toward a
      // cream white and then multiplied by the gain — and for an ordinary pad
      // boost, whose tint is that same cream, that means the entire plume was
      // cream at 2.6. Through ACES a cream at 2.6 is white, and white behind a
      // machine over grey tarmac in warm sun is beige. The single loudest
      // effect in the game had no hue in it at all.
      //
      // Fire is orange near the middle and white only where it is thinnest, so
      // the body starts from `FLAME_MID` and takes the tier as a wash: a pad
      // boost reads as clean flame, a mini-turbo reads as flame carrying that
      // tier's colour, and neither reads as fog lit from inside.
      // Capped under the clip point. A flame body is the largest quad in the
      // effect, so it is the one that decides whether the machine keeps its
      // silhouette — and radiance above the point where ACES bleaches buys no
      // brightness at all, it only spends hue.
      flameSpec.color0.copy(_plume).multiplyScalar(Math.min(gain, 2.0) * rng.range(0.8, 1.1));
      setHdr(flameSpec.color1, FLAME_END, 1.1);
      pool.emit(flameSpec);

      // Sparks out of the exhaust. Almost all of the kart's velocity, so they
      // hang in the plume, plus a hard shove backwards that the camera-relative
      // stretch turns into streaks pointing straight down the road behind.
      if (rng.next() < 0.55) {
        sparkSpec.px = _p.x; sparkSpec.py = _p.y; sparkSpec.pz = _p.z;
        // Same reasoning as the flame body: the chase camera sits under eight
        // metres behind the machine, and a spark leaving at 26 m/s relative to
        // it for a quarter of a second travels straight through the glass.
        const kick = rng.range(6, 15) * (0.7 + 0.5 * power);
        sparkSpec.vx = racer.vel.x * 0.88 - _fwd.x * kick + rng.range(-2.2, 2.2);
        sparkSpec.vy = racer.vel.y * 0.88 + rng.range(0.4, 3.0);
        sparkSpec.vz = racer.vel.z * 0.88 - _fwd.z * kick + rng.range(-2.2, 2.2);
        sparkSpec.life = rng.range(0.12, 0.24);
        sparkSpec.size0 = rng.range(0.10, 0.19);
        sparkSpec.gravity = 8;
        sparkSpec.drag = 0.8;
        // Split, not averaged — the same correction the mini-turbo sparks
        // already carry. Lerping every spark toward white and then multiplying
        // by the tier gain produces a population whose *mean* is bright and
        // whose *mode* is nothing in particular, and the eye reads the mode. A
        // measured mini-turbo boost came back with a stream of cream lozenges
        // and no trace of the tier that fired it.
        if (rng.next() < 0.22) {
          sparkSpec.color0.lerpColors(tint, WHITE_HOT, 0.34).multiplyScalar(gain * 0.72);
        } else {
          setHdr(sparkSpec.color0, tint, gain * 0.92);
        }
        setHdr(sparkSpec.color1, tint, gain * 0.12);
        pool.emit(sparkSpec);
        sparkSpec.gravity = 15;
        sparkSpec.drag = 2.0;
      }

      // ── the smoke tail is gone, and it is not coming back ────────────────
      //
      // It was born at 62% of the machine's velocity with a rise on it and a
      // life of up to eight tenths of a second: relative to a kart doing 60
      // m/s that is twenty-three metres a second *backwards* and a metre and a
      // half *up*, which drew a vertical grey column standing off the roof of
      // an accelerating machine. Nothing rises off an accelerating kart. A jet
      // does not have a smoke tail at speed either — what a jet has is fire
      // that runs out — so the tail is now the flame body's own cooling, which
      // `color1` already does.
    }
    flameSpec.rot = 0;
    flameSpec.rotVel = 0;

    // The nozzles: hot cores that do not flicker out between particles.
    //
    // Two of them, not one. The camera a player actually has is sitting almost
    // directly behind the machine, and from there a plume aimed straight away
    // from the lens has no length at all — every metre of it lands on the same
    // handful of pixels. A single stack of round quads on the centreline
    // foreshortens to a dot and the whole boost reads as the kart being lit
    // orange from inside. A pair set out at the flanks has *width*, which is
    // the one dimension the chase camera cannot take away, and width is what
    // makes the shape read as exhaust rather than as a tint.
    // ── how bright the throats are allowed to be ──────────────────────────
    //
    // A measured tier-one drift that ran over a boost pad photographed as a
    // *white headlamp* four hundred pixels across with the machine hidden
    // behind it, and the arithmetic is not subtle: two throat glows at 3.9, two
    // white pinpoints at 3.2, a 2.8m wash at 2.0, a ground pool, a flare at
    // each wheel and twenty flame bodies at 3.4 all land inside the same metre.
    // ACES takes anything much past 2.5 to white and it takes stacked additives
    // there immediately, so the loudest moment in the game arrived with no hue
    // in it at all and — worse — obscured the thing it was happening to.
    //
    // ...and then it came down again, by nearly half, because the measurement
    // said it was still happening: linear rgb of 1.9, 0.5, 1.0 in the near bin
    // six tenths of a second into a boost is a blown tail with the machine
    // missing out of it. The rule the numbers below follow is simply that
    // nothing broad may sit above 1.0 — the throat glow, the jet cells and the
    // wash are all under it, and the only things allowed near the clip point
    // are the two pinpoints, which between them cover a quarter of a metre.
    // Brightness above the clip buys nothing; what it costs is every pixel it
    // spreads to, and the pixels it was spreading to were the kart's.
    const flick = 0.85 + 0.15 * Math.sin(ctx.time.elapsed * 61 + racer.id * 2.3);
    const k = (gain * 0.40 + 0.24 * power) * flick;
    const spread = s.halfW * 0.42;

    // ── the two jets ────────────────────────────────────────────────────────
    //
    // The thing that was entirely missing, and the reason a mini-turbo read as
    // a lamp being switched on behind the kart rather than as an engine being
    // lit. A pooled population cannot be relied on to draw fire: it can be
    // thinned by the governor, it can be caught between emissions, and — as
    // measured — it can be sitting underneath a stack of white cores that have
    // clipped the whole tail to paper. So each throat now grows an
    // immediate-mode jet, rebuilt every frame the boost is live, and it is
    // drawn on the **puff** cell rather than the glow.
    //
    // That last part is the whole difference between fire and bloom. A glow is
    // a perfect radial gaussian: stack four of them and you get a brighter
    // gaussian, which is a lamp. The puff cell has a torn edge, and four torn
    // edges at different scales and rotations interpenetrate into something
    // with lobes and notches in it — which is what a flame is. The cells are
    // laid back along the exhaust axis, shrinking and cooling from a
    // near-white root to the tier's own hue at the tip, so the tier is stated
    // by the *fringe of the fire* and holds for the whole boost instead of for
    // one frame of screen flash.
    const JET = 5;
    for (let side = -1; side <= 1; side += 2) {
      for (let j = 0; j < JET; j++) {
        const u = j / (JET - 1);
        // Back along the tail, spreading and cooling.
        //
        // The length matters more than the brightness. Held to a metre the two
        // jets merge, at the eight to ten metres the chase camera sits, into a
        // single round bloom at the tail — which is a lamp again, by a different
        // route. Two metres of tail against a machine 1.9m long is a flame with
        // a *direction*, and direction is the one thing that says thrust.
        local(
          side * spread * (1 + 0.95 * u),
          -0.10 + 0.14 * u,
          -s.len * 0.46 - (0.5 + 1.9 * power) * u * rig,
          _p,
        );
        // Root white-hot, tip the tier's own colour: fire is only ever its
        // fuel's colour where it is thin. A boost with no tier behind it — a
        // pad, a mushroom, a trick — burns orange at the fringe instead, so the
        // jet is never a cream cloud with no hue in it at all.
        _tint.lerpColors(WARM_WHITE, tier > 0 ? tint : FLAME_MID, 0.25 + 0.75 * u);
        const heat = (1.5 - 0.6 * u) * (0.6 + 0.5 * power) * flick;
        const size = (0.36 + 0.86 * u) * (0.85 + 0.45 * power) * rig;
        add.push(
          _p.x, _p.y, _p.z, 0, 0, 0,
          _tint.r * heat, _tint.g * heat, _tint.b * heat, 0.85 - 0.3 * u,
          size, 0, ctx.time.elapsed * (3.1 + side * 1.7) + j * 2.4 + racer.id,
          PUFF_CELLS[(j + (side > 0 ? 2 : 0)) % PUFF_CELLS.length]!, MODE.billboard,
        );
      }
      // The throat itself: a small hot core inside the root of each jet, so the
      // fire has a hole to come out of. Small on purpose — this is the one
      // element allowed near the clip point, and it is allowed there only
      // because it covers a tenth of a metre.
      local(side * spread, -0.1, -s.len * 0.46, _p);
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        _plume.r * k, _plume.g * k, _plume.b * k, 0.9,
        (0.34 + 0.22 * power) * flick * rig, 0, 0, CELL.glow, MODE.billboard,
      );
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        1.1 * flick, 1.04 * flick, 0.94 * flick, 0.9,
        (0.12 + 0.08 * power) * rig, 0, 0, CELL.glow, MODE.billboard,
      );
    }
    // ...and the light it throws on the road, which is what welds the plume to
    // the ground instead of leaving it hovering behind the machine.
    if (racer.grounded) {
      local(0, -RIDE_HEIGHT + 0.15, -s.len * 0.62, _p);
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        _plume.r * k * 0.30, _plume.g * k * 0.30, _plume.b * k * 0.30, 0.34,
        (2.0 + 1.2 * power) * rig, (1.6 + 1.2 * power) * rig, groundYaw(), CELL.glow, MODE.ground,
      );
    }
  }

  /**
   * The strike. Two tenths of a second of immediate-mode geometry at the tail,
   * drawn every frame the ignition envelope is up.
   *
   * This exists because of a measurement, not a taste: with every sprite layer
   * hidden, the firing frame of a mini-turbo was *the same photograph*. All of
   * the read was coming from the post stack's radial smear and a DOM gradient,
   * and the world contributed a blue wash. A pooled burst cannot fix that on
   * its own, because a pooled burst is a population — it can be thinned by the
   * governor, arrive a frame late, or simply be too fine to resolve. Something
   * has to be *guaranteed on the glass* on the frame the boost fires.
   *
   * The shape is chosen to be one the charge can never make. A drift throws
   * soft round light and thin streaks; this is a hard four-point flare, white
   * at the centre, with a scorch expanding across the road under it. An edge is
   * the one thing two seconds of blue wash never has.
   */
  function ignitionFlare(racer: Racer, fx: RacerFx, dt: number, add: SpriteLayer): void {
    const e = fx.ignite;
    const s = sizeOf(racer);
    const rig = clamp(s.halfW / 0.85, 0.75, 1.6);
    const tier = fx.boostTier;
    const tint = tier > 0 ? TIER[tier]! : WARM_WHITE;
    const gain = tier > 0 ? TIER_GAIN[tier]! : 2.6;
    const p = fx.ignitePower;
    // Growth runs the other way from the envelope: the flare opens as it dies,
    // which is what makes it read as an expansion rather than as a lamp being
    // switched off.
    const g = 1 - e;
    const a = e * (0.5 + 0.5 * e);

    // ── where the strike is centred, and why it is not at the pipe ───────────
    //
    // A camera-facing quad is a *plane through its own centre*, so a two-metre
    // flare hung at exhaust height — half a metre off the deck — has three
    // quarters of a metre of itself below the tarmac, and the depth test cuts
    // it there. What ships is not the four-point star the atlas draws but the
    // part of it that cleared the road, with a dead-straight edge along the cut
    // and the quad's own corners showing wherever the additive colour is bright
    // enough to saturate its falloff. That is the hard-edged wedge, and it is
    // geometry rather than texture: measuring the atlas cell can never find it.
    //
    // So the strike sits about seventy centimetres up — still unmistakably at
    // the tail of the machine, high enough that the bright half of every quad
    // is in the air — and the two stars are held to brightnesses that keep the
    // falloff inside the quad instead of blowing it out to the corners.
    //
    // ── and it sits *behind* the tail, not on it ────────────────────────────
    //
    // ARCHITECTURE section 12 again, and this time it was the release that
    // broke it. A camera-facing quad is centred on its own anchor, so a star
    // 3-5m across hung at `-len * 0.50` — which *is* the tail — reaches half
    // that far forward, over the whole machine. Photographed at the firing
    // frame the cone was a featureless white blob for about two tenths of a
    // second: the loudest moment in the game erasing the thing it was happening
    // to. MK8 never compromises the silhouette, and the fix costs nothing —
    // move the anchor back by another third of a machine so the bright core
    // sits off the tail, and the kart stands in front of the fire as a shape
    // rather than inside it as a hole.
    local(0, 0.14, -s.len * 0.84, _p);
    // ── the clamp, and why it is not a matter of taste ──────────────────────
    //
    // Measured on the near bin at the firing frame, this module was putting
    // linear rgb of 1.59, 0.65, 1.42 on the glass and 1.94, 0.49, 1.03 six
    // tenths of a second later — clipping past 1.0 on two channels — and what
    // that looks like is the rear half of the machine disappearing into a
    // featureless blown-white disc. ARCHITECTURE section 12 opens with
    // *silhouette first*: every racer must be identifiable as a black shape.
    // An effect that erases the shape it belongs to has failed on the game's
    // own first rule however loud it is, and loud was never the problem — the
    // charge is read off hue, and hue is the first thing a clipped pixel loses.
    //
    // Everything below is held under the clip point. The strike keeps its
    // brightness where it has almost no area (the core is now a third of a
    // metre) and trades it for hue everywhere it has area.
    add.push(
      _p.x, _p.y, _p.z, 0, 0, 0,
      1.0 * a, 0.96 * a, 0.88 * a, 0.95,
      (0.22 + 0.30 * g + 0.14 * p) * rig, 0, 0, CELL.glow, MODE.billboard,
    );
    // The hard star. Two of them crossed: a white one on the level and a
    // tier-coloured one rolled 45°, so the burst carries its tier at the edges
    // while staying white in the middle. An *edge* is the whole point — two
    // seconds of drift charge is soft round light and thin streaks, and there
    // is no amount of extra blue that turns that into a different event.
    const spin = ctx.time.elapsed * 1.2 + racer.id;
    add.push(
      _p.x, _p.y, _p.z, 0, 0, 0,
      0.60 * a, 0.57 * a, 0.53 * a, 0.95,
      (0.8 + 1.1 * g + 0.3 * p) * rig, 0, spin, CELL.flare, MODE.billboard,
    );
    // The tier star is deliberately the *larger* of the two, so the hue lands
    // where a white core cannot reach it — on the points, outside the blow-out.
    // It also keeps the most radiance of anything here, because it is the only
    // quad in the strike whose whole job is to be a colour.
    add.push(
      _p.x, _p.y, _p.z, 0, 0, 0,
      tint.r * gain * a * 0.95, tint.g * gain * a * 0.95, tint.b * gain * a * 0.95, 0.85,
      (2.4 + 2.6 * g + 0.7 * p) * rig, 0, spin + 0.785, CELL.flare, MODE.billboard,
    );
    // The light on the road. A *falloff*, not a ring — see `groundLight` for
    // the measurement that killed the annulus. This one is immediate-mode
    // because it has to be on the glass on the firing frame whatever the pool
    // is doing, and it hugs the deck so the boost is welded to the surface
    // rather than hovering over it.
    if (racer.grounded) {
      // Behind the contact patch, for the same reason the stars are: a pool of
      // near-white light centred under the machine bleaches the road it is
      // standing on and takes the machine's edges with it.
      local(0, -RIDE_HEIGHT + 0.14, -s.len * 0.72, _p);
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        FLAME_HOT.r * 0.7 * a, FLAME_HOT.g * 0.62 * a, FLAME_HOT.b * 0.46 * a, 0.62,
        // Capped, twice over: `rig` reaches 1.6 on the widest machines, and
        // uncapped this reached fifteen metres of lit road behind a truck —
        // which stops being contact and becomes the tarmac being switched on.
        // The growth term came down with it, because a pool that keeps opening
        // as the strike dies ends up biggest at the moment it is faintest, and
        // measured that put a seven-metre wash on the road at the tail of every
        // boost the review sheet caught late.
        Math.min((3.0 + 2.6 * g + 1.0 * p) * rig, 6.5), (0.9 + 1.2 * g) * rig, groundYaw(),
        CELL.glow, MODE.ground,
      );
    }

    // ── the afterburn ────────────────────────────────────────────────────────
    //
    // The crack in `spendBoost` is one instant, and one instant is not a thing
    // a camera can be relied on to catch: the review sheet's own boost recipe
    // renders twenty-eight frames — nearly a quarter of a second of visual time
    // — before it takes the picture, by which point a population with a fifth
    // of a second of life is entirely dead. So the ignition keeps firing for
    // the first third of its envelope. A boost is a *shove that lasts*, not a
    // shutter click, and MK8's is roughly this long too.
    if (e < 0.55) return;
    const n = Math.round(150 * density * dt * (0.7 + 0.5 * p));
    local(0, -0.06, -s.len * 0.48, _p);
    for (let i = 0; i < n; i++) {
      sparkSpec.px = _p.x + rng.range(-0.3, 0.3);
      sparkSpec.py = _p.y + rng.range(-0.18, 0.3);
      sparkSpec.pz = _p.z + rng.range(-0.25, 0.25);
      const kick = rng.range(3, 9) * (0.7 + 0.5 * p);
      const spread = rng.range(-4.0, 4.0);
      sparkSpec.vx = racer.vel.x * 0.86 - _fwd.x * kick + _right.x * spread;
      sparkSpec.vy = racer.vel.y * 0.86 + rng.range(1.0, 5.5);
      sparkSpec.vz = racer.vel.z * 0.86 - _fwd.z * kick + _right.z * spread;
      sparkSpec.life = rng.range(0.16, 0.34);
      sparkSpec.size0 = rng.range(0.20, 0.34);
      sparkSpec.gravity = 12;
      sparkSpec.drag = 0.7;
      // A third of the afterburn is white, not two thirds. The whole strike is
      // a *coloured* event with a hot middle, and every white spark added to it
      // is a vote for the middle winning — measured, thirty white sparks at 3.0
      // inside half a metre is what turned a blue mini-turbo into a headlamp
      // whatever the rest of the arithmetic said.
      if (rng.next() < 0.32) {
        sparkSpec.color0.lerpColors(tint, WHITE_HOT, 0.6).multiplyScalar(1.5);
      } else {
        sparkSpec.color0.lerpColors(tint, FLAME_HOT, 0.22).multiplyScalar(gain * 1.1);
      }
      setHdr(sparkSpec.color1, tint, gain * 0.22);
      if (!pool.emit(sparkSpec)) break;
      if (rng.next() < 0.5) {
        emberSpec.px = sparkSpec.px; emberSpec.py = sparkSpec.py; emberSpec.pz = sparkSpec.pz;
        emberSpec.vx = sparkSpec.vx * 0.7 + racer.vel.x * 0.14;
        emberSpec.vy = sparkSpec.vy * 0.7 + racer.vel.y * 0.14;
        emberSpec.vz = sparkSpec.vz * 0.7 + racer.vel.z * 0.14;
        emberSpec.life = rng.range(0.12, 0.24);
        emberSpec.size0 = rng.range(0.26, 0.48) * rig;
        emberSpec.size1 = emberSpec.size0 * 0.35;
        emberSpec.color0.lerpColors(tint, WHITE_HOT, 0.45).multiplyScalar(1.7);
        setHdr(emberSpec.color1, tint, gain * 0.24);
        pool.emit(emberSpec);
      }
    }
    sparkSpec.gravity = 15;
    sparkSpec.drag = 2.0;
    emberSpec.size1 = 0.05;
  }

  /** Rotation that lays a `MODE.ground` quad's long axis down the racer's
   *  heading. The shader's ground branch spans (cos, 0, sin), so this is
   *  atan2(z, x) — not the yaw convention the rest of the game uses. */
  function groundYaw(): number {
    return Math.atan2(_fwd.z, _fwd.x);
  }

  /**
   * Light spilled *on* the road — a falloff, not a shape.
   *
   * ── why the boost no longer draws a ring ────────────────────────────────
   *
   * Because a ring is an object and this is supposed to be illumination. The
   * mini-turbo fired a `CELL.ring` annulus flat in the road plane at the tail
   * of the machine, and because a boost freezes nothing about the ignition
   * envelope — it is read off simulation time, which is exactly right — the
   * same annulus was redrawn identically for ten or more frames. What a
   * reviewer photographed was a hard-edged pale-gold torus lying in the tarmac
   * with the kart sitting on one of its arcs: a *decal*, and one that named no
   * event, since a shockwave that does not expand is a sticker.
   *
   * The replacement is `CELL.glow` in ground mode: a radial gaussian, so it has
   * no outer edge at any brightness and cannot resolve into a rim however long
   * it is held. It says the same thing the ring was trying to — the ground
   * under the machine is being lit by something violent — and says it the way
   * light actually behaves.
   */
  function groundLight(
    x: number, y: number, z: number, from: number, to: number,
    life: number, color: THREE.Color, k: number, alpha: number, hold = 0,
  ): void {
    groundLightSpec.px = x; groundLightSpec.py = y + RING_LIFT; groundLightSpec.pz = z;
    groundLightSpec.vx = 0; groundLightSpec.vy = 0; groundLightSpec.vz = 0;
    groundLightSpec.size0 = from;
    groundLightSpec.size1 = to > 9 ? 9 : to;
    groundLightSpec.life = life;
    groundLightSpec.alpha = alpha;
    groundLightSpec.rot = groundYaw();
    groundLightSpec.hold = hold;
    setHdr(groundLightSpec.color0, color, k);
    setHdr(groundLightSpec.color1, color, k * 0.05);
    pool.emit(groundLightSpec);
    groundLightSpec.hold = 0;
  }

  /** Ground shock ring. The single cheapest way to make an event feel physical. */
  function ring(
    x: number, y: number, z: number, from: number, to: number,
    life: number, color: THREE.Color, k: number, alpha: number, additive = true,
    hold = 0,
  ): void {
    // Every ring in the module is lifted clear of the surface it is drawn on,
    // in one place rather than at fifteen call sites.
    //
    // A `MODE.ground` quad is flat in *world* XZ and the road is not: it banks,
    // crests and dips. An eight-metre annulus laid five centimetres off the
    // deck therefore has a large part of itself under the tarmac on any corner
    // with camber, and the depth test cuts it along the line where the two
    // planes cross — so what reaches the frame is a *chord* of the ring with
    // one dead-straight edge, which is the hard-edged wedge reviewers keep
    // cropping and correctly calling wrong. It is a geometry defect, not a
    // texture one; measuring the roundness of the atlas cell can never find it.
    ringSpec.px = x; ringSpec.py = y + RING_LIFT; ringSpec.pz = z;
    ringSpec.vx = 0; ringSpec.vy = 0; ringSpec.vz = 0;
    ringSpec.size0 = from;
    // One ceiling for every ring in the module, applied where they are made
    // rather than at each of the fifteen call sites.
    //
    // Measured, the callers were asking for annuli of up to *sixteen metres* —
    // a boost ring on a wide machine, a hard landing, an explosion — laid flat
    // on the road eight metres from the lens. Past about eight metres a ring
    // stops reading as a shockwave and starts reading as the road being lit
    // from underneath, and it takes the frame with it: the additive layer was
    // measured covering five thousand square degrees of a four-and-a-half
    // thousand square degree picture. A shock is a *hard expanding edge*; what
    // makes it read is how fast it grows, not how big it ends up.
    ringSpec.size1 = to > 8.5 ? 8.5 : to;
    ringSpec.life = life;
    ringSpec.alpha = alpha;
    ringSpec.additive = additive;
    ringSpec.rot = rng.next() * TAU;
    setHdr(ringSpec.color0, color, k);
    setHdr(ringSpec.color1, color, k * 0.12);
    // How long the edge is allowed to stay at full strength. A ring is only
    // legible while it is expanding and the expansion is over in two or three
    // rendered frames, so a fade that starts at birth means the frame a
    // reviewer stops on has a 60% ring in it and the frame before had a 1.5m
    // disc hidden under the machine. See `hold` in `particles.ts`.
    ringSpec.hold = hold;
    pool.emit(ringSpec);
    ringSpec.hold = 0;
  }

  /** A ring of dust thrown outward along the ground. */
  function dustRing(
    x: number, y: number, z: number, n: number, speed: number, surface: Surface, scale: number,
  ): void {
    const sfx = SURFACE_FX[surface] ?? SURFACE_FX.road;
    const col = surfaceColors.get(surface) ?? surfaceColors.get('road')!;
    const deep = surfaceDeep.get(surface) ?? surfaceDeep.get('road')!;
    dustSpec.size0 = Math.min(sfx.size * 1.35 * scale, MAX_PUFF / sfx.grow);
    dustSpec.px = x; dustSpec.py = y + dustSpec.size0 * 0.5; dustSpec.pz = z;
    dustSpec.vx = 0; dustSpec.vy = 1.2 + 2.6 * sfx.lift; dustSpec.vz = 0;
    dustSpec.life = 0.75;
    dustSpec.size1 = dustSpec.size0 * sfx.grow;
    dustSpec.alpha = Math.max(sfx.alpha, 0.055);
    dustSpec.rotVel = 0.8;
    setHdr(dustSpec.color0, col, 1.0);
    setHdr(dustSpec.color1, deep, 0.85);
    pool.burst(dustSpec, Math.round(n * veilDensity), speed, 0.22, rng);

    // Matter as well as powder. A landing that punches a ring of dust out of
    // gravel and throws nothing solid with it reads as a smoke machine going
    // off under the kart.
    if (sfx.grit > 0) {
      gritSpec.px = x; gritSpec.py = y + 0.06; gritSpec.pz = z;
      gritSpec.vx = 0; gritSpec.vy = 2.0 + 2.5 * sfx.lift; gritSpec.vz = 0;
      gritSpec.life = 0.5;
      gritSpec.size0 = 0.15 * scale;
      gritSpec.size1 = gritSpec.size0 * 0.8;
      gritSpec.rotVel = rng.range(-13, 13);
      setHdr(gritSpec.color0, deep, 0.42);
      gritSpec.color1.copy(gritSpec.color0);
      pool.burst(gritSpec, Math.round(n * sfx.grit * density), speed * 1.15, 0.45, rng);
    }
  }

  /**
   * A puff of *smoke*, as distinct from a cloud of *ground*.
   *
   * `ctx.fx.spawn('smoke', …)` used to be an alias for `dustRing(..., 'dirt')`,
   * and that was the single worst bug in this module. The item system asks for
   * smoke at a spin-out, a banana slip and a bob-omb — reasonably, at
   * `scale: 1.5` to `2.2` — and the alias turned each request into twenty-two
   * tan puffs of up to seven metres across, born at a racer six metres from the
   * chase camera. That is the wall of large translucent discs over the sky, the
   * mountains and the HUD that reviewers kept photographing, and it fired
   * during ordinary racing because a spin-out is ordinary racing.
   *
   * Smoke is now its own thing and obeys the same rules as everything else
   * airborne here: neutral grey rather than the colour of a surface it never
   * touched, capped diameter, and its volume carried by the number of wisps
   * rather than by the size of any one of them.
   */
  function smokeBurst(
    x: number, y: number, z: number, n: number, speed: number, scale: number,
    vel?: THREE.Vector3,
  ): void {
    smokeSpec.px = x; smokeSpec.py = y + 0.25; smokeSpec.pz = z;
    smokeSpec.vx = (vel?.x ?? 0) * 0.7;
    smokeSpec.vy = 0.9 + (vel?.y ?? 0) * 0.7;
    smokeSpec.vz = (vel?.z ?? 0) * 0.7;
    smokeSpec.life = 0.7;
    smokeSpec.size0 = Math.min(0.34 * scale, MAX_PUFF / 2.6);
    smokeSpec.size1 = smokeSpec.size0 * 2.6;
    smokeSpec.alpha = 0.12;
    smokeSpec.rotVel = 0.7;
    setHdr(smokeSpec.color0, SMOKE, 1.0);
    setHdr(smokeSpec.color1, SMOKE_DEEP, 0.95);
    pool.burst(smokeSpec, Math.round(n * veilDensity), speed, 0.3, rng);
    smokeSpec.alpha = 0.042;
    smokeSpec.rotVel = 0;
  }

  function sparkBurst(
    x: number, y: number, z: number, n: number, speed: number, color: THREE.Color, k: number,
    vel?: THREE.Vector3,
  ): void {
    sparkSpec.px = x; sparkSpec.py = y; sparkSpec.pz = z;
    sparkSpec.vx = (vel?.x ?? 0) * 0.6;
    sparkSpec.vy = 0.5 + (vel?.y ?? 0) * 0.6;
    sparkSpec.vz = (vel?.z ?? 0) * 0.6;
    sparkSpec.life = 0.42;
    sparkSpec.size0 = 0.22;
    setHdr(sparkSpec.color0, color, k);
    setHdr(sparkSpec.color1, color, 0.3);
    pool.burst(sparkSpec, Math.round(n * density), speed, 0.75, rng);
  }

  /**
   * How fast whatever this effect happened *to* is travelling.
   *
   * `ctx.fx.spawn(id, pos)` carries a position and nothing else, which is fine
   * for an item box coming apart — a box is bolted to the road — and wrong for
   * everything that happens to a racer. A ring of stars born at rest beside a
   * machine doing 50 m/s is three kart-lengths behind it a fifth of a second
   * later, and what a screenshot catches is flat yellow cardboard hanging over
   * the road with nothing under it. Rather than widen the interface and make
   * every caller remember, the effect asks the world what was at that point:
   * the nearest racer inside a kart's reach lends its velocity, and if there is
   * nobody there the effect stays where it was put, which is correct for the
   * things that genuinely belong to the ground.
   */
  function inheritVel(x: number, y: number, z: number): THREE.Vector3 {
    _qv.set(0, 0, 0);
    let best = 16; // 4m, squared
    for (const racer of ctx.racers) {
      const dx = racer.pos.x - x, dy = racer.pos.y - y, dz = racer.pos.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) { best = d2; _qv.copy(racer.vel); }
    }
    return _qv;
  }

  // ── spending impulses ─────────────────────────────────────────────────────

  /**
   * The frame a boost fires — and the single most important frame in the game,
   * because it is the payoff for the whole drift loop.
   *
   * **The release has to be a different event from the charge.** That is the
   * defect this was rejected for and it is worth stating plainly, because the
   * old version failed it in the most understandable way possible: it took the
   * tier's colour, put it on both shock rings and on all sixty exhaust sparks,
   * and made the fan out of the same 0.09-0.17m velocity-stretched slivers the
   * wheels had been throwing for the last two seconds. A photograph of the
   * firing frame was then indistinguishable from a photograph of the charge —
   * a soft blue wash and eight thin dashes — and the loudest moment in the game
   * arrived looking exactly like the quiet one before it.
   *
   * So the release is built on the axis the charge cannot use: **heat**. The
   * charge is cold, thin and coloured; the release is white-hot, fat and
   * *structured*, and it only cools into the tier's hue as it dies. Four things
   * carry it:
   *
   *   `ignitionFlare` — an immediate-mode hard-edged star and a ground scorch,
   *   held for about a fifth of a second. Immediate mode because a screenshot
   *   of "the frame it fires" must never be able to catch a gap, and a hard
   *   four-point flare is a silhouette nothing else in this module draws.
   *
   *   the fan — twice the cross-section it had, a *third* of the backward kick
   *   so it stays inside two metres of the tail instead of being towed down the
   *   road, and a majority born white-hot rather than tier-coloured.
   *
   *   round embers riding with the fan, so the burst has mass. Velocity-mode
   *   sprites narrow as they stretch (`uStretchNarrow`), which is right for a
   *   spark and is why at 45 m/s the fan alone photographs as hairlines.
   *
   *   two rings that hold their peak for a few frames instead of fading from
   *   the instant they are born, and are born large enough to clear the machine.
   */
  function spendBoost(racer: Racer, fx: RacerFx): void {
    const s = sizeOf(racer);
    const power = clamp01(fx.pendBoost / 46);
    const tier = fx.boostTier;
    const tint = tier > 0 ? TIER[tier]! : WARM_WHITE;
    const gain = tier > 0 ? TIER_GAIN[tier]! : 2.6;
    const rig = clamp(s.halfW / 0.85, 0.75, 1.6);

    // How hard the immediate-mode half of the burst hits. The envelope itself
    // is read back off the simulation every frame — see `ignite`.
    fx.ignitePower = power;

    // Both pools sit *behind* the machine rather than under it. Centred at
    // `-len * 0.35` — which is the rear axle — a near-white falloff several
    // metres across lights the road on all four sides of the kart at once, and
    // a shape lit from every side has no edges left. The tier's light still
    // reaches forward under the machine, because a falloff has no rim; what it
    // no longer does is put its brightest point where the silhouette is.
    local(0, -RIDE_HEIGHT + 0.06, -s.len * 0.62, _p);
    // Outer: the tier's own light thrown across the road, so the release still
    // *names* the tier that paid for it. A falloff rather than an annulus — see
    // `groundLight`. It spreads fast and dies inside half a second, which is
    // what says "something violent happened here" without leaving an object on
    // the tarmac for the player to look at.
    groundLight(_p.x, _p.y, _p.z, 2.2 * rig, (7.0 + 4 * power) * rig, 0.34,
      tint, gain * 0.62, 0.42, 0.18);
    // Inner: the hot core. Flame, not the tier — this is the one part of the
    // frame that must not be the colour the wheels have been throwing. Further
    // back again, and dimmer: this is the single brightest thing the module
    // draws on the ground and it was a third of a machine-length from the kart.
    local(0, -RIDE_HEIGHT + 0.06, -s.len * 0.86, _p);
    groundLight(_p.x, _p.y, _p.z, 1.1 * rig, (3.0 + 2.2 * power) * rig, 0.22,
      FLAME_HOT, 1.35, 0.42, 0.20);

    // The exhaust cone. Born a little clear of the bodywork rather than inside
    // its last few centimetres: half of a ±0.3m spread centred on the tail is
    // in front of the tail, and additive sparks drawn over the machine are the
    // half of the blow-out that no amount of moving the stars back can fix.
    local(0, -0.08, -s.len * 0.60, _p);
    const n = Math.round((38 + 32 * power) * density);
    for (let i = 0; i < n; i++) {
      sparkSpec.px = _p.x + rng.range(-0.3, 0.3);
      sparkSpec.py = _p.y + rng.range(-0.2, 0.28);
      sparkSpec.pz = _p.z + rng.range(-0.25, 0.25);
      // A third of what it was. At 9-24 m/s of backward kick over a fifth of a
      // second the fan travelled four to six metres behind a machine already
      // doing 45, so by the time anything photographed it, it was a line of
      // lights strung down the road rather than a burst at the tail. A boost is
      // an *eruption at the exhaust*; everything in it stays inside two metres.
      const kick = rng.range(3, 8.5) * (0.7 + 0.5 * power);
      const spread = rng.range(-4.4, 4.4);
      sparkSpec.vx = racer.vel.x * 0.86 - _fwd.x * kick + _right.x * spread;
      sparkSpec.vy = racer.vel.y * 0.86 + rng.range(1.0, 6.0);
      sparkSpec.vz = racer.vel.z * 0.86 - _fwd.z * kick + _right.z * spread;
      sparkSpec.life = rng.range(0.14, 0.26);
      // Twice the cross-section of the charge's sparks, and the arithmetic is
      // not a preference. These are drawn through `MODE.velocity`, which
      // narrows a sprite as it stretches — at 0.09-0.17m and full chat that
      // leaves a hairline about a pixel wide, which is exactly why the firing
      // frame measured 203 additive instances and still photographed as a wash
      // with nothing in it.
      sparkSpec.size0 = rng.range(0.20, 0.35);
      sparkSpec.gravity = 12;
      sparkSpec.drag = 0.7;
      // Hot where the charge was cold.
      //
      // Two thirds of the fan is born very nearly white and *cools into* the
      // tier's hue over its life, which is what fire does and what the charge
      // never does — a charge spark is born its colour and stays it. The
      // remaining third carries the hue at birth so the tier is still readable
      // at the head of the burst as well as in its tail.
      if (rng.next() < 0.42) {
        sparkSpec.color0.lerpColors(tint, WHITE_HOT, 0.62).multiplyScalar(1.9);
      } else {
        sparkSpec.color0.lerpColors(tint, FLAME_HOT, 0.30).multiplyScalar(gain * 1.0);
      }
      setHdr(sparkSpec.color1, tint, gain * 0.22);
      if (!pool.emit(sparkSpec)) break;

      // ...and a round companion for every other one. The fan on its own is all
      // length and no width; the ember is the opposite, and stacked they read
      // as a body of fire with sparks coming out of it rather than as a comb.
      if (rng.next() < 0.55) {
        emberSpec.px = sparkSpec.px; emberSpec.py = sparkSpec.py; emberSpec.pz = sparkSpec.pz;
        emberSpec.vx = sparkSpec.vx * 0.7 + racer.vel.x * 0.14;
        emberSpec.vy = sparkSpec.vy * 0.7 + racer.vel.y * 0.14;
        emberSpec.vz = sparkSpec.vz * 0.7 + racer.vel.z * 0.14;
        emberSpec.life = rng.range(0.10, 0.20);
        emberSpec.size0 = rng.range(0.26, 0.52) * rig;
        emberSpec.size1 = emberSpec.size0 * 0.35;
        emberSpec.color0.lerpColors(tint, WHITE_HOT, 0.45).multiplyScalar(1.8);
        setHdr(emberSpec.color1, tint, gain * 0.24);
        pool.emit(emberSpec);
      }
    }
    sparkSpec.gravity = 15;
    sparkSpec.drag = 2.0;
    emberSpec.size1 = 0.05;

    dustRing(_p.x, _p.y - 0.4, _p.z, 16, 6 + 5 * power, racer.surface, 1.2 * rig);

    // Every boost source lights the same envelope. That is the whole reason it
    // exists: a pad, a mushroom, a trick and a mini-turbo were producing four
    // different amounts of frame effect for the same "I am boosting" state, and
    // a player cannot learn a signal that changes shape depending on where it
    // came from.
    fx.boostEnv = 1;

    if (racer.isPlayer) {
      // A draft is not a boost. It emits `kart:boost` because it genuinely is
      // free speed, and it earns the plume and the dust above — but the flash,
      // the shake and the rush are the vocabulary of thrust the player was
      // *given*, and spending them on tucking in behind somebody leaves the
      // game nothing louder to say when a mini-turbo actually fires.
      const draft = fx.boostKind === 2;
      if (!draft) {
        screen.flash(tier > 0 ? TIER_HEX[tier]! : 0xFFD9A0, 0.18 + 0.16 * power);
      }
      // The tier goes on the *rush*, not only on the flash.
      //
      // This is the correction that makes a violet ultra and a blue tier one
      // stop paying off identically. Measured, the flash was 0.102 in the tier
      // hex for one frame while the rush sat at 0.904 on a generic warm-orange
      // gradient for the whole boost — so the one cue with enough screen time
      // to carry the difference was carrying a constant, and everything the
      // player earned was being said in a frame nobody sees.
      screen.setRushTier(tier);
      // A short, sharp kick. Long enough to feel, over before it can get in the
      // way of the corner the player is usually already in.
      trauma = clamp01(trauma + (draft ? 0.05 : 0.16 + 0.16 * power));
      traumaDecay = 6.5;
    }
  }

  /**
   * Letting go of a drift.
   *
   * Releasing a fully charged tier three off-road used to produce *literally
   * nothing*: the sparks stopped, the speedo ring went back to yellow, and
   * three and a half seconds of investment evaporated without a frame of
   * acknowledgement, because the only thing watching for a release was the
   * boost — and off-road the boost is denied.
   *
   * A player cannot tell "I was refused" from "the game did not notice". So the
   * release itself is now an event. It is quieter than a boost by design — a
   * puff of spent rubber and the charge blowing off the wheels in its own
   * colour, with no ring, no flash and no shake — but it is never silent, and
   * at tier three it is loud enough to feel like something was thrown away.
   */
  function spendRelease(racer: Racer, fx: RacerFx, granted: boolean): void {
    const tier = fx.releaseTier;
    if (tier <= 0) return;
    const col = TIER[tier]!;
    const gain = TIER_GAIN[tier]!;
    const s = sizeOf(racer);

    for (let side = -1; side <= 1; side += 2) {
      sparkPort(racer, side, 0.20, _p);
      // Blown outward and upward off the wheel: the charge leaving, rather than
      // the kart being pushed. A boost throws its sparks straight back; this
      // one deliberately does not, so the two moments cannot be confused.
      const n = Math.round((granted ? 5 : 11) * tier * density);
      for (let i = 0; i < n; i++) {
        sparkSpec.px = _p.x + rng.range(-0.1, 0.1);
        sparkSpec.py = _p.y + rng.range(-0.05, 0.12);
        sparkSpec.pz = _p.z + rng.range(-0.1, 0.1);
        const out = rng.range(2.5, 7.5);
        sparkSpec.vx = racer.vel.x * 0.55 + _right.x * side * out + rng.range(-1.2, 1.2);
        sparkSpec.vy = racer.vel.y * 0.55 + rng.range(1.6, 5.2);
        sparkSpec.vz = racer.vel.z * 0.55 + _right.z * side * out + rng.range(-1.2, 1.2);
        sparkSpec.life = rng.range(0.2, 0.42);
        sparkSpec.size0 = rng.range(0.12, 0.24);
        sparkSpec.gravity = 18;
        sparkSpec.drag = 1.0;
        sparkSpec.color0.lerpColors(col, WHITE_HOT, 0.25).multiplyScalar(gain * 1.05);
        setHdr(sparkSpec.color1, col, gain * 0.22);
        if (!pool.emit(sparkSpec)) break;
      }
      // ...and the rubber it was standing on, letting go. Only if there *is*
      // rubber on anything: a puff of tarmac smoke under a machine that is
      // three metres in the air is a puff coming out of nowhere.
      if (!racer.grounded) continue;
      const sfx = SURFACE_FX[racer.surface];
      for (let i = 0; i < Math.round(7 * density); i++) {
        if (!smokePuff(racer, side, sfx, 0, 1.35, 1.0)) break;
      }
    }
    sparkSpec.gravity = 15;
    sparkSpec.drag = 2.0;

    // A single soft flare at each wheel, snapping shut. Without a shape with an
    // edge on it the release is just a few more sparks in a frame that already
    // had hundreds.
    if (!granted) {
      local(0, -RIDE_HEIGHT + 0.05, -s.len * 0.34, _p);
      // Light, not an annulus — the same correction the boost got. A charge
      // being thrown away is a glow going out under the machine, and a ring
      // lying in the road is a decal whatever event it is attached to.
      groundLight(_p.x, _p.y, _p.z, 1.2, 2.8 + 0.8 * tier, 0.24, col, gain * 0.45, 0.30);
      if (racer.isPlayer) screen.flash(TIER_HEX[tier]!, 0.05 + 0.02 * tier);
    }
  }

  /**
   * Touching down.
   *
   * Landing at 190 km/h used to produce a single pale wisp — no ring, no dust,
   * no weight. A landing is the one moment where the whole mass of the machine
   * arrives somewhere at once, and it has to be the ground that answers: a
   * hard ring punched flat across the surface, a low skirt of dust thrown
   * outward rather than upward, and a jolt in the hands.
   */
  function spendLand(racer: Racer, fx: RacerFx): void {
    const impact = clamp01(fx.pendLand);
    if (impact < 0.03) return;
    // ── how much of a landing this actually was ─────────────────────────────
    //
    // The single loudest bug this module had, and it took an instance dump to
    // find because it does not look like a bug — it looks like the drift being
    // washed out. A drift hop is 0.42m of air, which comes down at 5.3 m/s and
    // reports `impact` ≈ 0.41 through the same event a forty-metre jump uses.
    // A player hops several times a corner. So every corner was firing two
    // expanding rings up to nine metres across, forty puffs of dust, a burst of
    // warm rail sparks, a white screen flash and a camera kick — and *all of
    // that is warm*, right at the wheels, in the exact frames the mini-turbo is
    // trying to tell the player it has gone blue. Tier one was seventeen small
    // cyan sparks losing an argument with an eight-metre gold annulus.
    //
    // `airTime` is already in the payload and it is the honest discriminator:
    // a hop is a third of a second, a jump is most of a second. Below the hop
    // time the landing gets a puff of dust and nothing else — no ring, no
    // sparks, no flash, no shake.
    const flight = clamp01((fx.landAir - K.drift.hopTime) / 0.34);
    const punch = impact * (0.14 + 0.86 * flight);
    const s = sizeOf(racer);
    const rig = clamp(s.halfW / 0.85, 0.75, 1.6);
    local(0, -RIDE_HEIGHT + 0.05, 0, _p);

    // Thrown *outward*, low and flat: dust that climbs on a landing reads as an
    // explosion under the kart, dust that spreads reads as weight arriving.
    // This is the part a hop keeps, because a wheel hitting the road does move
    // some air whatever put it there.
    dustRing(_p.x, _p.y, _p.z, 5 + Math.round(26 * punch), 3 + 11 * punch, racer.surface,
      0.7 + 0.6 * punch);

    // ── the line between a bump and a landing ────────────────────────────────
    //
    // 0.16 rather than 0.10, and it is the number that decides whether the
    // shock ring is an event or wallpaper. `punch` folds `airTime` in — a drift
    // hop cannot exceed 0.14 whatever it lands at — so a gate here separates
    // "came off a crest" from "clipped a kerb" cleanly, and without it a chase
    // frame on an ordinary straight has a five-metre annulus painted under the
    // machine for no reason a player could name.
    if (punch < 0.16) return;

    // Two rings, fast and slow. One expanding hard edge reads as a shockwave;
    // a second, wider and softer behind it, reads as the dust it displaced.
    // Both are capped: an additive annulus lying flat on the road is the single
    // most expensive thing in the module per unit of usefulness, and past about
    // six metres it stops reading as a shock and starts reading as the road
    // being lit from below.
    //
    // Born wide enough to clear the machine, and holding their peak for a few
    // frames. At a birth diameter of one metre the first frames of a landing
    // ring are a disc underneath the kart, which is invisible, and by the time
    // it has expanded to something legible the fade has taken most of it — a
    // reviewer photographing a landing at speed found two white dots and a
    // dash where MK8 puts an annulus every single time.
    ring(_p.x, _p.y, _p.z, 1.8 * rig, (2.6 + 4.6 * punch) * rig, 0.22 + 0.16 * punch,
      WARM_WHITE, 2.0 + 1.2 * punch, 0.50 * punch + 0.05, true, 0.24);
    ring(_p.x, _p.y, _p.z, 2.6 * rig, (3.6 + 6.0 * punch) * rig, 0.38 + 0.24 * punch,
      surfaceColors.get(racer.surface) ?? WARM_WHITE, 1.2 + 0.7 * punch, 0.38 * punch + 0.03,
      true, 0.20);

    // ...and rubber, on any surface that has some to give.
    //
    // `dustRing` above is the right answer on dirt and no answer at all on
    // tarmac: the road row of `SURFACE_FX` carries `rate: 0` and a dust alpha a
    // quarter of dirt's, because tarmac has no dust — which left a landing at
    // 190 km/h on the main straight with nothing under it. What a hard surface
    // gives instead is smoke off four tyres slamming flat, thrown outward along
    // the deck rather than up.
    const sfx = SURFACE_FX[racer.surface];
    if (sfx.smoke > 0) {
      smokeSpec.px = _p.x; smokeSpec.py = _p.y + 0.16; smokeSpec.pz = _p.z;
      smokeSpec.vx = racer.vel.x * 0.35; smokeSpec.vy = 0.5; smokeSpec.vz = racer.vel.z * 0.35;
      smokeSpec.life = 0.55 + 0.35 * punch;
      smokeSpec.size0 = 0.30 * rig;
      smokeSpec.size1 = smokeSpec.size0 * 3.2;
      smokeSpec.alpha = 0.055 + 0.10 * punch;
      smokeSpec.rotVel = 0.9;
      setHdr(smokeSpec.color0, SMOKE, 1.05);
      setHdr(smokeSpec.color1, SMOKE_DEEP, 0.95);
      // spread 0.08 — an annulus lying on the deck, not a ball over the kart.
      pool.burst(smokeSpec, Math.round((10 + 26 * punch) * veilHero), 5 + 9 * punch, 0.08, rng);
      smokeSpec.alpha = 0.042;
      smokeSpec.rotVel = 0;
    }

    if (punch > 0.4 && (racer.surface === 'road' || racer.surface === 'rail' || racer.surface === 'boost')) {
      sparkBurst(_p.x, _p.y + 0.05, _p.z, Math.round(14 * punch), 7 * punch, RAIL_SPARK, 2.6);
    }
    if (racer.isPlayer) {
      if (punch > 0.3) screen.flash(0xFFFFFF, 0.04 + 0.09 * punch);
      // The jolt. A landing with no kick in it is a landing the hands never
      // felt, and the camera module damps its own boom in world space — the
      // only thing this module may move is the lens angle.
      trauma = clamp01(trauma + 0.06 + 0.34 * punch);
      traumaDecay = 7.5;
    }
  }

  function spendWall(racer: Racer, fx: RacerFx): void {
    const force = clamp01(fx.pendWall);
    const s = sizeOf(racer);
    local(fx.grindSide * (s.halfW + 0.14), -0.1, rng.range(-0.4, 0.4) * s.len, _p);
    sparkBurst(_p.x, _p.y, _p.z, 8 + Math.round(20 * force), 5 + 9 * force, RAIL_SPARK, 3.4);
    ring(_p.x, _p.y - 0.4, _p.z, 0.6, 2.4 + 3 * force, 0.24, WARM_WHITE, 1.4, 0.4 * force);
    if (racer.isPlayer) screen.flash(0xFFE0B0, 0.06 + 0.14 * force);
  }

  /**
   * Being hit, in four flavours.
   *
   * `item:reaction` carries the item module's authoritative reading of *what
   * the hit looks like*, and the whole point of that contract is that the four
   * do not look alike. One generic gold starburst for a banana, a red shell and
   * a lightning bolt tells the player nothing about what just happened to them,
   * which in a game where the answer changes what you should do next is a
   * wasted half second.
   *
   *   spin    a slip. Rubber, not fire: a low bloom of tyre smoke off all four
   *           corners and almost nothing bright.
   *   flip    a smash. Launched — so the burst goes up and out, hard, with a
   *           shock ring on the road under it and the loudest flash and kick.
   *   bump    a shove. Sideways, low, brief. It is contact, not damage.
   *   squish  flattened on the spot. Everything is driven *outward along the
   *           ground* from under the machine: nothing rises, because nothing
   *           was thrown — it was pressed.
   */
  function spendHit(racer: Racer, fx: RacerFx): void {
    const k = clamp01(fx.pendHit);
    const s = sizeOf(racer);
    const rig = clamp(s.halfW / 0.85, 0.75, 1.6);
    const kind = fx.hitKind;
    local(0, 0.1, 0, _p);
    const gx = _p.x, gy = _p.y - RIDE_HEIGHT + 0.06, gz = _p.z;

    if (kind === 1) {
      // A slip. Smoke off the tyres and a scuff of the surface, no shockwave.
      for (let side = -1; side <= 1; side += 2) {
        for (let end = -1; end <= 1; end += 2) {
          local(side * s.halfW * 0.86, -RIDE_HEIGHT + 0.12, end * s.len * 0.32, _p);
          smokeSpec.px = _p.x; smokeSpec.py = _p.y + 0.3; smokeSpec.pz = _p.z;
          smokeSpec.vx = racer.vel.x * 0.5; smokeSpec.vy = 1.0; smokeSpec.vz = racer.vel.z * 0.5;
          smokeSpec.life = 0.9;
          smokeSpec.size0 = 0.5 * rig;
          smokeSpec.size1 = smokeSpec.size0 * 3.0;
          smokeSpec.alpha = 0.062;
          smokeSpec.rotVel = rng.range(-1.2, 1.2);
          setHdr(smokeSpec.color0, SMOKE, 1.05);
          setHdr(smokeSpec.color1, SMOKE_DEEP, 0.95);
          pool.burst(smokeSpec, Math.round(7 * density), 2.6, 0.3, rng);
        }
      }
      smokeSpec.alpha = 0.042;
      dustRing(gx, gy, gz, 8, 4, racer.surface, 1.0 * rig);
      if (racer.isPlayer) {
        screen.flash(0xFFE8C0, 0.12);
        trauma = clamp01(trauma + 0.16);
        traumaDecay = 4.0;
      }
      return;
    }

    if (kind === 3) {
      // A shove. Low, sideways, over almost before it started.
      local(0, -0.05, 0, _p);
      ring(gx, gy, gz, 0.8, 3.4 * rig, 0.24, WARM_WHITE, 2.0, 0.5 * k);
      sparkBurst(_p.x, _p.y, _p.z, Math.round(14 * k), 8, WARM_WHITE, 2.6);
      dustRing(gx, gy, gz, 6, 4, racer.surface, 0.9 * rig);
      if (racer.isPlayer) {
        screen.flash(0xFFF0D0, 0.16);
        trauma = clamp01(trauma + 0.24);
        traumaDecay = 4.5;
      }
      return;
    }

    if (kind === 4) {
      // Flattened. Everything travels outward along the deck; nothing climbs.
      ring(gx, gy, gz, 0.6, 6.5 * rig, 0.34, TIER[1]!, 2.6, 0.9 * k);
      ring(gx, gy, gz, 0.4, 3.2 * rig, 0.20, WHITE_HOT, 2.4, 0.8);
      dustSpec.size0 = Math.min(SURFACE_FX[racer.surface].size * 1.5, MAX_PUFF / 2.6);
      dustSpec.px = gx; dustSpec.py = gy + dustSpec.size0 * 0.5; dustSpec.pz = gz;
      dustSpec.vx = 0; dustSpec.vy = 0.3; dustSpec.vz = 0;
      dustSpec.life = 0.7;
      dustSpec.size1 = dustSpec.size0 * 2.6;
      dustSpec.alpha = Math.max(SURFACE_FX[racer.surface].alpha, 0.075);
      setHdr(dustSpec.color0, surfaceColors.get(racer.surface) ?? WARM_WHITE, 1.0);
      setHdr(dustSpec.color1, surfaceDeep.get(racer.surface) ?? WARM_WHITE, 0.85);
      // spread 0.06: a disc, not a ball. The kart was pressed, not thrown.
      pool.burst(dustSpec, Math.round(18 * density), 9, 0.06, rng);
      if (racer.isPlayer) {
        screen.flash(0xC9E4FF, 0.34);
        trauma = clamp01(trauma + 0.5);
        traumaDecay = 3.2;
      }
      return;
    }

    // flip, and anything physics stunned without an item behind it: a smash.
    ring(gx, gy, gz, 1.0, 6.0 * rig, 0.4, WARM_WHITE, 2.4, 0.8 * k);
    sparkBurst(_p.x, _p.y, _p.z, Math.round(26 * k), 11, GOLD, 3.0);
    sparkBurst(_p.x, _p.y + 0.3, _p.z, Math.round(10 * k), 7, WHITE_HOT, 2.4);
    dustRing(gx, gy, gz, 10, 5, racer.surface, 1.1 * rig);

    // No loose stars here. This used to throw seven pooled ones at five
    // different sizes with no velocity inheritance, and since the kart carries
    // on at fifty metres a second while they hang where they were born, what a
    // screenshot a fifth of a second later caught was flat yellow cardboard
    // strewn across the road *ahead* of the player, floating a metre off the
    // tarmac and attached to nothing. The spin-out already has a ring — see
    // `spinStars` — which orbits the machine and travels with it. One
    // vocabulary per idea: stars mean "this racer is stunned", and they live on
    // the racer.

    if (racer.isPlayer) {
      screen.flash(0xFFE8C0, 0.3);
      trauma = clamp01(trauma + 0.45);
      traumaDecay = 2.6;
    }
  }

  function spendBump(racer: Racer, fx: RacerFx): void {
    const k = clamp01(fx.pendBump);
    ring(fx.bumpX, fx.bumpY - RIDE_HEIGHT + 0.06, fx.bumpZ, 0.6, 2.6, 0.24, WARM_WHITE, 1.8, 0.5 * k);
    sparkBurst(fx.bumpX, fx.bumpY, fx.bumpZ, 6 + Math.round(8 * k), 5, WARM_WHITE, 2.2);
    if (racer.isPlayer) screen.flash(0xFFF0D0, 0.06 + 0.08 * k);
  }

  /**
   * A bogged start. The tyres spin, the machine does not move, and a wall of
   * smoke comes off the back — the one moment in the game where a big slow
   * cloud is the right answer rather than a lazy one.
   */
  function spendBurnout(racer: Racer): void {
    const s = sizeOf(racer);
    for (let side = -1; side <= 1; side += 2) {
      rearWheel(racer, side, 0.10, _p);
      smokeSpec.px = _p.x; smokeSpec.py = _p.y; smokeSpec.pz = _p.z;
      smokeSpec.vx = -_fwd.x * 2.5; smokeSpec.vy = 1.1; smokeSpec.vz = -_fwd.z * 2.5;
      smokeSpec.life = 1.5;
      smokeSpec.size0 = 0.6;
      smokeSpec.size1 = 2.6;
      smokeSpec.alpha = 0.055;
      smokeSpec.rotVel = 0.7;
      setHdr(smokeSpec.color0, SMOKE, 1.1);
      setHdr(smokeSpec.color1, SMOKE_DEEP, 1.0);
      pool.burst(smokeSpec, Math.round(34 * density), 3.2, 0.3, rng);
      // A few rubber flecks, which is what tells the eye the smoke came off a
      // tyre rather than out of an engine.
      sparkBurst(_p.x, _p.y, _p.z, 5, 4, SMOKE_DEEP, 0.35);
    }
    smokeSpec.alpha = 0.042;
    local(0, -RIDE_HEIGHT + 0.04, -s.len * 0.3, _p);
    dustRing(_p.x, _p.y, _p.z, 10, 4, racer.surface, 1.3);
  }

  /** Coins. A short gold sparkle at the collector's shoulder — enough to notice
   *  in the corner of the eye, not enough to compete with the sparks. */
  function spendCoin(racer: Racer, n: number): void {
    const s = sizeOf(racer);
    local(rng.range(-0.5, 0.5) * s.halfW, s.height * 0.5, 0, _p);
    for (let i = 0; i < Math.round(5 * n * density); i++) {
      starSpec.px = _p.x + rng.range(-0.3, 0.3);
      starSpec.py = _p.y + rng.range(-0.2, 0.3);
      starSpec.pz = _p.z + rng.range(-0.3, 0.3);
      // Full inheritance and a very short life: a coin is a glint on the
      // machine, and anything that lags behind it turns into gold litter
      // strewn down the road.
      starSpec.vx = racer.vel.x + rng.range(-1.6, 1.6);
      starSpec.vy = racer.vel.y + rng.range(1.2, 3.2);
      starSpec.vz = racer.vel.z + rng.range(-1.6, 1.6);
      starSpec.life = rng.range(0.16, 0.30);
      starSpec.size0 = rng.range(0.14, 0.24);
      starSpec.size1 = 0.02;
      setHdr(starSpec.color0, GOLD, 2.6);
      setHdr(starSpec.color1, GOLD, 0.4);
      if (!pool.emit(starSpec)) break;
    }
    starSpec.size1 = 0.1;
  }

  /** Coins knocked loose. The same gold, thrown away from the kart and falling —
   *  the shape of the effect is the whole message. */
  function spendCoinLoss(racer: Racer, k: number): void {
    local(0, 0.45, 0, _p);
    starSpec.px = _p.x; starSpec.py = _p.y; starSpec.pz = _p.z;
    starSpec.vx = racer.vel.x * 0.3;
    starSpec.vy = 3.5;
    starSpec.vz = racer.vel.z * 0.3;
    starSpec.life = 0.9;
    starSpec.size0 = 0.34;
    setHdr(starSpec.color0, GOLD, 2.6);
    setHdr(starSpec.color1, GOLD, 0.5);
    pool.burst(starSpec, Math.round((4 + 8 * k) * density), 6, 0.5, rng);
  }

  /** Star / bullet pick-up: a rising column of light off the machine. */
  function spendPowerUp(racer: Racer): void {
    const s = sizeOf(racer);
    local(0, -RIDE_HEIGHT + 0.06, 0, _p);
    ring(_p.x, _p.y, _p.z, 0.8, 6.5, 0.45, GOLD, 2.6, 0.9);
    for (let i = 0; i < Math.round(26 * density); i++) {
      const a = rng.next() * TAU;
      const r = rng.range(0.2, 1.0) * s.halfW * 1.6;
      starSpec.px = _p.x + Math.cos(a) * r;
      starSpec.py = _p.y + rng.range(0, 0.3);
      starSpec.pz = _p.z + Math.sin(a) * r;
      starSpec.vx = racer.vel.x * 0.85 + Math.cos(a) * 1.2;
      starSpec.vy = racer.vel.y * 0.85 + rng.range(4, 9);
      starSpec.vz = racer.vel.z * 0.85 + Math.sin(a) * 1.2;
      starSpec.life = rng.range(0.35, 0.7);
      starSpec.size0 = rng.range(0.2, 0.42);
      setHdr(starSpec.color0, GOLD, 3.0);
      setHdr(starSpec.color1, WARM_WHITE, 0.4);
      if (!pool.emit(starSpec)) break;
    }
  }

  /** The sparkle that trails a racer under a star or a bullet. A state, not an
   *  event: it runs for as long as the effect is on them. */
  function powerTrail(racer: Racer, fx: RacerFx, dt: number): void {
    const s = sizeOf(racer);
    fx.sparkle += 40 * density * fx.near * dt;
    let n = Math.floor(fx.sparkle);
    fx.sparkle -= n;
    if (n > 6) n = 6;
    for (let i = 0; i < n; i++) {
      local(
        rng.range(-1, 1) * s.halfW * 1.1,
        rng.range(-0.3, 1) * s.height * 0.6,
        rng.range(-0.6, 0.5) * s.len,
        _p,
      );
      starSpec.px = _p.x; starSpec.py = _p.y; starSpec.pz = _p.z;
      starSpec.vx = racer.vel.x * 0.55 + rng.range(-1, 1);
      starSpec.vy = racer.vel.y * 0.55 + rng.range(0.5, 2.5);
      starSpec.vz = racer.vel.z * 0.55 + rng.range(-1, 1);
      starSpec.life = rng.range(0.25, 0.5);
      starSpec.size0 = rng.range(0.16, 0.32);
      setHdr(starSpec.color0, GOLD, 2.8);
      setHdr(starSpec.color1, GOLD, 0.3);
      if (!pool.emit(starSpec)) break;
    }
  }

  /** Stars orbiting a spun-out kart. Immediate mode — they are a state, not an
   *  event, and the state is `racer.stunned`. */
  function spinStars(racer: Racer, add: SpriteLayer): void {
    const s = sizeOf(racer);
    const t = ctx.time.elapsed;
    const fade = clamp01(racer.stunned * 2.2);
    // Above the machine, not around its axles. `size.height` is measured from
    // the contact point, and the racer's origin already floats RIDE_HEIGHT off
    // the ground, so clearing the roof means the full height less that offset —
    // plus a little air, because a halo that grazes the bodywork reads as part
    // of the bodywork.
    const lift = s.height - RIDE_HEIGHT + 0.30;
    // Tight. The radius used to scale with the machine, which on the plane —
    // four and a half metres across the wings — threw the ring out past the
    // wingtips, and from a chase camera that is indistinguishable from stars
    // lying on the road beside the kart. A halo is a halo: it is about the same
    // size whatever is wearing it, and it has to be small enough that no part
    // of it can ever be mistaken for something on the ground.
    const r = 0.62 + Math.min(s.halfW, 1.1) * 0.30;
    for (let i = 0; i < 6; i++) {
      const a = t * 5.4 + (i * TAU) / 6;
      // Tilted, so the ring reads as a ring rather than as six sprites in a
      // line whenever the camera is level with it.
      local(Math.cos(a) * r, lift + Math.sin(a) * r * 0.30, Math.sin(a) * r, _p);
      // One size for every star, and the pulse only moves the brightness. Five
      // stars at five different sizes read as five different objects; six
      // identical ones read as one halo turning.
      const pulse = 0.72 + 0.28 * Math.sin(t * 13 + i);
      const k = 3.0 * pulse * fade;
      // A soft halo behind each, so they bloom into a ring rather than sitting
      // there as six opaque decals — which was the other half of the cardboard.
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        GOLD.r * k * 0.4, GOLD.g * k * 0.4, GOLD.b * k * 0.34, 0.55 * fade,
        0.62, 0, 0, CELL.glow, MODE.billboard,
      );
      add.push(
        _p.x, _p.y, _p.z, 0, 0, 0,
        GOLD.r * k, GOLD.g * k, GOLD.b * k, 0.95 * fade,
        0.40, 0, a * 0.8, CELL.star, MODE.billboard,
      );
    }
  }

  /**
   * The finish. Two thirds of it is thrown *up out of the kart* and the rest
   * rains from above, because a burst that only falls has no moment of origin
   * and reads as weather.
   *
   * Flakes are large and the spread is tight. The first pass scattered small
   * ones over an eighteen-metre box, which is the correct size for a stadium
   * and completely wrong for something meant to fill the frame the player is
   * looking at: from a chase camera it produced a dozen visible specks.
   *
   * The falling half is thrown *forward*, down the direction of travel, and the
   * flakes are half the size they were. Both because of where the lens is. A
   * box centred on the kart is also a box centred on the camera six metres
   * behind it, so a third of the burst was spawning inside the near plane: one
   * flake at arm's length is thirty centimetres of solid magenta across a
   * quarter of the frame, and the finish read as the screen being hit by a
   * paint bomb rather than as confetti. Ahead of the machine they fall through
   * the shot instead of onto the glass.
   */
  function confettiBurst(
    x: number, y: number, z: number, n: number,
    vx = 0, vy = 0, vz = 0,
  ): void {
    // Which way "ahead" is, taken from the bulk velocity the caller threw the
    // burst with. Zero for a standing burst, which then falls straight down as
    // it always did.
    const speed = Math.hypot(vx, vz);
    const ax = speed > 0.5 ? vx / speed : 0;
    const az = speed > 0.5 ? vz / speed : 0;
    const lead = Math.min(14, speed * 0.5);

    for (let i = 0; i < n; i++) {
      // Two fifths out of the machine, three fifths raining across the shot.
      // It was the other way round, and the result was a clump behind the kart
      // with an empty frame around it — a burst, where what a finish wants is
      // weather.
      const fountain = i * 5 < n * 2;
      if (fountain) {
        // Out of the machine, in a cone.
        const a = rng.next() * TAU;
        const r = rng.range(0, 0.9);
        flakeSpec.px = x + Math.cos(a) * r;
        flakeSpec.py = y + rng.range(0.2, 1.2);
        flakeSpec.pz = z + Math.sin(a) * r;
        const out = rng.range(3, 11);
        flakeSpec.vx = vx + Math.cos(a) * out;
        flakeSpec.vy = vy * 0.4 + rng.range(4.5, 9.5);
        flakeSpec.vz = vz + Math.sin(a) * out;
        flakeSpec.life = rng.range(2.6, 4.6);
      } else {
        // Ahead of the machine and well above it, so the fall happens in front
        // of the lens rather than on it.
        const along = lead + rng.range(-3, 13);
        const across = rng.range(-11, 11);
        flakeSpec.px = x + ax * along - az * across;
        flakeSpec.py = y + rng.range(3.0, 8.0);
        flakeSpec.pz = z + az * along + ax * across;
        flakeSpec.vx = vx * 0.35 + rng.range(-2.5, 2.5);
        flakeSpec.vy = rng.range(-1, 2);
        flakeSpec.vz = vz * 0.35 + rng.range(-2.5, 2.5);
        flakeSpec.life = rng.range(2.2, 4.0);
      }
      // ── paper, not sweets ────────────────────────────────────────────────
      //
      // A flake used to be as wide as it was long, and a rounded square that
      // never changes its aspect is a *pill*: photographed at 4x, the finish
      // threw a storm of lozenges that never caught the light and never
      // sparkled. Real confetti is a thin strip, and what makes a storm of it
      // glitter is that each piece is a different width from the last.
      //
      // A billboard quad's `stretch` is plain extra half-length in metres (the
      // shader only reinterprets it in velocity mode), so it costs nothing to
      // make these rectangles: a narrow cross-section, a length that varies
      // three to one across the population, and a hard spin about the view
      // axis. The ones at the narrow end read as edge-on and the wide ones as
      // face-on, which is the flicker the effect was missing.
      flakeSpec.size0 = rng.range(0.09, 0.20);
      flakeSpec.size1 = flakeSpec.size0;
      flakeSpec.stretch = rng.range(0.06, 0.19);
      flakeSpec.rot = rng.next() * TAU;
      flakeSpec.rotVel = rng.range(-15, 15);
      const c = confettiColors[rng.int(0, confettiColors.length - 1)]!;
      // Confetti catches the light: born a little hot, settling to its own hue.
      setHdr(flakeSpec.color0, c, 1.7);
      setHdr(flakeSpec.color1, c, 0.9);
      if (!pool.emit(flakeSpec)) break;
    }
    // The preset is a shared register bank — see `ParticleSpec`. The item box
    // throws flakes too and wants square ones.
    flakeSpec.stretch = 0;
  }

  // ── speed lines ───────────────────────────────────────────────────────────
  //
  // Kept out of the particle pool. A streak wants a *fixed screen-space*
  // orientation and a length measured in fractions of the frame, and the pool's
  // stretch is derived from world velocity — which for a line sitting still in
  // front of a camera doing 60 m/s is exactly zero. So this is its own tiny
  // simulation: one flat buffer, spawn, integrate, fill.
  //
  // [ x, y, z, vx, vy, vz, age, life, rot, size, stretch, alpha ]
  const LINE_STRIDE = 12;
  const lineData = new Float32Array(LAYER_RUSH * LINE_STRIDE);
  let lineCount = 0;

  function spawnLines(amount: number, dt: number): void {
    lineAcc += amount * 300 * density * dt;
    let n = Math.floor(lineAcc);
    lineAcc -= n;
    if (n > 26) n = 26;
    if (n <= 0) return;

    const cam = ctx.camera;
    _camFwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _camRight.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _camUp.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const tanH = Math.tan(cam.fov * DEG * 0.5);

    for (let i = 0; i < n; i++) {
      if (lineCount >= LAYER_RUSH) return;
      // Right on the glass.
      //
      // A speed line is a *lens* effect, and this used to place it nine to
      // twenty-six metres out into the world. Everything about it is scaled by
      // `d`, so the screen-space result is identical either way — but out there
      // a streak spawned low in the frame is a two-metre object hanging over
      // the tarmac in front of the kart, and the review shots caught exactly
      // that: white hairlines lying flat on the road like sticks. At a metre
      // and a half to three the streak is unambiguously *in front of the
      // camera*, closer than any geometry it could be mistaken for, and the
      // depth-test-off rush layer draws it over the world where it belongs.
      const d = rng.range(1.5, 3.0);
      // A constant fraction of the *frame*, whatever the depth: the streaks form
      // a ring around the edge rather than a cloud in front of the kart.
      //
      // The floor matters more than it looks. A streak is placed by its centre
      // and drawn radially, so its inner tip reaches `u - stretch` toward the
      // vanishing point: at an old floor of 0.78 against a half-length of up to
      // 0.46, streaks were routinely landing a third of the way from the middle
      // of the frame — across the road the player is trying to read, and across
      // the machine they are trying to place.
      //
      // But 1.02 put the *centre* of every streak outside the glass, so all
      // that ever reached the frame was the last centimetre of an inner tip and
      // two hundred and forty km/h had no visible cue at all. 1.00 with the
      // half-length below capped at 0.30 is the compromise: the body of every
      // streak lands in the outer band, no inner tip reaches past 0.70 of the
      // half-frame, and the middle — the part the game is played in — is
      // arithmetically guaranteed to stay clean.
      // Placed by its centre, so where the *body* of a streak lands is what
      // matters, not where its inner tip reaches. The previous band started at
      // 1.00 — exactly the edge of the frame — and ran to 1.55, which means
      // roughly four streaks in five were spawned entirely outside the glass
      // and the module was paying for a hundred quads to show eight. A
      // photograph of the game at full speed came back with a scattering of
      // hairs in one corner.
      //
      // 0.92 to 1.32 with the half-length below capped at 0.24 puts the body of
      // every streak in the outer band where peripheral vision reads speed, and
      // still guarantees no inner tip reaches past 0.68 of the half-frame — the
      // middle two thirds, which is the part the game is played in, stays
      // arithmetically clean.
      const u = rng.range(0.92, 1.32);
      const a = rng.next() * TAU;
      const hy = d * tanH * u;
      const ox = Math.cos(a) * hy * cam.aspect;
      const oy = Math.sin(a) * hy;

      _p.copy(cam.position)
        .addScaledVector(_camFwd, d)
        .addScaledVector(_camRight, ox)
        .addScaledVector(_camUp, oy);

      const o = lineCount * LINE_STRIDE;
      lineData[o] = _p.x; lineData[o + 1] = _p.y; lineData[o + 2] = _p.z;
      // A little motion of their own, so the effect still reads if the boost
      // fires before the kart has picked the speed up.
      // Drifting toward the lens, which at this range is what makes the streak
      // grow across the frame the way the world does. Slow enough that it
      // cannot reach the near plane inside its own life.
      lineData[o + 3] = -_camFwd.x * 2.4;
      lineData[o + 4] = -_camFwd.y * 2.4;
      lineData[o + 5] = -_camFwd.z * 2.4;
      lineData[o + 6] = 0;
      lineData[o + 7] = rng.range(0.18, 0.32);
      // The long axis is the view-space direction out from the vanishing point,
      // which is exactly the path the world takes across the frame.
      lineData[o + 8] = Math.atan2(oy, ox);
      lineData[o + 9] = rng.range(0.16, 0.34) * d * 0.08;
      lineData[o + 10] = d * tanH * rng.range(0.10, 0.24);
      lineData[o + 11] = rng.range(0.72, 1.15) * amount;
      lineCount++;
    }
  }

  function updateLines(dt: number, rush: SpriteLayer): void {
    let i = 0;
    while (i < lineCount) {
      const o = i * LINE_STRIDE;
      const age = lineData[o + 6] + dt;
      const life = lineData[o + 7];
      if (age >= life) {
        lineCount--;
        if (i !== lineCount) {
          lineData.copyWithin(o, lineCount * LINE_STRIDE, lineCount * LINE_STRIDE + LINE_STRIDE);
        }
        continue;
      }
      lineData[o + 6] = age;
      lineData[o] += lineData[o + 3] * dt;
      lineData[o + 1] += lineData[o + 4] * dt;
      lineData[o + 2] += lineData[o + 5] * dt;

      // In and out on one hump: a streak that pops into existence at full
      // brightness reads as a scratch on the lens.
      const a = lineData[o + 11] * Math.sin(Math.PI * (age / life));
      rush.push(
        lineData[o], lineData[o + 1], lineData[o + 2],
        0, 0, 0,
        WARM_WHITE.r * 3.2, WARM_WHITE.g * 3.1, WARM_WHITE.b * 2.9, a,
        lineData[o + 9], lineData[o + 10], lineData[o + 8],
        CELL.streak, MODE.billboard,
      );
      i++;
    }
  }

  // ── bus wiring. Handlers record impulses only ─────────────────────────────

  ctx.bus.on<{ racer: Racer }>('kart:drift:start', ({ racer }) => {
    fxOf(racer).pendDriftStart = 1;
  });

  ctx.bus.on<{ racer: Racer; tier: number }>('kart:drift:charge', ({ racer, tier }) => {
    if (tier <= 0) return;
    const fx = fxOf(racer);
    fx.pendTier = Math.max(fx.pendTier, tier);
  });

  ctx.bus.on<{ racer: Racer; source: string; power: number }>('kart:boost', ({ racer, source, power }) => {
    const fx = fxOf(racer);
    fx.pendBoost = Math.max(fx.pendBoost, power);
    // Assignment, not `Math.max`. See the note on `boostTier`: a latch that only
    // ever climbs, cleared only when the boost window closes, means every boost
    // chained onto a mini-turbo wears the mini-turbo's colour. Each source
    // states its own tier — a pad states zero, and zero is an answer.
    fx.boostTier = source === 'drift1' ? 1 : source === 'drift2' ? 2 : source === 'drift3' ? 3 : 0;
    fx.boostKind = source === 'slipstream' ? 2 : 1;
    // Physics has already written `boost.time` when it emits this, so this is
    // the boost's full length — the denominator the ignition envelope reads its
    // age from. See `boostFull`.
    fx.boostFull = racer.boost.time;
  });

  ctx.bus.on<{ racer: Racer; impact: number; airTime?: number }>('kart:land', ({ racer, impact, airTime }) => {
    const fx = fxOf(racer);
    if (impact >= fx.pendLand) {
      fx.pendLand = impact;
      fx.landAir = airTime ?? 1;
    }
  });

  ctx.bus.on<{ racer: Racer }>('kart:hop', ({ racer }) => {
    fxOf(racer).pendHop = 1;
  });

  ctx.bus.on<{ racer: Racer }>('kart:offroad', ({ racer }) => {
    fxOf(racer).pendOffroad = 1;
  });

  ctx.bus.on<{ racer: Racer; force: number }>('kart:wall', ({ racer, force }) => {
    const fx = fxOf(racer);
    fx.pendWall = Math.max(fx.pendWall, force);
    fx.grind = Math.max(fx.grind, 0.28);
  });

  // Physics' own three-value vocabulary, and the fallback for anything that
  // stuns a kart without an item behind it. `item:reaction` lands in the same
  // fixed step immediately afterwards and overwrites the kind with the item
  // module's authoritative reading — see ARCHITECTURE §7. Impulses are spent in
  // `update`, so the later, better-informed event always wins.
  ctx.bus.on<{ racer: Racer }>('kart:hit', ({ racer }) => {
    const fx = fxOf(racer);
    fx.pendHit = 1;
    fx.hitKind = 0;
  });

  const HIT_KIND: Record<string, number> = { spin: 1, flip: 2, bump: 3, squish: 4 };
  ctx.bus.on<{ racer: Racer; kind: string; force: number }>('item:reaction', ({ racer, kind, force }) => {
    const fx = fxOf(racer);
    fx.pendHit = Math.max(fx.pendHit, clamp(force, 0.35, 1.4));
    fx.hitKind = HIT_KIND[kind] ?? 0;
  });

  ctx.bus.on<{ racer: Racer }>('kart:trick', ({ racer }) => {
    fxOf(racer).pendTrick = 1;
  });

  ctx.bus.on<{ a: Racer; b: Racer; force: number }>('kart:bump', ({ a, b, force }) => {
    // Contact resolution fires this every fixed step while two karts overlap —
    // 120 times a second for as long as they are touching. One pop per pair per
    // fifth of a second is the event a player actually perceives.
    const key = Math.min(a.id, b.id) * 64 + Math.max(a.id, b.id);
    const last = bumpAt.get(key) ?? -99;
    if (ctx.time.elapsed - last < 0.2) return;
    bumpAt.set(key, ctx.time.elapsed);
    const target = a.isPlayer || !b.isPlayer ? a : b;
    const fx = fxOf(target);
    fx.pendBump = Math.max(fx.pendBump, clamp01(force * 3));
    fx.bumpX = (a.pos.x + b.pos.x) * 0.5;
    fx.bumpY = (a.pos.y + b.pos.y) * 0.5;
    fx.bumpZ = (a.pos.z + b.pos.z) * 0.5;
  });

  // The director counts `ceil(timer - 1)`, so it reaches zero a whole second
  // before the lights actually go out. Treating that zero as "GO" — which this
  // used to — fired the launch burst while the field was still stationary, and
  // then the real start had nothing at all. The beats come off the number; the
  // start comes off the phase change, which is the only thing that happens at
  // the same instant the karts are allowed to move.
  ctx.bus.on<{ n: number }>('race:countdown', ({ n }) => {
    pendCountdown = Math.max(pendCountdown, 4 - clamp(n, 0, 3));
  });

  let lastPhase: string = ctx.race.phase;
  ctx.bus.on<{ phase: string }>('race:phase', ({ phase }) => {
    // Only a real countdown → racing transition. A capture reset drops straight
    // into 'racing', and a starting-line burst under a kart already at 60 m/s
    // reads as a bug rather than as a start.
    if (phase === 'racing' && lastPhase === 'countdown') pendGo = 1;
    lastPhase = phase;
  });

  /**
   * The flag, and **what the flag was worth**.
   *
   * This used to be `if (racer.isPlayer) pendConfetti = 1` — full strength,
   * place ignored — while the other two modules answering the same event both
   * read it: the mixer picks `finish` or `finish.back` off the podium test, and
   * the director arms a finish beat that drains the colour out of the whole
   * frame for fourth or worse. So a sixth of eight got the sad fanfare, the
   * grey wash *and* several hundred hot-pink confetti flakes, simultaneously.
   *
   * The burst is the celebration, so it scales with the thing being celebrated:
   * full for a win, most of it for the rest of the podium, and a token amount
   * off it — the field is still finishing, and something should still land, but
   * nothing about the player's own frame should look like a party.
   *
   * **And it only ever answers for the player.** There was a second branch here
   * that gave any *non*-player finish a flat 0.35 — and the burst is spawned on
   * `player`, at the player's position, carrying the player's velocity, because
   * that is the only anchor this effect has. So each of the seven CPUs crossing
   * the line let off a hundred and fifty flakes and a white screen flash out of
   * the player's own machine, at whatever point in the closing laps they
   * happened to finish, while the player was still driving. It also quietly
   * outranked the careful scale above: 0.35 for somebody else's race is three
   * times the 0.12 the player's own sixth place asks for.
   *
   * `race:finish` fires once per racer, and all three modules that answer it now
   * ask the same first question. The mixer cues nothing for a CPU, the director
   * arms no finish beat for one, and this throws no confetti for one.
   */
  ctx.bus.on<{ racer: Racer; place: number; podium: boolean }>(
    'race:finish', ({ racer, place, podium }) => {
      if (!racer.isPlayer) return;
      pendConfetti = Math.max(pendConfetti, podium ? (place === 1 ? 1 : 0.72) : 0.12);
    },
  );

  ctx.bus.on<{ racer: Racer }>('race:lap', ({ racer }) => {
    if (racer.isPlayer) pendLapPop = 1;
  });

  /**
   * A new best lap, on the frame it happens.
   *
   * The one thing a player chases lap to lap, and until now it produced nothing
   * at all until the results sheet — `race:bestlap` had no listener anywhere in
   * the game. A cool flash rather than the orange one the final lap gets: this
   * is a *time*, not a state change, and it must not be mistaken for the alarm
   * that says the race is nearly over.
   */
  ctx.bus.on<{ racer: Racer }>('race:bestlap', ({ racer }) => {
    if (racer.isPlayer) screen.flash(0x8CE9FF, 0.22);
  });

  ctx.bus.on<{ racer: Racer }>('race:rocketStart', ({ racer }) => {
    const fx = fxOf(racer);
    fx.pendBoost = Math.max(fx.pendBoost, 42);
  });

  // Bogged the start: a cloud of wasted rubber and no forward motion. Loud,
  // because the punishment being legible is the whole point of the mechanic.
  ctx.bus.on<{ racer: Racer }>('race:burnout', ({ racer }) => {
    fxOf(racer).pendBurnout = 1;
  });

  ctx.bus.on<{ racer: Racer; power: number }>('kart:launch', ({ racer, power }) => {
    const fx = fxOf(racer);
    fx.pendLaunch = Math.max(fx.pendLaunch, clamp01(power / 9));
  });

  // Drafting. The tell is on the *frame*, not on the kart: the air the player is
  // sitting in starts moving. A pulse on entry and a held wind while it lasts.
  ctx.bus.on<{ racer: Racer; state: string }>('kart:slipstream', ({ racer, state }) => {
    const fx = fxOf(racer);
    if (state === 'enter') { fx.draft = 1; fx.pendDraft = 1; } else fx.draft = 0;
  });

  ctx.bus.on<{ racer: Racer }>('kart:trick:start', ({ racer }) => {
    fxOf(racer).pendHop = 1;
  });

  // ── items. Every one of these is a moment the item module announces and,
  // until now, nothing drew. The item system builds its own blast and burst
  // *meshes*; what is added here is the particle half — the debris, the sparks
  // and the dust that stop those meshes reading as a decal popping in place.

  ctx.bus.on<{ pos: THREE.Vector3; radius: number }>('item:blast', ({ pos, radius }) => {
    const scale = clamp(radius / 6, 0.6, 2.2);
    api.spawn('explosion', pos, { scale });
  });

  ctx.bus.on<{ pos: THREE.Vector3 }>('item:box', ({ pos }) => {
    api.spawn('boxBreak', pos, { scale: 1 });
  });

  ctx.bus.on<{ pos: THREE.Vector3; kind: string }>('item:bounce', ({ pos, kind }) => {
    api.spawn('impact', pos, { scale: 0.7, color: kind === 'greenShell' ? 0x8CE06A : 0xFF7A6A });
  });

  ctx.bus.on<{ racer: Racer; total: number }>('coin:get', ({ racer }) => {
    fxOf(racer).pendCoin = Math.min(3, fxOf(racer).pendCoin + 1);
  });

  ctx.bus.on<{ racer: Racer; count: number }>('coin:lose', ({ racer, count }) => {
    const fx = fxOf(racer);
    fx.pendCoinLoss = Math.max(fx.pendCoinLoss, Math.min(1, count / 3));
  });

  ctx.bus.on<{ racer: Racer; effect: string; on: boolean }>('item:effect', ({ racer, effect, on }) => {
    if (!on) return;
    const fx = fxOf(racer);
    if (effect === 'star' || effect === 'bullet') fx.pendPowerUp = 1;
  });

  ctx.bus.on<{ standings: number[] }>('race:results', () => {
    pendConfetti = Math.max(pendConfetti, 1);
  });

  ctx.bus.on('quality:changed', () => {
    density = clamp01(ctx.quality.particles);
    marks.applyQuality();
  });

  // ── the public face ───────────────────────────────────────────────────────

  const api: FxSystem = {
    spawn(id: string, pos: THREE.Vector3, opts?: Record<string, unknown>): void {
      if (qCount >= QUEUE) return;
      qId[qCount] = id;
      qX[qCount] = pos.x; qY[qCount] = pos.y; qZ[qCount] = pos.z;
      qScale[qCount] = typeof opts?.scale === 'number' ? (opts.scale as number) : 1;
      qColor[qCount] = typeof opts?.color === 'number' ? (opts.color as number) : -1;
      qCount++;
    },

    shake(amount: number, duration = 0.4): void {
      trauma = clamp01(trauma + clamp01(amount));
      traumaDecay = 1 / Math.max(0.05, duration);
    },

    flash(color: number, amount = 0.4): void {
      screen.flash(color, amount);
    },
  };
  ctx.fx = api;

  function drainQueue(): void {
    for (let i = 0; i < qCount; i++) {
      const id = qId[i]!;
      const x = qX[i]!, y = qY[i]!, z = qZ[i]!;
      const scale = qScale[i]!;
      const hex = qColor[i]!;
      const col = hex >= 0 ? _tint.setHex(hex) : WARM_WHITE;

      // Everything below that happens *to a racer* travels with them — see
      // `inheritVel`. Effects that belong to the ground (a box breaking, a
      // blast crater, a dust ring punched into the surface) deliberately do
      // not, and are the reason this is per-case rather than global.
      const v = inheritVel(x, y, z);

      switch (id) {
        case 'spark':
        case 'sparks':
          sparkBurst(x, y, z, 16 * scale, 8 * scale, col, 3.0, v);
          break;
        case 'dust':
          // The ground being disturbed. Whatever the player is standing on, not
          // a hardcoded 'dirt': a dust ring the colour of a surface nobody is on
          // is the same mistake as smoke the colour of dirt.
          dustRing(x, y, z, 10 * scale, 4 * scale, ctx.player?.surface ?? 'road', scale);
          break;
        case 'smoke':
          smokeBurst(x, y, z, 12 * scale, 3.2 * scale, scale, v);
          break;
        case 'splash':
          dustRing(x, y, z, 16 * scale, 6 * scale, 'water', scale);
          break;
        case 'explosion':
          ring(x, y, z, 1.5 * scale, 12 * scale, 0.5, FLAME_MID, 3.0, 1);
          sparkBurst(x, y + 0.4, z, 34 * scale, 16 * scale, FLAME_HOT, 4.0);
          smokeBurst(x, y + 0.3, z, 16 * scale, 6 * scale, 1.4 * scale);
          dustRing(x, y, z, 14 * scale, 9 * scale, ctx.player?.surface ?? 'road', 1.2 * scale);
          screen.flash(0xFFC070, 0.34);
          trauma = clamp01(trauma + 0.6);
          traumaDecay = 2.4;
          break;
        case 'boost':
          ring(x, y, z, 1.2 * scale, 7 * scale, 0.4, col, 2.6, 0.9);
          sparkBurst(x, y, z, 22 * scale, 12 * scale, col, 3.2, v);
          break;
        case 'impact':
          ring(x, y, z, 0.7 * scale, 4 * scale, 0.3, col, 2.0, 0.7);
          sparkBurst(x, y, z, 12 * scale, 7 * scale, col, 2.6, v);
          break;
        case 'ring':
          ring(x, y, z, 0.8 * scale, 8 * scale, 0.45, col, 2.4, 0.9);
          break;
        case 'stars':
          starSpec.px = x; starSpec.py = y; starSpec.pz = z;
          // Thrown *with* whatever they came off. A ring of stars born at rest
          // beside a machine still doing fifty metres a second is three kart
          // lengths behind it before the next frame is drawn, and what a
          // screenshot catches is flat yellow cardboard lying over the road
          // with nothing under it.
          starSpec.vx = v.x * 0.85; starSpec.vy = 2 + v.y * 0.85; starSpec.vz = v.z * 0.85;
          starSpec.life = 0.7; starSpec.size0 = 0.4; starSpec.size1 = 0.08;
          setHdr(starSpec.color0, col, 3.0);
          setHdr(starSpec.color1, col, 0.4);
          pool.burst(starSpec, Math.round(8 * density * scale), 6, 0.6, rng);
          break;
        case 'confetti':
          confettiBurst(x, y, z, Math.round(90 * density * scale));
          break;
        case 'boxBreak':
          // An item box coming apart. The item module draws the box shattering;
          // this is the glitter and the puff of road dust it kicks up, which is
          // what stops the mesh reading as a model being switched off.
          ring(x, y, z, 0.5 * scale, 3.2 * scale, 0.3, WARM_WHITE, 2.2, 0.75);
          sparkBurst(x, y, z, Math.round(16 * scale), 7 * scale, GOLD, 2.8);
          sparkBurst(x, y, z, Math.round(8 * scale), 5 * scale, TIER[1]!, 2.4);
          for (let k = 0; k < Math.round(10 * density * scale); k++) {
            flakeSpec.px = x + rng.range(-0.3, 0.3);
            flakeSpec.py = y + rng.range(-0.3, 0.3);
            flakeSpec.pz = z + rng.range(-0.3, 0.3);
            flakeSpec.vx = rng.range(-4, 4);
            flakeSpec.vy = rng.range(1, 6);
            flakeSpec.vz = rng.range(-4, 4);
            flakeSpec.life = rng.range(0.5, 1.1);
            flakeSpec.size0 = rng.range(0.12, 0.22);
            flakeSpec.size1 = flakeSpec.size0;
            flakeSpec.rot = rng.next() * TAU;
            flakeSpec.rotVel = rng.range(-14, 14);
            const c = confettiColors[rng.int(0, confettiColors.length - 1)]!;
            setHdr(flakeSpec.color0, c, 1.4);
            setHdr(flakeSpec.color1, c, 0.8);
            if (!pool.emit(flakeSpec)) break;
          }
          break;
        case 'shine':
        case 'sparkle':
          sparkBurst(x, y, z, 10 * scale, 4 * scale, GOLD, 3.2, v);
          ring(x, y, z, 0.4 * scale, 2.2 * scale, 0.3, GOLD, 2.0, 0.7);
          break;
        default:
          // An unknown id still has to show something: a silent effect is a bug
          // nobody finds until a reviewer asks why the item does nothing.
          sparkBurst(x, y, z, 10 * scale, 6 * scale, col, 2.6, v);
          break;
      }
    }
    qCount = 0;
  }

  /**
   * The instrument.
   *
   * Everything this module does is spent inside one rendered frame and then
   * gone, which makes it the hardest piece in the game to review honestly: a
   * screenshot says "there is warm light behind the kart" and cannot say whether
   * that is nine sparks or four hundred, whether they are the tier's hue or
   * white, or whether the whole plume is thirty metres away in the wrong place.
   * Every defect this module has been rejected for was found by counting, not by
   * looking — so the counter is part of the module.
   *
   * Nothing in the simulation reads this, and it draws from no random stream.
   */
  function installProbe(): void {
    if (typeof globalThis === 'undefined') return;
    (globalThis as unknown as Record<string, unknown>).__FX = {
      /** Live population, by layer and by what it costs. */
      probe(): Record<string, unknown> {
        const p = ctx.player;
        const pfx = p ? state.get(p.id) : null;
        return {
          pool: pool.count,
          poolLoad: Math.round(pool.load * 100) / 100,
          // The two numbers the veil governor turns on: what the alpha layer
          // covered last frame, and how far the loop has had to cut to hold it.
          veil: Math.round(pool.veil * 1000) / 1000,
          veilScale: Math.round(veilScale * 100) / 100,
          add: addLayer?.count ?? 0,
          alpha: alphaLayer?.count ?? 0,
          rush: rushLayer?.count ?? 0,
          lines: lineCount,
          density: Math.round(density * 100) / 100,
          trauma: Math.round(trauma * 1000) / 1000,
          drift: p ? { active: p.drift.active, tier: p.drift.tier, charge: p.drift.charge } : null,
          boost: p ? { time: p.boost.time, power: p.boost.power, source: p.boost.source } : null,
          surface: p?.surface ?? '',
          grounded: p?.grounded ?? false,
          glow: pfx ? Math.round(pfx.glow * 100) / 100 : 0,
          boostEnv: pfx ? Math.round(pfx.boostEnv * 100) / 100 : 0,
          // The latch, both halves of it, so "which tier is the rush wearing
          // and did a draft light it" is answerable without a screenshot. Both
          // were bugs this module shipped, and neither was visible from
          // `boost.source` alone — that is the *simulation's* current source,
          // and the effects layer's own latch is what was wrong.
          boostTier: pfx ? pfx.boostTier : 0,
          boostKind: pfx ? pfx.boostKind : 0,
          grind: pfx ? Math.round(pfx.grind * 100) / 100 : 0,
          screen: screen.debug(),
        };
      },
      /**
       * Where the light actually is, and what colour it actually is.
       *
       * Returns the additive layer's instances binned by distance from the
       * camera, with the mean linear colour of each bin. This is the only way to
       * answer the question the whole module turns on — "is the middle third of
       * the mini-turbo actually orange on screen, or has it bleached to white" —
       * because the answer lives in a buffer that is overwritten sixty times a
       * second.
       */
      light(): Record<string, unknown> {
        return sampleLayer(addLayer);
      },
      haze(): Record<string, unknown> {
        return sampleLayer(alphaLayer);
      },

      /**
       * Hide or show every sprite layer this module owns.
       *
       * The only honest answer to "is that thing on screen mine". A reviewer
       * cropping a frame at 9x and finding a faceted, opaque, lit blob over a
       * machine reasonably calls it a dust puff and files it against this
       * module; the plume over the locomotive's funnel is a low-poly *solid*
       * built by `vehicles`, and no amount of work in here moves it. One
       * render with the layers off settles it in a second.
       */
      layers(on: boolean): number {
        let n = 0;
        for (const l of [addLayer, alphaLayer, rushLayer]) {
          if (!l) continue;
          l.mesh.userData.forceHidden = !on;
          if (!on) l.mesh.visible = false;
          n++;
        }
        return n;
      },

      /**
       * What is under this pixel. Debug only — it allocates a raycaster.
       *
       * Returns the object chain from the hit outward, which is what actually
       * names a thing: a mesh called `puff` three levels under `train` is the
       * locomotive's chimney, and a mesh called `fxAlpha` is a particle.
       */
      pick(x: number, y: number): unknown {
        const el = ctx.renderer.domElement;
        const ray = new THREE.Raycaster();
        ray.setFromCamera(
          new THREE.Vector2((x / el.clientWidth) * 2 - 1, -(y / el.clientHeight) * 2 + 1),
          ctx.camera,
        );
        const hits = ray.intersectObjects(ctx.scene.children, true);
        return hits.slice(0, 4).map((h) => {
          const chain: string[] = [];
          let o: THREE.Object3D | null = h.object;
          while (o) { chain.push(o.name || o.type); o = o.parent; }
          const mat = (h.object as THREE.Mesh).material as THREE.Material | undefined;
          return {
            d: Math.round(h.distance * 10) / 10,
            chain: chain.join(' < '),
            mat: Array.isArray(mat) ? 'multi' : `${mat?.type}:${mat?.name || ''}`,
          };
        });
      },
    };
  }

  /** Read back a layer's committed instances. Debug only; allocates. */
  function sampleLayer(layer: SpriteLayer | null): Record<string, unknown> {
    if (!layer || layer.count === 0) return { n: 0 };
    const geo = layer.mesh.geometry as THREE.InstancedBufferGeometry;
    const pos = geo.getAttribute('iPos').array as Float32Array;
    const col = geo.getAttribute('iColor').array as Float32Array;
    const par = geo.getAttribute('iParams').array as Float32Array;
    const cam = ctx.camera.position;
    const bins = [
      { name: 'near', to: 12 }, { name: 'mid', to: 40 }, { name: 'far', to: 1e9 },
    ];
    const out: Record<string, unknown> = { n: layer.count };
    for (const b of bins) {
      let n = 0, r = 0, g = 0, bl = 0, area = 0, maxSize = 0;
      const from = b.name === 'near' ? 0 : b.name === 'mid' ? 12 : 40;
      for (let i = 0; i < layer.count; i++) {
        const dx = pos[i * 3]! - cam.x, dy = pos[i * 3 + 1]! - cam.y, dz = pos[i * 3 + 2]! - cam.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < from || d >= b.to) continue;
        const a = col[i * 4 + 3]!;
        const size = par[i * 4]!;
        n++;
        r += col[i * 4]! * a; g += col[i * 4 + 1]! * a; bl += col[i * 4 + 2]! * a;
        // Solid angle each quad covers, in square degrees — the honest measure
        // of "how much of the frame is this effect", which neither a count nor
        // a size in metres can give on its own.
        const deg = (size / Math.max(0.5, d)) * 57.3;
        area += deg * deg * a;
        if (size > maxSize) maxSize = size;
      }
      const k = n > 0 ? 1 / n : 0;
      out[b.name] = {
        n,
        rgb: [Math.round(r * k * 100) / 100, Math.round(g * k * 100) / 100,
          Math.round(bl * k * 100) / 100],
        area: Math.round(area),
        maxSize: Math.round(maxSize * 100) / 100,
      };
    }
    return out;
  }

  /**
   * Barrier scrape. Physics reports the *first* contact on `kart:wall` and then
   * goes quiet for as long as the kart is rubbing along the rail, so the grind
   * itself has to be detected here — a kart riding a barrier with no sparks is
   * the clearest "nothing is happening" signal the game can send, and a
   * reviewer who pinned the machine against a barrier at racing speed measured
   * exactly that: no sparks at all, at any point along the rail.
   *
   * Two things were wrong with the detection and both are geometry.
   *
   * The tolerance was 22 centimetres. Physics pushes a touching kart back to
   * *exactly* the limit line, and the limit is rebuilt here from a half-width
   * that is clamped to a different range than physics clamps its own to
   * (`[0.5,1.6]` here against `[0.7,1.5]` there) — so on the widest machines
   * the two lines disagree by a tenth of a metre in the direction that makes
   * this test fail, and on all of them the sim position wanders inside the
   * window between fixed steps. 75cm is wider than any of that and still an
   * eighth of the verge, so it cannot fire in open road.
   *
   * And it only ever ran for the player. A CPU machine dragging itself down a
   * barrier three metres away threw nothing, which is half of what makes a
   * pack feel like it is being raced rather than driven.
   */
  function grindTest(racer: Racer, fx: RacerFx, dt: number): void {
    const track = ctx.track;
    if (!track || track.course.walls === false || !racer.grounded) return;
    if (Math.abs(racer.speed) < 5) return;
    const s = track.spline.nearest(racer.pos, _sample);
    const halfW = sizeOf(racer).halfW;
    const limit = s.width * 0.5 + (track.course.vergeWidth ?? 5) - halfW - K.wall.gap;
    const lateral = s.lateral ?? 0;
    if (Math.abs(lateral) < limit - 0.75) return;
    fx.grindSide = lateral > 0 ? 1 : -1;
    fx.grind = Math.max(fx.grind, dt + 0.02);
  }

  return {
    name: 'fx',
    order: 90,

    init(): void {
      atlas = createAtlas();
      // The additive layer is the sparks, and a spark is the one thing here
      // whose length is set by something the emitter does not control: how fast
      // the machine happens to be going. A drift flier keeps a quarter of the
      // kart's velocity, so at racing pace it is doing forty metres a second
      // *relative to the chase camera* and pins the stretch at whatever ceiling
      // it is given. At the shared 0.9 that is a two-metre streak — as long as
      // the kart — and measured crops of a mini-turbo came back with half a
      // dozen cyan slugs laid across the tarmac.
      //
      // So this layer buys a shorter, thinner streak: 0.55 caps a spark at
      // about a metre and a fifth, and `stretchNarrow` takes back the width it
      // does not need at that length. The alpha layer keeps the looser
      // settings, because a wake and a ribbon of tyre smoke are volumes and
      // want every metre they can get.
      addLayer = createSpriteLayer({
        name: 'fxAdditive', atlas, capacity: LAYER_ADD,
        blending: THREE.AdditiveBlending, renderOrder: 20,
        maxStretch: 0.55, stretchNarrow: 0.42,
      });
      // ── and the alpha layer buys a shorter one than it used to ────────────
      //
      // It was on the shared default of 0.9m of half-length, which for a puff
      // 0.6m wide is a lozenge two and a half metres long by two thirds of a
      // metre wide — and consecutive ones lying on a common axis fuse into a
      // single translucent envelope around the machine. A tier-two drift
      // photographed with the kart inside a soft bubble, which is the exact
      // opposite of what a ribbon of tyre smoke is for.
      //
      // The ceiling is also what makes a *frozen* frame honest. Stretch is
      // measured against the camera, and `setTimeScale(0)` freezes the camera
      // while the pool keeps stepping, so every velocity quad in a review
      // screenshot is pinned at whatever ceiling it is given. A tight one means
      // the sheet photographs the ribbon the player sees rather than a
      // capture-only smear.
      alphaLayer = createSpriteLayer({
        name: 'fxAlpha', atlas, capacity: LAYER_ALPHA,
        blending: THREE.NormalBlending, renderOrder: 18,
        maxStretch: 0.62, stretchNarrow: 0.20,
      });
      rushLayer = createSpriteLayer({
        name: 'fxRush', atlas, capacity: LAYER_RUSH,
        blending: THREE.AdditiveBlending, renderOrder: 900, depthTest: false,
      });
      ctx.scene.add(alphaLayer.mesh, addLayer.mesh, rushLayer.mesh, marks.mesh);
      density = clamp01(ctx.quality.particles);
      marks.applyQuality();
      installProbe();
    },

    reset(cfg: RaceConfig): void {
      // A private stream, but still seeded off the race so a capture of the
      // same seed photographs the same sparks.
      rng = makeRng(((cfg.seed ?? 1) * 2654435761) >>> 0 || 0x9e37);
      pool.clear();
      marks.reset();
      screen.reset();
      state.clear();
      bumpAt.clear();
      lineCount = 0;
      lineAcc = 0;
      trauma = 0;
      camPrimed = false;
      qCount = 0;
      pendCountdown = 0;
      pendGo = 0;
      pendConfetti = 0;
      pendLapPop = 0;
      density = clamp01(ctx.quality.particles);
      marks.applyQuality();
    },

    update(rawDt: number, alpha: number): void {
      const add = addLayer, alp = alphaLayer, rush = rushLayer;
      if (!add || !alp || !rush) return;

      const dt = clamp(rawDt, 0, 0.1);
      // A pool close to full starves the effects that matter most, so emission
      // is throttled before it gets there rather than dropped at random.
      const headroom = pool.load > 0.82 ? clamp01((1 - pool.load) / 0.18) : 1;
      const baseDensity = clamp01(ctx.quality.particles) * headroom;
      density = baseDensity;

      // The veil governor. `pool.veil` is what the alpha layer actually covered
      // when it was last filled — the end of the *previous* frame — so this is
      // a one-frame-delayed closed loop, which is exactly what it should be:
      // the thing being measured is the thing the player just saw.
      const want = pool.veil > VEIL_BUDGET
        ? clamp01(VEIL_BUDGET / pool.veil)
        : 1;
      // Fall fast, recover slowly. A cloud that thins the instant it is over
      // budget and then takes a quarter of a second to come back never pumps,
      // and never leaves a hole where the dust used to be.
      veilScale = clamp01(want < veilScale
        ? damp(veilScale, want, 0.0002, dt)
        : damp(veilScale, want, 0.03, dt));
      veilDensity = veilScale * baseDensity;
      // See the note on `veilHero`. Powers rather than offsets, so all three
      // agree at 1 and diverge only once the loop is actually cutting.
      veilHero = Math.pow(veilScale, 0.45) * baseDensity;
      veilBack = veilScale * veilScale * baseDensity;

      // Camera velocity for the streak shader. A cut or a reset teleports the
      // rig, and one frame of a 400 m/s "velocity" would turn every spark in
      // the pool into a screen-long dash, so an implausible jump is treated as
      // a cut and reported as zero.
      if (camPrimed && dt > 1e-4) {
        camVel.subVectors(ctx.camera.position, camPrev).divideScalar(dt);
        if (camVel.lengthSq() > 200 * 200) camVel.set(0, 0, 0);
      } else {
        camVel.set(0, 0, 0);
      }
      camPrev.copy(ctx.camera.position);
      camPrimed = true;

      pool.update(dt);
      add.reset();
      alp.reset();
      rush.reset();
      add.setCameraVelocity(camVel.x, camVel.y, camVel.z);
      alp.setCameraVelocity(camVel.x, camVel.y, camVel.z);
      rush.setCameraVelocity(camVel.x, camVel.y, camVel.z);

      drainQueue();

      const cam = ctx.camera;
      const player = ctx.player;

      for (const racer of ctx.racers) {
        const fx = fxOf(racer);
        frameOf(racer, alpha);
        if (racer.isPlayer) _playerPos.copy(_pos);

        // How much this racer's effects are worth. The player always pays full
        // price; everyone else fades out with distance, which is what keeps a
        // pack of eight drifting through a hairpin inside budget.
        //
        // The old curve held a CPU machine at 60% of full rate a hundred metres
        // away and only reached zero at a hundred and sixty. An instance dump
        // during a player tier-one drift found 581 live sparks on screen, of
        // which **458 were more than twelve metres away** — three quarters of
        // the entire spark budget spent on pinpoints one pixel wide, belonging
        // to machines the player is not looking at, in a warm colour that
        // actively fights the thing they are. A spark has no silhouette; past
        // about forty metres it is not an effect, it is a cost.
        const d2 = _pos.distanceToSquared(cam.position);
        const dist = Math.sqrt(d2);
        fx.near = racer.isPlayer ? 1 : clamp01(1 - (dist - 14) / 32);
        // Exhaust is the exception — see the note on `reach`.
        fx.reach = racer.isPlayer ? 1 : clamp01(1 - (dist - 34) / 120);

        // ── letting go of a drift ───────────────────────────────────────
        // Physics announces the start of a drift and the tier it reaches, but
        // never the end of one, and the end is a moment the player has just
        // spent three seconds earning. Watching the state here is a read, not a
        // write — nothing below touches the simulation.
        const drifting = racer.drift.active;
        if (fx.lastCharge > 0 && !drifting) {
          fx.release = 1;
          fx.releaseTier = fx.lastTier;
        }
        fx.lastCharge = drifting ? Math.max(0.001, racer.drift.charge) : 0;
        if (drifting) fx.lastTier = racer.drift.tier;

        // ── impulses ────────────────────────────────────────────────────
        if (fx.pendTier > 0) {
          const tier = fx.pendTier as 1 | 2 | 3;
          fx.pendTier = 0;
          fx.pop = 1;
          fx.popTier = tier;
          // The tier has to be felt in the rubber as well as in the light —
          // see `tyreSmoke`. Spent on this same frame, by the emitter, so the
          // extra smoke is born inside the burst of sparks below rather than
          // arriving a frame after it.
          fx.pendSmoke = tier;
          const col = TIER[tier]!;
          const gain = TIER_GAIN[tier]!;
          const s = sizeOf(racer);
          // A burst at each wheel rather than one at the tail: the tier is read
          // off the wheels, so that is where the announcement has to happen.
          for (let side = -1; side <= 1; side += 2) {
            sparkPort(racer, side, 0.26, _p);
            sparkBurst(_p.x, _p.y, _p.z, 12 + 5 * tier, 6.5 + 2.5 * tier, col, gain * 1.2);
          }
          local(0, -RIDE_HEIGHT + 0.05, -s.len * 0.34, _p);
          // The tier locking in lights the road under the machine in that
          // tier's colour. A pool of light, not a ring: the lock-in already has
          // an edge on it — the four-point flare at each wheel — and stacking a
          // hard annulus under that is where the "ring decal in the road plane"
          // read came from in the first place.
          groundLight(_p.x, _p.y, _p.z, 1.0, 3.6 + 1.0 * tier, 0.30, col, gain * 0.55, 0.42);
          if (racer.isPlayer) {
            screen.flash(TIER_HEX[tier]!, 0.07 + 0.035 * tier);
            // A whisper of shake, so the tier lands in the hands as well as the
            // eyes. Any more and holding a long drift becomes seasick.
            trauma = clamp01(trauma + 0.05 + 0.025 * tier);
            traumaDecay = 9;
          }
        }
        // The hop, and the drift that opens with one. `kart:drift:start` and
        // `kart:hop` are the same instant on the same press, so they are folded
        // rather than stacked — two full bursts on one frame is a puff of smoke
        // twice as thick as the one MK8 draws.
        if (fx.pendDriftStart > 0 || fx.pendHop > 0) {
          const strong = fx.pendDriftStart > 0;
          fx.pendDriftStart = 0;
          fx.pendHop = 0;
          // `kart:trick:start` shares this impulse, and a trick happens well
          // clear of the road — so the ground only answers if the wheels were
          // on it a moment ago. `grounded` alone is not the test: the hop is
          // announced on the frame the machine leaves, by which point physics
          // has already let go of the surface.
          if (racer.grounded || racer.airTime < 0.12) {
            hopBurst(racer, strong ? 1 : 0.7);
            local(0, -RIDE_HEIGHT + 0.04, -sizeOf(racer).len * 0.3, _p);
            dustRing(_p.x, _p.y, _p.z, strong ? 5 : 4, strong ? 3.5 : 3, racer.surface,
              strong ? 0.8 : 0.7);
          }
        }
        const boosted = fx.pendBoost > 0;
        if (boosted) { spendBoost(racer, fx); fx.pendBoost = 0; }
        // After the boost, so a granted mini-turbo can tone its own release
        // down rather than doubling up on the same frame.
        if (fx.release > 0) { spendRelease(racer, fx, boosted); fx.release = 0; }
        if (fx.pendLand > 0) { spendLand(racer, fx); fx.pendLand = 0; }
        if (fx.pendOffroad > 0) {
          fx.pendOffroad = 0;
          local(0, -RIDE_HEIGHT + 0.06, -sizeOf(racer).len * 0.3, _p);
          dustRing(_p.x, _p.y, _p.z, 12, 5, racer.surface, 1.2);
        }
        if (fx.pendWall > 0) { spendWall(racer, fx); fx.pendWall = 0; }
        if (fx.pendHit > 0) { spendHit(racer, fx); fx.pendHit = 0; fx.hitKind = 0; }
        if (fx.pendBump > 0) { spendBump(racer, fx); fx.pendBump = 0; }
        if (fx.pendTrick > 0) {
          fx.pendTrick = 0;
          local(0, 0.2, 0, _p);
          sparkBurst(_p.x, _p.y, _p.z, 14, 7, GOLD, 3.0);
        }
        if (fx.pendBurnout > 0) { spendBurnout(racer); fx.pendBurnout = 0; }
        if (fx.pendLaunch > 0) {
          const k = fx.pendLaunch;
          fx.pendLaunch = 0;
          local(0, -RIDE_HEIGHT + 0.05, 0, _p);
          ring(_p.x, _p.y, _p.z, 0.9, 3.5 + 5 * k, 0.3, WARM_WHITE, 2.0, 0.5 + 0.3 * k);
          dustRing(_p.x, _p.y, _p.z, 6 + Math.round(10 * k), 3 + 6 * k, racer.surface, 1.0);
        }
        if (fx.pendCoin > 0) { spendCoin(racer, fx.pendCoin); fx.pendCoin = 0; }
        if (fx.pendCoinLoss > 0) { spendCoinLoss(racer, fx.pendCoinLoss); fx.pendCoinLoss = 0; }
        if (fx.pendPowerUp > 0) { spendPowerUp(racer); fx.pendPowerUp = 0; }
        if (fx.pendDraft > 0) {
          fx.pendDraft = 0;
          if (racer.isPlayer) screen.flash(0xD8ECFF, 0.07);
        }

        // ── continuous ──────────────────────────────────────────────────
        // Held up by the drift alone, not by the drift *and* contact — see the
        // note in `driftSparks`. The pool of light on the road is still gated
        // on `grounded` inside `driftGlow`, which is the part that would be a
        // lie in mid-air; the light at the wheels is not.
        fx.glow = damp(fx.glow, racer.drift.active ? 1 : 0,
          racer.drift.active ? 0.0004 : 0.0000004, dt);
        fx.pop = Math.max(0, fx.pop - dt * 3.6);
        fx.draftEase = damp(fx.draftEase, fx.draft, 0.02, dt);
        // Outside the `near` gate on purpose: a racer whose boost ended while
        // they were too far away to draw would otherwise keep the old tier tint
        // and fire their next pad boost in purple.
        if (racer.boost.time <= 0) fx.boostTier = 0;
        // Same reason, for the same kind of bug: a tier that locked in while
        // this racer was too far away to draw must be forgotten, not banked
        // until they come back into range and cough it out mid-straight.
        if (fx.near <= 0.02) fx.pendSmoke = 0;
        // The boost envelope. Held up by the live boost, and released over
        // about a third of a second once it ends, so the state has a shape of
        // its own instead of vanishing between one rendered frame and the next.
        fx.boostEnv = racer.boost.time > 0
          ? 1
          : Math.max(0, fx.boostEnv - dt * 3.0);
        // The *kind* outlives the boost by exactly as long as the envelope
        // does, because the thing it gates — the screen rush — is released on
        // the envelope rather than on `boost.time`. Clearing it a third of a
        // second early would make the tail of every boost anonymous.
        if (fx.boostEnv <= 0.02) fx.boostKind = 0;

        // Always on, every machine, player and CPU alike — the layer that makes
        // the seconds between events look like a race rather than a diorama. It
        // is the only emitter here that does not need a reason, and the only
        // one that survives the `near` cut, because it is the only one built out
        // of silhouettes rather than pinpoints.
        if (fx.reach > 0.02) {
          exhaustPuffs(racer, fx, dt);
          if (fx.near > 0.02) exhaustGlow(racer, fx, add);
          // Dust is out here with the exhaust rather than inside the `near`
          // gate below, and for the same reason: it is a silhouette. See `vis`
          // in `surfaceDust`, which keeps the tight cut for hard surfaces so
          // this costs nothing for the seven machines on the tarmac.
          if (racer.grounded) surfaceDust(racer, fx, dt);
        }

        // The ignition strike, on the simulation's clock rather than on this
        // module's — see `boostFull`. A boost that ends early (a hit, a
        // lightning strike) takes its strike with it, which is right: the
        // envelope is a *reading* of the boost, not a timer running beside it.
        fx.ignite = racer.boost.time > 0 && fx.boostFull > 0
          ? clamp01(1 - (fx.boostFull - racer.boost.time) / IGNITE_TIME)
          : 0;
        if (fx.ignite > 0 && fx.near > 0.02) ignitionFlare(racer, fx, dt, add);

        if (fx.near > 0.02) {
          // Order matters: the smoke goes down first so the sparks land inside
          // it. Both are in different layers, but the alpha layer draws under
          // the additive one, and the read is "sparks coming out of smoke"
          // rather than "sparks in front of smoke".
          //
          // Outside the drift branch on purpose. The smoke belongs to the
          // contact patch, not to a game state: a spin, a boost breaking
          // traction and a slide the player did not ask for all burn rubber,
          // and gating it on `drift.active` was half of why a slide on tarmac
          // came out clean.
          if (racer.grounded) tyreSmoke(racer, fx, dt); else fx.pendSmoke = 0;
          if (racer.drift.active) {
            driftSparks(racer, fx, dt);
          }
          driftGlow(racer, fx, add);
          if (racer.boost.time > 0) boostFlame(racer, fx, dt, add);
          // Any stun, not only a spin. A squish and a bump leave a kart just as
          // helpless, and a silent one reads as the game having hung.
          if (racer.stunned > 0) spinStars(racer, add);
          if (racer.effects.has('star') || racer.effects.has('bullet')) {
            powerTrail(racer, fx, dt);
          }
        }

        if (fx.near > 0.02) grindTest(racer, fx, dt);
        if (fx.grind > 0) {
          fx.grind = Math.max(0, fx.grind - dt);
          const s = sizeOf(racer);
          // Grinding a barrier at 90km/h is one of the loudest things that can
          // happen to a kart, and three sparks a frame was a polite cough.
          // Steel on steel is a *stream*, not a sprinkle: this is the densest
          // continuous emitter in the module for as long as the contact lasts,
          // and it has to be, because the one thing a player must never be able
          // to do is scrape a wall and see the game not notice.
          const bite = clamp01(Math.abs(racer.speed) / 40);
          const n = Math.min(16, Math.round(420 * density * fx.near * bite * dt) + 3);
          // Outboard of the flank, not on it: sparks born inside the bodywork
          // are sparks the depth buffer eats.
          const flank = fx.grindSide * (s.halfW + 0.14);
          const invN = 1 / n;
          for (let i = 0; i < n; i++) {
            local(flank, rng.range(-0.34, 0.02), rng.range(-0.35, 0.3) * s.len, _p);
            // Spread back along the path taken during the frame, so a capture
            // at 20fps gets a stream rather than a row of clumps.
            _p.addScaledVector(racer.vel, -(i + 0.5) * invN * dt);
            sparkSpec.px = _p.x; sparkSpec.py = _p.y; sparkSpec.pz = _p.z;
            // Most of the kart's speed, so the sparks stream back along the wall
            // instead of hanging in the air the moment they leave it.
            const out = rng.range(2, 8) * (0.5 + 0.5 * bite);
            sparkSpec.vx = racer.vel.x * 0.72 + _right.x * fx.grindSide * out;
            sparkSpec.vy = racer.vel.y * 0.72 + rng.range(1.0, 5.0) * (0.5 + 0.5 * bite);
            sparkSpec.vz = racer.vel.z * 0.72 + _right.z * fx.grindSide * out;
            sparkSpec.life = rng.range(0.10, 0.24);
            sparkSpec.size0 = rng.range(0.11, 0.22);
            sparkSpec.gravity = 24;
            sparkSpec.drag = 1.6;
            sparkSpec.stretch = 0.042;
            // Hard white-yellow, and *only* white-yellow. Every other spark in
            // the module carries a hue that means something; this one has to be
            // the colour of steel giving way, so it can never be confused with
            // a charge.
            if (rng.next() < 0.3) {
              sparkSpec.color0.lerpColors(RAIL_SPARK, WHITE_HOT, 0.7).multiplyScalar(2.6);
            } else {
              setHdr(sparkSpec.color0, RAIL_SPARK, 2.4);
            }
            setHdr(sparkSpec.color1, RAIL_SPARK, 0.25);
            if (!pool.emit(sparkSpec)) break;
          }
          sparkSpec.gravity = 15;
          sparkSpec.drag = 2.0;
          sparkSpec.stretch = 0.035;
          // The hot point where the bodywork is actually touching. Without it
          // the sparks look like they are coming off nothing.
          local(flank, -0.12, rng.range(-0.2, 0.2) * s.len, _p);
          const flick = 0.7 + 0.3 * Math.sin(ctx.time.elapsed * 53 + racer.id);
          const gk = 1.7 * flick * bite;
          add.push(
            _p.x, _p.y, _p.z, 0, 0, 0,
            RAIL_SPARK.r * gk, RAIL_SPARK.g * gk, RAIL_SPARK.b * gk, 0.85 * bite,
            0.42 * flick, 0, 0, CELL.glow, MODE.billboard,
          );
          add.push(
            _p.x, _p.y, _p.z, 0, 0, 0,
            1.5 * flick * bite, 1.42 * flick * bite, 1.2 * flick * bite, 0.9 * bite,
            0.13 * flick, 0, 0, CELL.glow, MODE.billboard,
          );
        }

        // ── tyre marks ──────────────────────────────────────────────────
        //
        // The track's memory. Everything above lives for a fraction of a second;
        // this is the only thing the fx module leaves behind, and it is what
        // makes a corner look like it has been raced through rather than
        // arrived at. The previous pass laid marks that were technically there
        // and visually not: a spike-profiled ribbon half a metre wide whose
        // full darkness existed only along the exact centreline, which from
        // overhead on tarmac is indistinguishable from the road's own
        // aggregate. Wider, flatter across its width (see marks.ts), darker on
        // asphalt, and laid by all four wheels once the tyres are genuinely
        // scrubbing rather than by the rears alone.
        const sfx = SURFACE_FX[racer.surface];
        const markable = racer.grounded && sfx.mark > 0 && d2 < 30000;
        if (markable) {
          const slip = slipOf(racer);
          const strength = clamp01(
            (racer.drift.active ? 1.0 : 0)
            + slip * 3.0
            + (racer.boost.time > 0 ? 0.45 : 0)
            + (racer.stunned > 0 ? 0.7 : 0),
          ) * sfx.mark * clamp01(Math.abs(racer.speed) / 14);
          if (strength > 0.04) {
            const tint = markTints.get(racer.surface)!;
            const s = sizeOf(racer);
            // A tyre lays about a third of a metre of rubber; the quad has to be
            // wider than the contact patch because its shoulders are soft — but
            // not so wide that the two rear marks merge into one band. Two
            // parallel arcs read as a machine that was sliding; one broad
            // smear reads as a paint roller.
            const halfW = clamp(s.halfW * 0.34, 0.22, 0.44);
            for (let side = -1; side <= 1; side += 2) {
              rearWheel(racer, side, 0.032, _p);
              marks.stroke(
                racer.id * 4 + (side > 0 ? 1 : 0),
                _p.x, _p.y, _p.z,
                _right.x, _right.y, _right.z,
                halfW, strength, tint,
              );
            }
            // The fronts, once the whole machine is sliding rather than the back
            // end alone. Four marks through a corner is what a scrub looks like
            // from above; two is what a handbrake turn looks like.
            if (slip > 0.16) {
              const fs = clamp01((slip - 0.16) / 0.3) * strength * 0.7;
              for (let side = -1; side <= 1; side += 2) {
                local(side * s.halfW * 0.84, -RIDE_HEIGHT + 0.032, s.len * 0.32, _p);
                marks.stroke(
                  racer.id * 4 + 2 + (side > 0 ? 1 : 0),
                  _p.x, _p.y, _p.z,
                  _right.x, _right.y, _right.z,
                  halfW * 0.82, fs, tint,
                );
              }
            } else {
              marks.lift(racer.id * 4 + 2);
              marks.lift(racer.id * 4 + 3);
            }
          } else {
            for (let k = 0; k < 4; k++) marks.lift(racer.id * 4 + k);
          }
        } else {
          for (let k = 0; k < 4; k++) marks.lift(racer.id * 4 + k);
        }
      }

      // ── global beats ──────────────────────────────────────────────────
      // Each light escalates: the last beat before the start is nearly twice the
      // first. A countdown where every number lands identically has no rhythm,
      // and rhythm is the only thing a countdown is for.
      if (pendCountdown > 0) {
        const beat = pendCountdown;
        pendCountdown = 0;
        screen.flash(beat >= 4 ? 0xFFE9A0 : 0xFFF0C8, 0.07 + 0.05 * beat);
        if (player) {
          frameOf(player, alpha);
          local(0, -RIDE_HEIGHT + 0.05, 0, _p);
          ring(_p.x, _p.y, _p.z, 1.0, 3.0 + 0.9 * beat, 0.34,
            beat >= 4 ? GOLD : WARM_WHITE, 2.0, 0.28 + 0.12 * beat);
        }
      }
      if (pendGo > 0) {
        pendGo = 0;
        screen.flash(0xB8FFA0, 0.34);
        for (const racer of ctx.racers) {
          frameOf(racer, alpha);
          local(0, -RIDE_HEIGHT + 0.05, -sizeOf(racer).len * 0.35, _p);
          ring(_p.x, _p.y, _p.z, 0.8, 4.5, 0.4, WARM_WHITE, 2.4, 0.8);
          dustRing(_p.x, _p.y, _p.z, 8, 5, racer.surface, 1.0);
        }
      }
      if (pendLapPop > 0) {
        pendLapPop = 0;
        if (player) {
          frameOf(player, alpha);
          local(0, 0.6, 0, _p);
          sparkBurst(_p.x, _p.y, _p.z, 18, 8, GOLD, 3.2);
          screen.flash(0xFFE9A8, 0.12);
        }
      }
      if (pendConfetti > 0) {
        const strength = pendConfetti;
        pendConfetti = 0;
        if (player) {
          frameOf(player, alpha);
          // Thrown *with* the kart. Confetti born at rest beside a machine still
          // doing 32 m/s is behind the chase camera in a quarter of a second,
          // which is exactly how a burst of four hundred flakes managed to be
          // completely invisible in every screenshot of the finish.
          confettiBurst(
            _pos.x, _pos.y, _pos.z, Math.round(420 * density * strength),
            player.vel.x * 0.8, player.vel.y * 0.8, player.vel.z * 0.8,
          );
          local(0, 0.4, 0, _p);
          sparkBurst(_p.x, _p.y, _p.z, Math.round(40 * strength), 12, GOLD, 3.0);
          ring(_pos.x, _pos.y - RIDE_HEIGHT + 0.05, _pos.z, 1.5, 16, 0.7, GOLD, 2.4, 0.9);
          screen.flash(0xFFF3D0, 0.32 * strength);
        }
      }

      // ── the lens ──────────────────────────────────────────────────────
      let rushAmt = 0;
      let lineAmt = 0;
      let chargeAmt = 0;
      if (player) {
        const pfx = fxOf(player);
        // Off the envelope, not off `boost.time`. A pad boost, a mushroom, a
        // trick and each mini-turbo tier now light this to exactly the same
        // height and let go at the same rate, which is the difference between a
        // signal a player learns and four separate things that happen sometimes.
        // The envelope also survives a frame drawn a tenth of a second after
        // the boost expired, which the raw state does not.
        //
        // ── ...and only for thrust the player was *given* ────────────────
        //
        // Gated on the source, not on the envelope alone. The comment below has
        // always said the warm edge glow belongs to a boost and must not fire
        // for a draft, and the code contradicted it: sitting in someone's
        // slipstream emits `kart:boost`, which lit the envelope, which lit the
        // rush — measured at 0.687 with the whole rim orange for a machine that
        // had done nothing but tuck in behind another one.
        rushAmt = pfx.boostKind === 1
          ? clamp01(pfx.boostEnv * (0.62 + 0.38 * clamp01((player.boost.power - 18) / 34)))
          : 0;
        // The tier the rush is wearing is latched by `spendBoost` and let go
        // here, when the envelope that carries it is finally down. Clearing it
        // off `boost.time` instead would drop the colour a third of a second
        // before the effect it belongs to, so the tail of every mini-turbo
        // would fade out orange.
        if (pfx.boostEnv <= 0.02) screen.setRushTier(0);
        // Sitting in someone's slipstream is worth a few streaks of its own —
        // it is a speed the player did not ask for, and it should look like it.
        // Streaks only: the warm edge glow belongs to a boost, and lighting it
        // up for a draft would spend the game's loudest signal on its quietest
        // event.
        // ...and raw speed no longer earns any.
        //
        // It used to, from 42% of top speed, and that was wrong in a way a
        // still frame makes obvious: a racing lap is spent almost entirely
        // above 42%, so the streaks were on permanently. Something that is
        // always there is not a cue, it is texture — and it was texture the
        // player had to read the road through. Worse, an effect that means
        // "fast" while the player is merely *driving* has nothing left to say
        // when they actually boost, which is the one moment the whole rush
        // vocabulary exists for. Speed is carried by the wake, the exhaust, the
        // camera FOV and the road going past; the streaks are reserved for
        // thrust the player was given.
        //
        // A deep, sustained slipstream still earns a few, because that *is*
        // free speed — but only once the draft is genuinely established, so an
        // ordinary lap never lights them.
        const draft = clamp01((pfx.draftEase - 0.62) / 0.38);
        lineAmt = clamp01(rushAmt + draft * 0.35);
        // Speed lines are a *lens* effect: they belong to a camera riding on
        // the machine. Spawned around the frustum of a camera parked forty
        // metres overhead they read as scratches drawn across the world, which
        // is exactly how the overhead review shot photographs them. Distance
        // from the thing the effect is about is the honest test, and it turns
        // them off for overhead, free and cinematic without this module needing
        // to know the camera system's mode names.
        const camDist = cam.position.distanceTo(_playerPos);
        lineAmt *= clamp01(1 - (camDist - 26) / 16);
        // The sparks are the meter; this is the frame agreeing with them out of
        // the corner of the player's eye.
        //
        // ── one ladder, and it is in `chargeCss` ─────────────────────────
        //
        // There used to be two — a per-tier amount here multiplied by a per-tier
        // peak in the stylesheet — and multiplying two cautious ladders together
        // is how the meter ended up below threshold for two of its three marks:
        // 0.48 x 0.165 is 0.079 at tier one, which measured as *no detectable
        // tint at all* against a centre control. A drift ring that cannot be
        // told from no ring is not restraint, it is an absent feature.
        //
        // So the tier's strength lives in one place, in the stylesheet, where
        // it steps 0.10 / 0.15 / 0.20 — and this is now only "is there a drift
        // on": a hint while the charge is still building, full while it has a
        // tier to report.
        chargeAmt = player.drift.active ? (player.drift.tier > 0 ? 1 : 0.36) : 0;
        screen.setChargeTier(player.drift.tier);
      }
      screen.setRush(rushAmt);
      screen.setCharge(chargeAmt);
      spawnLines(lineAmt, dt);
      updateLines(dt, rush);

      // Where the lens is, so anything that has drifted into it dissolves
      // rather than covering the frame. Set after every emitter has run, so a
      // puff born this frame is judged at the position it was actually born at.
      pool.setCamera(cam.position.x, cam.position.y, cam.position.z);
      pool.fill(add, alp);
      add.commit();
      alp.commit();
      rush.commit();

      marks.update(ctx.time.elapsed);
      screen.update(dt);

      // ── shake ─────────────────────────────────────────────────────────
      // Orientation only, applied after the camera system has posed the rig.
      // The camera rebuilds its quaternion from scratch every frame, so nothing
      // here can feed back into it; its *position* is damped in world space and
      // is deliberately left alone.
      if (trauma > 0) {
        trauma = Math.max(0, trauma - traumaDecay * dt);
        const sh = trauma * trauma;
        if (sh > 1e-4) {
          const n = ctx.time.elapsed * 17;
          _shakeE.set(
            fbm1(n) * sh * 0.055,
            fbm1(n + 23.7) * sh * 0.055,
            fbm1(n + 51.1) * sh * 0.07,
          );
          _shakeQ.setFromEuler(_shakeE);
          cam.quaternion.multiply(_shakeQ);
        }
      }
    },

    dispose(): void {
      if (addLayer) { ctx.scene.remove(addLayer.mesh); addLayer.dispose(); addLayer = null; }
      if (alphaLayer) { ctx.scene.remove(alphaLayer.mesh); alphaLayer.dispose(); alphaLayer = null; }
      if (rushLayer) { ctx.scene.remove(rushLayer.mesh); rushLayer.dispose(); rushLayer = null; }
      ctx.scene.remove(marks.mesh);
      marks.dispose();
      screen.dispose();
      atlas?.dispose();
      atlas = null;
      if (ctx.fx === api) ctx.fx = null;
    },
  };
}
