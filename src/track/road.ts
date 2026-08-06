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
  makeAsphaltTexture, makeBoostTexture, makeCheckerTexture, makeGravelTexture,
  makeKerbTexture, makePaintTexture, makeTrackedGravelTexture,
} from './textures.ts';
import { features, type CourseDefEx } from './courses/types.ts';
import type { CourseDef, SplineSample } from '../types.ts';
import type { TrackSpline } from './spline.ts';

/** A boost strip resolved to absolute distances and lateral metres. */
export interface PadRuntime {
  d0: number;
  d1: number;
  lat0: number;
  lat1: number;
}

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

  return { pads, corners, padTexture };
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
