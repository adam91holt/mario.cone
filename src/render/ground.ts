// The ground under the tyres, per course.
//
// `track/terrain.ts` builds the landscape: an embankment skirt swept along the
// spline and a coarse field out to the fog. It builds them beautifully and it
// builds them **the same way on every course** — one warm-sandstone ramp and
// one dust texture. Saltpan Bypass declares 0xe0dccc, near-white salt, and
// photographed at rgb(122,100,59): within twelve points of Switchback Summit's
// alpine rock.
//
// So this system owns the landscape's surface: its albedo, its light, its
// material, and which of its two meshes receives a shadow map. It does not tint
// what terrain.ts made — a tint would give four brightnesses of one surface,
// and salt, crusher dust, schist and canyon sand are four different materials.
// It re-derives every vertex from scratch:
//
//   1. Where the vertex is relative to the circuit — metres beyond the shoulder
//      and metres above the nearest road — recovered from the spline exactly
//      the way terrain.ts derived them in the first place.
//   2. An albedo from the landscape's own ramp (`theme.ts`), anchored on the
//      course's declared `theme.ground`.
//   3. The course's key light baked on top, from `sunRig()` in
//      `render/lighting.ts` — *the sun the game is actually lit by*, house
//      quarter-turn, elevation clamp and all. There used to be three
//      derivations of that sun in this repo and one of them, inside
//      `track/terrain.ts`, was sixty-five degrees off. There is one now, it
//      lives with the lights, and this file imports it.
//   4. The landscape's own detail map (`groundtex.ts`), on its own metre pitch.
//   5. A shadow term on the embankment, so the thing every prop in the game
//      stands on can be stood on. See `shadowedTerrainMaterial`.
//
// Cost: one spline `nearest()` per vertex inside the circuit's neighbourhood,
// which is the same query terrain.ts already runs once per vertex to build the
// thing. It happens at track-build time and never in a frame. Nothing here
// allocates per frame because nothing here runs per frame.

import * as THREE from 'three';
import { smoothstep } from '../track/geom.ts';
import { groundTexture } from './groundtex.ts';
import { sunRig } from './lighting.ts';
import { GROUND_SURFACES, resolveTheme } from './theme.ts';
import { makeGravelTexture } from '../track/textures.ts';
import type { PaintArgs } from './theme.ts';
import type { CourseTheme, GameContext, GameSystem, Track } from '../types.ts';

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
  // **The rig itself is `render/lighting.ts`'s** — direction, colours, the
  // house quarter-turn and the elevation clamp all come from there, so a mesa's
  // lit face and a grandstand's lit face can never point different ways again.
  // What is local to the bake is only how hard each term is pushed.
  const r = sunRig(theme);

  const hemiSky = r.hemiSky.clone().multiplyScalar(HEMI_I);
  const hemiGround = r.hemiGround.clone().multiplyScalar(HEMI_I);
  const sun = r.key.clone();
  const ground = r.ground;

  // One bounce off the ground, added to the upward fill. See BOUNCE.
  hemiSky.r += sun.r * ground.r * BOUNCE;
  hemiSky.g += sun.g * ground.g * BOUNCE;
  hemiSky.b += sun.b * ground.b * BOUNCE;

  return {
    sun,
    sx: r.dir.x, sy: r.dir.y, sz: r.dir.z,
    hemiSky, hemiGround, rim: r.rim.clone(),
    rx: r.rimDir.x, ry: r.rimDir.y, rz: r.rimDir.z,
  };
}

/**
 * What is left of the light when the sun is taken out of it.
 *
 * The landscape is drawn unlit, so a shadow falling on it cannot be "the key
 * term times zero" — there is no key term at run time, it is already inside the
 * vertex colours. This is the ratio between the two, per channel, for a
 * level face: fill plus rim over fill plus rim plus key. Multiplying the baked
 * colour by it lands on exactly the colour the bake would have produced if the
 * sun had been blocked, which is what makes a prop's shadow on the dirt and a
 * kart's shadow on the tarmac the same shadow.
 */
function shadeOf(rig: Rig, out: THREE.Color): THREE.Color {
  const rimUp = Math.max(0, rig.ry) * RIM_I;
  const key = Math.max(0, rig.sy);
  const ch = (fill: number, rim: number, sun: number): number => {
    const lit = fill + rim * rimUp + sun * key;
    return lit > 1e-5 ? (fill + rim * rimUp) / lit : 1;
  };
  return out.setRGB(
    ch(rig.hemiSky.r, rig.rim.r, rig.sun.r),
    ch(rig.hemiSky.g, rig.rim.g, rig.sun.g),
    ch(rig.hemiSky.b, rig.rim.b, rig.sun.b),
  );
}

/**
 * An unlit terrain material that can still be stood on.
 *
 * `MeshBasicMaterial` cannot receive a shadow — it has no lights in its shader
 * at all — and that single fact was the whole of the split between the two
 * halves of this game's look: `world/index.ts` declined to cast because the
 * terrain could not receive, `render/ground.ts` declined to receive because
 * nothing out there cast, both comments were correct, and the verge stayed a
 * greybox six metres from a road that looks like a Nintendo game.
 *
 * So the landscape is lit the way it always was — baked, in the vertices,
 * because it is the largest thing on screen and the review harness rasterises
 * in software — and the *only* thing the real rig contributes is the shadow
 * mask. A Lambert material carries the shadow chunks and the light uniforms;
 * everything it computes with them is thrown away and replaced with the bake
 * times the mask.
 */
function shadowedTerrainMaterial(
  map: THREE.Texture, shade: THREE.Color,
): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ map, vertexColors: true });
  const uniform = { value: shade.clone() };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTerrainShade = uniform;
    shader.fragmentShader = shader.fragmentShader
      .replace('uniform vec3 diffuse;', 'uniform vec3 diffuse;\nuniform vec3 uTerrainShade;')
      .replace(
        '#include <shadowmap_pars_fragment>',
        '#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>',
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        // The bake is already the answer. Take the sun back out where the map
        // says something is standing in front of it, and nothing else.
        reflectedLight.directDiffuse = vec3( 0.0 );
        reflectedLight.indirectDiffuse =
          diffuseColor.rgb * mix( uTerrainShade, vec3( 1.0 ), getShadowMask() );`,
      );
  };
  // Two materials that compile to different programs must not share a cache
  // key, and three keys on this.
  mat.customProgramCacheKey = (): string => 'mc-terrain-shadow';
  return mat;
}

export function createGroundSystem(ctx: GameContext): GameSystem {
  const _probe = new THREE.Vector3();
  const _shade = new THREE.Color();
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

      // Flat ground carries no shape at this mesh resolution and should not be
      // asked to. The far field is 176 cells across four kilometres, so one
      // triangle is 23 metres on a side and its normal is quantisation noise —
      // bake a 30-degree sun against that and what prints is the triangulation:
      // the angular tonal wedges a critic photographed from the overhead camera
      // and read, correctly, as flat shading. Anything within twenty degrees of
      // level is therefore lit as level, and the terminator work below is spent
      // where there is a real slope to spend it on.
      const rawY = nor.getY(i);
      const flat = smoothstep(0.93, 0.995, rawY);
      const nx = nor.getX(i) * (1 - flat);
      const nz = nor.getZ(i) * (1 - flat);
      const ny = rawY + (1 - rawY) * flat;
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

    // One bake, one texture, one ramp for the whole landscape, so the skirt and
    // the field can never disagree about what this course is made of.
    //
    // Two materials, though, and the split is a budget rather than a look. The
    // embankment is the ground the player actually drives past — every cone,
    // drum, sign, hut and barrier in the game stands on it, and it is the only
    // terrain inside the shadow camera's sixty metres — so it takes the shadow
    // receive. The far field is four kilometres of ground that begins beyond
    // the skirt's last ring at 150m, where the shadow map has already run out
    // and `getShadowMask()` would return 1 for every one of its 62,000
    // triangles. Paying per-fragment for a term that is constant is not
    // coherence, it is waste; the two agree everywhere they meet because
    // an unshadowed fragment of one is the same arithmetic as a fragment of
    // the other.
    const tex = groundTexture(resolved.land);
    tex.repeat.set(1 / surf.tile, 1 / surf.tile);
    const field = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true });
    field.name = `terrain:${resolved.land}`;
    const skirt = shadowedTerrainMaterial(tex, shadeOf(rig, _shade));
    skirt.name = `terrain:${resolved.land}:shadowed`;

    const retired = new Set<THREE.Material>();
    for (const mesh of meshes) {
      surface(mesh, track, rig, box);
      const old = mesh.material;
      for (const m of Array.isArray(old) ? old : [old]) retired.add(m);
      const near = mesh.name === 'embankment';
      mesh.material = near ? skirt : field;
      mesh.receiveShadow = near;
      mesh.castShadow = false;
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
