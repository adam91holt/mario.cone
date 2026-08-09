// Palette and materials for the world dressing.
//
// The rule the whole module is held to: **one material per behaviour, not per
// object**. Colour lives in the vertices, so a hundred different props can
// share a single painted-plastic material and every one of them can be an
// InstancedMesh.
//
// Four behaviours turn out to be enough for everything beside the track:
//
//   `prop`    lit, opaque, painted. Cones, barriers, huts, cranes, diggers.
//   `crowd`   lit, opaque, and bobbing — the animation is a vertex program so
//             ten thousand spectators cost one draw call and no CPU at all.
//   `cloth`   double-sided and rippling. Flags, bunting, banner skirts.
//   `puff`    steam. Grows, rises and shrinks on a loop, again in the vertex
//             program, so a vent is geometry rather than a particle system.
//
// Plus one decal material for contact shadows. The landscape is drawn unlit
// (see track/terrain.ts) and therefore receives no shadow map at all, so every
// prop carries its own soft dark patch or it looks like a sticker on a photo.

import * as THREE from 'three';

/** Roadworks high-vis, plus the greys and browns a work site is actually made of. */
export const C = {
  orange: 0xff6b1a,
  orangeDeep: 0xd8500f,
  yellow: 0xffc300,
  yellowPale: 0xffdc6a,
  white: 0xfff8f0,
  offWhite: 0xe6ded2,
  asphalt: 0x3a3d46,
  ink: 0x23252b,
  steel: 0x8e99a8,
  steelDark: 0x5b6472,
  galv: 0xb4bcc6,
  rust: 0xb3502a,
  red: 0xe33b2e,
  green: 0x6fcf4a,
  greenDeep: 0x3f8f3a,
  blue: 0x2e86d6,
  cyan: 0x5fc8f5,
  navy: 0x27405e,
  sand: 0xc9a063,
  dirt: 0x9c6e42,
  dirtDark: 0x6d4c2c,
  concrete: 0xbcb3a2,
  concreteDark: 0x8e8676,
  timber: 0xc08b4e,
  timberDark: 0x8a5f31,
  tarp: 0x2f6f8f,
  magenta: 0xe0407f,
  purple: 0x8a5cd6,
  lime: 0xc6f24a,
  skin: [0xf3c9a0, 0xdca578, 0xb07a4e, 0x8a5a37, 0xf7dcc0] as const,
  /** Spectator clothing. Saturated and high-contrast — a crowd has to read as a
   *  crowd from two hundred metres, which means colour noise, not detail. */
  shirts: [
    0xff6b1a, 0xffc300, 0xe33b2e, 0x2e86d6, 0x6fcf4a, 0xfff8f0,
    0xe0407f, 0x8a5cd6, 0x5fc8f5, 0xc6f24a, 0xff9f1a, 0x27405e,
  ] as const,
} as const;

// ── the chroma budget ──────────────────────────────────────────────────────
//
// The palette above is the *course* palette, and it is deliberately loud. But
// loud is a budget, not a default, and the budget belongs to gameplay: the
// karts, the item boxes, the boost strips, the drift sparks. Those are the
// things a player has to pick out of a moving frame in a tenth of a second.
//
// Set dressing that covers a lot of frame — a run of advertising boards, a car
// park, a row of tents — has to be *quieter than the race in front of it* or it
// camouflages the race. A previous build ran full-chroma orange/cyan/white
// hoardings the whole way round the lap and the item boxes disappeared into
// them: same screen height, same hue family, higher saturation behind.
//
// So anything in that category goes through `mute()` first. Chroma is scaled
// and value is capped below a kart's paint, which leaves the boards reading as
// *depth* — dusty, sun-bleached, sitting back in the landscape — while the
// karts keep the top of the range to themselves. The graphic punch that is lost
// in chroma is bought back in value contrast: a near-black board next to a bone
// one still reads hard from two hundred metres.

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function hsvHex(h: number, s: number, v: number): number {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = v, g = t, b = p;
  switch (((i % 6) + 6) % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return (Math.round(clamp01(r) * 255) << 16)
    | (Math.round(clamp01(g) * 255) << 8)
    | Math.round(clamp01(b) * 255);
}

/**
 * Pull a course colour back into the background.
 *
 * `chroma` scales saturation; `maxV` caps value. Both in HSV rather than HSL
 * because value is what actually competes with a kart across a frame — a
 * half-saturated colour at full brightness is still the loudest thing on
 * screen.
 */
export function mute(hex: number, chroma = 0.55, maxV = 0.62): number {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const s = max <= 1e-6 ? 0 : d / max;
  return hsvHex(h, clamp01(s * chroma), Math.min(max, maxV));
}

/**
 * Trackside advertising, and everything else that covers frame without being
 * part of the race. The course palette at roughly 60% chroma, value capped
 * below kart paint. Named for what they *look* like rather than what they came
 * from, because at this saturation orange is terracotta and cyan is slate.
 */
export const BOARD = {
  clay: mute(C.orange, 0.52, 0.60),
  ochre: mute(C.yellow, 0.50, 0.62),
  slate: mute(C.cyan, 0.42, 0.58),
  deep: mute(C.navy, 0.60, 0.33),
  bone: mute(C.white, 0.30, 0.62),
  moss: mute(C.green, 0.40, 0.50),
  brick: mute(C.rust, 0.55, 0.50),
  /** Canvas: hospitality marquees, tarpaulins, tent valances. */
  canvas: 0xd9d2c4,
  canvasShade: 0xb3aa9a,
} as const;

/** Parked spectator vehicles. Varied, so a car park reads as one, but held to
 *  the same budget — a hundred cars at full chroma is a hundred false karts. */
export const PARKED = [
  mute(0xdfe3e6, 0.5, 0.72),
  mute(C.red, 0.62, 0.52),
  mute(C.navy, 0.7, 0.40),
  mute(C.green, 0.5, 0.48),
  mute(0x9aa3ad, 0.6, 0.60),
  mute(C.yellow, 0.55, 0.58),
  mute(C.tarp, 0.6, 0.46),
  mute(0x6b5644, 0.6, 0.44),
] as const;

/** Shared clock for every vertex-animated material in the module. */
export interface WorldClock { value: number }

export interface WorldMaterials {
  prop: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  /** Amber hazard beacons. Pulsed by the world system every frame. */
  glow: THREE.MeshStandardMaterial;
  /** Level-crossing lamps. Steady; the flash is done by visibility. */
  glowRed: THREE.MeshStandardMaterial;
  crowd: THREE.MeshLambertMaterial;
  cloth: THREE.MeshLambertMaterial;
  puff: THREE.MeshLambertMaterial;
  /** Airborne quarry dust. Drifts sideways rather than rising. */
  drift: THREE.MeshLambertMaterial;
  /** The mirage over a salt lake. Unlit, because it is air, not a surface. */
  shimmer: THREE.MeshBasicMaterial;
  shadow: THREE.MeshBasicMaterial;
  dispose(): void;
}

/**
 * A soft round blob, black with a radial alpha falloff.
 *
 * Used for the contact patch under every prop. Squared falloff, because a
 * linear one has a hard visible rim where it meets the ground.
 */
function makeBlobTexture(): THREE.CanvasTexture {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S - 0.5, dy = (y + 0.5) / S - 0.5;
      const r = Math.min(1, Math.hypot(dx, dy) * 2);
      const a = (1 - r) * (1 - r);
      const i = (y * S + x) * 4;
      img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Patch a material's vertex stage, keeping three's own program cache honest. */
function vertexProgram(
  mat: THREE.Material, clock: WorldClock, key: string,
  decls: string, body: string,
): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWorldTime = clock as unknown as THREE.IUniform;
    shader.vertexShader = `uniform float uWorldTime;\n${decls}\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${body}`);
  };
  mat.customProgramCacheKey = () => key;
}

export function createMaterials(clock: WorldClock): WorldMaterials {
  // Painted plastic and sheet steel. Roughness sits where the house gloss lobe
  // (render/materials.ts) gives a broad soft sheen rather than a hot pinpoint.
  const prop = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.56, metalness: 0.03,
  });
  prop.name = 'worldProp';

  const metal = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.34, metalness: 0.62,
  });
  metal.name = 'worldMetal';

  // Lamps and beacons. Emissive is uniform across the mesh, so anything using
  // one of these must be *only* lenses.
  const glow = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.2, metalness: 0,
    emissive: 0xffb020, emissiveIntensity: 0.9,
  });
  glow.name = 'worldGlow';

  const glowRed = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.2, metalness: 0,
    emissive: 0xff2a1a, emissiveIntensity: 1.4,
  });
  glowRed.name = 'worldGlowRed';

  // ── crowd ────────────────────────────────────────────────────────────────
  // Bob, sway, and a slower second harmonic so the stand never pulses as one
  // animal. `aAmp` is the height weight — 0 at the feet, 1 at the head, higher
  // still on a raised arm — and `aPhase` is per-spectator.
  const crowd = new THREE.MeshLambertMaterial({ vertexColors: true });
  crowd.name = 'worldCrowd';
  vertexProgram(crowd, clock, 'mc-world-crowd',
    'attribute float aAmp;\nattribute float aPhase;',
    `
  {
    float ph = aPhase * 6.28318;
    float t = uWorldTime * 5.4 + ph;
    float bob = sin(t) * 0.5 + 0.5;
    // A third of the crowd is on a slow beat and two thirds on a fast one, so
    // the stand reads as people rather than as a wave machine.
    float slow = sin(uWorldTime * 1.7 + ph * 2.3) * 0.5 + 0.5;
    float mix2 = step(0.66, fract(aPhase * 7.31));
    float amp = aAmp * mix(bob, slow, mix2);
    transformed.y += amp * 0.30;
    transformed.x += sin(t * 0.61 + ph) * aAmp * 0.09;
  }`);

  // ── cloth ────────────────────────────────────────────────────────────────
  // Flags and bunting. `aAmp` ramps from 0 at the pole to 1 at the free edge,
  // so nothing ever detaches from its mast, and the displacement is along the
  // surface normal rather than a fixed axis — a flag hung across the track and
  // a string of bunting hung along it are the same program.
  const cloth = new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide,
  });
  cloth.name = 'worldCloth';
  vertexProgram(cloth, clock, 'mc-world-cloth',
    'attribute float aAmp;\nattribute float aPhase;',
    `
  {
    float ph = aPhase * 6.28318;
    float w = sin((position.x + position.z) * 3.1 + position.y * 1.3 - uWorldTime * 6.2 + ph);
    transformed += normal * (w * aAmp * 0.36);
    transformed.y -= (1.0 - cos(w)) * aAmp * 0.09;
  }`);

  // ── steam ────────────────────────────────────────────────────────────────
  // Every puff is authored at the origin; the program lifts it, grows it and
  // pinches it out again on a loop. `aAmp` is the puff's size, `aPhase` its
  // place in the cycle — bake six of them into one geometry and a vent is a
  // continuous plume for the price of six spheres.
  // Translucent, because opaque white spheres stacked in a column read as a
  // snowman rather than as steam — which is exactly what the first version
  // looked like from the pulled-back camera. Depth writes are off so the puffs
  // never cut holes in each other; three draws them after the opaque pass, and
  // there is only ever one plume in frame, so no sorting problem survives.
  const puff = new THREE.MeshLambertMaterial({
    vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false,
  });
  puff.name = 'worldPuff';
  vertexProgram(puff, clock, 'mc-world-puff',
    'attribute float aAmp;\nattribute float aPhase;',
    `
  {
    float f = fract(uWorldTime * 0.34 + aPhase);
    float fade = sin(3.14159 * f);
    float drift = sin(aPhase * 31.7);
    transformed = position * (aAmp * (0.30 + f * 1.35) * fade);
    transformed.y += f * 5.4;
    transformed.x += drift * f * f * 1.5;
    transformed.z += cos(aPhase * 19.3) * f * f * 1.1;
  }`);

  // ── drifting dust ────────────────────────────────────────────────────────
  // A working pit has its own weather, and the tell is not a particle system —
  // it is that the air fifty metres away is never quite clear. Same trick as
  // the steam: every card is authored at the origin and the program walks it
  // downwind, swelling it and pinching it out at both ends of the cycle, so a
  // veil is geometry and costs nothing per frame. Slow — a third of the steam's
  // rate — because dust hangs, and anything faster reads as smoke.
  const drift = new THREE.MeshLambertMaterial({
    vertexColors: true, transparent: true, opacity: 0.30,
    depthWrite: false, side: THREE.DoubleSide,
  });
  drift.name = 'worldDrift';
  vertexProgram(drift, clock, 'mc-world-drift',
    'attribute float aAmp;\nattribute float aPhase;',
    `
  {
    float f = fract(uWorldTime * 0.048 + aPhase);
    float fade = sin(3.14159 * f);
    transformed = position * (aAmp * (0.55 + f * 0.75) * fade);
    transformed.x += (f - 0.5) * 46.0;
    transformed.y += f * 4.5 + sin(aPhase * 23.1) * 2.0;
    transformed.z += cos(aPhase * 11.7) * f * 9.0;
  }`);

  // ── the mirage ───────────────────────────────────────────────────────────
  // Heat shimmer over a dry lake. Unlit and barely there: it is a band of the
  // sky's own colour lying on the far crust, rippling, so the horizon detaches
  // the way it does over hot salt. Any more opacity than this and it stops
  // being air and becomes a fence.
  const shimmer = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.30,
    depthWrite: false, side: THREE.DoubleSide, fog: true,
  });
  shimmer.name = 'worldShimmer';
  vertexProgram(shimmer, clock, 'mc-world-shimmer',
    'attribute float aAmp;\nattribute float aPhase;',
    `
  {
    float ph = aPhase * 6.28318;
    float w = sin(position.x * 0.22 + uWorldTime * 1.35 + ph)
            + 0.6 * sin(position.x * 0.61 - uWorldTime * 2.1 + ph * 1.7);
    transformed.y += w * aAmp * 0.55;
    transformed.x += w * aAmp * 0.22;
  }`);

  // ── contact ──────────────────────────────────────────────────────────────
  const shadow = new THREE.MeshBasicMaterial({
    map: makeBlobTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.34,
    color: 0x4a3a26,
    fog: true,
  });
  shadow.name = 'worldContact';

  return {
    prop, metal, glow, glowRed, crowd, cloth, puff, drift, shimmer, shadow,
    dispose(): void {
      shadow.map?.dispose();
      for (const m of [
        prop, metal, glow, glowRed, crowd, cloth, puff, drift, shimmer, shadow,
      ]) m.dispose();
    },
  };
}
