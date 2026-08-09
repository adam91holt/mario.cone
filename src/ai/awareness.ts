// What a CPU can see right now.
//
// One shared scan per fixed step, read by every driver. The alternative — each
// driver projecting every other kart onto the spline for itself — is O(n²)
// `nearest()` calls a step, and `nearest()` is not free. This does n of them and
// hands out the answers.
//
// Everything here is expressed in *track* coordinates (distance along the lap,
// lateral offset from the centreline) rather than world space, because every
// decision a racing driver makes is in those terms: "he is eight metres ahead
// and two metres to my left" is actionable, a world-space vector is not.
//
// The hazard log is fed by the item system's own events rather than by reaching
// into its entity list. A banana is emitted once, at a known place, with a
// known life — that is enough to drive around it, and it keeps this module from
// depending on another module's internals. Events are delivered synchronously
// inside `fixedUpdate`, so the log stays deterministic.

import * as THREE from 'three';
import type { GameContext, ItemId, Racer, SplineSample } from '../types.ts';

/** Bananas outlive most of a lap; the pool never needs to be big. */
const MAX_HAZARDS = 40;
/** Seconds a dropped banana is assumed to sit there (items uses `life: 26`). */
const BANANA_LIFE = 26;
/** A bomb sits on its fuse, then owns a wide circle for a moment. */
const BOMB_LIFE = 3.4;
/** How long a shell laid behind stays a thing worth going round. */
const SHELL_LIFE = 7;
/** Item boxes come back four seconds after somebody takes one (items/boxes.ts). */
const BOX_RESPAWN = 4.0;
/** Distinct box positions worth remembering. Cone Canyon lays 25. */
const MAX_BOXES = 48;

interface Hazard {
  active: boolean;
  /** Lap distance and lateral offset, track frame. */
  d: number;
  lat: number;
  life: number;
  radius: number;
  ownerId: number;
}

/**
 * An item box, at a place the field has watched somebody take one.
 *
 * Nothing here reaches into the item system's box list. A box announces itself
 * the first time anybody breaks it (`item:box`), and boxes come back in the
 * same place, so by the end of the opening lap the field knows the row it drove
 * through — which is exactly how a player learns a circuit too.
 */
interface BoxNote {
  active: boolean;
  d: number;
  lat: number;
  /** Seconds until it is back, 0 if it is there now. */
  gone: number;
}

export interface World {
  /** Lap distance of each racer, indexed the same as `ctx.racers`. */
  readonly dist: Float64Array;
  /** Lateral offset of each racer. */
  readonly lat: Float64Array;
  /** Road half-width where each racer is. */
  readonly half: Float64Array;
  readonly hazards: readonly Hazard[];
  readonly boxes: readonly BoxNote[];
  /** Step counter, so a driver can tell whether the scan is fresh. */
  readonly frame: number;
  scan(): void;
  clear(): void;
  /** Index of a racer in the scan arrays. */
  indexOf(racer: Racer): number;
  dispose(): void;
}

const worlds = new WeakMap<GameContext, World>();

const _fwd = new THREE.Vector3();

function blankSample(): SplineSample {
  return {
    pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
    right: new THREE.Vector3(), up: new THREE.Vector3(),
    width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
  };
}

export function getWorld(ctx: GameContext): World {
  let w = worlds.get(ctx);
  if (!w) {
    w = createWorld(ctx);
    worlds.set(ctx, w);
  }
  return w;
}

/** Forget a context's world, so a re-created system does not inherit dead
 *  bus subscriptions from the one it replaced. */
export function dropWorld(ctx: GameContext): void {
  worlds.delete(ctx);
}

function createWorld(ctx: GameContext): World {
  let dist = new Float64Array(16);
  let lat = new Float64Array(16);
  let half = new Float64Array(16);
  const index = new Map<number, number>();
  const sample = blankSample();
  let frame = 0;

  const hazards: Hazard[] = [];
  for (let i = 0; i < MAX_HAZARDS; i++) {
    hazards.push({ active: false, d: 0, lat: 0, life: 0, radius: 0, ownerId: -1 });
  }
  const boxes: BoxNote[] = [];
  for (let i = 0; i < MAX_BOXES; i++) boxes.push({ active: false, d: 0, lat: 0, gone: 0 });

  function grow(nRacers: number): void {
    if (dist.length >= nRacers) return;
    const size = Math.max(nRacers, dist.length * 2);
    dist = new Float64Array(size);
    lat = new Float64Array(size);
    half = new Float64Array(size);
  }

  function addHazard(d: number, latOff: number, radius: number, life: number, ownerId: number): void {
    let slot = -1;
    let oldest = Infinity;
    for (let i = 0; i < hazards.length; i++) {
      const h = hazards[i];
      if (!h.active) { slot = i; break; }
      if (h.life < oldest) { oldest = h.life; slot = i; }
    }
    const h = hazards[slot];
    h.active = true;
    h.d = d;
    h.lat = latOff;
    h.radius = radius;
    h.life = life;
    h.ownerId = ownerId;
  }

  /**
   * A banana has just been laid.
   *
   * Thrown forward it leaves the kart at 19 m/s with a 7.5 m/s lob, which puts
   * it a little over eight metres up the road; dropped behind it lands where
   * the kart is. Either way the payload gives the thrower's position on the
   * step it happened, which is all a driver needs to know to go round it.
   */
  const offUse = ctx.bus.on<{ racer: Racer; item: ItemId; forward: boolean }>(
    'item:use', ({ racer, item, forward }) => {
      if (!ctx.track) return;
      // Only the things that stop and *stay* in the road are worth logging. A
      // shell thrown forward is a moving threat somebody else has to deal with;
      // one laid behind is a rock, and so is a banana, and so is a bomb until
      // its fuse runs out.
      let life = 0;
      let radius = 2.6;
      if (item === 'banana') life = BANANA_LIFE;
      else if (item === 'bomb') { life = BOMB_LIFE; radius = 5.2; }
      else if (item === 'greenShell' && !forward) { life = SHELL_LIFE; radius = 2.4; }
      if (life === 0) return;

      const s = ctx.track.spline.nearest(racer.pos, sample);
      let d = s.distance;
      let l = s.lateral ?? 0;
      if (forward) {
        _fwd.set(Math.sin(racer.yaw), 0, Math.cos(racer.yaw));
        // Project the throw onto the road rather than integrating the lob: the
        // difference is under a metre and this costs two dot products.
        d += _fwd.dot(s.tangent) * 8.5;
        l += _fwd.dot(s.right) * 8.5;
      }
      addHazard(d, l, radius, life, racer.id);
    });

  /**
   * A bomb has gone off. Whatever it was is no longer in the road, and the
   * karts that were about to steer round it should stop steering round it.
   */
  const offBlast = ctx.bus.on<{ pos: THREE.Vector3 }>('item:blast', ({ pos }) => {
    if (!ctx.track) return;
    const s = ctx.track.spline.nearest(pos, sample);
    for (let i = 0; i < hazards.length; i++) {
      const h = hazards[i];
      if (!h.active || h.radius < 4) continue;
      if (Math.abs(ctx.track.spline.signedDistance(h.d, s.distance)) < 14) h.active = false;
    }
  });

  /**
   * Somebody has just taken a box. Remember where it was.
   *
   * Matching on position rather than identity keeps this independent of the
   * item module's internals: two pickups within a couple of metres of each
   * other are the same box, and the note simply starts its respawn clock again.
   */
  const offBox = ctx.bus.on<{ racer: Racer; pos: THREE.Vector3 }>(
    'item:box', ({ pos }) => {
      if (!ctx.track) return;
      const s = ctx.track.spline.nearest(pos, sample);
      const d = s.distance;
      const l = s.lateral ?? 0;
      let slot = -1;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (!b.active) { if (slot < 0) slot = i; continue; }
        if (Math.abs(ctx.track.spline.signedDistance(b.d, d)) < 3 && Math.abs(b.lat - l) < 2.2) {
          b.gone = BOX_RESPAWN;
          return;
        }
      }
      if (slot < 0) return;
      const b = boxes[slot];
      b.active = true; b.d = d; b.lat = l; b.gone = BOX_RESPAWN;
    });

  /**
   * Somebody drove into one. Retire the nearest hazard so the field stops
   * steering around a banana that is no longer in the road — without this the
   * log only ever grows and the whole circuit slowly becomes undriveable.
   */
  const offStrike = ctx.bus.on<{ racer: Racer; item: ItemId }>(
    'item:strike', ({ racer, item }) => {
      if (item !== 'banana' || !ctx.track) return;
      const s = ctx.track.spline.nearest(racer.pos, sample);
      let best = -1;
      let bestGap = 12;
      for (let i = 0; i < hazards.length; i++) {
        const h = hazards[i];
        if (!h.active) continue;
        const gap = Math.abs(ctx.track.spline.signedDistance(h.d, s.distance))
          + Math.abs(h.lat - (s.lateral ?? 0));
        if (gap < bestGap) { bestGap = gap; best = i; }
      }
      if (best >= 0) hazards[best].active = false;
    });

  return {
    get dist() { return dist; },
    get lat() { return lat; },
    get half() { return half; },
    hazards,
    boxes,
    get frame() { return frame; },

    scan(): void {
      const track = ctx.track;
      if (!track) return;
      const racers = ctx.racers;
      grow(racers.length);
      index.clear();
      for (let i = 0; i < racers.length; i++) {
        const r = racers[i];
        index.set(r.id, i);
        const s = track.spline.nearest(r.pos, sample);
        dist[i] = s.distance;
        lat[i] = s.lateral ?? 0;
        half[i] = s.width * 0.5;
      }
      const dt = ctx.config.sim.fixedDt;
      for (let i = 0; i < hazards.length; i++) {
        const h = hazards[i];
        if (!h.active) continue;
        h.life -= dt;
        if (h.life <= 0) h.active = false;
      }
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.active && b.gone > 0) b.gone = Math.max(0, b.gone - dt);
      }
      frame++;
    },

    clear(): void {
      for (let i = 0; i < hazards.length; i++) hazards[i].active = false;
      // The box map survives a reset only if the circuit did. A different
      // course means every note is in the wrong place.
      for (let i = 0; i < boxes.length; i++) boxes[i].active = false;
      index.clear();
      frame = 0;
    },

    indexOf(racer: Racer): number {
      const i = index.get(racer.id);
      return i === undefined ? -1 : i;
    },

    dispose(): void {
      offUse();
      offStrike();
      offBlast();
      offBox();
    },
  };
}
