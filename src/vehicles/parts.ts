// Shared model-building helpers.
//
// Every racer is built from primitives at load time — no mesh files, so the game
// stays one self-contained bundle. The house style: bold flat colour, soft
// shading, chunky proportions, and a silhouette that reads at thumbnail size.

import * as THREE from 'three';

const _matCache = new Map<string, THREE.MeshStandardMaterial>();

export interface MatOptions {
  roughness?: number;
  metalness?: number;
  emissive?: number;
  emissiveIntensity?: number;
  flat?: boolean;
  transparent?: boolean;
  opacity?: number;
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
  });
  _matCache.set(key, m);
  return m;
}

export const METAL = (color: number): THREE.MeshStandardMaterial =>
  mat(color, { roughness: 0.34, metalness: 0.72, emissiveIntensity: 0.02 });

export const RUBBER = (color = 0x23252b): THREE.MeshStandardMaterial =>
  mat(color, { roughness: 0.9, metalness: 0, emissiveIntensity: 0.01 });

export const GLASS = (color = 0x8fd8ff): THREE.MeshStandardMaterial =>
  mat(color, { roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.62, emissiveIntensity: 0.18 });

/** Box with bevelled edges — reads far softer than a raw cube under key light. */
export function roundedBox(
  w: number, h: number, d: number, radius = 0.08, segments = 2,
): THREE.BufferGeometry {
  const r = Math.min(radius, w / 2, h / 2, d / 2);
  const geo = new THREE.BoxGeometry(w, h, d, segments, segments, segments);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const half = new THREE.Vector3(w / 2 - r, h / 2 - r, d / 2 - r);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const clamped = new THREE.Vector3(
      Math.max(-half.x, Math.min(half.x, v.x)),
      Math.max(-half.y, Math.min(half.y, v.y)),
      Math.max(-half.z, Math.min(half.z, v.z)));
    v.sub(clamped).normalize().multiplyScalar(r).add(clamped);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

export interface WheelOptions {
  radius?: number;
  width?: number;
  rimColor?: number;
  tyreColor?: number;
  spokes?: number;
}

/** A wheel with a visible rim, so rotation actually reads at speed. */
export function makeWheel(opts: WheelOptions = {}): THREE.Group {
  const radius = opts.radius ?? 0.42;
  const width = opts.width ?? 0.3;
  const g = new THREE.Group();

  const tyre = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, width, 18, 1),
    RUBBER(opts.tyreColor ?? 0x23252b));
  tyre.rotation.z = Math.PI / 2;
  tyre.castShadow = true;
  g.add(tyre);

  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.58, radius * 0.58, width * 1.06, 14, 1),
    mat(opts.rimColor ?? 0xFFF8F0, { roughness: 0.36 }));
  hub.rotation.z = Math.PI / 2;
  g.add(hub);

  // Spokes give the wheel a strobe as it turns — cheap, and it sells speed.
  const spokes = opts.spokes ?? 5;
  for (let i = 0; i < spokes; i++) {
    const s = new THREE.Mesh(
      new THREE.BoxGeometry(width * 1.1, radius * 0.9, radius * 0.13),
      mat(opts.rimColor ?? 0xFFF8F0, { roughness: 0.3 }));
    s.rotation.x = (i / spokes) * Math.PI;
    g.add(s);
  }

  g.userData.radius = radius;
  return g;
}

/** Soft blob shadow. Contact is what stops a kart looking like a sticker. */
export function makeShadowBlob(size = 1.6): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.28)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);

  const tex = new THREE.CanvasTexture(c);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false,
      opacity: 0.9, toneMapped: false,
    }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -1;
  mesh.name = 'shadowBlob';
  return mesh;
}

/** Cartoon eyes. A pair of these turns any prop into a character instantly. */
export function makeEyes(spacing = 0.34, radius = 0.15): THREE.Group {
  const g = new THREE.Group();
  const white = mat(0xffffff, { roughness: 0.28, emissiveIntensity: 0.14 });
  const black = mat(0x14161c, { roughness: 0.2 });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 12), white);
    eye.position.set(side * spacing, 0, 0);
    eye.scale.z = 0.62;
    g.add(eye);

    const pupil = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.52, 10, 8), black);
    pupil.position.set(side * spacing * 0.94, 0, radius * 0.52);
    pupil.scale.z = 0.6;
    g.add(pupil);

    const glint = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 0.2, 8, 6),
      mat(0xffffff, { roughness: 0.05, emissiveIntensity: 0.9 }));
    glint.position.set(side * spacing * 0.94 + radius * 0.18, radius * 0.3, radius * 0.62);
    g.add(glint);
  }
  g.name = 'eyes';
  return g;
}

/** Reflective hazard band, the visual motif tying the whole cast together. */
export function makeBand(
  radiusTop: number, radiusBottom: number, height: number, color = 0xFFF8F0,
): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, 20, 1, true),
    mat(color, { roughness: 0.25, emissiveIntensity: 0.22 }));
  m.castShadow = true;
  return m;
}

/** Attach a name so other systems can find a sub-part later. */
export function named<T extends THREE.Object3D>(obj: T, name: string): T {
  obj.name = name;
  return obj;
}

export function castShadows(root: THREE.Object3D, cast = true, receive = false): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = cast; m.receiveShadow = receive; }
  });
}

export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
  });
}
