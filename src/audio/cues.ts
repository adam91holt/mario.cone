// The three continuous things the player is told, as opposed to the things that
// happen to them.
//
// A one-shot answers "what just happened". These answer "what is true right
// now", and they are the sounds a player steers by:
//
//   the charge tone — how far the mini-turbo has wound up. The brief says a
//   player must be able to hear their charge without looking, and that is a
//   real requirement: the sparks are behind the machine and at a committed
//   drift angle the chassis is between the camera and both rear wheels. This
//   rises continuously *and* steps at each tier, so it can be read either as
//   "nearly there" or as "that is orange".
//
//   the threat siren — something is going to hit you, from over there. Panned
//   to the bearing the item system reports and accelerating toward impact, so
//   the correct response (turn, brake, or spend a banana) is available before
//   anything is visible on screen.
//
//   wind — how fast you are actually going. Engine pitch is a poor speedometer
//   because it saws up and down with the gearbox; wind noise only ever climbs.
//
// All three are player-only. They are instrument readings, not events in the
// world, so placing them in space would be a category error.

import { clamp, clamp01, lerp } from '../core/math.ts';
import { pulseCurve } from './dsp.ts';
import { param, set } from './nodes.ts';
import type { AudioBackend } from './context.ts';

export interface CueState {
  /** 0..1 mini-turbo charge, and whether the drift is live at all. */
  charge: number;
  chargeOn: boolean;
  tier: number;
  /** 0..1 time-to-impact of whatever is about to hit the player. */
  threat: number;
  /** Where it is, in the player's frame: -1 hard left, +1 hard right. */
  threatPan: number;
  /** 0..1 airspeed, and how deep in a rival's wake. */
  wind: number;
  draft: number;
}

export interface Cues {
  update(s: CueState, dt: number, now: number): void;
  silence(now: number): void;
  dispose(): void;
}

export function createCues(be: AudioBackend): Cues {
  const ac = be.ac;
  const t0 = be.now();

  // ── mini-turbo charge ─────────────────────────────────────────────────────
  // Two detuned triangles: a single oscillator here reads as a test tone, and
  // the beating between two is what makes it feel like something is building up
  // rather than merely playing.
  const chA = ac.createOscillator();
  const chB = ac.createOscillator();
  chA.type = 'triangle';
  chB.type = 'triangle';
  chB.detune.value = 11;
  const chBand = ac.createBiquadFilter();
  chBand.type = 'lowpass';
  chBand.frequency.value = 1200;
  chBand.Q.value = 3.5;
  // The tremolo. Its *rate* is the charge meter — slow flutter at the start,
  // a hard stutter by purple — which is a far more legible reading than level
  // and survives being buried under eight engines and a music bed.
  const chTrem = ac.createGain();
  chTrem.gain.value = 0.42;
  const chLfo = ac.createOscillator();
  chLfo.type = 'sawtooth';
  chLfo.frequency.value = 5;
  const chShape = ac.createWaveShaper();
  chShape.curve = be.curve('pulse2.2', () => pulseCurve(2.2));
  const chDepth = ac.createGain();
  chDepth.gain.value = 0.58;
  chLfo.connect(chShape);
  chShape.connect(chDepth);
  chDepth.connect(chTrem.gain);

  const chOut = ac.createGain();
  chOut.gain.value = 0;
  chA.connect(chBand);
  chB.connect(chBand);
  chBand.connect(chTrem);
  chTrem.connect(chOut);
  chOut.connect(be.sfx);
  const chSend = ac.createGain();
  chSend.gain.value = 0.12;
  chOut.connect(chSend);
  chSend.connect(be.verb);

  // ── incoming threat ───────────────────────────────────────────────────────
  const wOsc = ac.createOscillator();
  wOsc.type = 'square';
  wOsc.frequency.value = 880;
  const wBand = ac.createBiquadFilter();
  wBand.type = 'bandpass';
  wBand.frequency.value = 1500;
  wBand.Q.value = 2.2;
  const wGate = ac.createGain();
  wGate.gain.value = 0;
  const wLfo = ac.createOscillator();
  wLfo.type = 'sawtooth';
  wLfo.frequency.value = 3;
  const wShape = ac.createWaveShaper();
  wShape.curve = be.curve('pulse5', () => pulseCurve(5));
  const wDepth = ac.createGain();
  wDepth.gain.value = 0;
  wLfo.connect(wShape);
  wShape.connect(wDepth);
  wDepth.connect(wGate.gain);
  wOsc.connect(wBand);
  wBand.connect(wGate);

  let wPan: StereoPannerNode | null = null;
  if (typeof ac.createStereoPanner === 'function') {
    wPan = ac.createStereoPanner();
    wGate.connect(wPan);
    wPan.connect(be.sfx);
  } else {
    wGate.connect(be.sfx);
  }

  // ── wind ──────────────────────────────────────────────────────────────────
  const air = ac.createBufferSource();
  air.buffer = be.pink;
  air.loop = true;
  const airBand = ac.createBiquadFilter();
  airBand.type = 'bandpass';
  airBand.frequency.value = 500;
  airBand.Q.value = 0.55;
  const airGain = ac.createGain();
  airGain.gain.value = 0;
  air.connect(airBand);
  airBand.connect(airGain);
  airGain.connect(be.sfx);

  chA.start(t0); chB.start(t0); chLfo.start(t0);
  wOsc.start(t0); wLfo.start(t0);
  air.start(t0, 0.7);

  const pChA = param(chA.frequency, 200, 0.5, 0.02);
  const pChB = param(chB.frequency, 200, 0.5, 0.02);
  const pChCut = param(chBand.frequency, 1200, 20, 0.04);
  const pChOut = param(chOut.gain, 0, 0.002, 0.035);
  const pChRate = param(chLfo.frequency, 5, 0.08, 0.04);
  const pWRate = param(wLfo.frequency, 3, 0.08, 0.05);
  const pWDepth = param(wDepth.gain, 0, 0.002, 0.04);
  const pWFreq = param(wOsc.frequency, 880, 2, 0.04);
  const pWPan = wPan ? param(wPan.pan, 0, 0.02, 0.05) : null;
  const pAir = param(airGain.gain, 0, 0.002, 0.06);
  const pAirF = param(airBand.frequency, 500, 8, 0.05);

  let alive = true;

  return {
    update(s, dt, now) {
      if (!alive) return;
      void dt;

      // Charge. Just under two octaves across the whole wind-up, with a step
      // at each tier so the three states are distinguishable at a glance —
      // continuous for "how far", quantised for "which".
      const c = clamp01(s.charge);
      const step = s.tier * 0.055;
      const f = 196 * Math.pow(2, c * 1.75 + step);
      set(pChA, f, now);
      set(pChB, f, now);
      set(pChCut, lerp(900, 4200, c) + s.tier * 260, now);
      set(pChRate, lerp(4.5, 21, c * c * 0.6 + c * 0.4), now);
      // Loud enough to be an instrument rather than an ornament. It has to be
      // readable over the player's own engine and a music bed, and being a
      // near-pure tone in a mix made almost entirely of noise and saturation is
      // what lets it be so at a level that never dominates.
      set(pChOut, s.chargeOn ? lerp(0.09, 0.26, c) : 0, now);

      // Threat. Silent almost all the time, and loud on purpose when it is not:
      // this is the one cue that has to beat eight engines, a music bed and
      // whatever is exploding at the time, and a warning that is polite about
      // it is not a warning.
      //
      // It was polite. Measured against a rendered slice of the busiest moment
      // the game can produce, the siren sat 16dB *under* the mix in its own
      // band — inaudible exactly when it matters. It is now six decibels louder
      // and the engine bed steps back underneath it (see `index.ts`), which is
      // the other half of the same decision: a warning is a hole in the mix
      // with a tone in it, not a tone on top of a wall.
      const th = clamp01(s.threat);
      set(pWDepth, th > 0.01 ? lerp(0.32, 0.92, th) : 0, now);
      set(pWRate, lerp(3.2, 12, th * th), now);
      set(pWFreq, lerp(760, 1180, th), now);
      if (pWPan) set(pWPan, clamp(s.threatPan, -1, 1), now);

      // Wind. Quiet, and deliberately so: it is a bed, not a layer. The draft
      // term is the loud part, because sitting in a rival's wake is a thing the
      // player has *achieved* and the game should say so.
      const w = clamp01(s.wind);
      set(pAir, 0.055 * w * w + 0.075 * clamp01(s.draft), now);
      set(pAirF, lerp(360, 1500, w), now);
    },

    silence(now) {
      if (!alive) return;
      set(pChOut, 0, now);
      set(pWDepth, 0, now);
      set(pAir, 0, now);
    },

    dispose() {
      if (!alive) return;
      alive = false;
      const t = be.now();
      try {
        chA.stop(t); chB.stop(t); chLfo.stop(t);
        wOsc.stop(t); wLfo.stop(t); air.stop(t);
        chOut.disconnect(); chSend.disconnect();
        wGate.disconnect(); wPan?.disconnect(); airGain.disconnect();
      } catch { /* already torn down */ }
    },
  };
}
