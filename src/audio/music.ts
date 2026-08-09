// The music. A real tune, played by a sequencer, not a loop of ambience.
//
// It is a 16-bar theme in D major at 152bpm: four bars of hook, four of
// variation, four that lift to the subdominant, and four that come home. The
// instruments are a driving eighth-note bass, offbeat brass stabs, a
// four-on-the-floor kit — and then the part that makes it this game's theme
// rather than a generic upbeat loop: a percussion section made of roadworks.
// A scaffold pole struck with a hammer keeps the offbeat, a jackhammer fills
// the last half-bar of every phrase, and the B section is punctuated by a
// truck's reversing alarm on the beat. Those three sounds are the brief.
//
// Three things it has to do beyond playing:
//
//   Duck. Every loud one-shot pushes the music down and lets it back up over
//   about a third of a second, so an explosion or a fanfare is never fighting
//   the bed. Without it a kart racer's mix collapses the moment it gets
//   exciting, which is precisely the wrong moment.
//
//   Lift on the final lap. Up a tone, eight percent faster, with the melody
//   doubled an octave up and the hats in sixteenths. Nintendo does this because
//   it works: the player knows the race has changed before the HUD says so.
//
//   Survive the clock. Notes are scheduled ahead on the audio clock rather than
//   played from the render loop, so a frame that takes 200ms — which under the
//   software renderer in the capture harness is every frame — does not put a
//   hole in the groove. If the page is backgrounded and the clock runs away, the
//   sequencer resynchronises rather than trying to play the backlog.

import { clamp01, lerp } from '../core/math.ts';
import { driveCurve, midiHz } from './dsp.ts';
import { param, set } from './nodes.ts';
import type { AudioBackend } from './context.ts';

export type MusicMode = 'none' | 'race' | 'final' | 'star' | 'victory';
/** Everything but silence. Only these have a chart behind them. */
type ActiveMode = Exclude<MusicMode, 'none'>;

export interface Music {
  setMode(mode: MusicMode, fade?: number): void;
  readonly mode: MusicMode;
  /** 0..1. Pushes the bed down under an effect, and recovers by itself. */
  duck(amount: number): void;
  update(dt: number, now: number): void;
  dispose(): void;
}

// ── the chart ───────────────────────────────────────────────────────────────

/** Bass roots, one per bar. D - Bm - G - A, twice; then the lift; then home. */
const RACE_ROOT = [38, 35, 43, 45, 38, 35, 43, 45, 43, 45, 42, 35, 38, 35, 43, 45];
/** Minor thirds where the chart calls for them. */
const RACE_MINOR = [0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 0, 0];

const VICTORY_ROOT = [38, 43, 45, 38];
const VICTORY_MINOR = [0, 0, 0, 0];

/** One character per sixteenth note. */
const KICK = 'x...x...x...x...';
const KICK_FILL = 'x...x...x..xx.x.';
const SNARE = '....x.......x...';
const SNARE_FILL = '....x.......x.x.';
const STAB = '..x...x...x...x.';
const CLANK = '......x.......x.';
const BEEPER = 'x.......x.......';

/** Scale offsets the bass walks over its root, one per eighth note. */
const BASS_WALK = [0, 0, 7, 0, 12, 0, 7, 5];

/** [step, midi, lengthInSteps] */
type Note = readonly [number, number, number];

const LEAD_A: readonly (readonly Note[])[] = [
  [[0, 74, 2], [2, 78, 2], [4, 81, 3], [7, 79, 1], [8, 78, 4], [12, 76, 2], [14, 74, 2]],
  [[0, 71, 2], [2, 74, 2], [4, 78, 3], [7, 76, 1], [8, 74, 6]],
  [[0, 79, 2], [2, 81, 2], [4, 83, 4], [8, 81, 2], [10, 79, 2], [12, 78, 4]],
  [[0, 76, 2], [2, 78, 2], [4, 79, 2], [6, 81, 2], [8, 85, 4], [12, 81, 4]],
];
const LEAD_A2: readonly (readonly Note[])[] = [
  [[0, 81, 2], [2, 78, 2], [4, 74, 3], [7, 76, 1], [8, 78, 4], [12, 81, 4]],
  [[0, 83, 2], [2, 81, 2], [4, 78, 4], [8, 76, 2], [10, 74, 2], [12, 71, 4]],
  [[0, 79, 2], [2, 83, 2], [4, 86, 4], [8, 83, 2], [10, 81, 2], [12, 79, 4]],
  [[0, 78, 2], [2, 76, 2], [4, 73, 4], [8, 76, 2], [10, 78, 2], [12, 81, 4]],
];
const LEAD_B: readonly (readonly Note[])[] = [
  [[0, 71, 2], [2, 74, 2], [4, 79, 4], [8, 78, 2], [10, 76, 2], [12, 74, 4]],
  [[0, 73, 2], [2, 76, 2], [4, 81, 4], [8, 79, 2], [10, 78, 2], [12, 76, 4]],
  [[0, 69, 2], [2, 73, 2], [4, 78, 4], [8, 76, 2], [10, 74, 2], [12, 73, 4]],
  [[0, 71, 2], [2, 74, 2], [4, 78, 2], [6, 81, 2], [8, 83, 8]],
];

const VICTORY_LEAD: readonly (readonly Note[])[] = [
  [[0, 74, 4], [4, 78, 4], [8, 81, 8]],
  [[0, 79, 4], [4, 83, 4], [8, 86, 8]],
  [[0, 85, 4], [4, 81, 4], [8, 78, 8]],
  [[0, 74, 16]],
];

function leadBar(bar: number): readonly Note[] {
  if (bar < 4) return LEAD_A[bar]!;
  if (bar < 8) return LEAD_A2[bar - 4]!;
  if (bar < 12) return LEAD_B[bar - 8]!;
  return LEAD_A[bar - 12]!;
}

interface ModeSpec {
  bpm: number;
  transpose: number;
  /** 0..1 arrangement weight: octave doubling, sixteenth hats, extra metal. */
  intensity: number;
  bars: number;
  victory: boolean;
  level: number;
}

const MODES: Record<ActiveMode, ModeSpec> = {
  race:    { bpm: 152, transpose: 0, intensity: 0.35, bars: 16, victory: false, level: 1 },
  final:   { bpm: 164, transpose: 2, intensity: 0.85, bars: 16, victory: false, level: 1.05 },
  star:    { bpm: 188, transpose: 2, intensity: 1.00, bars: 16, victory: false, level: 1.1 },
  victory: { bpm: 104, transpose: 0, intensity: 0.5, bars: 4, victory: true, level: 1 },
};

const LOOKAHEAD = 0.22;
/** Hard cap on steps scheduled in one call, so a stalled tab cannot make the
 *  sequencer try to play its way out of a ten-second hole. */
const MAX_CATCHUP = 48;

export function createMusic(be: AudioBackend, baseLevel: number): Music {
  const ac = be.ac;

  // Every instrument plays into `out`, and the bed is then treated as a bed:
  // filtered, compressed, and only then levelled.
  const out = ac.createGain();
  out.gain.value = 1;

  // A highpass across the whole bed, and it is not cosmetic.
  //
  // Eight machines are already occupying everything below 150Hz, and the music
  // has no business competing with them down there: energy under about 45Hz is
  // inaudible on the speakers most people will play this on, but it is not
  // inaudible to the master limiter, which pulls the *whole mix* down to make
  // room for a rumble nobody can hear. A measured render of the theme had a
  // solid block of it running the entire loop. This is the single change that
  // took the low end from a wall to a bassline.
  const trim = ac.createBiquadFilter();
  trim.type = 'highpass';
  trim.frequency.value = 46;
  trim.Q.value = 0.7;

  // The bed's own compressor, and the reason it exists is measurement rather
  // than taste. Rendered flat, the theme's transients — a stab landing on a
  // bass note landing on the kick — peaked within a decibel of full scale while
  // its body sat a third of that, so the *music alone* was driving the master
  // limiter, and everything else in the game would have pumped against it.
  // Holding the arrangement's own dynamics here means the limiter downstream is
  // free to do what it is for: catching the game.
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 10;
  comp.ratio.value = 4;
  comp.attack.value = 0.005;
  comp.release.value = 0.12;

  const bus = ac.createGain();
  bus.gain.value = 0;

  out.connect(trim);
  trim.connect(comp);
  comp.connect(bus);
  bus.connect(be.music);
  const send = ac.createGain();
  send.gain.value = 0.13;
  bus.connect(send);
  send.connect(be.verb);

  const level = param(bus.gain, 0, 0.002, 0.04);

  let mode: MusicMode = 'none';
  let pending: ActiveMode | null = null;
  let spec = MODES.race;
  let step = 0;
  let nextTime = 0;
  let running = false;
  let fadeTarget = 1;
  let fade = 0;
  /** Audio-clock time at which a fade-out is finished and scheduling may stop.
   *  It has to be a time rather than a level: `set` records the *target* it
   *  asked for, so a fading bus reports zero the instant it is told to fade. */
  let stopAt = 0;
  let duckAmount = 0;

  const brassCurve = be.curve('drive1.4', () => driveCurve(1.4));
  const bassCurve = be.curve('drive2.6', () => driveCurve(2.6));

  // ── instruments ───────────────────────────────────────────────────────────

  function env(g: GainNode, t: number, peak: number, attack: number, hold: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(1e-4, peak), t + attack);
    if (hold > 0) g.gain.setValueAtTime(Math.max(1e-4, peak), t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + decay);
  }

  function noiseHit(
    t: number, type: BiquadFilterType, f0: number, f1: number, q: number,
    gain: number, decay: number, pink = false,
  ): void {
    const src = ac.createBufferSource();
    src.buffer = pink ? be.pink : be.white;
    src.loop = true;
    const bq = ac.createBiquadFilter();
    bq.type = type;
    bq.Q.value = q;
    bq.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) bq.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + decay);
    const g = ac.createGain();
    env(g, t, gain, 0.002, 0, decay);
    src.connect(bq); bq.connect(g); g.connect(out);
    src.start(t, (t * 7.3) % 2.4);
    src.stop(t + decay + 0.02);
  }

  function kick(t: number, gain: number): void {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.09);
    const g = ac.createGain();
    env(g, t, gain, 0.002, 0.01, 0.16);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + 0.2);
    noiseHit(t, 'highpass', 2200, 2200, 0.7, gain * 0.12, 0.012);
  }

  function snare(t: number, gain: number): void {
    noiseHit(t, 'bandpass', 2100, 1400, 1.1, gain * 0.75, 0.14);
    const o = ac.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    const g = ac.createGain();
    env(g, t, gain * 0.35, 0.002, 0, 0.09);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + 0.13);
  }

  function hat(t: number, gain: number, open: boolean): void {
    noiseHit(t, 'highpass', 7200, 7200, 0.8, gain, open ? 0.16 : 0.035);
  }

  /** A scaffold pole hit with a hammer. Inharmonic partials, a hard transient,
   *  and a tail long enough to ring under the next bar. */
  function clank(t: number, gain: number): void {
    const base = 430;
    const ratios = [1, 2.37, 3.81, 5.19];
    const amps = [1, 0.55, 0.34, 0.18];
    for (let i = 0; i < ratios.length; i++) {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = base * ratios[i]!;
      const g = ac.createGain();
      env(g, t, gain * amps[i]! * 0.5, 0.002, 0, 0.42 - i * 0.06);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + 0.5);
    }
    noiseHit(t, 'bandpass', 3400, 2000, 1.4, gain * 0.3, 0.04);
  }

  /** The reversing alarm. One note, square, unapologetic. */
  function beeper(t: number, gain: number): void {
    const o = ac.createOscillator();
    o.type = 'square';
    o.frequency.value = 1046;
    const bq = ac.createBiquadFilter();
    bq.type = 'lowpass';
    bq.frequency.value = 3000;
    bq.Q.value = 1;
    const g = ac.createGain();
    env(g, t, gain * 0.22, 0.004, 0.10, 0.03);
    o.connect(bq); bq.connect(g); g.connect(out);
    o.start(t); o.stop(t + 0.2);
  }

  /** A jackhammer fill: a burst of hard, filtered impacts at 32nd notes. */
  function jack(t: number, gain: number, dur: number): void {
    const n = Math.max(4, Math.round(dur / 0.035));
    for (let i = 0; i < n; i++) {
      const at = t + i * (dur / n);
      noiseHit(at, 'bandpass', 620, 380, 1.8, gain * (i % 2 ? 0.5 : 0.85), 0.026, true);
      const o = ac.createOscillator();
      o.type = 'square';
      o.frequency.value = 96;
      const g = ac.createGain();
      env(g, at, gain * 0.3, 0.001, 0, 0.02);
      o.connect(g); g.connect(out);
      o.start(at); o.stop(at + 0.04);
    }
  }

  function bass(t: number, midi: number, dur: number, gain: number): void {
    const f = midiHz(midi);
    const o = ac.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    // In unison with the saw, not an octave below it. An octave below a D2 root
    // is 37Hz — a frequency that costs headroom on every note of the bassline
    // and that almost nobody will ever hear. At unison the same oscillator
    // does the job it was there for, which is to give the fundamental a clean
    // body under the saw's harmonics.
    const sub = ac.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = f;
    const ws = ac.createWaveShaper();
    ws.curve = bassCurve;
    const bq = ac.createBiquadFilter();
    bq.type = 'lowpass';
    bq.Q.value = 4;
    bq.frequency.setValueAtTime(f * 9, t);
    bq.frequency.exponentialRampToValueAtTime(f * 2.6, t + dur * 0.8);
    const g = ac.createGain();
    env(g, t, gain, 0.006, dur * 0.28, dur * 0.42);
    o.connect(ws); ws.connect(bq);
    sub.connect(bq);
    bq.connect(g); g.connect(out);
    o.start(t); o.stop(t + dur + 0.1);
    sub.start(t); sub.stop(t + dur + 0.1);
  }

  function brass(t: number, midi: number, dur: number, gain: number): void {
    const f = midiHz(midi);
    for (let i = 0; i < 3; i++) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = (i - 1) * 12;
      const ws = ac.createWaveShaper();
      ws.curve = brassCurve;
      const bq = ac.createBiquadFilter();
      bq.type = 'lowpass';
      bq.Q.value = 3;
      bq.frequency.setValueAtTime(f * 2, t);
      bq.frequency.exponentialRampToValueAtTime(f * 6.5, t + 0.05);
      const g = ac.createGain();
      env(g, t, gain * 0.3, 0.01, dur * 0.5, dur * 0.6);
      o.connect(ws); ws.connect(bq); bq.connect(g); g.connect(out);
      o.start(t); o.stop(t + dur + 0.15);
    }
  }

  function lead(t: number, midi: number, dur: number, gain: number): void {
    const f = midiHz(midi);
    const o = ac.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const vib = ac.createOscillator();
    vib.type = 'sine';
    vib.frequency.value = 5.6;
    const vibDepth = ac.createGain();
    vibDepth.gain.value = 9;
    vib.connect(vibDepth);
    vibDepth.connect(o.detune);
    const bq = ac.createBiquadFilter();
    bq.type = 'lowpass';
    bq.frequency.value = f * 5.5;
    bq.Q.value = 1.2;
    const g = ac.createGain();
    env(g, t, gain, 0.008, dur * 0.55, dur * 0.5);
    o.connect(bq); bq.connect(g); g.connect(out);
    o.start(t); o.stop(t + dur + 0.12);
    vib.start(t); vib.stop(t + dur + 0.12);
  }

  function bell(t: number, midi: number, dur: number, gain: number): void {
    const f = midiHz(midi);
    const parts = [1, 2, 3.01, 4.16];
    const amps = [1, 0.5, 0.24, 0.12];
    for (let i = 0; i < parts.length; i++) {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * parts[i]!;
      const g = ac.createGain();
      env(g, t, gain * amps[i]!, 0.003, 0, dur * (1 - i * 0.15));
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + dur + 0.2);
    }
  }

  // ── the sequencer ─────────────────────────────────────────────────────────

  const hit = (pattern: string, s: number): boolean => pattern.charCodeAt(s) === 120;

  function scheduleStep(t: number, index: number, stepDur: number): void {
    const bars = spec.bars;
    const bar = Math.floor(index / 16) % bars;
    const s = index % 16;
    const tr = spec.transpose;
    const inten = spec.intensity;
    const g = spec.level;

    if (spec.victory) {
      const root = VICTORY_ROOT[bar]! + tr;
      const third = root + (VICTORY_MINOR[bar] ? 3 : 4);
      if (s === 0) {
        bass(t, root, stepDur * 8, 0.5 * g);
        brass(t, root + 12, stepDur * 14, 0.42 * g);
        brass(t, third + 12, stepDur * 14, 0.34 * g);
        brass(t, root + 19, stepDur * 14, 0.3 * g);
        kick(t, 0.46 * g);
        if (bar === 0) noiseHit(t, 'highpass', 5200, 5200, 0.7, 0.22 * g, 0.9);
      }
      if (s === 8) { bass(t, root + 7, stepDur * 6, 0.4 * g); kick(t, 0.36 * g); }
      if (s === 4 || s === 12) snare(t, 0.36 * g);
      if (s % 2 === 0) hat(t, 0.045 * g, false);
      for (const n of VICTORY_LEAD[bar]!) {
        if (n[0] === s) bell(t, n[1]! + tr, stepDur * n[2]!, 0.3 * g);
      }
      return;
    }

    const root = RACE_ROOT[bar]! + tr;
    const minor = RACE_MINOR[bar] === 1;
    const third = root + (minor ? 3 : 4);
    const fifth = root + 7;
    const fillBar = (bar % 4) === 3;
    const bSection = bar >= 8 && bar < 12;

    // ── kit ────────────────────────────────────────────────────────────────
    // The kick is the loudest transient in the arrangement and it was pinning
    // the whole bed's peak at full scale four times a bar — which leaves the
    // limiter nothing to give the game itself. It only has to be *felt*.
    if (hit(fillBar ? KICK_FILL : KICK, s)) kick(t, 0.5 * g);
    if (hit(fillBar ? SNARE_FILL : SNARE, s)) snare(t, 0.34 * g);
    // Eighths always; sixteenths once the arrangement opens up.
    const sixteenths = inten > 0.6;
    if (sixteenths ? true : s % 2 === 0) {
      const accent = s % 4 === 2 ? 1 : 0.55;
      hat(t, 0.05 * accent * g, s === 14 && fillBar);
    }

    // ── roadworks ──────────────────────────────────────────────────────────
    if (hit(CLANK, s) && (inten > 0.5 || bar % 2 === 1)) clank(t, 0.5 * g);
    if (bSection && hit(BEEPER, s)) beeper(t, 0.9 * g);
    if (fillBar && s === 12) jack(t, 0.42 * g * (0.6 + 0.4 * inten), stepDur * 4);

    // ── bass ───────────────────────────────────────────────────────────────
    if (s % 2 === 0) {
      const walk = BASS_WALK[(s >> 1) % BASS_WALK.length]!;
      // Just over half an eighth note. A bassline whose notes fill their own
      // slot is a drone with pitch changes in it; the *gap* is the groove.
      bass(t, root + walk, stepDur * 1.05, 0.44 * g);
    }

    // ── stabs ──────────────────────────────────────────────────────────────
    if (hit(STAB, s)) {
      // Three notes of three detuned saws each is nine oscillators landing on
      // one sixteenth, and at the gain a single stab wants they summed to four
      // times the melody. Accompaniment: it keeps the offbeat, it does not
      // carry the tune.
      const oct = 24;
      brass(t, root + oct, stepDur * 1.4, 0.18 * g);
      brass(t, third + oct, stepDur * 1.4, 0.14 * g);
      brass(t, fifth + oct, stepDur * 1.4, 0.12 * g);
    }

    // ── melody ─────────────────────────────────────────────────────────────
    for (const n of leadBar(bar)) {
      if (n[0] !== s) continue;
      const dur = stepDur * n[2]!;
      lead(t, n[1]! + tr, dur, 0.22 * g);
      if (inten > 0.7) lead(t, n[1]! + tr + 12, dur, 0.10 * g);
    }
  }

  return {
    get mode() { return mode; },

    setMode(next, fadeTime = 0.4) {
      if (next === mode && !pending) return;
      if (next === 'none') {
        pending = null;
        mode = 'none';
        fadeTarget = 0;
        fade = Math.max(0.05, fadeTime);
        stopAt = be.now() + fade * 1.6 + 0.2;
        return;
      }
      if (mode === 'none' || !running) {
        // Cold start: begin on the downbeat immediately.
        mode = next;
        pending = null;
        spec = MODES[next];
        step = 0;
        nextTime = 0;
        running = true;
        fadeTarget = 1;
        fade = Math.max(0.05, fadeTime);
        return;
      }
      if (next === 'victory') {
        // The one change that must not wait for a bar line — the race is over.
        mode = 'victory';
        pending = null;
        spec = MODES.victory;
        step = 0;
        nextTime = 0;
        fadeTarget = 1;
        return;
      }
      // Everything else lands on the next bar, so a lift never sounds like a
      // skipped beat.
      pending = next;
    },

    duck(amount) {
      if (amount > duckAmount) duckAmount = clamp01(amount);
    },

    update(dt, now) {
      duckAmount = Math.max(0, duckAmount - dt * 2.4);

      const target = fadeTarget * baseLevel * lerp(1, 0.42, duckAmount);
      // The fade constant only matters while a fade is in flight; the deadband
      // in `set` keeps a settled bus from writing anything at all.
      level.tc = fade > 0 ? fade * 0.4 : 0.04;
      set(level, running ? target : 0, now);

      if (!running) return;
      if (fadeTarget === 0 && now > stopAt) {
        running = false;
        return;
      }

      if (nextTime === 0) nextTime = now + 0.06;
      // A backgrounded tab stops the render loop while the audio clock keeps
      // going. Rejoin the groove rather than playing the missing minute.
      if (nextTime < now - 0.5) nextTime = now + 0.03;

      let guard = 0;
      while (nextTime < now + LOOKAHEAD && guard++ < MAX_CATCHUP) {
        if (step % 16 === 0 && pending) {
          mode = pending;
          spec = MODES[pending];
          pending = null;
          step = 0;
        }
        // Read inside the loop: a lift that lands on this bar line changes the
        // tempo, and a stale step length would put a stutter in the join.
        const stepDur = 60 / spec.bpm / 4;
        scheduleStep(nextTime, step, stepDur);
        step = (step + 1) % (spec.bars * 16);
        nextTime += stepDur;
      }
    },

    dispose() {
      running = false;
      try { out.disconnect(); trim.disconnect(); comp.disconnect(); bus.disconnect(); send.disconnect(); } catch { /* already gone */ }
    },
  };
}
