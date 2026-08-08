// Item boxes: where they go, when they come back, and how they read.
//
// Placement is *measured off the circuit* rather than hand-authored, so a
// re-cut layout re-places its own boxes. Two kinds of placement, and the
// difference between them is the whole design:
//
//   Rows. Five boxes spanning the road at the straightest points of the lap.
//   The racing line runs through one of them, so a leader defending their line
//   pays nothing to take an item — which is correct, because what they draw
//   from it is a banana.
//
//   Detours. Singles out on the gravel of the shortcut and hard on the outside
//   of the two tightest corners. Those cost real time to reach, and the payment
//   is that everyone behind you is drawing from the same table you are.
//
// The boxes themselves are one InstancedMesh each for glass, inner lamp, the
// `?` plate, the halo and the contact shadow — five draw calls for the whole
// circuit's worth, whatever the layout turns out to be.

import * as THREE from 'three';
import { clamp, ease } from '../core/math.ts';
import { features } from '../track/courses/types.ts';
import { roadCrown, shadowOffset } from './entities.ts';
import type { RacingLine } from '../track/racingline.ts';
import {
  boxCoreGeometry, boxGlyphGeometry, boxHaloGeometry, boxHaloMaterial, boxHue,
  boxShellGeometry, contactShadowGeometry, contactShadowMaterial, makeBoxMaterials,
  type BoxMaterials,
} from './models.ts';
import type { GameContext, Track } from '../types.ts';

/** Metres the box floats above the tarmac, at the centre of its bob. */
const FLOAT = 1.45;
/** Edge length. Sized against a ~2m kart: a box you have to aim at is a box
 *  you will miss, and a box you cannot see from the previous corner is a box
 *  nobody plans a lap around. */
const SIZE = 1.85;
/** Seconds a taken box stays gone. Long enough to matter in a pack, short
 *  enough that the racer behind you is not simply denied. */
const RESPAWN = 4.0;
/** Pickup radius. Generous — missing a box you drove through is maddening. */
const PICK_RADIUS = 2.5;
/** Metres the halo billboard is raised above the box, so its lower falloff
 *  never reaches the road. */
const HALO_LIFT = 0.45;
/** Metres the contact shadow floats above the tarmac. Small — the polygon
 *  offset on its material is what actually keeps it out of the road. */
const SHADOW_LIFT = 0.03;
/** Boxes in a row across the road. Five is the Mario Kart number and it is the
 *  right one: a road that fits four or five karts abreast needs a box for each
 *  of them, or taking one becomes a fight instead of a decision. */
const ROW = 5;

export interface ItemBox {
  pos: THREE.Vector3;
  /** Where the road surface is under it, for the contact shadow. */
  groundY: number;
  /** The same point as a vector, and the rotation that lays a flat disc *in
   *  the road's own plane* there. A contact shadow composed against the world
   *  horizontal cuts into a crowned, banked road and photographs as a sliver of
   *  itself — which is how five boxes ended up apparently casting nothing. */
  ground: THREE.Vector3;
  groundQuat: THREE.Quaternion;
  /** The road's own up at that point, for projecting the sun offset into the
   *  surface rather than through it. */
  groundQuat_up: THREE.Vector3;
  /** Absolute spline distance, for the pickup broadphase. */
  distance: number;
  /** Seconds until it comes back; 0 means it is there now. */
  respawn: number;
  /** 0..1 scale-in on respawn, and the bob/spin phase so a row is not in step. */
  pop: number;
  phase: number;
}

export interface BoxField {
  readonly boxes: ItemBox[];
  rebuild(track: Track, line: RacingLine): void;
  /** Box indices whose centre is within `PICK_RADIUS` of this lap distance. */
  candidates(distance: number): readonly number[];
  take(index: number): void;
  fixedUpdate(dt: number): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _face = new THREE.Quaternion();
const _billboard = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3();
const _off = new THREE.Vector3();
const UP_AXIS = new THREE.Vector3(0, 1, 0);

/** Bin width for the pickup broadphase, metres. */
const BIN = 12;

export function createBoxField(ctx: GameContext): BoxField {
  const boxes: ItemBox[] = [];
  const group = new THREE.Group();
  group.name = 'itemBoxes';
  ctx.scene.add(group);

  let materials: BoxMaterials | null = null;
  let shellGeo: THREE.BufferGeometry | null = null;
  let coreGeo: THREE.BufferGeometry | null = null;
  let haloGeo: THREE.BufferGeometry | null = null;
  let haloMat: THREE.MeshBasicMaterial | null = null;
  let glyphGeo: THREE.BufferGeometry | null = null;
  let blobGeo: THREE.BufferGeometry | null = null;
  let blobMat: THREE.MeshBasicMaterial | null = null;
  let ghostMat: THREE.MeshBasicMaterial | null = null;
  let shell: THREE.InstancedMesh | null = null;
  let core: THREE.InstancedMesh | null = null;
  let glyph: THREE.InstancedMesh | null = null;
  let halo: THREE.InstancedMesh | null = null;
  let shadow: THREE.InstancedMesh | null = null;
  let ghost: THREE.InstancedMesh | null = null;
  let bins: number[][] = [];
  let binCount = 0;
  let trackLength = 1;

  function clearMeshes(): void {
    // The instanced meshes are rebuilt per course; the geometry and materials
    // behind them are not, so only the wrappers are thrown away here.
    for (const m of [shell, core, glyph, halo, shadow, ghost]) {
      if (!m) continue;
      group.remove(m);
      m.dispose();
    }
    shell = core = glyph = halo = shadow = ghost = null;
  }

  function ensureAssets(): void {
    if (!materials) materials = makeBoxMaterials();
    if (!shellGeo) shellGeo = boxShellGeometry(SIZE);
    if (!coreGeo) coreGeo = boxCoreGeometry(SIZE);
    if (!glyphGeo) glyphGeo = boxGlyphGeometry(SIZE * 0.80);
    // Wider than the cube, and that is the point: at eighty metres the glass is
    // four pixels and the glow is the only part still on screen.
    if (!haloGeo) haloGeo = boxHaloGeometry(SIZE * 1.15);
    if (!haloMat) haloMat = boxHaloMaterial();
    if (!blobGeo) {
      // Sized to the box, not to its glow: a blob half again as wide as the
      // thing casting it reads as a stain rather than as contact. Every kart on
      // this circuit lays a crisp shadow, and a floating box laying none is the
      // fastest way to make it look pasted on — ARCHITECTURE §12, contact is
      // everything.
      blobGeo = contactShadowGeometry(SIZE * 0.62, 0.26);
      blobMat = contactShadowMaterial();
    }
    if (!ghostMat) {
      // The empty socket a taken box leaves behind.
      //
      // Without it a row that the pack has been through is a row with holes in
      // it, and a hole says nothing: a player cannot tell a box that was taken
      // two seconds ago from a row that was only ever three wide, so they
      // cannot decide whether to wait, and the four-second respawn — which is a
      // real tactical clock — is invisible. Mario Kart leaves a translucent
      // husk standing for exactly this reason. Deliberately colourless and
      // unlit: it must never be mistaken for the thing itself.
      ghostMat = new THREE.MeshBasicMaterial({
        color: 0x8FA0BC, transparent: true, opacity: 0.16,
        depthWrite: false, toneMapped: false, side: THREE.BackSide,
      });
    }
  }

  function buildMeshes(): void {
    clearMeshes();
    const n = boxes.length;
    if (!n) return;
    ensureAssets();

    shell = new THREE.InstancedMesh(shellGeo!, materials!.shell, n);
    core = new THREE.InstancedMesh(coreGeo!, materials!.core, n);
    glyph = new THREE.InstancedMesh(glyphGeo!, materials!.glyph, n);
    halo = new THREE.InstancedMesh(haloGeo!, haloMat!, n);
    shadow = new THREE.InstancedMesh(blobGeo!, blobMat!, n);
    ghost = new THREE.InstancedMesh(shellGeo!, ghostMat!, n);

    for (const m of [shell, core, glyph, halo, shadow, ghost]) {
      // One mesh spans the whole circuit, so a bounding-sphere cull can only
      // ever be wrong. Skip it rather than pay for it.
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      group.add(m);
    }
    shadow.renderOrder = -1;
    ghost.renderOrder = 0;
    // The halo sits *behind* the box it belongs to, so the glass and the glyph
    // are never washed out by their own glow.
    halo.renderOrder = 1;
    shell.renderOrder = 2;
    core.renderOrder = 3;
    // ...and the glyph sits in front of everything, including the near face of
    // its own cube. The shell writes no depth, so without an explicit order the
    // `?` would be occluded by the glass it is supposed to be seen through.
    glyph.renderOrder = 4;
  }

  /** Mean |curvature| over a window — how straight the road is around here. */
  function flatness(distance: number, half: number): number {
    const spline = ctx.track!.spline;
    let sum = 0;
    for (let i = -3; i <= 3; i++) {
      sum += Math.abs(spline.atDistance(distance + (i / 3) * half).curvature);
    }
    return sum / 7;
  }

  function addBox(distance: number, lateral: number): void {
    const spline = ctx.track!.spline;
    const s = spline.atDistance(distance);
    // The shadow belongs under the box, not under the centreline — on a banked
    // corner those are most of a metre apart vertically — and it belongs on the
    // *tarmac*, which stands proud of the spline's own surface by up to 16cm.
    // See `roadCrown`: a shadow laid on the spline is a shadow inside the road.
    const ground = new THREE.Vector3().copy(s.pos)
      .addScaledVector(s.right, lateral)
      .addScaledVector(s.up, roadCrown(lateral, s.width, ctx.track?.course.vergeWidth ?? 5));
    const pos = ground.clone().addScaledVector(s.up, FLOAT);
    const groundQuat = new THREE.Quaternion().setFromUnitVectors(
      UP_AXIS, _up.copy(s.up).normalize());
    boxes.push({
      pos,
      groundY: ground.y,
      ground: ground.clone().addScaledVector(s.up, SHADOW_LIFT),
      groundQuat,
      groundQuat_up: s.up.clone().normalize(),
      distance: ((distance % trackLength) + trackLength) % trackLength,
      respawn: 0,
      pop: 1,
      // A deterministic phase from the position: a row must not pulse in step,
      // and this needs no rng draw to say so.
      phase: (Math.abs(pos.x * 0.37 + pos.z * 0.71) % 1) * Math.PI * 2,
    });
  }

  function rebuild(track: Track, line: RacingLine): void {
    boxes.length = 0;
    trackLength = track.length;
    const L = track.length;
    const spline = track.spline;
    const start = track.course.startDistance ?? 0;
    const verge = track.course.vergeWidth ?? 5;

    // ── rows on the straights ────────────────────────────────────────────
    const STEP = 8;
    const n = Math.max(8, Math.floor(L / STEP));
    const scored: Array<{ d: number; score: number }> = [];
    for (let i = 0; i < n; i++) {
      const d = (i / n) * L;
      // Skip the grid: eight karts three abreast do not need a wall of boxes
      // in front of them before the lights have gone out.
      const fromStart = ((d - start) % L + L) % L;
      if (fromStart < 70 || fromStart > L - 45) continue;
      scored.push({ d, score: flatness(d, 45) });
    }
    scored.sort((a, b) => a.score - b.score);

    const chosen: number[] = [];
    const minGap = L / 6;
    for (const cand of scored) {
      if (chosen.length >= 4) break;
      let ok = true;
      for (const c of chosen) {
        const gap = Math.abs(spline.signedDistance(c, cand.d));
        if (gap < minGap) { ok = false; break; }
      }
      if (ok) chosen.push(cand.d);
    }
    chosen.sort((a, b) => a - b);

    for (const d of chosen) {
      const s = spline.atDistance(d);
      const half = s.width * 0.5;
      // Span the road, holding clear of each edge so the outermost box is
      // still takeable without brushing the barrier.
      const lim = Math.max(3, half - 2.6);
      // Five boxes distributed *cyclically* across the road, so the row can be
      // slid sideways onto the racing line without any of them falling off the
      // end. The obvious version — five fixed slots at lim/2 spacing, drop
      // anything that ends up outside — silently produced rows of four all the
      // way round the circuit, because a row that already spans exactly -lim to
      // +lim loses a box to any shift at all.
      const span = lim * 2;
      const step = span / ROW;
      // ...and slide the whole row sideways so that one of the five sits
      // exactly on the racing line. That is the entire design of these rows: a
      // leader defending their line pays *nothing* to take an item, which is
      // correct, because what the table gives them for it is a banana. A row
      // pinned to the centreline instead makes every driver leave the line to
      // take a box, and the item economy stops being about position at all.
      const onLine = clamp(line.lateralAt(d), -lim, lim);
      // Slide the whole row so that one box sits exactly on the racing line.
      const slot = Math.round((onLine + lim) / step - 0.5);
      const shift = onLine + lim - (slot + 0.5) * step;
      for (let k = 0; k < ROW; k++) {
        // Wrapped into [-lim, lim]: a box pushed off the right-hand end of the
        // road comes back on at the left, and the row stays five wide and
        // evenly spaced whatever the line is doing here.
        let u = (k + 0.5) * step + shift;
        u -= Math.floor(u / span) * span;
        addBox(d, u - lim);
      }
    }

    // ── detours ──────────────────────────────────────────────────────────
    const feat = features(track.course);
    for (const sc of feat.shortcuts ?? []) {
      const from = start + sc.from * L;
      const to = start + sc.to * L;
      for (let k = 1; k <= 2; k++) {
        const d = from + ((to - from) * k) / 3;
        const s = spline.atDistance(d);
        addBox(d, sc.side * (s.width * 0.5 + verge * 0.5));
      }
    }

    // The two tightest corners get a box hard on the outside: taking it means
    // giving up the apex, and everyone can see you do it.
    const corners: Array<{ d: number; k: number }> = [];
    for (let i = 0; i < n; i++) {
      const d = (i / n) * L;
      corners.push({ d, k: spline.atDistance(d).curvature });
    }
    corners.sort((a, b) => Math.abs(b.k) - Math.abs(a.k));
    const picked: number[] = [];
    for (const c of corners) {
      if (picked.length >= 2) break;
      let ok = true;
      for (const p of picked) if (Math.abs(spline.signedDistance(p, c.d)) < L / 5) { ok = false; break; }
      for (const p of chosen) if (Math.abs(spline.signedDistance(p, c.d)) < 60) { ok = false; break; }
      if (!ok) continue;
      picked.push(c.d);
      const s = spline.atDistance(c.d);
      addBox(c.d, Math.sign(c.k) * (s.width * 0.5 - 1.6));
    }

    // ── broadphase bins ──────────────────────────────────────────────────
    binCount = Math.max(1, Math.ceil(L / BIN));
    bins = new Array(binCount);
    for (let i = 0; i < binCount; i++) bins[i] = [];
    for (let i = 0; i < boxes.length; i++) {
      const b = Math.floor(boxes[i]!.distance / BIN) % binCount;
      bins[b]!.push(i);
    }

    buildMeshes();
  }

  const _empty: number[] = [];
  const _found: number[] = [];

  return {
    boxes,

    rebuild,

    candidates(distance: number): readonly number[] {
      if (!binCount) return _empty;
      const d = ((distance % trackLength) + trackLength) % trackLength;
      const b = Math.floor(d / BIN) % binCount;
      _found.length = 0;
      for (let k = -1; k <= 1; k++) {
        const list = bins[(b + k + binCount) % binCount]!;
        for (let i = 0; i < list.length; i++) _found.push(list[i]!);
      }
      return _found;
    },

    take(index: number): void {
      const box = boxes[index];
      if (!box) return;
      box.respawn = RESPAWN;
      box.pop = 0;
    },

    fixedUpdate(dt: number): void {
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]!;
        if (b.respawn > 0) {
          b.respawn = Math.max(0, b.respawn - dt);
        } else if (b.pop < 1) {
          b.pop = Math.min(1, b.pop + dt * 3.6);
        }
      }
    },

    update(dt: number, time: number): void {
      if (!shell || !core || !glyph || !halo || !shadow || !ghost) return;
      materials?.tick(time);
      // The glyph plates are square to the lens, all of them, so one quaternion
      // serves the whole circuit. Full camera-facing rather than yaw-only: this
      // plate lives *inside* a cube and never touches the road, so it has none
      // of the reasons the halo below has to stay upright, and an overhead or
      // minimap camera has to be able to read it too.
      _billboard.copy(ctx.camera.quaternion);
      // The halo billboards about the *vertical only*, and that one word is the
      // whole fix. A full camera-facing billboard is edge-on to the road when
      // the camera is above it — which is exactly what an overhead or minimap
      // shot is — so a soft additive disc three metres across lay flat on the
      // tarmac under every box and *lightened* the road beneath it. A floating
      // object with a bright pool under it instead of a shadow reads as a
      // spotlight, not as contact. Yawing to the camera keeps the glow standing
      // up behind the cube from every angle a player can reach.
      const camX = ctx.camera.position.x;
      const camZ = ctx.camera.position.z;

      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]!;
        const gone = b.respawn > 0;
        // Snap out, ease back in with a little overshoot — the box has to look
        // like it was *taken*, not like it was switched off.
        const scale = gone ? 0 : ease.outBack(b.pop);
        const bob = Math.sin(time * 1.7 + b.phase) * 0.13;

        _p.copy(b.pos);
        _p.y += bob;
        _e.set(time * 0.55 + b.phase, time * 0.95 + b.phase * 0.5, time * 0.22);
        _q.setFromEuler(_e);
        _s.setScalar(scale);
        _m.compose(_p, _q, _s);
        shell.setMatrixAt(i, _m);

        // The core counter-rotates and pulses, so even a still frame of a box
        // has something happening inside it.
        _e.set(-time * 1.4 + b.phase, time * 1.9, 0);
        _q.setFromEuler(_e);
        _s.setScalar(scale * (0.85 + Math.sin(time * 4 + b.phase) * 0.15));
        _m.compose(_p, _q, _s);
        core.setMatrixAt(i, _m);

        // The `?`. It nods rather than sitting rigid — a plate pinned square to
        // the lens with no motion of its own reads as a decal stuck on the
        // screen instead of an object floating inside the glass.
        _s.setScalar(scale * (0.94 + Math.sin(time * 3.1 + b.phase) * 0.07));
        _m.compose(_p, _billboard, _s);
        glyph.setMatrixAt(i, _m);

        // The halo breathes on its own beat — slower than the core, so the two
        // never lock into a single throb.
        _e.set(0, Math.atan2(camX - b.pos.x, camZ - b.pos.z), 0);
        _face.setFromEuler(_e);
        _s.setScalar(scale * (0.92 + Math.sin(time * 2.3 + b.phase * 1.7) * 0.12));
        // Lifted clear of the road. A glow centred on a box floating a metre
        // and a half up reaches the tarmac underneath it and lights exactly the
        // patch the contact shadow lives on — which is how a box ends up with a
        // bright pool under it instead of a shadow.
        _p.y += HALO_LIFT;
        _m.compose(_p, _face, _s);
        halo.setMatrixAt(i, _m);
        halo.setColorAt(i, boxHue(time, _c));
        _p.y -= HALO_LIFT;

        // The contact shadow, laid **in the road's plane** rather than in the
        // world's. On a crowned, banked circuit those differ by more than the
        // disc's own clearance, so a world-horizontal blob spends most of its
        // area inside the tarmac and only a crescent survives the depth test.
        // It also breathes with the bob: the box rises, the shadow spreads and
        // lightens, which is the cue that says "this thing is floating" rather
        // than "this thing is stuck to a decal".
        const lift = 1 + bob * 0.6;
        _s.set(scale * lift, 1, scale * lift);
        // Thrown along the sun, the same way the karts' shadows are. A blob
        // pooled directly under a floating object is the one arrangement that
        // contradicts every other shadow in the frame — and from overhead the
        // box sits on top of it, so the object appears to cast nothing at all.
        _p.copy(b.ground).add(shadowOffset(FLOAT + bob, b.groundQuat_up, _off));
        _m.compose(_p, b.groundQuat, _s);
        shadow.setMatrixAt(i, _m);

        // ...and the husk, which is the exact complement of the box: present
        // only while the box is not. It shrinks as the respawn clock runs down,
        // so the socket visibly *refills* rather than blinking back.
        if (gone) {
          const k = clamp(b.respawn / RESPAWN, 0, 1);
          _e.set(time * 0.3 + b.phase, time * 0.4 + b.phase * 0.5, 0);
          _q.setFromEuler(_e);
          _s.setScalar(0.62 + 0.3 * k);
          _p.copy(b.pos);
          _p.y += bob * 0.4;
          _m.compose(_p, _q, _s);
        } else {
          _s.setScalar(0);
          _m.compose(b.pos, _q, _s);
        }
        ghost.setMatrixAt(i, _m);
      }
      shell.instanceMatrix.needsUpdate = true;
      core.instanceMatrix.needsUpdate = true;
      glyph.instanceMatrix.needsUpdate = true;
      halo.instanceMatrix.needsUpdate = true;
      if (halo.instanceColor) halo.instanceColor.needsUpdate = true;
      shadow.instanceMatrix.needsUpdate = true;
      ghost.instanceMatrix.needsUpdate = true;
    },

    dispose(): void {
      clearMeshes();
      materials?.dispose();
      shellGeo?.dispose();
      coreGeo?.dispose();
      glyphGeo?.dispose();
      haloGeo?.dispose();
      haloMat?.dispose();
      blobGeo?.dispose();
      blobMat?.dispose();
      ghostMat?.dispose();
      materials = null;
      shellGeo = coreGeo = glyphGeo = haloGeo = blobGeo = null;
      haloMat = blobMat = ghostMat = null;
      ctx.scene.remove(group);
      boxes.length = 0;
    },
  };
}

/** Squared pickup radius, shared with the system that runs the test. */
export const PICK_RADIUS_SQ = PICK_RADIUS * PICK_RADIUS;
