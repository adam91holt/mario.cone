// Track system: turns a course definition into geometry, surfaces and
// checkpoints.
//
// The build is split by what each piece is *for*:
//   road.ts      the driving surface, markings, kerbs, shoulders, boost strips
//   barriers.ts  the built edge of the circuit — footings, panels, posts, boards
//   gantry.ts    the start/finish landmark
//   terrain.ts   the world the circuit sits in
//
// This file owns the contract the rest of the game sees: `sample()` — which
// answers "what am I standing on and where is it" for every racer every fixed
// step — plus the grid slots and the checkpoint ring.

import * as THREE from 'three';
import { TrackSpline } from './spline.ts';
import { buildRoad, type PadRuntime } from './road.ts';
import { buildBarriers } from './barriers.ts';
import { buildGantry } from './gantry.ts';
import { buildTerrain } from './terrain.ts';
import { surfaceHeight } from './geom.ts';
import { getCourse } from './courses/index.ts';
import type {
  CourseDef, GameContext, GameSystem, GridSlot, SplineSample, Surface, Track,
} from '../types.ts';

export interface TrackSystem extends GameSystem {
  build(course: CourseDef | string): Track;
  readonly track: Track | null;
}

export function createTrackSystem(ctx: GameContext): TrackSystem {
  let group: THREE.Group | null = null;
  let track: Track | null = null;
  let pads: PadRuntime[] = [];
  let padTexture: THREE.Texture | null = null;
  let banner: THREE.Object3D | null = null;
  let clock = 0;

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

    const road = buildRoad(spline, course, group);
    buildBarriers(spline, course, road.corners, group);
    banner = buildGantry(spline, course, group, course.name).banner;
    buildTerrain(spline, course, group);

    pads = road.pads;
    padTexture = road.padTexture;

    const checkpoints = buildCheckpoints(spline, course);
    const vergeWidth = course.vergeWidth ?? 5;
    const L = spline.length;

    track = {
      id: course.id,
      name: course.name,
      course,
      spline,
      group,
      length: L,
      laps: course.laps ?? ctx.config.race.laps,
      checkpoints,
      theme: course.theme ?? {},

      /**
       * Surface + position query used by kart physics every step.
       *
       * The track owns what the tarmac *is*: physics asks what surface it is
       * standing on and gets 'boost' back on a strip, which is what makes boost
       * pads a track feature rather than a physics special case.
       */
      sample(worldPos: THREE.Vector3, out?: SplineSample): SplineSample {
        const s = spline.nearest(worldPos, out);
        const half = s.width * 0.5;
        const lateral = s.lateral ?? 0;
        const a = Math.abs(lateral);
        let surface: Surface;
        if (a <= half) {
          surface = 'road';
          for (let i = 0; i < pads.length; i++) {
            const p = pads[i]!;
            if (lateral < p.lat0 || lateral > p.lat1) continue;
            const rel = ((s.distance - p.d0) % L + L) % L;
            if (rel <= p.d1 - p.d0) { surface = 'boost'; break; }
          }
        } else if (a <= half + vergeWidth) {
          surface = course.vergeSurface ?? 'dirt';
        } else {
          surface = course.offSurface ?? 'grass';
        }
        s.surface = surface;
        return s;
      },

      /** Start-grid slots: two staggered columns behind the line. */
      gridSlot(i: number, _total: number): GridSlot {
        const col = i % 2 === 0 ? -1 : 1;
        const row = Math.floor(i / 2);
        const back = 12 + row * 8;
        const startD = (course.startDistance ?? 0) - back;
        const s = spline.atDistance(startD, undefined);
        const lateral = col * (course.width ?? 24) * 0.19;
        const lift = surfaceHeight(lateral, s.width, vergeWidth) + 0.6;
        const pos = s.pos.clone()
          .addScaledVector(s.right, lateral)
          .addScaledVector(s.up, lift);
        return { pos, forward: s.tangent.clone(), up: s.up.clone(), distance: startD };
      },
    };

    ctx.scene.add(group);
    ctx.track = track;
    ctx.bus.emit('track:built', { track });
    return track;
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

    /** Visuals only — the chevrons crawl and the banner breathes. */
    update(dt: number): void {
      clock += dt;
      if (padTexture) padTexture.offset.y = (padTexture.offset.y - dt * 1.8) % 1;
      if (banner) {
        banner.rotation.x = Math.sin(clock * 1.3) * 0.035;
        banner.rotation.z = Math.sin(clock * 0.9 + 1.1) * 0.012;
      }
    },

    dispose() {
      if (group) {
        disposeGroup(group);
        ctx.scene.remove(group);
        group = null;
      }
    },
  };
}
