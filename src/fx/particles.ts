// The particle pool.
//
// One flat Float32Array holding every live particle in the game, simulated in a
// single tight loop and emptied into the sprite layers each frame. Structure of
// arrays rather than an array of objects, and swap-remove compaction rather than
// a free list: the loop then walks memory forward and the layer fill is already
// in the order the GPU wants.
//
// Nothing here allocates. `emit` takes a caller-owned spec object that the
// caller reuses — every emitter in this module keeps one preset and mutates the
// three or four fields that actually vary per particle. A pool that allocated a
// descriptor per spark would allocate about ten thousand of them a second at the
// head of a pack of eight drifting karts.
//
// The pool is a *visual* system. It is stepped from `update`, never from
// `fixedUpdate`, and it draws its randomness from its own generator rather than
// `ctx.rng` — reaching into the simulation's stream from a render-rate loop
// would make the number of frames drawn change who wins the race.

import * as THREE from 'three';
import type { Rng } from '../core/math.ts';
import type { SpriteLayer } from './sprites.ts';
import { MODE } from './sprites.ts';

/**
 * A particle description. Reused by the caller between emissions — treat it as
 * a register bank, not a value.
 */
export interface ParticleSpec {
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  /** Seconds. */
  life: number;
  /** Diameter in metres at birth and at death. */
  size0: number;
  size1: number;
  /** Linear scene-referred colour. Values above 1 bloom. */
  color0: THREE.Color;
  color1: THREE.Color;
  /** Peak opacity. */
  alpha: number;
  rot: number;
  rotVel: number;
  /** m/s^2 downward. Negative floats the particle upward. */
  gravity: number;
  /** Exponential velocity decay, 1/s. */
  drag: number;
  /** Metres of extra half-length per m/s of *camera-relative* speed, applied in
   *  the vertex shader. 0 for a round sprite. Only meaningful with
   *  `mode: MODE.velocity`. */
  stretch: number;
  /** Fraction of life spent fading in. */
  fadeIn: number;
  cell: number;
  mode: number;
  /** Additive layer (sparks, flame, light) or alpha layer (dust, confetti). */
  additive: boolean;
}

/** A spec with sensible defaults, ready to be specialised by an emitter. */
export function makeSpec(over: Partial<ParticleSpec> = {}): ParticleSpec {
  const spec: ParticleSpec = {
    px: 0, py: 0, pz: 0,
    vx: 0, vy: 0, vz: 0,
    life: 0.5,
    size0: 0.3, size1: 0.3,
    color0: new THREE.Color(1, 1, 1),
    color1: new THREE.Color(1, 1, 1),
    alpha: 1,
    rot: 0, rotVel: 0,
    gravity: 0, drag: 0,
    stretch: 0, fadeIn: 0,
    cell: 0, mode: MODE.billboard,
    additive: true,
  };
  Object.assign(spec, over);
  return spec;
}

const S = {
  px: 0, py: 1, pz: 2,
  vx: 3, vy: 4, vz: 5,
  age: 6, life: 7,
  size0: 8, size1: 9,
  r0: 10, g0: 11, b0: 12,
  r1: 13, g1: 14, b1: 15,
  alpha: 16,
  rot: 17, rotVel: 18,
  gravity: 19, drag: 20,
  stretch: 21, fadeIn: 22,
  code: 23,
} as const;
const STRIDE = 24;

/** `code` packs the atlas cell, the quad mode and the target layer. */
const ADDITIVE_BIT = 64;

export interface ParticlePool {
  readonly count: number;
  readonly capacity: number;
  /** 0..1 how full the pool is. Emitters throttle themselves on this. */
  readonly load: number;
  emit(spec: ParticleSpec): boolean;
  /** Emit `n` copies, scattering direction and speed through `rng`. */
  burst(spec: ParticleSpec, n: number, speed: number, spread: number, rng: Rng): void;
  update(dt: number): void;
  fill(additive: SpriteLayer, alpha: SpriteLayer): void;
  clear(): void;
}

export function createParticlePool(capacity: number): ParticlePool {
  const data = new Float32Array(capacity * STRIDE);
  let count = 0;

  function emit(spec: ParticleSpec): boolean {
    if (count >= capacity) return false;
    const o = count * STRIDE;
    data[o + S.px] = spec.px; data[o + S.py] = spec.py; data[o + S.pz] = spec.pz;
    data[o + S.vx] = spec.vx; data[o + S.vy] = spec.vy; data[o + S.vz] = spec.vz;
    data[o + S.age] = 0;
    data[o + S.life] = spec.life;
    data[o + S.size0] = spec.size0;
    data[o + S.size1] = spec.size1;
    data[o + S.r0] = spec.color0.r; data[o + S.g0] = spec.color0.g; data[o + S.b0] = spec.color0.b;
    data[o + S.r1] = spec.color1.r; data[o + S.g1] = spec.color1.g; data[o + S.b1] = spec.color1.b;
    data[o + S.alpha] = spec.alpha;
    data[o + S.rot] = spec.rot;
    data[o + S.rotVel] = spec.rotVel;
    data[o + S.gravity] = spec.gravity;
    data[o + S.drag] = spec.drag;
    data[o + S.stretch] = spec.stretch;
    data[o + S.fadeIn] = spec.fadeIn;
    data[o + S.code] = spec.cell + spec.mode * 8 + (spec.additive ? ADDITIVE_BIT : 0);
    count++;
    return true;
  }

  /**
   * A radial burst. The spec supplies the origin, the look and any bulk
   * velocity already written into `vx/vy/vz`; this adds a scattered direction on
   * top and restores the spec afterwards so the caller's preset survives.
   */
  function burst(spec: ParticleSpec, n: number, speed: number, spread: number, rng: Rng): void {
    const bx = spec.vx, by = spec.vy, bz = spec.vz;
    const life = spec.life;
    const size = spec.size0;
    for (let i = 0; i < n; i++) {
      // Uniform on a sphere, then squashed toward the horizontal by `spread`.
      const a = rng.next() * Math.PI * 2;
      const z = rng.range(-1, 1) * spread;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const s = speed * rng.range(0.45, 1);
      spec.vx = bx + Math.cos(a) * r * s;
      spec.vy = by + z * s;
      spec.vz = bz + Math.sin(a) * r * s;
      spec.life = life * rng.range(0.7, 1.25);
      spec.size0 = size * rng.range(0.7, 1.3);
      spec.rot = rng.next() * Math.PI * 2;
      if (!emit(spec)) break;
    }
    spec.vx = bx; spec.vy = by; spec.vz = bz;
    spec.life = life;
    spec.size0 = size;
  }

  function update(dt: number): void {
    let i = 0;
    while (i < count) {
      const o = i * STRIDE;
      const age = data[o + S.age] + dt;
      if (age >= data[o + S.life]) {
        // Swap-remove: the tail moves into the hole and is visited next pass.
        count--;
        if (i !== count) data.copyWithin(o, count * STRIDE, count * STRIDE + STRIDE);
        continue;
      }
      data[o + S.age] = age;

      const drag = data[o + S.drag];
      if (drag > 0) {
        const k = Math.exp(-drag * dt);
        data[o + S.vx] *= k;
        data[o + S.vy] *= k;
        data[o + S.vz] *= k;
      }
      data[o + S.vy] -= data[o + S.gravity] * dt;

      data[o + S.px] += data[o + S.vx] * dt;
      data[o + S.py] += data[o + S.vy] * dt;
      data[o + S.pz] += data[o + S.vz] * dt;
      data[o + S.rot] += data[o + S.rotVel] * dt;
      i++;
    }
  }

  function fill(additive: SpriteLayer, alpha: SpriteLayer): void {
    for (let i = 0; i < count; i++) {
      const o = i * STRIDE;
      const u = data[o + S.age] / data[o + S.life];

      // Fade in over the head of the life, then out on a quadratic tail. The
      // curve matters: a linear fade-out makes every puff of dust vanish at a
      // measurable instant, and the eye finds that instant every time.
      const fadeIn = data[o + S.fadeIn];
      let a = data[o + S.alpha];
      if (u < fadeIn) {
        a *= u / fadeIn;
      } else {
        const t = 1 - (u - fadeIn) / Math.max(1e-4, 1 - fadeIn);
        a *= t * t;
      }
      if (a < 0.004) continue;

      const r = data[o + S.r0] + (data[o + S.r1] - data[o + S.r0]) * u;
      const g = data[o + S.g0] + (data[o + S.g1] - data[o + S.g0]) * u;
      const b = data[o + S.b0] + (data[o + S.b1] - data[o + S.b0]) * u;
      const size = data[o + S.size0] + (data[o + S.size1] - data[o + S.size0]) * u;

      const code = data[o + S.code];
      const isAdd = code >= ADDITIVE_BIT;
      const packed = isAdd ? code - ADDITIVE_BIT : code;
      const mode = Math.floor(packed / 8);
      const cell = packed - mode * 8;

      // `stretch` goes across as the raw coefficient. Turning it into a length
      // needs the camera's velocity, which only the shader has — and doing it
      // here against world speed is what used to make every spark riding along
      // with the chase camera into a long dash pointing nowhere.
      const layer = isAdd ? additive : alpha;
      layer.push(
        data[o + S.px], data[o + S.py], data[o + S.pz],
        data[o + S.vx], data[o + S.vy], data[o + S.vz],
        r, g, b, a,
        size, data[o + S.stretch], data[o + S.rot],
        cell, mode,
      );
    }
  }

  return {
    get count() { return count; },
    capacity,
    get load() { return count / capacity; },
    emit,
    burst,
    update,
    fill,
    clear(): void { count = 0; },
  };
}
