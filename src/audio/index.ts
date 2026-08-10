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
import { createSoundBank, SOUND_IDS } from './sfx.ts';
import { createCues } from './cues.ts';
import { createMusic } from './music.ts';
import { createListener, createPlacement, place } from './nodes.ts';
import { renderAudio, acceptance } from './bench.ts';
import type {
  AudioSystem, GameContext, GameSystem, ItemId, RaceConfig, Racer, Surface, VehicleId,
} from '../types.ts';
import type { AudioBackend } from './context.ts';
import type { RacerVoice } from './engines.ts';
import type { SoundBank, PlayOpts } from './sfx.ts';
import type { Cues, CueState } from './cues.ts';
import type { Music, MusicMode } from './music.ts';
import type { RenderSpec } from './bench.ts';

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

/** Each machine's own one-word shout, laid out rather than built from the
 *  vehicle id — a table cannot produce an id the bank has never heard of. */
const SIGNATURE: Record<VehicleId, string> = {
  cone: 'sig.cone',
  plane: 'sig.plane',
  helicopter: 'sig.helicopter',
  digger: 'sig.digger',
  train: 'sig.train',
  truck: 'sig.truck',
  car: 'sig.car',
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

/** How often the wrong-way alarm re-arms while the sign is up. A shade over the
 *  length of one shot, so the beeps run continuously without overlapping. */
const WRONGWAY_PERIOD = 0.62;

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
  /** The wrong-way alarm's latch, and its re-arm clock. */
  let wrongWay = false;
  let wrongWayT = 0;

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
  /** Subscriptions, kept so `dispose` can actually let go of them. A system
   *  that is torn down and rebuilt — which is what a page with a menu does —
   *  would otherwise leave a dead handler on every event in the game. */
  const unsubs: Array<() => void> = [];
  function on<T = unknown>(event: string, fn: (payload: T) => void): void {
    unsubs.push(bus.on<T>(event, fn));
  }

  // The lights.
  //
  // The director counts 3, 2, 1 and then shows GO one beat *before* the flag
  // actually falls, so the last thing the player hears before being allowed to
  // move must not be two seconds of nothing. Three beats on the same note give
  // the ear a tempo; the fourth lifts a fourth to D — the key the GO fanfare is
  // in — and a riser underneath it carries the last second into the flag. That
  // is the whole rocket-start window, and it is now audible rather than merely
  // documented.
  on<{ n: number }>('race:countdown', ({ n }) => {
    if (n >= 1) cue('countdown', 1, clamp01((3 - n) / 2));
    else if (ctx.race.phase === 'countdown') cue('countdown.set');
  });
  on('race:racing', () => { cue('countdown.go'); });
  on<{ racer: Racer; lap: number }>('race:lap', ({ racer, lap }) => {
    if (!racer.isPlayer) return;
    if (lap >= ctx.race.totalLaps - 1) cue('lap.final');
    else cue('lap');
  });
  // Crossing the line, and it must not sound the same in sixth as it does in
  // first. The results music is identical either way — the flag is the one
  // moment the game gets to tell the player what just happened to them, and a
  // fanfare that plays regardless is a fanfare that means nothing.
  on<{ racer: Racer; place: number }>('race:finish', ({ racer, place }) => {
    if (racer.isPlayer) cue(place <= 3 ? 'finish' : 'finish.back');
  });
  on<{ racer: Racer }>('race:rocketStart', ({ racer }) => {
    cue('rocket', racer.isPlayer ? 1 : 0.5, 1, at(racer));
  });
  on<{ racer: Racer }>('race:burnout', ({ racer }) => {
    cue('burnout', racer.isPlayer ? 1 : 0.5, 1, at(racer));
  });
  /**
   * The third start verdict.
   *
   * The countdown has three outcomes and two of them had a sound. A player who
   * came on the throttle a beat early got a full-screen JUMPED / NO ROCKET
   * START plate over total silence, which reads as the game glitching rather
   * than as a rule being applied — and it is the *most common* of the three the
   * first time anybody plays.
   */
  on<{ racer: Racer }>('race:jumpstart', ({ racer }) => {
    if (racer.isPlayer) cue('jumpstart', 0.9);
  });
  /**
   * A new best lap.
   *
   * The one number a player is chasing lap to lap, and until now the first
   * acknowledgement of it arrived on the results sheet, ninety seconds after
   * the thing happened. Player only, and only once there is a lap to have
   * beaten — the director already applies that rule to its own banner.
   */
  on<{ racer: Racer; lap: number }>('race:bestlap', ({ racer, lap }) => {
    if (racer.isPlayer && lap >= 2) cue('bestlap', 0.85);
  });

  /**
   * The machine's own voice, on top of the boost it just took.
   *
   * Every kart in this game takes the same mini-turbo and the same pad, and if
   * they all shout about it with the same sound then seven machines that were
   * carefully made to sound different at cruise become identical at the exact
   * moment the player is paying most attention. So a boost is the boost *plus*
   * a one-word signature: the train's whistle, the truck's air horn, the
   * helicopter's turbine surge. Player only — eight of these going off across a
   * lap would stop being character and start being clutter.
   */
  function signature(racer: Racer, strength: number): void {
    if (!racer.isPlayer) return;
    cue(SIGNATURE[racer.vehicleId], strength);
  }

  on<{ racer: Racer; source: string; power: number }>('kart:boost', ({ racer, source, power }) => {
    const lv = clamp01(power / 46);
    const far = racer.isPlayer ? 1 : 0.7;
    if (source === 'drift1' || source === 'drift2' || source === 'drift3') {
      const tier = Number(source.slice(-1));
      cue('drift.release', far, tier / 3, at(racer));
      // Only the top two tiers earn a shout. A blue spark every other corner
      // would wear the joke out inside a lap.
      if (tier >= 2) signature(racer, tier >= 3 ? 0.9 : 0.62);
    } else if (source === 'rocketStart') {
      cue('rocket', far, lv, at(racer));
      signature(racer, 1);
    } else if (source === 'pad') {
      cue('pad', far * 0.85, lv, at(racer));
    } else if (source === 'star' || source === 'bullet') {
      // Those two announce themselves through `item:use`; a second whoosh every
      // time the effect re-arms is just noise.
    } else if (source === 'slipstream') {
      // The draft pays out as a shove rather than as a fanfare: the wake itself
      // is already audible on the wind bed, and this is its release.
      cue('draft', far * 0.8, lv, at(racer));
    } else {
      cue('boost', far, lv, at(racer));
      if (source === 'mushroom') signature(racer, 0.7);
    }
  });

  on<{ racer: Racer }>('kart:hop', ({ racer }) => {
    if (racer.isPlayer) cue('hop', 0.8);
  });
  on<{ racer: Racer; dir: number }>('kart:drift:start', ({ racer }) => {
    if (racer.isPlayer) cue('scrape', 0.7);
  });
  on<{ racer: Racer; tier: number }>('kart:drift:charge', ({ racer, tier }) => {
    if (racer.isPlayer && tier > 0) cue('drift.tier', 1, tier / 3);
  });
  on<{ racer: Racer; impact: number; tricked: boolean; airTime: number }>(
    'kart:land', ({ racer, impact, tricked, airTime }) => {
      // A drift hop lands several times a corner. Only a real drop gets the
      // full treatment, or the game develops a stutter.
      if (airTime < 0.22 && impact < 0.3) return;
      cue('land', racer.isPlayer ? 1 : 0.55, clamp01(impact), at(racer));
      if (tricked && racer.isPlayer) cue('trick', 0.9);
    },
  );
  on<{ racer: Racer }>('kart:trick:start', ({ racer }) => {
    if (racer.isPlayer) cue('trick', 0.7);
  });
  // Real air, as opposed to a drift hop. Physics only emits this above its own
  // launch threshold, so it is already the rare event it sounds like.
  on<{ racer: Racer; power: number }>('kart:launch', ({ racer, power }) => {
    cue('jump', racer.isPlayer ? 0.85 : 0.4, clamp01(power / 9), at(racer));
  });
  // Leaving the tarmac costs speed, so it has to be *announced*, not merely
  // implied by the tyre bed changing colour underneath the engine. Player only:
  // seven CPU machines clipping the verge would put a crunch under every corner
  // of the race.
  on<{ racer: Racer }>('kart:offroad', ({ racer }) => {
    if (racer.isPlayer) cue('offroad', 0.85);
  });
  // ...and finding it again. Leaving the tarmac had a cue and a dust burst;
  // coming back had neither, which made the surface change a one-way
  // announcement. Quiet — this is a relief, not an event.
  on<{ racer: Racer }>('kart:onroad', ({ racer }) => {
    if (racer.isPlayer) cue('scrape', 0.32, 0.4);
  });
  on<{ racer: Racer; force: number }>('kart:wall', ({ racer, force }) => {
    cue('wall', racer.isPlayer ? 1 : 0.6, clamp01(force), at(racer));
  });
  on<{ a: Racer; b: Racer; force: number }>('kart:bump', ({ a, b }) => {
    const who = a.isPlayer ? a : b;
    cue('bump', who.isPlayer ? 0.9 : 0.5, 1, at(who) ?? at(a));
  });

  on<{ racer: Racer }>('item:box', ({ racer }) => {
    cue('item.box', racer.isPlayer ? 1 : 0.45, 1, at(racer));
  });
  on<{ racer: Racer; remaining: number; total: number }>(
    'item:reel', ({ racer, remaining, total }) => {
      if (!racer.isPlayer) return;
      cue('item.reel', 1, 1 - clamp01(total > 0 ? remaining / total : 0));
    },
  );
  on<{ racer: Racer }>('item:get', ({ racer }) => {
    if (racer.isPlayer) cue('item.get');
  });
  on<{ racer: Racer; item: ItemId }>('item:use', ({ racer, item }) => {
    const id = USE_SOUND[item];
    if (id) cue(id, racer.isPlayer ? 1 : 0.7, 1, at(racer));
  });
  on<{ racer: Racer; kind: string }>('item:strike', ({ racer, kind }) => {
    const id = kind === 'flip' ? 'hit.flip'
      : kind === 'squish' ? 'hit.squish'
        : kind === 'bump' ? 'hit.bump' : 'hit.spin';
    cue(id, racer.isPlayer ? 1 : 0.6, 1, at(racer));
  });
  on<{ racer: Racer }>('item:block', ({ racer }) => {
    cue('bounce', racer.isPlayer ? 1 : 0.6, 0.2, at(racer));
  });
  on<{ pos: THREE.Vector3 }>('item:blast', ({ pos }) => {
    cue('blast', 1, 1, pos);
  });
  on<{ kind: string; pos: THREE.Vector3; bounces: number }>(
    'item:bounce', ({ pos, bounces }) => {
      cue('bounce', 0.8, clamp01(bounces / 4), pos);
    },
  );
  // What is *happening to* the player, as distinct from what they fired. Each
  // of these changes how the game is played for several seconds, and a state
  // change the player cannot hear is a state change they will blame the game
  // for. The `off` edges matter as much as the `on` ones: "it has worn off" is
  // the information you steer by on the corner after.
  on<{ racer: Racer; effect: string; on: boolean }>('item:effect', ({ racer, effect, on: active }) => {
    if (!racer.isPlayer) return;
    switch (effect) {
      case 'shrunk': cue(active ? 'shrink' : 'grow', 0.9); break;
      case 'inked': if (active) cue('splat', 1); break;
      case 'boo': cue(active ? 'boo.on' : 'boo.off', 0.85); break;
      case 'star': if (!active) cue('effect.end', 0.7); break;
      case 'bullet': if (!active) cue('effect.end', 0.7); break;
      default: break;
    }
  });
  on<{ racer: Racer }>('item:steal', ({ racer }) => {
    if (racer.isPlayer) cue('item.get', 0.8);
  });
  // The chime climbs with the purse, the way every game that has ever had a
  // collectable does it — because a run of coins that all sound the same is a
  // repeated noise, and a run that climbs is a *streak*. It tops out at ten,
  // which is where the coin's speed bonus tops out too, so the ear is told the
  // same thing the physics knows.
  on<{ racer: Racer; total: number }>('coin:get', ({ racer, total }) => {
    if (racer.isPlayer) cue('coin', 1, 1, null, 1 + 0.03 * clamp(total, 0, 10));
  });
  on<{ racer: Racer; count: number }>('coin:lose', ({ racer }) => {
    if (racer.isPlayer) cue('coin.lose');
  });

  /**
   * The wrong-way sign, which the director calls an alarm and which had no
   * alarm: it strobed in silence, because there was no `wrongway` id in the
   * bank and nothing subscribed to the event.
   *
   * It fires on the two *edges* only, so this is a latch rather than a poll:
   * the shot is two beeps of a reversing alarm and `update` re-arms it every
   * `WRONGWAY_PERIOD` for as long as the sign is up. Held here rather than
   * scheduled as one long loop because the sign can go out at any moment and a
   * loop already scheduled on the audio clock cannot be taken back.
   */
  on<{ on: boolean }>('race:wrongway', ({ on: active }) => {
    wrongWay = active;
    // Fire on the frame it happens, not a period later.
    if (active) wrongWayT = WRONGWAY_PERIOD;
  });

  /**
   * **Is the race being run?** One test, and this is it.
   *
   * There were two, three hundred lines apart in this file, and they disagreed.
   * `updateRacers` asked `ctx.race.phase === 'loading'` and cut the throttle,
   * which is right and fires. The engine-bus trim asked `ctx.time.scale === 0`
   * — and the director does not touch `time.scale` when it pauses; it calls
   * `holdField()` and `setPhaseQuiet('loading')` and nothing else. Measured
   * with the pause plate up: `{ phase: "loading", timeScale: 1 }`. So the
   * comment above the trim was exactly right about what should happen and the
   * line under it could never make it happen, and the whole field idled at full
   * bus gain behind the pause menu.
   *
   * `loading` is the phase `togglePause` parks the race in, and — per
   * ARCHITECTURE §11a — it is *not* "the front-end is up", which the race
   * simulates straight through. It is pause, or the moment before the first
   * grid has been formed. Both are "not being run".
   */
  const raceStopped = (): boolean => ctx.race.phase === 'loading';

  /**
   * Pausing, and coming back.
   *
   * `race:pause` had zero listeners: the loudest state change in the game — the
   * whole world stopping — happened in complete silence while the class screen
   * two menus earlier clicked on every keypress.
   */
  on<{ on: boolean }>('race:pause', ({ on: active }) => {
    cue(active ? 'pause.on' : 'pause.off', 0.85);
  });

  // The one channel that is genuinely a *warning*: it fires on the two edges of
  // "something will hit you inside 1.6 seconds", carrying where it is in the
  // player's own frame. The siren is started here and driven to impact in
  // `update`, so there is no polling and no timeout of our own.
  on<{ on: boolean; level: number; bearing: number }>(
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
    // The grid. Seven and a bit seconds of intro and countdown used to be
    // silence with four beeps in it — the single most anticipatory moment in
    // the game, and the mix's answer to it was nothing. The vamp runs at the
    // race tempo and the flag cuts straight to the theme's downbeat.
    if (phase === 'intro' || phase === 'countdown') return 'grid';
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
    const paused = raceStopped();
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
    // The music's own trim. The bed's *headroom* is set downstream, by a fixed
    // shelf on the music bus in `context.ts`; this is only the level the
    // arrangement was written at.
    music = createMusic(backend, 0.85);
    detachGestures();
  }

  const onGesture = (): void => {
    boot();
    if (be?.live && be.ac.state !== 'running') void be.live.resume().catch(() => { /* blocked */ });
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
      if (be?.live && be.ac.state !== 'running') {
        try { await be.live.resume(); } catch { /* still blocked; try again next gesture */ }
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
   * `render` is the important one. It builds this exact mixer inside an
   * OfflineAudioContext and hands back the samples, so audio can be reviewed
   * the way every other module in this repo is reviewed — by looking at what it
   * actually produced. Every level in `sfx.ts`, the engine bed's trim and the
   * tilt across it were set from measurements taken through it, not by ear.
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
      /** Render a slice of this game's audio offline and hand back the samples.
       *  The one way to review sound the way every other module is reviewed:
       *  by looking at what it actually produced. See `bench.ts`. */
      render: (spec: RenderSpec) => renderAudio(spec),
      /** The mix's own acceptance test: renders the shipped graph at the
       *  shipped gains and asserts that an explosion still lands, that the
       *  sidechain opens on the transient, that the busy mix has dynamics in
       *  it and that the theme has a form. See `bench.ts`. */
      acceptance: () => acceptance(),
      /** Every id the one-shot bank answers to, for a reviewer enumerating them. */
      ids: () => SOUND_IDS.slice(),
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
        duck: be ? +be.duck.depth.toFixed(3) : 0,
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
      // Cut the bed. Every other change of track waits for a bar line, which is
      // right for a lift and wrong for a new race: a measured run that reset out
      // of the results screen kept the victory fanfare playing over the new
      // grid for the rest of its bar. Dropping to silence here means the next
      // frame finds `mode === 'none'` and cold-starts the correct track on its
      // own downbeat, which is also the only way a race ever begins in time.
      music?.setMode('none', 0.08);
      threat = 0;
      threatActive = false;
      wrongWay = false;
      wrongWayT = 0;
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

      // The alarm, re-armed. Before `flush`, so the shot is scheduled in the
      // same pass as everything else that happened this frame.
      if (wrongWay) {
        wrongWayT += step;
        if (wrongWayT >= WRONGWAY_PERIOD) { wrongWayT = 0; cue('wrongway', 0.8); }
      }

      bank.frame(now, step);
      updateListener(step);
      updateRacers(step, alpha, now);
      updateCues(step, now);
      // Spend the frame's impulses before anything else touches the mix. Each
      // one opens the sidechain at its own scheduled start time as it goes
      // (`sfx.ts` → `duck.ts`), so the hole is sample-aligned with the
      // transient rather than a frame behind it.
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
      music.update(step, now);

      // The sidechain's transient stage is driven by the sound bank itself, at
      // the instant each voice is scheduled — nothing to do here. What is left
      // is the siren, which is not a transient: an incoming item counts as
      // loud *before* it arrives, because a warning is only a warning if it can
      // be heard over the player's own machine, and the cheapest decibels in
      // any mix are the ones taken away from something else.
      be.duck.hold(threat * 0.85);
      be.duck.update(now, step);

      // The field steps back for the results music, so the fanfare is not
      // fighting a whole field still driving around behind it. A paused game
      // steps back further still: the engines are the sound of the race being
      // run, and a race that is not being run should not be roaring.
      const paused = raceStopped();
      const trim = cfgAudio.engine
        * (phase === 'results' || phase === 'finished' ? 0.45 : 1)
        * (paused ? 0.12 : 1);
      if (trim !== engineTrim) {
        engineTrim = trim;
        be.engine.gain.setTargetAtTime(trim, now, paused ? 0.08 : 0.25);
      }
    },

    dispose(): void {
      detachGestures();
      for (const u of unsubs) u();
      unsubs.length = 0;
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
