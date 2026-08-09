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
 * The mix desk.
 *
 * Every sound above is *designed* — layers, envelopes, glides — and none of
 * that says anything about how loud it should be next to the others. Left
 * alone, loudness ends up decided by how many layers a sound happens to have,
 * and a measured render of this bank said exactly that: a barrier scrape came
 * out louder than a bob-omb, a red shell fired 20dB below a landing, and the
 * whole bank spanned 30dB in an order nobody chose. Lightning peaked *over*
 * full scale on its own.
 *
 * So the levels live here, in one table, set against a target curve rather than
 * per sound:
 *
 *   +1 dB   the four things allowed to own the mix: an explosion, a smash,
 *           the flag, the finish.
 *   -3 dB   your own big moment — a mini-turbo, a rocket start, a bullet, and
 *           each machine's signature shout.
 *   -5.5 dB speed you were given: a pad, a boost, the final lap.
 *   -7.5 dB contact. Walls and landings happen every corner of every lap and
 *           are the single easiest way to make a racing game exhausting.
 *   -10.5dB firing an item, and being handed one.
 *   -13 dB  small rewards and state changes.
 *   -18 dB  texture: a hop, a trick, the first bite of a drift.
 *
 * The curve was re-cut once the bed was given headroom (`context.ts`), and the
 * *spread* is the change that matters, not the level. It used to run from -5dB
 * down to -18dB; it now runs from +1dB down to -18dB, and its top sits 8dB
 * above a bed that has itself moved 8dB down. A bob-omb is therefore ~14dB
 * more prominent than it was, which is the difference between hearing a hole
 * in the mix and hearing an explosion.
 *
 * The numbers are ratios measured against that curve by `bench.ts`, not taste.
 * Re-measure with `__AUDIO.render` after changing any sound above; a sound that
 * has grown a layer will have moved.
 */
const TRIM: Record<string, number> = {
  // own the mix
  blast: 0.82, 'item.use.lightning': 0.55, 'hit.flip': 0.72,
  'countdown.go': 1.15, finish: 1.24, 'finish.back': 1.43,
  // your own big moment
  'item.use.horn': 0.66, 'item.use.bullet': 0.94, rocket: 0.96, 'drift.release': 0.96,
  'sig.truck': 0.98, 'sig.plane': 1.41, 'sig.train': 1.50, 'sig.digger': 1.74,
  'sig.car': 2.91, 'sig.helicopter': 3.15, 'sig.cone': 1.66,
  // speed you were given
  boost: 0.77, pad: 0.77, burnout: 0.83, 'lap.final': 1.56, 'hit.squish': 0.77,
  // contact
  wall: 0.47, land: 0.52, splat: 0.74, 'hit.bump': 0.76, 'hit.spin': 1.25,
  lap: 1.02, countdown: 1.18, 'countdown.set': 1.11, offroad: 1.10,
  // items
  'item.use.red': 0.81, 'item.use.shell': 2.09, 'item.use.bomb': 2.20,
  'item.use.mushroom': 1.48, 'item.use.banana': 1.40, 'item.use.boo': 1.54,
  'item.use.blooper': 0.79, 'item.use.star': 1.20, 'item.use.coin': 1.00,
  'item.box': 0.95, 'item.get': 1.05, coin: 1.11, bump: 0.81,
  // small rewards and state changes
  bounce: 0.97, draft: 1.00, 'drift.tier': 1.06, grow: 1.20, shrink: 1.50,
  'coin.lose': 1.48, 'effect.end': 1.40, 'boo.on': 1.55, 'boo.off': 1.22,
  jump: 1.14,
  // texture
  hop: 0.87, trick: 1.45, scrape: 1.5, 'ui.click': 1.67, 'item.reel': 1.2,
};

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

/**
 * Every id the bank answers to.
 *
 * Kept next to the bank rather than derived from it because a switch cannot be
 * enumerated at runtime, and a reviewer — or the bench — needs to be able to
 * fire all of them without reading this file. An id missing from here still
 * plays; it is simply invisible to anything walking the list.
 */
export const SOUND_IDS: readonly string[] = [
  'boost', 'pad', 'drift.release', 'drift.tier', 'rocket', 'burnout', 'trick',
  'hop', 'land', 'wall', 'bump', 'offroad', 'scrape',
  'hit.spin', 'hit.flip', 'hit.bump', 'hit.squish',
  'coin', 'coin.lose',
  'item.box', 'item.reel', 'item.get',
  'item.use.banana', 'item.use.shell', 'item.use.red', 'item.use.mushroom',
  'item.use.star', 'item.use.bullet', 'item.use.lightning', 'item.use.blooper',
  'item.use.boo', 'item.use.bomb', 'item.use.horn', 'item.use.coin',
  'bounce', 'blast', 'shrink', 'grow', 'splat', 'boo.on', 'boo.off', 'effect.end',
  'sig.cone', 'sig.plane', 'sig.helicopter', 'sig.digger', 'sig.train',
  'sig.truck', 'sig.car',
  'jump', 'draft',
  'countdown', 'countdown.set', 'countdown.go', 'lap', 'lap.final', 'finish', 'finish.back',
  'warn.tick', 'ui.click',
];

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
        // The first bite of a drift: the instant the rears let go. A narrow
        // band is what makes it rubber rather than gravel, and a narrow band
        // throws away most of its own level — so there are two of them, a
        // squeal and the scuff underneath it, or the moment the player commits
        // to a corner arrives silently.
        noise(s, {
          filter: 'bandpass', f0: 3200, f1: 2000, q: 6, gain: 0.5, attack: 0.01, decay: 0.16,
        });
        noise(s, {
          filter: 'bandpass', f0: 1100, f1: 700, q: 1.6, gain: 0.26,
          attack: 0.006, decay: 0.12, pink: true,
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
        // A homing shell, and it must not sound like the green one with a beep
        // on it — it is the item everyone in the field is afraid of. The lock-on
        // blips come first, then it *goes*: a launch whoosh with a body under it
        // that climbs away, so the sound leaves rather than merely happening.
        tone(s, { wave: 'square', f0: 1500, gain: 0.11, attack: 0.001, decay: 0.04 });
        tone(s, { wave: 'square', f0: 1900, gain: 0.11, attack: 0.001, decay: 0.055, delay: 0.06 });
        noise(s, {
          filter: 'bandpass', f0: 700, f1: 4600, q: 1.4, gain: 0.42,
          attack: 0.008, decay: 0.26, delay: 0.12,
        });
        tone(s, {
          wave: 'sawtooth', f0: 260, f1: 900, glide: 0.24, gain: 0.2, attack: 0.006, decay: 0.28,
          filter: 'lowpass', cut0: 900, cut1: 4000, q: 4, drive: 2.4, delay: 0.12,
        });
        tone(s, { wave: 'sine', f0: 150, f1: 70, gain: 0.34, attack: 0.004, decay: 0.2, delay: 0.12 });
        return 0.5;
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
        // The sub arrives a beat behind the crack, and swells rather than
        // snapping. Stacked on the same instant the two summed into one very
        // tall sample and the mix bought a 3dB peak it got nothing for; offset
        // by twelve milliseconds the *energy* is unchanged, the peak drops
        // into the clear — and it is also what an explosion at any distance
        // actually does, which is why it reads as bigger rather than louder.
        tone(s, {
          wave: 'sine', f0: 150, f1: 26, glide: 0.5, gain: 1.05,
          attack: 0.012, decay: 0.6, delay: 0.012,
        });
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

      case 'splat': {
        // Ink across the visor. Wet, dull, and immediately obvious that
        // something has been done *to* you.
        noise(s, {
          filter: 'lowpass', f0: 3200, f1: 240, q: 1.2, gain: 0.5, attack: 0.004, decay: 0.26,
          pink: true,
        });
        tone(s, {
          wave: 'sine', f0: 260, f1: 70, glide: 0.16, gain: 0.36, attack: 0.003, decay: 0.24,
        });
        noise(s, {
          filter: 'bandpass', f0: 900, f1: 400, q: 1.6, gain: 0.18,
          attack: 0.01, decay: 0.4, delay: 0.05, pink: true,
        });
        return 0.6;
      }
      case 'boo.on': {
        // Vanishing. Everything slides up and thins out.
        tone(s, {
          wave: 'sine', f0: 220, f1: 1400, glide: 0.4, gain: 0.2,
          attack: 0.03, decay: 0.5, vibrato: 55, vibratoRate: 6.5,
        });
        noise(s, {
          filter: 'bandpass', f0: 700, f1: 6000, q: 2.4, gain: 0.16, attack: 0.05, decay: 0.4,
        });
        return 0.4;
      }
      case 'boo.off': {
        // Back in the world, and heavier than you left it.
        tone(s, {
          wave: 'sine', f0: 1200, f1: 200, glide: 0.28, gain: 0.2,
          attack: 0.01, decay: 0.34, vibrato: 45, vibratoRate: 7,
        });
        noise(s, { filter: 'lowpass', f0: 4000, f1: 700, gain: 0.16, decay: 0.16 });
        return 0.35;
      }
      case 'effect.end': {
        // A protection running out. Two notes down, quiet, unmistakable — the
        // player has a second to change their mind about the corner ahead.
        bell(s, N.A5, 0.13, 0.2, 0);
        bell(s, N.D5, 0.15, 0.42, 0.07);
        return 0.25;
      }

      // ── the machines ──────────────────────────────────────────────────────
      // One word each, on top of a boost. See `signature` in index.ts for why
      // these exist: seven machines that sound different at cruise have to stay
      // different at the moment the player is listening hardest.
      case 'sig.cone': {
        // A little two-stroke wound past its limit. Buzzy, comic, brief — and
        // it needs a body as well as a buzz: the narrow band that makes the
        // strimmer a strimmer also throws away most of the level, so a second
        // layer goes through a wide filter to give the machine some size.
        tone(s, {
          wave: 'sawtooth', f0: 300, f1: 980, glide: 0.2, gain: 0.3,
          attack: 0.006, hold: 0.05, decay: 0.16,
          filter: 'bandpass', cut0: 900, cut1: 2800, q: 3.5, drive: 5,
          vibrato: 70, vibratoRate: 26,
        });
        tone(s, {
          wave: 'sawtooth', f0: 150, f1: 490, glide: 0.2, gain: 0.28,
          attack: 0.006, hold: 0.05, decay: 0.18,
          filter: 'lowpass', cut0: 700, cut1: 2200, q: 1.4, drive: 3,
          vibrato: 70, vibratoRate: 26,
        });
        noise(s, { filter: 'highpass', f0: 3200, gain: 0.1, attack: 0.01, decay: 0.14 });
        return 0.4;
      }
      case 'sig.plane': {
        // The prop biting. Two saws a few cents apart so the beat is audible,
        // sweeping up under a rush of air.
        for (let i = 0; i < 2; i++) {
          tone(s, {
            wave: 'sawtooth', f0: 96, f1: 190, glide: 0.34, gain: 0.24, detune: i ? 9 : -9,
            attack: 0.02, hold: 0.1, decay: 0.24,
            filter: 'lowpass', cut0: 700, cut1: 2000, q: 2, drive: 1.6,
          });
        }
        noise(s, {
          filter: 'bandpass', f0: 500, f1: 2600, q: 0.9, gain: 0.26, attack: 0.05, decay: 0.34,
          pink: true,
        });
        return 0.55;
      }
      case 'sig.helicopter': {
        // Collective pulled: the turbine spools and the blades speed up. Six
        // slaps, accelerating — a modulated gate cannot be scheduled this
        // precisely, so the one-shot spells them out.
        for (let i = 0; i < 6; i++) {
          noise(s, {
            filter: 'bandpass', f0: 700 - i * 40, q: 1.5, gain: 0.3 - i * 0.02,
            attack: 0.002, decay: 0.05, delay: i * (0.075 - i * 0.007), pink: true,
          });
        }
        tone(s, {
          wave: 'sawtooth', f0: 900, f1: 2600, glide: 0.42, gain: 0.1,
          attack: 0.04, decay: 0.4, filter: 'bandpass', cut0: 1200, cut1: 3000, q: 8,
        });
        tone(s, { wave: 'sine', f0: 120, f1: 62, gain: 0.3, attack: 0.01, decay: 0.34 });
        return 0.6;
      }
      case 'sig.digger': {
        // Hydraulics, then the bucket. A big machine doing something it was
        // built for, badly, at speed.
        tone(s, {
          wave: 'sine', f0: 1500, f1: 2600, glide: 0.26, gain: 0.09,
          attack: 0.03, decay: 0.28, filter: 'bandpass', cut0: 1800, cut1: 2800, q: 9,
        });
        tone(s, {
          wave: 'sawtooth', f0: 70, f1: 120, glide: 0.2, gain: 0.3, attack: 0.01, decay: 0.3,
          filter: 'lowpass', cut0: 400, cut1: 900, q: 2, drive: 4,
        });
        metal(s, 165, 0.2, 0.4);
        return 0.7;
      }
      case 'sig.train': {
        // A steam whistle: a chord of open pipes, not one note, with the last
        // partial slightly out — which is the entire reason a real whistle
        // sounds like a whistle and a sine sounds like a kettle.
        const dur = 0.5;
        const parts = [523, 622, 784, 932];
        const amps = [0.20, 0.15, 0.13, 0.08];
        for (let i = 0; i < parts.length; i++) {
          tone(s, {
            wave: 'sine', f0: parts[i]! * 0.97, f1: parts[i]!, glide: 0.07, gain: amps[i]!,
            attack: 0.05, hold: dur, decay: 0.24, vibrato: 12, vibratoRate: 5.5,
          });
        }
        noise(s, {
          filter: 'bandpass', f0: 2600, q: 1.1, gain: 0.14, attack: 0.04, decay: dur * 0.9,
        });
        return 0.85;
      }
      case 'sig.truck': {
        // The air horn, an octave up on the item version and half as long — it
        // is a punctuation mark here, not a weapon.
        const dur = 0.24;
        for (const f of [420, 528]) {
          for (let i = 0; i < 2; i++) {
            tone(s, {
              wave: 'sawtooth', f0: f, gain: 0.2, detune: i ? 8 : -8,
              attack: 0.01, hold: dur, decay: 0.12,
              filter: 'lowpass', cut0: 1800, cut1: 3000, q: 1.2, drive: 2.2,
            });
          }
        }
        noise(s, { filter: 'highpass', f0: 4200, gain: 0.06, attack: 0.008, decay: dur });
        return 0.7;
      }
      case 'sig.car': {
        // A rev flare and the blow-off valve after it. The one machine in the
        // cast that is simply fast, and it gets to sound smug about it.
        tone(s, {
          wave: 'sawtooth', f0: 180, f1: 620, glide: 0.16, gain: 0.22,
          attack: 0.008, decay: 0.22, filter: 'lowpass', cut0: 900, cut1: 4200, q: 4, drive: 2.4,
        });
        noise(s, {
          filter: 'bandpass', f0: 5200, f1: 2400, q: 2.6, gain: 0.22,
          attack: 0.006, decay: 0.16, delay: 0.19,
        });
        return 0.5;
      }

      // ── air ───────────────────────────────────────────────────────────────
      case 'jump': {
        // Leaving the ground properly. Air over the body, rising as it goes up.
        const big = clamp01(lv);
        noise(s, {
          filter: 'bandpass', f0: 380, f1: lerp(1400, 2600, big), q: 1.0,
          gain: 0.18 + 0.2 * big, attack: 0.06, decay: 0.3, pink: true,
        });
        tone(s, {
          wave: 'sine', f0: 170, f1: lerp(300, 460, big), glide: 0.2,
          gain: 0.12 + 0.14 * big, attack: 0.01, decay: 0.24,
        });
        return 0.3;
      }
      case 'draft': {
        // Punching out of a rival's wake. The suck first, then the release —
        // the shape is what tells the player they have *left* the wake with
        // something to show for it.
        noise(s, {
          filter: 'bandpass', f0: 1900, f1: 420, q: 1.3, gain: 0.3,
          attack: 0.05, decay: 0.2, pink: true,
        });
        noise(s, {
          filter: 'bandpass', f0: 500, f1: 3400, q: 1.0, gain: 0.34,
          attack: 0.02, decay: 0.26, delay: 0.13, pink: true,
        });
        tone(s, {
          wave: 'sine', f0: 120, f1: 240, glide: 0.2, gain: 0.3, attack: 0.02, decay: 0.28,
          delay: 0.1,
        });
        return 0.45;
      }

      // ── the race ──────────────────────────────────────────────────────────
      case 'countdown': {
        // Three beats of the same note, so the ear has a tempo to sit on and
        // the change on GO lands as an event rather than as a fourth beep. The
        // *pitch* holds; only the brightness and length climb, which reads as
        // rising tension without breaking the metronome.
        const urg = clamp01(lv);
        tone(s, {
          wave: 'square', f0: midiHz(N.A4), gain: 0.20 + 0.04 * urg,
          attack: 0.004, hold: 0.09 + 0.03 * urg, decay: 0.16,
          filter: 'lowpass', cut0: lerp(2000, 3400, urg), q: 2,
        });
        tone(s, { wave: 'sine', f0: midiHz(N.A3), gain: 0.14, attack: 0.004, hold: 0.08, decay: 0.2 });
        return 0.5;
      }
      case 'countdown.set': {
        // The fourth beat. Same voice as the three before it but a fourth up,
        // onto the tonic of the fanfare that is about to land — so the count
        // resolves musically instead of merely stopping. Under it, a one-second
        // riser: the exact length of the gap between this beat and the flag,
        // swelling to nothing at the moment the flag falls, which is what makes
        // the rocket-start window feel like a window.
        tone(s, {
          wave: 'square', f0: midiHz(N.D5), gain: 0.24, attack: 0.004, hold: 0.1, decay: 0.18,
          filter: 'lowpass', cut0: 3200, q: 2,
        });
        tone(s, { wave: 'sine', f0: midiHz(N.D4), gain: 0.15, attack: 0.004, hold: 0.08, decay: 0.22 });
        noise(s, {
          filter: 'bandpass', f0: 260, f1: 3600, q: 1.1,
          gain: 0.20, attack: 0.92, decay: 0.1, pink: true,
        });
        tone(s, {
          wave: 'sawtooth', f0: midiHz(N.D3), f1: midiHz(N.D4), glide: 0.95, gain: 0.08,
          attack: 0.9, decay: 0.1, filter: 'lowpass', cut0: 400, cut1: 2200, q: 3, drive: 1.6,
        });
        return 0.55;
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
      case 'finish.back': {
        // Off the podium. The same instrument and the same key as `finish` — it
        // is the same event — but the line falls instead of rising and the
        // chord it lands on is minor. Deliberately not a joke: the player is
        // going to hear this more often than the other one, and a game that
        // laughs at you six times a cup is a game you stop playing.
        // D - A - F falling, onto a D minor triad. Intervals rather than named
        // notes, because the minor third this needs is not one the major-key
        // chart above ever asks for.
        const line = [N.D5, N.A4, N.D4 + 3];
        for (let i = 0; i < line.length; i++) brass(s, line[i]!, 0.26, 0.2, i * 0.1);
        for (const m of [N.D4, N.D4 + 3, N.D4 + 7]) brass(s, m, 0.2, 0.7, 0.34);
        noise(s, {
          filter: 'lowpass', f0: 2200, f1: 700, q: 0.8, gain: 0.14,
          attack: 0.05, decay: 0.6, pink: true, delay: 0.3,
        });
        return 0.8;
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
    if (id === 'coin' || id === 'item.get' || id.startsWith('lap') || id.startsWith('finish')) return 0.22;
    if (id.startsWith('countdown')) return 0.3;
    // A machine shouting in a canyon gets an answer. It is the one family of
    // sounds whose whole job is to be *the place*, so it gets the most room.
    if (id.startsWith('sig.')) return 0.34;
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
      let heard = 1;
      if (opts?.pos) {
        const placed = spatialDest(opts.pos.x, opts.pos.y, opts.pos.z, send);
        if (!placed) return;
        // `spatialDest` has just written the distance gain into `pl`, and the
        // music duck needs it: a bob-omb a hundred metres up the road is barely
        // audible, and a mix that drops the bed to 42% for it is a mix that
        // ducks for things the player cannot hear.
        heard = pl.gain;
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

      const volume = opts?.volume ?? 1;
      shot.t = now + 0.008; // a hair of lead time, so nothing is scheduled late
      shot.dest = dest;
      shot.gain = volume * (TRIM[id] ?? 1);
      shot.rate = opts?.rate ?? 1;
      shot.level = opts?.level ?? 1;
      // How hard the mix should get out of the way. Deliberately *not* scaled by
      // the mix trim: the trim says how loud this sound is allowed to be, and
      // folding it in here would mean the game ducked least for the sounds it
      // had decided were most important. The caller's own volume does count,
      // because that is how far away and how relevant the event was.
      const weight = build(id, shot) * clamp01(volume) * heard;
      if (weight > loud) loud = weight;
      // Open the hole at the *same instant* the voice starts, not on the next
      // frame off an accumulated scalar. This one line is the difference
      // between an explosion landing in a gap and an explosion being followed
      // by one.
      be.duck.hit(weight, shot.t);
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
