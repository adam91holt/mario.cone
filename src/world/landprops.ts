// The kit that belongs to one landscape and no other.
//
// `props.ts` is the roadworks kit — cones, drums, hoardings, works compounds —
// and every course gets all of it, because every course in this game is a
// closed road. This file is what makes them different *places*: the things that
// only exist in a quarry, only on a mountain, only on a dry lake.
//
// Same three rules as props.ts. One geometry each, vertex colour baked in, so
// every kind is an InstancedMesh. Silhouette first, because at 60 m/s in
// peripheral vision the outline is all there is. Long props authored along +Z,
// so `Spot.along` and `Spot.face` mean the same thing here as they do there.
//
// One extra rule of its own: **nothing here may be mistaken for the race**.
// These sit beyond the barrier, in the run-off and the middle distance, and the
// player's eye is busy. So the palettes come from `themes.ts` — muted rock,
// soil and vegetation — and the only saturated thing anywhere in this file is
// the tip of a snow pole, which is high-vis orange in real life for exactly the
// reason it is here: it is a marker, and it is *supposed* to be found.

import * as THREE from 'three';
import { Kit, buildProp } from './kit.ts';
import { C, mute } from './look.ts';
import { PLANT, type LandPalette } from './themes.ts';
import { makeRng } from '../core/math.ts';

// ── alpine ─────────────────────────────────────────────────────────────────

/**
 * A stand of conifers.
 *
 * Trees are the single strongest "this is a mountain" cue there is, and one
 * tree is never a cue — a slope has forest on it or it does not. So the unit is
 * a clump of four on one geometry: four silhouettes for one instance, which is
 * also what lets a hillside carry a couple of hundred of them for four draws.
 *
 * Built as stacked cones on a bare trunk, narrowing and lifting, with the snow
 * that has settled on each tier drawn as a slightly wider, slightly flatter
 * cone just under it. That white line under every skirt is what makes them read
 * as snow-laden rather than as green traffic cones.
 */
export function pineStandGeo(seed: number, pal: LandPalette, count = 4): THREE.BufferGeometry {
  const r = makeRng(0x9f10 + seed * 733);
  const dark = 0x2f4a33;
  const mid = 0x3d5c3c;
  return buildProp('pineStand', (k) => {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + r.range(-0.5, 0.5);
      const rad = i === 0 ? 0 : r.range(3.4, 8.2);
      const h = r.range(7.5, 12.5);
      const w = h * r.range(0.20, 0.26);
      k.push();
      k.move(Math.cos(a) * rad, 0, Math.sin(a) * rad).rotY(r.range(0, 6.28));
      k.cyl(0, h * 0.13, 0, 0.17, 0.30, h * 0.26, 5, 0x4a3a2c, { ao: 0.5, aoHeight: 2 });
      const tiers = 4;
      for (let t = 0; t < tiers; t++) {
        const f = t / tiers;
        const y = h * (0.16 + f * 0.62);
        const rr = w * (1 - f * 0.62);
        const hh = h * (0.34 - f * 0.06);
        if (pal.cap !== null) {
          k.cone(0, y - 0.12, 0, rr * 1.05, hh * 0.42, 7, pal.cap,
            { ao: 0.3, aoHeight: h * 0.6 });
        }
        k.cone(0, y, 0, rr, hh, 7, t % 2 ? mid : dark,
          { ao: 0.42, aoHeight: h * 0.7, shade: 1 - f * 0.08 });
      }
      k.pop();
    }
  }, 0.42);
}

/**
 * A snow pole.
 *
 * The one object on a mountain road that is allowed to be loud: two and a half
 * metres of white pole with a hazard-orange head, planted every twenty metres
 * down both shoulders so a plough driver can find the edge of the carriageway
 * under a metre of snow. A line of them running away down a traverse is the
 * cheapest possible statement of "alpine road", and it doubles as a rhythm
 * marker for the corner the traverse is running into.
 */
export function snowPoleGeo(): THREE.BufferGeometry {
  return buildProp('snowPole', (k) => {
    k.cyl(0, 0.06, 0, 0.16, 0.20, 0.12, 6, C.concreteDark, { ao: 0.5 });
    k.cyl(0, 1.25, 0, 0.055, 0.065, 2.3, 6, C.white, { ao: 0.28, aoHeight: 1.6 });
    k.cyl(0, 2.30, 0, 0.075, 0.075, 0.34, 6, C.orange, { noAo: true });
    k.cyl(0, 2.52, 0, 0.05, 0.075, 0.14, 6, C.ink, { noAo: true });
    // The reflector, turned to face the road.
    k.box(0, 1.95, 0.06, 0.11, 0.20, 0.03, C.yellow, { noAo: true });
  }, 0.4);
}

/**
 * Sixteen metres of avalanche fence.
 *
 * Steel snow-bridge: raked posts anchored back into the slope, four horizontal
 * rails, cross-braced. Real ones are strung in stepped rows across an
 * avalanche's starting zone, which is what they are used for here — rows up the
 * open faces above the road, so the mountainside reads as *managed* rather than
 * as scenery, and so the eye has a horizontal to measure the gradient against.
 */
export function avalancheFenceGeo(): THREE.BufferGeometry {
  return buildProp('avalancheFence', (k) => {
    const L = 16, H = 3.4, bays = 6;
    for (let i = 0; i <= bays; i++) {
      const z = -L / 2 + (i * L) / bays;
      // Raked upright plus a back stay into the hill.
      k.strut(0, 0, z, -0.55, H, z, 0.075, C.galv, { ao: 0.45, aoHeight: 3 }, 4);
      k.strut(0, 0, z, 1.6, H * 0.42, z, 0.055, C.galv, { ao: 0.45, aoHeight: 3 }, 4);
      k.box(1.62, 0.14, z, 0.5, 0.28, 0.5, C.concreteDark, { ao: 0.5 });
    }
    for (let j = 0; j < 4; j++) {
      const f = 0.2 + j * 0.26;
      k.strut(-0.55 * f, H * f, -L / 2, -0.55 * f, H * f, L / 2, 0.055, C.steel,
        { ao: 0.35, aoHeight: 3 }, 4);
    }
    for (let i = 0; i < bays; i++) {
      const z0 = -L / 2 + (i * L) / bays, z1 = z0 + L / bays;
      const f = i % 2 ? 1 : -1;
      k.strut(f < 0 ? 0 : -0.55, f < 0 ? 0 : H, z0, f < 0 ? -0.55 : 0, f < 0 ? H : 0, z1,
        0.04, C.steel, { ao: 0.3, aoHeight: 3 }, 4);
    }
  }, 0.45);
}

/**
 * A wind-scoured snow drift.
 *
 * Long, low and asymmetric: a shallow windward ramp and a steep scoured lee
 * face, because a symmetrical white lump reads as a marshmallow. Laid along the
 * contour, so a hillside carrying a dozen of them has a direction the wind
 * came from.
 */
export function snowDriftGeo(seed: number, pal: LandPalette): THREE.BufferGeometry {
  const r = makeRng(0x33c1 + seed * 419);
  const snow = pal.cap ?? 0xeef4fa;
  return buildProp('snowDrift', (k) => {
    for (let i = 0; i < 5; i++) {
      const z = -7 + i * 3.5 + r.range(-0.8, 0.8);
      const w = r.range(4.2, 7.5);
      const h = r.range(0.5, 1.5);
      k.push();
      k.move(r.range(-1.2, 1.2), 0, z).rotY(r.range(-0.2, 0.2)).scale(1, h / w, 1);
      k.sph(0, 0, 0, w * 0.5, snow, 7, { noAo: true, shade: r.range(0.92, 1.04) });
      k.pop();
    }
    // The scoured lip, a shade colder so the drift has an edge in flat light.
    k.push();
    k.move(2.1, 0.15, 0).scale(1, 0.16, 1);
    k.sph(0, 0, 0, 2.6, 0xd2e0ee, 6, { noAo: true });
    k.pop();
  }, 0);
}

// ── quarry ─────────────────────────────────────────────────────────────────

/**
 * A quarry bench: three lifts of blasted rock with a haul road along the toe.
 *
 * The difference between a quarry and a hill is that a quarry is *cut in
 * steps*. Three hard horizontal lines stacked back into the slope do more to
 * say "this ground is being removed for a living" than any amount of machinery
 * standing on it — and unlike the machinery they survive to four hundred
 * metres, which is where most of this band is seen from.
 */
export function benchGeo(pal: LandPalette, seed = 0): THREE.BufferGeometry {
  const r = makeRng(0x6d21 + seed * 883);
  return buildProp('bench', (k) => {
    const L = 52;
    for (let i = 0; i < 3; i++) {
      const t = i / 2;
      // Each lift steps back and up: a face, then the flat it stands on.
      k.box(-i * 5.2, 2.1 + i * 4.2, 0, 13 - i * 3.4, 4.2, L - i * 7,
        i % 2 ? pal.rock : pal.rockDark, { noAo: true, shade: 0.84 + t * 0.2 });
      k.box(-i * 5.2 - 1.4, 4.2 + i * 4.2, 0, 10.2 - i * 3.4, 0.5, L - i * 7 - 1,
        pal.crest, { noAo: true, shade: 1.02 - t * 0.06 });
    }
    // Muck pile at the toe of the face, where the last shot dropped it.
    for (let i = 0; i < 16; i++) {
      const step = i % 3;
      k.push();
      k.move(-step * 5.2 + r.range(-2.4, 2.6), 0.6 + step * 4.2,
        r.range(-0.44, 0.44) * L).rotY(r.range(0, 6.28)).rotZ(r.range(-0.3, 0.3));
      k.box(0, 0, 0, r.range(1.2, 3.0), r.range(0.9, 2.0), r.range(1.1, 2.8),
        r.bool() ? pal.rockDark : pal.rock, { noAo: true, shade: r.range(0.7, 1.05) });
      k.pop();
    }
    // Haul road along the toe, and the windrow that keeps a truck on it.
    k.box(8.6, 0.14, 0, 8.4, 0.28, L + 5, pal.soil, { noAo: true, shade: 0.94 });
    k.box(12.4, 0.5, 0, 1.1, 1.0, L + 5, pal.soilDark, { noAo: true, shade: 0.88 });
  }, 0);
}

/** Blast rubble: what a shot leaves on the floor before the shovel gets to it. */
export function rubbleGeo(pal: LandPalette, seed = 0): THREE.BufferGeometry {
  const r = makeRng(0x2b70 + seed * 617);
  return buildProp('rubble', (k) => {
    for (let i = 0; i < 20; i++) {
      const a = r.range(0, 6.28);
      const rad = r.next() * r.next() * 5.4;
      const s = r.range(0.7, 2.4) * (1 - rad / 8);
      k.push();
      k.move(Math.cos(a) * rad, s * 0.4, Math.sin(a) * rad)
        .rotY(r.range(0, 6.28)).rotZ(r.range(-0.5, 0.5)).rotX(r.range(-0.4, 0.4));
      k.box(0, 0, 0, s * 1.4, s, s * 1.2,
        i % 3 === 0 ? pal.rockDark : pal.rock,
        { ao: 0.4, aoHeight: 2.4, shade: r.range(0.76, 1.06) });
      k.pop();
    }
  }, 0.4);
}

/**
 * The primary crusher and its stacker.
 *
 * The one building in a quarry, and it has to read as machinery rather than as
 * a shed: a fed hopper up on a steel frame, a chute down one side, and a raked
 * stacker conveyor throwing product onto a cone of its own. Eighteen metres
 * tall, which puts it above the barrier's sight line from anywhere on the lap.
 */
export function crusherGeo(pal: LandPalette): THREE.BufferGeometry {
  return buildProp('crusher', (k) => {
    // Frame.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      k.box(sx * 3.1, 0.3, sz * 3.1, 1.4, 0.6, 1.4, C.concreteDark, { ao: 0.6 });
      k.strut(sx * 3.1, 0.4, sz * 3.1, sx * 2.5, 9.4, sz * 2.5, 0.24, C.steelDark,
        { ao: 0.45, aoHeight: 6 });
    }
    for (const y of [3.0, 6.2]) {
      for (const sx of [-1, 1]) k.strut(sx * 2.9, y, -2.9, sx * 2.9, y, 2.9, 0.12, C.galv,
        { ao: 0.35, aoHeight: 8 });
      for (const sz of [-1, 1]) k.strut(-2.9, y, sz * 2.9, 2.9, y, sz * 2.9, 0.12, C.galv,
        { ao: 0.35, aoHeight: 8 });
    }
    // Jaw body and the flared feed hopper on top of it.
    k.box(0, 11.0, 0, 5.6, 3.6, 5.2, PLANT.steel, { ao: 0.3, aoHeight: 10 });
    k.box(0, 11.4, 0, 5.9, 1.1, 5.5, PLANT.body, { ao: 0.3, aoHeight: 10 });
    k.cyl(0, 14.6, 0, 4.6, 2.9, 3.6, 8, C.steel, { ao: 0.25, aoHeight: 12 });
    k.cyl(0, 16.6, 0, 4.9, 4.6, 0.4, 8, PLANT.bodyDark, { noAo: true });
    // Chute down the near side.
    k.push();
    k.move(3.4, 7.4, 0).rotZ(-0.5);
    k.box(0, 0, 0, 1.5, 5.2, 2.2, C.rust, { ao: 0.3, aoHeight: 8 });
    k.pop();
    // Stacker: a raked conveyor and the product cone under its head.
    k.push();
    k.move(-9.5, 3.6, 5.5).rotY(0.9).rotZ(-0.46);
    k.box(0, 0, 0, 1.5, 0.9, 21, C.steelDark, { ao: 0.3, aoHeight: 8 });
    k.box(0, 0.62, 0, 1.8, 0.28, 21.2, PLANT.body, { ao: 0.3, aoHeight: 8 });
    k.pop();
    k.cone(-16.5, 0, 10.5, 6.2, 6.8, 10, pal.crest, { ao: 0.4, aoHeight: 5 });
    k.strut(-9.5, 0, 5.5, -9.5, 3.4, 5.5, 0.3, C.galv, { ao: 0.5, aoHeight: 4 });
    // Ladders and a walkway, because scale needs something human-sized on it.
    for (let i = 0; i < 14; i++) {
      k.strut(3.0, 1.0 + i * 0.62, 3.2, 3.7, 1.0 + i * 0.62, 3.2, 0.045, C.galv,
        { ao: 0.3, aoHeight: 8 });
    }
    k.box(0, 9.6, 3.6, 6.6, 0.14, 1.2, C.galv, { ao: 0.3, aoHeight: 9 });
    k.box(0, 10.2, 4.15, 6.6, 1.0, 0.08, C.yellow, { ao: 0.3, aoHeight: 9 });
  }, 0.45);
}

/**
 * A rigid haul truck.
 *
 * Deliberately enormous next to the karts: a five-metre-tall dump body is the
 * scale reference that makes a quarry wall read as a hundred and forty metres
 * rather than as fourteen. Parked, always — nothing out here moves, and a
 * stationary machine the size of a house is a landmark.
 */
export function haulTruckGeo(): THREE.BufferGeometry {
  return buildProp('haulTruck', (k) => {
    // Wheels: four big ones, the rear pair doubled.
    const wheel = (x: number, z: number, r: number, w: number): void => {
      k.push();
      k.move(x, r, z).rotZ(Math.PI * 0.5);
      k.cyl(0, 0, 0, r, r, w, 10, C.ink, { ao: 0.55, aoHeight: 2.4 });
      k.cyl(0, w * 0.52, 0, r * 0.44, r * 0.44, 0.12, 8, PLANT.bodyDark, { noAo: true });
      k.pop();
    };
    for (const sx of [-1, 1]) {
      wheel(sx * 2.05, 2.6, 1.32, 1.0);
      wheel(sx * 2.28, -2.4, 1.32, 0.72);
      wheel(sx * 1.55, -2.4, 1.32, 0.72);
    }
    // Chassis and the dump body — a wedge, open at the back, canopy over the cab.
    k.box(0, 1.5, 0, 3.4, 0.9, 9.4, PLANT.steel, { ao: 0.55, aoHeight: 2.6 });
    k.push();
    k.move(0, 2.35, -0.4).rotX(-0.045);
    k.box(0, 1.5, 0, 5.2, 3.0, 8.0, PLANT.body, { ao: 0.4, aoHeight: 5 });
    k.box(0, 0.5, 0, 4.6, 1.2, 7.6, PLANT.bodyDark, { ao: 0.5, aoHeight: 4 });
    k.box(0, 3.4, 2.6, 5.4, 0.5, 3.4, PLANT.body, { ao: 0.3, aoHeight: 6 });
    k.pop();
    // Cab, tucked under the canopy on the left.
    k.box(-1.35, 3.5, 3.7, 1.9, 1.9, 2.1, PLANT.cab, { ao: 0.4, aoHeight: 5 });
    k.box(-1.35, 3.9, 4.78, 1.6, 1.0, 0.08, C.cyan, { ao: 0.3, aoHeight: 5 });
    k.box(0, 2.5, 4.9, 4.6, 1.3, 0.7, PLANT.bodyDark, { ao: 0.45, aoHeight: 4 });
    // Access stair up the front, and a beacon on the canopy.
    for (let i = 0; i < 6; i++) {
      k.box(-2.1, 1.0 + i * 0.44, 4.6 - i * 0.12, 0.9, 0.08, 0.34, C.galv,
        { ao: 0.4, aoHeight: 4 });
    }
  }, 0.5);
}

/**
 * A tracked blasthole drill.
 *
 * The best silhouette in a quarry: a squat tracked base with a twelve-metre
 * mast standing straight up off the back of it. Nothing else on any of these
 * courses has that outline, which is the whole reason it is here.
 */
export function drillRigGeo(): THREE.BufferGeometry {
  return buildProp('drillRig', (k) => {
    for (const sx of [-1, 1]) {
      k.box(sx * 1.4, 0.55, 0, 0.85, 1.1, 4.6, C.ink, { ao: 0.6, aoHeight: 1.8 });
      for (let i = 0; i < 7; i++) {
        k.push();
        k.move(sx * 1.4, 0.55, -2.0 + i * 0.66).rotZ(Math.PI * 0.5);
        k.cyl(0, 0, 0, 0.56, 0.56, 0.9, 8, C.steelDark, { ao: 0.55, aoHeight: 1.8 });
        k.pop();
      }
    }
    k.box(0, 1.5, -0.2, 3.4, 1.0, 4.2, PLANT.body, { ao: 0.5, aoHeight: 2.6 });
    k.box(0, 2.4, -1.5, 2.9, 1.4, 2.0, PLANT.bodyDark, { ao: 0.4, aoHeight: 3.4 });
    k.box(1.05, 2.85, 1.0, 1.5, 2.0, 1.6, PLANT.cab, { ao: 0.4, aoHeight: 3.6 });
    k.box(1.05, 3.1, 1.82, 1.2, 1.1, 0.07, C.cyan, { ao: 0.3, aoHeight: 4 });
    // The mast, and the rod string hanging in it.
    const H = 12.5;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      k.strut(-0.9 + sx * 0.44, 2.0, 2.0 + sz * 0.44, -0.9 + sx * 0.44, H, 2.0 + sz * 0.44,
        0.09, PLANT.bodyDark, { ao: 0.35, aoHeight: 6 }, 4);
    }
    for (let i = 1; i < 9; i++) {
      const y = 2.0 + (i * (H - 2.0)) / 9;
      k.strut(-1.34, y, 1.56, -0.46, y, 2.44, 0.05, C.galv, { ao: 0.3, aoHeight: 8 }, 4);
      k.strut(-0.46, y, 1.56, -1.34, y, 2.44, 0.05, C.galv, { ao: 0.3, aoHeight: 8 }, 4);
    }
    k.cyl(-0.9, 6.4, 2.0, 0.19, 0.19, 8.6, 6, C.steel, { ao: 0.3, aoHeight: 8 });
    k.box(-0.9, H + 0.3, 2.0, 1.6, 0.5, 1.6, PLANT.steel, { noAo: true });
    // Dust collector shroud at the collar — the bit that makes it a drill.
    k.cyl(-0.9, 1.2, 2.0, 1.1, 1.35, 1.6, 8, C.rust, { ao: 0.5, aoHeight: 2.4 });
  }, 0.5);
}

/**
 * A ground-level conveyor run on trestles.
 *
 * `props.ts` already has a conveyor *bridge* for the horizon. This is the other
 * kind: forty metres of belt two metres off the deck, walking across the middle
 * distance with a drive head at one end. Low enough that it never competes with
 * the skyline, long enough that it draws a line across the band.
 */
export function groundConveyorGeo(): THREE.BufferGeometry {
  return buildProp('groundConveyor', (k) => {
    const L = 40;
    k.box(0, 2.3, 0, 1.5, 0.7, L, C.steelDark, { ao: 0.35, aoHeight: 3 });
    k.box(0, 2.75, 0, 1.85, 0.22, L + 0.4, PLANT.body, { ao: 0.3, aoHeight: 3 });
    k.box(0, 1.95, 0, 1.6, 0.16, L, C.ink, { ao: 0.4, aoHeight: 3 });
    for (let i = 0; i <= 8; i++) {
      const z = -L / 2 + (i * L) / 8;
      for (const sx of [-1, 1]) {
        k.strut(sx * 1.5, 0, z, sx * 0.62, 2.1, z, 0.11, C.galv, { ao: 0.5, aoHeight: 2.6 });
      }
      k.strut(-1.5, 0.9, z, 1.5, 0.9, z, 0.07, C.galv, { ao: 0.5, aoHeight: 2.6 });
    }
    // Drive head and the spill under it.
    k.box(0, 3.0, L / 2 + 1.4, 2.6, 2.4, 2.8, PLANT.steel, { ao: 0.35, aoHeight: 4 });
    k.push();
    k.move(0, 1.9, L / 2 + 1.4).rotZ(Math.PI * 0.5);
    k.cyl(0, 0, 0, 0.75, 0.75, 2.0, 10, C.rust, { ao: 0.4, aoHeight: 3 });
    k.pop();
    k.box(0, 0.2, -L / 2 - 1.2, 2.4, 0.4, 2.4, C.concreteDark, { ao: 0.6 });
  }, 0.45);
}

/**
 * A veil of airborne dust.
 *
 * Five crossed cards on the drift material, all authored at the origin: the
 * vertex program walks each one downwind on its own phase and pinches it out at
 * both ends, so a working pit gets moving air for one draw call and no CPU.
 * Placed well out in the band — dust across the racing line would be a
 * readability problem, and dust hanging over the far benches is the point.
 */
export function dustVeilGeo(): THREE.BufferGeometry {
  return buildProp('dustVeil', (k) => {
    for (let i = 0; i < 5; i++) {
      const amp = 9 + (i % 3) * 4.5;
      const phase = i / 5;
      k.push();
      k.rotY((i * 1.31) % Math.PI);
      k.panel(0, 0, 0, 1, 0.42, 0xe9dcc0, { noAo: true, amp, phase });
      k.pop();
    }
  }, 0);
}

// ── saltpan ────────────────────────────────────────────────────────────────

/**
 * A harvested salt pile with the stacker that made it.
 *
 * Salt is worked in windrows and heaped in cones the colour of the ground it
 * came off, which sounds like a problem and is actually the opposite: a
 * *brilliant* white cone against a merely bright pan reads instantly, because
 * the pan is horizontal and the cone is not. Value does the separating, not
 * hue.
 */
export function saltHeapGeo(pal: LandPalette, seed = 0): THREE.BufferGeometry {
  const r = makeRng(0x8c40 + seed * 971);
  return buildProp('saltHeap', (k) => {
    k.cone(0, 0, 0, r.range(7.5, 9.5), r.range(8, 11), 12, pal.crest,
      { ao: 0.28, aoHeight: 8 });
    k.push();
    k.move(r.range(3, 6), 0, r.range(-5, -2)).rotY(r.range(0, 6.28));
    k.cone(0, 0, 0, r.range(4, 6), r.range(4.5, 7), 10, pal.soil,
      { ao: 0.28, aoHeight: 6 });
    k.pop();
    // The stacker.
    k.push();
    k.move(-8.5, 0, -9).rotY(0.7).rotZ(0.55);
    k.box(0, 7.5, 0, 1.3, 14.5, 1.7, C.steelDark, { ao: 0.3, aoHeight: 8 });
    k.box(0, 7.5, 0, 1.05, 14.7, 1.25, mute(C.cyan, 0.5, 0.6), { ao: 0.3, aoHeight: 8 });
    k.pop();
    k.strut(-12.5, 0, -13, -12.5, 5.0, -13, 0.28, C.galv, { ao: 0.5, aoHeight: 4 });
    // A scoop of it lying loose at the toe.
    for (let i = 0; i < 5; i++) {
      const a = r.range(0, 6.28), rad = r.range(9, 13);
      k.push();
      k.move(Math.cos(a) * rad, 0, Math.sin(a) * rad).scale(1, 0.3, 1);
      k.sph(0, 0, 0, r.range(1.4, 2.6), pal.crest, 6, { noAo: true });
      k.pop();
    }
  }, 0.3);
}

/**
 * An evaporation pond.
 *
 * Shallow brine inside a low salt bund, and the reason it earns its place is
 * that it is the only *cool* colour anywhere on a saltpan — a course otherwise
 * made entirely of white, black tarmac and blue sky. A scatter of them across
 * the middle distance turns a blank plain into a works.
 *
 * Flat and low: it lies on the crust rather than standing on it, so from the
 * road it reads as a stain rather than as an object, which is exactly right.
 */
export function brinePoolGeo(seed = 0): THREE.BufferGeometry {
  const r = makeRng(0x4e11 + seed * 557);
  const brine = 0x5f8f92;
  const brineDeep = 0x3f6b74;
  return buildProp('brinePool', (k) => {
    const R = r.range(11, 17);
    // Bund: a ring of low salt banks, drawn as overlapping flattened spheres so
    // the outline is irregular the way a hand-pushed bank is.
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      k.push();
      k.move(Math.cos(a) * R, 0, Math.sin(a) * R * 0.78).scale(1, 0.24, 1);
      k.sph(0, 0, 0, R * r.range(0.24, 0.34), 0xefece1, 6,
        { noAo: true, shade: r.range(0.94, 1.05) });
      k.pop();
    }
    // Water: two discs, the inner one deeper, sitting just off the crust.
    k.cyl(0, 0.10, 0, R * 0.92, R * 0.92, 0.06, 16, brine, { noAo: true });
    k.push();
    k.move(0, 0, 0).scale(1, 1, 0.78);
    k.cyl(0, 0.13, 0, R * 0.6, R * 0.6, 0.06, 14, brineDeep, { noAo: true });
    k.pop();
    // A rime of dry crust just inside the bund.
    k.cyl(0, 0.07, 0, R * 1.0, R * 1.0, 0.05, 16, 0xf6f3ea, { noAo: true });
  }, 0);
}

/**
 * A pressure ridge in the crust.
 *
 * Salt pans buckle: the crust grows, runs out of room and pushes up into low
 * ridges tens of metres long. Almost nothing, and that is the point — this is
 * the only relief a dry lake has, and without any of it the pan reads as a
 * painted plane rather than as a surface.
 */
export function saltRidgeGeo(seed = 0): THREE.BufferGeometry {
  const r = makeRng(0x7a53 + seed * 331);
  return buildProp('saltRidge', (k) => {
    const L = r.range(22, 40);
    for (let i = 0; i < 9; i++) {
      const z = -L / 2 + (i * L) / 8;
      const h = r.range(0.24, 0.62) * (1 - Math.abs(i / 8 - 0.5) * 1.1);
      k.push();
      k.move(r.range(-0.9, 0.9), 0, z).rotY(r.range(-0.15, 0.15)).scale(1, h / 2.4, 1);
      k.sph(0, 0, 0, r.range(1.6, 2.6), 0xf4f1e6, 6,
        { noAo: true, shade: r.range(0.93, 1.05) });
      k.pop();
    }
  }, 0);
}

/**
 * A survey peg.
 *
 * A dry lake has no landmarks, so a surveyor puts them in: a timber peg, a
 * length of pink flagging tape and a painted top. In a line running away across
 * the crust they are the only thing on the whole course that gives the middle
 * distance a scale, and they cost eight boxes each.
 */
export function surveyPegGeo(): THREE.BufferGeometry {
  return buildProp('surveyPeg', (k) => {
    k.box(0, 0.55, 0, 0.09, 1.1, 0.09, C.timber, { ao: 0.4, aoHeight: 1.0 });
    k.box(0, 1.14, 0, 0.11, 0.14, 0.11, C.magenta, { noAo: true });
    // The tape, tied off and hanging.
    k.push();
    k.move(0.05, 0.92, 0).rotZ(-0.5).rotY(0.4);
    k.panel(0.16, 0, 0, 0.34, 0.07, C.magenta, { noAo: true });
    k.pop();
    k.push();
    k.move(-0.05, 0.86, 0).rotZ(0.7).rotY(-0.9);
    k.panel(-0.14, 0, 0, 0.30, 0.06, C.magenta, { noAo: true });
    k.pop();
    // A ring of stones holding it, and its own contact patch.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      k.box(Math.cos(a) * 0.22, 0.05, Math.sin(a) * 0.22, 0.14, 0.1, 0.14,
        C.concreteDark, { ao: 0.4, aoHeight: 0.6 });
    }
  }, 0.4);
}

/** The mast a windsock hangs off: guyed, with a swivel head. */
export function windsockMastGeo(): THREE.BufferGeometry {
  return buildProp('windsockMast', (k) => {
    k.cyl(0, 0.12, 0, 0.4, 0.5, 0.24, 8, C.concreteDark, { ao: 0.6 });
    k.cyl(0, 3.4, 0, 0.075, 0.13, 6.5, 6, C.galv, { ao: 0.4, aoHeight: 4 });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      k.strut(0, 5.4, 0, Math.cos(a) * 2.4, 0.1, Math.sin(a) * 2.4, 0.022, C.steel,
        { ao: 0.4, aoHeight: 4 }, 3);
    }
    k.cyl(0, 6.75, 0, 0.14, 0.14, 0.2, 8, C.orange, { noAo: true });
    k.box(0, 6.75, 0.5, 0.06, 0.06, 1.0, C.steelDark, { noAo: true });
  }, 0.42);
}

/**
 * The sock itself, on the cloth material.
 *
 * Five tapering rings alternating orange and white, with `aAmp` ramping from
 * nothing at the throat to full at the tail, so the vertex program flies it
 * instead of wobbling it in the middle. Authored streaming along +Z from the
 * mast head.
 */
export function windsockGeo(): THREE.BufferGeometry {
  return buildProp('windsock', (k) => {
    for (let i = 0; i < 5; i++) {
      const f = i / 5;
      const r0 = 0.34 - f * 0.20;
      k.push();
      k.move(0, 0, 0.55 + i * 0.62).rotX(Math.PI * 0.5);
      k.cyl(0, 0, 0, r0 * 0.82, r0, 0.62, 8, i % 2 ? C.white : C.orange,
        { noAo: true, amp: 0.12 + f * 0.9, phase: 0.15 });
      k.pop();
    }
  }, 0);
}

/**
 * The mirage.
 *
 * Over hot salt the horizon detaches: a band of sky-coloured air sits on the
 * crust and ripples, and the far shore floats above it. That is one long, very
 * low, very transparent ribbon on the shimmer material, and it is the single
 * cheapest way to say *this ground is hot and flat and goes on for miles*.
 *
 * Held out past a hundred and fifty metres. Anything closer would put a moving
 * translucent band across the racing line, which is a readability problem
 * dressed up as atmosphere.
 */
export function shimmerGeo(): THREE.BufferGeometry {
  return buildProp('shimmer', (k) => {
    const L = 120;
    for (let i = 0; i < 3; i++) {
      k.push();
      k.move(i * 1.6 - 1.6, 0.30 + i * 0.34, 0).rotY(i * 0.05);
      k.panel(0, 0, 0, L, 0.9 + i * 0.5, 0xeaf3fb,
        { noAo: true, amp: 1 + i * 0.5, phase: i / 3 }, 24, 1);
      k.pop();
    }
  }, 0);
}

// ── shared, palette-driven ─────────────────────────────────────────────────

/**
 * A cap of whatever settles on top of things here.
 *
 * Snow on the mountain, salt rime on the pan, nothing in the desert or the
 * quarry. Applied to the top slabs of an outcrop and the crown of a heap, which
 * is where it would actually sit, and it is the difference between "a grey rock
 * on a grey mountain" and "a rock on a snowfield".
 */
export function capSlab(
  k: Kit, pal: LandPalette, x: number, y: number, z: number, w: number, d: number,
): void {
  if (pal.cap === null) return;
  k.box(x, y, z, w, 0.14, d, pal.cap, { noAo: true });
}

/** A hairline of the landscape's own vegetation, for a heap that has sat a while. */
export function tuftRing(k: Kit, pal: LandPalette, r: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.7;
    k.push();
    k.move(Math.cos(a) * r, 0, Math.sin(a) * r).scale(1, 0.5, 1);
    k.sph(0, 0.2, 0, 0.5, i % 2 ? pal.veg : pal.vegDark, 5, { ao: 0.4, aoHeight: 0.8 });
    k.pop();
  }
}
