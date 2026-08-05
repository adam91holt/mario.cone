// Global material behaviour: the cold Fresnel rim, patched into three's own
// lighting chunk so no other module has to know or care.
//
// Lights cannot give you rim separation on a Lambert surface. A directional
// light from behind is just another key — the *edge* of a silhouette gets no
// special treatment, because Lambert only knows about the angle to the light,
// never the angle to the eye. Rim light is a view-dependent term or it is
// nothing. So the whole game gets one: a cold sky-blue that builds toward
// grazing angles, drawing a thin cool line around every kart, cone and barrier
// and lifting it off whatever is behind it. That line is what makes an orange
// kart read as an object against orange sand.
//
// Gated on how *vertical* the surface is, because the same term applied to a
// road would set the entire far end of the straight glowing: every pixel of a
// receding floor is at a grazing angle.
//
// Baked as constants rather than uniforms on purpose. Three snapshots its
// uniform sets at module load, so a per-course uniform would mean touching
// every material every frame. This is a house style, not a course setting.

import * as THREE from 'three';

const RIM = {
  /** Scene-referred linear radiance added at a full grazing angle. */
  strength: 0.34,
  /** Higher = tighter to the silhouette. */
  power: 3.2,
  /** Cold, and a touch violet, so it never reads as "more sun". */
  color: [0.42, 0.66, 1.0] as const,
  /** How hard to ignore floors and ceilings. 0 = apply everywhere. */
  verticalBias: 1.0,
};

const v3 = (a: readonly number[]): string =>
  `vec3(${a[0]!.toFixed(3)}, ${a[1]!.toFixed(3)}, ${a[2]!.toFixed(3)})`;

let installed = false;

/**
 * Patch the shared lighting chunk. Must run before the first material compiles
 * — three resolves includes at program build time and caches the result.
 */
export function installMaterialStyle(): void {
  if (installed) return;
  installed = true;

  const chunk = THREE.ShaderChunk.lights_fragment_end;
  if (chunk.includes('MC_RIM')) return;

  THREE.ShaderChunk.lights_fragment_end = `${chunk}
// ── MARIO.CONE rim ───────────────────────────────────────────────────────
#define MC_RIM
{
  // Vertical surfaces only. A road seen from 200m away is at a grazing angle
  // across its whole length; without this it would glow like a lightbox.
  vec3 mcNormalWorld = transformNormalByInverseViewMatrix( geometryNormal, viewMatrix );
  float mcSide = 1.0 - abs( mcNormalWorld.y );
  mcSide = mix( 1.0, mcSide * mcSide, ${RIM.verticalBias.toFixed(3)} );

  float mcFresnel = 1.0 - saturate( dot( geometryNormal, geometryViewDir ) );
  reflectedLight.indirectDiffuse +=
    ${v3(RIM.color)} * ( pow( mcFresnel, ${RIM.power.toFixed(2)} ) * ${RIM.strength.toFixed(3)} * mcSide );
}
`;
}
