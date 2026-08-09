// The one-shot bank. Every impact, pickup, chime and explosion in the game.
//
// The house style, and it is the whole reason these read as Nintendo rather
// than as a synthesiser demo: **three layers, never one**. A body that carries
// the weight (a sine or a saturated triangle sliding downward), a transient
// that carries the *event* (a few milliseconds of filtered noise), and a top
// that carries the character (a bell, a chirp, a metallic partial). Take away
// the transient and nothing sounds like it happened; take away the body and
// nothing has any size; take away the top and every sound in the game is the
// same sound.
//
// The second rule is that nothing is a pure tone with a flat decay. Everything
// glides — pitch envelopes are what turn a beep into a boing — and everything
// is filtered by something that moves. A static filter is a timbre; a moving
// one is a gesture.
//
// Nothing here holds state beyond its own scheduling. A shot is built, given to
// the audio thread with an explicit stop time, and forgotten; the nodes fall
// off the graph when their source ends.

import { clamp, clamp01, lerp, makeRng } from '../core/math.ts';
import { driveCurve, midiHz, N } from './dsp.ts';
import { createPlacement, place } from './nodes.ts';
import type * as THREE from 'three';
import type { AudioBackend } from './context.ts';
import type { Listener } from './nodes.ts';

export interface PlayOpts {
  volume?: number;
  /** Pitch/rate multiplier. */
  rate?: number;
  /** World position. Omit for a sound that belongs to the player's own head. */
  pos?: THREE.Vector3;
  /** Hard stereo placement, -1..1, when there is no world position to use. */
  pan?: number;
  /** Generic 0..1 intensity: impact force, boost tier, countdown beat. */
  level?: number;
}

/** Where a shot is being written to, and how loud. Reused — never allocated. */
interface Shot {
  t: number;
  dest: AudioNode;
  gain: number;
  rate: number;
  level: number;
}

interface ToneOpts {
  wave?: OscillatorType;
  /** Start and (optional) end frequency, and how long the glide takes. */
  f0: number;
  f1?: number;
  glide?: number;
  /** Exponential glide reads as a pitch *bend*; linear reads as a siren. */
  linear?: boolean;
  gain: number;
  attack?: number;
  hold?: number;
  decay: number;
  delay?: number;
  detune?: number;
  /** An optional moving filter on this layer alone. */
  filter?: BiquadFilterType;
  cut0?: number;
  cut1?: number;
  q?: number;
  /** Saturation. Above zero the layer grows harmonics as it gets louder. */
  drive?: number;
  /** Vibrato depth in cents, and its rate. */
  vibrato?: number;
  vibratoRate?: number;
}

interface NoiseOpts {
  filter: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
  gain: number;
  attack?: number;
  decay: number;
  delay?: number;
  pink?: boolean;
  /** Play the buffer faster/slower — shifts the whole noise spectrum. */
  rate?: number;
}

export interface SoundBank {
  play(id: string, opts?: PlayOpts): void;
  /** Frames since the last call are irrelevant; this only refills the budget. */
  frame(now: number, dt: number): void;
  /** 0..1, how hard the bank has been hit lately. Drives music ducking. */
  readonly loudness: number;
}

/**
 * Minimum seconds between two firings of the same sound.
 *
 * A racing game generates events in bursts — eight karts crossing a boost pad
 * abreast, a shell hitting a racer already scraping a barrier — and the same
 * sound stacked on itself five times inside a frame does not get louder, it
 * gets *combed*: the copies phase against each other and the result is a metallic
 * flange that sounds like a bug. These are the shortest gaps at which each one
 * still reads as two events.
 */
const THROTTLE: Record<string, number> = {
  coin: 0.045,
  'item.reel': 0.02,
  wall: 0.09,
  bump: 0.07,
  land: 0.06,
  hop: 0.05,
  boost: 0.05,
  blast: 0.05,
  bounce: 0.05,
};
const DEFAULT_THROTTLE = 0.03;

/** Ceiling on shots started in one frame, and on the running total. Neither is
 *  reachable by playing the game — they exist so that a module in a runaway
 *  loop degrades the mix instead of the framerate. */
const FRAME_BUDGET = 8;
const BUSY_BUDGET = 26;

export function createSoundBank(be: AudioBackend, listener: Listener): SoundBank {
  const rng = makeRng(0x5eed17);
  const last = new Map<string, number>();
  const pl = createPlacement();
  let budget = FRAME_BUDGET;
  let busy = 0;
  let loud = 0;

  const drive = (amount: number): Float32Array<ArrayBuffer> =>
    be.curve(`drive${amount}`, () => driveCurve(amount));

  // ── layer builders ────────────────────────────────────────────────────────

  function tone(s: Shot, o: ToneOpts): void {
    const t = s.t + (o.delay ?? 0);
    const osc = be.ac.createOscillator();
    osc.type = o.wave ?? 'sine';
    if (o.detune) osc.detune.value = o.detune;
    const f0 = Math.max(8, o.f0 * s.rate);
    osc.frequency.setValueAtTime(f0, t);
    if (o.f1 !== undefined) {
      const f1 = Math.max(8, o.f1 * s.rate);
      const end = t + (o.glide ?? o.decay);
      if (o.linear) osc.frequency.linearRampToValueAtTime(f1, end);
      else osc.frequency.exponentialRampToValueAtTime(f1, end);
    }

    let head: AudioNode = osc;

    if (o.vibrato) {
      const lfo = be.ac.createOscillator();
      lfo.frequency.value = o.vibratoRate ?? 6;
      const depth = be.ac.createGain();
      depth.gain.value = o.vibrato;
      lfo.connect(depth);
      depth.connect(osc.detune);
      lfo.start(t);
      lfo.stop(t + (o.attack ?? 0.004) + (o.hold ?? 0) + o.decay + 0.05);
    }

    if (o.drive) {
      const ws = be.ac.createWaveShaper();
      ws.curve = drive(o.drive);
      head.connect(ws);
      head = ws;
    }

    if (o.filter) {
      const bq = be.ac.createBiquadFilter();
      bq.type = o.filter;
      bq.Q.value = o.q ?? 1;
      bq.frequency.setValueAtTime(Math.max(20, (o.cut0 ?? 1000) * s.rate), t);
      if (o.cut1 !== undefined) {
        bq.frequency.exponentialRampToValueAtTime(
          Math.max(20, o.cut1 * s.rate), t + (o.glide ?? o.decay));
      }
      head.connect(bq);
      head = bq;
    }

    const g = be.ac.createGain();
    const attack = o.attack ?? 0.004;
    const peak = Math.max(1e-4, o.gain * s.gain);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    if (o.hold) g.gain.setValueAtTime(peak, t + attack + o.hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + (o.hold ?? 0) + o.decay);
    head.connect(g);
    g.connect(s.dest);

    osc.start(t);
    osc.stop(t + attack + (o.hold ?? 0) + o.decay + 0.02);
  }

  function noise(s: Shot, o: NoiseOpts): void {
    const t = s.t + (o.delay ?? 0);
    const src = be.ac.createBufferSource();
    src.buffer = o.pink ? be.pink : be.white;
    src.loop = true;
    // A random offset into the bed, so two hits in the same frame are not the
    // same noise — which is the difference between two impacts and one impact
    // with a phasing artefact on it.
    const dur = (o.attack ?? 0.003) + o.decay;
    src.loopStart = 0;
    src.playbackRate.value = o.rate ?? 1;

    const bq = be.ac.createBiquadFilter();
    bq.type = o.filter;
    bq.Q.value = o.q ?? 1;
    bq.frequency.setValueAtTime(clamp(o.f0 * s.rate, 20, 20000), t);
    if (o.f1 !== undefined) {
      bq.frequency.exponentialRampToValueAtTime(clamp(o.f1 * s.rate, 20, 20000), t + dur);
    }

    const g = be.ac.createGain();
    const attack = o.attack ?? 0.003;
    const peak = Math.max(1e-4, o.gain * s.gain);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(bq);
    bq.connect(g);
    g.connect(s.dest);
    src.start(t, rng.range(0, 2.4));
    src.stop(t + dur + 0.02);
  }

  /** Three inharmonic partials — the ratios a struck metal bar actually has.
   *  Every clang, clink and scaffold-pole hit in the game is this. */
  function metal(s: Shot, base: number, gain: number, decay: number): void {
    const ratios = [1, 2.41, 3.83, 5.44];
    const amps = [1, 0.62, 0.38, 0.2];
    for (let i = 0; i < ratios.length; i++) {
      tone(s, {
        wave: 'sine', f0: base * ratios[i]!, gain: gain * amps[i]!,
        attack: 0.002, decay: decay * (1 - i * 0.16),
      });
    }
    noise(s, { filter: 'bandpass', f0: base * 4.5, q: 1.2, gain: gain * 0.5, decay: 0.03 });
  }

  /** A short brass-ish note: three detuned saws through a filter that opens.
   *  Every fanfare in the game is built out of these. */
  function brass(s: Shot, midi: number, gain: number, dur: number, delay: number): void {
    const f = midiHz(midi);
    for (let i = 0; i < 3; i++) {
      tone(s, {
        wave: 'sawtooth', f0: f, gain: gain * 0.34, detune: (i - 1) * 11,
        attack: 0.012, hold: dur * 0.55, decay: dur * 0.65, delay,
        filter: 'lowpass', cut0: f * 2.2, cut1: f * 7, q: 3.5, drive: 1.4,
      });
    }
  }

  /** A bell: a bright partial stack with a fast attack and a long, clean tail.
   *  Coins, item pickups and lap chimes. */
  function bell(s: Shot, midi: number, gain: number, decay: number, delay: number): void {
    const f = midiHz(midi);
    tone(s, { wave: 'sine', f0: f, gain: gain, attack: 0.002, decay, delay });
    tone(s, { wave: 'sine', f0: f * 2, gain: gain * 0.5, attack: 0.002, decay: decay * 0.7, delay });
    tone(s, { wave: 'sine', f0: f * 3.01, gain: gain * 0.2, attack: 0.002, decay: decay * 0.4, delay });
    tone(s, {
      wave: 'triangle', f0: f * 4.02, gain: gain * 0.12,
      attack: 0.001, decay: decay * 0.25, delay,
    });
  }

  // ── the bank ──────────────────────────────────────────────────────────────

  function build(id: string, s: Shot): number {
    const lv = s.level;
    switch (id) {
      // ── speed ─────────────────────────────────────────────────────────────
      case 'boost':
      case 'pad': {
        const bright = lerp(1, 1.5, lv);
        noise(s, {
          filter: 'bandpass', f0: 420, f1: 3600 * bright, q: 1.1,
          gain: 0.5, attack: 0.012, decay: 0.30, pink: true,
        });
        tone(s, { wave: 'sine', f0: 160, f1: 52, gain: 0.75, attack: 0.004, decay: 0.26 });
        tone(s, {
          wave: 'sawtooth', f0: 300 * bright, f1: 1500 * bright, gain: 0.20,
          attack: 0.008, decay: 0.22, filter: 'lowpass', cut0: 800, cut1: 5200, q: 5, drive: 2,
        });
        noise(s, {
          filter: 'lowpass', f0: 1400, f1: 300, gain: 0.22,
          attack: 0.02, decay: 0.55, pink: true, delay: 0.05,
        });
        return 0.5;
      }
      case 'drift.release': {
        // The mini-turbo. The boost body, plus a bell at the tier's own
        // interval — so the three tiers pay out three different chords and a
        // player learns which one they earned without looking at the sparks.
        const tier = clamp(Math.round(lv * 3), 1, 3);
        const root = [0, N.D5, N.Fs5, N.A5][tier]!;
        noise(s, {
          filter: 'bandpass', f0: 500, f1: 4200, q: 1.0,
          gain: 0.52, attack: 0.008, decay: 0.26 + tier * 0.05, pink: true,
        });
        tone(s, { wave: 'sine', f0: 190, f1: 48, gain: 0.8, attack: 0.003, decay: 0.28 });
        bell(s, root, 0.28, 0.55 + tier * 0.12, 0.01);
        bell(s, root + 7, 0.16, 0.42, 0.055);
        if (tier >= 3) bell(s, root + 12, 0.14, 0.6, 0.1);
        return 0.85;
      }
      case 'drift.tier': {
        // The instant a mini-turbo tier locks in. Deliberately small and very
        // short: the charge tone under it is the meter, and this is only the
        // click of the needle passing a mark. It shares its pitches with
        // `drift.release`, so the tier you heard lock in is the tier you hear
        // pay out.
        const tier = clamp(Math.round(lv * 3), 1, 3);
        const root = [0, N.D5, N.Fs5, N.A5][tier]!;
        bell(s, root + 12, 0.13, 0.22 + tier * 0.04, 0);
        if (tier >= 2) bell(s, root + 19, 0.07, 0.18, 0.02);
        noise(s, { filter: 'highpass', f0: 5200, gain: 0.05, decay: 0.02 });
        return 0.15;
      }
      case 'rocket': {
        noise(s, {
          filter: 'bandpass', f0: 300, f1: 5000, q: 0.8,
          gain: 0.7, attack: 0.01, decay: 0.5, pink: true,
        });
        tone(s, { wave: 'sine', f0: 220, f1: 40, gain: 1.0, attack: 0.003, decay: 0.5 });
        tone(s, {
          wave: 'sawtooth', f0: 180, f1: 900, gain: 0.3, attack: 0.01, decay: 0.42,
          filter: 'lowpass', cut0: 600, cut1: 6000, q: 6, drive: 3,
        });
        bell(s, N.A5, 0.2, 0.5, 0.02);
        return 1;
      }
      case 'burnout': {
        // Bogged down on the line: the engine drops into a lumpy stall and the
        // tyres go up in smoke with nothing to show for it.
        tone(s, {
          wave: 'sawtooth', f0: 150, f1: 46, gain: 0.5, attack: 0.01, decay: 0.9,
          filter: 'lowpass', cut0: 900, cut1: 220, q: 4, drive: 5, vibrato: 90, vibratoRate: 11,
        });
        noise(s, {
          filter: 'bandpass', f0: 2400, f1: 900, q: 2.5, gain: 0.3,
          attack: 0.03, decay: 0.85,
        });
        return 0.6;
      }
      case 'trick': {
        noise(s, {
          filter: 'bandpass', f0: 700, f1: 4600, q: 3.5, gain: 0.42,
          attack: 0.01, decay: 0.16,
        });
        tone(s, {
          wave: 'triangle', f0: 420, f1: 1500, gain: 0.16, attack: 0.006, decay: 0.18,
        });
        return 0.35;
      }

      // ── contact ───────────────────────────────────────────────────────────
      case 'hop': {
        tone(s, { wave: 'triangle', f0: 330, f1: 170, gain: 0.14, attack: 0.002, decay: 0.09 });
        noise(s, { filter: 'highpass', f0: 2600, gain: 0.10, decay: 0.04 });
        return 0.15;
      }
      case 'land': {
        const hard = clamp01(lv);
        tone(s, {
          wave: 'sine', f0: lerp(110, 78, hard), f1: 40,
          gain: 0.35 + 0.65 * hard, attack: 0.002, decay: 0.13 + 0.12 * hard,
        });
        noise(s, {
          filter: 'lowpass', f0: 900, f1: 260, q: 0.7,
          gain: 0.16 + 0.3 * hard, attack: 0.002, decay: 0.14, pink: true,
        });
        // Suspension. Only on a real drop — a drift hop landing with a
        // full-size clatter behind it is the single most fatiguing sound a kart
        // racer can make, because it happens six times a corner.
        if (hard > 0.35) {
          noise(s, {
            filter: 'bandpass', f0: 1500, f1: 700, q: 2.2,
            gain: 0.14 * hard, attack: 0.004, decay: 0.2, delay: 0.02,
          });
          metal(s, 240, 0.06 * hard, 0.22);
        }
        return 0.3 + 0.5 * hard;
      }
      case 'wall': {
        const force = clamp01(lv);
        metal(s, lerp(300, 190, force), 0.18 + 0.42 * force, 0.34 + 0.3 * force);
        noise(s, {
          filter: 'bandpass', f0: 2800, f1: 1300, q: 1.6,
          gain: 0.2 + 0.3 * force, attack: 0.002, decay: 0.12 + 0.16 * force,
        });
        tone(s, {
          wave: 'sine', f0: 120, f1: 46, gain: 0.3 * force, attack: 0.002, decay: 0.16,
        });
        return 0.4 + 0.5 * force;
      }
      case 'bump': {
        tone(s, { wave: 'sine', f0: 150, f1: 62, gain: 0.4, attack: 0.002, decay: 0.13 });
        noise(s, {
          filter: 'lowpass', f0: 1100, f1: 400, gain: 0.2, decay: 0.09, pink: true,
        });
        tone(s, { wave: 'triangle', f0: 260, f1: 180, gain: 0.1, attack: 0.003, decay: 0.1 });
        return 0.3;
      }
      case 'offroad': {
        // Two wheels off the road. A short burst of loose material under the
        // floor, not an impact — the moment has a cost attached and the sound
        // has to be legible with a corner still to be driven.
        noise(s, {
          filter: 'lowpass', f0: 2600, f1: 700, q: 0.9,
          gain: 0.3, attack: 0.006, decay: 0.22, pink: true,
        });
        noise(s, {
          filter: 'bandpass', f0: 1500, f1: 900, q: 1.6,
          gain: 0.16, attack: 0.004, decay: 0.16,
        });
        tone(s, { wave: 'sine', f0: 105, f1: 58, gain: 0.22, attack: 0.004, decay: 0.16 });
        return 0.3;
      }
      case 'scrape': {
        noise(s, {
          filter: 'bandpass', f0: 3200, f1: 2000, q: 6, gain: 0.16, attack: 0.01, decay: 0.16,
        });
        return 0.2;
      }

      // ── being hit ─────────────────────────────────────────────────────────
      case 'hit.spin': {
        // A slip, not a smash: tyres let go, the machine takes one lazy turn.
        noise(s, {
          filter: 'bandpass', f0: 1800, f1: 3000, q: 5, gain: 0.28, attack: 0.006, decay: 0.3,
        });
        tone(s, {
          wave: 'triangle', f0: 540, f1: 170, glide: 0.42, gain: 0.24,
          attack: 0.004, decay: 0.45, vibrato: 40, vibratoRate: 9,
        });
        tone(s, { wave: 'sine', f0: 130, f1: 60, gain: 0.3, attack: 0.003, decay: 0.2 });
        return 0.55;
      }
      case 'hit.flip': {
        // Launched. A crunch, a clang and a body dropping an octave and a half.
        noise(s, {
          filter: 'lowpass', f0: 5200, f1: 400, q: 0.8, gain: 0.55, attack: 0.002, decay: 0.34,
        });
        metal(s, 205, 0.32, 0.42);
        tone(s, { wave: 'sine', f0: 150, f1: 38, gain: 0.9, attack: 0.002, decay: 0.32 });
        tone(s, {
          wave: 'sawtooth', f0: 320, f1: 90, gain: 0.16, attack: 0.004, decay: 0.36,
          filter: 'lowpass', cut0: 2600, cut1: 500, q: 4, drive: 3,
        });
        return 1;
      }
      case 'hit.bump': {
        tone(s, { wave: 'sine', f0: 170, f1: 64, gain: 0.55, attack: 0.002, decay: 0.18 });
        noise(s, { filter: 'lowpass', f0: 1600, f1: 420, gain: 0.3, decay: 0.14, pink: true });
        return 0.45;
      }
      case 'hit.squish': {
        // Flattened on the spot. A pitch collapse plus the zap that caused it.
        tone(s, {
          wave: 'square', f0: 720, f1: 84, glide: 0.3, gain: 0.26,
          attack: 0.003, decay: 0.4, filter: 'lowpass', cut0: 3200, cut1: 380, q: 3, drive: 4,
        });
        noise(s, {
          filter: 'highpass', f0: 3400, gain: 0.3, attack: 0.001, decay: 0.1,
        });
        tone(s, { wave: 'sine', f0: 90, f1: 34, gain: 0.5, attack: 0.002, decay: 0.3 });
        return 0.8;
      }

      // ── money ─────────────────────────────────────────────────────────────
      case 'coin': {
        // The two-note ping every kart racer has, and it has it because a
        // single note reads as a click while a rising interval reads as a
        // *reward*. A fifth up, both notes short, the second brighter.
        bell(s, N.B5, 0.20, 0.10, 0);
        bell(s, N.Fs6, 0.22, 0.34, 0.055);
        noise(s, { filter: 'highpass', f0: 6000, gain: 0.07, decay: 0.03 });
        return 0.3;
      }
      case 'coin.lose': {
        const notes = [N.Fs6, N.D6, N.B5, N.Fs5];
        for (let i = 0; i < notes.length; i++) {
          bell(s, notes[i]!, 0.13 - i * 0.02, 0.16, i * 0.048);
        }
        noise(s, { filter: 'bandpass', f0: 900, f1: 380, q: 1.4, gain: 0.14, decay: 0.22 });
        return 0.4;
      }

      // ── items ─────────────────────────────────────────────────────────────
      case 'item.box': {
        // Glass and light. Bright inharmonic partials plus a rising sparkle,
        // so the box reads as *opened* rather than as hit.
        const base = 900;
        const ratios = [1, 1.51, 2.03, 2.77, 3.51];
        for (let i = 0; i < ratios.length; i++) {
          tone(s, {
            wave: 'sine', f0: base * ratios[i]!, gain: 0.14 / (1 + i * 0.5),
            attack: 0.002, decay: 0.5 - i * 0.06,
          });
        }
        noise(s, {
          filter: 'bandpass', f0: 2600, f1: 8000, q: 1.6, gain: 0.2, attack: 0.004, decay: 0.16,
        });
        return 0.4;
      }
      case 'item.reel': {
        // One click per face of the drum. It rises as the reel slows, which is
        // what makes the deceleration audible instead of merely visible.
        const up = clamp01(lv);
        tone(s, {
          wave: 'square', f0: lerp(900, 1700, up), gain: 0.075,
          attack: 0.001, decay: 0.028, filter: 'bandpass', cut0: lerp(1800, 3200, up), q: 2,
        });
        noise(s, { filter: 'highpass', f0: 4200, gain: 0.05, decay: 0.012 });
        return 0.08;
      }
      case 'item.get': {
        bell(s, N.D5, 0.16, 0.16, 0);
        bell(s, N.A5, 0.16, 0.16, 0.06);
        bell(s, N.D6, 0.20, 0.5, 0.12);
        return 0.35;
      }
      case 'item.use.banana': {
        tone(s, { wave: 'sine', f0: 420, f1: 240, gain: 0.2, attack: 0.003, decay: 0.11 });
        noise(s, { filter: 'lowpass', f0: 1800, f1: 700, gain: 0.12, decay: 0.07 });
        return 0.2;
      }
      case 'item.use.shell': {
        noise(s, {
          filter: 'bandpass', f0: 800, f1: 3800, q: 3, gain: 0.32, attack: 0.005, decay: 0.16,
        });
        tone(s, {
          wave: 'triangle', f0: 500, f1: 1300, gain: 0.16, attack: 0.004, decay: 0.16,
        });
        return 0.35;
      }
      case 'item.use.red': {
        noise(s, {
          filter: 'bandpass', f0: 900, f1: 4200, q: 3, gain: 0.32, attack: 0.005, decay: 0.17,
        });
        // The lock-on. Two hard blips before it goes — the tell that this one
        // is following someone.
        tone(s, { wave: 'square', f0: 1500, gain: 0.09, attack: 0.001, decay: 0.035 });
        tone(s, { wave: 'square', f0: 1900, gain: 0.09, attack: 0.001, decay: 0.05, delay: 0.07 });
        return 0.4;
      }
      case 'item.use.mushroom': {
        tone(s, {
          wave: 'triangle', f0: 240, f1: 760, glide: 0.16, gain: 0.26,
          attack: 0.004, decay: 0.24, vibrato: 25, vibratoRate: 14,
        });
        noise(s, {
          filter: 'bandpass', f0: 600, f1: 3200, q: 1.4, gain: 0.24, attack: 0.008, decay: 0.2,
        });
        return 0.4;
      }
      case 'item.use.star': {
        const arp = [N.D5, N.Fs5, N.A5, N.D6, N.Fs6];
        for (let i = 0; i < arp.length; i++) bell(s, arp[i]!, 0.16, 0.4, i * 0.045);
        noise(s, {
          filter: 'bandpass', f0: 3000, f1: 9000, q: 1.2, gain: 0.16, attack: 0.02, decay: 0.4,
        });
        return 0.7;
      }
      case 'item.use.bullet': {
        tone(s, { wave: 'sine', f0: 210, f1: 44, gain: 0.9, attack: 0.003, decay: 0.44 });
        noise(s, {
          filter: 'bandpass', f0: 500, f1: 5600, q: 0.9, gain: 0.6, attack: 0.012, decay: 0.5,
          pink: true,
        });
        tone(s, {
          wave: 'sawtooth', f0: 130, f1: 700, gain: 0.22, attack: 0.01, decay: 0.5,
          filter: 'lowpass', cut0: 500, cut1: 5000, q: 5, drive: 3.5,
        });
        return 1;
      }
      case 'item.use.lightning': {
        noise(s, {
          filter: 'highpass', f0: 1800, gain: 0.85, attack: 0.001, decay: 0.22,
        });
        noise(s, {
          filter: 'bandpass', f0: 6000, f1: 900, q: 1.1, gain: 0.5, attack: 0.002, decay: 0.5,
        });
        tone(s, {
          wave: 'sawtooth', f0: 900, f1: 60, glide: 0.42, gain: 0.3,
          attack: 0.002, decay: 0.6, filter: 'lowpass', cut0: 6000, cut1: 300, q: 2, drive: 6,
        });
        tone(s, { wave: 'sine', f0: 130, f1: 32, gain: 0.9, attack: 0.004, decay: 0.7 });
        return 1;
      }
      case 'item.use.blooper': {
        noise(s, {
          filter: 'lowpass', f0: 2400, f1: 380, q: 1.4, gain: 0.42, attack: 0.004, decay: 0.32,
          pink: true,
        });
        tone(s, {
          wave: 'sine', f0: 360, f1: 110, glide: 0.22, gain: 0.28, attack: 0.004, decay: 0.3,
        });
        return 0.5;
      }
      case 'item.use.boo': {
        tone(s, {
          wave: 'sine', f0: 300, f1: 900, glide: 0.5, gain: 0.16,
          attack: 0.05, decay: 0.85, vibrato: 60, vibratoRate: 5.5,
        });
        tone(s, {
          wave: 'sine', f0: 452, f1: 1340, glide: 0.5, gain: 0.10,
          attack: 0.07, decay: 0.85, vibrato: 70, vibratoRate: 4.7,
        });
        return 0.5;
      }
      case 'item.use.bomb': {
        tone(s, { wave: 'triangle', f0: 300, f1: 180, gain: 0.16, attack: 0.003, decay: 0.12 });
        noise(s, {
          filter: 'bandpass', f0: 5200, q: 1.4, gain: 0.13, attack: 0.02, decay: 0.5,
        });
        return 0.25;
      }
      case 'item.use.horn': {
        // A genuine two-tone air horn. The right sound for a game about
        // roadworks machines, and the only item that gets to be this rude.
        const dur = 0.42;
        for (const f of [318, 401]) {
          for (let i = 0; i < 2; i++) {
            tone(s, {
              wave: 'sawtooth', f0: f, gain: 0.3, detune: i ? 7 : -7,
              attack: 0.012, hold: dur, decay: 0.14,
              filter: 'lowpass', cut0: 1600, cut1: 2600, q: 1.2, drive: 2.4,
            });
          }
        }
        noise(s, {
          filter: 'highpass', f0: 4000, gain: 0.08, attack: 0.01, decay: dur,
        });
        return 1;
      }
      case 'item.use.coin': {
        bell(s, N.Fs5, 0.16, 0.12, 0);
        bell(s, N.B5, 0.18, 0.14, 0.05);
        bell(s, N.Fs6, 0.2, 0.4, 0.1);
        return 0.35;
      }
      case 'bounce': {
        // A shell off a barrier. Springy and pitched, so a bounce behind you is
        // instantly distinguishable from a hit.
        const up = clamp01(lv);
        tone(s, {
          wave: 'triangle', f0: lerp(560, 900, up), f1: lerp(300, 480, up), glide: 0.09,
          gain: 0.2, attack: 0.002, decay: 0.14,
        });
        metal(s, lerp(620, 900, up), 0.08, 0.12);
        return 0.25;
      }
      case 'blast': {
        // A bob-omb. Sub, body, and a crackling tail — and it is the one sound
        // in the game allowed to own the whole mix for a quarter of a second.
        tone(s, { wave: 'sine', f0: 150, f1: 26, glide: 0.5, gain: 1.0, attack: 0.002, decay: 0.6 });
        noise(s, {
          filter: 'lowpass', f0: 6500, f1: 180, q: 0.9, gain: 0.85, attack: 0.002, decay: 0.7,
          pink: true,
        });
        noise(s, {
          filter: 'bandpass', f0: 2200, f1: 600, q: 0.8, gain: 0.45, attack: 0.004, decay: 0.35,
        });
        for (let i = 0; i < 5; i++) {
          noise(s, {
            filter: 'bandpass', f0: rng.range(1400, 5200), q: 3, gain: 0.1,
            attack: 0.001, decay: 0.04, delay: 0.08 + i * rng.range(0.03, 0.09),
          });
        }
        return 1;
      }
      case 'shrink': {
        tone(s, {
          wave: 'square', f0: 900, f1: 220, glide: 0.34, gain: 0.16, attack: 0.005, decay: 0.4,
          filter: 'lowpass', cut0: 3000, cut1: 700, q: 2,
        });
        return 0.3;
      }
      case 'grow': {
        tone(s, {
          wave: 'square', f0: 240, f1: 940, glide: 0.3, gain: 0.16, attack: 0.005, decay: 0.36,
          filter: 'lowpass', cut0: 800, cut1: 3400, q: 2,
        });
        bell(s, N.D6, 0.14, 0.4, 0.28);
        return 0.3;
      }

      // ── the race ──────────────────────────────────────────────────────────
      case 'countdown': {
        // Three beats of the same note, so the ear has a tempo to sit on and
        // the change on GO lands as an event rather than as a fourth beep.
        tone(s, {
          wave: 'square', f0: midiHz(N.A4), gain: 0.22, attack: 0.004, hold: 0.1, decay: 0.16,
          filter: 'lowpass', cut0: 2600, q: 2,
        });
        tone(s, { wave: 'sine', f0: midiHz(N.A3), gain: 0.14, attack: 0.004, hold: 0.08, decay: 0.2 });
        return 0.5;
      }
      case 'countdown.go': {
        for (const m of [N.D5, N.Fs5, N.A5]) brass(s, m, 0.3, 0.34, 0);
        bell(s, N.D6, 0.24, 0.7, 0);
        noise(s, {
          filter: 'bandpass', f0: 700, f1: 5000, q: 0.9, gain: 0.3, attack: 0.008, decay: 0.3,
        });
        tone(s, { wave: 'sine', f0: 130, f1: 44, gain: 0.6, attack: 0.003, decay: 0.35 });
        return 1;
      }
      case 'lap': {
        const line = [N.D5, N.Fs5, N.A5];
        for (let i = 0; i < line.length; i++) brass(s, line[i]!, 0.26, 0.2, i * 0.085);
        bell(s, N.D6, 0.2, 0.6, 0.17);
        return 0.7;
      }
      case 'lap.final': {
        // Urgent, not celebratory: it goes *up* and keeps going.
        const line = [N.D5, N.G5, N.B5, N.D6];
        for (let i = 0; i < line.length; i++) brass(s, line[i]!, 0.28, 0.18, i * 0.075);
        noise(s, {
          filter: 'bandpass', f0: 1200, f1: 6000, q: 2.2, gain: 0.24,
          attack: 0.02, decay: 0.32, delay: 0.2,
        });
        bell(s, N.D6, 0.22, 0.8, 0.3);
        return 1;
      }
      case 'finish': {
        const line = [N.D5, N.Fs5, N.A5, N.D6];
        for (let i = 0; i < line.length; i++) brass(s, line[i]!, 0.3, 0.16, i * 0.08);
        for (const m of [N.D5, N.Fs5, N.A5, N.D6]) brass(s, m, 0.26, 0.8, 0.34);
        bell(s, N.D6, 0.24, 1.2, 0.34);
        noise(s, {
          filter: 'bandpass', f0: 800, f1: 4000, q: 0.8, gain: 0.2, attack: 0.05, decay: 0.7,
          pink: true,
        });
        return 1;
      }
      case 'warn.tick': {
        tone(s, {
          wave: 'square', f0: lerp(760, 1250, lv), gain: 0.13, attack: 0.002,
          hold: 0.02, decay: 0.07, filter: 'bandpass', cut0: lerp(1400, 2400, lv), q: 2.5,
        });
        return 0.15;
      }
      case 'ui.click': {
        tone(s, { wave: 'square', f0: 1200, gain: 0.08, attack: 0.001, decay: 0.03 });
        return 0.08;
      }
      default:
        return 0;
    }
  }

  const shot: Shot = { t: 0, dest: be.sfx, gain: 1, rate: 1, level: 1 };

  /** Positioned one-shots get their own three-node tail. Short-lived by
   *  construction: every source feeding it stops, so the chain falls off the
   *  graph on its own. */
  function spatialDest(x: number, y: number, z: number, send: number): AudioNode | null {
    place(listener, x, y, z, 0, 0, 0, pl);
    if (pl.gain < 0.02) return null;
    const g = be.ac.createGain();
    g.gain.value = pl.gain;
    const lp = be.ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = pl.cut;
    lp.Q.value = 0.4;
    g.connect(lp);
    if (typeof be.ac.createStereoPanner === 'function') {
      const p = be.ac.createStereoPanner();
      p.pan.value = pl.pan;
      lp.connect(p);
      p.connect(be.sfx);
    } else {
      lp.connect(be.sfx);
    }
    if (send > 0) {
      const sg = be.ac.createGain();
      // Distance sends *more* to the room, not less. That inversion is the
      // whole trick: a near explosion is dry and physical, a far one is mostly
      // the canyon answering, and the difference reads as distance far more
      // strongly than level ever does.
      sg.gain.value = send * lerp(0.5, 2.4, clamp01(pl.distance / 70));
      g.connect(sg);
      sg.connect(be.verb);
    }
    return g;
  }

  /** How much of the room each family of sounds is allowed. */
  function sendFor(id: string): number {
    if (id === 'blast' || id.startsWith('hit.') || id === 'wall') return 0.3;
    if (id.startsWith('item.use.') || id === 'item.box') return 0.18;
    if (id === 'coin' || id === 'item.get' || id.startsWith('lap') || id === 'finish') return 0.22;
    if (id === 'countdown' || id === 'countdown.go') return 0.3;
    return 0.1;
  }

  return {
    play(id, opts) {
      const now = be.now();
      const gap = THROTTLE[id] ?? DEFAULT_THROTTLE;
      const prev = last.get(id);
      if (prev !== undefined && now - prev < gap) return;
      if (budget <= 0 || busy >= BUSY_BUDGET) return;

      const send = sendFor(id);
      let dest: AudioNode = be.sfx;
      if (opts?.pos) {
        const placed = spatialDest(opts.pos.x, opts.pos.y, opts.pos.z, send);
        if (!placed) return;
        dest = placed;
      } else {
        if (send > 0) {
          // Unpositioned sounds still want a little air, or the whole game
          // sounds like it is happening inside a car.
          const sg = be.ac.createGain();
          sg.gain.value = send * 0.5;
          const tap = be.ac.createGain();
          tap.gain.value = 1;
          tap.connect(be.sfx);
          tap.connect(sg);
          sg.connect(be.verb);
          dest = tap;
        }
        if (opts?.pan !== undefined && typeof be.ac.createStereoPanner === 'function') {
          const p = be.ac.createStereoPanner();
          p.pan.value = clamp(opts.pan, -1, 1);
          p.connect(dest);
          dest = p;
        }
      }

      last.set(id, now);
      budget--;
      busy++;

      shot.t = now + 0.008; // a hair of lead time, so nothing is scheduled late
      shot.dest = dest;
      shot.gain = opts?.volume ?? 1;
      shot.rate = opts?.rate ?? 1;
      shot.level = opts?.level ?? 1;
      const weight = build(id, shot);
      if (weight > loud) loud = weight;
    },

    frame(now, dt) {
      budget = FRAME_BUDGET;
      busy = Math.max(0, busy - dt * 40);
      loud = Math.max(0, loud - dt * 2.6);
      // Drop stale throttle entries so the map cannot grow without bound across
      // a long session.
      if (last.size > 96) {
        for (const [k, v] of last) if (now - v > 3) last.delete(k);
      }
    },

    get loudness() { return loud; },
  };
}
