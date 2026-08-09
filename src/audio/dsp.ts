// Procedural signal sources.
//
// The game ships as one self-contained bundle with no asset files, so every
// waveform, every bed of noise and the room the whole mix sits in has to be
// built out of numbers at boot. That constraint is less limiting than it
// sounds: a periodic wave built from a hand-written harmonic series is a far
// more controllable engine tone than a sample, because the *timbre* can be
// designed independently of the pitch — which is exactly what a racing game
// needs, where one machine has to hold together from an idle to a redline.
//
// Everything here is deterministic. The noise beds and the reverb's impulse
// response are drawn from a seeded RNG rather than Math.random so two runs of
// the game sound identical, which matters for the same reason the simulation is
// deterministic: a reviewer comparing two captures must be comparing the game,
// not the dice.

import { makeRng } from '../core/math.ts';

/** MIDI note number → hertz. Everything musical in the game is written in MIDI
 *  numbers, because a transposition — which the final lap needs — is then an
 *  addition rather than a table. */
export const midiHz = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);

/** Named MIDI numbers, so the chart in music.ts reads as music. */
export const N = {
  C2: 36, D2: 38, E2: 40, F2: 41, Fs2: 42, G2: 43, A2: 45, B2: 47,
  C3: 48, Cs3: 49, D3: 50, E3: 52, Fs3: 54, G3: 55, A3: 57, B3: 59,
  Cs4: 61, D4: 62, E4: 64, Fs4: 66, G4: 67, A4: 69, B4: 71,
  Cs5: 73, D5: 74, E5: 76, Fs5: 78, G5: 79, A5: 81, B5: 83,
  Cs6: 85, D6: 86, E6: 88, Fs6: 90,
} as const;

/**
 * A looping bed of noise.
 *
 * Two flavours, and the difference is not cosmetic. White noise is flat per
 * hertz, so it is dominated by the top two octaves and reads as *hiss* — right
 * for a spark, an air brake or a hi-hat. Pink noise is flat per octave, which
 * is how wind, gravel, tyre roar and a distant crowd actually distribute their
 * energy; used for those, it sits under the mix instead of on top of it.
 *
 * Three seconds is long enough that the loop point is never heard. It cannot be
 * heard anyway — a discontinuity in noise is just another sample of noise — but
 * a short buffer develops an audible periodicity, and that *is* a tell.
 */
export function noiseBuffer(
  ac: BaseAudioContext, seconds: number, seed: number, pink = false,
): AudioBuffer {
  const sr = ac.sampleRate;
  const n = Math.max(1, Math.floor(sr * seconds));
  const buf = ac.createBuffer(2, n, sr);
  const rng = makeRng(seed);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    // Paul Kellet's pink filter — six one-poles summed. Cheap, and accurate to
    // about a tenth of a dB across the audible band.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng.next() * 2 - 1;
      if (!pink) { data[i] = w; continue; }
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.22;
      b6 = w * 0.115926;
    }
  }
  return buf;
}

/**
 * A decaying pulse, as a waveshaper curve.
 *
 * The trick that makes the helicopter and the locomotive possible without a
 * scheduler. Feed a *sawtooth* — which is a phase ramp from -1 to +1 — through
 * this and the output is 1 at the instant the ramp wraps and decays to 0 across
 * the cycle: an envelope generator that costs two nodes and whose rate can be
 * swept continuously by changing the oscillator's frequency.
 *
 * The alternative is scheduling every chuff and every blade slap on the audio
 * clock from the render loop, which would then have to survive a capture
 * harness that steps the simulation for eleven seconds without drawing a frame.
 * This cannot go wrong that way: it is a signal, not a plan.
 *
 * The curve is normalised to end at exactly zero. A pulse train with a DC
 * offset multiplied into a gain leaves the "silent" part of the cycle audible,
 * which turns a thump into a hum.
 */
export function pulseCurve(sharpness: number, size = 1024): Float32Array<ArrayBuffer> {
  const out = new Float32Array(size);
  const floor = Math.exp(-sharpness);
  const span = 1 - floor;
  for (let i = 0; i < size; i++) {
    const phase = i / (size - 1);
    out[i] = (Math.exp(-phase * sharpness) - floor) / span;
  }
  return out;
}

/**
 * Soft saturation. `amount` is how hard: 0.5 is a warm thickening, 6 is a
 * diesel's ugly bark.
 *
 * Every engine in the game runs through one of these, because a bare periodic
 * wave is *clean* and no machine with pistons in it is clean. Saturation also
 * generates harmonics that rise with level, which is the single most convincing
 * cue there is that an engine is under load rather than just louder.
 */
export function driveCurve(amount: number, size = 1024): Float32Array<ArrayBuffer> {
  const out = new Float32Array(size);
  const k = Math.max(0.001, amount);
  const norm = 1 / Math.tanh(k);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    out[i] = Math.tanh(k * x) * norm;
  }
  return out;
}

/**
 * The room. A synthetic impulse response for the convolver on the effects send.
 *
 * Cone Canyon is a canyon, and a canyon answers back — so this is not a concert
 * hall. It is a short, bright, slightly gappy decay with a cluster of early
 * reflections at 40-110ms, which is what a rock face two hundred metres away
 * does to a bob-omb. Long tails are the enemy in a racing game: anything past
 * about a second and a half smears the next explosion into the last one and the
 * mix turns to mud at exactly the moment it is busiest.
 */
export function impulseResponse(
  ac: BaseAudioContext, seconds: number, decay: number, seed: number,
): AudioBuffer {
  const sr = ac.sampleRate;
  const n = Math.max(1, Math.floor(sr * seconds));
  const buf = ac.createBuffer(2, n, sr);
  const rng = makeRng(seed);
  // Discrete slapbacks, in seconds and relative strength. Uncorrelated between
  // the two ears, which is what gives the tail width instead of a mono blob
  // sitting in the middle of the picture.
  const taps = [0.041, 0.058, 0.079, 0.097, 0.113, 0.148];
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const env = Math.pow(1 - t, decay);
      // A one-pole lowpass on the noise: a raw white tail is a hiss, and a hiss
      // behind every sound in the game is the cheapest way to make a mix sound
      // like a demo.
      lp += ((rng.next() * 2 - 1) - lp) * 0.42;
      data[i] = lp * env;
    }
    for (let k = 0; k < taps.length; k++) {
      const idx = Math.floor((taps[k]! + rng.range(-0.004, 0.004)) * sr);
      if (idx > 0 && idx < n) data[idx] += rng.range(0.4, 0.9) * (1 - k / taps.length) * 0.9;
    }
  }
  return buf;
}

/**
 * A periodic wave from a harmonic series.
 *
 * `amps[k]` is the amplitude of the k-th harmonic; index 0 is DC and ignored.
 * This is where a vehicle gets its character: the same oscillator playing the
 * same note is a two-stroke, a diesel or a turboprop depending only on which
 * partials are in this array. Normalisation is left on so a redesign of one
 * machine's spectrum cannot change how loud it is relative to the others.
 */
export function harmonicWave(ac: BaseAudioContext, amps: readonly number[]): PeriodicWave {
  const n = Math.max(2, amps.length);
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 1; i < n; i++) imag[i] = amps[i] ?? 0;
  return ac.createPeriodicWave(real, imag);
}
