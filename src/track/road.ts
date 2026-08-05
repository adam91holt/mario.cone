// The driving surface: tarmac, markings, kerbs, gravel shoulders, boost strips
// and the start/finish grid.
//
// Markings are geometry rather than a baked texture. A painted line drawn into
// the road texture has to stretch when the road narrows, which makes the edge of
// the circuit wobble at exactly the moment the player is using it to judge a
// corner. Laid as ribbons at fixed metre offsets from the edge, they stay the
// same width all lap and stay crisp under anisotropic filtering.
//
// Kerbs are placed by *measuring* the spline: any stretch curving harder than a
// threshold gets a rumble strip on the inside, tapered in and out. That means a
// re-cut layout kerbs itself correctly with no hand-authoring.

import * as THREE from 'three';
import { MeshBuilder, surfacePoint, type Lane } from './geom.ts';
import {
  makeAsphaltTexture, makeBoostTexture, makeCheckerTexture, makeGravelTexture,
  makeKerbTexture, makePaintTexture, makeTrackedGravelTexture,
} from './textures.ts';
import { features, type CourseDefEx } from './courses/types.ts';
import type { CourseDef } from '../types.ts';
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

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

const KERB_WIDTH = 2.1;
const KERB_LIFT = 0.075;
const LINE_INNER = 1.15;
const LINE_OUTER = 0.72;
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
 * Gaps between the kerbed stretches on one side — where the edge line runs.
 * Coverage is rasterised rather than sorted, so a kerb that wraps the start
 * line needs no special case.
 */
function complementSpans(spans: CornerSpan[], side: -1 | 1, L: number): Array<[number, number]> {
  const CELL = 2;
  const n = Math.ceil(L / CELL);
  const covered = new Uint8Array(n);
  for (const sp of spans) {
    if (sp.side !== side) continue;
    for (let d = sp.from - 2; d <= sp.to + 2; d += CELL) {
      covered[Math.floor(wrap(d, L) / CELL) % n] = 1;
    }
  }
  const gaps: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const free = i < n && !covered[i];
    if (free && start < 0) start = i;
    if (!free && start >= 0) {
      if ((i - start) * CELL > 16) gaps.push([start * CELL, i * CELL]);
      start = -1;
    }
  }
  return gaps;
}

export function buildRoad(
  spline: TrackSpline, course: CourseDef, parent: THREE.Group,
): RoadBuild {
  const verge = course.vergeWidth ?? 5;
  const feat = features(course);
  const L = spline.length;
  const theme = (course as CourseDefEx).theme?.road ?? {};

  // ── tarmac ──────────────────────────────────────────────────────────────
  const road = new MeshBuilder();
  const COLS = 10;
  const roadLanes: Lane[] = [];
  for (let j = 0; j <= COLS; j++) {
    const f = j / COLS - 0.5;
    roadLanes.push({
      lat: (s) => f * s.width,
      // Tiling in metres, so the grain never stretches with the road width.
      u: (s) => (f * s.width) / 12,
    });
  }
  road.addRibbon(spline, roadLanes, { verge, step: 2.4, vScale: 12, closed: true });

  // Lambert everywhere on the ground plane. Asphalt at roughness 0.9 has no
  // specular lobe worth the cost, and this surface covers half the screen every
  // frame — on the software renderer the review harness uses, a PBR shader here
  // is the difference between a frame and a slideshow.
  const roadMesh = new THREE.Mesh(road.toGeometry(), new THREE.MeshLambertMaterial({
    map: makeAsphaltTexture({ base: theme.base }),
  }));
  roadMesh.name = 'road';
  roadMesh.receiveShadow = true;
  parent.add(roadMesh);

  // ── gravel shoulders ────────────────────────────────────────────────────
  const apron = new MeshBuilder();
  for (const side of [-1, 1] as const) {
    const lanes: Lane[] = [0, 0.25, 0.55, 1].map((t) => ({
      lat: (s) => side * (s.width * 0.5 + verge * t),
      u: (s) => (side * (s.width * 0.5 + verge * t)) / 9,
    }));
    if (side < 0) lanes.reverse();
    apron.addRibbon(spline, lanes, { verge, step: 3, vScale: 9, closed: true });
  }
  // Lambert: gravel has no specular story to tell, and the shoulders cover a
  // lot of screen at grazing angles where a PBR shader is pure cost.
  const apronMesh = new THREE.Mesh(apron.toGeometry(), new THREE.MeshLambertMaterial({
    map: makeGravelTexture(),
  }));
  apronMesh.name = 'verge';
  apronMesh.receiveShadow = true;
  parent.add(apronMesh);

  // ── kerbs ───────────────────────────────────────────────────────────────
  const corners = findCorners(spline, feat.kerbCurvature ?? 0.0045);
  const kerb = new MeshBuilder();
  for (const span of corners) {
    const len = span.to - span.from;
    const taper = Math.min(12, len * 0.28);
    // Width tapers to nothing at both ends so the kerb grows out of the road
    // rather than starting with a step the karts can trip over.
    const w = (f: number): number => {
      const a = Math.min(1, (f * len) / taper);
      const b = Math.min(1, ((1 - f) * len) / taper);
      return KERB_WIDTH * Math.min(a, b);
    };
    const side = span.side;
    const outer: Lane = {
      lat: (s) => side * s.width * 0.5,
      lift: (_s, f) => KERB_LIFT * Math.min(1, w(f) / KERB_WIDTH),
      u: 0,
    };
    const inner: Lane = {
      lat: (s, f) => side * (s.width * 0.5 - w(f)),
      lift: (_s, f) => 0.012 * Math.min(1, w(f) / KERB_WIDTH),
      u: 1,
    };
    kerb.addRibbon(spline, side < 0 ? [outer, inner] : [inner, outer], {
      verge, from: span.from, to: span.to, step: 2, vScale: 5.5,
    });
  }
  if (!kerb.isEmpty) {
    const kerbMesh = new THREE.Mesh(kerb.toGeometry(), new THREE.MeshLambertMaterial({
      map: makeKerbTexture(),
    }));
    kerbMesh.name = 'kerbs';
    kerbMesh.receiveShadow = true;
    parent.add(kerbMesh);
  }

  // ── painted markings ────────────────────────────────────────────────────
  const paint = new MeshBuilder();

  for (const side of [-1, 1] as const) {
    for (const [from, to] of complementSpans(corners, side, L)) {
      const lanes: Lane[] = [
        { lat: (s) => side * (s.width * 0.5 - LINE_INNER), lift: () => PAINT_LIFT, u: 0 },
        { lat: (s) => side * (s.width * 0.5 - LINE_OUTER), lift: () => PAINT_LIFT, u: 1 },
      ];
      if (side < 0) lanes.reverse();
      paint.addRibbon(spline, lanes, { verge, from, to, step: 3, vScale: 4 });
    }
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
      { lat: () => -0.22, lift: () => PAINT_LIFT, u: 0 },
      { lat: () => 0.22, lift: () => PAINT_LIFT, u: 1 },
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
  const line = new MeshBuilder();
  line.addRibbon(spline, [
    { lat: (s) => -s.width * 0.5, lift: () => PAINT_LIFT, u: 0 },
    { lat: (s) => s.width * 0.5, lift: () => PAINT_LIFT, u: (s) => s.width / 3 },
  ], { verge, from: start - 1.6, to: start + 1.6, step: 1.6, vScale: 3 });

  const lineMesh = new THREE.Mesh(line.toGeometry(), new THREE.MeshLambertMaterial({
    map: makeCheckerTexture(2, '#22242B', '#FFF8F0'),
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  }));
  lineMesh.name = 'startLine';
  lineMesh.receiveShadow = true;
  parent.add(lineMesh);

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
    padBuilder.addRibbon(spline, [
      { lat: () => centre - w, lift: () => 0.03, u: 0 },
      { lat: () => centre + w, lift: () => 0.03, u: 1 },
    ], { verge, from: d - half, to: d + half, step: 2, vScale: 7 });
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
    const lanes: Lane[] = [
      { lat: (s) => side * (s.width * 0.5 + verge * 0.12), lift: () => 0.02, u: 0 },
      { lat: (s) => side * (s.width * 0.5 + verge * 0.95), lift: () => 0.02, u: 1 },
    ];
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

/** Four painted bars making one grid box, centred on a grid slot. */
function gridBox(
  b: MeshBuilder, spline: TrackSpline, verge: number,
  d: number, lat: number, length: number, width: number,
): void {
  const bar = 0.28;
  const hl = length * 0.5, hw = width * 0.5;

  const quad = (aL: number, aD: number, bL: number, bD: number): void => {
    const s0 = spline.atDistance(d + aD);
    const s1 = spline.atDistance(d + bD);
    surfacePoint(s0, lat + aL, verge, PAINT_LIFT, _v0);
    surfacePoint(s0, lat + bL, verge, PAINT_LIFT, _v1);
    surfacePoint(s1, lat + aL, verge, PAINT_LIFT, _v2);
    surfacePoint(s1, lat + bL, verge, PAINT_LIFT, _v3);
    b.addQuad(_v0, _v1, _v2, _v3);
  };
  // Two side bars and a heavier bar across the front of the box.
  quad(-hw, -hl, -hw + bar, hl);
  quad(hw - bar, -hl, hw, hl);
  quad(-hw, hl - bar * 1.6, hw, hl);
  quad(-hw, -hl, -hw + bar * 3.4, -hl + bar);
  quad(hw - bar * 3.4, -hl, hw, -hl + bar);
}
