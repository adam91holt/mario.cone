// Contact shadows.
//
// The single thing that decides whether a kart is *on* the road or *pasted onto*
// it. A sun shadow cannot do this job on its own: it swings with the time of
// day, it hides under the chassis whenever the sun is high, and at the exact
// moment a player needs to judge a landing it may be somewhere off to the left.
// So contact is drawn separately, always, directly beneath every racer,
// independent of where the sun happens to be.
//
// The position taken here:
//
//   * It multiplies. The patch does not paint a grey shape over the ground, it
//     *removes light* from it — the tarmac keeps its markings, the sand keeps
//     its mottle, and both go dark underneath the machine standing on them.
//   * It is blue-violet, not grey. Ground in shadow is lit by the sky and
//     nothing else, and the sky is blue. A neutral shadow is the tell of a
//     renderer that has not thought about it.
//   * It has a hard core. A single soft gradient reads as an airbrushed sticker;
//     what reads as contact is a dense middle with a short penumbra around it —
//     about a hand's width, which is roughly the size of the gap between a tyre
//     and the road.
//   * It lifts. As a racer leaves the ground the patch widens, softens and
//     fades, so height is legible from the blob alone even with the horizon out
//     of frame.
//
// One draw call for the whole field: a single indexed buffer holding one quad
// per racer, rebuilt on the CPU each frame. Twelve quads is nothing; a mesh per
// racer would be twelve transparent draw calls and twelve sort entries for no
// gain at all.

import * as THREE from 'three';
import { clamp01 } from '../core/math.ts';
import { surfaceHeight } from '../track/geom.ts';
import { getVehicle } from '../vehicles/registry.ts';
import type { GameContext, Racer, SplineSample } from '../types.ts';

/** Hard ceiling on the field size. Twelve is more than the game ever starts. */
const MAX_PATCHES = 16;

/** Metres of blur on the edge of the core when a racer is on the ground. */
const PENUMBRA = 0.15;

/**
 * Metres of soft skirt around the footprint.
 *
 * The dense part of the patch is the machine's own footprint plus a hand's
 * width; the skirt is the ambient occlusion that fades out beyond it. Crucially
 * this is an *absolute* distance, not a multiple of the vehicle: a wide plane
 * and a narrow cone both sit about the same height off the road, so the ground
 * around them darkens over about the same distance. Scaling it with the model
 * gives the plane a swimming pool and the cone a coaster.
 */
const SKIRT = 0.85;

/** How far past the footprint the dense core runs, metres. */
const CORE_MARGIN = 0.10;

/**
 * Linear multiplier applied to the ground at full density. Deliberately deep —
 * the previous pass sat around 25% and read as a smudge. This lands the tarmac
 * under a kart at roughly 40% of its lit value once the grade has had its say,
 * and pushes the hue toward violet on the way down.
 */
const TINT = [0.300, 0.272, 0.455] as const;

/** Height, in metres, at which a racer's blob has fully "let go" of the ground. */
const AIR_RANGE = 2.6;

/**
 * Ride height: how far a racer's simulation position floats above the surface
 * it is standing on, measured along the surface normal.
 *
 * This mirrors `RIDE_HEIGHT` in physics/kart.ts. It is the one number here that
 * is not derived, and if physics ever changes its suspension this has to follow
 * or every shadow in the game climbs off the road.
 */
const RIDE_HEIGHT = 0.55;

const VERT = /* glsl */ `
attribute vec2 aLocal;
attribute vec3 aParam;   // x opacity, y penumbra, z core radius — all unit space
varying vec2 vLocal;
varying vec3 vParam;
void main() {
  vLocal = aLocal;
  vParam = aParam;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uTint;
varying vec2 vLocal;
varying vec3 vParam;

void main() {
  // The quad is scaled to the vehicle's footprint plus its skirt, so the patch
  // is a unit disc in local space and comes out elliptical in the world for
  // free.
  float d = length(vLocal);
  float pen = vParam.y;
  float rc = vParam.z;

  // Two terms, and the split is the whole point. The core is nearly hard — a
  // dense ellipse reaching just past the wheels, with about 15cm of blur on its
  // edge — and the halo is the wider, softer occlusion around it that stops the
  // core reading as a decal. Together they saturate under the machine and still
  // leave real density out at the silhouette, which is the part a player can
  // actually see from the chase camera.
  float core = 1.0 - smoothstep(rc - pen, rc + pen, d);
  float halo = 1.0 - smoothstep(rc * 0.55, 1.02, d);
  float a = clamp(core * 0.58 + halo * 0.60, 0.0, 1.0) * vParam.x;
  if (a < 0.003) discard;

  // Multiply blending: what we write is what the ground gets scaled by.
  gl_FragColor = vec4(mix(vec3(1.0), uTint, a), 1.0);
}`;

export interface ContactShadows {
  readonly mesh: THREE.Mesh;
  /** Rebuild the patches for this frame. `alpha` is the render interpolant. */
  update(alpha: number): void;
  /** Re-read quality settings — the tint depends on whether postfx is on. */
  applyQuality(): void;
  dispose(): void;
}

/**
 * @param ctx the game context; racers and the track are read every frame.
 */
export function createContactShadows(ctx: GameContext): ContactShadows {
  const positions = new Float32Array(MAX_PATCHES * 4 * 3);
  const locals = new Float32Array(MAX_PATCHES * 4 * 2);
  const params = new Float32Array(MAX_PATCHES * 4 * 3);
  const index = new Uint16Array(MAX_PATCHES * 6);

  for (let i = 0; i < MAX_PATCHES; i++) {
    const v = i * 4;
    locals.set([-1, -1, 1, -1, 1, 1, -1, 1], i * 8);
    index.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
  }

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const parAttr = new THREE.BufferAttribute(params, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  parAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('aLocal', new THREE.BufferAttribute(locals, 2));
  geo.setAttribute('aParam', parAttr);
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    uniforms: { uTint: { value: new THREE.Color(TINT[0], TINT[1], TINT[2]) } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.MultiplyBlending,
    // Three's multiply path is written for premultiplied sources and refuses to
    // set the blend function without this. We write an opaque alpha and a
    // colour that *is* the multiplier, which is exactly what that path wants.
    premultipliedAlpha: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'contactShadows';
  mesh.frustumCulled = false;
  // First thing in the transparent pass: the ground is already down, and every
  // spark, puff and trail the fx system draws belongs on top of the shadow.
  mesh.renderOrder = -50;
  mesh.matrixAutoUpdate = false;
  mesh.userData.noShadow = true;

  // ── scratch ──────────────────────────────────────────────────────────────
  const _pos = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _ground = new THREE.Vector3();
  const _scratch = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  // Our own sample buffer: `track.sample()` reuses the spline's internal one,
  // and the camera queries it in the same frame.
  const _sample: SplineSample = {
    pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
    right: new THREE.Vector3(), up: new THREE.Vector3(),
    width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
  };

  /** Per-racer memory of the last surface we were actually standing on. */
  interface Anchor { y: number; up: THREE.Vector3; seen: boolean }
  const anchors = new Map<number, Anchor>();

  function anchorFor(id: number): Anchor {
    let a = anchors.get(id);
    if (!a) {
      a = { y: 0, up: new THREE.Vector3(0, 1, 0), seen: false };
      anchors.set(id, a);
    }
    return a;
  }

  /**
   * Where the ground is under this racer, and which way it faces.
   *
   * While a racer is grounded, physics has already answered both: it holds the
   * kart exactly one ride height above the surface, along that surface's normal,
   * so the contact point is a subtraction and it is right over tarmac, shoulder
   * and open desert alike. In the air we have to go and find the surface, which
   * the track can answer wherever the racer is over the road; past the shoulder
   * the terrain is somebody else's height field and the last surface we actually
   * touched is the better guess than anything the spline could tell us.
   */
  function resolveGround(racer: Racer, out: THREE.Vector3, up: THREE.Vector3): void {
    const a = anchorFor(racer.id);
    const track = ctx.track;
    const s = track ? track.sample(_pos, _sample) : null;
    const lateral = s ? s.lateral ?? 0 : 0;
    const verge = track?.course.vergeWidth ?? 5;
    const onTrack = !!s && Math.abs(lateral) <= s.width * 0.5 + verge;

    // Surface normal. On and around the tarmac it is the spline's, banking
    // included; out in the desert the spline is describing a corner forty
    // metres away and world up is closer to the truth.
    if (!s) up.copy(WORLD_UP);
    else if (onTrack) up.copy(s.up);
    else up.copy(s.up).lerp(WORLD_UP, 0.8).normalize();

    if (racer.grounded) {
      // Physics holds a racer exactly one ride height off the surface, along
      // that surface's normal — so the contact point is a subtraction, and it
      // works over tarmac, verge and open desert alike.
      out.copy(_pos).addScaledVector(up, -RIDE_HEIGHT);
      a.y = out.y;
      a.up.copy(up);
      a.seen = true;
      return;
    }

    // Airborne. Over the track we can ask where the road is; past the shoulder
    // the terrain is somebody else's height field and the last surface we
    // actually touched is the better answer.
    if (onTrack && s) {
      const h = surfaceHeight(lateral, s.width, verge);
      _scratch.copy(s.pos).addScaledVector(s.right, lateral).addScaledVector(s.up, h);
      out.set(_pos.x, _scratch.y, _pos.z);
      if (!a.seen) { a.y = _scratch.y; a.up.copy(up); a.seen = true; }
      return;
    }
    out.set(_pos.x, a.seen ? a.y : _pos.y - RIDE_HEIGHT, _pos.z);
    up.copy(a.up);
  }

  /** Half-footprints, resolved once per vehicle id. */
  const extents = new Map<string, [number, number]>();
  function extentFor(racer: Racer): [number, number] {
    let e = extents.get(racer.vehicleId);
    if (!e) {
      const size = getVehicle(racer.vehicleId).size;
      e = [Math.max(0.5, size.width * 0.5), Math.max(0.5, size.length * 0.5)];
      extents.set(racer.vehicleId, e);
    }
    return e;
  }

  /**
   * The cast blobs the vehicle rig ships with are a different (and, right now,
   * broken) answer to the same question. Only one of us should be drawing here.
   */
  function hideLegacyBlobs(racer: Racer): void {
    const visual = racer.visual;
    if (!visual || visual.userData.mcBlobsHidden) return;
    visual.userData.mcBlobsHidden = true;
    visual.traverse((o) => {
      if (o.name === 'shadowBlob') o.visible = false;
    });
  }

  let count = 0;

  function update(alpha: number): void {
    const racers = ctx.racers;
    count = 0;

    for (let i = 0; i < racers.length && count < MAX_PATCHES; i++) {
      const racer = racers[i]!;
      if (!racer.visual || !racer.visual.visible) continue;
      hideLegacyBlobs(racer);

      // Same interpolation the vehicle rigs use, so the patch never lags the
      // machine standing on it by a frame.
      _pos.lerpVectors(racer.prevPos, racer.pos, alpha);
      resolveGround(racer, _ground, _up);

      // Height above where this racer would sit at rest — not above the ground,
      // which it never is: physics floats every kart a ride height up.
      const height = racer.grounded
        ? 0
        : Math.max(0, _pos.y - _ground.y - RIDE_HEIGHT);
      const air = clamp01(Math.max(height / AIR_RANGE, racer.airTime / 0.9));

      // Footprint plus skirt. Leaving the ground widens the skirt rather than
      // scaling the whole patch, which is what an area light actually does: the
      // dark middle shrinks away and the soft edge spreads.
      const [fw, fl] = extentFor(racer);
      const skirt = SKIRT + air * 1.7;
      const hw = fw + skirt;
      const hl = fl + skirt;

      // Heading, flattened onto the surface. The wheels follow the racer's
      // travel yaw rather than the drifting chassis, and so does their shadow.
      _fwd.set(Math.sin(racer.yaw), 0, Math.cos(racer.yaw));
      _fwd.addScaledVector(_up, -_fwd.dot(_up));
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1); else _fwd.normalize();
      _right.crossVectors(_up, _fwd).normalize();

      // Clear of the road by a couple of centimetres: enough that no amount of
      // depth precision at 400m puts the tarmac in front of its own shadow,
      // little enough that the offset is invisible from the chase camera.
      const lift = 0.035;
      const cx = _ground.x + _up.x * lift;
      const cy = _ground.y + _up.y * lift;
      const cz = _ground.z + _up.z * lift;

      const o = count * 12;
      for (let c = 0; c < 4; c++) {
        const sx = c === 0 || c === 3 ? -1 : 1;
        const sz = c < 2 ? -1 : 1;
        positions[o + c * 3] = cx + _right.x * sx * hw + _fwd.x * sz * hl;
        positions[o + c * 3 + 1] = cy + _right.y * sx * hw + _fwd.y * sz * hl;
        positions[o + c * 3 + 2] = cz + _right.z * sx * hw + _fwd.z * sz * hl;
      }

      const opacity = 1 / (1 + air * 2.6);
      const mean = (hw + hl) * 0.5;
      const pen = clamp01((PENUMBRA + air * 0.9) / mean);
      // Core radius in unit space, averaged across the two axes — the ellipse
      // is a circle in local space, so it only gets one.
      const rc = clamp01(
        ((fw + CORE_MARGIN) / hw + (fl + CORE_MARGIN) / hl) * 0.5 * (1 - air * 0.45),
      );
      for (let c = 0; c < 4; c++) {
        params[o + c * 3] = opacity;
        params[o + c * 3 + 1] = pen;
        params[o + c * 3 + 2] = rc;
      }
      count++;
    }

    posAttr.needsUpdate = true;
    parAttr.needsUpdate = true;
    geo.setDrawRange(0, count * 6);
  }

  function applyQuality(): void {
    // With post-processing on, this multiply lands on scene-referred linear
    // radiance. With it off the frame has already been tone-mapped and encoded,
    // so the same visual result needs the transfer function's own exponent
    // applied to the multiplier — otherwise turning effects off doubles the
    // depth of every shadow in the game.
    const c = material.uniforms.uTint!.value as THREE.Color;
    if (ctx.quality.postfx) c.setRGB(TINT[0], TINT[1], TINT[2]);
    else c.setRGB(TINT[0] ** (1 / 2.2), TINT[1] ** (1 / 2.2), TINT[2] ** (1 / 2.2));
  }
  applyQuality();

  return {
    mesh,
    update,
    applyQuality,
    dispose(): void {
      geo.dispose();
      material.dispose();
      anchors.clear();
      extents.clear();
    },
  };
}
