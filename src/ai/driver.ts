// CPU drivers.
//
// The AI does not cheat by driving on rails: it produces the same input struct a
// human produces and hands it to the same physics. That keeps the field honest —
// if the karts feel bad to drive, the AI looks bad too, which is a useful alarm.
//
// The brain is four layers, and they run in that order every fixed step:
//
//   1. KNOW    a speed and line plan for the whole lap, built once at reset
//              against this game's own handling curve (knowledge.ts). This is
//              what replaced "steer at a point 16m ahead and hope".
//   2. SEE     the shared world scan: every kart projected onto the track, the
//              bananas, bombs and shells lying in the road, and the item boxes
//              the field has learned by watching each other take them
//              (awareness.ts).
//   3. DECIDE  where on the road to be — the plan's line, bent by traffic, by
//              hazards, by the boost strips, by the gravel cut, and by whatever
//              this driver's personality wants (personality.ts, items.ts).
//   4. DRIVE   turn that into steer/throttle/brake/drift.
//
// Two things in here are worth reading before changing anything, because both
// were measured to be catastrophically wrong and both are easy to reintroduce.
//
// **A drift entry is a decision, not a per-step vote.** Every gate on the entry
// used to be re-run on all 120 steps a second, including the forty the kart
// spends in the air after the hop, and the button was released the instant any
// of them flickered. Physics reads that release as "never mind" and clears the
// armed direction, so the next step hops again. Measured: eight hundred hops a
// race per driver, twenty of which became drifts — the field was not failing to
// drift, it was bouncing down the road, and that is what put a fifth of every
// race on the dirt. Entries are now *armed* (`driftArm`) and hold the button and
// the wheel until physics has latched.
//
// **A drift is an arc the driver chooses.** The run-off predictor extrapolates
// the kart's current path curvature; in a drift that curvature is deliberately
// tight and can be opened at will, so extrapolating it predicts a mistake
// nobody is going to make. Predicting with the widest arc still available is
// what lets a charge survive to a real tier.
//
// The controller in step 4 is the part worth reading. It is not pure pursuit:
// aiming at a point thirty metres up the road corrects a line only weakly and
// lags a corner by a whole reaction time, and the measured result was a field
// that spent a third of every race on the dirt. It is instead the standard
// feed-forward plus PD form —
//
//     curvature = (the lane's own curvature)
//               + (2/Ld)   * heading error against the lane
//               + (2/Ld^2) * lateral error from the lane
//
// — which has no steady-state error at all, because the feed-forward already
// holds the corner and the two error terms only ever have to correct a
// disturbance. On top of that sits a run-off predictor: extrapolate the kart's
// own path curvature half a second forward, and if that puts it past the edge,
// take the road back and lift. That is the single rule that keeps a CPU on the
// tarmac, and it is exactly what a driver does when a corner arrives too fast.
//
// The rule that shapes all of it: **everything a CPU does must be something a
// player could have done.** No teleporting to the line, no free grip, no
// perfect throttle, no item placed where a human could not have placed it.
// Where a CPU is faster than a player it is because it braked in a better
// place, not because it was allowed to.

import * as THREE from 'three';
import {
  angleDelta, clamp, clamp01, damp, fbm1, lerp, moveToward, sign, smoothstep,
} from '../core/math.ts';
import type { Rng } from '../core/math.ts';
import type {
  AiDriver, GameContext, GameSystem, ItemId, RaceConfig, Racer, SplineSample, Surface,
  TrackSplineLike,
} from '../types.ts';
import type { InputState } from '../core/input.ts';
import {
  buildPlan, curvatureLimit, knowledgeFor, speedForCurvature, turnRateAt,
  type CutSeg, type DriverPlan, type TrackKnowledge,
} from './knowledge.ts';
import { dropWorld, getWorld, type World } from './awareness.ts';
import { REFERENCE, dealProfiles, temper, type DriverProfile } from './personality.ts';
import { decideItem, pressDuration, type ItemView } from './items.ts';

type KartConfig = GameContext['config']['kart'];

const OFFROAD: ReadonlySet<Surface> = new Set<Surface>(['dirt', 'grass', 'sand', 'water']);

/** Metres between the two lane samples the heading error is measured over. */
const LANE_DS = 7;
/** Half the width of a kart. Every lane margin is measured from its outside edge. */
const KART_HALF = 1.15;
/**
 * Lock held through a drift entry. Physics wants more than a fifth of a turn on
 * the wheel at the moment the hop lands or it latches nothing; this is that,
 * plus a margin for the steering smoothing, and no more. Anything larger turns
 * the kart in before the corner and drops it off the inside — the entry window
 * now opens twenty metres early, so the difference matters.
 */
const COMMIT_LOCK = 0.28;
/**
 * The field-cohesion half of the rubber band: metres of gap to the field's
 * median before it does anything, metres over which it reaches full strength,
 * and the top-speed multipliers at each end. Deliberately gentler and slower
 * than the player-relative term — this one is about where a kart ends up a lap
 * later, never about how it accelerates now.
 */
const PACK_DEAD = 70;
const PACK_SPAN = 300;
const PACK_AHEAD = 0.975;
const PACK_BEHIND = 1.05;
/** Scratch for the field median. Sized for any field a course will ever field. */
const _prog = new Float64Array(24);
/** Seconds the run-off predictor looks ahead. About one corner's worth of trouble. */
const RUNOFF_T = 0.8;
/**
 * Deceleration a driver counts on when picking a braking point, m/s².
 * `config.kart.brakeForce` is 30 plus engine braking; planning for all of it
 * leaves nothing in hand for arriving a metre late.
 */
const BRAKE_DECEL = 22;

const _to = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _here: SplineSample = blankSample();
const _view: ItemView = {
  held: 0, aheadGap: Infinity, aheadBearing: 0, behindGap: Infinity, behindBearing: 0,
  rivalsAhead: 0, straightness: 1, offroad: false, onCut: false, cutIn: Infinity,
  speedFrac: 0, cornerExitIn: 0, place: 1, fieldSize: 8,
};

function blankSample(): SplineSample {
  return {
    pos: new THREE.Vector3(), tangent: new THREE.Vector3(),
    right: new THREE.Vector3(), up: new THREE.Vector3(),
    width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
  };
}

/**
 * Signed angle from direction `a` to direction `b` in the XZ plane, positive
 * when `b` lies to `a`'s LEFT — it is `atan2(cross(a,b).y, dot(a,b))`, the
 * rotation about +Y that takes `a` to `b`.
 *
 * Every heading in this file is in that convention, and so is `steer`: physics
 * adds `steer * turnRate` to a yaw of `atan2(fwd.x, fwd.z)`, which swings the
 * nose from +Z toward +X — the driver's left, since the chase camera looks
 * along the heading and so puts world -X on the right of the screen. The track
 * spline's `right` vector points the same way this angle does, so a positive
 * lateral offset is to the left and positive curvature turns left.
 *
 * This block used to claim the exact opposite on every count. The maths was
 * right and self-consistent, so the CPUs always drove correctly and nothing
 * ever contradicted the prose — until the human key mapping was written to
 * match the comment instead of the code, and shipped steering inverted.
 */
const angBetween = (ax: number, az: number, bx: number, bz: number): number =>
  Math.atan2(-(ax * bz - az * bx), ax * bx + az * bz);

/**
 * The input struct this driver authors.
 *
 * Built once and mutated in place. A fresh `pressed` object every step is nine
 * hundred allocations a second across a field of eight, in the hottest loop the
 * game has, for no reason at all.
 */
function makeInput(): InputState {
  return {
    steer: 0, accel: 0, brake: 0, drift: false, item: false, look: 0,
    pressed: { item: false, drift: false },
    anyInput: true, source: 'keyboard',
  };
}

const MISTAKE_WIDE = 0;
const MISTAKE_LATE = 1;
const MISTAKE_LIFT = 2;
const MISTAKE_NAMES = ['wide', 'late', 'lift'] as const;

/**
 * Reasons a committed drift ended. Bench vocabulary; the sim never reads it.
 *
 * `exit` and `strain` are the two healthy ones — the mini-turbo cashed in on the
 * way out, and the road opening up past what a drift can be steered to. A
 * histogram dominated by anything else is a bug, and the previous build's was
 * dominated by a run-off save that no longer exists.
 */
/*
 * `strain` and `inside` used to be one bucket, and that hid the answer to the
 * only question this histogram is kept to answer. They are two different
 * failures: `strain` is the road opening up under a drift over a sustained
 * fraction of a second, which is healthy and is how an esse ends; `inside` is
 * the run-off predictor reporting that even the *widest* arc still available
 * puts the kart off the inside kerb, which fires on a single step and is a
 * driver who committed to a corner they cannot hold. Counted together they read
 * as "drifts end on strain", which is the answer that stopped four separate
 * attempts at the mini-turbo tiers from finding anything.
 */
const WHY_NAMES = ['strain', 'exit', 'end', 'past', 'slow', 'stray', 'hit', 'inside'] as const;
const WHY_STRAIN = 0, WHY_EXIT = 1, WHY_END = 2, WHY_PAST = 3;
const WHY_SLOW = 4, WHY_STRAY = 5, WHY_HIT = 6, WHY_INSIDE = 7;
/** How many drift endings the bench keeps, for a per-corner histogram. */
const LOG_SIZE = 64;

/**
 * Bench counters.
 *
 * An AI is the one system a screenshot cannot judge, and the two things this
 * round is measured on — how much of a lap is spent drifting and at what tier,
 * and how much of it is spent off the road for no reason — are frame counts, not
 * poses. Accumulating them here costs a handful of adds a step and makes the
 * review reproducible instead of anecdotal.
 */
interface Tally {
  steps: number;
  driftSteps: number;
  /** Steps spent at each tier while drifting, 0..3. */
  tierSteps: Int32Array;
  /** Times each tier was newly reached. */
  tierHit: Int32Array;
  maxTier: number;
  drifts: number;
  /** Tier the drift held when it ended. */
  endTier: Int32Array;
  why: Int32Array;
  offSteps: number;
  /** Off-road while committed to the signposted gravel cut — the legitimate kind. */
  offCut: number;
  /** Off-road more than 3s after any stun, and not on the cut. The bug. */
  offUnforced: number;
  /** ...of which: the lane itself was outside the paint (a planning bug)... */
  offLane: number;
  /** ...and the lane was fine and the kart simply was not on it. */
  offTrack: number;
  /** Metres past the white line, summed over off-road steps. */
  overSum: number;
  /** Steps below 12 m/s outside a stun — a kart that is beached, not racing. */
  crawlSteps: number;
  /** Off-road while sideways, and off-road on a boost. */
  offDrift: number;
  offBoost: number;
  /** ...split by what the boost was: [mini-turbo, pad, item, other]. */
  offBoostSrc: Int32Array;
  /** Off-road on the inside of the bend rather than running wide of it. */
  offInside: number;
  stunSteps: number;
  sinceStun: number;
  latSum: number;
  latSq: number;
  onSpeed: number;
  onSteps: number;
  offSpeed: number;
  offN: number;
  log: Int32Array;
  logAt: number;
}

function makeTally(): Tally {
  return {
    steps: 0, driftSteps: 0,
    tierSteps: new Int32Array(4), tierHit: new Int32Array(4), maxTier: 0,
    drifts: 0, endTier: new Int32Array(4), why: new Int32Array(WHY_NAMES.length),
    offSteps: 0, offCut: 0, offUnforced: 0, offLane: 0, offTrack: 0,
    overSum: 0, crawlSteps: 0, offDrift: 0, offBoost: 0,
    offBoostSrc: new Int32Array(4), offInside: 0, stunSteps: 0, sinceStun: 99,
    latSum: 0, latSq: 0, onSpeed: 0, onSteps: 0, offSpeed: 0, offN: 0,
    // [corner, why, tier] triples.
    log: new Int32Array(LOG_SIZE * 3), logAt: 0,
  };
}

function clearTally(t: Tally): void {
  t.steps = 0; t.driftSteps = 0; t.maxTier = 0; t.drifts = 0;
  t.tierSteps.fill(0); t.tierHit.fill(0); t.endTier.fill(0); t.why.fill(0);
  t.offSteps = 0; t.offCut = 0; t.offUnforced = 0; t.offLane = 0; t.offTrack = 0;
  t.overSum = 0; t.crawlSteps = 0; t.offDrift = 0; t.offBoost = 0; t.offBoostSrc.fill(0); t.offInside = 0;
  t.stunSteps = 0; t.sinceStun = 99;
  t.latSum = 0; t.latSq = 0; t.onSpeed = 0; t.onSteps = 0; t.offSpeed = 0; t.offN = 0;
  t.log.fill(0); t.logAt = 0;
}

/** Record why a drift ended, and at what tier, against the corner it was in. */
function noteEnd(b: Brain, why: number, tier: number, corner: number): void {
  const t = b.tally;
  t.why[why]++;
  t.endTier[clamp(tier, 0, 3)]++;
  const i = (t.logAt % LOG_SIZE) * 3;
  t.log[i] = corner; t.log[i + 1] = why; t.log[i + 2] = tier;
  t.logAt++;
}

/** Everything a driver remembers between steps. */
interface Brain {
  profile: DriverProfile;
  rng: Rng;
  plan: DriverPlan | null;
  planKey: string;

  /** Smoothed steering command, before the reflexes that bypass the lag. */
  steerCmd: number;
  /** damp() constant for the reaction lag, derived from skill and consistency. */
  reactSmoothing: number;
  /** Set for the one step a drift commit needs more lock than the line asks for. */
  commitSteer: number;
  wanderPhase: number;

  /**
   * Everything bending the lane away from the circuit's own line — traffic,
   * hazards, item boxes, wander. Rate-limited, because a driver's hands do not
   * teleport and a lane that jumps is a kart that saws at the wheel.
   */
  bend: number;
  /** Smoothed path curvature the kart is actually holding, 1/m. */
  kActual: number;
  velHeading: number;
  /** Strength of the current run-off save, 0 when there is nothing to save. */
  save: number;
  /** Metres of road the kart is predicted to run out of. 0 when it is fine. */
  runoff: number;
  /** Which side of the road that is: +1 to the driver's left, -1 to the right. */
  runoffSide: -1 | 0 | 1;

  /** Drift: which corner we committed to, and which way. */
  driftCorner: number;
  driftDir: -1 | 0 | 1;
  redriftLock: number;
  /** Seconds of protection a fresh drift gets from the run-off predictor. */
  driftGrace: number;
  /**
   * Seconds left of a *committed entry*: the button stays down and the wheel
   * stays turned until the hop has landed and physics has latched a direction.
   */
  driftArm: number;
  /** Cooldown after an arm that never became a drift. Stops the popcorn hop. */
  armCool: number;
  /** Seconds this drift has been held, and the tier it is chasing. */
  driftTime: number;
  driftAim: number;
  /**
   * Seconds the drift has been asking for less curvature than its widest arc
   * can give. Sustained, that is the one situation a drift cannot be steered
   * out of and has to be released.
   */
  strain: number;
  /**
   * ...and the same clock for the *other* way a drift stops working: the arc
   * driving the kart toward the inside of the corner.
   *
   * This used to have no clock at all — `insideEdge` released the drift on the
   * single step it first became true. Once the bench was taught to count the
   * two separately (`WHY_INSIDE`), the histogram came back unambiguous: across
   * a whole race, on two seeds, **every driver ended between twelve and
   * twenty-three drifts on `inside` and not one on `strain`**. That one
   * instantaneous test was the entire reason no CPU in this game had ever fired
   * a green mini-turbo, let alone a purple.
   *
   * It is also the wrong reflex. A drift's widest arc is
   * `counterSteer * yawBonus * turnRate(v) / v`, and `turnRate` falls with
   * speed slower than `v` rises — so the arc *opens as the kart goes faster*.
   * The cure for over-rotating in a drift is throttle, not release. So this
   * gets a short fuse, and while it is burning the speed floor below is allowed
   * to ask for the speed the arc actually needs.
   */
  inside: number;
  /** Why the last drift ended. Bench only — nothing in the sim reads it. */
  driftWhy: string;

  /** Traffic. */
  tailTime: number;
  passTarget: number;
  passSide: -1 | 1;
  passTime: number;
  passCool: number;
  queueLift: number;
  /** 0..1 — how deep into a rival's wake this driver is deliberately sitting. */
  tuck: number;

  /** The gravel cut currently committed to, or -1. */
  cut: number;

  /** Recovery. */
  stuckTime: number;
  reverseTime: number;

  /** Mistake budget. */
  mistakeIn: number;
  mistakeLeft: number;
  mistakeKind: number;

  /** Item button state machine. */
  itemId: ItemId | null;
  itemHeld: number;
  pressLeft: number;
  pressLock: number;
  itemWhy: string;

  /** Countdown. */
  startClock: number;
  startHold: number;

  /** Last decision, for the bench. */
  lastLat: number;
  lastVTarget: number;
  lastErr: number;
  lastTier: number;
  /** Plan curvature under the kart last step, for the bench's inside/outside split. */
  lastK: number;
  tally: Tally;
}

const brains = new WeakMap<AiDriver, Brain>();

// ── construction ────────────────────────────────────────────────────────────

export function createAiDriver(ctx: GameContext, skill: number, linePreference: number): AiDriver {
  const input = makeInput();

  const brain: Brain = {
    profile: REFERENCE,
    rng: ctx.rng.fork(),
    plan: null,
    planKey: '',
    steerCmd: 0,
    reactSmoothing: Math.exp(-1 / 0.1),
    commitSteer: 0,
    wanderPhase: 0,
    bend: 0,
    kActual: 0,
    velHeading: 0,
    save: 0,
    runoff: 0,
    runoffSide: 0,
    driftCorner: -1,
    driftDir: 0,
    redriftLock: 0,
    driftGrace: 0,
    driftArm: 0,
    armCool: 0,
    driftTime: 0,
    driftAim: 0,
    strain: 0,
    inside: 0,
    driftWhy: '',
    tailTime: 0,
    passTarget: -1,
    passSide: 1,
    passTime: 0,
    passCool: 0,
    queueLift: 0,
    tuck: 0,
    cut: -1,
    stuckTime: 0,
    reverseTime: 0,
    mistakeIn: 14,
    mistakeLeft: 0,
    mistakeKind: MISTAKE_WIDE,
    itemId: null,
    itemHeld: 0,
    pressLeft: 0,
    pressLock: 0,
    itemWhy: '',
    startClock: 0,
    startHold: 0.14,
    lastLat: 0,
    lastVTarget: 0,
    lastErr: 0,
    lastTier: 0,
    lastK: 0,
    tally: makeTally(),
  };

  const driver: AiDriver = {
    skill,
    linePreference,
    update(racer: Racer, dt: number): void {
      drive(ctx, driver, brain, racer, dt, input);
    },
  };

  brains.set(driver, brain);
  return driver;
}

/** Give a driver its character and build its plan. Called at every race reset. */
function configure(
  ctx: GameContext, driver: AiDriver, racer: Racer, profile: DriverProfile, rng: Rng,
): void {
  const b = brains.get(driver);
  if (!b) return;
  b.profile = profile;
  b.rng = rng.fork();
  b.steerCmd = 0;
  b.commitSteer = 0;
  b.bend = 0;
  b.kActual = 0;
  b.velHeading = 0;
  b.save = 0;
  b.runoff = 0;
  b.runoffSide = 0;
  b.driftCorner = -1;
  b.driftDir = 0;
  b.redriftLock = 0;
  b.driftGrace = 0;
  b.driftArm = 0;
  b.armCool = 0;
  b.driftTime = 0;
  b.driftAim = 0;
  b.strain = 0;
  b.inside = 0;
  b.driftWhy = '';
  b.tailTime = 0;
  b.passTarget = -1;
  b.passTime = 0;
  b.passCool = 0;
  b.queueLift = 0;
  b.tuck = 0;
  b.cut = -1;
  b.stuckTime = 0;
  b.reverseTime = 0;
  b.itemId = null;
  b.itemHeld = 0;
  b.pressLeft = 0;
  b.pressLock = 0;
  b.itemWhy = '';
  b.startClock = 0;
  b.mistakeLeft = 0;
  b.lastTier = 0;
  b.wanderPhase = b.rng.range(0, 400);
  clearTally(b.tally);

  // Reaction lag as a time constant, converted to the `damp` smoothing this
  // codebase speaks: the fraction of the error still standing after a second.
  // The band is narrow on purpose. Beyond about a fifth of a second the lag
  // starts to fight the steering controller rather than colour it, and what
  // comes out is not a worse driver but a wobbling one.
  const tau = ctx.config.ai.reactionTime
    * lerp(1.30, 0.55, clamp01(driver.skill))
    * lerp(1.25, 0.85, profile.consistency);
  b.reactSmoothing = Math.exp(-1 / Math.max(0.03, tau));

  // The start. A driver either lands the rocket window or misses it — the field
  // must not all leave the line together, and it must not all leave it well.
  const good = b.rng.bool(clamp01(driver.skill * profile.consistency + 0.12));
  b.startHold = good ? b.rng.range(0.09, 0.21) : b.rng.range(0.34, 0.8);
  b.mistakeIn = b.rng.range(4, 12) + lerp(6, 34, profile.consistency);

  rebuildPlan(ctx, driver, racer);
}

function rebuildPlan(ctx: GameContext, driver: AiDriver, racer: Racer): void {
  const b = brains.get(driver);
  const track = ctx.track;
  if (!b || !track) return;
  const know: TrackKnowledge = knowledgeFor(track);
  const p = b.profile;
  b.plan = buildPlan(ctx.config, track, know, {
    bravery: p.bravery,
    driftLove: p.driftLove,
    apexShift: p.apexShift,
    lineGain: p.lineGain,
    linePreference: driver.linePreference,
    skill: clamp01(driver.skill),
    stats: racer.stats,
    classMul: ctx.config.race.classes[ctx.race.engineClass].speedMul,
  });
  b.planKey = planKeyFor(ctx, track.id, racer);
}

const planKeyFor = (ctx: GameContext, trackId: string, racer: Racer): string =>
  `${trackId}:${ctx.race.engineClass}:${racer.vehicleId}`;

// ── the lane ────────────────────────────────────────────────────────────────

/**
 * How close to the edge this driver is willing to put the kart *right now*.
 *
 * The plan already keeps its line off the paint, but a plan is a geometric
 * ideal and a kart is a thing with momentum. The faster it is going and the
 * more sideways it is, the more road it needs in hand — and a brave driver
 * needs the same amount and takes less of it, which is why the brave ones are
 * the ones who end up in the gravel.
 */
function laneLimit(halfAt: number, speed: number, drifting: boolean, bravery: number): number {
  // Kart half-width, then the paint, then what the kart is going to need to
  // give back when it does not track the lane exactly. Bravery buys a little of
  // that margin back and nothing else — the brave ones are supposed to be the
  // ones who end up in the gravel, not the whole field.
  const m = KART_HALF + 1.25 + clamp(speed * 0.036, 0, 2.0)
    + (drifting ? 1.3 : 0) - lerp(0.0, 0.5, bravery);
  return Math.max(1.2, halfAt - m);
}

/** 0..1 — how far onto the gravel cut a station is. */
function cutBlend(spline: TrackSplineLike, cut: CutSeg, dq: number): number {
  const inRel = spline.signedDistance(cut.approach, dq);
  const outRel = spline.signedDistance(cut.d1, dq);
  return smoothstep(clamp01(inRel / Math.max(6, cut.d0 - cut.approach)))
    * (1 - smoothstep(clamp01(outRel / Math.max(6, cut.rejoin - cut.d1))));
}

/**
 * Slide the lane onto a boost strip.
 *
 * Station-local rather than kart-local: the controller reads the lane at two
 * places at once, and a divert that depended on where the *kart* was would give
 * the two reads different answers and invent a heading error out of nothing.
 */
function padLane(plan: DriverPlan, l: number, dq: number, greed: number): number {
  const know = plan.know;
  const L = know.length;
  for (let i = 0; i < know.pads.length; i++) {
    if (!plan.padWorth[i]) continue;
    const pad = know.pads[i];
    if (Math.abs(pad.lat - l) > lerp(3, 9, greed)) continue;
    const span = pad.d1 - pad.d0;
    const into = (((dq - pad.d0) % L) + L) % L;
    let w: number;
    if (into <= span) w = 1;
    else {
      // Ease on over the thirty metres before it, and off over the ten after.
      const before = L - into;
      const after = into - span;
      w = before < 30 ? smoothstep(1 - before / 30)
        : after < 10 ? 1 - smoothstep(after / 10)
          : 0;
    }
    if (w <= 0) continue;
    return lerp(l, pad.lat, w * lerp(0.5, 0.95, greed));
  }
  return l;
}

/**
 * The lane, at any station on the lap.
 *
 * The circuit's own answer — the plan's line, diverted onto a boost strip,
 * blended onto the gravel cut — plus the slowly-moving `bend` that holds
 * everything about traffic and hazards. Being a pure function of the station is
 * what lets the controller sample it twice and read a heading off the
 * difference.
 */
function laneAt(
  ctx: GameContext, b: Brain, plan: DriverPlan, cut: CutSeg | null,
  dq: number, speed: number, drifting: boolean,
): number {
  const spline = ctx.track!.spline;
  const halfAt = plan.know.read(plan.know.half, dq);
  // How far past the speed this line was drawn for the kart actually is.
  //
  // A racing line's exit *is* the outside of the road — and a mini-turbo fires
  // exactly there, at a speed the brakes cannot take back: `boost.pull` drags
  // the kart up to its target whether or not the brake is down. Measured, that
  // one interaction was five to ten per cent of the entire race spent on the
  // dirt, almost all of it under a `drift1/2/3` boost. So a kart carrying a
  // boost through a corner aims further inside the paint, and gives itself the
  // road to run wide into that the line alone does not leave.
  const over = clamp01((speed / Math.max(12, plan.vAt(dq)) - 1) / 0.22);
  const lim = Math.max(1.2,
    laneLimit(halfAt, speed, drifting, b.profile.bravery) - over * 3.2);
  let l = padLane(plan, plan.latAt(dq), dq, b.profile.greed) + b.bend;
  // A drifting kart travels wider than its nose says it will — the tyres are
  // sliding, that is the whole manoeuvre — so a driver aims one at the inside
  // of the corner and lets the slide carry it back out to the line. Two things
  // fall out of that: the kart stops using up the outside verge it was
  // measurably living on, and it ends up where a drifting kart is supposed to
  // be photographed, sparking off the apex kerb rather than tidily mid-road.
  // A pure function of the station, so the two lane reads stay consistent.
  if (drifting) l -= sign(plan.kAt(dq)) * lerp(0.5, 1.2, b.profile.driftLove);
  l = clamp(l, -lim, lim);
  // The cut is deliberately off the road, so it wins its own blend rather than
  // being clamped back onto the tarmac it is there to avoid.
  if (cut) l = lerp(l, cut.lat, cutBlend(spline, cut, dq));
  return l;
}

// ── one step of driving ─────────────────────────────────────────────────────

function drive(
  ctx: GameContext, driver: AiDriver, b: Brain, racer: Racer, dt: number, input: InputState,
): void {
  racer.aiInput = input;
  input.pressed.item = false;
  input.pressed.drift = false;
  input.look = 0;

  const track = ctx.track;
  if (!track) {
    input.accel = 1; input.steer = 0; input.brake = 0; input.drift = false;
    return;
  }

  // The plan is per (course, class, kart). Any of the three changing invalidates
  // it — and a driver attached mid-race by the harness has none at all.
  if (!b.plan || b.planKey !== planKeyFor(ctx, track.id, racer)) rebuildPlan(ctx, driver, racer);
  const plan = b.plan;
  if (!plan) { input.accel = 1; input.steer = 0; return; }

  // ── the line-up ───────────────────────────────────────────────────────
  if (ctx.race.phase === 'countdown') {
    input.steer = 0; input.brake = 0; input.drift = false; input.item = false;
    // `race.countdown` reads 0 for exactly the last second, so a driver can aim
    // at the rocket-start window (0.02s..0.28s of held throttle) by counting
    // from that edge — the same information a player gets from the lights.
    if (ctx.race.countdown <= 0) b.startClock += dt; else b.startClock = 0;
    input.accel = b.startClock >= 1 - b.startHold ? 1 : 0;
    return;
  }

  if (racer.finished) {
    input.accel = 0; input.brake = 0.2; input.drift = false; input.item = false;
    input.steer = damp(input.steer, 0, 0.001, dt);
    return;
  }

  // Spun out: the wheel is out of our hands until it stops. Drop everything that
  // would otherwise resume the instant control comes back.
  if (racer.stunned > 0) {
    input.accel = 0; input.brake = 0; input.steer = 0;
    input.drift = false; input.item = false;
    if (b.driftCorner >= 0) {
      b.driftWhy = WHY_NAMES[WHY_HIT];
      noteEnd(b, WHY_HIT, racer.drift.tier, b.driftCorner);
    }
    b.driftCorner = -1; b.driftDir = 0; b.passTime = 0; b.tailTime = 0; b.pressLeft = 0;
    b.driftArm = 0; b.strain = 0; b.inside = 0; b.driftTime = 0;
    b.tuck = 0; b.save = 0; b.runoff = 0; b.runoffSide = 0;
    return;
  }

  // A bullet bill flies itself. Fighting it does nothing except look like a kart
  // having a seizure.
  if (racer.effects.has('bullet')) {
    input.accel = 1; input.brake = 0; input.steer = 0; input.drift = false;
    return;
  }

  const world = getWorld(ctx);
  const me = world.indexOf(racer);
  if (me < 0) { input.accel = 1; input.steer = 0; return; }

  const K = ctx.config.kart;
  const spline = track.spline;
  const d = world.dist[me];
  const lat = world.lat[me];
  const p = b.profile;
  const speed = racer.speed;
  const topSpeed = K.maxSpeed * lerp(0.86, 1.14, racer.stats.speed)
    * ctx.config.race.classes[ctx.race.engineClass].speedMul;
  const offroad = OFFROAD.has(racer.surface);
  const drifting = racer.drift.active;

  spline.atDistance(d, _here);

  b.redriftLock = Math.max(0, b.redriftLock - dt);
  b.driftGrace = Math.max(0, b.driftGrace - dt);
  b.passCool = Math.max(0, b.passCool - dt);
  b.pressLock = Math.max(0, b.pressLock - dt);
  tickMistakes(b, dt);

  // What the kart is actually doing, as opposed to what it was asked to do.
  // The run-off predictor is built on this: the difference between the path the
  // kart is on and the path the road is on is the whole question.
  const heading = Math.atan2(racer.vel.x, racer.vel.z);
  const turnRate = speed > 4 ? angleDelta(b.velHeading, heading) / dt : 0;
  b.velHeading = heading;
  b.kActual = damp(b.kActual, speed > 6 ? clamp(turnRate / speed, -0.2, 0.2) : 0, 1e-8, dt);

  // ── the gravel cut ────────────────────────────────────────────────────
  // A detour is only worth taking with something to spend on it: the surface
  // takes a third of the top speed away, so a kart that arrives without a boost
  // simply loses the time the shorter path saved.
  const cut = chooseCut(ctx, b, plan.know, racer, d, topSpeed);

  // ── everything that is not the circuit ────────────────────────────────
  const traffic = scanTraffic(ctx, world, me, d, lat, racer);
  const laneRef = plan.latAt(d + 10);
  let bend = trafficBend(ctx, b, racer, plan, world, traffic, laneRef, d, dt);
  bend += avoidance(ctx, world, me, d, laneRef + bend, racer);
  bend += boxSeek(ctx, world, racer, d, laneRef + bend, speed, p.greed);

  // Running wide: the apex simply arrives without them. The outside of a corner
  // is the far side from its apex, and the apex of a positive-curvature corner
  // sits at negative lateral.
  if (b.mistakeLeft > 0 && b.mistakeKind === MISTAKE_WIDE) {
    bend += sign(plan.kAt(d + 10)) * 2.4 * clamp01(b.mistakeLeft);
  }

  // Steering wander. Slow and small — the difference between a driver and a
  // rail, not a driver having a fit.
  b.wanderPhase += dt * lerp(0.3, 1.05, 1 - p.consistency);
  bend += fbm1(b.wanderPhase, 2) * lerp(0.15, 1.4, 1 - p.consistency);

  // The lane moves at a driver's pace, never at a solver's. Without this the
  // lane snaps several metres the instant a rival crosses a threshold, and the
  // controller — correctly — tries to follow it.
  const bendRate = lerp(7, 16, p.aggression) * lerp(0.85, 1.15, p.consistency);
  b.bend = moveToward(b.bend, clamp(bend, -14, 14), bendRate * dt);

  // ── steering ──────────────────────────────────────────────────────────
  // How far up the road the lane is read, and with it the feed-forward
  // curvature. It has to cover everything between the command and the kart's
  // path actually bending — the reaction lag, the steering smoothing, the tyres
  // taking a moment — or the kart turns in a reaction time late and the corner
  // is entered from outside it. A fifth of a second's travel is about that.
  const previewD = clamp(speed * 0.15, 2, 11);
  const laneHere = laneAt(ctx, b, plan, cut, d + previewD, speed, drifting);
  const laneNext = laneAt(ctx, b, plan, cut, d + previewD + LANE_DS, speed, drifting);
  b.lastLat = laneHere;
  b.lastK = plan.kAt(d);

  _fwd.set(Math.sin(racer.yaw), 0, Math.cos(racer.yaw));
  // Heading of the kart, and of the lane, both relative to the road.
  //
  // The kart's heading here is the direction it is *travelling*, not the
  // direction it is pointing. In a committed drift those differ by up to 38° —
  // that is what a drift is — and a controller fed the chassis angle reads
  // nearly forty degrees of heading error that does not exist, decides it is
  // already turning far harder than the corner needs, and counter-steers out of
  // the corner it is in the middle of. Which is precisely what the field was
  // doing at every apex on the circuit.
  const travelling = speed > 5;
  const dirX = travelling ? Math.sin(heading) : _fwd.x;
  const dirZ = travelling ? Math.cos(heading) : _fwd.z;
  const psiKart = angBetween(_here.tangent.x, _here.tangent.z, dirX, dirZ);
  const psiLane = Math.atan2(-(laneNext - laneHere), LANE_DS);
  const psi = angleDelta(psiKart, psiLane);
  const e = clamp(lat - laneHere, -14, 14);
  b.lastErr = e;

  // Ld is a *distance*, so the response is the same shape at every speed: the
  // lane is closed over roughly two of them however fast the kart is going.
  //
  // It is deliberately long. Everything between the command and the kart's
  // actual path — the reaction lag, the steering smoothing, the tyres taking a
  // moment to bend the trajectory round to the new heading — is about two
  // tenths of phase lag, and a short Ld puts the loop's natural frequency right
  // where that lag eats the damping. The measured symptom is a kart weaving six
  // metres either side of a straight it is supposedly tracking. A long Ld costs
  // nothing in corners, because the feed-forward is already holding the corner;
  // the error terms only ever have to mop up a disturbance.
  const Ld = clamp(9 + speed * 0.45, 14, 38) * lerp(0.92, 1.10, p.consistency);
  const kLimit = curvatureLimit(ctx.config, speed, racer.stats.handling, 1);
  const tr = Math.max(0.2, turnRateAt(ctx.config, speed, racer.stats.handling));
  /** The widest arc a committed drift can be steered to at this speed. */
  const widestK = K.drift.counterSteer * K.drift.yawBonus * tr / Math.max(8, speed);
  let kCmd = plan.kAt(d + previewD + LANE_DS * 0.5)
    + (2 / Ld) * psi
    + (2 / (Ld * Ld)) * e;

  // ── keeping it on the road ────────────────────────────────────────────
  // Where the kart ends up in `RUNOFF_T` seconds if it keeps doing exactly what
  // it is doing now. Relative to the road, its lateral acceleration is the
  // difference between its own path curvature and the road's — a kart matching
  // the corner holds its lateral offset, one going straighter than the corner
  // slides toward the outside at a rate that says exactly when it arrives.
  //
  // The road's curvature here is the spline's own, measured over a long
  // baseline and so a little flattered on the tight stuff. That is the right
  // error to have: it makes the predictor slightly slow to shout in a hairpin,
  // where the driver is already braking and steering for everything it is
  // worth, rather than permanently jumpy in one.
  const travel = Math.max(6, speed * RUNOFF_T);
  const kRoad = -_here.curvature;
  const latRate = racer.vel.dot(_here.right);
  // Predict with the path the driver *will* be on, not the one the kart happens
  // to be on this instant.
  //
  // In a committed drift the stick chooses an arc anywhere between `widestK` and
  // full lock, and a driver who is turning tighter than the corner needs simply
  // steers out. Extrapolating the current, deliberately-tight arc for eight
  // tenths of a second therefore predicts a mistake nobody is going to make —
  // and the measured consequence was catastrophic: the moment `driftGrace` ran
  // out this fired, and sixteen of every twenty drifts in the race died as a
  // run-off save, none of them past a blue turbo. So while drifting, the
  // prediction uses the widest arc still available, which is the honest worst
  // case the driver cannot steer away from.
  let kPath = b.kActual;
  if (drifting && racer.drift.dir !== 0) {
    const wide = racer.drift.dir * widestK;
    kPath = racer.drift.dir > 0 ? Math.min(kPath, wide) : Math.max(kPath, wide);
  }
  const latFuture = lat + latRate * RUNOFF_T
    - (kPath - kRoad) * speed * speed * RUNOFF_T * RUNOFF_T * 0.5;
  const halfFuture = plan.know.read(plan.know.half, d + travel);
  // On the gravel cut the edge that matters is the far side of the verge, not
  // the white line — the whole point of being there is to be off the tarmac.
  // Leaving the save switched off entirely, which is what this used to do, let
  // a kart run straight through the gravel into the sand and the barrier
  // beyond it, and the shortcut cost more than it ever saved.
  const verge = track.course.vergeWidth ?? 5;
  const edge = cut ? halfFuture + verge - 2.0 : halfFuture;
  const safe = Math.max(2, edge - (2.3 + (drifting ? 0.8 : 0) - lerp(0.6, 0, p.bravery)));

  b.save = 0;
  b.runoff = 0;
  b.runoffSide = 0;
  // Half a metre of dead band. Without it the predictor's own noise keeps a
  // token save switched on for most of the lap, and everything hung off it —
  // the throttle lift, the drift veto — is then permanently half-applied.
  if (Math.abs(latFuture) > safe + 0.5) {
    // Metres of road the kart is predicted to run out of. *This* is the number
    // the driver acts on, and it is kept separate from the steering correction
    // below on purpose: the correction is bounded by what the tyres own, so in
    // a corner already taken at the limit it is small however bad the overshoot
    // is — and the previous build hung the throttle lift off its size, with a
    // threshold of 30% of full lock it could essentially never reach. The
    // measured result was a field that never once lifted for a corner it was
    // about to run out of, and spent a fifth of the race on the dirt.
    b.runoff = Math.abs(latFuture) - safe;
    b.runoffSide = latFuture < 0 ? -1 : 1;
    // The curvature that closes the overshoot inside the prediction window,
    // with the gain rising as the overshoot does — a metre wide is a correction,
    // four metres wide is an emergency.
    // Positive lateral is to the driver's left and positive curvature turns
    // right, so the correction carries the *same* sign as the overshoot.
    const urgency = lerp(1, 2.6, clamp01(b.runoff / 4));
    b.save = sign(latFuture)
      * clamp((2 * b.runoff * urgency) / (travel * travel), 0, kLimit * 1.25);
    kCmd += b.save;
  }
  kCmd = clamp(kCmd, -kLimit * 1.6, kLimit * 1.6);

  // Curvature is the right currency at racing speed and the wrong one at walking
  // pace: `kCmd * speed / tr` divides by a yaw rate that is three times larger
  // down there, so a kart crawling out of the sand fourteen metres off the
  // centreline asks for six hundredths of a turn of lock and simply carries on
  // along the barrier. Measured, that stranded a kart for a whole race. Below
  // ~18 m/s the command crosses over to a direct heading-and-offset term, which
  // is what a driver actually uses to point a stopped kart back down the road.
  const direct = clamp(psi * 1.9 + e * 0.14, -1, 1);
  const curve = clamp((kCmd * speed) / tr, -1, 1);
  let want = lerp(direct, curve, smoothstep(clamp01((speed - 5) / 13)));

  // ── drift ─────────────────────────────────────────────────────────────
  b.commitSteer = 0;
  const driftDir = driftControl(
    ctx, b, plan, racer, d, speed, kCmd, widestK, offroad, dt, input, K);
  if (driftDir !== 0 && racer.drift.active) {
    // While a drift is committed, physics ignores the magnitude of the stick and
    // reads only how far *into* the drift it is pushed — between a hairpin-tight
    // arc and the wide counter-steered one. Solve for the `into` that produces
    // the curvature we actually want, instead of holding full lock and hoping.
    const c = K.drift.counterSteer;
    const band = Math.max(0.05, 1 - c);
    const need = (Math.abs(kCmd) * speed) / Math.max(0.2, tr * K.drift.yawBonus);
    let into = sign(kCmd) === driftDir ? clamp01((need - c) / band) : 0;
    // Lean in when there is road to lean into.
    //
    // Sitting at the wide end of the band is the cheapest way to hold a corner
    // and the worst-looking: the chassis only pivots 17°, the sparks barely
    // show, and the charge accrues a quarter slower for it. So a driver who is
    // not fighting for the road pushes the stick into the drift — which is both
    // what a player does and what makes a CPU legible as *drifting* rather than
    // as understeering with the button held.
    if (b.runoff === 0 && b.strain <= 0) into = Math.max(into, lerp(0.10, 0.28, p.driftLove));
    want = driftDir * (into * 2 - 1);
  } else if (driftDir !== 0) {
    // Armed but not yet sideways: the hop is in the air and physics is waiting
    // for enough lock to latch a direction. Give it that, unconditionally.
    want = clamp(want + driftDir * 0.22, -1, 1);
  }

  b.steerCmd = damp(b.steerCmd, want, b.reactSmoothing, dt);
  // Sliding across gravel with the wheel wound on only digs in deeper.
  input.steer = clamp(b.steerCmd * (offroad && !cut ? 0.85 : 1), -1, 1);
  // A save is a reflex, not a decision: it does not wait out a reaction time.
  // Neither does committing to a drift — physics wants more than a third of
  // lock during the hop, and a lag would arrive with it a corner later.
  if (b.save !== 0 && driftDir === 0) {
    const reflex = clamp((kCmd * speed) / tr, -1, 1);
    if (Math.abs(reflex) > Math.abs(input.steer) && sign(reflex) === sign(b.save)) {
      input.steer = reflex;
      b.steerCmd = damp(b.steerCmd, reflex, 0.02, dt);
    }
  }
  if (b.commitSteer !== 0 && Math.abs(input.steer) < Math.abs(b.commitSteer)) {
    input.steer = b.commitSteer;
    b.steerCmd = b.commitSteer;
  }

  // ── throttle ──────────────────────────────────────────────────────────
  // Read the whole braking zone, not one point in it. The plan already walks
  // the lap backwards and encodes braking points, but it does that at *its*
  // deceleration, and a driver reading a single station ahead inherits whatever
  // that assumption got wrong — arriving at a hairpin ten m/s hot with the
  // brakes already buried. Asking "what may I be doing now and still make every
  // station between here and eighty metres up the road" makes the braking point
  // fall out of the geometry instead.
  const react = Math.max(6, speed * 0.26);
  let vTarget = plan.vAt(d + react);
  for (let i = 1; i <= 6; i++) {
    const ahead = react + i * 13;
    const cap = Math.sqrt(plan.vAt(d + ahead) ** 2 + 2 * BRAKE_DECEL * (ahead - react));
    if (cap < vTarget) vTarget = cap;
  }
  if (b.mistakeLeft > 0 && b.mistakeKind === MISTAKE_LATE) vTarget *= 1.1;
  if (cut && racer.boost.time <= 0 && !racer.effects.has('star')) {
    // On the gravel the ceiling is the surface's, not the plan's.
    vTarget = Math.min(vTarget, topSpeed * 0.72);
  }
  // Somebody stopped in the road is a corner you did not plan for.
  if (traffic.blockStunned && traffic.blockGap < 16) {
    vTarget = Math.min(vTarget, Math.max(12, traffic.blockSpeed + 7));
  }
  // Running out of road, and not by a little. A driver who is genuinely fighting
  // the corner does not also carry the entry speed through it — but a lift that
  // engages the moment the prediction twitches is a driver who never opens the
  // throttle at all, so it is measured in metres of overshoot and needs a real
  // one before it bites.
  // ...but only for running *wide*. A drift that is turning tighter than the
  // corner is predicted to leave the road on the inside, and braking makes that
  // strictly worse: slower means a bigger yaw rate, means a tighter arc, means
  // further inside. Measured, that feedback loop put a fifth of the race on the
  // inside verge on its own.
  const insideOfDrift = drifting && racer.drift.dir !== 0
    && b.runoffSide !== racer.drift.dir;
  if (b.runoff > 0.8 && !insideOfDrift) {
    const bite = clamp01((b.runoff - 0.8) / 3);
    vTarget = Math.min(vTarget, speed * lerp(1, lerp(0.76, 0.90, p.bravery), bite));
  }
  // A drift has a minimum speed as well as a maximum.
  //
  // Its widest available arc is `counterSteer * yawBonus` of the kart's turn
  // rate, and turn rate climbs as speed falls — so below the speed at which
  // that arc matches the corner, a committed drift *cannot* be opened out far
  // enough and the kart is forced to the inside however the stick is held.
  // Braking below that speed while sideways is therefore never the right answer,
  // and the plan already sits above it by construction. This is the floor.
  //
  // **A floor, never a raise.** This block is the last thing to touch
  // `vTarget` — after the braking lookahead, after the run-off lift, after
  // everything — and the cap on it used to be `plan.vAt(d) * 1.15`, which made
  // it the last word rather than a floor under one. Fifteen per cent above the
  // plan's own profile is faster than the plan has *ever* asked for at that
  // station, so a driver who committed to a drift on the entry to the Chicane
  // Cuts had the target pinned at 85 m/s for half a second while the plan
  // wanted 45 and the predictor was reporting thirty metres of overshoot. It
  // arrived at the esse having never lifted. The 1.15 is gone: the floor may
  // hold a drift up to what the plan itself allows here and not one metre per
  // second past it.
  if (drifting || b.driftArm > 0) {
    const kHere = Math.abs(plan.kAt(d + previewD));
    // A quarter above the bare minimum, so the stick lands inside the drift's
    // band rather than pinned to the wide end of it with nothing left. That
    // margin is the whole difference between a drift that can be held to an
    // orange turbo and one that spends the corner grinding toward the inside
    // kerb while the driver counter-steers at it.
    const floor = speedForCurvature(ctx.config, kHere, racer.stats.handling,
      K.drift.counterSteer * K.drift.yawBonus * 1.25, topSpeed);
    // The one case where the plan is not the ceiling: the drift's own arc is
    // already carrying the kart to the inside. The arc opens with speed, so
    // here — and only here — the throttle is the correction and the plan's
    // number is the thing holding the kart in the fault. It is bounded by the
    // fuse in `driftControl`: a third of a second of this and the drift is
    // released and the plan takes over again.
    const cap = insideOfDrift ? Math.max(plan.vAt(d), floor) : plan.vAt(d);
    vTarget = Math.max(vTarget, Math.min(floor, cap));
  }
  // Queued behind a kart we cannot pass: back off a fraction and take a run at
  // them next time the road opens, rather than sitting in their gearbox for
  // half a lap. This is most of what turns a rolling lump back into a race.
  vTarget *= 1 - b.queueLift;
  b.lastVTarget = vTarget;

  const err = speed - vTarget;
  if (err > 1.5) {
    input.brake = clamp01((err - 1.5) / 5) * lerp(0.8, 1, p.bravery);
    input.accel = 0;
  } else {
    input.brake = 0;
    input.accel = clamp01(0.62 - err * 0.5);
    if (b.mistakeLeft > 0 && b.mistakeKind === MISTAKE_LIFT) input.accel *= 0.5;
  }
  // A star does not care about gravel, traffic or dignity.
  if (racer.effects.has('star')) { input.accel = 1; input.brake = 0; }

  // ── getting unstuck ───────────────────────────────────────────────────
  recover(ctx, b, racer, lat, speed, dt, input);

  // ── items ─────────────────────────────────────────────────────────────
  itemControl(ctx, b, plan, racer, d, traffic, cut, speed, topSpeed, offroad, dt, input);
}

// ── traffic ─────────────────────────────────────────────────────────────────

interface Traffic {
  blockIdx: number;
  blockGap: number;
  blockLat: number;
  blockSpeed: number;
  blockBearing: number;
  blockStunned: boolean;
  chaseIdx: number;
  chaseGap: number;
  chaseLat: number;
  chaseBearing: number;
  rivalsAhead: number;
}

/** One struct, refilled every step, never allocated in the loop. */
const _traffic: Traffic = {
  blockIdx: -1, blockGap: Infinity, blockLat: 0, blockSpeed: 0, blockBearing: 0,
  blockStunned: false, chaseIdx: -1, chaseGap: Infinity, chaseLat: 0, chaseBearing: 0,
  rivalsAhead: 0,
};

function scanTraffic(
  ctx: GameContext, world: World, me: number, d: number, lat: number, racer: Racer,
): Traffic {
  const t = _traffic;
  t.blockIdx = -1; t.blockGap = Infinity; t.blockLat = 0; t.blockSpeed = 0;
  t.blockBearing = 0; t.blockStunned = false;
  t.chaseIdx = -1; t.chaseGap = Infinity; t.chaseLat = 0; t.chaseBearing = 0;
  t.rivalsAhead = 0;

  const spline = ctx.track?.spline;
  if (!spline) return t;
  _fwd.set(Math.sin(racer.yaw), 0, Math.cos(racer.yaw));

  for (let j = 0; j < ctx.racers.length; j++) {
    if (j === me) continue;
    const other = ctx.racers[j];
    if (other.progress > racer.progress) t.rivalsAhead++;
    const rel = spline.signedDistance(d, world.dist[j]);
    if (Math.abs(rel) > 70) continue;
    const dl = Math.abs(world.lat[j] - lat);
    if (dl > 7) continue;
    _to.subVectors(other.pos, racer.pos);
    _to.y = 0;
    const bearing = angBetween(_fwd.x, _fwd.z, _to.x, _to.z);
    if (rel > 1 && rel < t.blockGap) {
      t.blockIdx = j; t.blockGap = rel; t.blockLat = world.lat[j];
      t.blockSpeed = other.speed; t.blockBearing = bearing;
      t.blockStunned = other.stunned > 0;
    } else if (rel < -1 && -rel < t.chaseGap) {
      t.chaseIdx = j; t.chaseGap = -rel; t.chaseLat = world.lat[j];
      t.chaseBearing = bearing;
    }
  }
  return t;
}

/**
 * Racing the kart in front, and the one behind. Returns a lateral offset from
 * the circuit's own line, in metres.
 *
 * Four behaviours, all meant to be legible from the grandstand: tuck into the
 * wake and let the draft build, come out and commit to a side, cover the inside
 * when somebody is looking up it — and, for the ones with a star, simply aim at
 * whoever is in front.
 *
 * The tuck is the one that changes how a race *looks*. `config.kart.slipstream`
 * pays a boost for 1.15s spent within nineteen metres and twenty-six degrees of
 * a rival, and a driver who does not deliberately line up behind one almost
 * never collects it: the measured field took nine slipstream boosts in a whole
 * race. Sitting in the wake first and passing second is both faster and the
 * thing that reads as racing rather than as queueing.
 */
function trafficBend(
  ctx: GameContext, b: Brain, racer: Racer, plan: DriverPlan, world: World,
  t: Traffic, laneRef: number, d: number, dt: number,
): number {
  const p = b.profile;
  let out = 0;

  const chasing = t.blockIdx >= 0 && t.blockGap < 26 && !t.blockStunned;
  if (chasing) {
    b.tailTime += dt;
    // The draft is worth real speed, so the patient drivers take it before they
    // take the position. The impatient ones do not wait, which is exactly why
    // they are the ones who end up in the gravel.
    const wait = racer.effects.has('draft')
      ? lerp(1.9, 0.35, p.aggression)
      : lerp(3.2, 0.7, p.aggression);
    if (b.tailTime > wait && b.passCool <= 0 && b.passTime <= 0) {
      b.passTarget = t.blockIdx;
      b.passSide = passSide(plan, t.blockLat, plan.know.read(plan.know.half, d + 20),
        d + 20, p.aggression);
      b.passTime = lerp(1.6, 3.4, p.patience);
      b.tailTime = 0;
    }
    // Stuck in a wake we cannot get out of: open a gap and come again. Without
    // this the field congeals into a single rolling lump within a lap.
    if (b.tailTime > 5.5 && b.passTime <= 0) {
      b.queueLift = Math.min(0.055, b.queueLift + dt * 0.12);
    } else {
      b.queueLift = Math.max(0, b.queueLift - dt * 0.25);
    }
  } else {
    b.tailTime = Math.max(0, b.tailTime - dt * 2);
    b.queueLift = Math.max(0, b.queueLift - dt * 0.4);
  }

  // ── tucking in ──────────────────────────────────────────────────────
  // Only while there is something to gain: inside the wake, still closing, and
  // not already committed to going round.
  const wantTuck = chasing && b.passTime <= 0 && t.blockGap > 3.5 && t.blockGap < 18
    && Math.abs(t.blockBearing) < 0.42;
  b.tuck = damp(b.tuck, wantTuck ? lerp(0.55, 1, p.patience) : 0, wantTuck ? 0.02 : 0.0005, dt);
  if (b.tuck > 0.01) out += (t.blockLat - laneRef) * b.tuck;

  // ── attacking ───────────────────────────────────────────────────────
  if (b.passTime > 0) {
    b.passTime -= dt;
    const idx = b.passTarget;
    const done = idx < 0 || idx >= ctx.racers.length
      || ctx.racers[idx].progress + 4 < racer.progress;
    if (done || b.passTime <= 0) {
      b.passTime = 0;
      b.passCool = lerp(2.4, 0.8, p.aggression);
    } else {
      out += (world.lat[idx] + b.passSide * lerp(2.8, 3.8, p.aggression) - laneRef) * 0.85;
    }
  }

  // ── defending ───────────────────────────────────────────────────────
  // Small, and only where it costs nothing. Covering a line into a corner is
  // racecraft; a CPU that weaves down a straight to keep the player behind is
  // the single most hated thing a kart racer can do.
  if (t.chaseIdx >= 0 && t.chaseGap < 13 && b.passTime <= 0) {
    const straight = clamp01(1 - Math.abs(plan.kAt(d + 20)) / 0.012);
    const cover = lerp(0, 1.7, p.aggression) * (1 - t.chaseGap / 13) * straight;
    out += clamp(t.chaseLat - laneRef, -1, 1) * cover;
  }

  // ── a star turns the kart itself into the weapon ─────────────────────
  if (racer.effects.has('star') && t.blockIdx >= 0 && t.blockGap < 30) {
    out += (t.blockLat - laneRef) * 0.8;
  }
  return out;
}

/** Which side of the kart in front to go. More room wins; the inside breaks ties. */
function passSide(
  plan: DriverPlan, blockLat: number, halfAim: number, aimD: number, aggression: number,
): -1 | 1 {
  const room = (s: number): number => halfAim - 2.4 - s * blockLat;
  // Positive curvature turns to the driver's right, whose inside is at negative
  // lateral: the spline's `right` points to the driver's left.
  const inside = -sign(plan.kAt(aimD + 20));
  const bias = inside === 0 ? 0 : aggression * 3;
  const plus = room(1) + (inside === 1 ? bias : 0);
  const minus = room(-1) + (inside === -1 ? bias : 0);
  return plus >= minus ? 1 : -1;
}

/**
 * Everything in the road that is not a rival to be raced: the bananas, bombs
 * and laid shells the item system has reported, and anybody currently spinning.
 *
 * The push is a lateral shove that grows as the thing gets closer and as the
 * overlap gets worse, so a driver eases around an obstacle from a long way out
 * rather than jinking at the last metre.
 */
function avoidance(
  ctx: GameContext, world: World, me: number, d: number, targetLat: number, racer: Racer,
): number {
  const spline = ctx.track?.spline;
  if (!spline) return 0;
  // Nothing on the road can hurt an invincible kart, and swerving as if it can
  // wastes the one item that lets you ignore the road entirely.
  if (racer.effects.has('star')) return 0;

  let push = 0;
  const reach = clamp(racer.speed * 0.8 + 12, 16, 48);

  for (let i = 0; i < world.hazards.length; i++) {
    const h = world.hazards[i];
    if (!h.active) continue;
    const rel = spline.signedDistance(d, h.d);
    if (rel < 1.5 || rel > reach) continue;
    const dl = targetLat - h.lat;
    const clearance = h.radius + 1.9;
    if (Math.abs(dl) > clearance) continue;
    const away = dl === 0 ? (h.lat > 0 ? -1 : 1) : sign(dl);
    push += away * (clearance - Math.abs(dl)) * (1 - rel / reach);
  }

  for (let j = 0; j < ctx.racers.length; j++) {
    if (j === me) continue;
    const other = ctx.racers[j];
    // A spinning kart is a rock in the road: it is not going where it is
    // pointing and it is not going to move out of the way.
    const spinning = other.stunned > 0;
    if (!spinning && other.speed > racer.speed - 6) continue;
    const span = spinning ? reach : 26;
    const rel = spline.signedDistance(d, world.dist[j]);
    if (rel < 1.5 || rel > span) continue;
    const dl = targetLat - world.lat[j];
    const clearance = spinning ? 4.6 : 3;
    if (Math.abs(dl) > clearance) continue;
    const away = dl === 0 ? (world.lat[j] > 0 ? -1 : 1) : sign(dl);
    push += away * (clearance - Math.abs(dl)) * (1 - rel / span) * (spinning ? 1.3 : 0.7);
  }

  return clamp(push, -6, 6);
}

/**
 * Going and getting an item.
 *
 * The boxes are laid in rows across the road with one of them sitting exactly
 * on the racing line, so a driver on the line is already collecting them and
 * this does nothing at all. It matters in the case it was written for: a driver
 * who has been shoved off the line by traffic, or who is running a wide
 * defensive lane, and is about to drive past a row of boxes with an empty slot.
 * A metre or two of lane is a cheap price for an item, and a greedy driver will
 * pay more of it than a tidy one.
 */
function boxSeek(
  ctx: GameContext, world: World, racer: Racer, d: number, laneRef: number,
  speed: number, greed: number,
): number {
  if (racer.item || racer.effects.has('bullet') || racer.effects.has('boo')) return 0;
  const spline = ctx.track?.spline;
  if (!spline) return 0;

  let best = 0;
  let bestGap = Infinity;
  const reach = clamp(speed * 1.1 + 18, 24, 80);
  for (let i = 0; i < world.boxes.length; i++) {
    const box = world.boxes[i];
    if (!box.active) continue;
    const gap = spline.forwardDistance(d, box.d);
    if (gap < 3 || gap > reach) continue;
    // No point diverting for one that will still be broken when we arrive.
    if (box.gone > gap / Math.max(10, speed)) continue;
    const off = box.lat - laneRef;
    if (Math.abs(off) > lerp(3.5, 9, greed)) continue;
    if (gap < bestGap) { bestGap = gap; best = off; }
  }
  if (bestGap === Infinity) return 0;
  return best * smoothstep(clamp01(1 - (bestGap - 10) / Math.max(10, reach - 10)))
    * lerp(0.6, 1, greed);
}

// ── the gravel cut ──────────────────────────────────────────────────────────

/**
 * Should this driver take the detour, and are they on it yet?
 *
 * The trade is honest: the cut is `save` metres shorter and costs the surface's
 * speed cap for its length. A boost — a mushroom, a mini-turbo about to fire, a
 * star — pays for that and then some. Nothing in hand and it is a mistake,
 * which is why the greedy drivers take it more often than they should and the
 * tidy ones take it only when it pays.
 */
function chooseCut(
  ctx: GameContext, b: Brain, know: TrackKnowledge, racer: Racer, d: number, topSpeed: number,
): CutSeg | null {
  const spline = ctx.track?.spline;
  if (!spline || know.cuts.length === 0) return null;

  if (b.cut >= 0) {
    const seg = know.cuts[b.cut];
    // Committed: hold it until we are back on tarmac past the exit.
    const span = seg.rejoin - seg.approach;
    if (spline.forwardDistance(d, seg.rejoin) <= span + 30) return seg;
    b.cut = -1;
  }

  for (let i = 0; i < know.cuts.length; i++) {
    const seg = know.cuts[i];
    const gap = spline.forwardDistance(d, seg.approach);
    if (gap > 26 || gap < 0.5) continue;
    // Something to spend on it, and it has to still be burning when the gravel
    // starts. A mini-turbo that has already fired is not a mushroom in hand.
    const boosted = racer.boost.time > 0.45
      || racer.effects.has('star')
      || racer.item === 'mushroom' || racer.item === 'tripleMushroom';
    const quick = racer.speed > topSpeed * 0.7;
    // Greed is what makes this a character trait rather than a rule: the
    // opportunist takes it on speed alone, the metronome wants the boost.
    if (!(b.profile.greed > 0.9 ? quick : boosted && quick)) continue;
    b.cut = i;
    return seg;
  }
  return null;
}

// ── drift ───────────────────────────────────────────────────────────────────

/**
 * Commit to, hold and release a drift.
 *
 * The plan already says which corners this driver means to drift and what tier
 * they are chasing (knowledge.ts). This runs that intent against the physics'
 * own rules: hold the button and steer to hop and commit, keep holding while
 * the charge is worth keeping, and release so the mini-turbo *lands on the
 * exit* rather than halfway round the corner where it is scrubbed straight back
 * off.
 *
 * Two things about this were measurably, badly wrong before, and both are
 * about *giving up too easily*:
 *
 *  - **The entry was a per-step vote, not a decision.** Every gate below was
 *    re-run on every one of the 120 steps a second, including the forty steps
 *    the kart spends in the air after the hop — and the drift button was
 *    released the moment any of them flickered. Physics reads a release as
 *    "never mind", clears the armed direction, and the next step the gates pass
 *    again and it hops afresh. Measured: eight hundred hops a race per driver,
 *    twenty of which became drifts. The field was not failing to drift, it was
 *    bouncing down the road like popcorn, and that — not the racing line — is
 *    what put a fifth of every race on the dirt. An entry is now *armed*: once
 *    the decision is made the button stays down and the wheel stays turned
 *    until physics has latched a direction or the window has closed.
 *
 *  - **The release was hunting a run-off that was not there.** See the
 *    prediction in `drive()`: a drift is an arc the driver chooses, so
 *    extrapolating the tightest one is predicting a mistake nobody makes. And
 *    releasing never helps a kart running *wide* — a committed drift carries
 *    `yawBonus` times the grip-steering rate, so standing it up is strictly
 *    less turn. What is left is the one situation a drift genuinely cannot be
 *    steered out of: the corner asking for *less* curvature than the widest
 *    available arc, which drives the kart to the inside.
 *
 * Returns the drift direction currently committed or armed, or 0.
 */
function driftControl(
  ctx: GameContext, b: Brain, plan: DriverPlan, racer: Racer, d: number, speed: number,
  kCmd: number, widestK: number, offroad: boolean, dt: number,
  input: InputState, K: KartConfig,
): -1 | 0 | 1 {
  const spline = ctx.track?.spline;
  if (!spline) { input.drift = false; return 0; }
  const drift = racer.drift;
  const p = b.profile;
  b.armCool = Math.max(0, b.armCool - dt);

  // ── holding one ───────────────────────────────────────────────────────
  if (drift.active && b.driftCorner >= 0) {
    b.driftArm = 0;
    // The grace window is measured from the moment the kart is actually
    // sideways, not from the moment the driver decided to be. Setting it at the
    // decision spends two thirds of it on the hop and the flight, and the kart
    // lands with a tenth of a second of protection — measured, that ended
    // sixteen of twenty-seven charges before they had banked anything at all.
    if (b.driftTime === 0) b.driftGrace = Math.max(b.driftGrace, 0.7);
    b.driftTime += dt;
    let seg = plan.know.corners[b.driftCorner];
    // Signed, so it runs negative past the exit instead of wrapping a whole
    // lap. A mini-turbo wants to land on the way *out*, so a drift is meant to
    // be carried past the apex and a little way onto the straight.
    let remaining = spline.signedDistance(d, seg.d1);

    // Chaining. Two bends the same way with a short link between them are one
    // drift to a player, and taking the second one already sideways is how a
    // purple turbo actually gets banked. Re-target rather than release.
    if (remaining < Math.max(6, speed * 0.25)) {
      const link = plan.cornerIndexAt(d + Math.max(14, speed * 0.55));
      if (link >= 0 && link !== b.driftCorner
        && plan.know.corners[link].dir === drift.dir && plan.tier[link] > 0) {
        b.driftCorner = link;
        b.driftAim = Math.max(b.driftAim, plan.tier[link]);
        seg = plan.know.corners[link];
        remaining = spline.signedDistance(d, seg.d1);
      }
    }

    // Pinned at the widest arc the drift can hold and *still* turning tighter
    // than the road wants. This is the only bail a committed drift has, because
    // it is the only thing the stick cannot answer: the corner asking for
    // appreciably less curvature than the widest arc it
    // can be steered to. The threshold has real slack in it: at plan
    // speed the ratio is 1.05-1.25, and a driver a fraction slow through a
    // braking zone must not be thrown out of a drift for it — measured, a
    // threshold of 0.85 ended twenty-eight of thirty charges before blue.
    const wrongWay = sign(kCmd) !== 0 && sign(kCmd) !== drift.dir;
    const tooTight = wrongWay || Math.abs(kCmd) < widestK * 0.60;
    // Nothing accumulates during the grace window. A drift throws the tail out
    // on purpose and the first half second of one always looks like a mistake;
    // letting the clock run through it means the charge is released the instant
    // the protection expires, which measured as every single drift on the
    // circuit dying at a blue turbo and none ever reaching orange.
    b.strain = tooTight && b.driftGrace <= 0
      ? b.strain + dt
      : Math.max(0, b.strain - dt * 2.5);
    // ...and the other way a drift stops working: over-rotating far enough to
    // be about to run out of road on the *inside*.
    //
    // **This is the one that was actually happening, and it had no fuse.** It
    // released the drift on the single step it first went true, and once the
    // bench separated the two endings the histogram was unanswerable: twelve to
    // twenty-three `inside` bails per driver per race and *zero* `strain` ones,
    // on both seeds, across the whole field. Two thirds of the mini-turbo
    // system — every green and every purple this game has ever advertised —
    // died on this line.
    //
    // A fuse, because it is not the emergency it was written as. The stick
    // cannot open the arc past `widestK`, true; but `widestK` is
    // `counterSteer * yawBonus * turnRate(v) / v`, and turn rate falls with
    // speed more slowly than speed rises — so **the arc opens as the kart goes
    // faster**, and the throttle is a control the driver still has. The speed
    // floor below reads `b.inside` and asks for the speed the arc needs; this
    // gives that a third of a second to work before giving up on the charge.
    const insideEdge = b.runoff > 2.0 && b.runoffSide !== drift.dir;
    b.inside = insideEdge ? b.inside + dt : Math.max(0, b.inside - dt * 3);
    // How long a driver will sit in an over-rotating drift before giving up on
    // it. This is the single number that separates the `drifter` from the rest:
    // a purple needs 1.9s of charge, and only somebody willing to hold a slide
    // that is not quite working ever gets one.
    // ...and a driver who has not yet banked what they came for sits in it twice
    // as long. This is the difference between a field that sparks blue out of
    // every corner and one that fires orange and purple: a tier-2 charge needs
    // about a second of drift and a tier-3 nearly two, and an over-rotating
    // slide that is *nearly* working is exactly the moment a real player holds
    // on through.
    const patience = lerp(0.45, 1.00, p.driftLove)
      * (drift.tier < b.driftAim ? 1.6 : 1);
    // The inside fuse used to be less than half the strain one, and the bench
    // says that single number was the whole of the mini-turbo problem: over
    // ninety seconds of eight-racer racing, 147 drifts ended and **87 of them
    // ended here** — against 44 on the exit, 16 on a hit, and not one on
    // `strain`, `past`, `end` or `slow`. At a fifth of a second of protection a
    // committed slide simply did not survive long enough to bank anything: 135
    // blue turbos, 12 green, no purple, in a game whose class screen says
    // "mini-turbos or nothing".
    //
    // The file's own argument is the one that wins. A drift's arc *opens as the
    // kart goes faster*, the speed floor below already asks for the speed the
    // arc needs, and the throttle is a control the driver still has — so an
    // over-rotating slide is a thing to drive out of, not to abandon. The fuse
    // is now the same length as the strain one, which is to say: a driver gives
    // up on the near problem and the far one after the same amount of trying,
    // and a driver still chasing a tier keeps the 1.6x `patience` already
    // grants them.
    const overStrained = b.driftGrace <= 0 && b.strain > patience;
    const overInside = b.driftGrace <= 0 && b.inside > patience * 0.95;
    const strained = overStrained || overInside;

    const rate = K.drift.chargeRate * lerp(0.8, 1.2, racer.stats.handling) * 0.92;
    const next = drift.tier < K.drift.tiers.length ? K.drift.tiers[drift.tier] : null;
    // How much further this driver will hold on past the exit to bank a tier.
    // Bounded: a counter-steered drift still turns, and a long one down a
    // straight ends in the barrier.
    const hangOn = lerp(6, 24, p.driftLove) * clamp01(speed / 45);
    const timeLeft = (remaining + hangOn) / Math.max(10, speed);
    const reachable = !!next && drift.charge + rate * timeLeft > next.at + 0.05;
    // **One opinion about which tier this driver is chasing, and it is the
    // plan's.** There used to be two: `driftAim`, which comes from
    // `plan.tier[corner]` and is capped by how much straight there is after the
    // exit to spend the boost on — and this second clause, which let anybody
    // who loves drifting hold for a purple *whatever the plan said about room*.
    // Measured, that is where the off-road time came from: the biggest boost in
    // the game fired four metres before a braking zone cannot be undone, and
    // physics drags the kart up to the boost speed whether or not the brake is
    // down. Who chases purple is decided in `ai/knowledge.ts` by `appetite`,
    // where it can be weighed against the road.
    const chasing = drift.tier < b.driftAim && reachable;

    // Where the boost wants to land: on the exit, pointing down the next
    // straight. A driver who already has what they came for lets go here.
    const nearExit = remaining <= Math.max(4, speed * 0.17);
    // Note what is *not* here: a bail for running wide.
    //
    // Standing the kart up cannot help. A committed drift carries `yawBonus`
    // times the kart's grip-steering rate — leaning into it is strictly more
    // turn than releasing it — and the brake works during a drift, so a driver
    // arriving hot has both answers already. Every version of this file that
    // released on a run-off save measured the same way: the save fires, the
    // charge dies at tier 0, and the field never sparks. The only thing a drift
    // genuinely cannot steer out of is being *too tight*, which is `strained`.
    const keep = !strained
      && remaining > -hangOn
      && remaining < seg.len + 40
      && speed > K.drift.minSpeed * 1.02
      && (chasing || !nearExit);

    if (keep) {
      input.drift = true;
      return drift.dir === 0 ? b.driftDir : drift.dir;
    }
    const why = overInside ? WHY_INSIDE : overStrained ? WHY_STRAIN
      : remaining >= seg.len + 40 ? WHY_PAST
        : remaining <= -hangOn ? WHY_END
          : speed <= K.drift.minSpeed * 1.02 ? WHY_SLOW
            : WHY_EXIT;
    b.driftWhy = WHY_NAMES[why];
    noteEnd(b, why, drift.tier, b.driftCorner);
    input.drift = false;
    b.driftCorner = -1;
    b.driftDir = 0;
    b.strain = 0;
    b.inside = 0;
    b.driftTime = 0;
    // Long enough that the mini-turbo is spent before the next hop, short
    // enough to take the second half of an esse.
    b.redriftLock = strained ? 0.55 : 0.28;
    return 0;
  }

  if (drift.active) {
    // Sideways without a plan — a hop that latched off a kerb. Let it go.
    b.driftWhy = 'stray';
    noteEnd(b, WHY_STRAY, drift.tier, -1);
    input.drift = false;
    b.driftArm = 0;
    return drift.dir;
  }

  // ── an entry already committed to ─────────────────────────────────────
  // The hop takes a third of a second and the kart is in the air for most of
  // it. Nothing decided on the ground gets to change its mind up there.
  if (b.driftArm > 0) {
    b.driftArm -= dt;
    if (racer.stunned <= 0 && speed > K.drift.minSpeed && b.driftArm > 0) {
      input.drift = true;
      b.commitSteer = b.driftDir * COMMIT_LOCK;
      return b.driftDir;
    }
    b.driftArm = 0;
    b.driftCorner = -1;
    b.driftDir = 0;
    b.armCool = 0.45;
    input.drift = false;
    return 0;
  }

  if (b.driftCorner >= 0) {
    // Physics dropped it under us — a barrier scrape, a landing, the recovery
    // steering standing the kart up in the sand.
    b.driftWhy = WHY_NAMES[WHY_HIT];
    noteEnd(b, WHY_HIT, drift.tier, b.driftCorner);
  }
  b.driftCorner = -1;
  b.driftDir = 0;
  b.driftTime = 0;
  b.strain = 0;
  b.inside = 0;

  if (offroad || b.redriftLock > 0 || b.armCool > 0 || speed < K.drift.minSpeed * 1.12) {
    input.drift = false;
    return 0;
  }
  if (b.mistakeLeft > 0 && b.mistakeKind === MISTAKE_LATE) { input.drift = false; return 0; }
  // Already fighting for the road. Adding a slide to that is how a moment
  // becomes an accident. Measured in metres of predicted overshoot, not in
  // steering authority — a corner taken at the limit has no authority left to
  // measure with.
  if (b.runoff > 1.4) { input.drift = false; return 0; }

  // Which corner are we in, or about to be in?
  //
  // The window opens in the braking zone. A drift is committed at turn-in and
  // the hop alone costs a third of a second in the air, so a driver who waits
  // until the corner is under the wheels has already spent the half of it the
  // charge lives in. Looking a hop's flight ahead is what turns a blue turbo
  // into an orange one.
  const lead = Math.min(lerp(10, 26, p.driftLove), speed * 0.4);
  let idx = plan.cornerIndexAt(d + 2);
  if (idx < 0 || plan.tier[idx] === 0) idx = plan.cornerIndexAt(d + lead);
  if (idx < 0 || plan.tier[idx] === 0) { input.drift = false; return 0; }

  const seg = plan.know.corners[idx];
  // Nothing to gain from committing on the way out of one — and a drift that
  // cannot outlive the hop is a hop. The hop alone eats a third of a second;
  // add the time a blue turbo needs to charge and that is the shortest corner
  // worth going sideways in. Without this a driver would commit twelve metres
  // from the exit and release at tier 0 having spent the corner in the air,
  // which is a third of the measured releases.
  // Is there enough corner left to bank anything? The hop alone eats a third of
  // a second in the air; add the time a blue turbo needs to charge and that is
  // the shortest stretch worth going sideways in. Measured without it, a third
  // of all releases were at tier 0 — drifts committed twelve metres from an
  // exit that were airborne for most of their life.
  const room = spline.signedDistance(d, seg.d1) + lerp(6, 24, p.driftLove) * clamp01(speed / 45);
  if (room < Math.max(seg.len * 0.35, speed * 0.72)) { input.drift = false; return 0; }
  // What the corner asks for, not what the controller is asking for this
  // instant: `kCmd` carries the run-off save and both error terms, and gating
  // an entry on it made the decision flicker at 120Hz — which is what turned
  // every entry into a hop and every lap into popcorn. `plan.tier` has already
  // decided this corner is worth a drift, at build time, against this driver's
  // own line; all that is left is to be in the right place for it.
  const kPlan = plan.kAt(seg.d0 + seg.len * 0.3);
  if (sign(kPlan) !== seg.dir) { input.drift = false; return 0; }

  // Note what is deliberately *not* here: a test of whether this corner is
  // tighter than the widest arc a drift can be steered to at the kart's current
  // speed. It was, briefly, and it is the wrong layer to ask at. Measured, it
  // cut the whole field's drifts by six to one — every corner on Cone Canyon
  // wider than about fifty metres failed it, which is most of them — and traded
  // a game that goes off the road for a game that never goes sideways. Whether
  // a corner is driftable is a fact about the corner and the kart, `knowledge.ts`
  // decides it once at build time, and if the answer is coming back "no" for a
  // circuit's whole corner set then the drift band in `config.kart.drift` is
  // what is wrong, not the driver.

  input.drift = true;
  b.driftCorner = idx;
  b.driftDir = seg.dir;
  b.driftAim = Math.max(1, plan.tier[idx]);
  b.driftGrace = 0.7;
  // The hop, the flight and the touchdown that commits it. Held open across all
  // three: physics needs the button down and a third of a lock on the wheel at
  // the moment the tyres land, and a driver who lets go in the air lands with
  // nothing.
  b.driftArm = K.drift.hopTime + 0.28;
  b.tally.drifts++;
  b.commitSteer = seg.dir * COMMIT_LOCK;
  return seg.dir;
}

// ── mistakes and recovery ───────────────────────────────────────────────────

/**
 * The mistake budget.
 *
 * A CPU that never errs is a metronome, and a field of metronomes finishes in
 * grid order every time. These are small on purpose: a late braking point, a
 * wide exit, a lift that costs a tenth. Nothing that reads as the game
 * malfunctioning; everything that reads as somebody having a moment.
 */
function tickMistakes(b: Brain, dt: number): void {
  if (b.mistakeLeft > 0) { b.mistakeLeft -= dt; return; }
  b.mistakeIn -= dt;
  if (b.mistakeIn > 0) return;
  b.mistakeIn = b.rng.range(3, 9) + lerp(5, 34, b.profile.consistency);
  const roll = b.rng.next();
  b.mistakeKind = roll < 0.45 ? MISTAKE_LATE : roll < 0.8 ? MISTAKE_WIDE : MISTAKE_LIFT;
  b.mistakeLeft = b.mistakeKind === MISTAKE_LIFT
    ? b.rng.range(0.25, 0.55)
    : b.rng.range(0.9, 2.1);
}

/**
 * Off the road, pointing the wrong way, or simply stopped.
 *
 * A kart facing the barrier needs to reverse; a kart in the sand needs a
 * shallow angle back to the tarmac, not full lock, which only ploughs it
 * further in.
 */
function recover(
  ctx: GameContext, b: Brain, racer: Racer, lat: number, speed: number, dt: number,
  input: InputState,
): void {
  const track = ctx.track;
  if (!track) return;

  _fwd.set(Math.sin(racer.yaw), 0, Math.cos(racer.yaw));
  const along = _fwd.dot(_here.tangent);

  if (b.reverseTime > 0) {
    b.reverseTime -= dt;
    input.accel = 0;
    input.brake = 1;
    input.drift = false;
    // Physics flips the steering sign below zero speed, so backing *away* from
    // whatever we are stuck against needs the wheel the other way once the kart
    // is actually going backwards.
    input.steer = clamp(speed < 0 ? -b.steerCmd : b.steerCmd, -1, 1);
    // Give up on the reverse only once there is room to turn in. The old test
    // was `speed > 1.5`, which is true of every kart that has just decided to
    // reverse *out of* forward motion — so the manoeuvre cancelled itself on
    // the step it began and the kart ground along the barrier for the rest of
    // the race. Measured: one of eight finished a full lap down with 88% of
    // its race spent under 12 m/s, which is most of what blew the field apart.
    if (speed < -7) b.reverseTime = 0;
    return;
  }

  if (along < -0.15 && speed < 26) {
    // Turned around. Nothing else matters until the nose is back down the road:
    // scrub the speed off first, then swing it round on full lock and power.
    const side = sign(_fwd.x * _here.tangent.z - _fwd.z * _here.tangent.x) || 1;
    input.steer = clamp(-side, -1, 1);
    input.drift = false;
    if (speed > 3.5) { input.accel = 0; input.brake = 1; }
    else { input.accel = 1; input.brake = 0; }
    b.stuckTime += dt;
    if (b.stuckTime > 2.4) { b.reverseTime = 1.2; b.stuckTime = 0; }
    return;
  }

  if (Math.abs(speed) < 3.5) {
    b.stuckTime += dt;
    if (b.stuckTime > 1.3) { b.reverseTime = 0.9; b.stuckTime = 0; }
    else { input.accel = 1; input.brake = 0; input.drift = false; }
  } else if (speed < 12 && OFFROAD.has(racer.surface)) {
    // Crawling in the dirt with the nose more or less the right way: not stuck
    // enough for the reverse, far too slow to be racing. Anything that keeps a
    // kart here is a bug, so the only job is to get out — but a kart that is
    // slowly gathering speed is getting out, and hauling it into reverse for a
    // second undoes exactly that.
    input.accel = 1;
    input.brake = 0;
    input.drift = false;
    if (speed < 6) {
      b.stuckTime += dt;
      if (b.stuckTime > 2.6) { b.reverseTime = 1.0; b.stuckTime = 0; }
    } else b.stuckTime = 0;
  } else {
    b.stuckTime = 0;
  }

  // Off the paint and not on the signposted cut. Every frame of this is a bug,
  // so getting back is the only job: aim across the verge at a real angle
  // instead of waiting for a curvature command that, on dirt at half speed, is
  // barely a twitch of the wheel. The angle is shallow deliberately — full lock
  // in sand ploughs a furrow and scrubs off what speed is left — and it grows
  // with how far out we are, so a wheel on the kerb barely notices it.
  const half = _here.width * 0.5;
  if (b.cut < 0 && Math.abs(lat) > half - KART_HALF) {
    const out = (Math.abs(lat) - (half - KART_HALF)) / Math.max(3, track.course.vergeWidth ?? 5);
    // Positive lateral is to the driver's *left* and positive steer turns the
    // nose right, so coming back from the left verge carries the same sign as
    // the offset — the same convention `b.save` and the lateral error term use.
    const home = sign(lat) * clamp01(out) * 0.7;
    if (Math.abs(home) > Math.abs(input.steer) || sign(home) !== sign(input.steer)) {
      input.steer = clamp(lerp(input.steer, home, clamp01(out)), -1, 1);
    }
    input.brake = 0;
    if (Math.abs(lat) > half + (track.course.vergeWidth ?? 5) * 0.5) {
      input.accel = Math.max(input.accel, 0.9);
      input.drift = false;
    }
  }
}

// ── items ───────────────────────────────────────────────────────────────────

/**
 * Author the item button.
 *
 * items.ts decides *what*; this turns it into the presses a human would have
 * made. `aim` items read the length of the press — a tap throws forward, a hold
 * lays it behind — so the same button held for a different length of time is
 * the whole vocabulary, and a CPU has no way to place a shell a player could
 * not have placed.
 *
 * Note for whoever owns src/items: the item module currently runs its own
 * `aiUse` for anything with a `racer.ai`, so these presses are authored and
 * ignored. Routing CPUs through `playerUse` with `racer.aiInput` in place of
 * `ctx.inputState` is the one line that hands item decisions to the driver that
 * is making every other decision. Until then, the *positioning* below is what
 * lands: a CPU carrying a mushroom onto the gravel cut gets the mushroom spent
 * on the gravel, because that is where it chose to be.
 */
function itemControl(
  ctx: GameContext, b: Brain, plan: DriverPlan, racer: Racer, d: number,
  t: Traffic, cut: CutSeg | null, speed: number, topSpeed: number, offroad: boolean,
  dt: number, input: InputState,
): void {
  // A press already in flight: hold the button down for the rest of its length.
  if (b.pressLeft > 0) {
    b.pressLeft -= dt;
    input.item = true;
    return;
  }
  input.item = false;
  if (!racer.item || b.pressLock > 0) return;

  const spline = ctx.track?.spline;
  if (!spline) return;

  let worst = 0;
  for (let i = 1; i <= 4; i++) {
    const k = Math.abs(plan.kAt(d + i * 12));
    if (k > worst) worst = k;
  }
  let cutIn = Infinity;
  for (let i = 0; i < plan.know.cuts.length; i++) {
    const gap = spline.forwardDistance(d, plan.know.cuts[i].d0);
    if (gap < cutIn) cutIn = gap;
  }
  const corner = plan.cornerAt(d);

  const v = _view;
  v.held = b.itemHeld;
  v.aheadGap = t.blockGap;
  v.aheadBearing = t.blockBearing;
  v.behindGap = t.chaseGap;
  v.behindBearing = t.chaseBearing;
  v.rivalsAhead = t.rivalsAhead;
  v.straightness = clamp01(1 - worst / 0.018);
  v.offroad = offroad;
  v.onCut = !!cut && spline.forwardDistance(cut.d0, d) < cut.d1 - cut.d0;
  v.cutIn = cutIn;
  v.speedFrac = clamp01(speed / Math.max(1, topSpeed));
  v.cornerExitIn = corner ? spline.forwardDistance(d, corner.d1) : 0;
  v.place = racer.place;
  v.fieldSize = ctx.racers.length;

  const intent = decideItem(racer, v, b.profile.aggression, b.profile.patience);
  if (!intent.fire) return;

  b.itemWhy = intent.why;
  b.pressLeft = pressDuration(racer.item, intent.forward);
  b.pressLock = 0.35;
  input.item = true;
  input.pressed.item = true;
}

// ── the system ──────────────────────────────────────────────────────────────

export function createAiSystem(ctx: GameContext): GameSystem {
  const world = getWorld(ctx);
  installBench();

  return {
    // Must run before physics (order 30): the AI authors the input that physics
    // then consumes in the same step. Running after would lag it by one frame.
    name: 'ai',
    order: 25,

    reset(_cfg: RaceConfig): void {
      world.clear();
      if (!ctx.track) return;
      const rng = ctx.rng.fork();
      const cpus: Racer[] = [];
      for (const racer of ctx.racers) if (racer.ai && !racer.isPlayer) cpus.push(racer);
      const profiles = dealProfiles(rng, cpus.length);
      for (let i = 0; i < cpus.length; i++) {
        const racer = cpus[i];
        const ai = racer.ai;
        if (!ai) continue;
        configure(ctx, ai, racer, temper(profiles[i], clamp01(ai.skill), rng), rng);
      }
      // The harness' autopilot drives the player's kart, and a capture wants a
      // clean fast lap rather than a character study: it always gets the
      // reference driver.
      for (const racer of ctx.racers) {
        if (racer.isPlayer && racer.ai) configure(ctx, racer.ai, racer, REFERENCE, rng);
      }
    },

    fixedUpdate(dt: number): void {
      const phase = ctx.race.phase;
      if (phase !== 'racing' && phase !== 'countdown' && phase !== 'finished') return;

      world.scan();
      for (const racer of ctx.racers) {
        const ai = racer.ai;
        if (!ai) continue;
        tickHeld(ai, racer, dt);
        ai.update(racer, dt);
        const b = brains.get(ai);
        if (b && phase === 'racing') tallyStep(b, racer, world, dt);
      }
      applyRubberBand(dt);
    },

    dispose(): void {
      world.dispose();
      dropWorld(ctx);
    },
  };

  /**
   * One step of bench counters. Nothing in the simulation reads any of this;
   * it exists so "the field never drifts" and "the field lives in the dirt" are
   * measurements rather than impressions.
   */
  function tallyStep(b: Brain, racer: Racer, w: World, dt: number): void {
    const t = b.tally;
    t.steps++;
    if (racer.stunned > 0) { t.stunSteps++; t.sinceStun = 0; } else t.sinceStun += dt;

    const tier = racer.drift.tier;
    if (racer.drift.active) {
      t.driftSteps++;
      t.tierSteps[tier]++;
      if (tier > b.lastTier) {
        for (let k = b.lastTier + 1; k <= tier; k++) t.tierHit[k]++;
        if (tier > t.maxTier) t.maxTier = tier;
      }
    }
    b.lastTier = racer.drift.active ? tier : 0;

    const off = OFFROAD.has(racer.surface);
    const i = w.indexOf(racer);
    if (off) {
      t.offSteps++;
      t.offSpeed += racer.speed; t.offN++;
      if (b.cut >= 0) t.offCut++;
      else {
        if (t.sinceStun > 3) t.offUnforced++;
        if (racer.drift.active) t.offDrift++;
        // The inside of a bend is at negative lateral when the curvature is
        // positive: the spline's `right` points to the driver's left.
        if (i >= 0 && b.lastK !== 0 && sign(w.lat[i]) === -sign(b.lastK)) t.offInside++;
        if (racer.boost.time > 0) {
          t.offBoost++;
          const src = racer.boost.source ?? '';
          t.offBoostSrc[src.startsWith('drift') ? 0 : src === 'pad' ? 1
            : src === 'mushroom' || src === 'star' || src === 'bullet' ? 2 : 3]++;
        }
        if (i >= 0) {
          const half = w.half[i];
          t.overSum += Math.max(0, Math.abs(w.lat[i]) - half);
          // Whose fault: a lane the driver planned onto the dirt, or a lane on
          // the tarmac the kart failed to hold.
          if (Math.abs(b.lastLat) > half - 1) t.offLane++; else t.offTrack++;
        }
      }
    } else {
      t.onSpeed += racer.speed; t.onSteps++;
    }
    if (racer.stunned <= 0 && racer.speed < 12) t.crawlSteps++;
    if (i >= 0) { t.latSum += w.lat[i]; t.latSq += w.lat[i] * w.lat[i]; }
  }

  /** How long the current item has been in hand — the policy's patience clock. */
  function tickHeld(ai: AiDriver, racer: Racer, dt: number): void {
    const b = brains.get(ai);
    if (!b) return;
    if (!racer.item) { b.itemHeld = 0; b.itemId = null; return; }
    if (b.itemId !== racer.item) { b.itemId = racer.item; b.itemHeld = 0; }
    b.itemHeld += dt;
  }

  /**
   * Keeps the race close without ever being visible.
   *
   * Four rules, and the first two are what separate this from the usual
   * cheating slingshot:
   *
   *  - **A dead zone.** Nothing within `dead` metres of the player is adjusted
   *    at all. The tell that gives rubber-banding away is a kart that matches
   *    your speed no matter what you do; if the karts you can actually see are
   *    never touched, there is nothing to see.
   *  - **It moves slowly.** The band is damped over a couple of seconds, so it
   *    can never produce an acceleration a player could notice — only a
   *    difference in where somebody ends up a lap later.
   *  - **It is off at the start**, so the grid is honest and the field strings
   *    out on merit before anything is done to hold it together.
   *  - **It holds the field together, not just the player's corner of it.**
   *    A band measured only against the player does nothing about two CPUs four
   *    hundred metres apart on the far side of the circuit — measured, the
   *    field's first-to-last spread reached 827m on a 2177m lap and four of
   *    eight racers finished a lap down, which is not a race, it is eight time
   *    trials. So there is a second, gentler term against the field's own
   *    median, with a dead zone twice as wide. It only ever applies to karts
   *    the player is nowhere near, so it is invisible by construction.
   */
  function applyRubberBand(dt: number): void {
    const player = ctx.player;
    if (!player || !ctx.track) return;
    const rb = ctx.config.ai.rubberBand;
    const dead = 26;
    const span = Math.max(20, rb.range - dead);
    const live = ctx.race.phase === 'racing' && ctx.race.time > 4 && !player.finished;
    const mid = packMedian();

    for (const racer of ctx.racers) {
      if (!racer.ai || racer.isPlayer) continue;
      let want = 1;
      if (live) {
        const gap = racer.progress - player.progress;
        if (Math.abs(gap) > dead) {
          const t = smoothstep(clamp01((Math.abs(gap) - dead) / span));
          want = gap > 0 ? lerp(1, rb.ahead, t) : lerp(1, rb.behind, t);
          const off = racer.progress - mid;
          const u = smoothstep(clamp01((Math.abs(off) - PACK_DEAD) / PACK_SPAN));
          want *= off > 0 ? lerp(1, PACK_AHEAD, u) : lerp(1, PACK_BEHIND, u);
          want = clamp(want, 0.90, 1.13);
        }
      }
      racer.rubberBand = damp(racer.rubberBand ?? 1, want, 0.05, dt);
    }
  }

  /**
   * The middle of the field, in progress metres.
   *
   * The median rather than the mean: one kart that has spun into the sand and
   * lost half a lap should not drag the whole field's reference back with it.
   * Eight elements, insertion-sorted into a buffer that is allocated once.
   */
  function packMedian(): number {
    const n = ctx.racers.length;
    if (n === 0 || n > _prog.length) return ctx.player?.progress ?? 0;
    for (let i = 0; i < n; i++) _prog[i] = ctx.racers[i].progress;
    for (let i = 1; i < n; i++) {
      const v = _prog[i];
      let j = i - 1;
      while (j >= 0 && _prog[j] > v) { _prog[j + 1] = _prog[j]; j--; }
      _prog[j + 1] = v;
    }
    return n % 2 ? _prog[(n - 1) >> 1] : (_prog[n / 2 - 1] + _prog[n / 2]) * 0.5;
  }

  /**
   * The reviewer's bench. Nothing in the simulation reads it.
   *
   * An AI is the one system a screenshot cannot judge: "does that kart look like
   * it knows what it is doing" is a question about a decision, and the decision
   * is invisible. This prints the ones that matter — who each driver is, what
   * line and speed they are aiming for, how far off that line they actually
   * are, what they are doing about the kart in front, and why they last spent
   * an item.
   */
  function installBench(): void {
    if (typeof globalThis === 'undefined') return;
    const brainOf = (racerId: number): { racer: Racer; b: Brain } | null => {
      const racer = ctx.racers.find((r) => r.id === racerId);
      const b = racer?.ai ? brains.get(racer.ai) : undefined;
      return racer && b ? { racer, b } : null;
    };

    (globalThis as unknown as Record<string, unknown>).__AI = {
      /** Who is driving, and how hard the band is leaning on them. */
      field(): Array<Record<string, unknown>> {
        return ctx.racers.filter((r) => r.ai).map((r) => {
          const b = r.ai ? brains.get(r.ai) : undefined;
          return {
            id: r.id,
            name: r.name,
            vehicle: r.vehicleId,
            place: r.place,
            skill: Math.round((r.ai?.skill ?? 0) * 100) / 100,
            style: b?.profile.key ?? '-',
            blurb: b?.profile.blurb ?? '',
            band: Math.round((r.rubberBand ?? 1) * 1000) / 1000,
          };
        });
      },

      /** One driver, in the terms the decision is actually made in. */
      probe(racerId = 1): Record<string, unknown> | null {
        const hit = brainOf(racerId);
        if (!hit) return null;
        const { racer, b } = hit;
        return {
          name: racer.name,
          style: b.profile.key,
          speed: Math.round(racer.speed * 10) / 10,
          planned: Math.round(b.lastVTarget * 10) / 10,
          lane: Math.round(b.lastLat * 10) / 10,
          off: Math.round(b.lastErr * 10) / 10,
          bend: Math.round(b.bend * 10) / 10,
          save: Math.round(b.save * 10000) / 10000,
          runoff: Math.round(b.runoff * 100) / 100,
          surface: racer.surface,
          drifting: racer.drift.active,
          driftCorner: b.driftCorner,
          driftWhy: b.driftWhy,
          driftAim: b.driftAim,
          driftArm: Math.round(b.driftArm * 100) / 100,
          strain: Math.round(b.strain * 100) / 100,
          tier: racer.drift.tier,
          charge: Math.round(racer.drift.charge * 100) / 100,
          tuck: Math.round(b.tuck * 100) / 100,
          passing: b.passTime > 0 ? b.passTarget : -1,
          tailTime: Math.round(b.tailTime * 10) / 10,
          queueLift: Math.round(b.queueLift * 1000) / 1000,
          cut: b.cut,
          mistake: b.mistakeLeft > 0 ? MISTAKE_NAMES[b.mistakeKind] : '',
          item: racer.item,
          itemWhy: b.itemWhy,
          band: Math.round((racer.rubberBand ?? 1) * 1000) / 1000,
        };
      },

      /** The whole speed plan for one driver, for plotting against a trace. */
      plan(racerId = 1, every = 8): Array<Record<string, number>> {
        const hit = brainOf(racerId);
        const plan = hit?.b.plan;
        if (!plan) return [];
        const out: Array<Record<string, number>> = [];
        for (let i = 0; i < plan.know.n; i += every) {
          out.push({
            d: Math.round(i * plan.know.step),
            v: Math.round(plan.v[i] * 10) / 10,
            lat: Math.round(plan.lat[i] * 10) / 10,
            k: Math.round(plan.k[i] * 10000) / 10000,
          });
        }
        return out;
      },

      /** Every corner on the lap, as this driver sees it. */
      corners(racerId = 1): Array<Record<string, number | string>> {
        const hit = brainOf(racerId);
        const plan = hit?.b.plan;
        if (!plan) return [];
        return plan.know.corners.map((c, i) => ({
          i,
          d0: Math.round(c.d0),
          len: Math.round(c.len),
          radius: Math.round(1 / Math.max(1e-5, c.k)),
          // What the *road* does there, and what this driver's own line does,
          // as radii. A line wider than the road is the racing line doing its
          // job; a line far wider than the road is the plan lying to itself.
          rRoad: Math.round(1 / Math.max(1e-5,
            Math.abs(plan.know.read(plan.know.roadK as unknown as Float32Array, c.apex)))),
          rLine: Math.round(1 / Math.max(1e-5, Math.abs(plan.kAt(c.apex)))),
          entry: Math.round(plan.vAt(c.d0) * 10) / 10,
          apex: Math.round(plan.vAt(c.apex) * 10) / 10,
          dir: c.dir > 0 ? 'right' : 'left',
          driftTier: plan.tier[i],
        }));
      },

      /** The boost strips, and whether this driver rates them worth a detour. */
      pads(racerId = 1): Array<Record<string, number | boolean>> {
        const hit = brainOf(racerId);
        const plan = hit?.b.plan;
        if (!plan) return [];
        return plan.know.pads.map((pad, i) => ({
          i,
          d: Math.round(pad.d0),
          lat: Math.round(pad.lat * 10) / 10,
          worth: plan.padWorth[i],
          vBefore: Math.round(plan.vAt(pad.d0)),
          vAfter: Math.round(plan.vAt(pad.d1 + 40)),
        }));
      },

      /**
       * The measurement this round is judged on: how much of the race each
       * driver spent drifting, at what tier, why every charge ended, and how
       * much time was spent off the road with nothing forcing it.
       */
      tally(): Array<Record<string, unknown>> {
        const pct = (a: number, n: number): number => Math.round((a / Math.max(1, n)) * 1000) / 10;
        return ctx.racers.filter((r) => r.ai).map((r) => {
          const b = r.ai ? brains.get(r.ai) : undefined;
          if (!b) return { name: r.name };
          const t = b.tally;
          const why: Record<string, number> = {};
          for (let i = 0; i < WHY_NAMES.length; i++) if (t.why[i]) why[WHY_NAMES[i]] = t.why[i];
          const mean = t.latSum / Math.max(1, t.steps);
          return {
            name: r.name,
            style: b.profile.key,
            place: r.place,
            lap: r.lap,
            driftPct: pct(t.driftSteps, t.steps),
            tierPct: [0, 1, 2, 3].map((i) => pct(t.tierSteps[i], t.driftSteps)),
            tierHit: Array.from(t.tierHit),
            maxTier: t.maxTier,
            drifts: t.drifts,
            endTier: Array.from(t.endTier),
            why,
            offPct: pct(t.offSteps, t.steps),
            offCutPct: pct(t.offCut, t.steps),
            offUnforcedPct: pct(t.offUnforced, t.steps),
            offLanePct: pct(t.offLane, t.steps),
            offTrackPct: pct(t.offTrack, t.steps),
            crawlPct: pct(t.crawlSteps, t.steps),
            offDriftPct: pct(t.offDrift, t.steps),
            offInsidePct: pct(t.offInside, t.steps),
            offBoostPct: pct(t.offBoost, t.steps),
            offBoostSrc: Array.from(t.offBoostSrc).map((x) => pct(x, t.steps)),
            overMean: Math.round((t.overSum / Math.max(1, t.offSteps)) * 100) / 100,
            stunPct: pct(t.stunSteps, t.steps),
            onSpeed: Math.round((t.onSpeed / Math.max(1, t.onSteps)) * 10) / 10,
            offSpeed: Math.round((t.offSpeed / Math.max(1, t.offN)) * 10) / 10,
            latMean: Math.round(mean * 100) / 100,
            latSd: Math.round(Math.sqrt(Math.max(0,
              t.latSq / Math.max(1, t.steps) - mean * mean)) * 100) / 100,
          };
        });
      },

      /** The last 64 drift endings across the field: which corner, why, what tier. */
      driftLog(racerId = 1): Array<Record<string, number | string>> {
        const hit = brainOf(racerId);
        if (!hit) return [];
        const t = hit.b.tally;
        const out: Array<Record<string, number | string>> = [];
        const n = Math.min(LOG_SIZE, t.logAt);
        for (let k = 0; k < n; k++) {
          const i = (((t.logAt - n + k) % LOG_SIZE) + LOG_SIZE) % LOG_SIZE;
          out.push({ corner: t.log[i * 3], why: WHY_NAMES[t.log[i * 3 + 1]] ?? '?', tier: t.log[i * 3 + 2] });
        }
        return out;
      },

      /** The item boxes the field has learned by watching each other. */
      boxes(): Array<Record<string, number>> {
        return world.boxes.filter((x) => x.active).map((x) => ({
          d: Math.round(x.d), lat: Math.round(x.lat * 10) / 10,
          gone: Math.round(x.gone * 10) / 10,
        }));
      },
    };
  }
}
