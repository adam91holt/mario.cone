// Small math toolbox. Deterministic — nothing here touches Math.random or the clock.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (b - a === 0 ? 0 : (v - a) / (b - a));
export const remap = (v: number, a: number, b: number, c: number, d: number): number =>
  lerp(c, d, clamp01(invLerp(a, b, v)));
export const sign = (v: number): number => (v < 0 ? -1 : v > 0 ? 1 : 0);

/** Framerate-independent exponential approach. `smoothing` = fraction remaining after 1s. */
export const damp = (a: number, b: number, smoothing: number, dt: number): number =>
  lerp(a, b, 1 - Math.pow(smoothing, dt));

/** Spring-damper toward a target. Returns the new `[value, velocity]`. */
export function spring(
  value: number, vel: number, target: number,
  stiffness: number, damping: number, dt: number,
): [number, number] {
  const f = (target - value) * stiffness - vel * damping;
  const nv = vel + f * dt;
  return [value + nv * dt, nv];
}

export const smoothstep = (t: number): number => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (t: number): number => {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

// Easing — used everywhere for UI and camera. Keep the set small and expressive.
export const ease = {
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuart: (t: number) => 1 - Math.pow(1 - t, 4),
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  outBack: (t: number) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  outElastic: (t: number) => {
    if (t <= 0 || t >= 1) return clamp01(t);
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
  outBounce: (t: number) => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
} as const;

/** Shortest signed angular difference, in radians, wrapped to [-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
export const lerpAngle = (a: number, b: number, t: number): number => a + angleDelta(a, b) * t;
export const dampAngle = (a: number, b: number, smoothing: number, dt: number): number =>
  a + angleDelta(a, b) * (1 - Math.pow(smoothing, dt));

/**
 * Seeded RNG (mulberry32). Every stochastic thing in the simulation pulls from one
 * of these, so a given seed always replays identically — which is what lets the
 * automated critics compare runs frame by frame.
 */
export interface Rng {
  next(): number;
  range(a: number, b: number): number;
  int(a: number, b: number): number;
  pick<T>(arr: readonly T[]): T;
  bool(p?: number): boolean;
  gauss(): number;
  sign(): number;
  fork(): Rng;
  state: number;
}

export function makeRng(seed = 1): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (a, b) => a + next() * (b - a),
    int: (a, b) => Math.floor(a + next() * (b - a + 1)),
    pick: <T,>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)] as T,
    bool: (p = 0.5) => next() < p,
    /** Gaussian-ish via central limit — cheap, and good enough for scatter. */
    gauss: () => (next() + next() + next() - 1.5) / 1.5,
    sign: () => (next() < 0.5 ? -1 : 1),
    fork: () => makeRng((next() * 4294967296) >>> 0),
    get state() { return s; },
    set state(v: number) { s = v >>> 0; },
  };
}

/** Cheap deterministic value noise — terrain wobble, wind, idle motion. */
export function hash1(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
}
export function noise1(x: number): number {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash1(i), hash1(i + 1), u) * 2 - 1;
}
/** Layered noise. Wind gusts, handheld camera drift, flag ripple. */
export function fbm1(x: number, octaves = 3): number {
  let v = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    v += noise1(x * freq) * amp;
    freq *= 2;
    amp *= 0.5;
  }
  return v;
}

/** Catmull-Rom on scalars. The spline module handles the vector case. */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Move `a` toward `b` by at most `maxDelta`. */
export function moveToward(a: number, b: number, maxDelta: number): number {
  const d = b - a;
  return Math.abs(d) <= maxDelta ? b : a + sign(d) * maxDelta;
}

/** Format seconds as M:SS.mmm — race timers and lap splits. */
export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
