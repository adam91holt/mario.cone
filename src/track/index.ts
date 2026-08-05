// Track system: turns a course definition into geometry, surfaces and checkpoints.

import * as THREE from 'three';
import { TrackSpline } from './spline.ts';
import { makeRoadTexture, makeRumbleTexture } from './textures.ts';
import { getCourse } from './courses/index.ts';
import type {
  CourseDef, GameContext, GameSystem, GridSlot, SplineSample, Surface, Track,
} from '../types.ts';

const _s: SplineSample = {
  pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
  right: new THREE.Vector3(), up: new THREE.Vector3(),
  width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
};

export interface TrackSystem extends GameSystem {
  build(course: CourseDef | string): Track;
  readonly track: Track | null;
}

export function createTrackSystem(ctx: GameContext): TrackSystem {
  let group: THREE.Group | null = null;
  let track: Track | null = null;

  function disposeGroup(g: THREE.Object3D): void {
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      if (mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) m.dispose();
      }
    });
  }

  function build(courseOrId: CourseDef | string): Track {
    const course = typeof courseOrId === 'string' ? getCourse(courseOrId) : courseOrId;

    if (group) {
      disposeGroup(group);
      ctx.scene.remove(group);
    }
    group = new THREE.Group();
    group.name = 'track';

    const spline = new TrackSpline(course.points, {
      closed: true,
      defaultWidth: course.width ?? 24,
    });

    buildRoad(spline, course, group);
    buildVerges(spline, course, group);
    buildWalls(spline, course, group);
    buildGround(course, group);

    const checkpoints = buildCheckpoints(spline, course);
    const vergeWidth = course.vergeWidth ?? 5;

    track = {
      id: course.id,
      name: course.name,
      course,
      spline,
      group,
      length: spline.length,
      laps: course.laps ?? ctx.config.race.laps,
      checkpoints,
      theme: course.theme ?? {},

      /** Surface + position query used by kart physics every step. */
      sample(worldPos: THREE.Vector3, out?: SplineSample): SplineSample {
        const s = spline.nearest(worldPos, out);
        const half = s.width * 0.5;
        const a = Math.abs(s.lateral ?? 0);
        let surface: Surface;
        if (a <= half) surface = 'road';
        else if (a <= half + vergeWidth) surface = course.vergeSurface ?? 'dirt';
        else surface = course.offSurface ?? 'grass';
        s.surface = surface;
        return s;
      },

      /** Start-grid slots: two staggered columns behind the line. */
      gridSlot(i: number, _total: number): GridSlot {
        const col = i % 2 === 0 ? -1 : 1;
        const row = Math.floor(i / 2);
        const back = 12 + row * 8;
        const startD = (course.startDistance ?? 0) - back;
        const lateral = col * (course.width ?? 24) * 0.19;
        const s = spline.atDistance(startD, undefined);
        const pos = spline.pointAt(startD, lateral, 0.6);
        return { pos, forward: s.tangent.clone(), up: s.up.clone(), distance: startD };
      },
    };

    ctx.scene.add(group);
    ctx.track = track;
    ctx.bus.emit('track:built', { track });
    return track;
  }

  // ── geometry ─────────────────────────────────────────────────────────────

  function buildRoad(spline: TrackSpline, course: CourseDef, parent: THREE.Group): void {
    const N = Math.max(64, Math.round(spline.length / 2.2));
    const cols = 8; // lateral subdivisions, so banking and crown read smoothly
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];

    for (let i = 0; i <= N; i++) {
      const d = (i / N) * spline.length;
      spline.atDistance(d, _s);
      for (let j = 0; j <= cols; j++) {
        const f = j / cols;
        const lat = (f - 0.5) * _s.width;
        // Slight camber so the road is not a dead-flat plane under the key light.
        const crown = Math.cos((f - 0.5) * Math.PI) * 0.16;
        positions.push(
          _s.pos.x + _s.right.x * lat + _s.up.x * crown,
          _s.pos.y + _s.right.y * lat + _s.up.y * crown,
          _s.pos.z + _s.right.z * lat + _s.up.z * crown);
        normals.push(_s.up.x, _s.up.y, _s.up.z);
        uvs.push(f, d / 12);
      }
    }
    // Winding matters: `right` is tangent x up, so stepping +j then +i winds
    // clockwise seen from above and the surface faces *down*. Ordering the
    // triangles this way puts the face up, where the players are.
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < cols; j++) {
        const a = i * (cols + 1) + j;
        const b = a + cols + 1;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      map: makeRoadTexture(course.theme?.road ?? {}),
      roughness: 0.86,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'road';
    mesh.receiveShadow = true;
    parent.add(mesh);
  }

  function buildVerges(spline: TrackSpline, course: CourseDef, parent: THREE.Group): void {
    const vergeW = course.vergeWidth ?? 5;
    const N = Math.max(64, Math.round(spline.length / 2.2));
    const tex = makeRumbleTexture();

    for (const side of [-1, 1]) {
      const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
      for (let i = 0; i <= N; i++) {
        const d = (i / N) * spline.length;
        spline.atDistance(d, _s);
        const inner = side * _s.width * 0.5;
        const outer = side * (_s.width * 0.5 + vergeW);
        for (const [lat, u] of [[inner, 0], [outer, 1]] as const) {
          const drop = u * -0.35; // the verge sits slightly below the road
          positions.push(
            _s.pos.x + _s.right.x * lat + _s.up.x * drop,
            _s.pos.y + _s.right.y * lat + _s.up.y * drop,
            _s.pos.z + _s.right.z * lat + _s.up.z * drop);
          normals.push(_s.up.x, _s.up.y, _s.up.z);
          uvs.push(u, d / 4);
        }
      }
      // The two verges mirror each other, so their winding has to mirror too or
      // the right-hand strip faces down and vanishes.
      for (let i = 0; i < N; i++) {
        const a = i * 2;
        if (side > 0) indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
        else indices.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
      mesh.name = `verge${side > 0 ? 'R' : 'L'}`;
      mesh.receiveShadow = true;
      parent.add(mesh);
    }
  }

  function buildWalls(spline: TrackSpline, course: CourseDef, parent: THREE.Group): void {
    if (course.walls === false) return;
    const vergeW = course.vergeWidth ?? 5;
    const h = course.wallHeight ?? 1.6;
    const N = Math.max(64, Math.round(spline.length / 3));
    const tex = makeRumbleTexture({ a: '#FF6B1A', b: '#FFF8F0', stripes: 8, along: true });

    for (const side of [-1, 1]) {
      const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
      for (let i = 0; i <= N; i++) {
        const d = (i / N) * spline.length;
        spline.atDistance(d, _s);
        const lat = side * (_s.width * 0.5 + vergeW);
        const bx = _s.pos.x + _s.right.x * lat;
        const by = _s.pos.y + _s.right.y * lat - 0.35;
        const bz = _s.pos.z + _s.right.z * lat;
        positions.push(bx, by, bz, bx + _s.up.x * h, by + _s.up.y * h, bz + _s.up.z * h);
        const nx = -side * _s.right.x, ny = -side * _s.right.y, nz = -side * _s.right.z;
        normals.push(nx, ny, nz, nx, ny, nz);
        uvs.push(d / 6, 0, d / 6, 1);
      }
      for (let i = 0; i < N; i++) {
        const a = i * 2;
        if (side > 0) indices.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
        else indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        map: tex, roughness: 0.7, side: THREE.DoubleSide,
      }));
      mesh.name = `wall${side > 0 ? 'R' : 'L'}`;
      mesh.receiveShadow = true;
      parent.add(mesh);
    }
  }

  function buildGround(course: CourseDef, parent: THREE.Group): void {
    const size = course.groundSize ?? 3000;
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: course.theme?.ground ?? ctx.config.palette.grass,
      roughness: 1,
    }));
    mesh.position.y = course.groundY ?? -0.6;
    mesh.receiveShadow = true;
    mesh.name = 'ground';
    parent.add(mesh);
  }

  function buildCheckpoints(spline: TrackSpline, course: CourseDef) {
    const count = course.checkpoints ?? 24;
    const list = [];
    for (let i = 0; i < count; i++) {
      const d = (course.startDistance ?? 0) + (i / count) * spline.length;
      const s = spline.atDistance(d, undefined);
      list.push({
        index: i,
        distance: ((d % spline.length) + spline.length) % spline.length,
        pos: s.pos.clone(),
        forward: s.tangent.clone(),
        width: s.width,
      });
    }
    return list;
  }

  return {
    name: 'track',
    order: 20,
    build,
    get track() { return track; },
    dispose() {
      if (group) {
        disposeGroup(group);
        ctx.scene.remove(group);
        group = null;
      }
    },
  };
}
