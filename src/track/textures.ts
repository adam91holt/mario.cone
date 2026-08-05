// Procedural track textures.
//
// Everything is drawn to a canvas at load time — no image files, so the game
// stays a single self-contained bundle. Two rules govern all of them:
//
//   * Tiling in metres, not in road widths. The road narrows from 30m to 23m
//     around the lap; a texture stretched across the ribbon would make the
//     asphalt grain visibly swell and shrink with it. Every surface here tiles
//     on a fixed metre pitch and the painted markings are geometry instead.
//   * Readable at 60 m/s. Detail that cannot survive being three pixels tall is
//     detail that only shows up as noise, so contrast lives in big shapes and
//     the fine grain is kept low-amplitude.

import * as THREE from 'three';

const _cache = new Map<string, THREE.CanvasTexture>();

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas context unavailable');
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

function finish(
  c: HTMLCanvasElement, key: string,
  wrap: THREE.Wrapping = THREE.RepeatWrapping,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = wrap;
  tex.wrapT = wrap;
  tex.anisotropy = 4;
  _cache.set(key, tex);
  return tex;
}

const cached = (key: string): THREE.CanvasTexture | undefined => _cache.get(key);

// ── surfaces ───────────────────────────────────────────────────────────────

export interface RoadTextureOptions {
  base?: string;
  /** Legacy fields kept so a course theme written against the old builder still
   *  loads; markings are geometry now. */
  line?: string;
  edge?: string;
  size?: number;
}

/** Asphalt. Tiles in both directions on a 8m pitch. */
export function makeAsphaltTexture(opts: RoadTextureOptions = {}): THREE.CanvasTexture {
  const key = `asphalt:${opts.base ?? ''}`;
  const hit = cached(key);
  if (hit) return hit;

  const base = opts.base ?? '#3A3D46';
  const S = 512;
  const [c, g] = canvas(S, S);
  const rnd = rand(0x9e3779b9);

  g.fillStyle = base;
  g.fillRect(0, 0, S, S);

  // Big soft patches first: old repairs and sun bleaching. These are what stop
  // the road reading as a flat grey plane from a distance.
  for (let i = 0; i < 26; i++) {
    const x = rnd() * S, y = rnd() * S, r = 40 + rnd() * 120;
    const light = rnd() > 0.45;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.035 + rnd() * 0.035;
    grad.addColorStop(0, light ? `rgba(255,246,232,${a})` : `rgba(12,14,20,${a})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Aggregate. Wrapped so the tile has no seam.
  for (let i = 0; i < S * 9; i++) {
    const x = rnd() * S, y = rnd() * S;
    const r = 0.4 + rnd() * 1.5;
    const light = rnd() > 0.5;
    g.fillStyle = light ? `rgba(255,255,255,0.05)` : `rgba(0,0,0,0.07)`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  // A couple of tar-seam repairs for silhouette interest at close range.
  g.strokeStyle = 'rgba(22,22,28,0.16)';
  for (let i = 0; i < 2; i++) {
    g.lineWidth = 1.5 + rnd() * 1.5;
    g.beginPath();
    let x = rnd() * S, y = 0;
    g.moveTo(x, y);
    while (y < S) {
      y += 24;
      x += (rnd() - 0.5) * 40;
      g.lineTo(x, y);
    }
    g.stroke();
  }

  return finish(c, key);
}

/** Compacted gravel for the verges and run-off. */
export function makeGravelTexture(tint = '#9E6A44'): THREE.CanvasTexture {
  const key = `gravel:${tint}`;
  const hit = cached(key);
  if (hit) return hit;

  const S = 512;
  const [c, g] = canvas(S, S);
  const rnd = rand(0x51ed270b);

  g.fillStyle = tint;
  g.fillRect(0, 0, S, S);

  for (let i = 0; i < 40; i++) {
    const x = rnd() * S, y = rnd() * S, r = 30 + rnd() * 90;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, rnd() > 0.5 ? 'rgba(255,226,186,0.08)' : 'rgba(74,44,24,0.10)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Pebbles: a light top and a dark shadow so they read as volume, not dots.
  for (let i = 0; i < S * 6; i++) {
    const x = rnd() * S, y = rnd() * S, r = 0.8 + rnd() * 2.6;
    g.fillStyle = 'rgba(60,38,20,0.30)';
    g.beginPath(); g.arc(x + 0.7, y + 0.9, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = `rgba(255,240,214,${0.10 + rnd() * 0.22})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  return finish(c, key);
}

/**
 * Detail for the canyon floor. Deliberately near-neutral: the terrain carries
 * its colour in vertex data (dust near the road, rock on the slopes, bleached
 * sand on the tops), and a tinted texture on top of that would multiply the two
 * into mud.
 */
export function makeGroundTexture(): THREE.CanvasTexture {
  const key = 'ground';
  const hit = cached(key);
  if (hit) return hit;

  const S = 512;
  const [c, g] = canvas(S, S);
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
  // Scrub: sparse tufts, so the ground is not a bare sheet of dust.
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
  return finish(c, key);
}

// ── markings and trim ──────────────────────────────────────────────────────

export interface KerbOptions {
  a?: string;
  b?: string;
  /** Stripe pitch in metres along the track. */
  pitch?: number;
}

/** Kerb / rumble strip. u runs across the kerb, v along the track in metres. */
export function makeKerbTexture(opts: KerbOptions = {}): THREE.CanvasTexture {
  const a = opts.a ?? '#E33B2E';
  const b = opts.b ?? '#FFF8F0';
  const key = `kerb:${a}:${b}`;
  const hit = cached(key);
  if (hit) return hit;

  const W = 64, H = 128;
  const [c, g] = canvas(W, H);
  g.fillStyle = b;
  g.fillRect(0, 0, W, H);
  g.fillStyle = a;
  g.fillRect(0, 0, W, H / 2);

  // A dark keyline along the inner edge and a highlight along the outer one:
  // the kerb reads as a raised block even where the mesh is nearly flat.
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0.34)');
  grad.addColorStop(0.28, 'rgba(255,255,255,0.16)');
  grad.addColorStop(1, 'rgba(0,0,0,0.16)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  // Scuff marks where karts clip it.
  const rnd = rand(0x7f4a7c15);
  for (let i = 0; i < 70; i++) {
    g.fillStyle = `rgba(40,34,30,${0.05 + rnd() * 0.12})`;
    g.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 10, 1 + rnd() * 3);
  }
  return finish(c, key);
}

/** Flat paint for edge lines and grid boxes. */
export function makePaintTexture(color = '#FFF8F0'): THREE.CanvasTexture {
  const key = `paint:${color}`;
  const hit = cached(key);
  if (hit) return hit;
  const S = 64;
  const [c, g] = canvas(S, S);
  g.fillStyle = color;
  g.fillRect(0, 0, S, S);
  const rnd = rand(0x1b56a3d1);
  for (let i = 0; i < 220; i++) {
    g.fillStyle = `rgba(60,56,52,${0.04 + rnd() * 0.10})`;
    g.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 4, 1 + rnd() * 2);
  }
  return finish(c, key);
}

/** Chequered band for the start/finish line. u across, v along. */
export function makeCheckerTexture(squares = 8, dark = '#22242B', light = '#FFF8F0'): THREE.CanvasTexture {
  const key = `checker:${squares}:${dark}:${light}`;
  const hit = cached(key);
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
  return finish(c, key);
}

/**
 * Boost strip: chevrons pointing down the road on a dark bed. v is the
 * along-track axis and scrolls at runtime, which is what makes the strip feel
 * like it is pulling you forward before you have even touched it.
 */
export function makeBoostTexture(): THREE.CanvasTexture {
  const key = 'boost';
  const hit = cached(key);
  if (hit) return hit;

  const W = 128, H = 128;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#141821';
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,107,26,0.20)';
  g.fillRect(0, 0, W, H);

  // Two chevrons per tile, pointing toward -v (the direction of travel).
  const chevron = (yTop: number, h: number, color: string): void => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(W * 0.5, yTop);
    g.lineTo(W, yTop + h * 0.55);
    g.lineTo(W, yTop + h);
    g.lineTo(W * 0.5, yTop + h * 0.45);
    g.lineTo(0, yTop + h);
    g.lineTo(0, yTop + h * 0.55);
    g.closePath();
    g.fill();
  };
  for (let i = 0; i < 2; i++) {
    const y = i * (H / 2);
    chevron(y + 4, H * 0.42, '#FFC300');
    chevron(y + 2, H * 0.42, '#FFF4C2');
  }
  // Edge rails keep the strip's silhouette crisp against the tarmac.
  g.fillStyle = '#FF6B1A';
  g.fillRect(0, 0, 5, H);
  g.fillRect(W - 5, 0, 5, H);
  return finish(c, key);
}

/** Worn tyre tracks for the gravel shortcut. Alpha-blended over the verge. */
export function makeTrackedGravelTexture(): THREE.CanvasTexture {
  const key = 'tracked';
  const hit = cached(key);
  if (hit) return hit;

  const W = 128, H = 256;
  const [c, g] = canvas(W, H);
  const rnd = rand(0x3ac0ffee);
  g.clearRect(0, 0, W, H);
  // Two worn ruts, darker and smoother than the gravel around them.
  for (const cx of [W * 0.34, W * 0.66]) {
    const grad = g.createLinearGradient(cx - 22, 0, cx + 22, 0);
    grad.addColorStop(0, 'rgba(96,66,38,0)');
    grad.addColorStop(0.5, 'rgba(96,66,38,0.55)');
    grad.addColorStop(1, 'rgba(96,66,38,0)');
    g.fillStyle = grad;
    g.fillRect(cx - 22, 0, 44, H);
  }
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(60,40,22,${0.05 + rnd() * 0.12})`;
    g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 6, 1);
  }
  return finish(c, key);
}

// ── built structures ───────────────────────────────────────────────────────

/** Barrier panel: hazard chevrons, a steel rail and bolt heads. */
export function makeBarrierTexture(): THREE.CanvasTexture {
  const key = 'barrier';
  const hit = cached(key);
  if (hit) return hit;

  const W = 256, H = 128;
  const [c, g] = canvas(W, H);

  g.fillStyle = '#E8E2D6';
  g.fillRect(0, 0, W, H);

  // Diagonal hazard stripes across the lower two thirds.
  g.save();
  g.beginPath();
  g.rect(0, H * 0.30, W, H * 0.70);
  g.clip();
  g.fillStyle = '#FF6B1A';
  const pitch = W / 4;
  for (let i = -2; i < 8; i++) {
    g.beginPath();
    g.moveTo(i * pitch, H);
    g.lineTo(i * pitch + pitch * 0.5, H);
    g.lineTo(i * pitch + pitch * 0.5 + H, 0);
    g.lineTo(i * pitch + H, 0);
    g.closePath();
    g.fill();
  }
  g.restore();

  // Steel capping rail along the top.
  const rail = g.createLinearGradient(0, 0, 0, H * 0.30);
  rail.addColorStop(0, '#C6CEDA');
  rail.addColorStop(0.55, '#8E99A8');
  rail.addColorStop(1, '#5C6472');
  g.fillStyle = rail;
  g.fillRect(0, 0, W, H * 0.30);
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.fillRect(0, H * 0.05, W, 3);

  // Bolts.
  const rnd = rand(0x6cf12d33);
  for (let i = 0; i < 4; i++) {
    const x = (i + 0.5) * (W / 4);
    for (const y of [H * 0.42, H * 0.86]) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath(); g.arc(x + 1, y + 1, 4, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#B7BFCB';
      g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill();
    }
  }
  // Grime along the bottom edge, so it looks installed rather than printed.
  const dirt = g.createLinearGradient(0, H, 0, H * 0.72);
  dirt.addColorStop(0, 'rgba(96,72,42,0.5)');
  dirt.addColorStop(1, 'rgba(96,72,42,0)');
  g.fillStyle = dirt;
  g.fillRect(0, H * 0.72, W, H * 0.28);
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(70,50,30,${rnd() * 0.15})`;
    g.fillRect(rnd() * W, H * 0.5 + rnd() * H * 0.5, 2 + rnd() * 14, 1 + rnd() * 3);
  }
  return finish(c, key);
}

/** Painted concrete for barrier bases, gantry legs and posts. */
export function makeConcreteTexture(): THREE.CanvasTexture {
  const key = 'concrete';
  const hit = cached(key);
  if (hit) return hit;
  const S = 256;
  const [c, g] = canvas(S, S);
  const rnd = rand(0x11ce7a09);
  g.fillStyle = '#D9D3C6';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 60; i++) {
    const x = rnd() * S, y = rnd() * S, r = 12 + rnd() * 60;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, rnd() > 0.5 ? 'rgba(255,255,255,0.16)' : 'rgba(110,104,94,0.16)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 700; i++) {
    g.fillStyle = `rgba(90,84,74,${rnd() * 0.10})`;
    g.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  return finish(c, key);
}

/** Direction-marker board: a stack of chevrons pointing into the corner. */
export function makeSignTexture(): THREE.CanvasTexture {
  const key = 'sign';
  const hit = cached(key);
  if (hit) return hit;
  const W = 128, H = 64;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#141821';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#FFC300';
  for (let i = 0; i < 3; i++) {
    const x = 8 + i * 40;
    g.beginPath();
    g.moveTo(x, 8);
    g.lineTo(x + 26, H / 2);
    g.lineTo(x, H - 8);
    g.lineTo(x + 12, H - 8);
    g.lineTo(x + 38, H / 2);
    g.lineTo(x + 12, 8);
    g.closePath();
    g.fill();
  }
  return finish(c, key, THREE.ClampToEdgeWrapping);
}

/** The gantry banner. Course name, chequer trim, high-vis everything. */
export function makeBannerTexture(name: string): THREE.CanvasTexture {
  const key = `banner:${name}`;
  const hit = cached(key);
  if (hit) return hit;

  const W = 1024, H = 128;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#1A1E27';
  g.fillRect(0, 0, W, H);

  // Chequer trim top and bottom.
  const sq = 16;
  for (let x = 0; x < W / sq; x++) {
    for (const [y, off] of [[0, 0], [H - sq, 1]] as const) {
      g.fillStyle = (x + off) % 2 === 0 ? '#FFF8F0' : '#22242B';
      g.fillRect(x * sq, y, sq, sq);
    }
  }
  // Hazard flashes at each end.
  for (const flip of [0, 1]) {
    g.save();
    g.translate(flip ? W : 0, 0);
    g.scale(flip ? -1 : 1, 1);
    g.beginPath();
    g.rect(0, sq, 150, H - sq * 2);
    g.clip();
    g.fillStyle = '#FF6B1A';
    for (let i = -1; i < 5; i++) {
      g.beginPath();
      g.moveTo(i * 44, H);
      g.lineTo(i * 44 + 22, H);
      g.lineTo(i * 44 + 22 + H, 0);
      g.lineTo(i * 44 + H, 0);
      g.closePath();
      g.fill();
    }
    g.restore();
  }

  g.font = '900 62px "Trebuchet MS", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#0E1116';
  g.fillText(name.toUpperCase(), W / 2 + 3, H / 2 + 4);
  g.fillStyle = '#FFC300';
  g.fillText(name.toUpperCase(), W / 2, H / 2);
  return finish(c, key, THREE.ClampToEdgeWrapping);
}

/** Start-light housing face: five dark lenses on a black board. */
export function makeLightBoardTexture(): THREE.CanvasTexture {
  const key = 'lights';
  const hit = cached(key);
  if (hit) return hit;
  const W = 320, H = 80;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#12151C';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#2A2F3A';
  g.lineWidth = 4;
  g.strokeRect(2, 2, W - 4, H - 4);
  for (let i = 0; i < 5; i++) {
    const x = (i + 0.5) * (W / 5);
    g.fillStyle = '#2A0E08';
    g.beginPath(); g.arc(x, H / 2, 22, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,120,60,0.10)';
    g.beginPath(); g.arc(x - 5, H / 2 - 6, 9, 0, Math.PI * 2); g.fill();
  }
  return finish(c, key, THREE.ClampToEdgeWrapping);
}

export function disposeTextureCache(): void {
  for (const t of _cache.values()) t.dispose();
  _cache.clear();
}
