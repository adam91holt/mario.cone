// Renderer, system registry, and the fixed-timestep loop.
//
// The loop is deliberately split so the harness can drive the simulation with no
// realtime clock at all — see `stepFixed` / `renderFrame`. That is what makes
// automated screenshots reproducible even on a software renderer.

import * as THREE from 'three';
import { FIXED_DT, MAX_STEPS_PER_FRAME } from './config.ts';
import type {
  FrameBudget, GameContext, GameSystem, RaceConfig, RenderStats, SystemCost,
} from '../types.ts';

/** Frames of history the budget averages over. One second at 60fps. */
const BUDGET_WINDOW = 60;

/**
 * Wall clock for the budget.
 *
 * `performance.now()` is called once per system boundary rather than twice —
 * one reading closes the previous system and opens the next — so the whole
 * profile costs one timer read per system per step (~1800/s), which is under
 * 0.01% of a frame and buys an honest per-system breakdown instead of a guess.
 */
const now = (): number =>
  (typeof performance !== 'undefined' ? performance.now() : Date.now());

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
  let wallPrimed = false;

  // ── the frame budget ─────────────────────────────────────────────────────
  //
  // Three costs, kept apart on purpose. A frame that misses 16.7ms because the
  // simulation spiked and a frame that misses it because the draw did are
  // different bugs with different fixes, and the number that used to be
  // reported here — one wall-clock delta — could not tell them apart. Worse, it
  // could not be read at all under the capture harness, which drives `step()`
  // and `render()` by hand and never enters the rAF loop: `frameTimes` stayed
  // full of the single bogus sample the first rAF callback wrote (that
  // callback's timestamp predates `start()`'s own `performance.now()`, so the
  // first delta is *negative*), and `stats()` answered `fps: 0, ms: -2039`.
  //
  // So: sim, update and draw are each measured where they happen, and the
  // budget is their sum. That number means the same thing whether the browser
  // or the harness is driving, which is what makes it a budget rather than a
  // frame rate.
  const budget: FrameBudget = {
    simMs: 0, updateMs: 0, drawMs: 0,
    meanMs: 0, worstMs: 0, meanSimMs: 0, meanDrawMs: 0,
    wallMs: 0, steps: 0, frames: 0, liveFrames: 0, benchFrames: 0,
  };
  /** True only inside the rAF loop's own call to `renderFrame`. */
  let driving = false;
  const simTimes = new Float32Array(BUDGET_WINDOW);
  const updTimes = new Float32Array(BUDGET_WINDOW);
  const drawTimes = new Float32Array(BUDGET_WINDOW);
  const wallTimes = new Float32Array(BUDGET_WINDOW);
  let frameIdx = 0;
  let frameCount = 0;
  let wallCount = 0;
  /** ms of fixedUpdate banked since the last rendered frame. */
  let simBank = 0;
  let stepBank = 0;
  /** Per-system totals for the frame being assembled, ms. Indexed as `systems`. */
  let sysSim = new Float64Array(0);
  let sysUpd = new Float64Array(0);
  /** ...and their exponentially smoothed values, which is what stats() reports. */
  let sysSimAvg = new Float64Array(0);
  let sysUpdAvg = new Float64Array(0);

  function sizeProfile(): void {
    if (sysSim.length >= systems.length) return;
    const n = systems.length;
    sysSim = new Float64Array(n);
    sysUpd = new Float64Array(n);
    sysSimAvg = new Float64Array(n);
    sysUpdAvg = new Float64Array(n);
  }

  ctx.budget = budget;

  /** The CSS size and device ratio the drawing buffer was last built for. */
  let sizedW = 0;
  let sizedH = 0;
  let sizedRatio = 0;

  /**
   * Match the drawing buffer to the canvas — and only when it does not.
   *
   * The guard used to compare `canvas.width` (which is *device* pixels) against
   * the element's CSS width, which are the same number only when the device
   * pixel ratio is exactly 1. On any retina laptop, and on every frame the
   * quality governor has scaled the render resolution, the two never matched,
   * so this ran its whole body — `setSize`, a projection rebuild, the
   * composer's target check and an `engine:resize` emit that the minimap and
   * the item slot both do work on — sixty times a second forever. Remembering
   * what we last sized *for* is the only comparison that is true in both
   * worlds, and it is also what lets the governor change the pixel ratio and
   * have the next frame simply pick it up.
   */
  function resize(): void {
    const w = canvas.clientWidth || canvas.width || 1280;
    const h = canvas.clientHeight || canvas.height || 720;
    const ratio = renderer.getPixelRatio();
    if (w === sizedW && h === sizedH && ratio === sizedRatio) return;
    sizedW = w; sizedH = h; sizedRatio = ratio;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    ctx.composer?.setSize(w, h);
    ctx.bus.emit('engine:resize', { width: w, height: h });
  }

  /**
   * One deterministic simulation step. No rendering, no wall clock.
   *
   * The timer reads below are *measurement*, never input: nothing in the
   * simulation may branch on them, and nothing does — they only accumulate into
   * `budget`, which no `fixedUpdate` reads. That is what keeps this step
   * reproducible on a machine that profiles differently from this one.
   */
  function stepFixed(dt: number = FIXED_DT): void {
    sizeProfile();
    ctx.time.dt = dt;
    ctx.inputState = ctx.input.sample(dt);
    let t = now();
    const t0 = t;
    for (let i = 0; i < systems.length; i++) {
      systems[i]!.fixedUpdate?.(dt);
      const n = now();
      sysSim[i]! += n - t;
      t = n;
    }
    ctx.time.elapsed += dt;
    ctx.time.frame++;
    simBank += t - t0;
    stepBank++;
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
    sizeProfile();
    const blend = alpha > 1 ? 1 : alpha > 0 ? alpha : 0; // NaN lands on 0
    ctx.time.alpha = blend;

    // Counted *before* the update pass, so a system reading them this frame
    // sees this frame included. Counting after was a real bug and a subtle one:
    // the single frame `startRace` primes to warm the shaders was still
    // uncounted while it ran, so the *next* frame — the first live one of the
    // session — saw the count move from 0 to 1 and read a bench frame arriving
    // milliseconds ago. The quality governor's burst test latched on that and
    // stood down for the rest of every real player's session, which is the
    // worst kind of failure: the ladder still typechecked, still passed its
    // determinism proof, and never once ran.
    budget.frames++;
    if (driving) budget.liveFrames++; else budget.benchFrames++;

    let t = now();
    const t0 = t;
    for (let i = 0; i < systems.length; i++) {
      systems[i]!.update?.(frameDt, blend);
      const n = now();
      sysUpd[i]! += n - t;
      t = n;
    }
    const updateMs = t - t0;

    renderer.info.reset();
    // A post-processing stack, if one is installed, owns the final draw.
    if (ctx.composer && ctx.quality.postfx) ctx.composer.render(frameDt);
    else renderer.render(scene, camera);
    const drawMs = now() - t;

    // ── close the frame ────────────────────────────────────────────────────
    budget.simMs = simBank;
    budget.updateMs = updateMs;
    budget.drawMs = drawMs;
    budget.steps = stepBank;
    simTimes[frameIdx] = simBank;
    updTimes[frameIdx] = updateMs;
    drawTimes[frameIdx] = drawMs;
    frameIdx = (frameIdx + 1) % BUDGET_WINDOW;
    if (frameCount < BUDGET_WINDOW) frameCount++;
    simBank = 0;
    stepBank = 0;

    let sum = 0, worst = 0, simSum = 0, drawSum = 0;
    for (let i = 0; i < frameCount; i++) {
      const total = simTimes[i]! + updTimes[i]! + drawTimes[i]!;
      sum += total;
      simSum += simTimes[i]!;
      drawSum += drawTimes[i]!;
      if (total > worst) worst = total;
    }
    const inv = frameCount > 0 ? 1 / frameCount : 0;
    budget.meanMs = sum * inv;
    budget.worstMs = worst;
    budget.meanSimMs = simSum * inv;
    budget.meanDrawMs = drawSum * inv;

    // Per-system costs decay toward the frame's own reading. A quarter-weight
    // blend settles in about a fifth of a second and keeps a single hitching
    // frame from being read as a system's steady cost.
    for (let i = 0; i < systems.length; i++) {
      sysSimAvg[i]! += (sysSim[i]! - sysSimAvg[i]!) * 0.25;
      sysUpdAvg[i]! += (sysUpd[i]! - sysUpdAvg[i]!) * 0.25;
      sysSim[i] = 0;
      sysUpd[i] = 0;
    }
  }

  function tick(ts: number): void {
    if (!running) return;
    rafId = requestAnimationFrame(tick);

    // Clamp: a backgrounded tab produces a huge delta that would teleport karts.
    //
    // The *first* callback needs the other clamp. A rAF timestamp is the moment
    // the frame began, which is routinely earlier than the `performance.now()`
    // that `start()` recorded a moment before — so the opening delta is
    // negative, and it used to be handed straight to the accumulator and to the
    // frame-time ring. One negative sample in a sixty-slot ring is what made
    // `stats()` report `ms: -2039, fps: 0` for the first second of every race.
    // The first frame simply has no delta; take a zero and start from there.
    const raw = wallPrimed ? (ts - lastWall) / 1000 : 0;
    const wallDt = raw > 0.25 ? 0.25 : raw > 0 ? raw : 0; // NaN lands on 0
    lastWall = ts;
    wallPrimed = true;

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

    driving = true;
    renderFrame(wallDt, accumulator / FIXED_DT);
    driving = false;

    // Wall time is kept alongside the measured budget rather than instead of
    // it: it is the only reading that includes vsync, compositing and whatever
    // else the browser is doing, and it is the only one that is meaningless
    // when the harness is driving. `wallCount` stays 0 in that case, and
    // `budget.wallMs` reads 0 — which is the honest answer, not a fake 60.
    //
    // **`raw`, not `wallDt`.** The 0.25s clamp above exists to stop a
    // backgrounded tab teleporting the karts; it is a limit on how much
    // *simulation* one frame may buy, and it has no business inside a
    // measurement. Recording the clamped value made `budget.wallMs` saturate at
    // exactly 250ms, so a machine drawing 1.7 frames a second — a real reading
    // of 590ms — reported the same number as one drawing 4, and the honest
    // reading of the worst machines this instrument exists for was the one
    // number it could not express. The first frame has no delta at all and is
    // skipped rather than recorded as a zero.
    if (raw > 0) {
      wallTimes[wallCount % BUDGET_WINDOW] = raw * 1000;
      wallCount++;
    }
    const n = wallCount < BUDGET_WINDOW ? wallCount : BUDGET_WINDOW;
    let wsum = 0;
    for (let i = 0; i < n; i++) wsum += wallTimes[i]!;
    budget.wallMs = n > 0 ? wsum / n : 0;
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

    /**
     * The honest bill for a frame.
     *
     * `ms` is *measured work* — simulation plus visual update plus draw — not a
     * wall-clock delta, so it means the same thing whether the browser's rAF
     * loop or the capture harness is driving. `wallMs` carries the wall reading
     * when there is one. `fps` is what that work implies, capped at the display
     * rate the game targets: 4ms of work is a 60fps frame with headroom, not a
     * 250fps one, and reporting 250 hides the headroom rather than showing it.
     */
    stats(): RenderStats {
      const info = renderer.info;
      const ms = budget.meanMs;
      const cost: SystemCost[] = [];
      for (let i = 0; i < systems.length; i++) {
        const sim = sysSimAvg[i] ?? 0;
        const upd = sysUpdAvg[i] ?? 0;
        if (sim + upd < 0.005) continue;
        cost.push({
          name: systems[i]!.name,
          simMs: +sim.toFixed(3),
          updateMs: +upd.toFixed(3),
        });
      }
      cost.sort((a, b) => (b.simMs + b.updateMs) - (a.simMs + a.updateMs));
      return {
        fps: ms > 0 ? Math.min(60, Math.round(1000 / ms)) : 0,
        ms: +ms.toFixed(2),
        worstMs: +budget.worstMs.toFixed(2),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs?.length ?? 0,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        simMs: +budget.simMs.toFixed(3),
        updateMs: +budget.updateMs.toFixed(3),
        drawMs: +budget.drawMs.toFixed(3),
        meanSimMs: +budget.meanSimMs.toFixed(3),
        meanDrawMs: +budget.meanDrawMs.toFixed(3),
        wallMs: +budget.wallMs.toFixed(2),
        steps: budget.steps,
        tier: ctx.quality.tier,
        drawDistance: +ctx.quality.drawDistance.toFixed(2),
        particles: +ctx.quality.particles.toFixed(2),
        shadowSize: ctx.quality.shadows ? ctx.quality.shadowSize : 0,
        systems: cost,
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
