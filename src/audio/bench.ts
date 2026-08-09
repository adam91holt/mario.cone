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
import { createListener, createPlacement, place, engineDuckFor } from './nodes.ts';
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
 * Render a slice of this game's audio offline and return the samples.
 *
 * Throws nothing: an environment with no OfflineAudioContext gets null, exactly
 * as the live backend does.
 */
export async function renderAudio(spec: RenderSpec): Promise<RenderResult | null> {
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
  let duckNow = 1;
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

    music?.duck(bank.loudness);
    music?.update(dt, t);

    // The same sidechain the frame loop applies, so what is measured here is
    // what the game plays.
    const wantDuck = engineDuckFor(Math.max(bank.loudness, cueState.threat * 0.85));
    if (Math.abs(wantDuck - duckNow) > 0.004) {
      const falling = wantDuck < duckNow;
      duckNow = wantDuck;
      be.engineDuck.gain.setTargetAtTime(wantDuck, t, falling ? 0.012 : 0.13);
    }
  }

  const buf = await ac.startRendering();

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
    sampleRate: sr,
    frames: n,
    seconds: n / sr,
    peak: +peak.toFixed(4),
    rms: +Math.sqrt(sum / (n * chs)).toFixed(5),
    clipped,
    silence: +(quiet / (n * chs)).toFixed(3),
    pcm: encode(buf),
  };
}
