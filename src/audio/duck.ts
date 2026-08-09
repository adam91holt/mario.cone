// The sidechain.
//
// A racing game's mix is two things at once: a *bed* that never stops — eight
// engines and a music loop — and a stream of one-shots that have to punch
// through it. The bed always wins that fight unless something makes room, and
// the thing that makes room is this.
//
// Two lessons are baked into the shape of this file, both of them measured
// rather than assumed.
//
//   **The hole has to open on the transient, not after it.** The previous
//   version drove the duck from a scalar the sound bank had accumulated, read
//   once a frame and applied with `setTargetAtTime`. Two separate lags stacked
//   up: a frame of latency, and a time constant that had been inherited from
//   the music's *fade* setting — 0.14s. A rendered bob-omb measured a 1dB blip
//   followed, 150ms later, by a 5dB dropout: the duck arrived after the
//   explosion had already decayed, so the audible signature of the loudest
//   event in the game was a hole where it used to be. Here the envelope is
//   scheduled on the audio clock at the *exact* time the shot is scheduled, so
//   the two are sample-aligned however late or early the render loop is.
//
//   **The envelope has to be knowable.** WebAudio will not tell you what an
//   AudioParam is worth right now, and a duck that re-triggers has to start
//   from wherever it currently is or it clicks. So the same piecewise-linear
//   envelope that is written into the graph is also modelled here in three
//   numbers, and `valueAt` is exact. That model is what the bench asserts on:
//   "the hole is open inside 20ms" is a fact about this file, checkable
//   without rendering anything.
//
// The threat siren gets a second, slower stage of its own. It is not a
// transient — it is a continuous "something is about to hit you" pressure —
// and running it through the shot envelope would have every frame of it
// re-triggering an attack.

import { clamp01 } from '../core/math.ts';

export interface Ducker {
  /**
   * A one-shot is being scheduled at `at` on the audio clock with 0..1 weight.
   * Call this from the same place, in the same breath, as the voice itself.
   */
  hit(weight: number, at: number): void;
  /** Continuous pressure, 0..1. The incoming-item siren, and nothing else. */
  hold(amount: number): void;
  /** Per frame: settles the slow stage. Cheap, and writes nothing when idle. */
  update(now: number, dt: number): void;
  /** The shot envelope's exact value on a bus, for the bench. */
  valueAt(bus: 'music' | 'engine', t: number): number;
  /** 0..1, how far down the bed is being held right now. Probe only. */
  readonly depth: number;
  dispose(): void;
}

/**
 * The shape of the hole, in seconds.
 *
 * Fast enough that an explosion lands *into* it — 14ms is under one frame at
 * 60fps and comfortably shorter than the 30ms it takes an ear to integrate a
 * transient into a loudness — and short enough overall that the bed is back
 * before the next corner. The hold covers the body of an impact; the release is
 * long enough that the bed rises rather than pops.
 */
const ATTACK = 0.014;
const HOLD = 0.085;
const RELEASE = 0.30;

/**
 * How far each bus is pushed down by a full-weight shot.
 *
 * Deeper on the music than on the engines, which is the opposite of what you
 * might guess and is right for the same reason a film mix rides dialogue over
 * score: the engines *are* the player's instrument panel and going deaf to your
 * own machine for a third of a second costs information, while the music is
 * atmosphere and can afford to disappear. -13dB and -10.5dB respectively.
 */
const MUSIC_DEPTH = 0.78;
const ENGINE_DEPTH = 0.70;

/** The siren's slower, shallower stage. It has to be heard *over* the bed for
 *  a second and a half without the bed ever appearing to pump. */
const HOLD_MUSIC = 0.55;
const HOLD_ENGINE = 0.45;

/** One bus's scheduled envelope, modelled exactly. */
interface Env {
  p: AudioParam;
  /** Start of the current envelope on the audio clock. */
  t0: number;
  /** Value it started from, and the floor it is heading to. */
  v0: number;
  floor: number;
  depth: number;
}

function makeEnv(p: AudioParam, depth: number): Env {
  return { p, t0: -1, v0: 1, floor: 1, depth };
}

/** Exact — this is the same piecewise-linear curve written into the graph. */
function envAt(e: Env, t: number): number {
  if (e.t0 < 0) return 1;
  const dt = t - e.t0;
  if (dt <= 0) return e.v0;
  if (dt < ATTACK) return e.v0 + (e.floor - e.v0) * (dt / ATTACK);
  if (dt < ATTACK + HOLD) return e.floor;
  const r = dt - ATTACK - HOLD;
  if (r < RELEASE) return e.floor + (1 - e.floor) * (r / RELEASE);
  return 1;
}

function strike(e: Env, weight: number, at: number): void {
  const want = 1 - e.depth * weight;
  const cur = envAt(e, at);
  // Never lift an existing duck: a coin landing in the tail of an explosion
  // must not pull the bed back up over the top of it. It only re-arms the
  // hold, which is what makes a burst of hits read as one sustained hole.
  const floor = want < cur ? want : cur;
  const p = e.p;
  p.cancelScheduledValues(at);
  p.setValueAtTime(cur, at);
  p.linearRampToValueAtTime(floor, at + ATTACK);
  p.setValueAtTime(floor, at + ATTACK + HOLD);
  p.linearRampToValueAtTime(1, at + ATTACK + HOLD + RELEASE);
  e.t0 = at;
  e.v0 = cur;
  e.floor = floor;
}

/**
 * Build the sidechain across two gain nodes it does not own.
 *
 * `shotMusic`/`shotEngine` carry the fast transient envelope;
 * `holdMusic`/`holdEngine` carry the siren. Separate nodes rather than one
 * parameter shared between them, because a slow continuous pressure and a
 * 14ms transient cannot be expressed on the same AudioParam without one of
 * them cancelling the other's automation.
 */
export function createDucker(
  shotMusic: GainNode, shotEngine: GainNode,
  holdMusic: GainNode, holdEngine: GainNode,
): Ducker {
  const music = makeEnv(shotMusic.gain, MUSIC_DEPTH);
  const engine = makeEnv(shotEngine.gain, ENGINE_DEPTH);
  let held = 0;
  let heldWritten = -1;
  let clock = 0;

  return {
    hit(weight, at) {
      const w = clamp01(weight);
      if (w < 0.02) return;
      strike(music, w, at);
      strike(engine, w, at);
    },

    hold(amount) {
      const a = clamp01(amount);
      if (a > held) held = a;
    },

    update(now, dt) {
      clock = now;
      // The siren's own release. Falls off by itself so a caller that simply
      // stops reporting a threat gets the bed back rather than a stuck duck.
      held = Math.max(0, held - dt * 1.6);
      if (Math.abs(held - heldWritten) < 0.01) return;
      const rising = held > heldWritten;
      heldWritten = held;
      // Down quickly enough to clear the siren's first tick, back up slowly
      // enough that a threat flickering on and off does not chop the bed.
      holdMusic.gain.setTargetAtTime(1 - HOLD_MUSIC * held, now, rising ? 0.04 : 0.22);
      holdEngine.gain.setTargetAtTime(1 - HOLD_ENGINE * held, now, rising ? 0.04 : 0.22);
    },

    valueAt(bus, t) {
      return envAt(bus === 'music' ? music : engine, t);
    },

    get depth() {
      return 1 - Math.min(envAt(music, clock) * (1 - HOLD_MUSIC * held), 1);
    },

    dispose() {
      try {
        music.p.cancelScheduledValues(0);
        engine.p.cancelScheduledValues(0);
      } catch { /* a context that is already gone is not a problem */ }
    },
  };
}
