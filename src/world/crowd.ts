// Spectators.
//
// A grandstand full of people is the single most expensive thing you can put
// beside a race track and the single most valuable: an empty stand does not
// read as "quiet", it reads as "unfinished". So the crowd is built to be
// affordable rather than built small.
//
// The trick is that a spectator has no bones, no skinning and no CPU cost at
// all. Each one is six boxes with a per-vertex phase baked in, and the whole
// stand is one geometry; the bob, the sway and the wave are a vertex program on
// the shared crowd material (see look.ts). Three hundred people cost one draw
// call and nothing per frame — which is why there can be several thousand of
// them around the lap.
//
// They are also, of course, at a roadworks. Two in five are wearing a hard hat.

import * as THREE from 'three';
import { Kit, buildProp } from './kit.ts';
import { C } from './look.ts';
import { makeRng, type Rng } from '../core/math.ts';

const TROUSERS = [0x2b3440, 0x3f4a5a, 0x5a4632, 0x6b7280, 0x27405e, 0x4a3a4f] as const;

export interface PersonOptions {
  /** Overall lighting multiplier — back rows and roofed stands sit darker. */
  shade?: number;
  /** Chance this one has both arms up. */
  waveChance?: number;
  /** Chance this one is waving a flag. */
  flagChance?: number;
  scale?: number;
}

/**
 * One spectator, standing at (x,y,z) and facing `yaw`.
 *
 * Everything on the body carries the same `aAmp`, so a person bounces as one
 * rigid object rather than coming apart at the neck; only raised arms get more,
 * and only enough to read as a wave.
 */
export function person(
  k: Kit, rng: Rng, x: number, y: number, z: number, yaw: number,
  opts: PersonOptions = {},
): void {
  const shade = opts.shade ?? 1;
  const phase = rng.next();
  const shirt = rng.pick(C.shirts);
  const trouser = rng.pick(TROUSERS);
  const skin = rng.pick(C.skin);
  const hat = rng.bool(0.42);
  const wave = rng.bool(opts.waveChance ?? 0.34);
  const flag = wave && rng.bool(opts.flagChance ?? 0.3);
  const s = (opts.scale ?? 1) * rng.range(0.88, 1.08);

  const body = { amp: 1, phase, noAo: true, shade };
  const limb = { amp: wave ? 1.28 : 1.04, phase, noAo: true, shade };

  k.push();
  k.move(x, y, z).rotY(yaw + rng.range(-0.42, 0.42)).scale(s);

  // Six boxes, seventy-two triangles. There are several thousand of these on
  // the course, so every part that does not change the silhouette at fifty
  // metres has been taken out: no hands, no shoulders, no neck.
  k.box(0, 0.34, 0, 0.36, 0.68, 0.26, trouser, body);
  k.box(0, 0.99, 0, 0.48, 0.66, 0.3, shirt, body);
  k.box(0, 1.44, 0, 0.27, 0.3, 0.26, skin, body);
  k.box(0, 1.62, 0, 0.33, 0.14, 0.34, hat ? C.yellow : rng.pick(C.shirts), body);

  for (const sx of [-1, 1] as const) {
    if (wave) {
      k.push();
      k.move(sx * 0.28, 1.18, 0).rotZ(sx * 0.42);
      k.box(0, 0.36, 0, 0.15, 0.74, 0.15, shirt, limb);
      k.pop();
    } else {
      k.box(sx * 0.3, 0.9, 0, 0.15, 0.64, 0.17, shirt, limb);
    }
  }

  if (flag) {
    k.push();
    k.move(0.3, 1.85, 0).rotZ(-0.34);
    k.box(0, 0.32, 0, 0.05, 0.66, 0.05, C.timber, limb);
    k.box(0.3, 0.52, 0, 0.56, 0.36, 0.04, rng.pick(C.shirts), limb);
    k.pop();
  }
  k.pop();
}

/**
 * A stand full of people, laid out on the same terraces `grandstandGeo` builds.
 *
 * Deliberately shaded down: this crowd is under a roof, and a crowd lit like
 * the open desert around it makes the roof look like a decal.
 */
export function standCrowdGeo(bays: number, seed = 7): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const W = bays * 3.4, ROWS = 9, RISE = 0.52, TREAD = 0.95;
  return buildProp('standCrowd', (k) => {
    for (let r = 0; r < ROWS; r++) {
      const y = 0.55 + r * RISE;
      const z = -r * TREAD;
      const n = Math.max(2, Math.floor(W / 0.72));
      for (let i = 0; i < n; i++) {
        if (rng.bool(0.06)) continue; // the odd empty seat; a full house is a wall
        const x = -W / 2 + 0.4 + (i + 0.5) * ((W - 0.8) / n) + rng.range(-0.09, 0.09);
        person(k, rng, x, y, z + rng.range(-0.16, 0.16), 0, {
          // Front rows catch the sky, back rows sit under the roof.
          shade: 0.66 + (1 - r / ROWS) * 0.3,
          waveChance: 0.3 + (1 - r / ROWS) * 0.2,
        });
      }
    }
  }, 0);
}

/**
 * A crowd for a flat deck — a scaffold platform, a bridge over the road.
 *
 * The cluster version brings its own earth bank with it, which is right on a
 * hillside and very wrong nine metres up in the air.
 */
export function deckCrowdGeo(seed: number, w = 9, rows = 2, seat = 0.9): THREE.BufferGeometry {
  const rng = makeRng(seed);
  return buildProp('deckCrowd', (k) => {
    for (let r = 0; r < rows; r++) {
      const n = Math.max(2, Math.round(w / seat));
      for (let i = 0; i < n; i++) {
        if (rng.bool(0.14)) continue;
        person(k, rng, -w / 2 + (i + 0.5) * (w / n) + rng.range(-0.12, 0.12), 0,
          -r * 0.85 + rng.range(-0.12, 0.12), rng.range(-0.35, 0.35),
          { waveChance: 0.55, flagChance: 0.4 });
      }
    }
  }, 0);
}

/** The cheap seats: five rows of scaffolding, matching `terraceGeo`. */
export function terraceCrowdGeo(seed = 11): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const W = 13, ROWS = 5;
  return buildProp('terraceCrowd', (k) => {
    for (let r = 0; r < ROWS; r++) {
      const y = 0.55 + r * 0.55;
      const z = -r * 1.05;
      const n = 17;
      for (let i = 0; i < n; i++) {
        if (rng.bool(0.12)) continue;
        const x = -W / 2 + 0.5 + (i + 0.5) * ((W - 1) / n) + rng.range(-0.1, 0.1);
        person(k, rng, x, y, z + rng.range(-0.14, 0.14), 0, {
          shade: 0.9 + (1 - r / ROWS) * 0.12, waveChance: 0.44,
        });
      }
    }
  }, 0);
}

/**
 * A standing crowd on a spectator bank.
 *
 * The bank comes with it, and it matters: the embankment beside this circuit
 * falls five metres inside thirty, so a crowd standing on the natural ground is
 * a crowd nobody sees over the barrier. This is placed at *road* level with a
 * plinth that runs down to meet whatever the ground has done, and the four
 * terraces lift the back row a metre and a half clear of everything in front of
 * it — which is, of course, exactly why real banking is built that way.
 *
 * Each cluster is generated from its own seed so several can be tiled along a
 * corner without reading as a repeat.
 */
export function clusterCrowdGeo(seed: number, w = 12, d = 6.4): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const ROWS = 4;
  const RISE = 0.5;
  const tread = d / ROWS;
  return buildProp('crowdCluster', (k) => {
    // The bank. One buried block plus a terrace per row.
    k.box(0, -4.3, -d * 0.5, w + 3.4, 8.6, d + 6, C.dirtDark, { noAo: true, shade: 0.7 });
    for (let r = 0; r < ROWS; r++) {
      k.box(0, r * RISE - 0.16, -r * tread - tread * 0.5, w + 2.6 - r * 0.3, 0.34 + r * RISE,
        tread + 0.4, r % 2 ? C.dirt : C.dirtDark, { noAo: true, shade: 0.86 - r * 0.04 });
    }
    // A run of site fence across the front, panelled in course colours — it is
    // what actually holds a crowd back, and it gives the block a hard bottom
    // edge instead of a bare wall of dirt.
    // Waist height, not chest height: the fence is there to give the block a
    // hard bottom edge, and every centimetre of it is a centimetre of crowd
    // nobody can see.
    const panels = [C.orange, C.navy, C.yellow, C.navy, C.cyan, C.orange];
    for (let i = 0; i <= 8; i++) {
      const x = -w / 2 - 0.6 + (i / 8) * (w + 1.2);
      k.strut(x, 0, 0.9, x, 1.35, 0.9, 0.055, C.galv, { noAo: true, shade: 0.9 });
      if (i === 8) continue;
      const x2 = -w / 2 - 0.6 + ((i + 1) / 8) * (w + 1.2);
      k.box((x + x2) * 0.5, 0.66, 0.92, (x2 - x) * 0.94, 1.16, 0.05,
        panels[i % panels.length]!, { noAo: true, shade: 0.86 });
    }
    k.strut(-w / 2 - 0.6, 1.37, 0.9, w / 2 + 0.6, 1.37, 0.9, 0.06, C.orange, { noAo: true });

    for (let r = 0; r < ROWS; r++) {
      const y = r * RISE;
      const z = -r * tread;
      const n = Math.max(3, Math.round(w / 0.78));
      for (let i = 0; i < n; i++) {
        if (rng.bool(0.14)) continue;
        const x = -w / 2 + (i + 0.5) * (w / n) + rng.range(-0.16, 0.16);
        person(k, rng, x, y, z + rng.range(-0.22, 0.22), rng.range(-0.3, 0.3), {
          shade: 0.94 + r * 0.02, waveChance: 0.5, flagChance: 0.42,
        });
      }
    }
  }, 0);
}
