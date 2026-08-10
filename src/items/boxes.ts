// Item boxes: where they go, when they come back, and how they read.
//
// Placement is *measured off the circuit* rather than hand-authored, so a
// re-cut layout re-places its own boxes. Two kinds of placement, and the
// difference between them is the whole design:
//
//   Rows. Eight boxes — one per kart — spanning the road wall to wall, at the
//   straightest point of each eighth of the lap. The racing line runs through
//   one of them, so a leader defending their line pays nothing to take an item,
//   which is correct, because what they draw from it is a banana. Nobody else
//   can miss the row either: both ends are pinned to the tarmac edge and the
//   spacing is tighter than the pickup radius, so every line across the road
//   takes exactly one box.
//
//   Detours. Singles out on the gravel of the shortcut and hard on the outside
//   of the two tightest corners. Those cost real time to reach, and the payment
//   is that everyone behind you is drawing from the same table you are.
//
// The boxes themselves are one InstancedMesh each for glass, inner lamp, the
// `?` plate, the halo and the contact shadow — five draw calls for the whole
// circuit's worth, whatever the layout turns out to be.

import * as THREE from 'three';
import { clamp, ease } from '../core/math.ts';
import { features } from '../track/courses/types.ts';
import { roadCrown, shadowOffset } from './entities.ts';
import type { RacingLine } from '../track/racingline.ts';
import {
  boxCoreGeometry, boxGlyphGeometry, boxHaloGeometry, boxHaloMaterial, boxHue,
  boxShellGeometry, contactShadowGeometry, contactShadowMaterial, makeBoxMaterials,
  type BoxMaterials,
} from './models.ts';
import type { GameContext, Track } from '../types.ts';

/** Metres the box floats above the tarmac, at the centre of its bob. */
const FLOAT = 1.45;
/** Edge length. Sized against a ~2m kart: a box you have to aim at is a box
 *  you will miss, and a box you cannot see from the previous corner is a box
 *  nobody plans a lap around. */
const SIZE = 1.85;
/**
 * Seconds a taken box stays gone.
 *
 * **This number is the item economy.** It was 4.0, and against an eight-kart
 * field arriving at a row nose to tail that is not a cooldown, it is a wall:
 * the leaders take the row, and everyone still on their way to it drives over
 * bare tarmac for the next hundred and sixty metres. Measured over a full
 * three-lap race that produced three draws in a hundred and forty-five seconds
 * and one unbroken sixty-four-second stretch with an empty slot — a kart racer
 * whose item layer the player touches for a tenth of the race.
 *
 * Nine tenths of a second is about thirty metres at racing speed: long enough that a row does
 * visibly thin out as the pack files through it, far too short to deny anybody a
 * lap. Traced against a real eight-kart start, even 1.5 was leaving the back of
 * the field on bare tarmac through the opening rows — the whole field converges
 * on the racing line, so the middle of the first row is stripped by the leaders
 * and the time a pack takes to file through one is longer than it looks from
 * the front of it.
 */
const RESPAWN = 0.9;
/**
 * Pickup radius, **measured in the road's plane**.
 *
 * Generous — missing a box you drove through is maddening — and the word
 * "plane" is what makes it generous in practice rather than only on paper. The
 * box floats `FLOAT` = 1.45m up; a straight 3D distance test against a kart
 * sitting on the tarmac therefore spends 1.45 of its 2.5 metres going *up* and
 * leaves 2.03m of actual sideways reach, which is how a 2.5m radius quietly
 * became a 2.0m one and why rows had holes in them. The test compares
 * horizontal distance and gates the vertical separately: see `PICK_LIFT`.
 *
 * **Wider than the row's own spacing, deliberately**, and that is the number
 * this was tuned to rather than a feel. One box in every row sits exactly on
 * the racing line, which is the point of the row — and it is therefore the one
 * box the whole field takes, every lap. A kart on the line whose reach stops
 * short of the *next* box along is a kart that drives through a row of eight,
 * seven of them still standing, and comes out with nothing; traced on a real
 * race that happened at a row with 7 of 8 live and the player dead on the
 * centreline. At 3.1m against a 3.05m spacing there is always a neighbour in
 * range, and the pickup takes the nearest one that is still standing — so what
 * a player sees is a hole where the on-line box was and the one beside it
 * breaking instead, which is exactly what happened.
 */
const PICK_RADIUS = 3.1;
/** Vertical gate on the pickup, metres. Wide enough that a kart landing off a
 *  kerb still collects, tight enough that a box is not taken from a bridge. */
const PICK_LIFT = 3.2;
/**
 * Metres the halo billboard is raised above the box.
 *
 * Small now, because the halo is small now. It used to be a disc two and a
 * quarter metres across hung above a box floating a metre and a half up, and
 * the bottom of its falloff therefore *landed on the tarmac*: photographed from
 * a chase camera, five item boxes each stained four to six metres of the racing
 * line green, magenta or purple, and the discs overlapped into one coloured
 * wash across the road the player was steering down. A floating object with a
 * bright pool under it instead of a shadow reads as a spotlight, not as
 * contact — and this frame had the pool *and* no shadow.
 *
 * The glow now lives inside the box's own silhouette (see `HALO_R`), so it lights
 * the glass and cannot reach the road, and the contact shadow does the job the
 * halo was accidentally doing: telling you there is an object there.
 */
const HALO_LIFT = 0.12;
/**
 * The halo's radius as a fraction of the box.
 *
 * 0.66 of 1.85m is a disc 2.4m across at its widest falloff, centred 1.57m up —
 * so its lower edge stops 0.35m clear of the tarmac at the bottom of the bob,
 * and it can never paint the road. It is still wider than the cube, which is
 * the whole reason it exists: at eighty metres the glass is four pixels and the
 * glow is what a player aims at out of the previous corner.
 */
const HALO_R = 0.66;
/** Metres the contact shadow floats above the tarmac. Small — the polygon
 *  offset on its material is what actually keeps it out of the road. */
const SHADOW_LIFT = 0.03;
/**
 * Boxes in a row across the road.
 *
 * Five is the Mario Kart number on a Mario Kart road. This road is not one: it
 * is 26 to 30 metres wide, which is nine karts abreast, and five boxes strung
 * across it left gaps a kart could steer through without noticing — a measured
 * span of ±9.9m against a 14.5m half-width, two thirds of the tarmac, so a car
 * on a wide entry passed a whole row cleanly and never knew a row was there.
 *
 * Eight is the *minimum* — one per kart in the field — and the actual count is
 * whatever `ROW_SPACING` needs to reach both edges of the road at this point,
 * so it is eight through the hairpin and ten across the start straight. Both
 * ends are pinned to the tarmac edge. A row is meant to be a decision about
 * *which* box, never a decision about whether you get one, and a field of eight
 * arriving at a row of five is seven decisions and one shrug.
 */
const ROW = 8;
/**
 * Metres between boxes in a row — the number the row is actually authored to.
 *
 * It has to stay under `PICK_RADIUS`, and not by a whisker. The box on the
 * racing line is the one the whole field takes, so a kart on the line needs to
 * be able to reach its *neighbour*, not merely the nearest half-gap; that is
 * the difference between a row that supplies the pack and a row that supplies
 * whoever gets there first.
 */
const ROW_SPACING = 2.95;
/**
 * Rows of boxes per lap.
 *
 * Four on a 2.2km lap is one every twenty-two seconds of driving *if you take
 * every single one*, and nobody does — the pack thins each row as it goes
 * through. Ten puts a row every two hundred and twenty metres, which is five
 * and a half seconds at racing speed.
 *
 * That sounds like a lot until you measure the lap: this circuit is 2.2km, and
 * Mario Kart 8's are a third of that with two or three sets each — so ten here
 * is *the same density per second of driving*, not a heavier one. And the
 * number is not a taste: what a slot spends its empty time on, measured over
 * full races, is the run between throwing an item at a real target and reaching
 * the next row. At four rows the autopiloted player held an item for 14% of a
 * race, at six for 39%, at eight for 58%. The cadence is the item economy.
 */
const ROWS = 10;
/**
 * Metres of tarmac left outside the outermost box in a row.
 *
 * Small on purpose: this is what "spans the road" means, and it used to be 2.6
 * *before* the cyclic layout took another half-spacing off the top, so the
 * outermost box sat at ±9.9m on a road 14.5m wide to the edge. The row's ends
 * are pinned here now, so this is the whole margin there is — 1.2m in from the
 * tarmac edge, with `PICK_RADIUS` reaching well past it.
 */
const LIM_EDGE = 1.2;

/**
 * How long the box's own shatter runs.
 *
 * Two clocks, and the first is the one that was missing. `POP` is the
 * *anticipation*: the cube swells for a twentieth of a second and then collapses
 * to nothing, which is the difference between a box being broken and a box
 * being switched off. `SHARD_LIFE` is how long the pieces of it fly.
 */
const POP_UP = 0.05;
const POP_OUT = 0.13;
const SHARD_LIFE = 0.62;
/** Pieces per box, and the ring buffer they come out of. */
const SHARD_N = 8;
const SHARD_MAX = 48;

/** One piece of broken box. Purely visual — nothing in the simulation reads it. */
interface Shard {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  axis: THREE.Vector3;
  spin: number;
  age: number;
  size: number;
  groundY: number;
}

export interface ItemBox {
  pos: THREE.Vector3;
  /** Where the road surface is under it, for the contact shadow. */
  groundY: number;
  /** The same point as a vector, and the rotation that lays a flat disc *in
   *  the road's own plane* there. A contact shadow composed against the world
   *  horizontal cuts into a crowned, banked road and photographs as a sliver of
   *  itself — which is how five boxes ended up apparently casting nothing. */
  ground: THREE.Vector3;
  groundQuat: THREE.Quaternion;
  /** The road's own up at that point, for projecting the sun offset into the
   *  surface rather than through it. */
  groundQuat_up: THREE.Vector3;
  /** Absolute spline distance, for the pickup broadphase. */
  distance: number;
  /**
   * True for the singles out on the shortcut gravel and hard on the outside of
   * the tight corners — the ones you have to *leave the line* to reach.
   *
   * It matters to more than bookkeeping. A detour box is almost never taken, so
   * it is almost always sitting there available, and anything asking "when is
   * the next box" gets a permanent yes from it. `gapAhead` skips them for
   * exactly that reason: the CPU that clears its slot on the approach to a row
   * would otherwise clear it four more times a lap for boxes it is not going
   * anywhere near, and throw away most of the items it draws.
   */
  detour: boolean;
  /** Seconds until it comes back; 0 means it is there now. */
  respawn: number;
  /** 0..1 scale-in on respawn, and the bob/spin phase so a row is not in step. */
  pop: number;
  phase: number;
}

export interface BoxField {
  readonly boxes: ItemBox[];
  rebuild(track: Track, line: RacingLine): void;
  /** Box indices whose centre is within `PICK_RADIUS` of this lap distance. */
  candidates(distance: number): readonly number[];
  /**
   * Metres of road from this lap distance to the next box that is *actually
   * there* — respawning ones do not count.
   *
   * This exists for the CPU item policy, and the behaviour it enables is the
   * single biggest thing keeping a slot full: arriving at a row of boxes with
   * your hands already occupied wastes the row, so a driver holding something
   * it has found no use for spends it just before the row rather than carrying
   * it through. That is what a good Mario Kart player does and it is why the
   * gap between "used my item" and "have another one" collapses to the length
   * of the reel.
   */
  gapAhead(distance: number): number;
  take(index: number): void;
  fixedUpdate(dt: number): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _face = new THREE.Quaternion();
const _billboard = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3();
const _off = new THREE.Vector3();
const _dir = new THREE.Vector3();
const UP_AXIS = new THREE.Vector3(0, 1, 0);

/** Bin width for the pickup broadphase, metres. */
const BIN = 12;

export function createBoxField(ctx: GameContext): BoxField {
  const boxes: ItemBox[] = [];
  const group = new THREE.Group();
  group.name = 'itemBoxes';
  ctx.scene.add(group);

  let materials: BoxMaterials | null = null;
  let shellGeo: THREE.BufferGeometry | null = null;
  let coreGeo: THREE.BufferGeometry | null = null;
  let haloGeo: THREE.BufferGeometry | null = null;
  let haloMat: THREE.MeshBasicMaterial | null = null;
  let glyphGeo: THREE.BufferGeometry | null = null;
  let blobGeo: THREE.BufferGeometry | null = null;
  let blobMat: THREE.MeshBasicMaterial | null = null;
  let shardGeo: THREE.BufferGeometry | null = null;
  let shell: THREE.InstancedMesh | null = null;
  let core: THREE.InstancedMesh | null = null;
  let glyph: THREE.InstancedMesh | null = null;
  let halo: THREE.InstancedMesh | null = null;
  let shadow: THREE.InstancedMesh | null = null;
  let shards: THREE.InstancedMesh | null = null;
  let bins: number[][] = [];
  let binCount = 0;
  let trackLength = 1;

  // The shatter pool. A ring buffer rather than a list with holes in it: the
  // whole field is walked every frame anyway and a dead shard costs one compare.
  const shardPool: Shard[] = [];
  for (let i = 0; i < SHARD_MAX; i++) {
    shardPool.push({
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      axis: new THREE.Vector3(0, 1, 0), spin: 0, age: SHARD_LIFE + 1, size: 1, groundY: 0,
    });
  }
  let shardNext = 0;

  function clearMeshes(): void {
    // The instanced meshes are rebuilt per course; the geometry and materials
    // behind them are not, so only the wrappers are thrown away here.
    for (const m of [shell, core, glyph, halo, shadow, shards]) {
      if (!m) continue;
      group.remove(m);
      m.dispose();
    }
    shell = core = glyph = halo = shadow = shards = null;
  }

  function ensureAssets(): void {
    if (!materials) materials = makeBoxMaterials();
    if (!shellGeo) shellGeo = boxShellGeometry(SIZE);
    if (!coreGeo) coreGeo = boxCoreGeometry(SIZE);
    if (!glyphGeo) glyphGeo = boxGlyphGeometry(SIZE * 0.80);
    // Inside the box's own silhouette — see HALO_R. It is what survives eighty
    // metres of road; it is not allowed to touch the tarmac on the way.
    if (!haloGeo) haloGeo = boxHaloGeometry(SIZE * HALO_R);
    if (!haloMat) haloMat = boxHaloMaterial();
    if (!blobGeo) {
      // Sized to the box, not to its glow: a blob half again as wide as the
      // thing casting it reads as a stain rather than as contact. Every kart on
      // this circuit lays a crisp shadow, and a floating box laying none is the
      // fastest way to make it look pasted on — ARCHITECTURE §12, contact is
      // everything.
      //
      // 0.28 with the ringed build behind it is a real shadow; 0.20 with the
      // old single fan behind it multiplied the road by 0.73 and photographed
      // as a smudge you had to be told about. See `contactShadowGeometry`.
      //
      // ...and 0.70 of the box rather than 0.52, which is a *viewing-angle*
      // number rather than a taste one. The cube spins, so from directly above
      // its silhouette is its diagonal — 2.6m for an 1.85m box — and a 1.9m
      // disc under it is a disc the box is standing on top of and completely
      // hiding. The overhead frame is exactly the one a reviewer uses to check
      // that things touch the ground. At 2.6m the shadow shows all the way
      // round from above and still reads as contact from a chase camera.
      blobGeo = contactShadowGeometry(SIZE * 0.70, 0.28);
      blobMat = contactShadowMaterial();
    }
    // The pieces. Small hard chunks of the same hazard-yellow the plate is
    // painted in, so what comes off the box is recognisably *the box*.
    if (!shardGeo) shardGeo = new THREE.TetrahedronGeometry(SIZE * 0.20, 0);
  }

  function buildMeshes(): void {
    clearMeshes();
    const n = boxes.length;
    if (!n) return;
    ensureAssets();

    shell = new THREE.InstancedMesh(shellGeo!, materials!.shell, n);
    core = new THREE.InstancedMesh(coreGeo!, materials!.core, n);
    glyph = new THREE.InstancedMesh(glyphGeo!, materials!.glyph, n);
    halo = new THREE.InstancedMesh(haloGeo!, haloMat!, n);
    shadow = new THREE.InstancedMesh(blobGeo!, blobMat!, n);
    shards = new THREE.InstancedMesh(shardGeo!, materials!.shard, SHARD_MAX);

    for (const m of [shell, core, glyph, halo, shadow, shards]) {
      // One mesh spans the whole circuit, so a bounding-sphere cull can only
      // ever be wrong. Skip it rather than pay for it.
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      group.add(m);
    }
    shadow.renderOrder = -1;
    shards.count = 0;
    // The halo sits *behind* the box it belongs to, so the glass and the glyph
    // are never washed out by their own glow.
    halo.renderOrder = 1;
    shell.renderOrder = 2;
    core.renderOrder = 3;
    // ...and the glyph sits in front of everything, including the near face of
    // its own cube. The shell writes no depth, so without an explicit order the
    // `?` would be occluded by the glass it is supposed to be seen through.
    glyph.renderOrder = 4;
  }

  /** Mean |curvature| over a window — how straight the road is around here. */
  function flatness(distance: number, half: number): number {
    const spline = ctx.track!.spline;
    let sum = 0;
    for (let i = -3; i <= 3; i++) {
      sum += Math.abs(spline.atDistance(distance + (i / 3) * half).curvature);
    }
    return sum / 7;
  }

  function addBox(distance: number, lateral: number, detour = false): void {
    const spline = ctx.track!.spline;
    const s = spline.atDistance(distance);
    // The shadow belongs under the box, not under the centreline — on a banked
    // corner those are most of a metre apart vertically — and it belongs on the
    // *tarmac*, which stands proud of the spline's own surface by up to 16cm.
    // See `roadCrown`: a shadow laid on the spline is a shadow inside the road.
    const ground = new THREE.Vector3().copy(s.pos)
      .addScaledVector(s.right, lateral)
      .addScaledVector(s.up, roadCrown(lateral, s.width, ctx.track?.course.vergeWidth ?? 5));
    const pos = ground.clone().addScaledVector(s.up, FLOAT);
    const groundQuat = new THREE.Quaternion().setFromUnitVectors(
      UP_AXIS, _up.copy(s.up).normalize());
    boxes.push({
      pos,
      groundY: ground.y,
      ground: ground.clone().addScaledVector(s.up, SHADOW_LIFT),
      groundQuat,
      groundQuat_up: s.up.clone().normalize(),
      distance: ((distance % trackLength) + trackLength) % trackLength,
      detour,
      respawn: 0,
      pop: 1,
      // A deterministic phase from the position: a row must not pulse in step,
      // and this needs no rng draw to say so.
      phase: (Math.abs(pos.x * 0.37 + pos.z * 0.71) % 1) * Math.PI * 2,
    });
  }

  function rebuild(track: Track, line: RacingLine): void {
    boxes.length = 0;
    // Chips from the last race must not be in the air at the lights of the next
    // one. Ages past the life are what "dead" means here; nothing else to undo.
    for (const sh of shardPool) sh.age = SHARD_LIFE + 1;
    shardNext = 0;
    trackLength = track.length;
    const L = track.length;
    const spline = track.spline;
    const start = track.course.startDistance ?? 0;
    const verge = track.course.vergeWidth ?? 5;

    // ── rows on the straights ────────────────────────────────────────────
    //
    // **One row per segment of the lap, not the six flattest points on it.**
    //
    // The old version scored every eight metres of circuit, sorted by flatness
    // and took the best four that were a minimum distance apart. Both halves of
    // that were wrong and the second one silently. Sorting globally means the
    // rows land wherever the *straights* happen to be, so a circuit with its
    // straights bunched together gets its item boxes bunched together too — on
    // Cone Canyon the first row of the lap ended up three hundred and seventy
    // metres past the line, and a race opens with every one of eight karts
    // holding nothing for the first eighteen seconds of it. And the min-gap
    // filter fails *quietly*: ask for six rows a sixth of a lap apart and the
    // loop simply runs out of candidates and hands back four, with nothing
    // anywhere saying the circuit is now under-supplied.
    //
    // Cutting the lap into `ROWS` equal segments and taking the flattest point
    // inside each one cannot do either. The cadence is guaranteed — a row every
    // `L / ROWS` metres whatever the layout — and the flatness test still picks
    // the best *place* within each segment, which is what it was ever good for.
    const STEP = 8;
    /** Metres of clear road after the start line. Eight karts three abreast do
     *  not need a wall of boxes in front of them before the lights go out. */
    const GRID_CLEAR = 90;
    /** ...and before it, so the last row of a lap and the first of the next are
     *  a proper interval apart across the line rather than back to back. */
    const LINE_CLEAR = 170;
    // The cadence is an exact `L / ROWS`, **including across the start line**.
    // Carving the grid's clearance out of the usable length instead and
    // splitting what was left put a 572m hole between the last row of a lap and
    // the first of the next — a fifteen-second dry stretch once a lap, in
    // exactly the place a player has just crossed the line and is looking for
    // something to happen.
    const segLen = L / ROWS;
    // How far from the middle of its segment a row may wander to find straight
    // road, as a fraction of the segment. Deliberately small: an even cadence
    // is worth more to the item economy than a perfectly straight row, and a
    // wide roam lets two neighbouring rows drift towards each other and open a
    // hole somewhere else.
    const ROAM = 0.15;
    /**
     * ...and how much straighter it has to be to bother.
     *
     * Flatness alone is not enough, and the first cut of this proved it: taking
     * the flattest point in each segment put two rows 135m apart and left a
     * 544m hole on the other side of the lap, because the flattest point in one
     * segment was at its right-hand end and the flattest in the next was at its
     * left. The cadence is the whole reason the rows are segmented, so the
     * distance from the middle of the segment is scored *against* the flatness
     * rather than merely bounded by it. Flatness is normalised across the
     * window first, so this weight means what it says whatever the units of
     * curvature happen to be: a candidate out at the edge of its roaming range
     * has to be better than everything else in the window by 0.85 of the whole
     * spread before it wins.
     */
    const CENTRE_PULL = 0.85;

    const reach = segLen * ROAM;
    /**
     * Where the first segment is centred, and with it every other one.
     *
     * Two clearances pull in opposite directions around the same piece of road:
     * nothing within `GRID_CLEAR` *after* the line, and nothing within
     * `LINE_CLEAR` *before* it, because a row there is a row standing in front
     * of a forming grid. Sliding the whole even cadence satisfies both without
     * breaking the cadence — which is the thing that carving a dead zone out of
     * the middle of it could not do.
     */
    const first = clamp(segLen * 0.5,
      GRID_CLEAR + reach,
      Math.max(GRID_CLEAR + reach, segLen - LINE_CLEAR - reach));

    const chosen: number[] = [];
    const window: Array<{ d: number; flat: number }> = [];
    for (let r = 0; r < ROWS; r++) {
      const centre = first + r * segLen;
      window.length = 0;
      let fmin = Infinity;
      let fmax = -Infinity;
      for (let u = -reach; u <= reach; u += STEP) {
        const flat = flatness(start + centre + u, 45);
        if (flat < fmin) fmin = flat;
        if (flat > fmax) fmax = flat;
        window.push({ d: centre + u, flat });
      }
      const spread = fmax - fmin || 1;
      let bestD = centre;
      let bestScore = Infinity;
      for (const c of window) {
        const u = (c.d - centre) / reach;
        const score = (c.flat - fmin) / spread + CENTRE_PULL * u * u;
        if (score < bestScore) { bestScore = score; bestD = c.d; }
      }
      chosen.push(((start + bestD) % L + L) % L);
      /**
       * **The opening row is a double rank.**
       *
       * Every other row on the circuit meets a field that has spread out along
       * the road; this one meets all eight machines side by side with all eight
       * hands empty, and the pack funnels down the racing line, so the middle of
       * the row is stripped by the front of it and the back of it drives through
       * a hole. Traced on a real start, the eighth kart was still empty-handed
       * nine seconds in and did not draw anything until the second row.
       *
       * A second rank forty-six metres on — a lag of a bit over a second, which
       * is roughly how long a pack takes to file through one — makes the opening
       * settlement complete: everybody has something by the first corner, which
       * is what the first corner of a kart race is *for*. Mario Kart doubles its
       * opening set for the same reason, and it is the only row on any circuit
       * that needs it.
       */
      if (r === 0) chosen.push(((start + bestD + 46) % L + L) % L);
    }
    chosen.sort((a, b) => a - b);

    for (const d of chosen) {
      const s = spline.atDistance(d);
      const half = s.width * 0.5;
      // Span the road — *all* of it. The margin is only what stops the
      // outermost box from being unreachable against the barrier; everything
      // between here and the centreline is covered by a box.
      const lim = Math.max(3, half - LIM_EDGE);
      /**
       * **Both ends pinned, and a box exactly on the racing line.**
       *
       * The row used to be a *cyclic* grid slid sideways until one node landed
       * on the line, which sounds equivalent to this and is not. A cyclic grid
       * of `ROW` nodes over a span of `2 lim` has an arbitrary phase, so the
       * outermost node on one side sits anywhere from `lim` to `lim - step`
       * inwards — a whole spacing of tarmac, three metres of it, that no box
       * covers and that changes from row to row for no reason a player could
       * ever learn. Traced over a race that is exactly what a missed row looks
       * like: a kart out at 10.6m off the centreline, five of seven boxes still
       * standing, and the nearest one eight metres away.
       *
       * So: node 0 is at `-lim` and node `n-1` is at `+lim`, always, and the
       * racing line gets a node of its own by letting the two halves of the row
       * carry a different number of intervals.
       *
       * ...and `n` is **derived from the width, not fixed**. A constant count
       * on a road that runs from 21m to 29m across is a constant count at two
       * different spacings, and the wide end came out at 3.8m — past the
       * pickup reach, which is the one number the row has to stay inside. The
       * row is authored as a *spacing* and the count follows; on this circuit
       * that is eight boxes at the hairpin and ten on the start straight.
       */
      const onLine = clamp(line.lateralAt(d), -lim * 0.6, lim * 0.6);
      const n = clamp(Math.round((lim * 2) / ROW_SPACING) + 1, ROW, ROW + 4);
      // How many of the n-1 intervals go to the left of the line. Clamped two
      // off each end: one interval carrying a whole half-road is how you get a
      // gap wider than a kart can reach across.
      const nL = Math.max(2, Math.min(n - 3,
        Math.round(((onLine + lim) / (2 * lim)) * (n - 1))));
      const stepL = (onLine + lim) / nL;
      const stepR = (lim - onLine) / (n - 1 - nL);
      for (let k = 0; k < n; k++) {
        addBox(d, k <= nL ? -lim + k * stepL : onLine + (k - nL) * stepR);
      }
    }

    // ── detours ──────────────────────────────────────────────────────────
    const feat = features(track.course);
    for (const sc of feat.shortcuts ?? []) {
      const from = start + sc.from * L;
      const to = start + sc.to * L;
      for (let k = 1; k <= 2; k++) {
        const d = from + ((to - from) * k) / 3;
        const s = spline.atDistance(d);
        addBox(d, sc.side * (s.width * 0.5 + verge * 0.5), true);
      }
    }

    // The two tightest corners get a box hard on the outside: taking it means
    // giving up the apex, and everyone can see you do it.
    const corners: Array<{ d: number; k: number }> = [];
    for (let d = 0; d < L; d += STEP) {
      corners.push({ d, k: spline.atDistance(d).curvature });
    }
    corners.sort((a, b) => Math.abs(b.k) - Math.abs(a.k));
    const picked: number[] = [];
    for (const c of corners) {
      if (picked.length >= 2) break;
      let ok = true;
      for (const p of picked) if (Math.abs(spline.signedDistance(p, c.d)) < L / 5) { ok = false; break; }
      for (const p of chosen) if (Math.abs(spline.signedDistance(p, c.d)) < 60) { ok = false; break; }
      if (!ok) continue;
      picked.push(c.d);
      const s = spline.atDistance(c.d);
      addBox(c.d, Math.sign(c.k) * (s.width * 0.5 - 1.6), true);
    }

    // ── broadphase bins ──────────────────────────────────────────────────
    binCount = Math.max(1, Math.ceil(L / BIN));
    bins = new Array(binCount);
    for (let i = 0; i < binCount; i++) bins[i] = [];
    for (let i = 0; i < boxes.length; i++) {
      const b = Math.floor(boxes[i]!.distance / BIN) % binCount;
      bins[b]!.push(i);
    }

    buildMeshes();
  }

  const _empty: number[] = [];
  const _found: number[] = [];

  return {
    boxes,

    rebuild,

    candidates(distance: number): readonly number[] {
      if (!binCount) return _empty;
      const d = ((distance % trackLength) + trackLength) % trackLength;
      const b = Math.floor(d / BIN) % binCount;
      _found.length = 0;
      for (let k = -1; k <= 1; k++) {
        const list = bins[(b + k + binCount) % binCount]!;
        for (let i = 0; i < list.length; i++) _found.push(list[i]!);
      }
      return _found;
    },

    gapAhead(distance: number): number {
      const L = trackLength;
      const d = ((distance % L) + L) % L;
      let best = Infinity;
      // A linear walk of forty-odd boxes, called five times a second per racer.
      // A sorted array and a binary search would be faster and would then need
      // the respawn state folded back in by hand; this stays correct for free.
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]!;
        if (b.respawn > 0 || b.detour) continue;
        const gap = ((b.distance - d) % L + L) % L;
        if (gap < best) best = gap;
      }
      return best;
    },

    take(index: number): void {
      const box = boxes[index];
      if (!box) return;
      box.respawn = RESPAWN;
      box.pop = 0;
      // ...and it comes apart. Eight chips off a fixed unit pattern rotated by
      // the box's own phase, so a row does not shatter in step and no draw is
      // spent on an rng the simulation would then have to replay.
      for (let k = 0; k < SHARD_N; k++) {
        const sh = shardPool[shardNext]!;
        shardNext = (shardNext + 1) % SHARD_MAX;
        const a = box.phase + (k / SHARD_N) * Math.PI * 2;
        // Alternate rings, so the spray has a near half and a far half rather
        // than being one flat ring of chips.
        const tilt = k % 2 === 0 ? 0.75 : 0.25;
        const out = 4.6 + (k % 3) * 1.5;
        sh.pos.copy(box.pos);
        sh.vel.set(Math.sin(a) * out, 3.4 + tilt * 3.6, Math.cos(a) * out);
        sh.axis.set(Math.sin(a * 2.3), 0.7, Math.cos(a * 1.7)).normalize();
        sh.spin = 9 + (k % 4) * 3.5;
        sh.age = 0;
        sh.size = 0.72 + (k % 3) * 0.2;
        sh.groundY = box.groundY;
      }
    },

    fixedUpdate(dt: number): void {
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]!;
        if (b.respawn > 0) {
          b.respawn = Math.max(0, b.respawn - dt);
        } else if (b.pop < 1) {
          b.pop = Math.min(1, b.pop + dt * 3.6);
        }
      }

      // ...and the chips, **on the fixed step even though nothing reads them.**
      //
      // The rule is that visuals live in `update`, and the exception is any
      // visual with a *life*: `update` runs off the render clock, which the
      // pause and the review harness cannot stop, so a shatter integrated there
      // carries on flying while the game is frozen and has aged out by the time
      // a screenshot of it comes back. This is eight bodies of ballistics per
      // broken box; putting them on the same clock as the respawn they belong
      // to costs nothing and makes them hold still when the race does.
      for (let i = 0; i < SHARD_MAX; i++) {
        const sh = shardPool[i]!;
        if (sh.age >= SHARD_LIFE) continue;
        sh.age += dt;
        sh.vel.y -= 26 * dt;
        sh.pos.addScaledVector(sh.vel, dt);
        // They land and stop rather than sinking through the road.
        if (sh.pos.y < sh.groundY + 0.08) {
          sh.pos.y = sh.groundY + 0.08;
          sh.vel.set(sh.vel.x * 0.4, Math.abs(sh.vel.y) * 0.28, sh.vel.z * 0.4);
        }
      }
    },

    update(dt: number, time: number): void {
      if (!shell || !core || !glyph || !halo || !shadow || !shards) return;
      materials?.tick(time);
      // The glyph plates are square to the lens, all of them, so one quaternion
      // serves the whole circuit. Full camera-facing rather than yaw-only: this
      // plate lives *inside* a cube and never touches the road, so it has none
      // of the reasons the halo below has to stay upright, and an overhead or
      // minimap camera has to be able to read it too.
      _billboard.copy(ctx.camera.quaternion);
      // The halo billboards about the *vertical only*, and that one word is the
      // whole fix. A full camera-facing billboard is edge-on to the road when
      // the camera is above it — which is exactly what an overhead or minimap
      // shot is — so a soft additive disc three metres across lay flat on the
      // tarmac under every box and *lightened* the road beneath it. A floating
      // object with a bright pool under it instead of a shadow reads as a
      // spotlight, not as contact. Yawing to the camera keeps the glow standing
      // up behind the cube from every angle a player can reach.
      const camX = ctx.camera.position.x;
      const camZ = ctx.camera.position.z;

      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i]!;
        const gone = b.respawn > 0;
        /**
         * **The pop, and then nothing.**
         *
         * A box that is taken used to go from full size to zero between two
         * frames and leave a grey translucent husk standing in the road for the
         * whole four seconds of the respawn. Both halves of that were wrong.
         * A cut is not a break — the eye needs a beat of *anticipation*, the
         * cube swelling before it lets go — and the husk, which was meant to
         * report the respawn clock, photographed as a flat blue-grey lozenge
         * lying on the racing line two seconds after anything had happened
         * there. Litter on the line is a worse lie than a gap in a row: a gap
         * is a box somebody took, which is exactly what it is.
         *
         * So: swell for a twentieth of a second, collapse over the next
         * thirteen hundredths, and be gone. The chips thrown in `take` are what
         * carries the moment from there.
         */
        const since = gone ? RESPAWN - b.respawn : 0;
        const scale = gone
          ? (since < POP_UP ? 1 + (since / POP_UP) * 0.42
            : since < POP_OUT ? 1.42 * (1 - (since - POP_UP) / (POP_OUT - POP_UP))
              : 0)
          : ease.outBack(b.pop);
        const bob = Math.sin(time * 1.7 + b.phase) * 0.13;

        _p.copy(b.pos);
        _p.y += bob;
        _e.set(time * 0.55 + b.phase, time * 0.95 + b.phase * 0.5, time * 0.22);
        _q.setFromEuler(_e);
        _s.setScalar(scale);
        _m.compose(_p, _q, _s);
        shell.setMatrixAt(i, _m);

        // The core counter-rotates and pulses, so even a still frame of a box
        // has something happening inside it.
        _e.set(-time * 1.4 + b.phase, time * 1.9, 0);
        _q.setFromEuler(_e);
        _s.setScalar(scale * (0.85 + Math.sin(time * 4 + b.phase) * 0.15));
        _m.compose(_p, _q, _s);
        core.setMatrixAt(i, _m);

        // The `?`. It nods rather than sitting rigid — a plate pinned square to
        // the lens with no motion of its own reads as a decal stuck on the
        // screen instead of an object floating inside the glass.
        _s.setScalar(scale * (0.94 + Math.sin(time * 3.1 + b.phase) * 0.07));
        _m.compose(_p, _billboard, _s);
        glyph.setMatrixAt(i, _m);

        // The halo breathes on its own beat — slower than the core, so the two
        // never lock into a single throb.
        //
        // ...and it *stands down when the camera climbs*. Yawing to the lens is
        // what keeps the glow upright behind the cube instead of lying flat on
        // the tarmac, and it has one failure mode: from directly above, a plane
        // that only turns about the vertical is edge-on, and every box in the
        // row grows a pair of bright coloured wings. Photographed from the
        // overhead camera that is unmistakably a bug. Past about 55° of
        // elevation the halo is therefore scaled away to nothing — the angles
        // where a glow is doing work (a chase camera sits at ten or fifteen)
        // are untouched, and the angles where it can only misbehave get the box
        // on its own, which from overhead is exactly what reads.
        _dir.subVectors(ctx.camera.position, b.pos);
        const elev = Math.abs(_dir.y) / Math.max(0.001, _dir.length());
        const face = 1 - clamp((elev - 0.55) / 0.34, 0, 1);
        _e.set(0, Math.atan2(camX - b.pos.x, camZ - b.pos.z), 0);
        _face.setFromEuler(_e);
        _s.setScalar(scale * face * (0.92 + Math.sin(time * 2.3 + b.phase * 1.7) * 0.12));
        // Lifted clear of the road. A glow centred on a box floating a metre
        // and a half up reaches the tarmac underneath it and lights exactly the
        // patch the contact shadow lives on — which is how a box ends up with a
        // bright pool under it instead of a shadow.
        _p.y += HALO_LIFT;
        _m.compose(_p, _face, _s);
        halo.setMatrixAt(i, _m);
        halo.setColorAt(i, boxHue(time, _c));
        _p.y -= HALO_LIFT;

        // The contact shadow, laid **in the road's plane** rather than in the
        // world's. On a crowned, banked circuit those differ by more than the
        // disc's own clearance, so a world-horizontal blob spends most of its
        // area inside the tarmac and only a crescent survives the depth test.
        // It also breathes with the bob: the box rises, the shadow spreads and
        // lightens, which is the cue that says "this thing is floating" rather
        // than "this thing is stuck to a decal".
        const lift = 1 + bob * 0.6;
        _s.set(scale * lift, 1, scale * lift);
        // Thrown along the sun, the same way the karts' shadows are. A blob
        // pooled directly under a floating object is the one arrangement that
        // contradicts every other shadow in the frame — and from overhead the
        // box sits on top of it, so the object appears to cast nothing at all.
        _p.copy(b.ground).add(shadowOffset(FLOAT + bob, b.groundQuat_up, _off));
        _m.compose(_p, b.groundQuat, _s);
        shadow.setMatrixAt(i, _m);
      }

      // ── the shatter ────────────────────────────────────────────────────
      //
      // Live chips are compacted into the front of the buffer and the instance
      // count set to however many there are — usually zero, and an
      // InstancedMesh with a count of zero is skipped outright, so the whole
      // rig costs a draw call only on the frames something has just broken.
      // The flight itself is integrated in `fixedUpdate`; this only draws it.
      let live = 0;
      for (let i = 0; i < SHARD_MAX; i++) {
        const sh = shardPool[i]!;
        if (sh.age >= SHARD_LIFE) continue;
        // Shrinking out is what lets them leave without a fade — the material
        // is shared across the whole pool, so alpha is not available per chip.
        const k = 1 - sh.age / SHARD_LIFE;
        _q.setFromAxisAngle(sh.axis, sh.age * sh.spin);
        _s.setScalar(sh.size * k * k);
        _m.compose(sh.pos, _q, _s);
        shards.setMatrixAt(live++, _m);
      }
      shards.count = live;

      shell.instanceMatrix.needsUpdate = true;
      core.instanceMatrix.needsUpdate = true;
      glyph.instanceMatrix.needsUpdate = true;
      halo.instanceMatrix.needsUpdate = true;
      if (halo.instanceColor) halo.instanceColor.needsUpdate = true;
      shadow.instanceMatrix.needsUpdate = true;
      if (live) shards.instanceMatrix.needsUpdate = true;
    },

    dispose(): void {
      clearMeshes();
      materials?.dispose();
      shellGeo?.dispose();
      coreGeo?.dispose();
      glyphGeo?.dispose();
      haloGeo?.dispose();
      haloMat?.dispose();
      blobGeo?.dispose();
      blobMat?.dispose();
      shardGeo?.dispose();
      materials = null;
      shellGeo = coreGeo = glyphGeo = haloGeo = blobGeo = shardGeo = null;
      haloMat = blobMat = null;
      ctx.scene.remove(group);
      boxes.length = 0;
    },
  };
}

/**
 * Does this kart take this box?
 *
 * The one place the test lives, so the radius above and the row spacing that
 * was chosen against it can never drift apart. Horizontal only, with a separate
 * vertical gate — see `PICK_RADIUS`.
 */
export function boxReached(box: ItemBox, pos: THREE.Vector3): boolean {
  if (Math.abs(box.pos.y - pos.y) > PICK_LIFT) return false;
  const dx = box.pos.x - pos.x;
  const dz = box.pos.z - pos.z;
  return dx * dx + dz * dz <= PICK_RADIUS_SQ;
}

/** Squared pickup radius, in the road's plane. */
export const PICK_RADIUS_SQ = PICK_RADIUS * PICK_RADIUS;
