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
import { features, type LandmarkDef } from './courses/types.ts';
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
/** The band that makes a mesa read as sedimentary rock rather than a lump. */
const C_STRATA = new THREE.Color(0x9d4f30);

export interface TerrainOptions {
  /** Datum the landscape settles to far from the circuit. */
  groundY: number;
  size: number;
  verge: number;
  rimStart: number;
  rimEnd: number;
  rimHeight: number;
  landmarks: LandmarkDef[];
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

  // Canyon rim. The old version was a smooth noise field starting 260m out and
  // capped at 42m — under five degrees of subtense from the road, which is why
  // it read as low dunes and the horizon had nothing in it. Now it is a mesa
  // field: the noise is pushed through a hard ramp so the tops go flat and the
  // sides go steep, and it starts close enough and stands tall enough to be a
  // canyon wall. `rimStart` keeps its foot clear of the circuit.
  const gate = smoothstep(o.rimStart, o.rimEnd, d);
  const plateau = smoothstep(0.40, 0.57, noise2(x / 420 + 3, z / 420 + 5));
  const terrace = 0.42 + 0.58 * smoothstep(0.34, 0.52, noise2(x / 165 + 9, z / 165 - 4));
  const erosion = 0.86 + 0.14 * noise2(x / 58 - 21, z / 58 + 13);
  const rim = plateau * terrace * erosion * o.rimHeight * gate;

  // Hero landforms, placed by the course so a straight has something at the end
  // of it. Held back from the circuit by the same gate as the rim.
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

function colourFor(d: number, height: number, sy: number, out: THREE.Color): void {
  out.copy(C_SHOULDER).lerp(C_DUST, smoothstep(3, 40, d));
  const rel = height - sy;
  // Exposed rock on the slopes, bleached sand on the tops, scrub in the
  // sheltered low ground. The ramps are deliberately wide: the field mesh is
  // coarse, and a tight ramp turns every grid cell into a visible facet.
  out.lerp(C_ROCK, smoothstep(-8, -46, rel) * 0.7);
  out.lerp(C_HIGH, smoothstep(4, 52, rel));
  out.lerp(C_SCRUB, smoothstep(-1, -16, rel) * (1 - smoothstep(-20, -48, rel)) * 0.30);
  // Horizontal strata on anything that stands up. Keyed on absolute height so
  // the bands run level across neighbouring buttes the way real ones do, and
  // faded in with elevation so the flats stay clean.
  const band = 0.5 + 0.5 * Math.sin(height * 0.21);
  out.lerp(C_STRATA, band * smoothstep(14, 55, rel) * 0.34);
}

export function buildTerrain(
  spline: TrackSpline, course: CourseDef, parent: THREE.Group,
): void {
  const verge = course.vergeWidth ?? 5;
  const t = features(course).terrain ?? {};
  const o: TerrainOptions = {
    groundY: course.groundY ?? -8,
    size: course.groundSize ?? 4000,
    verge,
    rimStart: t.rimStart ?? 260,
    rimEnd: t.rimEnd ?? 560,
    rimHeight: t.rimHeight ?? 42,
    landmarks: t.landmarks ?? [],
  };
  // The landscape is the largest thing on screen every single frame, so it is
  // deliberately the cheapest thing to shade: its light is baked into vertex
  // colours at build time and it ships unlit. **`render/ground.ts` owns that
  // bake** — and the material, and which of the two meshes receives a shadow
  // map. What ships from here is albedo and a placeholder material, replaced on
  // `track:built` before the first frame is drawn.
  const tex = makeGroundTexture();
  tex.repeat.set(1 / 42, 1 / 42);
  tex.anisotropy = 2;
  const mat = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true });

  parent.add(buildSkirt(spline, o, mat));
  parent.add(buildField(spline, o, mat));
}

/** The embankment either side of the circuit, swept along the spline. */
function buildSkirt(
  spline: TrackSpline, o: TerrainOptions, mat: THREE.Material,
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
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'embankment';
  return mesh;
}

/* The landscape's *light* is not built here.
 *
 * It used to be: a `bakeLighting` pass right below this line evaluated a second
 * lighting rig — its own hemisphere colours, its own rim, and the course's raw
 * theme azimuth and elevation with neither the house quarter-turn nor the
 * elevation clamp `render/lighting.ts` applies to the sun everything else in
 * the game is lit by. Measured, the two suns were sixty-five degrees apart, so
 * the desert and the buttes were modelled by one sun and every object standing
 * on them by another.
 *
 * It was also dead. `render/ground.ts` re-derives every one of these vertex
 * colours from scratch the moment the track is built — albedo from the
 * course's own surface ramp, light from the one shared rig — so nothing this
 * pass wrote ever reached a screen. Two lighting rigs, and the wrong one was
 * the one nobody could see.
 *
 * What is left here is albedo (`colourFor`) and geometry. If the ground system
 * ever fails to run, the landscape comes back flat rather than wrong.
 */

/** Everything from the embankment out to the fog. */
function buildField(
  spline: TrackSpline, o: TerrainOptions, mat: THREE.Material,
): THREE.Mesh {
  const half = o.size * 0.5;
  // Enough resolution that a butte reads as a block with faces rather than as a
  // smooth blob, without paying for detail the fog will eat anyway.
  const CELLS = 176;
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
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ground';
  return mesh;
}
