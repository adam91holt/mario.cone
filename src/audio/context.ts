// The audio backend: the WebAudio context, the mix buses, and the rule that
// none of it may ever exist before the player has touched the page.
//
// Two constraints shape this file.
//
//   Browsers block audio until a user gesture. Constructing an AudioContext
//   before one does not merely fail — it prints "The AudioContext was not
//   allowed to start" to the console, and this project's definition of done is
//   a clean console. So the context is not created at boot. It is created
//   *inside* the first gesture handler, at which point it starts running
//   immediately and nothing is ever suspended, resumed or warned about.
//
//   The capture harness runs headless with no audio device and asserts on
//   console output. Every entry point here therefore returns null or no-ops
//   rather than throwing, and the whole module simply never comes into
//   existence in that environment: no context, no nodes, no cost, no noise.
//
// The bus layout is deliberately conventional — music, sfx and engine into a
// master, a parallel convolution send, one limiter across the lot — because the
// interesting work in this module is the synthesis, and a mixer that surprises
// anyone is a mixer that is wrong.

import { impulseResponse, noiseBuffer } from './dsp.ts';
import { createDucker } from './duck.ts';
import type { Ducker } from './duck.ts';

/**
 * Headroom. The single most important pair of numbers in the mixer.
 *
 * A fixed trim on each of the two *sustained* buses, downstream of their
 * faders, so it is a property of the desk rather than of the volume control.
 *
 * The reason it exists is a measurement. With the engines and the music
 * running at the level a bed wants to be heard at, the whole mix sat at
 * -15.3dBFS RMS and a bob-omb — the loudest single event in the game — peaked
 * at -14.2dBFS. Net gain over the bed: 1.3dB, which is less than the
 * difference between two ordinary frames of engine noise. The explosion was
 * not too quiet. There was simply nowhere left above the bed for it to go, and
 * the limiter was flattening what little there was.
 *
 * So the bed is parked ~8dB (engines) and ~5dB (music) below where it would
 * naturally sit, the one-shot bank is pushed the other way, and the gap
 * between them is the whole dynamic range of the game. A player turns the
 * whole thing up; they cannot turn the *contrast* up, so it has to be built in.
 */
const ENGINE_BED = 0.40;
const MUSIC_BED = 0.545;

export interface AudioBackend {
  /** The graph's context. `BaseAudioContext` rather than `AudioContext` because
   *  the same graph is built into an OfflineAudioContext by the bench, which is
   *  how this module gets measured rather than guessed at. */
  readonly ac: BaseAudioContext;
  /** The live context, or null when this backend is an offline render. Only
   *  `resume`/`close` need it — everything else works on either. */
  readonly live: AudioContext | null;
  /** Post-fader trim for everything, ahead of the limiter. */
  readonly master: GainNode;
  readonly music: GainNode;
  readonly sfx: GainNode;
  readonly engine: GainNode;
  /**
   * The sidechain across both sustained buses.
   *
   * Headroom alone is not enough: the bed also has to *move*. Every one-shot
   * tells this the instant it is scheduled and it opens a hole on the audio
   * clock, sample-aligned with the transient rather than a frame behind it.
   * See `duck.ts` — the timing is the entire point of that file.
   */
  readonly duck: Ducker;
  /** Send input. Anything connected here is heard through the canyon. */
  readonly verb: GainNode;
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  now(): number;
  /** Offline only: move the virtual clock, so a bench can schedule a five-second
   *  sequence into a context whose `currentTime` never leaves zero. */
  setNow?(t: number): void;
  /** Cached by array identity — the harmonic tables are module constants. */
  wave(amps: readonly number[]): PeriodicWave;
  curve(key: string, make: () => Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer>;
  dispose(): void;
}

type ContextCtor = new (options?: AudioContextOptions) => AudioContext;

function contextCtor(): ContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: ContextCtor; webkitAudioContext?: ContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** True if this environment could plausibly make a sound. Cheap, and safe to
 *  ask before a gesture has happened. */
export function audioAvailable(): boolean {
  return contextCtor() !== null;
}

/**
 * The graph itself, on whatever context it is handed.
 *
 * Split out from `createBackend` so the identical mixer — same limiter, same
 * room, same noise beds — can be built inside an OfflineAudioContext. That is
 * what the bench renders, and a bench that measured a *different* graph would
 * be measuring nothing.
 */
function buildGraph(ac: BaseAudioContext, live: AudioContext | null): AudioBackend {
  // A safety limiter across the whole mix, and *only* a safety limiter.
  //
  // It used to sit at -7dB with a ratio of 12, which is not a limiter, it is a
  // bus compressor — and a measured busy mix confirmed it: peak -0.8dBFS at
  // -12.8dBFS RMS with the per-second level flat inside 0.8dB straight through
  // an explosion, a shell hit, a boost and a coin. Every transient in the game
  // was being spent on making the quiet parts louder. Now it catches genuine
  // overs and nothing else: nothing below -3dB is touched at all, and above it
  // the ratio is steep enough to be a brick wall rather than a squeeze.
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 4;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.1;
  limiter.connect(ac.destination);

  const master = ac.createGain();
  master.gain.value = 1;
  master.connect(limiter);

  const music = ac.createGain();
  const sfx = ac.createGain();
  const engine = ac.createGain();

  // The two sustained buses, each: fader → sidechain (fast) → siren hold
  // (slow) → fixed headroom trim → master. The one-shot bus goes straight to
  // the master and is never ducked by anything, because it is the thing
  // everything else is getting out of the way of.
  const musicDuck = ac.createGain();
  const musicHold = ac.createGain();
  const musicBed = ac.createGain();
  musicBed.gain.value = MUSIC_BED;
  const engineDuck = ac.createGain();
  const engineHold = ac.createGain();
  const engineBed = ac.createGain();
  engineBed.gain.value = ENGINE_BED;

  // A tilt across the engine bed, and the only EQ move in the whole mixer.
  //
  // An engine's authority is its low end; its top octaves are induction hiss,
  // gear whine and tyre roar, which are exactly the frequencies the melody, the
  // hats and the mini-turbo charge tone need to be heard in. Shelving the bed
  // down above 2.5kHz clears that space without touching anything that makes a
  // machine feel fast — measurably: the same slice of the race, same engine
  // level, with the melody band 2dB further out of the mud.
  const engineTilt = ac.createBiquadFilter();
  engineTilt.type = 'highshelf';
  engineTilt.frequency.value = 2500;
  engineTilt.gain.value = -4;

  music.connect(musicDuck);
  musicDuck.connect(musicHold);
  musicHold.connect(musicBed);
  musicBed.connect(master);

  sfx.connect(master);

  engine.connect(engineTilt);
  engineTilt.connect(engineDuck);
  engineDuck.connect(engineHold);
  engineHold.connect(engineBed);
  engineBed.connect(master);

  const duck = createDucker(musicDuck, engineDuck, musicHold, engineHold);

  const convolver = ac.createConvolver();
  convolver.normalize = true;
  convolver.buffer = impulseResponse(ac, 1.15, 3.1, 0x51a7);
  const verb = ac.createGain();
  verb.gain.value = 1;
  const verbOut = ac.createGain();
  verbOut.gain.value = 0.9;
  verb.connect(convolver);
  convolver.connect(verbOut);
  verbOut.connect(master);

  const white = noiseBuffer(ac, 3, 0xb0c4, false);
  const pink = noiseBuffer(ac, 3, 0x7a11, true);

  const waves = new Map<readonly number[], PeriodicWave>();
  const curves = new Map<string, Float32Array<ArrayBuffer>>();

  // Offline, `currentTime` sits at zero until the render runs, so every voice
  // would be scheduled on the same instant. The virtual clock is what lets the
  // bench lay a sequence out in time before rendering it.
  let virtual = -1;

  return {
    ac, live, master, music, sfx, engine, duck, verb, white, pink,
    now: () => (virtual >= 0 ? virtual : ac.currentTime),
    setNow(t: number) { virtual = t; },
    wave(amps) {
      let w = waves.get(amps);
      if (!w) {
        const n = Math.max(2, amps.length);
        const real = new Float32Array(n);
        const imag = new Float32Array(n);
        for (let i = 1; i < n; i++) imag[i] = amps[i] ?? 0;
        w = ac.createPeriodicWave(real, imag);
        waves.set(amps, w);
      }
      return w;
    },
    curve(key, make) {
      let c = curves.get(key);
      if (!c) { c = make(); curves.set(key, c); }
      return c;
    },
    dispose() {
      try {
        duck.dispose();
        master.disconnect();
        limiter.disconnect();
        void live?.close();
      } catch { /* a context that is already gone is not a problem */ }
    },
  };
}

/**
 * Build the whole graph. Returns null — never throws — if audio is unavailable,
 * because a headless renderer with no sound card is a completely normal way for
 * this game to be run and it must not be an error.
 */
export function createBackend(): AudioBackend | null {
  const Ctor = contextCtor();
  if (!Ctor) return null;

  let ac: AudioContext;
  try {
    ac = new Ctor({ latencyHint: 'interactive' });
  } catch {
    return null;
  }

  try {
    return buildGraph(ac, ac);
  } catch {
    try { void ac.close(); } catch { /* ignore */ }
    return null;
  }
}

/** The same mixer, on a context that renders faster than realtime. Bench only. */
export function createOfflineBackend(ac: BaseAudioContext): AudioBackend {
  return buildGraph(ac, null);
}
