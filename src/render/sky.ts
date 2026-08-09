// Sky and atmosphere.
//
// One model, two consumers. `mcSkyBase()` is the colour of the air in a given
// direction; the dome uses it as its backdrop and the post-processing pass uses
// it as the colour distant geometry fades into. Because both read the same
// function off the same uniform block, the horizon join is exact by
// construction — there is no eyeballed "fog colour" that drifts out of step
// with the sky behind it.
//
// The clouds are a flat noise field projected onto a plane at altitude. That
// projection is the whole trick: overhead they are big and round, and toward
// the horizon perspective squashes them into a crowded band, which is what
// gives a painted dome a sense of ceiling and distance.

import * as THREE from 'three';
import { DITHER_GLSL } from './grade.ts';
import { makeCloudNoise } from './noise.ts';

export interface AtmosphereUniforms {
  uZenith: { value: THREE.Color };
  uHorizon: { value: THREE.Color };
  uHaze: { value: THREE.Color };
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uCamPos: { value: THREE.Vector3 };
  /** Sim clock. Drives the cloud drift — and therefore the shadows it casts. */
  uTime: { value: number };
  /** 0..1 density of the cumulus deck. Shared so the ground shadows match. */
  uCoverage: { value: number };
  uHazeBand: { value: number };
  uInscatter: { value: number };
  /** Metres of visibility, roughly: where sea-level air reaches ~63% opacity. */
  uFogDistance: { value: number };
  /**
   * The colour of the *air*, normalised to unit luminance.
   *
   * Distance fades to the sky in that direction, which is the right idea and
   * the reason this game has aerial perspective rather than grey fog. But the
   * sky above the horizon and the air you are looking through are not the same
   * colour: a mountain's haze is colder and deeper than its horizon band, and a
   * working quarry's is dust. `theme.fog.color` says which, and until this
   * existed it said it to nobody. Applied as a tint rather than a colour so it
   * shifts hue without touching exposure, and so the sun's glow still comes
   * through the haze where the haze is between you and the sun.
   */
  uAirTint: { value: THREE.Color };
  /** Scale height of the haze layer. Low air is thick, high air is clear. */
  uFogHeight: { value: number };
  [key: string]: THREE.IUniform;
}

export function makeAtmosphereUniforms(): AtmosphereUniforms {
  return {
    uZenith: { value: new THREE.Color(0x2e86d6) },
    uHorizon: { value: new THREE.Color(0xbfe7ff) },
    uHaze: { value: new THREE.Color(0xffe2b0) },
    uSunDir: { value: new THREE.Vector3(0.6, 0.7, 0.4).normalize() },
    uSunColor: { value: new THREE.Color(0xfff2d8) },
    uCamPos: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uCoverage: { value: 0.565 },
    uHazeBand: { value: 10.5 },
    uInscatter: { value: 1.0 },
    uFogDistance: { value: 1400 },
    uFogHeight: { value: 150 },
    uAirTint: { value: new THREE.Color(1, 1, 1) },
  };
}

/**
 * The cumulus deck, as numbers rather than prose. The dome looks *through* this
 * field from the eye and the composite projects the ground *up* into it along
 * the sun; they have to be the same field or the shadows drift off the clouds
 * that cast them.
 */
export const CLOUD_DECK = {
  height: 1250,
  scale: 0.000255,
  drift: 0.0013,
  softness: 0.085,
  detail: 0.34,
};

/** Uniform declarations shared by the dome and the composite. */
export const ATMOS_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uCoverage;
uniform float uHazeBand;
uniform float uInscatter;
uniform float uFogDistance;
uniform float uFogHeight;
uniform vec3 uAirTint;
`;

/** `mcSkyBase(dir)` — scene-referred linear radiance of the air, no clouds. */
export const ATMOS_GLSL = /* glsl */ `
vec3 mcSkyBase(vec3 d) {
  float h = clamp(d.y, -1.0, 1.0);
  float up = max(h, 0.0);

  // Zenith down to horizon. sqrt in place of the pow it wants: the difference
  // is a few thousandths and this function runs on every pixel of the frame,
  // twice — once for the dome and once for the fog it has to match. The extra
  // shaping term pulls the zenith blue down into the band a chase camera can
  // actually see; without it the only properly blue sky in the game is directly
  // overhead, where nobody is looking.
  float s = sqrt(up);
  vec3 col = mix(uHorizon, uZenith, s * (1.0 + (1.0 - s) * 0.55));

  // Warm haze packed into the last few degrees above the horizon. Distance fog
  // fades into this exact colour, so the join cannot drift. The rational decay
  // stands in for exp(): same shape, no transcendental.
  float band = 1.0 / (1.0 + up * uHazeBand * (1.0 + up * uHazeBand * 0.5));
  col = mix(col, uHaze, band * 0.74);

  // Below the horizon: same haze, a shade heavier. The ground plane dissolves
  // into it rather than ending at a line.
  col = mix(col, uHaze * 0.74, 1.0 - smoothstep(-0.20, 0.0, h));

  // Forward scattering. The glow that builds around the sun and washes down the
  // horizon is the difference between atmosphere and a grey wash.
  float mu = max(dot(d, uSunDir), 0.0);
  float mu2 = mu * mu;
  float mu5 = mu2 * mu2 * mu;
  float mu10 = mu5 * mu5;
  col += uSunColor * uInscatter * (mu5 * 0.20 + mu10 * mu10 * mu10 * mu10 * 0.45);

  return col;
}

/**
 * How much air sits between the eye and a point *dist* away, accounting for the
 * haze thinning with altitude. Analytic integral of an exponential density
 * along the ray, which keeps hilltops clear while the valley floor hazes over.
 */
float mcAirMass(float dist, float camY, float dirY) {
  float H = max(uFogHeight, 1.0);
  float dy = dirY * dist;
  float a = exp(-max(camY, 0.0) / H);
  // Guard the near-horizontal case, where the closed form degenerates into
  // 0/0; the series expansion is exact enough well past this threshold.
  float integral = abs(dy) < 0.02 * H
    ? a * dist * (1.0 - 0.5 * dy / H)
    : a * (1.0 - exp(clamp(-dy / H, -40.0, 20.0))) * (dist / dy) * H;
  return clamp(integral, 0.0, 1e6) / max(uFogDistance, 1.0);
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vDir = world.xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Samples the cumulus field. Both consumers include this verbatim. */
export const CLOUD_FIELD_GLSL = /* glsl */ `
uniform sampler2D uNoise;

vec2 mcDeckUv(vec2 groundXZ) {
  return groundXZ * ${CLOUD_DECK.scale}
       + vec2(uTime * ${CLOUD_DECK.drift}, uTime * ${CLOUD_DECK.drift * 0.42});
}

/** Density of the deck at deck-space point p. Above cov there is cloud. */
float mcDeckDensity(vec2 p, float detailMul, out float cov) {
  // One fetch carries the body (r), the coverage drift (b) and the puffy
  // billow (a); a second adds the erosion detail. Two fetches is the budget.
  vec4 n = texture2D(uNoise, p);
  float detail = texture2D(uNoise, p * 2.2 + vec2(0.31, 0.77)).g;
  cov = uCoverage + (n.b - 0.5) * 0.30;
  return n.r + (detail - 0.5) * detailMul + (n.a - 0.5) * 0.12;
}

/** Body only — one fetch. Enough for the shadow the deck throws on the ground. */
float mcDeckShadow(vec2 p, out float cov) {
  vec4 n = texture2D(uNoise, p);
  cov = uCoverage + (n.b - 0.5) * 0.30;
  return n.r + (n.a - 0.5) * 0.12;
}
`;

const SKY_FRAG = /* glsl */ `
${ATMOS_UNIFORMS_GLSL}
${ATMOS_GLSL}
${CLOUD_FIELD_GLSL}
${DITHER_GLSL}

uniform vec3 uCloudLit;
uniform vec3 uCloudShade;

varying vec3 vDir;

/**
 * One deck of cloud. The rgb is its lit colour, the alpha its coverage of the pixel.
 *
 * The field is 2D noise sampled where the view ray crosses a plane at
 * altitude; perspective does all the work of making a flat field read as a
 * ceiling. Shading comes from stepping the same field toward the sun: more
 * cloud between here and the light means a darker, bluer pixel.
 */
vec4 mcCloudDeck(vec3 d, float height, float scale, vec2 stretch, float drift,
                 float coverage, float softness, float detailMul, float sunStep,
                 float density) {
  // Clamped rather than branched: every fetch below has to stay in uniform
  // control flow or the mip derivatives go undefined along the horizon.
  float dy = max(d.y, 0.012);
  float t = max((height - uCamPos.y) / dy, 0.0);

  vec2 p = (uCamPos.xz + d.xz * t) * scale * stretch
         + vec2(uTime * drift, uTime * drift * 0.42);

  // Perspective crushes the deck toward the horizon, so the fine octaves have
  // to come off there or the bottom of the sky turns to stipple. Big shapes
  // survive the compression; detail does not, and should not pretend to.
  float near = smoothstep(0.04, 0.40, d.y);
  float dm = detailMul * (0.18 + 0.82 * near);

  float cov;
  float dens = mcDeckDensity(p, dm, cov);
  cov += coverage - uCoverage;
  float a = smoothstep(cov, cov + softness, dens) * density;

  // ── Form ────────────────────────────────────────────────────────────────
  // A flat noise field has no top and no underside, so it has to be given one.
  // The density itself stands in for how tall the puff is: where the field is
  // barely over the coverage threshold we are looking at a thin translucent
  // fringe, and where it is deep we are looking at the belly of a cauliflower
  // that has several hundred metres of cloud above it.
  float thick = clamp((dens - cov) / 0.16, 0.0, 1.0);

  // Two probes toward the sun at different reaches. The long one finds the
  // terminator across the whole puff, the short one picks out the individual
  // lumps on the lit flank. Without the long one the field only ever varies by
  // a couple of percent and the whole deck comes back as flat cream cutouts.
  vec2 toward = normalize(uSunDir.xz + vec2(1e-4, 0.0)) * sunStep;
  float covA;
  float farAhead = mcDeckShadow(p + toward * 2.6, covA);
  float nearAhead = mcDeckShadow(p + toward, covA);
  float slope = (farAhead - dens) * 0.62 + (nearAhead - dens) * 0.38;

  // Sun-facing flank up into the highlight, away flank down into the shade.
  float lit = clamp(0.72 - slope * 9.0, 0.0, 1.0);
  // The deep body self-shadows: a fat cumulus is bright on top and blue-grey
  // underneath, and from down here we are mostly looking at underneath.
  lit *= mix(1.0, 0.55, thick);
  // Thin edges are translucent, so they burn out brighter than any core — but
  // only the genuinely thin ones. Applied any wider than this it lifts the
  // whole deck back to flat cream, which is where this started.
  float fringe = 1.0 - thick;
  lit = mix(lit, 1.0, fringe * fringe * fringe * 0.55);
  // Low in the sky it is undersides all the way down.
  lit *= mix(0.55, 1.0, smoothstep(0.02, 0.40, d.y));

  // An S about the middle rather than a square: squaring drags the whole deck
  // toward the shade colour, and what this wants is contrast at both ends — a
  // hot lit flank, a blue-grey belly, and a fast terminator between them.
  vec3 col = mix(uCloudShade, uCloudLit, smoothstep(0.05, 0.95, lit));

  // Silver lining: sun behind a shaded edge burns through it.
  float mu = max(dot(d, uSunDir), 0.0);
  float mu2 = mu * mu;
  col += uSunColor * (mu2 * mu2 * mu2 * mu) * (1.0 - lit) * 1.3;
  col += uSunColor * mu2 * 0.05;

  // Aerial perspective on the deck itself, so the field recedes instead of
  // tiling flatly out to the horizon. Held back from the mid sky — pushed as
  // far as it was, it washed the form out of exactly the clouds a player is
  // looking at.
  col = mix(col, uHaze * 1.02, (1.0 - smoothstep(0.0, 0.34, d.y)) * 0.46);
  a *= smoothstep(0.045, 0.20, d.y);

  return vec4(col, clamp(a, 0.0, 1.0));
}

void main() {
  vec3 d = normalize(vDir);
  vec3 col = mcSkyBase(d);

  // Sun disc. Deliberately far above white so the bloom has something to eat.
  float mu = dot(d, uSunDir);
  col += uSunColor * smoothstep(0.99930, 0.99972, mu) * 26.0;

  // Two decks. High cirrus first — stretched, sparse, barely there — then the
  // cumulus over the top. Big and few: a Nintendo sky is three or four sculpted
  // shapes with somewhere to look, not a field of popcorn.
  vec4 hi = mcCloudDeck(d, 3600.0, 0.000105, vec2(0.5, 2.6), 0.0009, 0.70, 0.34, 0.35, 0.05, 0.26);
  col = mix(col, hi.rgb, hi.a);

  vec4 lo = mcCloudDeck(d, ${CLOUD_DECK.height}.0, ${CLOUD_DECK.scale}, vec2(1.0, 1.0), ${CLOUD_DECK.drift}, uCoverage, ${CLOUD_DECK.softness}, ${CLOUD_DECK.detail}, 0.085, 1.0);
  col = mix(col, lo.rgb, lo.a);

  col += mcDither(gl_FragCoord.xy) * 0.0025;

  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface Sky {
  mesh: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;
  /** The cloud atlas, shared with the composite so it can cast the shadows. */
  noise: THREE.DataTexture;
  /** Per-frame: keeps the dome on the camera and drifts the cloud field. */
  update(camera: THREE.Camera, elapsed: number): void;
  setCoverage(v: number): void;
  dispose(): void;
}

/**
 * @param atmos shared uniform block — pass the same object to the composite.
 */
export function createSky(atmos: AtmosphereUniforms, radius = 2700): Sky {
  const noise = makeCloudNoise(256);

  const uniforms: Record<string, THREE.IUniform> = {
    ...atmos,
    uNoise: { value: noise },
    // Lit tops sit just over display white — bright enough to hold the top of
    // the tone curve, deliberately *under* the bloom threshold, because a
    // cumulus deck that blooms is a cumulus deck that has stopped having edges.
    uCloudLit: { value: new THREE.Color(0xfffaf2).multiplyScalar(1.05) },
    // The shaded side, at a little under half the lit side in linear terms —
    // which the tone curve's shoulder compresses back to roughly the 0.55 that
    // reads correctly on screen. Blue-grey, because the only thing lighting the
    // underside of a cloud is the sky.
    uCloudShade: { value: new THREE.Color(0x93b6dc) },
  };

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 24, 16),
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: true,
    }),
  );
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  // Drawn after the opaque world so the depth test throws away every sky pixel
  // the track already covers. The dome is the most expensive shader in the
  // frame; it should only ever run on pixels that are actually sky.
  mesh.renderOrder = 1000;

  return {
    mesh,
    uniforms,
    noise,

    update(camera: THREE.Camera, elapsed: number): void {
      camera.getWorldPosition(mesh.position);
      // Shared with the composite: the sky and the fog read the same eye point.
      atmos.uCamPos.value.copy(mesh.position);
      atmos.uTime.value = elapsed;
    },

    setCoverage(v: number): void {
      atmos.uCoverage.value = v;
    },

    dispose(): void {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      noise.dispose();
    },
  };
}
