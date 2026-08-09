// Bootstrap: builds the context, registers every system, and owns race setup.
//
// System registration order in this file does not matter — the engine sorts by
// each system's `order`. What does matter is that everything gets the same `ctx`.

import * as THREE from 'three';
import { config } from './core/config.ts';
import { createBus } from './core/bus.ts';
import { createInput } from './core/input.ts';
import { createEngine } from './core/engine.ts';
import { installHarness } from './core/harness.ts';
import { makeRng } from './core/math.ts';
import { createTrackSystem } from './track/index.ts';
import { createKartPhysics, createRacer } from './physics/kart.ts';
import { createAiSystem, createAiDriver } from './ai/driver.ts';
import { createItemSystem } from './items/index.ts';
import { createRaceDirector } from './race/director.ts';
import { createCameraSystem } from './render/camera.ts';
import { createLightingSystem } from './render/lighting.ts';
import { createVehicleSystem } from './vehicles/index.ts';
import { createWorldSystem } from './world/index.ts';
import { createFxSystem } from './fx/index.ts';
import { createAudioSystem } from './audio/index.ts';
import { getVehicle, listVehicles } from './vehicles/registry.ts';
import { createHudSystem } from './ui/hud.ts';
import { createMenuSystem } from './ui/menus/index.ts';
import type {
  GameContext, QualitySettings, RaceConfig, VehicleId,
} from './types.ts';

const CPU_NAMES = [
  'Bollard', 'Barrier', 'Hi-Vis', 'Gravel', 'Detour',
  'Tarmac', 'Skip', 'Sandbag', 'Beacon', 'Chevron', 'Grader',
];

function makeQuality(tier: QualitySettings['tier']): QualitySettings {
  const q = config.quality[tier];
  return { tier, ...q };
}

function createContext(): GameContext {
  const bus = createBus();
  const input = createInput();
  const inputState = input.state;

  // `scene`/`camera`/`renderer` are assigned by createEngine immediately after.
  return {
    THREE,
    scene: null as unknown as THREE.Scene,
    camera: null as unknown as THREE.PerspectiveCamera,
    renderer: null as unknown as THREE.WebGLRenderer,
    composer: null,
    bus,
    rng: makeRng(1),
    config,
    quality: makeQuality('high'),
    input,
    inputState,
    time: { elapsed: 0, dt: 0, alpha: 1, frame: 0, scale: 1 },
    track: null,
    racers: [],
    player: null,
    race: {
      phase: 'loading',
      time: 0,
      totalLaps: config.race.laps,
      engineClass: '150cc',
      standings: [],
      countdown: 3,
      finishedCount: 0,
    },
    audio: null,
    fx: null,
  };
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('#game canvas not found');

  const ctx = createContext();
  const engine = createEngine(ctx, canvas);

  const track = createTrackSystem(ctx);
  engine.add(track);
  engine.add(createWorldSystem(ctx));
  engine.add(createLightingSystem(ctx));
  engine.add(createAiSystem(ctx));
  engine.add(createKartPhysics(ctx));
  engine.add(createItemSystem(ctx));
  engine.add(createRaceDirector(ctx));
  engine.add(createCameraSystem(ctx));
  engine.add(createVehicleSystem(ctx));
  engine.add(createFxSystem(ctx));
  engine.add(createAudioSystem(ctx));
  engine.add(createHudSystem(ctx));
  engine.add(createMenuSystem(ctx));

  /** Tear down the previous field and build a fresh one. */
  function buildField(cfg: RaceConfig): void {
    for (const r of ctx.racers) {
      if (r.model) {
        ctx.scene.remove(r.model.root);
        r.model.dispose?.();
      }
    }
    ctx.racers.length = 0;

    const rng = makeRng(cfg.seed ?? 1);
    ctx.rng = rng;

    const all = listVehicles();
    const cpuPool = all.filter((v) => v.id !== cfg.vehicleId);
    const classSkill = config.race.classes[cfg.engineClass].aiSkill;

    for (let i = 0; i < cfg.racerCount; i++) {
      const isPlayer = i === 0;
      const def = isPlayer ? getVehicle(cfg.vehicleId) : cpuPool[(i - 1) % cpuPool.length]!;
      const name = isPlayer ? 'You' : CPU_NAMES[(i - 1) % CPU_NAMES.length]!;
      const racer = createRacer(i, name, def.id, { ...def.stats }, isPlayer);

      if (!isPlayer) {
        // Spread skill across the field so the pack strings out naturally.
        const skill = Math.min(1, classSkill * rng.range(0.86, 1.06));
        racer.ai = createAiDriver(ctx, skill, rng.gauss() * config.ai.lineNoise);
      }
      ctx.racers.push(racer);
      if (isPlayer) ctx.player = racer;
    }
  }

  /** Place the field on the start grid, facing down the track. */
  function placeOnGrid(): void {
    const t = ctx.track;
    if (!t) return;
    const total = ctx.racers.length;
    for (let i = 0; i < total; i++) {
      const racer = ctx.racers[i]!;
      const slot = t.gridSlot(i, total);
      racer.pos.copy(slot.pos);
      racer.prevPos.copy(slot.pos);
      racer.vel.set(0, 0, 0);
      racer.speed = 0;
      racer.yaw = Math.atan2(slot.forward.x, slot.forward.z);
      racer.drift = { active: false, dir: 0, charge: 0, tier: 0, angle: 0, hopTime: 0 };
      racer.boost = { time: 0, power: 0, source: null };
      racer.coins = 0;
      racer.item = null;
      racer.itemCount = 0;
      racer.stunned = 0;
      racer.invulnerable = 0;
      racer.rubberBand = 1;
      racer.effects.clear();
      racer.grounded = true;
      racer.airTime = 0;
      racer.surface = 'road';

      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), racer.yaw);
      racer.quat.copy(q);
      racer.prevQuat.copy(q);
    }
  }

  let current: RaceConfig = {
    courseId: 'cone-canyon',
    vehicleId: 'cone',
    engineClass: '150cc',
    racerCount: config.race.racerCount,
    seed: 1,
  };

  async function startRace(opts: Partial<RaceConfig> = {}): Promise<void> {
    current = { ...current, ...opts };
    ctx.time.elapsed = 0;
    ctx.time.frame = 0;
    ctx.time.scale = 1;

    track.build(current.courseId);
    buildField(current);
    placeOnGrid();
    // buildField makes a fresh player racer, so a held autopilot must reattach.
    if (autopilot) setAutopilot(true);
    engine.resetAll(current);
    // A first render primes shaders so the opening frames do not hitch.
    engine.renderFrame(1 / 60, 1);
  }

  function setQuality(tier: QualitySettings['tier']): void {
    ctx.quality = makeQuality(tier);
    engine.renderer.shadowMap.enabled = ctx.quality.shadows;
    engine.renderer.shadowMap.needsUpdate = true;
    ctx.bus.emit('quality:changed', { quality: ctx.quality });
  }

  let autopilot = false;
  function setAutopilot(on: boolean): void {
    autopilot = on;
    const p = ctx.player;
    if (!p) return;
    p.ai = on ? createAiDriver(ctx, 0.95, 0) : null;
    if (!on) delete p.aiInput;
  }

  const harness = installHarness(ctx, engine, { startRace, setQuality, setAutopilot });

  await engine.initAll();
  await startRace();

  engine.start();
  harness.ready = true;

  // Expose a little for hand debugging in the console.
  (window as unknown as { __CTX?: GameContext }).__CTX = ctx;

  document.getElementById('boot')?.remove();
}

boot().catch((err) => {
  console.error('[boot] failed', err);
  const el = document.getElementById('boot');
  if (el) el.textContent = `Failed to start: ${String(err)}`;
});

export type { VehicleId };
