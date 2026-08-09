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

/** Shared clock for every vertex-animated material in the module. */
export interface WorldClock { value: number }

export interface WorldMaterials {
  prop: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  glow: THREE.MeshStandardMaterial;
  crowd: THREE.MeshLambertMaterial;
  cloth: THREE.MeshLambertMaterial;
  puff: THREE.MeshLambertMaterial;
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

  // Lamps, beacons and crossing lights. Emissive is uniform across the mesh, so
  // anything using this must be *only* lenses.
  const glow = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.2, metalness: 0,
    emissive: 0xffffff, emissiveIntensity: 0.85,
  });
  glow.name = 'worldGlow';

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
  // Flags and bunting. The ripple travels along local x, and `aAmp` ramps from
  // 0 at the pole to 1 at the free edge, so nothing detaches from its mast.
  const cloth = new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide,
  });
  cloth.name = 'worldCloth';
  vertexProgram(cloth, clock, 'mc-world-cloth',
    'attribute float aAmp;\nattribute float aPhase;',
    `
  {
    float ph = aPhase * 6.28318;
    float w = sin(position.x * 3.1 + position.y * 1.3 - uWorldTime * 6.2 + ph);
    transformed.z += w * aAmp * 0.34;
    transformed.y -= (1.0 - cos(w)) * aAmp * 0.09;
  }`);

  // ── steam ────────────────────────────────────────────────────────────────
  // Every puff is authored at the origin; the program lifts it, grows it and
  // pinches it out again on a loop. `aAmp` is the puff's size, `aPhase` its
  // place in the cycle — bake six of them into one geometry and a vent is a
  // continuous plume for the price of six spheres.
  const puff = new THREE.MeshLambertMaterial({ vertexColors: true });
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
    prop, metal, glow, crowd, cloth, puff, shadow,
    dispose(): void {
      shadow.map?.dispose();
      for (const m of [prop, metal, glow, crowd, cloth, puff, shadow]) m.dispose();
    },
  };
}
