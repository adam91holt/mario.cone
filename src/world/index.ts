// World dressing — everything beside the track.
//
// The circuit already had a landscape and a barrier. What it did not have was a
// *place*: the two hundred metres either side of the road were empty dirt, so
// nothing told you how fast you were going and nothing told you anybody cared
// who won.
//
// ── The one measurement this module is built around ─────────────────────────
//
// The embankment falls 5.7m away from the shoulder inside thirty metres, and
// the barrier stands 1.9m above the road. From a chase camera three metres up,
// that geometry hides *everything* under about six metres tall out to fifty
// metres off the road: the whole near run-off is a ditch you cannot see into.
// Scatter a thousand beautiful traffic cones in it and the player sees a wall.
//
// So the dressing is built in three bands chosen against that sight line rather
// than by eye:
//
//   **Tall and close.** Along the straights, only things that clear six metres
//   go near the road: lighting columns, flag masts, floodlights, the gantry's
//   own furniture. They are the parallax layer — the things that whip past.
//
//   **Level and cut.** Anything that has to be *read* at twenty to sixty metres
//   stands on a platform at road height with a plinth buried into the bank:
//   works compounds on levelled pads, grandstands and spectator banking on
//   their own concrete. That is also what a real site and a real circuit do,
//   so the fix and the fiction are the same thing.
//
//   **Low and far.** Ground-level scatter — cones, drums, tyre stacks, spoil,
//   scrub, boulders — goes where the sight line actually reaches it: across the
//   outside of every corner, and from a hundred metres out where the barrier no
//   longer occludes. It also carries the overhead and pulled-back cameras.
//
//   **The middle distance** (§5b). Forty to a hundred and fifty metres out is
//   most of a pulled-back frame's width and it used to be bare dirt. It gets
//   event fields — pale gravel hardstands with spectator parking, hospitality
//   marquees and twenty-one-metre light towers — plus benched ground and
//   aggregate stockpiles. Only *tall* and *pale* survive the barrier's sight
//   line from the road; the rest is there for the cameras that look down.
//
// On top of that, the horizon layer: cranes, silos, a mast, a conveyor and a
// twenty-two metre traffic cone, one at the end of each straight, so a driver
// knows where they are on the lap without reading the minimap.
//
// ── The chroma budget ───────────────────────────────────────────────────────
//
// Full-strength orange and yellow belong to the *race* — karts, item boxes,
// boost strips. Set dressing that covers a lot of frame is held to roughly 60%
// chroma with its value capped below kart paint (`mute()` in look.ts), and buys
// its graphic punch back in value contrast instead. This is not a taste
// preference: a full-chroma hoarding run at kart height is camouflage, and the
// previous build lost a row of item boxes into one.
//
// ── Cost ────────────────────────────────────────────────────────────────────
//
// One geometry and one material per kind, so every kind is an InstancedMesh.
// High-count kinds are split by lap sector, coarsely enough that a batch is
// still worth submitting, so the half of the circuit behind you frustum-culls
// away; on top of that every batch carries its own draw distance scaled by
// `ctx.quality.drawDistance`. Nothing casts a shadow (see `def` below).
//
// Measured on Cone Canyon: **270-400 draw calls and 640-780k triangles** for
// the whole game in a settled frame, of which this module is the larger
// part. Spectators dominate that bill — a bank is fifty people at eighty
// triangles each and there are fifty banks — so the crowd draw distances are
// set where a bank stops being *people*, not where it stops being visible.
// Crowds, flags and steam animate entirely in vertex programs and cost nothing
// per frame; the six hero set pieces are the only things that touch the CPU,
// and between them they write about twenty matrices a frame.
//
// Ownership: this module owns `src/world/**`. It reads the track through
// `ctx.track` once `track:built` fires and never writes to it.

import * as THREE from 'three';
import { makeRng } from '../core/math.ts';
import { Batcher, Ground, type Batch, type Spot } from './place.ts';
import { C, createMaterials, type WorldClock, type WorldMaterials } from './look.ts';
import * as P from './props.ts';
import { clusterCrowdGeo, deckCrowdGeo, standCrowdGeo, terraceCrowdGeo } from './crowd.ts';
import {
  createBirds, createBridge, createRailway, createTipper, createWreckingCrane,
  type SetPiece,
} from './setpieces.ts';
import type { GameContext, GameSystem, Track, TrackSplineLike } from '../types.ts';

/** A corner, found from the curvature profile rather than authored. */
interface Corner {
  from: number;
  to: number;
  mid: number;
  /** Sharpest curvature anywhere in the span. */
  peak: number;
  /** Which side the apex is on, and which side the run-off is. */
  inner: -1 | 1;
  outer: -1 | 1;
  /** Length times sharpness — how much of a *moment* this corner is. */
  weight: number;
}

interface Claim { x: number; z: number; r: number }

const _camPos = new THREE.Vector3();

export function createWorldSystem(ctx: GameContext): GameSystem {
  const group = new THREE.Group();
  group.name = 'world';

  const clock: WorldClock = { value: 0 };
  let mats: WorldMaterials | null = null;
  let batches: Batch[] = [];
  let pieces: SetPiece[] = [];
  let offBus: (() => void) | null = null;
  let builtFor = '';
  let time = 0;

  function teardown(): void {
    for (const p of pieces) { group.remove(p.root); p.dispose(); }
    pieces = [];
    for (const b of batches) {
      group.remove(b.mesh);
      b.mesh.dispose();
      b.mesh.geometry.dispose();
    }
    batches = [];
    group.clear();
    builtFor = '';
  }

  // ── the build ────────────────────────────────────────────────────────────

  function build(track: Track): void {
    const M = mats;
    if (!M) return;
    teardown();
    builtFor = track.id;

    const spline = track.spline;
    const L = track.length;
    const ground = new Ground(spline, track.course);
    const batcher = new Batcher(L);
    const rng = makeRng(0x1a7c0 ^ hashString(track.id));
    const claims: Claim[] = [];
    const start = track.course.startDistance ?? 0;

    const wrap = (d: number): number => ((d % L) + L) % L;
    /** Lap fraction to distance. */
    const frac = (f: number): number => wrap(start + f * L);

    // ── kinds ──────────────────────────────────────────────────────────────
    // `far` is how many metres each kind survives to. A traffic cone at 280m is
    // two pixels; a tower crane at 280m is the skyline.
    //
    // Nothing out here casts a shadow, and that is a considered decision rather
    // than an oversight. The landscape is drawn unlit (track/terrain.ts) and
    // receives no shadow map at all, so the only surface a prop's shadow could
    // land on is the road — which is on the far side of a barrier from every
    // one of them. Meanwhile three culls the shadow pass per *object*, so one
    // instanced batch clipping the shadow frustum re-submits every cone in a
    // quarter of the circuit. Turning it off across the module halved the
    // module's triangle count for no visible loss; the grounding comes from the
    // baked contact patches instead.
    const def = (
      id: string, geo: THREE.BufferGeometry, far: number,
      material: THREE.Material = M.prop,
    ): void => batcher.define(id, geo, { material, far, cast: false });

    def('contact', P.blobGeo(), 200, M.shadow);
    def('cone', P.coneGeo(), 250);
    def('coneStack', P.coneStackGeo(), 340);
    def('drum', P.drumGeo(), 320);
    def('barrierRun', P.barrierRunGeo(), 360);
    def('trestle', P.trestleGeo(), 340);
    def('tyres', P.tyreStackGeo(), 380);
    def('sign', P.signGeo(), 420);
    def('arrowBoard', P.arrowBoardGeo(), 440);
    def('lightColumn', P.lightColumnGeo(), 820);
    def('beacon', P.beaconGeo(), 280, M.glow);
    def('hoarding', P.hoardingGeo(0), 400);
    def('hoarding2', P.hoardingGeo(1), 400);
    def('hoarding3', P.hoardingGeo(2), 400);
    def('pad', P.padGeo(32, 26), 900);
    def('padSmall', P.padGeo(21, 17), 720);

    def('portaloo', P.portalooGeo(), 560);
    def('container', P.containerGeo(), 1000);
    def('siteHut', P.siteHutGeo(), 1000);
    def('skip', P.skipGeo(), 600);
    def('floodlight', P.floodlightGeo(), 1000);
    def('scaffold', P.scaffoldGeo(), 680);
    def('pipeStack', P.pipeStackGeo(), 560);
    def('cableDrum', P.cableDrumGeo(), 500);
    def('palletStack', P.palletStackGeo(), 500);
    def('digger', P.diggerGeo(), 780);
    def('dumper', P.dumperGeo(), 780);
    def('marshalPost', P.marshalPostGeo(), 560);
    def('ventPipe', P.ventPipeGeo(), 560);
    def('steam', P.steamGeo(), 820, M.puff);

    def('spoil', P.spoilHeapGeo(), 950);
    def('boulder', P.boulderGeo(), 800);
    def('scrub', P.scrubGeo(), 420);

    // The middle distance — see §5b. Everything here is either large or tall,
    // because forty to a hundred and fifty metres out is five metres below the
    // road and hidden to about four metres by the barrier.
    def('hardstand', P.hardstandGeo(34, 48), 1500);
    def('hardstandS', P.hardstandGeo(22, 22), 1200);
    def('vanRow', P.vanRowGeo(11), 700);
    def('vanRow2', P.vanRowGeo(29), 700);
    def('vanRow3', P.vanRowGeo(47), 700);
    def('marquee', P.marqueeGeo(5), 1300);
    def('marquee2', P.marqueeGeo(23), 1300);
    def('berm', P.bermGeo(), 1400);
    def('stockpile', P.stockpileGeo(), 1600);
    def('floodTower', P.floodTowerGeo(), 2000);

    def('grandstand', P.grandstandGeo(8), 1600);
    def('standCrowd', standCrowdGeo(8, 21), 1600, M.crowd);
    def('grandstandS', P.grandstandGeo(5), 1300);
    def('standCrowdS', standCrowdGeo(5, 33), 1300, M.crowd);
    def('terrace', P.terraceGeo(), 900);
    def('terraceCrowd', terraceCrowdGeo(41), 740, M.crowd);
    // Spectator banks. Fifty-odd of these carry the lap, so they are also the
    // module's largest triangle bill — the draw distance is set where a bank
    // stops being people and starts being a coloured smudge, not where it stops
    // being visible.
    for (let i = 0; i < 3; i++) {
      def(`crowd${i}`, clusterCrowdGeo(101 + i * 17), 560, M.crowd);
    }
    def('deckCrowd', deckCrowdGeo(63, 3.4, 2, 0.85), 620, M.crowd);

    def('flagPole', P.flagPoleGeo(8.5), 820);
    def('flagA', P.flagGeo(2.45, 1.55, C.orange, C.white, 0), 780, M.cloth);
    def('flagB', P.flagGeo(2.45, 1.55, C.yellow, C.ink, 1), 780, M.cloth);
    def('flagC', P.flagGeo(2.45, 1.55, C.cyan, C.ink, 2), 780, M.cloth);
    def('bunting', P.buntingGeo(16), 540, M.cloth);

    def('towerCrane', P.towerCraneGeo(), 3000);
    def('silo', P.siloGeo(), 3000);
    def('mast', P.mastGeo(), 3000);
    def('conveyor', P.conveyorGeo(), 3000);
    def('giantCone', P.giantConeGeo(), 3000);

    // ── placement helpers ──────────────────────────────────────────────────

    /** A spot on the embankment, or null when the ground there is not real. */
    function at(d: number, side: -1 | 1, off: number): Spot | null {
      const s = ground.spot(wrap(d), side, off);
      if (!s.ok) return null;
      // Anything a few metres out has to prove it is not standing on the far
      // side of the circuit — this loop folds back on itself twice.
      if (off > 10 && ground.clearance(s.x, s.z) < off * 0.72) return null;
      return s;
    }

    /** The same spot, lifted to road level: for anything that stands on a pad. */
    function atRoad(d: number, side: -1 | 1, off: number): Spot | null {
      const s = at(d, side, off);
      if (!s) return null;
      s.y = ground.roadY(wrap(d));
      return s;
    }

    function farAt(d: number, side: -1 | 1, off: number): Spot | null {
      const s = ground.farSpot(wrap(d), side, off);
      if (ground.clearance(s.x, s.z) < Math.min(off, 150) * 0.72) return null;
      return s;
    }

    function free(x: number, z: number, r: number): boolean {
      for (let i = 0; i < claims.length; i++) {
        const c = claims[i]!;
        const dx = x - c.x, dz = z - c.z;
        if (dx * dx + dz * dz < (r + c.r) * (r + c.r)) return false;
      }
      return true;
    }
    const claim = (x: number, z: number, r: number): void => { claims.push({ x, z, r }); };

    /** Drop a prop, plus the soft contact patch that stands in for its shadow.
     *  The landscape is drawn unlit and receives no shadow map, so without one
     *  every prop reads as a sticker. */
    function drop(
      kind: string, s: Spot, yaw: number, scale: number, d: number, contact = 0,
    ): void {
      batcher.placeAt(kind, s.x, s.y - 0.07 * scale, s.z, yaw, scale, wrap(d));
      if (contact > 0) {
        batcher.placeAt('contact', s.x, s.y + 0.055, s.z, yaw, contact, wrap(d));
      }
    }

    /** Which side of the road has more room at this distance. */
    function roomier(d: number, off: number): -1 | 1 {
      const a = ground.spot(wrap(d), 1, off);
      const ca = a.ok ? ground.clearance(a.x, a.z) : -1;
      const b = ground.spot(wrap(d), -1, off);
      const cb = b.ok ? ground.clearance(b.x, b.z) : -1;
      return ca >= cb ? 1 : -1;
    }

    // Anything that has earned the frame — a crowd bank, a works yard, a stand
    // — books an opening in the hoarding run, and the boards are laid last,
    // around them.
    const gaps: Array<{ a: number; b: number; side: -1 | 1 }> = [];
    const gap = (a: number, b: number, side: -1 | 1): void => {
      gaps.push({ a: wrap(a), b: wrap(b), side });
    };
    function inGap(d: number, side: -1 | 1): boolean {
      const w = wrap(d);
      for (let i = 0; i < gaps.length; i++) {
        const g = gaps[i]!;
        if (g.side !== side) continue;
        if (g.a <= g.b ? (w >= g.a && w <= g.b) : (w >= g.a || w <= g.b)) return true;
      }
      return false;
    }
    const corners = findCorners(spline, L);
    /** Lap order, for anything that cares about what comes next. */
    const lapOrder = corners.slice().sort((a, b) => a.from - b.from);
    corners.sort((a, b) => b.weight - a.weight);

    // ── the boards ─────────────────────────────────────────────────────────
    //
    // The first version of this ran a four-metre board every twelve metres down
    // *both* sides for the whole lap. It was the loudest thing in every frame,
    // it made every corner look like every straight, and — the part that
    // actually mattered — the item-box row disappeared into it, because a wall
    // of trackside colour at kart height is camouflage.
    //
    // So the boards are a rhythm now, and the rhythm carries information:
    //
    //   **One side per straight.** Never both at the same lap distance. The
    //   open side hands the frame back to the landscape, which is what stops a
    //   circuit reading as a corridor.
    //
    //   **Never on the outside of a corner.** The side chosen for a straight is
    //   the *inside* of the corner it runs into, so as a player comes down to a
    //   bend the boards are on the hand they are turning towards and the
    //   outside is open crowd and run-off. That is the MK8 Stadium tell: the
    //   build-up you see ahead is spectators, and the boards stopping is the
    //   cue that the road is about to.
    //
    //   **The approach is clear.** Forty-six metres before a corner's entry the
    //   run ends, so nothing four metres tall stands two metres behind the
    //   barrier at the exact moment a player is reading the turn-in.
    //
    // What is left is roughly a third of the boards, in runs of six to a dozen
    // with flag masts at their ends and every fifth slot — which is both
    // cheaper and, from the road, far more like a race track.
    const HOARDINGS = ['hoarding', 'hoarding2', 'hoarding3'];
    const FLAGS = ['flagA', 'flagB', 'flagC'];
    const SPACING = 12.2;
    /** Metres of clear road before a corner's entry, and after its exit. At
     *  forty-five metres a second, thirty-eight metres of open outside is most
     *  of a second of the approach — enough to read the turn-in against the
     *  landscape rather than against a board. */
    const LEAD = 36, TRAIL = 18;
    /** A run shorter than this is not a rhythm, it is litter. */
    const MIN_RUN = 44;

    function hoardingRun(): void {
      if (lapOrder.length < 2) return;
      let variant = 0;
      for (let i = 0; i < lapOrder.length; i++) {
        const c = lapOrder[i]!;
        const last = i === lapOrder.length - 1;
        const next = lapOrder[last ? 0 : i + 1]!;
        // The side is the inside of the corner this straight feeds into. When
        // the two corners bend opposite ways that side is also the outside of
        // the one just left, so the run starts later to stay off its exit.
        const side = next.inner;
        let from = c.to + TRAIL + (side === c.outer ? 24 : 0);
        const to = (last ? next.from + L : next.from) - LEAD;
        const len = to - from;
        if (len < MIN_RUN) continue;

        const n = Math.floor(len / SPACING);
        from += (len - (n - 1) * SPACING) * 0.5;
        // Bookend masts only where there is a run long enough to bookend. On
        // this circuit the straights between corners are short, and capping a
        // four-slot run at both ends leaves two boards and no rhythm at all.
        const capped = n >= 6;
        for (let j = 0; j < n; j++) {
          const d = from + j * SPACING;
          if (inGap(d, side)) continue;
          // The ends of a run and every sixth slot inside a long one are a
          // mast, not a board: the break is what keeps a run from re-becoming a
          // wall, and the ends stop it terminating in mid-air.
          if (capped && (j === 0 || j === n - 1 || (n >= 10 && j % 6 === 5))) {
            const m = at(d, side, 4.2);
            if (!m) continue;
            drop('flagPole', m, 0, 1, d, 1.0);
            batcher.placeAt(FLAGS[(i + j) % 3]!,
              m.x, m.y + 7.0, m.z, m.along + Math.PI * 0.5, 1, wrap(d));
            continue;
          }
          const s = at(d, side, 2.3);
          // A board is printed on one face. `along` points a prop's +Z down the
          // track, which leaves its +X pointing away from the road on one side
          // and at it on the other — so the far side is turned end for end. The
          // run is symmetric along its length, so nothing else changes.
          if (s) {
            drop(HOARDINGS[variant % HOARDINGS.length]!, s,
              s.along + (side > 0 ? Math.PI : 0), 1, d, 0);
          }
          variant++;
        }
      }
    }

    // ── 1. the tall rhythm ─────────────────────────────────────────────────
    //
    // The parallax layer. Everything here clears the barrier by a wide margin,
    // because anything that does not is invisible from a chase camera.

    let colSide: -1 | 1 = 1;
    for (let d = 0; d < L; d += 52) {
      colSide = colSide === 1 ? -1 : 1;
      const s = at(d, colSide, rng.range(3.2, 4.4));
      if (s) drop('lightColumn', s, s.face, 1, d, 1.6);
    }

    // Flag masts, thinned out between the columns so the two never coincide.
    for (let d = 26; d < L; d += 104) {
      const side = (rng.bool() ? 1 : -1) as -1 | 1;
      const s = at(d, side, rng.range(4.4, 5.6));
      if (!s) continue;
      drop('flagPole', s, 0, 1, d, 1.0);
      batcher.placeAt(['flagA', 'flagB', 'flagC'][(d / 104 | 0) % 3]!,
        s.x, s.y + 7.0, s.z, s.along + Math.PI * 0.5, 1, wrap(d));
    }

    // ── 2. the corners ─────────────────────────────────────────────────────
    //
    // On the outside of a bend the sight line crosses the run-off instead of
    // running along the barrier, so this is the one place ground-level dressing
    // is properly visible from the road. It gets the most of everything.

    for (let ci = 0; ci < corners.length; ci++) {
      const c = corners[ci]!;
      const big = ci < 4;
      const mid = c.mid;

      // The outside of the bend is where the crowd goes, so the boards open up
      // for it — from the apron through to the exit banking.
      gap(mid - 34, mid + 34, c.outer);

      for (let d = c.from; d < c.to; d += 13) {
        const s = at(d, c.outer, rng.range(3.4, 5.0));
        if (s && rng.bool(0.5)) drop('tyres', s, s.along, rng.range(0.9, 1.2), d, 1.5);
      }
      const app = at(c.from - 30, c.outer, 3.0);
      if (app) drop('sign', app, app.face + c.outer * 0.3, 1, c.from - 30, 1.1);

      // The build-up. The boards stop forty-six metres before a corner's entry,
      // so this is what fills the approach instead: masts on the outside, which
      // is the hand the corner is about to open onto. A driver reads "corner"
      // off the dressing thickening on one side long before the road turns.
      for (let i = 0; i < 2; i++) {
        const fd = c.from - 38 + i * 14;
        const fp = at(fd, c.outer, 6.5);
        if (!fp) continue;
        drop('flagPole', fp, 0, 1, fd, 1.0);
        batcher.placeAt(['flagA', 'flagB', 'flagC'][(ci + i) % 3]!,
          fp.x, fp.y + 7.0, fp.z, fp.along + Math.PI * 0.5, 1, wrap(fd));
      }

      for (let i = 0; i < 4; i++) {
        const d = c.from + (c.to - c.from) * (0.15 + i * 0.24);
        const s = at(d, c.outer, rng.range(7, 10));
        if (s) drop('barrierRun', s, s.along, 1, d, 0);
      }
      // A fan of cones across the run-off floor. Mostly for the pulled-back and
      // overhead cameras — down at ground level the barrier hides it from the
      // chase — but it is what stops the run-off reading as bare dirt from
      // anywhere else on the circuit.
      for (let i = 0; i < 20; i++) {
        const d = c.from + ((c.to - c.from) * i) / 20;
        const s = at(d, c.outer, 11 + (i % 5) * 1.7);
        if (s) drop('cone', s, s.along, 1.05, d, 0.9);
      }

      // The marshal apron: a levelled platform at road height on the outside of
      // the bend, carrying everything that has to be *seen* — because anything
      // standing on the natural ground here is four metres down a hole.
      const apron = atRoad(mid - 4, c.outer, 17);
      if (apron && free(apron.x, apron.z, 15)) {
        claim(apron.x, apron.z, 13);
        drop('padSmall', apron, apron.along, 1, mid - 4, 0);
        const y = apron.y;
        const on = (dz: number, dOff: number): Spot | null => {
          const s = at(mid - 4 + dz, c.outer, 17 + dOff);
          if (!s) return null;
          s.y = y;
          return s;
        };
        const post = on(-2, -1);
        if (post) drop('marshalPost', post, post.face, 1, mid, 2.6);
        const board = on(-7, 1.5);
        if (board && big) drop('arrowBoard', board, board.face + c.outer * 0.2, 1, mid, 3.0);
        for (let i = 0; i < 9; i++) {
          const s = on(-7 + i * 1.8, -7.4 + (i % 2) * 0.4);
          if (!s) continue;
          if (i === 4) {
            drop('drum', s, s.along, 1, mid, 1.0);
            batcher.placeAt('beacon', s.x, s.y + 1.02, s.z, 0, 1.2, wrap(mid));
          } else {
            drop('cone', s, s.along, 1.1, mid, 0.9);
          }
        }
        const stack = on(5, 2);
        if (stack) drop('coneStack', stack, rng.range(0, 6), 1.1, mid, 1.1);
        const ty = on(7.5, -3);
        if (ty) drop('tyres', ty, ty.along, 1.2, mid, 1.6);
      }

      // Spectators, on their own banking, behind and above the apron.
      const bankOff = big ? 30 : 27;
      const s = atRoad(mid, c.outer, bankOff);
      if (s && free(s.x, s.z, 16)) {
        claim(s.x, s.z, 15);
        if (big) {
          drop('terrace', s, s.face, 1, mid, 0);
          drop('terraceCrowd', s, s.face, 1, mid, 0);
        } else {
          drop(`crowd${ci % 3}`, s, s.face, 1, mid, 0);
        }
        for (let i = 0; i < (big ? 4 : 2); i++) {
          const fd = mid - 24 + i * 15;
          const fp = at(fd, c.outer, 6.5);
          if (!fp) continue;
          drop('flagPole', fp, 0, 1, fd, 1.0);
          batcher.placeAt(['flagA', 'flagB', 'flagC'][(ci + i) % 3]!,
            fp.x, fp.y + 7.0, fp.z, fp.along + Math.PI * 0.5, 1, wrap(fd));
        }
      }
      // Two more knots either side of it, so the corner is populated along its
      // length rather than at one point.
      for (const [dd, oo] of [[-26, 24], [22, 26]] as const) {
        const s2 = atRoad(mid + dd, c.outer, oo);
        if (!s2 || !free(s2.x, s2.z, 13)) continue;
        claim(s2.x, s2.z, 12);
        drop(`crowd${(ci + (dd > 0 ? 1 : 2)) % 3}`, s2, s2.face, 1, mid + dd, 0);
      }
      // …and a scrap of works on the inside, which is what the camera is
      // pointed at on the way in.
      const inn = at(mid, c.inner, rng.range(13, 20));
      if (inn && free(inn.x, inn.z, 10)) {
        claim(inn.x, inn.z, 9);
        drop('spoil', inn, rng.range(0, 6), rng.range(0.7, 1.2), mid, 0);
        const cs = at(mid + 9, c.inner, rng.range(9, 14));
        if (cs) drop('coneStack', cs, rng.range(0, 6), 1.1, mid + 9, 1.1);
      }
    }

    // ── 3. work compounds ──────────────────────────────────────────────────
    //
    // Seven yards around the lap, each one cut into the bank as a levelled pad
    // so it sits at road height and can actually be seen. Everything on a pad
    // is squared up to the road — a random scatter of objects reads as debris,
    // a squared-up group reads as somebody's job.

    const COMPOUNDS: Array<{ f: number; side: -1 | 1; off: number }> = [
      { f: 0.085, side: 1, off: 30 },
      { f: 0.205, side: -1, off: 27 },
      { f: 0.335, side: 1, off: 32 },
      { f: 0.455, side: -1, off: 28 },
      { f: 0.575, side: 1, off: 34 },
      { f: 0.705, side: -1, off: 30 },
      { f: 0.855, side: 1, off: 28 },
    ];
    for (let i = 0; i < COMPOUNDS.length; i++) {
      const cfg = COMPOUNDS[i]!;
      // Corners are dressed first and they claim a lot of ground, so a yard
      // pinned to one exact lap fraction mostly loses the argument and never
      // gets built. Let it slide along the lap and further out until it finds
      // room — a works compound has no business being anywhere in particular.
      let d0 = 0, anchor: Spot | null = null, off = cfg.off;
      for (let k = 0; k < 12 && !anchor; k++) {
        const shift = ((k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2)) * 26;
        off = cfg.off + (k > 5 ? 12 : 0);
        d0 = frac(cfg.f) + shift;
        const s = atRoad(d0, cfg.side, off);
        if (s && free(s.x, s.z, 19)) anchor = s;
      }
      if (!anchor) continue;
      claim(anchor.x, anchor.z, 18);
      gap(d0 - 22, d0 + 22, cfg.side);
      compound(d0, cfg.side, off, i);
    }

    function compound(d0: number, side: -1 | 1, off: number, seed: number): void {
      const r = makeRng(0x5171 + seed * 977);
      const pad = atRoad(d0, side, off);
      if (!pad) return;
      drop('pad', pad, pad.along, 1, d0, 0);

      // Everything on the pad shares the pad's height; only x/z come from the
      // track frame, so nothing tilts or sinks relative to the platform.
      const y = pad.y;
      const on = (dz: number, dOff: number): Spot | null => {
        const s = at(d0 + dz, side, off + dOff);
        if (!s) return null;
        s.y = y;
        return s;
      };

      const kinds = ['siteHut', 'container', 'container', 'siteHut'];
      for (let i = 0; i < 3; i++) {
        const s = on(-9 + i * 8.4, r.range(6.5, 9));
        if (s) drop(r.pick(kinds), s, s.along, 1, d0, 8.5);
      }
      for (let i = 0; i < 3; i++) {
        const s = on(11.5 + i * 1.5, 7.5 - i * 0.3);
        if (s) drop('portaloo', s, s.face + r.range(-0.15, 0.15), 1, d0, 2.1);
      }
      const p1 = on(r.range(-3, 3), r.range(-2, 1));
      if (p1) drop(r.bool() ? 'digger' : 'dumper', p1, p1.face + r.range(-0.4, 0.4), 1, d0, 5.5);
      const p2 = on(r.range(7, 12), r.range(-4, -1));
      if (p2) drop('skip', p2, p2.along + r.range(-0.2, 0.2), 1, d0, 4.2);

      const mat1 = on(r.range(-14, -9), r.range(0, 3));
      if (mat1) drop('pipeStack', mat1, mat1.along + r.range(-0.3, 0.3), 1, d0, 4.5);
      const mat2 = on(r.range(-5, 1), r.range(3, 5));
      if (mat2) drop('palletStack', mat2, mat2.face + r.range(-0.5, 0.5), 1, d0, 2.2);
      const mat3 = on(r.range(4, 10), r.range(3, 5));
      if (mat3) drop('cableDrum', mat3, mat3.along + r.range(-0.4, 0.4), 1, d0, 3.0);

      const fl = on(r.range(-15, -11), r.range(-4, -2));
      if (fl) {
        drop('floodlight', fl, fl.face, 1, d0, 3.4);
        batcher.placeAt('beacon', fl.x, fl.y + 1.3, fl.z, 0, 1.4, wrap(d0));
      }
      const sc = on(r.range(13, 17), r.range(-6, -3));
      if (sc) {
        drop('scaffold', sc, sc.face, 1, d0, 4.6);
        // Site staff who have found the best view on the circuit.
        batcher.placeAt('deckCrowd', sc.x, sc.y + 5.47, sc.z, sc.face, 1, wrap(d0));
      }
      // Cones and drums along the front lip of the pad, marking it off.
      for (let i = 0; i < 11; i++) {
        const s = on(-16 + i * 3.3, -12.6 + r.range(-0.5, 0.5));
        if (!s) continue;
        if (i % 5 === 2) {
          drop('drum', s, s.along, 1, d0, 1.0);
          batcher.placeAt('beacon', s.x, s.y + 1.02, s.z, 0, 1, wrap(d0));
        } else {
          drop('cone', s, s.along, 1.05, d0, 0.9);
        }
      }
      // Spoil, off the back of the pad and down the bank where it belongs.
      const heap = at(d0 + r.range(14, 24), side, off + r.range(14, 22));
      if (heap) drop('spoil', heap, r.range(0, 6), r.range(0.9, 1.5), d0, 0);
    }

    // ── 4. the start/finish event ──────────────────────────────────────────
    //
    // Not a line — a venue. Stands facing each other across the road, the
    // paddock behind the main one, a wall of flags and bunting down the pit
    // straight, and a cone the size of a building standing over the lot so the
    // place is recognisable from three quarters of the lap away.

    startFinish();

    function startFinish(): void {
      const r = makeRng(0x9e3f);
      const OUT = roomier(start, 60);
      const IN = -OUT as -1 | 1;

      // The stands own the pit straight; the boards get the ends of it.
      gap(start - 150, start + 104, OUT);
      gap(start - 150, start + 60, IN);

      // Stands sit as close to the road as the barrier allows. Pushed further
      // back they leave the frame entirely: at forty degrees off axis a chase
      // camera down the straight simply never sees them, and a grandstand
      // nobody sees is the most expensive object in the game.
      // The main stand goes *ahead* of the grid, not level with it. The grid
      // sits forty metres back from the line and the chase camera another eight
      // behind that, so anything beside the line is already past the edge of
      // the frame when the lights are on — and the lights are exactly when the
      // player is looking hardest.
      const mainD = start + 58;
      const main = atRoad(mainD, OUT, 12);
      if (main) {
        claim(main.x, main.z, 22);
        drop('grandstand', main, main.face, 1, mainD, 0);
        drop('standCrowd', main, main.face, 1, mainD, 0);
      }
      const main2D = start - 54;
      const main2 = atRoad(main2D, OUT, 12);
      if (main2) {
        claim(main2.x, main2.z, 19);
        drop('grandstandS', main2, main2.face, 1, main2D, 0);
        drop('standCrowdS', main2, main2.face, 1, main2D, 0);
      }
      const oppD = start + 24;
      const opp = atRoad(oppD, IN, 12);
      if (opp) {
        claim(opp.x, opp.z, 19);
        drop('grandstandS', opp, opp.face, 1, oppD, 0);
        drop('standCrowdS', opp, opp.face, 1, oppD, 0);
      }
      for (let i = 0; i < 3; i++) {
        const d = start - 106 + i * 30;
        const s = atRoad(d, IN, 12);
        if (s && free(s.x, s.z, 9)) {
          claim(s.x, s.z, 8);
          drop('terrace', s, s.face, 1, d, 0);
          drop('terraceCrowd', s, s.face, 1, d, 0);
        }
      }
      // Standing crowd banked against the fence, both sides of the line.
      for (let i = 0; i < 11; i++) {
        const d = start - 150 + i * 26;
        for (const side of [-1, 1] as const) {
          const s = atRoad(d, side, 8.5);
          if (!s || !free(s.x, s.z, 7)) continue;
          claim(s.x, s.z, 6.5);
          batcher.placeAt(`crowd${i % 3}`, s.x, s.y, s.z, s.face, 0.95, wrap(d));
        }
      }

      // Flags down the straight, and bunting strung between them.
      for (let i = 0; i < 14; i++) {
        const d = start - 160 + i * 22;
        const side = (i % 2 === 0 ? -1 : 1) as -1 | 1;
        const s = at(d, side, 5.0);
        if (!s) continue;
        drop('flagPole', s, 0, 1, d, 1.0);
        batcher.placeAt(['flagA', 'flagB', 'flagC'][i % 3]!,
          s.x, s.y + 7.0, s.z, s.along + Math.PI * 0.5, 1, wrap(d));
      }
      for (let i = 0; i < 9; i++) {
        const d = start - 140 + i * 22;
        const s = at(d, IN, 4.4);
        if (s) batcher.placeAt('bunting', s.x, s.y + 6.2, s.z, s.along, 1, wrap(d));
      }

      // The paddock, on its own pad behind the main stand.
      const padD = start - 78;
      const padS = atRoad(padD, OUT, 44);
      if (padS) {
        claim(padS.x, padS.z, 26);
        drop('pad', padS, padS.along, 1, padD, 0);
        const y = padS.y;
        for (let i = 0; i < 5; i++) {
          const s = at(padD - 12 + i * 6.5, OUT, 44 + (i % 2) * 7 - 3);
          if (!s) continue;
          s.y = y;
          drop(i % 3 === 0 ? 'siteHut' : 'container', s, s.along, 1, padD, 8.5);
        }
        for (let i = 0; i < 3; i++) {
          const s = at(padD + 4 + i * 1.5, OUT, 34 - i * 0.3);
          if (!s) continue;
          s.y = y;
          drop('portaloo', s, s.face, 1, padD, 2.1);
        }
        for (let i = 0; i < 2; i++) {
          const s = at(padD - 6 + i * 12, OUT, 36);
          if (!s) continue;
          s.y = y;
          drop(r.bool() ? 'digger' : 'dumper', s, s.face + r.range(-0.5, 0.5), 1, padD, 5.5);
        }
      }
      for (const d of [start - 118, start + 30]) {
        const s = at(d, OUT, 26);
        if (s) {
          drop('floodlight', s, s.face, 1, d, 3.4);
          batcher.placeAt('beacon', s.x, s.y + 1.3, s.z, 0, 1.5, wrap(d));
        }
      }
      // Marshal posts either side of the line.
      for (const [d, side] of [[start - 22, IN], [start + 32, OUT]] as const) {
        const s = at(d, side as -1 | 1, 3.0);
        if (s) drop('marshalPost', s, s.face, 1, d, 2.6);
      }
      // A cone apron on the pit-side, laid out in a proper taper.
      for (let i = 0; i < 26; i++) {
        const d = start - 30 + i * 3.6;
        const s = at(d, IN, 4.0 + i * 0.34);
        if (s) drop(i % 6 === 0 ? 'coneStack' : 'cone', s, s.along, 1.05, d, 0.95);
      }

      // The landmark: twenty-two metres of traffic cone, placed *down* the
      // straight rather than beside the line. A landmark at the vanishing point
      // is the one a driver actually navigates by — it is the thing the grid is
      // looking at while the lights are still red.
      const heroD = start + 150;
      const heroSide = roomier(heroD, 90);
      const hero = at(heroD, heroSide, 62) ?? farAt(heroD, heroSide, 62);
      if (hero) {
        claim(hero.x, hero.z, 26);
        drop('giantCone', hero, rng.range(0, 6.28), 1, heroD, 0);
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          const s = at(heroD + Math.cos(a) * 19, heroSide, 62 + Math.sin(a) * 19);
          if (s) drop('cone', s, a, 1.6, heroD, 1.4);
        }
      }
    }

    // ── 5. the horizon ─────────────────────────────────────────────────────

    const HERO: Array<{ f: number; off: number; kind: string }> = [
      { f: 0.12, off: 240, kind: 'towerCrane' },
      { f: 0.275, off: 310, kind: 'silo' },
      { f: 0.41, off: 290, kind: 'mast' },
      { f: 0.525, off: 250, kind: 'conveyor' },
      { f: 0.64, off: 270, kind: 'towerCrane' },
      { f: 0.78, off: 330, kind: 'mast' },
      { f: 0.905, off: 290, kind: 'silo' },
    ];
    for (const h of HERO) {
      const d = frac(h.f);
      const side = roomier(d, 150);
      const base = ground.roadY(d);
      // Walk outward until the ground stops climbing. Dropped blind, half of
      // these end up standing on top of a butte, which reads less as industry
      // on the horizon and more as an alien landing site.
      let s: Spot | null = null;
      for (let k = 0; k < 7; k++) {
        const cand = farAt(d, side, h.off - k * 26);
        if (cand && Math.abs(cand.y - base) < 16) { s = cand; break; }
      }
      if (!s || !free(s.x, s.z, 95)) continue;
      claim(s.x, s.z, 90);
      batcher.placeAt(h.kind, s.x, s.y - 0.6, s.z, rng.range(0, 6.28), 1, d);
    }

    // ── 5b. the middle distance ────────────────────────────────────────────
    //
    // Forty to a hundred and fifty metres beyond the barrier. From the road
    // that band is most of a pulled-back frame's width, and it used to be bare
    // tan dirt with a light pole in it: the circuit had a foreground and a
    // horizon and nothing in between, which is exactly the depth cue that makes
    // speed read.
    //
    // The geometry of the place decides what can go there. The embankment drops
    // 5.7m inside thirty metres and the barrier hides everything under about
    // four metres from a chase camera, so at this range only two things are
    // visible from the road: what is *tall* (marquee ridges at six metres,
    // stockpiles at nine, light towers at twenty-one) and what is *pale* (a
    // gravel hardstand against orange dirt reads at three hundred metres). The
    // low, dense stuff — the car parks, the benched ground — is there for the
    // pulled-back, overhead and mid-pack cameras, which look straight down into
    // the band and used to find nothing at all.

    /**
     * An event field: a graded hardstand carrying spectator parking, a pair of
     * hospitality marquees and a light tower, with crowd spilling off its front
     * lip. Placed on the outside of the big corners, which is the one direction
     * the sight line from the road actually crosses this band.
     */
    function eventField(d0: number, side: -1 | 1, off: number, seed: number): void {
      const r = makeRng(0x4f21 + seed * 613);
      const base = at(d0, side, off);
      if (!base || !free(base.x, base.z, 34)) return;
      claim(base.x, base.z, 32);
      // Everything on the field shares the hardstand's height; only x/z come
      // from the track frame, so nothing tilts relative to the platform.
      const y = base.y;
      const on = (dz: number, dOff: number): Spot | null => {
        const s = at(d0 + dz, side, off + dOff);
        if (!s) return null;
        s.y = y;
        return s;
      };
      drop('hardstand', base, base.along, 1, d0, 0);

      const rows = ['vanRow', 'vanRow2', 'vanRow3'];
      for (let i = 0; i < 4; i++) {
        const s = on(-19 + i * 6.4, (i % 2 ? 4 : -4) + r.range(-1.5, 1.5));
        if (s) drop(rows[(seed + i) % 3]!, s, s.along, 1, d0, 0);
      }
      const m1 = on(r.range(9, 13), r.range(0, 4));
      if (m1) drop('marquee', m1, m1.face, 1, d0, 13);
      const m2 = on(r.range(19, 23), r.range(-7, -3));
      if (m2) drop('marquee2', m2, m2.face + r.range(-0.2, 0.2), 1, d0, 13);

      const tower = on(r.range(-4, 4), -20);
      if (tower) drop('floodTower', tower, tower.face, 1, d0, 3.6);
      // Drums and a mast along the front lip, so the platform has an edge.
      for (let i = 0; i < 7; i++) {
        const s = on(-18 + i * 6, -22.5);
        if (!s) continue;
        drop('drum', s, s.along, 1, d0, 1.0);
        batcher.placeAt('beacon', s.x, s.y + 1.02, s.z, 0, 1, wrap(d0));
      }
      const mast = on(r.range(24, 28), r.range(-16, -10));
      if (mast) {
        drop('flagPole', mast, 0, 1, d0, 1.0);
        batcher.placeAt(FLAGS[seed % 3]!,
          mast.x, mast.y + 7.0, mast.z, mast.along + Math.PI * 0.5, 1, wrap(d0));
      }

      // Overflow spectators along the lip facing the circuit.
      const lip = on(r.range(-8, 8), -24);
      if (lip) drop(`crowd${seed % 3}`, lip, lip.face, 1, d0, 0);
    }

    for (let i = 0; i < Math.min(5, corners.length); i++) {
      const c = corners[i]!;
      let placed = false;
      for (let k = 0; k < 4 && !placed; k++) {
        const off = 68 + k * 9;
        const before = claims.length;
        eventField(c.mid + (i % 2 ? 16 : -16), c.outer, off, i);
        placed = claims.length > before;
      }
    }
    // One more across the circuit from the start/finish, so the pit straight
    // has something at depth to sit in front of.
    eventField(frac(0.5), roomier(frac(0.5), 90), 74, 5);

    // Light towers around the rest of the lap. Twenty-one metres, which is the
    // only height that clears the barrier's sight line from this far out — a
    // ring of them is also the cheapest possible statement that this is a venue
    // and not a stretch of desert road.
    for (let i = 0; i < 12; i++) {
      const d = frac(i / 12 + 0.04);
      const side = (i % 2 === 0 ? 1 : -1) as -1 | 1;
      for (let k = 0; k < 5; k++) {
        const s = at(d + (k % 2 ? -14 : 14) * k, side, 46 + k * 11);
        if (!s || !free(s.x, s.z, 13)) continue;
        claim(s.x, s.z, 12);
        drop('floodTower', s, s.face, 1, d, 3.6);
        break;
      }
    }

    /**
     * Find room in the band, then book it.
     *
     * Everything out here is competing with the corners, the works compounds
     * and each other for the same ground, and a placement pinned to one exact
     * lap distance mostly loses that argument and silently never happens — the
     * first cut of this section asked for fifteen stockpiles and got four.
     * Nothing in the middle distance has any business being anywhere in
     * particular, so let it hunt.
     */
    function room(
      d: number, side: -1 | 1, near: number, far: number, r: number,
    ): { s: Spot; d: number; off: number } | null {
      for (let k = 0; k < 8; k++) {
        const dd = d + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 21;
        const off = near + ((far - near) * k) / 7;
        const s = at(dd, side, off);
        if (s && free(s.x, s.z, r)) { claim(s.x, s.z, r * 0.9); return { s, d: dd, off }; }
      }
      return null;
    }

    // Benched ground. The mid-distance dirt reads flat because it is flat;
    // stepping it gives the band a horizontal line to lie against and makes the
    // ground between the circuit and the canyon wall look worked rather than
    // untouched.
    for (let i = 0; i < 26; i++) {
      const side = (rng.bool() ? 1 : -1) as -1 | 1;
      const f = room((i / 26) * L + rng.range(-16, 16), side, 76, 146, 22);
      if (f) {
        drop('berm', f.s, f.s.along + rng.range(-0.35, 0.35),
          rng.range(0.85, 1.35), f.d, 0);
      }
    }

    // Aggregate stockpiles — pale grey, so they separate from the brown spoil
    // that shares the band, and tall enough to break the horizon line.
    for (let i = 0; i < 14; i++) {
      const side = (rng.bool() ? 1 : -1) as -1 | 1;
      const f = room(frac(i / 14 + 0.031), side, 60, 128, 16);
      if (f) drop('stockpile', f.s, rng.range(0, 6.28), rng.range(0.8, 1.5), f.d, 0);
    }

    // Small hardstands with a van row on them, scattered wider — the overflow
    // parking that says the event is bigger than the six fields.
    for (let i = 0; i < 10; i++) {
      const side = (rng.bool() ? 1 : -1) as -1 | 1;
      const f = room(frac(i / 10 + 0.07), side, 50, 108, 15);
      if (!f) continue;
      drop('hardstandS', f.s, f.s.along, 1, f.d, 0);
      const v = at(f.d + rng.range(-3, 3), side, f.off + rng.range(-2, 2));
      if (v) {
        v.y = f.s.y;
        drop(['vanRow', 'vanRow2', 'vanRow3'][i % 3]!, v, v.along, 1, f.d, 0);
      }
    }

    // Mid-distance heaps, so the ground between the circuit and the canyon rim
    // is not a bald plain. Deliberately large: at a hundred metres out a spoil
    // heap has to be the size of a house before it is anything at all.
    for (let i = 0; i < 46; i++) {
      const d = (i / 46) * L + rng.range(-26, 26);
      const side = (rng.bool() ? 1 : -1) as -1 | 1;
      const s = at(d, side, rng.range(60, 145));
      if (!s || !free(s.x, s.z, 20)) continue;
      claim(s.x, s.z, 18);
      drop('spoil', s, rng.range(0, 6.28), rng.range(1.8, 4.2), d, 0);
    }

    // Scrub and boulders, weighted outward so they never crowd the run-off.
    for (let i = 0; i < 340; i++) {
      const d = rng.range(0, L);
      const side = (rng.bool() ? 1 : -1) as -1 | 1;
      const off = 18 + rng.next() * rng.next() * 125;
      const s = at(d, side, off);
      if (!s) continue;
      if (rng.bool(0.6)) drop('scrub', s, rng.range(0, 6.28), rng.range(0.7, 1.6), d, 0);
      else drop('boulder', s, rng.range(0, 6.28), rng.range(0.5, 1.7), d, 0);
    }
    for (let i = 0; i < 150; i++) {
      const d = rng.range(0, L);
      const side = (rng.bool() ? 1 : -1) as -1 | 1;
      const s = farAt(d, side, rng.range(165, 540));
      if (!s) continue;
      drop('boulder', s, rng.range(0, 6.28), rng.range(1.5, 4.8), d, 0);
    }

    // Steam vents, where a pipe would plausibly come out of the bank.
    for (let i = 0; i < 5; i++) {
      const d = frac(0.055 + i * 0.19);
      const side = (i % 2 === 0 ? 1 : -1) as -1 | 1;
      const s = at(d, side, 13 + i * 2.4);
      if (!s) continue;
      drop('ventPipe', s, s.face, 1, d, 2.0);
      batcher.placeAt('steam', s.x, s.y + 1.7, s.z, 0, 1, wrap(d));
    }

    // Ground-level dressing the whole way round, just outside the barrier.
    // From the chase camera this is under the sight line and mostly invisible —
    // but the pulled-back, overhead and mid-pack cameras all look straight down
    // into it, and without it the verge is a bare brown ribbon from every one
    // of them. It is nine hundred cones for four draw calls, so it is cheap
    // enough to be worth having for three cameras out of five.
    for (let d = 0; d < L; d += 24) {
      const side = (rng.bool() ? 1 : -1) as -1 | 1;
      const n = rng.int(4, 8);
      const off0 = rng.range(4.4, 7.0);
      for (let i = 0; i < n; i++) {
        const s = at(d + i * 2.5 + rng.range(-0.4, 0.4), side,
          off0 + i * rng.range(0.3, 0.7));
        if (s) drop('cone', s, s.along + rng.range(-0.4, 0.4), rng.range(0.94, 1.1), d, 0.9);
      }
      const other = -side as -1 | 1;
      const s2 = at(d + 10, other, rng.range(4.0, 6.5));
      if (!s2) continue;
      if (rng.bool(0.4)) {
        drop('drum', s2, s2.face, 1, d, 1.0);
        batcher.placeAt('beacon', s2.x, s2.y + 1.02, s2.z, 0, 1, wrap(d));
      } else if (rng.bool(0.5)) {
        drop('trestle', s2, s2.along + rng.range(-0.2, 0.2), 1, d, 1.4);
      } else {
        drop('tyres', s2, s2.along, rng.range(0.85, 1.1), d, 1.5);
      }
    }

    // Boards last, into whatever is left between the openings.
    hoardingRun();

    batches = batcher.build(group);

    // ── 6. set pieces ──────────────────────────────────────────────────────

    // The wrecking ball, on the outside of the biggest corner and far enough
    // back that the ball can never swing anywhere near the barrier line.
    const craneCorner = corners[0];
    if (craneCorner) {
      const d = craneCorner.mid + 12;
      const s = at(d, craneCorner.outer, 52) ?? at(d, craneCorner.outer, 38);
      if (s) {
        const piece = createWreckingCrane(M);
        piece.root.position.set(s.x, s.y - 0.1, s.z);
        piece.root.rotation.y = s.face + 0.5;
        group.add(piece.root);
        pieces.push(piece);
      }
    }

    // The tipper, side-on to the road on the lip of a compound pad.
    {
      const d = frac(0.395);
      const side = roomier(d, 30);
      const s = atRoad(d, side, 26);
      if (s) {
        const piece = createTipper(M);
        piece.root.position.set(s.x, s.y - 0.06, s.z);
        piece.root.rotation.y = s.face + Math.PI * 0.5;
        group.add(piece.root);
        pieces.push(piece);
      }
    }

    // The works railway, laid along the fastest part of the lap. Which side has
    // room is a question about the shape of the circuit, so ask the ground.
    {
      const f0 = 0.545, f1 = 0.735;
      const probe = (side: -1 | 1): number => {
        let worst = Infinity;
        for (let i = 0; i <= 8; i++) {
          const d = frac(f0 + (f1 - f0) * (i / 8));
          const s = ground.spot(d, side, 40);
          worst = Math.min(worst, s.ok ? ground.clearance(s.x, s.z) : -1);
        }
        return worst;
      };
      const a = probe(1), b = probe(-1);
      const side: -1 | 1 = a >= b ? 1 : -1;
      if (Math.max(a, b) > 30) {
        const piece = createRailway(M, ground, spline, {
          from: frac(f0), to: frac(f0) + (f1 - f0) * L,
          side, off: 40, crossingAt: frac((f0 + f1) * 0.5),
        });
        group.add(piece.root);
        pieces.push(piece);
      }
    }

    // Two footbridges over the road, with people on them. Everything else in
    // this module is beside the circuit, so a straight hands the top third of
    // the frame to empty sky; a bridge puts the crowd overhead instead. Placed
    // where the road is flattest — the deck is square to the track's own frame,
    // and a bridge over a crest reads as leaning.
    {
      const probe = spline.atDistance(0);
      const flatness = (d: number): number => {
        let worst = 0;
        for (let i = -3; i <= 3; i++) {
          spline.atDistance(wrap(d + i * 8), probe);
          worst = Math.max(worst, Math.abs(probe.curvature) * 400 + Math.abs(probe.bank) * 6);
        }
        return worst;
      };
      for (const [i, want] of [0.45, 0.62].entries()) {
        let bestD = frac(want), bestScore = Infinity;
        for (let k = -8; k <= 8; k++) {
          const d = frac(want + k * 0.006);
          const score = flatness(d);
          if (score < bestScore) { bestScore = score; bestD = d; }
        }
        const piece = createBridge(
          M, spline, ground.verge, bestD,
          deckCrowdGeo(701 + i * 29, 26, 2, 0.92), `bridge${i}`);
        group.add(piece.root);
        pieces.push(piece);
      }
    }

    // Hawks over the middle of the map.
    {
      const c = new THREE.Vector3();
      const probe = spline.atDistance(0);
      let n = 0;
      for (let d = 0; d < L; d += 40) {
        spline.atDistance(d, probe);
        c.add(probe.pos); n++;
      }
      c.multiplyScalar(1 / Math.max(1, n));
      c.y += 82;
      const piece = createBirds(M, P.birdGeo(), c, 200, 7);
      group.add(piece.root);
      pieces.push(piece);
    }
  }

  // ── the frame ────────────────────────────────────────────────────────────

  return {
    name: 'world',
    // After the track (20), so `ctx.track` exists; before physics (30), so a
    // rebuild can never land halfway through a simulation step.
    order: 22,

    init(): void {
      mats = createMaterials(clock);
      ctx.scene.add(group);
      offBus = ctx.bus.on('track:built', (e: unknown) => {
        const track = (e as { track?: Track } | undefined)?.track ?? ctx.track;
        // The dressing is a pure function of the course, and the course is a
        // pure function of its id — so restarting the same race rebuilds an
        // identical world. Skipping that keeps a reset at a frame or two rather
        // than a second, which matters: the capture harness resets nine times
        // per review sheet.
        if (track && track.id !== builtFor) build(track);
      });
      if (ctx.track && builtFor !== ctx.track.id) build(ctx.track);
    },

    /**
     * Visuals only.
     *
     * Three things happen, and none of them touch the simulation: the shared
     * clock every vertex program reads is advanced, the set pieces get their
     * transforms, and each batch is switched against its own draw distance
     * scaled by the quality tier.
     */
    update(dt: number): void {
      time += dt;
      clock.value = time;

      if (mats) {
        // Hazard beacons. A roadworks light is a hard on/off with a long dark
        // beat, not a sine — a smooth pulse reads as a glowing lump.
        const f = (time * 1.45) % 1;
        mats.glow.emissiveIntensity = f < 0.4 ? 1.6 : 0.1;
      }

      for (let i = 0; i < pieces.length; i++) pieces[i]!.update(time);

      _camPos.copy(ctx.camera.position);
      const dd = ctx.quality.drawDistance;
      for (let i = 0; i < batches.length; i++) {
        const b = batches[i]!;
        const limit = b.far * dd + b.radius;
        b.mesh.visible = _camPos.distanceToSquared(b.center) < limit * limit;
      }
    },

    dispose(): void {
      offBus?.();
      offBus = null;
      teardown();
      ctx.scene.remove(group);
      mats?.dispose();
      mats = null;
    },
  };
}

// ── corner finding ─────────────────────────────────────────────────────────

/**
 * Read the corners off the curvature profile.
 *
 * The course does not publish where its corners are and should not have to:
 * anything sharp enough for a driver to notice is sharp enough to find, and
 * deriving it means the dressing follows a re-cut layout without being
 * re-authored.
 */
function findCorners(spline: TrackSplineLike, L: number): Corner[] {
  const STEP = 5;
  /** ~180m radius — about where a bend starts being a corner. */
  const THRESHOLD = 0.0055;
  const found: Corner[] = [];
  const s = spline.atDistance(0);
  let cur: Corner | null = null;

  for (let d = 0; d < L; d += STEP) {
    spline.atDistance(d, s);
    const k = s.curvature;
    if (Math.abs(k) < THRESHOLD) { cur = null; continue; }
    const inner = (k > 0 ? -1 : 1) as -1 | 1;
    if (cur && cur.inner === inner && d - cur.to <= 30) {
      cur.to = d;
      if (Math.abs(k) > Math.abs(cur.peak)) cur.peak = k;
    } else {
      cur = { from: d, to: d, mid: d, peak: k, inner, outer: -inner as -1 | 1, weight: 0 };
      found.push(cur);
    }
  }

  const keep: Corner[] = [];
  for (const c of found) {
    if (c.to - c.from < 18) continue;
    c.mid = (c.from + c.to) * 0.5;
    c.weight = (c.to - c.from) * Math.abs(c.peak);
    keep.push(c);
  }
  return keep;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
