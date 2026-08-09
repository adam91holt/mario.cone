// The measuring bench.
//
// Sound is the one part of this game a screenshot cannot judge. Everything else
// in the repo is reviewed by rendering a frame and looking at it; this is the
// equivalent for audio — it builds the *same* mixer inside an
// OfflineAudioContext, drives the same voices through the same per-frame update
// calls, renders faster than realtime and hands back the samples.
//
// That distinction matters: nothing here re-implements a sound. If the bench
// says the mini-turbo peaks at -3dBFS and puts its energy at 2kHz, that is what
// the game does, because it is the same code on a different clock.
//
// None of it runs unless something calls it. It exists so a reviewer — or the
// author — can answer "does the truck actually change gear" with a measurement
// instead of an opinion.

import { createOfflineBackend } from './context.ts';
import { createRacerVoice, createDrive } from './engines.ts';
import { createSoundBank } from './sfx.ts';
import { createCues } from './cues.ts';
import { createMusic } from './music.ts';
import { createListener, createPlacement, place } from './nodes.ts';
import { createDucker } from './duck.ts';
import type { VehicleId } from '../types.ts';
import type { CueState } from './cues.ts';
import type { MusicMode } from './music.ts';

export interface BenchShot {
  id: string;
  /** Seconds into the render. */
  at: number;
  volume?: number;
  level?: number;
  rate?: number;
  /** World position, for testing placement. Omitted = in the player's head. */
  pos?: [number, number, number];
}

export interface BenchEngine {
  vehicleId: VehicleId;
  isPlayer?: boolean;
  /** Speed fraction at the start and end of the render — the sweep is what
   *  makes a gearbox visible on a spectrogram. */
  ramp?: [number, number];
  throttle?: number;
  slip?: number;
  boost?: number;
  offroad?: number;
  /** Metres to the right of the listener, for a placement test. */
  offset?: number;
  /** Closing speed along the line of sight, for doppler. */
  closing?: number;
}

export interface BenchCues {
  /** Charge sweep across the render, 0..1. */
  charge?: [number, number];
  chargeOn?: boolean;
  tier?: number;
  threat?: [number, number];
  threatPan?: number;
  wind?: number;
}

export interface RenderSpec {
  seconds: number;
  sampleRate?: number;
  music?: MusicMode;
  musicLevel?: number;
  shots?: BenchShot[];
  engines?: BenchEngine[];
  cues?: BenchCues;
  gains?: { master?: number; music?: number; sfx?: number; engine?: number };
  /** Frames per second the virtual render loop runs at. */
  fps?: number;
}

export interface RenderResult {
  sampleRate: number;
  frames: number;
  seconds: number;
  /** Absolute peak and RMS across both channels, 0..1. */
  peak: number;
  rms: number;
  /** Samples at or beyond full scale — a mix that clips is a mix that is wrong. */
  clipped: number;
  /** Fraction of the render that is effectively silent. */
  silence: number;
  /** Interleaved stereo 16-bit PCM, base64. */
  pcm: string;
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function offlineCtor(): OfflineCtor | null {
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as unknown as {
    OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor;
  };
  return g.OfflineAudioContext ?? g.webkitOfflineAudioContext ?? null;
}

export function benchAvailable(): boolean {
  return offlineCtor() !== null;
}

const lerp1 = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Interleave and pack to 16-bit, then base64. Big, but it crosses a CDP bridge
 *  once per render and the alternative is trusting a summary. */
function encode(buf: AudioBuffer): string {
  const n = buf.length;
  const ch = Math.min(2, buf.numberOfChannels);
  const l = buf.getChannelData(0);
  const r = ch > 1 ? buf.getChannelData(1) : l;
  const bytes = new Uint8Array(n * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) {
    const a = Math.max(-1, Math.min(1, l[i]!));
    const b = Math.max(-1, Math.min(1, r[i]!));
    view.setInt16(i * 4, (a < 0 ? a * 0x8000 : a * 0x7fff) | 0, true);
    view.setInt16(i * 4 + 2, (b < 0 ? b * 0x8000 : b * 0x7fff) | 0, true);
  }
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/**
 * Render a slice of this game's audio offline and hand back the buffer.
 *
 * Throws nothing: an environment with no OfflineAudioContext gets null, exactly
 * as the live backend does.
 */
export async function renderBuffer(spec: RenderSpec): Promise<AudioBuffer | null> {
  const Ctor = offlineCtor();
  if (!Ctor) return null;

  const sr = spec.sampleRate ?? 48000;
  const seconds = Math.max(0.1, Math.min(40, spec.seconds));
  const frames = Math.floor(sr * seconds);
  const fps = spec.fps ?? 60;
  const dt = 1 / fps;

  const ac = new Ctor(2, frames, sr);
  const be = createOfflineBackend(ac);
  be.master.gain.value = spec.gains?.master ?? 0.75;
  be.music.gain.value = spec.gains?.music ?? 0.55;
  be.sfx.gain.value = spec.gains?.sfx ?? 0.85;
  be.engine.gain.value = spec.gains?.engine ?? 0.5;

  const listener = createListener();
  const placement = createPlacement();
  const bank = createSoundBank(be, listener);
  const music = spec.music && spec.music !== 'none' ? createMusic(be, spec.musicLevel ?? 0.85) : null;
  const cues = spec.cues ? createCues(be) : null;
  const cueState: CueState = {
    charge: 0, chargeOn: spec.cues?.chargeOn ?? true, tier: spec.cues?.tier ?? 0,
    threat: 0, threatPan: spec.cues?.threatPan ?? 0, wind: spec.cues?.wind ?? 0, draft: 0,
  };

  const drive = createDrive();
  const voices = (spec.engines ?? []).map((e) => ({
    spec: e,
    voice: createRacerVoice(be, e.vehicleId, e.isPlayer ?? true, 1),
  }));

  if (music && spec.music) music.setMode(spec.music, 0.05);

  const shots = (spec.shots ?? []).slice().sort((a, b) => a.at - b.at);
  let nextShot = 0;
  const shotPos = { x: 0, y: 0, z: 0 } as { x: number; y: number; z: number };

  for (let t = 0; t < seconds; t += dt) {
    be.setNow?.(t);
    bank.frame(t, dt);

    while (nextShot < shots.length && shots[nextShot]!.at <= t) {
      const s = shots[nextShot++]!;
      if (s.pos) {
        shotPos.x = s.pos[0]; shotPos.y = s.pos[1]; shotPos.z = s.pos[2];
        bank.play(s.id, {
          volume: s.volume, level: s.level, rate: s.rate,
          pos: shotPos as unknown as import('three').Vector3,
        });
      } else {
        bank.play(s.id, { volume: s.volume, level: s.level, rate: s.rate });
      }
    }

    const u = seconds > dt ? t / (seconds - dt) : 1;

    for (const v of voices) {
      const e = v.spec;
      const ramp = e.ramp ?? [0, 1];
      drive.speedFrac = lerp1(ramp[0], ramp[1], u);
      drive.throttle = e.throttle ?? 1;
      drive.boost = e.boost ?? 0;
      drive.slip = e.slip ?? 0;
      drive.offroad = e.offroad ?? 0;
      drive.airborne = false;
      drive.stunned = false;
      drive.surface = (e.offroad ?? 0) > 0.5 ? 'dirt' : 'road';
      const off = e.offset ?? 0;
      const closing = e.closing ?? 0;
      place(listener, off, 0, off === 0 ? 0.01 : 0, 0, 0, -closing, placement);
      v.voice.update(drive, placement, dt, t);
    }

    if (cues && spec.cues) {
      const c = spec.cues;
      cueState.charge = c.charge ? lerp1(c.charge[0], c.charge[1], u) : 0;
      cueState.threat = c.threat ? lerp1(c.threat[0], c.threat[1], u) : 0;
      cueState.tier = c.tier ?? Math.min(3, Math.floor(cueState.charge * 3.2));
      cues.update(cueState, dt, t);
    }

    music?.update(dt, t);

    // The same sidechain the frame loop applies — and, as in the game, the
    // transient stage has already been fired by `bank.play` at each shot's own
    // scheduled time. Only the siren's slow stage is driven from here.
    be.duck.hold(cueState.threat * 0.85);
    be.duck.update(t, dt);
  }

  return ac.startRendering();
}

/** The same render, summarised and packed for a caller across a CDP bridge. */
export async function renderAudio(spec: RenderSpec): Promise<RenderResult | null> {
  const buf = await renderBuffer(spec);
  if (!buf) return null;

  let peak = 0;
  let sum = 0;
  let clipped = 0;
  let quiet = 0;
  const n = buf.length;
  const chs = Math.min(2, buf.numberOfChannels);
  for (let c = 0; c < chs; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const a = Math.abs(d[i]!);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      if (a < 0.0008) quiet++;
      sum += d[i]! * d[i]!;
    }
  }

  return {
    sampleRate: buf.sampleRate,
    frames: n,
    seconds: n / buf.sampleRate,
    peak: +peak.toFixed(4),
    rms: +Math.sqrt(sum / (n * chs)).toFixed(5),
    clipped,
    silence: +(quiet / (n * chs)).toFixed(3),
    pcm: encode(buf),
  };
}

// ── the acceptance test ─────────────────────────────────────────────────────
//
// A reviewer played this build and rejected it on one sentence: "a bob-omb
// going off next to you produces no rise in the mix at all". They were right,
// and they were right with numbers — the bed sat at -15.3dBFS RMS and the
// explosion peaked at -14.2, so the loudest event in the game was worth 1.3dB.
//
// That failure is now a test. Everything below renders through the *shipped*
// graph at the *shipped* gains and asserts on the samples, so the next person
// to reach for the music level or the limiter threshold finds out immediately
// whether they have flattened the game again.

export interface Check {
  name: string;
  pass: boolean;
  /** The measured quantity, in whatever unit `want` describes. */
  value: number;
  want: string;
  detail?: string;
}

/** The mixer levels the game actually ships with — `src/core/config.ts`. The
 *  bed's headroom trim lives downstream of these, in `context.ts`, so these
 *  are the numbers a reviewer should copy and they measure the real mix. */
const SHIPPED = { master: 0.75, music: 0.55, sfx: 0.85, engine: 0.5 };

const dbOf = (x: number): number => 20 * Math.log10(Math.max(1e-9, x));

/** RMS across both channels over a window given in seconds. */
function rmsAt(buf: AudioBuffer, from: number, to: number): number {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(buf.length, Math.ceil(to * sr));
  if (b <= a) return 0;
  const chs = Math.min(2, buf.numberOfChannels);
  let sum = 0;
  for (let c = 0; c < chs; c++) {
    const d = buf.getChannelData(c);
    for (let i = a; i < b; i++) sum += d[i]! * d[i]!;
  }
  return Math.sqrt(sum / ((b - a) * chs));
}

function peakAt(buf: AudioBuffer, from: number, to: number): number {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(buf.length, Math.ceil(to * sr));
  const chs = Math.min(2, buf.numberOfChannels);
  let p = 0;
  for (let c = 0; c < chs; c++) {
    const d = buf.getChannelData(c);
    for (let i = a; i < b; i++) { const v = Math.abs(d[i]!); if (v > p) p = v; }
  }
  return p;
}

/** Band edges of the fingerprint, hertz. Roughly one per octave and a half
 *  across the range the arrangement actually occupies. */
const BANDS = [110, 260, 520, 1000, 2000, 3800, 7000];

/**
 * A spectral fingerprint of a slice, for asking whether two passages of music
 * are the same music.
 *
 * Cascaded one-poles rather than an FFT: this has to answer "is bar 5 the same
 * as bar 1, and is bar 9 different from both", and eight band levels do that
 * honestly. Two details make it discriminating rather than decorative. The
 * bands are read in *decibels*, because on a linear scale the bass drowns
 * everything and every bar of the same tune looks identical; and the mean is
 * removed, so what is compared is the *shape* of the spectrum rather than how
 * loud the passage was.
 */
function fingerprint(buf: AudioBuffer, from: number, to: number, out: number[]): number[] {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(buf.length, Math.ceil(to * sr));
  const d = buf.getChannelData(0);
  const nb = BANDS.length;
  const k = BANDS.map((f) => Math.exp(-2 * Math.PI * f / sr));
  const s = new Array<number>(nb).fill(0);
  const e = new Array<number>(nb + 1).fill(0);
  for (let i = a; i < b; i++) {
    const x = d[i]!;
    let prev = 0;
    for (let j = 0; j < nb; j++) {
      s[j] = x + k[j]! * (s[j]! - x);
      const band = s[j]! - prev;
      prev = s[j]!;
      e[j] = e[j]! + band * band;
    }
    const top = x - prev;
    e[nb] = e[nb]! + top * top;
  }
  const n = Math.max(1, b - a);
  let mean = 0;
  for (let j = 0; j <= nb; j++) {
    out[j] = dbOf(Math.sqrt(e[j]! / n));
    mean += out[j]!;
  }
  mean /= nb + 1;
  let mag = 0;
  for (let j = 0; j <= nb; j++) { out[j] = out[j]! - mean; mag += out[j]! * out[j]!; }
  mag = Math.sqrt(mag) || 1;
  for (let j = 0; j <= nb; j++) out[j] = out[j]! / mag;
  return out;
}

function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s / Math.max(1, a.length / (BANDS.length + 1));
}

/**
 * A passage as a *sequence* of fingerprints rather than one average of them.
 *
 * This is the difference between "these two bars use the same instruments" and
 * "these two bars are the same music". A single averaged spectrum over two
 * bars of a rock band is nearly identical whatever the band is playing —
 * measured, the bridge scored 0.976 against the hook — because the drum kit
 * dominates it. Chopping the passage into sixteenth-note windows first means
 * the comparison only scores high when the same events happen at the same
 * moments, which is exactly what a self-similarity matrix looks for.
 */
function sequence(buf: AudioBuffer, from: number, to: number, steps: number): number[] {
  const out: number[] = [];
  const w = (to - from) / steps;
  const one = new Array<number>(BANDS.length + 1).fill(0);
  for (let i = 0; i < steps; i++) {
    fingerprint(buf, from + i * w, from + (i + 1) * w, one);
    for (const v of one) out.push(v);
  }
  return out;
}

/**
 * Run the lot. Returns null where there is no OfflineAudioContext, and
 * otherwise one row per check — never throws, because a bench that can bring
 * the page down is a bench nobody runs.
 */
export async function acceptance(): Promise<Check[] | null> {
  if (!benchAvailable()) return null;
  const checks: Check[] = [];
  const add = (
    name: string, value: number, pass: boolean, want: string, detail?: string,
  ): void => { checks.push({ name, value: +value.toFixed(2), pass, want, detail }); };

  // ── 1. The one that failed. ───────────────────────────────────────────────
  // A bob-omb over two engines and the race theme, at shipped gains. The
  // explosion's first 150ms against the 500ms of bed in front of it.
  const BLAST_AT = 1.2;
  const impact = await renderBuffer({
    seconds: 2.2,
    music: 'race',
    gains: SHIPPED,
    engines: [
      { vehicleId: 'truck', isPlayer: true, ramp: [0.72, 0.8] },
      { vehicleId: 'car', isPlayer: false, ramp: [0.7, 0.78], offset: 6 },
    ],
    shots: [{ id: 'blast', at: BLAST_AT }],
  });
  if (impact) {
    const bed = rmsAt(impact, BLAST_AT - 0.5, BLAST_AT);
    const hit = rmsAt(impact, BLAST_AT, BLAST_AT + 0.15);
    const rise = dbOf(hit) - dbOf(bed);
    add('impact.rise', rise, rise >= 8, '>= 8 dB',
      `bed ${dbOf(bed).toFixed(1)} dBFS -> blast ${dbOf(hit).toFixed(1)} dBFS`);

    // And the bed really does step aside underneath it rather than after it.
    const after = rmsAt(impact, BLAST_AT + 0.6, BLAST_AT + 0.9);
    const recover = dbOf(after) - dbOf(bed);
    add('impact.recovers', recover, Math.abs(recover) <= 2.5, 'within 2.5 dB',
      'the bed is back where it started 600ms later');
  }

  // ── 2. The hole opens on the transient, not after it. ─────────────────────
  // Asserted against the ducker's own scheduled envelope, which is exact: it
  // is the same piecewise curve written into the graph.
  {
    const g = (): GainNode => ({ gain: {
      value: 1, cancelScheduledValues() {}, setValueAtTime() {},
      linearRampToValueAtTime() {}, setTargetAtTime() {},
    } } as unknown as GainNode);
    const d = createDucker(g(), g(), g(), g());
    d.hit(1, 0);
    const at20 = dbOf(d.valueAt('engine', 0.02));
    add('duck.opens', -at20, at20 <= -6, '>= 6 dB down by +20ms',
      `engine bus ${at20.toFixed(1)} dB at 20ms, ` +
      `${dbOf(d.valueAt('music', 0.02)).toFixed(1)} dB on music`);
    const at450 = dbOf(d.valueAt('engine', 0.45));
    add('duck.releases', at450, at450 >= -0.5, 'back by +450ms');
  }

  // ── 3. Headroom: the busy mix still has dynamics in it. ───────────────────
  const busy = await renderBuffer({
    seconds: 3.2,
    music: 'final',
    gains: SHIPPED,
    engines: [
      { vehicleId: 'cone', isPlayer: true, ramp: [0.85, 1] },
      { vehicleId: 'train', ramp: [0.8, 0.95], offset: 4 },
      { vehicleId: 'digger', ramp: [0.8, 0.9], offset: -7 },
      { vehicleId: 'helicopter', ramp: [0.75, 0.9], offset: 14 },
    ],
    cues: { charge: [0.2, 1], chargeOn: true, wind: 0.8 },
    shots: [
      { id: 'coin', at: 0.5 }, { id: 'boost', at: 1.0 },
      { id: 'blast', at: 1.6 }, { id: 'hit.flip', at: 2.3 },
    ],
  });
  if (busy) {
    // Per-100ms levels across the take. A game whose loudest moment is within
    // a decibel of its quietest is a game with a compressor across it, not a
    // mix — that was literally the reading that failed review.
    const win: number[] = [];
    for (let t = 0.2; t < 3.1; t += 0.1) win.push(dbOf(rmsAt(busy, t, t + 0.1)));
    win.sort((a, b) => a - b);
    const span = win[win.length - 1]! - win[Math.floor(win.length / 2)]!;
    add('mix.dynamics', span, span >= 7, '>= 7 dB peak-to-median',
      `${win.length} windows, ${win[0]!.toFixed(1)}..${win[win.length - 1]!.toFixed(1)} dBFS`);

    // And the same take measured the way the review measured it: per second,
    // end to end. That reading was -12.3..-13.1 dBFS — 0.8dB of movement across
    // an explosion, a shell hit, a boost and a coin.
    const secs: number[] = [];
    for (let t = 0; t + 1 <= 3.2; t += 0.5) secs.push(dbOf(rmsAt(busy, t, t + 1)));
    const range = Math.max(...secs) - Math.min(...secs);
    add('mix.perSecond', range, range >= 3, '>= 3 dB range per second',
      `${Math.min(...secs).toFixed(1)}..${Math.max(...secs).toFixed(1)} dBFS`);
  }

  // ── 3b. And the worst case the game can actually produce still fits. ──────
  // Every machine in the field at full noise, the final-lap arrangement, a
  // charged mini-turbo, an incoming siren, and then the four loudest one-shots
  // in the bank piled into a fifth of a second. Nothing in a real race is
  // busier than this, so if it does not clip, nothing does.
  const worst = await renderBuffer({
    seconds: 2.4,
    music: 'final',
    gains: SHIPPED,
    engines: [
      { vehicleId: 'cone', isPlayer: true, ramp: [0.95, 1] },
      { vehicleId: 'train', ramp: [0.95, 1], offset: 3 },
      { vehicleId: 'truck', ramp: [0.95, 1], offset: -4 },
      { vehicleId: 'plane', ramp: [0.95, 1], offset: 7 },
      { vehicleId: 'digger', ramp: [0.95, 1], offset: -9 },
      { vehicleId: 'car', ramp: [0.95, 1], offset: 12 },
      { vehicleId: 'helicopter', ramp: [0.95, 1], offset: -14 },
      { vehicleId: 'cone', ramp: [0.95, 1], offset: 18 },
    ],
    cues: { charge: [0.9, 1], chargeOn: true, threat: [0.6, 1], wind: 1 },
    shots: [
      { id: 'blast', at: 1.0 }, { id: 'hit.flip', at: 1.06 },
      { id: 'countdown.go', at: 1.12 }, { id: 'item.use.lightning', at: 1.18 },
      { id: 'finish', at: 1.24 },
    ],
  });
  if (worst) {
    const peak = peakAt(worst, 0, 2.4);
    let clipped = 0;
    for (let c = 0; c < Math.min(2, worst.numberOfChannels); c++) {
      const d = worst.getChannelData(c);
      for (let i = 0; i < worst.length; i++) if (Math.abs(d[i]!) >= 0.999) clipped++;
    }
    add('mix.peak', dbOf(peak), peak < 0.999 && clipped === 0, 'no clipped samples',
      `${clipped} samples at full scale`);
  }

  // ── 4. The theme has a form. ──────────────────────────────────────────────
  // 16 bars at 152bpm is 25.26s. Bars are 1.579s.
  const BAR = 60 / 152 * 4;
  const theme = await renderBuffer({
    seconds: 16 * BAR + 0.4, music: 'race', gains: SHIPPED,
  });
  if (theme) {
    const barAt = (i: number): number => 0.06 + i * BAR;
    // Bars 1-2 against bars 5-6 (the same two bars, restated) and against
    // bars 9-10 (the bridge). A theme scores high on the first and low on
    // the second; an ostinato scores the same on both, which is exactly the
    // reading that failed review.
    const a = sequence(theme, barAt(0), barAt(2), 16);
    const b = sequence(theme, barAt(4), barAt(6), 16);
    const c = sequence(theme, barAt(8), barAt(10), 16);
    const repeat = cosine(a, b);
    const contrast = cosine(a, c);
    add('music.hook', (repeat - contrast) * 100, repeat - contrast >= 0.15,
      'repeat beats bridge by >= 15%',
      `hook<->restatement ${repeat.toFixed(3)}, hook<->bridge ${contrast.toFixed(3)}`);

    // The break. Half of bar 9 is meant to be a hole; measure it against the
    // bar in front of it, from after the downbeat clank to the re-entry.
    const before = dbOf(rmsAt(theme, barAt(7), barAt(8)));
    const inBreak = dbOf(rmsAt(theme, barAt(8) + 0.30, barAt(8) + BAR / 2));
    add('music.break', before - inBreak, before - inBreak >= 8, '>= 8 dB drop',
      `bar 8 ${before.toFixed(1)} dBFS -> break ${inBreak.toFixed(1)} dBFS`);

    // And the loop as a whole is not flat. Half-bar resolution, which is the
    // shortest span an arrangement decision is made over: it used to read
    // inside 0.7dB end to end.
    const halves: number[] = [];
    for (let i = 0; i < 32; i++) {
      halves.push(dbOf(rmsAt(theme, barAt(0) + i * BAR / 2, barAt(0) + (i + 1) * BAR / 2)));
    }
    const span = Math.max(...halves) - Math.min(...halves);
    add('music.dynamics', span, span >= 5, '>= 5 dB across the loop',
      `32 half-bars, ${Math.min(...halves).toFixed(1)}..${Math.max(...halves).toFixed(1)} dBFS`);
  }

  // ── 5. The grid is not dead air. ──────────────────────────────────────────
  const grid = await renderBuffer({ seconds: 4.4, music: 'grid', gains: SHIPPED });
  if (grid) {
    const r = dbOf(rmsAt(grid, 0.1, 4.2));
    add('music.grid', r, r > -34, 'audible before the flag');
  }

  return checks;
}
