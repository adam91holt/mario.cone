// What a course's `theme` block actually *means*.
//
// `CourseTheme` (src/types.ts) is a data structure a course author fills in. For
// most of this project's life roughly half of it was prose: `theme.props` had
// thirteen distinct keys across four courses and **zero** property reads
// anywhere in `src/`, and `theme.ground` was read in exactly one place — as the
// lower hemisphere colour of the fill light — so a course could declare
// near-white salt and still photograph as the same khaki dirt as everything
// else. A field that lies about being read is worse than no field at all: it
// makes a course author believe they have art-directed something.
//
// This file is the fix and the contract. It is the *only* place that decides
// what a theme key means, it is exhaustive, and it is loud:
//
//   * Every key a course may write is one of the three lists below. Anything
//     else throws, by name, at build time. Silent no-op is exactly how thirteen
//     dead keys shipped, so the failure mode is now a hard one.
//   * Exactly one *landscape* key is allowed. `canyon`, `quarry`, `saltpan` and
//     `alpine` are not decorations, they are four different ground surfaces —
//     each with its own colour ramp, its own detail texture and its own scatter
//     — so declaring two of them is a question with no answer.
//   * `theme.ground` is the anchor of that surface, not a tint on a shared one.
//     Salt at 0xe0dccc and quarry dust at 0xb08a4e are not one material at two
//     brightnesses; they are a cracked evaporite crust and a crushed-rock floor,
//     and they get different ramps, different strata and different grain.
//
// `src/render/ground.ts` consumes the surface half of this; `src/world/themes.ts`
// consumes the prop half.
//
// ── the second round ───────────────────────────────────────────────────────
//
// The four ramps below were authored against the overhead camera and judged
// against the chase camera, which is not the same picture. A critic sampled the
// ground beyond the barrier from the seat a player actually races in and found
// Cone Canyon at #93785D and Jackhammer Quarry at #8C7347 — twenty-four RGB
// points apart, where forty is roughly where a person sees two different
// places. Rounds one and two of the cup were the same ground at a different
// time of day. Saltpan Bypass was worse in a more interesting way: from
// overhead its crust measured a genuinely neutral #BABBB8, and from the chase
// camera the same course measured warm beige #C1B2A9, because a tan shoulder
// band ramped over twenty-two metres owned the whole strip the low camera can
// see and the declared 0xE0DCCC salt only started past it.
//
// The lesson is in every ramp now: **the first ten metres beyond the shoulder
// is the course's identity**, because from the seat that is most of the lower
// third of the frame, and everything past it is fog and silhouette. So the
// near-field anchor of each surface is the loudest statement it makes, not the
// quietest.

import * as THREE from 'three';
import { noise2, smoothstep } from '../track/geom.ts';
import type { CourseTheme } from '../types.ts';

// ── the key list ───────────────────────────────────────────────────────────

/** The four landscapes. Exactly one per course, and it picks the ground. */
export const LAND_KEYS = ['canyon', 'quarry', 'saltpan', 'alpine'] as const;
export type LandKey = (typeof LAND_KEYS)[number];

/** Boolean set-dressing switches, on top of the landscape. */
export const FLAG_KEYS = [
  'cones', 'crowds', 'snowPoles', 'pines', 'avalancheFence',
  'windsocks', 'surveyPegs', 'conveyors', 'dust', 'heatShimmer',
] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

/** How much plant stands around the circuit, over and above the works yards. */
export const MACHINERY_LEVELS = ['none', 'light', 'heavy'] as const;
export type MachineryLevel = (typeof MACHINERY_LEVELS)[number];

// (There was a `PROP_KEYS` export here — the union of the three lists above,
// declared as "every key a course may write" and read by nothing, including
// `resolveTheme` twelve lines below it. In a file whose entire subject is that
// a field which lies about being read is worse than no field, that is not an
// oversight to leave in place. The three lists are the contract; `fail()`
// prints all three.)

export interface ResolvedTheme {
  land: LandKey;
  machinery: MachineryLevel;
  cones: boolean;
  crowds: boolean;
  snowPoles: boolean;
  pines: boolean;
  avalancheFence: boolean;
  windsocks: boolean;
  surveyPegs: boolean;
  conveyors: boolean;
  dust: boolean;
  heatShimmer: boolean;
  /** The course's declared ground colour, or the house default. */
  ground: number;
}

const DEFAULT_GROUND = 0xc9a063;

function fail(msg: string): never {
  throw new Error(
    `[theme] ${msg}\n`
    + `        landscapes: ${LAND_KEYS.join(', ')}\n`
    + `        switches:   ${FLAG_KEYS.join(', ')}\n`
    + `        machinery:  ${MACHINERY_LEVELS.join(' | ')}`,
  );
}

/**
 * Read a course theme into the flags the renderer and the world module switch
 * on. Throws on anything it does not recognise — see the file header.
 */
export function resolveTheme(theme: CourseTheme | undefined): ResolvedTheme {
  const props = theme?.props ?? {};
  const out: ResolvedTheme = {
    land: 'canyon',
    machinery: 'none',
    cones: false, crowds: false, snowPoles: false, pines: false,
    avalancheFence: false, windsocks: false, surveyPegs: false,
    conveyors: false, dust: false, heatShimmer: false,
    ground: theme?.ground ?? DEFAULT_GROUND,
  };

  let land: LandKey | null = null;
  for (const key of Object.keys(props)) {
    const value = props[key];
    if ((LAND_KEYS as readonly string[]).includes(key)) {
      if (value !== true) fail(`landscape key "${key}" must be true, got ${JSON.stringify(value)}`);
      if (land) fail(`course declares two landscapes, "${land}" and "${key}" — pick one`);
      land = key as LandKey;
      continue;
    }
    if ((FLAG_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') {
        fail(`switch "${key}" must be true or false, got ${JSON.stringify(value)}`);
      }
      out[key as FlagKey] = value;
      continue;
    }
    if (key === 'machinery') {
      if (!(MACHINERY_LEVELS as readonly unknown[]).includes(value)) {
        fail(`machinery must be one of ${MACHINERY_LEVELS.join(' | ')}, got ${JSON.stringify(value)}`);
      }
      out.machinery = value as MachineryLevel;
      continue;
    }
    fail(`unknown props key "${key}" — nothing in src/ reads it`);
  }

  out.land = land ?? 'canyon';
  return out;
}

// ── the four ground surfaces ───────────────────────────────────────────────
//
// One `GroundSurface` per landscape. `paint` is the whole art direction of the
// terrain: it is handed how far a point is from the shoulder, how high it
// stands over the nearest road, and where it is in the world, and it answers
// with an unlit albedo. `render/ground.ts` bakes the course's own key light on
// top and hands the result to a mesh that was, until this existed, painted with
// one shared desert ramp on every course in the game.

export interface PaintArgs {
  /** Metres beyond the outer edge of the shoulder. 0 is the barrier footing. */
  d: number;
  /** Metres above the nearest point of the road. Negative in the run-off ditch. */
  rel: number;
  x: number;
  z: number;
  /** The course's declared `theme.ground`, pre-parsed. */
  base: THREE.Color;
}

export interface GroundSurface {
  /** Metres one tile of the detail texture covers. */
  tile: number;
  /**
   * Base tint for the gravel shoulder, as a CSS colour.
   *
   * The verge is built by `track/road.ts`, whose texture builder already takes
   * a tint and is never given one — so every course in the game runs the same
   * clay-brown run-off. On white salt that reads as a stripe of orange mud
   * between black tarmac and a dry lake, and it is the loudest remaining thing
   * a course cannot say anything about. Until the road module reads a theme
   * colour of its own (see the report), the ground system hands the verge mesh
   * the tinted texture this names.
   */
  verge: string;
  paint(a: PaintArgs, out: THREE.Color): void;
}

const c = (hex: number): THREE.Color => new THREE.Color(hex);

/**
 * Low-frequency mottle so a 24m terrain cell is not one flat facet.
 *
 * The wavelength is deliberately long relative to the coarse field mesh. That
 * mesh is 176 cells across a four-kilometre square, so a cell is 23m wide and
 * anything with a period under about 120m is sampled below Nyquist: the noise
 * stops being mottle and starts being *facets*, which is exactly what the
 * overhead camera photographed — angular tonal patches following the ground
 * triangulation. Grain finer than this belongs in the detail map, which is
 * sampled per pixel and does not care how big a triangle is.
 */
const mottle = (x: number, z: number, m: number): number =>
  1 + (noise2(x / 230 + 4.2, z / 230 - 1.7) - 0.5) * m;

// ── canyon ────────────────────────────────────────────────────────────────
// Warm sandstone country: dust on the flats, terracotta where the ground has
// been cut into, bleached tops, and horizontal strata banding the buttes so
// they read as sedimentary rock rather than as lumps.
//
// The shoulder is the single most-photographed colour in the game — from a
// chase camera the first thirty metres beyond the barrier is most of the lower
// third of the frame — so it carries the course's whole identity, and it is
// pushed properly red. Round two of the cup is a working pit whose floor is
// cold grey; if this one is merely brown the two read as one place at two
// times of day, which is what a critic measured them as (24 RGB apart, where
// 40 is where a player sees two places).
const CANYON_SHOULDER = c(0xa76f38);
const CANYON_ROCK = c(0xb2683f);
const CANYON_HIGH = c(0xdcbb85);
const CANYON_SCRUB = c(0x7f8a4a);
const CANYON_STRATA = c(0x9d4f30);

const canyon: GroundSurface = {
  tile: 42,
  // The house default: clay-brown decomposed granite. Cone Canyon keeps it.
  verge: '#9E6A44',
  paint(a, out) {
    out.copy(CANYON_SHOULDER).lerp(a.base, smoothstep(2, 34, a.d));
    out.lerp(CANYON_ROCK, smoothstep(-8, -46, a.rel) * 0.72);
    out.lerp(CANYON_HIGH, smoothstep(6, 54, a.rel));
    out.lerp(CANYON_SCRUB,
      smoothstep(-1, -16, a.rel) * (1 - smoothstep(-20, -48, a.rel)) * 0.34);
    const band = 0.5 + 0.5 * Math.sin(a.rel * 0.21);
    out.lerp(CANYON_STRATA, band * smoothstep(14, 55, a.rel) * 0.34);
    out.multiplyScalar(mottle(a.x, a.z, 0.13));
  },
};

// ── quarry ────────────────────────────────────────────────────────────────
// A working pit, and the pit is **grey**.
//
// The first cut of this made the floor tan on the reasoning that a haul road is
// crusher dust, and kept the grey for the benched faces above it. From the
// overhead camera that was right and from the chase camera — the one a player
// actually races in — it was a disaster: the only ground in frame is the first
// forty metres beyond the barrier, that band never gets more than a couple of
// metres above the road, and so a critic measured the quarry at #8C7347 against
// Cone Canyon's #93785D. Twenty-four points apart, when forty is where two
// courses stop being one course at two times of day. Rounds one and two of the
// cup were the same place.
//
// So the anchor is the rock the dust was crushed out of — `themes.ts` calls it
// QUARRY.rock, 0x8b8d92 — and the course's declared `theme.ground` is mixed
// into it as what it actually is: a *film* of fines over the floor, thickest
// out on the untrafficked flat and walked away to nothing where the plant
// runs. Change `theme.ground` and the pit still shifts; it just shifts as a
// dusting on grey rock rather than as a desert.
const QUARRY_FLOOR = c(0x77797f);
const QUARRY_ROCK = c(0x77787e);
const QUARRY_FACE = c(0x9ea0a6);
const QUARRY_FINES = c(0xb6b1a4);
const QUARRY_WET = c(0x4f545c);
const QUARRY_BAND = c(0x5f6068);

const quarry: GroundSurface = {
  tile: 28,
  // Crusher run: the rock, crushed. Not the desert it was dug out of.
  verge: '#83858A',
  paint(a, out) {
    // Grey first, dust second. The mix is capped low and thins toward the road,
    // because that is where the machines are and dust does not survive them.
    out.copy(QUARRY_FLOOR).lerp(a.base, 0.10 + 0.16 * smoothstep(3, 46, a.d));
    // Spillage of pale fines across the floor, so the flat is not one tone.
    out.lerp(QUARRY_FINES, smoothstep(0.42, 0.72, noise2(a.x / 78 + 2, a.z / 78 + 9)) * 0.34);
    // Sumps and shadowed cuts.
    out.lerp(QUARRY_WET, smoothstep(-6, -22, a.rel) * 0.6);
    // The faces. Grey arrives fast and completely: 18 metres up a quarry wall
    // there is no dust left at all.
    out.lerp(QUARRY_ROCK, smoothstep(3, 26, a.rel));
    out.lerp(QUARRY_FACE, smoothstep(40, 120, a.rel) * 0.7);
    // Ten-metre lifts. Sharper and tighter than the canyon's sedimentary
    // banding — this is drilled and blasted, not laid down.
    const lift = 0.5 + 0.5 * Math.sin(a.rel * 0.62);
    out.lerp(QUARRY_BAND, Math.pow(lift, 2.2) * smoothstep(10, 40, a.rel) * 0.42);
    out.multiplyScalar(mottle(a.x, a.z, 0.10));
  },
};

// ── saltpan ───────────────────────────────────────────────────────────────
// A dry lake bed. Near-white evaporite the whole way to the horizon, faintly
// cool where brine still sits in the low ground and faintly dirty where traffic
// has been over it — and then, because the course's three landmarks are buttes
// standing *on* the pan, anything that gets more than a few metres above the
// crust turns to warm rock. White floor, tan skyline: that is the photograph.
//
// The salt has to start **at the kerb**. The course declares 0xE0DCCC and calls
// it "the highest road-to-ground contrast in the game", and the first cut of
// this ramped a warm shoulder into it over twenty-two metres — which put tan
// across the entire band a chase camera can see and left the salt for a camera
// players never use. Measured: neutral #BABBB8 from overhead, warm beige
// #C1B2A9 from the chase. So the shoulder is now salt-bound gravel rather than
// dirt, and the ramp is finished inside eight metres.
const SALT_SHOULDER = c(0xd4d2ca);
const SALT_CRUST = c(0xf2efe6);
const SALT_BRINE = c(0xa9bcbd);
const SALT_ROCK = c(0xc09a6d);
const SALT_ROCK_HIGH = c(0xdcc196);
const SALT_STRATA = c(0x9c6f47);

const saltpan: GroundSurface = {
  tile: 48,
  // Salt-bound gravel. Pale, because the run-off on a lake bed is the lake bed.
  verge: '#D9D6CC',
  paint(a, out) {
    out.copy(SALT_SHOULDER).lerp(a.base, smoothstep(0.5, 8, a.d));
    // Fresh crust in broad polygonal fields, damp margins between them.
    const wet = noise2(a.x / 210 - 6, a.z / 210 + 3);
    out.lerp(SALT_CRUST, smoothstep(0.44, 0.78, wet) * 0.85);
    out.lerp(SALT_BRINE, smoothstep(0.40, 0.16, wet) * 0.42);
    // Brine sits in the *low ground*, not in the run-off ditch beside the road
    // — which is where the old threshold put it, dragging a blue-grey stain
    // across the one band the chase camera can see.
    out.lerp(SALT_BRINE, smoothstep(-9, -24, a.rel) * 0.5);
    // The buttes. Warm rock, and it arrives quickly so the pan stays a pan.
    const up = smoothstep(4, 34, a.rel);
    out.lerp(SALT_ROCK, up);
    out.lerp(SALT_ROCK_HIGH, smoothstep(60, 170, a.rel) * 0.8);
    const band = 0.5 + 0.5 * Math.sin(a.rel * 0.16);
    out.lerp(SALT_STRATA, band * smoothstep(24, 90, a.rel) * 0.36);
    out.multiplyScalar(mottle(a.x, a.z, 0.07));
  },
};

// ── alpine ────────────────────────────────────────────────────────────────
// Above the treeline. Grey schist and olive tussock at road level, dark wet
// rock in the gullies, and — the one cue that makes a mountain a mountain from
// two kilometres away — *snow above the line*. The road is ploughed, so the
// snow starts well clear of it and arrives with a broken, noisy edge rather
// than a contour ring.
// Cool grey-green, and *green at the kerb*. The first cut ramped tussock in
// between two and eighteen metres below road level, which on an embankment that
// only falls 5.7m meant the turf never reached more than about seven per cent
// — so the one band a chase camera sees came back neutral grey and measured
// eleven RGB points from Cone Canyon's. A mountain road in summer has tussock
// up against the shoulder; that is where it goes now.
const ALPINE_SHOULDER = c(0x77806b);
const ALPINE_WET = c(0x585a52);
const ALPINE_TURF = c(0x67704a);
const ALPINE_SCREE = c(0xa5a294);
const ALPINE_SNOW = c(0xeef4fa);
const ALPINE_SHADE = c(0xc3d4e4);

const alpine: GroundSurface = {
  tile: 34,
  // Crushed schist chip, the grey a mountain road is shouldered in.
  verge: '#8B8879',
  paint(a, out) {
    out.copy(ALPINE_SHOULDER).lerp(a.base, smoothstep(2, 30, a.d));
    out.lerp(ALPINE_TURF,
      smoothstep(-0.4, -7, a.rel) * (1 - smoothstep(-24, -52, a.rel)) * 0.62);
    out.lerp(ALPINE_WET, smoothstep(-16, -48, a.rel) * 0.7);
    out.lerp(ALPINE_SCREE, smoothstep(18, 74, a.rel) * 0.75);
    // The snowline, broken by a noise field so it never reads as a contour.
    const line = 62 + (noise2(a.x / 240 + 8, a.z / 240 - 5) - 0.5) * 54;
    const snow = smoothstep(line, line + 46, a.rel);
    out.lerp(ALPINE_SHADE, snow * 0.9);
    out.lerp(ALPINE_SNOW, snow * snow);
    out.multiplyScalar(mottle(a.x, a.z, 0.11));
  },
};

export const GROUND_SURFACES: Record<LandKey, GroundSurface> = {
  canyon, quarry, saltpan, alpine,
};
