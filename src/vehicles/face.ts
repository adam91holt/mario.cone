// Faces.
//
// The single biggest difference between a model of a truck and a *character*
// who is a truck is about two hundred triangles of eye. This file is that.
//
// Three rules it follows:
//
//   1. The eyes are the performance. Pupils lead a turn, lids squint under
//      power, both go wide when something hits you. Everything else is
//      support.
//   2. Nothing is ever perfectly still. Blinks run on their own clock, offset
//      per racer so a grid of eight never blinks in unison.
//   3. It costs six draw calls, not thirty. Both eye whites are one merged
//      mesh, both pupils another, and the expression comes from moving and
//      scaling those groups rather than from more geometry.
//
// Everything here is driven from `update()` on the render thread. No sim state
// is written, and no wall clock is read — only the frame dt handed in.

import * as THREE from 'three';
import { clamp, clamp01, damp, hash1, lerp } from '../core/math.ts';
import { mat, mergeStatic, part, roundedBox } from './parts.ts';

export interface FaceOptions {
  /** Radius of one eyeball. Everything else is proportional to it. */
  radius?: number;
  /** Distance from centre to each eye. */
  spacing?: number;
  /** How far the eyes bulge out of the body they sit on. */
  bulge?: number;
  brows?: boolean;
  browColor?: number;
  /** `grin` is a mouth line; `grille` is a radiator that acts as one. */
  mouth?: 'grin' | 'grille' | 'none';
  mouthWidth?: number;
  mouthY?: number;
  /** How far forward the mouth sits. Bodies curve away under the eyes. */
  mouthZ?: number;
  /** Blink phase offset, so a grid does not blink in sync. */
  seed?: number;
  /** Squash the eyeballs against a curved surface. */
  flatten?: number;
  /**
   * Colour of a bezel ring set around each eye. Without one, an eyeball on a
   * vehicle reads as a ping-pong ball glued to a bonnet; with one it reads as
   * a headlamp that happens to be looking at you. Omit for eyes that sit
   * behind glass or on a soft body.
   */
  socket?: number;
}

/** Every number 0..1 unless noted. The rig blends between them. */
export interface FaceState {
  /** -1..1. Which way the pupils are looking. */
  look: number;
  /** -1..1. Up is positive. */
  lookUp: number;
  /** Lids down: effort, speed, determination. */
  squint: number;
  /** Eyes out on stalks: hits, big air, surprise. */
  wide: number;
  /** Brows in and down. */
  angry: number;
  /** -1..1 mouth curve, +1 a grin. */
  smile: number;
  /** Mouth open — yelling, straining, whooping. */
  open: number;
  /** Eyes spin: spun out. */
  dizzy: number;
}

export interface FaceRig {
  group: THREE.Group;
  update(dt: number, s: Partial<FaceState>): void;
}

const WHITE = 0xfffdf7;
const PUPIL = 0x14161c;

export function makeFace(o: FaceOptions = {}): FaceRig {
  const r = o.radius ?? 0.15;
  const spacing = o.spacing ?? r * 2.1;
  const bulge = o.bulge ?? r * 0.55;
  const flatten = o.flatten ?? 0.7;
  const seed = o.seed ?? 0;

  const group = new THREE.Group();
  group.name = 'face';

  // ── eyeballs ──
  const eyes = new THREE.Group();
  const whiteMat = mat(WHITE, { roughness: 0.26, emissiveIntensity: 0.2 });
  const whiteGeo = new THREE.SphereGeometry(r, 14, 10);
  for (const side of [-1, 1]) {
    const e = new THREE.Mesh(whiteGeo, whiteMat);
    e.position.set(side * spacing, 0, bulge);
    e.scale.z = flatten;
    eyes.add(e);
  }
  mergeStatic(eyes);
  group.add(eyes);

  // ── bezels ──
  if (o.socket !== undefined) {
    const rim = new THREE.Group();
    const rimMat = mat(o.socket, { roughness: 0.4 });
    const rimGeo = new THREE.TorusGeometry(r * 1.02, r * 0.26, 6, 16);
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(rimGeo, rimMat);
      m.position.set(side * spacing, 0, bulge + r * 0.16);
      m.scale.z = 0.8;
      rim.add(m);
    }
    mergeStatic(rim);
    group.add(rim);
  }

  // ── pupils, with their catchlight ──
  const pupils = new THREE.Group();
  const pupilMat = mat(PUPIL, { roughness: 0.18 });
  const pupilGeo = new THREE.SphereGeometry(r * 0.54, 10, 8);
  for (const side of [-1, 1]) {
    const p = new THREE.Mesh(pupilGeo, pupilMat);
    p.position.set(side * spacing, 0, bulge + r * 0.5);
    p.scale.z = 0.62;
    pupils.add(p);
  }
  mergeStatic(pupils);
  group.add(pupils);

  const glints = new THREE.Group();
  const glintMat = mat(0xffffff, { roughness: 0.04, emissiveIntensity: 1.1 });
  const glintGeo = new THREE.SphereGeometry(r * 0.19, 6, 5);
  for (const side of [-1, 1]) {
    const g = new THREE.Mesh(glintGeo, glintMat);
    g.position.set(side * spacing + r * 0.2, r * 0.28, bulge + r * 0.72);
    glints.add(g);
  }
  mergeStatic(glints);
  group.add(glints);

  // ── brows ──
  const browMat = mat(o.browColor ?? 0x24262e, { roughness: 0.5 });
  const browGeo = roundedBox(r * 1.5, r * 0.42, r * 0.44, r * 0.18);
  const brows: THREE.Mesh[] = [];
  if (o.brows !== false) {
    for (const side of [-1, 1]) {
      const b = new THREE.Mesh(browGeo, browMat);
      b.position.set(side * spacing, r * 1.15, bulge + r * 0.3);
      b.rotation.z = side * 0.12;
      group.add(b);
      brows.push(b);
    }
  }

  // ── mouth ──
  const mouthY = o.mouthY ?? -r * 2.0;
  const mouthW = o.mouthWidth ?? spacing * 2.1;
  const mouthZ = o.mouthZ ?? bulge * 0.8;
  const mouthMat = mat(0x1b1d24, { roughness: 0.42 });
  let smileArc: THREE.Mesh | null = null;
  let openMouth: THREE.Mesh | null = null;

  if ((o.mouth ?? 'grin') === 'grin') {
    smileArc = new THREE.Mesh(
      new THREE.TorusGeometry(mouthW * 0.4, r * 0.23, 8, 20, Math.PI),
      mouthMat);
    smileArc.position.set(0, mouthY + mouthW * 0.36, mouthZ);
    smileArc.rotation.z = Math.PI;
    group.add(smileArc);

    // The open mouth has to stand further out than the smile line: it is a
    // solid, and a body that curves away under the eyes will swallow it.
    openMouth = new THREE.Mesh(new THREE.SphereGeometry(mouthW * 0.26, 12, 10), mouthMat);
    openMouth.position.set(0, mouthY - r * 0.3, mouthZ + r * 0.55);
    openMouth.scale.set(1, 0.7, 0.4);
    openMouth.visible = false;
    group.add(openMouth);
  } else if (o.mouth === 'grille') {
    const grille = new THREE.Group();
    const frame = mat(0x2b2e36, { roughness: 0.45 });
    part(grille, roundedBox(mouthW, r * 1.5, r * 0.5, r * 0.2), frame, [0, mouthY, mouthZ]);
    const bars = Math.max(3, Math.round(mouthW / (r * 0.7)));
    for (let i = 0; i < bars; i++) {
      const x = (i / (bars - 1) - 0.5) * mouthW * 0.86;
      part(grille, roundedBox(r * 0.24, r * 1.1, r * 0.3, r * 0.08),
        mat(0xd8dee8, { roughness: 0.25, metalness: 0.6 }), [x, mouthY, mouthZ + r * 0.1]);
    }
    mergeStatic(grille);
    smileArc = grille.children[0] as THREE.Mesh;
    group.add(grille);
  }

  // ── state ──
  let t = hash1(seed + 3.1) * 4;
  let blinkAt = 1.4 + hash1(seed) * 2.6;
  let blink = 0;
  let sLook = 0, sUp = 0, sSquint = 0, sWide = 0, sAngry = 0, sSmile = 1, sOpen = 0;
  let spin = 0;

  // A face is inset detail: it has no business in the shadow pass, which costs
  // a second draw call for every mesh in it.
  group.traverse((o) => { o.userData.noShadow = true; });
  // Past about fifty metres an eye is four pixels wide. The vehicle system
  // switches the whole face off out there; see index.ts.
  group.userData.detail = true;

  return {
    group,
    update(dt: number, s: Partial<FaceState>): void {
      dt = Math.min(dt, 0.1);
      t += dt;

      // Blink on its own clock. Two quick ones now and then reads alive; one
      // slow one reads sleepy, which no racer should.
      if (t > blinkAt) {
        blink = 1;
        blinkAt = t + 1.9 + hash1(seed + t) * 3.4;
      }
      blink = Math.max(0, blink - dt * 9);
      const blinkAmount = Math.sin(clamp01(blink) * Math.PI) ** 0.6;

      const dizzy = clamp01(s.dizzy ?? 0);
      sLook = damp(sLook, clamp(s.look ?? 0, -1, 1), 0.0006, dt);
      sUp = damp(sUp, clamp(s.lookUp ?? 0, -1, 1), 0.0009, dt);
      sSquint = damp(sSquint, clamp01(s.squint ?? 0), 0.0008, dt);
      sWide = damp(sWide, clamp01(s.wide ?? 0), 0.00005, dt);
      sAngry = damp(sAngry, clamp01(s.angry ?? 0), 0.0008, dt);
      sSmile = damp(sSmile, clamp(s.smile ?? 1, -1, 1), 0.002, dt);
      sOpen = damp(sOpen, clamp01(s.open ?? 0), 0.0004, dt);

      // Lids. Blink wins over everything, then squint, then surprise.
      const openness = clamp01((1 - sSquint * 0.72 + sWide * 0.5) * (1 - blinkAmount * 0.95));
      eyes.scale.set(1 + sWide * 0.22, openness * (1 + sWide * 0.3), 1);
      pupils.scale.set(1 + sWide * 0.14, clamp01(openness * 1.05) * (1 + sWide * 0.2), 1);
      glints.scale.setScalar(openness > 0.25 ? 1 : 0.001);

      // Gaze. Pupils lead the turn — the character looks where it is going.
      spin += dt * dizzy * 9;
      const gx = dizzy > 0.01 ? Math.sin(spin) : sLook;
      const gy = dizzy > 0.01 ? Math.cos(spin) : sUp;
      pupils.position.set(gx * r * 0.42, gy * r * 0.34, 0);
      glints.position.set(gx * r * 0.42, gy * r * 0.34, 0);

      // Brows: down and in for effort, up and out for surprise.
      for (let i = 0; i < brows.length; i++) {
        const b = brows[i]!;
        const side = i === 0 ? -1 : 1;
        b.position.y = r * (1.15 - sAngry * 0.42 + sWide * 0.34 - blinkAmount * 0.1);
        // Inner end down is angry, inner end up is startled. The sign matters:
        // get it backwards and a straining racer looks like it is about to cry.
        b.rotation.z = side * (0.12 + sAngry * 0.5 - sWide * 0.34) + sLook * 0.05;
        b.scale.setScalar(1 + sAngry * 0.12);
      }

      // Mouth: a curve that flips to a frown, or an O when yelling.
      if (smileArc && openMouth) {
        const yelling = sOpen > 0.35;
        smileArc.visible = !yelling;
        openMouth.visible = yelling;
        const curve = sSmile;
        smileArc.rotation.z = lerp(Math.PI * 0.85, Math.PI, clamp01(curve));
        smileArc.scale.set(1, curve < 0 ? -1 : 1, 1);
        smileArc.position.y = mouthY + mouthW * 0.36 * (curve < 0 ? -1 : 1);
        const s2 = 0.6 + sOpen * 0.9;
        openMouth.scale.set(0.8 + sOpen * 0.4, s2 * 0.8, 0.4);
      } else if (smileArc) {
        // Grille mouth: it can only really grimace, so it does that.
        smileArc.scale.y = 1 + sOpen * 0.35 - sAngry * 0.12;
      }
    },
  };
}
