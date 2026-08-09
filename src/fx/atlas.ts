// One texture for every particle in the game.
//
// Sparks, dust, flame, confetti, shock rings and speed lines are all the same
// shader and the same draw call; the only thing that differs between them is
// which 128px cell of this atlas they sample. That is the whole reason it
// exists — the moment each effect owns its own texture, each effect also owns
// its own draw call, and a boost at the head of a pack of eight becomes thirty
// state changes instead of one.
//
// Everything is drawn white with an alpha profile. Colour arrives per particle,
// in linear scene-referred units, so the same sprite is a cold blue mini-turbo
// spark at 3.0 and a tan puff of desert dust at 0.4.

import * as THREE from 'three';

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 2;

/** Cell indices, packed into an instance attribute. Order matches the drawing
 *  below and must not be reshuffled without updating both. */
export const CELL = {
  /** Hot pinpoint with a fast falloff — the mini-turbo spark itself. */
  spark: 0,
  /** Broad soft ball — flame bodies, wheel glows, bloom seeds. */
  glow: 1,
  /** Mottled cloud — dust, tyre smoke, spray. */
  puff: 2,
  /** Thin horizontal line, tapered at both ends — speed lines. */
  streak: 3,
  /** Annulus — landing shocks, boost rings, impact pops. */
  ring: 4,
  /** Five-point star — spin-out. */
  star: 5,
  /** Folded rectangle — confetti. */
  flake: 6,
  /** Four-point flare — the instant a mini-turbo tier locks in. */
  flare: 7,
} as const;

export type CellName = keyof typeof CELL;

const SIZE = 128;

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

/** Deterministic scatter for the cloud cell — no Math.random anywhere. */
function hash(n: number): number {
  const s = Math.sin(n * 91.7213) * 43758.5453;
  return s - Math.floor(s);
}

function drawSpark(c: CanvasRenderingContext2D): void {
  const h = SIZE * 0.5;
  c.fillStyle = radial(c, h, h, h * 0.94, [
    [0.00, 1.0], [0.10, 1.0], [0.22, 0.72], [0.40, 0.24], [0.68, 0.05], [1.00, 0.0],
  ]);
  c.fillRect(0, 0, SIZE, SIZE);
}

function drawGlow(c: CanvasRenderingContext2D): void {
  const h = SIZE * 0.5;
  c.fillStyle = radial(c, h, h, h * 0.98, [
    [0.00, 1.0], [0.18, 0.80], [0.38, 0.40], [0.62, 0.13], [1.00, 0.0],
  ]);
  c.fillRect(0, 0, SIZE, SIZE);
}

/**
 * The dust / smoke cell.
 *
 * This is the sprite the whole continuous layer is made of, and it is the one
 * cell in the atlas whose shape decides whether the module reads as weather or
 * as dirt on the lens. Two previous passes each overcorrected the other:
 *
 *   The first stacked seven lobes at 52% additive, which saturates to a solid
 *   disc inside a third of the radius. Every puff arrived as an opaque soft
 *   ball that took whatever colour it was given and held it — tyre smoke read
 *   as an oil stain, and one puff over the locomotive funnel read as a boulder.
 *
 *   The second pushed thirteen much fainter lobes *out toward the rim* to avoid
 *   that, and in doing so built an annulus. Measured, the profile peaked at 0.20
 *   alpha around 0.35 of the radius and fell to 0.075 dead centre: a donut with
 *   a hole in the middle, less than half as dense at its centre as at its edge.
 *   That is not smoke, it is a smoke *ring*, and at any size big enough to
 *   notice the eye reads the outline — which is exactly why a screenshot of a
 *   kart crossing gravel came back covered in soap bubbles, and why the road
 *   behind a machine at speed came back looking like a windscreen nobody had
 *   wiped.
 *
 * A suspension lit from every direction has its greatest optical depth where
 * you are looking through the most of it, which is the middle. So the profile
 * is monotonic from the centre out — no exceptions, that is the whole lesson —
 * and the raggedness that stops it being a perfect circle is *bitten out* of
 * the silhouette rather than being what builds it. Sixteen faint lobes cannot
 * make a cloud; one dense one with chunks missing can.
 *
 * The ceiling is about 0.66 rather than 0.20, which is roughly three times the
 * old cell. Every alpha in the module that feeds this cell was retuned down to
 * match — the read now comes from a handful of legible sprites instead of from
 * four hundred invisible ones, which costs a third of the fill rate for more
 * visible density.
 */
function drawPuff(c: CanvasRenderingContext2D): void {
  const h = SIZE * 0.5;
  // The body: dense in the middle, gone by the rim, and monotonic in between.
  c.fillStyle = radial(c, h, h, h * 0.99, [
    [0.00, 0.72], [0.26, 0.66], [0.50, 0.44], [0.72, 0.18], [0.90, 0.04], [1.00, 0.0],
  ]);
  c.fillRect(0, 0, SIZE, SIZE);

  // Bite the silhouette apart. Nine soft notches taken out of the outer half,
  // so no two puffs in a cloud present the same outline once they are spinning
  // at different angles — a perfect disc repeated forty times reads as forty
  // discs, however soft each one is.
  c.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 9; i++) {
    const a = hash(i * 3.1 + 0.7) * Math.PI * 2;
    const d = h * (0.52 + hash(i * 7.3 + 2.1) * 0.42);
    const r = h * (0.22 + hash(i * 5.9 + 4.4) * 0.26);
    c.fillStyle = radial(c, h + Math.cos(a) * d, h + Math.sin(a) * d, r, [
      [0.00, 0.85], [0.55, 0.35], [1.00, 0.0],
    ]);
    c.fillRect(0, 0, SIZE, SIZE);
  }
  // ...and four much shallower ones inside it, so the body has some structure
  // to catch the light on rather than being a flat gradient.
  for (let i = 0; i < 4; i++) {
    const a = hash(i * 11.7 + 5.3) * Math.PI * 2;
    const d = h * (0.10 + hash(i * 4.7 + 1.9) * 0.30);
    const r = h * (0.16 + hash(i * 9.1 + 3.3) * 0.16);
    c.fillStyle = radial(c, h + Math.cos(a) * d, h + Math.sin(a) * d, r, [
      [0.00, 0.34], [0.60, 0.12], [1.00, 0.0],
    ]);
    c.fillRect(0, 0, SIZE, SIZE);
  }

  // No notch may leave a hard edge at the cell boundary.
  c.globalCompositeOperation = 'destination-in';
  c.fillStyle = radial(c, h, h, h * 0.99, [
    [0.00, 1.0], [0.70, 1.0], [1.00, 0.0],
  ]);
  c.fillRect(0, 0, SIZE, SIZE);
  c.globalCompositeOperation = 'source-over';
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

function drawRing(c: CanvasRenderingContext2D): void {
  const h = SIZE * 0.5;
  c.fillStyle = radial(c, h, h, h * 0.99, [
    [0.00, 0.0], [0.44, 0.0], [0.62, 0.16], [0.79, 1.0], [0.88, 0.34], [1.00, 0.0],
  ]);
  c.fillRect(0, 0, SIZE, SIZE);
}

function drawStar(c: CanvasRenderingContext2D): void {
  const h = SIZE * 0.5;
  // A soft halo behind, so the star blooms rather than sitting there as a decal.
  c.fillStyle = radial(c, h, h, h * 0.96, [
    [0.00, 0.55], [0.30, 0.22], [0.70, 0.04], [1.00, 0.0],
  ]);
  c.fillRect(0, 0, SIZE, SIZE);

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

function drawFlare(c: CanvasRenderingContext2D): void {
  const h = SIZE * 0.5;
  c.fillStyle = radial(c, h, h, h * 0.42, [
    [0.00, 1.0], [0.22, 0.62], [0.55, 0.16], [1.00, 0.0],
  ]);
  c.fillRect(0, 0, SIZE, SIZE);

  // Two tapered spikes, added on top. Bloom turns these into the little
  // four-pointed pop that says "that just locked in".
  c.globalCompositeOperation = 'lighter';
  for (let axis = 0; axis < 2; axis++) {
    const gx = axis === 0
      ? c.createLinearGradient(0, 0, SIZE, 0)
      : c.createLinearGradient(0, 0, 0, SIZE);
    gx.addColorStop(0.00, white(0));
    gx.addColorStop(0.50, white(0.95));
    gx.addColorStop(1.00, white(0));
    c.fillStyle = gx;
    const thin = SIZE * 0.085;
    if (axis === 0) c.fillRect(0, h - thin * 0.5, SIZE, thin);
    else c.fillRect(h - thin * 0.5, 0, thin, SIZE);
  }
  c.globalCompositeOperation = 'source-over';
}

const DRAW: Array<(c: CanvasRenderingContext2D) => void> = [
  drawSpark, drawGlow, drawPuff, drawStreak, drawRing, drawStar, drawFlake, drawFlare,
];

/**
 * Build the atlas. One canvas, eight cells, mipmapped.
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
