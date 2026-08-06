// Renderer, system registry, and the fixed-timestep loop.
//
// The loop is deliberately split so the harness can drive the simulation with no
// realtime clock at all — see `stepFixed` / `renderFrame`. That is what makes
// automated screenshots reproducible even on a software renderer.

import * as THREE from 'three';
import { FIXED_DT, MAX_STEPS_PER_FRAME } from './config.ts';
import type { GameContext, GameSystem, RaceConfig, RenderStats } from '../types.ts';

export interface Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly systems: GameSystem[];
  readonly running: boolean;
  add<T extends GameSystem>(system: T): T;
  get<T extends GameSystem = GameSystem>(name: string): T | undefined;
  resize(): void;
  stepFixed(dt?: number): void;
  renderFrame(frameDt?: number, alpha?: number): void;
  start(): void;
  stop(): void;
  stats(): RenderStats;
  initAll(): Promise<void>;
  resetAll(cfg: RaceConfig): void;
  dispose(): void;
}

export function createEngine(ctx: GameContext, canvas: HTMLCanvasElement): Engine {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: ctx.quality.aa,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = ctx.config.render.exposure;
  renderer.shadowMap.enabled = ctx.quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    ctx.config.camera.fov, 16 / 9, ctx.config.camera.near, ctx.config.camera.far);

  ctx.THREE = THREE;
  ctx.renderer = renderer;
  ctx.scene = scene;
  ctx.camera = camera;

  const systems: GameSystem[] = [];
  let running = false;
  let rafId = 0;
  let accumulator = 0;
  let lastWall = 0;

  // Rolling frame-time stats. Cheap, and the critics read them.
  const frameTimes = new Float32Array(60);
  let frameIdx = 0;
  let frameCount = 0;

  function resize(): void {
    const w = canvas.clientWidth || canvas.width || 1280;
    const h = canvas.clientHeight || canvas.height || 720;
    if (canvas.width === w && canvas.height === h && camera.aspect === w / h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    ctx.composer?.setSize(w, h);
    ctx.bus.emit('engine:resize', { width: w, height: h });
  }

  /** One deterministic simulation step. No rendering, no wall clock. */
  function stepFixed(dt: number = FIXED_DT): void {
    ctx.time.dt = dt;
    ctx.inputState = ctx.input.sample(dt);
    for (let i = 0; i < systems.length; i++) systems[i]!.fixedUpdate?.(dt);
    ctx.time.elapsed += dt;
    ctx.time.frame++;
  }

  /**
   * Visual update plus draw. `alpha` blends between the last two fixed states.
   *
   * It is clamped here because every consumer treats it as a blend factor and
   * feeds it straight to `lerp`. Anything outside 0..1 stops being a blend and
   * becomes an extrapolation: a measured alpha of -438 put each kart two
   * hundred metres behind itself, so the karts vanished from their own chase
   * cameras while the simulation drove on perfectly correctly. Clamping at the
   * single point that hands the number out is the only way to know that every
   * consumer got a real blend.
   */
  function renderFrame(frameDt: number = FIXED_DT, alpha = 1): void {
    const blend = alpha > 1 ? 1 : alpha > 0 ? alpha : 0; // NaN lands on 0
    ctx.time.alpha = blend;
    for (let i = 0; i < systems.length; i++) systems[i]!.update?.(frameDt, blend);
    renderer.info.reset();
    // A post-processing stack, if one is installed, owns the final draw.
    if (ctx.composer && ctx.quality.postfx) ctx.composer.render(frameDt);
    else renderer.render(scene, camera);
  }

  function tick(now: number): void {
    if (!running) return;
    rafId = requestAnimationFrame(tick);

    // Clamp: a backgrounded tab produces a huge delta that would teleport karts.
    const wallDt = Math.min((now - lastWall) / 1000 || 0, 0.25);
    lastWall = now;

    resize();
    accumulator += wallDt * ctx.time.scale;

    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      stepFixed(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0; // give up on the backlog
    // The harness drives `stepFixed` directly, outside this loop, so the
    // accumulator can be left describing time this loop never owned. Reset it
    // rather than let it leak into the frame blend.
    if (accumulator < 0) accumulator = 0;

    renderFrame(wallDt, accumulator / FIXED_DT);

    frameTimes[frameIdx] = wallDt * 1000;
    frameIdx = (frameIdx + 1) % frameTimes.length;
    frameCount++;
  }

  return {
    renderer, scene, camera, systems,
    get running() { return running; },

    add<T extends GameSystem>(system: T): T {
      systems.push(system);
      systems.sort((a, b) => a.order - b.order);
      return system;
    },

    get<T extends GameSystem = GameSystem>(name: string): T | undefined {
      return systems.find((s) => s.name === name) as T | undefined;
    },

    resize, stepFixed, renderFrame,

    start(): void {
      if (running) return;
      running = true;
      lastWall = performance.now();
      accumulator = 0;
      rafId = requestAnimationFrame(tick);
    },

    stop(): void {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    },

    stats(): RenderStats {
      const n = Math.min(frameCount, frameTimes.length);
      let sum = 0, worst = 0;
      for (let i = 0; i < n; i++) {
        const t = frameTimes[i]!;
        sum += t;
        if (t > worst) worst = t;
      }
      const ms = n ? sum / n : 0;
      const info = renderer.info;
      return {
        fps: ms > 0 ? Math.round(1000 / ms) : 0,
        ms: +ms.toFixed(2),
        worstMs: +worst.toFixed(2),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs?.length ?? 0,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      };
    },

    async initAll(): Promise<void> {
      for (const s of systems) await s.init?.();
    },

    resetAll(cfg: RaceConfig): void {
      for (const s of systems) s.reset?.(cfg);
    },

    dispose(): void {
      this.stop();
      for (const s of systems) s.dispose?.();
      systems.length = 0;
      renderer.dispose();
    },
  };
}
