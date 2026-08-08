// Where each machine breathes.
//
// The single largest hole in the previous pass: eight machines at 240 km/h with
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
  /** Puffs per second at a closed throttle. */
  idle: number;
  /** ...and the extra at full throttle. */
  drive: number;
  /** Metres per second the gas leaves at. */
  speed: number;
  /** Seconds a puff lasts. */
  life: number;
  /**
   * Peak opacity of one puff, before the atlas's own ceiling — about two
   * thirds — takes its cut. The read comes from having several wisps
   * overlapping, never from any one of them being solid.
   *
   * These are all about a third of what they were, and they had to be: the
   * puff cell was rebuilt (see `atlas.ts`) from a hollow ring peaking at 0.20
   * into a solid-centred cloud peaking at 0.66. Left alone, the locomotive's
   * steam would have gone from a wisp to a wall of cotton wool.
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
  size: 0.22, grow: 3.4,
  idle: 8, drive: 20,
  speed: 3.0, life: 0.62, alpha: 0.15,
  color: 0xE9EDF4, tail: 0xC2C8D4,
  hot: false,
  ...over,
});

/**
 * Exhaust anchors per machine, read off the parts that make the hole in
 * `vehicles/registry.ts`.
 *
 * The rule for how loud each one is: a machine's plume should say what kind of
 * engine it has without a word of text. The cone and the sedan run small petrol
 * engines and give a thin heat wisp; the truck and the digger run diesels and
 * give a proper stack; the locomotive gives steam, which is the biggest plume
 * in the game and the only one that is genuinely white; the plane and the
 * helicopter run turbines, which give almost no smoke and a hot lip instead.
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
      x: 0.24, y: 0.52, z: -1.14, dx: 0.16, dy: 1.1, dz: -1,
      size: 0.11, grow: 2.6, idle: 18, drive: 38,
    }),
    port({
      x: -0.24, y: 0.52, z: -1.14, dx: -0.16, dy: 1.1, dz: -1,
      size: 0.11, grow: 2.6, idle: 18, drive: 38,
    }),
  ],
  // One pipe under the rear valance, at (0, 0.42, -1.86).
  car: [
    port({
      x: 0.18, y: 0.44, z: -1.92, dx: 0.14, dy: 1.1, dz: -1,
      size: 0.13, grow: 2.7, idle: 20, drive: 42,
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
      size: 0.26, grow: 3.0, idle: 26, drive: 48, speed: 3.8, life: 1.0,
      alpha: 0.28, color: 0x9DA3AE, tail: 0x818794,
    }),
  ],
  // Stack on the engine deck at the back of the house, venting up.
  digger: [
    port({
      x: 0.56, y: 2.06, z: -0.34, dx: 0.02, dy: 1, dz: -0.14,
      size: 0.24, grow: 3.0, idle: 24, drive: 44, speed: 3.4, life: 0.95,
      alpha: 0.28, color: 0x9BA1AC, tail: 0x7F8591,
    }),
  ],
  // The chimney, at (0, 2.72, 1.62). Steam: white, fat, and it climbs. Kept
  // deliberately smaller at birth than the funnel is wide — the previous pass
  // put a single puff over the locomotive that was as big as its boiler and
  // hanging clear of the chimney, which reads as a boulder, not as steam.
  train: [
    port({
      x: 0, y: 2.84, z: 1.62, dx: 0, dy: 1, dz: -0.12,
      size: 0.30, grow: 3.2, idle: 34, drive: 58, speed: 5.4, life: 1.2,
      alpha: 0.30, color: 0xFDFEFF, tail: 0xC9D2DE,
    }),
  ],
  // Exhaust stubs either side of the cowl, blowing back along the fuselage.
  plane: [
    port({
      x: 0.34, y: 0.86, z: 0.86, dx: 0.2, dy: 0.5, dz: -1,
      size: 0.15, grow: 2.8, idle: 15, drive: 32, speed: 5.0, life: 0.52,
      alpha: 0.17, color: 0xDCE3EF, tail: 0xB4BDCC, hot: true,
    }),
    port({
      x: -0.34, y: 0.86, z: 0.86, dx: -0.2, dy: 0.5, dz: -1,
      size: 0.15, grow: 2.8, idle: 15, drive: 32, speed: 5.0, life: 0.52,
      alpha: 0.17, color: 0xDCE3EF, tail: 0xB4BDCC, hot: true,
    }),
  ],
  // Turbine exhaust on the engine deck under the mast, blowing down the boom.
  helicopter: [
    port({
      x: 0.28, y: 1.76, z: -0.72, dx: 0.24, dy: 0.4, dz: -1,
      size: 0.19, grow: 3.0, idle: 16, drive: 34, speed: 6.0, life: 0.6,
      alpha: 0.17, color: 0xDEE5F1, tail: 0xB6BFCE, hot: true,
    }),
  ],
};

/** Fallback for an id the table has never heard of. */
export const DEFAULT_PORT: ExhaustPort[] = [port({})];

export function portsFor(id: VehicleId): ExhaustPort[] {
  return EXHAUST[id] ?? DEFAULT_PORT;
}
