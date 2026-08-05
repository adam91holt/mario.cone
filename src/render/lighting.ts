// Lighting and sky.
//
// Warm key, cool fill, strong ambient occlusion-ish bounce. The goal is the
// Nintendo look: saturated, high-key, everything readable, nothing muddy. The
// shadow camera follows the player so a modest map covers the visible area at
// high resolution instead of blurring across the whole course.

import * as THREE from 'three';
import type { CourseTheme, GameContext, GameSystem } from '../types.ts';

const SKY_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vWorld;

void main() {
  vec3 dir = normalize(vWorld);
  float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);

  // Two-stage gradient: a tight warm band at the horizon under a deep zenith.
  float horizonBand = pow(1.0 - abs(dir.y), 5.0);
  vec3 col = mix(uBottom, uTop, pow(h, 0.72));
  col = mix(col, uHorizon, horizonBand * 0.65);

  // A soft sun bloom baked into the sky itself — cheaper and cleaner than
  // running a lens flare, and it gives the horizon somewhere to look.
  float sun = max(dot(dir, normalize(uSunDir)), 0.0);
  col += uSunColor * pow(sun, 220.0) * 1.6;
  col += uSunColor * pow(sun, 12.0) * 0.10;

  gl_FragColor = vec4(col, 1.0);
}`;

export function createLightingSystem(ctx: GameContext): GameSystem {
  const group = new THREE.Group();
  group.name = 'lighting';

  const sun = new THREE.DirectionalLight(0xfff2d8, 2.6);
  sun.castShadow = ctx.quality.shadows;
  const shadowExtent = 90;
  sun.shadow.mapSize.set(ctx.quality.shadowSize, ctx.quality.shadowSize);
  sun.shadow.camera.left = -shadowExtent;
  sun.shadow.camera.right = shadowExtent;
  sun.shadow.camera.top = shadowExtent;
  sun.shadow.camera.bottom = -shadowExtent;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 420;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  group.add(sun);
  group.add(sun.target);

  // Sky/ground hemisphere does the cool-fill half of the key/fill pair.
  const hemi = new THREE.HemisphereLight(0xbfe7ff, 0x8a6b3f, 1.15);
  group.add(hemi);

  // A dim rim from behind keeps silhouettes separated from the background.
  const rim = new THREE.DirectionalLight(0xbfd8ff, 0.55);
  rim.position.set(-0.5, 0.4, -1);
  group.add(rim);

  const skyUniforms = {
    uTop: { value: new THREE.Color(0x2e86d6) },
    uBottom: { value: new THREE.Color(0xbfe7ff) },
    uHorizon: { value: new THREE.Color(0xffe2b0) },
    uSunDir: { value: new THREE.Vector3(0.7, 0.6, 0.4) },
    uSunColor: { value: new THREE.Color(0xfff2d8) },
  };

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(2000, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    }),
  );
  sky.name = 'sky';
  sky.frustumCulled = false;

  function applyTheme(theme: CourseTheme): void {
    const s = theme.sky;
    if (s) {
      skyUniforms.uTop.value.setHex(s.top);
      skyUniforms.uBottom.value.setHex(s.bottom);
      skyUniforms.uHorizon.value.setHex(s.horizon ?? s.bottom);
      hemi.color.setHex(s.bottom);
    }
    const su = theme.sun;
    if (su) {
      sun.color.setHex(su.color);
      sun.intensity = su.intensity;
      skyUniforms.uSunColor.value.setHex(su.color);
      const az = su.azimuth, el = su.elevation;
      const dir = new THREE.Vector3(
        Math.cos(el) * Math.cos(az),
        Math.sin(el),
        Math.cos(el) * Math.sin(az)).normalize();
      skyUniforms.uSunDir.value.copy(dir);
      sun.position.copy(dir).multiplyScalar(160);
    }
    const f = theme.fog;
    if (f) {
      ctx.scene.fog = new THREE.Fog(f.color, f.near, f.far);
    } else {
      ctx.scene.fog = null;
    }
  }

  ctx.bus.on<{ track: { theme: CourseTheme } }>('track:built', ({ track }) => applyTheme(track.theme));

  return {
    name: 'lighting',
    order: 25,

    init(): void {
      ctx.scene.add(group);
      ctx.scene.add(sky);
      if (ctx.track) applyTheme(ctx.track.theme);
    },

    update(): void {
      // Keep the shadow frustum centred on the action.
      const focus = ctx.player ?? ctx.racers[0];
      if (focus) {
        sun.target.position.copy(focus.pos);
        sun.position.copy(focus.pos).add(
          skyUniforms.uSunDir.value.clone().multiplyScalar(160));
        sun.target.updateMatrixWorld();
      }
      sky.position.copy(ctx.camera.position);
    },

    dispose(): void {
      ctx.scene.remove(group);
      ctx.scene.remove(sky);
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
    },
  };
}
