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

import * as THREE from 'three';
import { MeshBuilder, fbm, noise2, smoothstep, surfacePoint, type Lane } from '../geom.ts';
import { makeCheckerTexture, makeKerbTexture, makePaintTexture } from '../textures.ts';
import { config } from '../../core/config.ts';
import { features, type BarrierKind, type KitDef } from './types.ts';
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
    const cap = g.createLinearGradient(W * 0.52, 0, W, 0);
    cap.addColorStop(0, '#2E6C9E');
    cap.addColorStop(0.45, '#3E82B8');
    cap.addColorStop(1, '#22557D');
    g.fillStyle = cap;
    g.fillRect(W * 0.52, 0, W * 0.48, H);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(W * 0.52, 0, 3, H);
    // Render courses. Wide, shallow, slightly uneven — a wall somebody built.
    for (let i = 0; i < 6; i++) {
      const y = (i + 0.5) * (H / 6);
      g.fillStyle = 'rgba(150,148,138,0.32)';
      g.fillRect(0, y, W * 0.52, 1.5);
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
    const stain = g.createLinearGradient(W * 0.30, 0, W * 0.52, 0);
    stain.addColorStop(0, 'rgba(150,140,110,0.30)');
    stain.addColorStop(1, 'rgba(150,140,110,0)');
    g.fillStyle = stain;
    g.fillRect(W * 0.30, 0, W * 0.22, H);
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
    // Four slats per 2m of road: a 25cm board on a 50cm pitch.
    const SLATS = 4;
    for (let i = 0; i < SLATS; i++) {
      const y = i * (H / SLATS);
      const wSlat = (H / SLATS) * 0.52;
      const shade = 0.82 + 0.18 * rnd();
      const r = Math.round(0x6f * shade), gg = Math.round(0x4e * shade), b = Math.round(0x36 * shade);
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
      g.fillStyle = '#5A3E2B';
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
    alphaTest: 0.5,
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
      { lat: (s) => side * (c.edge(s) + 0.30), lift: () => 1.52, u: 1 },
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
      scl.set(1, 1.85, 1);
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
  const mat = new THREE.MeshStandardMaterial({
    map: bannerTexture(a.name, style),
    roughness: 0.78,
    side: THREE.DoubleSide,
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
  // Trestles. The far one stands taller, because the belt is climbing.
  tower(st, -span, -3, 9.4, 1.15);
  tower(st, span, -3, 14.6, 1.15);
  a.group.add(st.mesh(steel, 'kitConveyorTrestle', a.materials));

  // The belt housing: a long box, rolled about z so it climbs left to right.
  const run = span * 2 + 26;
  const rise = 5.4;
  const angle = Math.atan2(rise, span * 2);
  const belt = new THREE.Group();
  belt.position.set(0, (9.9 + 15.1) * 0.5, 0);
  belt.rotation.z = angle;

  const hood = plateTexture('conveyor', '#9AA3AA', 'rgba(40,46,52,0.35)');
  const hoodMat = new THREE.MeshStandardMaterial({ map: hood, roughness: 0.55, metalness: 0.3 });
  a.materials.push(hoodMat);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(run, 1.5, 2.9), hoodMat);
  housing.castShadow = true;
  housing.receiveShadow = true;
  belt.add(housing);

  // A rounded hood on top — the silhouette people recognise a conveyor by.
  const capMat = new THREE.MeshStandardMaterial({ color: steel, roughness: 0.42, metalness: 0.45 });
  a.materials.push(capMat);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, run, 12, 1, false, 0, Math.PI), capMat);
  cap.rotation.z = Math.PI * 0.5;
  cap.position.y = 0.7;
  cap.castShadow = true;
  belt.add(cap);

  // Toe boards and a walkway handrail down the near side, in high-vis.
  const railMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5 });
  a.materials.push(railMat);
  for (const y of [-0.55, 0.45, 1.05]) {
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
      web.add(x0, -2.3, dz, x1, -2.3, dz, 0.16);
      web.add(x0, -0.75, dz, x0, -2.3, dz, 0.12);
      web.add(x0, -0.75, dz, x1, -2.3, dz, 0.10);
    }
    if (i % 2 === 0) web.add(x0, -2.3, -1.3, x0, -2.3, 1.3, 0.10);
  }
  belt.add(web.mesh(steel, 'kitConveyorWeb', a.materials));
  a.group.add(belt);

  // The head chute, dropping fines off the high end onto a cone of stockpile
  // outside the barrier. This is what tells you which way the belt runs.
  const chuteMat = new THREE.MeshStandardMaterial({ color: 0x5d666e, roughness: 0.7 });
  a.materials.push(chuteMat);
  const chute = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.5, 4.2, 8), chuteMat);
  chute.position.set(span + 11.5, 13.0, 0);
  chute.castShadow = true;
  a.group.add(chute);
  const pileMat = new THREE.MeshLambertMaterial({ color: 0xa9a396 });
  a.materials.push(pileMat);
  const pile = new THREE.Mesh(new THREE.ConeGeometry(7.5, 8.4, 14), pileMat);
  pile.position.set(span + 11.5, 1.2, 0);
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

  // The belt's underside over the centreline, which is what the banner hangs
  // from. `run/2` of housing at `angle`, half its depth, is where it is.
  return {
    banner: addBanner(a, Math.min(span * 2 - 2, 26), 11.6),
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

  // Two loading chutes hanging over the carriageway, with a dribble of salt
  // caught in mid-fall under each — the one thing on this circuit that reads as
  // *vertical* on a lake bed where nothing else is.
  const chuteMat = new THREE.MeshStandardMaterial({ color: steel, roughness: 0.5, metalness: 0.3 });
  a.materials.push(chuteMat);
  for (const sx of [-0.42, 0.42]) {
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
  const TALL = 27, SHORT = 19;

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
  const house = new THREE.Mesh(new THREE.BoxGeometry(7.4, 4.2, 6.2), houseMat);
  house.position.set(-span - 6.4, 1.9, 0);
  house.castShadow = true;
  house.receiveShadow = true;
  a.group.add(house);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.5, 7.2), snowMat);
  roof.position.set(-span - 6.4, 4.2, 0);
  roof.castShadow = true;
  a.group.add(roof);

  return {
    banner: addBanner(a, Math.min(span * 2 - 2, 26), BANNER_Y + 1.35),
    lamps: addLampBoard(a, BANNER_Y - 3.4),
  };
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
