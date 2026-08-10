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
/**
 * Hardest a single stroke may ever be.
 *
 * A mark is rubber left on a road, and rubber on a road is a *shade*, not a
 * hole. At full strength the multiply landed on 0.15 of the surface value,
 * which over sunlit asphalt is very nearly black — and a capture of a committed
 * slide at 77 m/s came back with a row of solid black parallelograms lying on
 * the tarmac. The shape gave it away as much as the tone: a strip that dark has
 * *ends*, and ends are the one thing a skid mark must never have.
 */
const MAX_FADE = 0.62;
/**
 * Quads a fresh ribbon spends ramping up to full strength.
 *
 * The ends are the other half of the same defect. A ribbon breaks whenever the
 * wheel leaves the ground — which at racing pace happens several times a
 * corner — and each restart used to stamp its first quad at full darkness, so
 * what the road actually collected was a scattering of hard-edged black slabs
 * rather than one arc that comes and goes. Fading the first couple of metres in
 * costs two multiplies and turns every break into a taper.
 */
const RUN_IN = 2;
/**
 * ...and the quads a ribbon spends ramping back *down* when the wheel lifts.
 *
 * The other end of the same defect, and the half that was missing. `RUN_IN`
 * turned every restart into a taper and left every *finish* as a transverse
 * cut at full strength — so a corner collected arcs that faded in beautifully
 * and then stopped dead, and the thing a 9x crop found on the tarmac was a
 * straight black edge exactly one quad wide, square across the direction of
 * travel. A tyre stops laying rubber the way it starts: by running out.
 *
 * Done by reaching back and re-weighting the last few quads rather than by
 * stamping a new one, because there is nothing left to stamp — the wheel has
 * already gone.
 */
const RUN_OUT = 3;
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
  // Softer shoulders than the old 0.46 plateau. A stroke laid at speed is a
  // long thin quad, and a plateau that wide gives its two long sides a
  // hard-looking boundary against the road — which is what turned a row of
  // strokes into a row of slabs. Rubber laid by a rounded sidewall has no
  // boundary at all: it just runs out.
  float s = abs(vSide);
  float edge = 1.0 - smoothstep(0.20, 1.0, s);
  float a = vFade * edge;
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(vec3(1.0), vTint, a), 1.0);
}`;

interface Track {
  live: boolean;
  x: number; y: number; z: number;
  /** Quads laid since this ribbon started, capped at `RUN_IN`. */
  run: number;
  /**
   * Ring-buffer slots of this ribbon's last few quads, newest last, so `lift`
   * can taper them out. Fixed length `RUN_OUT` and reused in place — a ribbon
   * per wheel per racer means sixteen of these and none of them may allocate
   * while the game is running.
   */
  tail: Int32Array;
  /** ...and the stamp id each of those slots carried when this ribbon wrote
   *  it. A slot another wheel has since overwritten fails the check and is
   *  left alone, which is what keeps a taper from erasing somebody else's
   *  mark once the buffer has wrapped. */
  tailStamp: Int32Array;
  tailCount: number;
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
  /** Which ribbon last wrote each ring-buffer slot. See `Track.tailStamp`. */
  const owner = new Int32Array(maxQuads).fill(-1);
  let stamp = 0;
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
    t: Track,
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
    // Remember who laid this slot, and hand the ribbon its slot back so `lift`
    // can find it again. Newest last; the oldest falls off the front.
    stamp++;
    owner[write] = stamp;
    if (t.tailCount < RUN_OUT) {
      t.tail[t.tailCount] = write;
      t.tailStamp[t.tailCount] = stamp;
      t.tailCount++;
    } else {
      for (let k = 1; k < RUN_OUT; k++) {
        t.tail[k - 1] = t.tail[k]!;
        t.tailStamp[k - 1] = t.tailStamp[k]!;
      }
      t.tail[RUN_OUT - 1] = write;
      t.tailStamp[RUN_OUT - 1] = stamp;
    }
    write = (write + 1) % maxQuads;
    if (written < maxQuads) written++;
  }

  /**
   * Fade a ribbon's last few quads out, so it runs out instead of stopping.
   *
   * The ramp is applied to whatever strength each quad already carries rather
   * than to a fresh value: the last quads of a short ribbon are still inside
   * the run-*in*, and multiplying keeps the two tapers from fighting.
   */
  function runOut(t: Track): void {
    const n = t.tailCount;
    for (let i = 0; i < n; i++) {
      const slot = t.tail[i]!;
      if (owner[slot] !== t.tailStamp[i]) continue;   // overwritten since
      const k = 1 - (i + 1) / (n + 1);                // oldest keeps most
      const v = slot * 4;
      for (let c = 0; c < 4; c++) fades[v + c] = (fades[v + c] ?? 0) * k;
      markDirty(v);
    }
    t.tailCount = 0;
  }

  return {
    mesh,

    stroke(id, nx, ny, nz, rx, ry, rz, halfWidth, strength, tint): void {
      let t = tracks.get(id);
      if (!t) {
        t = {
          live: false, x: 0, y: 0, z: 0, run: 0,
          tail: new Int32Array(RUN_OUT), tailStamp: new Int32Array(RUN_OUT), tailCount: 0,
        };
        tracks.set(id, t);
      }
      const dx = nx - t.x, dy = ny - t.y, dz = nz - t.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (!t.live || d2 > BREAK * BREAK) {
        // A teleport breaks the ribbon exactly as a lift does, so it gets the
        // same run-out — otherwise a reset or a rescue leaves a full-strength
        // stub on the road where the machine used to be.
        if (t.live) runOut(t);
        t.live = true;
        t.run = 0;
        t.tailCount = 0;
        t.x = nx; t.y = ny; t.z = nz;
        return;
      }
      if (d2 < STEP * STEP) return;
      // Ramp the head of a ribbon in, and never let one reach full black.
      const ramp = t.run >= RUN_IN ? 1 : (t.run + 1) / (RUN_IN + 1);
      const s = strength * ramp * MAX_FADE;
      if (t.run < RUN_IN) t.run++;
      quad(t, t.x, t.y, t.z, nx, ny, nz, rx, ry, rz, halfWidth, s, tint);
      t.x = nx; t.y = ny; t.z = nz;
    },

    lift(id): void {
      const t = tracks.get(id);
      if (!t || !t.live) return;
      runOut(t);
      t.live = false;
      t.run = 0;
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
      owner.fill(-1);
      stamp = 0;
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
