// The one primitive everything in this module draws with.
//
// A sprite layer is a single InstancedBufferGeometry that is rewritten from
// scratch every frame: reset, push as many quads as you like, commit. One draw
// call, one program, one texture — whether that frame contained four sprites or
// two thousand.
//
// Rewriting rather than persisting is deliberate. Particles die and are
// compacted, immediate-mode sprites (wheel glows, spin-out stars, the flare on
// a mini-turbo lock) exist for exactly one frame, and both want to end up in the
// same buffer. Trying to keep stable instance slots for that mix costs more
// bookkeeping than simply refilling a typed array, which is a memcpy the GPU is
// going to read linearly anyway.
//
// Three quad orientations, chosen per instance:
//
//   billboard  faces the camera, its long axis set by an explicit rotation.
//              Speed lines use this: the angle is the screen-space direction
//              away from the vanishing point, which no world-space velocity can
//              express.
//   ground     lies flat in the world XZ plane. Shock rings, boost scorches and
//              the pools of light under a drifting kart's wheels — anything
//              that has to read as being *on* the road rather than in front of
//              it.
//   velocity   faces the camera and stretches along its own motion *relative to
//              the camera*, projected into screen space. This is what makes a
//              spark a streak.
//
// That "relative to the camera" is the whole trick. A spark thrown off a kart
// doing 60 m/s is, in world space, also doing about 60 m/s — but so is the
// camera chasing it, so on screen it barely moves and must not streak. Stretch
// it by its world speed and every spark in the game becomes a two-metre dash
// pointing wherever the world happens to be flowing. Subtracting the camera's
// own velocity first makes the streak length equal to the distance the particle
// actually travels across the frame, which is the only definition that looks
// right from a chase camera *and* from a stationary one.

import * as THREE from 'three';

/** Quad orientation. Packed into an instance attribute alongside the cell. */
export const MODE = {
  billboard: 0,
  ground: 1,
  velocity: 2,
} as const;

export type SpriteMode = (typeof MODE)[keyof typeof MODE];

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iColor;
/** x size (diameter, metres), z rotation, w cell + mode*8.
 *  y is extra half-length in metres — except in velocity mode, where it is
 *  metres of half-length per m/s of camera-relative speed. */
attribute vec4 iParams;

/** The camera's own world velocity, so a streak can be measured against the
 *  frame rather than against the world. */
uniform vec3 uCamVel;

varying vec2 vUv;
varying vec4 vColor;

void main() {
  float packed = iParams.w;
  float mode = floor(packed * 0.125);
  float cell = packed - mode * 8.0;

  // Named rad, not half: "half" is a reserved word in GLSL ES.
  float rad = iParams.x * 0.5;
  float along = rad + iParams.y;
  float rot = iParams.z;
  vec2 corner = position.xy * 2.0;   // the base quad is +/-0.5

  vec4 mv;
  if (mode > 0.5 && mode < 1.5) {
    // Flat on the ground. Built in world space so the quad stays welded to the
    // road no matter where the lens is.
    float s = sin(rot), c = cos(rot);
    vec2 p = vec2(corner.x * along, corner.y * rad);
    vec3 offset = vec3(p.x * c - p.y * s, 0.0, p.x * s + p.y * c);
    mv = modelViewMatrix * vec4(iPos + offset, 1.0);
  } else {
    mv = modelViewMatrix * vec4(iPos, 1.0);
    vec2 ax = vec2(cos(rot), sin(rot));
    if (mode > 1.5) {
      // Along its own travel *through the frame*, measured in view space, so
      // the streak lies on the screen-space path the particle is really taking
      // and is exactly as long as the ground it covers while the shutter is
      // open. A spark keeping pace with the chase camera stays a point.
      vec3 vv = (modelViewMatrix * vec4(iVel - uCamVel, 0.0)).xyz;
      float vl = length(vv.xy);
      along = rad + iParams.y * vl;
      if (vl > 1e-4) ax = vv.xy / vl;
    }
    vec2 ay = vec2(-ax.y, ax.x);
    mv.xy += ax * (corner.x * along) + ay * (corner.y * rad);
  }

  gl_Position = projectionMatrix * mv;

  float col = mod(cell, 4.0);
  float row = floor(cell * 0.25);
  vUv = (uv + vec2(col, 1.0 - row)) * vec2(0.25, 0.5);
  vColor = iColor;
}`;

const FRAG = /* glsl */ `
uniform sampler2D tAtlas;
varying vec2 vUv;
varying vec4 vColor;

void main() {
  vec4 t = texture2D(tAtlas, vUv);
  float a = t.a * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * t.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface SpriteLayerOptions {
  name: string;
  atlas: THREE.Texture;
  capacity: number;
  blending: THREE.Blending;
  renderOrder: number;
  /** Off for the rush layer, which is a screen effect and may not be occluded. */
  depthTest?: boolean;
}

export interface SpriteLayer {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  readonly count: number;
  /** True once the layer is full — callers should stop pushing. */
  readonly full: boolean;
  reset(): void;
  push(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    r: number, g: number, b: number, a: number,
    size: number, stretch: number, rot: number,
    cell: number, mode: number,
  ): void;
  /** The camera's world velocity this frame. Velocity-mode quads streak against
   *  it, so a particle riding along with the chase camera stays a point. */
  setCameraVelocity(x: number, y: number, z: number): void;
  commit(): void;
  dispose(): void;
}

export function createSpriteLayer(opts: SpriteLayerOptions): SpriteLayer {
  const cap = opts.capacity;

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1,
  ]), 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);

  const posData = new Float32Array(cap * 3);
  const velData = new Float32Array(cap * 3);
  const colData = new Float32Array(cap * 4);
  const parData = new Float32Array(cap * 4);

  const posAttr = new THREE.InstancedBufferAttribute(posData, 3);
  const velAttr = new THREE.InstancedBufferAttribute(velData, 3);
  const colAttr = new THREE.InstancedBufferAttribute(colData, 4);
  const parAttr = new THREE.InstancedBufferAttribute(parData, 4);
  for (const a of [posAttr, velAttr, colAttr, parAttr]) a.setUsage(THREE.DynamicDrawUsage);

  geo.setAttribute('iPos', posAttr);
  geo.setAttribute('iVel', velAttr);
  geo.setAttribute('iColor', colAttr);
  geo.setAttribute('iParams', parAttr);
  geo.instanceCount = 0;
  // The quads live wherever the effect put them, which is nowhere the bounding
  // volume of a unit quad would suggest. Culling is off; the layer is one draw
  // call and always on screen somewhere.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const camVel = new THREE.Vector3();
  const material = new THREE.ShaderMaterial({
    uniforms: { tAtlas: { value: opts.atlas }, uCamVel: { value: camVel } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: opts.depthTest !== false,
    blending: opts.blending,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = opts.name;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = opts.renderOrder;
  mesh.userData.noShadow = true;
  mesh.visible = false;

  let count = 0;

  return {
    mesh,
    capacity: cap,
    get count() { return count; },
    get full() { return count >= cap; },

    reset(): void {
      count = 0;
    },

    push(x, y, z, vx, vy, vz, r, g, b, a, size, stretch, rot, cell, mode): void {
      if (count >= cap) return;
      const i3 = count * 3;
      const i4 = count * 4;
      posData[i3] = x; posData[i3 + 1] = y; posData[i3 + 2] = z;
      velData[i3] = vx; velData[i3 + 1] = vy; velData[i3 + 2] = vz;
      colData[i4] = r; colData[i4 + 1] = g; colData[i4 + 2] = b; colData[i4 + 3] = a;
      parData[i4] = size; parData[i4 + 1] = stretch; parData[i4 + 2] = rot;
      parData[i4 + 3] = cell + mode * 8;
      count++;
    },

    setCameraVelocity(x, y, z): void {
      camVel.set(x, y, z);
    },

    commit(): void {
      geo.instanceCount = count;
      mesh.visible = count > 0;
      if (count === 0) return;
      posAttr.addUpdateRange(0, count * 3);
      velAttr.addUpdateRange(0, count * 3);
      colAttr.addUpdateRange(0, count * 4);
      parAttr.addUpdateRange(0, count * 4);
      posAttr.needsUpdate = true;
      velAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      parAttr.needsUpdate = true;
    },

    dispose(): void {
      geo.dispose();
      material.dispose();
    },
  };
}
