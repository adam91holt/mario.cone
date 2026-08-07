// Everything an item turns into once it has left the kart.
//
// One pooled array of entities, one switch per kind. Pooled because a shell
// spawning must not allocate — this runs inside the fixed step, and a garbage
// collection at 120Hz is a hitch in the middle of a corner. Nodes are pooled
// too: each kind keeps a small stack of prebuilt models and hands one out on
// spawn.
//
// The three behaviours worth reading closely:
//
//   The green shell flies in world space and *reflects off the barrier line* —
//   the same lateral limit the kart physics holds a kart inside — so it ricochets
//   off exactly the wall the player can see.
//
//   The red shell does not fly at all. It rides the spline: a distance along the
//   lap and a lateral offset, steering that offset toward its target's. That is
//   what makes it hug the road through a hairpin instead of sailing off into the
//   scenery, and it is why it can be outrun but not out-cornered.
//
//   Everything else is a timer with a mesh on it.

import * as THREE from 'three';
import { clamp, clamp01, damp, ease } from '../core/math.ts';
import {
  addProjectileGlow, addProjectileShadow,
  buildBanana, buildBlast, buildBlooper, buildBomb, buildBoo, buildBurst,
  buildRing, buildScorch, buildShell, cloneWithMaterials, setColor, setOpacity,
  setRimStrength,
} from './models.ts';
import { surfaceHeight } from '../track/geom.ts';
import type { GameContext, Racer, SplineSample } from '../types.ts';

export type EntityKind =
  | 'banana' | 'greenShell' | 'redShell' | 'bomb'
  | 'blast' | 'ring' | 'ghost' | 'squid' | 'burst' | 'scorch';

export interface Entity {
  kind: EntityKind;
  active: boolean;
  ownerId: number;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Seconds left before it removes itself. */
  life: number;
  age: number;
  /** Seconds during which the owner is immune to their own item. */
  arm: number;
  bounces: number;
  targetId: number;
  /** Spline coordinates — the red shell's whole state. */
  dist: number;
  lat: number;
  yaw: number;
  spin: number;
  /** Contact radius, or the current radius of a blast/shockwave. */
  radius: number;
  scale: number;
  groundY: number;
  node: THREE.Object3D | null;
  /** Which item drew this, for the strike report. */
  source: EntityKind;
  /** Visual emitter clock for the flight trail. Written only from `update`. */
  puff: number;
}

export interface SpawnOptions {
  ownerId?: number;
  pos?: THREE.Vector3;
  vel?: THREE.Vector3;
  life?: number;
  arm?: number;
  targetId?: number;
  dist?: number;
  lat?: number;
  yaw?: number;
  radius?: number;
  groundY?: number;
  color?: number;
}

/** Called when an entity reaches a racer. Return true to consume the entity. */
export type HitFn = (entity: Entity, racer: Racer) => boolean;
/** Called the moment an entity's clock runs out, before it is recycled. */
export type ExpireFn = (entity: Entity) => void;

const MAX = 44;
const SHELL_SPEED = 58;
const RED_SPEED = 56;
const _v = new THREE.Vector3();
const _to = new THREE.Vector3();
const _sample: SplineSample = {
  pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
  right: new THREE.Vector3(), up: new THREE.Vector3(),
  width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
};

/**
 * How far the tarmac stands proud of the spline's own surface at a given
 * lateral offset.
 *
 * The road is *crowned*: the driving surface is lifted 16cm at the centreline
 * and falls away past the kerbs, the way a real road sheds water. None of that
 * is visible in a spline sample, so anything placed at `s.pos + right * lateral`
 * is placed **under the road** — by the better part of a shell's radius in the
 * middle, which is where almost everything in this module ends up.
 *
 * That single omission is why a green shell photographed half-sunk in the
 * tarmac, why a bob-omb's scorch mark could not be found on the road it had
 * just been burned into, and why the contact shadows under the item boxes were
 * invisible: all three were being drawn inside the asphalt.
 *
 * `surfaceHeight` is the track module's own profile — the one the road mesh is
 * built from and the one kart physics drives on — so this cannot drift out of
 * agreement with either of them.
 */
export function roadCrown(lateral: number, width: number, verge = 5): number {
  return surfaceHeight(lateral, width, verge);
}

function blank(): Entity {
  return {
    kind: 'banana', active: false, ownerId: -1,
    pos: new THREE.Vector3(), prevPos: new THREE.Vector3(), vel: new THREE.Vector3(),
    life: 0, age: 0, arm: 0, bounces: 0, targetId: -1,
    dist: 0, lat: 0, yaw: 0, spin: 0, radius: 1.5, scale: 1, groundY: 0,
    node: null, source: 'banana', puff: 0,
  };
}

export interface EntityField {
  readonly list: readonly Entity[];
  init(): void;
  spawn(kind: EntityKind, opts: SpawnOptions): Entity | null;
  fixedUpdate(dt: number, onHit: HitFn, onExpire: ExpireFn): void;
  update(dt: number, alpha: number, time: number): void;
  /** Wipe anything within `radius` of a point — what the super horn does. */
  clearNear(pos: THREE.Vector3, radius: number, except: number): number;
  clear(): void;
  dispose(): void;
}

export function createEntityField(ctx: GameContext): EntityField {
  const list: Entity[] = [];
  for (let i = 0; i < MAX; i++) list.push(blank());

  const group = new THREE.Group();
  group.name = 'items';
  ctx.scene.add(group);

  const prototypes = new Map<EntityKind, THREE.Object3D>();
  const pools = new Map<EntityKind, THREE.Object3D[]>();
  /** Kinds whose material state is animated per copy, so each needs its own. */
  const PRIVATE: ReadonlySet<EntityKind> =
    new Set<EntityKind>(['bomb', 'blast', 'ring', 'ghost', 'squid', 'burst', 'scorch']);

  function init(): void {
    if (prototypes.size) return;
    prototypes.set('banana', buildBanana());
    prototypes.set('greenShell', buildShell(0x46D63C, 0x2C9A2A));
    prototypes.set('redShell', buildShell(0xF03A2E, 0xB0231A));
    prototypes.set('bomb', buildBomb());
    prototypes.set('blast', buildBlast());
    prototypes.set('ring', buildRing(0xFF8A2A));
    prototypes.set('ghost', buildBoo());
    prototypes.set('squid', buildBlooper());
    prototypes.set('burst', buildBurst());
    prototypes.set('scorch', buildScorch());

    // Everything that travels gets a contact shadow and — for the two that
    // travel *fast* — a halo. A projectile is on screen for under a second and
    // spends it against tarmac; without these it is a coloured lump nobody can
    // find. See `addProjectileShadow`.
    addProjectileShadow(prototypes.get('banana')!, 1.25);
    addProjectileShadow(prototypes.get('bomb')!, 1.3);
    for (const [kind, colour] of [
      ['greenShell', 0x8CFF6A], ['redShell', 0xFF7A5A],
    ] as Array<[EntityKind, number]>) {
      addProjectileShadow(prototypes.get(kind)!, 1.6);
      addProjectileGlow(prototypes.get(kind)!, colour, 0.46);
    }

    for (const kind of prototypes.keys()) pools.set(kind, []);
    // Warm the pools before the race rather than during it. Two reasons, and
    // the second is the important one: a spawn inside the fixed step must not
    // allocate, and the *first* draw of a material three has never seen
    // compiles a shader program — which on a software renderer is a multi-second
    // stall. Every kind therefore exists, in the scene, before the lights go
    // out; `renderer.compile` in the item system's reset then pays for all of
    // them at once.
    for (const [kind, count] of [
      ['banana', 6], ['greenShell', 4], ['redShell', 4], ['bomb', 3], ['burst', 5],
      ['blast', 2], ['ring', 2], ['ghost', 1], ['squid', 1], ['scorch', 3],
    ] as Array<[EntityKind, number]>) {
      for (let i = 0; i < count; i++) pools.get(kind)!.push(makeNode(kind));
    }
  }

  function makeNode(kind: EntityKind): THREE.Object3D {
    const proto = prototypes.get(kind)!;
    const node = PRIVATE.has(kind) ? cloneWithMaterials(proto) : proto.clone(true);
    node.visible = false;
    node.matrixAutoUpdate = true;
    group.add(node);
    return node;
  }

  function acquire(kind: EntityKind): THREE.Object3D {
    const pool = pools.get(kind)!;
    const node = pool.pop() ?? makeNode(kind);
    node.visible = true;
    return node;
  }

  function release(e: Entity): void {
    if (e.node) {
      e.node.visible = false;
      pools.get(e.kind)!.push(e.node);
      e.node = null;
    }
    e.active = false;
  }

  /** Ground height and lateral offset at a world position. */
  function probe(pos: THREE.Vector3): SplineSample | null {
    const track = ctx.track;
    if (!track) return null;
    return track.spline.nearest(pos, _sample);
  }

  function surfaceY(s: SplineSample, lateral: number): number {
    _v.copy(s.pos).addScaledVector(s.right, lateral)
      .addScaledVector(s.up, roadCrown(lateral, s.width, ctx.track?.course.vergeWidth ?? 5));
    return _v.y;
  }

  // ── spawning ─────────────────────────────────────────────────────────────

  function spawn(kind: EntityKind, opts: SpawnOptions): Entity | null {
    let e: Entity | null = null;
    for (let i = 0; i < list.length; i++) {
      if (!list[i]!.active) { e = list[i]!; break; }
    }
    if (!e) {
      // Full. Steal the oldest projectile rather than silently dropping the
      // item the player just used.
      let oldest: Entity | null = null;
      for (const x of list) if (!oldest || x.age > oldest.age) oldest = x;
      if (!oldest) return null;
      release(oldest);
      e = oldest;
    }

    e.kind = kind;
    e.source = kind;
    e.active = true;
    e.ownerId = opts.ownerId ?? -1;
    e.pos.copy(opts.pos ?? _v.set(0, 0, 0));
    e.prevPos.copy(e.pos);
    e.vel.copy(opts.vel ?? _v.set(0, 0, 0));
    e.life = opts.life ?? 10;
    e.age = 0;
    e.arm = opts.arm ?? 0;
    e.bounces = 0;
    e.targetId = opts.targetId ?? -1;
    e.dist = opts.dist ?? 0;
    e.lat = opts.lat ?? 0;
    e.yaw = opts.yaw ?? 0;
    e.spin = 0;
    e.radius = opts.radius ?? 1.55;
    e.scale = 1;
    e.groundY = opts.groundY ?? e.pos.y;
    e.puff = 0;
    e.node = acquire(kind);
    e.node.position.copy(e.pos);
    e.node.rotation.set(0, e.yaw, 0);
    e.node.scale.setScalar(
      kind === 'blast' || kind === 'ring' || kind === 'burst' ? 0.01
        : kind === 'scorch' ? e.radius : 1);
    if (opts.color !== undefined) setColor(e.node, opts.color);
    return e;
  }

  // ── simulation ───────────────────────────────────────────────────────────

  function stepBanana(e: Entity, dt: number): void {
    if (e.pos.y > e.groundY + 0.02 || e.vel.lengthSq() > 0.01) {
      e.vel.y -= 30 * dt;
      e.pos.addScaledVector(e.vel, dt);
      e.spin += dt * 6;
      const s = probe(e.pos);
      if (s) e.groundY = surfaceY(s, s.lateral ?? 0);
      if (e.pos.y <= e.groundY + 0.02) {
        e.pos.y = e.groundY + 0.02;
        e.vel.set(0, 0, 0);
      }
    }
  }

  function stepShell(e: Entity, dt: number): void {
    const track = ctx.track;
    e.pos.addScaledVector(e.vel, dt);
    e.spin += dt * 14;
    if (!track) return;

    const s = track.spline.nearest(e.pos, _sample);
    const lateral = s.lateral ?? 0;
    // The same limit kart physics holds a kart inside, so a shell ricochets off
    // the barrier the player can actually see.
    const limit = s.width * 0.5 + (track.course.vergeWidth ?? 5) - 0.6;
    if (Math.abs(lateral) > limit) {
      const outward = Math.sign(lateral);
      e.pos.addScaledVector(s.right, -outward * (Math.abs(lateral) - limit));
      const into = e.vel.dot(s.right) * outward;
      if (into > 0) {
        e.vel.addScaledVector(s.right, -outward * into * 2);
        e.bounces++;
        // Bleed a little each time, so a shell that has been round the houses
        // is visibly on its last legs before it gives up.
        e.vel.multiplyScalar(0.97);
        ctx.bus.emit('item:bounce', { kind: e.kind, pos: e.pos, bounces: e.bounces });
        if (e.bounces > 4) e.life = 0;
      }
    }
    // Ride the road rather than the world: a shell that keeps its launch height
    // over a crest ends up flying at head height down the next straight.
    //
    // 0.16, not 0.45. The model stands *on* its origin — a hat's brim is at
    // y=0.12 and its crown at 0.58 — so half a metre of ride height hung the
    // whole thing in mid-air with a shadow a metre beneath it, which reads as
    // an object with no relationship to the road it is supposed to be
    // skittering along. Low enough to belong to the tarmac, high enough that
    // the brim clears it.
    const targetY = surfaceY(s, lateral) + 0.16;
    e.pos.y = damp(e.pos.y, targetY, 0.0001, dt);
    e.groundY = targetY - 0.16;
    e.yaw = Math.atan2(e.vel.x, e.vel.z);
  }

  function stepRedShell(e: Entity, dt: number): void {
    const track = ctx.track;
    if (!track) return;
    const L = track.length;
    const spline = track.spline;

    let targetLat = e.lat;
    const target = ctx.racers.find((r) => r.id === e.targetId);
    if (target) {
      const ts = spline.nearest(target.pos, _sample);
      targetLat = ts.lateral ?? 0;
      const gap = spline.forwardDistance(e.dist, ts.distance);
      // Closing: lean on the throttle a little when it is a long way back, so a
      // red shell fired from twelfth still means something.
      const chase = gap > 60 ? 1.18 : gap > 25 ? 1.08 : 1.0;
      e.dist += RED_SPEED * chase * dt;
      if (gap > L * 0.5) {
        // The target has gone past us the other way round the lap — it can only
        // be a shell fired at someone who has since been lapped. Let it die.
        e.life = Math.min(e.life, 0.4);
      }
    } else {
      e.dist += RED_SPEED * dt;
    }
    // Ease the lateral rather than snapping: the weave as it lines up is the
    // tell that lets a player know it is theirs and start looking for a wall.
    e.lat = damp(e.lat, targetLat, 0.00004, dt);

    const s = spline.atDistance(e.dist, _sample);
    e.lat = clamp(e.lat, -s.width * 0.5 - 2, s.width * 0.5 + 2);
    e.pos.copy(s.pos).addScaledVector(s.right, e.lat).addScaledVector(s.up, 0.18);
    e.yaw = Math.atan2(s.tangent.x, s.tangent.z);
    e.spin += dt * 16;
    e.groundY = e.pos.y - 0.18;
  }

  function stepBomb(e: Entity, dt: number): void {
    if (e.pos.y > e.groundY + 0.02 || Math.abs(e.vel.y) > 0.01 || e.vel.lengthSq() > 0.02) {
      e.vel.y -= 28 * dt;
      e.pos.addScaledVector(e.vel, dt);
      const s = probe(e.pos);
      if (s) e.groundY = surfaceY(s, s.lateral ?? 0);
      if (e.pos.y <= e.groundY + 0.02) {
        e.pos.y = e.groundY + 0.02;
        e.vel.set(0, 0, 0);
      }
      e.spin += dt * 5;
    }
  }

  function fixedUpdate(dt: number, onHit: HitFn, onExpire: ExpireFn): void {
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (!e.active) continue;

      e.prevPos.copy(e.pos);
      e.age += dt;
      e.life -= dt;
      if (e.arm > 0) e.arm = Math.max(0, e.arm - dt);

      switch (e.kind) {
        case 'banana': stepBanana(e, dt); break;
        case 'greenShell': stepShell(e, dt); break;
        case 'redShell': stepRedShell(e, dt); break;
        case 'bomb': stepBomb(e, dt); break;
        case 'blast':
          // Grows fast, holds, then goes. The radius is what the damage pass
          // read on the frame it spawned; this is only the picture of it.
          e.scale = clamp01(e.age / 0.16) * (1 + e.age * 0.5);
          break;
        case 'ring':
          // Out fast, then settle. A shockwave that expands linearly spends its
          // first tenth of a second inside the kart that fired it, which from a
          // chase camera means the player never sees it leave at all.
          //
          // 0.42s rather than 0.30: at 0.30 the wave had crossed nine metres and
          // gone past the lens before the eye had registered it starting, and
          // the only frames that caught it were the ones nobody was looking at.
          e.scale = ease.outCubic(clamp01(e.age / 0.42));
          break;
        case 'ghost':
        case 'squid': {
          e.pos.addScaledVector(e.vel, dt);
          e.spin += dt * 2.4;
          break;
        }
        case 'burst':
          e.scale = 1 + e.age * 6;
          e.spin += dt * 7;
          break;
        case 'scorch':
          // A mark on the road. It does nothing but cool.
          break;
        default: break;
      }

      if (e.life <= 0) { onExpire(e); release(e); continue; }

      // ── contact ────────────────────────────────────────────────────────
      if (e.kind === 'banana' || e.kind === 'greenShell'
        || e.kind === 'redShell' || e.kind === 'bomb') {
        let consumed = false;
        for (let r = 0; r < ctx.racers.length; r++) {
          const racer = ctx.racers[r]!;
          if (racer.id === e.ownerId && e.arm > 0) continue;
          _to.subVectors(racer.pos, e.pos);
          // Vertical tolerance is loose: a shell rides the road and a kart on a
          // kerb or mid-hop is still very much in its way.
          if (Math.abs(_to.y) > 2.6) continue;
          _to.y = 0;
          if (_to.lengthSq() > e.radius * e.radius) continue;
          if (onHit(e, racer)) { consumed = true; break; }
        }
        if (consumed) { release(e); continue; }
      }

      // A shell sweeping a banana off the road is free, and it is the kind of
      // thing a player notices once and remembers for the rest of the game.
      // Two shells meeting head-on take each other out — which is the only
      // thing that makes throwing a shell *backwards* at an incoming one a real
      // decision rather than a waste.
      if (e.kind === 'greenShell' || e.kind === 'redShell') {
        for (let j = 0; j < list.length; j++) {
          const o = list[j]!;
          if (!o.active || o === e) continue;
          const shell = o.kind === 'greenShell' || o.kind === 'redShell';
          if (o.kind !== 'banana' && o.kind !== 'bomb' && !shell) continue;
          if (o.pos.distanceToSquared(e.pos) > (shell ? 5.5 : 3.2)) continue;
          o.life = 0.0001;
          o.arm = 0;
          if (shell) e.life = 0.0001;
          break;
        }
      }
    }
  }

  // ── visuals ──────────────────────────────────────────────────────────────

  /**
   * Put the contact shadow on the road under an item.
   *
   * Divided through by the node's own scale because the squash a banana lands
   * with, and the swell a bob-omb goes off with, are on the node — and a shadow
   * that grows with them is a shadow that has left the ground.
   */
  function groundShadow(e: Entity, node: THREE.Object3D): void {
    const s = node.getObjectByName('shadow');
    if (!s) return;
    const h = Math.max(0, node.position.y - e.groundY);
    s.position.y = (0.05 - h) / Math.max(0.01, node.scale.y);
    // A shadow spreads and weakens as the thing casting it climbs. Materials
    // are shared across the pool, so this is done with scale rather than alpha.
    s.scale.setScalar(clamp(1 - h * 0.06, 0.5, 1.15) / Math.max(0.01, node.scale.x));
  }

  /**
   * The dust and sparks a projectile drags behind it.
   *
   * A shell crosses the frame in a third of a second. Whether the player *sees*
   * it is decided almost entirely by what it leaves behind — a bare mesh moving
   * at sixty metres a second across tarmac of a similar value is, in a still
   * frame, nothing. The trail is also the only thing that survives motion blur
   * and a small window.
   *
   * Emitted on the render clock. Nothing in the simulation reads it, and the
   * effect queue drops anything it cannot fit, so a crowded frame loses trail
   * before it loses a hit.
   */
  function flightTrail(e: Entity, node: THREE.Object3D, dt: number): void {
    const fx = ctx.fx;
    if (!fx) return;
    e.puff -= dt;
    if (e.puff > 0) return;
    e.puff = 0.055;
    // Out of shot, and it is not worth a slot in the queue.
    if (node.position.distanceToSquared(ctx.camera.position) > 120 * 120) return;
    const hot = e.kind === 'redShell' ? 0xFF9A72 : 0x9CFF74;
    if (Math.floor(e.age * 18) % 3 === 0) {
      _v.set(node.position.x, e.groundY + 0.06, node.position.z);
      fx.spawn('dust', _v, { scale: 0.3 });
    } else {
      _v.copy(node.position);
      fx.spawn('sparks', _v, { color: hot, scale: 0.2 });
    }
  }

  function update(dt: number, alpha: number, time: number): void {
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      const node = e.node;
      if (!e.active || !node) continue;

      node.position.lerpVectors(e.prevPos, e.pos, alpha);

      switch (e.kind) {
        case 'banana':
          node.rotation.set(0, e.spin, 0);
          // A banana that has just landed settles with a squash.
          node.scale.setScalar(1 + Math.max(0, 0.35 - e.age) * 0.6);
          groundShadow(e, node);
          break;
        case 'greenShell':
        case 'redShell':
          // It *spins*. The old build pinned yaw to the direction of travel —
          // which for a shell going down a straight is a constant — and put the
          // whole animation into a six-degree roll, so a hat crossing the frame
          // at sixty metres a second was, frame to frame, a static object being
          // slid sideways. Yaw is the spin now, and the brim under it is what
          // makes the rotation legible at speed.
          node.rotation.set(0, e.spin * 1.4, Math.sin(e.spin * 0.7) * 0.22);
          node.position.y += Math.sin(e.spin * 0.5) * 0.05;
          // Bigger than it is in the hand. A hat that reads at two metres, in
          // the slot, is four pixels of green forty metres down a straight —
          // and forty metres down a straight is where a shell has to be read.
          node.scale.setScalar(1.3);
          groundShadow(e, node);
          flightTrail(e, node, dt);
          break;
        case 'bomb': {
          node.rotation.set(0, e.spin, Math.sin(e.age * 8) * 0.12);
          // The fuse spark: brighter and faster the closer it is to going off.
          const urgency = clamp01(1 - e.life / 2.4);
          const spark = node.getObjectByName('spark');
          if (spark) {
            const s = 0.7 + Math.sin(time * (16 + urgency * 40)) * (0.3 + urgency * 0.5);
            spark.scale.setScalar(s);
          }
          // It swells as it is about to blow. Anticipation, and a warning.
          node.scale.setScalar(1 + urgency * urgency * 0.25);
          groundShadow(e, node);
          break;
        }
        case 'blast': {
          // 0.45, not 0.8. The damage radius is 7.4 metres, and a *fireball*
          // drawn at eight tenths of that is twelve metres across — bigger than
          // the road is wide, and from anywhere inside it the frame is a sheet
          // of orange. The reach of a bob-omb is reported by the shockwave ring
          // and by the karts it throws, not by how much of the lens it covers.
          node.scale.setScalar(e.radius * e.scale * 0.45);
          node.rotation.set(e.age * 1.2, e.age * 1.7, 0);
          // The two fireball layers are fresnel shells, so their fade lives in
          // `uStrength`, not in an alpha the blend never reads.
          const fade = clamp01(e.life * 2.4);
          setOpacity(node, fade);
          setRimStrength(node, fade * 1.55);
          const ring = node.getObjectByName('ring');
          if (ring) ring.scale.setScalar(1 + e.age * 2.4);
          break;
        }
        case 'ring': {
          // Uniform, so the annuli keep their thickness and the dome stays a
          // dome. The ring is built at unit radius; the entity's radius is the
          // reach the damage pass actually used.
          const r = e.radius * e.scale;
          node.scale.set(r, r, r);
          const a = clamp01(e.life * 3.4);
          setOpacity(node, a * 0.9);
          setRimStrength(node, a * 1.2);
          break;
        }
        case 'ghost':
          node.rotation.set(0, e.yaw + Math.sin(e.spin) * 0.4, 0);
          node.position.y += Math.sin(time * 3 + e.ownerId) * 0.25;
          setOpacity(node, clamp01(e.life) * 0.8);
          break;
        case 'squid':
          node.rotation.set(-0.25, e.yaw, Math.sin(e.spin * 1.6) * 0.2);
          node.position.y += Math.sin(time * 4 + e.ownerId) * 0.3;
          setOpacity(node, clamp01(e.life * 1.5));
          break;
        case 'scorch': {
          // Two clocks. The embers are gone in a second, the mark takes the
          // rest of its life — a bob-omb should leave the road changed for
          // longer than the fireball was on it.
          const fade = clamp01(e.life / Math.max(0.01, e.life + e.age)) * clamp01(e.age * 6);
          const mark = node.getObjectByName('mark') as THREE.Mesh | undefined;
          if (mark) (mark.material as THREE.MeshBasicMaterial).opacity = fade;
          const ash = node.getObjectByName('ash') as THREE.Mesh | undefined;
          if (ash) {
            (ash.material as THREE.MeshBasicMaterial).opacity = fade * 0.5;
            // It spreads a little as it settles, which is the only motion a
            // mark on the road gets.
            ash.scale.setScalar(1 + clamp01(e.age * 0.7) * 0.16);
          }
          const embers = node.getObjectByName('embers') as THREE.Mesh | undefined;
          if (embers) {
            const k = clamp01(1 - e.age / 1.1);
            (embers.material as THREE.MeshBasicMaterial).opacity = k * k * 0.9;
            embers.scale.setScalar(1 + e.age * 0.22);
          }
          break;
        }
        case 'burst':
          // Billboarded: a flat starburst edge-on is no starburst at all. Kept
          // small — this is a punctuation mark on the hit, not the hit itself,
          // and one that fills the frame reads as a bug.
          node.lookAt(ctx.camera.position);
          node.rotateZ(e.spin);
          node.scale.setScalar(e.scale * 0.24);
          setOpacity(node, clamp01(e.life * 3.4) * 0.85);
          break;
        default: break;
      }
    }
  }

  return {
    list,
    init,
    spawn,
    fixedUpdate,
    update,

    clearNear(pos: THREE.Vector3, radius: number, except: number): number {
      let n = 0;
      const r2 = radius * radius;
      for (const e of list) {
        if (!e.active || e.ownerId === except) continue;
        if (e.kind === 'blast' || e.kind === 'ring' || e.kind === 'burst') continue;
        if (e.kind === 'scorch') continue;
        if (e.pos.distanceToSquared(pos) > r2) continue;
        release(e);
        n++;
      }
      return n;
    },

    clear(): void {
      for (const e of list) if (e.active) release(e);
    },

    dispose(): void {
      for (const e of list) if (e.active) release(e);
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
      });
      ctx.scene.remove(group);
      prototypes.clear();
      pools.clear();
    },
  };
}

/** Launch speeds, exported so the AI can decide whether a shot is worth taking. */
export const PROJECTILE_SPEED = { shell: SHELL_SPEED, red: RED_SPEED };
