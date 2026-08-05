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
// grey-shouldered. What we want is closer to a bright offset print: a long,
// almost-linear midsection so hue survives, a clean roll to white at the top,
// and a toe that stops short of black because nothing in a Nintendo frame is
// ever actually black.

import * as THREE from 'three';

/** Tuning for the grade. These are baked into the shader as constants. */
const GRADE = {
  /** Where the linear section of the tone curve starts, and how long it runs. */
  toeEnd: 0.16,
  linearLength: 0.42,
  /** Slope of the linear section — the contrast of the midtones. */
  slope: 1.02,
  /** Toe tightness. Below 1 lifts the shadows. */
  toe: 0.92,
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

// Uchimura's piecewise curve: toe, straight, shoulder. The straight section is
// deliberately long — that is what keeps a hazard-yellow stripe hazard yellow
// at three stops over key.
float mcCurve(float x) {
  const float P = 1.0;
  const float a = ${f(GRADE.slope)};
  const float m = ${f(GRADE.toeEnd)};
  const float l = ${f(GRADE.linearLength)};
  const float c = ${f(GRADE.toe)};
  const float b = ${f(GRADE.pedestal)};

  float l0 = ((P - m) * l) / a;
  float S0 = m + l0;
  float S1 = m + a * l0;
  float C2 = (a * P) / (P - S1);
  float CP = -C2 / P;

  float w0 = 1.0 - smoothstep(0.0, m, x);
  float w2 = step(m + l0, x);
  float w1 = 1.0 - w0 - w2;

  float T = m * pow(max(x, 1e-5) / m, c) + b;
  float S = P - (P - S1) * exp(CP * (x - S0));
  float L = m + a * (x - m);

  return T * w0 + L * w1 + S * w2;
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
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666)) - 0.055, step(0.0031308, c));
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
