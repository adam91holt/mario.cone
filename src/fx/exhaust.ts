// Where each machine breathes.
//
// The single largest hole in the previous pass: a whole field at 240 km/h with
// nothing attached to any of them. A racing game is read first as *motion*, and
// motion at a still frame is carried entirely by what a vehicle is continuously
// shedding — heat haze off a tailpipe, diesel off a stack, steam off a chimney.
// Take that away and a pack shot is a diorama of parked models, however fast the
// number in the corner says they are going.
//
// So every racer gets an always-on emitter, the player and the CPUs alike, and
// it is anchored to a real point on the model rather than to a generic "behind
// the kart" offset. The train's plume has to leave the chimney, not the boiler;
// the truck's has to leave the stack behind the cab. A puff that is not welded
// to a hole in the bodywork is the "detached grey blob" this module has already
// been told off for once.
//
// Coordinates are the *model's* own frame — origin on the contact patch, +Z
// forward, +Y up — because that is the frame the vehicle registry places its
// parts in, and every anchor below was read straight off the part that makes
// the hole. The fx system subtracts the ride height when it turns these into
// world points.

import type { VehicleId } from '../types.ts';

export interface ExhaustPort {
  /** Anchor in model space: origin on the contact patch, +Z forward. */
  x: number; y: number; z: number;
  /** Unit direction the gas leaves in, model space. */
  dx: number; dy: number; dz: number;

  /** Diameter of a newborn puff, metres. */
  size: number;
  /** How much it swells over its life. Steam billows; a tailpipe barely does. */
  grow: number;
  /**
   * Puffs per second at a closed throttle.
   *
   * Read together with `size` and `alpha` — the three of them are one decision,
   * and getting the *ratio* wrong is what produced both of this module's
   * previous exhaust defects. Too few and too long-lived, and the plume detaches
   * into a band of pale spheres hanging behind the machine; too few and too big,
   * and it is a stack of outlined balls over the funnel. Neither is fixed by
   * changing the quantity, because in both cases the quantity was roughly right
   * and the *granularity* was wrong.
   *
   * The rule the table now follows: a plume must have at least twenty pieces in
   * the air at once, none of them more than about half a metre across at death,
   * and no single piece opaque enough to be identified as an object. Rate times
   * life gives the first, `size` times `grow` the second, `alpha` the third.
   */
  idle: number;
  /** ...and the extra at full throttle. */
  drive: number;
  /** Metres per second the gas leaves at. */
  speed: number;
  /** Seconds a puff lasts. */
  life: number;
  /**
   * Peak opacity of one puff, before the atlas's own ceiling — about three
   * quarters — takes its cut. The read comes from having several wisps
   * overlapping, never from any one of them being solid.
   *
   * Every plume in this table has been rebuilt around one measurement: a
   * screenshot of the locomotive at racing speed came back with **four
   * separate, individually outlined translucent balls** stacked over the
   * chimney. The rate was 30 a second against a 0.6s life and a puff that grew
   * to very nearly a metre across, which is a dozen large discs in the air at
   * once — and a dozen large discs is a bag of marbles, not steam, whatever
   * opacity each of them carries.
   *
   * So every port now runs at roughly three times the rate, half the diameter
   * and a third of the opacity. That is *the same integrated density* arranged
   * as a mass rather than as a handful of objects, and the difference is
   * categorical: a mass has an outline that changes every frame, and objects
   * have outlines you can count.
   */
  alpha: number;
  /** Pale body colour, and the slightly deeper tone it settles to. */
  color: number;
  tail: number;
  /** A turbine or a jet also gets a small heat glow at the lip. */
  hot: boolean;
}

const port = (over: Partial<ExhaustPort>): ExhaustPort => ({
  x: 0, y: 0.5, z: -1,
  dx: 0, dy: 0.9, dz: -1,
  size: 0.12, grow: 3.4,
  idle: 24, drive: 48,
  speed: 3.0, life: 0.62, alpha: 0.10,
  color: 0xE9EDF4, tail: 0xC2C8D4,
  hot: false,
  ...over,
});

/**
 * Exhaust anchors per machine, read off the parts that make the hole in
 * `vehicles/registry.ts`.
 *
 * ── how loud these are, and why they went up ──────────────────────────────
 *
 * Every `alpha` here is about 45% higher than it was, because the thing this
 * table exists to prevent was still measurably happening: a review frame of
 * three machines nose-to-tail at 54 m/s came back with *no exhaust on any of
 * them*, and a chase frame on the racing line came back with no particles at
 * all. The plumes were present and they were tuned to be so polite that they
 * could not be seen — which for the one emitter that runs on every machine for
 * the whole race is the same as not existing. A still frame of this game at
 * full speed has to feel alive (ARCHITECTURE section 12) and this is the layer
 * that carries it.
 *
 * The granularity rule below is untouched: still many small wisps, still none
 * of them identifiable as an object. Only the optical depth went up.
 *
 * The rule for how loud each one is: a machine's plume should say what kind of
 * engine it has without a word of text. The cone and the sedan run small petrol
 * engines and give a thin heat wisp; the truck and the digger run diesels and
 * give a proper stack; the locomotive gives steam, which is the biggest plume
 * in the game and the only one that is genuinely white; the plane and the
 * helicopter run turbines, which give almost no smoke and a hot lip instead.
 *
 * ── and then every rate was cut to a third, and the aim brought down ────────
 *
 * The measurement that forced it: an ordinary traffic frame carried 804 live
 * alpha sprites, and this table was most of them. Eight machines at 160 puffs a
 * second each against a 0.6s life is roughly five hundred discs in the air at
 * once, which is not a plume — it is confetti, and reviewers photographed it as
 * grey lozenges floating at windscreen height. A third of the rate at half
 * again the opacity is the same optical depth in a quarter of the objects, and
 * a plume is judged on whether its outline can be counted.
 *
 * `dy` came down with it, and that is the other half. The cone was aiming its
 * gas at 1.1 up against 1.0 back — 48° above horizontal — with a rising
 * buoyancy on top and 94% of the machine's own velocity kept, so at 60 m/s the
 * plume went almost *straight up* relative to the kart and stood there: a
 * vertical grey column rising off the roof of a machine under full acceleration.
 * Nothing rises off an accelerating kart. The ports now aim mostly backwards,
 * and `exhaustPuffs` shears the rest of the climb out with speed.
 */
export const EXHAUST: Record<VehicleId, ExhaustPort[]> = {
  // Two chrome tips under the tail, at (±0.24, 0.5, -1.06). The port sits low
  // and dark, in the machine's own shadow, so the plume is aimed to *climb* out
  // of it — a wisp that stays down at axle height behind a black silhouette is
  // a wisp nobody will ever photograph. Kept small in world units for the
  // opposite reason: this port ends up three metres from the chase camera,
  // where a puff a third of a metre across covers a fifth of the frame, which
  // is how a tailpipe wisp turns into cotton wool.
  cone: [
    port({
      x: 0.24, y: 0.52, z: -1.14, dx: 0.16, dy: 0.55, dz: -1,
      size: 0.17, grow: 2.5, idle: 15, drive: 28, life: 0.48, alpha: 0.19,
    }),
    port({
      x: -0.24, y: 0.52, z: -1.14, dx: -0.16, dy: 0.55, dz: -1,
      size: 0.17, grow: 2.5, idle: 15, drive: 28, life: 0.48, alpha: 0.19,
    }),
  ],
  // One pipe under the rear valance, at (0, 0.42, -1.86).
  car: [
    port({
      x: 0.18, y: 0.44, z: -1.92, dx: 0.14, dy: 0.55, dz: -1,
      size: 0.19, grow: 2.6, idle: 16, drive: 30, life: 0.48, alpha: 0.19,
    }),
  ],
  // Diesel stack behind the cab, at (0.92, 2.95, 0.42), venting straight up.
  truck: [
    port({
      x: 0.92, y: 3.02, z: 0.42, dx: 0.04, dy: 1, dz: -0.16,
      // Diesel is *grey*, not white. A plume pushed all the way toward the key
      // light vanishes against the sky it is drawn on, which is where a stack
      // plume spends its whole life; the colour has to sit in the gap between
      // the sky above it and the tarmac below, so it reads against both. That
      // still satisfies the rule this module got wrong last round — nothing
      // airborne may be darker than the ground — with room to spare.
      size: 0.16, grow: 3.2, idle: 15, drive: 24, speed: 3.8, life: 0.52,
      alpha: 0.22, color: 0x9DA3AE, tail: 0x818794,
    }),
  ],
  // Stack on the engine deck at the back of the house, venting up.
  digger: [
    port({
      x: 0.56, y: 2.06, z: -0.34, dx: 0.02, dy: 1, dz: -0.14,
      size: 0.15, grow: 3.2, idle: 14, drive: 22, speed: 3.4, life: 0.50,
      alpha: 0.22, color: 0x9BA1AC, tail: 0x7F8591,
    }),
  ],
  // The chimney, at (0, 2.72, 1.62). Steam: white, fat, and it climbs. Kept
  // deliberately smaller at birth than the funnel is wide — the previous pass
  // put a single puff over the locomotive that was as big as its boiler and
  // hanging clear of the chimney, which reads as a boulder, not as steam.
  train: [
    port({
      x: 0, y: 2.84, z: 1.62, dx: 0, dy: 1, dz: -0.12,
      // The one plume that keeps its piece count. A chimney vents into still
      // air above the machine, so its output does not shear away down the road
      // the way a tailpipe's does — which means the granularity rule bites
      // hardest here: cut to a third, the steam collapsed into a single soft
      // ball sitting on the funnel, which is the exact defect this table was
      // rebuilt to kill. Twice the pieces at two thirds the opacity and a
      // smaller birth diameter is the same column made of things you cannot
      // count.
      size: 0.13, grow: 3.2, idle: 24, drive: 34, speed: 5.0, life: 0.58,
      alpha: 0.20, color: 0xFDFEFF, tail: 0xC9D2DE,
    }),
  ],
  // Exhaust stubs either side of the cowl, blowing back along the fuselage.
  plane: [
    port({
      x: 0.34, y: 0.86, z: 0.86, dx: 0.2, dy: 0.3, dz: -1,
      size: 0.11, grow: 2.8, idle: 15, drive: 29, speed: 5.0, life: 0.50,
      alpha: 0.19, color: 0xDCE3EF, tail: 0xB4BDCC, hot: true,
    }),
    port({
      x: -0.34, y: 0.86, z: 0.86, dx: -0.2, dy: 0.3, dz: -1,
      size: 0.11, grow: 2.8, idle: 15, drive: 29, speed: 5.0, life: 0.50,
      alpha: 0.19, color: 0xDCE3EF, tail: 0xB4BDCC, hot: true,
    }),
  ],
  // Turbine exhaust on the engine deck under the mast, blowing down the boom.
  helicopter: [
    port({
      x: 0.28, y: 1.76, z: -0.72, dx: 0.24, dy: 0.25, dz: -1,
      size: 0.13, grow: 3.0, idle: 16, drive: 31, speed: 6.0, life: 0.54,
      alpha: 0.19, color: 0xDEE5F1, tail: 0xB6BFCE, hot: true,
    }),
  ],
};

/** Fallback for an id the table has never heard of. */
export const DEFAULT_PORT: ExhaustPort[] = [port({})];

export function portsFor(id: VehicleId): ExhaustPort[] {
  return EXHAUST[id] ?? DEFAULT_PORT;
}
