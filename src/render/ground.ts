// The ground under the tyres, per course.
//
// `track/terrain.ts` builds the landscape: an embankment skirt swept along the
// spline and a coarse field out to the fog, both baked unlit into vertex
// colours. It builds them beautifully and it builds them **the same way on
// every course** — one warm-sandstone ramp, one dust texture, and one sun
// direction taken raw from the theme rather than the one the scene is actually
// lit by. Saltpan Bypass declares 0xe0dccc, near-white salt, and photographed
// at rgb(122,100,59): within twelve points of Switchback Summit's alpine rock.
//
// So this system re-surfaces those two meshes the moment the track is built. It
// does not tint them — a tint would give four brightnesses of one surface, and
// salt, crusher dust, schist and canyon sand are four different materials. It
// re-derives every vertex from scratch:
//
//   1. Where the vertex is relative to the circuit — metres beyond the shoulder
//      and metres above the nearest road — recovered from the spline exactly
//      the way terrain.ts derived them in the first place.
//   2. An albedo from the landscape's own ramp (`theme.ts`), anchored on the
//      course's declared `theme.ground`.
//   3. The course's key light baked on top — and, unlike the original bake,
//      *the sun the game is actually lit by*: `render/lighting.ts` puts the sun
//      through a house quarter-turn and clamps its elevation to a 6-degree
//      working window, so a course asking for a 49-degree sun gets a 34-degree
//      one on every lit surface and used to get its 49-degree one on the dirt.
//      A mesa's lit face and a grandstand's lit face now point the same way.
//   4. The landscape's own detail map (`groundtex.ts`), on its own metre pitch.
//
// Cost: one spline `nearest()` per vertex inside the circuit's neighbourhood,
// which is the same query terrain.ts already runs once per vertex to build the
// thing. It happens at track-build time and never in a frame. Nothing here
// allocates per frame because nothing here runs per frame.

import * as THREE from 'three';
import { clamp } from '../core/math.ts';
import { smoothstep } from '../track/geom.ts';
import { groundTexture } from './groundtex.ts';
import { GROUND_SURFACES, resolveTheme } from './theme.ts';
import { makeGravelTexture } from '../track/textures.ts';
import type { PaintArgs } from './theme.ts';
import type { CourseTheme, GameContext, GameSystem, Track } from '../types.ts';

/** Mirrors `render/lighting.ts`. If that rig moves, this follows it. */
const AZIMUTH_TRIM = Math.PI * 0.5;
const SUN_ELEVATION = { min: 0.50, max: 0.60 };
const DEFAULT_SKY = { top: 0x2e86d6, bottom: 0xbfe7ff, horizon: 0xffe2b0 };
const DEFAULT_SUN = { color: 0xfff2d8, intensity: 2.6, azimuth: 0.7, elevation: 0.85 };
const SUN_GAIN = 1.16;
/** Fill and rim strength, close to the values the original bake was tuned to. */
const HEMI_I = 1.30;
const RIM_I = 0.55;
/**
 * Sunlight bounced back up off the ground itself.
 *
 * A hemisphere light hands an up-facing normal nothing but sky, which is why
 * the first cut of this made Cone Canyon read khaki: the desert floor was lit
 * by a blue dome and a low sun and lost every bit of its own warmth. But a
 * desert floor is not lit by the sky alone — it is lit by several square
 * kilometres of sunlit sand, and that single bounce is most of the reason a
 * desert is orange rather than blue-grey.
 *
 * Modelling it costs one multiply and it scales with the course automatically:
 * dark quarry rock bounces almost nothing and stays cold, near-white salt
 * bounces a great deal and lifts its own shadows, which is exactly what a salt
 * pan does in life.
 */
const BOUNCE = 0.26;
const WHITE = new THREE.Color(0xffffff);

/** The two meshes terrain.ts names. Anything else in the track group is not ours. */
const TERRAIN_MESHES = new Set(['ground', 'embankment']);
/** The gravel shoulder, built by road.ts. Only its detail map is touched. */
const VERGE_MESH = 'verge';

interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }

interface Rig {
  sun: THREE.Color;
  sx: number; sy: number; sz: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  rim: THREE.Color;
  rx: number; ry: number; rz: number;
}

function buildRig(theme: CourseTheme): Rig {
  const s = { ...DEFAULT_SKY, ...(theme.sky ?? {}) };
  const su = { ...DEFAULT_SUN, ...(theme.sun ?? {}) };
  const az = su.azimuth + AZIMUTH_TRIM;
  const el = clamp(su.elevation, SUN_ELEVATION.min, SUN_ELEVATION.max);

  const zenith = new THREE.Color(s.top);
  const horizon = new THREE.Color(s.bottom);

  // Same two ends the hemisphere light picks: sky above, the course's own
  // ground bounce below, lifted toward white and held well under the sky.
  const ground = new THREE.Color(theme.ground ?? 0xc9a063);
  const hemiSky = horizon.clone().lerp(zenith, 0.58).multiplyScalar(HEMI_I);
  const hemiGround = ground.clone().lerp(WHITE, 0.18).multiplyScalar(0.58 * HEMI_I);
  const rim = zenith.clone().lerp(WHITE, 0.34);

  const sun = new THREE.Color(su.color).multiplyScalar(su.intensity * SUN_GAIN);
  // One bounce off the ground, added to the upward fill. See BOUNCE.
  hemiSky.r += sun.r * ground.r * BOUNCE;
  hemiSky.g += sun.g * ground.g * BOUNCE;
  hemiSky.b += sun.b * ground.b * BOUNCE;

  const sx = Math.cos(el) * Math.cos(az);
  const sy = Math.sin(el);
  const sz = Math.cos(el) * Math.sin(az);
  // The rim mirrors the sun across the vertical and sits low, so it grazes.
  const rl = Math.hypot(-sx, 0.20, -sz) || 1;

  return {
    sun,
    sx, sy, sz,
    hemiSky, hemiGround, rim,
    rx: -sx / rl, ry: 0.20 / rl, rz: -sz / rl,
  };
}

export function createGroundSystem(ctx: GameContext): GameSystem {
  const _probe = new THREE.Vector3();
  let off: (() => void) | null = null;
  let surfacedFor = '';

  /**
   * Re-derive the albedo of one terrain mesh and bake the course's light into
   * it. `d`/`rel` are recovered the same way terrain.ts computed them, so the
   * ramp lands on exactly the ground it was authored against.
   */
  function surface(mesh: THREE.Mesh, track: Track, rig: Rig, box: Bounds): void {
    const resolved = resolveTheme(track.theme);
    const surf = GROUND_SURFACES[resolved.land];
    const course = track.course;
    const verge = course.vergeWidth ?? 5;
    const groundY = course.groundY ?? -8;

    const pos = mesh.geometry.getAttribute('position');
    const nor = mesh.geometry.getAttribute('normal');
    const col = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!pos || !nor || !col) return;

    const spline = track.spline;
    const { minX, maxX, minZ, maxZ } = box;
    const NEAR = 420;

    const out = new THREE.Color();
    const args: PaintArgs = {
      d: 0, rel: 0, x: 0, z: 0,
      base: new THREE.Color(resolved.ground),
    };
    const s = spline.atDistance(0);
    const INV_PI = 1 / Math.PI;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      let d = 1e5;
      let sy = groundY;
      if (x > minX - NEAR && x < maxX + NEAR && z > minZ - NEAR && z < maxZ + NEAR) {
        _probe.set(x, 0, z);
        spline.nearest(_probe, s);
        d = Math.max(0, Math.hypot(x - s.pos.x, z - s.pos.z) - (s.width * 0.5 + verge));
        sy = s.pos.y;
      }
      args.d = d; args.rel = y - sy; args.x = x; args.z = z;
      surf.paint(args, out);

      const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
      const key = Math.max(0, nx * rig.sx + ny * rig.sy + nz * rig.sz);
      const rimAmt = Math.max(0, nx * rig.rx + ny * rig.ry + nz * rig.rz) * RIM_I;
      const hemi = 0.5 + 0.5 * ny;
      // A landform shades *itself*, and a hemisphere fill does not know that.
      // Both flanks of a butte have the same up-vector, so both get the same
      // fill; the sun term alone was not enough of a difference and the big
      // masses photographed as flat cut-outs — ARCHITECTURE §12's "warm key,
      // cool fill" reading on the karts and not on the landscape.
      //
      // So the fill is scaled by how much sky a face can actually see, which is
      // a function of two things: how steep it is, and whether it is turned
      // away from the light. A flat is untouched — `slope` is zero there, which
      // is most of the ground in the game — and a hundred-metre face turned
      // from the sun loses two fifths of its ambient, which is what puts a
      // terminator on a mesa.
      const slope = Math.sqrt(nx * nx + nz * nz);
      const away = 1 - smoothstep(-0.35, 0.30, nx * rig.sx + nz * rig.sz);
      const fill = 1 - 0.42 * slope * away;
      // `hemiSky`/`hemiGround` already carry the fill strength and the bounce.
      const lr = (rig.hemiGround.r + (rig.hemiSky.r - rig.hemiGround.r) * hemi) * fill
        + rig.sun.r * key + rig.rim.r * rimAmt;
      const lg = (rig.hemiGround.g + (rig.hemiSky.g - rig.hemiGround.g) * hemi) * fill
        + rig.sun.g * key + rig.rim.g * rimAmt;
      const lb = (rig.hemiGround.b + (rig.hemiSky.b - rig.hemiGround.b) * hemi) * fill
        + rig.sun.b * key + rig.rim.b * rimAmt;

      col.setXYZ(i, out.r * lr * INV_PI, out.g * lg * INV_PI, out.b * lb * INV_PI);
    }
    col.needsUpdate = true;
  }

  /**
   * Retint the gravel shoulder.
   *
   * The verge is the *other* half of "the ground under the tyres", and it is
   * the half a player spends time actually driving on. `road.ts` builds it with
   * `makeGravelTexture()` — a builder whose first parameter is a tint and which
   * has never once been given one — so all four courses run the same clay-brown
   * run-off, which on a white salt pan is a stripe of orange mud.
   *
   * Only the material's `map` is swapped. The mesh, the material, its vertex
   * colours (which carry the baked kerb shadow) and its shading are road.ts's
   * and stay road.ts's; this is the smallest possible intervention that makes
   * the shoulder answer to the course, and it evaporates the moment the road
   * module reads a verge colour of its own.
   */
  function retintVerge(track: Track, tint: string): void {
    track.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.name !== VERGE_MESH) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const withMap = mat as THREE.Material & { map?: THREE.Texture | null };
        if (!withMap.map) continue;
        const next = makeGravelTexture(tint);
        // The builder caches by tint and hands back a shared instance, so the
        // wrap and repeat road.ts chose have to be carried across by hand.
        next.wrapS = withMap.map.wrapS;
        next.wrapT = withMap.map.wrapT;
        next.repeat.copy(withMap.map.repeat);
        next.anisotropy = withMap.map.anisotropy;
        withMap.map = next;
        mat.needsUpdate = true;
      }
    });
  }

  function apply(track: Track): void {
    const meshes: THREE.Mesh[] = [];
    track.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && TERRAIN_MESHES.has(m.name)) meshes.push(m);
    });
    if (meshes.length === 0) return;

    const resolved = resolveTheme(track.theme);
    const surf = GROUND_SURFACES[resolved.land];
    const rig = buildRig(track.theme);
    retintVerge(track, surf.verge);
    // Far from the circuit the spline query is pointless — terrain.ts skips it
    // too, and settles those vertices onto the global datum instead. Walked
    // once and shared by both meshes.
    const box: Bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    const walk = track.spline.atDistance(0);
    for (let d = 0; d < track.spline.length; d += 8) {
      track.spline.atDistance(d, walk);
      box.minX = Math.min(box.minX, walk.pos.x); box.maxX = Math.max(box.maxX, walk.pos.x);
      box.minZ = Math.min(box.minZ, walk.pos.z); box.maxZ = Math.max(box.maxZ, walk.pos.z);
    }

    // One material for the whole landscape, so the skirt and the field can
    // never disagree — and unlit, because the light is in the vertices and
    // nothing out here receives a shadow map.
    const tex = groundTexture(resolved.land);
    tex.repeat.set(1 / surf.tile, 1 / surf.tile);
    const mat = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true });
    mat.name = `terrain:${resolved.land}`;

    const retired = new Set<THREE.Material>();
    for (const mesh of meshes) {
      surface(mesh, track, rig, box);
      const old = mesh.material;
      for (const m of Array.isArray(old) ? old : [old]) retired.add(m);
      mesh.material = mat;
    }
    // The material terrain.ts made is now unreferenced. Its map is not: that
    // one is cached inside track/textures.ts and other courses will ask for it.
    for (const m of retired) m.dispose();
    surfacedFor = track.id;
  }

  return {
    name: 'ground',
    // Between the track (20) and the world dressing (22). Nothing here runs in
    // a frame; the order only decides where it sits in a stack trace.
    order: 21,

    init(): void {
      off = ctx.bus.on('track:built', (e: unknown) => {
        const track = (e as { track?: Track } | undefined)?.track ?? ctx.track;
        if (track) apply(track);
      });
      if (ctx.track && ctx.track.id !== surfacedFor) apply(ctx.track);
    },

    dispose(): void {
      off?.();
      off = null;
      surfacedFor = '';
    },
  };
}
