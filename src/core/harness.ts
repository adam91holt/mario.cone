// window.__GAME — the automation surface.
//
// Every automated critic sees the game exclusively through this object, so it has
// to stay stable. Additive changes are fine; renaming or removing anything here
// silently blinds the review pipeline.
//
// The property that matters most: `step()` advances the simulation using only the
// fixed timestep — no requestAnimationFrame, no wall clock. A capture script can
// therefore ask for "4.0 seconds into the race" and get the same frame every time,
// no matter how slow the machine rendering it is.

import { FIXED_DT } from './config.ts';
import type {
  GameContext, HarnessApi, RaceConfig, Snapshot, SnapshotRacer,
  CameraMode, RacePhase, QualitySettings,
} from '../types.ts';
import type { Engine } from './engine.ts';

export interface HarnessHost {
  startRace(opts: Partial<RaceConfig>): Promise<void>;
  setQuality(tier: QualitySettings['tier']): void;
  setAutopilot(on: boolean): void;
}

export function installHarness(ctx: GameContext, engine: Engine, host: HarnessHost): HarnessApi {
  const round = (v: number): number => +v.toFixed(3);

  const api: HarnessApi = {
    ready: false,
    version: '0.1.0',

    /** Advance the simulation by `seconds` of game time. Deterministic, no draw. */
    step(seconds: number = FIXED_DT): number {
      const n = Math.max(1, Math.round(seconds / FIXED_DT));
      for (let i = 0; i < n; i++) engine.stepFixed(FIXED_DT);
      return n;
    },

    /** Draw one frame at the current simulation state. */
    render(): void {
      engine.resize();
      engine.renderFrame(FIXED_DT, 1);
    },

    /** step + render interleaved, so animation driven off `update` also runs. */
    advance(seconds = 1, fps = 60): number {
      const frames = Math.max(1, Math.round(seconds * fps));
      const perFrame = seconds / frames;
      const stepsPer = Math.max(1, Math.round(perFrame / FIXED_DT));
      for (let f = 0; f < frames; f++) {
        for (let i = 0; i < stepsPer; i++) engine.stepFixed(FIXED_DT);
        engine.renderFrame(perFrame, 1);
      }
      return frames;
    },

    /** Hard reset into a specific race configuration. */
    async reset(opts: Partial<RaceConfig> = {}): Promise<void> {
      await host.startRace(opts);
    },

    setInput(partial) { ctx.input.setVirtual(partial); },
    clearInput(key) { ctx.input.clearVirtual(key); },
    press(name) { ctx.input.press(name); },

    setCamera(mode: CameraMode): CameraMode {
      ctx.bus.emit('camera:mode', { mode });
      return mode;
    },
    setQuality(tier) { host.setQuality(tier); },
    setTimeScale(s) { ctx.time.scale = s; },
    setAutopilot(on) { host.setAutopilot(on); },

    /** Jump the race straight to a phase, skipping intros. */
    seek(phase: RacePhase): RacePhase {
      ctx.bus.emit('race:seek', { phase });
      return phase;
    },

    stats() { return engine.stats(); },

    /** Plain-JSON state dump. Must stay serialisable — critics diff it. */
    snapshot(): Snapshot {
      return {
        version: api.version,
        time: { elapsed: round(ctx.time.elapsed), frame: ctx.time.frame },
        race: ctx.race
          ? {
              phase: ctx.race.phase,
              time: round(ctx.race.time),
              totalLaps: ctx.race.totalLaps,
              standings: ctx.race.standings.slice(),
            }
          : null,
        track: ctx.track
          ? { id: ctx.track.id, name: ctx.track.name, length: round(ctx.track.length) }
          : null,
        racers: ctx.racers.map((r): SnapshotRacer => ({
          id: r.id,
          name: r.name,
          vehicleId: r.vehicleId,
          isPlayer: r.isPlayer,
          pos: [round(r.pos.x), round(r.pos.y), round(r.pos.z)],
          speed: round(r.speed),
          place: r.place,
          lap: r.lap,
          progress: round(r.progress),
          coins: r.coins,
          item: r.item,
          grounded: r.grounded,
          surface: r.surface,
          drift: { active: r.drift.active, tier: r.drift.tier, charge: round(r.drift.charge) },
          boost: { time: round(r.boost.time), source: r.boost.source },
          stunned: round(r.stunned),
        })),
        camera: {
          pos: [round(ctx.camera.position.x), round(ctx.camera.position.y), round(ctx.camera.position.z)],
          fov: round(ctx.camera.fov),
        },
        errors: api.errors.slice(),
      };
    },

    /** Console errors captured since load — critics fail the build on any. */
    errors: [],
  };

  // Capture anything that goes wrong so a critic can see it without a devtools
  // protocol hookup, and so `--smoke` can fail loudly.
  const origError = console.error;
  console.error = (...args: unknown[]): void => {
    const text = args
      .map((a) => (a instanceof Error && a.stack ? a.stack : String(a)))
      .join(' ')
      .slice(0, 500);
    api.errors.push(text);
    if (api.errors.length > 50) api.errors.shift();
    origError.apply(console, args as []);
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('error', (e) =>
      api.errors.push(`uncaught: ${e.message} @${e.filename}:${e.lineno}`));
    window.addEventListener('unhandledrejection', (e) =>
      api.errors.push(`unhandled: ${String(e.reason)}`));
    window.__GAME = api;
  }

  ctx.harness = api;
  return api;
}
