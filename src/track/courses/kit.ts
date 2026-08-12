// What each circuit is *built out of* — the arrival structure over the line and
// the barrier down both edges of the road.
//
// ── the finding this answers ───────────────────────────────────────────────
//
// A critic played the cup after the four layouts were re-cut and scored it 7/10
// on a single sentence: *"the four circuits are now genuinely different shapes
// but they are still the same place."* The evidence was four screenshots taken
// from the grid — `cone-canyon-grid.png`, `jackhammer-quarry-grid.png`,
// `saltpan-bypass-grid.png`, `switchback-summit-grid.png` — which shared, to
// the pixel, the same yellow truss gantry, the same navy hazard-striped banner
// with gold type, the same five-bulb light rig, the same chequered strip, and
// the same orange-and-white striped panel barrier on grey drums for the entire
// lap. Only the terrain tint and the sky changed.
//
// That is not a decoration problem. **The barrier is the second-largest object
// in the frame after the tarmac**, it is on screen for every metre of every
// lap, and the arrival structure is what the player stares at for the whole
// countdown — the establishing shot of the course, held for four seconds while
// nothing else moves. Two objects, and they were constants.
//
// ── why this is a system and not a builder ─────────────────────────────────
//
// `track/gantry.ts`, `track/barriers.ts` and `track/road.ts` each build exactly
// one of their thing, unconditionally, and none of them belongs to this module.
// So the kit listens for `track:built`, hides the stock pieces the course has
// replaced, and stands its own where they were. That is precisely the
// intervention `render/ground.ts` already makes on the shoulder gravel —
// *"only the material's map is swapped… the smallest possible intervention that
// makes the shoulder answer to the course"* — and it carries the same promise:
// the moment `track/` grows a barrier vocabulary of its own, this file
// evaporates into a parameter.
//
// Nothing here touches the driving. The barrier is drawn where physics already
// stops a kart (`width/2 + verge - 0.8`), the road surface, its width, its
// kerb *geometry* and every collision line are road.ts's and stay road.ts's.
// A kit changes what the circuit is made of, never where it goes.
//
// ── the rules a kit is held to ─────────────────────────────────────────────
//
//   1. **Silhouette first.** The four barriers have four profiles, not four
//      palettes: a striped board on posts, a continuous concrete batter, a low
//      capped wall and a slatted timber fence you can see the landscape
//      through. Read as black shapes at a hundred metres they are still four
//      things.
//   2. **The road stays readable.** Nothing gets taller than the stock 1.5m
//      panel and nothing leans over the tarmac, because the barrier's real job
//      is to say where the road ends at 60 m/s.
//   3. **Everything the countdown needs comes with it.** An arrival piece that
//      replaces the gantry replaces its banner *and* its five-lamp board, off
//      `config.race.startLights` — the same table `race/stage.ts` draws the
//      screen board from. Two boards, one truth, and no course may ship a dead
//      signal over its own grid.
//   4. **Build cost only.** Every texture is drawn once and cached by key,
//      every repeated part is instanced, and `update()` does nothing but sway a
//      banner and toggle five lamp meshes. No allocation in any hot path.
//
// ── and one thing in here that is not a kit ────────────────────────────────
//
// `unfoldSkirt`, at the bottom. It is the fix for the chase camera driving
// underground — a player report, reproduced by `tools/underground.mjs` on two
// of these four circuits — and it is here because it is a defect in a landscape
// the courses in this directory are the ones to expose, and because
// `track/terrain.ts` is not this module's file. It runs on every course, kit or
// no kit, and it is a no-op on a circuit that does not fold back over itself.
// Its own comment says what it is, what it measured, and where it belongs.

import * as THREE from 'three';
import { MeshBuilder, fbm, noise2, smoothstep, surfacePoint, type Lane } from '../geom.ts';
import { makeCheckerTexture, makeKerbTexture, makePaintTexture } from '../textures.ts';
import { config } from '../../core/config.ts';
import { features, type BarrierKind, type ChapterDef, type KitDef } from './types.ts';
import type { TrackSpline } from '../spline.ts';
import type {
  CourseDef, GameContext, GameSystem, SplineSample, Track,
} from '../../types.ts';

// ── texture bench ──────────────────────────────────────────────────────────
//
// Same three rules as `track/textures.ts`: drawn to a canvas at build time so
// the game ships no image files, tiled in **metres** rather than in road
// widths, and cached by key so that resetting the race a hundred times through
// the harness allocates one of each. Nothing here reads a clock or
// `Math.random`, so two boots of the same course are the same pixels.

const _cache = new Map<string, THREE.CanvasTexture>();

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas context unavailable');
  return [c, g];
}

/** Deterministic PRNG. The grain has to be byte-identical on every boot. */
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

function tex(
  key: string, w: number, h: number,
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
  wrap: THREE.Wrapping = THREE.RepeatWrapping,
): THREE.CanvasTexture {
  const hit = _cache.get(key);
  if (hit) return hit;
  const [c, g] = canvas(w, h);
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = wrap;
  t.wrapT = wrap;
  t.anisotropy = 4;
  _cache.set(key, t);
  return t;
}

// ── the four barrier skins ─────────────────────────────────────────────────
//
// u runs **across the profile** — 0 at the toe on the road side, 1 at the back
// — and v runs along the track in metres, which is what keeps a stripe the same
// size on a 34-metre salt highway and a 12-metre quarry cut.

/** Concrete jersey: a battered grey face with black-and-yellow toe bands. */
function jerseyTexture(): THREE.CanvasTexture {
  return tex('kit:jersey', 128, 256, (g, W, H) => {
    const rnd = rand(0x51b7a3);
    // Base concrete, lighter along the top of the batter where rain washes it.
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#8E8A80');
    grad.addColorStop(0.34, '#C9C4B6');
    grad.addColorStop(0.62, '#DAD5C7');
    grad.addColorStop(1, '#9A958A');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    // Pour joints every 3m of v — the panels are cast, not extruded.
    for (let i = 0; i < 4; i++) {
      const y = (i + 0.5) * (H / 4);
      g.fillStyle = 'rgba(48,44,38,0.42)';
      g.fillRect(0, y, W, 2);
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(0, y + 2, W, 1);
    }
    // The toe band: hazard black and yellow on the lowest third of the face,
    // which is the part a wheel actually meets.
    g.save();
    g.beginPath(); g.rect(0, 0, W * 0.30, H); g.clip();
    g.fillStyle = '#F2B705';
    g.fillRect(0, 0, W * 0.30, H);
    g.fillStyle = '#22262E';
    const pitch = H / 6;
    for (let i = -1; i < 8; i++) {
      g.beginPath();
      g.moveTo(0, i * pitch);
      g.lineTo(0, i * pitch + pitch * 0.5);
      g.lineTo(W * 0.30, i * pitch + pitch * 0.5 - W * 0.30);
      g.lineTo(W * 0.30, i * pitch - W * 0.30);
      g.closePath();
      g.fill();
    }
    g.restore();
    // Rock dust down the whole face, heaviest at the toe.
    for (let i = 0; i < 420; i++) {
      const x = rnd() * W;
      const a = 0.05 + 0.16 * (1 - x / W);
      g.fillStyle = `rgba(120,114,100,${(rnd() * a).toFixed(3)})`;
      g.fillRect(x, rnd() * H, 1 + rnd() * 3, 1 + rnd() * 8);
    }
    // Scuffs where a kart has been along it.
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(30,28,26,${(0.05 + rnd() * 0.14).toFixed(3)})`;
      g.fillRect(rnd() * W * 0.5, rnd() * H, 2 + rnd() * 5, 3 + rnd() * 26);
    }
  });
}

/** Salt works: white render, blue capping, crust creeping up the foot. */
function seawallTexture(): THREE.CanvasTexture {
  return tex('kit:seawall', 128, 256, (g, W, H) => {
    const rnd = rand(0x2ad9f1);
    g.fillStyle = '#EFEDE4';
    g.fillRect(0, 0, W, H);
    // The blue capping owns the top band of the profile.
    const cap = g.createLinearGradient(W * 0.42, 0, W, 0);
    cap.addColorStop(0, '#2E6C9E');
    cap.addColorStop(0.45, '#3E82B8');
    cap.addColorStop(1, '#22557D');
    g.fillStyle = cap;
    g.fillRect(W * 0.42, 0, W * 0.58, H);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(W * 0.42, 0, 3, H);
    // Render courses. Wide, shallow, slightly uneven — a wall somebody built.
    for (let i = 0; i < 6; i++) {
      const y = (i + 0.5) * (H / 6);
      g.fillStyle = 'rgba(150,148,138,0.32)';
      g.fillRect(0, y, W * 0.42, 1.5);
    }
    // Crust: salt blooming out of the foot, which is where the pan wets it.
    for (let i = 0; i < 320; i++) {
      const x = rnd() * W * 0.34;
      g.fillStyle = `rgba(255,255,255,${(0.10 + rnd() * 0.55).toFixed(3)})`;
      g.beginPath();
      g.arc(x, rnd() * H, 1 + rnd() * 4.5, 0, Math.PI * 2);
      g.fill();
    }
    // Tide staining just above it, so the crust reads as deposited rather than
    // as noise.
    const stain = g.createLinearGradient(W * 0.24, 0, W * 0.42, 0);
    stain.addColorStop(0, 'rgba(150,140,110,0.30)');
    stain.addColorStop(1, 'rgba(150,140,110,0)');
    g.fillStyle = stain;
    g.fillRect(W * 0.24, 0, W * 0.18, H);
  });
}

/**
 * Timber snow fence: vertical slats with real gaps.
 *
 * The gaps are the whole point and they are **alpha**, not paint — a snow fence
 * you cannot see the mountain through is a painted wall. u runs up the fence
 * (0 at the foot, 1 at the cap) and v along the road, so a slat is a band in v
 * and the two rails are bands in u.
 */
function snowfenceTexture(): THREE.CanvasTexture {
  return tex('kit:snowfence', 64, 128, (g, W, H) => {
    const rnd = rand(0x7c31d5);
    g.clearRect(0, 0, W, H);
    // Four slats per 2m of road: a 31cm board on a 50cm pitch. The gap is what
    // makes it a snow fence rather than a hoarding, and the board is what makes
    // it read as one at a hundred metres — under about half and half it stops
    // being either.
    const SLATS = 4;
    for (let i = 0; i < SLATS; i++) {
      const y = i * (H / SLATS);
      const wSlat = (H / SLATS) * 0.62;
      const shade = 0.84 + 0.16 * rnd();
      const r = Math.round(0x9a * shade), gg = Math.round(0x6d * shade), b = Math.round(0x4a * shade);
      g.fillStyle = `rgb(${r},${gg},${b})`;
      g.fillRect(0, y, W, wSlat);
      // Weathered top edge and a dark grain line down each board.
      g.fillStyle = 'rgba(226,214,192,0.30)';
      g.fillRect(0, y, W, 1.5);
      g.fillStyle = 'rgba(24,16,10,0.35)';
      g.fillRect(0, y + wSlat - 1.5, W, 1.5);
      for (let k = 0; k < 5; k++) {
        g.fillStyle = `rgba(40,26,16,${(0.06 + rnd() * 0.12).toFixed(3)})`;
        g.fillRect(rnd() * W, y + 2, 1 + rnd() * 2, wSlat - 4);
      }
    }
    // Two horizontal rails, opaque all the way along, so the fence hangs
    // together instead of reading as loose sticks.
    for (const [u, h] of [[0.22, 5], [0.80, 5]] as const) {
      g.fillStyle = '#6B4A32';
      g.fillRect(u * W, 0, h, H);
      g.fillStyle = 'rgba(232,220,198,0.28)';
      g.fillRect(u * W, 0, 1.5, H);
    }
    // Snow packed along the foot of the fence.
    const snow = g.createLinearGradient(0, 0, W * 0.16, 0);
    snow.addColorStop(0, 'rgba(255,255,255,0.92)');
    snow.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = snow;
    g.fillRect(0, 0, W * 0.16, H);
  }, THREE.RepeatWrapping);
}

/**
 * The name banner. Course-specific livery rather than one navy plate with the
 * name swapped, which is what the four grid shots had in common.
 */
function bannerTexture(name: string, s: { field: string; ink: string; strip: string }): THREE.CanvasTexture {
  return tex(`kit:banner:${name}:${s.field}:${s.ink}:${s.strip}`, 1024, 128, (g, W, H) => {
    g.fillStyle = s.field;
    g.fillRect(0, 0, W, H);
    // A single strip top and bottom rather than a full hazard field: the name
    // is the message and the livery is the frame.
    g.fillStyle = s.strip;
    g.fillRect(0, 0, W, 9);
    g.fillRect(0, H - 9, W, 9);
    g.fillStyle = 'rgba(0,0,0,0.16)';
    g.fillRect(0, 13, W, 4);
    g.fillRect(0, H - 17, W, 4);
    g.font = '900 62px "Trebuchet MS", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.42)';
    g.fillText(name.toUpperCase(), W / 2 + 3, H / 2 + 4);
    g.fillStyle = s.ink;
    g.fillText(name.toUpperCase(), W / 2, H / 2);
  }, THREE.ClampToEdgeWrapping);
}

/** The housing five lamps sit proud of. Painted; the lenses are meshes. */
function lampBoardTexture(steel: number): THREE.CanvasTexture {
  const hex = `#${steel.toString(16).padStart(6, '0')}`;
  return tex(`kit:board:${hex}`, 320, 80, (g, W, H) => {
    g.fillStyle = '#1A1D24';
    g.fillRect(0, 0, W, H);
    g.fillStyle = hex;
    g.fillRect(0, 0, W, 7);
    g.fillRect(0, H - 7, W, 7);
    for (let i = 0; i < 5; i++) {
      const x = (i + 0.5) * (W / 5);
      g.fillStyle = '#0B0D12';
      g.beginPath(); g.arc(x, H / 2, 26, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(210,215,225,0.55)';
      g.lineWidth = 3;
      g.beginPath(); g.arc(x, H / 2, 26, 0, Math.PI * 2); g.stroke();
    }
  }, THREE.ClampToEdgeWrapping);
}

/**
 * The belt housing's skin: dark works grey with a hazard band along the bottom
 * edge and a rivet line every course.
 *
 * Tiled along the bridge rather than stretched over it — sixty-seven metres of
 * one unstretched decal is a pale slab, and a pale slab across the top of the
 * frame is what a monorail looks like.
 */
function conveyorSkin(): THREE.CanvasTexture {
  return tex('kit:conveyorSkin', 128, 128, (g, W, H) => {
    const rnd = rand(0x28ba61);
    const base = g.createLinearGradient(0, 0, 0, H);
    base.addColorStop(0, '#79848C');
    base.addColorStop(0.55, '#5C666D');
    base.addColorStop(1, '#454E55');
    g.fillStyle = base;
    g.fillRect(0, 0, W, H);
    // Hazard band along the lower edge — v = 0 is the bottom of the box.
    g.fillStyle = '#F2B705';
    g.fillRect(0, H * 0.70, W, H * 0.22);
    g.fillStyle = '#22262E';
    for (let i = -1; i < 6; i++) {
      g.beginPath();
      g.moveTo(i * (W / 4), H * 0.92);
      g.lineTo(i * (W / 4) + W / 8, H * 0.92);
      g.lineTo(i * (W / 4) + W / 8 + H * 0.22, H * 0.70);
      g.lineTo(i * (W / 4) + H * 0.22, H * 0.70);
      g.closePath();
      g.fill();
    }
    g.fillStyle = 'rgba(10,12,16,0.45)';
    g.fillRect(0, H * 0.92, W, H * 0.08);
    // Ribs and rivets.
    for (let i = 0; i < 4; i++) {
      const x = (i + 0.5) * (W / 4);
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(x, 0, 2, H * 0.70);
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(x + 2, 0, 2, H * 0.70);
    }
    for (let i = 0; i < 180; i++) {
      g.fillStyle = `rgba(150,144,130,${(rnd() * 0.16).toFixed(3)})`;
      g.fillRect(rnd() * W, rnd() * H * 0.7, 1 + rnd() * 5, 1 + rnd() * 2);
    }
  });
}

/** Galvanised plate, for jetty decks and pylon cross-arms. */
function plateTexture(key: string, base: string, dark: string): THREE.CanvasTexture {
  return tex(`kit:plate:${key}`, 128, 128, (g, W, H) => {
    const rnd = rand(0x3f9c22);
    g.fillStyle = base;
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(255,255,255,${(rnd() * 0.10).toFixed(3)})`;
      g.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 14, 1 + rnd() * 3);
    }
    for (let i = 0; i < 6; i++) {
      g.fillStyle = dark;
      g.fillRect(0, i * (H / 6), W, 1.5);
    }
  });
}

// ── the barrier ────────────────────────────────────────────────────────────

/**
 * Everything a barrier profile needs to know, resolved once.
 *
 * `edge(s)` is the line **physics enforces** — `width/2 + verge`. Every profile
 * below is quoted as an offset from it, so a kart pressed against the barrier
 * is resting on the thing it can see whatever the course's width does.
 */
interface BarrierCtx {
  spline: TrackSpline;
  verge: number;
  edge(s: SplineSample): number;
  root: THREE.Group;
  materials: THREE.Material[];
}

type Profile = Array<{ off: number; lift: number; u: number }>;

/** Sweep one profile down both sides of the circuit as a single mesh. */
function sweep(
  c: BarrierCtx, name: string, profile: Profile, mat: THREE.Material, vScale: number,
): void {
  const b = new MeshBuilder();
  for (const side of [-1, 1] as const) {
    const lanes: Lane[] = profile.map((p) => ({
      lat: (s: SplineSample) => side * (c.edge(s) + p.off),
      lift: () => p.lift,
      u: p.u,
    }));
    if (side < 0) lanes.reverse();
    b.addRibbon(c.spline, lanes, { verge: c.verge, step: 3, vScale, closed: true });
  }
  if (b.isEmpty) return;
  const mesh = new THREE.Mesh(b.toGeometry(), mat);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  c.root.add(mesh);
}

/**
 * Concrete jersey barrier — Jackhammer Quarry.
 *
 * The real profile, because the real profile is the recognisable thing: a
 * near-vertical 7cm toe, a 55° batter up to about knee height, then a steep
 * upper face to a flat 1.05m top. No posts, no rail, no gaps. A pit wall.
 */
function buildJersey(c: BarrierCtx): void {
  const mat = new THREE.MeshLambertMaterial({ map: jerseyTexture(), side: THREE.DoubleSide });
  c.materials.push(mat);
  sweep(c, 'kitJersey', [
    { off: 0.00, lift: -0.40, u: 0.00 },
    { off: 0.06, lift: 0.06, u: 0.06 },
    { off: 0.30, lift: 0.34, u: 0.30 },
    { off: 0.40, lift: 1.02, u: 0.66 },
    { off: 0.62, lift: 1.10, u: 0.80 },
    { off: 0.84, lift: 1.02, u: 0.90 },
    { off: 0.96, lift: -0.40, u: 1.00 },
  ], mat, 3.2);
}

/**
 * Salt-crusted low wall — Saltpan Bypass.
 *
 * 0.82m and no higher. A 1.5m panel run down 3.5km of lake bed fences in the
 * one view this circuit is built around, and the course already declares
 * `wallHeight: 1.1` for the same reason.
 */
function buildSeawall(c: BarrierCtx): void {
  const mat = new THREE.MeshLambertMaterial({ map: seawallTexture(), side: THREE.DoubleSide });
  c.materials.push(mat);
  sweep(c, 'kitSeawall', [
    { off: 0.00, lift: -0.40, u: 0.00 },
    { off: 0.10, lift: 0.10, u: 0.10 },
    { off: 0.20, lift: 0.74, u: 0.50 },
    { off: 0.28, lift: 0.82, u: 0.62 },
    { off: 0.60, lift: 0.82, u: 0.74 },
    { off: 0.68, lift: 0.72, u: 0.86 },
    { off: 0.78, lift: -0.40, u: 1.00 },
  ], mat, 2.6);
}

/**
 * Timber snow fence — Switchback Summit.
 *
 * Three pieces: a bank of packed snow along the foot, the slatted screen
 * standing on it (alpha-tested, so the mountain shows through the gaps), and a
 * raking post every four metres holding it up. The posts are one InstancedMesh.
 */
function buildSnowFence(c: BarrierCtx): void {
  const bankMat = new THREE.MeshLambertMaterial({ color: 0xdfe8ef });
  const fenceMat = new THREE.MeshLambertMaterial({
    map: snowfenceTexture(),
    side: THREE.DoubleSide,
    // 0.35, not 0.5. A 30cm board on a 50cm pitch mips down to roughly 60%
    // coverage, and a half-alpha cut erodes the fence away exactly where a
    // player is looking longest — down the road, at distance.
    alphaTest: 0.35,
    transparent: false,
  });
  c.materials.push(bankMat, fenceMat);

  sweep(c, 'kitSnowBank', [
    { off: 0.00, lift: -0.40, u: 0.00 },
    { off: 0.16, lift: 0.22, u: 0.30 },
    { off: 0.52, lift: 0.30, u: 0.60 },
    { off: 0.78, lift: -0.40, u: 1.00 },
  ], bankMat, 4);

  // The screen itself: a single vertical plane. u is height up the fence, so
  // the texture's rails and slats land where they were drawn.
  const screen = new MeshBuilder();
  for (const side of [-1, 1] as const) {
    const lanes: Lane[] = [
      { lat: (s) => side * (c.edge(s) + 0.34), lift: () => 0.10, u: 0 },
      { lat: (s) => side * (c.edge(s) + 0.30), lift: () => 1.68, u: 1 },
    ];
    if (side < 0) lanes.reverse();
    screen.addRibbon(c.spline, lanes, { verge: c.verge, step: 2, vScale: 2, closed: true });
  }
  const screenMesh = new THREE.Mesh(screen.toGeometry(), fenceMat);
  screenMesh.name = 'kitSnowFence';
  screenMesh.castShadow = true;
  c.root.add(screenMesh);

  // Raking posts. One box geometry, one draw call, both sides of the lap.
  const L = c.spline.length;
  const STEP = 4.5;
  const per = Math.max(4, Math.floor(L / STEP));
  const geo = new THREE.BoxGeometry(0.16, 1, 0.16);
  geo.translate(0, 0.5, 0);
  const postMat = new THREE.MeshLambertMaterial({ color: 0x5c4130 });
  c.materials.push(postMat);
  const posts = new THREE.InstancedMesh(geo, postMat, per * 2);
  posts.name = 'kitFencePosts';
  posts.castShadow = true;
  const s: SplineSample = c.spline.atDistance(0);
  const pos = new THREE.Vector3();
  const up = new THREE.Vector3();
  const right = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const scl = new THREE.Vector3();
  const lean = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  let n = 0;
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < per; i++) {
      c.spline.atDistance((i / per) * L, s);
      surfacePoint(s, side * (c.edge(s) + 0.52), c.verge, 0.18, pos);
      up.copy(s.up);
      right.copy(s.right);
      fwd.crossVectors(right, up).normalize();
      m.makeBasis(right, up, fwd);
      q.setFromRotationMatrix(m);
      // Rake the post back away from the road, which is how a snow fence
      // stands and what stops it reading as a row of railway sleepers.
      lean.setFromAxisAngle(fwd, side * 0.17);
      q.multiply(lean);
      scl.set(1, 2.02, 1);
      m.compose(pos, q, scl);
      posts.setMatrixAt(n++, m);
    }
  }
  posts.count = n;
  posts.instanceMatrix.needsUpdate = true;
  c.root.add(posts);
}

// ── the arrival structures ─────────────────────────────────────────────────

/**
 * Struts, collected so an entire lattice is one InstancedMesh.
 *
 * Lifted from `track/gantry.ts`, which is the right shape for the problem and
 * not exported. Two hundred members at two draw calls is what makes a lattice
 * affordable at all.
 */
class Struts {
  readonly list: THREE.Matrix4[] = [];
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private scl = new THREE.Vector3();

  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number): void {
    this.a.set(ax, ay, az);
    this.b.set(bx, by, bz);
    this.dir.subVectors(this.b, this.a);
    const len = this.dir.length();
    if (len < 1e-4) return;
    this.dir.divideScalar(len);
    this.q.setFromUnitVectors(UP, this.dir);
    this.scl.set(t, len, t);
    this.list.push(new THREE.Matrix4().compose(
      this.a.addScaledVector(this.dir, len * 0.5), this.q, this.scl,
    ));
  }

  mesh(color: number, name: string, materials: THREE.Material[]): THREE.InstancedMesh {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.4 });
    materials.push(mat);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, this.list.length);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (let i = 0; i < this.list.length; i++) mesh.setMatrixAt(i, this.list[i]!);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

const _shade = new THREE.Color();
/** A darker mix of a kit colour, so one declared steel can carry two values. */
function shade(color: number, f: number): number {
  return _shade.setHex(color).multiplyScalar(f).getHex();
}

/** A square lattice tower from `y0` to `y1`, half-width `r`, centred at `cx`. */
function tower(st: Struts, cx: number, y0: number, y1: number, r: number, splay = 1.3): void {
  for (const ox of [-r, r]) {
    for (const oz of [-r, r]) {
      st.add(cx + ox * splay, y0, oz * splay, cx + ox, y1, oz, 0.22);
    }
  }
  for (let y = y0 + 0.6; y < y1; y += 1.8) {
    const f = 1 + (splay - 1) * Math.max(0, 1 - (y - y0) / (y1 - y0));
    st.add(cx - r * f, y, -r * f, cx + r * f, y, -r * f, 0.12);
    st.add(cx - r * f, y, r * f, cx + r * f, y, r * f, 0.12);
    st.add(cx - r * f, y, -r * f, cx - r * f, y, r * f, 0.12);
    st.add(cx + r * f, y, -r * f, cx + r * f, y, r * f, 0.12);
    const flip = Math.round((y - y0) / 1.8) % 2 === 0 ? 1 : -1;
    st.add(cx - r * f, y, flip * r * f, cx + r * f, y + 1.8, flip * r * f, 0.10);
    st.add(cx + r * f, y, -flip * r * f, cx - r * f, y + 1.8, -flip * r * f, 0.10);
  }
}

interface ArrivalParts {
  /** Sways every frame. A dead-still banner reads as a photograph. */
  banner: THREE.Object3D;
  /** The five lenses, hidden until the count arms. */
  lamps: THREE.Mesh[];
}

interface BuildArgs {
  group: THREE.Group;
  /** Half the road plus the shoulder plus clearance: where a leg may stand. */
  span: number;
  kit: KitDef;
  name: string;
  materials: THREE.Material[];
}

/** Height of the banner's hanging point. The same on every structure, so the
 *  signage rig is interchangeable and only the thing carrying it changes. */
const BANNER_Y = 9.2;

/**
 * Hang the name banner at `BANNER_Y`, on drop rods reaching up to whatever is
 * carrying it. The height is the same on all four structures on purpose: the
 * signage rig is interchangeable and only the thing over it changes.
 */
function addBanner(a: BuildArgs, width: number, carriedAt: number): THREE.Object3D {
  const style = a.kit.banner ?? { field: '#1B2A4A', ink: '#FFC300', strip: '#FF6B1A' };
  const map = bannerTexture(a.name, style);
  const mat = new THREE.MeshStandardMaterial({
    map,
    roughness: 0.78,
    side: THREE.DoubleSide,
    // **The name has to survive being lit from behind.**
    //
    // The grid shot stands the camera *under* the arrival structure looking up
    // the road, which is the side of the banner the sun is not on — and this is
    // a `DoubleSide` plane, so what a player sees on the establishing shot of
    // three of the four rounds is the back face, keyed by nothing but ambient.
    // A critic read Switchback Summit's plate as "grey type on a dark navy
    // plate, close to illegible", and the texture under it is #F2F7FB on
    // #123B52 — about as much contrast as two colours can carry. It was not the
    // livery, it was the light.
    //
    // The map doubles as its own emissive, so the *ink* carries a floor of its
    // own and the field does not: white text lifts, the navy plate stays navy,
    // and the contrast goes up rather than the whole sign going flat. A third
    // is a sign that is legible in shade, not a sign that glows.
    emissive: 0xffffff,
    emissiveMap: map,
    emissiveIntensity: 0.34,
  });
  a.materials.push(mat);

  if (carriedAt > BANNER_Y + 0.2) {
    const rodMat = new THREE.MeshStandardMaterial({ color: 0x333a44, roughness: 0.55, metalness: 0.4 });
    a.materials.push(rodMat);
    const h = carriedAt - BANNER_Y;
    const geo = new THREE.BoxGeometry(0.13, h, 0.13);
    geo.translate(0, h * 0.5, 0);
    for (const x of [-width * 0.42, width * 0.42]) {
      const rod = new THREE.Mesh(geo, rodMat);
      rod.position.set(x, BANNER_Y, 0);
      rod.castShadow = true;
      a.group.add(rod);
    }
  }

  const pivot = new THREE.Group();
  pivot.position.set(0, BANNER_Y, 0);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, 2.5), mat);
  mesh.position.y = -1.25;
  mesh.castShadow = true;
  pivot.add(mesh);
  a.group.add(pivot);
  return pivot;
}

function addLampBoard(a: BuildArgs, y: number): THREE.Mesh[] {
  const steel = a.kit.steel ?? 0xf0d64a;
  const boardMat = new THREE.MeshStandardMaterial({
    map: lampBoardTexture(steel), roughness: 0.5, side: THREE.DoubleSide,
  });
  a.materials.push(boardMat);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.6), boardMat);
  board.position.set(0, y, 0.12);
  board.castShadow = true;
  a.group.add(board);

  // Two hangers, so the board is bolted to something.
  const hangMat = new THREE.MeshStandardMaterial({ color: 0x30363f, roughness: 0.6 });
  a.materials.push(hangMat);
  for (const side of [-1, 1]) {
    const hang = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.0, 0.12), hangMat);
    hang.position.set(side * 2.6, y + 1.8, 0.12);
    a.group.add(hang);
  }

  // The lenses. Unlit on purpose — a bulb is a light source, not a surface.
  const geo = new THREE.CircleGeometry(0.44, 14);
  const red = new THREE.MeshBasicMaterial({ color: 0xff2a16, toneMapped: false });
  a.materials.push(red);
  const lamps: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(geo, red);
    m.position.set((i + 0.5) * (6.4 / 5) - 3.2, 0, 0.04);
    m.visible = false;
    m.frustumCulled = false;
    board.add(m);
    lamps.push(m);
  }
  return lamps;
}

/**
 * **The quarry conveyor.** An inclined overland belt crossing the haul road on
 * two steel trestles, running shot rock from the crusher out to the stockpile.
 *
 * The belt is what makes it read: it climbs across the frame instead of
 * spanning it level, so the structure has a direction and the grid is standing
 * *under* something that is working rather than beside a decoration.
 */
function buildConveyor(a: BuildArgs): ArrivalParts {
  const steel = a.kit.steel ?? 0x7f8a92;
  const accent = a.kit.accent ?? 0xf2b705;
  const span = a.span;
  const st = new Struts();
  // Trestles. The far one stands five metres taller, because the belt is
  // climbing — the whole silhouette is a diagonal and that is the point.
  const LOW = 11.0, HIGH = 16.4;
  tower(st, -span, -3, LOW, 1.15);
  tower(st, span, -3, HIGH, 1.15);
  // The hanger beam the signage rig swings from, slung under the bridge on two
  // short rods. A banner hung off nothing is the tell that a structure was
  // designed round a fitting rather than the other way about.
  st.add(-13, BANNER_Y + 1.4, 0, 13, BANNER_Y + 1.4, 0, 0.28);
  st.add(-10, BANNER_Y + 1.4, 0, -10, 11.3, 0, 0.15);
  st.add(10, BANNER_Y + 1.4, 0, 10, 13.5, 0, 0.15);
  a.group.add(st.mesh(steel, 'kitConveyorTrestle', a.materials));

  // The belt housing: a long box, rolled about z so it climbs left to right.
  const run = span * 2 + 26;
  const angle = Math.atan2(HIGH - LOW, span * 2);
  const belt = new THREE.Group();
  belt.position.set(0, (LOW + HIGH) * 0.5, 0);
  belt.rotation.z = angle;

  const skin = conveyorSkin();
  skin.repeat.set(run / 6, 1);
  const hoodMat = new THREE.MeshStandardMaterial({ map: skin, roughness: 0.62, metalness: 0.25 });
  a.materials.push(hoodMat);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(run, 1.7, 2.9), hoodMat);
  housing.castShadow = true;
  housing.receiveShadow = true;
  belt.add(housing);

  // A rounded hood on top — the silhouette people recognise a conveyor by.
  // Matte and darker than the frame: a polished half-cylinder sixty metres long
  // catches the whole sky and photographs as a white slab across the top of the
  // frame, which is what a monorail looks like.
  const capMat = new THREE.MeshStandardMaterial({
    color: shade(steel, 0.72), roughness: 0.78, metalness: 0.12,
  });
  a.materials.push(capMat);
  // A full barrel rather than a half shell. A half-cylinder has to be aimed —
  // `thetaLength` selects an arc, the arc rotates with the group, and a hood
  // that ends up on the *underside* leaves the flat top of the housing facing
  // the sky, which is exactly the pale slab this was drawn to get rid of.
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, run, 14), capMat);
  cap.rotation.z = Math.PI * 0.5;
  cap.position.y = 0.62;
  cap.castShadow = true;
  belt.add(cap);

  // Toe boards and a walkway handrail down the near side, in high-vis.
  const railMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5 });
  a.materials.push(railMat);
  for (const y of [-0.72, 0.55, 1.15]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(run, 0.13, 0.13), railMat);
    rail.position.set(0, y, -1.75);
    rail.castShadow = true;
    belt.add(rail);
  }
  const stanchion = new THREE.BoxGeometry(0.11, 1.7, 0.11);
  const stan = new THREE.InstancedMesh(stanchion, railMat, 18);
  stan.name = 'kitConveyorRail';
  stan.castShadow = true;
  const m = new THREE.Matrix4();
  for (let i = 0; i < 18; i++) {
    m.makeTranslation(-run * 0.5 + (i + 0.5) * (run / 18), 0.25, -1.75);
    stan.setMatrixAt(i, m);
  }
  stan.instanceMatrix.needsUpdate = true;
  belt.add(stan);

  // The stringer truss under the belt. Forty metres of unsupported housing
  // reads as a floating box; a Warren web under it reads as a bridge.
  const web = new Struts();
  const bays = Math.max(8, Math.round(run / 4.2));
  for (let i = 0; i < bays; i++) {
    const x0 = -run * 0.5 + i * (run / bays);
    const x1 = x0 + run / bays;
    for (const dz of [-1.3, 1.3]) {
      web.add(x0, -1.6, dz, x1, -1.6, dz, 0.16);
      web.add(x0, -0.85, dz, x0, -1.6, dz, 0.12);
      web.add(x0, -0.85, dz, x1, -1.6, dz, 0.10);
    }
    if (i % 2 === 0) web.add(x0, -1.6, -1.3, x0, -1.6, 1.3, 0.10);
  }
  belt.add(web.mesh(steel, 'kitConveyorWeb', a.materials));
  a.group.add(belt);

  // The head chute, dropping fines off the high end onto a cone of stockpile
  // outside the barrier. This is what tells you which way the belt runs.
  const chuteMat = new THREE.MeshStandardMaterial({ color: 0x5d666e, roughness: 0.7 });
  a.materials.push(chuteMat);
  const chute = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 2.0, 10, 8), chuteMat);
  chute.position.set(span + 12, 12.6, 0);
  chute.castShadow = true;
  a.group.add(chute);
  const pileMat = new THREE.MeshLambertMaterial({ color: 0xa9a396 });
  a.materials.push(pileMat);
  const pile = new THREE.Mesh(new THREE.ConeGeometry(9, 11, 14), pileMat);
  pile.position.set(span + 12, 2.6, 0);
  pile.castShadow = true;
  pile.receiveShadow = true;
  a.group.add(pile);

  // Operator cabin bolted to the near trestle.
  const cabMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.55 });
  a.materials.push(cabMat);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.4, 2.4), cabMat);
  cab.position.set(-span - 2.1, 5.6, 0);
  cab.castShadow = true;
  a.group.add(cab);
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x1d2a33, roughness: 0.2, metalness: 0.5 });
  a.materials.push(glassMat);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(2.66, 1.1, 1.9), glassMat);
  glass.position.set(-span - 2.1, 6.2, 0);
  a.group.add(glass);

  return {
    banner: addBanner(a, Math.min(span * 2 - 2, 26), BANNER_Y + 1.4),
    lamps: addLampBoard(a, BANNER_Y - 3.4),
  };
}

/**
 * **The salt-loading jetty.** A timber-piled deck crossing the bypass, with two
 * loading chutes hanging over the road and a heap of raw salt on the deck.
 *
 * It is horizontal where the conveyor climbs and pale where the conveyor is
 * grey, and it stands on piles rather than lattice — three different words for
 * "the thing over the start line".
 */
function buildJetty(a: BuildArgs): ArrivalParts {
  const steel = a.kit.steel ?? 0x2e6c9e;
  const accent = a.kit.accent ?? 0xffffff;
  const span = a.span;

  const timber = plateTexture('jettyTimber', '#D8D0BC', 'rgba(120,108,86,0.45)');
  const timberMat = new THREE.MeshStandardMaterial({ map: timber, roughness: 0.85 });
  a.materials.push(timberMat);

  // Piles: three per side, cross-braced, standing in salt.
  const pileGeo = new THREE.CylinderGeometry(0.46, 0.54, 13.6, 8);
  const piles = new THREE.InstancedMesh(pileGeo, timberMat, 6);
  piles.name = 'kitJettyPiles';
  piles.castShadow = true;
  piles.receiveShadow = true;
  const m = new THREE.Matrix4();
  let n = 0;
  for (const side of [-1, 1]) {
    for (const dz of [-3.2, 0, 3.2]) {
      m.makeTranslation(side * span, 3.4, dz);
      piles.setMatrixAt(n++, m);
    }
  }
  piles.instanceMatrix.needsUpdate = true;
  a.group.add(piles);

  const brace = new Struts();
  for (const side of [-1, 1]) {
    brace.add(side * span, 1.2, -3.2, side * span, 9.6, 3.2, 0.16);
    brace.add(side * span, 1.2, 3.2, side * span, 9.6, -3.2, 0.16);
    brace.add(side * span - 1.4, 9.8, 0, side * span + 1.4, 9.8, 0, 0.2);
  }
  // The span itself, and it is a **through** truss — the web stands on top of
  // the deck rather than under it. Nothing may stand between the pile lines,
  // because that is the road, so sixty metres has to be carried rather than
  // propped; and putting the steel above the deck leaves the underside clean
  // for the banner and the loading chutes instead of fighting them for the one
  // band of air the driver looks through.
  {
    const bays = Math.max(10, Math.round((span * 2) / 5.5));
    for (let i = 0; i <= bays; i++) {
      const x0 = -span + i * ((span * 2) / bays);
      const x1 = x0 + (span * 2) / bays;
      for (const dz of [-3.2, 3.2]) {
        if (i < bays) {
          brace.add(x0, 10.7, dz, x1, 10.7, dz, 0.20);
          brace.add(x0, 13.5, dz, x1, 13.5, dz, 0.20);
          brace.add(x0, 10.7, dz, x1, 13.5, dz, 0.12);
        }
        brace.add(x0, 10.7, dz, x0, 13.5, dz, 0.14);
      }
      if (i % 2 === 0) brace.add(x0, 13.5, -3.2, x0, 13.5, 3.2, 0.12);
    }
  }
  a.group.add(brace.mesh(steel, 'kitJettyBrace', a.materials));

  // The deck.
  const deckW = span * 2 + 9;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(deckW, 0.55, 7.2), timberMat);
  deck.position.set(0, 10.35, 0);
  deck.castShadow = true;
  deck.receiveShadow = true;
  a.group.add(deck);

  // A windrow of raw salt heaped down the middle of the deck, between the two
  // truss walls: the jetty has cargo on it, so it is a working jetty and not a
  // footbridge with a name on it.
  const saltMat = new THREE.MeshLambertMaterial({ color: 0xf6f4ec });
  a.materials.push(saltMat);
  const heap = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 1.6, deckW * 0.66, 10), saltMat);
  heap.rotation.z = Math.PI * 0.5;
  heap.position.set(0, 11.4, 0);
  heap.castShadow = true;
  a.group.add(heap);

  // Two loading chutes hanging off the deck ends, each with a dribble of salt
  // caught in mid-fall and a cone of it built up underneath. This is the one
  // thing on this circuit that reads as *vertical* on a lake bed where nothing
  // else does, and it is what makes the deck a working jetty rather than a
  // footbridge with a name on it.
  //
  // **Outside the barrier line, and that is a rule rather than a composition
  // choice.** What comes out of a chute lands, and a three-metre heap of salt
  // standing on twelve metres of drivable crust is an obstacle the course never
  // declared and physics has never heard of. Everything the world module places
  // starts outside the barrier footing for the same reason; so does this.
  const chuteMat = new THREE.MeshStandardMaterial({ color: steel, roughness: 0.5, metalness: 0.3 });
  a.materials.push(chuteMat);
  for (const sx of [-1.12, 1.12]) {
    const chute = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 0.75, 3.4, 10), chuteMat);
    chute.position.set(sx * span, 8.3, 0);
    chute.castShadow = true;
    a.group.add(chute);
    const fall = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.72, 2.6, 8), saltMat);
    fall.position.set(sx * span, 5.6, 0);
    a.group.add(fall);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(3.4, 3.6, 12), saltMat);
    cone.position.set(sx * span, 1.6, 0);
    cone.castShadow = true;
    cone.receiveShadow = true;
    a.group.add(cone);
  }

  // The works plate on the deck fascia, white on works blue.
  const fasciaMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.7 });
  a.materials.push(fasciaMat);
  const fascia = new THREE.Mesh(new THREE.BoxGeometry(deckW, 0.85, 0.2), fasciaMat);
  fascia.position.set(0, 9.9, 3.7);
  a.group.add(fascia);

  return {
    banner: addBanner(a, Math.min(span * 2 - 2, 30), 10.05),
    lamps: addLampBoard(a, BANNER_Y - 3.4),
  };
}

/**
 * **The cable-car pylon pair.** A tall galvanised lattice mast on one side of
 * the road and a shorter one on the other, a pair of cables slung between them
 * with two gondolas hanging on the span, and a portal beam under the cables
 * carrying the name and the lights.
 *
 * The gondolas are the point. They are the only part of any arrival structure
 * that is *above* the frame line, so the mountain's start is the only one where
 * a player looks up.
 */
function buildPylon(a: BuildArgs): ArrivalParts {
  const steel = a.kit.steel ?? 0xb7c0c9;
  const accent = a.kit.accent ?? 0xe04a2b;
  const span = a.span;
  const TALL = 23.5, SHORT = 16.5;

  const st = new Struts();
  tower(st, -span, -3, TALL, 1.5, 1.6);
  tower(st, span, -3, SHORT, 1.3, 1.5);
  // Cross-arms at the head of each mast.
  for (const [cx, h, w] of [[-span, TALL, 3.6], [span, SHORT, 3.2]] as const) {
    st.add(cx - w, h, 0, cx + w, h, 0, 0.26);
    st.add(cx - w, h, 0, cx, h - 2.4, 0, 0.16);
    st.add(cx + w, h, 0, cx, h - 2.4, 0, 0.16);
  }
  // The portal beam the signage hangs off, plus its knee braces.
  st.add(-span, BANNER_Y + 1.5, 0, span, BANNER_Y + 1.5, 0, 0.30);
  st.add(-span + 0.6, BANNER_Y + 1.5, 0, -span + 0.6, BANNER_Y + 4.2, 0, 0.14);
  st.add(span - 0.6, BANNER_Y + 1.5, 0, span - 0.6, BANNER_Y + 4.2, 0, 0.14);
  st.add(-span, BANNER_Y + 4.2, 0, -span + 3.4, BANNER_Y + 1.5, 0, 0.13);
  st.add(span, BANNER_Y + 4.2, 0, span - 3.4, BANNER_Y + 1.5, 0, 0.13);

  // The two cables. Straight members chained through a shallow sag, because a
  // dead-straight cable over a valley reads as a scaffold pole.
  const SEGS = 14;
  for (const dz of [-2.6, 2.6]) {
    for (let i = 0; i < SEGS; i++) {
      const t0 = i / SEGS, t1 = (i + 1) / SEGS;
      const yOf = (t: number): number =>
        TALL + (SHORT - TALL) * t - 2.6 * Math.sin(Math.PI * t);
      st.add(-span + t0 * span * 2, yOf(t0), dz, -span + t1 * span * 2, yOf(t1), dz, 0.11);
    }
  }
  a.group.add(st.mesh(steel, 'kitPylonMast', a.materials));

  // Gondolas, hung off the downhill cable at two points along the span.
  const cabMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.4, metalness: 0.1 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x16222c, roughness: 0.18, metalness: 0.55 });
  const armMat = new THREE.MeshStandardMaterial({ color: 0x39424c, roughness: 0.5, metalness: 0.5 });
  a.materials.push(cabMat, glassMat, armMat);
  for (const [t, dz] of [[0.34, -2.6], [0.68, 2.6]] as const) {
    const y = TALL + (SHORT - TALL) * t - 2.6 * Math.sin(Math.PI * t);
    const x = -span + t * span * 2;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.6, 0.16), armMat);
    arm.position.set(x, y - 1.3, dz);
    arm.castShadow = true;
    a.group.add(arm);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.9, 2.3), cabMat);
    cab.position.set(x, y - 4.1, dz);
    cab.castShadow = true;
    a.group.add(cab);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(2.36, 1.25, 2.36), glassMat);
    glass.position.set(x, y - 3.7, dz);
    a.group.add(glass);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.24, 2.5), armMat);
    roof.position.set(x, y - 2.6, dz);
    roof.castShadow = true;
    a.group.add(roof);
  }

  // Snow lying on the portal beam and the cross-arms, because on this course it
  // lies on everything.
  const snowMat = new THREE.MeshLambertMaterial({ color: 0xf2f7fb });
  a.materials.push(snowMat);
  const capBeam = new THREE.Mesh(new THREE.BoxGeometry(span * 2, 0.16, 0.44), snowMat);
  capBeam.position.set(0, BANNER_Y + 1.72, 0);
  capBeam.castShadow = true;
  a.group.add(capBeam);

  // The drive house at the foot of the tall mast: a shed with a big sheave in
  // it, so the cableway has somewhere to be driven from.
  const houseMat = new THREE.MeshStandardMaterial({ color: 0x8a6a4c, roughness: 0.75 });
  a.materials.push(houseMat);
  const house = new THREE.Mesh(new THREE.BoxGeometry(7.4, 5.6, 6.2), houseMat);
  house.position.set(-span - 6.4, 1.5, 0);
  house.castShadow = true;
  house.receiveShadow = true;
  a.group.add(house);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.5, 7.2), snowMat);
  roof.position.set(-span - 6.4, 4.5, 0);
  roof.castShadow = true;
  a.group.add(roof);

  return {
    banner: addBanner(a, Math.min(span * 2 - 2, 26), BANNER_Y + 1.35),
    lamps: addLampBoard(a, BANNER_Y - 3.4),
  };
}

// ── chapters: the places one lap passes through ────────────────────────────
//
// **The finding.** A critic photographed the same chase view at 22%, 50% and
// 78% of one lap of every course: *"Cone Canyon — three near-identical frames,
// same orange verge, same striped fence, same tan hills, same sky; with the
// minimap covered you cannot say which third of the lap you are on. Saltpan —
// same white salt, same black ribbon, same distant butte, three times. Only one
// of four courses has chapters."*
//
// The one that passed — Switchback Summit, valley floor to summit works — did
// it with a hundred and sixteen metres of climb, and that is not a style the
// other two can copy. `track/terrain.ts` anchors the landscape to the elevation
// of the **nearest road** (`ref` in `terrainHeight`, which does not reach the
// datum until 340 metres out), so on a flat circuit the ground beside the road
// is the same ground for the whole lap by construction, and raising one section
// of tarmac simply lifts the landscape with it. There is no course-side number
// that digs a valley next to a bypass.
//
// So a chapter is **built**. It stands something along a span of the road that
// is big enough to change the shape of the frame — a trench between two faces,
// a deck with a truss on it, an arch across the road — and two spans of the
// same lap under the same sky then read as two places. See `ChapterDef`.
//
// Everything here obeys the same three rules as the barrier: nothing leans over
// the tarmac inside the line physics enforces, nothing is taller than it needs
// to be to close the horizon, and every piece is one mesh or one InstancedMesh.
// A chapter is scenery — it changes what the road looks like and never where it
// goes.

/** Rock face: bedded strata across the profile, fractures up it. */
function rockFaceTexture(tint: number): THREE.CanvasTexture {
  const key = `kit:rock:${tint.toString(16)}`;
  return tex(key, 256, 256, (g, W, H) => {
    const rnd = rand(0x9e3b17 ^ tint);
    const base = new THREE.Color(tint);
    const hex = (c: THREE.Color, f: number): string =>
      `#${_shade.copy(c).multiplyScalar(f).getHexString()}`;
    g.fillStyle = hex(base, 1);
    g.fillRect(0, 0, W, H);
    // Strata. x is height up the face, so a bed is a band in x — and it wobbles
    // along the track, because a bed that is a ruled line is a painted wall.
    let x = 0;
    while (x < W) {
      const band = 6 + rnd() * 26;
      const f = 0.72 + rnd() * 0.5;
      g.fillStyle = hex(base, f);
      g.beginPath();
      g.moveTo(x, 0);
      for (let y = 0; y <= H; y += 16) {
        g.lineTo(x + Math.sin(y * 0.035 + x) * 3.5, y);
      }
      for (let y = H; y >= 0; y -= 16) {
        g.lineTo(x + band + Math.sin(y * 0.035 + x * 1.7) * 3.5, y);
      }
      g.closePath();
      g.fill();
      x += band;
    }
    // Fractures: a joint runs *up* the face, so it is a line at constant v.
    for (let i = 0; i < 26; i++) {
      const y = rnd() * H;
      g.fillStyle = `rgba(20,12,8,${(0.10 + rnd() * 0.26).toFixed(3)})`;
      g.fillRect(rnd() * W * 0.5, y, W, 1 + rnd() * 2);
    }
    // Blast scar and dust, heaviest at the toe where the spoil piles up.
    for (let i = 0; i < 520; i++) {
      const px = rnd() * W;
      g.fillStyle = `rgba(255,242,220,${(rnd() * 0.10 * (px / W)).toFixed(3)})`;
      g.fillRect(px, rnd() * H, 1 + rnd() * 4, 1 + rnd() * 3);
    }
  });
}

/** Works wall: ribbed sheet pile, concrete capping, hazard band at the toe. */
function worksWallTexture(tint: number, accent: number): THREE.CanvasTexture {
  const key = `kit:works:${tint.toString(16)}:${accent.toString(16)}`;
  return tex(key, 256, 256, (g, W, H) => {
    const rnd = rand(0x1f5c88 ^ tint);
    const body = `#${new THREE.Color(tint).getHexString()}`;
    g.fillStyle = body;
    g.fillRect(0, 0, W, H);
    // Sheet pile: the pans and webs run up the face, so a rib is a stripe along
    // v. Two tones, because a pile wall is a folded plate and half of it faces
    // away from the sun.
    for (let y = 0; y < H; y += 22) {
      g.fillStyle = 'rgba(255,255,255,0.13)';
      g.fillRect(0, y, W, 8);
      g.fillStyle = 'rgba(20,24,30,0.22)';
      g.fillRect(0, y + 12, W, 6);
    }
    // Capping beam along the crest, and a walkway kerb under it.
    g.fillStyle = '#D9D5C8';
    g.fillRect(W * 0.86, 0, W * 0.14, H);
    g.fillStyle = 'rgba(30,34,40,0.35)';
    g.fillRect(W * 0.845, 0, W * 0.02, H);
    // Hazard band along the toe: the part a kart can actually reach.
    g.fillStyle = `#${new THREE.Color(accent).getHexString()}`;
    g.fillRect(0, 0, W * 0.11, H);
    g.fillStyle = '#22262E';
    for (let y = -30; y < H; y += 30) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(0, y + 15);
      g.lineTo(W * 0.11, y + 15 - W * 0.11);
      g.lineTo(W * 0.11, y - W * 0.11);
      g.closePath();
      g.fill();
    }
    // Salt bloom and streaking down the face.
    for (let i = 0; i < 320; i++) {
      const px = W * 0.11 + rnd() * W * 0.72;
      g.fillStyle = `rgba(244,241,232,${(rnd() * 0.22).toFixed(3)})`;
      g.fillRect(px, rnd() * H, 2 + rnd() * 9, 1 + rnd() * 2);
    }
  });
}

interface ChapterCtx {
  spline: TrackSpline;
  verge: number;
  root: THREE.Group;
  materials: THREE.Material[];
  /** Metres from the ring's origin to the start line — lap fractions are off it. */
  start: number;
  L: number;
}

/** A chapter's span resolved to an absolute distance and a length in metres. */
function chapterSpan(c: ChapterCtx, ch: ChapterDef): [number, number] {
  const d0 = (((c.start + ch.from * c.L) % c.L) + c.L) % c.L;
  let span = (ch.to - ch.from) * c.L;
  if (span < 0) span += c.L;
  return [d0, Math.max(20, span)];
}

const edgeOf = (verge: number) => (s: SplineSample): number => s.width * 0.5 + verge;

/**
 * A lateral offset outside the barrier, **clamped so it cannot fold through the
 * centre of a corner**.
 *
 * `track/terrain.ts` carries the same clamp on its skirt rings and says why: on
 * the inside of a tight turn, a lane laid a fixed distance out from a
 * curved centreline runs out of room at the radius of curvature and then turns
 * itself inside out. Digger's Elbow is 34 metres of radius on a road whose
 * barrier line is already 17.9 metres from the centreline, so a wall wanting to
 * sit twelve metres behind that has three metres of world to sit in. Clamping
 * costs a metre of wall on the apex of the tightest corners in the cup;
 * not clamping costs the mesh.
 */
function offsetAt(s: SplineSample, edge: number, off: number, side: -1 | 1): number {
  const inner = (s.curvature > 0 ? -1 : 1) === side;
  if (!inner || Math.abs(s.curvature) <= 1e-4) return side * (edge + off);
  const limit = Math.max(0, 1 / Math.abs(s.curvature) - edge - 2.5);
  return side * (edge + Math.min(off, limit));
}

/**
 * A cutting: two faces standing just outside the barrier, and the horizon gone.
 *
 * The whole read is the *crest line* — a wall of one height is a fence, and a
 * rock face has a broken top that moves against the sky as you drive under it.
 * So the crest is noise on the along-track distance, and it ramps in and out
 * over the first and last forty metres of the span so the road is not walled by
 * a step.
 */
function buildCutting(c: ChapterCtx, ch: ChapterDef): void {
  const h = ch.height ?? 11;
  const batter = ch.batter ?? 3.4;
  const isRock = (ch.face ?? 'rock') === 'rock';
  const tint = ch.tint ?? (isRock ? 0xa9633a : 0x8f9aa4);
  const [d0, span] = chapterSpan(c, ch);
  const map = isRock ? rockFaceTexture(tint) : worksWallTexture(tint, ch.accent ?? 0xffc300);
  const mat = new THREE.MeshLambertMaterial({ map, side: THREE.DoubleSide });
  c.materials.push(mat);

  const edge = edgeOf(c.verge);
  const tp = Math.min(0.34, 46 / span);
  const ramp = (f: number): number => smoothstep(0, tp, f) * smoothstep(0, tp, 1 - f);
  const b = new MeshBuilder();

  for (const side of [-1, 1] as const) {
    // The crest, in metres above the road. Rock breaks; a works wall is built,
    // so it only breathes a few per cent.
    const crest = (s: SplineSample, f: number): number => {
      const n = isRock
        ? 0.72 + 0.56 * noise2(s.distance / 27 + side * 4.5, side * 2.3)
        : 0.96 + 0.08 * noise2(s.distance / 40, side);
      return h * ramp(f) * n;
    };
    const at = (off: number) => (s: SplineSample): number => offsetAt(s, edge(s), off, side);
    // ── the face, and the top, as two ribbons ─────────────────────────────
    //
    // Deliberately two, because `MeshBuilder` averages normals within one
    // ribbon and across a crest that is exactly wrong: the first cut of this
    // was one profile from the toe over the top and back down, and it
    // photographed as a smooth grey whale-back — a dune, not a cut face. Two
    // ribbons do not share vertices, so the crest is a hard edge and the face
    // holds one value against the sky.
    const face: Lane[] = [
      // Buried toe, so there is no gap under the wall on a cambered corner.
      { lat: at(0.35), lift: () => -1.6, u: 0 },
      { lat: at(0.70), lift: (s, f) => -0.30 + 0.5 * ramp(f), u: 0.05 },
      { lat: at(1.05), lift: (s, f) => crest(s, f) * 0.46, u: 0.42 },
      { lat: at(1.35 + batter * 0.42), lift: (s, f) => crest(s, f) * 0.88, u: 0.82 },
      { lat: at(1.35 + batter * 0.62), lift: (s, f) => crest(s, f), u: 1 },
    ];
    // The top: a narrow crest shelf, then the back falling away into the
    // landscape — which is what stops the wall reading as a cardboard flat the
    // moment the camera gets above it.
    const top: Lane[] = [
      { lat: at(1.35 + batter * 0.62), lift: (s, f) => crest(s, f), u: 1 },
      { lat: at(1.35 + batter), lift: (s, f) => crest(s, f) * (isRock ? 0.94 : 1), u: 0.88 },
      { lat: at(1.35 + batter + 7), lift: (s, f) => crest(s, f) * 0.42 - 2.5, u: 0.5 },
    ];
    if (side < 0) { face.reverse(); top.reverse(); }
    const opts = {
      verge: c.verge, from: d0, to: d0 + span, step: 3.2, vScale: isRock ? 16 : 11,
    };
    b.addRibbon(c.spline, face, opts);
    b.addRibbon(c.spline, top, opts);
  }
  const mesh = new THREE.Mesh(b.toGeometry(), mat);
  mesh.name = `chapter:cutting:${ch.name}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  c.root.add(mesh);

  // ── what closes the top of a works cutting ──────────────────────────────
  //
  // A rock cutting is closed by its own crest, which breaks and leans. A wall
  // built by people is level and would leave a strip of sky exactly as wide as
  // the road, so a works cutting is bridged: a pipe rack every forty metres,
  // carrying two runs of pipe over the carriageway. It is the piece that makes
  // this a *place inside a works* rather than a road with two grey walls beside
  // it, and it costs one InstancedMesh.
  //
  // **Thin, and grey.** The first cut ran three 42cm members in the kit's
  // hazard yellow at two thirds of the wall's height, and photographed as three
  // enormous olive timbers lying across the top of the frame — the loudest
  // thing on the circuit, at the exact moment a driver is trying to read a
  // thirty-metre-radius chicane under them. A service run is 20cm of painted
  // steel and it belongs *above* the eye line, not across it.
  if (!isRock) {
    const st = new Struts();
    const s: SplineSample = c.spline.atDistance(d0);
    const racks = Math.max(1, Math.round(span / 42));
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i < racks; i++) {
      const f = (i + 0.5) / racks;
      if (ramp(f) < 0.55) continue;
      c.spline.atDistance(d0 + span * f, s);
      const off = edge(s) + 1.1;
      const top = h * 1.02;
      for (let j = 0; j < 2; j++) {
        const y = top + j * 0.62;
        surfacePoint(s, -off, c.verge, y, a);
        surfacePoint(s, off, c.verge, y, b);
        st.add(a.x, a.y, a.z, b.x, b.y, b.z, 0.22 - j * 0.04);
      }
      // The two stools the rack sits on, standing on the wall crest.
      for (const side of [-1, 1] as const) {
        surfacePoint(s, side * off, c.verge, h * 0.55, a);
        surfacePoint(s, side * off, c.verge, top + 1.1, b);
        st.add(a.x, a.y, a.z, b.x, b.y, b.z, 0.34);
      }
    }
    if (st.list.length) {
      c.root.add(st.mesh(shade(tint, 0.72), `chapter:rack:${ch.name}`, c.materials));
    }
  }

  // Talus. A cut face sheds, and the toe of the heap is the one place the
  // driver's eye can measure how far away the wall is.
  if (isRock) {
    const talusMat = new THREE.MeshLambertMaterial({
      color: shade(tint, 0.86), side: THREE.DoubleSide,
    });
    c.materials.push(talusMat);
    const t = new MeshBuilder();
    for (const side of [-1, 1] as const) {
      const at = (off: number) => (s: SplineSample): number => offsetAt(s, edge(s), off, side);
      const heap = (s: SplineSample, f: number): number =>
        ramp(f) * (0.9 + 1.9 * noise2(s.distance / 13 + side * 7.7, side));
      const lanes: Lane[] = [
        { lat: at(-0.1), lift: () => -0.45, u: 0 },
        { lat: at(1.1), lift: (s, f) => heap(s, f), u: 0.5 },
        { lat: at(2.4), lift: (s, f) => heap(s, f) * 0.5, u: 1 },
      ];
      if (side < 0) lanes.reverse();
      t.addRibbon(c.spline, lanes, {
        verge: c.verge, from: d0, to: d0 + span, step: 2.6, vScale: 9,
      });
    }
    const talus = new THREE.Mesh(t.toGeometry(), talusMat);
    talus.name = `chapter:talus:${ch.name}`;
    talus.receiveShadow = true;
    c.root.add(talus);
  }
}

/**
 * A viaduct: the road up on a structure, because the ground will not go down.
 *
 * Four pieces, and the order matters — the fascia is what says *there is
 * nothing under the edge of this road*, and without it a parapet is a wall and
 * a truss is a fence:
 *
 *   1. a deck fascia overhanging both flanks, with a beam hanging under it;
 *   2. a solid parapet standing on the fascia;
 *   3. two through trusses standing on the parapets;
 *   4. portal braces across the top every fifth panel, which is the member that
 *      makes it a bridge rather than two fences.
 */
function buildViaduct(c: ChapterCtx, ch: ChapterDef): void {
  const h = ch.height ?? 6.2;
  const over = ch.batter ?? 2.4;
  const steel = ch.tint ?? 0x3a6f9c;
  const accent = ch.accent ?? 0xf1efe6;
  const [d0, span] = chapterSpan(c, ch);
  const edge = edgeOf(c.verge);
  const tp = Math.min(0.22, 30 / span);
  const ramp = (f: number): number => smoothstep(0, tp, f) * smoothstep(0, tp, 1 - f);

  // ── the deck ────────────────────────────────────────────────────────────
  const deckMat = new THREE.MeshLambertMaterial({
    color: accent, side: THREE.DoubleSide,
  });
  const beamMat = new THREE.MeshLambertMaterial({ color: shade(steel, 0.8) });
  c.materials.push(deckMat, beamMat);
  const deck = new MeshBuilder();
  const fascia = new MeshBuilder();
  for (const side of [-1, 1] as const) {
    const at = (off: number) => (s: SplineSample): number => offsetAt(s, edge(s), off, side);
    const top: Lane[] = [
      { lat: at(-0.2), lift: () => -0.34, u: 0 },
      { lat: at(over * 0.6), lift: () => -0.26, u: 0.5 },
      { lat: at(over), lift: () => -0.26, u: 1 },
    ];
    // The hanging beam. It ramps to nothing at both ends of the span so the
    // structure grows out of the embankment instead of starting in mid-air.
    const face: Lane[] = [
      { lat: at(over), lift: () => -0.26, u: 0 },
      { lat: at(over * 0.94), lift: (s, f) => -0.26 - 2.6 * ramp(f) - 0.4, u: 1 },
    ];
    if (side < 0) { top.reverse(); face.reverse(); }
    deck.addRibbon(c.spline, top, { verge: c.verge, from: d0, to: d0 + span, step: 3, vScale: 6 });
    fascia.addRibbon(c.spline, face, { verge: c.verge, from: d0, to: d0 + span, step: 3, vScale: 6 });
    // The parapet: a solid box profile standing on the deck edge.
    const wall: Lane[] = [
      { lat: at(over - 0.62), lift: () => -0.3, u: 0 },
      { lat: at(over - 0.62), lift: (s, f) => 0.35 + 0.72 * ramp(f), u: 0.4 },
      { lat: at(over), lift: (s, f) => 0.38 + 0.74 * ramp(f), u: 0.6 },
      { lat: at(over), lift: () => -0.3, u: 1 },
    ];
    if (side < 0) wall.reverse();
    deck.addRibbon(c.spline, wall, { verge: c.verge, from: d0, to: d0 + span, step: 3, vScale: 6 });
  }
  const deckMesh = new THREE.Mesh(deck.toGeometry(), deckMat);
  deckMesh.name = `chapter:deck:${ch.name}`;
  deckMesh.castShadow = true;
  deckMesh.receiveShadow = true;
  c.root.add(deckMesh);
  const fasciaMesh = new THREE.Mesh(fascia.toGeometry(), beamMat);
  fasciaMesh.name = `chapter:fascia:${ch.name}`;
  fasciaMesh.castShadow = true;
  c.root.add(fasciaMesh);

  // ── the truss ───────────────────────────────────────────────────────────
  const st = new Struts();
  const PANEL = 6.2;
  const bays = Math.max(3, Math.round(span / PANEL));
  const s: SplineSample = c.spline.atDistance(d0);
  // Two chords a side, so a bay is four points: (low,high) at each end.
  const pts: THREE.Vector3[][] = [];
  for (let i = 0; i <= bays; i++) {
    const f = i / bays;
    c.spline.atDistance(d0 + span * f, s);
    const lift = ramp(f);
    const row: THREE.Vector3[] = [];
    for (const side of [-1, 1] as const) {
      const lat = offsetAt(s, edge(s), over - 0.3, side);
      row.push(surfacePoint(s, lat, c.verge, 0.9 * lift, new THREE.Vector3()));
      row.push(surfacePoint(s, lat, c.verge, (0.9 + h) * lift, new THREE.Vector3()));
    }
    pts.push(row);
  }
  const V = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];
  for (let i = 0; i < bays; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    for (const k of [0, 2]) {
      // Chords.
      st.add(...V(a[k]!), ...V(b[k]!), 0.30);
      st.add(...V(a[k + 1]!), ...V(b[k + 1]!), 0.30);
      // Vertical and diagonal — the diagonal alternates hand, which is what a
      // Warren web looks like and what stops it reading as a ladder.
      st.add(...V(a[k]!), ...V(a[k + 1]!), 0.20);
      if (i % 2 === 0) st.add(...V(a[k]!), ...V(b[k + 1]!), 0.17);
      else st.add(...V(a[k + 1]!), ...V(b[k]!), 0.17);
    }
    // Portal bracing overhead. Every fifth bay, plus knee braces into the top
    // chords so the frame has a corner rather than a butt joint.
    if (i % 5 === 2) {
      st.add(...V(a[1]!), ...V(a[3]!), 0.26);
      const kneeL = a[1]!.clone().lerp(a[3]!, 0.14);
      const kneeR = a[3]!.clone().lerp(a[1]!, 0.14);
      st.add(...V(a[0]!.clone().lerp(a[1]!, 0.72)), ...V(kneeL), 0.15);
      st.add(...V(a[2]!.clone().lerp(a[3]!, 0.72)), ...V(kneeR), 0.15);
    }
  }
  if (st.list.length) {
    const mesh = st.mesh(steel, `chapter:truss:${ch.name}`, c.materials);
    c.root.add(mesh);
  }
}

/**
 * A portal: a natural rock bridge across the road.
 *
 * Not a span of road but a gate on one — the frame you drive *through* on the
 * way into the next chapter, and the cheapest thing in this file per metre of
 * memory it buys.
 *
 * ── one solid sweep, and it took a photograph to know that ─────────────────
 *
 * The first cut was voussoirs: thirty boxes stood along the half ellipse with
 * their scale and roll shaken by noise, on the reasoning that a smooth tube
 * photographs as a plastic croquet hoop. It photographs as **a chain of loose
 * slabs** — a caterpillar of separate rectangles with daylight between them,
 * because the along-arc spacing of an arch this size is three metres and no
 * honest block is six metres long. A rock arch is one piece of rock.
 *
 * So it is a swept section: a rectangular profile carried along the ellipse,
 * four quads per station, the radial half-thickness swelling at the crown and
 * at the springings the way a natural bridge does, and the section's outline
 * broken by the same deterministic hash noise the cutting's crest uses. Each
 * quad gets its own normals — `addQuad` accumulates per batch — so it is
 * flat-shaded and rocky rather than smooth and inflatable. The sweep runs from
 * `t = -0.05` to `1.05`, which drives both feet into the ground instead of
 * standing them on it.
 */
function buildPortal(c: ChapterCtx, ch: ChapterDef): void {
  const tint = ch.tint ?? 0xa9633a;
  const d = (((c.start + (ch.from + ch.to) * 0.5 * c.L) % c.L) + c.L) % c.L;
  const s = c.spline.atDistance(d);
  const edge = s.width * 0.5 + c.verge;
  const foot = edge + 3.0;
  const rise = ch.height ?? 15;
  const mat = new THREE.MeshLambertMaterial({ map: rockFaceTexture(tint) });
  c.materials.push(mat);

  const fwd = new THREE.Vector3().crossVectors(s.right, s.up).normalize();
  const b = new MeshBuilder();
  const SEC = 26;

  // Centreline of the arch at parameter t, into `out`.
  const centre = (t: number, out: THREE.Vector3): THREE.Vector3 => {
    const a = Math.PI * t;
    return surfacePoint(s, -Math.cos(a) * foot, c.verge, Math.sin(a) * rise - 1.2, out);
  };
  // The four corners of the section at t, in order: inner-near, inner-far,
  // outer-far, outer-near.
  const _c0 = new THREE.Vector3();
  const _c1 = new THREE.Vector3();
  const _tan = new THREE.Vector3();
  const _rad = new THREE.Vector3();
  const section = (t: number): THREE.Vector3[] => {
    const a = Math.PI * t;
    centre(t, _c0);
    centre(t + 0.01, _c1);
    _tan.subVectors(_c1, _c0).normalize();
    _rad.crossVectors(_tan, fwd).normalize();
    const wob = noise2(t * 9.4, 3.3);
    // Thick at the crown, thick where it lands, thinnest a third of the way up
    // each leg — and never thin enough to read as a handle.
    const half = 2.4 + 1.7 * Math.abs(Math.cos(a)) + 1.9 * Math.pow(Math.sin(a), 2) + wob * 1.5;
    const deep = 4.2 + wob * 2.6;
    const out: THREE.Vector3[] = [];
    for (const [r, f] of [[-1, -1], [-1, 1], [1, 1], [1, -1]] as const) {
      out.push(_c0.clone().addScaledVector(_rad, r * half).addScaledVector(fwd, f * deep));
    }
    return out;
  };

  let prev = section(-0.05);
  for (let i = 1; i <= SEC; i++) {
    const t = -0.05 + (1.1 * i) / SEC;
    const next = section(t);
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      b.addQuad(prev[k]!, prev[k2]!, next[k]!, next[k2]!, [0, 0, 1, 1]);
    }
    prev = next;
  }

  const mesh = new THREE.Mesh(b.toGeometry(), mat);
  mesh.name = `chapter:portal:${ch.name}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  c.root.add(mesh);
}

function buildChapters(c: ChapterCtx, chapters: ChapterDef[]): void {
  for (const ch of chapters) {
    if (ch.kind === 'cutting') buildCutting(c, ch);
    else if (ch.kind === 'viaduct') buildViaduct(c, ch);
    else buildPortal(c, ch);
  }
}

// ── the skirt that folds over itself ───────────────────────────────────────
//
// **This is the camera-underground bug, and it is measured on these courses.**
//
// A player reported *"the screen just went brown above the racer and you can't
// see them"*. `tools/underground.mjs` reproduces it: the chase lens ends up
// inside the landscape on 51 of 171 samples at Jackhammer Quarry and 24 of 171
// at Switchback Summit — the mountain's worst is **9.5 metres under, at t=0,
// with the kart sitting on the start grid**. The ray comes back with three and
// four stacked surfaces at a single XZ.
//
// ── what it actually is ────────────────────────────────────────────────────
//
// `track/terrain.ts` builds the landscape in two pieces. The **field** is a
// heightfield: every vertex asks `spline.nearest()` which road is closest and
// takes its elevation, so it is right everywhere by construction. The **skirt**
// is *swept* — for each station on the centreline it lays nine rings out to
// 150 metres, all anchored to **that station's** elevation, and it never asks
// what else is nearby.
//
// On a circuit that never comes back near itself that is the same answer. On
// one that folds, it is not:
//
//     course              stations with another road >5m above them inside 165m
//     Cone Canyon          82   worst +11.2m     passes: 5.99m of clearance
//     Saltpan Bypass       21   worst +11.2m     passes: 6.04m
//     Jackhammer Quarry   171   worst +40.4m     FAILS:  4.15m under
//     Switchback Summit   211   worst +62.4m     FAILS:  9.49m under
//
// So the skirt of the weighbridge — 40 metres above the pit floor and 139
// metres from it in plan — is a shelf hanging in the air over the pit floor's
// road, and the chase camera drives straight into the underside of it. The
// arithmetic is not subtle: a skirt sits about 5.75m below its own road and
// drifts a fifth of the way toward the datum by 150m out, so it clears a road
// **about nine metres** below it and buries everything under that. Cone Canyon
// and Saltpan are inside that budget. The pit and the mountain are not, by a
// factor of four and seven.
//
// ── why this is not fixed in the layout ────────────────────────────────────
//
// It was the obvious answer and it is the wrong one, and it took a measurement
// to know that. Getting Jackhammer inside the nine-metre budget means cutting
// the pit from 42 metres deep to about 12, and getting Switchback inside it
// means deleting its 115-metre climb — which is the single measurement the last
// review round *praised*: "elevation 115.2m switchback vs 13.6m saltpan, 8.5x".
// Trading the cup's whole elevation range for a workaround to a construction
// fault in the landscape builder is not a fix, it is a retreat.
//
// ── what this does instead ─────────────────────────────────────────────────
//
// It gives the skirt the answer the field already has. Every skirt vertex past
// the twenty-metre ring — where the sweep has finished blending out of the
// road's banked frame and is a pure height query — is clamped to the height the
// **nearest** road establishes at its own XZ. Where the swept road *is* the
// nearest road, `d` comes out equal to the ring offset and the clamp is exactly
// the value already there: a no-op, to the bit. Where another road is nearer
// and lower, the shelf drops onto that road's own terrain, which is where the
// two skirts then agree instead of stacking.
//
// It only ever lowers, it changes nothing on a circuit that does not fold, and
// it degrades to nothing the day `terrain.ts` sweeps the skirt against
// `nearest()` itself — which is where this belongs and is not this module's
// file. See the report.
//
// The height function below is terrain.ts's, verbatim. It is the **third** copy
// in the repo: `world/place.ts` already carries one, privately, for exactly the
// same reason ("there is no runtime 'how high is the ground here' to call").
// Three mirrors of one function is a defect of its own and the fix is one
// exported `terrainHeight` in `track/terrain.ts`.

interface HeightOpts {
  groundY: number;
  rimStart: number;
  rimEnd: number;
  rimHeight: number;
  landmarks: ReadonlyArray<{ x: number; z: number; radius: number; height: number; kind?: string }>;
}

/** terrain.ts's height function, verbatim. `d` is metres beyond the shoulder. */
function terrainHeight(d: number, sy: number, x: number, z: number, o: HeightOpts): number {
  const embankment = 0.35 + 5.4 * smoothstep(0, 26, d);
  const ref = sy + (o.groundY - sy) * smoothstep(70, 340, d);
  const hills = fbm(x / 260, z / 260) * 26 * smoothstep(55, 320, d);
  const dunes = fbm(x / 150 + 11, z / 150 - 7) * 3.6 * smoothstep(20, 110, d);

  const gate = smoothstep(o.rimStart, o.rimEnd, d);
  const plateau = smoothstep(0.40, 0.57, noise2(x / 420 + 3, z / 420 + 5));
  const terrace = 0.42 + 0.58 * smoothstep(0.34, 0.52, noise2(x / 165 + 9, z / 165 - 4));
  const erosion = 0.86 + 0.14 * noise2(x / 58 - 21, z / 58 + 13);
  const rim = plateau * terrace * erosion * o.rimHeight * gate;

  let hero = 0;
  for (let i = 0; i < o.landmarks.length; i++) {
    const lm = o.landmarks[i]!;
    const r = Math.hypot(x - lm.x, z - lm.z) / lm.radius;
    if (r >= 1.35) continue;
    const shape = lm.kind === 'spire'
      ? Math.pow(Math.max(0, 1 - r), 2.2)
      : 1 - smoothstep(0.52, 1.05, r);
    const wobble = 0.84 + 0.16 * noise2(x / 44 + lm.x * 0.01, z / 44 + lm.z * 0.01);
    hero += lm.height * shape * wobble * smoothstep(o.rimStart * 0.7, o.rimStart * 1.5, d);
  }
  return ref - embankment + hills + dunes + rim + hero;
}

/** Columns in the skirt — `RINGS.length` in terrain.ts, mirrored in place.ts. */
const SKIRT_COLS = 9;
/** The first ring at which the sweep has fully left the road's banked frame. */
const SKIRT_FREE_COL = 4;

const _probe = new THREE.Vector3();

function unfoldSkirt(track: Track, spline: TrackSpline, verge: number): number {
  const mesh = track.group.getObjectByName('embankment') as THREE.Mesh | undefined;
  if (!mesh?.isMesh) return 0;
  const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!attr) return 0;
  // Both sides of the circuit are laid out as whole rings of nine, so a
  // vertex's column is its index modulo nine. If terrain.ts ever changes the
  // ring table this stops being true, and the clamp falls back to a five-metre
  // margin rather than guessing — it does less, never something wrong.
  const layout = attr.count % (SKIRT_COLS * 2) === 0;

  const t = features(track.course).terrain ?? {};
  const o: HeightOpts = {
    groundY: track.course.groundY ?? -8,
    rimStart: t.rimStart ?? 260,
    rimEnd: t.rimEnd ?? 560,
    rimHeight: t.rimHeight ?? 42,
    landmarks: t.landmarks ?? [],
  };

  const s: SplineSample = spline.atDistance(0);
  let moved = 0;
  for (let i = 0; i < attr.count; i++) {
    const x = attr.getX(i), y = attr.getY(i), z = attr.getZ(i);
    _probe.set(x, 0, z);
    spline.nearest(_probe, s);
    const dx = x - s.pos.x, dz = z - s.pos.z;
    const d = Math.max(0, Math.hypot(dx, dz) - (s.width * 0.5 + verge));
    const ceiling = terrainHeight(d, s.pos.y, x, z, o);
    // Inside the twenty-metre ring the sweep is still partly in the road's
    // banked frame, which legitimately stands above the level height by a few
    // metres on a cambered corner. Past it the two are the same query — but not
    // to the centimetre, because the hill and dune terms are scaled by `d` and
    // `nearest()` answers with the closest *sample* rather than the exact foot
    // of the perpendicular. A metre and a half of slack covers that and is
    // nothing next to the tens of metres a real shelf stands proud by.
    const margin = layout && i % SKIRT_COLS >= SKIRT_FREE_COL ? 1.5 : 5.0;
    // Dropped a little *under* the ceiling rather than onto it. A foreign
    // shelf lowered to exactly the local terrain height is coplanar with the
    // local skirt that is already there, and two coplanar surfaces are a
    // shimmer. Under it, it is simply gone.
    if (y > ceiling + margin) { attr.setY(i, ceiling - 0.8); moved++; }
  }
  if (!moved) return 0;
  attr.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingSphere();
  return moved;
}

// ── the system ─────────────────────────────────────────────────────────────

/** Seconds the board holds green after the flag before going dark. */
const GO_HOLD = 1.6;

const NONE: readonly number[] = [];
const ALL = [0, 1, 2, 3, 4] as const;
const LAMP_GREEN = 0x3cff6b;

export function createCourseKitSystem(ctx: GameContext): GameSystem {
  let root: THREE.Group | null = null;
  let materials: THREE.Material[] = [];
  let banner: THREE.Object3D | null = null;
  let lamps: THREE.Mesh[] = [];
  let green: THREE.MeshBasicMaterial | null = null;
  let red: THREE.Material | null = null;
  let clock = 0;
  /** Seconds since the flag while the board holds green. -1 when dark. */
  let goT = -1;

  function setLamps(on: readonly number[], mat: THREE.Material | null): void {
    for (let i = 0; i < lamps.length; i++) {
      const b = lamps[i]!;
      b.visible = on.includes(i);
      if (mat) b.material = mat;
    }
  }

  ctx.bus.on<{ n: number }>('race:countdown', ({ n }) => {
    if (!lamps.length) return;
    if (n > 0) setLamps(config.race.startLights[n] ?? NONE, red);
    else setLamps(ALL, green);
  });
  ctx.bus.on('race:racing', () => { goT = 0; });
  ctx.bus.on('race:intro', () => { goT = -1; setLamps(NONE, red); });

  function dispose(): void {
    if (root) {
      ctx.scene.remove(root);
      root.traverse((o) => { (o as THREE.Mesh).geometry?.dispose(); });
      root = null;
    }
    for (const m of materials) m.dispose();
    materials = [];
    banner = null;
    lamps = [];
    green = null;
    red = null;
    goT = -1;
  }

  /**
   * Hide a stock piece the course has replaced.
   *
   * `visible = false` rather than removal: `track/index.ts` owns those objects,
   * rebuilds them with the road and disposes them with it, and a system that
   * *removed* them would be quietly leaking whatever it took out of a group
   * somebody else is about to dispose. Hiding is reversible, costs one boolean
   * and leaves the ownership where it was.
   */
  function hide(group: THREE.Object3D, name: string): void {
    const o = group.getObjectByName(name);
    if (o) o.visible = false;
  }

  /**
   * Repaint the parts of the road that road.ts builds one of.
   *
   * Only the material's `map` is swapped, which is exactly what
   * `render/ground.ts` does to the shoulder gravel and for the same stated
   * reason: the mesh, the material, its vertex colours (which carry the baked
   * kerb shadow) and its shading stay road.ts's.
   */
  function repaint(track: Track, name: string, next: THREE.Texture): void {
    const mesh = track.group.getObjectByName(name) as THREE.Mesh | undefined;
    if (!mesh?.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      const withMap = mat as THREE.Material & { map?: THREE.Texture | null };
      if (!withMap.map) continue;
      // The builders cache by key and hand back shared instances, so the wrap
      // and repeat the road chose have to be carried across by hand.
      next.wrapS = withMap.map.wrapS;
      next.wrapT = withMap.map.wrapT;
      next.repeat.copy(withMap.map.repeat);
      next.anisotropy = withMap.map.anisotropy;
      withMap.map = next;
      mat.needsUpdate = true;
    }
  }

  function build(track: Track): void {
    dispose();
    const course: CourseDef = track.course;
    // `Track` publishes the spline as `TrackSplineLike` — the read-only subset
    // other modules are allowed to depend on. The ribbon builder wants the
    // class, and every member it touches (`length`, `atDistance`, `nearest`) is
    // in the published subset, so this narrows rather than widens what is
    // depended on.
    const spline = track.spline as unknown as TrackSpline;
    const verge = course.vergeWidth ?? 5;

    // Before anything is built on it: stop the landscape from hanging over its
    // own road. Runs for every course, kit or no kit — a circuit that does not
    // fold is untouched to the bit. See `unfoldSkirt`.
    unfoldSkirt(track, spline, verge);

    const kit = features(course).kit;
    if (!kit) return;

    root = new THREE.Group();
    root.name = 'courseKit';

    // ── the road's own paint ────────────────────────────────────────────────
    if (kit.kerb) {
      repaint(track, 'kerbs', makeKerbTexture({ a: kit.kerb.a, b: kit.kerb.b }));
      const mesh = track.group.getObjectByName('kerbs') as THREE.Mesh | undefined;
      const mat = mesh?.material as (THREE.Material & { map?: THREE.Texture | null }) | undefined;
      // The kerb ribbon is laid at 5.5m of track per unit of v, so a stripe
      // pair asked for in metres is that over the pitch.
      if (mat?.map && kit.kerb.pitch) mat.map.repeat.y = 5.5 / kit.kerb.pitch;
    }
    if (kit.paint) repaint(track, 'markings', makePaintTexture(kit.paint));
    if (kit.chequer) {
      repaint(track, 'startLine', makeCheckerTexture(2, kit.chequer.dark, kit.chequer.light));
    }

    // ── the barrier ─────────────────────────────────────────────────────────
    const barrier: BarrierKind = kit.barrier ?? 'panel';
    if (barrier !== 'panel' && course.walls !== false) {
      for (const n of ['barrierPanels', 'barrierBase', 'barrierPosts']) hide(track.group, n);
      const bc: BarrierCtx = {
        spline,
        verge,
        edge: (s) => s.width * 0.5 + verge,
        root,
        materials,
      };
      if (barrier === 'jersey') buildJersey(bc);
      else if (barrier === 'seawall') buildSeawall(bc);
      else buildSnowFence(bc);
    }

    // ── the chapters ────────────────────────────────────────────────────────
    //
    // Built before the arrival structure so that a chapter which runs over the
    // start line is under it rather than through it. See `ChapterDef`.
    if (kit.chapters?.length) {
      buildChapters({
        spline,
        verge,
        root,
        materials,
        start: course.startDistance ?? 0,
        L: spline.length,
      }, kit.chapters);
    }

    // ── the arrival ─────────────────────────────────────────────────────────
    const arrival = kit.arrival ?? 'gantry';
    if (arrival !== 'gantry') {
      hide(track.group, 'gantry');
      const d = course.startDistance ?? 0;
      const s = spline.atDistance(d);
      const group = new THREE.Group();
      group.name = `arrival:${arrival}`;
      const at = new THREE.Vector3();
      surfacePoint(s, 0, verge, 0, at);
      const fwd = new THREE.Vector3().crossVectors(s.right, s.up).normalize();
      group.position.copy(at);
      group.setRotationFromMatrix(new THREE.Matrix4().makeBasis(s.right, s.up, fwd));

      const args: BuildArgs = {
        group,
        span: s.width * 0.5 + verge + 2.6,
        kit,
        name: course.name,
        materials,
      };
      const parts = arrival === 'conveyor' ? buildConveyor(args)
        : arrival === 'jetty' ? buildJetty(args)
          : buildPylon(args);
      banner = parts.banner;
      lamps = parts.lamps;
      red = lamps[0]?.material as THREE.Material ?? null;
      green = new THREE.MeshBasicMaterial({ color: LAMP_GREEN, toneMapped: false });
      materials.push(green);
      setLamps(NONE, red);
      root.add(group);
    }

    ctx.scene.add(root);
  }

  return {
    name: 'coursekit',
    /**
     * Between the track (20) and the ground bake (21), and it has to be.
     *
     * `core/engine.ts` sorts systems by `order` and initialises them in that
     * sorted order, so `order` is also the order the `track:built` handlers
     * subscribe in and therefore the order they run in. `render/ground.ts`
     * bakes the landscape's vertex colours from its vertex *positions* — so if
     * this ran after it, every skirt vertex `unfoldSkirt` lowers would keep the
     * colour it had thirty metres higher up.
     */
    order: 20.5,

    init(): void {
      ctx.bus.on<{ track: Track }>('track:built', ({ track }) => build(track));
      if (ctx.track) build(ctx.track);
    },

    reset(): void {
      goT = -1;
      setLamps(NONE, red);
    },

    /** Visuals only: the banner breathes and the board holds its green. */
    update(dt: number): void {
      clock += dt;
      if (banner) {
        banner.rotation.x = Math.sin(clock * 1.3) * 0.035;
        banner.rotation.z = Math.sin(clock * 0.9 + 1.1) * 0.012;
      }
      if (goT >= 0) {
        goT += dt;
        if (goT > GO_HOLD) { goT = -1; setLamps(NONE, red); }
      }
    },

    dispose,
  };
}
