// Procedural track textures.
//
// Everything is drawn to a canvas at load time — no image files, so the game
// stays a single self-contained bundle. Keep these readable at speed: the road
// edge has to pop in peripheral vision, and the centreline has to give a clear
// sense of motion without strobing.

import * as THREE from 'three';

export interface RoadTextureOptions {
  base?: string;
  line?: string;
  edge?: string;
  /** Width of the texture in px. Height is 4x for the along-track tiling. */
  size?: number;
}

const _cache = new Map<string, THREE.CanvasTexture>();

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas context unavailable');
  return [c, g];
}

/** Deterministic speckle — asphalt that is not a flat fill, without a noise lib. */
function speckle(g: CanvasRenderingContext2D, w: number, h: number, count: number, alpha: number): void {
  let s = 0x9e3779b9;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const x = rnd() * w, y = rnd() * h;
    const r = 0.5 + rnd() * 1.8;
    const light = rnd() > 0.5;
    g.fillStyle = light ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha * 1.3})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
}

/**
 * Road surface. U runs across the road (0 = left edge, 1 = right edge), V runs
 * along it, so the edge lines are baked into the texture rather than needing
 * extra geometry.
 */
export function makeRoadTexture(opts: RoadTextureOptions = {}): THREE.CanvasTexture {
  const key = `road:${JSON.stringify(opts)}`;
  const hit = _cache.get(key);
  if (hit) return hit;

  const base = opts.base ?? '#3A3D46';
  const line = opts.line ?? '#FFF8F0';
  const edge = opts.edge ?? '#FFC300';
  const W = opts.size ?? 256;
  const H = W * 4;
  const [c, g] = canvas(W, H);

  g.fillStyle = base;
  g.fillRect(0, 0, W, H);

  // Subtle cross-road gradient so the crown of the road catches light.
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0.25)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.06)');
  grad.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  speckle(g, W, H, W * 6, 0.05);

  // Solid edge lines, inset from the true edge so the verge reads separately.
  const edgeW = W * 0.035;
  const inset = W * 0.045;
  g.fillStyle = edge;
  g.fillRect(inset, 0, edgeW, H);
  g.fillRect(W - inset - edgeW, 0, edgeW, H);

  // Dashed centreline. Two dashes per tile keeps the strobe rate comfortable.
  g.fillStyle = line;
  const dashW = W * 0.028;
  const dashH = H * 0.16;
  const gap = H * 0.34;
  for (let y = 0; y < H; y += dashH + gap) {
    g.fillRect(W * 0.5 - dashW * 0.5, y, dashW, dashH);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  _cache.set(key, tex);
  return tex;
}

export interface RumbleOptions {
  a?: string;
  b?: string;
  stripes?: number;
  /** Stripes run along the strip rather than across it. */
  along?: boolean;
}

/** Hazard-stripe texture for verges, kerbs and barriers. */
export function makeRumbleTexture(opts: RumbleOptions = {}): THREE.CanvasTexture {
  const key = `rumble:${JSON.stringify(opts)}`;
  const hit = _cache.get(key);
  if (hit) return hit;

  const a = opts.a ?? '#E33B2E';
  const b = opts.b ?? '#FFF8F0';
  const stripes = opts.stripes ?? 6;
  const S = 128;
  const [c, g] = canvas(S, S);

  g.fillStyle = b;
  g.fillRect(0, 0, S, S);
  g.fillStyle = a;
  const step = S / stripes;
  for (let i = 0; i < stripes; i += 2) {
    if (opts.along) g.fillRect(i * step, 0, step, S);
    else g.fillRect(0, i * step, S, step);
  }

  // Bevel so the kerb does not read as a flat decal under direct sun.
  const grad = g.createLinearGradient(0, 0, S, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(0,0,0,0.28)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  _cache.set(key, tex);
  return tex;
}

/** Chequered start/finish banding. */
export function makeCheckerTexture(squares = 8, dark = '#22242B', light = '#FFF8F0'): THREE.CanvasTexture {
  const key = `checker:${squares}:${dark}:${light}`;
  const hit = _cache.get(key);
  if (hit) return hit;

  const S = 256;
  const [c, g] = canvas(S, S);
  const step = S / squares;
  for (let y = 0; y < squares; y++) {
    for (let x = 0; x < squares; x++) {
      g.fillStyle = (x + y) % 2 === 0 ? dark : light;
      g.fillRect(x * step, y * step, step, step);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  _cache.set(key, tex);
  return tex;
}

export function disposeTextureCache(): void {
  for (const t of _cache.values()) t.dispose();
  _cache.clear();
}
