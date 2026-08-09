// The music. A real tune, played by a sequencer, not a loop of ambience.
//
// **The form.** Two eight-bar phrases in D major at 152bpm.
//
//   bars 1-2   the hook
//   bars 3-4   its answer, turning back to the top
//   bars 5-6   the hook again, note for note
//   bars 7-8   a lift to the subdominant, ending on one long held note
//   bars 9-12  the bridge. Half a bar of *nothing* — a scaffold clank and a
//              reversing alarm alone — then the tune returns an octave down
//              over a sustained bass and a half-time kick, and climbs back
//   bars 13-16 the hook and its answer, home, with a crash on the downbeat
//
// That shape is the fix for a specific measured failure. The previous chart
// was sixteen bars of continuously new melody at one unvarying density: a
// self-similarity matrix of it had no block structure and no repeated-phrase
// stripes, a novelty curve had not one peak above 2.5 standard deviations, and
// the per-second level was flat inside 0.7dB for the whole loop. It was
// harmonically rich and it was an *ostinato*, not a tune. A theme needs a
// phrase you hear twice and a moment where everything stops — so now it has
// both, and the two joins (the break at bar 9, the return at bar 13) are the
// loudest structural events in the loop.
//
// The instruments are a driving eighth-note bass, offbeat brass stabs, a
// four-on-the-floor kit — and then the part that makes it this game's theme
// rather than a generic upbeat loop: a percussion section made of roadworks.
// A scaffold pole struck with a hammer keeps the offbeat, a jackhammer fills
// the last half-bar of every phrase, and the bridge is punctuated by a truck's
// reversing alarm on the beat. Those three sounds are the brief.
//
// Three things it has to do beyond playing:
//
//   Start on the grid. The intro and the countdown are 7.2 seconds — the most
//   anticipatory moment in the whole game — and they used to be dead air with
//   four beeps in it. `grid` is a four-bar vamp on a D pedal with the site
//   percussion and the reversing alarm, at the race tempo, and the flag cuts
//   straight from it to the theme's downbeat under the GO fanfare.
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
//
// Ducking is *not* here any more. It lives in `duck.ts`, on a node of its own
// in the mixer, driven from the instant a one-shot is scheduled — because
// doing it on this bus meant it inherited this bus's fade time constant and
// arrived 150ms after the explosion it was supposed to make room for.

import { driveCurve, midiHz } from './dsp.ts';
import { param, set } from './nodes.ts';
import type { AudioBackend } from './context.ts';

export type MusicMode = 'none' | 'menu' | 'grid' | 'race' | 'final' | 'star' | 'victory';
/** Everything but silence. Only these have a chart behind them. */
type ActiveMode = Exclude<MusicMode, 'none'>;

export interface Music {
  setMode(mode: MusicMode, fade?: number): void;
  readonly mode: MusicMode;
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
/** The bridge drops to half time. Two kicks a bar instead of four is the
 *  single cheapest way to make a section feel like it has opened up. */
const KICK_HALF = 'x.......x.......';
const SNARE = '....x.......x...';
const SNARE_FILL = '....x.......x.x.';
const SNARE_HALF = '....x.......x..x';
const STAB = '..x...x...x...x.';
const CLANK = '......x.......x.';
const BEEPER = 'x.......x.......';

/** Scale offsets the bass walks over its root, one per eighth note. */
const BASS_WALK = [0, 0, 7, 0, 12, 0, 7, 5];

/** [step, midi, lengthInSteps] */
type Note = readonly [number, number, number];

/**
 * The hook. Two bars over D and Bm, and the only two bars in the theme a
 * player is ever going to be able to hum.
 *
 * It climbs a D major arpeggio to a held top D and then falls away through the
 * relative minor, which is the oldest trick there is and the reason it sticks:
 * one gesture up, one gesture down, a long note in the middle to hang on to.
 * It is stated at bar 1, restated identically at bar 5, and comes home at bar
 * 13 — three times in a 25-second loop, which is what "theme" means.
 */
const HOOK: readonly (readonly Note[])[] = [
  [[0, 74, 2], [2, 78, 2], [4, 81, 3], [7, 83, 1], [8, 86, 5], [14, 83, 2]],
  [[0, 83, 2], [2, 81, 2], [4, 78, 4], [8, 76, 2], [10, 78, 2], [12, 74, 4]],
];
/** The answer: two bars over G and A that lift and then turn back to the top. */
const ANSWER: readonly (readonly Note[])[] = [
  [[0, 79, 2], [2, 83, 2], [4, 86, 3], [7, 88, 1], [8, 86, 4], [12, 83, 4]],
  [[0, 85, 2], [2, 83, 2], [4, 81, 2], [6, 78, 2], [8, 76, 4], [12, 81, 2], [14, 83, 2]],
];
/** Bars 7-8. The phrase goes higher than it has yet, then stops dead on one
 *  long A — the note the break falls out of. */
const LIFT: readonly (readonly Note[])[] = [
  [[0, 79, 2], [2, 81, 2], [4, 83, 4], [8, 86, 2], [10, 88, 2], [12, 90, 4]],
  [[0, 88, 2], [2, 85, 2], [4, 83, 2], [6, 81, 2], [8, 78, 5]],
];
/**
 * The bridge, bars 9-12. G - A - F#m - Bm.
 *
 * Bar 9 is empty for half a bar: that hole is the loudest structural event in
 * the theme, because a break is the one thing an ear cannot fail to notice.
 * When the tune comes back it is an octave below where it has lived all
 * loop — same instrument, different world — and it climbs from there back to
 * the hook.
 */
const BRIDGE: readonly (readonly Note[])[] = [
  [[8, 71, 4], [12, 74, 4]],
  [[0, 73, 2], [2, 76, 2], [4, 81, 4], [8, 79, 2], [10, 78, 2], [12, 76, 4]],
  [[0, 78, 2], [2, 73, 2], [4, 78, 4], [8, 81, 2], [10, 78, 2], [12, 73, 4]],
  [[0, 71, 2], [2, 74, 2], [4, 78, 2], [6, 81, 2], [8, 83, 4], [12, 85, 4]],
];

const VICTORY_LEAD: readonly (readonly Note[])[] = [
  [[0, 74, 4], [4, 78, 4], [8, 81, 8]],
  [[0, 79, 4], [4, 83, 4], [8, 86, 8]],
  [[0, 85, 4], [4, 81, 4], [8, 78, 8]],
  [[0, 74, 16]],
];

function leadBar(bar: number): readonly Note[] {
  if (bar < 2) return HOOK[bar]!;
  if (bar < 4) return ANSWER[bar - 2]!;
  if (bar < 6) return HOOK[bar - 4]!;
  if (bar < 8) return LIFT[bar - 6]!;
  if (bar < 12) return BRIDGE[bar - 8]!;
  if (bar < 14) return HOOK[bar - 12]!;
  return ANSWER[bar - 14]!;
}

type Chart = 'race' | 'victory' | 'grid';

interface ModeSpec {
  bpm: number;
  transpose: number;
  /** 0..1 arrangement weight: octave doubling, sixteenth hats, extra metal. */
  intensity: number;
  bars: number;
  chart: Chart;
  level: number;
}

const MODES: Record<ActiveMode, ModeSpec> = {
  /**
   * The front-end's theme.
   *
   * The whole of the front-end — title, machine, circuit, class — used to run on
   * `grid`, which is a four-bar zero-intensity holding pattern written for the
   * seven seconds between the grid forming and the flag. The game's title
   * screen had no theme; it had a vamp, on a loop, for as long as a player
   * spent choosing.
   *
   * So this is the theme, played the way a menu should play it: the full
   * sixteen-bar chart, so the hook, the break and the return all land, at a
   * relaxed tempo and a low arrangement weight. It is the same tune the race is
   * scored with — which is the point, because the moment the flag falls the
   * player should recognise where they are. `grid` is still what the hand-off
   * switches to, and the flag still cuts to the theme's own downbeat.
   */
  menu:    { bpm: 128, transpose: 0, intensity: 0.14, bars: 16, chart: 'race',    level: 0.78 },
  grid:    { bpm: 152, transpose: 0, intensity: 0.0,  bars: 4,  chart: 'grid',    level: 0.9 },
  race:    { bpm: 152, transpose: 0, intensity: 0.35, bars: 16, chart: 'race',    level: 1 },
  final:   { bpm: 164, transpose: 2, intensity: 0.85, bars: 16, chart: 'race',    level: 1.05 },
  star:    { bpm: 188, transpose: 2, intensity: 1.00, bars: 16, chart: 'race',    level: 1.1 },
  victory: { bpm: 104, transpose: 0, intensity: 0.5,  bars: 4,  chart: 'victory', level: 1 },
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

  /** A crash. Marks the two bar lines that matter — the top of the tune and
   *  the return of the hook — and nothing else, so it never becomes wallpaper. */
  function crash(t: number, gain: number): void {
    noiseHit(t, 'highpass', 3600, 3600, 0.7, gain * 0.20, 1.2);
    noiseHit(t, 'bandpass', 900, 700, 0.9, gain * 0.10, 0.5, true);
  }

  /**
   * A swept band of noise: up, and it is a riser into a section; down, and it
   * is the floor falling out from under one. Two of these are what make the
   * break at bar 9 and the return at bar 13 read as *edits* rather than as the
   * arrangement happening to thin out.
   */
  function sweep(t: number, gain: number, dur: number, up: boolean): void {
    const src = ac.createBufferSource();
    src.buffer = be.pink;
    src.loop = true;
    const bq = ac.createBiquadFilter();
    bq.type = 'bandpass';
    bq.Q.value = 1.3;
    bq.frequency.setValueAtTime(up ? 380 : 5400, t);
    bq.frequency.exponentialRampToValueAtTime(up ? 6200 : 300, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    if (up) {
      g.gain.exponentialRampToValueAtTime(Math.max(1e-4, gain), t + dur);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.14);
    } else {
      g.gain.exponentialRampToValueAtTime(Math.max(1e-4, gain), t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }
    src.connect(bq); bq.connect(g); g.connect(out);
    src.start(t, (t * 3.7) % 2.4);
    src.stop(t + dur + 0.25);
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

    if (spec.chart === 'grid') {
      // The grid. Four bars of a works site idling before the flag: a D pedal,
      // the reversing alarm on every downbeat, scaffold on the offbeat, and a
      // kit that goes from half time to four-on-the-floor across the vamp so
      // the last bar before GO is already moving. No melody at all — the
      // countdown beeps are the melody, and this is what they sit on.
      const root = 38 + tr;
      const building = bar >= 2;
      if (hit(building ? KICK : KICK_HALF, s)) kick(t, 0.42 * g);
      if (s % 2 === 0) hat(t, 0.035 * (s % 4 === 2 ? 1 : 0.5) * g, false);
      if (hit(BEEPER, s)) beeper(t, 0.85 * g);
      if (hit(CLANK, s)) clank(t, 0.42 * g);
      if (s === 0) bass(t, root, stepDur * 7, 0.40 * g);
      if (s === 8) bass(t, root + 7, stepDur * 7, 0.34 * g);
      if (bar === 0 && s === 0) crash(t, 0.35 * g);
      // The last half-bar of the vamp: a jackhammer and a riser, so the loop
      // point itself sounds like something is about to happen. It is, four
      // times over, and then the flag cuts it off.
      if (bar === 3 && s === 8) sweep(t, 0.09 * g, stepDur * 8, true);
      if (bar === 3 && s === 12) jack(t, 0.34 * g, stepDur * 4);
      return;
    }

    if (spec.chart === 'victory') {
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
    const fillBar = (bar & 3) === 3;
    const bridge = bar >= 8 && bar < 12;
    /** The two lightened bars of the bridge, before it starts climbing back. */
    const light = bar === 8 || bar === 9;
    /**
     * The bridge's dynamic arc, as a plain gain on the whole arrangement.
     *
     * Arranging alone was not enough. Rendered and measured, the bridge came
     * out *louder* than the hook — sustained roots hold more energy than a
     * gapped eighth-note walk does, and a section that is supposed to feel like
     * a step backwards cannot be a step up on the meter. So it steps back four
     * decibels and climbs from there, and by bar 12 it is pushing.
     */
    const bg = light ? 0.62 : bar === 10 ? 0.82 : 1;
    /** The break itself: the first half of bar 9. */
    const hole = bar === 8 && s < 8;
    /** The two bar lines the form turns on. */
    const top = bar === 0 || bar === 12;

    if (hole) {
      // Two beats of held breath. One scaffold clank and two blasts of the
      // reversing alarm across the first half-beat, and then nothing at
      // all — no kick, no bass, no hats, no tune, for two thirds of a second.
      // Measured on its own it is a 10dB hole in the middle of a bed that used
      // to be flat inside a decibel for its entire loop, and it costs nothing.
      if (s === 0) { clank(t, 0.7 * g); beeper(t, 1.0 * g); }
      if (s === 2) beeper(t, 0.7 * g);
      return;
    }

    // ── the joins ──────────────────────────────────────────────────────────
    if (top && s === 0) crash(t, 0.55 * g);
    // Out of the lift and into the break: the floor drops away.
    if (bar === 7 && s === 12) sweep(t, 0.085 * g, stepDur * 3.4, false);
    // Out of the bridge and back to the hook: half a bar of riser.
    if (bar === 11 && s === 8) sweep(t, 0.13 * g, stepDur * 8, true);
    // And the loop point itself. Bars 13-16 are bars 1-4 note for note, which
    // is what a recapitulation is; without something on the very last beat the
    // seam is simply the tune starting again for no reason.
    if (bar === 15 && s === 12) sweep(t, 0.10 * g, stepDur * 4, true);

    // ── kit ────────────────────────────────────────────────────────────────
    // The kick is the loudest transient in the arrangement and it was pinning
    // the whole bed's peak at full scale four times a bar — which leaves the
    // limiter nothing to give the game itself. It only has to be *felt*.
    // The last half of bar 12 drops the kit entirely under the fill: the hook
    // then walks back in on a downbeat with a crash on it, which is the single
    // biggest change of state in the loop and measures as one.
    const dropped = bar === 11 && s >= 8;
    const kickPat = light ? KICK_HALF : fillBar ? KICK_FILL : KICK;
    if (!dropped && hit(kickPat, s)) kick(t, (light ? 0.42 : 0.5) * bg * g);
    const snarePat = light ? SNARE_HALF : fillBar ? SNARE_FILL : SNARE;
    if (!dropped && hit(snarePat, s)) snare(t, (light ? 0.26 : 0.34) * bg * g);
    // Eighths always; sixteenths once the arrangement opens up — but never
    // through the bridge, which is supposed to breathe.
    const sixteenths = inten > 0.6 && !light;
    if (!dropped && (sixteenths || s % 2 === 0)) {
      const accent = s % 4 === 2 ? 1 : 0.55;
      hat(t, 0.05 * accent * (light ? 0.55 : 1) * bg * g, s === 14 && fillBar);
    }

    // ── roadworks ──────────────────────────────────────────────────────────
    if (hit(CLANK, s) && (inten > 0.5 || (bar & 1) === 1 || bridge)) clank(t, 0.5 * bg * g);
    if (bridge && hit(BEEPER, s)) beeper(t, 0.9 * bg * g);
    // Bar 12's jackhammer is the run-up to the hook, so it gets the loud one.
    if (fillBar && s === 12) {
      jack(t, 0.42 * g * (0.6 + 0.4 * inten) * (bar === 11 ? 1.35 : 1), stepDur * 4);
    }

    // ── bass ───────────────────────────────────────────────────────────────
    if (light) {
      // Sustained roots instead of the eighth-note walk. The walk is the
      // engine of the A section; taking it away is most of why the bridge
      // sounds like a different piece of music played by the same band.
      if (s === 0) bass(t, root, stepDur * 6, 0.34 * bg * g);
      if (s === 8) bass(t, fifth, stepDur * 6, 0.30 * bg * g);
    } else if (s % 2 === 0) {
      const walk = BASS_WALK[(s >> 1) % BASS_WALK.length]!;
      // Just over half an eighth note. A bassline whose notes fill their own
      // slot is a drone with pitch changes in it; the *gap* is the groove.
      bass(t, root + walk, stepDur * 1.05, 0.44 * bg * g);
    }

    // ── stabs ──────────────────────────────────────────────────────────────
    // The A section's signature, and they stay out of the bridge until bar 12
    // brings them back to push into the return.
    if (hit(STAB, s) && (!bridge || bar === 11)) {
      // Three notes of three detuned saws each is nine oscillators landing on
      // one sixteenth, and at the gain a single stab wants they summed to four
      // times the melody. Accompaniment: it keeps the offbeat, it does not
      // carry the tune.
      const oct = 24;
      const sg = bar === 11 ? 1.25 : 1;
      brass(t, root + oct, stepDur * 1.4, 0.18 * sg * g);
      brass(t, third + oct, stepDur * 1.4, 0.14 * sg * g);
      brass(t, fifth + oct, stepDur * 1.4, 0.12 * sg * g);
    }

    // ── melody ─────────────────────────────────────────────────────────────
    for (const n of leadBar(bar)) {
      if (n[0] !== s) continue;
      const dur = stepDur * n[2]!;
      // The bridge's octave-down restatement wants a little more weight, or
      // dropping it twelve semitones simply loses it under the bass.
      lead(t, n[1]! + tr, dur, (light ? 0.26 : 0.22) * bg * g);
      if (inten > 0.7) lead(t, n[1]! + tr + 12, dur, 0.10 * bg * g);
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
      if (next === 'victory' || mode === 'grid') {
        // Two changes that must not wait for a bar line.
        //
        // Victory, because the race is over. And anything leaving the grid,
        // because the flag falls when the flag falls — the vamp is four bars
        // of anticipation and the countdown does not land on its bar line, so
        // GO cuts it off mid-phrase and the theme starts on its own downbeat
        // underneath the fanfare. A hard edit at the single loudest moment in
        // the game is not a seam anyone will ever hear.
        mode = next;
        pending = null;
        spec = MODES[next];
        step = 0;
        nextTime = 0;
        fadeTarget = 1;
        return;
      }
      // Everything else lands on the next bar, so a lift never sounds like a
      // skipped beat.
      pending = next;
    },

    update(dt, now) {
      const target = fadeTarget * baseLevel;
      // The fade constant only matters while a fade is in flight; the deadband
      // in `set` keeps a settled bus from writing anything at all.
      //
      // Nothing but a fade is allowed on this parameter. The duck used to
      // share it, which meant the duck inherited the *fade's* time constant —
      // 0.14s for an ordinary change of track — and a sidechain that takes
      // 140ms to open is a sidechain that arrives after the explosion. It now
      // lives on its own node in the mixer. See `duck.ts`.
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
