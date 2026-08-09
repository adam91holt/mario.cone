// The grain of each of the four ground surfaces.
//
// The colour of the terrain comes from the vertex ramp in `theme.ts`; this is
// what it is *made of* up close. One canvas per landscape, drawn once and
// cached, tiling on a fixed metre pitch so the grain never swells or shrinks
// with the width of the road (same rule as `track/textures.ts`).
//
// Every one of them is deliberately near-white on average — around 0.93 — so
// the ramp keeps its hue and the texture only adds structure. A tinted detail
// map here would fight the palette and the palette would lose, which is how you
// get four courses that are one surface at four brightnesses.
//
// Only lateral-ish structure survives on a surface seen from a low camera, but
// unlike the road the terrain is mostly seen from *above* — the run-off from
// the chase camera, the whole landscape from the overhead and pulled-back
// shots. So these carry real two-dimensional pattern: cracks, chips, ruts.

import * as THREE from 'three';
import type { LandKey } from './theme.ts';

const _cache = new Map<LandKey, THREE.CanvasTexture>();

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) throw new Error('[groundtex] 2D canvas context unavailable');
  return [c, g];
}

/** Deterministic PRNG — the textures must be byte-identical on every boot. */
function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small angular chip. Reads as broken rock; a circle reads as a bubble. */
function chip(
  g: CanvasRenderingContext2D, rnd: () => number,
  x: number, y: number, r: number, fill: string,
): void {
  const n = 4 + ((rnd() * 3) | 0);
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd() * 0.5;
    const rr = r * (0.62 + rnd() * 0.5);
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

/** Draw `fn` nine times so anything crossing an edge wraps into the tile. */
function wrapped(
  g: CanvasRenderingContext2D, S: number, x: number, y: number, reach: number,
  fn: (px: number, py: number) => void,
): void {
  fn(x, y);
  if (x < reach) fn(x + S, y);
  if (x > S - reach) fn(x - S, y);
  if (y < reach) fn(x, y + S);
  if (y > S - reach) fn(x, y - S);
  if (x < reach && y < reach) fn(x + S, y + S);
  if (x > S - reach && y > S - reach) fn(x - S, y - S);
  if (x < reach && y > S - reach) fn(x + S, y - S);
  if (x > S - reach && y < reach) fn(x - S, y + S);
}

// ── canyon: sun-baked dust over gravel ─────────────────────────────────────

function canyonCanvas(): HTMLCanvasElement {
  const S = 512;
  const [c, g] = canvas(S);
  const rnd = rand(0x2f9c1a77);

  g.fillStyle = '#EFEAE0';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 90; i++) {
    const x = rnd() * S, y = rnd() * S, r = 20 + rnd() * 130;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const v = rnd() > 0.5 ? '255,252,244' : '176,166,150';
    grad.addColorStop(0, `rgba(${v},0.22)`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Sparse scrub tufts, so the ground is not a bare sheet of dust.
  for (let i = 0; i < 240; i++) {
    const x = rnd() * S, y = rnd() * S, r = 2 + rnd() * 7;
    g.fillStyle = `rgba(${120 + rnd() * 30 | 0},${132 + rnd() * 30 | 0},96,${0.16 + rnd() * 0.22})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < S * 4; i++) {
    const x = rnd() * S, y = rnd() * S;
    g.fillStyle = rnd() > 0.5 ? 'rgba(255,255,250,0.10)' : 'rgba(120,108,92,0.10)';
    g.fillRect(x, y, 1.5, 1.5);
  }
  return c;
}

// ── quarry: crusher run, tracked over ──────────────────────────────────────
//
// Angular chips at two sizes over a fines matrix, plus the thing that actually
// says "quarry" from a moving kart: parallel haul-truck ruts, dark and damp,
// running one way across the whole tile.

function quarryCanvas(): HTMLCanvasElement {
  const S = 512;
  const [c, g] = canvas(S);
  const rnd = rand(0x71c3d015);

  g.fillStyle = '#E9E5DB';
  g.fillRect(0, 0, S, S);

  // Ruts first, so the aggregate lies on top of them.
  for (let i = 0; i < 9; i++) {
    const x = rnd() * S;
    const w = 8 + rnd() * 26;
    const grad = g.createLinearGradient(x - w, 0, x + w, 0);
    const a = 0.10 + rnd() * 0.14;
    grad.addColorStop(0, 'rgba(74,72,68,0)');
    grad.addColorStop(0.5, `rgba(74,72,68,${a.toFixed(3)})`);
    grad.addColorStop(1, 'rgba(74,72,68,0)');
    g.fillStyle = grad;
    wrapped(g, S, x, S * 0.5, w * 2, (px) => g.fillRect(px - w, 0, w * 2, S));
  }

  // Blast rock: big pale spalls with a shadowed underside.
  for (let i = 0; i < 130; i++) {
    const x = rnd() * S, y = rnd() * S, r = 5 + rnd() * 13;
    const v = 168 + ((rnd() * 62) | 0);
    wrapped(g, S, x, y, r + 3, (px, py) => {
      chip(g, rand(0x400 + i), px, py + 1.6, r, 'rgba(88,86,82,0.30)');
      chip(g, rand(0x400 + i), px, py, r, `rgba(${v},${v - 4},${v - 12},0.62)`);
    });
  }
  // Crusher fines.
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * S, y = rnd() * S, r = 1 + rnd() * 3;
    const dark = rnd() > 0.55;
    g.fillStyle = dark
      ? `rgba(96,96,98,${0.14 + rnd() * 0.2})`
      : `rgba(246,242,232,${0.16 + rnd() * 0.22})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  return c;
}

// ── saltpan: cracked evaporite crust ───────────────────────────────────────
//
// The polygon network is the single most recognisable ground texture there is,
// and it costs one two-nearest-site pass. Sites are laid on a jittered lattice
// and searched with wrap, so the tile is seamless in both directions; the crack
// is the ridge where the two nearest sites are equidistant.

function saltpanCanvas(): HTMLCanvasElement {
  const S = 512;
  const [c, g] = canvas(S);
  const rnd = rand(0x5ab10c3f);
  // Sixteen plates across a 48-metre tile puts a polygon at three metres, which
  // is the size a real crust cracks at and — more to the point — the size that
  // still reads as a *pattern* from the overhead camera rather than as paving.
  const N = 16;
  const cell = S / N;
  const sx = new Float32Array(N * N);
  const sy = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      sx[j * N + i] = (i + 0.14 + rnd() * 0.72) * cell;
      sy[j * N + i] = (j + 0.14 + rnd() * 0.72) * cell;
    }
  }

  const img = g.createImageData(S, S);
  const px = img.data;
  for (let y = 0; y < S; y++) {
    const gj = Math.floor(y / cell);
    for (let x = 0; x < S; x++) {
      const gi = Math.floor(x / cell);
      let d1 = 1e9, d2 = 1e9;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = ((gi + di) % N + N) % N;
          const jj = ((gj + dj) % N + N) % N;
          const ox = (gi + di - ii) * cell;
          const oy = (gj + dj - jj) * cell;
          const ddx = sx[jj * N + ii]! + ox - x;
          const ddy = sy[jj * N + ii]! + oy - y;
          const dd = Math.sqrt(ddx * ddx + ddy * ddy);
          if (dd < d1) { d2 = d1; d1 = dd; } else if (dd < d2) { d2 = dd; }
        }
      }
      // Ridge distance. Wide and soft: a hairline crack disappears in the first
      // mip level and the pan goes back to being a blank sheet.
      const edge = Math.min(1, (d2 - d1) / 7.5);
      const crack = 1 - edge * edge;
      // The plates themselves lift slightly at their rims, so the crust reads
      // as tiles rather than as a drawn net.
      const lift = Math.min(1, (d2 - d1) / 26);
      const v = 252 - crack * 74 + lift * 3;
      const i = (y * S + x) * 4;
      px[i] = v;
      px[i + 1] = v - crack * 5;
      px[i + 2] = v - crack * 12;
      px[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  // Wind-blown dust drifts and the odd patch of damp, low amplitude.
  for (let i = 0; i < 40; i++) {
    const x = rnd() * S, y = rnd() * S, r = 40 + rnd() * 140;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const warm = rnd() > 0.45;
    grad.addColorStop(0, warm ? 'rgba(214,203,178,0.16)' : 'rgba(178,196,198,0.15)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return c;
}

// ── alpine: schist scree and lichen ────────────────────────────────────────

function alpineCanvas(): HTMLCanvasElement {
  const S = 512;
  const [c, g] = canvas(S);
  const rnd = rand(0x1de0b6b3);

  g.fillStyle = '#ECEDE8';
  g.fillRect(0, 0, S, S);

  // Broad tonal fields: bare rock against turf. Big shapes, because at fifty
  // metres this is the only thing left of the texture.
  for (let i = 0; i < 46; i++) {
    const x = rnd() * S, y = rnd() * S, r = 42 + rnd() * 120;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const turf = rnd() > 0.5;
    grad.addColorStop(0, turf ? 'rgba(126,140,92,0.26)' : 'rgba(158,160,156,0.24)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Scree: flat schist plates, all lying roughly the same way down the slope.
  for (let i = 0; i < 420; i++) {
    const x = rnd() * S, y = rnd() * S, r = 3 + rnd() * 9;
    const v = 150 + ((rnd() * 76) | 0);
    wrapped(g, S, x, y, r + 3, (pxx, pyy) => {
      g.save();
      g.translate(pxx, pyy);
      g.rotate(0.5 + rnd() * 0.3);
      g.scale(1, 0.52);
      chip(g, rand(0x900 + i), 0, 1.4, r, 'rgba(70,74,76,0.26)');
      chip(g, rand(0x900 + i), 0, 0, r, `rgba(${v},${v + 2},${v + 4},0.58)`);
      g.restore();
    });
  }
  // Lichen. Small, high-chroma, and the reason alpine rock is never neutral.
  for (let i = 0; i < 700; i++) {
    const x = rnd() * S, y = rnd() * S, r = 1.4 + rnd() * 3.6;
    const gold = rnd() > 0.62;
    g.fillStyle = gold
      ? `rgba(196,178,96,${0.14 + rnd() * 0.2})`
      : `rgba(124,146,104,${0.13 + rnd() * 0.2})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  return c;
}

const BUILDERS: Record<LandKey, () => HTMLCanvasElement> = {
  canyon: canyonCanvas,
  quarry: quarryCanvas,
  saltpan: saltpanCanvas,
  alpine: alpineCanvas,
};

/** The detail map for a landscape. Built once, then shared for the session. */
export function groundTexture(land: LandKey): THREE.CanvasTexture {
  const hit = _cache.get(land);
  if (hit) return hit;
  const tex = new THREE.CanvasTexture(BUILDERS[land]());
  tex.name = `ground:${land}`;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 2;
  _cache.set(land, tex);
  return tex;
}

export function disposeGroundTextures(): void {
  for (const t of _cache.values()) t.dispose();
  _cache.clear();
}
