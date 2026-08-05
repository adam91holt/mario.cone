// Shared model-building helpers.
//
// Every racer is built from primitives at load time — no mesh files, so the game
// stays one self-contained bundle. The house style: bold flat colour, soft
// shading, chunky proportions, and a silhouette that reads at thumbnail size.
//
// Two things in here are load-bearing beyond "make a shape":
//
//   `mat()` caches, so a full grid of eight racers shares a handful of
//   materials rather than allocating one per mesh.
//
//   `mergeStatic()` flattens a finished sub-assembly into one mesh per
//   material. A cartoon vehicle wants dozens of little bevelled lumps — rivets,
//   lamps, bumpers, tread blocks — and dozens of lumps is dozens of draw calls
//   times eight racers. Merged, a whole shell costs four or five. That is the
//   budget that pays for the detail everywhere else in this module.

import * as THREE from 'three';

// ── materials ──────────────────────────────────────────────────────────────

const _matCache = new Map<string, THREE.MeshStandardMaterial>();

export interface MatOptions {
  roughness?: number;
  metalness?: number;
  emissive?: number;
  emissiveIntensity?: number;
  flat?: boolean;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
}

/** Painted-vinyl look: mid roughness, no metal, gentle emissive lift so shadows
 *  never go muddy. Cached — a full grid shares a handful of materials. */
export function mat(color: number, opts: MatOptions = {}): THREE.MeshStandardMaterial {
  const key = `${color}:${JSON.stringify(opts)}`;
  const hit = _matCache.get(key);
  if (hit) return hit;
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.52,
    metalness: opts.metalness ?? 0.0,
    emissive: opts.emissive ?? color,
    emissiveIntensity: opts.emissiveIntensity ?? 0.055,
    flatShading: opts.flat ?? false,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    depthWrite: (opts.opacity ?? 1) >= 1,
  });
  _matCache.set(key, m);
  return m;
}

export const METAL = (color: number): THREE.MeshStandardMaterial =>
  mat(color, { roughness: 0.34, metalness: 0.72, emissiveIntensity: 0.02 });

export const CHROME = (): THREE.MeshStandardMaterial =>
  mat(0xd8dee8, { roughness: 0.18, metalness: 0.9, emissiveIntensity: 0.02 });

export const RUBBER = (color = 0x23252b): THREE.MeshStandardMaterial =>
  mat(color, { roughness: 0.9, metalness: 0, emissiveIntensity: 0.01 });

export const GLASS = (color = 0x8fd8ff): THREE.MeshStandardMaterial =>
  mat(color, { roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.62, emissiveIntensity: 0.18 });

/** A lamp lens. Reads as *on* even in full sun, which is what sells a face. */
export const LAMP = (color = 0xfff3c4, glow = 0.9): THREE.MeshStandardMaterial =>
  mat(color, { roughness: 0.1, emissiveIntensity: glow });

// ── geometry ───────────────────────────────────────────────────────────────

/**
 * Shape cache. Building a bevelled box means a per-vertex projection pass and a
 * normal recompute, and a grid of eight racers asks for the same few hundred
 * shapes over and over — every race reset, which is a visible hitch.
 *
 * A *clone* is handed out rather than the cached geometry itself: callers
 * translate and dispose what they are given, and neither may reach the copy the
 * cache is holding.
 */
const _geoCache = new Map<string, THREE.BufferGeometry>();

function cachedGeo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let hit = _geoCache.get(key);
  if (!hit) {
    hit = make();
    _geoCache.set(key, hit);
  }
  return hit.clone();
}

/** Box with bevelled edges — reads far softer than a raw cube under key light. */
export function roundedBox(
  w: number, h: number, d: number, radius = 0.08, segments = 2,
): THREE.BufferGeometry {
  return cachedGeo(`b:${w},${h},${d},${radius},${segments}`, () =>
    buildRoundedBox(w, h, d, radius, segments));
}

function buildRoundedBox(
  w: number, h: number, d: number, radius: number, segments: number,
): THREE.BufferGeometry {
  const r = Math.min(radius, w / 2, h / 2, d / 2);
  const geo = new THREE.BoxGeometry(w, h, d, segments, segments, segments);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const clamped = new THREE.Vector3();
  const half = new THREE.Vector3(w / 2 - r, h / 2 - r, d / 2 - r);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    clamped.set(
      Math.max(-half.x, Math.min(half.x, v.x)),
      Math.max(-half.y, Math.min(half.y, v.y)),
      Math.max(-half.z, Math.min(half.z, v.z)));
    v.sub(clamped).normalize().multiplyScalar(r).add(clamped);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * A box whose front face is a different size from its back one. This is the
 * whole cartoon-vehicle vocabulary in one function: bonnets that taper, cabs
 * that flare, noses that pinch. `taper` scales the +Z end in x and y.
 */
export function taperBox(
  w: number, h: number, d: number, taperX = 0.7, taperY = taperX, radius = 0.07,
): THREE.BufferGeometry {
  return cachedGeo(`t:${w},${h},${d},${taperX},${taperY},${radius}`, () =>
    buildTaperBox(w, h, d, taperX, taperY, radius));
}

function buildTaperBox(
  w: number, h: number, d: number, taperX: number, taperY: number, radius: number,
): THREE.BufferGeometry {
  const geo = buildRoundedBox(w, h, d, radius, 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const half = d / 2;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const t = (z + half) / d; // 0 at the back, 1 at the front
    const sx = 1 + (taperX - 1) * t;
    const sy = 1 + (taperY - 1) * t;
    pos.setXY(i, pos.getX(i) * sx, pos.getY(i) * sy);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Surface of revolution around Y. Points are `[radius, height]`, bottom-up. */
export function lathe(points: Array<readonly [number, number]>, segments = 24): THREE.BufferGeometry {
  return cachedGeo(`l:${segments}:${points.join('|')}`, () => {
    const pts = points.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0001), y));
    return new THREE.LatheGeometry(pts, segments);
  });
}

/** Convenience: build a mesh, place it, parent it, hand it back. */
export function part(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  pos?: readonly [number, number, number],
  rot?: readonly [number, number, number],
): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  if (pos) m.position.set(pos[0], pos[1], pos[2]);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  parent.add(m);
  return m;
}

/** The same part on both sides. `x` is mirrored; anything else is copied. */
export function pair(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  pos: readonly [number, number, number],
  rot?: readonly [number, number, number],
  mirrorRot: readonly [number, number, number] = [1, -1, -1],
): [THREE.Mesh, THREE.Mesh] {
  const a = part(parent, geo, material, pos, rot);
  const b = new THREE.Mesh(geo, material);
  b.position.set(-pos[0], pos[1], pos[2]);
  if (rot) b.rotation.set(rot[0] * mirrorRot[0], rot[1] * mirrorRot[1], rot[2] * mirrorRot[2]);
  parent.add(b);
  return [a, b];
}

// ── merging ────────────────────────────────────────────────────────────────

/** Concatenate geometries into one non-indexed buffer. Position/normal/uv only. */
export function mergeGeos(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geos = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let count = 0;
  for (const g of geos) count += g.attributes.position!.count;

  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let o = 0;
  for (const g of geos) {
    const p = g.attributes.position as THREE.BufferAttribute;
    const n = g.attributes.normal as THREE.BufferAttribute | undefined;
    const u = g.attributes.uv as THREE.BufferAttribute | undefined;
    for (let i = 0; i < p.count; i++) {
      const k = (o + i) * 3;
      pos[k] = p.getX(i); pos[k + 1] = p.getY(i); pos[k + 2] = p.getZ(i);
      if (n) { nrm[k] = n.getX(i); nrm[k + 1] = n.getY(i); nrm[k + 2] = n.getZ(i); }
      if (u) { uv[(o + i) * 2] = u.getX(i); uv[(o + i) * 2 + 1] = u.getY(i); }
    }
    o += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/**
 * Flatten a finished sub-assembly into one mesh per material, in place.
 *
 * The group must contain only static meshes — anything that animates has to
 * live outside it, because after this call the individual parts no longer
 * exist as objects. Transforms are baked, so the group itself keeps whatever
 * position it had.
 */
export function mergeStatic(group: THREE.Object3D): THREE.Object3D {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();

  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry.clone();
    local.multiplyMatrices(inv, mesh.matrixWorld);
    geo.applyMatrix4(local);
    const material = mesh.material as THREE.Material;
    const list = buckets.get(material);
    if (list) list.push(geo); else buckets.set(material, [geo]);
  });

  group.clear();
  for (const [material, geos] of buckets) {
    const merged = new THREE.Mesh(geos.length === 1 ? geos[0]! : mergeGeos(geos), material);
    merged.castShadow = true;
    group.add(merged);
  }
  return group;
}

// ── wheels ─────────────────────────────────────────────────────────────────

export interface WheelOptions {
  radius?: number;
  width?: number;
  rimColor?: number;
  tyreColor?: number;
  spokes?: number;
  /** Chunky off-road lugs around the tread. */
  treads?: number;
  /** Domed centre cap. Off for rail wheels, which want a flat boss. */
  cap?: boolean;
}

/** Built shapes, keyed by their options. A full grid asks for the same five or
 *  six wheels forty times over; only their transforms differ. */
const _wheelCache = new Map<string, [THREE.BufferGeometry, THREE.BufferGeometry]>();

/**
 * A wheel with a hard-contrast rim, so rotation reads at speed.
 *
 * The tread lugs are the point: a smooth cylinder spinning at 200km/h is a
 * still image. Lugs give it a strobe, which is what the eye reads as "fast".
 */
export function makeWheel(opts: WheelOptions = {}): THREE.Group {
  const key = JSON.stringify(opts);
  const cached = _wheelCache.get(key);
  if (cached) {
    const g = new THREE.Group();
    const tyre = new THREE.Mesh(cached[0], RUBBER(opts.tyreColor ?? 0x23252b));
    const rim = new THREE.Mesh(cached[1], mat(opts.rimColor ?? 0xfff8f0, { roughness: 0.34 }));
    tyre.castShadow = true;
    rim.castShadow = true;
    g.add(tyre, rim);
    g.userData.radius = opts.radius ?? 0.42;
    return g;
  }

  const radius = opts.radius ?? 0.42;
  const width = opts.width ?? 0.3;
  const rimColor = opts.rimColor ?? 0xfff8f0;
  const spokes = opts.spokes ?? 5;
  const treads = opts.treads ?? 10;

  const g = new THREE.Group();
  const rubber = new THREE.Group();
  const rim = new THREE.Group();

  const tyreMat = RUBBER(opts.tyreColor ?? 0x23252b);
  const rimMat = mat(rimColor, { roughness: 0.34 });

  // Carcass, with a slightly proud shoulder either side so the tyre reads as
  // inflated rather than as a disc.
  part(rubber, new THREE.CylinderGeometry(radius, radius, width * 0.82, 18, 1), tyreMat,
    [0, 0, 0], [0, 0, Math.PI / 2]);
  part(rubber, lathe([
    [radius * 0.66, -width / 2], [radius * 0.94, -width / 2],
    [radius, -width * 0.3], [radius, width * 0.3],
    [radius * 0.94, width / 2], [radius * 0.66, width / 2],
  ], 12), tyreMat, [0, 0, 0], [0, 0, Math.PI / 2]);

  // Plain boxes, not bevelled ones: a tread lug is four pixels of strobe at
  // racing speed and there are ninety-six of them on a full grid.
  const lugGeo = new THREE.BoxGeometry(width * 1.02, radius * 0.16, radius * 0.34);
  for (let i = 0; i < treads; i++) {
    const a = (i / treads) * Math.PI * 2;
    const lug = new THREE.Mesh(lugGeo, tyreMat);
    lug.position.set(0, Math.cos(a) * radius * 0.97, Math.sin(a) * radius * 0.97);
    lug.rotation.x = -a;
    rubber.add(lug);
  }

  // Rim: a dish plus spokes. High contrast against the tyre on purpose.
  part(rim, new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, width * 1.04, 14, 1), rimMat,
    [0, 0, 0], [0, 0, Math.PI / 2]);
  // Plain boxes: at wheel scale a bevel on a spoke is invisible and costs four
  // times the triangles, on every wheel of every racer.
  const spokeGeo = new THREE.BoxGeometry(width * 1.08, radius * 1.06, radius * 0.2);
  for (let i = 0; i < spokes; i++) {
    const s = new THREE.Mesh(spokeGeo, rimMat);
    s.rotation.set((i / spokes) * Math.PI, 0, 0);
    rim.add(s);
  }
  if (opts.cap !== false) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.3, 8, 5), rimMat);
    cap.scale.x = 0.5;
    cap.position.x = width * 0.5;
    rim.add(cap);
    const cap2 = cap.clone();
    cap2.position.x = -width * 0.5;
    rim.add(cap2);
  }

  g.add(mergeStatic(rubber), mergeStatic(rim));
  g.userData.radius = radius;
  // Shared geometry has to outlive any one model, so it is flagged for
  // `disposeTree` to leave alone when a race tears its field down.
  const tyreGeo = (rubber.children[0] as THREE.Mesh).geometry;
  const rimGeo = (rim.children[0] as THREE.Mesh).geometry;
  tyreGeo.userData.shared = true;
  rimGeo.userData.shared = true;
  _wheelCache.set(key, [tyreGeo, rimGeo]);
  return g;
}

/** Continuous track for the digger: a rounded belt with visible links. */
export function makeTrack(length: number, height: number, width: number, links = 16): THREE.Group {
  const g = new THREE.Group();
  const beltMat = RUBBER(0x2a2d35);
  const r = height / 2;
  const straight = length - height;

  // Belt: two end rounds and two flats, drawn as a single extruded outline.
  const shape = new THREE.Shape();
  shape.absarc(straight / 2, 0, r, -Math.PI / 2, Math.PI / 2, false);
  shape.absarc(-straight / 2, 0, r, Math.PI / 2, Math.PI * 1.5, false);
  const belt = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 1, curveSegments: 8 }),
    beltMat);
  belt.position.set(0, 0, -width / 2);
  const holder = new THREE.Group();
  holder.add(belt);
  holder.rotation.y = Math.PI / 2;

  // Links, so the belt reads as a track rather than a black slab.
  const linkGeo = new THREE.BoxGeometry(width * 1.08, 0.07, (straight / links) * 0.55);
  for (let i = 0; i < links; i++) {
    const t = (i / links) * 2 - 1;
    const z = (t * straight) / 2;
    part(g, linkGeo, RUBBER(0x3c414c), [0, r + 0.02, z]);
    part(g, linkGeo, RUBBER(0x3c414c), [0, -r - 0.02, z]);
  }
  g.add(holder);
  return g;
}

// ── contact shadow ─────────────────────────────────────────────────────────

let _blobTex: THREE.CanvasTexture | null = null;
function blobTexture(): THREE.CanvasTexture {
  if (_blobTex) return _blobTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(0,0,0,0.62)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.34)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  _blobTex = new THREE.CanvasTexture(c);
  return _blobTex;
}

/** Soft blob shadow. Contact is what stops a kart looking like a sticker. */
export function makeShadowBlob(width = 1.6, length = width): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, length),
    new THREE.MeshBasicMaterial({
      map: blobTexture(), transparent: true, depthWrite: false,
      opacity: 0.85, toneMapped: false,
    }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.02;
  mesh.renderOrder = -1;
  mesh.name = 'shadowBlob';
  mesh.userData.noShadow = true;
  return mesh;
}

// ── spinning things ────────────────────────────────────────────────────────

/**
 * The translucent disc a prop or rotor becomes once it is up to speed. Fading
 * one in while the blades stay solid is the trick that makes a two-blade prop
 * read as spinning instead of strobing.
 */
export function makeSpinDisc(radius: number, color = 0xcfe4f5, inner = 0.12): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(radius * inner, radius, 28, 1),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0, side: THREE.DoubleSide,
      depthWrite: false, toneMapped: false,
    }));
  m.name = 'spinDisc';
  m.userData.noShadow = true;
  m.userData.detail = true;
  return m;
}

/**
 * The amber beacon every roadworks machine carries. It is the motif that ties
 * the cast together, and — because it never stops turning — the thing that
 * keeps a parked grid from looking like a screenshot.
 *
 * The lens gets its own material instance: `mat()` hands out shared, cached
 * materials, so anything that animates a colour or an opacity has to own one.
 */
export interface Beacon {
  group: THREE.Group;
  update(dt: number, brightness: number): void;
}

export function makeBeacon(radius = 0.12, color = 0xffa11a): Beacon {
  const group = new THREE.Group();
  const lensMat = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.9,
    roughness: 0.16, transparent: true, opacity: 0.85,
  });
  const lens = new THREE.Mesh(
    lathe([[radius * 0.98, 0], [radius, radius * 0.5], [radius * 0.82, radius * 1.0],
      [radius * 0.5, radius * 1.3], [0, radius * 1.38]], 12), lensMat);
  lens.position.y = radius * 0.5;
  group.add(lens);

  // The rotating reflector inside. One bright face sweeping around is all it
  // takes to read as a revolving light.
  const flash = new THREE.Mesh(
    roundedBox(radius * 0.34, radius * 0.9, radius * 1.5, radius * 0.12),
    new THREE.MeshBasicMaterial({ color: 0xfff4d0, toneMapped: false }));
  flash.position.y = radius * 0.8;
  group.add(flash);

  group.traverse((o) => { o.userData.noShadow = true; });
  group.userData.detail = true;

  let a = 0;
  return {
    group,
    update(dt, brightness) {
      a += dt * 7.5;
      flash.rotation.y = a;
      lensMat.emissiveIntensity = 0.55 + brightness * 0.9 + Math.sin(a) * 0.25;
    },
  };
}

/** A soft emissive blob: exhaust heat, lamp bloom, a straining engine. */
export interface Glow {
  mesh: THREE.Mesh;
  set(amount: number): void;
}

export function makeGlow(radius = 0.14, color = 0xffb257): Glow {
  const material = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 6), material);
  mesh.scale.setScalar(0.01);
  mesh.name = 'glow';
  mesh.userData.noShadow = true;
  mesh.userData.detail = true;
  return {
    mesh,
    set(amount: number) {
      const a = Math.max(0, Math.min(1, amount));
      material.opacity = a * 0.85;
      mesh.scale.setScalar(0.35 + a * 1.15);
      mesh.visible = a > 0.02;
    },
  };
}

/** Steam / exhaust puff set. Cheap, and a still frame stops looking dead. */
export interface PuffSet {
  group: THREE.Group;
  /** `rate` is puffs per second; `speed` scales how fast they rise. */
  update(dt: number, rate: number, rise: number): void;
}

export function makePuffs(count = 3, size = 0.3, color = 0xf4f0e6): PuffSet {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
  });
  const geo = new THREE.SphereGeometry(size, 8, 6);
  const puffs: THREE.Mesh[] = [];
  group.userData.detail = true;
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(geo, material.clone());
    m.userData.life = i / count;
    m.userData.noShadow = true;
    m.visible = false;
    group.add(m);
    puffs.push(m);
  }
  return {
    group,
    update(dt, rate, rise) {
      for (let i = 0; i < puffs.length; i++) {
        const p = puffs[i]!;
        let life = p.userData.life as number;
        life += dt * rate * (1 + i * 0.02);
        if (life > 1) life -= Math.floor(life);
        p.userData.life = life;
        p.visible = rate > 0.01;
        const t = life;
        p.position.set(Math.sin(t * 6 + i) * t * 0.22, t * rise, -t * rise * 0.55);
        const s = 0.45 + t * 1.5;
        p.scale.setScalar(s);
        (p.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (1 - t) * 0.7 * Math.min(1, rate));
      }
    },
  };
}

// ── misc ───────────────────────────────────────────────────────────────────

/** Attach a name so other systems can find a sub-part later. */
export function named<T extends THREE.Object3D>(obj: T, name: string): T {
  obj.name = name;
  return obj;
}

/** Everything solid casts; anything flagged `noShadow` (blobs, glows, puffs,
 *  spin discs) does not — a transparent sprite casts a solid black disc. */
export function castShadows(root: THREE.Object3D, cast = true, receive = false): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !m.userData.noShadow) {
      m.castShadow = cast;
      m.receiveShadow = receive;
    }
  });
}

/** Free this model's GPU buffers. Geometry flagged `shared` — the wheel cache —
 *  belongs to every racer at once and is deliberately left alive. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
  });
}
