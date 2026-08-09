// Race director: the grid, the lights, the laps, the flag and everything after
// it.
//
// The counting half of this file is unchanged in spirit: progress is a
// monotonic distance (lap * trackLength + distance along the spline), which
// makes sorting positions trivial and immune to the wrap-around bugs that
// plague checkpoint-only systems.
//
// The other half is the *shape of a race*, and it is worth stating plainly
// because it is spread over a state machine:
//
//   **grid**      The field is seated by championship order — a fresh race puts
//                 the player at the back, which is where a kart racer's story
//                 starts — and drives up into its slots while the camera sweeps
//                 the grid and the course card names the circuit.
//   **lights**    Three beats and a flag. `race.countdown` reads 3, 2, 1 during
//                 the three seconds before the start and 0 *on* it, so the GO
//                 the player sees is the frame they are allowed to move.
//   **racing**    Laps, splits, best laps, the final-lap alarm.
//   **flag**      The player crosses. Time drops to a third for a beat, the
//                 lens swings round, and the rest of the field is read home one
//                 machine at a time instead of being deleted.
//   **wrap**      Everybody is in (or the window has closed on the stragglers).
//   **results**   The table, the points, the championship, and the way out.
//
// Pause is orthogonal to all of it and is a *phase*, not a widget: every system
// in the game already stops on a phase that is not `racing`, so pausing swaps
// the phase and remembers where it was.

import * as THREE from 'three';
import { clamp01, ease, hash1 } from '../core/math.ts';
import { boostRacer } from '../physics/kart.ts';
import { getVehicle } from '../vehicles/registry.ts';
import { coursesInCup, listCourses } from '../track/courses/index.ts';
import { ordinalWord } from '../ui/glyphs.ts';
import { blipColor } from '../ui/theme.ts';
import { createCup, createRaceBook, type ResultRow } from './book.ts';
import { createOverlay, type RaceOverlay } from './overlay.ts';
import { formatGap } from './results.ts';
import type { MenuOption } from './menu.ts';
import type {
  GameContext, GameSystem, RaceConfig, Racer, RacePhase, SplineSample,
} from '../types.ts';

/** Seconds of the intro sweep the field spends driving into its slots. */
const FORM_TIME = 1.0;
const FORM_BACK = 11;
const FORM_ROW_STAGGER = 0.06;
/** How long the flag holds before the results sheet is allowed to start. */
const FLAG_HOLD = 1.5;
/** ...and the longest the race will wait for the field after the player is in. */
const WRAP_LIMIT = 14;
/** A player still circulating after the whole field is home gets this long. */
const SOLO_LIMIT = 45;
/** Beat between the last machine crossing and the sheet arriving. */
const RESULTS_DELAY = 1.15;
/** The finish slow-motion, in real seconds: fall, hold, recover. */
const SLOW_FALL = 0.12;
const SLOW_HOLD = 0.8;
const SLOW_RISE = 1.0;
const SLOW_DEPTH = 0.3;

/** Where a racer sits on the grid, in spline terms, so the drive-in can follow
 *  the road rather than a straight line pointing off a banked corner. */
interface Seat {
  racer: Racer;
  /** The pose the drive-in ends on. */
  pos: THREE.Vector3;
  distance: number;
  lateral: number;
  height: number;
  row: number;
}

const UP = new THREE.Vector3(0, 1, 0);

/** See `gridOrder()`. Held false by the opening camera sweep, not by taste. */
const PLAYER_AT_BACK = false;

export function createRaceDirector(ctx: GameContext): GameSystem {
  const R = ctx.config.race;
  const book = createRaceBook();
  const cup = createCup();

  let countdownTimer = 0;
  let lastBeat = -1;
  let introTimer = 0;
  /** Seconds the grid has spent driving into its slots. Negative when settled. */
  let formT = -1;
  /** Seconds since the player took the flag. Negative when they have not. */
  let flagT = -1;
  /** Seconds since the whole field came home. Negative until it has. */
  let wrapT = -1;
  let soloT = 0;
  /** The finish slow-motion clock. Real seconds — it is a *visual* effect that
   *  happens to be spent in the simulation's currency. */
  let slowT = -1;

  /** The leader's time, and the last time written into the book. */
  let winnerTime = 0;
  let lastFinishTime = 0;

  let paused = false;
  let resumePhase: RacePhase = 'racing';
  /** Set while a restart is in flight so a second key press cannot double-fire. */
  let restarting = false;
  /** True when the next `reset` is one this module asked for. Anything else — a
   *  reviewer calling `__GAME.reset()`, a front-end starting a race — is a
   *  standalone race and gets a fresh championship and a fresh grid. */
  let ownRestart = false;
  /** Menu nav latch: the stick has to come back to centre between moves. */
  let navLatch = 0;

  let cfgNow: RaceConfig = {
    courseId: 'cone-canyon', vehicleId: 'cone', engineClass: '150cc',
    racerCount: 8, seed: 1,
  };
  /** Grid order for the next race, by racer name — championship order, set when
   *  the player advances a round. Null means "seat a fresh race". */
  let pendingGrid: string[] | null = null;
  let cupStarted = false;

  const seats: Seat[] = [];
  const startHeld = new Map<number, number>();
  let sample: SplineSample | null = null;

  const overlay: RaceOverlay | null = createOverlay(onPick);

  // ── small helpers ────────────────────────────────────────────────────────

  const colorOf = (racer: Racer): number =>
    blipColor(getVehicle(racer.vehicleId).colors.primary);

  function setPhase(phase: RacePhase): void {
    if (ctx.race.phase === phase) return;
    ctx.race.phase = phase;
    ctx.bus.emit(`race:${phase}`, {});
    ctx.bus.emit('race:phase', { phase });
  }

  /**
   * Change phase without announcing it as a *transition*.
   *
   * Pause and resume move the phase twice for reasons that have nothing to do
   * with the race — and `race:racing` is the event the mixer plays the starting
   * fanfare on. Resuming a paused race must not sound like a fresh start, so the
   * pause path moves the phase quietly and only publishes `race:phase`, which is
   * a statement of *state* and safe to repeat.
   */
  function setPhaseQuiet(phase: RacePhase): void {
    if (ctx.race.phase === phase) return;
    ctx.race.phase = phase;
    ctx.bus.emit('race:phase', { phase });
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

  // ── the grid ─────────────────────────────────────────────────────────────

  /**
   * The order the field lines up in.
   *
   * Later rounds of a cup line up by championship order, best first — which is
   * what makes leading one worth something, and is the rule MK8 uses.
   *
   * A standalone race lines up in field order, which puts the human on pole.
   * **That is the camera's requirement, not a design choice.** The opening
   * sweep's first beat sits 11.5m *ahead* of the player looking back at them,
   * so everything behind the player is in shot and everything in front of them
   * is behind the lens: with the human on pole that beat is the whole grid, and
   * with the human anywhere else it is one machine three metres from the lens
   * and an empty road. Both compositions were photographed before this comment
   * was written.
   *
   * Flip `PLAYER_AT_BACK` the day that beat frames *up* the grid from behind
   * the player instead — starting last is the premise a kart racer wants, and
   * everything else in this module already supports it (the countdown and the
   * opening laps are markedly better shots with seven machines in front of
   * you). One constant, and a line in the camera module.
   */
  function gridOrder(): Racer[] {
    const field = ctx.racers.slice();
    if (pendingGrid && pendingGrid.length) {
      const rank = new Map(pendingGrid.map((name, i) => [name, i]));
      field.sort((a, b) => (rank.get(a.name) ?? 99) - (rank.get(b.name) ?? 99));
      return field;
    }
    field.sort((a, b) => {
      if (PLAYER_AT_BACK && a.isPlayer !== b.isPlayer) return a.isPlayer ? 1 : -1;
      return a.id - b.id;
    });
    return field;
  }

  function seatGrid(): void {
    const track = ctx.track;
    seats.length = 0;
    if (!track) return;
    if (!sample) sample = track.spline.atDistance(0);

    const order = gridOrder();
    const total = order.length;
    const L = track.length;

    for (let slot = 0; slot < total; slot++) {
      const racer = order[slot]!;
      const g = track.gridSlot(slot, total);
      racer.pos.copy(g.pos);
      racer.prevPos.copy(g.pos);
      racer.vel.set(0, 0, 0);
      racer.speed = 0;
      racer.yaw = Math.atan2(g.forward.x, g.forward.z);
      racer.quat.setFromAxisAngle(UP, racer.yaw);
      racer.prevQuat.copy(racer.quat);

      racer.lap = -1;
      racer.checkpoint = 0;
      racer.finished = false;
      racer.finishTime = 0;
      racer.lapTimes = [];
      racer.progress = -L + lapDistance(g.distance);
      racer.place = slot + 1;

      const s = track.spline.nearest(g.pos, sample);
      seats.push({
        racer,
        pos: g.pos.clone(),
        distance: s.distance,
        lateral: s.lateral ?? 0,
        height: s.height ?? 0,
        row: Math.floor(slot / 2),
      });
    }

    ctx.race.standings = order.map((r) => r.id);
    ctx.bus.emit('race:grid', { order: ctx.race.standings.slice() });
  }

  /**
   * The field driving up into its slots under the opening camera sweep.
   *
   * Sim state, written in `fixedUpdate` after physics has stepped — which is
   * safe precisely because physics freezes every kart outside the `racing`
   * phase, so nothing else is touching these transforms. `speed` is written too,
   * not as decoration: the wheel rigs and the engine voices are driven from it,
   * and a machine that slides into place with dead wheels and a silent motor
   * looks like a bug in the animation system.
   */
  function updateFormation(dt: number): void {
    const track = ctx.track;
    if (!track || formT < 0 || !sample) return;
    formT += dt;
    let moving = false;

    for (const seat of seats) {
      const u = clamp01((formT - seat.row * FORM_ROW_STAGGER) / FORM_TIME);
      if (u >= 1) { seat.racer.speed = 0; continue; }
      moving = true;
      const e = ease.outCubic(u);
      const back = (1 - e) * FORM_BACK;
      const d = seat.distance - back;
      track.spline.pointAt(d, seat.lateral, seat.height, seat.racer.pos);
      const s = track.spline.atDistance(d, sample);
      seat.racer.yaw = Math.atan2(s.tangent.x, s.tangent.z);
      seat.racer.quat.setFromAxisAngle(UP, seat.racer.yaw);
      // The derivative of the ease, so the wheels turn at the speed the machine
      // is actually travelling and stop exactly as it parks.
      seat.racer.speed = FORM_BACK * 3 * (1 - u) * (1 - u) / FORM_TIME;
    }
    if (!moving) endFormation();
  }

  function endFormation(): void {
    if (formT < 0) return;
    formT = -1;
    for (const seat of seats) {
      seat.racer.pos.copy(seat.pos);
      seat.racer.prevPos.copy(seat.pos);
      seat.racer.speed = 0;
      seat.racer.vel.set(0, 0, 0);
    }
  }

  // ── the lights ───────────────────────────────────────────────────────────

  function beginCountdown(): void {
    countdownTimer = R.countdownFrom;
    lastBeat = -1;
    startHeld.clear();
    endFormation();
    overlay?.card.retire();
    overlay?.lights.arm();
    setPhase('countdown');
    ctx.race.countdown = R.countdownFrom;
    beat(R.countdownFrom);
  }

  function beat(n: number): void {
    if (n === lastBeat) return;
    lastBeat = n;
    overlay?.lights.beat(n);
    ctx.bus.emit('race:countdown', { n });
  }

  /**
   * What each CPU did with the last quarter second before the flag.
   *
   * Deterministic, and deliberately *not* drawn from `ctx.rng`: the shared
   * stream is consumed by items and by the AI, and taking eight numbers out of
   * it at the start of every race would shift every other module's sequence for
   * a decision no one can see. A hash of the racer's id and the race seed gives
   * the same answer every run without moving anybody else's dice.
   *
   * (The AI used to author this itself by holding the throttle through a beat
   * the countdown spent showing GO to a field that was not allowed to move. The
   * beat is gone; see the note on `race.countdown` at the top of this file.)
   */
  function cpuHold(racer: Racer): number {
    const [outer, inner] = R.rocketStart.window;
    const skill = racer.ai?.skill ?? 0.5;
    const r = hash1(racer.id * 7.919 + (cfgNow.seed ?? 1) * 0.613 + 3.17);
    const pRocket = 0.1 + skill * 0.5;
    const pBog = 0.03 + (1 - skill) * 0.06;
    if (r < pRocket) return inner + (r / pRocket) * (outer - inner);
    if (r > 1 - pBog) return R.rocketStart.burnout + 0.3;
    return 0;
  }

  /** Rocket start: reward accelerating in the last fraction of the countdown. */
  function evaluateStart(racer: Racer): void {
    const held = racer.isPlayer ? (startHeld.get(racer.id) ?? 0) : cpuHold(racer);
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

  // ── laps and places ──────────────────────────────────────────────────────

  function updateProgress(racer: Racer): void {
    const track = ctx.track;
    if (!track) return;
    const L = track.length;
    const d = lapDistance(track.spline.nearest(racer.pos, sample ?? undefined).distance);

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
        const { split, best } = book.lap(racer, ctx.race.time);
        ctx.bus.emit('race:lap', { racer, lap: racer.lap, split });
        if (best) ctx.bus.emit('race:bestlap', { racer, time: split, lap: racer.lap });
        if (racer.lap === ctx.race.totalLaps - 1) {
          ctx.bus.emit('race:finallap', { racer, lap: racer.lap });
          if (racer.isPlayer) ctx.fx?.flash(0xFF6B1A, 0.3);
        }
      }
      if (racer.lap >= ctx.race.totalLaps && !racer.finished) finishRacer(racer, false);
    }
    racer.progress = racer.lap * L + d;
  }

  function finishRacer(racer: Racer, estimated: boolean): void {
    if (racer.finished) return;
    racer.finished = true;
    // A forced finish must never be *earlier* than one already in the book, or
    // the table's times would contradict its own order.
    racer.finishTime = estimated
      ? Math.max(estimateFinish(racer), lastFinishTime + 0.08)
      : ctx.race.time;
    lastFinishTime = racer.finishTime;
    ctx.race.finishedCount++;
    const place = ctx.race.finishedCount;
    if (place === 1) winnerTime = racer.finishTime;
    book.finish(racer, place, racer.finishTime, estimated);
    ctx.bus.emit('race:finish', { racer, place, time: racer.finishTime });

    if (racer.isPlayer) beginFlag();
    // Everyone who comes home after the player is read out by name. Before it,
    // the player is still driving and the screen belongs to the race.
    else if (flagT >= 0) tickerAdd(racer, place);
  }

  /** A time for a racer the flag came in on: their remaining distance at a pace
   *  they could plausibly have held. Marked `estimated` in the table. */
  function estimateFinish(racer: Racer): number {
    const track = ctx.track;
    if (!track) return ctx.race.time;
    const remaining = Math.max(0, track.length * ctx.race.totalLaps - racer.progress);
    const pace = Math.max(28, Math.abs(racer.speed));
    return ctx.race.time + remaining / pace;
  }

  function tickerAdd(racer: Racer, place: number): void {
    const gap = place > 1 ? Math.max(0, racer.finishTime - winnerTime) : 0;
    overlay?.ticker.add({
      place,
      suffix: ordinalWord(place),
      name: racer.name,
      gap: gap > 0 ? `+${formatGap(gap)}` : '',
      color: colorOf(racer),
      isPlayer: racer.isPlayer,
    });
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

  // ── the flag ─────────────────────────────────────────────────────────────

  function beginFlag(): void {
    if (flagT >= 0) return;
    flagT = 0;
    slowT = 0;
    ctx.fx?.flash(0xFFF8F0, 0.42);
    // The race is decided; the mixer should not wait for the last CPU to trundle
    // home before it says so. `setMusic` is the audio module's own front door.
    ctx.audio?.setMusic('victory', { fade: 0.9 });
    // Read the order home from the top, including the machines that beat us.
    const done = ctx.racers.filter((r) => r.finished)
      .sort((a, b) => a.finishTime - b.finishTime);
    for (let i = 0; i < done.length; i++) tickerAdd(done[i]!, i + 1);
  }

  /** Slow-motion across the line. Written to `time.scale`, which only the
   *  realtime loop reads — the harness steps the simulation by hand, so a
   *  capture is unaffected and stays reproducible. */
  function updateSlowMo(dt: number): void {
    if (slowT < 0) return;
    slowT += dt;
    let s: number;
    if (slowT < SLOW_FALL) s = 1 - (1 - SLOW_DEPTH) * ease.outQuad(slowT / SLOW_FALL);
    else if (slowT < SLOW_FALL + SLOW_HOLD) s = SLOW_DEPTH;
    else {
      const u = clamp01((slowT - SLOW_FALL - SLOW_HOLD) / SLOW_RISE);
      s = SLOW_DEPTH + (1 - SLOW_DEPTH) * ease.inOutCubic(u);
      if (u >= 1) { slowT = -1; ctx.time.scale = 1; return; }
    }
    ctx.time.scale = s;
  }

  // ── results ──────────────────────────────────────────────────────────────

  function ensureCup(): void {
    if (cupStarted) return;
    const cupId = ctx.track?.course.cup ?? 'hazard';
    const inCup = coursesInCup(cupId);
    const list = (inCup.length ? inCup : listCourses().slice()).map((c) => c.id);
    cup.begin(cupId, cupTitle(cupId), list, 4);
    cupStarted = true;
  }

  function cupTitle(id: string): string {
    return `${id.replace(/[-_]/g, ' ')} cup`.toUpperCase();
  }

  function toWrap(): void {
    if (ctx.race.phase === 'finished' || ctx.race.phase === 'results') return;
    // Stragglers come home in the order they were running, not in the order the
    // field happens to be stored in.
    const left = ctx.racers.filter((r) => !r.finished).sort((a, b) => b.progress - a.progress);
    for (const r of left) finishRacer(r, true);
    updateStandings();
    setPhase('finished');
    wrapT = 0;
    // A lens that keeps chasing a stationary kart for the last ten seconds of a
    // race is a lens with nothing to say. The orbit is the camera module's own
    // mode; this only asks for it.
    ctx.bus.emit('camera:mode', { mode: 'cinematic' });
    ctx.bus.emit('race:results', {
      standings: ctx.race.standings.slice(),
      rows: book.rows(R.points, colorOf),
    });
  }

  function showResults(): void {
    const rows = book.rows(R.points, colorOf);
    ensureCup();
    cup.apply(rows);
    setPhase('results');
    if (!overlay) return;
    overlay.ticker.clear();
    const fast = book.fastest();
    const complete = cup.complete();
    overlay.results.show(rows, cup.state.standings, {
      cupName: cup.state.name,
      courseName: ctx.track?.name ?? '',
      round: cup.state.round,
      rounds: cup.state.rounds,
      bestLapName: fast.racer?.name ?? '',
      bestLapTime: fast.time,
      cupComplete: complete,
    }, resultOptions(complete));
  }

  function resultOptions(complete: boolean): MenuOption[] {
    const opts: MenuOption[] = [];
    if (!complete) opts.push({ id: 'next', label: 'NEXT RACE' });
    opts.push({ id: 'again', label: complete ? 'NEW CUP' : 'RACE AGAIN' });
    opts.push({ id: 'exit', label: 'EXIT' });
    return opts;
  }

  // ── restarting ───────────────────────────────────────────────────────────

  /**
   * Hand the race back to `main.ts`.
   *
   * Deferred to a microtask on purpose: a menu press arrives inside
   * `fixedUpdate`, and `harness.reset()` tears down the field and calls
   * `reset()` on every system — including this one — which would land in the
   * middle of the step that asked for it. The microtask runs after the whole
   * frame has unwound, which is the only seam wide enough to rebuild a race in.
   */
  function restart(opts: Partial<RaceConfig>): void {
    if (restarting) return;
    restarting = true;
    ownRestart = true;
    ctx.time.scale = 1;
    queueMicrotask(() => {
      restarting = false;
      const api = ctx.harness;
      if (!api) { ownRestart = false; return; }
      void api.reset(opts);
    });
  }

  function onPick(id: string): void {
    if (restarting) return;
    const seed = ((cfgNow.seed ?? 1) * 1103515245 + 12345) >>> 8;

    if (paused) {
      // The championship is only folded in when a results sheet is built, so
      // nothing here has to roll it back: abandoning a race mid-way scores
      // nothing, exactly as it should.
      if (id === 'resume') { togglePause(); return; }
      if (id === 'restart') { togglePause(); restart({ ...cfgNow }); return; }
      if (id === 'quit') { togglePause(); toWrap(); return; }
      return;
    }

    if (id === 'next') {
      if (cup.advance()) {
        pendingGrid = cup.state.standings.map((s) => s.name);
        restart({ ...cfgNow, courseId: cup.courseId(), seed });
      } else {
        cupStarted = false;
        pendingGrid = null;
        restart({ ...cfgNow, seed });
      }
      return;
    }
    if (id === 'again') {
      // A retry must not bank the points twice — the championship rolls back to
      // where it stood before this race was folded in.
      cup.undo();
      if (cup.complete()) { cupStarted = false; pendingGrid = null; }
      restart({ ...cfgNow });
      return;
    }
    if (id === 'exit') {
      // If a front-end is listening it owns what happens next; if nothing is,
      // the only honest "exit" this build has is a fresh championship.
      if ((ctx.bus.inspect()['race:exit'] ?? 0) > 0) {
        ctx.bus.emit('race:exit', { from: 'results' });
        return;
      }
      cupStarted = false;
      pendingGrid = null;
      restart({ ...cfgNow, seed });
    }
  }

  // ── pause ────────────────────────────────────────────────────────────────

  function canPause(): boolean {
    const p = ctx.race.phase;
    return p === 'intro' || p === 'countdown' || p === 'racing' || p === 'finished';
  }

  function togglePause(): void {
    if (paused) {
      paused = false;
      overlay?.pause.hide();
      setPhaseQuiet(resumePhase);
      ctx.bus.emit('race:pause', { on: false });
      return;
    }
    if (!canPause()) return;
    paused = true;
    resumePhase = ctx.race.phase;
    setPhaseQuiet('loading');
    const player = ctx.player;
    overlay?.pause.show([
      { id: 'resume', label: 'RESUME' },
      { id: 'restart', label: 'RESTART' },
      { id: 'quit', label: 'END RACE' },
    ], {
      lap: Math.max(1, (player?.lap ?? 0) + 1),
      totalLaps: ctx.race.totalLaps,
      place: player?.place ?? 1,
    });
    ctx.bus.emit('race:pause', { on: true });
  }

  // ── menu input ───────────────────────────────────────────────────────────

  /** One row of options, driven by the only axis and the only edges the input
   *  layer publishes. Pointer input is handled by the widget itself. */
  function menuInput(dt: number, menu: { move(d: number): void; press(): string | null }): void {
    const s = ctx.inputState;
    navLatch = Math.max(0, navLatch - dt);
    const steer = s.steer;
    if (Math.abs(steer) < 0.25) navLatch = 0;
    else if (navLatch <= 0) {
      menu.move(steer > 0 ? 1 : -1);
      // Held: repeat, slowly enough to be a choice rather than a scroll.
      navLatch = 0.28;
    }
    if (s.pressed.confirm || s.pressed.drift || s.pressed.item) {
      const id = menu.press();
      if (id) onPick(id);
    }
  }

  // ── the harness's seek ───────────────────────────────────────────────────

  ctx.bus.on<{ phase: RacePhase }>('race:seek', ({ phase }) => {
    // Used by the capture harness to skip straight to a phase.
    if (paused) togglePause();
    if (phase === 'racing') {
      endFormation();
      countdownTimer = 0;
      introTimer = 0;
      overlay?.card.reset();
      overlay?.lights.reset();
      setPhase('racing');
    } else if (phase === 'countdown') {
      beginCountdown();
    } else if (phase === 'finished') {
      toWrap();
    } else if (phase === 'results') {
      toWrap();
      wrapT = -1;
      showResults();
      // A seek is not a finish: nothing should be left running in slow motion.
      slowT = -1;
      ctx.time.scale = 1;
    } else if (phase === 'intro') {
      setPhase('intro');
    } else {
      setPhase(phase);
    }
  });

  // ── the reviewer's bench ─────────────────────────────────────────────────
  //
  // The same idea as `__ITEMS` and `__AUDIO`: a results screen and a pause menu
  // are states a screenshot cannot reach by driving, so they get a front door.
  // Nothing in the simulation reads any of it.
  if (typeof globalThis !== 'undefined') {
    (globalThis as unknown as Record<string, unknown>).__RACE = {
      probe: (): Record<string, unknown> => ({
        phase: ctx.race.phase,
        paused,
        countdown: ctx.race.countdown,
        time: +ctx.race.time.toFixed(3),
        totalLaps: ctx.race.totalLaps,
        forming: formT >= 0,
        flag: +flagT.toFixed(2),
        timeScale: +ctx.time.scale.toFixed(3),
        finished: book.finishedCount(),
        grid: ctx.racers.slice().sort((a, b) => a.place - b.place).map((r) => r.name),
        rows: book.rows(R.points, colorOf),
        best: (() => { const f = book.fastest(); return { name: f.racer?.name ?? '', time: +f.time.toFixed(3) }; })(),
        cup: cup.state,
        menu: overlay?.results.visible ? overlay.results.menu.current()
          : overlay?.pause.visible ? overlay.pause.menu.current() : null,
      }),
      pause: (on?: boolean): void => { if (on === undefined || on !== paused) togglePause(); },
      /** Move the live menu cursor, and press it. */
      select: (i: number): void => {
        const m = overlay?.results.visible ? overlay.results.menu
          : overlay?.pause.visible ? overlay.pause.menu : null;
        m?.focus(i);
      },
      confirm: (): void => {
        const m = overlay?.results.visible ? overlay.results.menu
          : overlay?.pause.visible ? overlay.pause.menu : null;
        const id = m?.press();
        if (id) onPick(id);
      },
      cup: () => cup.state,
    };
  }

  // ── the system ───────────────────────────────────────────────────────────

  return {
    name: 'race',
    order: 70,

    reset(cfg: RaceConfig): void {
      if (!ownRestart) {
        // Somebody outside this module started a race: no championship history,
        // no inherited grid. That is what keeps `__GAME.reset()` reproducible
        // however many times a reviewer calls it.
        cupStarted = false;
        pendingGrid = null;
      }
      ownRestart = false;

      cfgNow = { ...cfg };
      ctx.race.time = 0;
      ctx.race.totalLaps = cfg.laps ?? ctx.track?.laps ?? R.laps;
      ctx.race.engineClass = cfg.engineClass;
      ctx.race.finishedCount = 0;
      ctx.race.countdown = R.countdownFrom;
      countdownTimer = 0;
      lastBeat = -1;
      flagT = -1;
      wrapT = -1;
      soloT = 0;
      slowT = -1;
      formT = -1;
      navLatch = 0;
      paused = false;
      winnerTime = 0;
      lastFinishTime = 0;
      startHeld.clear();
      ctx.time.scale = 1;
      book.reset(ctx.racers);
      ensureCup();
      overlay?.reset();
      ctx.audio?.setMusic('auto');

      seatGrid();

      if (cfg.instant) {
        introTimer = 0;
        setPhase('racing');
      } else {
        introTimer = ctx.config.camera.intro.duration;
        formT = 0;
        setPhase('intro');
        ctx.bus.emit('race:intro', {});
        overlay?.card.show({
          cup: cup.state.name,
          round: cup.state.round + 1,
          rounds: cup.state.rounds,
          course: ctx.track?.name ?? '',
          laps: ctx.race.totalLaps,
          engineClass: cfg.engineClass,
        }, Math.max(0.6, introTimer - 1.3));
      }
    },

    fixedUpdate(dt: number): void {
      const race = ctx.race;

      if (ctx.inputState.pressed.pause) togglePause();
      if (paused) {
        if (overlay) menuInput(dt, overlay.pause.menu);
        return;
      }

      switch (race.phase) {
        case 'intro': {
          updateFormation(dt);
          introTimer -= dt;
          if (introTimer <= 0) beginCountdown();
          break;
        }

        case 'countdown': {
          countdownTimer -= dt;
          race.countdown = Math.max(0, Math.ceil(countdownTimer));

          // How long each racer has been holding the throttle, for the start.
          for (const r of ctx.racers) {
            const accel = r.isPlayer ? ctx.inputState.accel : 0;
            if (accel > 0.5) startHeld.set(r.id, (startHeld.get(r.id) ?? 0) + dt);
            else startHeld.delete(r.id);
          }

          if (countdownTimer > 0) {
            beat(race.countdown);
          } else {
            // The flag. Phase first, so the GO that follows lands on the frame
            // the field is allowed to move rather than a beat before it.
            race.countdown = 0;
            setPhase('racing');
            for (const r of ctx.racers) evaluateStart(r);
            lastBeat = 0;
            overlay?.lights.go();
            ctx.bus.emit('race:countdown', { n: 0 });
          }
          break;
        }

        case 'racing': {
          race.time += dt;
          for (const r of ctx.racers) updateProgress(r);
          updateStandings();

          if (flagT >= 0) {
            flagT += dt;
            const allIn = race.finishedCount >= ctx.racers.length;
            if ((allIn && flagT >= FLAG_HOLD) || flagT >= WRAP_LIMIT) toWrap();
          } else if (race.finishedCount >= ctx.racers.length - (ctx.player ? 1 : 0)
                     && !ctx.player?.finished) {
            // Everybody else is home and the player is still circulating. They
            // get a generous window and then the flag comes in anyway.
            soloT += dt;
            if (soloT >= SOLO_LIMIT) toWrap();
          }
          break;
        }

        case 'finished': {
          // The last machines are still rolling to a stop; hold the frame, then
          // bring the sheet in.
          race.time += dt;
          for (const r of ctx.racers) updateProgress(r);
          updateStandings();
          if (wrapT >= 0) {
            wrapT += dt;
            if (wrapT >= RESULTS_DELAY) { wrapT = -1; showResults(); }
          }
          break;
        }

        case 'results': {
          if (overlay) menuInput(dt, overlay.results.menu);
          break;
        }

        default:
          break;
      }
    },

    update(rawDt: number): void {
      const dt = rawDt > 0.1 ? 0.1 : rawDt > 0 ? rawDt : 0;
      updateSlowMo(dt);
      // The overlay integrates its own animation from a sanitised frame delta,
      // for the same reason the HUD does: the realtime loop keeps ticking under
      // the capture harness, so `update` can be handed a delta measured between
      // two different clocks. A blend is a blend and a delta is a delta.
      overlay?.update(dt);
    },

    dispose(): void {
      overlay?.dispose();
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

export type { ResultRow };
