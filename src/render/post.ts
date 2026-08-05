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

  // Boost: the frame stretches away from the middle. Cheap, coherent, and it
  // sells speed harder than any particle can.
  if (uBoost > 0.002) {
    float stretch = uBoost * r2 * 0.020;
    vec3 acc = col;
    float w = 1.0;
    for (int i = 1; i < 5; i++) {
      float f = float(i) * 0.25;
      float k = 1.0 - f * 0.55;
      acc += sampleScene(uv - toCentre * (stretch * f), ca) * k;
      w += k;
    }
    col = acc / w;
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
  col = mix(col, mcSkyBase(world), clamp(fog, 0.0, 1.0));

  col += texture2D(tBloom, uv).rgb * uBloom;

  col = mcGrade(col * uExposure);

  // A wide, gentle vignette. High-key means the corners fall off, not close.
  col *= 1.0 - uVignette * smoothstep(0.50, 1.90, r2 * (1.0 + uBoost * 0.45));

  // Warm the frame while boosting — the whole picture leans into it.
  col = mix(col, col * vec3(1.10, 1.02, 0.90), clamp(uBoost, 0.0, 1.0) * 0.35);

  col = mcLinearToSRGB(col);
  col += mcDither(gl_FragCoord.xy) * (1.4 / 255.0);

  gl_FragColor = vec4(col, 1.0);
}`;

export interface PostStack {
  render(dt?: number): void;
  setSize(width?: number, height?: number): void;
  dispose(): void;
  /** 0..1 — drives the radial stretch and the warm push. */
  setBoost(v: number): void;
  setExposure(v: number): void;
  setCloudShadow(v: number): void;
}

const MIPS = 5;

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
  let width = Math.max(2, Math.floor(size.x));
  let height = Math.max(2, Math.floor(size.y));

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
    // No multisampling. Resolving a 4x half-float target costs more than the
    // rest of the stack put together on a software rasteriser, and the frame
    // already carries a soft bloom and a dither that hide most of what MSAA
    // would have caught. Edge quality is bought back with the grade, not with
    // four times the fill rate.
    samples: 0,
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
      uThreshold: { value: 0.95 },
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
    uBloom: { value: 0.24 },
    uVignette: { value: 0.22 },
    uAberration: { value: 0.0009 },
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

  function setSize(): void {
    renderer.getDrawingBufferSize(size);
    const w = Math.max(2, Math.floor(size.x));
    const h = Math.max(2, Math.floor(size.y));
    if (w === width && h === height) return;
    width = w; height = h;
    sceneTarget.setSize(width, height);
    for (let i = 0; i < MIPS; i++) {
      mips[i]!.setSize(Math.max(2, width >> (i + 1)), Math.max(2, height >> (i + 1)));
    }
  }
  setSize();

  function render(): void {
    setSize();

    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();

    // 1. the world, linear and un-tone-mapped (three skips tone mapping and the
    //    output transform entirely when the destination is a render target).
    renderer.autoClear = true;
    renderer.setRenderTarget(sceneTarget);
    renderer.render(ctx.scene, ctx.camera);

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

    // 5. one pass for everything else.
    const cam = ctx.camera;
    (compositeUniforms.uInvProjection!.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    (compositeUniforms.uCamRot!.value as THREE.Matrix3).setFromMatrix4(cam.matrixWorld);
    compositeUniforms.uNear!.value = cam.near;
    compositeUniforms.uFar!.value = cam.far;
    blit(null, compositeMat);

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  return {
    render,
    setSize,
    setBoost(v: number): void { compositeUniforms.uBoost!.value = v; },
    setExposure(v: number): void { compositeUniforms.uExposure!.value = v; },
    setCloudShadow(v: number): void { compositeUniforms.uCloudShadow!.value = v; },
    dispose(): void {
      sceneTarget.dispose();
      depthTexture.dispose();
      for (const m of mips) m.dispose();
      quadGeo.dispose();
      brightMat.dispose();
      downMat.dispose();
      upMat.dispose();
      compositeMat.dispose();
    },
  };
}
