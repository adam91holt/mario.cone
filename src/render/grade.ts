// The film stock.
//
// One tone curve and one grade, shared by every path the game can render
// through. When post-processing is on, the composite pass applies it to the
// linear HDR buffer; when it is off, the exact same GLSL is injected into
// three's `CustomToneMapping` hook so every material tone-maps identically.
// Turning postfx off should cost you bloom, atmosphere and vignette — never the
// colour of the game.
//
// The position: ACES is the wrong film stock for this. It bruises saturated
// plastic — a safety-orange cone under a hard sun comes back sunburnt and
// grey-shouldered. What we want is closer to a bright offset print: a long
// straight midsection so hue survives, a clean roll to white at the top, and a
// floor that stops short of zero, because nothing in a Nintendo frame is ever
// actually black.

import * as THREE from 'three';

/** Tuning for the grade. These are baked into the shader as constants. */
const GRADE = {
  /** Scene-referred value where the highlight shoulder takes over. */
  knee: 0.52,
  /** Slope of the straight section — the contrast of the midtones. */
  slope: 1.03,
  /** Floor lift. Keeps deep shadow coloured rather than dead. */
  pedestal: 0.006,

  /** Multipliers applied to shadows and highlights: cool shade, warm sun. */
  shadowTint: [0.955, 0.985, 1.075],
  highlightTint: [1.035, 1.005, 0.955],

  saturation: 1.19,
  contrast: 1.045,
  contrastPivot: 0.47,
};

const v3 = (a: number[]): string => `vec3(${a[0]!.toFixed(4)}, ${a[1]!.toFixed(4)}, ${a[2]!.toFixed(4)})`;
const f = (n: number): string => n.toFixed(5);

/**
 * `mcGrade(vec3 linear)` — scene-referred linear in, display-referred linear
 * out (still linear; the caller encodes to sRGB). Also exports `mcCurve` for
 * anything that wants the luminance response on its own.
 */
export const GRADE_GLSL = /* glsl */ `
#ifndef MC_GRADE
#define MC_GRADE

// A straight line through the mids and a hyperbolic shoulder above the knee,
// joined C1 so the transition is invisible. The long straight section is what
// keeps a hazard-yellow stripe hazard yellow at three stops over key; the
// shoulder is what stops it clipping to white.
//
// Deliberately built from nothing but multiplies and a divide. This runs on
// every pixel of every frame, and the review harness renders through a software
// rasteriser where a pow() costs an order of magnitude more than a multiply.
float mcCurve(float x) {
  const float K = ${f(GRADE.knee)};      // where the shoulder takes over
  const float A = ${f(GRADE.slope)};     // slope of the straight section
  const float B = ${f(GRADE.pedestal)};  // shadows never quite reach zero
  const float S = A * K;                 // value at the knee
  const float R = (1.0 - S) / A;         // shoulder scale that makes it C1

  float lin = A * x + B;
  float d = x - K;
  float sh = S + (1.0 - S) * d / (d + R) + B;
  return x < K ? lin : sh;
}

vec3 mcGrade(vec3 c) {
  c = max(c, 0.0);
  vec3 t = vec3(mcCurve(c.r), mcCurve(c.g), mcCurve(c.b));

  // Split tone. The whole warm-key / cool-fill idea, restated at the grade so
  // it survives even where the lighting is flat.
  float l = dot(t, vec3(0.2126, 0.7152, 0.0722));
  t *= mix(${v3(GRADE.shadowTint)}, ${v3(GRADE.highlightTint)}, smoothstep(0.14, 0.86, l));

  // Painted vinyl, not photography.
  float lum = dot(t, vec3(0.2126, 0.7152, 0.0722));
  t = mix(vec3(lum), t, ${f(GRADE.saturation)});

  // A light S about a high pivot: saturation alone goes chalky in the mids.
  t = ${f(GRADE.contrastPivot)} + (t - ${f(GRADE.contrastPivot)}) * ${f(GRADE.contrast)};

  return clamp(t, 0.0, 1.0);
}
#endif
`;

/** Linear -> sRGB, for shaders that write to the default framebuffer by hand. */
export const SRGB_GLSL = /* glsl */ `
#ifndef MC_SRGB
#define MC_SRGB
vec3 mcLinearToSRGB(vec3 c) {
  // sqrt plus a single corrective term. Peak error against the real transfer
  // function is under half a code value — less than the dither we add on top —
  // and it costs one sqrt instead of one pow per channel.
  vec3 u = sqrt(clamp(c, 0.0, 1.0));
  return u + 0.149 * u * (1.0 - u);
}
#endif
`;

/**
 * Interleaved-gradient dither. Sky gradients band hard at 8 bits and the fix is
 * a third of a code value of noise — invisible, and it buys back the ramp.
 * Deterministic in screen space, so captures stay reproducible.
 */
export const DITHER_GLSL = /* glsl */ `
#ifndef MC_DITHER
#define MC_DITHER
float mcDither(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))) - 0.5;
}
#endif
`;

/**
 * Extra exposure on top of the engine's, so the grade is tuned in one place.
 *
 * Nudged up when the fill came down: cutting the ambient by more than half is
 * what buys the modelling, but taken on its own it also takes a stop out of the
 * whole picture, and this game is high-key. The ratio is the art direction; the
 * absolute level is a knob.
 *
 * It lives here rather than in `lighting.ts` because it has two consumers: the
 * race's post stack and the front-end's 3D set, which used to run stock ACES at
 * a number of its own and photographed a stop darker than the machine it was
 * about to hand the player.
 */
export const EXPOSURE_TRIM = 1.12;

let installed = false;

/**
 * Point three's own material pipeline at the same film stock. Materials only
 * tone-map when they draw straight to the canvas, so this is exactly the
 * postfx-off path — the composite owns the rest of the time.
 */
export function installFilmStock(renderer: THREE.WebGLRenderer, exposure: number): void {
  if (!installed) {
    const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
    const marker = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
    if (chunk.includes(marker)) {
      THREE.ShaderChunk.tonemapping_pars_fragment = chunk.replace(
        marker,
        `${GRADE_GLSL}\nvec3 CustomToneMapping( vec3 color ) { return mcGrade( color * toneMappingExposure ); }`,
      );
    }
    installed = true;
  }
  renderer.toneMapping = THREE.CustomToneMapping;
  renderer.toneMappingExposure = exposure;
}
