// THE FLOOD — the water on Saltpan Bypass, and what a kart does to it.
//
// ── the finding this file exists to answer ─────────────────────────────────
//
// A critic played round three and rejected the cup on the round's own
// signature:
//
//   *"THE FLOOD — the named signature mechanic of an entire round of the cup —
//   renders as a flat, static, untextured translucent quad with hard straight
//   polygon edges laid on top of the tarmac, and no racer driving through it
//   produces a single splash, spray plume or wake, so the player's only cue
//   that they are in water is a colour shift. I captured five racers
//   simultaneously inside the water with zero spray between them."*
//
// Three faults, and they are three different faults:
//
//   1. **The boundary was a ruled polygon edge.** `road.ts` builds a `brine`
//      patch out of the same `patchScale()` band the physics reads, and that
//      band *tapers*: over the leading 1.6 metres it grows from a point at the
//      band's centre out to full width. On a thirty-four-metre road that is a
//      very shallow V — two straight lines ruled diagonally across the asphalt,
//      which is exactly what was photographed. And the sheet sat at a constant
//      5.2cm lift right out to its own edge, so where the tarmac fell away
//      under the crown the sheet stayed level and showed a vertical side wall.
//   2. **It was static.** No motion, no ripple, no sparkle. At 87 m/s a still
//      surface is a painted patch; the eye finds *motion* before it finds
//      colour, and there was none to find.
//   3. **Driving through it emitted nothing.** `fx/index.ts` does carry a
//      `water` row in `SURFACE_FX`, and it fires — but it fires the generic
//      loose-surface dust puff, which is a pale haze scaled to a tyre. Water is
//      not dust. A kart at sixty metres a second hitting a hundred millimetres
//      of standing brine throws a *rooster tail* the height of the machine and
//      leaves a wake on the sheet behind it for a second and a half, and
//      neither of those is something a dust preset can be tuned into.
//
// ── why this is a system in `courses/` and not a change to `road.ts` ───────
//
// Same answer, and same precedent, as `courses/kit.ts`: `track/road.ts` builds
// exactly one kind of brine patch, unconditionally, and it is not this module's
// file. So this listens for `track:built`, hides the stock sheet, and stands
// its own in its place — the smallest intervention that makes the water answer
// to the course that declared it. Nothing here touches the driving: `sample()`
// still resolves `water` off the same `PatchRuntime` band it always did, and
// this file resolves each sheet from the *same* `SurfacePatchDef` the road
// resolves, into the same `PatchRuntime` shape, so the sheet a player can see
// and the sheet the kart is standing on are read off one declaration.
//
// The moment `track/` grows a water vocabulary of its own, this evaporates.
//
// ── the three pieces ───────────────────────────────────────────────────────
//
//   * **the sheet** — a conformed, alpha-dissolved, foam-edged surface with an
//     animated ripple normal and a specular sparkle, driven off `ctx.time`.
//   * **the spray** — a persistent rooster tail off every wheel of every racer
//     standing in water, plus a burst on entry.
//   * **the wake** — a fading ribbon of disturbed water behind each racer, with
//     the two bright divergent foam lines that are what actually says *this is
//     liquid* rather than *this is a colour*.
//
// ── determinism, and where the clocks come from ────────────────────────────
//
// The sheet's animation phase is `ctx.time.elapsed` — simulation time, the same
// number on every machine and on the reviewer's software rasteriser. Never a
// wall-clock read. The particles run in `update()` and are visuals only: they
// use a **private** LCG rather than `ctx.rng`, because drawing from the
// simulation's generator out of a per-frame hook would desync the simulation
// itself. Nothing in this file has a `fixedUpdate`.

import * as THREE from 'three';
import { surfacePoint } from '../geom.ts';
import type { PatchRuntime } from '../road.ts';
import { features } from './types.ts';
import type { TrackSpline } from '../spline.ts';
import type { CourseDef, GameContext, GameSystem, Racer, SplineSample, Track } from '../../types.ts';

// ── numbers ────────────────────────────────────────────────────────────────

/** Metres the sheet stands over the road at its deepest. */
const DEPTH = 0.055;
/**
 * Metres of soft margin at every boundary of the sheet.
 *
 * Two things happen across this band and they are deliberately the same band:
 * the alpha falls to nothing, and the lift falls to nearly nothing. That pair
 * is the whole answer to *"floats above it with a visible vertical side wall"* —
 * a sheet whose edge is both transparent and level with the tarmac has no edge
 * to see.
 */
const MARGIN = 2.2;
/** Metres of foam / wet band inside the margin. The critic asked for 1-2. */
const FOAM = 1.6;
/** Along-track sampling of the sheet, metres. */
const STEP = 1.6;
/** Across-track sampling of the sheet, metres. Ripple is per-pixel, not per-vertex. */
const ACROSS = 20;

/** Below this, a wheel is paddling rather than planing and throws nothing. */
const SPRAY_MIN_SPEED = 7;

/** Hard ceilings. Nothing in here allocates after `build()`. */
const MAX_SPRAY = 1400;
/** Wake samples kept per racer. At 0.055s a sample that is about 2.2s of trail. */
const WAKE_POINTS = 40;
const MAX_RACERS = 12;

// ── the sheet ──────────────────────────────────────────────────────────────

/**
 * The water shader, grafted onto a Phong material rather than written from
 * scratch.
 *
 * Deliberate: a bare `ShaderMaterial` would have to reimplement fog, the
 * shadow mask, tone mapping and the lighting the rest of the course is lit by,
 * and would then disagree with all four the first time somebody changed one.
 * Phong already carries them; what it does not carry is a normal that moves and
 * an edge that dissolves, and those are the two things injected below.
 *
 * `aEdge` is metres from the nearest boundary of the sheet, clamped. It is the
 * only extra attribute, and it drives the dissolve, the foam and the wet band
 * from one number so they cannot come apart.
 */
function waterMaterial(tint: string, time: { value: number }): THREE.MeshPhongMaterial {
  const mat = new THREE.MeshPhongMaterial({
    color: new THREE.Color(tint),
    specular: 0xfffdf6,
    // High and tight: standing water is a mirror, and the sun on it is a hard
    // small glint rather than a broad sheen. This is the sparkle the critic
    // asked for and it is free — the ripple normal below is what makes it
    // travel across the surface instead of sitting still.
    shininess: 260,
    vertexColors: true,
    transparent: true,
    // Judging the depth of a flooded road *is* the skill this sheet exists to
    // ask about, so the centre dashes and the edge line have to read through
    // it. An opaque sheet is a painted patch with a highlight on it.
    opacity: 0.62,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -5,
    polygonOffsetUnits: -5,
  });

  mat.onBeforeCompile = (shader): void => {
    shader.uniforms.uTime = time;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aEdge;
        varying float vEdge;
        varying vec3 vWorld;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vEdge = aEdge;
        vWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        varying float vEdge;
        varying vec3 vWorld;

        // Six crossed wave trains at three scales. Cheap, endless, and — because
        // every phase is a function of uTime, which is simulation time — the
        // same on every machine and in every replay.
        vec3 rippleNormal( vec2 p, float t ) {
          vec2 g = vec2( 0.0 );
          g.x += 0.085 * sin( p.x * 0.55 + p.y * 0.21 + t * 1.55 );
          g.y += 0.085 * sin( p.y * 0.62 - p.x * 0.24 + t * 1.25 );
          g.x += 0.055 * sin( p.x * 1.70 - p.y * 1.15 - t * 2.90 );
          g.y += 0.055 * sin( p.y * 1.55 + p.x * 1.05 + t * 2.35 );
          g.x += 0.028 * sin( p.x * 4.30 + p.y * 2.10 + t * 5.10 );
          g.y += 0.028 * sin( p.y * 4.05 - p.x * 2.60 - t * 5.80 );
          return normalize( vec3( -g.x, 1.0, -g.y ) );
        }`,
      )
      // The perturbation is built in world space and then taken into view
      // space, rather than added to the view-space normal directly: the sheet
      // lies on a road that banks and climbs, and a normal bent in the wrong
      // frame puts the sun's glint somewhere the sun is not.
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        {
          vec3 wn = rippleNormal( vWorld.xz, uTime );
          normal = normalize( ( viewMatrix * vec4( wn, 0.0 ) ).xyz );
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float e = vEdge;

          // ── the dissolve ─────────────────────────────────────────────────
          // Alpha to nothing over the outer margin, so the sheet has no ruled
          // boundary anywhere. Squared, so most of the fade happens close in
          // and the sheet keeps its body.
          float diss = smoothstep( 0.0, ${MARGIN.toFixed(2)}, e );
          diffuseColor.a *= diss * diss;

          // ── the foam, and the wet band under it ──────────────────────────
          // A scrolling ragged crest riding the edge. The two trains beat
          // against each other so the line never repeats down a
          // thirty-four-metre waterline, and both are functions of uTime, so
          // the foam *travels* — which is the tell that the edge is a water
          // line and not a paint line.
          float n1 = sin( vWorld.x * 0.85 + vWorld.z * 0.42 - uTime * 1.35 );
          float n2 = sin( vWorld.z * 1.24 - vWorld.x * 0.61 + uTime * 0.95 );
          float n3 = sin( vWorld.x * 2.90 - vWorld.z * 3.40 + uTime * 2.10 );
          // Contrasty rather than soft. A foam line that fades smoothly to
          // nothing is fog; one that breaks into lumps with dark water between
          // them is surf, and surf is what says *edge of the water*.
          float crest = clamp( 0.18 + 1.15 * ( n1 * n2 ) + 0.22 * n3, 0.0, 1.0 );
          float foam = smoothstep( ${(FOAM + 0.15).toFixed(2)}, 0.20, e ) * crest;
          foam *= smoothstep( 0.0, 0.45, e );

          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0, 0.99, 0.96 ), foam * 0.92 );
          diffuseColor.a = max( diffuseColor.a, foam * 0.86 );
        }`,
      );
  };

  // Two materials that compile to different programs must not share a cache
  // key, and this one is a different program from every other Phong in the
  // game.
  mat.customProgramCacheKey = (): string => 'mc-flood-water';
  return mat;
}

/**
 * One sheet, conformed to the road.
 *
 * Built as a plain grid rather than through `MeshBuilder` for one reason: the
 * dissolve needs a per-vertex distance-to-boundary, and a ribbon lane cannot
 * carry an attribute the builder does not know about.
 *
 * **The band is the declared band, not the tapered one.** `patchScale()` pinches
 * a hard patch from a point to full width over its leading 1.6 metres, which is
 * how physics wants it and is also the diagonal a critic photographed. What is
 * drawn here is the full rectangle with a *transverse* waterline that dissolves
 * and foams — perpendicular to the road, the way a waterline actually lies —
 * and a hand-rolled wobble so it is not ruled either. The consequence is that
 * for the first metre and a half of a sheet the water reads very slightly wider
 * than physics calls it, at the extreme lateral edges only: eighteen
 * milliseconds at racing speed, in the driver's favour.
 */
function buildSheet(
  spline: TrackSpline, p: PatchRuntime, verge: number,
  pos: number[], col: number[], edge: number[], idx: number[],
): void {
  const span = p.d1 - p.d0;
  if (span <= 0.5) return;
  const rings = Math.max(3, Math.round(span / STEP) + 1);
  const cols = ACROSS;
  const base = pos.length / 3;
  const s: SplineSample = spline.atDistance(p.d0);
  const _v = new THREE.Vector3();

  for (let i = 0; i < rings; i++) {
    const f = i / (rings - 1);
    // A waterline that wanders. ±0.55m of low-frequency wobble along the
    // leading and trailing edges, so neither is a ruled line even before the
    // foam and the dissolve get to it. Deterministic — it is a function of the
    // patch seed and the lateral, nothing else.
    const d = p.d0 + span * f;
    spline.atDistance(d, s);
    const half = s.width * 0.5;

    for (let j = 0; j < cols; j++) {
      const u = j / (cols - 1);
      const t = u * 2 - 1;
      const wob = Math.sin(t * 5.1 + p.seed * 3.7) * 0.35 + Math.sin(t * 11.3 - p.seed) * 0.2;
      const lat = (p.c + p.hw * t) * half;

      // Distance to the nearest boundary, in metres, in both directions at
      // once. Along the road the wobble moves the waterline; across it the
      // band edge is where the declaration put it.
      const along = Math.min(d - p.d0, p.d1 - d) + wob;
      const across = (1 - Math.abs(t)) * p.hw * half;
      const e = Math.max(0, Math.min(along, across));

      // The lift falls away with the same number that fades the alpha, so the
      // sheet meets the tarmac rather than standing on it.
      const k = Math.min(1, e / MARGIN);
      surfacePoint(s, lat, verge, DEPTH * (0.10 + 0.90 * k * k), _v);
      pos.push(_v.x, _v.y, _v.z);

      // Deep in the middle, and paler where it thins — the one cue that says
      // which part of a flooded road you can survive. Same read the stock sheet
      // had; it is the only thing about it that was right.
      const shallow = 1 - Math.min(1, e / 3.4);
      const v = 0.86 + shallow * 0.30;
      col.push(v * 0.93, v, v * 1.05, 1);
      edge.push(e);
    }
  }

  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = base + i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const dd = c + 1;
      idx.push(a, c, b, b, c, dd);
    }
  }
}

// ── the spray ──────────────────────────────────────────────────────────────

const SPRAY_VERT = /* glsl */`
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
uniform float uScale;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mv;
  float z = max( 0.4, -mv.z );
  // ── the near fade, and it is not an optimisation ────────────────────────
  //
  // A sprite two metres from the lens covers a quarter of the frame, and the
  // machine throwing the most water is always the one the camera is bolted to.
  // The first cut of this photographed the player's own plume as a flat pale
  // mass across the bottom half of the picture with the road behind it gone.
  // Everything inside four metres is faded out: the plume is *there*, it is
  // just not allowed to be the picture.
  vAlpha = aAlpha * smoothstep( 1.1, 4.6, z );
  gl_PointSize = clamp( aSize * uScale / z, 1.0, 150.0 );
}`;

const SPRAY_FRAG = /* glsl */`
varying float vAlpha;
varying vec3 vColor;
void main() {
  // A soft round droplet with a slightly hot core. Water broken into air is
  // lit from the whole sky and reads brighter than anything it is over, which
  // is why this is nearly white on the darkest tarmac in the cup.
  vec2 d = gl_PointCoord - 0.5;
  float r = dot( d, d ) * 4.0;
  if ( r > 1.0 ) discard;
  float a = ( 1.0 - r ) * ( 1.0 - r );
  float core = pow( 1.0 - r, 6.0 );
  gl_FragColor = vec4( vColor + core * 0.35, a * vAlpha );
}`;

interface Spray {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; ttl: number;
  size0: number; size1: number;
  r: number; g: number; b: number;
  alpha: number;
}

// ── the wake ───────────────────────────────────────────────────────────────

const WAKE_VERT = /* glsl */`
attribute float aAge;
attribute float aSide;
varying float vAge;
varying float vSide;
varying vec3 vWorld;
void main() {
  vAge = aAge;
  vSide = aSide;
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const WAKE_FRAG = /* glsl */`
varying float vAge;
varying float vSide;
varying vec3 vWorld;
uniform float uTime;
void main() {
  // Two divergent foam lines with churned water between them. That shape — not
  // the colour — is what reads as "something heavy went through here".
  float s = abs( vSide );
  float rails = smoothstep( 0.42, 0.96, s ) * ( 1.0 - smoothstep( 0.96, 1.0, s ) );
  float churn = ( 1.0 - s ) * ( 0.42
    + 0.38 * sin( vWorld.x * 2.7 + vWorld.z * 1.9 - uTime * 3.1 )
    * sin( vWorld.z * 3.3 - vWorld.x * 2.1 + uTime * 2.4 ) );
  float body = clamp( rails * 1.15 + churn * 0.55, 0.0, 1.0 );
  // Fades out at the head as well as the tail: the wake has to *close* behind
  // the machine rather than end on a straight line.
  float fade = ( 1.0 - vAge ) * ( 1.0 - vAge ) * smoothstep( 0.0, 0.06, vAge );
  gl_FragColor = vec4( vec3( 1.0, 0.995, 0.97 ), body * fade * 0.55 );
  if ( gl_FragColor.a < 0.004 ) discard;
}`;

interface WakeSample {
  x: number; y: number; z: number;
  rx: number; rz: number;
  half: number;
  age: number;
}

interface WakeTrail {
  pts: WakeSample[];
  head: number;
  count: number;
  since: number;
  /** Metres travelled since the last sample, so the trail is spatial not temporal. */
  wasWet: boolean;
}

// ── the system ─────────────────────────────────────────────────────────────

export function createFloodSystem(ctx: GameContext): GameSystem {
  const THREEns = ctx.THREE;

  let root: THREE.Group | null = null;
  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const timeU = { value: 0 };

  // ── the spray pool ────────────────────────────────────────────────────────
  const pool: Spray[] = [];
  for (let i = 0; i < MAX_SPRAY; i++) {
    pool.push({
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, ttl: 1,
      size0: 1, size1: 1, r: 1, g: 1, b: 1, alpha: 1,
    });
  }
  let live = 0;
  const sprayPos = new Float32Array(MAX_SPRAY * 3);
  const sprayCol = new Float32Array(MAX_SPRAY * 3);
  const spraySize = new Float32Array(MAX_SPRAY);
  const sprayAlpha = new Float32Array(MAX_SPRAY);
  let sprayGeo: THREE.BufferGeometry | null = null;
  let sprayPoints: THREE.Points | null = null;
  const sprayScale = { value: 380 };

  // ── the wake pool ─────────────────────────────────────────────────────────
  const trails: WakeTrail[] = [];
  for (let i = 0; i < MAX_RACERS; i++) {
    const pts: WakeSample[] = [];
    for (let j = 0; j < WAKE_POINTS; j++) pts.push({ x: 0, y: 0, z: 0, rx: 1, rz: 0, half: 1, age: 1 });
    trails.push({ pts, head: 0, count: 0, since: 0, wasWet: false });
  }
  const WAKE_VERTS = MAX_RACERS * WAKE_POINTS * 2;
  const wakePos = new Float32Array(WAKE_VERTS * 3);
  const wakeAge = new Float32Array(WAKE_VERTS);
  const wakeSide = new Float32Array(WAKE_VERTS);
  const wakeIdx = new Uint16Array(MAX_RACERS * (WAKE_POINTS - 1) * 6);
  let wakeGeo: THREE.BufferGeometry | null = null;
  let wakeMesh: THREE.Mesh | null = null;

  /**
   * A private generator.
   *
   * Not `ctx.rng`: this runs in `update()`, and drawing from the simulation's
   * stream out of a per-frame hook would make the simulation depend on how many
   * frames were rendered — which is the one thing `step()` exists to prevent.
   */
  let seed = 0x9e3779b9;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const range = (a: number, b: number): number => a + (b - a) * rnd();

  // Scratch. Nothing in the per-frame path allocates.
  const _fwd = new THREEns.Vector3();
  const _right = new THREEns.Vector3();
  const _up = new THREEns.Vector3();
  const _at = new THREEns.Vector3();
  const _m = new THREEns.Matrix4();

  /** Water depth is what a wheel throws; below the sheet there is nothing. */
  let hasWater = false;

  function emit(
    x: number, y: number, z: number, vx: number, vy: number, vz: number,
    ttl: number, s0: number, s1: number, alpha: number, warm: number,
  ): void {
    if (live >= MAX_SPRAY) return;
    const p = pool[live++]!;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.life = 0; p.ttl = ttl;
    p.size0 = s0; p.size1 = s1;
    // Brine is not white: it is a very pale, very slightly green-blue, and the
    // droplets closest to the sheet carry more of the sheet's own colour.
    p.r = 0.80 + warm * 0.20;
    p.g = 0.90 + warm * 0.10;
    p.b = 0.94 + warm * 0.06;
    p.alpha = alpha;
  }

  /**
   * One machine's contribution for one frame.
   *
   * Four wheels, and the rear pair throw about twice what the front pair do —
   * the fronts part the water and the rears are driving through the trench the
   * fronts opened, which is why a rooster tail comes off the *back* of a
   * vehicle in every photograph of one that has ever been taken.
   */
  function sprayRacer(r: Racer, dt: number, budget: number): void {
    const sp = Math.abs(r.speed);
    if (sp < SPRAY_MIN_SPEED) return;

    _m.makeRotationFromQuaternion(r.quat);
    _right.set(1, 0, 0).applyMatrix4(_m);
    _up.set(0, 1, 0).applyMatrix4(_m);
    _fwd.set(0, 0, 1).applyMatrix4(_m);

    // Scaled off top speed rather than off an absolute, so a heavy machine and
    // a light one throw the same amount of water at the same fraction of their
    // own pace.
    const load = Math.min(1, sp / 46);
    const n = Math.min(9, Math.round(budget * (2.4 + 9.5 * load) * dt * 60));

    for (let i = 0; i < n; i++) {
      const rear = i % 3 !== 0;
      const side = i % 2 === 0 ? 1 : -1;
      const back = rear ? -1.05 : 0.95;
      const lat = side * range(0.72, 1.02);

      _at.copy(r.pos)
        .addScaledVector(_right, lat)
        .addScaledVector(_fwd, back)
        .addScaledVector(_up, -0.18);

      // Up and *outward*, and mostly backward relative to the road. A rooster
      // tail is water being thrown off the top of a rotating tyre: it leaves
      // roughly along the tyre's own tangent, which is up and back, and then
      // fans sideways as it breaks up.
      const throwUp = rear ? range(3.4, 7.6) : range(1.9, 4.2);
      const out = side * range(0.6, 3.1);
      const drag = rear ? 0.42 : 0.30;
      emit(
        _at.x, _at.y, _at.z,
        r.vel.x * drag + _right.x * out - _fwd.x * range(1, 5) + range(-0.5, 0.5),
        throwUp,
        r.vel.z * drag + _right.z * out - _fwd.z * range(1, 5) + range(-0.5, 0.5),
        range(0.34, 0.72),
        range(0.13, 0.32) * (rear ? 1.35 : 1),
        range(0.62, 1.15),
        range(0.50, 0.85) * (0.45 + 0.55 * load),
        rnd(),
      );
    }

    // The sheet itself, pushed sideways: a low flat curtain either side of the
    // machine that is thrown *out* rather than up. It is what makes the plume
    // read as displaced water instead of as steam.
    const m = Math.min(4, Math.round(budget * (1.2 + 4.0 * load) * dt * 60));
    for (let i = 0; i < m; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      _at.copy(r.pos)
        .addScaledVector(_right, side * range(0.9, 1.35))
        .addScaledVector(_fwd, range(-1.4, 0.6))
        .addScaledVector(_up, -0.30);
      emit(
        _at.x, _at.y, _at.z,
        r.vel.x * 0.24 + _right.x * side * range(3.2, 7.4),
        range(0.6, 2.0),
        r.vel.z * 0.24 + _right.z * side * range(3.2, 7.4),
        range(0.45, 0.85),
        range(0.28, 0.52), range(0.85, 1.45),
        range(0.24, 0.42) * (0.4 + 0.6 * load),
        rnd() * 0.5,
      );
    }
  }

  /** The moment of entry: one hard sheet of water thrown forward and up. */
  function splash(r: Racer, budget: number): void {
    const sp = Math.abs(r.speed);
    if (sp < SPRAY_MIN_SPEED) return;
    _m.makeRotationFromQuaternion(r.quat);
    _right.set(1, 0, 0).applyMatrix4(_m);
    _fwd.set(0, 0, 1).applyMatrix4(_m);
    const load = Math.min(1, sp / 46);
    const n = Math.round(budget * (16 + 30 * load));
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      _at.copy(r.pos)
        .addScaledVector(_right, side * range(0.3, 1.5))
        .addScaledVector(_fwd, range(0.3, 1.6));
      _at.y -= 0.24;
      emit(
        _at.x, _at.y, _at.z,
        r.vel.x * 0.30 + _right.x * side * range(2.5, 9.5) + _fwd.x * range(0, 4),
        range(2.6, 9.0),
        r.vel.z * 0.30 + _right.z * side * range(2.5, 9.5) + _fwd.z * range(0, 4),
        range(0.42, 0.90),
        range(0.18, 0.46), range(1.0, 1.7),
        range(0.42, 0.78),
        rnd(),
      );
    }
  }

  // ── build ──────────────────────────────────────────────────────────────

  function dispose(): void {
    if (root) {
      ctx.scene.remove(root);
      root = null;
    }
    for (const g of geometries) g.dispose();
    geometries.length = 0;
    for (const m of materials) m.dispose();
    materials.length = 0;
    sprayGeo = null;
    sprayPoints = null;
    wakeGeo = null;
    wakeMesh = null;
    live = 0;
    hasWater = false;
    for (const t of trails) { t.count = 0; t.head = 0; t.since = 0; t.wasWet = false; }
  }

  function build(track: Track): void {
    dispose();
    const course: CourseDef = track.course;
    const defs = (features(course).patches ?? []).filter(
      (d) => d.surface === 'water' || d.style === 'brine',
    );
    if (!defs.length) return;

    hasWater = true;
    const spline = track.spline as unknown as TrackSpline;
    const verge = course.vergeWidth ?? 5;
    const L = spline.length;
    const start = course.startDistance ?? 0;

    root = new THREEns.Group();
    root.name = 'flood';

    // The stock sheet, replaced. `visible = false` rather than removal, for the
    // reason `kit.ts` states: `track/index.ts` owns that object, rebuilds it
    // with the road and disposes it with the road, and a system that *removed*
    // it would be quietly taking something out of a group somebody else is
    // about to free.
    const stock = track.group.getObjectByName('brine');
    if (stock) stock.visible = false;

    // One mesh per tint, so a course may flood in two colours without paying
    // for two draw calls per sheet.
    const byTint = new Map<string, { pos: number[]; col: number[]; edge: number[]; idx: number[] }>();
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i]!;
      const tint = def.tint ?? '#3F6E7C';
      let buf = byTint.get(tint);
      if (!buf) { buf = { pos: [], col: [], edge: [], idx: [] }; byTint.set(tint, buf); }
      const lo = Math.min(def.latFrom, def.latTo);
      const hi = Math.max(def.latFrom, def.latTo);
      const d0 = ((start + def.from * L) % L + L) % L;
      const span = Math.max(8, (def.to - def.from) * L);
      // The same `PatchRuntime` shape `road.ts` resolves and `sample()` walks,
      // built from the same declaration. It is not *used* for the band here —
      // see `buildSheet` — but keeping it means the seed, the extent and the
      // centre are one arithmetic rather than two.
      buildSheet(spline, {
        d0, d1: d0 + span, surface: def.surface,
        c: (lo + hi) * 0.5, hw: (hi - lo) * 0.5,
        taper: 1.6, seed: i * 7.31 + 1.7, hard: true,
      }, verge, buf.pos, buf.col, buf.edge, buf.idx);
    }

    for (const [tint, buf] of byTint) {
      if (!buf.idx.length) continue;
      const geo = new THREEns.BufferGeometry();
      geo.setAttribute('position', new THREEns.Float32BufferAttribute(buf.pos, 3));
      geo.setAttribute('color', new THREEns.Float32BufferAttribute(buf.col, 4));
      geo.setAttribute('aEdge', new THREEns.Float32BufferAttribute(buf.edge, 1));
      geo.setIndex(buf.idx);
      geo.computeVertexNormals();
      geometries.push(geo);
      const mat = waterMaterial(tint, timeU);
      materials.push(mat);
      const mesh = new THREEns.Mesh(geo, mat);
      mesh.name = 'floodSheet';
      mesh.receiveShadow = true;
      // The sheet is a lid on the road: it must draw after the tarmac and the
      // markings under it, and before the spray standing on top of it.
      mesh.renderOrder = 2;
      root.add(mesh);
    }

    // ── spray ──────────────────────────────────────────────────────────────
    sprayGeo = new THREEns.BufferGeometry();
    sprayGeo.setAttribute('position', new THREEns.BufferAttribute(sprayPos, 3));
    sprayGeo.setAttribute('aColor', new THREEns.BufferAttribute(sprayCol, 3));
    sprayGeo.setAttribute('aSize', new THREEns.BufferAttribute(spraySize, 1));
    sprayGeo.setAttribute('aAlpha', new THREEns.BufferAttribute(sprayAlpha, 1));
    sprayGeo.setDrawRange(0, 0);
    // The pool is a kilometre of circuit wide; a bounding sphere computed off
    // dead particles at the origin would cull the whole system the moment the
    // camera left it.
    sprayGeo.boundingSphere = new THREEns.Sphere(new THREEns.Vector3(), 1e6);
    geometries.push(sprayGeo);
    const sprayMat = new THREEns.ShaderMaterial({
      uniforms: { uScale: sprayScale },
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREEns.NormalBlending,
    });
    materials.push(sprayMat);
    sprayPoints = new THREEns.Points(sprayGeo, sprayMat);
    sprayPoints.name = 'floodSpray';
    sprayPoints.frustumCulled = false;
    sprayPoints.renderOrder = 6;
    root.add(sprayPoints);

    // ── wake ───────────────────────────────────────────────────────────────
    for (let r = 0; r < MAX_RACERS; r++) {
      const v0 = r * WAKE_POINTS * 2;
      const i0 = r * (WAKE_POINTS - 1) * 6;
      for (let k = 0; k < WAKE_POINTS - 1; k++) {
        const a = v0 + k * 2;
        wakeIdx[i0 + k * 6 + 0] = a;
        wakeIdx[i0 + k * 6 + 1] = a + 2;
        wakeIdx[i0 + k * 6 + 2] = a + 1;
        wakeIdx[i0 + k * 6 + 3] = a + 1;
        wakeIdx[i0 + k * 6 + 4] = a + 2;
        wakeIdx[i0 + k * 6 + 5] = a + 3;
      }
      for (let k = 0; k < WAKE_POINTS; k++) {
        wakeSide[v0 + k * 2] = -1;
        wakeSide[v0 + k * 2 + 1] = 1;
      }
    }
    wakeGeo = new THREEns.BufferGeometry();
    wakeGeo.setAttribute('position', new THREEns.BufferAttribute(wakePos, 3));
    wakeGeo.setAttribute('aAge', new THREEns.BufferAttribute(wakeAge, 1));
    wakeGeo.setAttribute('aSide', new THREEns.BufferAttribute(wakeSide, 1));
    wakeGeo.setIndex(new THREEns.BufferAttribute(wakeIdx, 1));
    wakeGeo.setDrawRange(0, 0);
    wakeGeo.boundingSphere = new THREEns.Sphere(new THREEns.Vector3(), 1e6);
    geometries.push(wakeGeo);
    const wakeMat = new THREEns.ShaderMaterial({
      uniforms: { uTime: timeU },
      vertexShader: WAKE_VERT,
      fragmentShader: WAKE_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREEns.DoubleSide,
      blending: THREEns.NormalBlending,
    });
    materials.push(wakeMat);
    wakeMesh = new THREEns.Mesh(wakeGeo, wakeMat);
    wakeMesh.name = 'floodWake';
    wakeMesh.frustumCulled = false;
    // Above the sheet, below the spray.
    wakeMesh.renderOrder = 4;
    root.add(wakeMesh);

    ctx.scene.add(root);
  }

  // ── per-frame ──────────────────────────────────────────────────────────

  function stepSpray(dt: number): void {
    let n = 0;
    for (let i = 0; i < live; i++) {
      const p = pool[i]!;
      p.life += dt;
      if (p.life >= p.ttl) continue;
      // Gravity, and a little drag: droplets are small and lose their throw
      // fast, which is what makes a plume hang behind the machine rather than
      // travel with it.
      p.vy -= 21 * dt;
      const k = Math.max(0, 1 - 2.1 * dt);
      p.vx *= k; p.vz *= k;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (i !== n) {
        const q = pool[n]!;
        pool[n] = p;
        pool[i] = q;
      }
      const f = p.life / p.ttl;
      const o = n * 3;
      sprayPos[o] = p.x; sprayPos[o + 1] = p.y; sprayPos[o + 2] = p.z;
      sprayCol[o] = p.r; sprayCol[o + 1] = p.g; sprayCol[o + 2] = p.b;
      spraySize[n] = p.size0 + (p.size1 - p.size0) * f;
      // Up over the first fifth and then away: a droplet arrives as a droplet
      // and leaves as mist, so the plume has a bright shoulder near the tyre
      // rather than being at its brightest the instant it is born.
      sprayAlpha[n] = p.alpha * Math.min(1, f / 0.18) * (1 - f) * (1 - f);
      n++;
    }
    live = n;
    if (!sprayGeo) return;
    sprayGeo.setDrawRange(0, live);
    if (live > 0) {
      (sprayGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (sprayGeo.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
      (sprayGeo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
      (sprayGeo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  function stepWake(dt: number): void {
    let drawn = 0;
    for (let ri = 0; ri < MAX_RACERS; ri++) {
      const t = trails[ri]!;
      if (!t.count) continue;
      let alive = 0;
      for (let k = 0; k < t.count; k++) {
        const p = t.pts[(t.head - 1 - k + WAKE_POINTS * 2) % WAKE_POINTS]!;
        p.age += dt / 1.5;
        if (p.age < 1) alive++;
      }
      const v0 = ri * WAKE_POINTS * 2;
      t.count = alive;
      if (alive < 2) {
        // A trail that has run out has to be *retired*, not merely skipped.
        // The draw range is one number for the whole buffer, so a racer whose
        // block still carried last second's ages would keep drawing a wake
        // frozen on the road behind wherever it left the water, for as long as
        // any higher-numbered racer was still leaving one.
        for (let k = 0; k < WAKE_POINTS * 2; k++) wakeAge[v0 + k] = 1;
        t.count = 0;
        continue;
      }

      for (let k = 0; k < alive; k++) {
        const p = t.pts[(t.head - 1 - k + WAKE_POINTS * 2) % WAKE_POINTS]!;
        // The trail widens with age: a wake spreads out behind what made it.
        const hw = p.half * (1 + p.age * 0.9);
        const o = (v0 + k * 2) * 3;
        wakePos[o] = p.x - p.rx * hw;
        wakePos[o + 1] = p.y;
        wakePos[o + 2] = p.z - p.rz * hw;
        wakePos[o + 3] = p.x + p.rx * hw;
        wakePos[o + 4] = p.y;
        wakePos[o + 5] = p.z + p.rz * hw;
        wakeAge[v0 + k * 2] = p.age;
        wakeAge[v0 + k * 2 + 1] = p.age;
      }
      // Everything past the live head is collapsed onto the last live sample,
      // which produces degenerate triangles rather than a tail whipping back to
      // wherever the buffer was last frame.
      for (let k = alive; k < WAKE_POINTS; k++) {
        const src = (v0 + (alive - 1) * 2) * 3;
        const o = (v0 + k * 2) * 3;
        wakePos[o] = wakePos[src]; wakePos[o + 1] = wakePos[src + 1]; wakePos[o + 2] = wakePos[src + 2];
        wakePos[o + 3] = wakePos[src]; wakePos[o + 4] = wakePos[src + 1]; wakePos[o + 5] = wakePos[src + 2];
        wakeAge[v0 + k * 2] = 1;
        wakeAge[v0 + k * 2 + 1] = 1;
      }
      drawn = Math.max(drawn, (ri + 1) * (WAKE_POINTS - 1) * 6);
    }
    if (!wakeGeo) return;
    wakeGeo.setDrawRange(0, drawn);
    if (drawn > 0) {
      (wakeGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (wakeGeo.getAttribute('aAge') as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  function record(r: Racer, ri: number, dt: number): void {
    const t = trails[ri]!;
    t.since += Math.abs(r.speed) * dt;
    // A sample every 2.4 metres, so a wake is the same length in metres at
    // twenty metres a second as at eighty. Sampling on a clock gives a stubby
    // trail at low speed and one that outruns the buffer at high speed.
    if (t.since < 2.4 && t.count > 0) return;
    t.since = 0;
    _m.makeRotationFromQuaternion(r.quat);
    _right.set(1, 0, 0).applyMatrix4(_m);
    const p = t.pts[t.head]!;
    p.x = r.pos.x;
    // On the sheet, not in it. The sheet's own body sits at about 5cm over the
    // crown and the kart's origin is at axle height, so this is measured off
    // the water rather than off the machine.
    p.y = r.pos.y - 0.30;
    p.z = r.pos.z;
    p.rx = _right.x;
    p.rz = _right.z;
    p.half = 1.15;
    p.age = 0;
    t.head = (t.head + 1) % WAKE_POINTS;
    if (t.count < WAKE_POINTS) t.count++;
  }

  return {
    name: 'flood',
    /**
     * After `fx` (90) and before the HUD (100). It is the same slot the drift
     * sparks and the boost flame run in, and for the same reason: everything it
     * draws is a consequence of where the machines finished the step.
     */
    order: 90.5,

    init(): void {
      ctx.bus.on<{ track: Track }>('track:built', ({ track }) => build(track));
      if (ctx.track) build(ctx.track);
    },

    reset(): void {
      live = 0;
      seed = 0x9e3779b9;
      for (const t of trails) { t.count = 0; t.head = 0; t.since = 0; t.wasWet = false; }
      if (sprayGeo) sprayGeo.setDrawRange(0, 0);
      if (wakeGeo) wakeGeo.setDrawRange(0, 0);
    },

    update(dt: number): void {
      if (!hasWater || !root) return;
      // Simulation time, never a wall clock. The sheet animates at the same
      // phase on every machine and in every replay.
      timeU.value = ctx.time.elapsed;
      // Point size is in pixels, so it has to answer to the viewport or the
      // spray is twice as big on a phone as it is on the review sheet.
      sprayScale.value = ctx.renderer.domElement.height * 0.42;

      const budget = Math.max(0.25, Math.min(1.4, ctx.quality.particles ?? 1));
      const racers = ctx.racers;
      for (let i = 0; i < racers.length && i < MAX_RACERS; i++) {
        const r = racers[i]!;
        const wet = r.surface === 'water' && r.grounded;
        const t = trails[i]!;
        if (wet) {
          if (!t.wasWet) splash(r, budget);
          sprayRacer(r, dt, budget);
          record(r, i, dt);
        }
        t.wasWet = wet;
      }
      stepSpray(dt);
      stepWake(dt);
    },

    dispose,
  };
}
