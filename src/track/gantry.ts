// The start/finish gantry.
//
// The line needs a landmark. A painted stripe on tarmac reads as nothing from a
// chase camera at 60 m/s, and "where is the line" is a question the player asks
// three times a race. So: two lattice towers standing outside the barriers, a
// truss over the road, a banner with the circuit's name and a light board.
//
// The whole thing is built in the track's local frame — x across the road, y up,
// z down the track — and then placed with a single basis matrix, so it sits
// square to the road however the road is banked or climbing. Every strut is one
// instance of the same unit box, which keeps the structure at two draw calls.

import * as THREE from 'three';
import { config } from '../core/config.ts';
import { makeBannerTexture, makeConcreteTexture, makeLightBoardTexture } from './textures.ts';
import { surfacePoint } from './geom.ts';
import type { CourseDef } from '../types.ts';
import type { TrackSpline } from './spline.ts';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Collects strut placements so they can all be one InstancedMesh. */
class Struts {
  readonly list: THREE.Matrix4[] = [];

  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number): void {
    _a.set(ax, ay, az);
    _b.set(bx, by, bz);
    _dir.subVectors(_b, _a);
    const len = _dir.length();
    if (len < 1e-4) return;
    _dir.divideScalar(len);
    _q.setFromUnitVectors(UP, _dir);
    _scl.set(t, len, t);
    const m = new THREE.Matrix4().compose(
      _a.addScaledVector(_dir, len * 0.5), _q, _scl,
    );
    this.list.push(m);
  }
}

export interface GantryResult {
  group: THREE.Group;
  /** Sways a little every frame; a dead-still banner reads as a photograph. */
  banner: THREE.Object3D;
  /** The five bulbs on the board. Driven by the countdown — see `GantryLights`. */
  lights: GantryLights;
}

/**
 * The start-light board hanging over the grid.
 *
 * It was a painted texture with five dead lenses, memoised in the texture
 * cache, so it *could not* change — while a second five-bulb board two hundred
 * pixels above it counted the race in correctly. The physical rig over the grid
 * is the one the player's eye goes to, and it was the one thing on the start
 * straight with a job it never did.
 *
 * The housing stays painted. The lamps are five emissive discs standing a
 * centimetre proud of it, hidden until the count arms and hidden again once the
 * flag has fallen, so they cost nothing for the rest of the race. The beat
 * table is `config.race.startLights`, which is also what `race/stage.ts` draws
 * its board from: two boards, one truth.
 */
export interface GantryLights {
  /** 3, 2, 1 — the beat currently showing. */
  beat(n: number): void;
  /** The flag. Every bulb goes green. */
  go(): void;
  /** Dark, and out of the draw. */
  clear(): void;
}

export function buildGantry(
  spline: TrackSpline, course: CourseDef, parent: THREE.Group, name: string,
): GantryResult {
  const verge = course.vergeWidth ?? 5;
  const d = course.startDistance ?? 0;
  const s = spline.atDistance(d);

  const group = new THREE.Group();
  group.name = 'gantry';
  // Place at the centre of the road on the line, aligned to the track frame.
  surfacePoint(s, 0, verge, 0, _a);
  const fwd = new THREE.Vector3().crossVectors(s.right, s.up).normalize();
  group.position.copy(_a);
  group.setRotationFromMatrix(new THREE.Matrix4().makeBasis(s.right, s.up, fwd));

  const span = s.width * 0.5 + verge + 2.4;
  const H = 9.2;         // underside of the truss
  const legR = 1.05;     // half-width of a tower
  const struts = new Struts();

  for (const side of [-1, 1]) {
    const cx = side * span;
    // Four legs, splayed slightly outward at the base so the tower reads as a
    // structure with a footprint rather than a post.
    for (const ox of [-legR, legR]) {
      for (const oz of [-legR, legR]) {
        struts.add(cx + ox * 1.35, -3, oz * 1.35, cx + ox, H + 1.4, oz, 0.24);
      }
    }
    // Rungs and braces.
    for (let y = 0.4; y < H + 1.2; y += 1.7) {
      const f = 1 + 0.35 * Math.max(0, 1 - y / H);
      struts.add(cx - legR * f, y, -legR * f, cx + legR * f, y, -legR * f, 0.14);
      struts.add(cx - legR * f, y, legR * f, cx + legR * f, y, legR * f, 0.14);
      struts.add(cx - legR * f, y, -legR * f, cx - legR * f, y, legR * f, 0.14);
      struts.add(cx + legR * f, y, -legR * f, cx + legR * f, y, legR * f, 0.14);
      // Diagonals, alternating direction up the tower.
      const flip = Math.round(y / 1.7) % 2 === 0 ? 1 : -1;
      struts.add(cx - legR * f, y, flip * legR * f, cx + legR * f, y + 1.7, flip * legR * f, 0.11);
      struts.add(cx + legR * f, y, -flip * legR * f, cx - legR * f, y + 1.7, -flip * legR * f, 0.11);
    }
  }

  // The truss over the road: two chords, verticals and a zigzag web.
  for (const oz of [-0.85, 0.85]) {
    struts.add(-span, H, oz, span, H, oz, 0.22);
    struts.add(-span, H + 1.4, oz, span, H + 1.4, oz, 0.22);
  }
  const bays = Math.max(6, Math.round((span * 2) / 3.4));
  for (let i = 0; i <= bays; i++) {
    const x = -span + (i / bays) * span * 2;
    struts.add(x, H, -0.85, x, H + 1.4, -0.85, 0.12);
    struts.add(x, H, 0.85, x, H + 1.4, 0.85, 0.12);
    if (i < bays) {
      const x2 = -span + ((i + 1) / bays) * span * 2;
      const up = i % 2 === 0;
      struts.add(x, up ? H : H + 1.4, -0.85, x2, up ? H + 1.4 : H, -0.85, 0.10);
      struts.add(x, up ? H : H + 1.4, 0.85, x2, up ? H + 1.4 : H, 0.85, 0.10);
    }
  }
  // Cross ties between the two chords.
  for (let i = 0; i <= bays; i += 2) {
    const x = -span + (i / bays) * span * 2;
    struts.add(x, H + 1.4, -0.85, x, H + 1.4, 0.85, 0.10);
  }

  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
    color: 0xf0d64a,
    roughness: 0.45,
    metalness: 0.35,
  }), struts.list.length);
  mesh.name = 'gantryFrame';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  for (let i = 0; i < struts.list.length; i++) mesh.setMatrixAt(i, struts.list[i]!);
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);

  // Concrete pads under each tower.
  const padGeo = new THREE.BoxGeometry(3.6, 0.5, 3.6);
  const padMat = new THREE.MeshStandardMaterial({ map: makeConcreteTexture(), roughness: 0.95 });
  for (const side of [-1, 1]) {
    const pad = new THREE.Mesh(padGeo, padMat);
    pad.position.set(side * span, -0.5, 0);
    pad.receiveShadow = true;
    pad.castShadow = true;
    group.add(pad);
  }

  // Banner hung under the truss.
  const banner = new THREE.Group();
  banner.position.set(0, H - 0.05, 0);
  const bannerMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(span * 2 - 1.2, 2.5),
    new THREE.MeshStandardMaterial({
      map: makeBannerTexture(name),
      roughness: 0.75,
      side: THREE.DoubleSide,
    }),
  );
  bannerMesh.position.y = -1.25;
  bannerMesh.castShadow = true;
  banner.add(bannerMesh);
  group.add(banner);

  // Start lights, hung in the middle where the grid can see them.
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(6.4, 1.6),
    new THREE.MeshStandardMaterial({
      map: makeLightBoardTexture(),
      roughness: 0.5,
      side: THREE.DoubleSide,
    }),
  );
  board.position.set(0, H - 3.4, 0.1);
  board.castShadow = true;
  group.add(board);
  const lights = buildLamps(board);
  for (const side of [-1, 1]) {
    const hang = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 2.1, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x30363f, roughness: 0.6 }),
    );
    hang.position.set(side * 2.6, H - 2.35, 0);
    group.add(hang);
  }

  parent.add(group);
  return { group, banner, lights };
}

/** Lamp colours. Unlit on purpose — a bulb is a light source, not a surface. */
const LAMP_RED = 0xFF2A16;
const LAMP_GREEN = 0x3CFF6B;

/** The five lenses, at the same pitch `makeLightBoardTexture` paints them. */
function buildLamps(board: THREE.Mesh): GantryLights {
  const geo = new THREE.CircleGeometry(0.44, 14);
  const red = new THREE.MeshBasicMaterial({ color: LAMP_RED, toneMapped: false });
  const green = new THREE.MeshBasicMaterial({ color: LAMP_GREEN, toneMapped: false });
  const bulbs: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(geo, red);
    // The board is 6.4 wide and the texture paints five lenses on its own
    // fifths, so the lamps land on the painted ones rather than beside them.
    m.position.set((i + 0.5) * (6.4 / 5) - 3.2, 0, 0.03);
    m.visible = false;
    m.frustumCulled = false;
    board.add(m);
    bulbs.push(m);
  }

  const set = (on: readonly number[], mat: THREE.Material): void => {
    for (let i = 0; i < bulbs.length; i++) {
      const b = bulbs[i]!;
      b.visible = on.includes(i);
      b.material = mat;
    }
  };

  return {
    beat(n: number): void { set(config.race.startLights[n] ?? [], red); },
    go(): void { set(ALL_BULBS, green); },
    clear(): void { set(NONE, red); },
  };
}

const ALL_BULBS = [0, 1, 2, 3, 4] as const;
const NONE: readonly number[] = [];
