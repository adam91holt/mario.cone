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
//   **grid**      The field is seated — by championship order in a cup, with
//                 the human at the back of a fresh one — and drives up into its
//                 slots while the camera sweeps the grid and the course card
//                 names the circuit. Everyone gets a real starting place; nobody
//                 spends the countdown reading "1st".
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
import { clamp01, ease, formatTime, hash1 } from '../core/math.ts';
import { boostRacer } from '../physics/kart.ts';
import { getVehicle } from '../vehicles/registry.ts';
import { coursesInCup, listCourses } from '../track/courses/index.ts';
import { ordinalWord } from '../ui/glyphs.ts';
import { blipColor, FINISH_HOLD, FINISH_WRAP } from '../ui/theme.ts';
import { createCup, createRaceBook, type ResultRow } from './book.ts';
import { createOverlay, type RaceOverlay } from './overlay.ts';
import { FIN_HOLD, FIN_IN, WIPE_COVERED, WIPE_TOTAL } from './stage.ts';
import { formatGap } from './results.ts';
import type { MenuOption } from './menu.ts';
import type {
  CameraMode, GameContext, GameSystem, RaceConfig, Racer, RacePhase, SplineSample,
} from '../types.ts';

/** Seconds of the intro sweep the field spends driving into its slots. */
const FORM_TIME = 1.0;
const FORM_BACK = 11;
const FORM_ROW_STAGGER = 0.06;
/** How long the flag holds before the results sheet is allowed to start. Long
 *  enough that the HUD's own place banner has said its piece and left. */
const FLAG_HOLD = 2.0;
/**
 * ...and the longest the race will wait for the field after the player is in.
 *
 * **Cut to the length of the celebration.** It was fourteen, then six, and both
 * numbers were chosen on the theory that the frame after the flag is worth
 * holding. Measured, it is not: the beat's colour ends at 2.55s (`FIN_TOTAL`),
 * the HUD's gold place banner holds 4.2s and then leaves, the confetti burst is
 * spent — and at flag+5.1s a winning player was looking at a held letterbox
 * over a beige embankment with a stopped machine clipped by the bottom bar. Six
 * seconds on the most important moment in the game, four of them a photograph
 * of a dirt bank.
 *
 * 4.2 covers the beat, plus the second and a half in which a real field
 * genuinely does come home behind a winner (measured on Cone Canyon: +0.058,
 * +0.483, +1.183, +1.241, +1.958, +5.308 on a race driven end to end), and it
 * is stated in `ui/theme.ts` beside the wrap, because the HUD's finishing
 * banner has to hold for their sum or the last second before the curtain is an
 * empty frame. Anyone still out on the circuit is brought in by `toWrap` with a
 * time the sheet labels as an estimate — or, more than a lap out, with no time
 * at all. A race is over when the player's race is over.
 */
const WRAP_LIMIT = FINISH_HOLD;
/** A player still circulating after the whole field is home gets this long. */
const SOLO_LIMIT = 45;
/** Beat between the last machine crossing and the sheet arriving. Short enough
 *  that the curtain starts while the finish banner is still on the frame, so
 *  the hand-off happens *out of* something rather than out of an empty shot. */
const RESULTS_DELAY = FINISH_WRAP;
/** The finish slow-motion, in real seconds: fall, hold, recover. */
const SLOW_FALL = 0.15;
const SLOW_HOLD = 0.55;
const SLOW_RISE = 0.6;
const SLOW_DEPTH = 0.35;
/** Metres of hysteresis on a position change.
 *
 *  Sorting eight racers on a raw distance means two machines running side by
 *  side trade places on millimetres: measured, `racer.place` changed 35 times in
 *  one race, nine of those dwelling under 0.2s and the shortest for 8ms. Nothing
 *  reading that number can tell a pass from noise.
 *
 *  A kart length is what a pass *is* — you are ahead when you are visibly ahead,
 *  and which of two machines running thirty centimetres apart is "fifth" is a
 *  question with no honest answer, so the readout should pick one and hold it.
 *  Because the bias is applied to the racer's *current* place this is true
 *  hysteresis rather than a delay: the order changes on the frame the pass
 *  completes, it just cannot change back for free. Measured against a bunched
 *  eight-car pack, where the progress differences that were flipping sat between
 *  0.8m and 1.5m. */
const PLACE_MARGIN = 1.8;
/** Facing-backwards thresholds: how long a mistake has to last before the sign
 *  comes up, and how quickly it leaves once it is over. A spin-out points the
 *  wrong way for a moment every time and is not a navigation error. */
const WRONG_ON = 0.45;
const WRONG_OFF = 0.22;
/** cos of the angle between travel and the racing direction past which a racer
 *  is going the wrong way — about 110°, so a hard slide is never mistaken for
 *  one. */
const WRONG_DOT = -0.34;
/** Below this, the machine is not really travelling and its heading is noise. */
const WRONG_SPEED = 5;

// ── the start ──────────────────────────────────────────────────────────────
//
// **The window is the last beat, and the reward is for being on the throttle
// when the flag falls — not for stabbing at it.**
//
// This is the one mechanic in the countdown, and the first version of it had
// the sign backwards. It measured the *press* against a quarter-second slot
// ending on the green, so the only way to score was to blip the throttle in the
// last ~0.1s of the count; holding through the final beat — which is Mario
// Kart's actual window, and the thing the light board fills up to tell you to
// do — paid nothing, and holding from the course card, which is what every
// player does the first time, paid 1.2 seconds of immobility with no tell.
// The countdown contained no decision and silently robbed a race.
//
// So the rule is stated in the countdown's own units, and the board draws it:
//
//   held ∈ (0, 1 beat]   the throttle came on during the **last beat** — the
//                        beat where all five bulbs are lit — and is still on at
//                        the flag. Rocket start.
//   held ∈ (1, 2 beats]  early, but not stupid. An ordinary start, no penalty.
//                        The band exists so that "a bit keen" is not a
//                        catastrophe: only one of these two edges may bite.
//   held > 2 beats       on the throttle since before the "2". The engine bogs,
//                        exactly like the real thing — and now says so.
//   held = 0             first press on or after the green. An ordinary start.
//                        Nothing is owed to a player who was not on the throttle
//                        when the race began.
//
// `ROCKET_TOLERANCE` is two fixed steps of slack, so a player who comes on the
// power on the very frame the last bulb lights is inside the window rather than
// two thousandths outside it.
const BEAT = 1.0;
const ROCKET_WINDOW = BEAT + 2 / 120;
const BOG_HOLD = 2 * BEAT;
/** Seconds of bogged engine. Long enough to cost a place, short enough that the
 *  race is not over — the old 0.9 plus the throttle ramp measured out at 1.2s of
 *  dead stop and 33m, which is not a mistake, it is a deletion. */
const BOG_TIME = 0.62;

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

/** See `gridOrder()`. */
const PLAYER_AT_BACK = true;

/** Who is ahead of whom. Hoisted so the per-step sort allocates nothing.
 *
 *  The comparison is on `progress` biased by the racer's *current* place, which
 *  is a total order on a single number (so the sort stays well defined) and is
 *  what makes a position stable: to take a place you must be `PLACE_MARGIN`
 *  metres clear, and once you have taken it the bias is yours. */
function byRunningOrder(a: Racer, b: Racer): number {
  // Finished racers always outrank unfinished ones, earliest first.
  if (a.finished !== b.finished) return a.finished ? -1 : 1;
  if (a.finished && b.finished) return a.finishTime - b.finishTime;
  return (b.progress - b.place * PLACE_MARGIN) - (a.progress - a.place * PLACE_MARGIN);
}

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
  /** Seconds into the hand-off curtain. Negative when it is not running. Race
   *  seconds, so it survives a pause and lands on the same frame every capture;
   *  it keeps running past the point the sheet is built, because the curtain has
   *  to open again on the other side of it. */
  let wipeT = -1;
  /** ...and the same clock for the beat after the player's own crossing. */
  let beatT = -1;
  /** True once the curtain has been closed for this hand-off, so the sheet is
   *  built exactly once. */
  let handedOff = false;
  /** The player's own finishing place, and whether it was worth celebrating.
   *  Zero until they take the flag. */
  let finishPlace = 0;
  /** True when the race was ended from the pause menu. An abandoned race gets
   *  the table; it does not get the ceremony. */
  let abandoned = false;
  /** Wrong-way state for the player. */
  let wrongT = 0;
  let wrongOn = false;
  /** The highest lap each racer has actually completed. Reversing back over the
   *  line rewinds `racer.lap` — which is correct, you are behind the line
   *  again — but it must not be able to *re-award* a lap time on the way back
   *  through. Measured: driving backwards over the line and forwards again
   *  pushed a second split for the same lap. */
  const lapPeak = new Map<number, number>();

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
    racerCount: R.racerCount, seed: 1,
  };
  /** Grid order for the next race, by racer name — championship order, set when
   *  the player advances a round. Null means "seat a fresh race". */
  let pendingGrid: string[] | null = null;
  let cupStarted = false;

  const seats: Seat[] = [];
  const startHeld = new Map<number, number>();
  /** The player's last start, for the reviewer's bench. The one mechanic in the
   *  countdown is a *timing* rule, and a screenshot cannot show a timing rule —
   *  so the number the rule was applied to is published rather than inferred
   *  from how far the kart got. */
  const lastStart: {
    held: number;
    verdict: 'none' | 'ordinary' | 'jumped' | 'rocket' | 'burnout';
    /** 0..1 — where in the last beat the throttle came on. See `rocketQuality`. */
    quality: number;
    tier: 0 | 1 | 2 | 3;
  } = { held: 0, verdict: 'none', quality: 0, tier: 0 };
  let sample: SplineSample | null = null;

  /** True while the front-end (`src/ui/menus`) has a screen up. It publishes
   *  `ui:menu` on both edges; this module stands off the controls — and, since
   *  the standoff in `fixedUpdate`, the whole race — while it is open, rather
   *  than reaching into it. */
  let frontEndOpen = false;
  ctx.bus.on<{ open: boolean }>('ui:menu', ({ open }) => {
    if (open === frontEndOpen) return;
    frontEndOpen = open;
    if (open) {
      if (paused) togglePause();
      return;
    }
    // **Cleared, not restored.** Every way out of the front-end goes through
    // `reset` — launching builds a new race, backing out rebuilds the old one —
    // and both put the field on the grid themselves. Handing back the snapshot
    // this module froze would undo the placement that just happened.
    held.clear();
  });

  const overlay: RaceOverlay | null = createOverlay(ctx, onPick);

  // ── small helpers ────────────────────────────────────────────────────────

  /**
   * The livery colour a results row, a ticker line or a championship chip is
   * painted in.
   *
   * There used to be a duplicate-counting pass here — a field of eight drawn
   * from a cast of seven always contained one machine twice, and this table
   * printed both copies in the same paint. The field is the cast now (see
   * `racerCount` in core/config.ts), so no two entrants share a machine and the
   * machine's own colour is the whole answer.
   */
  const colorOf = (racer: Racer): number =>
    blipColor(getVehicle(racer.vehicleId).colors.primary);

  /**
   * Ask the camera for a *shot*, not a mode.
   *
   * `camera:mode` is the player's own control — chase, far, look-behind — and
   * the race has no business spending it on ceremony (it did, once, and the
   * finish cut to the inside of a building; see `toWrap`). These are the three
   * moments the race can compose better than a follow rig can, stated as
   * requests with everything the rig needs to frame them:
   *
   *   `grid`      during the 3s intro. The field is a staggered 2x4 and the
   *               player is seated last, so a beat that reads *up* the grid from
   *               behind them shows the whole field. `slot` is the player's
   *               grid index, `total` the field size, `back` the metres of grid
   *               ahead of them.
   *   `countdown` the three beats. Back and up in proportion to the grid
   *               standing in front of the player, so the machines they have to
   *               get past are in the frame they spend the count staring at.
   *   `finish`    the player's own crossing. `hold` is how long the move runs,
   *               and it is the same number the beat and the flag window are
   *               cut from.
   *
   * **All three are answered** — `render/camera.ts` subscribes and composes
   * `grid`, `countdown` and `finish`, and reads `finish`'s `hold` as the length
   * of the move rather than keeping a number of its own. They were not, for the
   * whole life of the project, which is why the opening sweep used to fly
   * through the item layer reading the grid backwards. (`podium` was a fourth
   * and is gone: it played its whole length under a results sheet that covers
   * the frame at 97% opacity.)
   */
  function askCamera(shot: string, extra: Record<string, unknown> = {}): void {
    ctx.bus.emit('camera:shot', { shot, ...extra });
  }

  // ── the lens, no longer borrowed ─────────────────────────────────────────
  //
  // This module used to hold a whole borrow-and-return apparatus — three
  // functions, three flags and a paragraph of apology — whose only job was to
  // push `camera:mode` to `near` at the flag and give it back afterwards,
  // because `camera:shot { shot: 'finish' }` went to a module that had never
  // subscribed to it. `camera:mode` is the *player's* channel: a player holding
  // look-behind, or a reviewer who has asked for `overhead`, had the shot
  // silently taken off them, and the borrow had to be unwound on four separate
  // paths to avoid leaving the lens somewhere nobody asked for.
  //
  // `render/camera.ts` answers `finish` now, and the lens the borrow was
  // lending (two metres in, half a metre down, four degrees off the field of
  // view) is folded into `config.camera.victory` where the rest of the move
  // lives. The mode is watched here only so the probe can report it.
  //
  // The reasoning that produced `near` is worth keeping even though the borrow
  // is gone: `far` was tried first and photographed badly, because pulling
  // *back* at a finish hands the middle of the frame to whichever machine
  // happens to be passing, and a player who has just stopped racing is being
  // passed by all of them. At the finish the lens must close in.
  let camMode: CameraMode = 'chase';

  ctx.bus.on<{ mode: CameraMode }>('camera:mode', ({ mode }) => { camMode = mode; });

  function setPhase(phase: RacePhase): void {
    if (ctx.race.phase === phase) return;
    ctx.race.phase = phase;
    // **Except `countdown`.** The per-phase announcement is `race:<phase>`, and
    // for exactly one phase that name is already taken by the beat event that
    // carries `{ n }`. Emitting it here fired a `race:countdown` with no beat in
    // it at the top of every start: the mixer read the missing number as the
    // set-and-hold note and played it two seconds early, and the banner briefly
    // set its numeral to the string "undefined" — saved only by the real beat
    // landing in the same step and overwriting it. Phase watchers use
    // `race:phase`, which everything in the game already listens to.
    if (phase !== 'countdown') ctx.bus.emit(`race:${phase}`, {});
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
   * A standalone race — and round one of a cup — puts the human **last**.
   *
   * This used to be the other way round, on the theory that the opening sweep's
   * first beat sits 11.5m ahead of the player looking back at them and needs the
   * field behind the lens to have anything in it. Photographing the whole start
   * rather than one beat of it says the opposite, twice over:
   *
   *  - The chase rig spends the countdown 7-9m behind the player, and the grid's
   *    rows are 8m apart. On pole, that is *inside the row-2 machine*: for the
   *    entire count the bottom quarter of the frame was a yellow chassis with two
   *    beacons on it. Seated last, the rig sits on open road.
   *  - On pole the player never sees a rival before the flag — every one of them
   *    is behind the lens for the sweep, the count, and the first corner. Seated
   *    last, the sweep's crane beat looks straight down a staggered 2x4 grid, the
   *    count frames seven machines, and the race opens with somewhere to go.
   *
   * Which is also the premise the genre is built on: you start at the back and
   * you carve your way up. Later rounds of a cup override this and line up by
   * championship order, best first — that is what makes leading one worth
   * something, and it is the rule MK8 uses.
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
    // No `race:grid` emit. It carried the seated order into a room that never
    // had anybody in it, and the same order is already on `ctx.race.standings`
    // for anything in the frame and on `__RACE.probe().grid` for anything
    // outside it. An unheard emit costs frame time and makes the event table
    // lie about what the game is.
  }

  /** The player's grid index, pole = 0. -1 before the grid is seated. */
  function playerSlot(): number {
    for (let i = 0; i < seats.length; i++) if (seats[i]!.racer.isPlayer) return i;
    return -1;
  }

  /** Metres of grid in front of the player — how far a lens has to see to hold
   *  the whole field. Zero on pole. */
  function gridDepth(): number {
    const me = playerSlot();
    if (me < 0 || !seats.length) return 0;
    return Math.max(0, seats[0]!.distance - seats[me]!.distance);
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
    // `back` is the metres of grid standing in front of the player: the number a
    // rig needs to know how much road the countdown framing has to hold.
    askCamera('countdown', { slot: playerSlot(), total: seats.length, back: gridDepth() });
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
   * How long each CPU had been on the throttle when the flag fell.
   *
   * Deterministic, and deliberately *not* drawn from `ctx.rng`: the shared
   * stream is consumed by items and by the AI, and taking eight numbers out of
   * it at the start of every race would shift every other module's sequence for
   * a decision no one can see. A hash of the racer's id and the race seed gives
   * the same answer every run without moving anybody else's dice.
   *
   * Same units as the player's, so the field is playing the same game: a value
   * inside the last beat rockets, a value past two beats bogs, anything between
   * is an ordinary start.
   */
  function cpuHold(racer: Racer): number {
    const skill = racer.ai?.skill ?? 0.5;
    const r = hash1(racer.id * 7.919 + (cfgNow.seed ?? 1) * 0.613 + 3.17);
    // About a third of a 150cc field gets it right and one in twenty bogs — a
    // grid where five of seven machines rocket away is not a reward, it is the
    // default, and the player's own start stops meaning anything.
    const pRocket = 0.05 + skill * 0.3;
    const pBog = 0.03 + (1 - skill) * 0.06;
    if (r < pRocket) {
      // Inside the beat, and — now that where in it matters — a better driver
      // sits closer to the flag and varies less. This used to be the other way
      // round, which was harmless while the window paid a flat reward and is not
      // any more: it would have handed the sharpest starts to the worst drivers.
      const centre = 0.42 + skill * 0.5;
      const spread = 0.55 - skill * 0.35;
      return BEAT * Math.min(1, Math.max(0.1, centre + (r / pRocket - 0.5) * spread));
    }
    if (r > 1 - pBog) return BOG_HOLD + 0.4;
    return BEAT * 1.5;
  }

  /**
   * The flag, for one machine. See the note on `BEAT` above for the rule.
   *
   * Both outcomes are announced on the bus in the same breath as they are
   * applied — `race:rocketStart` and `race:burnout` — because a start that only
   * exists as a number in the physics state is a start no player can learn from.
   */
  /**
   * How good a rocket start was, 0..1.
   *
   * The window is the last beat, and *where in it* the throttle came on is the
   * whole skill: holding from the frame the last bulb lit is the answer the
   * light board is drawing, and stabbing at the throttle a tenth of a second
   * before the flag is a guess that happened to land. Until now the two paid
   * exactly the same — measured, holds of 0.95s, 0.60s, 0.35s and 0.15s
   * produced byte-identical speed and boost — so the one mechanic in the
   * countdown had a right answer and no reward for finding it.
   *
   * Quality is the fraction of the last beat the throttle was down for, so a
   * perfect start is worth about sixty per cent more boost than a lucky one and
   * the difference is visible in the first corner. `tier` is the same fact in
   * three steps, for anything that would rather say it in words.
   */
  function rocketQuality(held: number): number {
    return clamp01(held / BEAT);
  }
  function rocketTier(q: number): 1 | 2 | 3 {
    return q >= 0.8 ? 3 : q >= 0.45 ? 2 : 1;
  }

  function evaluateStart(racer: Racer): void {
    const held = racer.isPlayer ? (startHeld.get(racer.id) ?? 0) : cpuHold(racer);
    if (racer.isPlayer) {
      lastStart.held = held;
      lastStart.verdict = 'ordinary';
      lastStart.quality = 0;
      lastStart.tier = 0;
    }
    if (held > 0 && held <= ROCKET_WINDOW) {
      const q = rocketQuality(held);
      const tier = rocketTier(q);
      const time = R.rocketStart.boost.time * (0.55 + 0.45 * q);
      const power = R.rocketStart.boost.power * (0.72 + 0.28 * q);
      if (racer.isPlayer) {
        lastStart.verdict = 'rocket';
        lastStart.quality = q;
        lastStart.tier = tier;
        // The top tier is a *narrow* target, so landing it is worth a frame of
        // its own even before anybody writes a word about it.
        if (tier === 3) ctx.fx?.flash(0xFFD84D, 0.34);
      }
      boostRacer(ctx, racer, 'rocketStart', time, power);
      ctx.bus.emit('race:rocketStart', { racer, held, quality: q, tier, time, power });
    } else if (held > ROCKET_WINDOW && held <= BOG_HOLD) {
      // The band between the two edges. It is deliberately unpunished — only one
      // of the two mistakes may bite — but it used to be *silent*, which meant a
      // full second of the countdown where the player's input did nothing and
      // the game never said why. Now it says why.
      if (racer.isPlayer) {
        lastStart.verdict = 'jumped';
        overlay?.verdict.show('JUMPED', 'NO ROCKET START', 'mild');
      }
      ctx.bus.emit('race:jumpstart', { racer, held });
    } else if (held > BOG_HOLD) {
      if (racer.isPlayer) lastStart.verdict = 'burnout';
      // On the power since before the "2": the engine bogs, exactly like the
      // real thing. `duration` is published so the smoke and the strangled
      // engine note can last as long as the penalty does instead of guessing.
      racer.stunned = Math.max(racer.stunned, BOG_TIME);
      ctx.bus.emit('race:burnout', { racer, held, duration: BOG_TIME });
      if (racer.isPlayer) {
        overlay?.verdict.show('TOO EARLY', 'ENGINE BOGGED');
        ctx.fx?.shake(0.4, 0.55);
      }
    }
  }

  // ── laps and places ──────────────────────────────────────────────────────

  function updateProgress(racer: Racer, dt: number): void {
    const track = ctx.track;
    if (!track) return;
    const L = track.length;
    const d = lapDistance(track.spline.nearest(racer.pos, sample ?? undefined).distance);

    const prev = racer.progress - racer.lap * L;
    // A jump of more than half the lap can only be the line wrapping, which is
    // unambiguous at kart speeds.
    let delta = d - prev;

    if (delta > L * 0.5) {
      // Reversed back over the line. The lap goes with it — you are behind the
      // line again — but never past the grid's own -1, or `progress` walks off
      // into a lap that never existed.
      if (racer.lap > -1) racer.lap--;
      delta -= L;
    } else if (delta < -L * 0.5) {
      racer.lap++;
      delta += L;
      // Racers start at lap -1 on the run-up to the line, so lap 0 is the first
      // crossing and does not score a lap time. A lap is only *scored* the first
      // time it is reached: see `lapPeak`.
      if (racer.lap >= 1 && racer.lap > (lapPeak.get(racer.id) ?? 0)) {
        lapPeak.set(racer.id, racer.lap);
        racer.lapTimes.push(ctx.race.time);
        const { split, best } = book.lap(racer, ctx.race.time);
        ctx.bus.emit('race:lap', { racer, lap: racer.lap, split });
        if (best) {
          ctx.bus.emit('race:bestlap', { racer, time: split, lap: racer.lap });
          // Only worth saying out loud once there is a lap to have beaten.
          if (racer.isPlayer && racer.lap >= 2) {
            overlay?.note.show('BEST LAP', formatTime(split));
          }
        }
        // The final lap. Stated by `race:lap` and nothing else: `lap` is in that
        // payload and the mixer already lifts the fanfare off it, so the second
        // announcement this used to make was one nobody ever subscribed to.
        if (racer.lap === ctx.race.totalLaps - 1 && racer.isPlayer) {
          ctx.fx?.flash(0xFF6B1A, 0.3);
        }
      }
      if (racer.lap >= ctx.race.totalLaps && !racer.finished) finishRacer(racer, false);
    }

    // **Rate-limited, because `nearest()` is a search and searches snap.**
    //
    // `progress` is the sorting key for the entire field, and it is derived from
    // the closest point on the spline to a kart — which is not a continuous
    // function of position. Measured over ninety seconds of an eight-car race it
    // moved by more than four times the distance the kart could have travelled
    // seventy-nine times, once by 31.6 metres in a single 8ms step: a lateral
    // hop between two stations of the spline, not a kart teleporting. Every one
    // of those is a position readout jumping several places and coming straight
    // back.
    //
    // So the step is bounded by what the machine could actually have covered,
    // with a floor so a stationary kart being shoved still has room. It is a
    // limiter and not a clamp — the moment the search settles, the next steps
    // close the gap at four times racing speed, so nothing is permanently lost.
    const limit = Math.max(Math.abs(racer.speed), 12) * dt * 4 + 1.5;
    if (delta > limit) delta = limit;
    else if (delta < -limit) delta = -limit;
    racer.progress += delta;
  }

  /**
   * The one instruction the circuit gives that the game used to give silently.
   *
   * It is a *travel* test, not a heading one: a slide, a spin-out or a bump can
   * point a machine backwards for half a second and none of them are navigation
   * errors, but a kart whose velocity is more than 110° off the racing direction
   * for half a second is driving at the field. Measured on the edges only, so a
   * siren can be started and stopped without polling.
   */
  function updateWrongWay(dt: number): void {
    const track = ctx.track;
    const p = ctx.player;
    let bad = false;
    if (track && p && !p.finished && !paused) {
      const s = track.spline.nearest(p.pos, sample ?? undefined);
      const vx = p.vel.x, vz = p.vel.z;
      const sp = Math.hypot(vx, vz);
      if (sp > WRONG_SPEED) {
        bad = (vx * s.tangent.x + vz * s.tangent.z) / sp < WRONG_DOT;
      }
    }
    wrongT = bad ? wrongT + dt : Math.max(0, wrongT - dt * (WRONG_ON / WRONG_OFF));
    const on = wrongOn ? wrongT > 0 : wrongT >= WRONG_ON;
    if (on !== wrongOn) {
      wrongOn = on;
      overlay?.wrongWay.set(on);
      ctx.bus.emit('race:wrongway', { racer: p, on });
    }
    if (wrongOn && wrongT > WRONG_ON) wrongT = WRONG_ON;
  }

  function clearWrongWay(): void {
    wrongT = 0;
    if (!wrongOn) return;
    wrongOn = false;
    overlay?.wrongWay.set(false);
    ctx.bus.emit('race:wrongway', { racer: ctx.player, on: false });
  }

  /**
   * How many whole laps behind the leader a racer was when the flag came in for
   * them. Zero for anyone who actually completed the distance.
   *
   * A results sheet is allowed to *estimate* a time for a machine the flag came
   * in on. It is not allowed to estimate one for a machine that was still two
   * laps out — that is not a close finish rendered approximately, it is a
   * fiction, and it is what turned the eighth row into "+1:34.396" as though
   * somebody had timed it. Real racing prints "+1 LAP".
   */
  function lapsDown(racer: Racer): number {
    // `racer.lap` is laps *completed*, so a machine on the final lap of three
    // reads 2 and is not a lap down — it is on the lead lap and simply behind.
    // One less than the total is therefore the datum, not the total.
    return Math.max(0, ctx.race.totalLaps - 1 - Math.max(0, racer.lap));
  }

  function finishRacer(racer: Racer, estimated: boolean): void {
    if (racer.finished) return;
    racer.finished = true;
    // **No fabricated ladder.**
    //
    // This used to clamp every estimate to `lastFinishTime + 0.08`, and because
    // a comfortable win force-finishes the whole remaining field inside one
    // frame, the clamp — not the estimate — is what decided the times: the
    // published review sheet read +0.080 / +0.160 / +0.240 / +0.320 / +0.400
    // / +0.480 / +0.560 straight down all seven rows. Seven machines strung out
    // over a kilometre of canyon, printed as a metronome.
    //
    // `estimateFinish` stands on its own now. The ordering it has to agree with
    // is guaranteed at the callers instead — both of them force-finish in
    // estimate order — and the epsilon below is only a tie-break for two
    // machines whose estimates land on the same thousandth, not a spacing.
    racer.finishTime = estimated
      ? Math.max(estimateFinish(racer), lastFinishTime + 0.001)
      : ctx.race.time;
    lastFinishTime = racer.finishTime;
    ctx.race.finishedCount++;
    const place = ctx.race.finishedCount;
    if (place === 1) winnerTime = racer.finishTime;
    book.finish(racer, place, racer.finishTime, estimated, estimated ? lapsDown(racer) : 0);
    // `podium` is redundant with `place` and is published anyway: every consumer
    // of this event has to answer the same question — is this a result worth
    // celebrating — and one of them was still firing a full confetti burst and a
    // gold starburst on a fifth-of-eight because reading `place` was one more
    // step than reading `racer`.
    ctx.bus.emit('race:finish', {
      racer, place, time: racer.finishTime, podium: place >= 1 && place <= 3,
    });

    if (racer.isPlayer) beginFlag(place);
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

  /**
   * One line of the field coming home.
   *
   * **Never the player.** The HUD slams a gold plate across the middle of the
   * frame reading `1ST PLACE 2:27.591` on the same beat; a dark plate two
   * hundred pixels to its left reading `1ST | FOREMAN` is the same statement in
   * a second visual language, and the finish was making it twice. The banner
   * keeps it — it is the bigger object and it carries the time — and this list
   * is what it always should have been: the machines still arriving behind you.
   */
  function tickerAdd(racer: Racer, place: number): void {
    if (racer.isPlayer) return;
    const gap = place > 1 ? Math.max(0, racer.finishTime - winnerTime) : 0;
    overlay?.ticker.add({
      place,
      suffix: ordinalWord(place),
      name: racer.name,
      gap: gap > 0 ? `+${formatGap(gap)}` : '',
      color: colorOf(racer),
    });
  }

  /** Reused by `updateStandings`, which runs every fixed step: a fresh array and
   *  a fresh comparator 120 times a second is the definition of an allocation in
   *  a hot path. */
  const order: Racer[] = [];

  function updateStandings(): void {
    order.length = 0;
    for (const r of ctx.racers) order.push(r);
    order.sort(byRunningOrder);
    const standings = ctx.race.standings;
    standings.length = 0;
    for (let i = 0; i < order.length; i++) {
      order[i]!.place = i + 1;
      standings.push(order[i]!.id);
    }
  }

  // ── the flag ─────────────────────────────────────────────────────────────

  /**
   * The player's own crossing. **The two and a half seconds after it belong to
   * this function**, and the race carries on underneath them.
   *
   * What lands, all of it keyed off the one number that decides what the race
   * meant — the place:
   *
   *   *time*    drops to a third over a sixth of a second and comes back over
   *             six tenths. The crossing is the one frame in a race that is
   *             worth looking at, and until now the game drove straight past it.
   *   *lens*    a composed shot on `camera:shot`, answered by
   *             `render/camera.ts`. The ask carries the place and the podium
   *             flag, so a fourth is framed differently from a win.
   *   *frame*   letterbox bars, and then either a warm, saturated, gold-swept
   *             picture or a cold, drained, closing one. A still from a podium
   *             finish and a still from fifth are not the same photograph any
   *             more, which is the whole of the complaint.
   *   *sound*   the mixer already branches on place; it is only told earlier.
   *
   * An abandoned race — "END RACE" from the pause menu — skips every bit of it.
   * Quitting is not a result.
   */
  function beginFlag(place: number): void {
    if (flagT >= 0) return;
    flagT = 0;
    finishPlace = place;
    const podium = place >= 1 && place <= 3;

    if (!abandoned) {
      slowT = 0;
      slowBase = ctx.time.scale;
      slowWrote = -1;
      ctx.fx?.flash(podium ? 0xFFF3C4 : 0xE6EEF8, podium ? 0.46 : 0.3);
      overlay?.finish.arm(place, podium);
      beatT = 0;
      // Everything the rig needs to frame the crossing. Answered.
      askCamera('finish', {
        racerId: ctx.player?.id ?? 0,
        place,
        podium,
        hold: 2.55,
        /** Metres past the line the machine will be when the shot settles. */
        lead: Math.abs(ctx.player?.speed ?? 0) * 0.6,
      });
    }

    // The race is decided; the mixer should not wait for the last CPU to trundle
    // home before it says so. `setMusic` is the audio module's own front door.
    ctx.audio?.setMusic('victory', { fade: 0.9 });
    // Read the order home from the top, including the machines that beat us.
    const done = ctx.racers.filter((r) => r.finished)
      .sort((a, b) => a.finishTime - b.finishTime);
    for (let i = 0; i < done.length; i++) tickerAdd(done[i]!, i + 1);
  }

  /**
   * Slow-motion across the line: to `SLOW_DEPTH` over `SLOW_FALL`, held, back
   * over `SLOW_RISE`.
   *
   * **It is a multiplier on whatever the outside world asked for, not a value.**
   * `time.scale` has a second writer that matters more than this one: the
   * harness's freeze, `__GAME.setTimeScale(0)`, which is how every frame-by-frame
   * capture in the project holds the world still.
   *
   * The previous version handled that by *standing down* the moment it found a
   * number it had not written — which is why a reviewer who froze the clock and
   * then drove a whole race concluded, correctly from what they could measure,
   * that this ramp does not exist: their freeze cancelled it on the first frame
   * and the only write they ever saw was the 1 the results transition puts back.
   *
   * So the ramp keeps a `slowBase` and writes `base * ramp`. A freeze stays
   * frozen — 0 × anything is 0 — a reviewer who sets 0.5 gets half of a
   * slow-motion finish rather than none of one, and the ramp itself is published
   * on `__RACE.probe().slow` so it can be read at any point in the beat without
   * having to infer it from the number it multiplies. Anything that changes the
   * scale mid-ramp is adopted as the new base rather than treated as a coup.
   */
  let slowWrote = -1;
  let slowBase = 1;
  /** The ramp's own value, 1 when it is not running. Published, not inferred. */
  let slowRamp = 1;

  function updateSlowMo(dt: number): void {
    if (slowT < 0) return;
    // Somebody else moved the clock: keep the beat, adopt their number.
    if (slowWrote >= 0 && Math.abs(ctx.time.scale - slowWrote) > 1e-4) {
      slowBase = slowRamp > 1e-4 ? ctx.time.scale / slowRamp : ctx.time.scale;
    }
    slowT += dt;
    if (slowT < SLOW_FALL) {
      slowRamp = 1 - (1 - SLOW_DEPTH) * ease.outQuad(slowT / SLOW_FALL);
    } else if (slowT < SLOW_FALL + SLOW_HOLD) {
      slowRamp = SLOW_DEPTH;
    } else {
      const u = clamp01((slowT - SLOW_FALL - SLOW_HOLD) / SLOW_RISE);
      slowRamp = SLOW_DEPTH + (1 - SLOW_DEPTH) * ease.inOutCubic(u);
      if (u >= 1) {
        slowT = -1; slowWrote = -1; slowRamp = 1;
        ctx.time.scale = slowBase;
        return;
      }
    }
    ctx.time.scale = slowBase * slowRamp;
    slowWrote = ctx.time.scale;
  }

  /** Unwind the ramp without stamping on a clock somebody else owns. */
  function endSlowMo(): void {
    if (slowT >= 0 || slowWrote >= 0) ctx.time.scale = slowBase;
    slowT = -1;
    slowWrote = -1;
    slowRamp = 1;
  }

  // ── results ──────────────────────────────────────────────────────────────

  /**
   * Open a championship over the cup the current circuit belongs to.
   *
   * **The circuit the player chose decides which round this is.** It did not,
   * and the two halves of the game said different things about it inside one
   * second: the front-end's launch card printed the chosen circuit's index in
   * the cup ("ROUND 3 OF 4", third of four pips lit) and `begin()` here
   * unconditionally set round 0, so the course card on the grid a beat later
   * said 1/4. Worse, `cup.courseId()` is `courseIds[round]`, so NEXT RACE after
   * a race started on Saltpan sent the player to Jackhammer — skipping Cone
   * Canyon and queueing Saltpan again later in the same championship.
   *
   * A cup is its registry order and nothing else, so entering it on the third
   * circuit means entering at round three. All three screens that state a round
   * — the circuit card's brief, the launch card, the grid's course card — now
   * read the same number off the same list, and `advance()` walks forward
   * through it in order.
   *
   * `rounds` is the list's own length rather than a hardcoded 4, so a fifth
   * circuit added to a cup lengthens the championship without a line changing.
   */
  function ensureCup(): void {
    if (cupStarted) return;
    const cupId = ctx.track?.course.cup ?? 'hazard';
    const inCup = coursesInCup(cupId);
    const list = (inCup.length ? inCup : listCourses().slice()).map((c) => c.id);
    cup.begin(cupId, cupTitle(cupId), list, list.length);
    const at = list.indexOf(cfgNow.courseId);
    if (at > 0) cup.state.round = at;
    cupStarted = true;
  }

  function cupTitle(id: string): string {
    return `${id.replace(/[-_]/g, ' ')} cup`.toUpperCase();
  }

  function toWrap(): void {
    if (ctx.race.phase === 'finished' || ctx.race.phase === 'results') return;
    // Stragglers come home in the order their own estimates put them in, not in
    // the order the field happens to be stored in — and not in progress order
    // either. Sorting on progress and then printing a time derived from
    // progress *and pace* is how the table ends up contradicting itself, and
    // the old answer to that was a clamp that fabricated an even 80ms ladder
    // down the sheet. Sort on the number that is actually printed and the two
    // agree by construction.
    const left = ctx.racers.filter((r) => !r.finished)
      .sort((a, b) => estimateFinish(a) - estimateFinish(b));
    for (const r of left) finishRacer(r, true);
    updateStandings();
    clearWrongWay();
    setPhase('finished');
    wrapT = 0;
    // **No mode change here.**
    //
    // This used to ask for `cinematic`, and the ask was answered honestly and
    // looked terrible: that mode is a trackside orbit whose angle is derived
    // from `time.elapsed`, so it cut — hard, a quarter-second after the flag —
    // to whatever bearing the clock happened to land on. Photographed, that was
    // twice a lens outside the barriers with the player a forty-pixel speck cut
    // in half by the armco, and once the inside of a building. It is also the
    // one mode the rig's ground-clearance and occlusion handling skips.
    //
    // The chase rig already has a *victory* move for this moment — it arms on
    // `race:finish` — and it keeps the machine in frame. So the flag keeps the
    // camera it was shot on, and the ask for a real end-of-race lens is in the
    // report rather than in a mode that makes the shot worse.
    ctx.bus.emit('race:results', {
      standings: ctx.race.standings.slice(),
      rows: book.rows(R.points, colorOf),
    });
  }

  /**
   * The hand-off. **Three live layers become one, behind a closed curtain.**
   *
   * Photographed a second before the sheet arrived, this game had the HUD's
   * fading place banner sliced in half by an incoming results row while the
   * in-race ticker's gaps floated inside rows they did not belong to. Every one
   * of those is the same bug: two interfaces cross-fading through each other,
   * because a results sheet that fades *up* is transparent for exactly as long
   * as it takes to arrive.
   *
   * So nothing cross-fades. A curtain closes, and while the frame is covered the
   * race's own furniture is torn down, the lens is given back, and the sheet is
   * built. The curtain opens on a screen with one thing on it. The HUD's own
   * layers get `race:handoff` on the same frame, which is the only thing this
   * module can do about furniture it does not own.
   */
  function beginHandoff(): void {
    if (wipeT >= 0 || ctx.race.phase === 'results') return;
    wipeT = 0;
    handedOff = false;
    // Skip the beat straight to its exit, wherever it had got to.
    if (beatT >= 0) beatT = Math.max(beatT, FIN_IN + FIN_HOLD);
    overlay?.ticker.retire();
    overlay?.note.reset();
    overlay?.verdict.reset();
    clearWrongWay();
    ctx.bus.emit('race:handoff', { to: 'results' });
  }

  function showResults(): void {
    handedOff = true;
    beatT = -1;
    const rows = book.rows(R.points, colorOf);
    ensureCup();
    cup.apply(rows);
    setPhase('results');
    // **No shot is asked for here.** There was one — `podium`, the winner
    // orbited behind the sheet — and `render/camera.ts` answered it in full,
    // under a results sheet that covers the frame from edge to edge at 97%
    // opacity. See the note where that shot used to live. The lens keeps the
    // finish orbit, which the player actually sees.
    endSlowMo();
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
      playerSplits: ctx.player ? book.splitsOf(ctx.player) : [],
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
      // Abandoning a race gets the table. It does not get the ceremony: no
      // slow-motion, no letterbox, no gold. See `beginFlag`.
      if (id === 'quit') { abandoned = true; togglePause(); toWrap(); return; }
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
      // The front-end owns what happens after a race, and it published a door
      // for exactly this: `ui:menu:open` raises the character-select screen.
      // (There used to be a `race:exit` alongside it "for anyone else who wants
      // to know". Nobody ever did.)
      if ((ctx.bus.inspect()['ui:menu:open'] ?? 0) > 0) {
        ctx.bus.emit('ui:menu:open', { from: 'results' });
        return;
      }
      // No front-end in this build: the only honest exit is a fresh cup.
      cupStarted = false;
      pendingGrid = null;
      restart({ ...cfgNow, seed });
    }
  }

  // ── pause ────────────────────────────────────────────────────────────────

  /**
   * Hold the field still.
   *
   * Taking the phase out of `racing` stops every system from *driving* the
   * karts — physics zeroes their inputs, the AI stands down, the reels stop —
   * but a kart is not a thing that stops when you stop pushing it: physics
   * still integrates the velocity it already had, so a pause taken at 70 m/s
   * left the whole field gliding silently down the road behind the menu.
   * Measured; it is the reason this exists.
   *
   * The transform is stashed on the frame the game stops and rewritten after
   * physics each step, which is the same seam the grid drive-in uses. Nothing
   * else may write these while the phase is not `racing`.
   */
  interface Held { pos: THREE.Vector3; vel: THREE.Vector3; speed: number }
  const held = new Map<number, Held>();

  function holdField(): void {
    held.clear();
    for (const r of ctx.racers) {
      held.set(r.id, { pos: r.pos.clone(), vel: r.vel.clone(), speed: r.speed });
    }
  }

  function keepFieldStill(): void {
    for (const r of ctx.racers) {
      const h = held.get(r.id);
      if (!h) continue;
      r.pos.copy(h.pos);
      r.prevPos.copy(h.pos);
      r.vel.set(0, 0, 0);
      r.speed = 0;
    }
  }

  function releaseField(): void {
    for (const r of ctx.racers) {
      const h = held.get(r.id);
      if (!h) continue;
      r.pos.copy(h.pos);
      r.prevPos.copy(h.pos);
      r.vel.copy(h.vel);
      r.speed = h.speed;
    }
    held.clear();
  }

  /**
   * Pausing is for a race that is actually being driven.
   *
   * Not `finished` and not `results`: the front-end takes the pause key on
   * both of those to bring itself back up, and two modules answering the same
   * key is how a player ends up in a paused race behind a title screen. Not
   * while that front-end is open either — its own screens are already a menu,
   * and this one would be listening for the same stick underneath it.
   */
  function canPause(): boolean {
    if (frontEndOpen) return false;
    const p = ctx.race.phase;
    return p === 'intro' || p === 'countdown' || p === 'racing';
  }

  function togglePause(): void {
    if (paused) {
      paused = false;
      releaseField();
      overlay?.pause.hide();
      setPhaseQuiet(resumePhase);
      ctx.bus.emit('race:pause', { on: false });
      return;
    }
    if (!canPause()) return;
    paused = true;
    resumePhase = ctx.race.phase;
    holdField();
    // An alarm that carries on strobing behind a menu is an alarm about nothing.
    clearWrongWay();
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
      // A seek is a cut, not a hand-off: no curtain, no ceremony to tear down.
      beatT = -1;
      wipeT = -1;
      overlay?.finish.reset();
      overlay?.finish.at(-1, -1);
      overlay?.ticker.clear();
      clearWrongWay();
      showResults();
      // A seek is not a finish: nothing should be left running in slow motion.
      // Only *our* ramp is unwound — a reviewer who froze the clock and then
      // seeked keeps their freeze.
      endSlowMo();
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
        /** The player's start: seconds the throttle was held into the flag, and
         *  what that bought. `held` is in countdown beats — 1 beat or less is
         *  the rocket window, over two is a burnout. */
        start: {
          held: +lastStart.held.toFixed(3),
          verdict: lastStart.verdict,
          /** 0..1 — where in the last beat the throttle came on. */
          quality: +lastStart.quality.toFixed(3),
          tier: lastStart.tier,
        },
        flag: +flagT.toFixed(2),
        timeScale: +ctx.time.scale.toFixed(3),
        /** The finish slow-motion, stated rather than inferred. `ramp` is what
         *  the effect is doing; `scale` is that multiplied by whatever the
         *  outside world last asked the clock to run at, which is the number
         *  actually in `time.scale`. A frozen reviewer sees ramp move and scale
         *  stay at zero — both true. */
        slow: {
          running: slowT >= 0,
          t: +Math.max(0, slowT).toFixed(3),
          ramp: +slowRamp.toFixed(3),
          base: +slowBase.toFixed(3),
        },
        /** The player's own crossing, and which of the two endings it played. */
        finish: {
          place: finishPlace,
          podium: finishPlace >= 1 && finishPlace <= 3,
          beat: beatT >= 0,
          abandoned,
        },
        handoff: { wipe: +wipeT.toFixed(3), beat: +beatT.toFixed(3), done: handedOff },
        wrongWay: wrongOn,
        camera: { mode: camMode },
        finished: book.finishedCount(),
        /** The order the field was seated in, pole first. */
        grid: seats.map((s) => s.racer.name),
        places: ctx.racers.slice().sort((a, b) => a.place - b.place).map((r) => r.name),
        rows: book.rows(R.points, colorOf),
        best: (() => { const f = book.fastest(); return { name: f.racer?.name ?? '', time: +f.time.toFixed(3) }; })(),
        cup: cup.state,
        menu: overlay?.results.visible ? overlay.results.menu.current()
          : overlay?.pause.visible ? overlay.pause.menu.current() : null,
      }),
      pause: (on?: boolean): void => { if (on === undefined || on !== paused) togglePause(); },
      /**
       * Take the flag, now, in a chosen place.
       *
       * The finish is a *branch* — a podium and a fourth are two different two
       * and a half seconds — and neither of them is reachable by driving unless
       * the reviewer can also make the field beat them by exactly the right
       * margin. So both are put behind a door, the same way the results sheet
       * and the pause menu are. It runs the real path: the machines ahead are
       * finished first, then the player, through `finishRacer`.
       */
      flag: (place = 1): number => {
        const player = ctx.player;
        if (!player || player.finished) return 0;
        if (ctx.race.phase !== 'racing') setPhase('racing');
        const want = Math.max(1, Math.min(ctx.racers.length, Math.floor(place)));
        const ahead = ctx.racers
          .filter((r) => !r.isPlayer && !r.finished)
          .sort((a, b) => estimateFinish(a) - estimateFinish(b));
        for (let i = 0; i < want - 1 && i < ahead.length; i++) finishRacer(ahead[i]!, true);
        finishRacer(player, true);
        updateStandings();
        return ctx.race.finishedCount;
      },
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
      /**
       * Put the championship on a given round, so the *last* results sheet — the
       * one that crowns a cup — is reachable without driving four Grands Prix.
       * A round at or past the last one makes the next sheet the final one.
       * Pure presentation: the cup has no effect on the simulation.
       */
      cupRound: (n: number): number => {
        ensureCup();
        cup.state.round = Math.max(0, Math.min(cup.state.rounds - 1, Math.floor(n)));
        return cup.state.round;
      },
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
      slowWrote = -1;
      slowBase = 1;
      slowRamp = 1;
      wipeT = -1;
      beatT = -1;
      handedOff = false;
      finishPlace = 0;
      abandoned = false;
      wrongT = 0;
      wrongOn = false;
      lapPeak.clear();
      formT = -1;
      navLatch = 0;
      // **The pause has to be *lifted*, not just forgotten.** ARCHITECTURE §11a
      // tells every consumer to stand off on the `race:pause` edges, and this
      // line used to drop `paused` on the floor without announcing it — so a
      // player who paused and chose RESTART got a running race with the mixer
      // still ducked and the CONTROLS card welded fully opaque over the frame
      // for the rest of it. Reproduced: `{ cardOpacity: "1", phase: "racing" }`.
      // An edge contract with a silent exit is not a contract.
      if (paused) {
        paused = false;
        ctx.bus.emit('race:pause', { on: false });
      }
      winnerTime = 0;
      lastFinishTime = 0;
      startHeld.clear();
      lastStart.held = 0;
      lastStart.verdict = 'none';
      lastStart.quality = 0;
      lastStart.tier = 0;
      held.clear();
      // The camera module puts its own mode back to `chase` in its reset, so
      // this only re-syncs the copy the probe reports — emitting here would
      // fight a reviewer who set a mode between races.
      camMode = 'chase';
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
        askCamera('grid', {
          slot: playerSlot(),
          total: seats.length,
          back: gridDepth(),
        });
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
        keepFieldStill();
        if (overlay) menuInput(dt, overlay.pause.menu);
        return;
      }

      /**
       * **A race does not run behind the front-end.**
       *
       * `boot()` in main.ts starts a race *before* the title screen is raised —
       * the menus need a built world to stage themselves against — and nothing
       * here stood that race down. So from the first frame of a cold load the
       * field rolled itself into formation, the lights ran, the flag dropped
       * and seven AI drivers raced a full three laps, all underneath a
       * wordmark. Reported from an iPhone as "it just starts moving the car
       * before the countdown", which is the formation approach in `intro`,
       * seen by a player who had not been let in yet and — on that build — had
       * no controls to answer it with.
       *
       * `frontEndOpen` was already tracked here for `canPause`. This is the
       * same fact spent on the thing it was always describing: while a screen
       * is up, the phase machine does not tick and the field does not move.
       * The snapshot is taken on the first held step rather than on the `open`
       * edge, because that edge fires from inside `engine.resetAll()` and the
       * grid placement it should be freezing may not have run yet.
       */
      if (frontEndOpen) {
        if (held.size === 0) holdField();
        keepFieldStill();
        return;
      }

      // The two ceremony clocks. Phase-independent on purpose: the beat begins
      // in `racing`, runs through `finished`, and the curtain it hands over to
      // has to keep opening once the phase is already `results`.
      if (beatT >= 0) {
        // **Not cleared at `FIN_TOTAL`.** The colour of the beat ends there;
        // the letterbox it opened does not. See the note on `FIN_IN` in
        // stage.ts — this clock now runs from the player's crossing to the
        // hand-off, and it is what holds a composed frame over the seconds the
        // rest of the field is still coming home. `showResults` clears it,
        // behind a closed curtain, which is the only place a letterbox may
        // vanish.
        beatT += dt;
      }
      if (wipeT >= 0) {
        wipeT += dt;
        // The sheet is built the moment the frame is covered, and not before.
        if (!handedOff && wipeT >= WIPE_COVERED) showResults();
        if (wipeT >= WIPE_TOTAL) wipeT = -1;
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
          for (const r of ctx.racers) updateProgress(r, dt);
          updateStandings();
          updateWrongWay(dt);

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
          // close the curtain and bring the sheet in behind it.
          race.time += dt;
          for (const r of ctx.racers) updateProgress(r, dt);
          updateStandings();
          if (wrapT >= 0) {
            wrapT += dt;
            if (wrapT >= RESULTS_DELAY) { wrapT = -1; beginHandoff(); }
          }
          break;
        }

        case 'results': {
          if (overlay && !frontEndOpen) menuInput(dt, overlay.results.menu);
          break;
        }

        default:
          break;
      }
    },

    update(rawDt: number): void {
      const dt = rawDt > 0.1 ? 0.1 : rawDt > 0 ? rawDt : 0;
      updateSlowMo(dt);
      // The one widget drawn from the race's clock rather than the frame's —
      // see `FinishBeat.at`. Its two clocks are integrated in `fixedUpdate`;
      // this only paints them.
      overlay?.finish.at(beatT, wipeT);
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
