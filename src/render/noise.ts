// Procedural, seamlessly tiling noise, baked once on the CPU.
//
// The sky needs several octaves of fbm plus a light-direction lookup per pixel.
// Evaluating that as hash noise in the fragment shader costs ~80 ALU ops on a
// pixel that is *background*, which is the wrong place to spend a frame — and
// it is unaffordable outright on the software renderer the review harness uses.
// Baking it into one 256² RGBA texture turns the whole cloud field into four
// texture fetches.
//
// Everything here is deterministic: an integer hash, no Math.random, no clock.

import * as THREE from 'three';

/** 32-bit integer hash. Same input, same output, on every machine. */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** Value noise on a lattice of period `p`, so sampling u,v in [0,1) tiles. */
function vnoise(x: number, y: number, p: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % p) + p) % p, x1 = (x0 + 1) % p;
  const y0 = ((yi % p) + p) % p, y1 = (y0 + 1) % p;
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

interface FbmOpts {
  base: number;
  octaves: number;
  gain?: number;
  seed?: number;
  /** Fold the noise around 0.5 for the cauliflower edges clouds actually have. */
  billow?: boolean;
}

function fbm(u: number, v: number, o: FbmOpts): number {
  const gain = o.gain ?? 0.5;
  let freq = o.base, amp = 1, sum = 0, norm = 0;
  for (let i = 0; i < o.octaves; i++) {
    let n = vnoise(u * freq, v * freq, freq, (o.seed ?? 0) + i * 131);
    if (o.billow) n = Math.abs(n * 2 - 1);
    sum += n * amp;
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / norm;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Push a narrow fbm distribution out toward the full 0..1 range. */
const punch = (x: number, k: number): number => clamp01((x - 0.5) * k + 0.5);

/**
 * The cloud atlas. One texture, four jobs:
 *
 *   R  body      — the shape of a cumulus field
 *   G  erosion   — high-frequency detail that eats the silhouette
 *   B  coverage  — a slow drift in how cloudy the sky is, so the field is not
 *                  uniformly busy from horizon to zenith
 *   A  billow    — folded noise, used for the lit cauliflower tops
 */
export function makeCloudNoise(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv, v = y * inv;
      const i = (y * size + x) * 4;
      data[i] = punch(fbm(u, v, { base: 3, octaves: 5, seed: 11 }), 1.85) * 255;
      data[i + 1] = punch(fbm(u, v, { base: 9, octaves: 4, seed: 907 }), 1.5) * 255;
      data[i + 2] = punch(fbm(u, v, { base: 2, octaves: 2, seed: 5501 }), 1.3) * 255;
      data[i + 3] = punch(fbm(u, v, { base: 5, octaves: 4, seed: 271, billow: true }), 1.4) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
