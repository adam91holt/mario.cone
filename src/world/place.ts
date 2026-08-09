// Where a prop goes, and how a thousand of them become a handful of draws.
//
// Two jobs.
//
// ── Standing on the actual ground ───────────────────────────────────────────
//
// The landscape (track/terrain.ts) is not a plane and not a heightmap query —
// it is two baked meshes, an embankment skirt swept along the spline and a
// coarse field beyond it. There is no runtime "how high is the ground here?"
// to call, so this file reconstructs both surfaces from the same functions that
// built them, *including* the skirt's ring spacing and the field's grid, so a
// cone placed at 14 metres off the shoulder lands on the triangle that is
// actually drawn there rather than on the smooth function behind it. Anything
// less and half the set dressing floats and the other half is buried.
//
// This is a mirror of terrain.ts and has to follow it. The tell that it has
// drifted is props hovering a few centimetres off the dirt.
//
// ── Batching ────────────────────────────────────────────────────────────────
//
// Every prop kind is one geometry with one material, so every prop kind is an
// InstancedMesh. Kinds with a lot of instances are split by lap sector, which
// is what lets the half of the circuit behind the camera cost nothing; kinds
// with only a few stay whole. On top of three's frustum test each batch carries
// its own draw distance, scaled by `ctx.quality.drawDistance`.

import * as THREE from 'three';
import { fbm, noise2, smoothstep } from '../track/geom.ts';
import { features } from '../track/courses/types.ts';
import type { CourseDef, SplineSample, TrackSplineLike } from '../types.ts';

/** Ring offsets of the embankment skirt. Must match terrain.ts. */
const RINGS = [0, 2, 5, 11, 20, 34, 58, 95, 150] as const;
/** Cells across the field mesh. Must match terrain.ts. */
const FIELD_CELLS = 176;

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _banked = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _sc = new THREE.Vector3();
const UPY = new THREE.Vector3(0, 1, 0);

export interface Spot {
  /** False when the ground here is not real — inside a hairpin, mostly. */
  ok: boolean;
  x: number; y: number; z: number;
  /** Yaw that turns a prop authored facing +Z to face the racing line. */
  face: number;
  /** Yaw that lines a prop up with the direction of travel. */
  along: number;
}

/**
 * The landscape, reconstructed.
 *
 * Built once per track from the course definition, then queried at build time
 * only — nothing in here runs per frame.
 */
export class Ground {
  readonly verge: number;
  private readonly groundY: number;
  private readonly rimStart: number;
  private readonly rimEnd: number;
  private readonly rimHeight: number;
  private readonly landmarks: ReadonlyArray<{ x: number; z: number; radius: number; height: number; kind?: string }>;
  private readonly cellSize: number;
  private readonly minGX: number;
  private readonly minGZ: number;
  private readonly s: SplineSample;

  constructor(private readonly spline: TrackSplineLike, course: CourseDef) {
    this.verge = course.vergeWidth ?? 5;
    const t = features(course).terrain ?? {};
    this.groundY = course.groundY ?? -8;
    this.rimStart = t.rimStart ?? 260;
    this.rimEnd = t.rimEnd ?? 560;
    this.rimHeight = t.rimHeight ?? 42;
    this.landmarks = t.landmarks ?? [];

    // The field mesh is centred on the circuit's bounding box, sampled every
    // 8 metres along the spline — same as terrain.ts, so the grid lines up.
    const size = course.groundSize ?? 4000;
    this.cellSize = size / FIELD_CELLS;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const probe = spline.atDistance(0);
    for (let d = 0; d < spline.length; d += 8) {
      spline.atDistance(d, probe);
      minX = Math.min(minX, probe.pos.x); maxX = Math.max(maxX, probe.pos.x);
      minZ = Math.min(minZ, probe.pos.z); maxZ = Math.max(maxZ, probe.pos.z);
    }
    this.minGX = (minX + maxX) * 0.5 - size * 0.5;
    this.minGZ = (minZ + maxZ) * 0.5 - size * 0.5;
    this.s = spline.atDistance(0);
  }

  /** terrain.ts's height function, verbatim. `d` is metres beyond the shoulder. */
  private height(d: number, sy: number, x: number, z: number): number {
    const embankment = 0.35 + 5.4 * smoothstep(0, 26, d);
    const ref = sy + (this.groundY - sy) * smoothstep(70, 340, d);
    const hills = fbm(x / 260, z / 260) * 26 * smoothstep(55, 320, d);
    const dunes = fbm(x / 150 + 11, z / 150 - 7) * 3.6 * smoothstep(20, 110, d);

    const gate = smoothstep(this.rimStart, this.rimEnd, d);
    const plateau = smoothstep(0.40, 0.57, noise2(x / 420 + 3, z / 420 + 5));
    const terrace = 0.42 + 0.58 * smoothstep(0.34, 0.52, noise2(x / 165 + 9, z / 165 - 4));
    const erosion = 0.86 + 0.14 * noise2(x / 58 - 21, z / 58 + 13);
    const rim = plateau * terrace * erosion * this.rimHeight * gate;

    let hero = 0;
    for (const lm of this.landmarks) {
      const r = Math.hypot(x - lm.x, z - lm.z) / lm.radius;
      if (r >= 1.35) continue;
      const shape = lm.kind === 'spire'
        ? Math.pow(Math.max(0, 1 - r), 2.2)
        : 1 - smoothstep(0.52, 1.05, r);
      const wobble = 0.84 + 0.16 * noise2(x / 44 + lm.x * 0.01, z / 44 + lm.z * 0.01);
      hero += lm.height * shape * wobble
        * smoothstep(this.rimStart * 0.7, this.rimStart * 1.5, d);
    }
    return ref - embankment + hills + dunes + rim + hero;
  }

  /** One vertex of the skirt, exactly as terrain.ts writes it. */
  private ringVertex(s: SplineSample, side: number, off: number, out: THREE.Vector3): void {
    const edge = s.width * 0.5 + this.verge;
    const lat = side * (edge + off);
    const w = smoothstep(0, 20, off);
    _banked.copy(s.pos).addScaledVector(s.right, lat)
      .addScaledVector(s.up, -0.35 - 5.4 * smoothstep(0, 26, off));
    // Horizontal outward normal — the landscape does not inherit the road's roll.
    const inv = 1 / Math.max(1e-6, Math.hypot(s.tangent.x, s.tangent.z));
    const frx = -s.tangent.z * inv * side;
    const frz = s.tangent.x * inv * side;
    const fx = s.pos.x + frx * (edge + off);
    const fz = s.pos.z + frz * (edge + off);
    const fy = this.height(off, s.pos.y, fx, fz);
    out.set(
      _banked.x + (fx - _banked.x) * w,
      _banked.y + (fy - _banked.y) * w,
      _banked.z + (fz - _banked.z) * w,
    );
  }

  /**
   * A spot on the embankment beside the road.
   *
   * `off` is metres beyond the outer edge of the shoulder — 0 is against the
   * barrier footing, and physics stops a kart 0.8m *inside* that, so anything
   * placed here is unreachable by definition.
   */
  spot(d: number, side: -1 | 1, off: number, out?: Spot): Spot {
    const r: Spot = out ?? { ok: false, x: 0, y: 0, z: 0, face: 0, along: 0 };
    const s = this.spline.atDistance(d, this.s);
    const edge = s.width * 0.5 + this.verge;

    // Inside a tight corner the skirt's rings fold into the centre of the turn
    // and the mesh runs out. Refuse the spot rather than stand a crane in a hole.
    const inner = (s.curvature > 0 ? -1 : 1) === side;
    if (inner && Math.abs(s.curvature) > 1e-4) {
      const limit = Math.max(0, 1 / Math.abs(s.curvature) - edge);
      if (off > limit * 0.82) { r.ok = false; return r; }
    }

    // Bracket the requested offset by the two rings either side of it and
    // interpolate the *mesh*, not the function it was made from.
    let j = 0;
    while (j < RINGS.length - 2 && RINGS[j + 1]! < off) j++;
    const o0 = RINGS[j]!, o1 = RINGS[j + 1]!;
    const t = Math.min(1, Math.max(0, (off - o0) / (o1 - o0)));
    this.ringVertex(s, side, o0, _a);
    this.ringVertex(s, side, o1, _b);
    r.x = _a.x + (_b.x - _a.x) * t;
    r.y = _a.y + (_b.y - _a.y) * t;
    r.z = _a.z + (_b.z - _a.z) * t;

    const inv = 1 / Math.max(1e-6, Math.hypot(s.tangent.x, s.tangent.z));
    const frx = -s.tangent.z * inv * side;
    const frz = s.tangent.x * inv * side;
    r.face = Math.atan2(-frx, -frz);
    r.along = Math.atan2(s.tangent.x, s.tangent.z);
    r.ok = true;
    return r;
  }

  /**
   * The road's own elevation at a lap distance.
   *
   * The embankment falls 5.75m away from the shoulder inside thirty metres,
   * which means the whole run-off is a ditch: from a chase camera 3m up, a
   * barrier 1.9m tall hides everything under about six metres of height out to
   * fifty metres off the road. So anything that has to be *seen* — a stand, a
   * crowd, a works compound, a line of cones — is built at road level on its own
   * plinth rather than sitting in the hole. This is the datum for that.
   */
  roadY(d: number): number {
    return this.spline.atDistance(d, this.s).pos.y;
  }

  /**
   * A spot out past the skirt, on the open field.
   *
   * The skirt only reaches 150m; beyond that the visible surface is the coarse
   * field mesh, so the position comes straight off the spline's horizontal
   * frame and the height comes from the field. Use this for anything on the
   * horizon — cranes, silos, masts.
   */
  farSpot(d: number, side: -1 | 1, off: number, out?: Spot): Spot {
    const r: Spot = out ?? { ok: false, x: 0, y: 0, z: 0, face: 0, along: 0 };
    const s = this.spline.atDistance(d, this.s);
    const edge = s.width * 0.5 + this.verge;
    const inv = 1 / Math.max(1e-6, Math.hypot(s.tangent.x, s.tangent.z));
    const frx = -s.tangent.z * inv * side;
    const frz = s.tangent.x * inv * side;
    r.x = s.pos.x + frx * (edge + off);
    r.z = s.pos.z + frz * (edge + off);
    r.face = Math.atan2(-frx, -frz);
    r.along = Math.atan2(s.tangent.x, s.tangent.z);
    r.y = this.fieldY(r.x, r.z);
    r.ok = true;
    return r;
  }

  /**
   * Height of the far field at a world position, bilinear across the same grid
   * cell the mesh is made of — so a silo two hundred metres out still has its
   * feet in the dirt.
   */
  fieldY(x: number, z: number): number {
    const c = this.cellSize;
    const gx = Math.floor((x - this.minGX) / c);
    const gz = Math.floor((z - this.minGZ) / c);
    const fx = (x - this.minGX) / c - gx;
    const fz = (z - this.minGZ) / c - gz;
    const h00 = this.cornerY(this.minGX + gx * c, this.minGZ + gz * c);
    const h10 = this.cornerY(this.minGX + (gx + 1) * c, this.minGZ + gz * c);
    const h01 = this.cornerY(this.minGX + gx * c, this.minGZ + (gz + 1) * c);
    const h11 = this.cornerY(this.minGX + (gx + 1) * c, this.minGZ + (gz + 1) * c);
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }

  private cornerY(x: number, z: number): number {
    _v.set(x, 0, z);
    const s = this.spline.nearest(_v, this.s);
    _v.set(x - s.pos.x, 0, z - s.pos.z);
    const d = Math.max(0, _v.length() - (s.width * 0.5 + this.verge));
    const sink = 4 * (1 - smoothstep(50, 140, d));
    return this.height(d, s.pos.y, x, z) - sink;
  }

  /** Metres beyond the shoulder at a world position — "is this clear of the road". */
  clearance(x: number, z: number): number {
    _v.set(x, 0, z);
    const s = this.spline.nearest(_v, this.s);
    _v.set(x - s.pos.x, 0, z - s.pos.z);
    return _v.length() - (s.width * 0.5 + this.verge);
  }

  /** Lap distance nearest a world position, for sector bucketing. */
  distanceAt(x: number, z: number): number {
    _v.set(x, 0, z);
    return this.spline.nearest(_v, this.s).distance;
  }
}

// ── batching ───────────────────────────────────────────────────────────────

/** Lap sectors a kind's instances are bucketed into before batching. */
const SECTORS = 8;
/**
 * Instances a batch wants to carry.
 *
 * This is the whole trade. Split too coarsely and a batch spans the circuit, so
 * its bounding sphere never leaves the frustum and its draw distance never
 * trips — every cone on the course is drawn every frame. Split too finely and
 * nine hundred cones become sixty-four draw calls of fourteen instances each,
 * which is worse in the other direction: the first version of this file did
 * exactly that and put the whole module at four hundred and seventy draws.
 *
 * So sectors are merged back down until each batch is worth submitting. Kinds
 * with a handful of instances end up whole; the ones that carpet the lap end up
 * with one batch per sector, which is exactly where the culling pays.
 */
const PER_BATCH = 70;

export interface KindOptions {
  material: THREE.Material;
  /** Metres past which this kind stops drawing, before the quality scale. */
  far?: number;
  cast?: boolean;
  receive?: boolean;
  /** Draw order for the transparent decals. */
  renderOrder?: number;
}

interface Kind {
  id: string;
  geo: THREE.BufferGeometry;
  opts: KindOptions;
  buckets: THREE.Matrix4[][];
  total: number;
}

export interface Batch {
  mesh: THREE.InstancedMesh;
  center: THREE.Vector3;
  radius: number;
  far: number;
}

/**
 * Collects instances by kind and lap sector, then turns them into meshes.
 *
 * Matrices are copied on `place`, so callers can reuse one scratch matrix for
 * an entire circuit's worth of cones.
 */
export class Batcher {
  private kinds = new Map<string, Kind>();
  readonly batches: Batch[] = [];

  constructor(private readonly lapLength: number) {}

  define(id: string, geo: THREE.BufferGeometry, opts: KindOptions): void {
    if (this.kinds.has(id)) return;
    this.kinds.set(id, {
      id, geo, opts, total: 0,
      buckets: Array.from({ length: SECTORS }, () => [] as THREE.Matrix4[]),
    });
  }

  has(id: string): boolean { return this.kinds.has(id); }

  /** `d` is the lap distance the prop belongs to; it only chooses the bucket. */
  place(id: string, m: THREE.Matrix4, d: number): void {
    const k = this.kinds.get(id);
    if (!k) return;
    const f = ((d / this.lapLength) % 1 + 1) % 1;
    const sector = Math.min(SECTORS - 1, Math.floor(f * SECTORS));
    k.buckets[sector]!.push(m.clone());
    k.total++;
  }

  /** Position + yaw + uniform scale, the shape almost every placement takes. */
  placeAt(
    id: string, x: number, y: number, z: number, yaw: number, scale: number, d: number,
    tilt = 0,
  ): void {
    _q.setFromAxisAngle(UPY, yaw);
    if (tilt !== 0) _q.multiply(_qTilt.setFromAxisAngle(TILT_AXIS, tilt));
    _sc.set(scale, scale, scale);
    _m.compose(_v.set(x, y, z), _q, _sc);
    this.place(id, _m, d);
  }

  build(parent: THREE.Object3D): Batch[] {
    for (const k of this.kinds.values()) {
      // A kind the placement program never used still built its geometry.
      // Nothing else will ever hold it, so let it go here.
      if (k.total === 0) { k.geo.dispose(); continue; }

      const want = Math.max(1, Math.min(SECTORS, Math.ceil(k.total / PER_BATCH)));
      const per = Math.ceil(SECTORS / want);
      const groups: THREE.Matrix4[][] = [];
      for (let i = 0; i < SECTORS; i += per) {
        const merged: THREE.Matrix4[] = [];
        for (let j = i; j < Math.min(SECTORS, i + per); j++) {
          const b = k.buckets[j]!;
          for (let n = 0; n < b.length; n++) merged.push(b[n]!);
        }
        if (merged.length) groups.push(merged);
      }

      for (const list of groups) {
        if (!list.length) continue;
        const mesh = new THREE.InstancedMesh(k.geo, k.opts.material, list.length);
        mesh.name = `world:${k.id}`;
        mesh.castShadow = k.opts.cast ?? false;
        mesh.receiveShadow = k.opts.receive ?? false;
        if (k.opts.renderOrder) mesh.renderOrder = k.opts.renderOrder;
        mesh.frustumCulled = true;
        for (let i = 0; i < list.length; i++) mesh.setMatrixAt(i, list[i]!);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        const bs = mesh.boundingSphere ?? new THREE.Sphere(new THREE.Vector3(), 1);
        parent.add(mesh);
        this.batches.push({
          mesh,
          center: bs.center.clone(),
          radius: bs.radius,
          far: k.opts.far ?? 400,
        });
      }
    }
    this.kinds.clear();
    return this.batches;
  }
}

const _qTilt = new THREE.Quaternion();
const TILT_AXIS = new THREE.Vector3(1, 0, 0);
