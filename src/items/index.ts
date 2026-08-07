// The item system.
//
// Without this a kart racer is a time trial with traffic. With it, every lap has
// a story: you take the box on the racing line, the reel gives you a banana
// because you are winning, and the machine in eighth draws a bullet bill and
// arrives in your mirrors four seconds later.
//
// Three rules the whole module is built to.
//
//   *The draw is the comeback mechanic.* Position-weighted, MK8-style — see
//   defs.ts. Nothing else in the game closes a gap the way an item table does,
//   and nothing else ruins a race as fast as one that is flat.
//
//   *Everything is deterministic.* Every stochastic choice — the draw, whether
//   a CPU takes a shot — comes out of `ctx.rng`, never `Math.random`, and every
//   timer runs on the fixed step. A seed replays a race down to which corner
//   the third-place kart lost its shell on.
//
//   *A hit has to be legible.* You see the item coming, you see a burst in its
//   own colour when it lands, you spin, you drop coins, and you get half a
//   second of blinking invulnerability so the pack cannot chain you. Losing to
//   an item you never saw is the fastest way to make a player put the game down.
//
// Ownership: this module writes `racer.item`, `racer.itemCount`, `racer.coins`
// and its own `effects` flags, and it perturbs a kart only through the two
// entry points physics publishes — `boostRacer` and `stunRacer`. The one
// exception is the bullet bill, which by definition drives the kart for you.

import * as THREE from 'three';
import { clamp01, damp, lerp } from '../core/math.ts';
import { boostRacer, stunRacer } from '../physics/kart.ts';
import { buildRacingLine, type RacingLine } from '../track/racingline.ts';
import type { TrackSpline } from '../track/spline.ts';
import { drawItem, ITEMS, REEL_FACES, type ItemEntry } from './defs.ts';
import { createBoxField, PICK_RADIUS_SQ, type BoxField } from './boxes.ts';
import { COIN_PICK_SQ, createCoinField, type CoinField } from './coins.ts';
import {
  createEntityField, PROJECTILE_SPEED, type Entity, type EntityField,
} from './entities.ts';
import {
  buildBanana, buildBomb, buildBulletHusk, buildMushroom, buildShell, buildStarAura,
  cloneWithMaterials,
} from './models.ts';
import { createItemHud, type ItemHud } from './reel.ts';
import type {
  GameContext, GameSystem, ItemId, Racer, SplineSample, Surface,
} from '../types.ts';

// ── tuning ─────────────────────────────────────────────────────────────────

/** How long the reel spins. The player's is long enough to be a *beat*. */
const SPIN_PLAYER = 1.05;
const SPIN_CPU = 0.4;
/** Seconds between two uses of the same triple. */
const USE_LOCK = 0.22;
/** A tap throws forward; anything longer lays the item behind. */
const TAP_TIME = 0.24;
/** A held button eventually gives up and drops it, so a stuck input still plays. */
const HOLD_LIMIT = 1.1;

const STAR_TIME = 7.0;
const BULLET_TIME = 6.0;
const SHRUNK_TIME = 7.0;
const INK_TIME = 6.0;
const BOO_TIME = 4.5;
const BOMB_FUSE = 2.6;
const BLAST_RADIUS = 7.4;
const HORN_RADIUS = 9.5;

/** Coins spilled by a hit, and the ceiling the speed bonus stops at. */
const SPILL = 3;
const COIN_CAP = 10;

const OFFROAD: ReadonlySet<Surface> = new Set<Surface>(['dirt', 'grass', 'sand', 'water']);

// ── scratch ────────────────────────────────────────────────────────────────

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _to = new THREE.Vector3();
const _knock = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _sample: SplineSample = {
  pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
  right: new THREE.Vector3(), up: new THREE.Vector3(),
  width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
};

interface RacerItems {
  /** Roulette: seconds left, and what it will land on. */
  spin: number;
  spinTotal: number;
  pending: ItemEntry | null;
  reelTimer: number;
  reelIndex: number;
  /** Seconds since the item settled — the CPU's patience runs off this. */
  held: number;
  /** Seconds the use button has been down, and its state last step. */
  hold: number;
  wasDown: boolean;
  useLock: number;
  aiTimer: number;

  star: number;
  bullet: number;
  bulletDist: number;
  bulletLat: number;
  shrunk: number;
  ink: number;
  boo: number;
  booSteal: number;
  booTarget: number;

  /** Visual state, written only from `update`. */
  orbit: THREE.Group | null;
  orbitKey: string;
  aura: THREE.Object3D | null;
  husk: THREE.Object3D | null;
  scale: number;
  phase: number;
}

function newState(id: number): RacerItems {
  return {
    spin: 0, spinTotal: 1, pending: null, reelTimer: 0, reelIndex: 0,
    held: 0, hold: 0, wasDown: false, useLock: 0, aiTimer: 0.3,
    star: 0, bullet: 0, bulletDist: 0, bulletLat: 0,
    shrunk: 0, ink: 0, boo: 0, booSteal: 0, booTarget: -1,
    orbit: null, orbitKey: '', aura: null, husk: null, scale: 1,
    phase: id * 1.7,
  };
}

export function createItemSystem(ctx: GameContext): GameSystem {
  const boxes: BoxField = createBoxField(ctx);
  const coins: CoinField = createCoinField(ctx);
  const entities: EntityField = createEntityField(ctx);
  const hud: ItemHud = createItemHud();
  const states = new Map<number, RacerItems>();

  /** Everything this module hangs on a kart — orbits, auras, the bullet husk. */
  const rig = new THREE.Group();
  rig.name = 'itemRig';
  ctx.scene.add(rig);

  const heldProtos = new Map<string, THREE.Object3D>();
  let auraProto: THREE.Object3D | null = null;
  let huskProto: THREE.Object3D | null = null;
  let line: RacingLine | null = null;
  let visualTime = 0;

  /**
   * Drop one of this module's per-racer effect nodes.
   *
   * Geometry is shared with the prototype and must survive; the materials are
   * clones (an aura hue-cycles per racer) and belong to the copy, so they go.
   */
  function dropNode(node: THREE.Object3D | null): null {
    if (!node) return null;
    rig.remove(node);
    node.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      if (Array.isArray(m)) for (const x of m) x.dispose();
      else m.dispose();
    });
    return null;
  }

  const stateOf = (racer: Racer): RacerItems => {
    let s = states.get(racer.id);
    if (!s) { s = newState(racer.id); states.set(racer.id, s); }
    return s;
  };

  const classMul = (): number => ctx.config.race.classes[ctx.race.engineClass].speedMul;

  /** Absolute distance along the spline, straight off race progress — free,
   *  where a `nearest()` per racer per step would not be. */
  function lapDistance(racer: Racer): number {
    const track = ctx.track!;
    const L = track.length;
    const start = track.course.startDistance ?? 0;
    const d = ((racer.progress % L) + L) % L;
    return (d + start) % L;
  }

  const forwardOf = (racer: Racer, out: THREE.Vector3): THREE.Vector3 =>
    out.set(Math.sin(racer.yaw), 0, Math.cos(racer.yaw));

  const immune = (racer: Racer): boolean =>
    racer.effects.has('star') || racer.effects.has('bullet') || racer.invulnerable > 0;

  // ── coins ────────────────────────────────────────────────────────────────

  function addCoins(racer: Racer, n: number): void {
    if (n <= 0) return;
    const before = racer.coins;
    racer.coins = Math.min(COIN_CAP, racer.coins + n);
    if (racer.coins !== before) ctx.bus.emit('coin:get', { racer, total: racer.coins });
  }

  function spillCoins(racer: Racer): void {
    const drop = Math.min(racer.coins, SPILL);
    if (drop <= 0) return;
    racer.coins -= drop;
    coins.spill(racer.pos, racer.id, drop, racer.pos.y - 0.55);
    ctx.bus.emit('coin:lose', { racer, count: drop, total: racer.coins });
  }

  // ── being hit ────────────────────────────────────────────────────────────

  /**
   * The one place a racer is ever hurt by an item.
   *
   * Everything a hit costs lives here so it can never disagree with itself: the
   * burst in the item's own colour, the coins on the road, the trailing items
   * dropped, the stun, and the invulnerability that stops a pack from chaining
   * you from eighth to nowhere.
   */
  function strike(racer: Racer, by: Racer | null, item: ItemId,
    kind: 'spin' | 'squish' | 'bump' = 'spin'): boolean {
    if (immune(racer) || racer.finished) return false;
    const def = ITEMS[item];

    ctx.bus.emit('item:strike', { racer, by, item, kind });
    entities.spawn('burst', {
      pos: _pos.copy(racer.pos).setY(racer.pos.y + 0.6),
      life: 0.42, color: def.color, ownerId: by?.id ?? -1,
    });

    // Coins are the cost. The item in hand survives — losing the shell you were
    // saving *and* the two seconds is the kind of compounding punishment that
    // turns a comeback into a spiral.
    spillCoins(racer);
    stateOf(racer).hold = 0;

    stunRacer(ctx, racer, kind, by);

    // A star or a bullet does not tap you, it *throws* you. The impulse is
    // horizontal-plus-a-little-up: the lift is what makes the shove read, and
    // the tyres eat the sideways part again over the next half second exactly
    // the way they eat any other slide.
    if (by && (item === 'star' || item === 'bulletBill' || item === 'horn')) {
      _knock.subVectors(racer.pos, by.pos);
      _knock.y = 0;
      // Dead-centre contact has no direction of its own: shove them off the
      // striker's flank instead of leaving the impulse undefined.
      if (_knock.lengthSq() < 1e-4) _knock.set(Math.cos(by.yaw), 0, -Math.sin(by.yaw));
      _knock.normalize();
      racer.vel.addScaledVector(_knock, 11);
      racer.vel.y += 3.2;
    }

    if (racer.isPlayer) {
      hud.flash(def.color, 0.42);
      ctx.fx?.shake(0.9, 0.4);
    }
    return true;
  }

  function explode(pos: THREE.Vector3, ownerId: number): void {
    entities.spawn('blast', { pos, life: 0.55, radius: BLAST_RADIUS, ownerId });
    ctx.bus.emit('item:blast', { pos, ownerId, radius: BLAST_RADIUS });
    const owner = ctx.racers.find((r) => r.id === ownerId) ?? null;
    for (const racer of ctx.racers) {
      _to.subVectors(racer.pos, pos);
      if (_to.lengthSq() > BLAST_RADIUS * BLAST_RADIUS) continue;
      strike(racer, owner, 'bomb', 'spin');
    }
    entities.clearNear(pos, BLAST_RADIUS * 0.7, -1);
    if (ctx.player && ctx.player.pos.distanceToSquared(pos) < 900) {
      ctx.fx?.shake(clamp01(1 - ctx.player.pos.distanceTo(pos) / 30));
    }
  }

  // ── the roulette ─────────────────────────────────────────────────────────

  function startRoulette(racer: Racer, st: RacerItems): void {
    st.pending = drawItem(ctx.rng, racer.place, Math.max(2, ctx.racers.length));
    st.spinTotal = racer.isPlayer && !racer.ai
      ? SPIN_PLAYER
      : SPIN_CPU + (1 - (racer.ai?.skill ?? 0.8)) * 0.5;
    st.spin = st.spinTotal;
    st.reelTimer = 0;
    st.reelIndex = ctx.rng.int(0, REEL_FACES.length - 1);
    ctx.bus.emit('item:roulette', { racer, phase: 'start' });
    if (racer.isPlayer) hud.spinning(true);
  }

  function tickRoulette(racer: Racer, st: RacerItems, dt: number): void {
    if (st.spin <= 0) return;
    st.spin -= dt;
    st.reelTimer -= dt;
    if (st.reelTimer <= 0) {
      st.reelIndex = (st.reelIndex + 1) % REEL_FACES.length;
      // Decelerating: fast at the top, slowing into the answer. A reel that
      // stops at a constant rate has no ending.
      const t = 1 - clamp01(st.spin / st.spinTotal);
      st.reelTimer = lerp(0.05, 0.15, t * t);
      if (racer.isPlayer) hud.showFace(REEL_FACES[st.reelIndex]!);
    }
    if (st.spin <= 0) {
      const entry = st.pending ?? { id: 'banana' as ItemId, count: 1 };
      st.pending = null;
      st.spin = 0;
      st.held = 0;
      racer.item = entry.id;
      racer.itemCount = entry.count;
      ctx.bus.emit('item:get', { racer, item: entry.id, count: entry.count });
      ctx.bus.emit('item:roulette', { racer, phase: 'settle', item: entry.id });
      if (racer.isPlayer) {
        hud.spinning(false);
        hud.setItem(entry);
        hud.punch();
      }
    }
  }

  // ── pickups ──────────────────────────────────────────────────────────────

  function pickups(racer: Racer, st: RacerItems): void {
    const d = lapDistance(racer);

    if (!racer.item && st.spin <= 0 && !racer.effects.has('bullet')) {
      const near = boxes.candidates(d);
      for (let i = 0; i < near.length; i++) {
        const box = boxes.boxes[near[i]!]!;
        if (box.respawn > 0) continue;
        if (box.pos.distanceToSquared(racer.pos) > PICK_RADIUS_SQ + 1.4) continue;
        boxes.take(near[i]!);
        // The box has to *break*, not blink out. One burst, in its own warm
        // white, and the respawn pops back in four seconds later.
        entities.spawn('burst', { pos: box.pos, life: 0.34, color: 0xFFF3C4 });
        ctx.bus.emit('item:box', { racer, pos: box.pos });
        startRoulette(racer, st);
        break;
      }
    }

    const nearCoins = coins.candidates(d);
    let got = 0;
    for (let i = 0; i < nearCoins.length; i++) {
      const c = coins.coins[nearCoins[i]!]!;
      if (c.respawn > 0) continue;
      if (c.pos.distanceToSquared(racer.pos) > COIN_PICK_SQ + 0.9) continue;
      coins.take(nearCoins[i]!);
      got++;
    }
    got += coins.sweep(racer.pos, racer.id);
    addCoins(racer, got);
  }

  // ── deploying ────────────────────────────────────────────────────────────

  function racerAt(place: number): Racer | null {
    for (const r of ctx.racers) if (r.place === place) return r;
    return null;
  }

  function nearest(racer: Racer, ahead: boolean, maxDist: number): Racer | null {
    forwardOf(racer, _fwd);
    let best: Racer | null = null;
    let bestD = maxDist;
    for (const other of ctx.racers) {
      if (other === racer || other.finished) continue;
      _to.subVectors(other.pos, racer.pos);
      _to.y = 0;
      const d = _to.length();
      if (d > bestD || d < 0.001) continue;
      const along = _to.dot(_fwd) / d;
      if (ahead ? along < 0.55 : along > -0.55) continue;
      best = other;
      bestD = d;
    }
    return best;
  }

  function launchPoint(racer: Racer, forward: boolean, out: THREE.Vector3): THREE.Vector3 {
    forwardOf(racer, _fwd);
    return out.copy(racer.pos).addScaledVector(_fwd, forward ? 2.6 : -2.8);
  }

  function use(racer: Racer, st: RacerItems, forward: boolean): void {
    const id = racer.item;
    if (!id) return;
    const count = Math.max(1, racer.itemCount);

    if (count > 1) racer.itemCount = count - 1;
    else { racer.item = null; racer.itemCount = 0; }
    st.useLock = USE_LOCK;
    st.hold = 0;
    st.held = 0;
    if (racer.isPlayer) hud.setItem(racer.item ? { id: racer.item, count: racer.itemCount } : null);
    ctx.bus.emit('item:use', { racer, item: id, count, forward });

    forwardOf(racer, _fwd);
    const groundY = racer.pos.y - 0.55;

    switch (id) {
      case 'banana': {
        launchPoint(racer, forward, _pos);
        _vel.set(0, 0, 0);
        if (forward) _vel.copy(_fwd).multiplyScalar(19).setY(7.5);
        entities.spawn('banana', {
          ownerId: racer.id, pos: _pos, vel: _vel, life: 26, arm: 0.65,
          radius: 1.5, groundY,
        });
        break;
      }

      case 'greenShell': {
        launchPoint(racer, forward, _pos);
        _pos.y = racer.pos.y - 0.1;
        _vel.copy(_fwd).multiplyScalar(forward ? PROJECTILE_SPEED.shell : -PROJECTILE_SPEED.shell * 0.6);
        entities.spawn('greenShell', {
          ownerId: racer.id, pos: _pos, vel: _vel, life: 9, arm: 0.35,
          radius: 1.6, groundY,
        });
        break;
      }

      case 'redShell': {
        const target = forward ? racerAt(racer.place - 1) : null;
        if (!target) {
          // Nothing ahead, or laid backwards: it flies as a plain shell, which
          // is exactly what a red shell with nobody to chase should do.
          launchPoint(racer, forward, _pos);
          _pos.y = racer.pos.y - 0.1;
          _vel.copy(_fwd).multiplyScalar(forward ? PROJECTILE_SPEED.shell : -PROJECTILE_SPEED.shell * 0.6);
          entities.spawn('greenShell', {
            ownerId: racer.id, pos: _pos, vel: _vel, life: 8, arm: 0.35, radius: 1.6, groundY,
          });
          break;
        }
        const s = ctx.track!.spline.nearest(racer.pos, _sample);
        launchPoint(racer, true, _pos);
        entities.spawn('redShell', {
          ownerId: racer.id, pos: _pos, life: 13, arm: 0.25, radius: 1.9,
          targetId: target.id, dist: s.distance + 3, lat: s.lateral ?? 0,
        });
        break;
      }

      case 'bomb': {
        launchPoint(racer, forward, _pos);
        _vel.copy(_fwd).multiplyScalar(forward ? 24 : -7).setY(forward ? 9 : 3);
        entities.spawn('bomb', {
          ownerId: racer.id, pos: _pos, vel: _vel, life: BOMB_FUSE, arm: 0.4,
          radius: 1.9, groundY,
        });
        break;
      }

      case 'mushroom':
      case 'tripleMushroom':
        boostRacer(ctx, racer, 'mushroom',
          ctx.config.kart.boost.mushroom.time, ctx.config.kart.boost.mushroom.power);
        break;

      case 'star': {
        st.star = STAR_TIME;
        racer.effects.add('star');
        boostRacer(ctx, racer, 'star',
          ctx.config.kart.boost.star.time, ctx.config.kart.boost.star.power);
        ctx.bus.emit('item:effect', { racer, effect: 'star', on: true });
        if (racer.isPlayer) hud.flash(0xFFD84D, 0.35);
        break;
      }

      case 'bulletBill': startBullet(racer, st); break;

      case 'lightning': fireLightning(racer); break;

      case 'blooper': fireBlooper(racer); break;

      case 'boo': fireBoo(racer, st); break;

      case 'coin':
        // Two coins and a nudge — the leader's consolation prize, and still
        // worth having when you are one coin off the cap.
        addCoins(racer, 2);
        boostRacer(ctx, racer, 'mushroom', 0.25, 12);
        break;

      case 'horn': fireHorn(racer); break;

      default: break;
    }
  }

  // ── the big ones ─────────────────────────────────────────────────────────

  function startBullet(racer: Racer, st: RacerItems): void {
    const track = ctx.track;
    if (!track) return;
    const s = track.spline.nearest(racer.pos, _sample);
    st.bullet = BULLET_TIME;
    st.bulletDist = s.distance;
    st.bulletLat = s.lateral ?? 0;
    racer.effects.add('bullet');
    racer.stunned = 0;
    boostRacer(ctx, racer, 'bullet',
      ctx.config.kart.boost.bullet.time, ctx.config.kart.boost.bullet.power);
    ctx.bus.emit('item:effect', { racer, effect: 'bullet', on: true });
  }

  /**
   * The bullet drives. Position, heading and speed are taken off the spline
   * outright — this is the one item that is allowed to overrule the kart model,
   * because being driven is the whole fantasy of it.
   *
   * It runs *after* physics in the same step, so physics has already stored
   * `prevPos` and the render interpolation stays smooth.
   */
  function driveBullet(racer: Racer, st: RacerItems, dt: number): void {
    const track = ctx.track;
    if (!track) return;
    const speed = ctx.config.kart.maxSpeed * classMul() * 1.34;
    st.bulletDist += speed * dt;
    const target = line ? line.lateralAt(st.bulletDist) : 0;
    st.bulletLat = damp(st.bulletLat, target, 0.0002, dt);

    const s = track.spline.atDistance(st.bulletDist, _sample);
    racer.pos.copy(s.pos).addScaledVector(s.right, st.bulletLat).addScaledVector(s.up, 0.55);
    racer.yaw = Math.atan2(s.tangent.x, s.tangent.z);
    racer.speed = speed;
    racer.vel.copy(s.tangent).multiplyScalar(speed);
    racer.grounded = true;
    racer.airTime = 0;
    racer.surface = 'road';
    racer.stunned = 0;

    _fwd.copy(s.tangent);
    _up.copy(s.up);
    _right.crossVectors(_up, _fwd).normalize();
    _m.makeBasis(_right, _up, _fwd);
    racer.quat.setFromRotationMatrix(_m);

    // Anything in the way is scattered.
    for (const other of ctx.racers) {
      if (other === racer) continue;
      if (other.pos.distanceToSquared(racer.pos) > 9) continue;
      strike(other, racer, 'bulletBill', 'spin');
    }
  }

  function endBullet(racer: Racer): void {
    racer.effects.delete('bullet');
    racer.invulnerable = Math.max(racer.invulnerable, 0.6);
    // Land it on a mushroom rather than dropping the player off a cliff edge.
    boostRacer(ctx, racer, 'mushroom', 0.7, 26);
    ctx.bus.emit('item:effect', { racer, effect: 'bullet', on: false });
  }

  function fireLightning(user: Racer): void {
    for (const racer of ctx.racers) {
      if (racer === user || racer.finished) continue;
      if (racer.effects.has('star') || racer.effects.has('bullet')) continue;
      const st = stateOf(racer);
      st.shrunk = SHRUNK_TIME;
      racer.effects.add('shrunk');
      spillCoins(racer);
      // The item in hand is lost too — that is most of what lightning is for.
      racer.item = null;
      racer.itemCount = 0;
      st.spin = 0;
      st.pending = null;
      if (racer.isPlayer) hud.setItem(null);
      stunRacer(ctx, racer, 'bump', user);
      ctx.bus.emit('item:effect', { racer, effect: 'shrunk', on: true });
    }
    hud.flash(0xFFFCE0, 0.85);
    ctx.fx?.flash(0xFFFCE0, 0.9);
  }

  function fireBlooper(user: Racer): void {
    for (const racer of ctx.racers) {
      if (racer === user || racer.finished) continue;
      if (racer.place >= user.place) continue;
      if (racer.effects.has('star') || racer.effects.has('bullet')) continue;
      const st = stateOf(racer);
      st.ink = INK_TIME;
      racer.effects.add('inked');
      ctx.bus.emit('item:effect', { racer, effect: 'inked', on: true });
    }
    forwardOf(user, _fwd);
    entities.spawn('squid', {
      ownerId: user.id,
      pos: _pos.copy(user.pos).addScaledVector(_fwd, 3).setY(user.pos.y + 2.6),
      vel: _vel.copy(_fwd).multiplyScalar(26).setY(1.5),
      life: 3.2, yaw: user.yaw,
    });
  }

  function fireBoo(user: Racer, st: RacerItems): void {
    st.boo = BOO_TIME;
    user.effects.add('boo');
    user.invulnerable = Math.max(user.invulnerable, BOO_TIME);

    // Steal from someone ahead who actually has something worth taking.
    let victim: Racer | null = null;
    for (const racer of ctx.racers) {
      if (racer === user || !racer.item || racer.finished) continue;
      if (racer.place > user.place) continue;
      if (!victim || racer.place < victim.place) victim = racer;
    }
    st.booTarget = victim ? victim.id : -1;
    st.booSteal = victim ? 1.1 : 0;

    forwardOf(user, _fwd);
    entities.spawn('ghost', {
      ownerId: user.id,
      pos: _pos.copy(user.pos).setY(user.pos.y + 1.4),
      vel: _vel.copy(_fwd).multiplyScalar(victim ? 22 : 8).setY(1.2),
      life: BOO_TIME * 0.6, yaw: user.yaw,
    });
    ctx.bus.emit('item:effect', { racer: user, effect: 'boo', on: true });
  }

  function fireHorn(user: Racer): void {
    _pos.copy(user.pos);
    entities.spawn('ring', {
      ownerId: user.id, pos: _pos, life: 0.42, radius: HORN_RADIUS,
    });
    // The point of the horn: it deletes what is about to hit you. A red shell
    // has no other counter, and a game where the leader has no answer to one is
    // a game that punishes leading.
    entities.clearNear(_pos, HORN_RADIUS, user.id);
    for (const racer of ctx.racers) {
      if (racer === user) continue;
      if (racer.pos.distanceToSquared(user.pos) > HORN_RADIUS * HORN_RADIUS) continue;
      strike(racer, user, 'horn', 'spin');
    }
    ctx.fx?.shake(0.5, 0.3);
  }

  // ── input ────────────────────────────────────────────────────────────────

  function playerUse(racer: Racer, st: RacerItems, dt: number): void {
    const input = ctx.inputState;
    const down = input.item;
    const pressed = !!input.pressed.item;
    const def = ITEMS[racer.item!];

    if (def.mode === 'instant') {
      if (pressed) use(racer, st, true);
      st.wasDown = down;
      return;
    }

    if (down) st.hold += dt;
    if (pressed && !down) {
      // The harness' one-shot press: no hold to read, so it throws.
      use(racer, st, true);
    } else if (!down && st.wasDown) {
      use(racer, st, st.hold < TAP_TIME);
    } else if (down && st.hold > HOLD_LIMIT) {
      use(racer, st, false);
    }
    if (!down) st.hold = 0;
    st.wasDown = down;
  }

  /**
   * CPU item use. Not "fire on a timer": a CPU that throws a shell at an empty
   * road teaches the player that items are noise. Each item asks its own
   * question, and the answer is gated by a draw from `ctx.rng` so the field
   * does not act in unison.
   */
  function aiUse(racer: Racer, st: RacerItems, distance: number): void {
    const id = racer.item!;
    const def = ITEMS[id];
    const skill = racer.ai?.skill ?? 0.8;
    const patience = def.aiDelay * (1.6 - skill);
    if (st.held < patience) return;
    const chance = ctx.config.ai.itemUseChance;

    switch (id) {
      case 'mushroom':
      case 'tripleMushroom': {
        // On the grass, or lined up with something straight enough to spend it.
        const straight = Math.abs(ctx.track!.spline.atDistance(distance + 30, _sample).curvature) < 0.004;
        if (OFFROAD.has(racer.surface) || (straight && racer.speed > 12)) {
          if (ctx.rng.bool(chance)) use(racer, st, true);
        } else if (st.held > 6) use(racer, st, true);
        break;
      }
      case 'banana': {
        const behind = nearest(racer, false, 22);
        if (behind || st.held > 5) {
          if (ctx.rng.bool(chance)) use(racer, st, false);
        }
        break;
      }
      case 'greenShell': {
        const ahead = nearest(racer, true, 48);
        const behind = nearest(racer, false, 16);
        if (ahead && ctx.rng.bool(chance * skill)) use(racer, st, true);
        else if (behind && ctx.rng.bool(chance * 0.6)) use(racer, st, false);
        else if (st.held > 7) use(racer, st, true);
        break;
      }
      case 'redShell': {
        if (racer.place > 1 && ctx.rng.bool(chance)) use(racer, st, true);
        else if (st.held > 6) use(racer, st, false);
        break;
      }
      case 'bomb': {
        const ahead = nearest(racer, true, 34);
        const behind = nearest(racer, false, 18);
        if (ahead && ctx.rng.bool(chance)) use(racer, st, true);
        else if (behind && ctx.rng.bool(chance)) use(racer, st, false);
        else if (st.held > 6) use(racer, st, true);
        break;
      }
      case 'horn': {
        // Held for a red shell, which is what it is for. Otherwise, eventually.
        let inbound = false;
        for (const e of entities.list) {
          if (!e.active || e.kind !== 'redShell' || e.targetId !== racer.id) continue;
          if (e.pos.distanceToSquared(racer.pos) < 700) { inbound = true; break; }
        }
        if (inbound || st.held > 5) use(racer, st, true);
        break;
      }
      default:
        if (ctx.rng.bool(chance)) use(racer, st, true);
        break;
    }
  }

  // ── per-racer effects ────────────────────────────────────────────────────

  function tickEffects(racer: Racer, st: RacerItems, dt: number): void {
    if (st.star > 0) {
      st.star = Math.max(0, st.star - dt);
      if (st.star === 0) {
        racer.effects.delete('star');
        ctx.bus.emit('item:effect', { racer, effect: 'star', on: false });
      } else {
        for (const other of ctx.racers) {
          if (other === racer) continue;
          if (other.pos.distanceToSquared(racer.pos) > 10) continue;
          strike(other, racer, 'star', 'spin');
        }
      }
    }

    if (st.bullet > 0) {
      st.bullet = Math.max(0, st.bullet - dt);
      if (st.bullet === 0) endBullet(racer);
      else driveBullet(racer, st, dt);
    }

    if (st.shrunk > 0) {
      st.shrunk = Math.max(0, st.shrunk - dt);
      // Shrinking is a speed cap, applied after physics has had its say. The
      // kart still drives — it is simply small, slow and squashable.
      const cap = ctx.config.kart.maxSpeed * classMul() * 0.62;
      if (racer.speed > cap) racer.speed = cap;
      if (st.shrunk === 0) {
        racer.effects.delete('shrunk');
        ctx.bus.emit('item:effect', { racer, effect: 'shrunk', on: false });
      }
    }

    if (st.ink > 0) {
      st.ink = Math.max(0, st.ink - dt);
      if (st.ink === 0) {
        racer.effects.delete('inked');
        ctx.bus.emit('item:effect', { racer, effect: 'inked', on: false });
      } else if (racer.ai) {
        // A CPU cannot see the ink, so the ink has to reach the steering: a
        // slow, deterministic wander it has to fight all the way down the road.
        racer.yaw += Math.sin(ctx.race.time * 4.2 + racer.id * 2.1) * 0.5 * dt;
      }
    }

    if (st.boo > 0) {
      st.boo = Math.max(0, st.boo - dt);
      racer.invulnerable = Math.max(racer.invulnerable, Math.min(st.boo, 0.2));
      if (st.booSteal > 0) {
        st.booSteal = Math.max(0, st.booSteal - dt);
        if (st.booSteal === 0) {
          const victim = ctx.racers.find((r) => r.id === st.booTarget);
          if (victim?.item) {
            const stolen: ItemEntry = { id: victim.item, count: Math.max(1, victim.itemCount) };
            victim.item = null;
            victim.itemCount = 0;
            if (victim.isPlayer) hud.setItem(null);
            racer.item = stolen.id;
            racer.itemCount = stolen.count;
            if (racer.isPlayer) { hud.setItem(stolen); hud.punch(); }
            ctx.bus.emit('item:steal', { racer, from: victim, item: stolen.id });
            ctx.bus.emit('item:get', { racer, item: stolen.id, count: stolen.count });
          }
        }
      }
      if (st.boo === 0) {
        racer.effects.delete('boo');
        ctx.bus.emit('item:effect', { racer, effect: 'boo', on: false });
      }
    }
  }

  /** A shrunk kart under the wheels of a full-size one. */
  function squishPass(): void {
    for (const small of ctx.racers) {
      if (!small.effects.has('shrunk') || small.invulnerable > 0) continue;
      for (const big of ctx.racers) {
        if (big === small || big.effects.has('shrunk')) continue;
        if (big.pos.distanceToSquared(small.pos) > 6.5) continue;
        if (big.speed < small.speed + 2) continue;
        strike(small, big, 'lightning', 'squish');
        break;
      }
    }
  }

  // ── entity callbacks ─────────────────────────────────────────────────────

  function onHit(e: Entity, racer: Racer): boolean {
    const owner = ctx.racers.find((r) => r.id === e.ownerId) ?? null;

    if (racer.effects.has('star') || racer.effects.has('bullet')) {
      // Ploughed straight through it. The item is gone, the racer is not.
      entities.spawn('burst', {
        pos: _pos.copy(e.pos).setY(e.pos.y + 0.4), life: 0.35,
        color: racer.effects.has('star') ? 0xFFD84D : 0xBFD6FF,
      });
      return true;
    }
    if (racer.invulnerable > 0 || racer.stunned > 0) return false;

    if (e.kind === 'bomb') {
      explode(e.pos, e.ownerId);
      return true;
    }
    const item: ItemId = e.kind === 'banana' ? 'banana'
      : e.kind === 'redShell' ? 'redShell' : 'greenShell';
    return strike(racer, owner, item, 'spin');
  }

  function onExpire(e: Entity): void {
    if (e.kind === 'bomb') explode(e.pos, e.ownerId);
  }

  // ── visuals ──────────────────────────────────────────────────────────────

  function heldPrototype(id: ItemId): THREE.Object3D | null {
    const key = id;
    let proto = heldProtos.get(key);
    if (proto) return proto;
    switch (id) {
      case 'banana': proto = buildBanana(); break;
      case 'greenShell': proto = buildShell(0x46D63C, 0x2C9A2A); break;
      case 'redShell': proto = buildShell(0xF03A2E, 0xB0231A); break;
      case 'bomb': proto = buildBomb(); break;
      case 'mushroom':
      case 'tripleMushroom': proto = buildMushroom(); break;
      default: return null;
    }
    heldProtos.set(key, proto);
    return proto;
  }

  /**
   * What the kart is visibly carrying. A triple orbits; a single aim item
   * trails behind while the button is held, which is the tell that says a
   * banana is about to be laid in front of you.
   */
  function syncCarried(racer: Racer, st: RacerItems): void {
    const id = racer.item;
    const def = id ? ITEMS[id] : null;
    const trailing = !!def && def.mode === 'aim' && racer.itemCount <= 1
      && racer.isPlayer && !racer.ai && st.hold > 0.05;
    const shown = !id || racer.stunned > 0 ? 0
      : racer.itemCount > 1 ? racer.itemCount
        : trailing ? 1 : 0;
    const key = `${id ?? ''}:${shown}`;

    if (key !== st.orbitKey) {
      st.orbitKey = key;
      if (st.orbit) { rig.remove(st.orbit); st.orbit = null; }
      const proto = shown > 0 && id ? heldPrototype(id) : null;
      if (proto) {
        const group = new THREE.Group();
        for (let i = 0; i < shown; i++) {
          // The prototypes live in the scene hidden, so their shaders are built
          // before the race — the copies have to be switched back on.
          const copy = proto.clone(true);
          copy.visible = true;
          group.add(copy);
        }
        rig.add(group);
        st.orbit = group;
      }
    }
    if (!st.orbit) return;

    const n = st.orbit.children.length;
    const trail = n === 1 && racer.itemCount <= 1;
    forwardOf(racer, _fwd);
    for (let i = 0; i < n; i++) {
      const node = st.orbit.children[i]!;
      if (trail) {
        node.position.copy(racer.pos).addScaledVector(_fwd, -2.4);
        node.position.y = racer.pos.y - 0.35;
        node.rotation.y = racer.yaw;
      } else {
        const a = st.phase + visualTime * 1.9 + (i / n) * Math.PI * 2;
        node.position.set(
          racer.pos.x + Math.sin(a) * 2.15,
          racer.pos.y - 0.1 + Math.sin(visualTime * 3 + a) * 0.08,
          racer.pos.z + Math.cos(a) * 2.15);
        node.rotation.y = -a;
      }
    }
  }

  function syncAura(racer: Racer, st: RacerItems, dt: number): void {
    // Star.
    if (st.star > 0) {
      if (!st.aura) {
        st.aura = cloneWithMaterials(auraProto!);
        st.aura.visible = true;
        rig.add(st.aura);
      }
      st.aura.position.copy(racer.pos);
      const shell = st.aura.getObjectByName('shell') as THREE.Mesh | undefined;
      if (shell) {
        const m = shell.material as THREE.MeshBasicMaterial;
        // Hue cycle: the one place in this game that is allowed to be garish.
        m.color.setHSL((visualTime * 1.6) % 1, 0.85, 0.62);
        m.opacity = (st.star < 1.5 ? clamp01(st.star * 2) : 1) * (0.22 + Math.sin(visualTime * 18) * 0.06);
      }
      for (let i = 0; i < 5; i++) {
        const s = st.aura.getObjectByName(`spark${i}`);
        if (!s) continue;
        const a = visualTime * 4.5 + (i / 5) * Math.PI * 2;
        s.position.set(Math.sin(a) * 1.8, 0.5 + Math.sin(a * 2.3) * 0.7, Math.cos(a) * 1.8);
        s.rotation.z = a * 2;
        (s as THREE.Mesh & { material: THREE.MeshBasicMaterial }).material.opacity =
          0.5 + Math.sin(a * 3) * 0.45;
      }
    } else if (st.aura) {
      st.aura = dropNode(st.aura);
    }

    // Bullet bill: a casing thrown around whatever machine you brought.
    if (st.bullet > 0) {
      if (!st.husk) {
        st.husk = cloneWithMaterials(huskProto!);
        st.husk.visible = true;
        rig.add(st.husk);
      }
      st.husk.position.copy(racer.pos);
      st.husk.position.y -= 0.5;
      st.husk.rotation.y = racer.yaw;
      const flare = st.husk.getObjectByName('flare') as THREE.Mesh | undefined;
      if (flare) {
        flare.scale.set(1, 0.8 + Math.sin(visualTime * 40) * 0.25, 1);
        (flare.material as THREE.MeshBasicMaterial).opacity =
          0.4 + Math.sin(visualTime * 33) * 0.15;
      }
    } else if (st.husk) {
      st.husk = dropNode(st.husk);
    }

    // Shrunk. Scale is the one channel on a racer's model nobody else writes —
    // and it is only ever touched while an item is actually holding it away
    // from 1, so a racer nothing has happened to is left entirely alone.
    const root = racer.model?.root;
    if (root && (st.shrunk > 0 || st.scale !== 1)) {
      st.scale = damp(st.scale, st.shrunk > 0 ? 0.5 : 1, 0.0005, dt);
      if (Math.abs(st.scale - 1) < 0.004) st.scale = 1;
      root.scale.setScalar(st.scale);
    }
  }

  // ── the system ───────────────────────────────────────────────────────────

  const system: GameSystem = {
    name: 'items',
    order: 50,

    init(): void {
      entities.init();
      // The effect rigs exist from the start, hidden, so their programs are
      // built with everything else instead of stalling the frame a star fires
      // on. Both are cloned per racer; these two are only ever the source.
      auraProto = buildStarAura();
      auraProto.visible = false;
      rig.add(auraProto);
      huskProto = buildBulletHusk();
      huskProto.visible = false;
      rig.add(huskProto);
      // Carried items reuse the projectile models, except the mushroom, which
      // is never a projectile and would otherwise compile mid-race.
      for (const id of ['banana', 'greenShell', 'redShell', 'bomb', 'mushroom'] as ItemId[]) {
        const proto = heldPrototype(id);
        if (proto && !proto.parent) { proto.visible = false; rig.add(proto); }
      }
      hud.build();
    },

    reset(): void {
      entities.clear();
      for (const st of states.values()) {
        if (st.orbit) rig.remove(st.orbit);
        dropNode(st.aura);
        dropNode(st.husk);
      }
      states.clear();
      hud.setItem(null);
      hud.spinning(false);
      hud.setInk(0);

      const track = ctx.track;
      if (!track) return;
      // The line is the item system's map of the circuit: where the coins go,
      // and the rail a bullet bill drives.
      line = buildRacingLine(track.spline as unknown as TrackSpline, 3.2);
      boxes.rebuild(track);
      coins.rebuild(track, line);

      // Pay for every shader this module will ever need, here, once, while the
      // grid is still forming. A material three has not seen before compiles on
      // the frame it is first drawn, and on a software renderer that is a
      // multi-second stall — which would land on the frame a shell is fired, a
      // bob-omb goes off or a star lights up. `compile` walks the whole scene,
      // so anything else that is in it and hidden gets warmed too.
      ctx.renderer?.compile?.(ctx.scene, ctx.camera);
    },

    fixedUpdate(dt: number): void {
      boxes.fixedUpdate(dt);
      coins.fixedUpdate(dt);
      if (!ctx.track) return;

      const phase = ctx.race.phase;
      const live = phase === 'racing' || phase === 'finished';

      for (const racer of ctx.racers) {
        const st = stateOf(racer);
        if (st.useLock > 0) st.useLock = Math.max(0, st.useLock - dt);
        tickEffects(racer, st, dt);
        if (!live || racer.finished) continue;

        pickups(racer, st);
        tickRoulette(racer, st, dt);

        if (racer.item && racer.stunned <= 0 && st.useLock <= 0 && st.bullet <= 0) {
          st.held += dt;
          if (racer.ai) {
            st.aiTimer -= dt;
            if (st.aiTimer <= 0) {
              st.aiTimer = 0.2;
              aiUse(racer, st, lapDistance(racer));
            }
          } else {
            playerUse(racer, st, dt);
          }
        } else if (!racer.item) {
          // Keep the button's edge state fresh with an empty slot, or the frame
          // an item lands on is also the frame it is thrown away.
          st.hold = 0;
          if (racer.isPlayer && !racer.ai) st.wasDown = ctx.inputState.item;
        }
      }

      entities.fixedUpdate(dt, onHit, onExpire);
      squishPass();
    },

    update(dt: number, alpha: number): void {
      visualTime += dt;
      boxes.update(dt, visualTime);
      // The coin field draws a window around whoever the camera is following.
      coins.update(visualTime, ctx.player && ctx.track ? lapDistance(ctx.player) : 0);
      entities.update(dt, alpha, visualTime);

      for (const racer of ctx.racers) {
        const st = states.get(racer.id);
        if (!st) continue;
        syncCarried(racer, st);
        syncAura(racer, st, dt);
      }

      const player = ctx.player;
      if (player) {
        // Ink lands hard and then drains: full strength for about a second, and
        // thinning from there. Holding it opaque for six seconds is not a
        // handicap, it is a blindfold.
        const st = states.get(player.id);
        const t = st ? clamp01(st.ink / INK_TIME) : 0;
        hud.setInk(t > 0 ? 0.3 + 0.48 * Math.pow(t, 0.7) : 0);
      }
      hud.update(dt);
    },

    dispose(): void {
      entities.dispose();
      boxes.dispose();
      coins.dispose();
      hud.dispose();
      ctx.scene.remove(rig);
      states.clear();
      heldProtos.clear();
    },
  };

  // Reviewer's bench. `__ITEMS.give('redShell')` puts one in the player's hand
  // so a shot can be set up by hand; `state()` is the read-only picture of who
  // is holding what. Neither is used by the simulation.
  if (typeof globalThis !== 'undefined') {
    (globalThis as unknown as Record<string, unknown>).__ITEMS = {
      give(id: ItemId, count = 1, racerId = ctx.player?.id ?? 0): boolean {
        const racer = ctx.racers.find((r) => r.id === racerId);
        if (!racer) return false;
        const st = stateOf(racer);
        st.spin = 0;
        st.pending = null;
        st.held = 0;
        racer.item = id;
        racer.itemCount = count;
        if (racer.isPlayer) { hud.setItem({ id, count }); hud.punch(); }
        return true;
      },
      /** Metres to the next item box ahead of a racer, and where it is. */
      nextBox(racerId = ctx.player?.id ?? 0): { gap: number; pos: number[] } | null {
        const racer = ctx.racers.find((r) => r.id === racerId);
        const track = ctx.track;
        if (!racer || !track) return null;
        const here = lapDistance(racer);
        let best: { gap: number; pos: number[] } | null = null;
        for (const b of boxes.boxes) {
          if (b.respawn > 0) continue;
          const gap = track.spline.forwardDistance(here, b.distance);
          if (!best || gap < best.gap) best = { gap, pos: [b.pos.x, b.pos.y, b.pos.z] };
        }
        return best;
      },
      state(): Record<string, unknown> {
        return {
          boxes: boxes.boxes.length,
          boxesTaken: boxes.boxes.filter((b) => b.respawn > 0).length,
          coins: coins.coins.length,
          entities: entities.list.filter((e) => e.active).map((e) => e.kind),
          racers: ctx.racers.map((r) => ({
            name: r.name, place: r.place, item: r.item, count: r.itemCount,
            coins: r.coins, effects: Array.from(r.effects),
          })),
        };
      },
    };
  }

  return system;
}

export default createItemSystem;
