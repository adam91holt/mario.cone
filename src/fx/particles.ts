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
  /**
   * How much of the frame the *veil* — everything on the alpha layer — actually
   * covered last time it was filled, as a sum of solid angles weighted by
   * opacity. 1.0 is roughly one full screen covered once at full opacity.
   *
   * The number this module was missing. Every previous pass tuned dust and
   * smoke by adjusting fifteen separate alphas and rates against a screenshot,
   * which works for the one frame it was tuned on and for no other: put eight
   * machines in a hairpin, or drop the frame rate so each emission is fatter,
   * or drive onto a surface with a different table row, and the same numbers
   * produce a windscreen nobody has wiped. Measuring the thing that actually
   * fails means the emitters can be governed against it directly.
   */
  readonly veil: number;
  emit(spec: ParticleSpec): boolean;
  /** Emit `n` copies, scattering direction and speed through `rng`. */
  burst(spec: ParticleSpec, n: number, speed: number, spread: number, rng: Rng): void;
  update(dt: number): void;
  /**
   * Where the lens is this frame, so `fill` can dissolve anything that gets
   * into it. See the note on the fade in `fill`.
   */
  setCamera(x: number, y: number, z: number): void;
  fill(additive: SpriteLayer, alpha: SpriteLayer): void;
  clear(): void;
}

/**
 * The near-camera dissolve band, in metres. An opaque-layer particle is at full
 * strength beyond `NEAR_FAR` and gone by `NEAR_NEAR`.
 *
 * This exists because of a defect that no amount of per-emitter tuning can
 * reach. Every continuous emitter in the module throws its output *backwards*
 * relative to the machine, the chase camera sits six to eight metres behind
 * that machine, and so sooner or later some of that output arrives at the lens.
 * A dust puff a metre from the camera is a soft disc covering a quarter of the
 * frame; twenty of them is a race being played behind frosted glass, which is
 * exactly what the review frames caught — fifteen to twenty translucent discs
 * over the sky, the mountains and the HUD while the player was in an ordinary
 * drift.
 *
 * Additive particles are deliberately exempt. A flame plume is *meant* to be
 * able to reach the camera and wash the frame warm, and it brightens rather
 * than obscures. This is only ever about things that hide the game.
 */
const NEAR_NEAR = 2.2;
const NEAR_FAR = 6.0;

/**
 * The angular governor, in radians of apparent diameter.
 *
 * The metric dissolve above is not enough on its own, and the arithmetic says
 * why: a 2.4m puff sitting 3.1m from the lens — just outside `NEAR_FAR`, so at
 * *full* opacity — subtends 43°, which on a 90° frame is half the picture. A
 * measured capture of an ordinary tier-one drift came back with the sky, the
 * mountains, the road and the HUD behind six of them. Distance is the wrong
 * variable: what matters is how much of the frame one sprite owns, and that is
 * `size / distance` whatever combination of the two produced it.
 *
 * So an alpha-layer sprite fades out as its apparent diameter grows past
 * `ANG_SOFT` (15°) and is gone by `ANG_HARD` (36°), and its drawn diameter is
 * capped at `ANG_CLAMP` on the way. Nothing on the alpha layer can obscure the
 * game no matter what an emitter asks for — which is a guarantee, not a tuning
 * pass, and it is the only kind of answer that survives the next set of numbers
 * somebody types into the surface table.
 *
 * Additive particles get the same treatment at roughly twice the size. They are
 * not exempt, and believing they were is how the alpha layer got fixed and the
 * frame stayed unreadable: with the dust under control, a measured drift at 77
 * km/h had **thirty-one** additive quads inside twelve metres covering five
 * thousand square degrees between them — against a frame worth about four and a
 * half thousand. A shock ring fourteen metres across and a lock-in flare six
 * metres across are not "washing the frame warm", they are painting it out. The
 * looser ceiling is the real difference between the two layers: a flame plume
 * genuinely may fill the picture with light, so it is allowed to get twice as
 * big before anything happens to it.
 */
const ANG_SOFT = 0.26;
const ANG_HARD = 0.62;
const ANG_CLAMP = 0.50;
const ANG_SOFT_ADD = 0.55;
const ANG_HARD_ADD = 1.20;
const ANG_CLAMP_ADD = 1.00;

/**
 * Below this apparent diameter a sprite is not worth drawing, in radians.
 *
 * 1.6 milliradians is about one pixel on a 900-line frame — a sprite that
 * cannot resolve to more than a single dim pixel, which after the alpha ramp is
 * a pixel nobody will ever see. Measured on a drift with the field strung out,
 * **1247 of the additive layer's 1969 instances were past forty metres** and
 * contributed one part in a hundred and forty of its coverage between them.
 * That is half the layer's capacity, half its fill rate and half its buffer
 * upload spent on nothing, and worse, it is capacity the effects at the player's
 * own wheels have to compete for when the pool gets busy.
 */
const ANG_MIN = 0.0016;

export function createParticlePool(capacity: number): ParticlePool {
  const data = new Float32Array(capacity * STRIDE);
  let count = 0;
  let camX = 0, camY = 0, camZ = 0;
  let veil = 0;

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
    veil = 0;
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

      const code = data[o + S.code];
      const isAdd = code >= ADDITIVE_BIT;
      let size = data[o + S.size0] + (data[o + S.size1] - data[o + S.size0]) * u;
      const dx = data[o + S.px] - camX;
      const dy = data[o + S.py] - camY;
      const dz = data[o + S.pz] - camZ;
      const d2 = dx * dx + dy * dy + dz * dz;
      const d = Math.sqrt(d2);
      if (!isAdd) {
        // Dissolve anything that has wandered into the lens.
        if (d2 < NEAR_FAR * NEAR_FAR) {
          if (d2 <= NEAR_NEAR * NEAR_NEAR) continue;
          const t = (d - NEAR_NEAR) / (NEAR_FAR - NEAR_NEAR);
          a *= t * t;
          if (a < 0.004) continue;
        }
      }
      const packed = isAdd ? code - ADDITIVE_BIT : code;
      const mode = Math.floor(packed / 8);
      const cell = packed - mode * 8;

      // ...and cut down anything that has grown to own the frame, wherever it
      // happens to be. See the note on the angular governor above.
      //
      // Ground quads are exempt, and the exemption is geometric rather than a
      // favour: they lie flat in the world, so a chase camera looking twelve
      // degrees down foreshortens them to about a quarter of their length and
      // `size / distance` overstates what they actually cover by four to one.
      // They also cannot do the thing the governor exists to prevent — a quad
      // welded to the road can never hover in front of the lens — and they are
      // the module's whole vocabulary for *contact*, which is the one thing the
      // art direction says may never be traded away.
      const soft = isAdd ? ANG_SOFT_ADD : ANG_SOFT;
      const ang = size / (d > 0.5 ? d : 0.5);
      // Too small to resolve. Velocity-mode quads get a third of the threshold
      // rather than an exemption: their length comes from the stretch in the
      // vertex shader, which this cannot see, so a distant spark is longer than
      // its diameter suggests — but not thirty times longer, and past a certain
      // range it is a dim sub-pixel dash like everything else.
      if (ang < (mode === MODE.velocity ? ANG_MIN * 0.34 : ANG_MIN)) continue;
      if (mode !== MODE.ground && ang > soft) {
        const hard = isAdd ? ANG_HARD_ADD : ANG_HARD;
        if (ang >= hard) continue;
        const t = (hard - ang) / (hard - soft);
        a *= t * t;
        if (a < 0.004) continue;
        const cap = isAdd ? ANG_CLAMP_ADD : ANG_CLAMP;
        if (ang > cap) size = d * cap;
      }
      if (!isAdd) {
        // What this sprite is about to cost the frame, in steradian-ish units.
        // Cheap: two multiplies on a number already in a register.
        const cover = size / (d > 1 ? d : 1);
        veil += cover * cover * a;
      }

      const r = data[o + S.r0] + (data[o + S.r1] - data[o + S.r0]) * u;
      const g = data[o + S.g0] + (data[o + S.g1] - data[o + S.g0]) * u;
      const b = data[o + S.b0] + (data[o + S.b1] - data[o + S.b0]) * u;

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
    get veil() { return veil; },
    emit,
    burst,
    update,
    setCamera(x: number, y: number, z: number): void { camX = x; camY = y; camZ = z; },
    fill,
    clear(): void { count = 0; veil = 0; },
  };
}
