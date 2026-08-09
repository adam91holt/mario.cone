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
const MAX_HAZARDS = 32;
/** Seconds a dropped banana is assumed to sit there (items uses `life: 26`). */
const BANANA_LIFE = 26;

interface Hazard {
  active: boolean;
  /** Lap distance and lateral offset, track frame. */
  d: number;
  lat: number;
  life: number;
  radius: number;
  ownerId: number;
}

export interface World {
  /** Lap distance of each racer, indexed the same as `ctx.racers`. */
  readonly dist: Float64Array;
  /** Lateral offset of each racer. */
  readonly lat: Float64Array;
  /** Road half-width where each racer is. */
  readonly half: Float64Array;
  readonly hazards: readonly Hazard[];
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
      if (item !== 'banana' || !ctx.track) return;
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
      addHazard(d, l, 2.6, BANANA_LIFE, racer.id);
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
      frame++;
    },

    clear(): void {
      for (let i = 0; i < hazards.length; i++) hazards[i].active = false;
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
    },
  };
}
