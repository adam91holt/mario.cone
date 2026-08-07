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
// The boxes themselves are one InstancedMesh each for shell, core and contact
// shadow — three draw calls for the whole circuit's worth.

import * as THREE from 'three';
import { ease } from '../core/math.ts';
import { makeShadowBlob } from '../vehicles/parts.ts';
import { features } from '../track/courses/types.ts';
import {
  boxCoreGeometry, boxShellGeometry, makeBoxMaterials, type BoxMaterials,
} from './models.ts';
import type { GameContext, Track } from '../types.ts';

/** Metres the box floats above the tarmac, at the centre of its bob. */
const FLOAT = 1.35;
const SIZE = 1.5;
/** Seconds a taken box stays gone. Long enough to matter in a pack, short
 *  enough that the racer behind you is not simply denied. */
const RESPAWN = 4.0;
/** Pickup radius. Generous — missing a box you drove through is maddening. */
const PICK_RADIUS = 2.35;

export interface ItemBox {
  pos: THREE.Vector3;
  /** Where the road surface is under it, for the contact shadow. */
  groundY: number;
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
  rebuild(track: Track): void;
  /** Box indices whose centre is within `PICK_RADIUS` of this lap distance. */
  candidates(distance: number): readonly number[];
  take(index: number): void;
  fixedUpdate(dt: number): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

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
  let blobGeo: THREE.BufferGeometry | null = null;
  let blobMat: THREE.MeshBasicMaterial | null = null;
  let shell: THREE.InstancedMesh | null = null;
  let core: THREE.InstancedMesh | null = null;
  let shadow: THREE.InstancedMesh | null = null;
  let bins: number[][] = [];
  let binCount = 0;
  let trackLength = 1;

  function clearMeshes(): void {
    // The instanced meshes are rebuilt per course; the geometry and materials
    // behind them are not, so only the wrappers are thrown away here.
    for (const m of [shell, core, shadow]) {
      if (!m) continue;
      group.remove(m);
      m.dispose();
    }
    shell = core = shadow = null;
  }

  function ensureAssets(): void {
    if (!materials) materials = makeBoxMaterials();
    if (!shellGeo) shellGeo = boxShellGeometry(SIZE);
    if (!coreGeo) coreGeo = boxCoreGeometry(SIZE);
    if (!blobGeo) {
      const blob = makeShadowBlob(2.0, 2.0);
      blobGeo = blob.geometry;
      blobGeo.rotateX(-Math.PI / 2);
      blobMat = blob.material as THREE.MeshBasicMaterial;
      blobMat.opacity = 0.42;
    }
  }

  function buildMeshes(): void {
    clearMeshes();
    const n = boxes.length;
    if (!n) return;
    ensureAssets();

    shell = new THREE.InstancedMesh(shellGeo!, materials!.shell, n);
    core = new THREE.InstancedMesh(coreGeo!, materials!.core, n);
    shadow = new THREE.InstancedMesh(blobGeo!, blobMat!, n);

    for (const m of [shell, core, shadow]) {
      // One mesh spans the whole circuit, so a bounding-sphere cull can only
      // ever be wrong. Skip it rather than pay for it.
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      group.add(m);
    }
    shadow.renderOrder = -1;
    shell.renderOrder = 2;
    core.renderOrder = 3;
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
    // corner those are most of a metre apart vertically.
    const ground = new THREE.Vector3().copy(s.pos).addScaledVector(s.right, lateral);
    const pos = ground.clone().addScaledVector(s.up, FLOAT);
    boxes.push({
      pos,
      groundY: ground.y,
      distance: ((distance % trackLength) + trackLength) % trackLength,
      respawn: 0,
      pop: 1,
      // A deterministic phase from the position: a row must not pulse in step,
      // and this needs no rng draw to say so.
      phase: (Math.abs(pos.x * 0.37 + pos.z * 0.71) % 1) * Math.PI * 2,
    });
  }

  function rebuild(track: Track): void {
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
      // Span the road, holding 2.2m off each edge so the outermost box is
      // still takeable without brushing the barrier.
      const reach = Math.max(3, half - 2.2);
      for (let k = -2; k <= 2; k++) addBox(d, (k / 2) * reach);
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
      if (!shell || !core || !shadow) return;
      materials?.tick(time);

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

        _p.set(b.pos.x, b.groundY + 0.03, b.pos.z);
        _q.identity();
        _s.set(scale * (1 - bob * 0.4), 1, scale * (1 - bob * 0.4));
        _m.compose(_p, _q, _s);
        shadow.setMatrixAt(i, _m);
      }
      shell.instanceMatrix.needsUpdate = true;
      core.instanceMatrix.needsUpdate = true;
      shadow.instanceMatrix.needsUpdate = true;
    },

    dispose(): void {
      clearMeshes();
      materials?.dispose();
      shellGeo?.dispose();
      coreGeo?.dispose();
      blobGeo?.dispose();
      blobMat?.dispose();
      materials = null;
      shellGeo = coreGeo = blobGeo = null;
      blobMat = null;
      ctx.scene.remove(group);
      boxes.length = 0;
    },
  };
}

/** Squared pickup radius, shared with the system that runs the test. */
export const PICK_RADIUS_SQ = PICK_RADIUS * PICK_RADIUS;
