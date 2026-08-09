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
import { BOARD, C } from './look.ts';
import { makeRng, type Rng } from '../core/math.ts';

const TROUSERS = [0x2b3440, 0x3f4a5a, 0x5a4632, 0x6b7280, 0x27405e, 0x4a3a4f] as const;

/** Panelling on the front of a spectator bank and its fence. Muted, because
 *  fifty of these run the whole lap and the crowd on top of them is already the
 *  colour: see the chroma-budget note in look.ts. */
const FACING = [
  BOARD.clay, BOARD.deep, BOARD.ochre, BOARD.slate, BOARD.bone, BOARD.brick,
] as const;

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
  const hair = hat || rng.bool(0.5);
  const wave = rng.bool(opts.waveChance ?? 0.34);
  const flag = wave && rng.bool(opts.flagChance ?? 0.3);
  const s = (opts.scale ?? 1) * rng.range(0.88, 1.08);

  const body = { amp: 1, phase, noAo: true, shade };
  const limb = { amp: wave ? 1.28 : 1.04, phase, noAo: true, shade };

  k.push();
  k.move(x, y, z).rotY(yaw + rng.range(-0.42, 0.42)).scale(s);

  // Six or seven boxes — under eighty triangles — and every one of them is
  // spent on the *outline* rather than on anatomy. There are the better part of
  // a thousand of these baked into the course and fifty copies of some of them
  // around the lap, so this is the single most leveraged triangle budget in the
  // module.
  //
  // The first version was a single trouser block with the arms tucked against
  // the torso, which from the trackside camera read as a rectangle with a
  // smaller rectangle on top. What fixed it was not detail but **gaps**: two
  // legs with daylight between them, arms standing well off the body, and a
  // head clearly narrower than the shoulders. Hair is dropped on a third of the
  // crowd, which pays for the extra leg.
  for (const sx of [-1, 1] as const) {
    k.box(sx * 0.12, 0.33, 0, 0.17, 0.66, 0.24, trouser, body);
  }
  k.box(0, 1.0, 0, 0.5, 0.72, 0.3, shirt, body);
  k.box(0, 1.48, 0, 0.24, 0.3, 0.24, skin, body);
  if (hair) {
    k.box(0, 1.65, 0, 0.31, 0.14, 0.32, hat ? C.yellow : rng.pick(C.shirts), body);
  }

  for (const sx of [-1, 1] as const) {
    if (wave) {
      k.push();
      k.move(sx * 0.31, 1.22, 0).rotZ(sx * 0.52);
      k.box(0, 0.4, 0, 0.13, 0.8, 0.13, shirt, limb);
      k.pop();
    } else {
      k.box(sx * 0.36, 0.94, 0.01, 0.12, 0.62, 0.15, shirt, limb);
    }
  }

  if (flag) {
    k.push();
    k.move(0.34, 1.9, 0).rotZ(-0.34);
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
  const RISE = 0.55;
  const tread = d / ROWS;
  const backZ = -ROWS * tread - 0.6;
  const canopy = rng.pick([BOARD.clay, BOARD.slate, BOARD.deep, BOARD.brick]);
  const roofed = rng.bool(0.66);
  return buildProp('crowdCluster', (k) => {
    // ── the structure ──────────────────────────────────────────────────────
    // These stand at fifty-odd places around the lap, which makes them the
    // *typical* view rather than a special one — so they are built as a small
    // stand, not as a mound. The first version was a raw earth block with
    // people on top, and away from the start/finish it read as a brown plinth
    // sprinkled with confetti. Everything below is the difference between that
    // and something that looks built: a faced retaining wall, a defined back,
    // and a roof.
    //
    // The block is cut back to the fence line. The first version was six metres
    // deep and stood three metres *in front* of its own crowd, so from the road
    // you read a slab of dirt first and some people second — which is the exact
    // opposite of what a spectator bank is for.
    k.box(0, -4.5, -d * 0.5 - 1.5, w + 3.4, 9, d + 3, C.dirtDark,
      { noAo: true, shade: 0.62 });
    // The retaining face. These stand at road level on ground that has already
    // fallen away, so the first thing anyone sees of a bank is the wall holding
    // it up — and a bare wall of dirt is precisely the "brown plinth" read.
    // Capping beam, a band of panels, a plinth course.
    k.box(0, -0.3, 0.14, w + 3.4, 0.6, 0.34, C.concrete, { noAo: true, shade: 1.0 });
    for (let i = 0; i < 6; i++) {
      const bx = (-0.5 + (i + 0.5) / 6) * (w + 3.0);
      k.box(bx, -1.4, 0.1, ((w + 3.0) / 6) * 0.96, 1.6, 0.28,
        FACING[(i + (seed & 3)) % FACING.length]!, { noAo: true, shade: 0.84 });
    }
    k.box(0, -2.34, 0.12, w + 3.4, 0.3, 0.32, C.concreteDark, { noAo: true, shade: 0.86 });
    k.box(0, -4.8, 0.04, w + 3.2, 4.6, 0.24, C.concreteDark, { noAo: true, shade: 0.6 });
    // Faced retaining steps — concrete, not dirt, so the bank has a hard edge
    // and a value that separates from the ground it is cut into.
    for (let r = 0; r < ROWS; r++) {
      const y = r * RISE - 0.18;
      k.box(0, y, -r * tread - tread * 0.5, w + 2.6 - r * 0.3, 0.36 + r * RISE,
        tread + 0.4, r % 2 ? C.concrete : C.concreteDark,
        { noAo: true, shade: 0.82 - r * 0.03 });
      // The nosing on each step: a thin lighter lip, which is what actually
      // makes terracing read as terracing at a hundred metres.
      k.box(0, r * RISE + 0.03, -r * tread + tread * 0.42, w + 2.6 - r * 0.3, 0.1,
        0.18, C.concrete, { noAo: true, shade: 1.0 });
    }
    // Front fence, panelled. Waist height — every centimetre of it is a
    // centimetre of crowd nobody can see.
    for (let i = 0; i <= 8; i++) {
      const x = -w / 2 - 0.6 + (i / 8) * (w + 1.2);
      k.strut(x, 0, 0.9, x, 1.35, 0.9, 0.055, C.galv, { noAo: true, shade: 0.9 });
      if (i === 8) continue;
      const x2 = -w / 2 - 0.6 + ((i + 1) / 8) * (w + 1.2);
      k.box((x + x2) * 0.5, 0.66, 0.92, (x2 - x) * 0.94, 1.16, 0.05,
        FACING[(i + 3) % FACING.length]!, { noAo: true, shade: 0.9 });
    }
    k.strut(-w / 2 - 0.6, 1.37, 0.9, w / 2 + 0.6, 1.37, 0.9, 0.06, C.orange, { noAo: true });

    // ── the back ───────────────────────────────────────────────────────────
    // A wall behind the top row. Without it a bank's silhouette is the crowd
    // itself, which from any distance is a fuzzy edge; with it the whole block
    // has a top line and reads as one built object.
    const backY = (ROWS - 1) * RISE;
    k.box(0, backY + 1.5, backZ, w + 2.2, 3.0, 0.24, C.concreteDark,
      { noAo: true, shade: 0.86 });
    k.box(0, backY + 2.5, backZ + 0.15, w + 2.2, 0.7, 0.06, canopy, { noAo: true });
    k.box(0, backY + 3.06, backZ, w + 2.4, 0.18, 0.44, C.galv, { noAo: true, shade: 0.95 });

    // ── the roof ───────────────────────────────────────────────────────────
    // Two thirds of the banks get a shade canopy over their back rows; the rest
    // get a line of pennants instead. Both give the block a roofline — the
    // single biggest difference between "small stand" and "mound" — and having
    // two answers stops fifty of them round the lap reading as one stamped
    // part. The canopy deliberately stops short of the front row: that is where
    // the crowd colour is, and shading it would throw the whole thing away.
    const roofY = backY + 3.1;
    if (roofed) {
      for (const sx of [-1, 1] as const) {
        k.strut(sx * (w * 0.5 + 0.5), 0, backZ + 0.1, sx * (w * 0.5 + 0.5), roofY,
          backZ + 0.1, 0.09, C.galv, { noAo: true });
        k.strut(sx * (w * 0.5 + 0.5), roofY - 0.1, backZ + 0.1,
          sx * (w * 0.5 + 0.5), roofY + 0.5, backZ + tread * 2.6, 0.07, C.galv,
          { noAo: true });
      }
      k.push();
      k.move(0, roofY + 0.55, backZ + tread * 1.3).rotX(-0.11);
      k.box(0, 0, 0, w + 1.8, 0.16, tread * 2.8 + 0.7, C.offWhite,
        { noAo: true, shade: 0.94 });
      k.pop();
      k.box(0, roofY + 0.66, backZ + tread * 2.72, w + 1.8, 0.6, 0.1, canopy,
        { noAo: true });
    } else {
      for (let i = 0; i < 7; i++) {
        const x = (-0.5 + i / 6) * (w + 1.4);
        k.strut(x, backY + 3.0, backZ, x, backY + 5.4, backZ, 0.05, C.galv, { noAo: true });
        k.box(x + 0.45, backY + 4.8, backZ, 0.9, 0.62, 0.05,
          FACING[(i + 1) % FACING.length]!, { noAo: true });
      }
    }

    // ── the people ─────────────────────────────────────────────────────────
    for (let r = 0; r < ROWS; r++) {
      const y = r * RISE;
      const z = -r * tread;
      const n = Math.max(3, Math.round(w / 0.86));
      for (let i = 0; i < n; i++) {
        if (rng.bool(0.14)) continue;
        const x = -w / 2 + (i + 0.5) * (w / n) + rng.range(-0.16, 0.16);
        person(k, rng, x, y, z + rng.range(-0.2, 0.2), rng.range(-0.3, 0.3), {
          shade: roofed && r >= ROWS - 2 ? 0.8 + r * 0.02 : 0.96 + r * 0.02,
          waveChance: 0.5, flagChance: 0.42,
        });
      }
    }
  }, 0);
}
