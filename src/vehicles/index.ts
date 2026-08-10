// Vehicle visuals: keeps each racer's model in sync with its simulated state.
//
// This is a pure `update` system. It reads simulation output and writes only to
// scene nodes — nothing here may feed back into the simulation.
//
// What lives here versus in the model:
//
//   Here — anything true of *every* racer: interpolating the fixed-step
//   transform, standing the model on the ground, the drift hop, the contact
//   shadow, and the blink while spun out.
//
//   In the model (see rig.ts) — anything about how a particular machine
//   *behaves*: suspension, lean, dive, the arm, the rotor, the face. Those are
//   derived from racer state inside the model itself, so a model can be built
//   and driven in isolation by the capture tooling with no system running.

import * as THREE from 'three';
import { clamp01, damp, lerp } from '../core/math.ts';
import { attachModel, getVehicle } from './registry.ts';
import type { GameContext, GameSystem, Racer } from '../types.ts';

/**
 * Physics keeps `racer.pos` a fixed distance above the surface (RIDE_HEIGHT in
 * physics/kart.ts) rather than at the contact patch. Models are built with
 * their tyres at y = 0, as the VehicleModel contract asks, so the visual is
 * dropped by that much along the kart's own up axis — along it, not straight
 * down, so the wheels stay planted through banked corners too.
 *
 * If physics ever changes its ride height, this constant has to follow. It is
 * the one number in this module that is not derived.
 */
const CONTACT_DROP = 0.55;

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _level = new THREE.Quaternion();
const _inv = new THREE.Quaternion();

/**
 * Beyond this, an eye is about four pixels across and a rotating beacon is
 * one. Detail groups — faces, beacons, exhaust glows, spin discs, puffs —
 * switch off past it, which costs a full grid of eight nothing visible and
 * saves a hundred draw calls in the shots where the whole field is on screen.
 */
const DETAIL_DISTANCE = 52;

// ── the part ladder ────────────────────────────────────────────────────────
//
// Measured, not guessed. An ablation of a settled racing frame on Cone Canyon
// put the whole game at 413 draw calls, of which **295 were the eight machines**
// — 71% of the frame's submissions for 62k of its 688k triangles. A racer is
// twenty-two to forty-one meshes across seventeen to twenty-six materials, and
// none of that can merge further without merging the paint; so the only honest
// lever left is *not submitting the parts nobody can resolve*.
//
// Both thresholds below are in **screen pixels of radius**, resolved against the
// live lens and viewport rather than against a distance in metres, because the
// same machine at the same distance is four times the pixels on the overhead
// camera as it is at a 50° chase and the answer has to follow the frame.
//
/** A part smaller than this across is not detail, it is cost. */
const PART_MIN_PX = 2.6;
/**
 * ...and a part smaller than this casts a shadow nobody will find.
 *
 * Deliberately far coarser: the shadow pass was 154 of those 413 calls, and a
 * wing mirror's own shadow contributes nothing to the dark shape under a kart
 * that the body has not already drawn. The two largest meshes of every machine
 * are exempt (see `SHADOW_KEEP`) so no racer can ever lose its shadow outright.
 */
const SHADOW_MIN_PX = 9;
/** Largest meshes that keep casting whatever the ladder says. */
const SHADOW_KEEP = 2;
/**
 * Fraction a threshold has to be beaten by before a part switches back on.
 *
 * Without it a machine held at exactly the cut distance — which is where a
 * rival you are racing sits, by definition — flickers its own greebles on and
 * off every frame.
 */
const LOD_HYSTERESIS = 0.82;

/** One switchable part, with the model-space radius that decides its fate. */
interface LodPart {
  node: THREE.Mesh;
  /** Bounding radius in metres, model space. */
  radius: number;
  /** The mesh's own build-time answer, so the ladder can restore it exactly. */
  casts: boolean;
}

interface VisualState {
  /** 0..1 how airborne the racer looks, for the contact shadow. */
  air: number;
  /** Seconds of visual time, for the stun blink. */
  t: number;
  /** Nodes flagged `userData.detail` by the model, cached at build time. */
  detail: THREE.Object3D[];
  detailOn: boolean;
  /**
   * Everything the ladder may switch, **ascending by radius**, so a frame's
   * decision is a pointer into a sorted array rather than a walk of the tree.
   * Nodes under a `detail` group are deliberately absent: that gate owns them,
   * and two owners of one `visible` flag is a flicker.
   */
  parts: LodPart[];
  /** Parts [0, hidden) are switched off; [0, unshadowed) cast nothing. */
  hidden: number;
  unshadowed: number;
  /** The contact blob, found once instead of by name every frame. */
  blob: THREE.Mesh | null;
}

/** First part big enough to survive `want`. The list is sorted, so this is it. */
function firstAtLeast(parts: LodPart[], want: number): number {
  let i = 0;
  while (i < parts.length && parts[i]!.radius < want) i++;
  return i;
}

/**
 * Where a ladder's pointer wants to be, with the dead band applied.
 *
 * Moving *up* (dropping parts) happens the moment the threshold is crossed.
 * Moving back down waits until the part clears it by `LOD_HYSTERESIS`, so a
 * rival held at exactly the cut distance — which, being a rival, is where it
 * spends the race — settles instead of strobing.
 */
function ladderTarget(parts: LodPart[], at: number, want: number): number {
  const grow = firstAtLeast(parts, want);
  if (grow > at) return grow;
  const shrink = firstAtLeast(parts, want * LOD_HYSTERESIS);
  return shrink < at ? shrink : at;
}

/** Parts below the pointer are switched off; above it, on. */
function moveVisible(parts: LodPart[], at: number, target: number): number {
  while (at < target) { parts[at]!.node.visible = false; at++; }
  while (at > target) { at--; parts[at]!.node.visible = true; }
  return at;
}

/** ...and the same walk for the shadow pass, restoring each mesh's own answer. */
function moveShadow(parts: LodPart[], at: number, target: number): number {
  while (at < target) { parts[at]!.node.castShadow = false; at++; }
  while (at > target) { at--; parts[at]!.node.castShadow = parts[at]!.casts; }
  return at;
}

export function createVehicleSystem(ctx: GameContext): GameSystem {
  const visuals = new Map<number, VisualState>();

  function makeVisualState(model: { root: THREE.Object3D }): VisualState {
    const detail: THREE.Object3D[] = [];
    const parts: LodPart[] = [];
    let blob: THREE.Mesh | null = null;

    // One walk builds all three lists. `underDetail` is carried down rather
    // than tested by climbing back up, so a node buried three groups deep
    // inside a beacon housing is still recognised as the detail gate's.
    const walk = (o: THREE.Object3D, underDetail: boolean): void => {
      const isDetail = underDetail || !!o.userData.detail;
      if (o.userData.detail) detail.push(o);
      if (o.name === 'shadowBlob') {
        blob = o as THREE.Mesh;
        return; // the contact pass owns it; the ladder must not touch it
      }
      const mesh = o as THREE.Mesh;
      // Anything already switched off at build time belongs to somebody else —
      // a puff waiting for a rate, a mouth waiting to be yelled with — and the
      // ladder must not be the thing that turns it on.
      if (!isDetail && mesh.isMesh && mesh.geometry && mesh.visible) {
        if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
        const r = mesh.geometry.boundingSphere?.radius ?? 0;
        // The build-time shadow answer is recorded on the node, not just in the
        // list. The list is rebuilt on every `reset()`, and if it read the flag
        // back off a mesh the previous race's ladder had switched off, that
        // mesh would lose its shadow permanently. Models are rebuilt per race
        // today so it cannot happen — but "cannot happen today" is exactly the
        // shape of the bug the next change to the reset path introduces.
        if (r > 0) {
          const born = mesh.userData.mcCasts as boolean | undefined;
          const casts = born ?? mesh.castShadow;
          mesh.userData.mcCasts = casts;
          parts.push({ node: mesh, radius: r, casts });
        }
      }
      for (let i = 0; i < o.children.length; i++) walk(o.children[i]!, isDetail);
    };
    walk(model.root, false);
    parts.sort((a, b) => a.radius - b.radius);

    return {
      air: 0, t: 0, detail, detailOn: true,
      parts, hidden: 0, unshadowed: 0, blob,
    };
  }

  /**
   * Guarantees both halves of a racer's visual state: the model, and the
   * bookkeeping keyed off its id.
   *
   * These have to be repaired independently. A racer can arrive here already
   * holding a model — carried across a reset, or attached by tooling that
   * builds a model in isolation — with no entry in `visuals`, and previously
   * that combination made the update loop skip the racer entirely, so its
   * model sat wherever it was last placed while the simulation drove on
   * without it.
   */
  function ensureModel(racer: Racer): VisualState {
    if (!racer.model) {
      const model = attachModel(ctx, racer);
      const state = makeVisualState(model);
      visuals.set(racer.id, state);
      return state;
    }
    let state = visuals.get(racer.id);
    if (!state) {
      state = makeVisualState(racer.model);
      visuals.set(racer.id, state);
    }
    return state;
  }

  return {
    name: 'vehicles',
    order: 85,

    reset(): void {
      // Racer ids are reused across races, so any bookkeeping left over from the
      // previous field would otherwise be inherited by a different racer.
      visuals.clear();
      for (const racer of ctx.racers) ensureModel(racer);
    },

    update(dt: number, alpha: number): void {
      const step = Math.min(dt, 0.1);

      // Pixels of screen height per metre at one metre. Divide by a distance
      // and you have the projected size of anything out there, which is the
      // only unit in which "too small to resolve" means anything: the same
      // machine at the same distance is four times the pixels through the
      // overhead lens as it is through the 50° chase.
      //
      // Read off the live camera and the live drawing buffer every frame —
      // both move (the lens opens with speed and kicks on every boost), and a
      // ladder keyed to a stale lens pops parts back in during the exact
      // second the player is looking hardest.
      const canvas = ctx.renderer.domElement;
      const h = canvas.height || canvas.clientHeight || 720;
      const pxPerMetre =
        (h * 0.5) / Math.tan((ctx.camera.fov * Math.PI) / 360);
      // A tier that has already given up its shadow map has nothing to gain
      // from walking the shadow ladder, and everything to lose from writing
      // `castShadow` on two hundred nodes for no reason.
      const shadows = ctx.quality.shadows;

      for (const racer of ctx.racers) {
        const vis = ensureModel(racer);
        const model = racer.model;
        if (!model) continue;

        vis.t += step;

        // Interpolate between the last two fixed states, or the 120Hz
        // simulation visibly stair-steps at 60fps.
        _pos.lerpVectors(racer.prevPos, racer.pos, alpha);
        _quat.copy(racer.prevQuat).slerp(racer.quat, alpha);

        const root = model.root;
        root.quaternion.copy(_quat);

        // Stand it on the road. `up` comes from the kart's own orientation, so
        // on a banked corner the drop follows the banking.
        _up.set(0, 1, 0).applyQuaternion(_quat);
        root.position.copy(_pos).addScaledVector(_up, -CONTACT_DROP);

        // Hop lifts the whole model rather than the simulated body, so the kart
        // keeps its ground contact for physics while looking airborne.
        const d = racer.drift;
        if (d.hopTime > 0) {
          const t = 1 - d.hopTime / ctx.config.kart.drift.hopTime;
          root.position.addScaledVector(
            _up, Math.sin(t * Math.PI) * ctx.config.kart.drift.hopHeight * 0.6);
        }

        model.update?.(racer, step, alpha);

        // Detail LOD. Out of range it is held off every frame, because the
        // model's own update also drives some of these (a prop disc fades in
        // with rpm, an exhaust glow with boost) and would switch them back on.
        // Coming back into range it is restored once, and the model owns it
        // again from there.
        const d2 = _pos.distanceToSquared(ctx.camera.position);
        if (vis.detail.length) {
          const on = d2 < DETAIL_DISTANCE * DETAIL_DISTANCE;
          if (!on) {
            for (const d of vis.detail) d.visible = false;
            vis.detailOn = false;
          } else if (!vis.detailOn) {
            for (const d of vis.detail) d.visible = true;
            vis.detailOn = true;
          }
        }

        // ── the part ladder ──────────────────────────────────────────────
        //
        // After the model's own update and after the detail gate, so this has
        // the last word on `visible` and the two owners never disagree. The
        // thresholds are radii in metres: a part is dropped once its projected
        // radius falls under a couple of pixels, and stops casting a shadow a
        // good deal earlier than that.
        const parts = vis.parts;
        if (parts.length && d2 > 1e-6) {
          // Metres of model-space radius per screen pixel at this distance.
          const perPx = Math.sqrt(d2) / pxPerMetre;
          vis.hidden = moveVisible(parts, vis.hidden,
            ladderTarget(parts, vis.hidden, PART_MIN_PX * perPx));
          if (shadows) {
            // Capped so the two biggest meshes always cast: a machine may lose
            // its greebles' shadows, never its own.
            const keep = parts.length > SHADOW_KEEP ? parts.length - SHADOW_KEEP : 0;
            const want = ladderTarget(parts, vis.unshadowed, SHADOW_MIN_PX * perPx);
            vis.unshadowed = moveShadow(parts, vis.unshadowed, want < keep ? want : keep);
          }
        }

        // Blink the model while spun out, and while briefly invulnerable after.
        if (racer.stunned > 0 || racer.invulnerable > 0) {
          root.visible = racer.stunned > 0 ? true : Math.sin(vis.t * 42) > 0;
        } else {
          root.visible = true;
        }

        // Contact shadow. It stays flat on the road while the kart is planted
        // and levels off to horizontal once it leaves it, then shrinks away —
        // a blob that follows a kart into the air is the fastest way to make a
        // jump look weightless.
        // Found once at build time. `getObjectByName` is a full traverse of the
        // rig, and doing it per racer per frame was walking two hundred nodes a
        // frame to reach one that never moves.
        const blob = vis.blob;
        if (blob) {
          vis.air = damp(vis.air, racer.grounded ? 0 : 1, racer.grounded ? 0.0005 : 0.02, step);
          const lift = clamp01(racer.airTime * 0.7 + vis.air * 0.2);
          _inv.copy(_quat).invert();
          _level.identity().slerp(_inv, vis.air);
          blob.quaternion.copy(_level).multiply(_flat);
          blob.position.y = 0.02 - lift * 0.02;
          blob.scale.setScalar(lerp(1, 1.4, lift));
          const m = blob.material as THREE.MeshBasicMaterial;
          m.opacity = 0.85 * (1 - lift * 0.85);
        }
      }
    },

    dispose(): void {
      for (const racer of ctx.racers) {
        if (racer.model) {
          ctx.scene.remove(racer.model.root);
          racer.model.dispose?.();
          racer.model = null;
          racer.visual = null;
        }
      }
      visuals.clear();
    },
  };
}

export { getVehicle, attachModel };
