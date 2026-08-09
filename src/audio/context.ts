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

export interface AudioBackend {
  readonly ac: AudioContext;
  /** Post-fader trim for everything, ahead of the limiter. */
  readonly master: GainNode;
  readonly music: GainNode;
  readonly sfx: GainNode;
  readonly engine: GainNode;
  /** Send input. Anything connected here is heard through the canyon. */
  readonly verb: GainNode;
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  now(): number;
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
    // One limiter across the whole mix. Eight engines, a music bed and a
    // bob-omb going off in the middle of the pack will comfortably sum past
    // full scale, and a game that clips on its best moment sounds broken
    // exactly when it should sound expensive.
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -7;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.18;
    limiter.connect(ac.destination);

    const master = ac.createGain();
    master.gain.value = 1;
    master.connect(limiter);

    const music = ac.createGain();
    const sfx = ac.createGain();
    const engine = ac.createGain();
    music.connect(master);
    sfx.connect(master);
    engine.connect(master);

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

    return {
      ac, master, music, sfx, engine, verb, white, pink,
      now: () => ac.currentTime,
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
          master.disconnect();
          limiter.disconnect();
          void ac.close();
        } catch { /* a context that is already gone is not a problem */ }
      },
    };
  } catch {
    try { void ac.close(); } catch { /* ignore */ }
    return null;
  }
}
