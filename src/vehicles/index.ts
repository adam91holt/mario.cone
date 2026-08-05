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

interface VisualState {
  /** 0..1 how airborne the racer looks, for the contact shadow. */
  air: number;
  /** Seconds of visual time, for the stun blink. */
  t: number;
  /** Nodes flagged `userData.detail` by the model, cached at build time. */
  detail: THREE.Object3D[];
  detailOn: boolean;
}

export function createVehicleSystem(ctx: GameContext): GameSystem {
  const visuals = new Map<number, VisualState>();

  function ensureModel(racer: Racer): void {
    if (racer.model) return;
    const model = attachModel(ctx, racer);
    const detail: THREE.Object3D[] = [];
    model.root.traverse((o) => {
      if (o.userData.detail) detail.push(o);
    });
    visuals.set(racer.id, { air: 0, t: 0, detail, detailOn: true });
  }

  return {
    name: 'vehicles',
    order: 85,

    reset(): void {
      for (const racer of ctx.racers) ensureModel(racer);
    },

    update(dt: number, alpha: number): void {
      const step = Math.min(dt, 0.1);

      for (const racer of ctx.racers) {
        ensureModel(racer);
        const model = racer.model;
        if (!model) continue;

        const vis = visuals.get(racer.id);
        if (!vis) continue;
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
        if (vis.detail.length) {
          const on = _pos.distanceToSquared(ctx.camera.position) < DETAIL_DISTANCE * DETAIL_DISTANCE;
          if (!on) {
            for (const d of vis.detail) d.visible = false;
            vis.detailOn = false;
          } else if (!vis.detailOn) {
            for (const d of vis.detail) d.visible = true;
            vis.detailOn = true;
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
        const blob = root.getObjectByName('shadowBlob');
        if (blob) {
          vis.air = damp(vis.air, racer.grounded ? 0 : 1, racer.grounded ? 0.0005 : 0.02, step);
          const lift = clamp01(racer.airTime * 0.7 + vis.air * 0.2);
          _inv.copy(_quat).invert();
          _level.identity().slerp(_inv, vis.air);
          blob.quaternion.copy(_level).multiply(_flat);
          blob.position.y = 0.02 - lift * 0.02;
          blob.scale.setScalar(lerp(1, 1.4, lift));
          const m = (blob as THREE.Mesh).material as THREE.MeshBasicMaterial;
          m.opacity = 0.85 * (1 - lift * 0.85);
        }

        visuals.set(racer.id, vis);
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
