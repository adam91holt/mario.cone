// Barriers.
//
// Physics stops a kart at `width/2 + verge - 0.8` from the centreline, so that
// is exactly where the barrier has to *look* like it is: a wall you bounce off
// somewhere other than where you can see it is the fastest way to make a racer
// feel broken. Everything here is anchored to that line.
//
// A barrier is not an extruded ribbon. It is a concrete footing, a run of
// hazard-striped panels, steel posts at a regular pitch and a capping rail —
// built, in other words, rather than swept. The posts and the corner marker
// boards are instanced, so the whole circuit's furniture is four draw calls.

import * as THREE from 'three';
import { MeshBuilder, surfacePoint, type Lane } from './geom.ts';
import { makeBarrierTexture, makeConcreteTexture, makeSignTexture } from './textures.ts';
import type { CornerSpan } from './road.ts';
import type { CourseDef, SplineSample } from '../types.ts';
import type { TrackSpline } from './spline.ts';

const _pos = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _scale = new THREE.Vector3();

/** Post pitch, metres. */
const POST_STEP = 9;
/** Marker-board pitch through a corner, metres. */
const SIGN_STEP = 22;

export function buildBarriers(
  spline: TrackSpline, course: CourseDef, corners: CornerSpan[], parent: THREE.Group,
): void {
  if (course.walls === false) return;

  const verge = course.vergeWidth ?? 5;
  const h = course.wallHeight ?? 1.5;
  const L = spline.length;

  // The line physics actually enforces.
  const edge = (s: SplineSample): number => s.width * 0.5 + verge;

  // ── concrete footing ────────────────────────────────────────────────────
  const base = new MeshBuilder();
  const panels = new MeshBuilder();

  for (const side of [-1, 1] as const) {
    const at = (off: number) => (s: SplineSample): number => side * (edge(s) + off);

    // Footing: a battered face on the road side, a flat top, a back face.
    const footing: Lane[] = [
      { lat: at(-0.10), lift: () => -0.35, u: 0 },
      { lat: at(0.06), lift: () => 0.34, u: 0.5 },
      { lat: at(0.62), lift: () => 0.40, u: 1 },
      { lat: at(0.72), lift: () => -0.40, u: 1.4 },
    ];
    if (side < 0) footing.reverse();
    base.addRibbon(spline, footing, { verge, step: 3, vScale: 5, closed: true });

    // Panel run: a board standing on the footing, plus its capping rail.
    const panel: Lane[] = [
      { lat: at(0.30), lift: () => 0.34, u: 0 },
      { lat: at(0.30), lift: () => 0.34 + h, u: 1 },
    ];
    if (side < 0) panel.reverse();
    panels.addRibbon(spline, panel, { verge, step: 3, vScale: 6, closed: true });

    const cap: Lane[] = [
      { lat: at(0.16), lift: () => 0.34 + h, u: 0 },
      { lat: at(0.46), lift: () => 0.34 + h + 0.1, u: 0.28 },
    ];
    if (side < 0) cap.reverse();
    panels.addRibbon(spline, cap, { verge, step: 3, vScale: 6, closed: true });
  }

  const baseMesh = new THREE.Mesh(base.toGeometry(), new THREE.MeshLambertMaterial({
    map: makeConcreteTexture(),
    side: THREE.DoubleSide,
  }));
  baseMesh.name = 'barrierBase';
  baseMesh.receiveShadow = true;
  baseMesh.castShadow = true;
  parent.add(baseMesh);

  const panelMesh = new THREE.Mesh(panels.toGeometry(), new THREE.MeshStandardMaterial({
    map: makeBarrierTexture(),
    roughness: 0.62,
    metalness: 0.1,
    side: THREE.DoubleSide,
  }));
  panelMesh.name = 'barrierPanels';
  panelMesh.receiveShadow = true;
  panelMesh.castShadow = true;
  parent.add(panelMesh);

  // ── posts ───────────────────────────────────────────────────────────────
  const postCount = Math.max(4, Math.floor(L / POST_STEP)) * 2;
  const postGeo = new THREE.BoxGeometry(0.20, 1, 0.20);
  postGeo.translate(0, 0.5, 0);
  const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({
    color: 0x8e99a8,
    roughness: 0.45,
    metalness: 0.35,
  }), postCount);
  posts.name = 'barrierPosts';
  posts.castShadow = true;
  posts.receiveShadow = true;

  const s: SplineSample = spline.atDistance(0);
  let n = 0;
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < postCount / 2; i++) {
      const d = (i / (postCount / 2)) * L;
      spline.atDistance(d, s);
      surfacePoint(s, side * (edge(s) + 0.42), verge, 0.3, _pos);
      _up.copy(s.up);
      _right.copy(s.right);
      _fwd.crossVectors(_right, _up).normalize();
      _m.makeBasis(_right, _up, _fwd);
      _m.setPosition(_pos);
      _scale.set(1, h + 0.2, 1);
      _m.scale(_scale);
      posts.setMatrixAt(n++, _m);
    }
  }
  posts.count = n;
  posts.instanceMatrix.needsUpdate = true;
  parent.add(posts);

  // ── corner marker boards ────────────────────────────────────────────────
  // On the *outside* of every corner, angled back toward the driver, which is
  // where a real circuit puts them and where peripheral vision finds them.
  const boards: number[] = [];
  for (const c of corners) {
    for (let d = c.from + 4; d < c.to - 4; d += SIGN_STEP) boards.push(d, -c.side);
  }
  const signCount = Math.max(1, boards.length / 2);
  const signGeo = new THREE.PlaneGeometry(2.4, 1.2);
  const signs = new THREE.InstancedMesh(signGeo, new THREE.MeshLambertMaterial({
    map: makeSignTexture(),
    side: THREE.DoubleSide,
  }), signCount);
  signs.name = 'cornerBoards';
  signs.castShadow = true;

  for (let i = 0; i < signCount; i++) {
    const d = boards[i * 2] ?? 0;
    const side = boards[i * 2 + 1] ?? 1;
    spline.atDistance(d, s);
    surfacePoint(s, side * (edge(s) + 0.30), verge, 0.34 + h + 0.72, _pos);
    _up.copy(s.up);
    _fwd.copy(s.tangent).multiplyScalar(-1);
    _right.crossVectors(_up, _fwd).normalize();
    // Angle the board in toward the racing line so it faces the approach.
    _fwd.addScaledVector(_right, -side * 0.45).normalize();
    _right.crossVectors(_up, _fwd).normalize();
    _m.makeBasis(_right, _up, _fwd);
    _m.setPosition(_pos);
    signs.setMatrixAt(i, _m);
  }
  signs.instanceMatrix.needsUpdate = true;
  if (boards.length) parent.add(signs);
}
