// Sound.
//
// Ownership: everything in `src/audio/**`. This module writes to `ctx.audio`
// and to nothing else in the game — it is a pure consumer of the event bus and
// of read-only racer state.
//
// Three positions the whole module is built on.
//
//   **Nothing exists before a gesture.** A browser will not start audio until
//   the player touches the page, and constructing a context early does not
//   merely fail, it prints a warning to a console this project requires to be
//   empty. So the AudioContext, every node and every voice are created inside
//   the first keydown or pointerdown, and in an environment that never has one
//   — the capture harness, which drives the game through `window.__GAME` and
//   never touches the DOM — this module allocates nothing, schedules nothing
//   and costs nothing. It can also never throw: a missing sound device is a
//   completely ordinary way to run this game.
//
//   **Events are impulses, not sounds.** Every handler here records what
//   happened and returns; the next rendered frame decides what to play. That is
//   the same discipline the fx module runs on and for the same reason: the
//   harness steps the simulation for eleven seconds without drawing a single
//   frame, and a handler that synthesised on the spot would try to start several
//   thousand voices at one instant on the audio clock. Recording an impulse per
//   *kind* of event also collapses a burst — eight karts crossing a boost pad
//   abreast — into one sound, which is what it should have been anyway.
//
//   **Simulation is never read from a handler and never written at all.**
//   Everything that decides what the mix sounds like is read in `update`, off
//   interpolated visual state, exactly like a camera.
//
// The layering, top to bottom: music under everything, ducked by anything loud;
// the player's own engine as the constant bed; the field placed around it in
// stereo with distance and doppler; one-shots on top; and two continuous
// instrument readings — the mini-turbo charge and the incoming-item siren —
// that sit above all of it because they are the two things a player steers by.

import * as THREE from 'three';
import { clamp, clamp01, damp } from '../core/math.ts';
import { createBackend } from './context.ts';
import { createRacerVoice, createDrive } from './engines.ts';
import { createSoundBank } from './sfx.ts';
import { createCues } from './cues.ts';
import { createMusic } from './music.ts';
import { createListener, createPlacement, place } from './nodes.ts';
import type {
  AudioSystem, GameContext, GameSystem, ItemId, RaceConfig, Racer, Surface,
} from '../types.ts';
import type { AudioBackend } from './context.ts';
import type { RacerVoice } from './engines.ts';
import type { SoundBank, PlayOpts } from './sfx.ts';
import type { Cues, CueState } from './cues.ts';
import type { Music, MusicMode } from './music.ts';

/** What an item sounds like when it is fired. */
const USE_SOUND: Record<ItemId, string> = {
  banana: 'item.use.banana',
  greenShell: 'item.use.shell',
  redShell: 'item.use.red',
  mushroom: 'item.use.mushroom',
  tripleMushroom: 'item.use.mushroom',
  star: 'item.use.star',
  bulletBill: 'item.use.bullet',
  lightning: 'item.use.lightning',
  blooper: 'item.use.blooper',
  boo: 'item.use.boo',
  bomb: 'item.use.bomb',
  coin: 'item.use.coin',
  horn: 'item.use.horn',
};

const OFFROAD: Record<Surface, number> = {
  road: 0, boost: 0, rail: 0, air: 0,
  dirt: 1, sand: 1, grass: 0.85, water: 0.9,
};

/** A sound waiting for the next rendered frame. One per id — a burst of the
 *  same event collapses onto the loudest member of the burst. */
interface Pending {
  id: string;
  x: number; y: number; z: number;
  positional: boolean;
  level: number;
  volume: number;
  rate: number;
}

/** Per-racer smoothing that belongs to the mix, not to the simulation. */
interface RacerAudio {
  voice: RacerVoice | null;
  vehicleId: string;
  boost: number;
  offroad: number;
  scrub: number;
}

const MAX_PENDING = 48;

// ── scratch. Nothing in this file may allocate per frame ────────────────────
const _pos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _lat = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camPrev = new THREE.Vector3();
const _camQuat = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _shotPos = new THREE.Vector3();

export function createAudioSystem(ctx: GameContext): GameSystem {
  const cfgAudio = ctx.config.audio;

  let be: AudioBackend | null = null;
  let bank: SoundBank | null = null;
  let cues: Cues | null = null;
  let music: Music | null = null;
  let booting = false;

  const listener = createListener();
  const placement = createPlacement();
  const drive = createDrive();
  const cueState: CueState = {
    charge: 0, chargeOn: false, tier: 0,
    threat: 0, threatPan: 0, wind: 0, draft: 0,
  };

  const racerAudio = new Map<number, RacerAudio>();
  const pend = new Map<string, Pending>();
  const pool: Pending[] = [];
  const shotOpts: PlayOpts = {};

  let camPrimed = false;
  let listenerOverride = false;
  /** Explicit `setMusic` from another module wins over the phase machine. */
  let musicOverride: MusicMode | null = null;
  let threatActive = false;
  let threatPan = 0;
  let threat = 0;
  let engineTrim = -1;

  // ── impulses ──────────────────────────────────────────────────────────────

  function cue(
    id: string, volume = 1, level = 1, pos: THREE.Vector3 | null = null, rate = 1,
  ): void {
    if (!be) return;
    const existing = pend.get(id);
    if (existing) {
      // Keep the loudest of a burst rather than the first, so a graze followed
      // by a real hit inside the same frame reports the hit.
      if (volume <= existing.volume) return;
      existing.volume = volume;
      existing.level = level;
      existing.rate = rate;
      existing.positional = pos !== null;
      if (pos) { existing.x = pos.x; existing.y = pos.y; existing.z = pos.z; }
      return;
    }
    if (pend.size >= MAX_PENDING) return;
    const e = pool.pop() ?? {
      id: '', x: 0, y: 0, z: 0, positional: false, level: 1, volume: 1, rate: 1,
    };
    e.id = id;
    e.volume = volume;
    e.level = level;
    e.rate = rate;
    e.positional = pos !== null;
    if (pos) { e.x = pos.x; e.y = pos.y; e.z = pos.z; }
    pend.set(id, e);
  }

  /** Where a racer's sound comes from: the player's own is in their head, a
   *  rival's is out in the world. */
  const at = (racer: Racer | null | undefined): THREE.Vector3 | null =>
    racer && !racer.isPlayer ? racer.pos : null;

  function flush(): void {
    if (!bank) { pend.clear(); return; }
    for (const e of pend.values()) {
      shotOpts.volume = e.volume;
      shotOpts.level = e.level;
      shotOpts.rate = e.rate;
      if (e.positional) {
        _shotPos.set(e.x, e.y, e.z);
        shotOpts.pos = _shotPos;
      } else {
        shotOpts.pos = undefined;
      }
      bank.play(e.id, shotOpts);
      pool.push(e);
    }
    pend.clear();
  }

  // ── the bus ───────────────────────────────────────────────────────────────

  const bus = ctx.bus;

  bus.on<{ n: number }>('race:countdown', ({ n }) => {
    if (n >= 1) cue('countdown', 1, n);
  });
  bus.on('race:racing', () => { cue('countdown.go'); });
  bus.on<{ racer: Racer; lap: number }>('race:lap', ({ racer, lap }) => {
    if (!racer.isPlayer) return;
    if (lap >= ctx.race.totalLaps - 1) cue('lap.final');
    else cue('lap');
  });
  bus.on<{ racer: Racer }>('race:finish', ({ racer }) => {
    if (racer.isPlayer) cue('finish');
  });
  bus.on<{ racer: Racer }>('race:rocketStart', ({ racer }) => {
    cue('rocket', racer.isPlayer ? 1 : 0.5, 1, at(racer));
  });
  bus.on<{ racer: Racer }>('race:burnout', ({ racer }) => {
    cue('burnout', racer.isPlayer ? 1 : 0.5, 1, at(racer));
  });

  bus.on<{ racer: Racer; source: string; power: number }>('kart:boost', ({ racer, source, power }) => {
    const lv = clamp01(power / 46);
    const far = racer.isPlayer ? 1 : 0.7;
    if (source === 'drift1' || source === 'drift2' || source === 'drift3') {
      const tier = Number(source.slice(-1)) / 3;
      cue('drift.release', far, tier, at(racer));
    } else if (source === 'rocketStart') {
      cue('rocket', far, lv, at(racer));
    } else if (source === 'pad') {
      cue('pad', far * 0.85, lv, at(racer));
    } else if (source === 'star' || source === 'bullet') {
      // Those two announce themselves through `item:use`; a second whoosh every
      // time the effect re-arms is just noise.
    } else {
      cue('boost', far, lv, at(racer));
    }
  });

  bus.on<{ racer: Racer }>('kart:hop', ({ racer }) => {
    if (racer.isPlayer) cue('hop', 0.8);
  });
  bus.on<{ racer: Racer; dir: number }>('kart:drift:start', ({ racer }) => {
    if (racer.isPlayer) cue('scrape', 0.7);
  });
  bus.on<{ racer: Racer; tier: number }>('kart:drift:charge', ({ racer, tier }) => {
    if (racer.isPlayer && tier > 0) cue('drift.tier', 1, tier / 3);
  });
  bus.on<{ racer: Racer; impact: number; tricked: boolean; airTime: number }>(
    'kart:land', ({ racer, impact, tricked, airTime }) => {
      // A drift hop lands several times a corner. Only a real drop gets the
      // full treatment, or the game develops a stutter.
      if (airTime < 0.22 && impact < 0.3) return;
      cue('land', racer.isPlayer ? 1 : 0.55, clamp01(impact), at(racer));
      if (tricked && racer.isPlayer) cue('trick', 0.9);
    },
  );
  bus.on<{ racer: Racer }>('kart:trick:start', ({ racer }) => {
    if (racer.isPlayer) cue('trick', 0.7);
  });
  // Leaving the tarmac costs speed, so it has to be *announced*, not merely
  // implied by the tyre bed changing colour underneath the engine. Player only:
  // seven CPU machines clipping the verge would put a crunch under every corner
  // of the race.
  bus.on<{ racer: Racer }>('kart:offroad', ({ racer }) => {
    if (racer.isPlayer) cue('offroad', 0.85);
  });
  bus.on<{ racer: Racer; force: number }>('kart:wall', ({ racer, force }) => {
    cue('wall', racer.isPlayer ? 1 : 0.6, clamp01(force), at(racer));
  });
  bus.on<{ a: Racer; b: Racer; force: number }>('kart:bump', ({ a, b }) => {
    const who = a.isPlayer ? a : b;
    cue('bump', who.isPlayer ? 0.9 : 0.5, 1, at(who) ?? at(a));
  });

  bus.on<{ racer: Racer }>('item:box', ({ racer }) => {
    cue('item.box', racer.isPlayer ? 1 : 0.45, 1, at(racer));
  });
  bus.on<{ racer: Racer; remaining: number; total: number }>(
    'item:reel', ({ racer, remaining, total }) => {
      if (!racer.isPlayer) return;
      cue('item.reel', 1, 1 - clamp01(total > 0 ? remaining / total : 0));
    },
  );
  bus.on<{ racer: Racer }>('item:get', ({ racer }) => {
    if (racer.isPlayer) cue('item.get');
  });
  bus.on<{ racer: Racer; item: ItemId }>('item:use', ({ racer, item }) => {
    const id = USE_SOUND[item];
    if (id) cue(id, racer.isPlayer ? 1 : 0.7, 1, at(racer));
  });
  bus.on<{ racer: Racer; kind: string }>('item:strike', ({ racer, kind }) => {
    const id = kind === 'flip' ? 'hit.flip'
      : kind === 'squish' ? 'hit.squish'
        : kind === 'bump' ? 'hit.bump' : 'hit.spin';
    cue(id, racer.isPlayer ? 1 : 0.6, 1, at(racer));
  });
  bus.on<{ racer: Racer }>('item:block', ({ racer }) => {
    cue('bounce', racer.isPlayer ? 1 : 0.6, 0.2, at(racer));
  });
  bus.on<{ pos: THREE.Vector3 }>('item:blast', ({ pos }) => {
    cue('blast', 1, 1, pos);
  });
  bus.on<{ kind: string; pos: THREE.Vector3; bounces: number }>(
    'item:bounce', ({ pos, bounces }) => {
      cue('bounce', 0.8, clamp01(bounces / 4), pos);
    },
  );
  bus.on<{ racer: Racer; effect: string; on: boolean }>('item:effect', ({ racer, effect, on }) => {
    if (!racer.isPlayer) return;
    if (effect === 'shrunk') cue(on ? 'shrink' : 'grow', 0.9);
  });
  bus.on<{ racer: Racer }>('item:steal', ({ racer }) => {
    if (racer.isPlayer) cue('item.get', 0.8);
  });
  bus.on<{ racer: Racer }>('coin:get', ({ racer }) => {
    if (racer.isPlayer) cue('coin');
  });
  bus.on<{ racer: Racer; count: number }>('coin:lose', ({ racer }) => {
    if (racer.isPlayer) cue('coin.lose');
  });

  // The one channel that is genuinely a *warning*: it fires on the two edges of
  // "something will hit you inside 1.6 seconds", carrying where it is in the
  // player's own frame. The siren is started here and driven to impact in
  // `update`, so there is no polling and no timeout of our own.
  bus.on<{ on: boolean; level: number; bearing: number }>(
    'item:warn', ({ on, level, bearing }) => {
      threatActive = on;
      if (on) {
        threat = Math.max(threat, clamp01(level));
        threatPan = clamp(Math.sin(bearing), -1, 1);
      }
    },
  );

  // ── the mix ───────────────────────────────────────────────────────────────

  function autoMode(): MusicMode {
    const player = ctx.player;
    if (player?.effects.has('star')) return 'star';
    const phase = ctx.race.phase;
    if (phase === 'results' || phase === 'finished') return 'victory';
    if (phase !== 'racing') return 'none';
    // Racers start on lap -1 behind the line, so `totalLaps - 1` is the lap
    // that ends at the flag whatever the race length is.
    if (player && player.lap >= ctx.race.totalLaps - 1) return 'final';
    return 'race';
  }

  function updateListener(dt: number): void {
    if (listenerOverride) { listenerOverride = false; return; }
    ctx.camera.getWorldPosition(_camPos);
    ctx.camera.getWorldQuaternion(_camQuat);
    setListenerFrom(_camPos, _camQuat, dt);
  }

  function setListenerFrom(p: THREE.Vector3, q: THREE.Quaternion, dt: number): void {
    if (!camPrimed) { _camPrev.copy(p); camPrimed = true; }
    const inv = dt > 1e-4 ? 1 / dt : 0;
    // The listener's own velocity, differenced rather than read off the camera
    // system — which owns no such number, and which is entitled not to.
    listener.vx = (p.x - _camPrev.x) * inv;
    listener.vy = (p.y - _camPrev.y) * inv;
    listener.vz = (p.z - _camPrev.z) * inv;
    _camPrev.copy(p);
    listener.px = p.x; listener.py = p.y; listener.pz = p.z;
    _axis.set(1, 0, 0).applyQuaternion(q);
    listener.rx = _axis.x; listener.ry = _axis.y; listener.rz = _axis.z;
    // Three's cameras look down -Z; the listener's "forward" is the direction
    // the picture is facing, which is what the behind-the-camera dulling keys
    // off, so the sign matters.
    _axis.set(0, 0, -1).applyQuaternion(q);
    listener.fx = _axis.x; listener.fy = _axis.y; listener.fz = _axis.z;
  }

  function stateOf(racer: Racer): RacerAudio {
    let s = racerAudio.get(racer.id);
    if (!s) {
      s = { voice: null, vehicleId: '', boost: 0, offroad: 0, scrub: 0 };
      racerAudio.set(racer.id, s);
    }
    if (be && (!s.voice || s.vehicleId !== racer.vehicleId)) {
      s.voice?.dispose();
      s.voice = createRacerVoice(be, racer.vehicleId, racer.isPlayer, racer.id + 1);
      s.vehicleId = racer.vehicleId;
    }
    return s;
  }

  /** Sideways travel as a fraction of forward travel — what the tyres are
   *  actually complaining about. */
  function slipOf(racer: Racer): number {
    _fwd.set(0, 0, 1).applyQuaternion(racer.quat);
    _lat.copy(racer.vel);
    _lat.y = 0;
    const along = _lat.dot(_fwd);
    _lat.addScaledVector(_fwd, -along);
    return clamp01(_lat.length() / Math.max(7, Math.abs(racer.speed)));
  }

  function updateRacers(dt: number, alpha: number, now: number): void {
    const paused = ctx.race.phase === 'loading';
    for (const racer of ctx.racers) {
      const s = stateOf(racer);
      if (!s.voice) continue;

      _pos.lerpVectors(racer.prevPos, racer.pos, alpha);
      place(listener, _pos.x, _pos.y, _pos.z, racer.vel.x, racer.vel.y, racer.vel.z, placement);

      const boosting = racer.boost.time > 0 ? 1 : 0;
      s.boost = damp(s.boost, boosting, 0.0009, dt);
      s.offroad = damp(s.offroad, OFFROAD[racer.surface] ?? 0, 0.002, dt);
      // The drift is a slide the physics has *decided* on, so the scrub floor
      // comes from the drift flag rather than only from measured lateral speed:
      // a committed drift at low slip angle still burns rubber.
      const slip = Math.max(slipOf(racer), racer.drift.active ? 0.42 : 0);
      s.scrub = damp(s.scrub, slip, 0.0015, dt);

      drive.speedFrac = clamp01(Math.abs(racer.speed) / Math.max(10, racer.maxSpeed));
      // Exactly the rule physics uses to decide whose hands are on the wheel.
      // Reading the human's input for anything flagged `isPlayer` looks right
      // and is wrong the moment the harness switches on autopilot — which is
      // how every capture and every reviewer drives this game. The kart would
      // be doing 200km/h with its engine reporting a closed throttle.
      const hands = racer.ai ? (racer.aiInput ?? ctx.inputState) : ctx.inputState;
      drive.throttle = paused ? 0 : hands.accel;
      drive.boost = s.boost;
      drive.slip = s.scrub;
      drive.airborne = !racer.grounded;
      drive.stunned = racer.stunned > 0;
      drive.surface = racer.surface;
      drive.offroad = s.offroad;

      s.voice.update(drive, placement, dt, now);
    }
  }

  function updateCues(dt: number, now: number): void {
    if (!cues) return;
    const player = ctx.player;
    if (!player) { cues.silence(now); return; }

    const cap = ctx.config.kart.drift.chargeCap;
    cueState.charge = clamp01(player.drift.charge / cap);
    cueState.chargeOn = player.drift.active;
    cueState.tier = player.drift.tier;

    // The item system reports the two edges of a threat; the ramp between them
    // is ours. 1.6s is its own window, so this reaches full alarm exactly as
    // the thing arrives.
    if (threatActive) threat = clamp01(threat + dt / 1.5);
    else threat = Math.max(0, threat - dt * 4);
    cueState.threat = threat;
    cueState.threatPan = threatPan;

    cueState.wind = clamp01(Math.abs(player.speed) / Math.max(10, player.maxSpeed));
    cueState.draft = player.effects.has('draft') ? 1 : 0;
    cues.update(cueState, dt, now);
  }

  // ── unlocking ─────────────────────────────────────────────────────────────

  function boot(): void {
    if (be || booting) return;
    booting = true;
    const backend = createBackend();
    booting = false;
    if (!backend) return;
    be = backend;
    backend.master.gain.value = cfgAudio.master;
    backend.music.gain.value = cfgAudio.music;
    backend.sfx.gain.value = cfgAudio.sfx;
    backend.engine.gain.value = cfgAudio.engine;
    bank = createSoundBank(backend, listener);
    cues = createCues(backend);
    // Headroom. The bed is measured to sit level with the player's own engine
    // at this trim, which leaves the limiter room to do its job when a bob-omb
    // goes off in the middle of the pack.
    music = createMusic(backend, 0.85);
    detachGestures();
  }

  const onGesture = (): void => {
    boot();
    if (be && be.ac.state !== 'running') void be.ac.resume().catch(() => { /* blocked */ });
  };

  let gesturesAttached = false;
  function attachGestures(): void {
    if (gesturesAttached || typeof window === 'undefined') return;
    gesturesAttached = true;
    window.addEventListener('pointerdown', onGesture, { passive: true });
    window.addEventListener('keydown', onGesture, { passive: true });
    window.addEventListener('touchstart', onGesture, { passive: true });
  }
  function detachGestures(): void {
    if (!gesturesAttached || typeof window === 'undefined') return;
    gesturesAttached = false;
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('keydown', onGesture);
    window.removeEventListener('touchstart', onGesture);
  }

  // ── the public face ───────────────────────────────────────────────────────

  const api: AudioSystem = {
    play(id, opts) {
      cue(
        id,
        opts?.volume ?? 1,
        1,
        opts?.pos ?? null,
        opts?.rate ?? 1,
      );
    },

    /**
     * Force a track. Ids are the music modes: `race`, `final`, `star`,
     * `victory`. `null` stops the music; `'auto'` hands it back to the race
     * phase, which is what drives it unless someone takes it away.
     */
    setMusic(id, opts) {
      if (id === 'auto') { musicOverride = null; return; }
      musicOverride = (id ?? 'none') as MusicMode;
      music?.setMode(musicOverride, opts?.fade ?? 0.4);
    },

    setListener(pos, quat) {
      setListenerFrom(pos, quat, ctx.time.dt || 1 / 60);
      listenerOverride = true;
    },

    /** Make sure this racer has a voice. The frame loop does this anyway; the
     *  entry point exists so a module that builds a racer late can ask for one
     *  without waiting a frame. */
    setEngine(racer) {
      if (be) stateOf(racer);
    },

    async unlock() {
      boot();
      if (be && be.ac.state !== 'running') {
        try { await be.ac.resume(); } catch { /* still blocked; try again next gesture */ }
      }
    },
  };

  ctx.audio = api;

  /**
   * The reviewer's bench.
   *
   * Sound is the one part of this game a screenshot cannot judge, and the
   * capture harness never produces a user gesture — so without this there is no
   * way to establish from the outside that the module is even running, let
   * alone that a shell whooshing past is panned to the correct side. Nothing in
   * the simulation reads any of it and none of it draws from `ctx.rng`.
   *
   * `unlock()` needs a real gesture behind it in a normal browser; a test
   * driver that clicks the page first will find everything here live.
   */
  if (typeof globalThis !== 'undefined') {
    (globalThis as unknown as Record<string, unknown>).__AUDIO = {
      unlock: () => api.unlock(),
      /** Fire any sound in the bank by name, optionally out in the world. */
      play: (id: string, opts?: PlayOpts) => { if (bank) bank.play(id, opts); },
      /** Force a track: 'race' | 'final' | 'star' | 'victory' | 'auto' | null. */
      music: (id: string | null) => api.setMusic(id),
      /** Everything a critic might want to assert on, as plain JSON. */
      probe: () => ({
        unlocked: be !== null,
        state: be ? be.ac.state : 'none',
        sampleRate: be ? be.ac.sampleRate : 0,
        voices: racerAudio.size,
        pending: pend.size,
        music: music ? music.mode : 'none',
        override: musicOverride,
        loudness: bank ? +bank.loudness.toFixed(3) : 0,
        threat: +threat.toFixed(3),
        threatPan: +threatPan.toFixed(3),
        charge: +cueState.charge.toFixed(3),
        tier: cueState.tier,
        listener: [
          +listener.px.toFixed(2), +listener.py.toFixed(2), +listener.pz.toFixed(2),
        ],
      }),
      /** Where a world position lands in the mix right now: level, stereo
       *  placement, air absorption and doppler. This is how "you can hear a
       *  shell coming from the left" gets checked rather than asserted. */
      placeAt: (x: number, y: number, z: number, vx = 0, vy = 0, vz = 0) => {
        place(listener, x, y, z, vx, vy, vz, placement);
        return {
          gain: +placement.gain.toFixed(3),
          pan: +placement.pan.toFixed(3),
          cut: Math.round(placement.cut),
          rate: +placement.rate.toFixed(3),
          distance: +placement.distance.toFixed(2),
        };
      },
    };
  }

  return {
    name: 'audio',
    order: 90,

    init(): void {
      attachGestures();
    },

    reset(_cfg: RaceConfig): void {
      // The field is rebuilt on every race, and racer ids are reused with
      // different machines behind them, so the voices go with it.
      for (const s of racerAudio.values()) s.voice?.dispose();
      racerAudio.clear();
      pend.clear();
      threat = 0;
      threatActive = false;
      engineTrim = -1;
      camPrimed = false;
    },

    update(dt: number, alpha: number): void {
      if (!be || !bank || !music) { pend.clear(); return; }
      // A context that is not running has a frozen clock, so everything
      // scheduled against it would pile up on one instant and fire together the
      // moment it resumes. Sit the frame out instead.
      if (be.ac.state !== 'running') { pend.clear(); return; }

      const now = be.now();
      const step = dt > 0.5 ? 0.5 : dt;

      bank.frame(now, step);
      updateListener(step);
      updateRacers(step, alpha, now);
      updateCues(step, now);
      // Spend the frame's impulses *before* the music reads how loud the bank
      // is, so an explosion ducks the bed on the frame it goes off rather than
      // on the one after it. Sixteen milliseconds late is enough to hear.
      flush();

      // The music follows the race unless somebody has taken it over. Reading
      // the phase rather than listening for it means the mode is correct even
      // when the harness jumps straight to a phase, or resets mid-race.
      const phase = ctx.race.phase;
      const want = musicOverride ?? autoMode();
      if (music.mode !== want) {
        // Victory comes in slowly on purpose: the finish fanfare is a second
        // long and the results theme must not walk over the end of it.
        music.setMode(want, want === 'none' ? 0.5 : want === 'victory' ? 0.9 : 0.35);
      }
      music.duck(bank.loudness);
      music.update(step, now);

      // The field steps back for the results music, so the fanfare is not
      // fighting eight machines still driving around behind it.
      const trim = cfgAudio.engine * (phase === 'results' || phase === 'finished' ? 0.45 : 1);
      if (trim !== engineTrim) {
        engineTrim = trim;
        be.engine.gain.setTargetAtTime(trim, now, 0.25);
      }
    },

    dispose(): void {
      detachGestures();
      for (const s of racerAudio.values()) s.voice?.dispose();
      racerAudio.clear();
      cues?.dispose();
      music?.dispose();
      be?.dispose();
      be = null;
      bank = null;
      cues = null;
      music = null;
    },
  };
}
