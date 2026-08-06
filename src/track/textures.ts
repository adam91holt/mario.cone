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
  anisotropy = 4,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = wrap;
  tex.wrapT = wrap;
  tex.anisotropy = anisotropy;
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

/**
 * Asphalt. Tiles in both directions on a 12m pitch: u runs across the road, v
 * along it.
 *
 * The hard constraint is minification. The road is seen at a grazing angle, so
 * the along-track axis is crushed to nothing within twenty metres and any
 * detail that varies along v averages out to flat grey — which is exactly the
 * distance band a driver reads. What survives is *lateral* structure, because
 * across the road the texel density stays high. So the surface is built from
 * lengthwise features: polish lanes where the traffic runs, tonal breaks
 * between one pour of asphalt and the next, and only then the aggregate.
 */
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

  // Lengthwise polish lanes. Constant along v, so they survive every mip level
  // the road is ever drawn at — this is the single reason the tarmac stops
  // reading as a smooth plane at distance.
  for (let i = 0; i < 7; i++) {
    const x = rnd() * S;
    const w = 26 + rnd() * 64;
    const dark = rnd() > 0.42;
    const a = 0.09 + rnd() * 0.10;
    const grad = g.createLinearGradient(x - w, 0, x + w, 0);
    const col = dark ? '22,24,31' : '214,208,196';
    grad.addColorStop(0, `rgba(${col},0)`);
    grad.addColorStop(0.5, `rgba(${col},${a.toFixed(3)})`);
    grad.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = grad;
    g.fillRect(x - w, 0, w * 2, S);
    // Wrap the tail so the tile has no seam across the road.
    if (x - w < 0) { g.save(); g.translate(S, 0); g.fillRect(x - w, 0, w * 2, S); g.restore(); }
    if (x + w > S) { g.save(); g.translate(-S, 0); g.fillRect(x - w, 0, w * 2, S); g.restore(); }
  }

  // Tonal breaks: old repairs and sun bleaching, three times the amplitude they
  // used to carry so they still separate once the mip chain has had its way.
  for (let i = 0; i < 30; i++) {
    const x = rnd() * S, y = rnd() * S, r = 50 + rnd() * 150;
    const light = rnd() > 0.45;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.075 + rnd() * 0.075;
    grad.addColorStop(0, light ? `rgba(255,246,232,${a})` : `rgba(10,12,18,${a})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Coarse aggregate clumps — big enough to hold together for a mip level or
  // two, which is what puts texture on the road at 10-25m.
  for (let i = 0; i < S * 1.2; i++) {
    const x = rnd() * S, y = rnd() * S, r = 2.2 + rnd() * 4.4;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const light = rnd() > 0.5;
    grad.addColorStop(0, light ? 'rgba(226,222,214,0.20)' : 'rgba(14,15,20,0.24)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Chip: the stones themselves, lit top-left with a shadow bottom-right so
  // they read as gravel in a binder rather than as noise.
  for (let i = 0; i < S * 11; i++) {
    const x = rnd() * S, y = rnd() * S;
    const r = 0.5 + rnd() * 1.7;
    g.fillStyle = 'rgba(8,9,13,0.22)';
    g.beginPath(); g.arc(x + 0.6, y + 0.7, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = `rgba(236,232,224,${(0.10 + rnd() * 0.16).toFixed(3)})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }

  // A couple of tar-seam repairs for silhouette interest at close range.
  g.strokeStyle = 'rgba(20,20,26,0.26)';
  for (let i = 0; i < 3; i++) {
    g.lineWidth = 1.5 + rnd() * 2.5;
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

  return finish(c, key, THREE.RepeatWrapping, 8);
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

/**
 * Kerb / rumble strip. v runs along the track in metres; u runs across the
 * *block*, and the atlas is split so one texture skins both of its faces:
 *
 *   u 0.00 .. 0.63   the top, from the chamfered inner lip outward
 *   u 0.63 .. 1.00   the vertical outer face, in shadow under the lip
 *
 * The stripes line up in v across the split, so the block reads as one object
 * wrapped in paint rather than two ribbons that happen to touch.
 */
export function makeKerbTexture(opts: KerbOptions = {}): THREE.CanvasTexture {
  const a = opts.a ?? '#E33B2E';
  const b = opts.b ?? '#FFF8F0';
  const key = `kerb:${a}:${b}`;
  const hit = cached(key);
  if (hit) return hit;

  const W = 128, H = 128;
  const SPLIT = Math.round(W * 0.63);
  const [c, g] = canvas(W, H);
  g.fillStyle = b;
  g.fillRect(0, 0, W, H);
  g.fillStyle = a;
  g.fillRect(0, 0, W, H / 2);

  // Top face: a dark keyline where it meets the tarmac, a bright chamfer just
  // outboard of it, then a slow fall-off to the outer lip.
  const top = g.createLinearGradient(0, 0, SPLIT, 0);
  top.addColorStop(0, 'rgba(0,0,0,0.40)');
  top.addColorStop(0.10, 'rgba(0,0,0,0.06)');
  top.addColorStop(0.30, 'rgba(255,255,255,0.22)');
  top.addColorStop(1, 'rgba(0,0,0,0.10)');
  g.fillStyle = top;
  g.fillRect(0, 0, SPLIT, H);

  // Outer face: the same stripes, dropped into shade and darkening downward, so
  // the block has a side you can see rather than an edge you infer.
  const face = g.createLinearGradient(SPLIT, 0, W, 0);
  face.addColorStop(0, 'rgba(6,8,14,0.30)');
  face.addColorStop(0.35, 'rgba(6,8,14,0.46)');
  face.addColorStop(1, 'rgba(6,8,14,0.66)');
  g.fillStyle = face;
  g.fillRect(SPLIT, 0, W - SPLIT, H);
  // A hard highlight exactly on the arris — the lip catches the sun.
  g.fillStyle = 'rgba(255,250,240,0.5)';
  g.fillRect(SPLIT - 3, 0, 3, H);

  // Scuff marks where karts clip it.
  const rnd = rand(0x7f4a7c15);
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(40,34,30,${(0.05 + rnd() * 0.12).toFixed(3)})`;
    g.fillRect(rnd() * SPLIT, rnd() * H, 2 + rnd() * 10, 1 + rnd() * 3);
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
 *
 * The arrow's proportions are the whole trick. Mapped onto a 5.5m-wide strip at
 * 15m of tile, each arm sits about 30 degrees off the road axis; drawn any
 * shallower — as they were — perspective flattens the V into a horizontal bar
 * and the strip reads as a cattle grid instead of an arrow.
 */
export function makeBoostTexture(): THREE.CanvasTexture {
  const key = 'boost';
  const hit = cached(key);
  if (hit) return hit;

  const W = 128, H = 128;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#10141C';
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,107,26,0.16)';
  g.fillRect(0, 0, W, H);

  // Two chevrons per tile, apex toward +v — the direction of travel.
  const chevron = (yTop: number, depth: number, thick: number, color: string): void => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(W * 0.5, yTop);
    g.lineTo(W, yTop + depth);
    g.lineTo(W, yTop + depth + thick);
    g.lineTo(W * 0.5, yTop + thick);
    g.lineTo(0, yTop + depth + thick);
    g.lineTo(0, yTop + depth);
    g.closePath();
    g.fill();
  };
  for (let i = 0; i < 2; i++) {
    const y = i * (H / 2);
    chevron(y + 3, 40, 22, '#F07A12');   // shadow, offset down-track
    chevron(y, 40, 22, '#FFC300');
    chevron(y - 3, 40, 13, '#FFF6CE');   // hot inner edge along the leading arm
  }
  // Edge rails keep the strip's silhouette crisp against the tarmac.
  g.fillStyle = '#FF6B1A';
  g.fillRect(0, 0, 6, H);
  g.fillRect(W - 6, 0, 6, H);
  g.fillStyle = 'rgba(255,246,206,0.7)';
  g.fillRect(0, 0, 2, H);
  g.fillRect(W - 2, 0, 2, H);
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
  g.fillStyle = '#232833';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#4A515F';
  g.lineWidth = 4;
  g.strokeRect(2, 2, W - 4, H - 4);
  for (let i = 0; i < 5; i++) {
    const x = (i + 0.5) * (W / 5);
    g.fillStyle = '#3A1410';
    g.beginPath(); g.arc(x, H / 2, 22, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,140,80,0.16)';
    g.beginPath(); g.arc(x - 5, H / 2 - 6, 9, 0, Math.PI * 2); g.fill();
  }
  return finish(c, key, THREE.ClampToEdgeWrapping);
}

export function disposeTextureCache(): void {
  for (const t of _cache.values()) t.dispose();
  _cache.clear();
}
