// Seven machines, and the rule that you must be able to tell them apart with
// your eyes shut.
//
// Every voice here is built from the same six parts — a tone, a sub, a bed of
// noise, an optional pulse train, an optional whine and a tyre scrub — and what
// makes a locomotive a locomotive rather than a truck with the treble turned
// down is *which* of those parts carries the identity:
//
//   cone         the tone. A tiny two-stroke: odd harmonics, hard saturation, a
//                short gearbox and a fundamental up where a strimmer lives.
//   plane        two tones. Detuned a few cents so they beat against each other
//                at a couple of hertz, which is the sound of a propeller and
//                cannot be faked with one oscillator.
//   helicopter   the pulse. A blade slap at seven to twenty hertz gating a band
//                of noise, over a turbine whine. The tone barely matters.
//   digger       the sub, plus a slow lope on the pulse — a big diesel firing
//                unevenly at idle.
//   train        the pulse again, but shaped as a chuff: sharp attack, long
//                decay, rate locked to the wheels, with steam hissing over it.
//   truck        the whine. A turbo spooling from 600Hz to over 3kHz, and six
//                gears, so a truck audibly *works* for its speed.
//   car          the tone again, but revvy: a high redline and five short gears.
//
// The gearbox is the other half of it. A pitch that rises monotonically with
// speed is a siren, not an engine; real machines climb, drop and climb again,
// and that sawtooth is most of what tells a player how fast they are going
// without looking at anything. Machines that have no gearbox in life — the
// aircraft and the locomotive — do not get one here either, and the difference
// between those two groups is immediately audible, which is the point.

import { clamp, clamp01, damp, lerp } from '../core/math.ts';
import { driveCurve, pulseCurve } from './dsp.ts';
import { createSpatial, param, set } from './nodes.ts';
import type { Surface, VehicleId } from '../types.ts';
import type { AudioBackend } from './context.ts';
import type { Param, Placement, Spatial } from './nodes.ts';

/** Everything a voice needs to know about the machine it belongs to. Filled in
 *  by the audio system each frame; never allocated. */
export interface Drive {
  speedFrac: number;
  throttle: number;
  boost: number;
  slip: number;
  airborne: boolean;
  stunned: boolean;
  surface: Surface;
  /** 0..1, how far off the tarmac. Adds roar and eats the top end. */
  offroad: number;
}

export function createDrive(): Drive {
  return {
    speedFrac: 0, throttle: 0, boost: 0, slip: 0,
    airborne: false, stunned: false, surface: 'road', offroad: 0,
  };
}

interface PulseSpec {
  rate0: number; rate1: number; sharp: number;
  band: number; bandQ: number; level: number;
  thump: number; thumpF: number;
}

interface WhineSpec {
  wave: OscillatorType; f0: number; f1: number; level: number; q: number;
}

interface EngineSpec {
  harmonics: readonly number[];
  /** Fundamental at idle and at the redline, hertz. */
  idle: number;
  top: number;
  /** 0 = no gearbox: pitch tracks speed continuously. */
  gears: number;
  /** Cents between the two tone oscillators. Thickness — and, on the plane, the
   *  beat that makes it a propeller. */
  detune: number;
  toneLevel: number;
  sub: number;
  subMul: number;
  drive: number;
  cut0: number;
  cut1: number;
  q: number;
  rumble: { type: BiquadFilterType; f: number; q: number; level: number };
  pulse?: PulseSpec;
  whine?: WhineSpec;
  /** Broadband hiss that rises with throttle — steam, induction, air. */
  hiss: number;
  vol: number;
}

const SPEC: Record<VehicleId, EngineSpec> = {
  cone: {
    harmonics: [0, 1, 0.30, 0.85, 0.22, 0.62, 0.18, 0.45, 0.14, 0.34, 0.11, 0.26, 0.09],
    idle: 92, top: 345, gears: 4, detune: 16, toneLevel: 0.30,
    sub: 0.10, subMul: 0.5, drive: 2.2, cut0: 900, cut1: 5600, q: 1.2,
    rumble: { type: 'bandpass', f: 1600, q: 1.0, level: 0.05 },
    whine: { wave: 'sawtooth', f0: 700, f1: 2100, level: 0.05, q: 4 },
    hiss: 0.03, vol: 0.82,
  },
  plane: {
    harmonics: [0, 1, 0.78, 0.50, 0.16, 0.30, 0.10, 0.14],
    idle: 46, top: 132, gears: 0, detune: 9, toneLevel: 0.44,
    sub: 0.30, subMul: 0.5, drive: 1.0, cut0: 500, cut1: 2400, q: 0.9,
    rumble: { type: 'lowpass', f: 900, q: 0.7, level: 0.17 },
    whine: { wave: 'sawtooth', f0: 380, f1: 1050, level: 0.06, q: 3 },
    hiss: 0.07, vol: 0.76,
  },
  helicopter: {
    harmonics: [0, 1, 0.35, 0.50, 0.18, 0.30],
    idle: 38, top: 96, gears: 0, detune: 5, toneLevel: 0.20,
    sub: 0.32, subMul: 0.5, drive: 0.8, cut0: 400, cut1: 1500, q: 0.8,
    rumble: { type: 'lowpass', f: 700, q: 0.7, level: 0.10 },
    pulse: {
      rate0: 7.5, rate1: 19, sharp: 7, band: 760, bandQ: 1.4,
      level: 0.55, thump: 0.75, thumpF: 150,
    },
    whine: { wave: 'sawtooth', f0: 900, f1: 2400, level: 0.09, q: 6 },
    hiss: 0.05, vol: 1.04,
  },
  digger: {
    harmonics: [0, 1, 0.92, 0.66, 0.32, 0.44, 0.26, 0.20, 0.14, 0.22],
    idle: 24, top: 78, gears: 3, detune: 6, toneLevel: 0.46,
    sub: 0.32, subMul: 0.5, drive: 3.4, cut0: 260, cut1: 1500, q: 1.4,
    rumble: { type: 'lowpass', f: 380, q: 0.7, level: 0.14 },
    pulse: {
      rate0: 4, rate1: 13, sharp: 3, band: 300, bandQ: 1.0,
      level: 0.16, thump: 0.30, thumpF: 90,
    },
    whine: { wave: 'sine', f0: 1800, f1: 3000, level: 0.035, q: 8 },
    hiss: 0.03, vol: 0.55,
  },
  train: {
    harmonics: [0, 1, 0.55, 0.28, 0.12],
    idle: 20, top: 52, gears: 0, detune: 4, toneLevel: 0.20,
    sub: 0.40, subMul: 0.5, drive: 1.6, cut0: 240, cut1: 900, q: 0.9,
    rumble: { type: 'lowpass', f: 260, q: 0.8, level: 0.17 },
    pulse: {
      rate0: 1.8, rate1: 10.5, sharp: 5.5, band: 640, bandQ: 0.9,
      level: 0.78, thump: 0.70, thumpF: 105,
    },
    hiss: 0.11, vol: 0.84,
  },
  truck: {
    harmonics: [0, 1, 0.72, 0.50, 0.36, 0.40, 0.24, 0.18, 0.12],
    idle: 32, top: 118, gears: 6, detune: 7, toneLevel: 0.42,
    sub: 0.28, subMul: 0.5, drive: 2.6, cut0: 320, cut1: 2400, q: 1.3,
    rumble: { type: 'lowpass', f: 520, q: 0.7, level: 0.10 },
    whine: { wave: 'sawtooth', f0: 620, f1: 3200, level: 0.10, q: 7 },
    hiss: 0.05, vol: 0.63,
  },
  car: {
    harmonics: [0, 1, 0.62, 0.44, 0.30, 0.24, 0.18, 0.13, 0.10, 0.07],
    idle: 58, top: 250, gears: 5, detune: 8, toneLevel: 0.34,
    sub: 0.20, subMul: 0.5, drive: 1.8, cut0: 620, cut1: 4600, q: 1.6,
    rumble: { type: 'lowpass', f: 800, q: 0.7, level: 0.06 },
    whine: { wave: 'sawtooth', f0: 900, f1: 2600, level: 0.045, q: 6 },
    hiss: 0.03, vol: 0.77,
  },
};

/**
 * How each surface answers a sliding tyre.
 *
 * Tarmac is a *resonance* — a narrow, high, ringing squeal, which is what
 * rubber does when it grips and lets go thousands of times a second. Everything
 * loose is a *band* — wide, low, no pitch at all, because gravel does not
 * resonate, it rattles. Getting those two the same way round is the whole
 * difference between "the tyres are protesting" and "I am off the road", and a
 * player has to be able to hear which without taking their eyes off the corner.
 */
const SCRUB: Record<Surface, { f: number; q: number; level: number }> = {
  road:  { f: 1900, q: 7.0, level: 0.30 },
  boost: { f: 1900, q: 7.0, level: 0.28 },
  dirt:  { f: 780,  q: 1.1, level: 0.34 },
  sand:  { f: 620,  q: 0.9, level: 0.32 },
  grass: { f: 900,  q: 1.0, level: 0.26 },
  water: { f: 1500, q: 0.8, level: 0.30 },
  rail:  { f: 3200, q: 9.0, level: 0.30 },
  air:   { f: 1200, q: 1.0, level: 0.0 },
};

/**
 * How much quieter a rival is than your own machine, over and above distance.
 *
 * Distance alone is not enough. A rival two metres off your door genuinely is
 * as loud as you are, and a mix built on that truth turns the middle of the
 * pack into porridge — eight engines, none of them yours, and no way to hear
 * your own revs, which is the one instrument the player is actually steering
 * by. You sit *in* your machine and beside everyone else's, and this is that
 * difference expressed as a number.
 */
const RIVAL_TRIM = 0.58;

export interface RacerVoice {
  /** `p` must already have been filled in by `place()` for this racer. */
  update(d: Drive, p: Placement, dt: number, now: number): void;
  dispose(): void;
}

export function createRacerVoice(
  be: AudioBackend, vehicleId: VehicleId, isPlayer: boolean, seed: number,
): RacerVoice {
  const spec = SPEC[vehicleId];
  const ac = be.ac;
  const t0 = be.now();
  // Every voice starts its noise bed at a different place in the buffer.
  // Without it, eight machines share one waveform sample for sample and the
  // pack sums coherently into a single comb-filtered roar instead of into
  // eight engines.
  const offset = (seed * 0.37) % 2.6;

  const mix = ac.createGain();
  mix.gain.value = 0;

  // ── output: the player is in the middle of the picture, rivals are placed ──
  let spatial: Spatial | null = null;
  if (isPlayer) {
    const send = ac.createGain();
    send.gain.value = 0.05;
    mix.connect(be.engine);
    mix.connect(send);
    send.connect(be.verb);
  } else {
    spatial = createSpatial(be, be.engine, 0.09);
    // Distance level is applied at `mix` below, so the placement chain's own
    // gain is a pass-through and only its filter and pan do any work.
    spatial.input.gain.value = 1;
    spatial.gain.last = 1;
    mix.connect(spatial.input);
  }

  // ── tone: two oscillators on the vehicle's own harmonic series ────────────
  const wave = be.wave(spec.harmonics);
  const toneA = ac.createOscillator();
  const toneB = ac.createOscillator();
  toneA.setPeriodicWave(wave);
  toneB.setPeriodicWave(wave);
  toneB.detune.value = spec.detune;
  toneA.detune.value = -spec.detune * 0.35;

  const toneGain = ac.createGain();
  toneGain.gain.value = 0;
  const shaper = ac.createWaveShaper();
  shaper.curve = be.curve(`drive${spec.drive}`, () => driveCurve(spec.drive));
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = spec.cut0;
  lp.Q.value = spec.q;
  toneA.connect(toneGain);
  toneB.connect(toneGain);
  toneGain.connect(shaper);
  shaper.connect(lp);
  lp.connect(mix);

  const sub = ac.createOscillator();
  sub.type = 'sine';
  const subGain = ac.createGain();
  subGain.gain.value = 0;
  sub.connect(subGain);
  subGain.connect(mix);

  // ── noise beds ────────────────────────────────────────────────────────────
  const pinkSrc = ac.createBufferSource();
  pinkSrc.buffer = be.pink;
  pinkSrc.loop = true;
  const whiteSrc = ac.createBufferSource();
  whiteSrc.buffer = be.white;
  whiteSrc.loop = true;

  const rumbleF = ac.createBiquadFilter();
  rumbleF.type = spec.rumble.type;
  rumbleF.frequency.value = spec.rumble.f;
  rumbleF.Q.value = spec.rumble.q;
  const rumbleGain = ac.createGain();
  rumbleGain.gain.value = 0;
  pinkSrc.connect(rumbleF);
  rumbleF.connect(rumbleGain);
  rumbleGain.connect(mix);

  const hissF = ac.createBiquadFilter();
  hissF.type = 'highpass';
  hissF.frequency.value = 2600;
  hissF.Q.value = 0.6;
  const hissGain = ac.createGain();
  hissGain.gain.value = 0;
  whiteSrc.connect(hissF);
  hissF.connect(hissGain);
  hissGain.connect(mix);

  // ── the tyres ─────────────────────────────────────────────────────────────
  const scrubF = ac.createBiquadFilter();
  scrubF.type = 'bandpass';
  scrubF.frequency.value = 1900;
  scrubF.Q.value = 6;
  const scrubGain = ac.createGain();
  scrubGain.gain.value = 0;
  whiteSrc.connect(scrubF);
  scrubF.connect(scrubGain);
  scrubGain.connect(mix);

  // ── the pulse train: blade slap, chuff, diesel lope ───────────────────────
  let modOsc: OscillatorNode | null = null;
  let modFreq: Param | null = null;
  let pulseDepth: Param | null = null;
  let thumpDepth: Param | null = null;
  if (spec.pulse) {
    const ps = spec.pulse;
    modOsc = ac.createOscillator();
    modOsc.type = 'sawtooth';
    modOsc.frequency.value = ps.rate0;
    const modShaper = ac.createWaveShaper();
    modShaper.curve = be.curve(`pulse${ps.sharp}`, () => pulseCurve(ps.sharp));
    modOsc.connect(modShaper);

    const band = ac.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = ps.band;
    band.Q.value = ps.bandQ;
    const gate = ac.createGain();
    gate.gain.value = 0;
    whiteSrc.connect(band);
    band.connect(gate);
    gate.connect(mix);
    const depth = ac.createGain();
    depth.gain.value = 0;
    modShaper.connect(depth);
    depth.connect(gate.gain);

    const thumpF = ac.createBiquadFilter();
    thumpF.type = 'lowpass';
    thumpF.frequency.value = ps.thumpF;
    thumpF.Q.value = 1.1;
    const thumpGate = ac.createGain();
    thumpGate.gain.value = 0;
    pinkSrc.connect(thumpF);
    thumpF.connect(thumpGate);
    thumpGate.connect(mix);
    const tDepth = ac.createGain();
    tDepth.gain.value = 0;
    modShaper.connect(tDepth);
    tDepth.connect(thumpGate.gain);

    modFreq = param(modOsc.frequency, ps.rate0, 0.05, 0.06);
    pulseDepth = param(depth.gain, 0, 0.003, 0.05);
    thumpDepth = param(tDepth.gain, 0, 0.003, 0.05);
  }

  // ── the whine: turbo, turbine, hydraulics, gear noise ─────────────────────
  let whineOsc: OscillatorNode | null = null;
  let whineFreq: Param | null = null;
  let whineBand: Param | null = null;
  let whineLevel: Param | null = null;
  if (spec.whine) {
    const ws = spec.whine;
    whineOsc = ac.createOscillator();
    whineOsc.type = ws.wave;
    whineOsc.frequency.value = ws.f0;
    const bq = ac.createBiquadFilter();
    bq.type = 'bandpass';
    bq.frequency.value = ws.f0;
    bq.Q.value = ws.q;
    const g = ac.createGain();
    g.gain.value = 0;
    whineOsc.connect(bq);
    bq.connect(g);
    g.connect(mix);
    whineFreq = param(whineOsc.frequency, ws.f0, 1, 0.05);
    // The band is driven alongside the oscillator rather than left fixed, so
    // the whine keeps its own colour as it spools instead of walking out of
    // its own filter and going dull at the top of the range.
    whineBand = param(bq.frequency, ws.f0, 4, 0.05);
    whineLevel = param(g.gain, 0, 0.002, 0.05);
  }

  toneA.start(t0);
  toneB.start(t0);
  sub.start(t0);
  modOsc?.start(t0);
  whineOsc?.start(t0);
  pinkSrc.start(t0, offset);
  whiteSrc.start(t0, (offset + 1.3) % 2.6);

  // ── per-frame parameters ──────────────────────────────────────────────────
  const pToneA = param(toneA.frequency, spec.idle, 0.4, 0.02);
  const pToneB = param(toneB.frequency, spec.idle, 0.4, 0.02);
  const pSub = param(sub.frequency, spec.idle * spec.subMul, 0.3, 0.02);
  const pToneGain = param(toneGain.gain, 0, 0.002, 0.03);
  const pSubGain = param(subGain.gain, 0, 0.002, 0.04);
  const pCut = param(lp.frequency, spec.cut0, 25, 0.04);
  const pRumble = param(rumbleGain.gain, 0, 0.002, 0.05);
  const pHiss = param(hissGain.gain, 0, 0.002, 0.05);
  const pScrub = param(scrubGain.gain, 0, 0.002, 0.03);
  const pScrubF = param(scrubF.frequency, 1900, 15, 0.04);
  const pScrubQ = param(scrubF.Q, 6, 0.2, 0.06);
  const pMix = param(mix.gain, 0, 0.002, 0.04);

  // ── the gearbox, and the smoothed revs it produces ────────────────────────
  let gear = 0;
  let rev = 0.12;
  let shiftDip = 0;
  let alive = true;

  function targetRev(d: Drive): number {
    const frac = clamp01(d.speedFrac);
    if (spec.gears <= 0) {
      // No gearbox. Aircraft and locomotives climb once, all the way.
      return lerp(0.14, 1, Math.pow(frac, 0.82));
    }
    const step = 1 / spec.gears;
    // Hysteresis, and it is not decoration: without it a kart sitting exactly
    // on a shift point flutters between two ratios at 60Hz, which sounds like
    // the engine is broken. The window down is wider than the window up
    // because a real box holds a gear through a lift.
    if (frac > (gear + 1) * step + 0.004 && gear < spec.gears - 1) {
      gear++;
      shiftDip = 1;
    } else if (frac < gear * step - 0.03 && gear > 0) {
      gear--;
    }
    const within = clamp01((frac - gear * step) * spec.gears);
    return 0.34 + 0.66 * within;
  }

  return {
    update(d, p, dt, now) {
      if (!alive) return;

      // Distance culling. A machine a hundred metres up the road is not worth
      // a dozen parameter writes a frame, and the deadbands would swallow most
      // of them anyway — but the mix gain still has to be driven to zero or the
      // voice hangs at whatever level it had when it went out of range.
      const audible = isPlayer ? 1 : p.gain * RIVAL_TRIM;
      if (audible < 0.012) {
        set(pMix, 0, now);
        return;
      }

      let target = targetRev(d);
      // Off the ground the engine has nothing to push against and runs away.
      if (d.airborne) target = Math.max(target, 0.86);
      // A boost is the machine being asked for more than it has.
      target += d.boost * 0.18;
      // Off the throttle it sags; stunned, it dies back to an idle.
      if (d.throttle < 0.2) target *= 0.86;
      if (d.stunned) target = Math.min(target, 0.24);

      shiftDip = Math.max(0, shiftDip - dt * 11);
      target *= 1 - shiftDip * 0.22;

      // Revs chase quickly but not instantly: the lag is what a flywheel is.
      rev = damp(rev, clamp(target, 0.08, 1.24), 0.0006, dt);

      const doppler = isPlayer ? 1 : p.rate;
      const f = lerp(spec.idle, spec.top, Math.pow(rev, 0.92)) * doppler;
      set(pToneA, f, now);
      set(pToneB, f, now);
      set(pSub, f * spec.subMul, now);

      // Load: how hard the machine is working, as distinct from how fast it is
      // going. It opens the filter and pushes the tone into the saturator,
      // which is the cue that says "under power" rather than "louder".
      const load = clamp01(d.throttle * 0.62 + d.speedFrac * 0.24 + d.boost * 0.5);
      const lit = 1 - shiftDip * 0.5;
      set(pToneGain, spec.toneLevel * (0.42 + 0.58 * load) * lit, now);
      set(pSubGain, spec.sub * (0.5 + 0.5 * load), now);
      set(pCut, lerp(spec.cut0, spec.cut1, load * 0.75 + rev * 0.25) * lerp(1, 0.6, d.offroad), now);

      // Road roar. Rises with speed, doubles off the tarmac, and is most of
      // what tells a still, throttled-off machine that it is still moving.
      const roll = spec.rumble.level * (0.30 + 0.85 * d.speedFrac) * (1 + d.offroad * 1.1);
      set(pRumble, roll, now);
      set(pHiss, spec.hiss * (0.3 + 0.7 * load), now);

      if (modFreq && pulseDepth && thumpDepth && spec.pulse) {
        const ps = spec.pulse;
        set(modFreq, lerp(ps.rate0, ps.rate1, Math.pow(rev, 0.8)) * doppler, now);
        const push = 0.45 + 0.55 * load;
        set(pulseDepth, ps.level * push, now);
        set(thumpDepth, ps.thump * push, now);
      }

      if (whineFreq && whineBand && whineLevel && spec.whine) {
        const ws = spec.whine;
        const wf = lerp(ws.f0, ws.f1, Math.pow(rev, 1.15)) * doppler;
        set(whineFreq, wf, now);
        set(whineBand, wf, now);
        // A turbo is silent off boost and screams on it: squaring the load is
        // what makes it an event rather than a layer.
        set(whineLevel, ws.level * (0.15 + 0.85 * load * load), now);
      }

      const sc = SCRUB[d.surface];
      const bite = clamp01(d.slip) * clamp01(d.speedFrac * 2.2);
      set(pScrub, sc.level * bite * bite * (d.airborne ? 0 : 1), now);
      set(pScrubF, sc.f * lerp(0.86, 1.18, clamp01(d.slip)), now);
      set(pScrubQ, sc.q, now);

      set(pMix, spec.vol * audible, now);
      if (spatial) {
        set(spatial.cut, p.cut, now);
        if (spatial.pan) set(spatial.pan, p.pan, now);
      }
    },

    dispose() {
      if (!alive) return;
      alive = false;
      const t = be.now();
      try {
        toneA.stop(t); toneB.stop(t); sub.stop(t);
        modOsc?.stop(t); whineOsc?.stop(t);
        pinkSrc.stop(t); whiteSrc.stop(t);
        mix.disconnect();
        spatial?.disconnect();
      } catch { /* already torn down */ }
    },
  };
}
