// What each landscape is made of, above the ground.
//
// `render/theme.ts` decides what a course's `theme.props` block *means* and how
// the terrain under it is painted. This is the other half: the colours the
// natural scatter is built in, how much of it there is, and what stands on the
// horizon.
//
// The point of splitting it this way is that a landscape is not a switch on one
// set of props — it is a different set. Cone Canyon's run-off is terracotta
// boulders and olive scrub because it is sandstone country; the same geometry
// in the same colours on a salt lake reads as a bug. So each landscape brings
// its own palette, its own density (a pan is *empty*, and that emptiness is the
// course's whole character) and its own skyline.

import { C, mute } from './look.ts';
import type { LandKey } from '../render/theme.ts';

export interface LandPalette {
  /** Broken rock: boulders, talus, rubble. */
  rock: number;
  rockDark: number;
  /** Loose worked ground: spoil, berms, benches. */
  soil: number;
  soilDark: number;
  /** Whatever grows, if anything does. */
  veg: number;
  vegDark: number;
  /** Pale crest material on benched and heaped ground. */
  crest: number;
  /**
   * What settles on the top of things. Snow above the line on the mountain,
   * salt rime on the pan, nothing in the desert.
   */
  cap: number | null;
  /**
   * Density of the natural scatter, 0..1, against Cone Canyon's.
   *
   * This is art direction, not a performance knob. A dry lake is famously
   * featureless — that is why land-speed records are set on them — and a saltpan
   * scattered as densely as a canyon floor stops being a saltpan.
   */
  scatter: number;
  /** Kinds cycled along the horizon ring, in order. */
  skyline: readonly string[];
}

const CANYON: LandPalette = {
  rock: 0xa9713f, rockDark: C.rust,
  soil: C.dirt, soilDark: C.dirtDark,
  veg: 0x7d8a4e, vegDark: 0x6d7a42,
  crest: C.concreteDark,
  cap: null,
  scatter: 1,
  skyline: ['towerCrane', 'silo', 'mast', 'conveyor', 'towerCrane', 'mast', 'silo'],
};

// A working pit is grey. The floor is tan because a haul road is crusher dust,
// but every piece of rock in it came out of a face two hours ago and has had no
// time to weather — which is exactly why the quarry cannot be the canyon at a
// different exposure.
const QUARRY: LandPalette = {
  rock: 0x8b8d92, rockDark: 0x60636a,
  soil: 0x9a8a68, soilDark: 0x6d6350,
  veg: 0x6e7350, vegDark: 0x565c40,
  crest: 0xb9b4a6,
  cap: null,
  scatter: 0.85,
  skyline: ['conveyor', 'silo', 'towerCrane', 'conveyor', 'silo', 'mast', 'towerCrane'],
};

// Salt works. Almost nothing stands up, and what does is either white or a long
// way away — so the scatter is a third of the canyon's and the skyline is
// mostly sky.
const SALTPAN: LandPalette = {
  rock: 0xc0a883, rockDark: 0x9c8460,
  soil: 0xd6d0be, soilDark: 0xb2ac99,
  veg: 0x9aa48a, vegDark: 0x7c866e,
  crest: 0xefece1,
  cap: 0xf4f1e8,
  scatter: 0.32,
  skyline: ['mast', 'conveyor', 'silo', 'mast', 'conveyor', 'silo', 'mast'],
};

// Above the treeline. Cold grey schist, dark tussock, and snow on anything that
// stands proud of the wind.
const ALPINE: LandPalette = {
  rock: 0x8d9096, rockDark: 0x5f636a,
  soil: 0x7a7768, soilDark: 0x545245,
  veg: 0x5d6b3e, vegDark: 0x44502e,
  crest: 0xb0b6bc,
  cap: 0xe9f1f8,
  scatter: 0.9,
  skyline: ['mast', 'towerCrane', 'mast', 'silo', 'mast', 'towerCrane', 'mast'],
};

export const LAND_PALETTES: Record<LandKey, LandPalette> = {
  canyon: CANYON,
  quarry: QUARRY,
  saltpan: SALTPAN,
  alpine: ALPINE,
};

/** Heavy plant livery — quiet enough not to compete with a kart. See look.ts. */
export const PLANT = {
  body: mute(C.yellow, 0.72, 0.70),
  bodyDark: mute(C.yellow, 0.62, 0.44),
  cab: mute(C.ink, 0.4, 0.22),
  steel: C.steelDark,
} as const;
