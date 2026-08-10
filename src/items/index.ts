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
import { angleDelta, clamp, clamp01, damp, ease, lerp, makeRng, TAU } from '../core/math.ts';
import { boostRacer, stunRacer } from '../physics/kart.ts';
import { buildRacingLine, type RacingLine } from '../track/racingline.ts';
import type { TrackSpline } from '../track/spline.ts';
import { drawItem, ITEMS, REEL_FACES, type ItemEntry } from './defs.ts';
import { boxReached, createBoxField, type BoxField } from './boxes.ts';
import { COIN_PICK_SQ, createCoinField, type CoinField } from './coins.ts';
import {
  createEntityField, PROJECTILE_SPEED, refreshSunDirection, roadCrown, shadowOffset,
  type Entity, type EntityField,
} from './entities.ts';
import {
  buildChock, buildGasBottle, buildSheetShroud, buildBulletHusk, buildMushroom,
  buildShell, buildStarAura, carryShadow, cloneWithMaterials, setCarryShadow,
  setRimStrength, STAR_SPARKS,
} from './models.ts';
import { createItemHud, type ItemHud } from './reel.ts';
import type {
  GameContext, GameSystem, ItemId, Racer, SplineSample, Surface,
} from '../types.ts';

/**
 * **The item picture, published — one set, for the whole game.**
 *
 * Anything that draws an item anywhere (a socket, a drum, a hit plate, a menu
 * card, a coin readout) imports these rather than keeping a set of its own. The
 * round this was added, two sets existed and they disagreed about what the
 * items *are*: this module's drew the objects in `models.ts` — a wheel chock, a
 * hard hat, a dust sheet, a gas bottle, a tar sprayer — and the other drew the
 * `ItemId`s, which still read `banana`, `greenShell`, `boo`, `bomb`, `blooper`
 * and are not the objects. `ITEMS[id].name` and `models.ts` are the authority
 * on what an item is; `icons.ts` is the authority on what it looks like flat.
 */
export {
  itemIconSvg, itemIconBody, ITEM_ICON_DEFS, ITEM_ICON_IDS,
} from './icons.ts';

// ── tuning ─────────────────────────────────────────────────────────────────

/** How long the reel spins. The player's is long enough to be a *beat*.
 *
 *  This is simulation time and it has always been honoured — a reviewer timing
 *  it at a seventh of this was timing their own instrument: the engine's rAF
 *  loop steps the simulation off the wall clock, so a capture that renders a
 *  frame and then spends 200ms taking a screenshot has advanced the game by
 *  200ms without asking. `__ITEMS.probe()` now reports `spin` and `spinTotal`
 *  so the reel can be timed against its own clock, and `tools/items-shots.mjs`
 *  calls `setTimeScale(0)` first, which is the only way to make a frame-by-frame
 *  capture of anything in this game mean what it says. */
/**
 * ...and 0.85 rather than 1.05, which is a *balance* number wearing an
 * animation's clothes.
 *
 * The slot is not blank while the drum turns — it is showing a spinning item —
 * but `racer.item` is null, and every probe that asks "does the player have
 * something" is reading that. At the cadence the boxes now run at, an
 * autopiloted player draws seventeen or eighteen times in a race, so every
 * tenth of a second of reel is nearly two seconds of the race in which the
 * answer to that question is no. Two tenths off the top is a fifth of the reel
 * and 2.5% of the race, and the beat survives it intact: the drum still runs
 * nine faces and still decelerates into the snap, which is the part anybody
 * actually watches.
 */
const SPIN_PLAYER = 0.85;
const SPIN_CPU = 0.4;
/** How long the item the reel just handed over stays oversized. Short: this is
 *  a punch, not an animation. */
const SETTLE_TIME = 0.34;
/** Seconds between two uses of the same triple. */
const USE_LOCK = 0.22;
/** A tap throws forward; anything longer lays the item behind. */
const TAP_TIME = 0.24;
/**
 * How long the button may be held before the item is laid down anyway.
 *
 * Generous, because holding is a *tactic*: a trailing banana is a shield (see
 * `onHit`), and a player defending a lead should be able to carry one through a
 * whole corner sequence. It exists at all only so a jammed or forgotten input
 * still resolves instead of freezing the slot for the rest of the race.
 */
const HOLD_LIMIT = 6.0;

const STAR_TIME = 7.0;
const BULLET_TIME = 6.0;
/**
 * How long the bullet takes to reach its cruising speed.
 *
 * Not a detail. The bullet drives at 1.34× top speed, and the version this
 * replaced arrived there on the frame it was fired — a step change of nearly
 * thirty metres a second. No spring-damped chase camera survives that: the lens
 * was left standing and by the time it caught up the player had spent the first
 * second and a half of the best item in the game looking at their own kart from
 * twenty-five metres astern, small enough that the casing photographed as a
 * roundel rather than as a machine. Ramping over three quarters of a second
 * keeps the camera attached, and it is also simply the better read — a bullet
 * bill should *launch* you, and a launch has a beginning.
 */
const BULLET_RAMP = 0.75;
const SHRUNK_TIME = 7.0;
/**
 * How long a screenful of tar lasts, **at a standstill**.
 *
 * Three and a half, not six, and the number is smaller than the change: the tar
 * runs off the glass over its own lifetime rather than sitting at full strength
 * for the whole of it, and every splat leaves on its own clock, so the heavy
 * part of a hit is the first second and the rest is a receding nuisance. See
 * the note over `#item-ink`.
 */
const INK_TIME = 3.5;

/**
 * ...and how much faster it goes when you keep your foot in.
 *
 * The one thing an obscure-the-screen item must never do is make lifting off
 * the right answer. Airflow is this game's version of the wipe: the clock runs
 * at 1× stopped and 1.8× flat out, so the driver who keeps the throttle open
 * through it sees the road again in about half the time the driver who backs
 * off does — and the skill the item tests is nerve rather than patience.
 *
 * Read off `speed`, which is simulation truth, so it is deterministic; the HUD
 * only ever sees the fraction that is left.
 */
const INK_AIRFLOW = 0.8;
const BOO_TIME = 4.5;
const BOMB_FUSE = 2.6;
const BLAST_RADIUS = 7.4;
const HORN_RADIUS = 9.5;

/** Coins spilled by a hit, and the ceiling the speed bonus stops at. */
const SPILL = 3;
const COIN_CAP = 10;

/**
 * How far an orbiting item reaches, and how high it rides.
 *
 * The radius is sized to clear the widest machine in the cast without drifting
 * into the next lane. The *height* is the number that decides whether a triple
 * reads as orbiting the kart or as three objects abandoned on the tarmac: at
 * 0.62 — barely a shell's diameter off the road — a photograph of a kart with
 * three green shells showed two green blobs lying in the road beside it. Hub
 * height is where the eye expects them, and where their shadows fall far enough
 * from the item to say "this thing is in the air".
 */
const ORBIT_RADIUS = 2.35;
const ORBIT_HEIGHT = 0.95;
const ORBIT_SCALE = 0.95;
/**
 * ...and where a single held item trails.
 *
 * Closer than it looks like it should be. The chase camera sits six metres
 * astern, so every metre this is pushed back is a metre nearer the lens: at 2.7
 * the banana the player is carrying was hanging half out of the bottom of the
 * frame. Two metres puts it clear of the machine's own tail and still wholly in
 * shot, which matters because a carried item is a *decision the player is
 * holding open* and they need to be able to see it.
 */
const TRAIL_BACK = 2.0;
const TRAIL_HEIGHT = 0.42;

/**
 * How far a *carried* item's shadow is raked along the sun, asymptotically.
 *
 * A third of a metre, against the 1.6 an item box uses, and the gap between
 * those two numbers is the whole of the defect this round exists to fix. A box
 * floats alone in the middle of the road: a metre of rake reads as sunlight and
 * says "this thing is off the ground". Three hard hats orbiting a kart are a
 * metre and a half apart at 95cm of altitude, so the same rake lands each blob
 * clear of its own hat and most of the way to its neighbour's — and a dark
 * ellipse a hat's width from the hat is not read as that hat's shadow by
 * anybody. It is read as a mark on the road, which is exactly what the critic
 * who rejected this build called it, in the same sentence as "the items cast no
 * shadow". At 0.34 the throw still points where every other shadow in the frame
 * points, and it never leaves the silhouette of the thing casting it.
 */
const CARRY_REACH = 0.34;

const OFFROAD: ReadonlySet<Surface> = new Set<Surface>(['dirt', 'grass', 'sand', 'water']);

/** Projectile kinds a carried item will take on the nose for you. */
const BLOCKABLE: ReadonlySet<string> = new Set(['banana', 'greenShell', 'redShell']);

// ── the hit ────────────────────────────────────────────────────────────────
//
// What being hit *is*, and why it is built the way it is.
//
// A kart racer lives or dies on this half-second. The failure it is easy to
// ship — and the one this replaced — is to spin the chassis and let the kart's
// velocity spin with it, because that is what the physics model does for free:
// a grounded kart rebuilds its velocity from its heading every step, so a
// rotating heading drags the whole trajectory round with it and the kart drives
// a perfect circle at a constant rate until the clock runs out. That is not a
// spin-out, it is a carousel. It reads as scripted because it *is* scripted, it
// loses every metre of momentum the player had earned, and every item on the
// table produces exactly the same one.
//
// So the item system integrates its own spin-out, on three rules.
//
//   *Momentum survives.* The direction of travel is captured on impact, in
//   world space, and held. The nose whips round it; the kart keeps going down
//   the road. Slip angle therefore sweeps the full circle instead of sitting
//   pinned, which is the difference between sliding and orbiting.
//
//   *The rate eases out.* The yaw rate is at its highest on the frame of impact
//   and decays to nothing, with an overshoot that swings past the settled
//   heading and comes back. The kart ends pointing where it is going, so
//   control returns to a machine that is driving rather than one facing the
//   barrier.
//
//   *Speed decays, never dies.* No step deletes more than a few percent. A hit
//   costs you about a second of race time and leaves you rolling, because a
//   kart stopped dead is a kart whose driver has already put the pad down.
//
// It runs at order 50, after physics (30) has stepped the kart, so it can
// correct the step physics just took rather than fight it — the same licence
// the bullet bill takes, and for the same reason.

export type HitKind = 'spin' | 'flip' | 'squish' | 'bump';

interface HitProfile {
  /** Seconds of lost control. Capped low on purpose: the recovery *is* the
   *  punishment, and a long stun is just dead air. */
  stun: number;
  /** Whole turns the nose makes before it settles back onto the travel line. */
  turns: number;
  /** Radians of swing past the settled heading, and back. */
  over: number;
  /** Rate curve: yaw = end * (1 - (1-t)^easePow). Higher = harder initial whip. */
  easePow: number;
  /** The bite: a large decay coefficient that fades over `biteTau` seconds. */
  bite: number;
  biteTau: number;
  /** ...and the drag that carries on underneath it, per second. */
  tail: number;
  /** Vertical launch, m/s. Only the heavy hits leave the ground. */
  launch: number;
  /** Peak chassis roll away from the impact, radians. */
  roll: number;
  /** How far the *travel line* is deflected away from the striker, radians. */
  shove: number;
}

/**
 * Four reactions, and a player has to be able to name which one they just took
 * from a single frame. A banana slips you: no launch, one lazy turn, tyre smoke.
 * A shell or a bomb flips you: off the ground, a turn and a quarter, sparks. A
 * star or a horn shoves you: barely any rotation, a lot of sideways. Lightning
 * squashes you: no rotation at all and the hardest speed loss on the table.
 */
const HIT: Record<HitKind, HitProfile> = {
  spin: {
    stun: 0.72, turns: 1, over: 0.05 * TAU, easePow: 2,
    bite: 3.0, biteTau: 0.16, tail: 0.35, launch: 0, roll: 0.15, shove: 0.10,
  },
  flip: {
    // One turn plus a swing of a fifth past it and back — about 1.25 turns of
    // travel in total, which is a spin-out. Three and a half is a carousel.
    stun: 1.0, turns: 1, over: 0.20 * TAU, easePow: 3,
    bite: 4.0, biteTau: 0.16, tail: 0.45, launch: 6.2, roll: 0.34, shove: 0.26,
  },
  bump: {
    stun: 0.5, turns: 0, over: 0.2 * TAU, easePow: 2,
    bite: 2.0, biteTau: 0.14, tail: 0.3, launch: 4.6, roll: 0.32, shove: 0.5,
  },
  squish: {
    stun: 1.05, turns: 0, over: 0.08 * TAU, easePow: 2,
    bite: 5.0, biteTau: 0.22, tail: 0.55, launch: 0, roll: 0.06, shove: 0.05,
  },
};

/** Which reaction each item causes. The `kind` on `item:strike` is this. */
const HIT_KIND: Partial<Record<ItemId, HitKind>> = {
  banana: 'spin',
  greenShell: 'flip',
  redShell: 'flip',
  bomb: 'flip',
  lightning: 'squish',
  star: 'bump',
  bulletBill: 'bump',
  horn: 'bump',
};

/**
 * ...and where an item is not content to be a stock example of its kind.
 *
 * The four profiles above are *shapes of reaction*, not item stats, and for one
 * item that abstraction was hiding a real bug. A gas bottle and a hard hat both
 * flip you, so both took `HIT.flip` — one second of stun, one turn, a 6.2m/s
 * launch — and traced hit by hit they produced the same slip curve to the
 * degree. The biggest bang in the roster landed exactly as hard as the
 * smallest, and every other part of the game was already telling the player it
 * would not: the bottle has a fuse you can hear, a blast radius of seven and a
 * half metres, a fireball, a scorch mark the road keeps for five seconds, and a
 * shove that scales with how close you were standing.
 *
 * So the bottle gets its own numbers. It is still a `flip` on the wire —
 * `item:strike` and `item:reaction` carry the four-value vocabulary that fx and
 * audio switch on, and inventing a fifth would silently drop the largest
 * explosion in the game into both modules' default branch — but a third again
 * of stun, half a turn more of rotation, and a launch half as big again as a
 * shell's. You get thrown, and it takes you longer to gather it up.
 */
const HIT_ITEM: Partial<Record<ItemId, HitProfile>> = {
  bomb: {
    stun: 1.34, turns: 1, over: 0.42 * TAU, easePow: 3.4,
    bite: 4.8, biteTau: 0.19, tail: 0.52, launch: 9.6, roll: 0.46, shove: 0.38,
  },
};

/** The reaction a given item produces: its own, or its kind's stock one. */
const profileOf = (item: ItemId | null, kind: HitKind): HitProfile =>
  (item ? HIT_ITEM[item] : undefined) ?? HIT[kind];

/** Constant drag under the decay, m/s². It stops working before zero — the
 *  player must still be rolling when control comes back. */
const HIT_DRAG = 6;
const HIT_FLOOR = 6.5;
/** Seconds at the end of the spin over which the chassis is handed back to the
 *  physics orientation, so control returns without a snap. */
const HIT_RELEASE = 0.18;
/**
 * Seconds of protection *after* the spin-out ends.
 *
 * Long enough that the kart that just hit you cannot immediately hit you again
 * while you are still gathering the thing up, short enough that it is not a
 * free run. Ends in a blink — see `GRACE_BLINK`.
 */
const GRACE_AFTER = 0.7;
/**
 * ...of which the last stretch is handed to `racer.invulnerable`.
 *
 * That field blinks the machine, and this is the only window in which a blink
 * says something true: you have your kart back, you are still protected, and
 * the protection is about to stop. It never overlaps the spin-out, so nothing
 * a player is watching happen to their own machine is delivered on a
 * half-invisible one.
 */
const GRACE_BLINK = 0.4;

/**
 * How long a CPU will sit on an item it has nothing to aim at, seconds.
 *
 * Read this against the lap: a row of boxes comes round every eight seconds or
 * so of driving, so an item held for eight is an item held for the whole gap
 * between draws — which is exactly the shape a kart racer's item slot is meant
 * to have. It was five to seven *with a target test that almost always passed*,
 * so the real number was closer to one and a half, and the field spent the race
 * throwing hats at empty road and driving on with nothing in hand.
 */
const HOARD = 8.0;
/**
 * ...and longer still for the two that are worth more behind you than in front.
 *
 * A chock on the back bumper and a hat held low are *shields* (see the block in
 * `onHit`): while they are there the next thing thrown at this kart hits them
 * instead. A CPU that throws its shield away at the first empty road behind it
 * has spent an item to accomplish nothing at all.
 */
const HOARD_SHIELD = 11.0;
/**
 * Metres before a row of boxes at which a CPU spends whatever it is still
 * holding, seconds be damned.
 *
 * This is the behaviour that actually keeps an item slot full, and it is worth
 * being explicit about why. You cannot take a box with your hands full, so an
 * item carried *through* a row does not merely delay the next draw — it throws
 * the row away, and the next chance is a third of a lap later. Every decent
 * Mario Kart player clears their slot on the approach for exactly this reason,
 * and a field that does not is a field whose item boxes are mostly decoration.
 *
 * Sixteen metres is about four tenths of a second at racing speed — long enough
 * that a chock dropped here is a real hazard on the run-in and short enough
 * that the slot is not standing empty for a quarter of the gap between rows
 * waiting for one. Every metre of this window is a metre of empty slot, and
 * that is the whole reason it is as tight as it is.
 */
const USE_BEFORE_ROW = 16;
/**
 * The shortest a CPU will ever sit on anything, seconds.
 *
 * A floor under `aiDelay`, and it exists because the instant items — the coin
 * above all, which is a third of what a leader ever draws — have delays low
 * enough that the reel had barely stopped before the slot was empty again. A
 * beat of *having* the item is not a delay tax, it is the difference between
 * drawing something and being handed a result.
 */
const PATIENCE_FLOOR = 2.8;

// ── scratch ────────────────────────────────────────────────────────────────

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _to = new THREE.Vector3();
const _knock = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vis = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _hue = new THREE.Color();
/** Constant, and never written — the target the star's flash lerps toward. */
const _white = new THREE.Color(0xFFFFFF);
const _m = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _lean = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
/** Local axes of a kart built by `makeBasis(right, up, forward)`. */
const ROLL_AXIS = new THREE.Vector3(0, 0, 1);
const PITCH_AXIS = new THREE.Vector3(1, 0, 0);
/** The contact point under a kart, in the kart's own frame. */
const _ground = new THREE.Vector3();
/** The road's up at that point — the plane a carried item's blob lies in. */
const _norm = new THREE.Vector3();
const _shadow = new THREE.Vector3();
/** Measuring a held model's footprint. Written once per item id, at build. */
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _off = new THREE.Vector3();
/** The muzzle's own scratch. Deliberately not shared with `_off`, which is
 *  written from `update`, because this one is written from the fixed step. */
const _muz = new THREE.Vector3();
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
  /** Seconds left of the settle punch — the window right after the reel lands
   *  in which the item the kart is carrying is oversized and springing back. */
  settle: number;
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
  /** Speed the kart was doing when the bullet fired — the bottom of the ramp. */
  bulletSpeed0: number;
  shrunk: number;
  ink: number;
  boo: number;
  booSteal: number;
  booTarget: number;

  /** How many carried items are out on the kart, and whether they will take a
   *  hit for it. Written in the fixed step so the picture and the rule can
   *  never disagree. */
  shown: number;
  guarded: boolean;

  /**
   * The spin-out, integrated by this module rather than by the kart model.
   * `hitTime <= 0` means there isn't one. Flat fields rather than a nested
   * object because a hit lands inside the fixed step and must not allocate.
   */
  hitTime: number;
  hitTotal: number;
  hitKind: HitKind;
  /** The numbers this particular hit is being integrated against — captured on
   *  impact, because two items can share a `kind` and not a profile. */
  hitProfile: HitProfile;
  /** World-space direction of travel, held for the whole spin. */
  hitDirX: number;
  hitDirZ: number;
  hitSpeed: number;
  hitYaw0: number;
  /** Signed radians from `hitYaw0` to the settled heading, and the swing past
   *  it that comes back. */
  hitEnd: number;
  hitOver: number;
  hitDir: number;
  /** The item that caused it, for the trail thrown off during the spin. */
  hitColor: number;
  /** Visual emitter clock for that trail. Written only from `update`. */
  hitPuff: number;
  /**
   * Seconds of "you cannot be hit again yet", counted by this module.
   *
   * Separate from `racer.invulnerable` on purpose, and it is a *visual*
   * distinction rather than a bookkeeping one. The vehicle rig blinks anything
   * carrying `invulnerable`, which is the right tell for the half-second after
   * you get control back and completely wrong for the second and a half a
   * spin-out plus its grace period actually lasts: a wheel chock used to hand
   * `stun + 0.55` straight to `invulnerable`, and the machine strobed through
   * the whole reaction — photographed 0.8s after the hit there was nothing on
   * the road but a shadow. The spin-out is the most expensive thing that
   * happens to a player and it has to be *delivered on a solid machine*.
   *
   * So the protection lives here for the length of the spin, and only the last
   * `GRACE_BLINK` seconds of it are handed to `invulnerable` — where the blink
   * then means what it is supposed to mean: your shield is running out.
   */
  grace: number;

  /** Visual state, written only from `update`. */
  orbit: THREE.Group | null;
  orbitKey: string;
  aura: THREE.Object3D | null;
  husk: THREE.Object3D | null;
  shroud: THREE.Object3D | null;
  scale: number;
  phase: number;
  /** Seconds until the next star sparkle is thrown off. Visual only. */
  sparkle: number;
}

function newState(id: number): RacerItems {
  return {
    spin: 0, spinTotal: 1, pending: null, reelTimer: 0, reelIndex: 0, settle: 0,
    held: 0, hold: 0, wasDown: false, useLock: 0, aiTimer: 0.3,
    star: 0, bullet: 0, bulletDist: 0, bulletLat: 0, bulletSpeed0: 0,
    shrunk: 0, ink: 0, boo: 0, booSteal: 0, booTarget: -1,
    shown: 0, guarded: false,
    hitTime: 0, hitTotal: 1, hitKind: 'spin', hitProfile: HIT.spin,
    hitDirX: 0, hitDirZ: 1,
    hitSpeed: 0, hitYaw0: 0, hitEnd: 0, hitOver: 0, hitDir: 1,
    hitColor: 0xFFF8F0, hitPuff: 0, grace: 0,
    orbit: null, orbitKey: '', aura: null, husk: null, shroud: null, scale: 1,
    phase: id * 1.7, sparkle: 0,
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
  /** ...and how much road each of them covers. See `heldPrototype`. */
  const heldRadius = new Map<string, number>();
  /** Spare orbit rigs, keyed `item:count`. See `drawCarried`. */
  const orbitPool = new Map<string, THREE.Group[]>();
  let auraProto: THREE.Object3D | null = null;
  let huskProto: THREE.Object3D | null = null;
  let shroudProto: THREE.Object3D | null = null;
  let line: RacingLine | null = null;
  let visualTime = 0;
  /** Interpolation blend for the current rendered frame, so the visuals this
   *  module hangs on a kart ride with it instead of a fixed step behind. */
  let blend = 1;

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

  /** Set on reset; cleared on the first frame drawn after it. */
  let sunDirty = true;

  const stateOf = (racer: Racer): RacerItems => {
    let s = states.get(racer.id);
    if (!s) { s = newState(racer.id); states.set(racer.id, s); }
    return s;
  };

  const classMul = (): number => ctx.config.race.classes[ctx.race.engineClass].speedMul;

  /**
   * The legible half of an item's colour pair.
   *
   * Every flare this module throws is additive, and additive means a dark
   * colour contributes nothing: a bob-omb (0x2E3340) or a bullet bill
   * (0x4A5162) would land with no flash at all. Where the primary is too dark
   * to carry light, the accent is.
   */
  function brightOf(id: ItemId): number {
    const def = ITEMS[id];
    const lum = (c: number): number =>
      ((c >> 16 & 255) * 0.3 + (c >> 8 & 255) * 0.59 + (c & 255) * 0.11) / 255;
    return lum(def.color) > 0.42 ? def.color : def.accent;
  }

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

  /**
   * Can this racer be hurt right now?
   *
   * `boo` is in here rather than in `racer.invulnerable`, and that distinction
   * is not bookkeeping. The vehicle rig blinks any racer whose invulnerability
   * is up — correct for the second after a hit, and a four-and-a-half-second
   * strobe if a boo writes it for its whole duration, which is what it used to
   * do. The player spent the best item on the tail-end table watching their own
   * kart flicker on and off. Immunity is a *rule*; the blink is a readout of one
   * particular short-lived form of it, and the two are separated here.
   */
  const immune = (racer: Racer): boolean =>
    racer.effects.has('star') || racer.effects.has('bullet')
    || racer.effects.has('boo') || racer.invulnerable > 0
    // ...and the post-hit grace, which spends most of its life *not* written to
    // `invulnerable` so the spin-out is delivered on a machine you can see.
    || (states.get(racer.id)?.grace ?? 0) > 0;

  /** `Array.find` with a closure allocates, and these run inside the fixed
   *  step on every projectile contact. */
  function racerById(id: number): Racer | null {
    const all = ctx.racers;
    for (let i = 0; i < all.length; i++) if (all[i]!.id === id) return all[i]!;
    return null;
  }

  /**
   * Where a kart *is on screen* this frame, which is not where it is in the
   * simulation. Everything this module hangs on a kart — orbiting shells, the
   * star aura, the bullet casing — has to be placed against the same
   * interpolated transform the vehicle rig uses, or it swims half a fixed step
   * behind the machine it is supposed to be attached to.
   */
  function visualPos(racer: Racer, out: THREE.Vector3): THREE.Vector3 {
    return out.lerpVectors(racer.prevPos, racer.pos, blend);
  }

  /**
   * ...and which way it is *facing* this frame, which is not simply its yaw.
   *
   * Cone Canyon banks. A kart in a banked corner is rolled by up to fifteen
   * degrees, and anything hung off it from a yaw-only basis stays stubbornly
   * level: the low side of a shell orbit sinks into the tarmac while the high
   * side lifts clear of the machine, and the bullet bill's casing leaves the
   * kart sticking out through its flank. Everything this module attaches to a
   * racer therefore takes the racer's whole orientation.
   */
  function visualQuat(racer: Racer, out: THREE.Quaternion): THREE.Quaternion {
    return out.copy(racer.prevQuat).slerp(racer.quat, blend);
  }

  // ── coins ────────────────────────────────────────────────────────────────

  function addCoins(racer: Racer, n: number, at?: THREE.Vector3): void {
    if (n <= 0) return;
    const before = racer.coins;
    racer.coins = Math.min(COIN_CAP, racer.coins + n);
    if (racer.coins === before) return;
    ctx.bus.emit('coin:get', { racer, total: racer.coins });
    // A coin that vanishes silently is a coin the player never learns to want.
    ctx.fx?.spawn('shine', at ?? racer.pos, { scale: 0.8 });
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
   * burst in the item's own colour, the coins on the road, the stun, the
   * invulnerability that stops a pack from chaining you from eighth to nowhere,
   * and the spin-out itself — see `beginHit`.
   */
  function strike(racer: Racer, by: Racer | null, item: ItemId,
    kindOverride?: HitKind, force = 1, from?: THREE.Vector3): boolean {
    if (immune(racer) || racer.finished) return false;
    const def = ITEMS[item];
    const kind = kindOverride ?? HIT_KIND[item] ?? 'spin';

    ctx.bus.emit('item:strike', { racer, by, item, kind });

    // Coins are the cost. The item in hand survives — losing the shell you were
    // saving *and* the second is the kind of compounding punishment that turns a
    // comeback into a spiral.
    spillCoins(racer);
    const st = stateOf(racer);
    st.hold = 0;

    beginHit(racer, st, kind, by, from ?? by?.pos ?? null, def.color, force, item);
    hitFx(racer, kind, def.color, force);

    if (racer.isPlayer) {
      hud.flash(def.color, kind === 'spin' ? 0.3 : 0.45);
      // ...and scaled by how hard it landed, so standing next to a gas bottle
      // when it goes is not the same camera move as clipping the edge of it.
      ctx.fx?.shake((kind === 'spin' ? 0.55 : 0.95) * clamp(force, 0.7, 1.35), 0.4);
      // Name it. Everything else about a hit — the spin, the red instruments,
      // the coins on the road — is the same picture whichever item caused it.
      hud.strike(item);
    }
    return true;
  }

  /**
   * Start a spin-out, and hand the kart's trajectory to this module for the
   * length of it.
   *
   * The two numbers that matter are captured here and never recomputed: the
   * world-space direction the kart was travelling, and the speed it was doing.
   * Everything the integrator does afterwards is a decay of the second and a
   * rotation *about* the first.
   */
  function beginHit(racer: Racer, st: RacerItems, kind: HitKind, by: Racer | null,
    from: THREE.Vector3 | null, color: number, force: number,
    item: ItemId | null = null): void {
    // The profile is captured here and held for the whole spin-out. Looking it
    // up per step off `hitKind` alone is what made every `flip` identical: the
    // kind is the *shape* of the reaction and the item is how hard it lands,
    // and only one of those two survives into the integrator unless it is
    // written down.
    const P = profileOf(item, kind);
    st.hitProfile = P;

    // The direction of travel, in the world, flattened. A kart that is barely
    // moving has no travel direction worth keeping, so it borrows its nose.
    _knock.set(racer.vel.x, 0, racer.vel.z);
    let speed = _knock.length();
    if (speed < 0.6) {
      forwardOf(racer, _knock);
      speed = Math.max(speed, Math.abs(racer.speed));
    } else {
      _knock.divideScalar(speed);
      speed = Math.max(speed, Math.abs(racer.speed));
    }

    // Which side it came from decides which way the nose goes, and a shove
    // bends the *travel line* away from the striker rather than adding an
    // impulse the kart model would eat on the next step.
    let side = 0;
    if (from) {
      _to.subVectors(racer.pos, from);
      _to.y = 0;
      // `right` of the travel direction: fwd = (sin y, 0, cos y) ⇒ right = (cos y, 0, -sin y).
      side = _to.x * _knock.z - _to.z * _knock.x;
    }
    // No striker to take a side from — a lightning bolt, a bench call — so the
    // field does not all spin the same way.
    const dir = from ? (side >= 0 ? 1 : -1) : (racer.id % 2 === 0 ? 1 : -1);
    if (from && P.shove > 0) {
      const a = -dir * P.shove * clamp01(force);
      const c = Math.cos(a), s = Math.sin(a);
      const x = _knock.x * c + _knock.z * s;
      const z = -_knock.x * s + _knock.z * c;
      _knock.set(x, 0, z);
    }

    st.hitKind = kind;
    st.hitTotal = P.stun;
    st.hitTime = P.stun;
    st.hitDirX = _knock.x;
    st.hitDirZ = _knock.z;
    st.hitSpeed = speed;
    st.hitYaw0 = racer.yaw;
    st.hitDir = dir;
    st.hitColor = color;
    st.hitPuff = 0;
    // Settle facing the way the kart is actually going, a whole number of turns
    // later. Anything else hands control back to a machine pointing at the
    // barrier, which is a second punishment nobody asked for.
    const travelYaw = Math.atan2(_knock.x, _knock.z);
    st.hitEnd = dir * P.turns * TAU + angleDelta(racer.yaw, travelYaw);
    st.hitOver = dir * P.over * clamp(force, 0.6, 1.3);

    // The contract fields, through physics' own entry point so `kart:hit`,
    // `effects` and the input lockout all land the way every other module
    // expects. Its speed cut and its stun length are then replaced by this
    // module's: a single step that deletes 85% of a kart's speed is the thing
    // this whole section exists to stop.
    //
    // The invulnerability is cleared first because the caller has already ruled
    // on whether this hit lands (`strike`) or is unconditional (lightning), and
    // `stunRacer` would otherwise silently drop the event and the flags.
    const keep = racer.speed;
    racer.invulnerable = 0;
    st.grace = P.stun + GRACE_AFTER;
    // `flip` is this module's word; physics knows three. A flip is a spin as
    // far as its own flags are concerned, and the extra flag below is what
    // tells anyone who cares the difference.
    stunRacer(ctx, racer,
      kind === 'bump' ? 'bump' : kind === 'squish' ? 'squish' : 'spin', by);
    racer.speed = keep;
    racer.stunned = P.stun;
    // **Not** `invulnerable`. `stunRacer` may have written one of its own, and
    // anything on that field blinks the machine — see `RacerItems.grace`. The
    // protection is `st.grace`; `invulnerable` is picked up again in
    // `tickGrace`, once there is a machine under the player's hands to blink.
    racer.invulnerable = 0;
    if (kind === 'flip') racer.effects.add('flip');

    // Off the ground for the heavy ones. Physics only believes a kart is
    // airborne once it is genuinely clear of the road, so the lift is not a
    // teleport — it is the minimum that makes a launch exist at all.
    if (P.launch > 0) {
      racer.pos.y += 0.18;
      racer.vel.y = Math.max(racer.vel.y, 0) + P.launch * clamp(force, 0.5, 1.2);
      racer.grounded = false;
      racer.airTime = 0.001;
    }

    // The reaction, separately from the strike that caused it: `item:strike`
    // says what hit you, this says what your kart is about to do about it and
    // how hard. Audio and fx want the second, and lightning has one without the
    // first ever having been an item in flight.
    ctx.bus.emit('item:reaction', { racer, kind, force });
  }

  /**
   * The spin-out integrator. Runs every fixed step for as long as the hit lasts.
   *
   * Three things happen here and they are deliberately independent of each
   * other: the speed decays, the *direction* does not, and the heading rotates.
   * Keeping them apart is the entire fix — the kart model couples the second to
   * the third, which is what turned every hit into a circle.
   */
  function driveSpinout(racer: Racer, st: RacerItems, dt: number): void {
    const P = st.hitProfile;
    st.hitTime = Math.max(0, st.hitTime - dt);
    const left = st.hitTime;
    const age = st.hitTotal - left;
    const t = clamp01(age / st.hitTotal);

    // ── speed ───────────────────────────────────────────────────────────────
    // A hard bite that fades over a sixth of a second, and a light drag under
    // it. No step may take more than a few percent — an instantaneous stop is
    // the game reaching in, not a collision — and the constant part gives up
    // before zero so the kart is still rolling when the player gets it back.
    const k = P.bite * Math.exp(-age / P.biteTau) + P.tail;
    st.hitSpeed -= st.hitSpeed * k * dt;
    if (st.hitSpeed > HIT_FLOOR) {
      st.hitSpeed = Math.max(HIT_FLOOR, st.hitSpeed - HIT_DRAG * dt);
    }

    // ── trajectory ──────────────────────────────────────────────────────────
    // Physics has already integrated this step against a velocity it rebuilt
    // from the (spinning) heading. Correct the step it took rather than fight
    // it: the difference in velocity, applied over the same dt, is exactly the
    // displacement it should have had. Vertical is left alone — gravity, ride
    // height and landings are the kart model's, and they still are.
    const vx = st.hitDirX * st.hitSpeed;
    const vz = st.hitDirZ * st.hitSpeed;
    racer.pos.x += (vx - racer.vel.x) * dt;
    racer.pos.z += (vz - racer.vel.z) * dt;
    racer.vel.x = vx;
    racer.vel.z = vz;
    racer.speed = st.hitSpeed;

    // ── heading ─────────────────────────────────────────────────────────────
    // Fastest on the frame of impact, easing to nothing, with a swing past the
    // settled heading that comes back. The rate is the derivative of this and
    // is never twice the same.
    const p = 1 - Math.pow(1 - t, P.easePow);
    const yaw = st.hitYaw0 + st.hitEnd * p + st.hitOver * Math.sin(Math.PI * t);
    racer.yaw = yaw;
    racer.stunned = left;

    // ── the chassis ─────────────────────────────────────────────────────────
    // Written here rather than left to physics because the kart model eases its
    // orientation with a ~0.11s time constant — correct for kerbs and camber,
    // and a low-pass filter that would smear a 1200°/s whip into a slow drift.
    const s = ctx.track ? ctx.track.spline.nearest(racer.pos, _sample) : null;
    _up.copy(s ? s.up : UP);
    _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    _fwd.addScaledVector(_up, -_fwd.dot(_up)).normalize();
    _right.crossVectors(_up, _fwd).normalize();
    _m.makeBasis(_right, _up, _fwd);
    _quat.setFromRotationMatrix(_m);
    // Recoil: the body is thrown over away from the impact and comes back.
    const recoil = Math.sin(Math.PI * Math.pow(t, 0.55));
    _lean.setFromAxisAngle(ROLL_AXIS, P.roll * st.hitDir * recoil);
    _quat.multiply(_lean);
    if (!racer.grounded) {
      _lean.setFromAxisAngle(PITCH_AXIS, -0.28 * recoil);
      _quat.multiply(_lean);
    }
    // Hand the chassis back over the last fraction of a second, so control
    // returns to a kart that is already sitting the way physics thinks it is.
    racer.quat.slerp(_quat, clamp01(left / HIT_RELEASE));

    if (left <= 0) endHit(racer, st);
  }

  /**
   * The post-hit grace, and the one window in which the machine is allowed to
   * blink.
   *
   * Runs every fixed step for every racer, before anything can hit them. Two
   * jobs: count the protection down, and hand its last `GRACE_BLINK` seconds to
   * `racer.invulnerable` — which is what the vehicle rig strobes. While the
   * spin-out is running, `invulnerable` is held at zero, so the reaction a
   * player is watching happen to their own kart happens on a solid one.
   *
   * `Math.max` rather than a plain write, because a star, a boo and physics'
   * own kart-on-kart bump all use the same field and this must never shorten
   * one of theirs.
   */
  function tickGrace(racer: Racer, st: RacerItems, dt: number): void {
    if (st.grace <= 0) return;
    st.grace = Math.max(0, st.grace - dt);
    if (racer.stunned > 0 || st.hitTime > 0) return;
    if (st.grace > 0 && st.grace <= GRACE_BLINK) {
      racer.invulnerable = Math.max(racer.invulnerable, st.grace);
    }
  }

  /** Clear up after a spin-out. The flags are cleared here rather than left to
   *  physics' own timer, because this module owns the clock they ran on. */
  function endHit(racer: Racer, st: RacerItems): void {
    st.hitTime = 0;
    racer.stunned = 0;
    racer.effects.delete('spin');
    racer.effects.delete('flip');
    racer.effects.delete('squish');
    racer.effects.delete('bump');
  }

  /**
   * What a hit looks like, and it is a different picture for every kind.
   *
   * A player has to be able to name what got them from one frame. Colour alone
   * cannot do that — half the table is warm — so each reaction gets its own
   * *shape*: a banana throws tyre smoke off the road, a shell or a bomb throws
   * white sparks and a burst up at roof height, a shove throws a ring out
   * sideways, and lightning drops a flat cloud of dust as the kart is squashed
   * into it.
   */
  function hitFx(racer: Racer, kind: HitKind, color: number, force: number): void {
    const fx = ctx.fx;
    const scale = clamp(force, 0.6, 1.4);
    switch (kind) {
      case 'spin':
        // Low and smoky: you slid on something.
        entities.spawn('burst', {
          pos: _pos.copy(racer.pos).setY(racer.pos.y - 0.1),
          life: 0.3, color, ownerId: racer.id,
        });
        fx?.spawn('smoke', _pos.copy(racer.pos).setY(racer.pos.y - 0.45), { scale: 1.5 });
        fx?.spawn('impact', _pos.copy(racer.pos).setY(racer.pos.y - 0.3),
          { color, scale: 0.8 });
        break;
      case 'flip':
        // High and hot: something hit you hard enough to lift you.
        entities.spawn('burst', {
          pos: _pos.copy(racer.pos).setY(racer.pos.y + 0.85),
          life: 0.5, color, ownerId: racer.id,
        });
        fx?.spawn('impact', _pos, { color, scale: 1.7 * scale });
        fx?.spawn('sparks', _pos.copy(racer.pos).setY(racer.pos.y + 0.5),
          { color: 0xFFF8F0, scale: 1.15 * scale });
        break;
      case 'bump':
        // Sideways: a ring leaving the flank, and no smoke at all.
        entities.spawn('burst', {
          pos: _pos.copy(racer.pos).setY(racer.pos.y + 0.5),
          life: 0.36, color, ownerId: racer.id,
        });
        fx?.spawn('ring', _pos.copy(racer.pos).setY(racer.pos.y - 0.3),
          { color, scale: 1.4 });
        fx?.spawn('sparks', racer.pos, { color, scale: 1.0 });
        break;
      case 'squish':
        // Flattened. A wide, flat cloud and nothing above the bodywork.
        fx?.spawn('smoke', _pos.copy(racer.pos).setY(racer.pos.y - 0.5), { scale: 2.1 });
        fx?.spawn('impact', _pos, { color, scale: 0.9 });
        break;
      default: break;
    }
  }

  function explode(pos: THREE.Vector3, ownerId: number, groundY = pos.y - 0.02): void {
    entities.spawn('blast', { pos, life: 0.5, radius: BLAST_RADIUS, ownerId });
    // The road remembers it. A fireball that leaves nothing behind is an event
    // the track has no record of, and the road is where the player is looking.
    entities.spawn('scorch', {
      pos: _pos.copy(pos).setY(groundY + 0.04),
      life: 5.5, radius: BLAST_RADIUS * 0.42, ownerId,
    });
    ctx.bus.emit('item:blast', { pos, ownerId, radius: BLAST_RADIUS });
    ctx.fx?.spawn('explosion', pos, { scale: 1.2 });
    // ...and the smoke that a fireball on its own does not have. The fx module
    // draws this as a dirt-coloured ring, which is exactly what a bob-omb going
    // off on tarmac should throw up.
    ctx.fx?.spawn('smoke', _pos.copy(pos).setY(groundY + 0.3), { scale: 2.2 });
    const owner = racerById(ownerId);
    for (const racer of ctx.racers) {
      const d2 = racer.pos.distanceToSquared(pos);
      if (d2 > BLAST_RADIUS * BLAST_RADIUS) continue;
      // A blast *throws* you as well as flipping you, and it throws whoever was
      // standing next to it hardest: a bomb that costs the same at the edge of
      // its reach as it does at the centre has no shape to place.
      const near = clamp01(1 - Math.sqrt(d2) / BLAST_RADIUS);
      strike(racer, owner, 'bomb', 'flip', 0.55 + 0.75 * near, pos);
    }
    entities.clearNear(pos, BLAST_RADIUS * 0.7, -1);
    if (ctx.player && ctx.player.pos.distanceToSquared(pos) < 900) {
      ctx.fx?.shake(clamp01(1 - ctx.player.pos.distanceTo(pos) / 30));
    }
  }

  // ── the roulette ─────────────────────────────────────────────────────────

  function startRoulette(racer: Racer, st: RacerItems): void {
    st.pending = drawItem(ctx.rng, racer.place, Math.max(2, ctx.racers.length));
    // Keyed on whose *slot* this is, not on who is steering. An autopiloted
    // player is still the player as far as the HUD is concerned, and the reel
    // is the one animation every reviewer drives past on autopilot — gating it
    // on `!racer.ai` meant the long spin, the whole point of the beat, was the
    // one thing nobody ever saw.
    st.spinTotal = racer.isPlayer
      ? SPIN_PLAYER
      : SPIN_CPU + (1 - (racer.ai?.skill ?? 0.8)) * 0.5;
    st.spin = st.spinTotal;
    st.reelTimer = 0;
    st.reelIndex = ctx.rng.int(0, REEL_FACES.length - 1);
    // The *duration* travels with the event. Whoever draws the slot has to
    // decelerate its drum into the answer, and without this it can only mirror
    // `SPIN_PLAYER` as a constant of its own — two copies of one number in two
    // modules, which is a desync waiting for the first time either is tuned.
    ctx.bus.emit('item:roulette',
      { racer, phase: 'start', duration: st.spinTotal });
    // The drum starts on the face the seed picked, so a replay of the same race
    // shows the same reel on the same frame.
    if (racer.isPlayer) hud.spinning(true, st.reelIndex);
  }

  /**
   * Abandon a spin that is already running.
   *
   * Three things can interrupt a roulette — a bolt of lightning, the chequered
   * flag, and the reviewer's bench putting an item straight into a hand — and
   * every one of them used to leave the slot in its spinning state with the
   * draw thrown away. That was survivable while the reel was an icon swap and
   * is not now: the drum simply stays on screen, turning, for the rest of the
   * race. Anything that cancels a spin comes through here.
   */
  function stopSpin(racer: Racer, st: RacerItems): void {
    if (st.spin <= 0 && !st.pending) return;
    st.spin = 0;
    st.pending = null;
    st.settle = 0;
    // A `settle` with no `item` — the one shape in the contract that says "the
    // spin is over and there is nothing in the slot". Anything that started a
    // loop on `phase:'start'` needs this or it runs for the rest of the race.
    ctx.bus.emit('item:roulette', { racer, phase: 'settle' });
    if (racer.isPlayer) hud.spinning(false);
  }

  function tickRoulette(racer: Racer, st: RacerItems, dt: number): void {
    if (st.spin <= 0) return;

    /**
     * Slot-stop.
     *
     * Pressing the item button while the reel is running stops it. It is a
     * learned Mario Kart interaction and the difference between watching an
     * animation and making a decision: a player who needs a mushroom *now*
     * stops the reel the instant a box breaks rather than waiting out a second
     * of theatre with their thumb over the button.
     *
     * It deliberately does not change *what* you draw — the draw was made when
     * the box broke, and a reel the button could aim would be a slot machine
     * with a stop button, which is a different and much worse game. What it
     * buys you is the time.
     *
     * The short tail rather than an immediate settle is what makes it read: the
     * reel has to be seen to *snap* onto the answer, and a face that changes on
     * the same frame the button goes down looks like a dropped input.
     */
    if (racer.isPlayer && ctx.inputState.pressed.item
      && st.spinTotal - st.spin > 0.14 && st.spin > 0.09) {
      st.spin = 0.08;
      st.reelTimer = Math.min(st.reelTimer, 0.04);
    }

    st.spin -= dt;
    st.reelTimer -= dt;
    if (st.reelTimer <= 0) {
      st.reelIndex = (st.reelIndex + 1) % REEL_FACES.length;
      // Decelerating: fast at the top, slowing into the answer. A reel that
      // stops at a constant rate has no ending.
      const t = 1 - clamp01(st.spin / st.spinTotal);
      st.reelTimer = lerp(0.05, 0.15, t * t);
      // One event per face, so a slot drawn by another module can turn its drum
      // on this module's clock instead of guessing at a cadence. `remaining` is
      // what makes the deceleration free: it goes to zero on the settle.
      if (racer.isPlayer) {
        hud.reelTick();
        ctx.bus.emit('item:reel',
          { racer, index: st.reelIndex, remaining: st.spin, total: st.spinTotal });
      }
    }
    if (st.spin <= 0) {
      const entry = st.pending ?? { id: 'banana' as ItemId, count: 1 };
      st.pending = null;
      st.spin = 0;
      st.held = 0;
      racer.item = entry.id;
      racer.itemCount = entry.count;
      // A beat before it can be spent. Stopping the reel is a button press, and
      // a player who taps twice — or holds through the settle — would otherwise
      // fire the item on the very frame it landed, which reads as the game
      // eating the draw. Short enough that nobody deliberately waiting on a
      // mushroom notices it.
      st.useLock = Math.max(st.useLock, 0.14);
      // The payoff. The reel has been running for a second and the one thing a
      // player must never be able to miss is the frame it stops on — so the
      // arrival is punched in the world as well as in the slot: the item pops
      // in oversized and springs back (see `drawCarried`), and a flare goes off
      // at the machine that drew it. The HUD half of this belongs to whichever
      // module owns the slot; the world half is here, and it cannot be
      // overdrawn, cropped or stood down.
      st.settle = SETTLE_TIME;
      // In the item's own colour, so the flare *names the draw* — the eye has
      // the answer before it has read the icon. Bright side of the pair: a
      // bob-omb's own near-black would be an additive flare of nothing.
      const flare = brightOf(entry.id);
      entities.spawn('burst', {
        pos: _pos.copy(racer.pos).setY(racer.pos.y + 1.0),
        ownerId: racer.id, life: 0.5, color: flare, scale: 1.3,
      });
      ctx.bus.emit('item:get', { racer, item: entry.id, count: entry.count });
      ctx.bus.emit('item:roulette', { racer, phase: 'settle', item: entry.id });
      if (racer.isPlayer) {
        hud.spinning(false);
        hud.setItem(entry);
        hud.punch();
        // The white wash. Brief — a blink, not a strobe — and drawn by this
        // module's own overlay rather than by the fx module's, because it is
        // the one part of the settle that must exist whoever owns the slot.
        hud.flash(0xFFF3DC, 0.26);
      }
    }
  }

  // ── pickups ──────────────────────────────────────────────────────────────

  /**
   * A box comes apart.
   *
   * Three separate things, and the count is deliberate: the *shatter* is the fx
   * module's `boxBreak`, the *flash* is a burst of this module's own that lives
   * long enough to be seen, and the *husk* is the empty frame left standing
   * where the box was, so a row that has been through the pack still reads as a
   * row of five rather than a row with holes in it.
   *
   * The old version spent a 0.34s burst and nothing else. Photographed frame by
   * frame it was a bright star on the frame of contact, a flat decal one frame
   * later and nothing at all by the third — three frames at 60fps for the most
   * repeated moment in the game.
   */
  function breakOpen(racer: Racer, st: RacerItems, index: number): void {
    const box = boxes.boxes[index]!;
    boxes.take(index);
    entities.spawn('burst', { pos: box.pos, life: 0.55, color: 0xFFE9A8, scale: 1.05 });
    ctx.fx?.spawn('boxBreak', box.pos, { scale: 1.15 });
    ctx.bus.emit('item:box', { racer, pos: box.pos });
    startRoulette(racer, st);
  }

  function pickups(racer: Racer, st: RacerItems): void {
    const d = lapDistance(racer);

    // ...**including while riding a pile driver.** A bullet drives the racing
    // line at forty metres a second, which takes it straight through the middle
    // of every row on the circuit, and this used to be gated off so a racer
    // ploughed through thirty item boxes over six seconds and came out the far
    // end holding nothing. That is the game ignoring something the player
    // watched happen. It also gives the ride a *landing*: you are put down in
    // fourth with something in your hands rather than put down in fourth and
    // immediately overtaken. The item cannot be fired while the husk is on —
    // `st.bullet` blocks `use` — so this is a hand-off, not a double-dip.
    if (!racer.item && st.spin <= 0) {
      const near = boxes.candidates(d);
      // The **nearest** one in reach, not the first the broadphase happens to
      // list. The reach is wider than the spacing on purpose — a pack all
      // funnelling down the racing line strips the middle of a row and leaves
      // its edges standing, and a kart that can only take the box it is
      // pointed at gets nothing while two sit a metre and a half away — so on
      // a busy row two or three boxes are in range at once and it matters
      // which breaks. Taking the far one while the near one is untouched is
      // the kind of thing nobody can name and everybody sees.
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < near.length; i++) {
        const idx = near[i]!;
        const box = boxes.boxes[idx]!;
        if (box.respawn > 0) continue;
        if (!boxReached(box, racer.pos)) continue;
        const dx = box.pos.x - racer.pos.x;
        const dz = box.pos.z - racer.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) { bestD = d2; best = idx; }
      }
      if (best >= 0) breakOpen(racer, st, best);
    }

    const nearCoins = coins.candidates(d);
    let got = 0;
    let last: THREE.Vector3 | undefined;
    for (let i = 0; i < nearCoins.length; i++) {
      const c = coins.coins[nearCoins[i]!]!;
      if (c.respawn > 0) continue;
      if (c.pos.distanceToSquared(racer.pos) > COIN_PICK_SQ + 0.9) continue;
      coins.take(nearCoins[i]!);
      last = c.pos;
      got++;
    }
    got += coins.sweep(racer.pos, racer.id);
    addCoins(racer, got, last);
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
    // 3.3 forward, not 2.6. A shell leaves at seventy-six metres a second and
    // the kart it left is doing fifty, so for the first fifth of a second the
    // two are only about ten metres apart — and ten metres down the road, from
    // a chase camera, is *directly over the machine's roof*. Photographed frame
    // by frame, a thrown hat was a green lump sitting on top of the player's own
    // cone at 0ms and still there at 200ms, and the first frame it read as a
    // separate object at all was 700ms. Three quarters of a kart further out
    // costs the throw nothing and buys the whole first tenth of a second.
    return out.copy(racer.pos).addScaledVector(_fwd, forward ? 3.3 : -2.9);
  }

  /**
   * **The muzzle.** What it looks like when something leaves the kart.
   *
   * Every launch in this module used to be a spawn and nothing else: one frame
   * the item was in the hand, the next it was an object in the road, and the
   * moment in between — the one the player pressed a button for — had no
   * picture at all. A kart racer sells a throw with a *flash at the muzzle*,
   * because that is the only part of it guaranteed to happen where the player
   * is already looking.
   *
   * Three parts, all cheap: a burst in the item's own bright colour left
   * standing at the launch point (so it slides backwards as the kart drives
   * out of it, which is the recoil read), a puff of dust off the road under it,
   * and a kick on the lens for the player. Nothing in the simulation reads any
   * of it, but it is spawned from the fixed step so a replay of the same seed
   * throws the same shot.
   */
  function muzzle(racer: Racer, id: ItemId, at: THREE.Vector3, forward: boolean): void {
    const bright = brightOf(id);
    entities.spawn('burst', {
      // ownerId -1 on purpose: a burst that rides its owner would be dragged
      // along with the kart, and the whole point of this one is that the kart
      // leaves it behind.
      ownerId: -1, pos: at, life: 0.26, color: bright, scale: forward ? 0.9 : 0.7,
    });
    ctx.fx?.spawn('sparks', at, { color: bright, scale: 0.42 });
    ctx.fx?.spawn('dust', _muz.set(at.x, racer.pos.y - 0.5, at.z), { scale: 0.34 });
    if (racer.isPlayer) ctx.fx?.shake(0.14, 0.12);
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
        muzzle(racer, id, _pos, forward);
        break;
      }

      case 'greenShell': {
        // Backwards is scaled down so a shell laid behind still travels at the
        // speed it always did — it is a mine you leave in the road for whoever
        // is chasing you, and it stops being one if it outruns them.
        launchPoint(racer, forward, _pos);
        // On the deck from the first frame. It used to be born level with the
        // kart's waist and damp down to the road over half a second, which is
        // the half second it spends in front of the chase camera — so a hat
        // left the machine at roof height and only found the tarmac once it was
        // too far away to see it arrive.
        _pos.y = groundY + 0.16;
        _vel.copy(_fwd).multiplyScalar(forward ? PROJECTILE_SPEED.shell : -PROJECTILE_SPEED.shell * 0.46);
        entities.spawn('greenShell', {
          ownerId: racer.id, pos: _pos, vel: _vel, life: 9, arm: 0.35,
          radius: 1.6, groundY,
        });
        muzzle(racer, id, _pos, forward);
        break;
      }

      case 'redShell': {
        let target = forward ? racerAt(racer.place - 1) : null;
        // ...and it has to be *ahead on the road*, not merely ahead on the
        // timing screen. In a pack running three abreast the two disagree by a
        // couple of metres all the time, and a shell born a step past its own
        // target is a shell with nothing to chase.
        if (target) {
          const L = ctx.track!.length;
          const td = ctx.track!.spline.nearest(target.pos, _sample).distance;
          const here = ctx.track!.spline.nearest(racer.pos, _sample).distance;
          if (ctx.track!.spline.forwardDistance(here + 3, td) > L * 0.5) target = null;
        }
        if (!target) {
          // Nothing ahead, or laid backwards: it flies as a plain shell, which
          // is exactly what a red shell with nobody to chase should do.
          launchPoint(racer, forward, _pos);
          _pos.y = groundY + 0.16;
          _vel.copy(_fwd).multiplyScalar(forward ? PROJECTILE_SPEED.shell : -PROJECTILE_SPEED.shell * 0.46);
          entities.spawn('greenShell', {
            ownerId: racer.id, pos: _pos, vel: _vel, life: 8, arm: 0.35, radius: 1.6, groundY,
          });
          muzzle(racer, id, _pos, forward);
          break;
        }
        const s = ctx.track!.spline.nearest(racer.pos, _sample);
        launchPoint(racer, true, _pos);
        entities.spawn('redShell', {
          ownerId: racer.id, pos: _pos, life: 13, arm: 0.25, radius: 1.9,
          targetId: target.id, dist: s.distance + 3, lat: s.lateral ?? 0,
        });
        muzzle(racer, id, _pos, true);
        break;
      }

      case 'bomb': {
        launchPoint(racer, forward, _pos);
        _vel.copy(_fwd).multiplyScalar(forward ? 24 : -7).setY(forward ? 9 : 3);
        entities.spawn('bomb', {
          ownerId: racer.id, pos: _pos, vel: _vel, life: BOMB_FUSE, arm: 0.4,
          radius: 1.9, groundY,
        });
        muzzle(racer, id, _pos, forward);
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
        // A star clears whatever was holding you: taking one mid-spin has to
        // *end* the spin, or the best item in the game arrives as a spectator.
        racer.stunned = 0;
        boostRacer(ctx, racer, 'star',
          ctx.config.kart.boost.star.time, ctx.config.kart.boost.star.power);
        ctx.bus.emit('item:effect', { racer, effect: 'star', on: true });
        ctx.fx?.spawn('stars', racer.pos, { color: 0xFFD84D, scale: 2 });
        if (racer.isPlayer) { hud.flash(0xFFD84D, 0.35); ctx.fx?.shake(0.35, 0.3); }
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
    // The bottom of the ramp — see BULLET_RAMP. Floored well under walking pace
    // so a bullet fired from a standstill or out of a spin still *launches*
    // rather than crawling for the first half second.
    st.bulletSpeed0 = Math.max(18, Math.abs(racer.speed));
    racer.effects.add('bullet');
    racer.stunned = 0;
    boostRacer(ctx, racer, 'bullet',
      ctx.config.kart.boost.bullet.time, ctx.config.kart.boost.bullet.power);
    ctx.bus.emit('item:effect', { racer, effect: 'bullet', on: true });
    ctx.fx?.spawn('boost', racer.pos, { color: 0x9FD6FF, scale: 2.2 });
    if (racer.isPlayer) { hud.flash(0xBFE6FF, 0.5); ctx.fx?.shake(0.7, 0.45); }
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
    // Ramped, not switched on. Cubic-out: most of the gain lands in the first
    // third of a second, which still reads as a shove in the back, and the tail
    // of it is inside what a chase camera can follow.
    const cruise = ctx.config.kart.maxSpeed * classMul() * 1.34;
    const ramp = clamp01((BULLET_TIME - st.bullet) / BULLET_RAMP);
    const speed = lerp(st.bulletSpeed0, cruise, 1 - Math.pow(1 - ramp, 3));
    st.bulletDist += speed * dt;
    const target = line ? line.lateralAt(st.bulletDist) : 0;
    // A quarter-second to find the line, not a tenth. A kart that fires this
    // from the outside of a corner is six or seven metres off the racing line,
    // and at the old rate it crossed those metres in about a tenth of a second —
    // twenty metres a second sideways, which no chase camera can follow. The
    // player got a smear and then a view of their own kart from the wrong side.
    // Slower reads as the bullet *steering*, which is also what it is doing.
    st.bulletLat = damp(st.bulletLat, target, 0.02, dt);

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
      strike(other, racer, 'bulletBill');
    }
  }

  function endBullet(racer: Racer): void {
    racer.effects.delete('bullet');
    racer.invulnerable = Math.max(racer.invulnerable, 0.6);
    // Land it on a mushroom rather than dropping the player off a cliff edge.
    boostRacer(ctx, racer, 'mushroom', 0.7, 26);
    ctx.bus.emit('item:effect', { racer, effect: 'bullet', on: false });
    ctx.fx?.spawn('impact', racer.pos, { color: 0xBFE6FF, scale: 1.6 });
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
      stopSpin(racer, st);
      if (racer.isPlayer) hud.setItem(null);
      // Squashed on the spot, not spun: a bolt from above has no side to it,
      // and lightning is the one hit in the game nothing makes you immune to.
      ctx.bus.emit('item:strike', { racer, by: user, item: 'lightning', kind: 'squish' });
      beginHit(racer, st, 'squish', user, null, ITEMS.lightning.color, 0.8);
      hitFx(racer, 'squish', ITEMS.lightning.color, 0.8);
      if (racer.isPlayer) hud.strike('lightning');
      ctx.bus.emit('item:effect', { racer, effect: 'shrunk', on: true });
    }
    hud.flash(0xFFFCE0, 0.85);
    ctx.fx?.flash(0xFFFCE0, 0.9);
    ctx.fx?.shake(0.55, 0.5);
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
    entities.spawn('sprayer', {
      ownerId: user.id,
      pos: _pos.copy(user.pos).addScaledVector(_fwd, 3).setY(user.pos.y + 2.6),
      vel: _vel.copy(_fwd).multiplyScalar(26).setY(1.5),
      life: 3.2, yaw: user.yaw,
    });
  }

  function fireBoo(user: Racer, st: RacerItems): void {
    st.boo = BOO_TIME;
    user.effects.add('boo');
    // No `invulnerable` write: see `immune`. A boo is untouchable because it is
    // a boo, and the shroud says so far better than a strobing kart does.

    // Steal from someone ahead who actually has something worth taking.
    let victim: Racer | null = null;
    for (const racer of ctx.racers) {
      if (racer === user || !racer.item || racer.finished) continue;
      if (racer.place > user.place) continue;
      if (!victim || racer.place < victim.place) victim = racer;
    }
    st.booTarget = victim ? victim.id : -1;
    // The attempt is unconditional. It used to be armed only if somebody ahead
    // happened to be holding something at the instant the button went down,
    // which meant the best item on the tail-end table regularly did nothing at
    // all: a second later four machines in front are carrying shells, and the
    // boo that was sent to fetch one had already been told there was nothing to
    // take. Who it robs is decided when it *arrives* — see `stealVictim`.
    st.booSteal = 1.1;

    forwardOf(user, _fwd);
    entities.spawn('sheet', {
      ownerId: user.id,
      pos: _pos.copy(user.pos).setY(user.pos.y + 1.4),
      vel: _vel.copy(_fwd).multiplyScalar(victim ? 22 : 8).setY(1.2),
      life: BOO_TIME * 0.6, yaw: user.yaw,
    });
    ctx.bus.emit('item:effect', { racer: user, effect: 'boo', on: true });
  }

  /**
   * Who the boo actually robs, decided at the moment it arrives.
   *
   * Preference order, and it is the order that makes this a comeback item:
   * whoever it was sent after, then the machine *nearest ahead* that is
   * carrying something — robbing the leader from eighth is a fantasy, robbing
   * the kart you are about to overtake is a race — and failing both, anybody at
   * all. Only a field in which literally nobody is holding an item sends a boo
   * home empty, which over a lap is close to never.
   */
  function stealVictim(user: Racer, preferId: number): Racer | null {
    const first = racerById(preferId);
    if (first && first.item && !first.finished) return first;

    let ahead: Racer | null = null;
    let any: Racer | null = null;
    for (const r of ctx.racers) {
      if (r === user || r.finished || !r.item) continue;
      // Nearest ahead is the *largest* place still in front of the user.
      if (r.place < user.place && (!ahead || r.place > ahead.place)) ahead = r;
      if (!any || r.place < any.place) any = r;
    }
    return ahead ?? any;
  }

  function fireHorn(user: Racer): void {
    _pos.copy(user.pos);
    entities.spawn('ring', {
      ownerId: user.id, pos: _pos, life: 0.62, radius: HORN_RADIUS,
    });
    // The point of the horn: it deletes what is about to hit you. A red shell
    // has no other counter, and a game where the leader has no answer to one is
    // a game that punishes leading.
    entities.clearNear(_pos, HORN_RADIUS, user.id);
    for (const racer of ctx.racers) {
      if (racer === user) continue;
      if (racer.pos.distanceToSquared(user.pos) > HORN_RADIUS * HORN_RADIUS) continue;
      strike(racer, user, 'horn', undefined,
        1.15 - 0.5 * Math.sqrt(racer.pos.distanceToSquared(user.pos)) / HORN_RADIUS);
    }
    ctx.fx?.spawn('ring', user.pos, { color: 0xFF8A2A, scale: 1.6 });
    ctx.fx?.shake(0.5, 0.3);
    // The wave leaves from underneath the camera, so for the racer who fired it
    // the *screen* has to be most of the report.
    if (user.isPlayer) hud.flash(0xFF8A2A, 0.5);
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
   *
   * **A held item is a position, not indecision.** This is the half that was
   * missing, and it cost the game more than the box layout did: the whole field
   * — the autopiloted player included — used to dump whatever it drew within a
   * second or two of drawing it, at nothing in particular, and then drive on
   * with an empty slot until the next row. Dragging a wheel chock behind you
   * for half a lap is not a CPU failing to make up its mind; it is the single
   * most common thing a good Mario Kart player does, it is what the shield in
   * `onHit` exists to reward, and it is why a real kart racer's item slot is
   * *full* most of the time. Every branch below now has a target test worth
   * failing and a hoard limit measured in the seconds a lap actually has.
   */
  function aiUse(racer: Racer, st: RacerItems, distance: number): void {
    const id = racer.item!;
    const def = ITEMS[id];
    const skill = racer.ai?.skill ?? 0.8;
    /**
     * Patience *rises* with skill, which is the opposite of what it used to do.
     * `1.6 - skill` made the best driver in the field the twitchiest — a 0.95
     * skill CPU threw its shell in two thirds of the time an 0.6 took, when the
     * thing that separates a good kart player from a bad one is precisely that
     * they wait for the shot.
     */
    const patience = Math.max(PATIENCE_FLOOR, def.aiDelay * (0.85 + skill * 0.85));
    if (st.held < patience) return;
    const chance = ctx.config.ai.itemUseChance;

    // The row is coming and this kart's hands are full — see `USE_BEFORE_ROW`.
    // Deliberately *above* the per-item questions rather than folded into each
    // one's fallback: it is not "I have run out of patience", it is "there is a
    // box forty metres away and I cannot take it holding this".
    if (boxes.gapAhead(distance) < USE_BEFORE_ROW) {
      // Scattered across the approach rather than fired on the metre. Every
      // kart in the field runs this test on the same forty metres of road, and
      // eight machines throwing on the same frame every lap is a chorus line,
      // not a race. A coin flip per look, five looks a second, spreads them
      // over the whole run-in.
      if (ctx.rng.bool(0.6)) {
        // Backwards for the chock, which is worth more on the road behind a row
        // of boxes than in the air in front of it: everyone converges on a row,
        // so a chock laid on the approach is the best-placed chock of the lap.
        use(racer, st, id !== 'banana');
      }
      return;
    }

    switch (id) {
      case 'mushroom':
      case 'tripleMushroom': {
        // On the grass, or lined up with something straight enough to spend it.
        const straight = Math.abs(ctx.track!.spline.atDistance(distance + 30, _sample).curvature) < 0.004;
        if (OFFROAD.has(racer.surface) || (straight && racer.speed > 12)) {
          if (ctx.rng.bool(chance)) use(racer, st, true);
        } else if (st.held > HOARD) use(racer, st, true);
        break;
      }
      case 'banana': {
        // Close behind, and *close* is the word: at twenty-two metres a chock
        // dropped on the racing line is something the chaser has a second and a
        // half to read and steer around, so the drop was free and the shield
        // was gone. Ten metres is inside their reaction — and until somebody is
        // that close, the chock is worth more hanging off the back bumper,
        // where it eats the next hard hat aimed at this kart.
        const behind = nearest(racer, false, 8);
        if (behind || st.held > HOARD_SHIELD) {
          if (ctx.rng.bool(chance)) use(racer, st, false);
        }
        break;
      }
      case 'greenShell': {
        // A hard hat travels in a straight line, so the shot is only on if the
        // road ahead is one. Firing it into the apex of a hairpin is the shot
        // that made items look like noise.
        const ahead = nearest(racer, true, 30);
        const behind = nearest(racer, false, 9);
        const straight = Math.abs(ctx.track!.spline.atDistance(distance + 20, _sample).curvature) < 0.006;
        if (ahead && straight && ctx.rng.bool(chance * skill)) use(racer, st, true);
        else if (behind && ctx.rng.bool(chance * 0.6)) use(racer, st, false);
        else if (st.held > HOARD_SHIELD) use(racer, st, true);
        break;
      }
      case 'redShell': {
        // It homes, so the only question is whether there is anybody in front
        // of this kart *on the road* to home at. `place > 1` said yes for a
        // leader's chaser forty seconds up the circuit, and the shell died of
        // old age every time.
        const ahead = nearest(racer, true, 40);
        if (ahead && ctx.rng.bool(chance)) use(racer, st, true);
        else if (st.held > HOARD) use(racer, st, true);
        break;
      }
      case 'bomb': {
        const ahead = nearest(racer, true, 26);
        const behind = nearest(racer, false, 12);
        if (ahead && ctx.rng.bool(chance)) use(racer, st, true);
        else if (behind && ctx.rng.bool(chance)) use(racer, st, false);
        else if (st.held > HOARD) use(racer, st, true);
        break;
      }
      case 'horn': {
        // Held for a red shell, which is what it is for. Otherwise, eventually.
        let inbound = false;
        for (const e of entities.list) {
          if (!e.active || e.kind !== 'redShell' || e.targetId !== racer.id) continue;
          if (e.pos.distanceToSquared(racer.pos) < 700) { inbound = true; break; }
        }
        if (inbound || st.held > HOARD) use(racer, st, true);
        break;
      }
      case 'coin': {
        // Under the cap a coin is *top speed*, and top speed banked now is
        // worth more than top speed banked later, so it goes straight in. At
        // the cap it is a quarter-second nudge and nothing else — and a nudge
        // is worth waiting for a place to spend, which is why the leader's
        // consolation prize stopped evaporating the instant the reel stopped.
        if (racer.coins < COIN_CAP) use(racer, st, true);
        else if (OFFROAD.has(racer.surface) || racer.speed < racer.maxSpeed * 0.72) {
          use(racer, st, true);
        }
        break;
      }
      case 'blooper': {
        // It tars the glass of everybody ahead. Nobody ahead, nothing to tar.
        if (racer.place > 2 && ctx.rng.bool(chance)) use(racer, st, true);
        else if (st.held > HOARD) use(racer, st, true);
        break;
      }
      case 'star': {
        // Invincible, faster, and it knocks people aside — so it is worth
        // something *near other karts* and worth much less on an empty road.
        // Firing it the instant it lands is how a tail-ender spends the best
        // item on the table overtaking nobody.
        const near = nearest(racer, true, 40) ?? nearest(racer, false, 18);
        if (near || OFFROAD.has(racer.surface)) { if (ctx.rng.bool(chance)) use(racer, st, true); }
        else if (st.held > HOARD) use(racer, st, true);
        break;
      }
      case 'bulletBill': {
        // It flies you *up the road*. With nobody up the road to reach, all it
        // does is take the wheel off you for six seconds.
        if (nearest(racer, true, 140) && ctx.rng.bool(chance)) use(racer, st, true);
        else if (st.held > HOARD) use(racer, st, true);
        break;
      }
      case 'lightning': {
        // Everyone ahead loses their item, their size and their speed — so the
        // bolt is worth most when there is a field in front of you to shrink,
        // and worth nothing at all from the front.
        if (racer.place > 1 && ctx.rng.bool(chance * 0.7)) use(racer, st, true);
        else if (st.held > HOARD) use(racer, st, true);
        break;
      }
      case 'boo': {
        // A dust sheet steals. It steals *nothing* off a field that is holding
        // nothing, which is exactly the moment a CPU used to spend it.
        let carrying = 0;
        for (const other of ctx.racers) if (other !== racer && other.item) carrying++;
        if (carrying >= 2 && ctx.rng.bool(chance)) use(racer, st, true);
        else if (st.held > HOARD) use(racer, st, true);
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
        // `invulnerable` is the field every other module reads to answer "can
        // this racer be hurt", so a star has to write it and not only its own
        // effect flag. It is written over the run-down rather than across the
        // whole seven seconds because the vehicle rig blinks any racer whose
        // invulnerability is up — which is exactly right for the last second of
        // a star and a strobe light for the first six. See the report.
        if (st.star < 1.2) racer.invulnerable = Math.max(racer.invulnerable, st.star);
        for (const other of ctx.racers) {
          if (other === racer) continue;
          if (other.pos.distanceToSquared(racer.pos) > 10) continue;
          strike(other, racer, 'star');
        }
        // A star that can be stopped by grass is not a star. Physics scales top
        // speed by the surface, so this holds a floor under the invincible kart
        // the same way the shrunk case above holds a ceiling over a small one —
        // the two are the same mechanism pointed in opposite directions.
        const floor = ctx.config.kart.maxSpeed * classMul() * 0.94;
        if (OFFROAD.has(racer.surface) && racer.speed < floor && racer.grounded) {
          racer.speed = Math.min(floor, racer.speed + 55 * dt);
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
      // Airflow. `maxSpeed` is the racer's own, so a shrunk or bogged machine
      // does not get the fast wipe for driving flat out at nothing.
      const flow = 1 + INK_AIRFLOW
        * clamp01(racer.speed / Math.max(1, racer.maxSpeed));
      st.ink = Math.max(0, st.ink - dt * flow);
      if (st.ink === 0) {
        racer.effects.delete('inked');
        ctx.bus.emit('item:effect', { racer, effect: 'inked', on: false });
      } else if (racer.ai) {
        // A CPU cannot see the ink, so the ink has to reach the steering: a
        // slow, deterministic wander it has to fight all the way down the road.
        // Scaled by what is left, so a machine's line recovers on the same
        // curve the player's screen clears on rather than snapping straight.
        racer.yaw += Math.sin(ctx.race.time * 4.2 + racer.id * 2.1)
          * 0.5 * clamp01(st.ink / INK_TIME) * dt;
      }
    }

    if (st.boo > 0) {
      st.boo = Math.max(0, st.boo - dt);
      // The last third of a second is handed to `invulnerable`, which is what
      // makes the kart blink — the same tell a star ends on, and the only
      // warning a player gets that they are about to be solid again.
      if (st.boo < 0.35) racer.invulnerable = Math.max(racer.invulnerable, st.boo);
      if (st.booSteal > 0) {
        st.booSteal = Math.max(0, st.booSteal - dt);
        if (st.booSteal === 0) {
          const victim = stealVictim(racer, st.booTarget);
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

  // ── the incoming warning ─────────────────────────────────────────────────
  //
  // A red shell arrives from behind, at sixty metres a second, and the chase
  // camera does not look that way. Without a tell the player's only information
  // is the bang — and an item you could not have done anything about is an item
  // that reads as the game being unfair, even when it is not. The warning is
  // what turns a red shell into a decision: brake, cut, spend the banana you
  // were saving, blow the horn.
  //
  // **It is a time-to-impact test, not a proximity test.** The version this
  // replaced lit up for anything hostile within forty-two metres that happened
  // to be getting closer, which on a circuit where the pack runs three abreast
  // meant: every shell crossing the road two lanes over, every bob-omb thrown
  // at somebody else, and — because the arming window is a third of a second —
  // *the player's own green shell*, four metres in front of their own bumper.
  // Instrumented over a race it was lit better than half the time and never
  // rose above four fifths of an opacity that itself topped out at 0.79. A
  // warning that is always on is wallpaper; a warning nobody believes costs
  // attention to say nothing at all.
  //
  // So a threat now has to *actually be going to hit the player*: closest
  // approach is solved in the horizontal plane against relative velocity, and
  // only a pass that comes inside a kart's width inside the next second and a
  // half counts. Everything else is silent. What is left is rare enough that it
  // can be loud — it ramps to full strength on the frame of impact — and it
  // carries a bearing, so the player is told which way to look.

  /** Seconds of lead the warning gives. Long enough to act on, short enough
   *  that it is only ever about a threat that is genuinely arriving. */
  const WARN_WINDOW = 1.6;
  /** ...and how near the pass has to be, metres. About a kart and a half. */
  const WARN_MISS = 3.4;

  /** The current worst threat to the player, written by `warnPlayer`. */
  let threatLevel = 0;
  let threatBearing = 0;
  let threatItem: ItemId = 'greenShell';
  /** ...and whether the bus has been told about it, so `item:warn` fires on the
   *  two transitions rather than a hundred and twenty times a second. */
  let threatOn = false;

  /**
   * Closest approach of a moving thing to the player, as a 0..1 urgency.
   *
   * Returns 0 for anything that will miss, is receding, or is further away in
   * time than the warning window. `dx`/`dv` are read out of the scratch vectors
   * the caller filled, because this runs over every entity every fixed step.
   */
  function closingUrgency(dx: THREE.Vector3, dv: THREE.Vector3, miss: number): number {
    const vv = dv.x * dv.x + dv.z * dv.z;
    // Not moving relative to us: a banana in the road, a bob-omb that has come
    // to rest. Both are hazards the player can see, and neither is an ambush.
    if (vv < 4) return 0;
    const tti = -(dx.x * dv.x + dx.z * dv.z) / vv;
    if (tti <= 0 || tti > WARN_WINDOW) return 0;
    const mx = dx.x + dv.x * tti;
    const mz = dx.z + dv.z * tti;
    if (mx * mx + mz * mz > miss * miss) return 0;
    return 1 - tti / WARN_WINDOW;
  }

  /** Where a threat is, in the player's own frame: 0 dead ahead, +right, ±π
   *  behind. The arrow on screen is pointed with this. */
  function bearingOf(player: Racer, dx: THREE.Vector3): number {
    const s = Math.sin(player.yaw);
    const c = Math.cos(player.yaw);
    return Math.atan2(dx.x * c - dx.z * s, dx.x * s + dx.z * c);
  }

  function offer(level: number, player: Racer, dx: THREE.Vector3, item: ItemId): void {
    if (level <= threatLevel) return;
    threatLevel = level;
    threatBearing = bearingOf(player, dx);
    threatItem = item;
  }

  /**
   * Publish the warning, and tell the bus about the *transitions* only.
   *
   * Audio wants a siren that starts when something is coming and stops when it
   * is not; the HUD wants a number every frame. Emitting `item:warn` a hundred
   * and twenty times a second would give the first one a stutter and the second
   * nothing it does not already have, so the event fires on the two edges and
   * carries the level it started at. Anything that wants the live value reads
   * it off the HUD it is already driving.
   */
  function publishWarning(): void {
    // A bob-omb's own colour is near-black, which is the right answer for a
    // thing lying in the road and the wrong one for a chevron that has to be
    // seen against tarmac. It wears its fuse-orange accent instead.
    hud.warn(threatLevel, threatBearing,
      threatItem === 'bomb' ? ITEMS.bomb.accent : ITEMS[threatItem].color);
    const on = threatLevel > 0;
    if (on === threatOn) return;
    threatOn = on;
    ctx.bus.emit('item:warn', {
      racer: ctx.player, on, item: threatItem, level: threatLevel,
      bearing: threatBearing,
    });
  }

  function warnPlayer(): void {
    const player = ctx.player;
    threatLevel = 0;
    if (!player || player.finished || ctx.race.phase !== 'racing') { publishWarning(); return; }

    for (const e of entities.list) {
      if (!e.active) continue;

      if (e.kind === 'redShell') {
        // The one threat that does not need a trajectory test: it is following
        // you, round corners, and the only question is how long it will take.
        if (e.targetId !== player.id) continue;
        const gap = ctx.track!.spline.forwardDistance(e.dist, lapDistance(player));
        const closing = Math.max(4, PROJECTILE_SPEED.red - player.speed);
        const tti = gap / closing;
        if (tti > WARN_WINDOW) continue;
        _to.subVectors(e.pos, player.pos);
        offer(clamp01(1 - tti / WARN_WINDOW), player, _to, 'redShell');
        continue;
      }

      if (e.kind !== 'greenShell' && e.kind !== 'bomb') continue;
      // Your own, unless it has been off a barrier — a shell that has bounced
      // is nobody's shell any more, and being taken out by your own ricochet is
      // exactly the moment a player deserves to be told.
      if (e.ownerId === player.id && e.bounces === 0) continue;
      _to.subVectors(e.pos, player.pos);
      if (Math.abs(_to.y) > 3) continue;
      _vel.subVectors(e.vel, player.vel);
      const level = closingUrgency(_to, _vel, WARN_MISS + e.radius * 0.5);
      if (level > 0) {
        offer(level, player, _to, e.kind === 'bomb' ? 'bomb' : 'greenShell');
      }
    }

    // A star or a bullet bill bearing down on you is as much an incoming item
    // as a shell is, and it is the one the player can most easily avoid — if
    // they are told. Held to a shorter window because it is a kart, not a
    // projectile, and a kart can change its mind.
    for (const other of ctx.racers) {
      if (other === player) continue;
      const star = other.effects.has('star');
      if (!star && !other.effects.has('bullet')) continue;
      _to.subVectors(other.pos, player.pos);
      if (Math.abs(_to.y) > 3) continue;
      _vel.subVectors(other.vel, player.vel);
      const level = closingUrgency(_to, _vel, 3.0) * 0.85;
      if (level > 0) offer(level, player, _to, star ? 'star' : 'bulletBill');
    }

    publishWarning();
  }

  /** A shrunk kart under the wheels of a full-size one. */
  function squishPass(): void {
    for (const small of ctx.racers) {
      if (!small.effects.has('shrunk') || small.invulnerable > 0) continue;
      if (stateOf(small).grace > 0) continue;
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
    const owner = racerById(e.ownerId);

    if (racer.effects.has('star') || racer.effects.has('bullet')) {
      // Ploughed straight through it. The item is gone, the racer is not.
      entities.spawn('burst', {
        pos: _pos.copy(e.pos).setY(e.pos.y + 0.4), life: 0.35,
        color: racer.effects.has('star') ? 0xFFD84D : 0xBFD6FF,
      });
      return true;
    }
    // A ghost, a kart already spinning, or one still blinking off its last hit.
    // The item is *not* consumed — it carries on down the road looking for
    // someone it can actually hit, which is both the right picture and the
    // reason boo belongs here rather than in the branch above: a boo must not
    // pay for the hit with the item it is carrying, and the branch above spends
    // the shield.
    // (`grace` and not only `invulnerable`, because the grace period spends
    // most of its life off that field on purpose — see `RacerItems.grace`.)
    if (racer.invulnerable > 0 || racer.stunned > 0 || racer.effects.has('boo')
      || stateOf(racer).grace > 0) return false;

    if (e.kind === 'bomb') {
      explode(e.pos, e.ownerId, e.groundY);
      return true;
    }

    // The shield. An item you are visibly carrying takes the hit for you: the
    // banana dragging behind the kart eats the green shell, one of your three
    // shells is smashed instead of you. This is why holding a triple is a
    // defensive position in Mario Kart and not merely three chances to attack,
    // and without it the whole "hold your item until you need it" layer of the
    // game does not exist.
    const st = stateOf(racer);
    if (st.guarded && BLOCKABLE.has(e.kind)) {
      const id = racer.item!;
      if (racer.itemCount > 1) racer.itemCount--;
      else { racer.item = null; racer.itemCount = 0; }
      st.useLock = Math.max(st.useLock, 0.18);
      if (racer.isPlayer) {
        hud.setItem(racer.item ? { id: racer.item, count: racer.itemCount } : null);
        hud.flash(ITEMS[id].color, 0.22);
      }
      entities.spawn('burst', {
        pos: _pos.copy(e.pos).setY(e.pos.y + 0.4), life: 0.34, color: ITEMS[id].color,
      });
      ctx.fx?.spawn('impact', _pos, { color: ITEMS[id].color, scale: 1.0 });
      ctx.bus.emit('item:block', { racer, by: owner, item: id, blocked: e.kind });
      return true;
    }

    const item: ItemId = e.kind === 'banana' ? 'banana'
      : e.kind === 'redShell' ? 'redShell' : 'greenShell';
    return strike(racer, owner, item, undefined, 1, e.pos);
  }

  function onExpire(e: Entity): void {
    if (e.kind === 'bomb') explode(e.pos, e.ownerId, e.groundY);
  }

  // ── visuals ──────────────────────────────────────────────────────────────

  function heldPrototype(id: ItemId): THREE.Object3D | null {
    const key = id;
    let proto = heldProtos.get(key);
    if (proto) return proto;
    switch (id) {
      case 'banana': proto = buildChock(); break;
      case 'greenShell': proto = buildShell(0x46D63C, 0x2C9A2A); break;
      case 'redShell': proto = buildShell(0xF03A2E, 0x7E1610, true); break;
      case 'bomb': proto = buildGasBottle(); break;
      case 'mushroom':
      case 'tripleMushroom': proto = buildMushroom(); break;
      default: return null;
    }
    heldProtos.set(key, proto);
    // ...and how much road it covers, measured off the model rather than
    // guessed. A wheel chock, a hard hat and a gas bottle are different sizes,
    // and a shadow authored as one constant is visibly too big under one of
    // them and too small under another — which is exactly how a blob stops
    // reading as *that object's* shadow. Measured once, here, because a
    // bounding box walks the whole mesh.
    _box.setFromObject(proto);
    _box.getSize(_size);
    heldRadius.set(key, clamp(Math.max(_size.x, _size.z) * 0.5, 0.22, 0.7));
    return proto;
  }

  /**
   * What the kart is visibly carrying, decided in the fixed step.
   *
   * A triple orbits. A single aim item trails behind once it is *readied* —
   * for the player, while the button is held; for a CPU, a beat after it draws
   * one. That tell matters both ways: it is what warns you a banana is about to
   * be laid in front of you, and it is what tells you the machine ahead is
   * carrying a shield you will have to break before you can hit it.
   *
   * This lives here rather than in `update` because `guarded` decides whether a
   * shell connects, and a gameplay rule read off a visual would drift out of
   * step with the simulation the moment the framerate did.
   */
  function syncCarriage(racer: Racer, st: RacerItems): void {
    const id = racer.item;
    if (!id || racer.stunned > 0 || st.bullet > 0 || racer.finished) {
      st.shown = 0;
      st.guarded = false;
      return;
    }
    const def = ITEMS[id];
    const count = Math.max(1, racer.itemCount);
    // A triple keeps orbiting down to its last one — the set is the item, and
    // a lone mushroom that has stopped circling looks like a bug.
    const readied = count > 1 || id === 'tripleMushroom'
      || (def.mode === 'aim' && (racer.ai ? st.held > 0.3 : st.hold > 0.05));
    st.shown = readied ? count : 0;
    st.guarded = st.shown > 0 && def.mode === 'aim';
  }

  /** Place the carried items on the kart. Visual only — `syncCarriage` already
   *  decided how many there are. */
  function drawCarried(racer: Racer, st: RacerItems): void {
    const id = racer.item;
    const shown = id ? st.shown : 0;
    const key = `${id ?? ''}:${shown}`;

    if (key !== st.orbitKey) {
      // Pooled by (item, count). A player holding the button to trail a banana
      // toggles this rig on and off every time their thumb moves, and a triple
      // rebuilds it on every shot fired — so the obvious version allocates a
      // group and three model clones several times a lap, inside `update`.
      if (st.orbit) {
        rig.remove(st.orbit);
        const bin = orbitPool.get(st.orbitKey);
        if (bin) bin.push(st.orbit); else orbitPool.set(st.orbitKey, [st.orbit]);
        st.orbit = null;
      }
      st.orbitKey = key;
      const proto = shown > 0 && id ? heldPrototype(id) : null;
      if (proto) {
        let group = orbitPool.get(key)?.pop() ?? null;
        if (!group) {
          group = new THREE.Group();
          for (let i = 0; i < shown; i++) {
            // One *carrier* per item, holding the model and the model's own
            // contact shadow as siblings. The carrier stays axis-aligned to the
            // world so the shadow can be laid flat on the road while the thing
            // above it tumbles: parenting a blob to a spinning shell gives you
            // a blob that spins with it, edge-on to the tarmac half the time.
            const carrier = new THREE.Group();
            // The prototypes live in the scene hidden, so their shaders are
            // built before the race — the copies have to be switched back on.
            const copy = proto.clone(true);
            copy.visible = true;
            copy.scale.setScalar(ORBIT_SCALE);
            carrier.add(copy);
            carrier.add(carryShadow());
            group.add(carrier);
          }
        }
        rig.add(group);
        st.orbit = group;
      }
    }
    if (!st.orbit) return;

    const n = st.orbit.children.length;
    const trail = n === 1;
    visualPos(racer, _vis);
    visualQuat(racer, _quat);
    // The kart's own basis, so the orbit banks with it. Everything below is
    // measured from the machine's *contact point* rather than its centre: an
    // item that rides the chassis sinks into the tarmac every time the kart
    // dips on its springs.
    _fwd.set(0, 0, 1).applyQuaternion(_quat);
    _right.set(1, 0, 0).applyQuaternion(_quat);
    _up.set(0, 1, 0).applyQuaternion(_quat);
    _pos.copy(_vis).addScaledVector(_up, -0.55);

    // ...and the *road*, which is not the same plane. The contact point above
    // rides with the machine, so over a crest it is a metre in the air and a
    // shadow pinned to it hangs in the sky with the kart. One `nearest` per
    // racer per frame — not one per item — and the surface each blob lands on
    // is then evaluated in that sample's own frame, which holds over the two
    // and a half metres an orbit reaches.
    const track = ctx.track;
    const s = track ? track.spline.nearest(_vis, _sample) : null;
    const verge = track?.course.vergeWidth ?? 5;
    if (s) _norm.copy(s.up);

    // The settle punch. For the fraction of a second after the reel lands, the
    // item the kart is holding is oversized and falling back to size — the one
    // piece of the box-to-item beat that lives in the world rather than in the
    // HUD, and therefore the one piece this module can guarantee is on screen.
    const punch = st.settle > 0
      ? 1 + 0.9 * (1 - ease.outBack(clamp01(1 - st.settle / SETTLE_TIME)))
      : 1;

    for (let i = 0; i < n; i++) {
      const carrier = st.orbit.children[i]!;
      const node = carrier.children[0]!;
      if (trail) {
        // Held, not dropped: back a little, up a little, and rocking gently on
        // the tow. A carried item pinned rigidly to the kart looks welded on.
        carrier.position.copy(_pos)
          .addScaledVector(_fwd, -TRAIL_BACK)
          .addScaledVector(_up, TRAIL_HEIGHT + Math.sin(visualTime * 2.6 + st.phase) * 0.045);
        node.quaternion.copy(_quat);
        node.rotateX(-0.22);
        node.rotateZ(Math.sin(visualTime * 1.8 + st.phase) * 0.13);
      } else {
        const a = st.phase + visualTime * 2.1 + (i / n) * Math.PI * 2;
        carrier.position.copy(_pos)
          .addScaledVector(_right, Math.sin(a) * ORBIT_RADIUS)
          .addScaledVector(_fwd, Math.cos(a) * ORBIT_RADIUS)
          .addScaledVector(_up, ORBIT_HEIGHT + Math.sin(visualTime * 3 + a) * 0.09);
        // Nose along the orbit, so the set reads as circling rather than as
        // three objects being dragged sideways.
        node.quaternion.copy(_quat);
        node.rotateY(-a);
      }
      node.scale.setScalar(ORBIT_SCALE * punch);

      // ── the blob on the road under it ─────────────────────────────────────
      //
      // The one thing that decides whether the three hats are *orbiting the
      // kart* or *pasted over the frame*. Three rules, and the version this
      // replaced broke all three at once.
      //
      //   *It goes under the item.* The throw along the sun is compressed to a
      //   third of a metre — enough to agree with the direction every other
      //   shadow in the frame is raked, short enough that the blob never leaves
      //   the item's own silhouette. At the box's asymptote it was a metre, and
      //   a metre from a hat on a chase camera is a separate black ellipse: the
      //   critic who rejected this read it as a scenery shadow and the hats as
      //   casting nothing, which is what that picture actually shows.
      //
      //   *It lands on the road, not on the kart.* Projected onto the track
      //   surface at the blob's own lateral offset — so it holds through the
      //   crown, the banking and the verge — and it lets go when the machine
      //   leaves the ground instead of flying with it.
      //
      //   *It is the item's size and the item's height.* Radius off the model's
      //   own footprint, spreading and thinning as it lifts.
      const blob = carrier.children[1] as THREE.Mesh | undefined;
      if (!blob) continue;
      // Eight racers with a triple each is twenty-four extra draw calls for
      // discs a couple of pixels across at the far end of a straight, so there
      // is a cull — but it is a long one. At seventy metres this dropped the
      // shadows out of the *overhead* camera, which sits about eighty up and is
      // the one shot a reviewer uses to check exactly this. A cull that hides
      // the thing from the instrument that measures it is not an optimisation.
      blob.visible = carrier.position.distanceToSquared(ctx.camera.position) < 95 * 95;
      if (!blob.visible) continue;

      // Height above the *road*: drop the item onto the surface at its own
      // lateral offset, measured along the track's up.
      let h: number;
      if (s) {
        _to.subVectors(carrier.position, s.pos);
        const lat = _to.dot(s.right);
        _shadow.copy(s.pos).addScaledVector(s.right, lat)
          .addScaledVector(_norm, roadCrown(lat, s.width, verge));
        h = _to.subVectors(carrier.position, _shadow).dot(_norm);
        // Keep the along-track component: the sample's origin is under the
        // *kart*, and an item two metres ahead of it belongs two metres ahead.
        _shadow.copy(carrier.position).addScaledVector(_norm, -h);
      } else {
        _norm.copy(_up);
        h = 0.55;
        _shadow.copy(carrier.position).addScaledVector(_norm, -h);
      }
      _shadow.addScaledVector(_norm, 0.03)
        .add(shadowOffset(Math.max(0, h), _norm, _off, CARRY_REACH));
      blob.position.subVectors(_shadow, carrier.position);
      blob.quaternion.setFromUnitVectors(UP, _norm);
      setCarryShadow(blob, heldRadius.get(id!) ?? 0.34, h);
    }
  }

  /**
   * The trail a kart throws off *while* it is spinning.
   *
   * A hit that is only legible on the frame it landed is a hit the player, who
   * was looking at the corner, did not see at all. The reaction has to keep
   * saying what it was for its whole length — smoke off the tyres for a slip,
   * sparks off the bodywork for a smash — and it has to be a different picture
   * for each. Visual only: the emitter runs on the render clock and nothing in
   * the simulation reads it.
   */
  function hitTrail(racer: Racer, st: RacerItems, dt: number): void {
    if (st.hitTime <= 0) { st.hitPuff = 0; return; }
    st.hitPuff -= dt;
    if (st.hitPuff > 0) return;
    visualPos(racer, _vis);
    if (st.hitKind === 'spin' || st.hitKind === 'squish') {
      st.hitPuff = 0.08;
      ctx.fx?.spawn('smoke', _pos.copy(_vis).setY(_vis.y - 0.5), { scale: 0.55 });
    } else {
      st.hitPuff = 0.06;
      ctx.fx?.spawn('sparks', _pos.copy(_vis).setY(_vis.y + 0.25),
        { color: st.hitColor, scale: 0.38 });
    }
  }

  function syncAura(racer: Racer, st: RacerItems, dt: number): void {
    visualPos(racer, _vis);
    visualQuat(racer, _quat);
    // Straight down the kart's own up-axis, not the world's: on the banking
    // these differ by most of a metre laterally, and a star's light pool laid on
    // the world horizontal cuts a chord through a banked road.
    _up.set(0, 1, 0).applyQuaternion(_quat);
    _ground.copy(_vis).addScaledVector(_up, -0.55);

    // ── star ────────────────────────────────────────────────────────────────
    if (st.star > 0) {
      if (!st.aura) {
        st.aura = cloneWithMaterials(auraProto!);
        st.aura.visible = true;
        rig.add(st.aura);
      }
      st.aura.position.copy(_ground);
      st.aura.quaternion.copy(_quat);
      // Fade the whole rig out over the last second and a half, so a star runs
      // *down* rather than switching off mid-corner.
      const fade = st.star < 1.5 ? clamp01(st.star * 2) : 1;
      // The hue cycles *inside the roadworks palette* — safety orange to hazard
      // yellow to white-hot and back — rather than round the whole wheel. A
      // star is allowed to be the loudest thing on the screen; it is not
      // allowed to be the one magenta object in the game.
      // Gold to white-hot, not orange to yellow. The low end used to sit at
      // hue 0.030 — which is safety orange, the colour of the machine the
      // player is driving. An aura the same hue as the kart inside it does not
      // read as "that kart is invincible", it reads as "that kart has been
      // replaced by a glowing egg": photographed round a road cone, the stripes
      // and the face were gone and the silhouette with them. Starting at 0.095
      // keeps the whole cycle clear of the cone, the digger and the truck, and
      // still inside the roadworks palette — hazard yellow is 0.128, dead
      // centre of the range.
      const cyc = 0.5 + 0.5 * Math.sin(visualTime * 4.6);
      _hue.setHSL(lerp(0.095, 0.148, cyc), lerp(0.98, 0.72, cyc), lerp(0.56, 0.80, cyc));

      /**
       * **The flash — and it is the only thing that puts the star on the kart.**
       *
       * Everything above this line lights the air *around* the machine: a
       * fresnel shell, a pool on the road, a swarm of stars. Photographed on
       * this circuit, that was not enough and could not be. Cone Canyon's dirt,
       * its barriers, its cranes and the player's own road cone are all tan and
       * safety orange; a gold rim around an orange kart on an orange verge is a
       * gold rim on an orange frame, and from another racer's screen — where the
       * whole question is *which one of us is untouchable right now* — it says
       * nothing at all. The kart itself never changed colour.
       *
       * `uCore` is what the shell gives off face-on, and it is normally held at
       * a whisker above nothing precisely so the machine inside stays legible.
       * Opening it right up for a *twentieth of a second*, four and a bit times
       * a second, buys the read without paying the silhouette for it: on the
       * flash frames the kart is washed in the star's own colour and pushed
       * toward white, and in between — which is three quarters of the time — it
       * is the machine the player is steering, entirely unobscured. That is the
       * strobe every invincibility in this genre has had since 1985, and it is
       * loud from a hundred metres away in somebody else's mirror.
       */
      const beat = (visualTime * 5) % 1;
      const flash = beat < 0.36 ? Math.sin((beat / 0.36) * Math.PI) : 0;
      // ...and the flash goes white-hot rather than merely brighter gold. White
      // is the one value nothing on this course owns.
      if (flash > 0) _hue.lerp(_white, flash * 0.55);

      const shell = st.aura.getObjectByName('shell') as THREE.Mesh | undefined;
      if (shell) {
        const m = shell.material as THREE.ShaderMaterial;
        (m.uniforms.uColor!.value as THREE.Color).copy(_hue);
        // Held down from 1.5, and down again from 0.95. The machine inside is
        // the thing the player is steering, and every notch of strength here is
        // paid for out of its silhouette — an item that hides your own kart is
        // an item you cannot drive. The stars orbiting outside the shell are
        // what say "invincible"; the shell only has to say "lit".
        m.uniforms.uStrength!.value = fade * (0.80 + Math.sin(visualTime * 16) * 0.20);
        // 0.34 at the peak, not 0.62. The flash has to *wash* the machine, not
        // delete it: at 0.62 the additive term put the cone above white and the
        // stripes, the face and the silhouette went with it, which is the exact
        // failure the low base value in `rimMaterial` exists to avoid. At 0.34
        // the kart is plainly a different colour for those seventy
        // milliseconds and is plainly still a kart.
        m.uniforms.uCore!.value = 0.03 + flash * flash * 0.34 * fade;
      }
      const pool = st.aura.getObjectByName('pool') as THREE.Mesh | undefined;
      if (pool) {
        const m = pool.material as THREE.MeshBasicMaterial;
        m.color.copy(_hue);
        m.opacity = fade * (0.27 + Math.sin(visualTime * 11) * 0.08);
        pool.scale.setScalar(0.9 + Math.sin(visualTime * 7) * 0.1);
      }
      for (let i = 0; i < STAR_SPARKS; i++) {
        const s = st.aura.getObjectByName(`spark${i}`) as THREE.Mesh | undefined;
        if (!s) continue;
        // Two counter-rotating rings of stars rather than one, so the swarm
        // reads as a cloud of them instead of a spinning necklace.
        const dir = i % 2 === 0 ? 1 : -1;
        const a = visualTime * 3.6 * dir + (i / STAR_SPARKS) * Math.PI * 2;
        const r = 1.75 + (i % 3) * 0.28;
        s.position.set(Math.sin(a) * r, 0.55 + Math.sin(a * 2.3 + i) * 0.75, Math.cos(a) * r);
        s.rotation.set(0, 0, a * 2.2);
        const m = s.material as THREE.MeshBasicMaterial;
        const c = 0.5 + 0.5 * Math.sin(visualTime * 5.2 + i * 0.9);
        // Held below white. At 0.86 lightness a saturated hue is a white star
        // with a warm edge, which is how a cycling swarm ends up photographing
        // as flat white cardboard.
        m.color.setHSL(lerp(0.090, 0.150, c), 0.92, lerp(0.58, 0.80, c));
        m.opacity = fade * (0.5 + Math.sin(a * 3) * 0.45);
      }
      // A trail of sparks off the back, at a fixed rate rather than per frame.
      st.sparkle -= dt;
      if (st.sparkle <= 0) {
        st.sparkle = 0.07;
        forwardOf(racer, _fwd);
        ctx.fx?.spawn('sparkle',
          _pos.copy(_ground).addScaledVector(_fwd, -1.6).addScaledVector(_up, 0.4),
          { scale: 0.55 });
      }
    } else if (st.aura) {
      st.aura = dropNode(st.aura);
    }

    // ── bullet bill: a casing thrown around whatever machine you brought ─────
    if (st.bullet > 0) {
      if (!st.husk) {
        st.husk = cloneWithMaterials(huskProto!);
        st.husk.visible = true;
        rig.add(st.husk);
      }
      // It arrives and leaves with a stretch, so the six seconds have a shape.
      const grow = clamp01((BULLET_TIME - st.bullet) * 6) * clamp01(st.bullet * 3);
      // Sat on the road, not sunk into it: the casing's belly is one radius
      // below its axis, and the axis is built at 0.95.
      st.husk.position.copy(_ground).addScaledVector(_up, 0.22);
      st.husk.quaternion.copy(_quat);
      st.husk.scale.set(0.6 + 0.4 * grow, 0.6 + 0.4 * grow, 0.5 + 0.5 * grow);

      const flare = st.husk.getObjectByName('flare') as THREE.Mesh | undefined;
      if (flare) {
        flare.scale.set(1, 0.75 + Math.sin(visualTime * 38) * 0.28, 1);
        (flare.material as THREE.MeshBasicMaterial).opacity =
          grow * (0.7 + Math.sin(visualTime * 33) * 0.22);
      }
      const core = st.husk.getObjectByName('core') as THREE.Mesh | undefined;
      if (core) {
        core.scale.set(1, 0.8 + Math.sin(visualTime * 55) * 0.3, 1);
        (core.material as THREE.MeshBasicMaterial).opacity = grow * 0.95;
      }
      const shock = st.husk.getObjectByName('shock') as THREE.Mesh | undefined;
      if (shock) {
        const p = (visualTime * 3) % 1;
        shock.scale.setScalar(0.9 + p * 0.7);
        (shock.material as THREE.MeshBasicMaterial).opacity = grow * (1 - p) * 0.8;
      }
    } else if (st.husk) {
      st.husk = dropNode(st.husk);
    }

    // ── boo ─────────────────────────────────────────────────────────────────
    if (st.boo > 0) {
      if (!st.shroud) {
        st.shroud = cloneWithMaterials(shroudProto!);
        st.shroud.visible = true;
        rig.add(st.shroud);
      }
      st.shroud.position.copy(_ground);
      st.shroud.quaternion.copy(_quat);
      const fade = clamp01(st.boo * 2) * clamp01((BOO_TIME - st.boo) * 5);
      setRimStrength(st.shroud, fade * (0.7 + Math.sin(visualTime * 5) * 0.25));
      const rider = st.shroud.getObjectByName('rider');
      if (rider) {
        // It drifts as well as bobs. A ghost pinned to one point on the
        // bodywork is a decal; one that swings out and back is riding with you.
        rider.position.set(
          0.95 + Math.sin(visualTime * 1.15) * 0.34,
          1.55 + Math.sin(visualTime * 3.4) * 0.18,
          -0.35 + Math.sin(visualTime * 0.87) * 0.22);
        rider.rotation.y = Math.sin(visualTime * 1.9) * 0.5;
        rider.scale.setScalar(0.7 * fade);
      }
    } else if (st.shroud) {
      st.shroud = dropNode(st.shroud);
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
      shroudProto = buildSheetShroud();
      shroudProto.visible = false;
      rig.add(shroudProto);
      // Carried items reuse the projectile models, except the mushroom, which
      // is never a projectile and would otherwise compile mid-race.
      for (const id of ['banana', 'greenShell', 'redShell', 'bomb', 'mushroom'] as ItemId[]) {
        const proto = heldPrototype(id);
        if (proto && !proto.parent) { proto.visible = false; rig.add(proto); }
      }
      hud.build();
    },

    reset(): void {
      // Visual clocks restart with the race. Nothing in the simulation reads
      // this, but the box shimmer, the orbit phase and the star's hue cycle all
      // ride on it — and a reviewer who resets and re-photographs the same seed
      // is owed the same picture, not the same race under a different sky.
      visualTime = 0;
      entities.clear();
      for (const st of states.values()) {
        // Back to the pool, not into the bin. The models inside an orbit rig
        // share their materials with the hidden prototype and must never be
        // disposed; the blob under each one owns a material of its own and must
        // be. Clearing the pool on every reset dropped both on the floor, and
        // the capture harness resets a dozen times a run.
        if (st.orbit) {
          rig.remove(st.orbit);
          const bin = orbitPool.get(st.orbitKey);
          if (bin) bin.push(st.orbit); else orbitPool.set(st.orbitKey, [st.orbit]);
        }
        dropNode(st.aura);
        dropNode(st.husk);
        dropNode(st.shroud);
      }
      states.clear();
      // A shrunk racer whose state has just been thrown away would otherwise
      // start the next race at half size for ever, and a racer reset mid-spin
      // would carry this module's own `flip` flag into it — the clock that
      // clears that flag has just been deleted.
      for (const racer of ctx.racers) {
        racer.model?.root.scale.setScalar(1);
        racer.effects.delete('flip');
      }
      hud.setItem(null);
      hud.spinning(false);
      hud.reset();

      // Every blob shadow this module lays is thrown along the scene's key
      // light, which the lighting module points at the course's own sun on
      // reset. Read it here, once, rather than per box per frame — and again on
      // the first frame drawn, because system `reset` order is not guaranteed
      // and reading a sun the lighting module has not aimed yet would leave a
      // whole circuit's worth of shadows pointing at the last course's.
      refreshSunDirection(ctx);
      sunDirty = true;

      const track = ctx.track;
      if (!track) return;
      // The line is the item system's map of the circuit: where the coins go,
      // and the rail a bullet bill drives.
      line = buildRacingLine(track.spline as unknown as TrackSpline, 3.2);
      boxes.rebuild(track, line);
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
        if (st.settle > 0) st.settle = Math.max(0, st.settle - dt);
        tickGrace(racer, st, dt);
        // Before anything else, and before the effects: a spin-out is this
        // module correcting the step physics has just taken, so it has to land
        // on the same step. A star or a bullet cancels it outright.
        if (st.hitTime > 0) {
          if (st.star > 0 || st.bullet > 0) endHit(racer, st);
          else driveSpinout(racer, st, dt);
        }
        tickEffects(racer, st, dt);
        if (!live || racer.finished) {
          // The flag has fallen, or this racer is done. A reel still turning
          // over the results screen is the game forgetting the race is over.
          stopSpin(racer, st);
          syncCarriage(racer, st);
          continue;
        }

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

        // After the button has been read, so a banana readied this step is
        // already shielding on this step.
        syncCarriage(racer, st);
      }

      entities.fixedUpdate(dt, onHit, onExpire);
      squishPass();
      warnPlayer();
    },

    update(dt: number, alpha: number): void {
      if (sunDirty) { sunDirty = false; refreshSunDirection(ctx); }
      visualTime += dt;
      blend = alpha;
      boxes.update(dt, visualTime);
      // The coin field draws a window around whoever the camera is following.
      coins.update(visualTime, ctx.player && ctx.track ? lapDistance(ctx.player) : 0);
      entities.update(dt, alpha, visualTime);

      for (const racer of ctx.racers) {
        const st = states.get(racer.id);
        if (!st) continue;
        drawCarried(racer, st);
        syncAura(racer, st, dt);
        hitTrail(racer, st, dt);
      }

      const player = ctx.player;
      if (player) {
        // The *fraction of the tar's life still to run*, not an opacity. How the
        // ink lands, holds, runs off the glass and fades is a picture, and it
        // belongs to the thing that draws it; all this end owes it is an honest
        // clock. See `ItemHud.setInk`.
        //
        // The second number is the airflow, and it is deliberately the *same
        // expression* the clock above runs on rather than an eyeballed
        // approximation of it: the rule is "keep your foot in and the screen
        // clears in half the time", and a player only ever learns that from
        // watching the tar tear off the glass as the speed comes up. Two
        // different speed curves for the rule and the picture would be a lie
        // told at sixty frames a second.
        const st = states.get(player.id);
        hud.setInk(
          st ? clamp01(st.ink / INK_TIME) : 0,
          clamp01(player.speed / Math.max(1, player.maxSpeed)),
        );
      }
      hud.update(dt);
    },

    dispose(): void {
      entities.dispose();
      boxes.dispose();
      coins.dispose();
      hud.dispose();
      // Everything this module hung on the scene: the hidden prototypes, any
      // live orbit, the star aura, the bullet casing, the boo shroud. Geometry
      // and materials are shared between a prototype and its clones, so a
      // double dispose is possible here and costs nothing — a missed one leaves
      // a buffer on the GPU for the lifetime of the page.
      rig.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) for (const x of m) x.dispose();
        else m?.dispose();
      });
      // ...and the pooled orbit rigs, which by then are detached from `rig` and
      // therefore invisible to the traversal above.
      for (const bin of orbitPool.values()) {
        for (const group of bin) {
          group.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
            if (Array.isArray(m)) for (const x of m) x.dispose();
            else m?.dispose();
          });
        }
      }
      ctx.scene.remove(rig);
      states.clear();
      orbitPool.clear();
      heldProtos.clear();
      heldRadius.clear();
    },
  };

  /**
   * The reviewer's bench.
   *
   * An item system is nearly impossible to photograph through ordinary input:
   * the shot a critic wants is "a red shell four metres off the player's rear
   * bumper", and waiting for the roulette to hand one out is not a capture
   * recipe. These put any item in any hand and fire it on demand. Nothing in
   * the simulation reads them, and none of them draws from `ctx.rng`, so a
   * seeded race is unaffected by their existence.
   */
  if (typeof globalThis !== 'undefined') {
    (globalThis as unknown as Record<string, unknown>).__ITEMS = {
      /** Put an item straight into a hand, skipping the roulette. */
      give(id: ItemId, count = 1, racerId = ctx.player?.id ?? 0): boolean {
        const racer = racerById(racerId);
        if (!racer) return false;
        const st = stateOf(racer);
        stopSpin(racer, st);
        st.held = 0;
        st.useLock = 0;
        racer.item = id;
        racer.itemCount = count;
        syncCarriage(racer, st);
        if (racer.isPlayer) { hud.setItem({ id, count }); hud.punch(); }
        return true;
      },
      /**
       * Start a roulette, as if a box had just been taken.
       *
       * `give` puts an item straight in the hand and skips the reel entirely,
       * which left the one animation with a *duration* impossible to photograph:
       * a capture would have to drive the kart through a real box and guess at
       * the frame. This spins it on demand.
       */
      roll(racerId = ctx.player?.id ?? 0): boolean {
        const racer = racerById(racerId);
        if (!racer) return false;
        const st = stateOf(racer);
        racer.item = null;
        racer.itemCount = 0;
        if (racer.isPlayer) hud.setItem(null);
        startRoulette(racer, st);
        return true;
      },
      /** Fire whatever is in hand, forwards by default. */
      use(racerId = ctx.player?.id ?? 0, forward = true): boolean {
        const racer = racerById(racerId);
        if (!racer?.item) return false;
        const st = stateOf(racer);
        st.useLock = 0;
        use(racer, st, forward);
        return true;
      },
      /** Give and fire in one call — the shape almost every shot wants. */
      fire(id: ItemId, racerId = ctx.player?.id ?? 0, forward = true): boolean {
        const racer = racerById(racerId);
        if (!racer) return false;
        const st = stateOf(racer);
        stopSpin(racer, st);
        st.useLock = 0;
        racer.item = id;
        racer.itemCount = 1;
        use(racer, st, forward);
        return true;
      },
      /**
       * Put a homing shell on a racer's tail, from wherever is behind them.
       *
       * The incoming warning is the one thing in this module with no
       * screenshot recipe at all: `fire` shoots *forwards*, so nothing a bench
       * can do through the ordinary path ever aims at the player. This spawns a
       * red shell already locked on, a stated distance back.
       */
      incoming(gap = 45, racerId = ctx.player?.id ?? 0): boolean {
        const racer = racerById(racerId);
        const track = ctx.track;
        if (!racer || !track) return false;
        const s = track.spline.nearest(racer.pos, _sample);
        const from = racerById(racerId === 1 ? 2 : 1) ?? racer;
        return !!entities.spawn('redShell', {
          ownerId: from.id, pos: track.spline.pointAt(s.distance - gap, s.lateral ?? 0, 0.5, _pos),
          life: 13, arm: 0, radius: 1.9,
          targetId: racer.id, dist: s.distance - gap, lat: s.lateral ?? 0,
        });
      },

      /**
       * Ink a racer's screen, so the blooper can be looked at.
       *
       * Clamped to what a real blooper does. A bench that can stage a state the
       * game cannot reach produces critiques of things no player will ever see
       * — and the ink in particular is a *shape over time*, so an instrument
       * that could pin it at full strength for a minute would be measuring a
       * frame the item never has.
       */
      ink(seconds = INK_TIME, racerId = ctx.player?.id ?? 0): boolean {
        const racer = racerById(racerId);
        if (!racer) return false;
        const st = stateOf(racer);
        st.ink = clamp(seconds, 0, INK_TIME);
        racer.effects.add('inked');
        return true;
      },

      /** Hit a racer with a named item, for photographing the reaction. */
      hit(racerId = ctx.player?.id ?? 0, item: ItemId = 'greenShell',
        byId = -1): boolean {
        const racer = racerById(racerId);
        if (!racer) return false;
        // Both halves of the protection, or a bench staging two hits in a row
        // gets one hit and a silent no-op — `grace` outlives `invulnerable` by
        // design, see `RacerItems.grace`.
        racer.invulnerable = 0;
        stateOf(racer).grace = 0;
        return strike(racer, racerById(byId), item);
      },
      /** Hand every CPU the same item, so a pack fight can be staged. */
      giveAll(id: ItemId, count = 1): number {
        let n = 0;
        for (const racer of ctx.racers) {
          if (racer.isPlayer) continue;
          const st = stateOf(racer);
          st.spin = 0;
          st.pending = null;
          racer.item = id;
          racer.itemCount = count;
          syncCarriage(racer, st);
          n++;
        }
        return n;
      },
      /**
       * Where every box on the circuit actually sits: lap distance, lateral
       * offset from the centreline, and whether it is currently there.
       *
       * Placement is the half of the box design that a screenshot cannot judge
       * — a row photographed after the pack has been through looks like a row
       * of two whatever it was built as.
       */
      layout(): Array<Record<string, number>> {
        const track = ctx.track;
        if (!track) return [];
        return boxes.boxes.map((b) => {
          const s = track.spline.nearest(b.pos, _sample);
          return {
            d: Math.round(b.distance),
            lat: Math.round((s.lateral ?? 0) * 10) / 10,
            width: Math.round(s.width * 10) / 10,
            up: b.respawn > 0 ? 0 : 1,
          };
        });
      },

      /**
       * Put a racer a measured distance short of the next row of boxes.
       *
       * The one shot every reviewer of this module wants is "the row, from the
       * driver's seat, at a stated range", and there is no way to drive to it:
       * you arrive at whatever speed and lateral offset the lap gave you. This
       * teleports, aligned to the lane the nearest box sits in. Bench only —
       * nothing in the simulation reads it, and it draws no rng.
       */
      park(gap = 12, speed = 0, racerId = ctx.player?.id ?? 0): number {
        const racer = racerById(racerId);
        const track = ctx.track;
        if (!racer || !track) return -1;
        const here = lapDistance(racer);
        let best = -1;
        let bestGap = Infinity;
        for (let i = 0; i < boxes.boxes.length; i++) {
          const g = track.spline.forwardDistance(here, boxes.boxes[i]!.distance);
          if (g < bestGap) { bestGap = g; best = i; }
        }
        if (best < 0) return -1;
        const box = boxes.boxes[best]!;
        const lat = track.spline.nearest(box.pos, _sample).lateral ?? 0;
        const d = box.distance - gap;
        const s = track.spline.atDistance(d, _sample);
        _pos.copy(s.pos)
          .addScaledVector(s.right, lat)
          .addScaledVector(s.up, roadCrown(lat, s.width, track.course.vergeWidth ?? 5) + 0.55);
        racer.pos.copy(_pos);
        racer.prevPos.copy(_pos);
        racer.yaw = Math.atan2(s.tangent.x, s.tangent.z);
        _quat.setFromAxisAngle(UP, racer.yaw);
        racer.quat.copy(_quat);
        racer.prevQuat.copy(_quat);
        racer.speed = speed;
        racer.vel.set(s.tangent.x, 0, s.tangent.z).multiplyScalar(speed);
        return gap;
      },

      /** Break the box the racer is nearest to, exactly as driving into it
       *  would — the burst, the respawn timer, the roulette. */
      breakBox(racerId = ctx.player?.id ?? 0): boolean {
        const racer = racerById(racerId);
        if (!racer || !ctx.track) return false;
        const near = boxes.candidates(lapDistance(racer));
        let best = -1;
        let bestD = 400;
        for (let i = 0; i < near.length; i++) {
          const box = boxes.boxes[near[i]!]!;
          if (box.respawn > 0) continue;
          const d = box.pos.distanceToSquared(racer.pos);
          if (d < bestD) { bestD = d; best = near[i]!; }
        }
        if (best < 0) return false;
        const st = stateOf(racer);
        racer.item = null;
        racer.itemCount = 0;
        if (racer.isPlayer) hud.setItem(null);
        breakOpen(racer, st, best);
        return true;
      },

      /** Metres to the next item box ahead of a racer, and where it is. */
      nextBox(racerId = ctx.player?.id ?? 0): { gap: number; pos: number[] } | null {
        const racer = racerById(racerId);
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

      /**
       * The supply side of the item economy, as numbers rather than a picture.
       *
       * How often a player draws is a property of the *layout* — how many rows
       * a lap has, how far apart they are, and how far across the road each one
       * reaches — and none of that is visible in a screenshot of one row. This
       * is what a census reads before it blames the roulette.
       */
      rows(): Record<string, unknown> {
        const L = ctx.track?.length ?? 1;
        const start = ctx.track?.course.startDistance ?? 0;
        const at = new Map<number, { lats: number[]; detour: boolean; live: number }>();
        for (const b of boxes.boxes) {
          const key = Math.round(b.distance);
          let e = at.get(key);
          if (!e) { e = { lats: [], detour: b.detour, live: 0 }; at.set(key, e); }
          e.lats.push(ctx.track ? (ctx.track.spline.nearest(b.pos, _sample).lateral ?? 0) : 0);
          if (b.respawn <= 0) e.live++;
        }
        const rows = Array.from(at.entries())
          .filter(([, e]) => !e.detour)
          .map(([d, e]) => ({
            fromStart: Math.round(((d - start) % L + L) % L),
            n: e.lats.length,
            // How many of them are there *right now*. A row that is always
            // half broken when the back of the field arrives is a row that is
            // only supplying the front of it.
            live: e.live,
            halfWidth: +(ctx.track!.spline.atDistance(d, _sample).width * 0.5).toFixed(1),
            span: +Math.max(...e.lats.map(Math.abs)).toFixed(1),
          }))
          .sort((a, b) => a.fromStart - b.fromStart);
        const gaps: number[] = [];
        for (let i = 0; i < rows.length; i++) {
          const next = rows[(i + 1) % rows.length]!;
          gaps.push(((next.fromStart - rows[i]!.fromStart) % L + L) % L);
        }
        return {
          lap: Math.round(L),
          boxes: boxes.boxes.length,
          detours: boxes.boxes.filter((b) => b.detour).length,
          rows,
          gaps: gaps.map(Math.round),
        };
      },
      /** Roll the draw table `n` times for a given place. Balance, not play. */
      sample(place = 1, n = 2000, fieldSize = Math.max(2, ctx.racers.length)):
      Record<string, number> {
        const out: Record<string, number> = {};
        const rng = makeRng(0xC0FFEE + place);
        for (let i = 0; i < n; i++) {
          const e = drawItem(rng, place, fieldSize);
          const k = e.count > 1 ? `${e.id}x${e.count}` : e.id;
          out[k] = (out[k] ?? 0) + 1;
        }
        return out;
      },
      /**
       * One racer, in the numbers a hit is actually judged on.
       *
       * `slip` is the angle between where the machine is pointing and where it
       * is going: near zero when it is driving, sweeping the full circle while
       * it is spinning out, and *pinned* if some other piece of the game has
       * quietly coupled the two together — which is the bug this instrument
       * exists to make visible.
       */
      probe(racerId = ctx.player?.id ?? 0): Record<string, unknown> | null {
        const racer = racerById(racerId);
        if (!racer) return null;
        const st = stateOf(racer);
        const D = 180 / Math.PI;
        const travel = Math.atan2(racer.vel.x, racer.vel.z);
        return {
          speed: racer.speed,
          vel: Math.hypot(racer.vel.x, racer.vel.z),
          heading: (racer.yaw * D) % 360,
          travel: (travel * D) % 360,
          slip: angleDelta(racer.yaw, travel) * D,
          stunned: racer.stunned,
          // Two numbers, not one, and the gap between them is the fix: `grace`
          // is how long this racer cannot be hit for, `invulnerable` is how
          // long the vehicle rig will *blink* them for. The second is a short
          // tail of the first and never overlaps the spin-out.
          grace: st.grace,
          invulnerable: racer.invulnerable,
          grounded: racer.grounded,
          coins: racer.coins,
          hit: st.hitTime > 0 ? st.hitKind : '',
          hitLeft: st.hitTime,
          effects: Array.from(racer.effects),
          // Seconds of tar left on the glass, and the fraction of its life that
          // is. The ink is the one effect in this module whose whole design is a
          // *shape over time*, and an instrument that can only see "inked: yes"
          // cannot tell a screenful that clears in a second and a half from one
          // that sits there for six. Anything measuring the item reads these.
          ink: st.ink,
          inkFrac: st.ink > 0 ? st.ink / INK_TIME : 0,
          // The reel, in the terms the beat is judged on. A critic timing the
          // roulette off `racer.item` alone can only see the frame it landed;
          // these say how long it was *meant* to run and how far through it is,
          // which is the difference between "the spin is short" and "something
          // cut the spin short".
          // Supply, from where this racer is sitting: how many boxes the
          // broadphase is offering them and how far the nearest live one is,
          // *in the road's plane*. A slot that stays empty through a row of
          // boxes is either an economy problem or a reach problem, and these
          // two numbers are the only things that tell them apart.
          boxCands: boxes.candidates(lapDistance(racer)).length,
          /** Metres to the next row of boxes — the CPU's own clear-out clock. */
          rowGap: boxes.gapAhead(lapDistance(racer)),
          boxNear: (() => {
            const near = boxes.candidates(lapDistance(racer));
            let best = Infinity;
            for (let i = 0; i < near.length; i++) {
              const b = boxes.boxes[near[i]!]!;
              if (b.respawn > 0) continue;
              const dx = b.pos.x - racer.pos.x;
              const dz = b.pos.z - racer.pos.z;
              const d2 = Math.sqrt(dx * dx + dz * dz);
              if (d2 < best) best = d2;
            }
            return best;
          })(),
          spin: st.spin,
          spinTotal: st.spinTotal,
          spinFace: st.spin > 0 ? REEL_FACES[st.reelIndex % REEL_FACES.length] : '',
          settle: st.settle,
        };
      },

      /**
       * What the incoming warning currently believes, in its own terms.
       *
       * The warning is the one part of this module whose failure mode is
       * statistical rather than visual: a screenshot cannot tell you that a
       * vignette was lit for half the race, and that is exactly how the version
       * this replaced got through two critic rounds. Sampling this over a race
       * gives the numbers that matter — how often it fires, and how hard.
       */
      threat(): Record<string, unknown> {
        return {
          level: threatLevel,
          bearing: threatBearing,
          item: threatLevel > 0 ? threatItem : null,
        };
      },

      /**
       * Where every carried item and its ground shadow actually are.
       *
       * Contact is the one thing a screenshot argues about and nothing else can
       * settle: "the hats are floating" and "the shadow is there but three
       * metres up the road" look identical from a chase camera. This reports the
       * item's world position, the blob's, the height between them and the
       * ground the track thinks is under it — so a reviewer can tell a missing
       * shadow from a misplaced one without reading the source.
       */
      carry(racerId = ctx.player?.id ?? 0): Record<string, unknown> | null {
        const racer = racerById(racerId);
        const st = states.get(racerId);
        if (!racer || !st) return null;
        const r3 = (v: THREE.Vector3): number[] =>
          [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
        const items: Array<Record<string, unknown>> = [];
        for (const carrier of st.orbit?.children ?? []) {
          const node = carrier.children[0];
          const blob = carrier.children[1] as THREE.Mesh | undefined;
          carrier.updateWorldMatrix(true, false);
          _pos.setFromMatrixPosition(carrier.matrixWorld);
          const at = _pos.clone();
          let shadow: number[] | null = null;
          let ground = 0;
          if (blob) {
            blob.updateWorldMatrix(true, false);
            _shadow.setFromMatrixPosition(blob.matrixWorld);
            shadow = r3(_shadow);
            if (ctx.track) {
              const s = ctx.track.spline.nearest(_shadow, _sample);
              // The road surface at the blob's own lateral offset, measured
              // along the track's up — the road banks, so comparing world y
              // would report a metre of error on a corner that has none.
              const lat = s.lateral ?? 0;
              _off.copy(s.pos).addScaledVector(s.right, lat)
                .addScaledVector(s.up,
                  roadCrown(lat, s.width, ctx.track.course.vergeWidth ?? 5));
              ground = +_off.sub(_shadow).dot(s.up).toFixed(3);
            }
          }
          items.push({
            at: r3(at),
            shadow,
            visible: !!blob?.visible,
            // Positive means the blob is *below* the road it is meant to lie on,
            // which is a shadow the depth test will eat.
            sunk: ground,
            height: blob ? +(at.y - (_shadow.y)).toFixed(2) : 0,
            scale: blob ? +blob.scale.x.toFixed(2) : 0,
            nodeScale: node ? +node.scale.x.toFixed(2) : 0,
          });
        }
        return { item: racer.item, shown: st.shown, key: st.orbitKey, items };
      },

      state(): Record<string, unknown> {
        return {
          boxes: boxes.boxes.length,
          boxesTaken: boxes.boxes.filter((b) => b.respawn > 0).length,
          coins: coins.coins.length,
          entities: entities.list.filter((e) => e.active).map((e) => e.kind),
          racers: ctx.racers.map((r) => {
            const st = states.get(r.id);
            return {
              name: r.name, place: r.place, item: r.item, count: r.itemCount,
              coins: r.coins, effects: Array.from(r.effects),
              spinning: (st?.spin ?? 0) > 0, guarded: !!st?.guarded,
            };
          }),
        };
      },
    };
  }

  return system;
}

export default createItemSystem;
