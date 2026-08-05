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
  uHazeBand: { value: number };
  uInscatter: { value: number };
  /** Metres of visibility, roughly: the distance at which air is ~63% opaque. */
  uFogDistance: { value: number };
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
    uHazeBand: { value: 7.5 },
    uInscatter: { value: 1.0 },
    uFogDistance: { value: 900 },
    uFogHeight: { value: 130 },
  };
}

/** Uniform declarations shared by the dome and the composite. */
export const ATMOS_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uHazeBand;
uniform float uInscatter;
uniform float uFogDistance;
uniform float uFogHeight;
`;

/** `mcSkyBase(dir)` — scene-referred linear radiance of the air, no clouds. */
export const ATMOS_GLSL = /* glsl */ `
vec3 mcSkyBase(vec3 d) {
  float h = clamp(d.y, -1.0, 1.0);

  // Zenith down to horizon. A low exponent keeps real blue overhead and hands
  // the bottom third of the dome to haze, which is where the racing happens.
  vec3 col = mix(uHorizon, uZenith, pow(max(h, 0.0), 0.42));

  // Warm haze packed into the last few degrees above the horizon. Distance fog
  // fades into this exact colour, so the join cannot drift.
  col = mix(col, uHaze, exp(-max(h, 0.0) * uHazeBand) * 0.78);

  // Below the horizon: same haze, a shade heavier. The ground plane dissolves
  // into it rather than ending at a line.
  col = mix(col, uHaze * 0.74, 1.0 - smoothstep(-0.20, 0.0, h));

  // Forward scattering. The glow that builds around the sun and washes down the
  // horizon is the difference between atmosphere and a grey wash.
  float mu = max(dot(d, uSunDir), 0.0);
  col += uSunColor * uInscatter * (pow(mu, 5.0) * 0.20 + pow(mu, 40.0) * 0.45);

  return col;
}

/**
 * How much air sits between the eye and a point `dist` away, accounting for the
 * haze thinning with altitude. Analytic integral of an exponential density
 * along the ray, which keeps hilltops clear while the valley floor hazes over.
 */
float mcAirMass(float dist, float camY, float dirY) {
  float H = max(uFogHeight, 1.0);
  float dy = dirY * dist;
  float a = exp(-max(camY, 0.0) / H);
  // Guard the near-horizontal case, where the integral degenerates.
  float integral = abs(dy) < 0.6
    ? a * dist * (1.0 - 0.5 * dy / H)
    : a * (1.0 - exp(-dy / H)) * (dist / dy) * H;
  return max(integral, 0.0) / max(uFogDistance, 1.0);
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vDir = world.xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = /* glsl */ `
${ATMOS_UNIFORMS_GLSL}
${ATMOS_GLSL}
${DITHER_GLSL}

uniform sampler2D uNoise;
uniform vec3 uCamPos;
uniform float uTime;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uCoverage;

varying vec3 vDir;

/**
 * One deck of cloud. `rgb` is its lit colour, `a` its coverage of the pixel.
 *
 * The field is 2D noise sampled where the view ray crosses a plane at
 * `height`; perspective does all the work of making a flat field read as a
 * ceiling. Shading comes from stepping the same field toward the sun: more
 * cloud between here and the light means a darker, bluer pixel.
 */
vec4 mcCloudDeck(vec3 d, float height, float scale, vec2 stretch, float drift,
                 float coverage, float softness, float detailMul, float density) {
  // Clamped rather than branched: every fetch below has to stay in uniform
  // control flow or the mip derivatives go undefined along the horizon.
  float dy = max(d.y, 0.012);
  float t = max((height - uCamPos.y) / dy, 0.0);

  vec2 p = (uCamPos.xz + d.xz * t) * scale * stretch;
  p += vec2(uTime * drift, uTime * drift * 0.42);

  vec4 n = texture2D(uNoise, p);
  vec2 pd = p * 3.1 + vec2(0.31, 0.77);
  float detail = texture2D(uNoise, pd).g;
  float billow = texture2D(uNoise, p * 1.7 + vec2(0.13, 0.51)).a;

  float cov = coverage + (n.b - 0.5) * 0.34;
  float dens = n.r + (detail - 0.5) * detailMul + (billow - 0.5) * 0.16;
  float a = smoothstep(cov, cov + softness, dens) * density;

  // Self-shadow. One step toward the sun is enough at this scale, and it is the
  // difference between a sticker and something with a lit side.
  vec2 sunStep = normalize(uSunDir.xz + vec2(1e-4, 0.0)) * 0.018;
  float toSun = texture2D(uNoise, p + sunStep).r
              + (texture2D(uNoise, pd + sunStep * 3.1).g - 0.5) * detailMul;
  float lit = clamp(1.0 - (toSun - dens) * 4.2, 0.0, 1.0);
  lit = mix(lit, 1.0, smoothstep(cov + softness * 0.4, cov, dens) * 0.55);

  vec3 col = mix(uCloudShade, uCloudLit, lit * lit);

  // Silver lining: sun behind a shaded edge burns through it.
  float mu = max(dot(d, uSunDir), 0.0);
  col += uSunColor * pow(mu, 7.0) * (1.0 - lit) * 0.9;
  col += uSunColor * pow(mu, 2.0) * 0.06;

  // Aerial perspective on the deck itself, so the field recedes instead of
  // tiling flatly out to the horizon.
  float far = smoothstep(0.42, 0.03, d.y);
  col = mix(col, uHaze * 1.05, far * 0.85);
  a *= smoothstep(0.012, 0.075, d.y);

  return vec4(col, clamp(a, 0.0, 1.0));
}

void main() {
  vec3 d = normalize(vDir);
  vec3 col = mcSkyBase(d);

  // Sun disc. Deliberately far above white so the bloom has something to eat.
  float mu = dot(d, uSunDir);
  col += uSunColor * smoothstep(0.99930, 0.99972, mu) * 26.0;

  // High cirrus first, cumulus over the top of it.
  vec4 hi = mcCloudDeck(d, 3400.0, 0.00016, vec2(0.45, 2.30), 0.0011, 0.56, 0.30, 0.55, 0.55);
  col = mix(col, hi.rgb, hi.a);

  vec4 lo = mcCloudDeck(d, 1050.0, 0.00052, vec2(1.0, 1.0), 0.0016, uCoverage, 0.115, 0.60, 1.0);
  col = mix(col, lo.rgb, lo.a);

  col += mcDither(gl_FragCoord.xy) * 0.0025;

  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface Sky {
  mesh: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;
  /** Per-frame: keeps the dome on the camera and drifts the cloud field. */
  update(camera: THREE.Camera, elapsed: number): void;
  setCoverage(v: number): void;
  dispose(): void;
}

/**
 * @param atmos shared uniform block — pass the same object to the composite.
 */
export function createSky(atmos: AtmosphereUniforms): Sky {
  const noise = makeCloudNoise(256);

  const uniforms: Record<string, THREE.IUniform> = {
    ...atmos,
    uNoise: { value: noise },
    uCamPos: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    // Cloud tops sit above display white on purpose: they are the brightest
    // thing in the frame and they should bloom a little.
    uCloudLit: { value: new THREE.Color(0xfffaf0).multiplyScalar(1.55) },
    uCloudShade: { value: new THREE.Color(0x8fb4d8).multiplyScalar(0.62) },
    uCoverage: { value: 0.47 },
  };

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1800, 24, 16),
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

    update(camera: THREE.Camera, elapsed: number): void {
      camera.getWorldPosition(mesh.position);
      (uniforms.uCamPos!.value as THREE.Vector3).copy(mesh.position);
      uniforms.uTime!.value = elapsed;
    },

    setCoverage(v: number): void {
      uniforms.uCoverage!.value = v;
    },

    dispose(): void {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      noise.dispose();
    },
  };
}
