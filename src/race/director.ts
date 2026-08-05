// Race director: countdown, lap counting, positions, finishing order.
//
// Progress is tracked as a monotonic distance (lap * trackLength + distance
// along the spline), which makes sorting positions trivial and immune to the
// wrap-around bugs that plague checkpoint-only systems. Checkpoints still exist,
// but only to stop a player from driving backwards over the line to farm laps.

import { clamp01 } from '../core/math.ts';
import { boostRacer } from '../physics/kart.ts';
import type { GameContext, GameSystem, RaceConfig, Racer, RacePhase } from '../types.ts';

export function createRaceDirector(ctx: GameContext): GameSystem {
  const R = ctx.config.race;
  let countdownTimer = 0;
  let lastCountdownShown = -1;
  let introTimer = 0;
  /** Set when the player holds accelerate during the countdown window. */
  const startCharge = new Map<number, number>();

  function setPhase(phase: RacePhase): void {
    if (ctx.race.phase === phase) return;
    ctx.race.phase = phase;
    ctx.bus.emit(`race:${phase}`, {});
    ctx.bus.emit('race:phase', { phase });
  }

  function beginCountdown(): void {
    countdownTimer = R.countdownFrom + 1;
    lastCountdownShown = -1;
    startCharge.clear();
    setPhase('countdown');
  }

  /** Rocket start: reward accelerating in the last fraction of the countdown. */
  function evaluateStart(racer: Racer): void {
    const held = startCharge.get(racer.id) ?? 0;
    const [outer, inner] = R.rocketStart.window;
    if (held > 0 && held <= outer && held >= inner) {
      boostRacer(ctx, racer, 'rocketStart', R.rocketStart.boost.time, R.rocketStart.boost.power);
      ctx.bus.emit('race:rocketStart', { racer });
    } else if (held > R.rocketStart.burnout) {
      // Held far too early — bog down, exactly like the real thing.
      racer.stunned = Math.max(racer.stunned, 0.9);
      ctx.bus.emit('race:burnout', { racer });
    }
  }

  /** Distance around the loop measured from the start/finish line, not from the
   *  spline's arbitrary origin — so the lap counter ticks over exactly at the
   *  line regardless of where the course author put station zero. */
  function lapDistance(rawDistance: number): number {
    const track = ctx.track!;
    const L = track.length;
    const start = track.course.startDistance ?? 0;
    return (((rawDistance - start) % L) + L) % L;
  }

  function updateProgress(racer: Racer): void {
    const track = ctx.track;
    if (!track) return;
    const L = track.length;
    const d = lapDistance(track.spline.nearest(racer.pos).distance);

    const prev = racer.progress - racer.lap * L;
    // A jump of more than half the lap can only be the line wrapping, which is
    // unambiguous at kart speeds.
    const delta = d - prev;

    if (delta > L * 0.5) {
      racer.lap--;            // reversed back over the line
    } else if (delta < -L * 0.5) {
      racer.lap++;
      // Racers start at lap -1 on the run-up to the line, so lap 0 is the first
      // crossing and does not score a lap time.
      if (racer.lap >= 1) {
        racer.lapTimes.push(ctx.race.time);
        ctx.bus.emit('race:lap', { racer, lap: racer.lap });
      }
      if (racer.lap >= ctx.race.totalLaps && !racer.finished) {
        racer.finished = true;
        racer.finishTime = ctx.race.time;
        ctx.race.finishedCount++;
        ctx.bus.emit('race:finish', {
          racer, place: ctx.race.finishedCount, time: racer.finishTime,
        });
      }
    }
    racer.progress = racer.lap * L + d;
  }

  function updateStandings(): void {
    const order = ctx.racers.slice().sort((a, b) => {
      // Finished racers always outrank unfinished ones, earliest first.
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return b.progress - a.progress;
    });
    for (let i = 0; i < order.length; i++) order[i]!.place = i + 1;
    ctx.race.standings = order.map((r) => r.id);
  }

  ctx.bus.on<{ phase: RacePhase }>('race:seek', ({ phase }) => {
    // Used by the capture harness to skip straight to a phase.
    if (phase === 'racing') {
      countdownTimer = 0;
      introTimer = 0;
      setPhase('racing');
    } else if (phase === 'countdown') {
      beginCountdown();
    } else if (phase === 'results') {
      for (const r of ctx.racers) {
        if (!r.finished) { r.finished = true; r.finishTime = ctx.race.time; }
      }
      setPhase('results');
    } else {
      setPhase(phase);
    }
  });

  return {
    name: 'race',
    order: 70,

    reset(cfg: RaceConfig): void {
      ctx.race.time = 0;
      ctx.race.totalLaps = cfg.laps ?? ctx.track?.laps ?? R.laps;
      ctx.race.engineClass = cfg.engineClass;
      ctx.race.finishedCount = 0;
      ctx.race.countdown = R.countdownFrom;
      ctx.race.standings = ctx.racers.map((r) => r.id);
      startCharge.clear();

      // The grid sits behind the line, so everyone begins on lap -1: their first
      // crossing starts lap 1 rather than scoring one.
      const L = ctx.track?.length ?? 1;
      for (const r of ctx.racers) {
        r.checkpoint = 0;
        r.finished = false;
        r.finishTime = 0;
        r.lapTimes = [];
        r.lap = -1;
        r.progress = ctx.track
          ? -L + lapDistance(ctx.track.spline.nearest(r.pos).distance)
          : 0;
      }

      if (cfg.instant) {
        introTimer = 0;
        countdownTimer = 0;
        setPhase('racing');
      } else {
        introTimer = 3.2;
        setPhase('intro');
        ctx.bus.emit('race:intro', {});
      }
    },

    fixedUpdate(dt: number): void {
      const race = ctx.race;

      switch (race.phase) {
        case 'intro': {
          introTimer -= dt;
          if (introTimer <= 0) beginCountdown();
          break;
        }

        case 'countdown': {
          countdownTimer -= dt;
          race.countdown = Math.max(0, Math.ceil(countdownTimer - 1));

          // Track how long each racer has been holding accelerate.
          for (const r of ctx.racers) {
            const accel = r.isPlayer ? ctx.inputState.accel : (r.aiInput?.accel ?? 0);
            if (accel > 0.5) startCharge.set(r.id, (startCharge.get(r.id) ?? 0) + dt);
            else startCharge.delete(r.id);
          }

          const shown = race.countdown;
          if (shown !== lastCountdownShown) {
            lastCountdownShown = shown;
            ctx.bus.emit('race:countdown', { n: shown });
          }

          if (countdownTimer <= 0) {
            for (const r of ctx.racers) evaluateStart(r);
            setPhase('racing');
          }
          break;
        }

        case 'racing': {
          race.time += dt;
          for (const r of ctx.racers) updateProgress(r);
          updateStandings();

          if (ctx.player?.finished) {
            setPhase('finished');
            ctx.bus.emit('race:results', { standings: race.standings.slice() });
          } else if (race.finishedCount >= ctx.racers.length) {
            setPhase('finished');
          }
          break;
        }

        case 'finished': {
          // Let the AI keep racing for a moment before the results screen.
          race.time += dt;
          for (const r of ctx.racers) updateProgress(r);
          updateStandings();
          break;
        }

        default:
          break;
      }
    },
  };
}

/** Points awarded for a finishing place, for cup standings. */
export function pointsFor(ctx: GameContext, place: number): number {
  return ctx.config.race.points[place - 1] ?? 0;
}

/** 0..1 how far through the race a racer is. Used by HUD and rubber-banding. */
export function raceProgressFraction(ctx: GameContext, racer: Racer): number {
  const track = ctx.track;
  if (!track) return 0;
  return clamp01(racer.progress / (track.length * ctx.race.totalLaps));
}
