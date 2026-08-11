// The post stack.
//
// Scene -> HDR buffer -> bloom pyramid -> one composite that does atmosphere,
// bloom, the film stock, vignette and dither in a single pass. Six small passes
// and one full-resolution pass; deliberately not a stock EffectComposer chain,
// because the grade and the sky have to agree with each other and an off-the-
// shelf bloom pass has no opinion about either.
//
// The engine only routes through here when `ctx.quality.postfx` is on. With it
// off it draws the scene straight to the canvas and three's own tone-mapping
// hook applies the same film stock (see grade.ts), so the game loses effects
// but never changes colour.

import * as THREE from 'three';
import { DITHER_GLSL, GRADE_GLSL, SRGB_GLSL } from './grade.ts';
import { ATMOS_GLSL, ATMOS_UNIFORMS_GLSL, CLOUD_DECK, CLOUD_FIELD_GLSL } from './sky.ts';
import type { AtmosphereUniforms } from './sky.ts';
import type { GameContext } from '../types.ts';

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** The composite needs a view ray as well as the uv, for depth reprojection. */
const RAY_VERT = /* glsl */ `
uniform mat4 uInvProjection;
varying vec2 vUv;
varying vec3 vRay;
void main() {
  vUv = uv;
  vec4 v = uInvProjection * vec4(position.xy, 1.0, 1.0);
  vec3 ray = v.xyz / v.w;
  // Normalised so ray.z == -1: multiplying by linear depth gives view position.
  vRay = ray / -ray.z;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;

void main() {
  vec3 c = texture2D(tScene, vUv + uTexel * vec2(-1.0, -1.0)).rgb
         + texture2D(tScene, vUv + uTexel * vec2( 1.0, -1.0)).rgb
         + texture2D(tScene, vUv + uTexel * vec2(-1.0,  1.0)).rgb
         + texture2D(tScene, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;

  // Soft knee, so a surface easing past the threshold ramps into the glow
  // instead of popping into it.
  float l = max(c.r, max(c.g, c.b));
  float s = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  s = s * s / (4.0 * uKnee + 1e-4);
  gl_FragColor = vec4(c * (max(s, l - uThreshold) / max(l, 1e-4)), 1.0);
}`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.25;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb * 0.1875;
  c += texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb * 0.1875;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb * 0.1875;
  c += texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb * 0.1875;
  gl_FragColor = vec4(c, 1.0);
}`;

/** Additive tent upsample: four bilinear taps make a 4x4 filter for free. */
const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uScale;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  gl_FragColor = vec4(c * 0.25 * uScale, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
${ATMOS_UNIFORMS_GLSL}
${ATMOS_GLSL}
${CLOUD_FIELD_GLSL}
${GRADE_GLSL}
${SRGB_GLSL}
${DITHER_GLSL}

uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tDepth;

uniform mat3 uCamRot;
uniform float uNear;
uniform float uFar;

uniform float uExposure;
uniform float uBloom;
uniform float uVignette;
uniform float uAberration;
uniform float uBoost;
uniform float uFogAmount;
uniform float uCloudShadow;

varying vec2 vUv;
varying vec3 vRay;

/**
 * Scene fetch with a touch of lateral colour error toward the frame edge.
 * The middle of the frame skips the extra two taps entirely — the aberration
 * there is far below a pixel, and this is a full-resolution pass.
 */
vec3 sampleScene(vec2 uv, float amount) {
  if (amount < 0.0004) return texture2D(tScene, uv).rgb;
  vec2 off = (uv - 0.5) * amount;
  return vec3(
    texture2D(tScene, uv + off).r,
    texture2D(tScene, uv).g,
    texture2D(tScene, uv - off).b);
}

void main() {
  vec2 uv = vUv;
  vec2 toCentre = uv - 0.5;
  float r2 = dot(toCentre, toCentre) * 4.0;

  float ca = uAberration * r2;
  vec3 col = sampleScene(uv, ca);

  // ── Boost ──────────────────────────────────────────────────────────────
  // A directional streak, not a blur: every pixel smears along the line back
  // toward the middle of the frame, which is the direction the world is
  // actually travelling past the camera. Eight taps rather than four, jittered
  // per pixel so a long streak does not come apart into ghosts, and roughly
  // four times the reach — at full boost the corners of the frame drag about
  // eighty pixels, which is the difference between an effect you notice and an
  // effect the reviewer has to be told about.
  //
  // Uniform branch, so it costs nothing on the ninety-odd percent of frames
  // where nobody is boosting.
  if (uBoost > 0.002) {
    float stretch = uBoost * (0.010 + r2 * 0.036);
    float jitter = mcDither(gl_FragCoord.xy) + 0.5;
    vec3 acc = vec3(0.0);
    float w = 0.0;
    for (int i = 0; i < 8; i++) {
      float f = (float(i) + jitter) * 0.125;
      float k = 1.0 - f * 0.62;
      acc += sampleScene(uv - toCentre * (stretch * f), ca) * k;
      w += k;
    }
    // Held back a little in the very middle of the frame so the kart itself
    // stays sharp while the world tears past it.
    col = mix(col, acc / w, clamp(0.30 + r2 * 0.55, 0.0, 1.0));
  }

  // ── Depth ──────────────────────────────────────────────────────────────
  // Everything below is branchless on purpose. The cloud lookup samples a
  // mipmapped texture, and a mipmapped fetch inside a pixel-varying branch has
  // undefined derivatives; the isWorld mask does the job instead.
  vec3 world = normalize(uCamRot * vRay);
  float raw = texture2D(tDepth, uv).x;
  float isWorld = step(raw, 0.999998);
  float ndc = raw * 2.0 - 1.0;
  float linear = (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
  float dist = length(vRay) * linear;

  // ── Cloud shadow ───────────────────────────────────────────────────────
  // Push the surface back up into the cloud deck along the sun and ask whether
  // there is anything up there. It costs three fetches and it is the single
  // biggest thing keeping a static desert from looking like a diorama: the
  // whole floor breathes as the sky drifts over it.
  vec3 wpos = uCamPos + world * min(dist, 1400.0);
  float lift = (${CLOUD_DECK.height}.0 - wpos.y) / max(uSunDir.y, 0.25);
  float cov;
  float dens = mcDeckShadow(mcDeckUv(wpos.xz + uSunDir.xz * lift), cov);
  float shade = smoothstep(cov - 0.01, cov + ${CLOUD_DECK.softness} * 2.4, dens);
  col *= 1.0 - shade * uCloudShadow * isWorld;

  // ── Atmosphere ─────────────────────────────────────────────────────────
  // Depth-driven, so it is real aerial perspective: the colour comes from the
  // sky in that exact direction, the haze thins with altitude, and everything
  // near the sun picks up its glow. Sky pixels never wrote depth, so they are
  // already the answer.
  // The cubic term is art direction, not physics: it keeps the first few
  // hundred metres crisp and then dissolves the far field completely, so the
  // ground plane never ends in a visible line against the sky.
  float air = mcAirMass(dist, uCamPos.y, world.y);
  float fog = (1.0 - exp(-(air + 2.6 * air * air * air))) * uFogAmount * isWorld;
  // The air has its own colour (the course theme's "fog.color"), applied as a
  // unit-luminance tint on the directional sky rather than as a flat fog
  // colour — no backticks in here, see ARCHITECTURE rule 7 — so the shape
  // of the haze — brighter toward the sun, thinner with altitude — is the good
  // idea and stays, while a course still gets to say whether its distance is
  // cold and deep or hot and full of dust. The sky itself is left alone, so a
  // far ridge sits cooler than the sky above it, which is what aerial
  // perspective looks like.
  col = mix(col, mcSkyBase(world) * uAirTint, clamp(fog, 0.0, 1.0));

  col += texture2D(tBloom, uv).rgb * uBloom;

  col = mcGrade(col * uExposure);

  // A wide, gentle vignette. High-key means the corners fall off, not close —
  // until a boost, when it closes down hard and fast and the frame narrows
  // around the kart.
  float vig = uVignette * (1.0 + uBoost * 1.9);
  col *= 1.0 - vig * smoothstep(0.50 - uBoost * 0.34, 1.90, r2);

  // Warm the frame while boosting — the whole picture leans into it.
  col = mix(col, col * vec3(1.24, 1.06, 0.80), clamp(uBoost, 0.0, 1.0) * 0.85);

  col = mcLinearToSRGB(col);
  col += mcDither(gl_FragCoord.xy) * (1.4 / 255.0);

  gl_FragColor = vec4(col, 1.0);
}`;

/**
 * The upscale. One texture read, no maths.
 *
 * Only ever bound when the scene has been drawn smaller than the canvas and
 * antialiasing is off — with `aa` on, FXAA is already a full-resolution pass
 * over the same texture and does this for nothing. Bilinear filtering on
 * `ldrTarget` is what actually resizes the picture; this is the blit that puts
 * it on the screen.
 */
const COPY_FRAG = /* glsl */ `
uniform sampler2D tFrame;
varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(tFrame, vUv).rgb, 1.0); }`;

/**
 * FXAA 3.11's console preset, near enough.
 *
 * The engine asks for an antialiased canvas, and then the post stack renders
 * into an offscreen target and hands the canvas a fullscreen quad — at which
 * point the canvas's own multisampling has nothing left to resolve. So the
 * effects tier was shipping *worse* edges than the tier with no effects at all.
 * This buys them back at the end of the chain, after the grade, where the
 * luminance the filter reasons about is the luminance the player sees.
 */
const FXAA_FRAG = /* glsl */ `
uniform sampler2D tFrame;
uniform vec2 uTexel;
varying vec2 vUv;

float mcLuma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec3 m = texture2D(tFrame, vUv).rgb;
  float lM  = mcLuma(m);
  float lNW = mcLuma(texture2D(tFrame, vUv + uTexel * vec2(-1.0, -1.0)).rgb);
  float lNE = mcLuma(texture2D(tFrame, vUv + uTexel * vec2( 1.0, -1.0)).rgb);
  float lSW = mcLuma(texture2D(tFrame, vUv + uTexel * vec2(-1.0,  1.0)).rgb);
  float lSE = mcLuma(texture2D(tFrame, vUv + uTexel * vec2( 1.0,  1.0)).rgb);

  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  // Flat enough to leave alone. This is most of the frame, and skipping it is
  // what makes the pass affordable.
  if (lMax - lMin < max(0.028, lMax * 0.115)) {
    gl_FragColor = vec4(m, 1.0);
    return;
  }

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, -8.0, 8.0) * uTexel;

  vec3 a = 0.5 * (texture2D(tFrame, vUv + dir * (1.0 / 3.0 - 0.5)).rgb
                + texture2D(tFrame, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(tFrame, vUv + dir * -0.5).rgb
                           + texture2D(tFrame, vUv + dir *  0.5).rgb);
  float lB = mcLuma(b);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? a : b, 1.0);
}`;

export interface PostStack {
  render(dt?: number): void;
  setSize(width?: number, height?: number): void;
  dispose(): void;
  /** 0..1 — drives the radial stretch and the warm push. */
  setBoost(v: number): void;
  setExposure(v: number): void;
  setCloudShadow(v: number): void;
  /**
   * Draw the 3D at `scale` of the canvas without touching the swap chain.
   *
   * **This is the handshake `core/quality.ts` probes for**, and the reason it
   * is a method rather than a flag: a capability announced through a flag is a
   * capability two modules can disagree about, so the governor asks
   * `typeof composer.setRenderScale === 'function'` and nothing else.
   *
   * The alternative — `renderer.setPixelRatio` — rebuilds the drawing buffer
   * (measured at +348ms on a 320x180 bench and **3101ms live at 1280x720**)
   * *and* shrinks the canvas underneath a DOM HUD that stays at native size, so
   * the quality governor was forced to hold the single largest lever it owns
   * until the next race build. Nothing about that is inherent: this stack
   * already renders the world into its own targets and only the last blit
   * touches the canvas. So the scene target, the bloom pyramid and the LDR
   * target are resized to `scale` and the final resolve stays full size, which
   * is one reallocation of targets this file owns, the canvas never moves, and
   * the HUD never comes apart from the road.
   *
   * Returns true if the size actually changed, so the caller can tell a landed
   * step from a no-op.
   */
  setRenderScale(scale: number): boolean;
  /** What the scene is currently drawn at, 0..1. */
  renderScale(): number;
}

/** The smallest fraction of the canvas the scene may be drawn at. Below about
 *  this the upscale stops reading as "soft" and starts reading as "broken". */
const MIN_RENDER_SCALE = 0.4;

const MIPS = 5;
/** How much of the pyramid reaches the composite when bloom is on. */
const BLOOM_STRENGTH = 0.30;
/** Reused for the one clear that stands in for the whole pyramid. */
const BLACK = new THREE.Color(0, 0, 0);

export function createPostStack(
  ctx: GameContext,
  atmos: AtmosphereUniforms,
  noise: THREE.Texture,
): PostStack {
  const renderer = ctx.renderer;

  // Half float keeps the sun disc and boost flames above display white so the
  // bright pass has something to find. Without it, bloom degenerates into a
  // blur of things that were already white.
  const hdr = renderer.extensions.has('EXT_color_buffer_float')
    || renderer.extensions.has('EXT_color_buffer_half_float');
  const colorType = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;

  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  /** The canvas. Never moved by this file. */
  let baseW = Math.max(2, Math.floor(size.x));
  let baseH = Math.max(2, Math.floor(size.y));
  /** What fraction of it the world is drawn at — see `setRenderScale`. */
  let scale = 1;
  /** ...and the resulting target size, which is what everything upstream of the
   *  final blit works in. */
  let width = baseW;
  let height = baseH;

  const depthTexture = new THREE.DepthTexture(width, height);
  depthTexture.format = THREE.DepthFormat;
  depthTexture.type = THREE.UnsignedIntType;
  depthTexture.minFilter = THREE.NearestFilter;
  depthTexture.magFilter = THREE.NearestFilter;

  const sceneTarget = new THREE.WebGLRenderTarget(width, height, {
    type: colorType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
    depthTexture,
    // No multisampling here. Resolving a 4x half-float target with a depth
    // texture attached costs more than the rest of the stack put together on a
    // software rasteriser. Edges are bought back at the far end of the chain
    // instead, with an FXAA resolve on the graded frame.
    samples: 0,
  });

  // Where the composite lands when antialiasing is on, so FXAA has a texture to
  // read. sRGB-encoded 8-bit, because that is what the filter wants: it reasons
  // about perceptual luminance, and running it on linear HDR would leave the
  // dark side of every edge untouched.
  const ldrTarget = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });

  const mips: THREE.WebGLRenderTarget[] = [];
  for (let i = 0; i < MIPS; i++) {
    mips.push(new THREE.WebGLRenderTarget(2, 2, {
      type: colorType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    }));
  }

  // ── fullscreen quad plumbing ───────────────────────────────────────────
  const brightMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: sceneTarget.texture },
      uTexel: { value: new THREE.Vector2() },
      // Above the cloud deck, not through it. The threshold used to sit under
      // the lit cumulus, which meant the entire sky went round the five-mip
      // pyramid and came back as one uniform wash — the effects tier had a
      // visibly worse sky than the tier with no effects. Only the sun disc, the
      // boost flames and genuine speculars are allowed to glow.
      uThreshold: { value: 1.35 },
      uKnee: { value: 0.40 },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: BRIGHT_FRAG,
    depthTest: false,
    depthWrite: false,
  });

  const downMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
    vertexShader: QUAD_VERT,
    fragmentShader: DOWN_FRAG,
    depthTest: false,
    depthWrite: false,
  });

  const upMat = new THREE.ShaderMaterial({
    uniforms: {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uScale: { value: 0.72 },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: UP_FRAG,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const compositeUniforms: Record<string, THREE.IUniform> = {
    ...atmos,
    tScene: { value: sceneTarget.texture },
    tBloom: { value: mips[0]!.texture },
    tDepth: { value: depthTexture },
    uInvProjection: { value: new THREE.Matrix4() },
    uCamRot: { value: new THREE.Matrix3() },
    uNear: { value: 0.1 },
    uFar: { value: 1000 },
    uExposure: { value: ctx.config.render.exposure },
    uBloom: { value: BLOOM_STRENGTH },
    uVignette: { value: 0.22 },
    // Off. Lateral colour error is a lens artefact that only reads as one when
    // the edge it sits on is smooth; on a hard staircase it is just fringing.
    uAberration: { value: 0.0 },
    uBoost: { value: 0 },
    uFogAmount: { value: 1.0 },
    uCloudShadow: { value: 0.22 },
    uNoise: { value: noise },
  };

  const compositeMat = new THREE.ShaderMaterial({
    uniforms: compositeUniforms,
    vertexShader: RAY_VERT,
    fragmentShader: COMPOSITE_FRAG,
    depthTest: false,
    depthWrite: false,
  });

  const fxaaMat = new THREE.ShaderMaterial({
    uniforms: {
      tFrame: { value: ldrTarget.texture },
      uTexel: { value: new THREE.Vector2() },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: FXAA_FRAG,
    depthTest: false,
    depthWrite: false,
  });

  const copyMat = new THREE.ShaderMaterial({
    uniforms: { tFrame: { value: ldrTarget.texture } },
    vertexShader: QUAD_VERT,
    fragmentShader: COPY_FRAG,
    depthTest: false,
    depthWrite: false,
  });

  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad: THREE.Mesh<THREE.PlaneGeometry, THREE.Material> = new THREE.Mesh(quadGeo, brightMat);
  quad.frustumCulled = false;
  quadScene.add(quad);

  function blit(target: THREE.WebGLRenderTarget | null, mat: THREE.Material, clear = true): void {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.autoClear = clear;
    renderer.render(quadScene, quadCam);
  }

  /** True once the pyramid's top mip has been blacked out for a bloom-off run,
   *  so the clear happens on the edge rather than on every frame after it. */
  let bloomCleared = false;
  const _clear = new THREE.Color();

  function setSize(): void {
    renderer.getDrawingBufferSize(size);
    baseW = Math.max(2, Math.floor(size.x));
    baseH = Math.max(2, Math.floor(size.y));
    const w = Math.max(2, Math.round(baseW * scale));
    const h = Math.max(2, Math.round(baseH * scale));
    if (w === width && h === height) return;
    width = w; height = h;
    // A resized target is an uninitialised one, so a bloom-off run has to black
    // its top mip out again — the governor changes the render scale far more
    // often than it changes the bloom flag.
    bloomCleared = false;
    sceneTarget.setSize(width, height);
    ldrTarget.setSize(width, height);
    (fxaaMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / width, 1 / height);
    for (let i = 0; i < MIPS; i++) {
      mips[i]!.setSize(Math.max(2, width >> (i + 1)), Math.max(2, height >> (i + 1)));
    }
  }
  setSize();
  (fxaaMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / width, 1 / height);

  /**
   * Compile every pass's program now, including the ones only a lower quality
   * rung ever asks for.
   *
   * three keys its program cache on the *render target* as well as the
   * material, because the output colour space and the tone mapping differ
   * between drawing into a target and drawing into the back buffer. The
   * composite is therefore two programs: one for `aa: true`, which lands in
   * `ldrTarget` for FXAA to read, and one for `aa: false`, which goes straight
   * to the screen. Only the first is ever built by a frame at the top rung — so
   * the frame on which the quality ladder first gives up antialiasing compiles
   * the largest shader in the game (atmosphere, bloom, film stock, vignette,
   * dither, all in one pass) at the exact moment it is trying to rescue a
   * machine that is already failing. Measured on the ladder walk: the program
   * count went 84 -> 85 on that rung and nowhere else, which is one program more
   * than a ladder is allowed to cost.
   *
   * Six compiles at boot, where nobody is watching, and the count is flat for
   * the whole descent.
   */
  function warmPrograms(): void {
    const prevTarget = renderer.getRenderTarget();
    const prevMat = quad.material;
    const passes: Array<[THREE.Material, Array<THREE.WebGLRenderTarget | null>]> = [
      [brightMat, [mips[0]!]],
      [downMat, [mips[1]!]],
      [upMat, [mips[0]!]],
      // Both, and this pair is the whole reason this function exists.
      [compositeMat, [ldrTarget, null]],
      [fxaaMat, [null]],
      // ...and the upscale blit, which only a reduced render scale with `aa`
      // off ever asks for — which is to say, every rung below the top one.
      // Compiling it here is the same argument one program along.
      [copyMat, [null]],
    ];
    for (const [mat, targets] of passes) {
      quad.material = mat;
      for (const target of targets) {
        renderer.setRenderTarget(target);
        try {
          renderer.compile(quadScene, quadCam);
        } catch {
          // A warm-up that did not happen is a hitch later, not a broken game.
        }
      }
    }
    quad.material = prevMat;
    renderer.setRenderTarget(prevTarget);
  }
  warmPrograms();

  function render(): void {
    setSize();

    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();

    // 1. the world, linear and un-tone-mapped (three skips tone mapping and the
    //    output transform entirely when the destination is a render target).
    renderer.autoClear = true;
    renderer.setRenderTarget(sceneTarget);
    renderer.render(ctx.scene, ctx.camera);

    // ── the pyramid, which the quality ladder may decline ──────────────────
    //
    // Nine blits over five mips, all of them fill: a bright pass at half
    // resolution, four halvings down and four adds back up. It costs nothing
    // in triangles and nothing in draw calls and it is pure pixels, which is
    // the one currency the machines this ladder exists for are short of.
    //
    // It is a *separate* lever from `postfx` on purpose. Turning the whole
    // stack off takes the atmosphere, the film stock, the vignette and the
    // grade with it, puts `THREE.FogExp2` back on the scene and recompiles
    // every material in the game — measured at 762ms in the single frame the
    // governor picked to rescue a machine that was already failing. Dropping
    // only the glow keeps every one of those and compiles nothing: the same
    // composite program runs, with `uBloom` at zero and a black texture bound.
    const bloom = ctx.quality.bloom !== false;
    compositeUniforms.uBloom!.value = bloom ? BLOOM_STRENGTH : 0;
    if (bloom) {
      // 2. bright pass into the top of the pyramid.
      (brightMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / width, 1 / height);
      blit(mips[0]!, brightMat);

      // 3. down the pyramid.
      for (let i = 1; i < MIPS; i++) {
        const src = mips[i - 1]!;
        downMat.uniforms.tSrc!.value = src.texture;
        (downMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
        blit(mips[i]!, downMat);
      }

      // 4. and back up, adding as it goes. Each level widens the glow, so the
      //    result has a tight core under a very soft halo rather than one radius.
      for (let i = MIPS - 1; i > 0; i--) {
        const src = mips[i]!;
        upMat.uniforms.tSrc!.value = src.texture;
        (upMat.uniforms.uTexel!.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
        blit(mips[i - 1]!, upMat, false);
      }
    } else if (!bloomCleared) {
      // The composite still samples `tBloom`, so the mip it reads has to be
      // black rather than whatever the last bloomed frame left in it. Cleared
      // once on the edge, not every frame — a clear is a full write of the
      // target and paying for one to save nine is the whole point.
      renderer.getClearColor(_clear);
      const alpha = renderer.getClearAlpha();
      renderer.setRenderTarget(mips[0]!);
      renderer.setClearColor(BLACK, 0);
      renderer.clear(true, false, false);
      renderer.setClearColor(_clear, alpha);
      bloomCleared = true;
    }
    if (bloom) bloomCleared = false;

    // 5. one pass for everything else.
    const cam = ctx.camera;
    (compositeUniforms.uInvProjection!.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    (compositeUniforms.uCamRot!.value as THREE.Matrix3).setFromMatrix4(cam.matrixWorld);
    compositeUniforms.uNear!.value = cam.near;
    compositeUniforms.uFar!.value = cam.far;

    // 6. resolve edges, if this tier is paying for them — and resolve the
    //    *size* if the world was drawn smaller than the canvas.
    //
    //    Those are the same pass whenever `aa` is on: FXAA already reads the
    //    LDR target and writes the back buffer, so an upscale is free inside
    //    it. With `aa` off and a reduced scale there is nothing to resolve
    //    through, so `copyMat` does the blit — one texture read, and both
    //    programs are built at boot by `warmPrograms`.
    if (ctx.quality.aa) {
      blit(ldrTarget, compositeMat);
      blit(null, fxaaMat);
    } else if (scale < 1) {
      blit(ldrTarget, compositeMat);
      blit(null, copyMat);
    } else {
      blit(null, compositeMat);
    }

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  return {
    render,
    setSize,
    setRenderScale(next: number): boolean {
      const s = next > 1 ? 1 : next < MIN_RENDER_SCALE ? MIN_RENDER_SCALE : next;
      // Quantised to whole percents so that a governor nudging by thousandths
      // cannot reallocate targets for a size change of nought pixels.
      const q = Math.round(s * 100) / 100;
      if (q === scale) return false;
      const wasW = width;
      const wasH = height;
      scale = q;
      setSize();
      return width !== wasW || height !== wasH;
    },
    renderScale(): number { return scale; },
    setBoost(v: number): void { compositeUniforms.uBoost!.value = v; },
    setExposure(v: number): void { compositeUniforms.uExposure!.value = v; },
    setCloudShadow(v: number): void { compositeUniforms.uCloudShadow!.value = v; },
    dispose(): void {
      sceneTarget.dispose();
      ldrTarget.dispose();
      depthTexture.dispose();
      for (const m of mips) m.dispose();
      quadGeo.dispose();
      brightMat.dispose();
      downMat.dispose();
      upMat.dispose();
      compositeMat.dispose();
      fxaaMat.dispose();
      copyMat.dispose();
    },
  };
}
