// The world the circuit sits in.
//
// A flat coloured quad is the single cheapest way to make a racing game look
// unfinished: with no horizon and no parallax, speed stops reading. This builds
// a real landscape instead, in two pieces that share one height function so
// they cannot disagree:
//
//   * a *skirt* swept along the spline — the embankment falling away from the
//     verge. It has to start exactly on the outer edge of the shoulder, which
//     is banked, and settle into level ground within twenty metres, so its rings
//     blend from the road's banked frame into a world-horizontal one.
//   * a heightfield covering everything out to the fog, sampled through the same
//     function via the spline's nearest-point query, and sunk slightly wherever
//     the skirt already covers it so the two never fight.
//
// Height is anchored to the *track's* elevation nearby and to a global datum far
// away, so the circuit reads as a shelf cut into the canyon rather than a ribbon
// floating over a plain. Everything is deterministic hash noise — no
// Math.random, no assets.

import * as THREE from 'three';
import { fbm, noise2, smoothstep } from './geom.ts';
import { makeGroundTexture } from './textures.ts';
import type { CourseDef, SplineSample } from '../types.ts';
import type { TrackSpline } from './spline.ts';

const _v = new THREE.Vector3();
const _fr = new THREE.Vector3();
const _banked = new THREE.Vector3();

/** Rings of the embankment skirt, metres beyond the shoulder. */
const RINGS = [0, 2, 5, 11, 20, 34, 58, 95, 150];

/** Colour ramp keyed on how far from the road and how high above the datum. */
const C_SHOULDER = new THREE.Color(0xb08a55);
const C_DUST = new THREE.Color(0xc9a063);
const C_ROCK = new THREE.Color(0xb2683f);
const C_HIGH = new THREE.Color(0xdcbb85);
const C_SCRUB = new THREE.Color(0x8a9350);

export interface TerrainOptions {
  /** Datum the landscape settles to far from the circuit. */
  groundY: number;
  size: number;
  verge: number;
}

/**
 * The one height function. `d` is metres beyond the outer edge of the shoulder,
 * `sy` the road's elevation at the nearest point on the centreline.
 */
function terrainHeight(d: number, sy: number, x: number, z: number, o: TerrainOptions): number {
  // Close in, the ground belongs to the road: it drops away from the shoulder
  // into a shallow ditch so the track always reads as raised.
  const embankment = 0.35 + 5.4 * smoothstep(0, 26, d);
  // Far out it stops caring about the road's elevation and settles to the datum.
  const ref = sy + (o.groundY - sy) * smoothstep(70, 340, d);

  const hills = fbm(x / 260, z / 260) * 26 * smoothstep(55, 320, d);
  // Long-wavelength dunes only: anything finer than the grid that samples it
  // turns into faceted triangles when seen from above.
  const dunes = fbm(x / 150 + 11, z / 150 - 7) * 3.6 * smoothstep(20, 110, d);
  // Canyon rim: mesas ringing the circuit — and rising in the middle of it —
  // which is what gives the horizon something to do, hides the edge of the
  // world, and stops the far side of the lap reading as clutter.
  const rim = (0.5 + 0.5 * noise2(x / 380 + 3, z / 380 + 5))
    * 42 * smoothstep(260, 560, d);

  return ref - embankment + hills + dunes + rim;
}

function colourFor(d: number, height: number, sy: number, out: THREE.Color): void {
  out.copy(C_SHOULDER).lerp(C_DUST, smoothstep(3, 40, d));
  const rel = height - sy;
  // Exposed rock on the slopes, bleached sand on the tops.
  out.lerp(C_ROCK, smoothstep(-4, -22, rel) * 0.75);
  out.lerp(C_HIGH, smoothstep(6, 30, rel));
  // A little scrub green in the sheltered low ground.
  out.lerp(C_SCRUB, smoothstep(-2, -9, rel) * (1 - smoothstep(-14, -30, rel)) * 0.35);
}

export function buildTerrain(
  spline: TrackSpline, course: CourseDef, parent: THREE.Group,
): void {
  const verge = course.vergeWidth ?? 5;
  const o: TerrainOptions = {
    groundY: course.groundY ?? -8,
    size: course.groundSize ?? 4000,
    verge,
  };
  // The landscape is the largest thing on screen every single frame, so it is
  // deliberately the cheapest thing to shade: the key light and sky fill are
  // baked into vertex colours at build time and both meshes ship unlit. Nothing
  // drives out here — the barrier is the boundary — so no shadow ever falls on
  // it, and on the software renderer the review harness uses this is worth more
  // than any triangle budget. Baking both meshes with the same function is also
  // what keeps the seam between them invisible.
  const tex = makeGroundTexture();
  tex.repeat.set(1 / 42, 1 / 42);
  tex.anisotropy = 2;
  const mat = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true });

  parent.add(buildSkirt(spline, o, mat, course));
  parent.add(buildField(spline, o, mat, course));
}

/** The embankment either side of the circuit, swept along the spline. */
function buildSkirt(
  spline: TrackSpline, o: TerrainOptions, mat: THREE.Material, course: CourseDef,
): THREE.Mesh {
  const L = spline.length;
  const step = 6;
  const rings = Math.max(16, Math.round(L / step));
  const cols = RINGS.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const col = new THREE.Color();
  const s: SplineSample = spline.atDistance(0);

  for (const side of [-1, 1] as const) {
    const base = positions.length / 3;
    for (let i = 0; i <= rings; i++) {
      const d = (i / rings) * L;
      spline.atDistance(d, s);
      const edge = s.width * 0.5 + o.verge;
      // Horizontal right, so the landscape does not inherit the road's roll.
      _fr.set(s.tangent.z, 0, -s.tangent.x).normalize().multiplyScalar(-side);

      // On the inside of a tight corner the rings would fold back through the
      // centre of the turn, so they are clamped to the radius of curvature —
      // which is exactly far enough to close the pocket inside a hairpin as a
      // fan. Clamping any shorter leaves a hole there for the coarse field mesh
      // to poke through, and it pokes through *over* the barrier.
      const limit = Math.abs(s.curvature) > 1e-4
        ? Math.max(0, 1 / Math.abs(s.curvature) - edge)
        : Infinity;
      const inner = (s.curvature > 0 ? -1 : 1) === side;

      for (let j = 0; j < cols; j++) {
        const want = RINGS[j]!;
        const off = inner ? Math.min(want, limit) : want;
        const lat = side * (edge + off);
        const w = smoothstep(0, 20, off);

        _banked.copy(s.pos).addScaledVector(s.right, lat)
          .addScaledVector(s.up, -0.35 - 5.4 * smoothstep(0, 26, off));
        const fx = s.pos.x + _fr.x * (edge + off);
        const fz = s.pos.z + _fr.z * (edge + off);
        const fy = terrainHeight(off, s.pos.y, fx, fz, o);

        const x = _banked.x + (fx - _banked.x) * w;
        const y = _banked.y + (fy - _banked.y) * w;
        const z = _banked.z + (fz - _banked.z) * w;
        positions.push(x, y, z);
        uvs.push(x, z);
        colourFor(off, y, s.pos.y, col);
        colors.push(col.r, col.g, col.b);
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = base + i * cols + j;
        const b = a + cols;
        // Mirrored sides need mirrored winding or one of them faces the dirt.
        if (side > 0) indices.push(a, a + 1, b, b, a + 1, b + 1);
        else indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  bakeLighting(geo, course);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'embankment';
  return mesh;
}

/**
 * Bake the course's key light and sky fill into vertex colours.
 *
 * This mirrors the lighting module's rig — warm directional sun, hemisphere
 * fill, cool rim — evaluated per vertex with Lambert's 1/pi, so an unlit mesh
 * lands within a percent or two of the lit surfaces it touches. If the lighting
 * rig changes shape, this is the one place that has to follow it; the seam at
 * the shoulder is what tells you it has drifted.
 */
const HEMI_SKY = new THREE.Color(0xbfe7ff);
const HEMI_GROUND = new THREE.Color(0x8a6b3f);
const HEMI_I = 1.15;
const RIM = new THREE.Color(0xbfd8ff);
const RIM_I = 0.55;
const RIM_DIR = new THREE.Vector3(-0.5, 0.4, -1).normalize();

function bakeLighting(geo: THREE.BufferGeometry, course: CourseDef): void {
  const sunDef = course.theme?.sun;
  const az = sunDef?.azimuth ?? 0.7;
  const el = sunDef?.elevation ?? 0.85;
  const sunI = sunDef?.intensity ?? 2.6;
  const sun = new THREE.Color(sunDef?.color ?? 0xfff2d8);
  const sx = Math.cos(el) * Math.cos(az), sy = Math.sin(el), sz = Math.cos(el) * Math.sin(az);

  const n = geo.getAttribute('normal');
  const c = geo.getAttribute('color');
  const INV_PI = 1 / Math.PI;
  for (let i = 0; i < c.count; i++) {
    const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
    const key = Math.max(0, nx * sx + ny * sy + nz * sz) * sunI;
    const rim = Math.max(0, nx * RIM_DIR.x + ny * RIM_DIR.y + nz * RIM_DIR.z) * RIM_I;
    const hemi = 0.5 + 0.5 * ny;
    const r = (HEMI_GROUND.r + (HEMI_SKY.r - HEMI_GROUND.r) * hemi) * HEMI_I
      + sun.r * key + RIM.r * rim;
    const g = (HEMI_GROUND.g + (HEMI_SKY.g - HEMI_GROUND.g) * hemi) * HEMI_I
      + sun.g * key + RIM.g * rim;
    const b = (HEMI_GROUND.b + (HEMI_SKY.b - HEMI_GROUND.b) * hemi) * HEMI_I
      + sun.b * key + RIM.b * rim;
    c.setXYZ(i, c.getX(i) * r * INV_PI, c.getY(i) * g * INV_PI, c.getZ(i) * b * INV_PI);
  }
  c.needsUpdate = true;
}

/** Everything from the embankment out to the fog. */
function buildField(
  spline: TrackSpline, o: TerrainOptions, mat: THREE.Material, course: CourseDef,
): THREE.Mesh {
  const half = o.size * 0.5;
  const CELLS = 124;
  const cell = o.size / CELLS;

  // Centre the field on the circuit, and remember its bounds so far-off
  // vertices can skip the nearest-point query entirely.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const probe = spline.atDistance(0);
  for (let d = 0; d < spline.length; d += 8) {
    spline.atDistance(d, probe);
    minX = Math.min(minX, probe.pos.x); maxX = Math.max(maxX, probe.pos.x);
    minZ = Math.min(minZ, probe.pos.z); maxZ = Math.max(maxZ, probe.pos.z);
  }
  const cx = (minX + maxX) * 0.5, cz = (minZ + maxZ) * 0.5;
  const NEAR = 420;

  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const col = new THREE.Color();
  const s: SplineSample = spline.atDistance(0);

  for (let iz = 0; iz <= CELLS; iz++) {
    for (let ix = 0; ix <= CELLS; ix++) {
      const x = cx - half + ix * cell;
      const z = cz - half + iz * cell;
      let d = 1e5;
      let sy = o.groundY;
      if (x > minX - NEAR && x < maxX + NEAR && z > minZ - NEAR && z < maxZ + NEAR) {
        _v.set(x, 0, z);
        spline.nearest(_v, s);
        _v.set(x - s.pos.x, 0, z - s.pos.z);
        d = Math.max(0, _v.length() - (s.width * 0.5 + o.verge));
        sy = s.pos.y;
      }
      // Sink whatever the skirt already covers. This has to be deep enough that
      // a cell spanning the width of a hairpin cannot interpolate its way up
      // over the barrier, and it fades out well before the skirt's outer ring.
      const sink = 4 * (1 - smoothstep(50, 140, d));
      const y = terrainHeight(d, sy, x, z, o) - sink;
      positions.push(x, y, z);
      uvs.push(x, z);
      colourFor(d, y, sy, col);
      colors.push(col.r, col.g, col.b);
    }
  }

  const row = CELLS + 1;
  for (let iz = 0; iz < CELLS; iz++) {
    for (let ix = 0; ix < CELLS; ix++) {
      const a = iz * row + ix;
      indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  bakeLighting(geo, course);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ground';
  return mesh;
}
