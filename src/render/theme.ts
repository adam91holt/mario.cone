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
//   * Every key a course may write is listed in `PROP_KEYS`. Anything else
//     throws, by name, at build time. Silent no-op is exactly how thirteen dead
//     keys shipped, so the failure mode is now a hard one.
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

/** Every key a course theme is allowed to write under `props`. */
export const PROP_KEYS: readonly string[] = [...LAND_KEYS, ...FLAG_KEYS, 'machinery'];

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

/** Low-frequency mottle so a 24m terrain cell is not one flat facet. */
const mottle = (x: number, z: number, m: number): number =>
  1 + (noise2(x / 96 + 4.2, z / 96 - 1.7) - 0.5) * m;

// ── canyon ────────────────────────────────────────────────────────────────
// Warm sandstone country: dust on the flats, terracotta where the ground has
// been cut into, bleached tops, and horizontal strata banding the buttes so
// they read as sedimentary rock rather than as lumps.
const CANYON_SHOULDER = c(0x9c7746);
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
// A working pit. The floor is tan crusher dust because that is what a haul road
// is made of, but *everything that stands up is grey* — the benched faces are
// freshly blasted rock, and they are banded hard on a tight vertical pitch
// because a quarry wall is cut in ten-metre lifts. That grey-over-tan split is
// the whole difference from the canyon, which is warm all the way up.
const QUARRY_SHOULDER = c(0x8d7346);
const QUARRY_ROCK = c(0x77787e);
const QUARRY_FACE = c(0x9ea0a6);
const QUARRY_FINES = c(0xc6bda8);
const QUARRY_WET = c(0x5b5f66);
const QUARRY_BAND = c(0x5f6068);

const quarry: GroundSurface = {
  tile: 28,
  // Crusher run, scoured grey by the plant that made it.
  verge: '#8A7B5C',
  paint(a, out) {
    out.copy(QUARRY_SHOULDER).lerp(a.base, smoothstep(2, 26, a.d));
    // Spillage of pale fines across the floor, so the flat is not one tone.
    out.lerp(QUARRY_FINES, smoothstep(0.42, 0.72, noise2(a.x / 78 + 2, a.z / 78 + 9)) * 0.32);
    // Sumps and shadowed cuts.
    out.lerp(QUARRY_WET, smoothstep(-6, -22, a.rel) * 0.55);
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
const SALT_SHOULDER = c(0xbfb6a0);
const SALT_CRUST = c(0xf2efe6);
const SALT_BRINE = c(0xa9bcbd);
const SALT_ROCK = c(0xc09a6d);
const SALT_ROCK_HIGH = c(0xdcc196);
const SALT_STRATA = c(0x9c6f47);

const saltpan: GroundSurface = {
  tile: 48,
  // Salt-bound gravel. Pale, because the run-off on a lake bed is the lake bed.
  verge: '#CFC6AE',
  paint(a, out) {
    out.copy(SALT_SHOULDER).lerp(a.base, smoothstep(1.5, 22, a.d));
    // Fresh crust in broad polygonal fields, damp margins between them.
    const wet = noise2(a.x / 210 - 6, a.z / 210 + 3);
    out.lerp(SALT_CRUST, smoothstep(0.44, 0.78, wet) * 0.85);
    out.lerp(SALT_BRINE, smoothstep(0.40, 0.16, wet) * 0.42);
    out.lerp(SALT_BRINE, smoothstep(-1.5, -7, a.rel) * 0.5);
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
const ALPINE_SHOULDER = c(0x7d7a68);
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
      smoothstep(-2, -18, a.rel) * (1 - smoothstep(-24, -52, a.rel)) * 0.55);
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
