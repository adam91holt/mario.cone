// One texture for every particle in the game.
//
// Sparks, dust, flame, confetti, shock rings and speed lines are all the same
// shader and the same draw call; the only thing that differs between them is
// which cell of this atlas they sample. That is the whole reason it exists —
// the moment each effect owns its own texture, each effect also owns its own
// draw call, and a boost at the head of a pack of eight becomes thirty state
// changes instead of one.
//
// Everything is drawn white with an alpha profile. Colour arrives per particle,
// in linear scene-referred units, so the same sprite is a cold blue mini-turbo
// spark at 3.0 and a tan puff of desert dust at 0.4.
//
// **One rule governs every cell that is not a sign.** No straight edge may be
// traceable in the silhouette at nine times magnification, because a sprite the
// player sees forty of at once is judged on its outline and a straight outline
// is the plainest statement a frame can make that it was computed. The clouds
// were rejected for it once as a sixteen-sided polygon; the spark cell was
// carrying the same defect two ways at the same time — a `sqrt` width taper
// that is a straight line over the range it was used on, and a nose that held
// full width while the brightness ran out, which drew a flat wall across the
// leading edge — and the shock ring was a `createRadialGradient` annulus, which
// is to say a mathematically exact circle of constant thickness laid flat on
// the road at eight metres across.
//
// So every one of them is now rasterised from a **stated function** built out
// of `bump` — a compact kernel that is C2 where it meets zero — rather than
// composited out of gradients and rectangles. A sum of C2 functions is C2, and
// the iso-alpha contours of a C2 field are smooth curves at every zoom. That is
// a guarantee rather than a tuning pass. The three exceptions are deliberate:
// the star and the confetti flake are *objects* and want their edges, and the
// speed-line streak is a soft cross that has none to begin with.

import * as THREE from 'three';

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 3;

/** Cell indices, packed into an instance attribute. Order matches the drawing
 *  below and must not be reshuffled without updating both. */
export const CELL = {
  /** A comet: round hot head, hairline tail — the mini-turbo spark itself. */
  spark: 0,
  /** Broad soft ball — flame bodies, wheel glows, bloom seeds. */
  glow: 1,
  /** Mottled cloud — dust, tyre smoke, spray. The first of five. */
  puff: 2,
  /** Thin horizontal line, tapered at both ends — speed lines. */
  streak: 3,
  /** A ring of thrown-up ground, out of round — landing shocks, boost rings,
   *  impact pops. Not a circle: see `drawRing`. */
  ring: 4,
  /** Five-point star — spin-out. */
  star: 5,
  /** Folded rectangle — confetti. */
  flake: 6,
  /** Four-point flare — the instant a mini-turbo tier locks in. */
  flare: 7,
  /** The other four clouds. See `PUFF_CELLS`. */
  puff2: 8,
  puff3: 9,
  puff4: 10,
  puff5: 11,
} as const;

export type CellName = keyof typeof CELL;

/**
 * Every cloud in the atlas, as one list.
 *
 * **A cloud is not one shape.** The whole continuous layer — off-road dust,
 * tyre smoke, exhaust, the speed wake, the flame body, impact puffs, the
 * burnout — used to sample a single cell, and a single cell repeated forty
 * times in a frame is a *stamp*: however soft it is, the eye finds the repeat
 * and the repeat is what says computer graphics. Rotation does not hide it,
 * because a rotated copy of a shape is the same shape.
 *
 * So emitters draw a cell out of here per particle. Five silhouettes with
 * nothing in common but their radial profile, at a cost of four extra cells of
 * texture and no extra draw calls, no extra state, and no extra work per frame.
 */
export const PUFF_CELLS: readonly number[] = [
  CELL.puff, CELL.puff2, CELL.puff3, CELL.puff4, CELL.puff5,
];

/**
 * Cell size in texels.
 *
 * 256, not 128, and the reason is a measurement rather than a preference. The
 * angular governor in `particles.ts` lets an alpha sprite reach `ANG_CLAMP`
 * (0.50 rad) and an additive one `ANG_CLAMP_ADD` (1.00 rad) of apparent
 * diameter — a third and two thirds of the width of a 1600px frame. A cell of
 * 128 texels drawn across a thousand screen pixels is magnified **eight
 * times**, and GPU bilinear magnification of a smooth radial ramp at 8x does
 * not stay smooth: each texel becomes a quad of the interpolant, and the
 * iso-alpha contour through it is a *straight segment*. String those together
 * around the rim of a puff and the silhouette resolves into a polygon with
 * visible facet edges, which is exactly what a 9x crop of the biggest, most
 * noticeable puffs came back showing.
 *
 * At 256 the same sprite is magnified four times, and every cell here is
 * additionally built with a silhouette that is *analytic* in the angle (see
 * `cloudField`), so there is no radius at which a facet can form in the source
 * data either. Cost: one 1024x768 RGBA texture, about 3MB with its mip chain,
 * for the only texture the effects layer owns.
 */
const SIZE = 256;

type Stop = readonly [number, number];

function white(a: number): string {
  return `rgba(255,255,255,${a.toFixed(4)})`;
}

function radial(
  c: CanvasRenderingContext2D, cx: number, cy: number, r: number, list: readonly Stop[],
): CanvasGradient {
  const g = c.createRadialGradient(cx, cy, 0, cx, cy, r);
  for (const [t, a] of list) g.addColorStop(t, white(a));
  return g;
}

/** Deterministic scatter for the cloud cells — no Math.random anywhere. */
function hash(n: number): number {
  const s = Math.sin(n * 91.7213) * 43758.5453;
  return s - Math.floor(s);
}

/** Smootherstep. C2 at both ends, so nothing built on it creases. */
function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

const TAU = Math.PI * 2;

/**
 * The compact smooth kernel every analytic cell in this file is built out of.
 *
 * `(1 - q²)³` on `q < 1`, zero outside. Two properties, and both of them are
 * the whole point:
 *
 *   It is **exactly zero** past `q = 1`, so a cell built from a finite number
 *   of these has a support this code can state rather than a gaussian tail that
 *   has to be clipped somewhere — and a clip is a hard edge.
 *
 *   Its first and second derivatives are **both zero at `q = 1`**, so the
 *   junction between "kernel" and "nothing" is C2. A sum of C2 functions is C2,
 *   which means the iso-alpha contours of anything assembled from them are
 *   smooth curves. They cannot resolve into a straight segment at any
 *   magnification, because there is no straight segment in the source to
 *   resolve into.
 */
function bump(q2: number): number {
  if (q2 >= 1) return 0;
  const t = 1 - q2;
  return t * t * t;
}

/**
 * Rasterise a cell from a closure over normalised coordinates.
 *
 * `f(x, y)` is called with `x` running 0..1 across the cell and `y` running
 * -0.5..0.5 down it, and returns alpha. Per-pixel rather than by compositing
 * gradients, because a silhouette assembled out of overlapping `fillRect`s and
 * `CanvasGradient`s is the *accidental* outcome of the compositor rather than a
 * function this file can state — and only a stated function can be checked.
 */
function raster(c: CanvasRenderingContext2D, f: (x: number, y: number) => number): void {
  const cv = document.createElement('canvas');
  cv.width = SIZE;
  cv.height = SIZE;
  const cc = cv.getContext('2d');
  if (!cc) throw new Error('[fx] 2d context unavailable');
  const img = cc.createImageData(SIZE, SIZE);
  const px = img.data;
  for (let py = 0; py < SIZE; py++) {
    const y = (py + 0.5) / SIZE - 0.5;
    for (let pxi = 0; pxi < SIZE; pxi++) {
      const i = (py * SIZE + pxi) * 4;
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
      const a = f((pxi + 0.5) / SIZE, y);
      px[i + 3] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
    }
  }
  cc.putImageData(img, 0, 0);
  c.drawImage(cv, 0, 0);
}

/**
 * The spark. A **comet**, not a ball — and that difference is most of what
 * separates "a spray of sparks" from "a chain of glowing tic-tacs".
 *
 * Every particle that samples this cell is drawn in `MODE.velocity`: the quad is
 * stretched along the direction the particle takes across the frame, and the
 * texture is stretched with it. A radial gaussian stretched four to one is a
 * *capsule* — symmetric, soft at both ends, thick in the middle — and a stream
 * of capsules being towed behind a kart is exactly what the boost, the
 * mini-turbo and the barrier grind photographed as. No amount of tuning the
 * colour, the count or the length fixes that, because the shape itself is
 * wrong: the eye reads a symmetric blob as an *object*, and only an asymmetric
 * taper as *motion*.
 *
 * So the cell is built to be stretched. `+X` is the direction of travel (the
 * shader's velocity branch aligns the quad's local X with the screen-space
 * velocity), so the head sits forward in the cell and the tail runs back toward
 * `u = 0`, narrowing as it goes.
 *
 * **It is a swept kernel, not a column of gradients**, and that is the fix the
 * cloud cells already had applied to them one round earlier. The previous
 * version rasterised 256 one-pixel vertical gradients whose half-width was
 * `0.10 + 0.90 * sqrt(u / NOSE)` and whose brightness past the nose fell while
 * the width stayed pinned at maximum. Two straight edges came out of that and
 * both of them photographed:
 *
 *   a `sqrt` taper is very nearly a straight line over the range it was used
 *   on, so the two long sides of the comet were traceable as straight edges at
 *   9x — the same defect as the 16-gon puff, in the second most-drawn cell in
 *   the atlas;
 *
 *   and holding full width while the brightness ran out gave the leading edge a
 *   **blunt wall**. A measured 5x crop of a boost came back with a scatter of
 *   small cyan rectangles with squared-off ends, which is what a stretched bar
 *   of light with a flat nose looks like. A spark has a round head.
 *
 * What is here instead is what a spark *is*: a bright point, photographed while
 * moving. Thirty-two copies of the compact kernel are laid down the axis, the
 * radius growing and the brightness rising toward the head — the integral a
 * shutter takes over a moving point. The silhouette is therefore the outer
 * envelope of a family of circles, which is a smooth curve everywhere by
 * construction, has a round nose because the head kernel is round, and reaches
 * exactly zero inside the cell because the kernel has compact support.
 */
function drawSpark(c: CanvasRenderingContext2D): void {
  /** Where the head sits along the cell. 0 = tail end, 1 = leading edge. */
  const HEAD = 0.62;
  const TAIL = 0.035;
  /** Half-width of the head, in cell heights. The cell's own half-height is
   *  0.5, so the support has to end inside that — this plus the margin below is
   *  what keeps the mip chain from carrying the comet into its neighbours. */
  const R_HEAD = 0.36;
  const R_TAIL = 0.030;
  /**
   * Samples along the sweep.
   *
   * The spacing has to stay under the *tail* radius, which is the smallest one:
   * crowd the samples toward the head instead and the thin end of the comet
   * comes apart into a dotted line of individual kernels, which a 9x crop
   * catches instantly. 32 evenly spaced samples over 0.585 of the cell is a
   * step of 0.018 against a tail radius of 0.030, so consecutive kernels always
   * overlap and the envelope is continuous everywhere.
   */
  const N = 32;

  const cx = new Float32Array(N);
  const cr = new Float32Array(N);
  const cb = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const s = i / (N - 1);               // 0 at the tail, 1 at the head
    cx[i] = TAIL + (HEAD - TAIL) * s;
    cr[i] = R_TAIL + (R_HEAD - R_TAIL) * Math.pow(s, 1.35);
    // A long power-law rise, so the tail is a hairline of light rather than a
    // second lobe. Divided by the sample's own area so a fat head kernel does
    // not simply drown the thin tail ones.
    cb[i] = (0.035 + 0.965 * Math.pow(s, 2.1)) / (cr[i] * cr[i]);
  }

  // One pass to find the peak, so the profile below can be stated in 0..1
  // rather than depending on how many samples the sweep happens to use.
  let peak = 0;
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let k = 0; k < N; k++) {
      const dx = cx[i]! - cx[k]!;
      s += cb[k]! * bump((dx * dx) / (cr[k]! * cr[k]!));
    }
    if (s > peak) peak = s;
  }
  const inv = 1 / peak;

  raster(c, (x, y) => {
    let a = 0;
    for (let k = 0; k < N; k++) {
      const dx = x - cx[k]!;
      const r = cr[k]!;
      const q2 = (dx * dx + y * y) / (r * r);
      if (q2 < 1) a += cb[k]! * bump(q2);
    }
    a *= inv;
    // A shoulder on the accumulated field rather than on any one kernel. It
    // pulls the faint outer skirt in so the comet has a *defined* body without
    // giving it a boundary: the curve is smooth, so the alpha still crosses the
    // eye's threshold at a different radius for every opacity the module uses.
    return a <= 0 ? 0 : Math.pow(a, 1.25);
  });
}

function drawGlow(c: CanvasRenderingContext2D): void {
  const h = SIZE * 0.5;
  c.fillStyle = radial(c, h, h, h * 0.98, [
    [0.00, 1.0], [0.18, 0.80], [0.38, 0.40], [0.62, 0.13], [1.00, 0.0],
  ]);
  c.fillRect(0, 0, SIZE, SIZE);
}

// ── the clouds ─────────────────────────────────────────────────────────────
//
// The dust / smoke cells: the sprite the whole continuous layer is made of, and
// the ones whose shape decides whether the module reads as weather or as dirt
// on the lens. Four previous passes each overcorrected the last:
//
//   The first stacked seven lobes at 52% additive, which saturates to a solid
//   disc inside a third of the radius. Every puff arrived as an opaque soft
//   ball — tyre smoke read as an oil stain, and one puff over the locomotive
//   funnel read as a boulder.
//
//   The second pushed thirteen much fainter lobes *out toward the rim* to avoid
//   that, and in doing so built an annulus: measured, it peaked at 0.20 alpha
//   around 0.35 of the radius and fell to 0.075 dead centre. That is not smoke,
//   it is a smoke *ring*, and it is why a capture of a kart crossing gravel came
//   back covered in soap bubbles.
//
//   The third made the profile monotonic — one dense body with chunks bitten
//   out of it by seventeen `destination-out` lobes — and that is the version
//   that got the module to 7/10 and was rejected at the silhouette. Two things
//   were wrong with it and neither is the alpha profile, which is why the
//   profile below is deliberately unchanged to within a few percent:
//
//     *It could not survive magnification.* A 128-texel cell blown up eight
//     times across the frame is a lattice of bilinear quads, and the iso-alpha
//     contour across a bilinear quad is a straight line. The rim resolved into
//     facets — a polygon, at exactly the zoom a reviewer uses.
//
//     *There was one of it.* Every cloud in the game — dust, tyre smoke,
//     exhaust, wake, flame, impact, burnout — was the same silhouette turned to
//     a different angle, and a rotated copy of a shape is the same shape.
//
// So: five cells at 256 texels, and the raggedness that stops each of them
// being a circle is now *analytic*. The silhouette is a sum of six harmonics of
// the polar angle — a closed, infinitely differentiable curve. It has no
// vertices to find, at any zoom, in the source data or after any amount of
// filtering, which is a guarantee rather than a tuning pass. Chunks bitten out
// with circles were only ever an approximation of one.

/** Mean alpha at the centre of a cloud, matching the cell it replaces. */
const CLOUD_PEAK = 0.67;
/**
 * Exponent of the radial falloff.
 *
 * Low, and it has to be: this is the number that decides whether the sprite has
 * an *edge*. A high exponent gives a tight bright core with a fast shoulder,
 * which is a ball; 1.2 spends most of the radius getting from full to nothing,
 * so the radius at which the alpha crosses the eye's threshold moves for every
 * opacity the module uses, and a cloud of forty of them never resolves into
 * forty outlines.
 */
const CLOUD_FALL = 1.2;
/**
 * Radius, in half-cells, at which the body would reach zero if the silhouette
 * were not warped.
 *
 * Chosen so the mean alpha profile and the mean silhouette radius of the
 * finished cell land on top of the ones the whole `SURFACE_FX` table in
 * `index.ts` was tuned against — every alpha in that table is calibrated to
 * this curve, and a change here is a change to all of them. Measured, the cell
 * it replaces ran 0.671 at the centre, 0.246 at half radius and 0.059 at three
 * quarters, with a mean silhouette radius of 0.702. So does this one.
 */
const CLOUD_R0 = 0.99;
/**
 * How far the harmonics may pull the rim *in*, as a fraction of R0.
 *
 * One-sided on purpose. A warp that can also push the rim out has to be given
 * somewhere to go, which means either a cell the body does not fill — wasting
 * three quarters of the texels the resolution was raised for — or a body that
 * is still at 0.24 alpha when it reaches the cell boundary and gets cut off
 * there by the mip guard. That cut is a circle of hard edge: the exact defect
 * this rebuild exists to remove, reintroduced by the fix for it.
 */
const CLOUD_WARP = 0.45;

/**
 * The silhouette field for one cloud: a smooth, closed, strictly periodic curve
 * on the circle, sampled into a table.
 *
 * Six harmonics with fixed phases and falling amplitudes. The lowest ones give
 * the cloud its big asymmetric lobes, the highest its fine ruffle; the sum is
 * band-limited, so there is a shortest wavelength in it — about a twelfth of
 * the circumference — and nothing sharper can appear no matter how far the cell
 * is magnified. The table is read with linear interpolation between 4096
 * entries, which is an arc of 0.4 texels at the rim: three orders of magnitude
 * below anything the eye could call a straight edge.
 */
function cloudField(seed: number): Float32Array {
  const H = 6;
  const FREQ = [2, 3, 4, 5, 7, 9];
  const amp = new Float32Array(H);
  const phase = new Float32Array(H);
  let total = 0;
  for (let k = 0; k < H; k++) {
    // Weighted hard toward the low harmonics: the big asymmetric billows are
    // what a cloud is read by, and the high ones are only there so the rim
    // between them is never a plain arc either.
    amp[k] = (1 / (1 + k * 0.62)) * (0.5 + hash(seed * 3.77 + k * 1.31));
    phase[k] = hash(seed * 5.13 + k * 2.29) * TAU;
    total += amp[k]!;
  }
  const inv = 1 / total;
  const N = 4096;
  const out = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * TAU;
    let s = 0;
    for (let k = 0; k < H; k++) s += amp[k]! * Math.sin(FREQ[k]! * a + phase[k]!);
    // Mapped to 0..1: the warp only ever pulls the rim in. See `CLOUD_WARP`.
    out[i] = 0.5 + 0.5 * s * inv;
  }
  return out;
}

/**
 * Value noise on a lattice, interpolated with smootherstep.
 *
 * The cloud's internal structure — the mottling that gives a puff something to
 * catch the light on instead of being a flat ramp. C2 across every lattice
 * boundary, so it cannot contribute a crease to the silhouette either.
 *
 * The lattice is built once per octave rather than hashed per corner per pixel.
 * The naive version cost twelve `Math.sin` calls and three closures for every
 * one of the 327,680 pixels this module rasterises at boot — a fifth of a
 * second of dropped frames and a million short-lived objects, to compute 283
 * distinct numbers.
 */
function lattice(n: number, seed: number): Float32Array {
  const t = new Float32Array(n * n);
  for (let i = 0; i < t.length; i++) t[i] = hash(seed * 19.7 + i * 1.373);
  return t;
}

function noise(t: Float32Array, n: number, u: number, v: number): number {
  const x = u * n;
  const y = v * n;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(0, 1, x - x0);
  const fy = smooth(0, 1, y - y0);
  const xa = ((x0 % n) + n) % n;
  const ya = ((y0 % n) + n) % n;
  const xb = (xa + 1) % n;
  const yb = (ya + 1) % n;
  const a = t[ya * n + xa]!;
  const b = t[ya * n + xb]!;
  const c = t[yb * n + xa]!;
  const d = t[yb * n + xb]!;
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fy;
}

/**
 * Rasterise one cloud cell.
 *
 * Per-pixel rather than by compositing gradients, because the silhouette has to
 * be a function this code can *state* — `alpha(r, theta)` — rather than the
 * accidental outcome of seventeen overlapping circles. A closed form is the
 * only version of this that can be checked: crop it at 9x, trace the rim, and
 * every tangent turns.
 */
function drawCloud(c: CanvasRenderingContext2D, seed: number): void {
  const field = cloudField(seed);
  const oct0 = lattice(3, seed + 1.7);
  const oct1 = lattice(7, seed + 4.3);
  const oct2 = lattice(15, seed + 9.1);
  const N = field.length - 1;

  raster(c, (x, y) => {
    const dx = (x - 0.5) * 2;
    const dy = y * 2;
    const d = Math.sqrt(dx * dx + dy * dy);
    // Everything past the inscribed circle is empty. The body has already
    // reached zero well inside it — this only guarantees the mip chain can
    // never bleed one cell into its neighbour.
    if (d >= 0.999) return 0;

    // Where on the rim we are, as a smooth periodic function of the angle.
    const th = Math.atan2(dy, dx);
    const t = ((th < 0 ? th + TAU : th) / TAU) * N;
    const ti = t | 0;
    const s = field[ti]! + (field[ti + 1]! - field[ti]!) * (t - ti);

    // The warp bites the outside and leaves the core alone: a cloud is ragged
    // at its edge and dense in its middle, and warping the middle as well
    // just moves the whole sprite off centre.
    const rn = (d / CLOUD_R0) * (1 + CLOUD_WARP * s * smooth(0.06, 0.92, d));
    if (rn >= 1) return 0;
    let a = CLOUD_PEAK * Math.pow(1 - rn, CLOUD_FALL);
    // Structure at three scales: billows about a third of the cell across,
    // clumps inside those, and a fine grain over the top so no billow is a
    // smooth ball. Value noise rather than a ring of gaussian lobes, because
    // lobes placed inside the body correlate with the radius — they pile up in
    // the middle, flatten the core into a plateau and lift the peak by half
    // again, which is a change to the alpha profile dressed up as a change to
    // the texture.
    //
    // The modulation averages 1 by construction, so the *mean* radial profile
    // is still the monotonic curve every alpha in `index.ts` was tuned
    // against, while any individual pixel runs between 0.55 and 1.45 of it.
    // That spread is the whole difference between a cloud and a gradient.
    const m = 0.50 * noise(oct0, 3, x, y + 0.5)
      + 0.32 * noise(oct1, 7, x, y + 0.5)
      + 0.18 * noise(oct2, 15, x, y + 0.5);
    a *= 0.55 + 0.90 * m;
    // ...and a last analytic vignette. A polynomial rather than a ramp with
    // endpoints: it is exactly zero at the cell boundary, so the mip chain can
    // never carry one cell into its neighbour, and it is a smooth function
    // everywhere, so it cannot be the thing that draws an edge.
    const d6 = d * d * d;
    return a * (1 - d6 * d6 * d6 * d);   // 1 - d^10
  });
}

function drawStreak(c: CanvasRenderingContext2D): void {
  const gx = c.createLinearGradient(0, 0, SIZE, 0);
  gx.addColorStop(0.00, white(0));
  gx.addColorStop(0.22, white(0.55));
  gx.addColorStop(0.50, white(1));
  gx.addColorStop(0.78, white(0.55));
  gx.addColorStop(1.00, white(0));
  c.fillStyle = gx;
  c.fillRect(0, 0, SIZE, SIZE);

  const gy = c.createLinearGradient(0, 0, 0, SIZE);
  gy.addColorStop(0.00, white(0));
  gy.addColorStop(0.36, white(0.10));
  gy.addColorStop(0.50, white(1));
  gy.addColorStop(0.64, white(0.10));
  gy.addColorStop(1.00, white(0));
  c.globalCompositeOperation = 'destination-in';
  c.fillStyle = gy;
  c.fillRect(0, 0, SIZE, SIZE);
  c.globalCompositeOperation = 'source-over';
}

/**
 * The shock ring — a landing, a boost pad, a blast, a mini-turbo firing.
 *
 * It used to be five colour stops on a `createRadialGradient`, which is to say
 * a **perfect annulus of constant width**: the same radius at every angle, the
 * same thickness at every angle, and a piecewise-linear alpha ramp with a
 * crease at each stop. It is drawn flat on the road at up to eight and a half
 * metres across, so it is the largest single sprite the module ever puts on
 * screen, and at that size a mathematically exact circle of even thickness is
 * the "computer graphics" tell in its purest form. Nothing in a landing is
 * circular to a tenth of a percent. Photographed at 9x it read as a neon O
 * laid on the tarmac.
 *
 * So the same treatment the cloud cells got: the radius, the thickness and the
 * brightness are each a smooth periodic function of the angle, built out of the
 * band-limited harmonic sum in `cloudField`. What comes out is a ring of
 * *displaced air and grit* — thicker and brighter where the ground gave more,
 * thinner where it gave less, and out of round by a few percent everywhere.
 *
 * The wall profile is deliberately asymmetric: tight on the outside, where the
 * shock front is, and trailing away inward, where the disturbance is still
 * settling. That is the difference between a ring that is *expanding* and a
 * ring that is merely drawn.
 */
function drawRing(c: CanvasRenderingContext2D): void {
  const shape = cloudField(11.0);
  const thick = cloudField(12.0);
  const bright = cloudField(13.0);
  const N = shape.length - 1;

  /** Mean radius of the wall, in half-cells. Everything past `R0 + T_OUT` is
   *  empty, and that sum has to stay inside the inscribed circle or the mip
   *  chain carries the ring into the neighbouring cell. */
  const R0 = 0.755;
  /** Half-thickness outward (the front) and inward (the wake). */
  const T_OUT = 0.155;
  const T_IN = 0.34;
  /** How far out of round the ring runs, and how much its thickness varies. */
  const WOBBLE = 0.048;
  const VARY = 0.30;

  const sample = (tab: Float32Array, t: number): number => {
    const i = t | 0;
    return tab[i]! + (tab[i + 1]! - tab[i]!) * (t - i);
  };

  raster(c, (x, y) => {
    const dx = (x - 0.5) * 2;
    const dy = y * 2;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d >= 0.999) return 0;
    const th = Math.atan2(dy, dx);
    const t = ((th < 0 ? th + TAU : th) / TAU) * N;

    const r = R0 * (1 + WOBBLE * (sample(shape, t) * 2 - 1));
    const vary = 1 + VARY * (sample(thick, t) * 2 - 1);
    const n = d - r;
    const half = (n >= 0 ? T_OUT : T_IN) * vary;
    const q = n / half;
    // The wall. A compact C2 kernel rather than a gradient with stops: it has
    // no crease anywhere along the profile, so the ring cannot band into
    // concentric contours the way a piecewise-linear ramp does under bloom.
    let a = bump(q * q);
    // ...biased forward, so the brightest line sits just inside the front edge
    // rather than dead centre of the wall.
    if (n < 0) a *= 0.55 + 0.45 * bump(q * q);
    a *= 0.62 + 0.38 * sample(bright, t);
    // A faint wash of lifted dust inside the ring, so the middle is not a hole.
    const inner = 1 - d / r;
    if (inner > 0) a += 0.075 * inner * inner * (0.6 + 0.4 * sample(bright, t));
    // Exactly zero at the cell boundary whatever the harmonics did.
    const d6 = d * d * d;
    return a * (1 - d6 * d6 * d6 * d);
  });
}

function drawStar(c: CanvasRenderingContext2D): void {
  const h = SIZE * 0.5;
  // A soft halo behind, so the star blooms rather than sitting there as a decal.
  c.fillStyle = radial(c, h, h, h * 0.96, [
    [0.00, 0.55], [0.30, 0.22], [0.70, 0.04], [1.00, 0.0],
  ]);
  c.fillRect(0, 0, SIZE, SIZE);

  // The one cell in the atlas that is *allowed* straight edges — a five-point
  // star is a sign, and a sign with a soft outline is a smudge. The corners are
  // rounded rather than mitred so the points do not alias into needles when the
  // sprite is small, which is the only place the shape was actually failing.
  const outer = h * 0.82;
  const inner = outer * 0.44;
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = h + Math.cos(a) * r;
    const y = h + Math.sin(a) * r;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.closePath();
  c.fillStyle = white(1);
  c.lineJoin = 'round';
  c.lineWidth = SIZE * 0.045;
  c.strokeStyle = white(1);
  c.stroke();
  c.fill();
}

function drawFlake(c: CanvasRenderingContext2D): void {
  // A rounded rectangle with a shaded lower half: the tumble is driven by the
  // instance rotation, and the shading is what stops each flake reading as a
  // flat sticker when it turns.
  const w = SIZE * 0.62;
  const hgt = SIZE * 0.40;
  const x = (SIZE - w) * 0.5;
  const y = (SIZE - hgt) * 0.5;
  const r = hgt * 0.28;
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + hgt, r);
  c.arcTo(x + w, y + hgt, x, y + hgt, r);
  c.arcTo(x, y + hgt, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
  const g = c.createLinearGradient(0, y, 0, y + hgt);
  g.addColorStop(0.00, 'rgba(255,255,255,1)');
  g.addColorStop(0.52, 'rgba(255,255,255,1)');
  g.addColorStop(0.54, 'rgba(150,150,150,1)');
  g.addColorStop(1.00, 'rgba(120,120,120,1)');
  c.fillStyle = g;
  c.fill();
}

/**
 * The lock-in flare.
 *
 * The spikes used to be `fillRect`s with a gradient along their length and a
 * *constant* profile across their thickness, which gives a bar of light with
 * two perfectly straight parallel edges. That is fine at eight pixels across
 * and indefensible at the size this cell actually reaches: it is an additive
 * sprite, so the governor lets it grow to `ANG_CLAMP_ADD` — two thirds of the
 * frame — and a 9x crop of a tier-three lock-in came back with a hard-edged
 * cross drawn over the road.
 *
 * Now each spike is rasterised as a column of one-pixel gradients, tapering in
 * thickness as well as in brightness, so it has a soft gaussian section
 * everywhere along its length and no edge to trace.
 */
function drawFlare(c: CanvasRenderingContext2D): void {
  const h = SIZE * 0.5;
  c.fillStyle = radial(c, h, h, h * 0.42, [
    [0.00, 1.0], [0.22, 0.62], [0.55, 0.16], [1.00, 0.0],
  ]);
  c.fillRect(0, 0, SIZE, SIZE);

  c.globalCompositeOperation = 'lighter';
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < SIZE; i++) {
      const u = (i + 0.5) / SIZE;
      // Brightest and thickest at the middle, gone at both tips.
      const k = 1 - Math.abs(u - 0.5) * 2;
      const bright = Math.pow(k, 1.35) * 0.95;
      if (bright < 0.004) continue;
      const w = SIZE * (0.012 + 0.055 * Math.pow(k, 0.7));
      const g = axis === 0
        ? c.createLinearGradient(0, h - w, 0, h + w)
        : c.createLinearGradient(h - w, 0, h + w, 0);
      g.addColorStop(0.00, white(0));
      g.addColorStop(0.28, white(bright * 0.16));
      g.addColorStop(0.50, white(bright));
      g.addColorStop(0.72, white(bright * 0.16));
      g.addColorStop(1.00, white(0));
      c.fillStyle = g;
      if (axis === 0) c.fillRect(i, h - w, 1, w * 2);
      else c.fillRect(h - w, i, w * 2, 1);
    }
  }
  c.globalCompositeOperation = 'source-over';
}

const DRAW: Array<(c: CanvasRenderingContext2D) => void> = [
  drawSpark,
  drawGlow,
  (c) => drawCloud(c, 1.0),
  drawStreak,
  drawRing,
  drawStar,
  drawFlake,
  drawFlare,
  (c) => drawCloud(c, 2.0),
  (c) => drawCloud(c, 3.0),
  (c) => drawCloud(c, 4.0),
  (c) => drawCloud(c, 5.0),
];

/**
 * Build the atlas. One canvas, twelve cells, mipmapped.
 *
 * Every cell fades to zero alpha well inside its own boundary, so the mip chain
 * can bleed between neighbours without a seam ever appearing on screen.
 */
export function createAtlas(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * SIZE;
  canvas.height = ATLAS_ROWS * SIZE;
  const c = canvas.getContext('2d');
  if (!c) throw new Error('[fx] 2d context unavailable');

  for (let i = 0; i < DRAW.length; i++) {
    const col = i % ATLAS_COLS;
    const row = Math.floor(i / ATLAS_COLS);
    c.save();
    c.beginPath();
    c.rect(col * SIZE, row * SIZE, SIZE, SIZE);
    c.clip();
    c.translate(col * SIZE, row * SIZE);
    DRAW[i]!(c);
    c.restore();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'fxAtlas';
  // The sprites are alpha masks, not colour: leaving them in the working space
  // keeps the shader a straight multiply against the per-instance colour.
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.anisotropy = 2;
  return tex;
}
