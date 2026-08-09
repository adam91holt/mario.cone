// Coins.
//
// Physics already reads `racer.coins` — ten of them are worth about 11% of top
// speed and a chunk of acceleration — but nothing ever incremented it, so the
// stat existed and the mechanic did not. This is the mechanic: coins lie on the
// racing line, you collect them by driving well, and you spill three of them
// every time somebody hits you. That is what makes a hit cost more than the
// spin, and what makes the line worth holding on a lap where you have no item.
//
// Two populations, one look. The laid-out field respawns on a timer; the coins
// knocked out of a racer arc away, land, and can be swept up by whoever is
// behind — which is the best two seconds in the genre.

import * as THREE from 'three';
import { clamp01 } from '../core/math.ts';
import { coinGeometry, coinMaterial, contactShadowGeometry, contactShadowMaterial } from './models.ts';
import { roadCrown, shadowOffset } from './entities.ts';
import type { RacingLine } from '../track/racingline.ts';
import type { GameContext, Track } from '../types.ts';

/** Metres above the tarmac the field coins hang — roughly bonnet height, so
 *  they read against the road rather than disappearing into it. */
const FLOAT = 0.92;
/**
 * Seconds before a collected coin comes back.
 *
 * Tuned against the spill: a hit costs three coins, and ten coins are worth
 * about 11% of top speed, so the punishment is only real if getting back to ten
 * takes a corner or two. With the field as dense as it first was — and this
 * timer as short — every racer in the audit sat pinned at ten coins for the
 * whole race and the stat may as well not have existed.
 */
const RESPAWN = 11.0;
const PICK_RADIUS = 2.1;
export const COIN_PICK_SQ = PICK_RADIUS * PICK_RADIUS;

/** Ceiling on how many spilled coins can be in the world at once. */
const LOOSE_MAX = 36;
/** Seconds a spilled coin lies there before it fades out. */
const LOOSE_LIFE = 7.5;
/**
 * ...and how long a spilled coin is in the air before *anyone* may take it.
 *
 * The racer who dropped it never may — see `sweep`. This is only so that the
 * kart directly behind cannot hoover up a spill on the same frame it is thrown,
 * before the coins have had time to arc out and be seen.
 */
const LOOSE_ARM = 0.35;
const BIN = 12;
/** How much of the lap's coins are drawn, ahead of and behind the driver. */
const DRAW_AHEAD = 260;
const DRAW_BEHIND = 90;

export interface FieldCoin {
  pos: THREE.Vector3;
  distance: number;
  respawn: number;
  phase: number;
  /** The road surface directly under it, and the road's own up there — a coin
   *  floating at bonnet height with nothing under it is the same "pasted on"
   *  read an item box with no shadow has, and there are a hundred of these on a
   *  lap to every twenty-four of those. */
  ground: THREE.Vector3;
  up: THREE.Vector3;
}

interface LooseCoin {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  groundY: number;
  life: number;
  arm: number;
  ownerId: number;
  spin: number;
}

export interface CoinField {
  readonly coins: FieldCoin[];
  rebuild(track: Track, line: RacingLine): void;
  candidates(distance: number): readonly number[];
  take(index: number): void;
  /** Spill `n` coins out of a racer that has just been hit. */
  spill(pos: THREE.Vector3, ownerId: number, n: number, groundY: number): void;
  /** Test the loose coins for a racer. Returns how many were swept up. */
  sweep(pos: THREE.Vector3, racerId: number): number;
  fixedUpdate(dt: number): void;
  /** `centre` is the lap distance to draw around — see the note in `update`. */
  update(time: number, centre: number): void;
  dispose(): void;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3(0, 1, 0);
const _off = new THREE.Vector3();
const _sq = new THREE.Quaternion();

export function createCoinField(ctx: GameContext): CoinField {
  const coins: FieldCoin[] = [];
  const loose: LooseCoin[] = [];
  for (let i = 0; i < LOOSE_MAX; i++) {
    loose.push({
      active: false,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      groundY: 0, life: 0, arm: 0, ownerId: -1, spin: 0,
    });
  }

  const group = new THREE.Group();
  group.name = 'coins';
  ctx.scene.add(group);

  let geometry: THREE.BufferGeometry | null = null;
  let material: THREE.MeshStandardMaterial | null = null;
  let blobGeo: THREE.BufferGeometry | null = null;
  let blobMat: THREE.MeshBasicMaterial | null = null;
  let field: THREE.InstancedMesh | null = null;
  let looseMesh: THREE.InstancedMesh | null = null;
  let fieldShadow: THREE.InstancedMesh | null = null;
  let looseShadow: THREE.InstancedMesh | null = null;
  let bins: number[][] = [];
  let binCount = 0;
  let length = 1;
  /** Instance capacity of `field` — `count` is rewritten every frame. */
  let capacity = 1;

  function ensureAssets(): void {
    if (!geometry) geometry = coinGeometry();
    if (!material) material = coinMaterial();
    if (!blobGeo) {
      blobGeo = contactShadowGeometry(0.44, 0.30);
      blobMat = contactShadowMaterial();
    }
  }

  function clearMeshes(): void {
    for (const m of [field, looseMesh, fieldShadow, looseShadow]) {
      if (!m) continue;
      group.remove(m);
      m.dispose();
    }
    field = looseMesh = fieldShadow = looseShadow = null;
  }

  function rebuild(track: Track, line: RacingLine): void {
    ensureAssets();
    clearMeshes();
    coins.length = 0;
    for (const c of loose) c.active = false;

    const L = track.length;
    length = L;
    const spline = track.spline;
    const start = track.course.startDistance ?? 0;

    // Runs of coins along the line, with a gap between runs. A continuous
    // ribbon of coins all lap would be wallpaper; runs give the player
    // something to aim at and a reason to hold the line through a corner.
    //
    // The gap does the balancing. Ten coins has to be a state you *reach* and
    // then defend, not the state you are in by the first corner — so a lap
    // carries roughly a hundred coins rather than the two hundred it started
    // with, and the run you drove through is still gone when the pack behind
    // arrives.
    const RUN = 5;
    const SPACING = 6.5;
    const GAP = 62;
    let d = start + 55;
    const end = start + L - 30;
    let index = 0;
    while (d < end) {
      for (let i = 0; i < RUN; i++) {
        const at = d + i * SPACING;
        const s = spline.atDistance(at);
        // On the line, with a gentle weave across it so a run reads as a
        // *path* rather than as a row of studs.
        const weave = Math.sin(index * 0.9) * Math.min(2.6, s.width * 0.12);
        const lat = line.lateralAt(at) + weave;
        // The tarmac stands proud of the spline — see `roadCrown` — so the
        // ground point has to include the crown or every coin's shadow is drawn
        // inside the road.
        const ground = new THREE.Vector3()
          .copy(s.pos)
          .addScaledVector(s.right, lat)
          .addScaledVector(s.up, roadCrown(lat, s.width, track.course.vergeWidth ?? 5) + 0.03);
        const pos = ground.clone().addScaledVector(s.up, FLOAT);
        coins.push({
          pos,
          distance: ((at % L) + L) % L,
          respawn: 0,
          phase: index * 0.7,
          ground,
          up: s.up.clone().normalize(),
        });
        index++;
      }
      d += RUN * SPACING + GAP;
    }

    binCount = Math.max(1, Math.ceil(L / BIN));
    bins = new Array(binCount);
    for (let i = 0; i < binCount; i++) bins[i] = [];
    for (let i = 0; i < coins.length; i++) {
      bins[Math.floor(coins[i]!.distance / BIN) % binCount]!.push(i);
    }

    capacity = Math.max(1, coins.length);
    field = new THREE.InstancedMesh(geometry!, material!, capacity);
    looseMesh = new THREE.InstancedMesh(geometry!, material!, LOOSE_MAX);
    fieldShadow = new THREE.InstancedMesh(blobGeo!, blobMat!, capacity);
    looseShadow = new THREE.InstancedMesh(blobGeo!, blobMat!, LOOSE_MAX);
    for (const m of [field, looseMesh, fieldShadow, looseShadow]) {
      m.frustumCulled = false;
      m.castShadow = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      group.add(m);
    }
    fieldShadow.renderOrder = -1;
    looseShadow.renderOrder = -1;
  }

  const _empty: number[] = [];
  const _found: number[] = [];

  return {
    coins,
    rebuild,

    candidates(distance: number): readonly number[] {
      if (!binCount) return _empty;
      const d = ((distance % length) + length) % length;
      const b = Math.floor(d / BIN) % binCount;
      _found.length = 0;
      for (let k = -1; k <= 1; k++) {
        const list = bins[(b + k + binCount) % binCount]!;
        for (let i = 0; i < list.length; i++) _found.push(list[i]!);
      }
      return _found;
    },

    take(index: number): void {
      const c = coins[index];
      if (c) c.respawn = RESPAWN;
    },

    spill(pos: THREE.Vector3, ownerId: number, n: number, groundY: number): void {
      let spawned = 0;
      for (let i = 0; i < loose.length && spawned < n; i++) {
        const c = loose[i]!;
        if (c.active) continue;
        c.active = true;
        c.pos.copy(pos);
        c.pos.y += 0.4;
        // Fanned out sideways and up, deterministically: three coins spat out
        // of the same hit must land in three different places, and none of it
        // may come from a random draw the replay cannot reproduce.
        const a = (spawned / Math.max(1, n)) * Math.PI * 2 + ownerId;
        c.vel.set(Math.sin(a) * 5.2, 6.4 + (spawned % 2) * 1.4, Math.cos(a) * 5.2);
        c.groundY = groundY;
        c.life = LOOSE_LIFE;
        c.arm = LOOSE_ARM;
        c.ownerId = ownerId;
        c.spin = a;
        spawned++;
      }
    },

    sweep(pos: THREE.Vector3, racerId: number): number {
      let got = 0;
      for (let i = 0; i < loose.length; i++) {
        const c = loose[i]!;
        if (!c.active || c.life <= 0) continue;
        // The racer who dropped these never gets them back. Not a timer — a
        // rule. With a short arming window the victim was still spinning
        // *inside* their own spill when it expired and swept two of the three
        // coins straight back up, which refunds most of the penalty within two
        // seconds and leaves a hit costing nothing but the spin. They are for
        // whoever is behind.
        if (c.ownerId === racerId) continue;
        if (c.arm > 0) continue;
        if (c.pos.distanceToSquared(pos) > COIN_PICK_SQ + 1.2) continue;
        c.active = false;
        got++;
      }
      return got;
    },

    fixedUpdate(dt: number): void {
      for (let i = 0; i < coins.length; i++) {
        const c = coins[i]!;
        if (c.respawn > 0) c.respawn = Math.max(0, c.respawn - dt);
      }
      for (let i = 0; i < loose.length; i++) {
        const c = loose[i]!;
        if (!c.active) continue;
        c.life -= dt;
        if (c.life <= 0) { c.active = false; continue; }
        if (c.arm > 0) c.arm = Math.max(0, c.arm - dt);
        if (c.pos.y > c.groundY + 0.42) {
          c.vel.y -= 26 * dt;
          c.pos.addScaledVector(c.vel, dt);
          if (c.pos.y <= c.groundY + 0.42) {
            c.pos.y = c.groundY + 0.42;
            // One small bounce, then it lies there and waits to be swept up.
            c.vel.multiplyScalar(0.25);
            c.vel.y = Math.abs(c.vel.y) * 0.35;
            if (c.vel.y < 1.2) c.vel.set(0, 0, 0);
          }
        }
        c.spin += dt * 5.5;
      }
    },

    update(time: number, centre: number): void {
      if (!field || !looseMesh || !fieldShadow || !looseShadow) return;

      // Only the coins near the driver are drawn, compacted into the front of
      // the instance buffer. A lap of coins is a couple of hundred instances
      // and an InstancedMesh spanning the whole circuit can never be culled, so
      // without this window the far side of the map is paid for every frame.
      let slot = 0;
      for (let i = 0; i < coins.length; i++) {
        const c = coins[i]!;
        if (c.respawn > 0) continue;
        let gap = c.distance - centre;
        if (gap > length * 0.5) gap -= length;
        else if (gap < -length * 0.5) gap += length;
        if (gap < -DRAW_BEHIND || gap > DRAW_AHEAD) continue;

        const bob = Math.sin(time * 2.2 + c.phase) * 0.09;
        _p.copy(c.pos);
        _p.y += bob;
        _q.setFromAxisAngle(_axis, time * 2.6 + c.phase);
        // Fade the last quarter second back in rather than blinking it on.
        const pop = clamp01((RESPAWN - c.respawn) * 4);
        _s.setScalar(pop);
        _m.compose(_p, _q, _s);
        field.setMatrixAt(slot, _m);

        _p.copy(c.ground).add(shadowOffset(FLOAT + bob, c.up, _off));
        _sq.setFromUnitVectors(_axis, c.up);
        _s.setScalar(pop * (1 + bob * 0.5));
        _m.compose(_p, _sq, _s);
        fieldShadow.setMatrixAt(slot, _m);

        slot++;
        if (slot >= capacity) break;
      }
      field.count = slot;
      field.instanceMatrix.needsUpdate = true;
      fieldShadow.count = slot;
      fieldShadow.instanceMatrix.needsUpdate = true;

      for (let i = 0; i < loose.length; i++) {
        const c = loose[i]!;
        const s = c.active ? clamp01(c.life * 1.6) : 0;
        _p.copy(c.pos);
        _q.setFromAxisAngle(_axis, c.spin);
        _s.setScalar(s);
        _m.compose(_p, _q, _s);
        looseMesh.setMatrixAt(i, _m);

        // A spilled coin's shadow is what says it is *bouncing* rather than
        // hanging: it shrinks away as the coin arcs up and rushes back to meet
        // it on the way down.
        const h = Math.max(0.04, c.pos.y - c.groundY);
        _p.set(c.pos.x, c.groundY + 0.03, c.pos.z).add(shadowOffset(h, _axis, _off));
        _sq.identity();
        _s.setScalar(s * clamp01(1.1 - h * 0.12));
        _m.compose(_p, _sq, _s);
        looseShadow.setMatrixAt(i, _m);
      }
      looseMesh.instanceMatrix.needsUpdate = true;
      looseShadow.instanceMatrix.needsUpdate = true;
    },

    dispose(): void {
      clearMeshes();
      geometry?.dispose();
      material?.dispose();
      blobGeo?.dispose();
      blobMat?.dispose();
      geometry = null;
      material = null;
      blobGeo = null;
      blobMat = null;
      ctx.scene.remove(group);
      coins.length = 0;
    },
  };
}
