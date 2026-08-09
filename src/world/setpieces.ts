// The things that are *doing* something as you go past.
//
// Scatter alone gets you a diorama. What makes a lap feel like a place is that
// the place has not stopped for you: a wrecking ball still swinging, a tipper
// still emptying, a works train still shunting on the siding beside the
// straight, hawks still turning over the canyon. None of it is interactive and
// none of it is anywhere a kart can reach — it exists so that the third lap
// does not look like the first, and so that a paused frame still has something
// moving in it a beat later.
//
// Each set piece is a small group with an `update(t)`. There are only a handful
// of them, so unlike everything else in this module they are ordinary meshes
// rather than instances; the moving parts are separate nodes with a transform
// written per frame, which costs nothing at this count.

import * as THREE from 'three';
import { buildProp } from './kit.ts';
import { C, type WorldMaterials } from './look.ts';
import { dumperChassis, dumperBed } from './props.ts';
import type { Ground, Spot } from './place.ts';
import type { TrackSplineLike } from '../types.ts';

export interface SetPiece {
  root: THREE.Object3D;
  update(t: number): void;
  dispose(): void;
}

const _spot: Spot = { ok: false, x: 0, y: 0, z: 0, face: 0, along: 0 };

function disposer(root: THREE.Object3D): () => void {
  return () => {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
  };
}

// ── the wrecking ball ──────────────────────────────────────────────────────

/**
 * A lattice crawler crane with a ball on the end of it.
 *
 * The whole point is the pendulum: a heavy object on a long cable moving slowly
 * is the most legible motion there is at a distance, and it is visible from
 * most of the far side of the circuit.
 */
export function createWreckingCrane(mats: WorldMaterials): SetPiece {
  const root = new THREE.Group();
  root.name = 'wreckingCrane';

  const BOOM = 24, ANG = 1.02; // radians from horizontal
  const tipY = 3.1 + Math.sin(ANG) * BOOM;
  const tipZ = 1.4 + Math.cos(ANG) * BOOM;

  const body = buildProp('crane', (k) => {
    // Crawler tracks.
    for (const sx of [-1, 1]) {
      k.box(sx * 1.9, 0.62, 0, 1.1, 1.24, 6.4, C.ink, { ao: 0.55, aoHeight: 2 });
      for (let i = 0; i < 7; i++) {
        k.push();
        k.move(sx * 1.9, 0.62, -2.7 + i * 0.9).rotZ(Math.PI * 0.5);
        k.cyl(0, 0, 0, 0.6, 0.6, 1.16, 8, C.steelDark, { ao: 0.5, aoHeight: 2 });
        k.pop();
      }
    }
    k.box(0, 1.42, 0, 4.6, 0.4, 5.6, C.ink, { ao: 0.45, aoHeight: 2.4 });
    k.cyl(0, 1.75, 0, 1.5, 1.5, 0.34, 12, C.steelDark, { ao: 0.4, aoHeight: 2.6 });
    // House and cab.
    k.box(-0.3, 2.9, -1.5, 3.4, 2.2, 4.4, C.orange, { ao: 0.35, aoHeight: 3.4 });
    k.box(0, 4.1, -1.5, 3.5, 0.2, 4.5, C.orangeDeep, { ao: 0.3, aoHeight: 3.6 });
    k.box(1.5, 3.2, 1.4, 1.5, 2.6, 1.9, C.orange, { ao: 0.35, aoHeight: 3.4 });
    k.box(1.5, 3.5, 2.38, 1.1, 1.6, 0.06, C.navy, { ao: 0.3, aoHeight: 3.6 });
    k.box(2.27, 3.5, 1.4, 0.06, 1.6, 1.3, C.navy, { ao: 0.3, aoHeight: 3.6 });
    k.box(-1.8, 2.6, -3.6, 2.2, 1.6, 1.2, C.steelDark, { ao: 0.4, aoHeight: 3 });
    // A-frame and the pendant ropes that hold the boom up.
    k.strut(-1.2, 4.1, -1.2, -0.5, 8.6, -2.2, 0.14, C.galv, { ao: 0.3, aoHeight: 4 });
    k.strut(1.2, 4.1, -1.2, 0.5, 8.6, -2.2, 0.14, C.galv, { ao: 0.3, aoHeight: 4 });
    k.strut(-0.5, 8.6, -2.2, 0.5, 8.6, -2.2, 0.12, C.galv, { noAo: true });
    k.strut(0, 8.6, -2.2, 0, tipY, tipZ, 0.05, C.steelDark, { noAo: true });

    // Lattice boom: three chords with a zigzag web.
    const R = 0.62;
    const bx = [-R, R, 0];
    const bz = [-R, -R, R * 1.1];
    const at = (i: number, f: number, out: [number, number, number]): void => {
      out[0] = bx[i]!;
      out[1] = 3.1 + Math.sin(ANG) * (BOOM * f) + Math.cos(ANG) * bz[i]!;
      out[2] = 1.4 + Math.cos(ANG) * (BOOM * f) - Math.sin(ANG) * bz[i]!;
    };
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      at(i, 0, a); at(i, 1, b);
      k.strut(a[0], a[1], a[2], b[0], b[1], b[2], 0.11, C.yellow, { ao: 0.25, aoHeight: 6 });
    }
    const BAYS = 13;
    for (let s = 0; s < BAYS; s++) {
      const f0 = s / BAYS, f1 = (s + 1) / BAYS;
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3;
        at(i, f0, a); at(j, f0, b);
        k.strut(a[0], a[1], a[2], b[0], b[1], b[2], 0.055, C.yellow, { ao: 0.2, aoHeight: 6 });
        at(i, f0, a); at(j, f1, b);
        k.strut(a[0], a[1], a[2], b[0], b[1], b[2], 0.045, C.yellow, { ao: 0.2, aoHeight: 6 });
      }
    }
    // Head sheaves.
    k.push();
    k.move(0, tipY, tipZ).rotZ(Math.PI * 0.5);
    k.cyl(0, 0, 0, 0.55, 0.55, 0.3, 10, C.steelDark, { noAo: true });
    k.pop();
  }, 0.45);

  const mesh = new THREE.Mesh(body, mats.prop);
  mesh.castShadow = true;
  root.add(mesh);

  // The pendulum: everything below the head sheave hangs off one node.
  const pivot = new THREE.Group();
  pivot.position.set(0, tipY, tipZ);
  root.add(pivot);

  const CABLE = 13.5;
  const ball = buildProp('ball', (k) => {
    k.cyl(0, -CABLE * 0.5, 0, 0.07, 0.07, CABLE, 6, C.ink, { noAo: true });
    k.cyl(0, -CABLE - 0.3, 0, 0.28, 0.28, 0.6, 8, C.steelDark, { noAo: true });
    k.sph(0, -CABLE - 2.0, 0, 1.55, 0x4b4f57, 12, { noAo: true });
    k.sph(0.9, -CABLE - 1.4, 0.6, 0.5, 0x5c616b, 8, { noAo: true });
  }, 0);
  const ballMesh = new THREE.Mesh(ball, mats.metal);
  ballMesh.castShadow = true;
  pivot.add(ballMesh);

  return {
    root,
    update(t: number): void {
      // Two periods beating against each other, so it never looks like a metronome.
      pivot.rotation.x = Math.sin(t * 0.62) * 0.44;
      pivot.rotation.z = Math.sin(t * 0.41 + 1.2) * 0.16;
    },
    dispose: disposer(root),
  };
}

// ── the tipping load ───────────────────────────────────────────────────────

/**
 * A dumper that raises its bed, sheds a load of spoil and drops back down, on a
 * loop. The single most obviously *alive* thing beside the road, because it has
 * a beginning, a middle and an end rather than a cycle.
 */
export function createTipper(mats: WorldMaterials): SetPiece {
  const root = new THREE.Group();
  root.name = 'tipper';

  const chassis = new THREE.Mesh(buildProp('tipperChassis', (k) => {
    dumperChassis(k);
  }, 0.45), mats.prop);
  chassis.castShadow = true;
  root.add(chassis);

  const bed = new THREE.Group();
  bed.position.set(0, 1.5, -1.9);
  root.add(bed);
  const bedMesh = new THREE.Mesh(buildProp('tipperBed', (k) => { dumperBed(k); }, 0), mats.prop);
  bedMesh.castShadow = true;
  bed.add(bedMesh);

  const load = new THREE.Group();
  bed.add(load);
  const loadMesh = new THREE.Mesh(buildProp('tipperLoad', (k) => {
    for (let i = 0; i < 11; i++) {
      const a = i * 2.399;
      k.push();
      k.move(Math.sin(a) * 0.62, 0.34 + Math.cos(a * 2.7) * 0.12, 1.8 + Math.cos(a) * 1.4)
        .rotY(a).scale(1, 0.62, 1);
      k.sph(0, 0, 0, 0.66, i % 2 ? C.dirt : C.dirtDark, 6, { noAo: true });
      k.pop();
    }
  }, 0), mats.prop);
  load.add(loadMesh);

  const pile = new THREE.Group();
  pile.position.set(0, 0, -4.6);
  root.add(pile);
  const pileMesh = new THREE.Mesh(buildProp('tipperPile', (k) => {
    k.cone(0, 0, 0, 2.7, 1.9, 10, C.dirt, { ao: 0.4, aoHeight: 2 });
    k.push(); k.move(1.5, 0, 0.8).rotY(0.7);
    k.cone(0, 0, 0, 1.6, 1.1, 8, C.dirtDark, { ao: 0.4, aoHeight: 2 });
    k.pop();
  }, 0.4), mats.prop);
  pileMesh.castShadow = true;
  pile.add(pileMesh);

  const PERIOD = 13;
  return {
    root,
    update(t: number): void {
      const f = ((t % PERIOD) + PERIOD) % PERIOD / PERIOD;
      // Up over the first fifth, held, down again by two thirds, then it waits.
      const up = f < 0.2 ? f / 0.2 : f < 0.45 ? 1 : f < 0.66 ? 1 - (f - 0.45) / 0.21 : 0;
      const eased = up * up * (3 - 2 * up);
      bed.rotation.x = -eased * 0.95;
      // The load slides out as the bed passes the angle of repose, then the
      // pile it made settles back down while the truck sits idle.
      const shed = Math.min(1, Math.max(0, (eased - 0.55) / 0.4));
      load.position.z = -shed * 3.4;
      load.scale.setScalar(Math.max(0.001, 1 - shed));
      load.visible = shed < 0.99;
      const grow = 0.84 + 0.16 * eased;
      pile.scale.set(grow, grow * 0.94 + 0.06, grow);
    },
    dispose: disposer(root),
  };
}

// ── the works railway ──────────────────────────────────────────────────────

export interface RailwayOptions {
  /** Lap distances the siding runs between. */
  from: number;
  to: number;
  side: -1 | 1;
  /** Metres beyond the shoulder. */
  off: number;
  /** Where the service road crosses, as a lap distance. */
  crossingAt: number;
}

/**
 * A narrow-gauge works railway on the outside of the fastest straight, with a
 * shunting loco and a level crossing that closes for it.
 *
 * The track is laid *along the spline* at a fixed offset rather than as a
 * straight line, which is what guarantees it can never wander toward the
 * circuit however the course is re-cut.
 */
export function createRailway(
  mats: WorldMaterials, ground: Ground, spline: TrackSplineLike, o: RailwayOptions,
): SetPiece {
  const root = new THREE.Group();
  root.name = 'railway';

  const L = spline.length;
  const span = o.to - o.from;
  const GAUGE = 1.5;

  // ── permanent way ────────────────────────────────────────────────────────
  const perm = buildProp('railway', (k) => {
    const steps = Math.max(8, Math.round(span / 2.4));
    let prev: Spot | null = null;
    for (let i = 0; i <= steps; i++) {
      const d = o.from + (span * i) / steps;
      const s = ground.spot(d, o.side, o.off, { ...( _spot) });
      if (!s.ok) { prev = null; continue; }
      if (prev) {
        // Two rails and the ballast under them, one segment at a time.
        for (const g of [-GAUGE * 0.5, GAUGE * 0.5]) {
          const ax = prev.x + Math.cos(prev.along) * g;
          const az = prev.z - Math.sin(prev.along) * g;
          const bx = s.x + Math.cos(s.along) * g;
          const bz = s.z - Math.sin(s.along) * g;
          k.strut(ax, prev.y + 0.36, az, bx, s.y + 0.36, bz, 0.075, C.rust,
            { noAo: true, shade: 0.9 });
        }
        k.push();
        k.move((prev.x + s.x) * 0.5, (prev.y + s.y) * 0.5 + 0.14, (prev.z + s.z) * 0.5)
          .rotY(s.along);
        k.box(0, 0, 0, 3.2, 0.28, 2.5, C.concreteDark, { noAo: true, shade: 0.92 });
        k.pop();
      }
      // Sleepers.
      k.push();
      k.move(s.x, s.y + 0.3, s.z).rotY(s.along);
      k.box(0, 0, 0, 2.5, 0.16, 0.34, C.timberDark, { noAo: true });
      k.pop();
      prev = { ...s };
    }
  }, 0);
  const permMesh = new THREE.Mesh(perm, mats.prop);
  permMesh.receiveShadow = false;
  root.add(permMesh);

  // ── the crossing ─────────────────────────────────────────────────────────
  const cross = ground.spot(o.crossingAt, o.side, o.off, { ..._spot });
  const crossGroup = new THREE.Group();
  crossGroup.position.set(cross.x, cross.y, cross.z);
  crossGroup.rotation.y = cross.along;
  root.add(crossGroup);

  const deck = new THREE.Mesh(buildProp('crossingDeck', (k) => {
    k.box(0, 0.22, 0, 9, 0.44, 5.2, C.concreteDark, { ao: 0.35, aoHeight: 1.4 });
    k.box(0, 0.46, 0, 9, 0.08, 3.2, C.asphalt, { ao: 0.2, aoHeight: 1.4 });
    for (const sz of [-1, 1]) {
      k.post(-4.2, 0.44, sz * 2.9, 0.3, 3.2, 0.3, C.white, { ao: 0.3, aoHeight: 3 });
      k.post(4.2, 0.44, sz * 2.9, 0.3, 3.2, 0.3, C.white, { ao: 0.3, aoHeight: 3 });
    }
    // Saltire boards.
    for (const sx of [-1, 1]) {
      for (const rot of [0.78, -0.78]) {
        k.push();
        k.move(sx * 4.2, 3.4, 2.9).rotZ(rot);
        k.box(0, 0, 0.16, 1.9, 0.3, 0.07, C.white, { noAo: true });
        k.pop();
      }
    }
  }, 0.4), mats.prop);
  deck.castShadow = true;
  crossGroup.add(deck);

  // Lamps — two per side, alternating while the gates are down.
  const lampGeo = buildProp('crossLamp', (k) => {
    k.cyl(0, 0, 0, 0.22, 0.22, 0.12, 8, C.red, { noAo: true });
  }, 0);
  const lamps: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    for (const ox of [-0.42, 0.42]) {
      const m = new THREE.Mesh(lampGeo, mats.glowRed);
      m.position.set(sx * 4.2 + ox, 2.85, 3.05);
      m.rotation.x = Math.PI * 0.5;
      crossGroup.add(m);
      lamps.push(m);
    }
  }

  // Booms.
  const boomGeo = buildProp('boom', (k) => {
    k.box(2.6, 0, 0, 5.4, 0.22, 0.16, C.white, { noAo: true });
    for (let i = 0; i < 5; i++) {
      k.box(0.55 + i * 1.1, 0, 0.09, 0.55, 0.24, 0.04, i % 2 ? C.red : C.white,
        { noAo: true });
    }
    k.box(0.1, -0.32, 0, 0.5, 0.5, 0.24, C.white, { noAo: true });
  }, 0);
  const booms: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const g = new THREE.Group();
    g.position.set(sx * 4.2, 2.2, 2.9);
    g.rotation.y = sx > 0 ? Math.PI : 0;
    crossGroup.add(g);
    const m = new THREE.Mesh(boomGeo, mats.prop);
    m.castShadow = true;
    g.add(m);
    booms.push(g);
  }

  // ── the train ────────────────────────────────────────────────────────────
  const locoGeo = buildProp('worksLoco', (k) => {
    k.box(0, 0.62, 0, 2.3, 0.5, 6.4, C.ink, { ao: 0.5, aoHeight: 1.8 });
    for (const sz of [-2.1, 2.1]) for (const sx of [-1, 1]) {
      k.push();
      k.move(sx * 1.0, 0.44, sz).rotZ(Math.PI * 0.5);
      k.cyl(0, 0, 0, 0.44, 0.44, 0.22, 10, C.steelDark, { ao: 0.5, aoHeight: 1.6 });
      k.pop();
    }
    k.box(0, 1.4, -1.1, 2.2, 1.1, 4.0, C.yellow, { ao: 0.4, aoHeight: 2.4 });
    k.box(0, 2.35, 1.0, 2.0, 1.9, 2.2, C.yellow, { ao: 0.35, aoHeight: 3 });
    k.box(0, 2.5, 2.12, 1.5, 1.1, 0.06, C.navy, { ao: 0.3, aoHeight: 3 });
    k.box(1.02, 2.5, 1.0, 0.06, 1.1, 1.6, C.navy, { ao: 0.3, aoHeight: 3 });
    k.box(0, 3.35, 1.0, 2.1, 0.16, 2.3, C.orange, { noAo: true });
    k.box(0, 2.05, -2.6, 2.24, 0.18, 0.6, C.orange, { ao: 0.35, aoHeight: 2.6 });
    k.cyl(0, 2.3, -2.4, 0.24, 0.3, 1.1, 8, C.ink, { ao: 0.3, aoHeight: 3 });
  }, 0.45);
  const wagonGeo = buildProp('worksWagon', (k) => {
    k.box(0, 0.62, 0, 2.2, 0.5, 5.4, C.ink, { ao: 0.5, aoHeight: 1.8 });
    for (const sz of [-1.8, 1.8]) for (const sx of [-1, 1]) {
      k.push();
      k.move(sx * 0.95, 0.44, sz).rotZ(Math.PI * 0.5);
      k.cyl(0, 0, 0, 0.44, 0.44, 0.22, 10, C.steelDark, { ao: 0.5, aoHeight: 1.6 });
      k.pop();
    }
    k.box(0, 1.05, 0, 2.3, 0.36, 5.2, C.rust, { ao: 0.45, aoHeight: 2 });
    for (const sx of [-1, 1]) k.box(sx * 1.1, 1.55, 0, 0.16, 1.0, 5.2, C.rust, { ao: 0.4, aoHeight: 2.4 });
    for (const sz of [-1, 1]) k.box(0, 1.55, sz * 2.6, 2.3, 1.0, 0.16, C.rust, { ao: 0.4, aoHeight: 2.4 });
    for (let i = 0; i < 6; i++) {
      const a = i * 2.399;
      k.push();
      k.move(Math.sin(a) * 0.5, 1.5, Math.cos(a) * 1.7).scale(1, 0.6, 1);
      k.sph(0, 0, 0, 0.7, i % 2 ? C.dirt : C.dirtDark, 6, { ao: 0.3, aoHeight: 2.4 });
      k.pop();
    }
  }, 0.45);

  const cars: THREE.Mesh[] = [
    new THREE.Mesh(locoGeo, mats.prop),
    new THREE.Mesh(wagonGeo, mats.prop),
    new THREE.Mesh(wagonGeo, mats.prop),
  ];
  for (const c of cars) { c.castShadow = true; root.add(c); }

  const chimney = new THREE.Mesh(buildProp('trainSteam', (k) => {
    for (let i = 0; i < 6; i++) {
      k.sph(0, 0, 0, 0.62, 0xeef4f8, 6, { noAo: true, amp: 0.5 + (i % 3) * 0.14, phase: i / 6 });
    }
  }, 0), mats.puff);
  root.add(chimney);

  const RUN = span - 26;
  const start = o.from + 13;
  const PERIOD = 46;
  const boomTarget = [0, 0];
  const boomNow = [0, 0];
  let flash = 0;

  return {
    root,
    update(t: number): void {
      // A smooth shuttle: the loco eases to a stand at each end of the siding
      // and waits there for a beat before setting back.
      const u = 0.5 - 0.5 * Math.cos((t / PERIOD) * Math.PI * 2);
      const dLead = start + u * RUN;
      for (let i = 0; i < cars.length; i++) {
        const d = dLead - i * 7.4;
        const s = ground.spot(((d % L) + L) % L, o.side, o.off, _spot);
        if (!s.ok) { cars[i]!.visible = false; continue; }
        cars[i]!.visible = true;
        cars[i]!.position.set(s.x, s.y + 0.34, s.z);
        cars[i]!.rotation.y = s.along;
      }
      chimney.visible = cars[0]!.visible;
      chimney.position.copy(cars[0]!.position);
      chimney.position.y += 3.4;

      // The crossing closes when the consist is anywhere near it.
      const near = Math.abs(dLead - o.crossingAt) < 46 || Math.abs(dLead - 16 - o.crossingAt) < 46;
      boomTarget[0] = near ? 0 : Math.PI * 0.5;
      boomTarget[1] = boomTarget[0]!;
      for (let i = 0; i < 2; i++) {
        boomNow[i] = boomNow[i]! + (boomTarget[i]! - boomNow[i]!) * 0.035;
        booms[i]!.rotation.z = boomNow[i]!;
      }
      flash = near ? (t * 1.6) % 1 : -1;
      for (let i = 0; i < lamps.length; i++) {
        lamps[i]!.visible = flash >= 0 && (i % 2 === 0 ? flash < 0.5 : flash >= 0.5);
      }
    },
    dispose: disposer(root),
  };
}

// ── the footbridge ─────────────────────────────────────────────────────────

/**
 * A scaffolding footbridge over the road, with people on it.
 *
 * Everything else in this module is beside the circuit, which means the top
 * third of the frame down a straight is sky and nothing else. A bridge puts the
 * crowd *over* the road: you drive under it, and for a beat the whole screen is
 * somebody watching you.
 *
 * Built in the track's own frame — x across, y up, z along — and placed with a
 * single basis matrix, so it sits square to the road however the road is banked
 * or climbing. The deck clears ten metres, well above anything a kart can reach
 * on a course with no ramps.
 */
/**
 * `crowdGeo` is nullable because a course can decline the crowd set outright
 * (`theme.props.crowds`). Handing this an empty geometry instead would put a
 * NaN bounding sphere on the console, which the review harness counts as an
 * error — so "no spectators" is expressed as no mesh at all.
 */
export function createBridge(
  mats: WorldMaterials, spline: TrackSplineLike, verge: number,
  d: number, crowdGeo: THREE.BufferGeometry | null, name: string,
): SetPiece {
  const root = new THREE.Group();
  root.name = 'footbridge';

  const s = spline.atDistance(d);
  const span = s.width * 0.5 + verge + 3.4;
  const H = 10.2;

  const fwd = new THREE.Vector3().crossVectors(s.right, s.up).normalize();
  root.position.copy(s.pos);
  root.setRotationFromMatrix(new THREE.Matrix4().makeBasis(s.right, s.up, fwd));

  const geo = buildProp(name, (k) => {
    for (const side of [-1, 1]) {
      const cx = side * span;
      for (const ox of [-1.1, 1.1]) {
        for (const oz of [-1.1, 1.1]) {
          // Legs run well below the road: the ground behind the barrier has
          // already fallen away by a metre or two and they have to reach it.
          k.strut(cx + ox * 1.25, -4, oz * 1.25, cx + ox, H + 1.6, oz, 0.16, C.galv,
            { noAo: true });
        }
      }
      for (let y = -1; y < H + 1.4; y += 1.6) {
        for (const oz of [-1.1, 1.1]) {
          k.strut(cx - 1.1, y, oz, cx + 1.1, y, oz, 0.08, C.galv, { noAo: true });
        }
        for (const ox of [-1.1, 1.1]) {
          k.strut(cx + ox, y, -1.1, cx + ox, y, 1.1, 0.08, C.galv, { noAo: true });
        }
        const flip = Math.round(y / 1.6) % 2 === 0 ? 1 : -1;
        k.strut(cx - 1.1, y, flip * 1.1, cx + 1.1, y + 1.6, flip * 1.1, 0.06, C.galv,
          { noAo: true });
      }
      // Stair flight down the outside, so the deck is reachable by something.
      for (let i = 0; i < 9; i++) {
        k.box(cx + side * (1.6 + i * 0.42), 1.2 + i * 1.0, 0, 0.9, 0.1, 1.8, C.timber,
          { noAo: true });
      }
    }
    // Deck.
    for (let i = 0; i < 7; i++) {
      k.box(0, H, -1.35 + i * 0.45, span * 2, 0.14, 0.44, C.timber, { noAo: true });
    }
    k.box(0, H - 0.22, 0, span * 2 + 0.4, 0.3, 3.4, C.steelDark, { noAo: true });
    // Handrails and a solid kick board, which is what stops the deck reading as
    // a plank with people balanced on it.
    for (const oz of [-1.55, 1.55]) {
      k.box(0, H + 0.55, oz, span * 2, 0.9, 0.08, oz < 0 ? C.orange : C.navy, { noAo: true });
      k.strut(-span, H + 1.5, oz, span, H + 1.5, oz, 0.07, C.galv, { noAo: true });
      for (let i = 0; i <= 14; i++) {
        const x = -span + (i / 14) * span * 2;
        k.strut(x, H + 0.1, oz, x, H + 1.5, oz, 0.05, C.galv, { noAo: true });
      }
    }
    // A banner slung under the deck, facing the oncoming traffic.
    k.box(0, H - 1.5, 1.6, span * 1.5, 1.7, 0.1, C.navy, { noAo: true });
    k.box(0, H - 1.5, 1.66, span * 1.35, 0.5, 0.04, C.orange, { noAo: true });
    for (let i = 0; i < 5; i++) {
      k.push();
      k.move(-span * 0.6 + i * span * 0.3, H - 2.1, 1.67).rotZ(Math.PI * 0.25);
      k.box(0, 0, 0, 0.5, 0.18, 0.03, C.yellow, { noAo: true });
      k.pop();
    }
  }, 0);

  const mesh = new THREE.Mesh(geo, mats.prop);
  mesh.castShadow = true;
  root.add(mesh);

  if (crowdGeo) {
    const crowd = new THREE.Mesh(crowdGeo, mats.crowd);
    crowd.position.set(0, H + 0.07, 0.4);
    crowd.rotation.y = Math.PI;
    root.add(crowd);
  }

  return { root, update(): void {}, dispose: disposer(root) };
}

// ── birds ──────────────────────────────────────────────────────────────────

/**
 * A few hawks turning over the canyon.
 *
 * Almost free — one instanced mesh, a handful of matrices a frame — and it is
 * the only thing in the game that moves in the top third of the screen.
 */
export function createBirds(
  mats: WorldMaterials, geo: THREE.BufferGeometry,
  centre: THREE.Vector3, radius: number, count = 7,
): SetPiece {
  const root = new THREE.Group();
  root.name = 'birds';
  const mesh = new THREE.InstancedMesh(geo, mats.crowd, count);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  root.add(mesh);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(2.4, 2.4, 2.4);

  return {
    root,
    update(t: number): void {
      for (let i = 0; i < count; i++) {
        const rate = 0.055 + (i % 3) * 0.012;
        const a = t * rate + i * 1.37;
        const r = radius * (0.55 + 0.45 * ((i * 0.37) % 1));
        p.set(
          centre.x + Math.cos(a) * r,
          centre.y + Math.sin(t * 0.19 + i) * 9 + (i % 4) * 7,
          centre.z + Math.sin(a) * r * 0.8,
        );
        // Face along the tangent of the circle and bank into it.
        e.set(0, -a + Math.PI * 0.5, 0.26);
        q.setFromEuler(e);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose: disposer(root),
  };
}
