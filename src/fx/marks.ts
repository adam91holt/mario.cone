// Tyre marks.
//
// The only effect in this module that outlives the frame it was made in, and
// the reason a corner still shows what happened in it three seconds later. A
// drift that leaves nothing behind reads as the kart skating; two black arcs
// scribed into the tarmac read as rubber being spent.
//
// One ribbon buffer for the whole field, laid down as a ring of quads. Each
// wheel keeps its last stamped point and stitches a new quad to it once it has
// travelled far enough, which is what keeps the strip continuous through a
// corner instead of dotting it. Age lives in a vertex attribute and the fade is
// computed in the shader against a single clock uniform, so once a segment is
// written it is never touched again — the CPU cost of a mark is the moment it
// is drawn and nothing after it.
//
// Blending is a multiply, exactly like the contact pass: a mark removes light
// from the road rather than painting a grey shape over it, so the asphalt keeps
// its aggregate and its lane paint underneath.

import * as THREE from 'three';
import type { GameContext } from '../types.ts';

/** Metres between stamps. Shorter is smoother and costs quads. */
const STEP = 1.1;
/** Beyond this a racer was moved, not driven — break the ribbon. */
const BREAK = 26;
/**
 * Seconds a mark takes to fade out completely.
 *
 * Long, on purpose. The point of a mark is that a corner still shows what
 * happened in it after the pack has gone through, so the number has to cover a
 * whole lap of traffic rather than one machine's own drift.
 */
const LIFE = 11.0;

const VERT = /* glsl */ `
attribute float aBirth;
attribute float aFade;
attribute float aSide;
attribute vec3 aTint;

uniform float uNow;
uniform float uLife;
uniform float uGamma;

varying float vFade;
varying float vSide;
varying vec3 vTint;

void main() {
  float age = (uNow - aBirth) / uLife;
  vFade = aFade * clamp(1.0 - age, 0.0, 1.0);
  vSide = aSide;
  // With post-processing on this multiply lands on linear radiance; with it off
  // the frame has already been encoded, and the same visual depth needs the
  // transfer function's exponent. Per-vertex, and the tint is flat across a
  // quad, so this is exact and free.
  vTint = pow(aTint, vec3(uGamma));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
varying float vFade;
varying float vSide;
varying vec3 vTint;

void main() {
  // A tyre lays a *patch*, not a hairline. The previous profile was
  // (1 - s^2)^2, which is a spike: it reaches full strength only along the
  // exact centreline and has fallen to a fifth of it a third of the way out, so
  // however wide the quad was, what landed on screen was two pencil strokes.
  // From overhead on tarmac that is indistinguishable from the road's own
  // aggregate, which is exactly how a three-and-a-half second drift managed to
  // leave a track with no memory of it.
  //
  // A plateau with a shoulder instead: full darkness out to half the width,
  // then a soft edge over the remainder. That is the shape of the contact patch
  // of a tyre with a rounded sidewall, and it is what makes the mark read as a
  // band of spent rubber rather than as a scratch.
  float s = abs(vSide);
  float edge = 1.0 - smoothstep(0.46, 1.0, s);
  float a = vFade * edge;
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(vec3(1.0), vTint, a), 1.0);
}`;

interface Track {
  live: boolean;
  x: number; y: number; z: number;
}

export interface TyreMarks {
  readonly mesh: THREE.Mesh;
  /**
   * Offer a contact point for one wheel. Emits a segment only once the wheel
   * has travelled `STEP` from its last stamp.
   *
   * @param id      stable per-wheel key
   * @param nx,ny,nz contact point in world space
   * @param rx,ry,rz unit vector across the strip (the wheel's right)
   */
  stroke(
    id: number,
    nx: number, ny: number, nz: number,
    rx: number, ry: number, rz: number,
    halfWidth: number, strength: number, tint: THREE.Color,
  ): void;
  /** Drop a wheel's continuity, so the next stamp starts a new ribbon. */
  lift(id: number): void;
  update(now: number): void;
  applyQuality(): void;
  reset(): void;
  dispose(): void;
}

export function createTyreMarks(ctx: GameContext, maxQuads: number): TyreMarks {
  const verts = maxQuads * 4;
  const positions = new Float32Array(verts * 3);
  const tints = new Float32Array(verts * 3);
  const births = new Float32Array(verts);
  const fades = new Float32Array(verts);
  const sides = new Float32Array(verts);
  const index = new Uint16Array(maxQuads * 6);

  for (let q = 0; q < maxQuads; q++) {
    const v = q * 4;
    index[q * 6] = v; index[q * 6 + 1] = v + 1; index[q * 6 + 2] = v + 2;
    index[q * 6 + 3] = v; index[q * 6 + 4] = v + 2; index[q * 6 + 5] = v + 3;
    sides[v] = -1; sides[v + 1] = 1; sides[v + 2] = 1; sides[v + 3] = -1;
    // Everything starts fully expired, so a fresh buffer draws nothing.
    births[v] = births[v + 1] = births[v + 2] = births[v + 3] = -1e6;
  }

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const tintAttr = new THREE.BufferAttribute(tints, 3);
  const birthAttr = new THREE.BufferAttribute(births, 1);
  const fadeAttr = new THREE.BufferAttribute(fades, 1);
  for (const a of [posAttr, tintAttr, birthAttr, fadeAttr]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('aTint', tintAttr);
  geo.setAttribute('aBirth', birthAttr);
  geo.setAttribute('aFade', fadeAttr);
  geo.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uNow: { value: 0 },
      uLife: { value: LIFE },
      uGamma: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.MultiplyBlending,
    // Three's multiply path wants a premultiplied source; we write an opaque
    // alpha and a colour that *is* the multiplier, which is what it expects.
    premultipliedAlpha: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'fxTyreMarks';
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  // Under the contact blobs and everything else the fx module draws, over the
  // road. Both are multiplies, so their order between themselves does not
  // matter; what matters is that neither lands on top of a spark.
  mesh.renderOrder = -48;
  mesh.userData.noShadow = true;

  const tracks = new Map<number, Track>();
  let write = 0;
  let written = 0;
  let now = 0;
  let dirtyLo = Infinity;
  let dirtyHi = -Infinity;

  function markDirty(v0: number): void {
    if (v0 < dirtyLo) dirtyLo = v0;
    if (v0 + 4 > dirtyHi) dirtyHi = v0 + 4;
  }

  function quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    rx: number, ry: number, rz: number,
    halfWidth: number, strength: number, tint: THREE.Color,
  ): void {
    const v = write * 4;
    const o = v * 3;
    const hx = rx * halfWidth, hy = ry * halfWidth, hz = rz * halfWidth;
    positions[o] = ax - hx; positions[o + 1] = ay - hy; positions[o + 2] = az - hz;
    positions[o + 3] = ax + hx; positions[o + 4] = ay + hy; positions[o + 5] = az + hz;
    positions[o + 6] = bx + hx; positions[o + 7] = by + hy; positions[o + 8] = bz + hz;
    positions[o + 9] = bx - hx; positions[o + 10] = by - hy; positions[o + 11] = bz - hz;
    for (let k = 0; k < 4; k++) {
      births[v + k] = now;
      fades[v + k] = strength;
      tints[o + k * 3] = tint.r;
      tints[o + k * 3 + 1] = tint.g;
      tints[o + k * 3 + 2] = tint.b;
    }
    markDirty(v);
    write = (write + 1) % maxQuads;
    if (written < maxQuads) written++;
  }

  return {
    mesh,

    stroke(id, nx, ny, nz, rx, ry, rz, halfWidth, strength, tint): void {
      let t = tracks.get(id);
      if (!t) {
        t = { live: false, x: 0, y: 0, z: 0 };
        tracks.set(id, t);
      }
      const dx = nx - t.x, dy = ny - t.y, dz = nz - t.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (!t.live || d2 > BREAK * BREAK) {
        t.live = true;
        t.x = nx; t.y = ny; t.z = nz;
        return;
      }
      if (d2 < STEP * STEP) return;
      quad(t.x, t.y, t.z, nx, ny, nz, rx, ry, rz, halfWidth, strength, tint);
      t.x = nx; t.y = ny; t.z = nz;
    },

    lift(id): void {
      const t = tracks.get(id);
      if (t) t.live = false;
    },

    update(elapsed): void {
      now = elapsed;
      material.uniforms.uNow!.value = elapsed;
      geo.setDrawRange(0, written * 6);
      if (dirtyHi <= dirtyLo) return;
      const lo = dirtyLo, hi = dirtyHi;
      dirtyLo = Infinity; dirtyHi = -Infinity;
      posAttr.addUpdateRange(lo * 3, (hi - lo) * 3);
      tintAttr.addUpdateRange(lo * 3, (hi - lo) * 3);
      birthAttr.addUpdateRange(lo, hi - lo);
      fadeAttr.addUpdateRange(lo, hi - lo);
      posAttr.needsUpdate = true;
      tintAttr.needsUpdate = true;
      birthAttr.needsUpdate = true;
      fadeAttr.needsUpdate = true;
    },

    applyQuality(): void {
      material.uniforms.uGamma!.value = ctx.quality.postfx ? 1 : 1 / 2.2;
    },

    reset(): void {
      tracks.clear();
      write = 0;
      written = 0;
      dirtyLo = Infinity;
      dirtyHi = -Infinity;
      births.fill(-1e6);
      birthAttr.addUpdateRange(0, births.length);
      birthAttr.needsUpdate = true;
      geo.setDrawRange(0, 0);
    },

    dispose(): void {
      geo.dispose();
      material.dispose();
      tracks.clear();
    },
  };
}
