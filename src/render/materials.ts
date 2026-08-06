// Global material behaviour, patched into three's own lighting chunks so no
// other module has to know or care.
//
// Two house rules live here, and between them they are what makes the cast read
// as moulded plastic rather than as flat vinyl decals.
//
// ── The cold Fresnel rim ────────────────────────────────────────────────────
//
// Lights cannot give you rim separation on a diffuse surface. A directional
// light from behind is just another key — the *edge* of a silhouette gets no
// special treatment, because Lambert only knows the angle to the light, never
// the angle to the eye. Rim light is a view-dependent term or it is nothing. So
// the whole game gets one: a cold sky-blue that builds toward grazing angles,
// drawing a thin cool line around every kart, cone and barrier and lifting it
// off whatever is behind it. That line is what makes an orange kart read as an
// object against orange sand.
//
// Gated on how *vertical* the surface is, because the same term applied to a
// road would set the entire far end of the straight glowing: every pixel of a
// receding floor is at a grazing angle.
//
// ── The gloss lobe ──────────────────────────────────────────────────────────
//
// Every material in the game is a MeshStandardMaterial around roughness 0.5,
// and a dielectric GGX lobe at that roughness peaks near four percent of the
// key. Physically correct; visually it means there is not one highlight
// anywhere in the frame, and a toy without a highlight reads as paper. So a
// second, unphysical, much brighter lobe goes on top of the correct one —
// broad on the rough parts, tight and hot on chrome and glass. It is added
// inside `RE_Direct_Physical`, which is the only place the *shadowed* light
// colour is still in scope, so a highlight can never appear on a surface the
// sun cannot see.
//
// Baked as constants rather than uniforms on purpose. Three snapshots its
// uniform sets at module load, so a per-course uniform would mean touching
// every material every frame. This is a house style, not a course setting.

import * as THREE from 'three';

const RIM = {
  /** Scene-referred linear radiance added at a full grazing angle. */
  strength: 0.72,
  /** Higher = tighter to the silhouette. */
  power: 2.8,
  /** Cold, and a touch violet, so it never reads as "more sun". */
  color: [0.42, 0.66, 1.0] as const,
  /** How hard to ignore floors and ceilings. 0 = apply everywhere. */
  verticalBias: 1.0,
};

const GLOSS = {
  /** Blinn exponent on a fully rough surface — a wide, soft sheen. */
  minPower: 8.0,
  /** Extra exponent as the surface polishes up. Chrome lands near 60. */
  powerGain: 52.0,
  /** Peak strength on a fully rough surface, as a fraction of irradiance. */
  minStrength: 0.16,
  /** Extra peak strength as it polishes up. */
  strengthGain: 1.05,
};

const v3 = (a: readonly number[]): string =>
  `vec3(${a[0]!.toFixed(3)}, ${a[1]!.toFixed(3)}, ${a[2]!.toFixed(3)})`;
const f = (n: number): string => n.toFixed(2);

let installed = false;

/**
 * Patch the shared lighting chunks. Must run before the first material compiles
 * — three resolves includes at program build time and caches the result.
 */
export function installMaterialStyle(): void {
  if (installed) return;
  installed = true;

  installRim();
  installGloss();
}

function installRim(): void {
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

function installGloss(): void {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  if (chunk.includes('MC_GLOSS')) return;

  // The tail of RE_Direct_Physical. `irradiance` already carries N·L *and* the
  // shadow mask *and* the light's colour and intensity, which is exactly the
  // set of things a highlight has to respect.
  const anchor = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );';
  if (!chunk.includes(anchor)) return;

  THREE.ShaderChunk.lights_physical_pars_fragment = chunk.replace(anchor, `
	// ── MARIO.CONE gloss lobe ──────────────────────────────────────────────
	#define MC_GLOSS
	{
		vec3 mcH = normalize( directLight.direction + geometryViewDir );
		float mcNoH = saturate( dot( geometryNormal, mcH ) );
		// Squared, so the lobe stays broad and gentle across most of the game
		// and only goes hot and tight on the genuinely polished materials.
		float mcGloss = 1.0 - material.roughness;
		mcGloss *= mcGloss;
		float mcLobe = pow( mcNoH, ${f(GLOSS.minPower)} + ${f(GLOSS.powerGain)} * mcGloss );
		reflectedLight.directSpecular +=
			irradiance * mcLobe * ( ${f(GLOSS.minStrength)} + ${f(GLOSS.strengthGain)} * mcGloss );
	}
	${anchor}`);
}
