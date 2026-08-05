// Vehicle visuals: keeps each racer's model in sync with its simulated state.
//
// This is a pure `update` system. It reads simulation output and writes only to
// scene nodes — nothing here may feed back into the simulation.

import * as THREE from 'three';
import { clamp01, lerp } from '../core/math.ts';
import { attachModel, getVehicle } from './registry.ts';
import type { GameContext, GameSystem, Racer } from '../types.ts';

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();

export function createVehicleSystem(ctx: GameContext): GameSystem {
  // Squash-and-stretch state per racer, keyed by id.
  const squash = new Map<number, { amount: number; vel: number }>();

  ctx.bus.on<{ racer: Racer; impact: number }>('kart:land', ({ racer, impact }) => {
    const s = squash.get(racer.id);
    if (s) s.vel -= impact * ctx.config.kart.air.landingSquash * 22;
  });
  ctx.bus.on<{ racer: Racer }>('kart:boost', ({ racer }) => {
    const s = squash.get(racer.id);
    if (s) s.vel += 3.2; // a quick stretch on the launch
  });

  function ensureModel(racer: Racer): void {
    if (racer.model) return;
    attachModel(ctx, racer);
    squash.set(racer.id, { amount: 0, vel: 0 });
  }

  return {
    name: 'vehicles',
    order: 85,

    reset(): void {
      for (const racer of ctx.racers) ensureModel(racer);
    },

    update(dt: number, alpha: number): void {
      for (const racer of ctx.racers) {
        ensureModel(racer);
        const model = racer.model;
        if (!model) continue;

        // Interpolate between the last two fixed states, or the 120Hz simulation
        // visibly stair-steps at 60fps.
        _pos.lerpVectors(racer.prevPos, racer.pos, alpha);
        _quat.copy(racer.prevQuat).slerp(racer.quat, alpha);

        const root = model.root;
        root.position.copy(_pos);
        root.quaternion.copy(_quat);

        // Hop lifts the whole model rather than the simulated body, so the kart
        // keeps its ground contact for physics while looking airborne.
        const d = racer.drift;
        if (d.hopTime > 0) {
          const t = 1 - d.hopTime / ctx.config.kart.drift.hopTime;
          root.position.y += Math.sin(t * Math.PI) * ctx.config.kart.drift.hopHeight * 0.5;
        }

        // Spring the squash back to neutral; landings and boosts kick it.
        const s = squash.get(racer.id);
        if (s) {
          s.vel += (0 - s.amount) * 130 * dt - s.vel * 13 * dt;
          s.amount += s.vel * dt;
          const sq = Math.max(-0.45, Math.min(0.45, s.amount));
          root.scale.set(1 - sq * 0.5, 1 + sq, 1 - sq * 0.5);
        }

        model.update?.(racer, dt, alpha);

        // Blink the model while spun out, and while briefly invulnerable after.
        if (racer.stunned > 0 || racer.invulnerable > 0) {
          const flash = Math.sin(ctx.time.elapsed * 40) > 0;
          root.visible = racer.stunned > 0 ? true : flash;
        } else {
          root.visible = true;
        }

        // Keep the blob shadow flat on the ground under a tilting kart.
        const blob = root.getObjectByName('shadowBlob');
        if (blob) {
          const lift = Math.max(0, _pos.y - 0.4);
          blob.position.y = -0.5 - lift * 0.02;
          const fade = clamp01(1 - lift * 0.12);
          const m = (blob as THREE.Mesh).material as THREE.MeshBasicMaterial;
          m.opacity = 0.9 * fade;
          const grow = lerp(1, 1.35, clamp01(lift * 0.1));
          blob.scale.setScalar(grow);
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
      squash.clear();
    },
  };
}

export { getVehicle, attachModel };
