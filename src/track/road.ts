// The driving surface: tarmac, markings, kerbs, gravel shoulders, boost strips
// and the start/finish grid.
//
// Three ideas run through all of it.
//
// *Markings are geometry, not texture.* A painted line drawn into the road
// texture has to stretch when the road narrows, which makes the edge of the
// circuit wobble at exactly the moment the player is using it to judge a
// corner. Laid as ribbons at fixed metre offsets from the edge, they stay the
// same width all lap and stay crisp under anisotropic filtering.
//
// *Nothing spans the crown as a single quad.* `geom.ts` crowns the road 16cm at
// the centreline; a flat chord stretched from edge to edge sits below that
// crown and is swallowed by the tarmac. Every transverse marking — the
// chequered line, the grid boxes, the boost strips — is built through a
// subdivided patch or a multi-lane ribbon so it follows the camber.
//
// *The tarmac is a material, not a colour.* Between the markings the road
// carries a polished racing line through every apex, dusty off-line edges and
// large-scale tonal breaks, all baked into vertex colours. Texture detail
// mipmaps away by twenty metres; vertex colour does not, and twenty metres is
// where a driver at 60 m/s is actually looking.
//
// Kerbs are placed by *measuring* the spline: any stretch curving harder than a
// threshold gets a rumble strip on the inside, tapered in and out. That means a
// re-cut layout kerbs itself correctly with no hand-authoring.

import * as THREE from 'three';
import { MeshBuilder, fbm, smoothstep, surfaceHeight, type Lane } from './geom.ts';
import { buildRacingLine, type RacingLine } from './racingline.ts';
import {
  makeAsphaltTexture, makeBoostTexture, makeCheckerTexture, makeConcreteTexture,
  makeGravelTexture, makeKerbTexture, makePaintTexture, makeTrackedGravelTexture,
} from './textures.ts';
import { features, type CourseDefEx, type GateDef, type RampDef } from './courses/types.ts';
import { rampLength } from './courses/ramp.ts';
import type { CourseDef, SplineSample, Surface } from '../types.ts';
import type { TrackSpline } from './spline.ts';

/** A boost strip resolved to absolute distances and lateral metres. */
export interface PadRuntime {
  d0: number;
  d1: number;
  lat0: number;
  lat1: number;
}

/**
 * A surface patch resolved to absolute distances and a lateral band.
 *
 * The band is carried as *fractions of the half width* rather than metres,
 * because a spill runs down the side of a road whose width changes underneath
 * it — Switchback's washout crosses two metres of narrowing and Jackhammer's
 * sump apron three.
 */
export interface PatchRuntime {
  d0: number;
  d1: number;
  surface: Surface;
  /** Centre of the band, as a fraction of the half width. */
  c: number;
  /** Half the band, same units. */
  hw: number;
  /** Metres over which the band fades in at each end. */
  taper: number;
  /** Decorrelates the edge noise between patches on the same course. */
  seed: number;
  /**
   * Skip the ragged edge.
   *
   * A scree spill has an edge that noise is *right* for — material that fanned
   * out of a shoulder has no straight sides. A sheet of standing brine has a
   * waterline and a built central island has a kerb, and both of those are
   * ruled. Because `patchScale` is what `sample()` walks as well as what the
   * paint is swept from, this flag reaches the grip and the picture together:
   * the island a kart is kept off and the island a player can see are the same
   * rectangle either way.
   */
  hard?: boolean;
}

/**
 * How much of a patch's lateral band is present `rel` metres into it: 0 for
 * none, 1 for the whole declared band.
 *
 * **This is called by the paint below and by `sample()` in `track/index.ts`,
 * and that is the whole point of it existing.** A spill that a player can see
 * and a spill a kart can feel have to be the same shape, and the way to
 * guarantee that is not to write the shape down twice. The ends fade in over a
 * third of the patch so it fans out of the shoulder instead of starting at a
 * ruled transverse line, and the noise term only ever eats *into* the declared
 * band — a patch never grows past what the course asked for.
 */
export function patchScale(p: PatchRuntime, rel: number): number {
  const len = p.d1 - p.d0;
  if (rel < 0 || rel > len) return 0;
  const ends = smoothstep(0, p.taper, rel) * smoothstep(0, p.taper, len - rel);
  if (p.hard) return ends;
  const k = ends * (0.88 + fbm(rel / 19 + p.seed, p.seed) * 0.12);
  return k < 0 ? 0 : k > 1 ? 1 : k;
}

/** Fallback material colour per surface, when a course does not name one. */
const PATCH_TINT: Partial<Record<Surface, string>> = {
  dirt: '#8A6A46',
  sand: '#CDBB98',
  grass: '#5F7A3C',
  water: '#4A6E82',
};

export interface CornerSpan {
  from: number;
  to: number;
  /** -1 kerbs the left edge, +1 the right. */
  side: -1 | 1;
  /** Peak curvature magnitude, used to size the kerb. */
  strength: number;
}

export interface RoadBuild {
  pads: PadRuntime[];
  patches: PatchRuntime[];
  corners: CornerSpan[];
  /** Scrolled every frame so the chevrons crawl toward the driver. */
  padTexture: THREE.Texture | null;
}

/** Kerb block: 2.4m across, 13cm proud of the road, with a real outer face. */
const KERB_WIDTH = 2.4;
const KERB_TOP = 0.13;
/** Metres over which the kerb grows out of the road at each end. */
const KERB_TAPER = 13;
/** Texture u where the kerb's top face ends and its outer face begins. */
const KERB_FACE_U = 0.63;

/** Edge line: 0.55m of paint, held 0.3m clear of the kerb or the road edge. */
const LINE_W = 0.55;
const LINE_GAP = 0.30;
const PAINT_LIFT = 0.022;

const wrap = (d: number, L: number): number => ((d % L) + L) % L;

/**
 * Find the corners worth kerbing.
 *
 * Curvature is sampled every few metres, thresholded, then the runs are grown
 * and merged so a corner with a slight straightening in the middle still gets
 * one continuous kerb instead of two stubs.
 */
export function findCorners(spline: TrackSpline, threshold: number): CornerSpan[] {
  const L = spline.length;
  const STEP = 4;
  const n = Math.floor(L / STEP);
  const s = spline.atDistance(0);
  const spans: CornerSpan[] = [];
  let cur: CornerSpan | null = null;

  for (let i = 0; i <= n; i++) {
    const d = i * STEP;
    spline.atDistance(d, s);
    const c = s.curvature;
    const inside: -1 | 1 = c > 0 ? -1 : 1; // a left-hander is kerbed on the left
    if (Math.abs(c) >= threshold) {
      if (cur && cur.side === inside && d - cur.to <= 26) {
        cur.to = d;
        cur.strength = Math.max(cur.strength, Math.abs(c));
      } else {
        if (cur) spans.push(cur);
        cur = { from: d, to: d, side: inside, strength: Math.abs(c) };
      }
    }
  }
  if (cur) spans.push(cur);

  // Join a run that wraps the start line, then drop the stubs.
  if (spans.length > 1) {
    const first = spans[0]!, last = spans[spans.length - 1]!;
    if (first.from < STEP * 1.5 && last.to > L - STEP * 2 && first.side === last.side) {
      last.to = first.to + L;
      last.strength = Math.max(last.strength, first.strength);
      spans.shift();
    }
  }
  return spans.filter((sp) => sp.to - sp.from > 22).map((sp) => ({
    ...sp,
    from: sp.from - 6,
    to: sp.to + 6,
  }));
}

/**
 * Width of the kerb on one side at a distance, tapers included.
 *
 * One function answers this for the kerb mesh, the edge line that runs beside
 * it and the contact shadow baked into the shoulder, so the three can never
 * disagree about where the kerb is by even a centimetre.
 */
function kerbWidthAt(spans: CornerSpan[], side: -1 | 1, d: number, L: number): number {
  let best = 0;
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i]!;
    if (sp.side !== side) continue;
    const len = sp.to - sp.from;
    const rel = wrap(d - sp.from, L);
    if (rel > len) continue;
    const taper = Math.min(KERB_TAPER, len * 0.3);
    const w = KERB_WIDTH * Math.min(1, Math.min(rel / taper, (len - rel) / taper));
    if (w > best) best = w;
  }
  return best;
}

export function buildRoad(
  spline: TrackSpline, course: CourseDef, parent: THREE.Group,
): RoadBuild {
  const verge = course.vergeWidth ?? 5;
  const feat = features(course);
  const L = spline.length;
  const theme = (course as CourseDefEx).theme?.road ?? {};
  const corners = findCorners(spline, feat.kerbCurvature ?? 0.0042);
  const racing = buildRacingLine(spline);
  const kerbAt = (side: -1 | 1, d: number): number => kerbWidthAt(corners, side, d, L);

  // ── tarmac ──────────────────────────────────────────────────────────────
  // 24 lanes across rather than the 10 the geometry alone needs. The extra
  // columns are there to carry vertex colour: at ~1.1m lateral spacing the
  // racing line lands as a soft band roughly a car wide, which is what it looks
  // like on a real circuit and what it has to look like from 40m back.
  const road = new MeshBuilder();
  const COLS = 24;
  const roadLanes: Lane[] = [];
  for (let j = 0; j <= COLS; j++) {
    const f = j / COLS - 0.5;
    roadLanes.push({
      lat: (s) => f * s.width,
      // Tiling in metres, so the grain never stretches with the road width.
      u: (s) => (f * s.width) / 12,
    });
  }
  road.addRibbon(spline, roadLanes, {
    verge, step: 2.6, vScale: 12, closed: true, tint: makeTarmacTint(racing),
  });

  // Lambert everywhere on the ground plane. Asphalt at roughness 0.9 has no
  // specular lobe worth the cost, and this surface covers half the screen every
  // frame — on the software renderer the review harness uses, a PBR shader here
  // is the difference between a frame and a slideshow.
  const roadMesh = new THREE.Mesh(road.toGeometry(), new THREE.MeshLambertMaterial({
    map: makeAsphaltTexture({ base: theme.base }),
    vertexColors: true,
  }));
  roadMesh.name = 'road';
  roadMesh.receiveShadow = true;
  parent.add(roadMesh);

  // ── gravel shoulders ────────────────────────────────────────────────────
  const apron = new MeshBuilder();
  for (const side of [-1, 1] as const) {
    const lanes: Lane[] = [0, 0.06, 0.25, 0.55, 1].map((t) => ({
      lat: (s) => side * (s.width * 0.5 + verge * t),
      u: (s) => (side * (s.width * 0.5 + verge * t)) / 9,
    }));
    if (side < 0) lanes.reverse();
    apron.addRibbon(spline, lanes, {
      verge, step: 3, vScale: 9, closed: true,
      // The band the kerb overhangs is baked dark. A raised block with nothing
      // underneath it reads as a sticker; the shadow is what makes it a kerb.
      tint: (s, lat, _f, out) => {
        const k = kerbAt(Math.sign(lat) as -1 | 1, s.distance);
        const off = Math.abs(lat) - s.width * 0.5;
        const v = 1 - (k / KERB_WIDTH) * 0.42 * (1 - smoothstep(0.1, 1.5, off));
        out.setRGB(v, v * 0.995, v * 0.985);
      },
    });
  }
  // Lambert: gravel has no specular story to tell, and the shoulders cover a
  // lot of screen at grazing angles where a PBR shader is pure cost.
  const apronMesh = new THREE.Mesh(apron.toGeometry(), new THREE.MeshLambertMaterial({
    map: makeGravelTexture(),
    vertexColors: true,
  }));
  apronMesh.name = 'verge';
  apronMesh.receiveShadow = true;
  parent.add(apronMesh);

  // ── kerbs ───────────────────────────────────────────────────────────────
  // Built as a block, not a decal: a chamfered inner lip the karts ride up, a
  // flat top held level with the road edge, and a vertical outer face that
  // catches the light differently from either. The top is the only part the
  // player drives on; the face is what tells them it is there.
  const kerb = new MeshBuilder();
  for (const span of corners) {
    const side = span.side;
    const w = (s: SplineSample): number => kerbAt(side, s.distance);
    const inner = (s: SplineSample): number => side * (s.width * 0.5 - w(s));
    // Height of the road right where the kerb meets it — the top face is held
    // flat relative to *that*, so the block never leans with the camber.
    const datum = (s: SplineSample): number =>
      surfaceHeight(inner(s), s.width, verge) + KERB_TOP;
    const flat = (lat: number, s: SplineSample): number =>
      datum(s) - surfaceHeight(lat, s.width, verge);

    const top: Lane[] = [
      { lat: inner, lift: (s) => 0.012 * (w(s) / KERB_WIDTH), u: 0.02 },
      {
        lat: (s) => side * (s.width * 0.5 - w(s) * 0.6),
        lift: (s) => flat(side * (s.width * 0.5 - w(s) * 0.6), s) * (w(s) / KERB_WIDTH),
        u: 0.18,
      },
      {
        lat: (s) => side * (s.width * 0.5 + 0.10),
        lift: (s) => flat(side * (s.width * 0.5 + 0.10), s) * (w(s) / KERB_WIDTH),
        u: KERB_FACE_U - 0.03,
      },
    ];
    const face: Lane[] = [
      {
        lat: (s) => side * (s.width * 0.5 + 0.10),
        lift: (s) => flat(side * (s.width * 0.5 + 0.10), s) * (w(s) / KERB_WIDTH),
        u: KERB_FACE_U + 0.03,
      },
      { lat: (s) => side * (s.width * 0.5 + 0.34), lift: () => -0.06, u: 0.99 },
    ];
    if (side < 0) { top.reverse(); face.reverse(); }
    kerb.addRibbon(spline, top, { verge, from: span.from, to: span.to, step: 1.6, vScale: 5.5 });
    kerb.addRibbon(spline, face, { verge, from: span.from, to: span.to, step: 1.6, vScale: 5.5 });
  }
  if (!kerb.isEmpty) {
    const kerbMesh = new THREE.Mesh(kerb.toGeometry(), new THREE.MeshLambertMaterial({
      map: makeKerbTexture(),
    }));
    kerbMesh.name = 'kerbs';
    kerbMesh.receiveShadow = true;
    kerbMesh.castShadow = true;
    parent.add(kerbMesh);
  }

  // ── painted markings ────────────────────────────────────────────────────
  const paint = new MeshBuilder();

  // Edge lines run the *whole* lap and step inboard around each kerb rather
  // than stopping for it. An edge line that vanishes through every corner is
  // one that vanishes exactly where the driver needs to know where the road
  // ends.
  for (const side of [-1, 1] as const) {
    const inset = (s: SplineSample): number => s.width * 0.5 - kerbAt(side, s.distance) - LINE_GAP;
    const lanes: Lane[] = [
      { lat: (s) => side * (inset(s) - LINE_W), lift: () => PAINT_LIFT, u: 0 },
      { lat: (s) => side * inset(s), lift: () => PAINT_LIFT, u: 1 },
    ];
    if (side < 0) lanes.reverse();
    paint.addRibbon(spline, lanes, { verge, step: 2, vScale: 4, closed: true });
  }

  // Centre dashes. 4m on, 10m off: at 60 m/s that is a beat every quarter
  // second — fast enough to read as speed, slow enough not to strobe.
  const DASH = 4, GAP = 10;
  const period = DASH + GAP;
  const dashes = Math.max(1, Math.round(L / period));
  const pitch = L / dashes;
  for (let i = 0; i < dashes; i++) {
    const d0 = i * pitch;
    paint.addRibbon(spline, [
      { lat: () => -0.28, lift: () => PAINT_LIFT, u: 0 },
      { lat: () => 0.28, lift: () => PAINT_LIFT, u: 1 },
    ], { verge, from: d0, to: d0 + DASH, step: DASH, vScale: 4 });
  }

  // Grid boxes, drawn as outlines exactly where main.ts puts the karts.
  const start = course.startDistance ?? 0;
  const total = 8;
  for (let i = 0; i < total; i++) {
    const col = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const d = start - (12 + row * 8);
    const lat = col * ((course.width ?? 26) * 0.19);
    gridBox(paint, spline, verge, d, lat, 4.6, 2.9);
  }

  const paintMesh = new THREE.Mesh(paint.toGeometry(), new THREE.MeshLambertMaterial({
    map: makePaintTexture(),
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  }));
  paintMesh.name = 'markings';
  paintMesh.receiveShadow = true;
  parent.add(paintMesh);

  // ── start/finish line ───────────────────────────────────────────────────
  // Eleven lanes across, not two. The old two-lane chord sat 14cm under the
  // crown at the centreline and only the outer metre of each side emerged, so
  // the line the player is racing toward three times a race was two tapering
  // wedges with a hairline between them.
  const line = new MeshBuilder();
  const CHECK = 3.4;          // metres per texture period = two 1.7m squares
  const lineLanes: Lane[] = [];
  for (let j = 0; j <= 10; j++) {
    const f = j / 10 - 0.5;
    lineLanes.push({
      lat: (s) => f * s.width,
      lift: () => PAINT_LIFT,
      u: (s) => (f * s.width) / CHECK,
    });
  }
  line.addRibbon(spline, lineLanes, {
    verge, from: start - 1.7, to: start + 1.7, step: 0.85, vScale: CHECK,
  });

  const lineMesh = new THREE.Mesh(line.toGeometry(), new THREE.MeshLambertMaterial({
    map: makeCheckerTexture(2, '#22242B', '#FFF8F0'),
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  }));
  lineMesh.name = 'startLine';
  lineMesh.receiveShadow = true;
  parent.add(lineMesh);

  // A solid stripe on the approach side of the chequer, so the line still reads
  // as a *line* when the chequer squares are only a pixel or two tall.
  const trim = new MeshBuilder();
  for (const off of [-2.6, 2.2]) {
    trim.addRibbon(spline, lineLanes.map((l) => ({ ...l, u: 0 })), {
      verge, from: start + off, to: start + off + 0.4, step: 0.4, vScale: 4,
    });
  }
  // Two heavy bars either side of the grid, where the karts line up.
  const trimMesh = new THREE.Mesh(trim.toGeometry(), new THREE.MeshLambertMaterial({
    map: makePaintTexture(),
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  }));
  trimMesh.name = 'startTrim';
  parent.add(trimMesh);

  // ── boost strips ────────────────────────────────────────────────────────
  const pads: PadRuntime[] = [];
  const padBuilder = new MeshBuilder();
  for (const def of feat.pads ?? []) {
    const d = wrap(start + def.at * L, L);
    const half = (def.length ?? 16) * 0.5;
    const s = spline.atDistance(d);
    const centre = (def.lateral ?? 0) * s.width * 0.5;
    const w = (def.width ?? 6) * 0.5;
    pads.push({ d0: d - half, d1: d + half, lat0: centre - w, lat1: centre + w });
    const lanes: Lane[] = [];
    for (let j = 0; j <= 6; j++) {
      const f = j / 6;
      lanes.push({ lat: () => centre - w + 2 * w * f, lift: () => 0.03, u: f });
    }
    padBuilder.addRibbon(spline, lanes, { verge, from: d - half, to: d + half, step: 1.2, vScale: 15 });
  }

  let padTexture: THREE.Texture | null = null;
  if (!padBuilder.isEmpty) {
    padTexture = makeBoostTexture().clone();
    padTexture.needsUpdate = true;
    const padMesh = new THREE.Mesh(padBuilder.toGeometry(), new THREE.MeshLambertMaterial({
      map: padTexture,
      emissive: 0xffffff,
      emissiveMap: padTexture,
      emissiveIntensity: 0.85,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }));
    padMesh.name = 'boostPads';
    parent.add(padMesh);
  }

  // ── shortcut: the worn line across the gravel ───────────────────────────
  const cut = new MeshBuilder();
  for (const sc of feat.shortcuts ?? []) {
    const from = wrap(start + sc.from * L, L);
    const to = from + (sc.to - sc.from) * L;
    const side = sc.side;
    const lanes: Lane[] = [];
    for (let j = 0; j <= 4; j++) {
      const t = 0.12 + (0.95 - 0.12) * (j / 4);
      lanes.push({
        lat: (s) => side * (s.width * 0.5 + verge * t),
        lift: () => 0.02,
        u: j / 4,
      });
    }
    if (side < 0) lanes.reverse();
    cut.addRibbon(spline, lanes, { verge, from, to, step: 2.5, vScale: 9 });
  }
  if (!cut.isEmpty) {
    const cutMesh = new THREE.Mesh(cut.toGeometry(), new THREE.MeshLambertMaterial({
      map: makeTrackedGravelTexture(),
      transparent: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }));
    cutMesh.name = 'shortcut';
    cutMesh.receiveShadow = true;
    parent.add(cutMesh);
  }

  // ── surface patches: the spill, the windrow, the washout ────────────────
  // Material lying *on* the racing surface, which is a different idea from the
  // gravel cut above: the cut is a route off the tarmac that saves distance,
  // and a patch is tarmac that has stopped behaving like tarmac. It is laid at
  // the shortcut's polygon offset but a few millimetres higher, so it covers
  // the centre dashes and the edge line — a spill does not politely stop at
  // the paint.
  //
  // The band comes from `patchScale`, which `sample()` also calls. Nothing here
  // decides a shape of its own.
  const patches: PatchRuntime[] = [];
  const spills = new Map<string, MeshBuilder>();
  const brine = new Map<string, MeshBuilder>();
  const island = new MeshBuilder();
  const islandKerb = new MeshBuilder();
  const patchDefs = feat.patches ?? [];
  for (let i = 0; i < patchDefs.length; i++) {
    const def = patchDefs[i]!;
    const style = def.style ?? 'spill';
    const d0 = wrap(start + def.from * L, L);
    const span = Math.max(8, (def.to - def.from) * L);
    const lo = Math.min(def.latFrom, def.latTo);
    const hi = Math.max(def.latFrom, def.latTo);
    const hard = style !== 'spill';
    const p: PatchRuntime = {
      d0,
      d1: d0 + span,
      surface: def.surface,
      c: (lo + hi) * 0.5,
      hw: (hi - lo) * 0.5,
      // A spill fans out of the shoulder over a third of its length. Water has
      // a waterline and an island has a nose, so both get a metre and a half —
      // enough that the mesh does not end on a knife edge, short enough that
      // the leading edge is a thing you arrive at rather than sink into.
      taper: hard ? 1.6 : Math.min(24, span * 0.34),
      seed: i * 7.31 + 1.7,
      ...(hard ? { hard: true } : {}),
    };
    patches.push(p);

    const tint = def.tint ?? PATCH_TINT[def.surface] ?? '#8A6A46';
    const band = (t: number) => (s: SplineSample): number => {
      const k = patchScale(p, wrap(s.distance - p.d0, L));
      return (p.c + p.hw * k * t) * s.width * 0.5;
    };

    if (style === 'island') {
      // ── a built central reservation ────────────────────────────────────
      // Not material lying on the road: a thing installed on it, so it has a
      // flat top, two hazard-striped flanks and a hard edge all round. This is
      // what turns one carriageway into two, and a player has to be able to
      // read at two hundred metres that the gap in front of them is a *choice*
      // rather than a spill they can drive through.
      // Built exactly the way a kerb is built in this file, and that is the
      // point rather than an economy. An island has to say *keep off* from two
      // hundred metres, and it may not say *wall*: physics knows this band as a
      // surface, not as an obstacle, so a kart that gets it wrong drives over
      // it and loses a third of its speed. A concrete slab reads as a wall and
      // lies; a red-and-white kerb block 14cm proud is the one shape this game
      // has already taught the player to stay off and to survive.
      //
      // It was a plain pale slab for one build and photographed as a smear of
      // light tarmac you would not brake for.
      const TOP = 0.14;
      const top: Lane[] = [];
      for (let j = 0; j <= 4; j++) {
        const t = j / 2 - 1;
        const lat = band(t * 0.82);
        top.push({ lat, lift: () => TOP, u: 0.03 + (j / 4) * 0.54 });
      }
      island.addRibbon(spline, top, { verge, from: d0, to: d0 + span, step: 1.8, vScale: 3.4 });
      for (const side of [-1, 1] as const) {
        const outer = band(side);
        const inner = band(side * 0.82);
        const flank: Lane[] = [
          { lat: outer, lift: () => -0.02, u: 0.99 },
          { lat: inner, lift: () => TOP, u: KERB_FACE_U + 0.03 },
        ];
        if (side < 0) flank.reverse();
        island.addRibbon(spline, flank, { verge, from: d0, to: d0 + span, step: 1.8, vScale: 3.4 });
      }
      // A chevron nose on each end, so the leading edge is a thing you are
      // aimed at rather than a line you arrive on top of.
      for (const [at, dir] of [[d0, 1], [d0 + span, -1]] as const) {
        const nose: Lane[] = [
          { lat: band(-0.55), lift: () => 0.03, u: 0.06 },
          { lat: band(0), lift: () => 0.03, u: 0.5 },
          { lat: band(0.55), lift: () => 0.03, u: 0.94 },
        ];
        islandKerb.addRibbon(spline, nose, {
          verge, from: Math.min(at, at + dir * 9), to: Math.max(at, at + dir * 9),
          step: 1.2, vScale: 2.2,
        });
      }
    } else if (style === 'brine') {
      // ── standing water ─────────────────────────────────────────────────
      // Lifted almost to the crown and drawn transparent, so it reads as a
      // sheet lying *on* the road with the markings still visible under it —
      // which is exactly how you judge how deep a flooded road is.
      let builder = brine.get(tint);
      if (!builder) { builder = new MeshBuilder(); brine.set(tint, builder); }
      const lanes: Lane[] = [];
      for (let j = 0; j <= 8; j++) {
        const t = j / 4 - 1;
        const lat = band(t);
        lanes.push({ lat, lift: () => 0.052, u: (s) => lat(s) / 11 });
      }
      builder.addRibbon(spline, lanes, {
        verge, from: d0, to: d0 + span, step: 2, vScale: 11,
        // Deep in the middle, shallow and bright where it thins to nothing at
        // the edges — the one cue that says which part of it you can survive.
        tint: (s, latM, _f, out) => {
          const half = s.width * 0.5;
          const k = patchScale(p, wrap(s.distance - p.d0, L)) || 1e-3;
          const off = Math.abs(latM / half - p.c) / (p.hw * k);
          const shallow = smoothstep(0.55, 1, off);
          const v = 0.80 + shallow * 0.42;
          out.setRGB(v * 0.94, v, v * 1.03);
        },
      });
    } else {
      let builder = spills.get(tint);
      if (!builder) { builder = new MeshBuilder(); spills.set(tint, builder); }

      // Eight lanes across the band. The lateral of each is a function of
      // distance, because the band narrows toward both ends.
      const lanes: Lane[] = [];
      for (let j = 0; j <= 8; j++) {
        const t = j / 4 - 1; // -1..+1 across the band
        const lat = band(t);
        lanes.push({ lat, lift: () => 0.028, u: (s) => lat(s) / 6 });
      }
      builder.addRibbon(spline, lanes, {
        verge, from: d0, to: d0 + span, step: 1.6, vScale: 6,
        // Loose material is not one tone: the middle is churned and dark, the
        // thin edges are dusted over the tarmac and read pale.
        tint: (s, latM, _f, out) => {
          const half = s.width * 0.5;
          const k = patchScale(p, wrap(s.distance - p.d0, L)) || 1e-3;
          const off = Math.abs(latM / half - p.c) / (p.hw * k);
          const depth = 1 - smoothstep(0.45, 1, off);
          const n = fbm(s.distance / 7 + p.seed, latM / 7) * 0.14;
          const v = 1 + 0.16 * (1 - depth) + n - depth * 0.10;
          out.setRGB(v, v * 0.985, v * 0.955);
        },
      });
    }
  }
  for (const [tint, builder] of spills) {
    if (builder.isEmpty) continue;
    const mesh = new THREE.Mesh(builder.toGeometry(), new THREE.MeshLambertMaterial({
      map: makeGravelTexture(tint),
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }));
    mesh.name = 'spill';
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
  for (const [tint, builder] of brine) {
    if (builder.isEmpty) continue;
    // The only specular surface on the ground plane in the whole game, and the
    // reason it is worth a Phong shader here when nothing else on the road gets
    // one: water without a highlight is a blue rectangle. It is two hundred
    // metres of one course, so the shader cost is paid once and seen once.
    const mesh = new THREE.Mesh(builder.toGeometry(), new THREE.MeshPhongMaterial({
      color: new THREE.Color(tint),
      specular: 0xfff8f0,
      shininess: 96,
      vertexColors: true,
      transparent: true,
      opacity: 0.66,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
    }));
    mesh.name = 'brine';
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
  if (!island.isEmpty) {
    const mesh = new THREE.Mesh(island.toGeometry(), new THREE.MeshLambertMaterial({
      map: makeKerbTexture(),
    }));
    mesh.name = 'island';
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    parent.add(mesh);
  }
  if (!islandKerb.isEmpty) {
    const noseMesh = new THREE.Mesh(islandKerb.toGeometry(), new THREE.MeshLambertMaterial({
      map: makeKerbTexture({ a: '#22242B', b: '#FFC300' }),
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
    }));
    noseMesh.name = 'islandNose';
    noseMesh.receiveShadow = true;
    parent.add(noseMesh);
  }

  buildRamps(spline, feat.ramps, start, L, verge, parent);
  buildGates(spline, feat.gates, start, L, verge, parent);

  return { pads, patches, corners, padTexture };
}

/**
 * The launch ramp's deck.
 *
 * **The ramp itself is not here and cannot be here.** `physics/kart.ts` rebuilds
 * the ground from the spline — position, `up`, width and the 16cm crown — and
 * reads no geometry at all, so a wedge of mesh laid on the tarmac would be a
 * picture of a ramp that every kart in the field drives straight through. The
 * shape lives in the centreline, put there by `applyRamps` in
 * `courses/ramp.ts` from the same `RampDef` array this reads.
 *
 * So what gets built here is what a ramp is *made of*: a concrete deck up the
 * run-up, hazard bars across it counting down to a fat one on the lip, and a
 * raised rail down each side. All of it is swept through `surfacePoint`, which
 * follows the spline — so it climbs the ramp on its own, and there is no second
 * copy of the profile to fall out of agreement with the one the kart actually
 * takes off from.
 */
function buildRamps(
  spline: TrackSpline, ramps: RampDef[] | undefined,
  start: number, L: number, verge: number, parent: THREE.Group,
): void {
  if (!ramps || ramps.length === 0) return;

  const deck = new MeshBuilder();
  const bars = new MeshBuilder();
  const rails = new MeshBuilder();

  for (const r of ramps) {
    const lip = wrap(start + r.at * L, L);
    const len = rampLength(r);
    const from = lip - len;
    const s0 = spline.atDistance(lip);
    const centre = (r.lateral ?? 0) * s0.width * 0.5;
    const half = (r.width ?? 14) * 0.5;
    const across = (lift: number, uScale = 1): Lane[] => {
      const out: Lane[] = [];
      for (let j = 0; j <= 8; j++) {
        const f = j / 8;
        out.push({ lat: () => centre - half + 2 * half * f, lift: () => lift, u: f * uScale });
      }
      return out;
    };

    // The deck: a concrete apron, not a paint job. It was hazard stripes across
    // its whole width for one build and photographed as a single enormous
    // black-and-gold wedge filling half the frame — a ramp has to be *read* in
    // the second before it arrives, and a surface with no quiet parts has no
    // loud ones either.
    deck.addRibbon(spline, across(0.022, 2.2), { verge, from, to: lip, step: 1.3, vScale: 7 });

    // Hazard bars across it every 4.4m, so they strobe under the kart on the
    // way up. That beat is the only cue a driver gets for how fast the lip is
    // coming; the deck itself is the same colour all the way along it.
    for (let d = lip - 2.6; d > from + 1; d -= 4.4) {
      bars.addRibbon(spline, across(0.028), { verge, from: d - 1.1, to: d, step: 0.55, vScale: 1.6 });
    }
    // ...and one at the lip itself, twice as wide. One bar is a marking; a run
    // of them counting down to a fat one is a take-off board.
    bars.addRibbon(spline, across(0.03), { verge, from: lip - 2.2, to: lip, step: 0.55, vScale: 3.2 });

    // A rail down each edge, standing 18cm proud. A ramp with a flat painted
    // edge reads as a decal; a ramp with a lip you can see the side of reads as
    // a thing that was bolted to the road.
    for (const side of [-1, 1] as const) {
      const outer = centre + side * half;
      const inner = centre + side * (half - 0.5);
      const rail: Lane[] = [
        { lat: () => inner, lift: () => 0.18, u: 0.06 },
        { lat: () => outer, lift: () => 0.18, u: 0.55 },
        { lat: () => outer + side * 0.10, lift: () => -0.02, u: 0.99 },
      ];
      if (side < 0) rail.reverse();
      rails.addRibbon(spline, rail, { verge, from, to: lip, step: 1.3, vScale: 2.6 });
    }
  }

  if (!deck.isEmpty) {
    const mesh = new THREE.Mesh(deck.toGeometry(), new THREE.MeshLambertMaterial({
      map: makeConcreteTexture(),
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }));
    mesh.name = 'rampDeck';
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
  if (!bars.isEmpty) {
    const mesh = new THREE.Mesh(bars.toGeometry(), new THREE.MeshLambertMaterial({
      map: makeKerbTexture({ a: '#1C1F27', b: '#FFC300' }),
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    }));
    mesh.name = 'rampBars';
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
  if (!rails.isEmpty) {
    const mesh = new THREE.Mesh(rails.toGeometry(), new THREE.MeshLambertMaterial({
      map: makeKerbTexture({ a: '#FF6B1A', b: '#FFF8F0' }),
    }));
    mesh.name = 'rampRails';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
  }
}

/**
 * The pinch gate: two blocks standing where the road stops being wide enough.
 *
 * The pinch itself is *width*, authored in the course's waypoints, which is why
 * it is real — the barrier line, the line physics enforces and the ribbon the
 * road mesh is swept along all come off `s.width` and all narrow together. What
 * a width pinch has no way of saying is that it is deliberate: a road that
 * quietly necks from twenty-one metres to eleven over a corner entry reads, at
 * speed, as a mistake in the level.
 *
 * These are the two noses that say it out loud. They stand on the shoulder
 * rather than on the tarmac — the shoulder is already 70% of top speed, so
 * nothing here takes anything away from a kart that was not already in trouble
 * — and they are the only free-standing furniture on the driving surface in the
 * cup.
 */
function buildGates(
  spline: TrackSpline, gates: GateDef[] | undefined,
  start: number, L: number, verge: number, parent: THREE.Group,
): void {
  if (!gates || gates.length === 0) return;

  const block = new MeshBuilder();
  for (const g of gates) {
    const d = wrap(start + g.at * L, L);
    const len = g.length ?? 26;
    const h = g.height ?? 1.15;
    const from = d - len * 0.5;
    const to = d + len * 0.5;
    // Battered like a temporary works block: wide at the foot, narrow on top,
    // and tapered to nothing at both ends so it is a nose rather than a wall.
    const nose = (f: number): number => Math.min(1, Math.min(f, 1 - f) * 4.5);
    for (const side of [-1, 1] as const) {
      const foot = (s: SplineSample): number => side * (s.width * 0.5 + 0.25);
      const back = (s: SplineSample): number => side * (s.width * 0.5 + 2.3);
      const lanes: Lane[] = [
        { lat: foot, lift: () => -0.05, u: 0 },
        { lat: (s) => side * (s.width * 0.5 + 0.55), lift: (_s, f) => h * nose(f), u: 0.30 },
        { lat: (s) => side * (s.width * 0.5 + 2.0), lift: (_s, f) => h * nose(f), u: 0.62 },
        { lat: back, lift: () => -0.15, u: 0.99 },
      ];
      if (side < 0) lanes.reverse();
      block.addRibbon(spline, lanes, { verge, from, to, step: 1.3, vScale: 3 });
    }
  }
  if (block.isEmpty) return;
  const mesh = new THREE.Mesh(block.toGeometry(), new THREE.MeshLambertMaterial({
    map: makeKerbTexture({ a: '#22242B', b: '#FFC300' }),
  }));
  mesh.name = 'gate';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
}

/**
 * The tarmac's vertex tint.
 *
 * Four signals, all large enough to survive minification, all multiplying the
 * asphalt map:
 *   * the polished racing line — a soft band with a darker, cooler core;
 *   * off-line dust, lifting and warming the last few metres before the kerb;
 *   * tonal breaks in world space, so one stretch of asphalt reads older than
 *     the next instead of the whole lap being one shade of grey;
 *   * a slight lightening of the crown, which is what makes the camber legible.
 */
function makeTarmacTint(racing: RacingLine) {
  return (s: SplineSample, lat: number, _f: number, out: THREE.Color): void => {
    const half = s.width * 0.5;
    const line = racing.lateralAt(s.distance);
    const load = 0.32 + 0.68 * racing.loadAt(s.distance);
    const dl = Math.abs(lat - line);

    const band = 1 - smoothstep(1.5, 5.4, dl);
    const core = 1 - smoothstep(0.3, 1.9, dl);
    const rubber = (0.105 * band + 0.085 * core) * load;

    const edge = smoothstep(half - 4.6, half - 0.5, Math.abs(lat));
    const crown = 1 - Math.abs(lat) / Math.max(1, half);

    const px = s.pos.x + s.right.x * lat;
    const pz = s.pos.z + s.right.z * lat;
    const patch = fbm(px / 47, pz / 47) * 0.085 + fbm(px / 13 + 40, pz / 13 - 17) * 0.03;

    const v = 1 - rubber + edge * 0.10 + crown * 0.035 + patch;
    // Rubber is cool and dark, dust is warm and pale.
    out.setRGB(
      v * (1 + edge * 0.055 - rubber * 0.12),
      v * (1 + edge * 0.020 - rubber * 0.05),
      v * (1 - edge * 0.045 + rubber * 0.10),
    );
  };
}

/** Four painted bars making one grid box, centred on a grid slot. */
function gridBox(
  b: MeshBuilder, spline: TrackSpline, verge: number,
  d: number, lat: number, length: number, width: number,
): void {
  const bar = 0.28;
  const hl = length * 0.5, hw = width * 0.5;
  const patch = (aL: number, aD: number, bL: number, bD: number): void =>
    b.addPatch(spline, verge, d + aD, d + bD, lat + aL, lat + bL, PAINT_LIFT);

  // Two side bars and a heavier bar across the front of the box. The transverse
  // ones are subdivided across their span — a 2.9m quad drawn as one chord sits
  // under the crown and disappears on the middle of the road.
  patch(-hw, -hl, -hw + bar, hl);
  patch(hw - bar, -hl, hw, hl);
  patch(-hw, hl - bar * 1.6, hw, hl);
  patch(-hw, -hl, -hw + bar * 3.4, -hl + bar);
  patch(hw - bar * 3.4, -hl, hw, -hl + bar);
}
