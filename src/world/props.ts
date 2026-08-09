// The kit of parts that lives beside the road.
//
// Every function here returns *one* geometry with vertex colour baked in, ready
// to be an InstancedMesh. They are authored to three rules:
//
//   Silhouette first. Everything is read at 60 m/s in peripheral vision, so
//   shapes are chunky and outlines are distinct: a portaloo is a tall thin
//   slab, a skip is a wedge, a floodlight is a mast with a crossbar. Detail
//   that does not change the outline is detail nobody sees.
//
//   Long props are authored along +Z. `Spot.along` lines a prop up with the
//   direction of travel and `Spot.face` turns it to look at the racing line;
//   both assume the prop's forward axis is +Z, so a run of barriers and a
//   warning sign use the same two numbers.
//
//   Nothing is symmetric about the palette. Roadworks are orange, white and
//   yellow against grey steel and brown dirt, and the small number of blues
//   (portaloos, tarps, site huts) exist purely so the orange has something to
//   be orange *against*.

import * as THREE from 'three';
import { Kit, buildProp } from './kit.ts';
import { BOARD, C, PARKED } from './look.ts';
import { LAND_PALETTES, type LandPalette } from './themes.ts';
import { makeRng } from '../core/math.ts';

// ── the small stuff you pass at arm's length ───────────────────────────────

/** One traffic cone. The game's mascot, standing in the run-off in its hundreds. */
export function coneGeo(): THREE.BufferGeometry {
  // Ninety triangles. There are the better part of a thousand of these on the
  // course, so every segment here is paid for eight hundred times over.
  return buildProp('cone', (k) => {
    k.box(0, 0.05, 0, 0.46, 0.1, 0.46, C.ink, { ao: 0.3 });
    k.cone(0, 0.1, 0, 0.175, 0.8, 8, C.orange, { aoHeight: 0.5 });
    k.cyl(0, 0.38, 0, 0.118, 0.135, 0.14, 8, C.white, { ao: 0.12 });
    k.cyl(0, 0.58, 0, 0.068, 0.085, 0.10, 8, C.white, { ao: 0.08 });
  }, 0.5);
}

/** Five cones nested and leaning — how they actually arrive on site. */
export function coneStackGeo(): THREE.BufferGeometry {
  return buildProp('coneStack', (k) => {
    k.box(0, 0.03, 0, 0.5, 0.06, 0.5, C.ink, { ao: 0.35 });
    for (let i = 0; i < 5; i++) {
      k.push();
      k.move(0, i * 0.155, 0).rotY(i * 0.7).rotZ((i - 2) * 0.022);
      k.cone(0, 0.06, 0, 0.175 - i * 0.004, 0.8, 8, C.orange, { aoHeight: 1.4 });
      k.cyl(0, 0.34, 0, 0.12, 0.138, 0.13, 8, C.white, { ao: 0.1 });
      k.pop();
    }
  }, 0.5);
}

/** A hazard drum: the fat plastic kind with a reflective band. */
export function drumGeo(): THREE.BufferGeometry {
  return buildProp('drum', (k) => {
    k.box(0, 0.04, 0, 0.62, 0.08, 0.62, C.ink, { ao: 0.3 });
    k.cyl(0, 0.5, 0, 0.26, 0.31, 0.88, 10, C.orange);
    k.cyl(0, 0.44, 0, 0.29, 0.31, 0.2, 10, C.white, { ao: 0.2 });
    k.cyl(0, 0.72, 0, 0.28, 0.28, 0.12, 10, C.white, { ao: 0.1 });
    k.cyl(0, 0.95, 0, 0.2, 0.25, 0.08, 10, C.ink, { ao: 0.05 });
  }, 0.45);
}

/** Four metres of plastic water barrier — one orange unit, one white, so a run
 *  of them alternates without needing two kinds. */
export function barrierRunGeo(): THREE.BufferGeometry {
  const unit = (k: Kit, z: number, color: number): void => {
    k.box(0, 0.19, z, 0.66, 0.38, 1.92, color, { ao: 0.5 });
    k.box(0, 0.58, z, 0.44, 0.44, 1.92, color, { ao: 0.35 });
    k.box(0, 0.83, z, 0.54, 0.1, 1.98, color, { shade: 0.86, ao: 0.25 });
    k.cyl(0, 0.5, z - 0.99, 0.14, 0.14, 0.96, 6, color, { shade: 0.92 });
    k.cyl(0, 0.5, z + 0.99, 0.14, 0.14, 0.96, 6, color, { shade: 0.92 });
  };
  return buildProp('barrierRun', (k) => {
    unit(k, -1.0, C.orange);
    unit(k, 1.0, C.white);
  }, 0.5);
}

/** The A-frame "road closed" trestle, hazard-striped along its board. */
export function trestleGeo(): THREE.BufferGeometry {
  return buildProp('trestle', (k) => {
    for (const s of [-1, 1]) {
      k.strut(0, 0.02, s * 0.42, -0.34, 1.02, s * 0.02, 0.045, C.galv);
      k.strut(0, 0.02, s * 0.42, 0.34, 1.02, s * 0.02, 0.045, C.galv);
      k.strut(-0.2, 0.5, s * 0.24, 0.2, 0.5, s * 0.24, 0.03, C.galv);
    }
    // Six diagonal stripes read as hazard tape from further away than a texture.
    for (let i = 0; i < 6; i++) {
      k.box(0, 0.88, -1.05 + i * 0.42 + 0.21, 0.07, 0.32, 0.42,
        i % 2 === 0 ? C.orange : C.white, { ao: 0.18 });
    }
    k.box(0, 1.06, 0, 0.1, 0.06, 2.6, C.galv, { ao: 0.1 });
  }, 0.42);
}

/** A stack of tyres in the run-off: the most legible "this is a race track"
 *  object there is, and it costs eight cylinders. */
export function tyreStackGeo(): THREE.BufferGeometry {
  return buildProp('tyreStack', (k) => {
    for (let i = 0; i < 4; i++) {
      k.cyl(0, 0.16 + i * 0.3, 0, 0.52, 0.52, 0.3, 9, i === 3 ? C.white : C.ink,
        { ao: 0.35, aoHeight: 1.3 });
    }
    k.cyl(0, 1.32, 0, 0.5, 0.5, 0.08, 9, C.orange, { ao: 0.1 });
  }, 0.5);
}

/** A diamond warning sign on two legs. */
export function signGeo(): THREE.BufferGeometry {
  return buildProp('sign', (k) => {
    k.strut(-0.42, 0, 0, -0.3, 1.5, 0, 0.05, C.steelDark);
    k.strut(0.42, 0, 0, 0.3, 1.5, 0, 0.05, C.steelDark);
    k.strut(-0.36, 0.62, 0, 0.36, 0.62, 0, 0.035, C.steelDark);
    k.push();
    k.move(0, 1.7, 0).rotZ(Math.PI * 0.25);
    k.box(0, 0, 0, 1.16, 1.16, 0.07, C.yellow, { ao: 0.16, aoHeight: 2.4 });
    k.box(0, 0, 0.045, 1.3, 1.3, 0.02, C.ink, { ao: 0.16, aoHeight: 2.4 });
    k.box(0, 0, 0.055, 1.14, 1.14, 0.02, C.yellow, { ao: 0.16, aoHeight: 2.4 });
    k.pop();
    // A bold exclamation reads at two hundred metres; a pictogram does not.
    k.box(0, 1.82, 0.075, 0.13, 0.5, 0.02, C.ink, { ao: 0.14, aoHeight: 2.4 });
    k.box(0, 1.48, 0.075, 0.14, 0.14, 0.02, C.ink, { ao: 0.14, aoHeight: 2.4 });
  }, 0.34);
}

/** A directional arrow board on a trailer — the thing that tells you which way
 *  the lane goes, borrowed here as pure decoration. */
export function arrowBoardGeo(): THREE.BufferGeometry {
  return buildProp('arrowBoard', (k) => {
    k.box(0, 0.42, 0, 1.0, 0.28, 2.6, C.yellow, { ao: 0.45 });
    k.cyl(-0.56, 0.34, -0.7, 0.34, 0.34, 0.22, 10, C.ink, { ao: 0.4 });
    k.cyl(0.56, 0.34, -0.7, 0.34, 0.34, 0.22, 10, C.ink, { ao: 0.4 });
    k.post(0, 0.5, 0.4, 0.16, 1.5, 0.16, C.steelDark, { ao: 0.3, aoHeight: 2 });
    k.push();
    k.move(0, 1.85, 0.44).rotY(Math.PI * 0.5);
    k.box(0, 0, 0, 2.7, 1.35, 0.1, C.ink, { ao: 0.1, aoHeight: 3 });
    for (let i = 0; i < 3; i++) {
      const x = -0.75 + i * 0.75;
      k.push();
      k.move(x, 0, 0.07).rotZ(Math.PI * 0.25);
      k.box(0, 0, 0, 0.5, 0.16, 0.03, C.yellow, { ao: 0, noAo: true });
      k.pop();
      k.push();
      k.move(x, 0, 0.07).rotZ(-Math.PI * 0.25);
      k.box(0, 0, 0, 0.5, 0.16, 0.03, C.yellow, { ao: 0, noAo: true });
      k.pop();
    }
    k.pop();
  }, 0.4);
}

/** Temporary site lighting: a column with a shepherd's-crook arm. */
export function lightColumnGeo(): THREE.BufferGeometry {
  return buildProp('lightColumn', (k) => {
    k.cyl(0, 0.16, 0, 0.3, 0.4, 0.32, 8, C.concreteDark, { ao: 0.5 });
    k.cyl(0, 4.2, 0, 0.11, 0.19, 8.2, 8, C.galv, { ao: 0.4, aoHeight: 3.5 });
    for (let i = 0; i < 5; i++) {
      const a = (i / 4) * Math.PI * 0.5;
      k.strut(
        Math.sin(a) * 0.9 * (i / 4), 8.3 - Math.cos(a) * 0 + i * 0.16, 0,
        Math.sin(a) * 1.4, 8.3 + Math.sin(a) * 0.55, 0, 0.08, C.galv,
        { ao: 0.2, aoHeight: 4 });
    }
    k.box(1.5, 8.9, 0, 0.9, 0.2, 0.44, C.galv, { ao: 0.15, aoHeight: 4 });
    k.box(1.5, 8.76, 0, 0.78, 0.12, 0.36, C.yellowPale, { noAo: true });
  }, 0.5);
}

// ── the site itself ────────────────────────────────────────────────────────

export function portalooGeo(): THREE.BufferGeometry {
  return buildProp('portaloo', (k) => {
    k.box(0, 1.15, 0, 1.16, 2.3, 1.16, C.tarp, { ao: 0.5, aoHeight: 1.9 });
    k.box(0, 2.36, 0, 1.26, 0.14, 1.26, C.offWhite, { ao: 0.2, aoHeight: 2.6 });
    k.box(0, 1.2, 0.6, 0.86, 2.0, 0.06, C.navy, { ao: 0.5, aoHeight: 1.9 });
    k.box(0, 2.02, 0.65, 0.6, 0.28, 0.04, C.offWhite, { ao: 0.2, aoHeight: 2.6 });
    k.box(0.36, 1.2, 0.66, 0.07, 0.14, 0.05, C.steel, { ao: 0.35, aoHeight: 2 });
    k.cyl(0.42, 2.6, -0.42, 0.09, 0.09, 0.5, 6, C.steelDark, { ao: 0.1, aoHeight: 3 });
    k.box(0, 0.06, 0, 1.3, 0.12, 1.3, C.ink, { ao: 0.6 });
  }, 0.45);
}

export function containerGeo(): THREE.BufferGeometry {
  return buildProp('container', (k) => {
    k.box(0, 1.3, 0, 2.44, 2.5, 6.06, C.rust, { ao: 0.42, aoHeight: 2.2 });
    // Corrugation. Purely a light-catcher, but a flat-sided box at fifty metres
    // reads as a texture-less lump and this does not.
    for (let i = 0; i < 18; i++) {
      const z = -2.85 + i * 0.335;
      k.box(1.235, 1.32, z, 0.05, 2.2, 0.16, C.rust, { shade: 1.12, ao: 0.42, aoHeight: 2.2 });
      k.box(-1.235, 1.32, z, 0.05, 2.2, 0.16, C.rust, { shade: 0.86, ao: 0.42, aoHeight: 2.2 });
    }
    k.box(0, 1.3, 3.05, 2.3, 2.3, 0.08, C.rust, { shade: 0.8, ao: 0.42, aoHeight: 2.2 });
    k.box(0, 1.3, 3.09, 0.09, 2.3, 0.05, C.ink, { ao: 0.42, aoHeight: 2.2 });
    k.box(0, 2.58, 0, 2.5, 0.12, 6.1, C.rust, { shade: 1.2, ao: 0.2, aoHeight: 2.8 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      k.box(sx * 1.2, 0.12, sz * 2.9, 0.24, 0.24, 0.3, C.steelDark, { ao: 0.6 });
    }
  }, 0.45);
}

export function siteHutGeo(): THREE.BufferGeometry {
  return buildProp('siteHut', (k) => {
    for (const sz of [-1, 0, 1]) {
      k.box(0, 0.18, sz * 2.4, 2.7, 0.36, 0.5, C.concreteDark, { ao: 0.65 });
    }
    k.box(0, 1.7, 0, 2.6, 2.4, 6.2, C.offWhite, { ao: 0.45, aoHeight: 2.4 });
    k.box(0, 2.98, 0, 2.76, 0.18, 6.4, C.steel, { ao: 0.2, aoHeight: 3.2 });
    k.box(0, 1.05, 0, 2.66, 0.16, 6.24, C.orange, { ao: 0.5, aoHeight: 2.4 });
    // Window band, front and back.
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        k.box(sx * 1.33, 2.0, -1.9 + i * 1.9, 0.06, 0.9, 1.3, C.navy,
          { ao: 0.3, aoHeight: 2.6 });
        k.box(sx * 1.36, 2.0, -1.9 + i * 1.9, 0.03, 1.0, 1.42, C.steel,
          { ao: 0.3, aoHeight: 2.6 });
      }
    }
    k.box(0, 1.6, 3.15, 0.9, 2.0, 0.08, C.tarp, { ao: 0.45, aoHeight: 2.4 });
    k.box(0, 0.35, 3.4, 1.2, 0.7, 0.5, C.concreteDark, { ao: 0.6 });
  }, 0.45);
}

export function skipGeo(): THREE.BufferGeometry {
  return buildProp('skip', (k) => {
    // A wedge: narrow at the bottom, flared at the top, like the real thing.
    k.box(0, 0.14, 0, 1.5, 0.28, 2.7, C.yellow, { ao: 0.6 });
    for (const sx of [-1, 1]) {
      k.push();
      k.move(sx * 0.95, 0.78, 0).rotZ(sx * 0.16);
      k.box(0, 0, 0, 0.1, 1.16, 3.2, C.yellow, { ao: 0.5, aoHeight: 1.5 });
      k.pop();
    }
    for (const sz of [-1, 1]) {
      k.push();
      k.move(0, 0.78, sz * 1.5).rotX(-sz * 0.2);
      k.box(0, 0, 0, 1.9, 1.16, 0.1, C.yellow, { ao: 0.5, aoHeight: 1.5 });
      k.pop();
    }
    k.box(0, 1.36, 0, 2.14, 0.12, 3.5, C.orange, { ao: 0.2, aoHeight: 1.8 });
    // Load: a lumpy heap of spoil and broken slab.
    for (let i = 0; i < 7; i++) {
      const a = i * 2.399;
      k.push();
      k.move(Math.sin(a) * 0.6, 1.2 + Math.cos(a * 3) * 0.14, Math.cos(a) * 1.1)
        .rotY(a).rotZ(0.2 + Math.sin(a * 2) * 0.3);
      k.box(0, 0, 0, 0.7, 0.16, 0.6, i % 3 === 0 ? C.concreteDark : C.dirtDark,
        { ao: 0.25, aoHeight: 1.6 });
      k.pop();
    }
    k.sph(0, 1.28, 0, 0.72, C.dirtDark, 7, { ao: 0.3, aoHeight: 1.6 });
  }, 0.5);
}

export function floodlightGeo(): THREE.BufferGeometry {
  return buildProp('floodlight', (k) => {
    k.box(0, 0.55, 0, 1.5, 1.1, 2.2, C.yellow, { ao: 0.55, aoHeight: 1.6 });
    k.box(0, 1.16, 0, 1.3, 0.14, 2.0, C.ink, { ao: 0.35, aoHeight: 1.8 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      k.strut(sx * 0.7, 0.36, sz * 1.0, sx * 1.5, 0.12, sz * 1.7, 0.08, C.steelDark,
        { ao: 0.55 });
      k.box(sx * 1.5, 0.1, sz * 1.7, 0.42, 0.2, 0.42, C.steelDark, { ao: 0.6 });
    }
    // Telescopic mast.
    k.cyl(0, 3.0, 0, 0.16, 0.24, 3.8, 8, C.galv, { ao: 0.4, aoHeight: 3 });
    k.cyl(0, 6.3, 0, 0.12, 0.16, 3.2, 8, C.galv, { ao: 0.25, aoHeight: 4 });
    k.box(0, 7.9, 0, 2.6, 0.16, 0.16, C.steelDark, { noAo: true });
    for (let i = 0; i < 4; i++) {
      const x = -0.98 + i * 0.65;
      k.push();
      k.move(x, 8.05, 0).rotX(0.5);
      k.box(0, 0, 0, 0.56, 0.42, 0.2, C.ink, { noAo: true });
      k.box(0, 0, 0.13, 0.5, 0.36, 0.06, C.yellowPale, { noAo: true });
      k.pop();
    }
  }, 0.5);
}

/** A scaffolding tower with a boarded deck — a place to put people. */
export function scaffoldGeo(): THREE.BufferGeometry {
  return buildProp('scaffold', (k) => {
    const R = 1.8, H = 5.4;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      k.box(sx * R, 0.08, sz * R, 0.5, 0.16, 0.5, C.timberDark, { ao: 0.6 });
      k.strut(sx * R, 0.1, sz * R, sx * R, H + 1.3, sz * R, 0.075, C.galv,
        { ao: 0.4, aoHeight: 3 });
    }
    for (let y = 1.0; y < H + 1.3; y += 1.35) {
      for (const sx of [-1, 1]) {
        k.strut(sx * R, y, -R, sx * R, y, R, 0.055, C.galv, { ao: 0.35, aoHeight: 3 });
      }
      for (const sz of [-1, 1]) {
        k.strut(-R, y, sz * R, R, y, sz * R, 0.055, C.galv, { ao: 0.35, aoHeight: 3 });
      }
      const flip = Math.round(y / 1.35) % 2 === 0 ? 1 : -1;
      k.strut(-R, y, flip * R, R, y + 1.35, flip * R, 0.042, C.galv, { ao: 0.3, aoHeight: 3 });
      k.strut(R, y, -flip * R, -R, y + 1.35, -flip * R, 0.042, C.galv, { ao: 0.3, aoHeight: 3 });
    }
    // Deck.
    for (let i = 0; i < 6; i++) {
      k.box(-1.5 + i * 0.6, H, 0, 0.56, 0.09, 3.8, C.timber, { ao: 0.2, aoHeight: 4 });
    }
    // Handrail and a scrim of orange netting on the road side.
    for (const sz of [-1, 1]) {
      k.strut(-R, H + 1.1, sz * R, R, H + 1.1, sz * R, 0.05, C.orange, { noAo: true });
    }
    k.box(0, H + 0.55, R + 0.06, 3.7, 1.1, 0.05, C.orange, { noAo: true, shade: 0.9 });
  }, 0.5);
}

export function pipeStackGeo(): THREE.BufferGeometry {
  return buildProp('pipeStack', (k) => {
    for (let i = 0; i < 3; i++) k.box(-1.4 + i * 1.4, 0.09, 0, 0.24, 0.18, 3.4, C.timberDark, { ao: 0.6 });
    const rows = [3, 2, 1];
    for (let r = 0; r < rows.length; r++) {
      const n = rows[r]!;
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * 1.12;
        const y = 0.74 + r * 0.98;
        k.push();
        k.move(x, y, 0).rotX(Math.PI * 0.5);
        k.cyl(0, 0, 0, 0.54, 0.54, 3.2, 12, C.concrete, { ao: 0.4, aoHeight: 2.4 });
        k.cyl(0, 0, 0, 0.4, 0.4, 3.28, 10, C.concreteDark, { ao: 0.5, aoHeight: 2.4 });
        k.pop();
      }
    }
  }, 0.5);
}

export function cableDrumGeo(): THREE.BufferGeometry {
  return buildProp('cableDrum', (k) => {
    k.push();
    k.rotZ(Math.PI * 0.5);
    k.cyl(0, -0.62, 0, 1.25, 1.25, 0.14, 14, C.timber, { ao: 0.4, aoHeight: 2.4 });
    k.cyl(0, 0.62, 0, 1.25, 1.25, 0.14, 14, C.timber, { ao: 0.4, aoHeight: 2.4 });
    k.cyl(0, 0, 0, 0.62, 0.62, 1.2, 12, C.ink, { ao: 0.45, aoHeight: 2.4 });
    for (let i = 0; i < 7; i++) {
      k.cyl(0, -0.5 + i * 0.17, 0, 0.78, 0.78, 0.15, 12, C.steelDark,
        { ao: 0.45, aoHeight: 2.4, shade: i % 2 ? 1.1 : 0.9 });
    }
    k.pop();
  }, 0.5);
}

export function palletStackGeo(): THREE.BufferGeometry {
  return buildProp('palletStack', (k) => {
    for (let p = 0; p < 3; p++) {
      const y = p * 0.16;
      for (let i = 0; i < 4; i++) {
        k.box(0, y + 0.11, -0.55 + i * 0.37, 1.2, 0.05, 0.16, C.timber, { ao: 0.55 });
      }
      k.box(0, y + 0.05, 0, 1.2, 0.09, 1.3, C.timberDark, { ao: 0.6 });
    }
    k.box(0, 0.95, 0, 1.15, 0.9, 1.25, C.tarp, { ao: 0.35, aoHeight: 1.6 });
    k.box(0, 1.42, 0, 1.2, 0.08, 1.3, C.navy, { ao: 0.2, aoHeight: 1.8 });
  }, 0.5);
}

/** A heap of spoil. Scaled at placement, so one geometry covers everything from
 *  a shovelful to a quarry tip. */
export function spoilHeapGeo(pal: LandPalette = LAND_PALETTES.canyon): THREE.BufferGeometry {
  return buildProp('spoil', (k) => {
    k.cone(0, 0, 0, 2.6, 2.0, 9, pal.soil, { ao: 0.45, aoHeight: 2.2 });
    k.push();
    k.move(1.4, 0, -0.9).rotY(0.6);
    k.cone(0, 0, 0, 1.7, 1.3, 8, pal.soilDark, { ao: 0.45, aoHeight: 2.2 });
    k.pop();
    k.push();
    k.move(-1.1, 0, 1.3).rotY(1.9);
    k.cone(0, 0, 0, 1.4, 1.0, 8, pal.soil, { ao: 0.45, aoHeight: 2.2, shade: 1.08 });
    k.pop();
    // Whatever settles on top here: snow above the line, salt rime on the pan.
    if (pal.cap !== null) {
      k.cone(0, 1.16, 0, 1.05, 0.88, 9, pal.cap, { noAo: true });
    }
  }, 0.45);
}

/**
 * An outcrop of broken rock.
 *
 * Built from tilted slabs rather than blobs: a smooth low-poly sphere at this
 * scale reads as a flying saucer parked on the hillside, which is exactly what
 * the first pass looked like. Flat faces at odd angles read as stone.
 */
export function boulderGeo(pal: LandPalette = LAND_PALETTES.canyon): THREE.BufferGeometry {
  return buildProp('boulder', (k) => {
    const slabs: Array<[number, number, number, number, number, number, number, number]> = [
      // x, y, z, w, h, d, yaw, tilt
      [0, 0.42, 0, 2.0, 0.9, 1.7, 0.2, 0.10],
      [0.55, 0.95, -0.3, 1.4, 0.8, 1.2, 0.9, -0.16],
      [-0.6, 0.72, 0.45, 1.2, 0.62, 1.0, 1.9, 0.22],
      [0.15, 1.42, 0.1, 0.9, 0.6, 0.8, 2.6, 0.12],
      [-1.15, 0.3, -0.5, 0.9, 0.5, 0.8, 0.5, -0.24],
    ];
    for (let i = 0; i < slabs.length; i++) {
      const s = slabs[i]!;
      k.push();
      k.move(s[0]!, s[1]!, s[2]!).rotY(s[6]!).rotZ(s[7]!).rotX(s[7]! * 0.6);
      k.box(0, 0, 0, s[3]!, s[4]!, s[5]!,
        i % 2 ? pal.rockDark : pal.rock, { ao: 0.42, aoHeight: 1.8, shade: 1 - i * 0.045 });
      // Snow or rime lies on the up-facing slab, not on the whole rock — a
      // uniformly white boulder reads as a marshmallow.
      if (pal.cap !== null) {
        k.box(0, s[4]! * 0.5, 0, s[3]! * 0.86, 0.13, s[5]! * 0.86, pal.cap, { noAo: true });
      }
      k.pop();
    }
  }, 0.42);
}

/**
 * Twelve metres of trackside hoarding.
 *
 * Two things about this piece are the result of being wrong about it once.
 *
 * **Colour.** The first version carried the course palette at full strength —
 * orange, cyan, white — and became the loudest thing in every frame, brighter
 * and more saturated than the player's own kart. The row of item boxes sat at
 * the same screen height in the same hue family and simply vanished into it.
 * So every colour here comes through `mute()` (look.ts): roughly 60% chroma,
 * value capped below kart paint. What is lost in chroma is bought back in
 * *value* — a near-black panel beside a bone one still reads hard at two
 * hundred metres, and it reads as distance rather than as a second racing line.
 *
 * **Marks.** The first version's motifs were block glyphs that happened to look
 * like letters — F, E, ≡ — which the eye tries to read and cannot, so the whole
 * run scanned as corrupted text. These are deliberately non-alphabetic: a
 * roundel, a chevron pair, a three-bar speed mark. Shapes, not type.
 *
 * The lower two metres live behind the barrier and are never seen, so they stay
 * dark and only the visible band above the rail carries anything at all.
 */
export function hoardingGeo(variant = 0): THREE.BufferGeometry {
  const H = 3.75;
  /** Panel colour and the mark that goes on it. `variant` rotates the sequence
   *  so alternating kinds along a run stops it reading as one repeated tile. */
  const all: Array<[number, number]> = [
    [BOARD.clay, BOARD.bone],
    [BOARD.deep, BOARD.ochre],
    [BOARD.bone, BOARD.brick],
    [BOARD.slate, BOARD.bone],
    [BOARD.ochre, BOARD.deep],
    [BOARD.moss, BOARD.bone],
  ];
  const boards = [0, 1, 2, 3].map((i) => all[(i + variant * 2) % all.length]!);
  return buildProp('hoarding', (k) => {
    for (let i = 0; i <= 4; i++) {
      const z = -6 + i * 3;
      k.strut(0, 0, z, 0, H + 0.2, z, 0.09, C.steelDark, { ao: 0.5, aoHeight: 2.6 }, 4);
      if (i % 2 === 0) {
        k.strut(0, 0.2, z, -0.55, 2.4, z, 0.06, C.steelDark, { ao: 0.5, aoHeight: 2.6 }, 4);
      }
    }
    const face = { ao: 0.16, aoHeight: 3.6 };
    for (let i = 0; i < 4; i++) {
      const z = -4.4 + i * 3;
      const [base, mark] = boards[i % boards.length]!;
      k.box(0, 1.02, z, 0.13, 2.05, 2.96, C.ink, { ao: 0.6, aoHeight: 2.4 });
      k.box(0, 2.9, z, 0.15, 1.72, 2.96, base!, face);
      switch ((i + variant) % 3) {
        case 0: {
          // A roundel with a bar under it. The disc is a flat cylinder turned to
          // stand in the board's own plane.
          k.push();
          k.move(-0.085, 2.98, z).rotZ(Math.PI * 0.5);
          k.cyl(0, 0, 0, 0.56, 0.56, 0.04, 12, mark!, face);
          k.cyl(0, 0.03, 0, 0.3, 0.3, 0.04, 10, base!, face);
          k.pop();
          k.box(-0.085, 2.26, z, 0.04, 0.16, 2.1, mark!, face);
          break;
        }
        case 1: {
          // Two chevrons, pointing the way the traffic goes.
          for (let j = 0; j < 2; j++) {
            for (const sy of [-1, 1] as const) {
              k.push();
              k.move(-0.085, 2.9, z - 0.62 + j * 1.24).rotX(sy * 0.72);
              k.box(0, 0, 0.42, 0.04, 0.3, 1.5, mark!, face);
              k.pop();
            }
          }
          break;
        }
        default: {
          // A three-bar speed mark: same width, stepped back, stepped down.
          for (let j = 0; j < 3; j++) {
            k.box(-0.085, 3.36 - j * 0.46, z - 0.18 - j * 0.34,
              0.04, 0.28, 2.2 - j * 0.55, mark!, face);
          }
          break;
        }
      }
    }
    k.box(0, H + 0.15, 0, 0.24, 0.24, 12, BOARD.deep, { ao: 0.1, aoHeight: 4 });
    k.box(0, 1.98, 0, 0.2, 0.16, 12, C.steelDark, { ao: 0.4, aoHeight: 3 });
    k.box(0, 0.16, 0, 0.32, 0.32, 12, C.concreteDark, { ao: 0.6, aoHeight: 1.6 });
  }, 0.5);
}

export function scrubGeo(pal: LandPalette = LAND_PALETTES.canyon): THREE.BufferGeometry {
  return buildProp('scrub', (k) => {
    k.push(); k.scale(1, 0.62, 1);
    k.sph(0, 0.62, 0, 0.74, pal.veg, 5, { ao: 0.45, aoHeight: 1.0 });
    k.pop();
    k.push(); k.move(0.6, 0, 0.32).scale(1, 0.55, 1);
    k.sph(0, 0.46, 0, 0.52, pal.vegDark, 5, { ao: 0.45, aoHeight: 1.0 });
    k.pop();
  }, 0.45);
}

// ── the middle distance ────────────────────────────────────────────────────
//
// Forty to a hundred and fifty metres beyond the barrier. In a pulled-back or
// overhead frame that band is most of the picture's width, and it used to be
// bare tan dirt with a couple of light poles in it — the circuit had a
// foreground and a horizon and nothing between them.
//
// Two constraints shape everything here. It has to be *big*: at ninety metres a
// prop needs to be the size of a house before it is anything at all. And the
// tall ones have to be genuinely tall, because the embankment puts that whole
// band five metres below road level and the barrier hides everything under
// about four metres of it from a chase camera. So the band is built from a few
// large silhouettes — tents, stockpiles, light towers, benched ground — rather
// than from a lot of small things nobody would ever see.

/**
 * A graded gravel hardstand: the pale platform a car park, a marquee row or a
 * far crowd bank stands on.
 *
 * Lower and lighter than a works pad, and that is its real job — the landscape
 * out here is one flat orange-tan, so a pale rectangle of scalpings does more
 * for the band than anything standing on it.
 */
export function hardstandGeo(
  w = 46, d = 30, pal: LandPalette = LAND_PALETTES.canyon,
): THREE.BufferGeometry {
  return buildProp('hardstand', (k) => {
    // A battered skirt so it meets whatever the dirt has done underneath — in
    // the landscape's own soil, because a brown earthwork on a salt lake is a
    // rectangle of the wrong planet.
    k.box(0, -3.0, 0, w * 1.16, 6, d * 1.16, pal.soilDark, { noAo: true, shade: 0.7 });
    for (let i = 0; i < 3; i++) {
      const t = i / 2;
      k.box(0, -0.08 - t * 2.6, 0, w * (1 + t * 0.22), 0.12, d * (1 + t * 0.22),
        i === 0 ? pal.crest : pal.soilDark, { noAo: true, shade: 1 - t * 0.26 });
    }
    // Pale, but not white: the point is a value step off the orange dirt, and a
    // slab that goes brighter than the road markings pulls the eye off the
    // circuit from three hundred metres.
    k.box(0, 0.03, 0, w, 0.16, d, C.concrete, { noAo: true, shade: 0.82 });
    // An access lane up the middle and marked-out bays either side of it.
    // Painted lines cost nothing and they are the whole difference between a
    // gravel apron and a blank slab — which is exactly what this read as from a
    // hundred metres with only three rows of cars standing on it. The bays run
    // along +Z to match `vanRowGeo`, which parks its cars nose-on to the track.
    k.box(0, 0.07, 0, w * 0.98, 0.06, d * 0.16, C.concreteDark,
      { noAo: true, shade: 0.86 });
    for (const sz of [-1, 1] as const) {
      const z = sz * d * 0.26;
      const bay = d * 0.28;
      for (let j = 0; j <= 12; j++) {
        k.box((-0.5 + j / 12) * w * 0.94, 0.09, z, 0.16, 0.05, bay, C.offWhite,
          { noAo: true, shade: 0.74 });
      }
      k.box(0, 0.09, z + sz * bay * 0.5, w * 0.94, 0.05, 0.18, C.offWhite,
        { noAo: true, shade: 0.74 });
    }
  }, 0);
}

/**
 * A row of six parked spectator vehicles.
 *
 * Baked as a row rather than as one car: a car park is a *pattern*, and one
 * geometry of six gets the pattern for a sixth of the instances. Colours come
 * from the muted parked palette — a hundred full-chroma cars beside the road is
 * a hundred things that look like karts.
 */
export function vanRowGeo(seed = 3): THREE.BufferGeometry {
  const rng = makeRng(seed);
  return buildProp('vanRow', (k) => {
    for (let i = 0; i < 6; i++) {
      const x = (i - 2.5) * 3.1 + rng.range(-0.25, 0.25);
      const tall = rng.bool(0.4);
      const col = rng.pick(PARKED);
      const L = rng.range(4.2, 5.0);
      k.push();
      k.move(x, 0, rng.range(-0.5, 0.5)).rotY(rng.range(-0.06, 0.06));
      k.box(0, 0.72, 0, 1.9, 0.78, L, col, { ao: 0.5, aoHeight: 1.6 });
      if (tall) {
        k.box(0, 1.52, -0.2, 1.86, 0.86, L * 0.72, col, { ao: 0.32, aoHeight: 2.2 });
        k.box(0, 1.9, -0.2, 1.7, 0.16, L * 0.7, C.offWhite,
          { ao: 0.3, aoHeight: 2.4, shade: 0.85 });
      } else {
        k.box(0, 1.38, -0.25, 1.66, 0.6, L * 0.46, C.steelDark,
          { ao: 0.35, aoHeight: 2.2, shade: 0.9 });
      }
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        k.box(sx * 0.86, 0.34, sz * L * 0.32, 0.2, 0.6, 0.6, C.ink,
          { ao: 0.6, aoHeight: 1.2 });
      }
      k.pop();
    }
  }, 0.5);
}

/**
 * A hospitality marquee: fourteen metres of peaked white canvas.
 *
 * The one shape in this band that is genuinely readable from the road. It is
 * six metres to the ridge, which clears the barrier's sight line from a chase
 * camera out to a hundred metres, and it is near-white against tan dirt, which
 * is the strongest value contrast available out here without spending chroma.
 */
export function marqueeGeo(seed = 1): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const W = 13, D = 9, EAVE = 3.1, RIDGE = 5.8;
  const stripe = rng.pick([BOARD.clay, BOARD.slate, BOARD.deep, BOARD.brick]);
  return buildProp('marquee', (k) => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      k.strut(sx * W * 0.5, 0, sz * D * 0.5, sx * W * 0.5, EAVE, sz * D * 0.5,
        0.09, C.galv, { ao: 0.45, aoHeight: 2.4 });
    }
    k.strut(-W * 0.5, EAVE, -D * 0.5, W * 0.5, EAVE, -D * 0.5, 0.07, C.galv, { noAo: true });
    k.strut(-W * 0.5, EAVE, D * 0.5, W * 0.5, EAVE, D * 0.5, 0.07, C.galv, { noAo: true });
    // Two roof slopes meeting on a ridge.
    const slope = Math.atan2(RIDGE - EAVE, D * 0.5);
    const len = Math.hypot(RIDGE - EAVE, D * 0.5);
    for (const sz of [-1, 1] as const) {
      k.push();
      k.move(0, (EAVE + RIDGE) * 0.5, sz * D * 0.25).rotX(-sz * slope);
      k.box(0, 0, 0, W + 0.5, 0.12, len, BOARD.canvas, { noAo: true, shade: sz > 0 ? 1 : 0.86 });
      k.box(0, -0.1, 0, W + 0.5, 0.06, len * 0.34, stripe,
        { noAo: true, shade: sz > 0 ? 1 : 0.86 });
      k.pop();
    }
    k.box(0, RIDGE + 0.06, 0, W + 0.6, 0.16, 0.3, BOARD.canvas, { noAo: true });
    // Scalloped valance under the eaves — the tell that reads as "tent".
    for (const sz of [-1, 1]) {
      for (let i = 0; i < 9; i++) {
        k.box(-W * 0.5 + 0.7 + i * 1.55, EAVE - 0.36, sz * (D * 0.5 + 0.06),
          1.3, 0.62, 0.06, i % 2 ? stripe : BOARD.canvas, { noAo: true, shade: 0.94 });
      }
    }
    // A pennant on the ridge. Static — at this distance a flap would be one
    // pixel of motion for a whole extra material.
    k.strut(W * 0.5 - 0.4, RIDGE, 0, W * 0.5 - 0.4, RIDGE + 2.6, 0, 0.05, C.galv,
      { noAo: true });
    k.box(W * 0.5 - 0.4, RIDGE + 2.1, 0.55, 0.05, 0.66, 1.1, BOARD.clay, { noAo: true });
  }, 0.4);
}

/**
 * A quarry bench: forty metres of cut ground, stepped, with a pale crest and a
 * haul road along its foot.
 *
 * The mid-distance dirt reads as flat because it *is* flat. Benching it gives
 * the band a horizontal line to lie against, which is what makes the ground
 * between the circuit and the canyon wall look like it has been worked rather
 * than like a hole in the mesh.
 */
export function bermGeo(pal: LandPalette = LAND_PALETTES.canyon): THREE.BufferGeometry {
  const rng = makeRng(0x8ab3);
  return buildProp('berm', (k) => {
    const L = 46;
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      k.box(-i * 2.1, 0.5 + i * 0.95, 0, 11 - i * 2.1, 2.0 + i * 0.1, L - i * 5,
        i % 2 ? pal.soil : pal.soilDark, { noAo: true, shade: 0.82 + t * 0.2 });
    }
    // Crest: scalped rock, the pale line that does most of the work.
    k.box(-6.3, 4.3, 0, 4.6, 0.5, L - 15, pal.crest, { noAo: true, shade: 1.02 });
    // Rubble down the face and along the toe. Four stacked boxes is a stepped
    // quarry bench, which is right; four stacked boxes and nothing else is a
    // stack of boxes, which is what it looked like.
    for (let i = 0; i < 14; i++) {
      const step = i % 4;
      k.push();
      k.move(-step * 2.1 + rng.range(-1.4, 1.4), 0.4 + step * 0.95,
        rng.range(-0.44, 0.44) * L).rotY(rng.range(0, 6.28));
      k.box(0, 0, 0, rng.range(0.9, 2.2), rng.range(0.7, 1.4), rng.range(0.9, 2.0),
        rng.bool() ? pal.soilDark : pal.rock, { noAo: true, shade: rng.range(0.72, 1.0) });
      k.pop();
    }
    // Haul road along the toe.
    k.box(7.6, 0.12, 0, 6.4, 0.24, L + 4, pal.crest, { noAo: true, shade: 0.92 });
    k.box(10.4, 0.3, 0, 0.7, 0.5, L + 4, pal.soil, { noAo: true, shade: 0.86 });
  }, 0);
}

/** A stockpile of aggregate with its feed conveyor — pale grey, so it separates
 *  from the dirt spoil heaps that share the band. */
export function stockpileGeo(): THREE.BufferGeometry {
  return buildProp('stockpile', (k) => {
    k.cone(0, 0, 0, 8.5, 9.5, 11, C.concrete, { ao: 0.4, aoHeight: 7 });
    k.push();
    k.move(2, 0, 2).rotY(0.9);
    k.cone(0, 0, 0, 5.4, 6.2, 9, C.concreteDark, { ao: 0.4, aoHeight: 6 });
    k.pop();
    // The conveyor that made it.
    k.push();
    k.move(-6, 0, -7).rotY(0.6).rotZ(0.62);
    k.box(0, 7.5, 0, 1.5, 15, 1.9, C.steelDark, { ao: 0.35, aoHeight: 8 });
    k.box(0, 7.5, 0, 1.2, 15.2, 1.4, C.rust, { ao: 0.35, aoHeight: 8 });
    k.pop();
    k.strut(-9.5, 0, -11, -9.5, 5.5, -11, 0.3, C.steelDark, { ao: 0.5, aoHeight: 5 });
  }, 0.4);
}

/**
 * A twenty-two metre event lighting tower.
 *
 * The mid-distance band is five metres below the road and the barrier hides the
 * first four metres of everything in it, so the only way to put something *out
 * there* into a chase frame is to make it tall. A ring of these around the
 * circuit is also the cheapest possible statement that this is a venue with an
 * evening session rather than a stretch of desert road.
 */
export function floodTowerGeo(): THREE.BufferGeometry {
  return buildProp('floodTower', (k) => {
    const H = 21, R0 = 1.5, R1 = 0.55;
    const leg = (t: number): number => R0 + (R1 - R0) * t;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      k.box(sx * R0, 0.2, sz * R0, 1.1, 0.4, 1.1, C.concreteDark, { ao: 0.6 });
      k.strut(sx * R0, 0.2, sz * R0, sx * R1, H, sz * R1, 0.14, C.galv,
        { ao: 0.4, aoHeight: 5 }, 4);
    }
    for (let i = 0; i <= 6; i++) {
      const t = i / 6, y = 0.4 + t * (H - 0.4), r = leg(t);
      for (const sx of [-1, 1]) {
        k.strut(sx * r, y, -r, sx * r, y, r, 0.07, C.galv, { ao: 0.35, aoHeight: 6 }, 4);
      }
      for (const sz of [-1, 1]) {
        k.strut(-r, y, sz * r, r, y, sz * r, 0.07, C.galv, { ao: 0.35, aoHeight: 6 }, 4);
      }
      if (i === 6) continue;
      const t2 = (i + 1) / 6, y2 = 0.4 + t2 * (H - 0.4), r2 = leg(t2);
      const f = i % 2 ? 1 : -1;
      k.strut(-r, y, f * r, r2, y2, f * r2, 0.055, C.galv, { ao: 0.3, aoHeight: 6 }, 4);
      k.strut(f * r, y, -r, f * r2, y2, r2, 0.055, C.galv, { ao: 0.3, aoHeight: 6 }, 4);
    }
    // Head: a raked frame of eight lamps.
    k.box(0, H + 0.5, 0, 5.6, 0.22, 1.4, C.steelDark, { noAo: true });
    k.box(0, H + 1.6, 0, 0.22, 2.2, 0.22, C.galv, { noAo: true });
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 4; i++) {
        k.push();
        k.move(-2.1 + i * 1.4, H + 1.0 + row * 1.15, 0.1).rotX(0.42);
        k.box(0, 0, 0, 1.2, 0.9, 0.34, C.ink, { noAo: true });
        k.box(0, 0, 0.22, 1.05, 0.76, 0.06, C.yellowPale, { noAo: true });
        k.pop();
      }
    }
  }, 0.5);
}

// ── parked plant ───────────────────────────────────────────────────────────

/** A parked excavator. Not a racer — the racers are the cartoon ones; this is a
 *  real machine sitting in the run-off, which is what makes them cartoons. */
export function diggerGeo(): THREE.BufferGeometry {
  return buildProp('digger', (k) => {
    for (const sx of [-1, 1]) {
      k.box(sx * 1.05, 0.42, 0, 0.62, 0.84, 3.5, C.ink, { ao: 0.6, aoHeight: 1.4 });
      for (let i = 0; i < 6; i++) {
        k.push();
        k.move(sx * 1.05, 0.42, -1.5 + i * 0.6).rotZ(Math.PI * 0.5);
        k.cyl(0, 0, 0, 0.44, 0.44, 0.66, 8, C.steelDark, { ao: 0.55, aoHeight: 1.4 });
        k.pop();
      }
    }
    k.box(0, 0.98, 0, 2.5, 0.3, 3.2, C.ink, { ao: 0.45, aoHeight: 1.8 });
    k.cyl(0, 1.2, 0, 0.9, 0.9, 0.24, 10, C.steelDark, { ao: 0.4, aoHeight: 2 });
    // House and cab.
    k.box(-0.1, 1.85, -0.9, 2.0, 1.1, 1.9, C.yellow, { ao: 0.35, aoHeight: 2.4 });
    k.box(0.55, 2.2, 0.72, 1.1, 1.9, 1.3, C.yellow, { ao: 0.3, aoHeight: 2.6 });
    k.box(0.55, 2.35, 1.39, 0.9, 1.4, 0.06, C.navy, { ao: 0.3, aoHeight: 2.6 });
    k.box(1.12, 2.35, 0.72, 0.06, 1.4, 1.0, C.navy, { ao: 0.3, aoHeight: 2.6 });
    k.box(-0.1, 2.44, -0.9, 2.06, 0.12, 1.96, C.orange, { ao: 0.25, aoHeight: 2.8 });
    // Boom, dipper, bucket.
    k.push();
    k.move(-0.35, 2.0, 1.0).rotX(-0.72);
    k.box(0, 1.5, 0, 0.44, 3.1, 0.5, C.yellow, { ao: 0.2, aoHeight: 3.4 });
    k.move(0, 3.0, 0).rotX(1.62);
    k.box(0, 1.15, 0, 0.34, 2.4, 0.4, C.yellow, { ao: 0.2, aoHeight: 3.4 });
    k.move(0, 2.3, 0).rotX(0.9);
    k.box(0, 0.35, 0, 0.86, 0.8, 0.6, C.orange, { ao: 0.2, aoHeight: 3.4 });
    for (let i = 0; i < 4; i++) {
      k.box(-0.33 + i * 0.22, 0.78, 0.1, 0.1, 0.3, 0.22, C.steelDark,
        { ao: 0.2, aoHeight: 3.4 });
    }
    k.pop();
  }, 0.45);
}

/** A site dumper with its bed down. The tipping one is a set piece; this is the
 *  one that just sits there. */
export function dumperGeo(bedAngle = 0): THREE.BufferGeometry {
  return buildProp('dumper', (k) => {
    dumperChassis(k);
    k.push();
    k.move(0, 1.5, -1.9).rotX(-bedAngle);
    dumperBed(k);
    k.pop();
  }, 0.45);
}

export function dumperChassis(k: Kit): void {
  for (const sx of [-1, 1]) for (const z of [1.7, -0.6, -2.0]) {
    k.push();
    k.move(sx * 1.25, 0.72, z).rotZ(Math.PI * 0.5);
    k.cyl(0, 0, 0, 0.72, 0.72, 0.6, 10, C.ink, { ao: 0.55, aoHeight: 1.6 });
    k.cyl(0, 0, 0, 0.3, 0.3, 0.64, 8, C.steel, { ao: 0.5, aoHeight: 1.6 });
    k.pop();
  }
  k.box(0, 0.95, -0.4, 2.1, 0.34, 5.4, C.ink, { ao: 0.55, aoHeight: 1.8 });
  k.box(0, 1.9, 1.55, 2.2, 1.6, 1.9, C.orange, { ao: 0.35, aoHeight: 2.6 });
  k.box(0, 2.1, 2.52, 1.7, 0.9, 0.06, C.navy, { ao: 0.3, aoHeight: 2.8 });
  k.box(0, 2.76, 1.55, 2.26, 0.14, 1.96, C.orangeDeep, { ao: 0.25, aoHeight: 3 });
  k.box(0, 1.16, 0.6, 2.3, 0.16, 0.4, C.steelDark, { ao: 0.4, aoHeight: 2 });
}

export function dumperBed(k: Kit): void {
  k.box(0, 0.1, 1.75, 2.2, 0.2, 3.5, C.steelDark, { noAo: true });
  for (const sx of [-1, 1]) k.box(sx * 1.1, 0.6, 1.75, 0.12, 1.2, 3.5, C.orange, { noAo: true });
  k.box(0, 0.6, 0.05, 2.2, 1.4, 0.14, C.orange, { noAo: true });
  k.box(0, 0.75, 3.45, 2.2, 1.1, 0.12, C.orangeDeep, { noAo: true });
}

/** A gravel load that rides in the tipper's bed. */
export function loadGeo(): THREE.BufferGeometry {
  return buildProp('load', (k) => {
    for (let i = 0; i < 9; i++) {
      const a = i * 2.399;
      k.push();
      k.move(Math.sin(a) * 0.6, 0.2 + Math.cos(a * 2.7) * 0.12, 1.75 + Math.cos(a) * 1.3)
        .rotY(a).scale(1, 0.6, 1);
      k.sph(0, 0, 0, 0.62, i % 2 ? C.dirt : C.dirtDark, 6, { noAo: true });
      k.pop();
    }
  }, 0);
}

// ── things on the horizon ──────────────────────────────────────────────────

/** A tower crane. The single best silhouette a construction site has. */
export function towerCraneGeo(): THREE.BufferGeometry {
  return buildProp('towerCrane', (k) => {
    const R = 1.15, H = 34;
    k.box(0, 0.5, 0, 6, 1, 6, C.concreteDark, { ao: 0.5, aoHeight: 3 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      k.strut(sx * R, 1, sz * R, sx * R, H, sz * R, 0.2, C.yellow, { ao: 0.35, aoHeight: 8 });
    }
    for (let y = 2; y < H; y += 2.2) {
      for (const sx of [-1, 1]) k.strut(sx * R, y, -R, sx * R, y, R, 0.11, C.yellow, { ao: 0.3, aoHeight: 8 });
      for (const sz of [-1, 1]) k.strut(-R, y, sz * R, R, y, sz * R, 0.11, C.yellow, { ao: 0.3, aoHeight: 8 });
      const f = Math.round(y / 2.2) % 2 === 0 ? 1 : -1;
      k.strut(-R, y, f * R, R, y + 2.2, f * R, 0.09, C.yellow, { ao: 0.3, aoHeight: 8 });
      k.strut(R, y, -f * R, -R, y + 2.2, -f * R, 0.09, C.yellow, { ao: 0.3, aoHeight: 8 });
    }
    // Slewing unit, cab, jib and counter-jib.
    k.box(0, H + 1.2, 0, 3.0, 2.2, 3.0, C.yellow, { noAo: true });
    k.box(1.9, H + 2.2, 0, 1.6, 1.8, 1.7, C.white, { noAo: true });
    k.box(2.5, H + 2.3, 0, 0.5, 1.2, 1.3, C.navy, { noAo: true });
    for (let i = 0; i < 14; i++) {
      const z0 = 2 + i * 2.0, z1 = z0 + 2.0;
      for (const sx of [-1, 1]) k.strut(sx * 0.7, H + 2.4, z0, sx * 0.7, H + 2.4, z1, 0.09, C.yellow, { noAo: true });
      k.strut(0, H + 0.9, z0, 0, H + 0.9, z1, 0.09, C.yellow, { noAo: true });
      k.strut(-0.7, H + 2.4, z0, 0, H + 0.9, z1, 0.06, C.yellow, { noAo: true });
      k.strut(0.7, H + 2.4, z1, 0, H + 0.9, z0, 0.06, C.yellow, { noAo: true });
      k.strut(-0.7, H + 2.4, z0, 0.7, H + 2.4, z1, 0.05, C.yellow, { noAo: true });
    }
    for (let i = 0; i < 4; i++) {
      const z0 = -2 - i * 2.0, z1 = z0 - 2.0;
      for (const sx of [-1, 1]) k.strut(sx * 0.7, H + 2.4, z0, sx * 0.7, H + 2.4, z1, 0.09, C.yellow, { noAo: true });
      k.strut(0, H + 0.9, z0, 0, H + 0.9, z1, 0.09, C.yellow, { noAo: true });
    }
    k.box(0, H + 1.6, -9.6, 2.4, 1.4, 2.2, C.concreteDark, { noAo: true });
    // Pendant ties and the hook block.
    k.strut(0, H + 6.5, 0, 0, H + 2.4, 22, 0.06, C.steelDark, { noAo: true });
    k.strut(0, H + 6.5, 0, 0, H + 2.4, -9, 0.06, C.steelDark, { noAo: true });
    k.strut(0, H + 6.6, -0.5, 0, H + 6.6, 0.5, 0.5, C.yellow, { noAo: true });
    k.strut(0, H + 2.2, 15, 0, H - 7, 15, 0.045, C.ink, { noAo: true });
    k.box(0, H - 7.6, 15, 0.7, 1.2, 0.7, C.ink, { noAo: true });
  }, 0.35);
}

/** A batching plant: silos, a conveyor and a hopper. Pure horizon furniture. */
export function siloGeo(): THREE.BufferGeometry {
  return buildProp('silo', (k) => {
    k.box(0, 0.4, 0, 14, 0.8, 10, C.concreteDark, { ao: 0.5, aoHeight: 4 });
    for (let i = 0; i < 3; i++) {
      const x = -4.4 + i * 4.4;
      for (let j = 0; j < 4; j++) {
        const a = j * Math.PI * 0.5 + 0.78;
        k.strut(x + Math.cos(a) * 1.7, 0.8, Math.sin(a) * 1.7,
          x + Math.cos(a) * 1.9, 5.5, Math.sin(a) * 1.9, 0.22, C.steelDark, { ao: 0.4, aoHeight: 6 });
      }
      k.cyl(x, 4.4, 0, 1.95, 0.5, 2.6, 12, C.steel, { ao: 0.3, aoHeight: 8 });
      k.cyl(x, 10.5, 0, 1.95, 1.95, 9.6, 12, i === 1 ? C.offWhite : C.steel,
        { ao: 0.25, aoHeight: 10 });
      k.cyl(x, 15.6, 0, 1.1, 2.0, 0.9, 12, C.steelDark, { noAo: true });
      k.box(x, 12, 2.0, 1.2, 8, 0.14, C.orange, { ao: 0.25, aoHeight: 10 });
    }
    // Conveyor up to the top.
    k.push();
    k.move(-11, 6, 6).rotY(-0.5).rotZ(0.62);
    k.box(0, 0, 0, 15, 0.9, 1.6, C.steelDark, { noAo: true });
    k.box(0, 0.6, 0, 15, 0.3, 1.9, C.orange, { noAo: true });
    k.pop();
    k.box(-14, 2, 10, 5, 4, 5, C.steelDark, { ao: 0.4, aoHeight: 5 });
  }, 0.35);
}

/** A guyed lattice mast. Vertical punctuation on a horizon that is otherwise
 *  all horizontal strata. */
export function mastGeo(): THREE.BufferGeometry {
  return buildProp('mast', (k) => {
    const H = 42, R = 0.8;
    for (let j = 0; j < 3; j++) {
      const a = j * 2.094;
      const x = Math.cos(a) * R, z = Math.sin(a) * R;
      k.strut(x, 0, z, x, H, z, 0.13, C.galv, { ao: 0.35, aoHeight: 10 });
    }
    for (let y = 1.6; y < H; y += 1.9) {
      for (let j = 0; j < 3; j++) {
        const a = j * 2.094, b = ((j + 1) % 3) * 2.094;
        k.strut(Math.cos(a) * R, y, Math.sin(a) * R, Math.cos(b) * R, y, Math.sin(b) * R,
          0.06, C.galv, { ao: 0.3, aoHeight: 10 });
        k.strut(Math.cos(a) * R, y, Math.sin(a) * R,
          Math.cos(b) * R, y + 1.9, Math.sin(b) * R, 0.05, C.galv, { ao: 0.3, aoHeight: 10 });
      }
    }
    for (let j = 0; j < 3; j++) {
      const a = j * 2.094 + 0.5;
      k.strut(0, H * 0.72, 0, Math.cos(a) * 16, 0, Math.sin(a) * 16, 0.05, C.steelDark,
        { ao: 0.3, aoHeight: 10 });
    }
    k.box(0, H * 0.55, 0, 1.6, 1.6, 1.6, C.offWhite, { noAo: true });
    k.cyl(0, H + 1.6, 0, 0.08, 0.14, 3.2, 6, C.red, { noAo: true });
  }, 0.4);
}

/** The course's signature: a road cone the size of a building. */
export function giantConeGeo(): THREE.BufferGeometry {
  return buildProp('giantCone', (k) => {
    k.cyl(0, 0.6, 0, 8.2, 9.0, 1.2, 16, C.concreteDark, { ao: 0.5, aoHeight: 6 });
    k.box(0, 1.5, 0, 12.6, 0.7, 12.6, C.ink, { ao: 0.45, aoHeight: 6 });
    k.box(0, 2.1, 0, 10.4, 0.6, 10.4, C.ink, { ao: 0.45, aoHeight: 6 });
    k.cone(0, 2.3, 0, 5.0, 20, 20, C.orange, { ao: 0.3, aoHeight: 10 });
    k.cyl(0, 9.0, 0, 3.05, 3.55, 3.4, 20, C.white, { ao: 0.22, aoHeight: 12 });
    k.cyl(0, 14.6, 0, 1.55, 2.05, 2.6, 20, C.white, { ao: 0.18, aoHeight: 14 });
    k.sph(0, 22.5, 0, 0.55, C.red, 8, { noAo: true });
  }, 0.4);
}

/** A conveyor bridge on legs, walking across the middle distance. */
export function conveyorGeo(): THREE.BufferGeometry {
  return buildProp('conveyor', (k) => {
    const L = 46;
    k.push();
    k.move(0, 9, 0).rotX(0.11);
    k.box(0, 0, 0, 2.0, 1.0, L, C.steelDark, { noAo: true });
    k.box(0, 0.7, 0, 2.3, 0.3, L, C.orange, { noAo: true });
    for (let i = 0; i < 16; i++) {
      const z = -L / 2 + i * (L / 15);
      k.strut(-1.0, -0.5, z, 1.0, 0.6, z, 0.05, C.galv, { noAo: true });
      k.strut(1.0, -0.5, z, -1.0, 0.6, z, 0.05, C.galv, { noAo: true });
    }
    k.pop();
    for (const z of [-16, 2, 18]) {
      for (const sx of [-1, 1]) {
        k.strut(sx * 2.4, 0, z + 1.6, sx * 0.8, 9 + z * 0.11, z, 0.24, C.galv,
          { ao: 0.4, aoHeight: 6 });
      }
      k.strut(-2.4, 3.4, z + 1.6, 2.4, 3.4, z + 1.6, 0.13, C.galv, { ao: 0.4, aoHeight: 6 });
    }
    k.box(0, 4.5, 26, 6, 9, 6, C.steel, { ao: 0.4, aoHeight: 6 });
    k.cyl(0, 5, -27, 4.0, 4.0, 10, 12, C.rust, { ao: 0.4, aoHeight: 6 });
  }, 0.4);
}

// ── the start/finish event ─────────────────────────────────────────────────

/**
 * A levelled works pad.
 *
 * The embankment falls away from the shoulder fast enough that anything
 * standing in it disappears behind the barrier from a chase camera. Real sites
 * solve this the same way: they cut a flat platform. Everything in a compound
 * stands on one of these, which puts it back at road level where it can be seen
 * — and a squared-off pad with a battered edge reads as somebody's yard rather
 * than as props floating on a slope.
 *
 * The plinth runs eight metres down so it always meets the ground it is cut
 * into, however far the embankment has dropped by.
 */
export function padGeo(
  w = 34, d = 26, pal: LandPalette = LAND_PALETTES.canyon,
): THREE.BufferGeometry {
  return buildProp('pad', (k) => {
    // Battered sides: a slab with vertical faces reads as a floating box. The
    // cut is in whatever this landscape is made of — the platform is imported
    // hardcore, so only the running surface stays the same everywhere.
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const y = -0.1 - t * 8;
      const g = 1 + t * 0.55;
      k.box(0, y, 0, w * g, 0.1, d * g, i === 0 ? pal.soil : pal.soilDark,
        { noAo: true, shade: 1 - t * 0.32 });
    }
    k.box(0, -4.1, 0, w * 1.3, 8.2, d * 1.3, pal.soilDark, { noAo: true, shade: 0.72 });
    k.box(0, 0.02, 0, w, 0.16, d, C.concrete, { noAo: true, shade: 0.96 });
    // A kerb of scalped hardcore around the rim, so the edge has a line.
    for (const sx of [-1, 1]) k.box(sx * w * 0.5, 0.1, 0, 0.7, 0.3, d, pal.soilDark, { noAo: true });
    for (const sz of [-1, 1]) k.box(0, 0.1, sz * d * 0.5, w, 0.3, 0.7, pal.soilDark, { noAo: true });
  }, 0);
}

/**
 * A grandstand: raked terraces, a roof on trusses, a sponsor fascia.
 *
 * Built in its own frame with the seats facing +Z, so it can be dropped beside
 * any straight and simply turned to face the road, and standing on a plinth
 * that runs well below its feet — it is placed at *road* level, not at ground
 * level, or the front row would be looking at the back of a barrier.
 */
export function grandstandGeo(bays = 7): THREE.BufferGeometry {
  return buildProp('grandstand', (k) => {
    const W = bays * 3.4, ROWS = 9, RISE = 0.52, TREAD = 0.95;
    const backZ = -ROWS * TREAD - 1.4;

    // Plinth.
    k.box(0, -4.4, backZ * 0.5 + 0.8, W + 2.4, 9, Math.abs(backZ) + 3.6, C.concreteDark,
      { noAo: true, shade: 0.74 });
    k.box(0, 0.1, backZ * 0.5 + 0.8, W + 2.8, 0.5, Math.abs(backZ) + 4.0, C.concrete,
      { noAo: true, shade: 0.9 });

    // Deck: one step per row, each one a slab you can see the edge of.
    for (let r = 0; r < ROWS; r++) {
      const y = 0.55 + r * RISE, z = -r * TREAD;
      k.box(0, y - 0.12, z, W, 0.24, TREAD + 0.02, C.concrete,
        { ao: 0.5, aoHeight: 3.4, shade: r % 2 ? 1.0 : 0.94 });
      k.box(0, y - 0.42, z - TREAD * 0.5, W, 0.62, 0.16, C.concreteDark,
        { ao: 0.55, aoHeight: 3.4 });
    }
    // Understructure, so the stand is not floating on nothing.
    for (let i = 0; i <= bays; i++) {
      const x = -W / 2 + i * 3.4;
      k.strut(x, 0, 0.9, x, 0.5, 0.9, 0.18, C.steelDark, { ao: 0.6, aoHeight: 2 });
      k.strut(x, 0, backZ + 1, x, 0.5 + ROWS * RISE, backZ + 1, 0.18, C.steelDark,
        { ao: 0.5, aoHeight: 4 });
      k.strut(x, 0.4, 0.9, x, 0.5 + ROWS * RISE * 0.9, backZ + 1.6, 0.12, C.steelDark,
        { ao: 0.5, aoHeight: 4 });
    }
    // Front safety rail. Two rails and the posts, not a sheet: the front row is
    // the row every camera is closest to, and a metre of solid steel across it
    // hides exactly the people worth having.
    k.box(0, 1.05, 1.15, W, 0.14, 0.16, C.orange, { ao: 0.35, aoHeight: 2.4 });
    k.box(0, 0.66, 1.15, W, 0.1, 0.08, C.steel, { ao: 0.45, aoHeight: 2.4, shade: 0.92 });
    k.box(0, 0.3, 1.15, W, 0.1, 0.08, C.steel, { ao: 0.5, aoHeight: 2.4, shade: 0.92 });
    for (let i = 0; i <= bays * 2; i++) {
      k.strut(-W / 2 + i * 1.7, 0.1, 1.15, -W / 2 + i * 1.7, 1.1, 1.15, 0.05, C.steelDark,
        { ao: 0.4, aoHeight: 2.4 });
    }
    // Back wall, in course colours.
    k.box(0, 3.4, backZ, W, 6.8, 0.3, C.navy, { ao: 0.4, aoHeight: 5 });
    k.box(0, 5.4, backZ + 0.2, W, 1.6, 0.1, C.orange, { ao: 0.25, aoHeight: 6 });
    k.box(0, 3.1, backZ + 0.2, W, 0.5, 0.08, C.yellow, { ao: 0.35, aoHeight: 6 });
    // Roof: cantilevered trusses and a deck, with a fascia over the front edge.
    const roofY = 0.5 + ROWS * RISE + 3.2;
    for (let i = 0; i <= bays; i++) {
      const x = -W / 2 + i * 3.4;
      k.strut(x, roofY - 0.2, backZ + 1, x, roofY + 0.5, 1.6, 0.15, C.steel, { noAo: true });
      k.strut(x, roofY - 1.6, backZ + 1, x, roofY + 0.3, -1.5, 0.1, C.steel, { noAo: true });
    }
    k.push();
    k.move(0, roofY + 0.5, (backZ + 1.6) * 0.5).rotX(-0.085);
    k.box(0, 0, 0, W + 0.6, 0.22, Math.abs(backZ) + 3.4, C.offWhite, { noAo: true });
    k.pop();
    k.box(0, roofY + 1.1, 1.7, W + 0.6, 1.3, 0.22, C.orange, { noAo: true });
    k.box(0, roofY + 1.1, 1.83, W - 1.4, 0.7, 0.06, C.white, { noAo: true });
  }, 0.4);
}

/** A stepped viewing bank of scaffolding — the cheap seats at a corner. Also
 *  placed at road level, on its own cut platform. */
export function terraceGeo(): THREE.BufferGeometry {
  return buildProp('terrace', (k) => {
    const W = 13, ROWS = 5;
    // The block, cut back so its front face lands just behind the front rail.
    // The first version was twelve metres deep and stood three metres in front
    // of its own front row, which put a slab of bare dirt between the camera
    // and every spectator on it — the "brown plinth topped with confetti" read.
    k.box(0, -4.4, -3.9, W + 3, 9, 10, C.dirtDark, { noAo: true, shade: 0.68 });
    k.box(0, 0.06, -3.9, W + 3.4, 0.3, 10.4, C.dirt, { noAo: true, shade: 0.9 });
    // Faced front: capping beam, a band of panels, a plinth course. These stand
    // at road level on ground that has already fallen away, so this wall is the
    // first thing anybody sees of the terrace.
    k.box(0, -0.24, 1.25, W + 3.4, 0.6, 0.34, C.concrete, { noAo: true, shade: 1.0 });
    for (let i = 0; i < 5; i++) {
      const panels = [BOARD.clay, BOARD.deep, BOARD.ochre, BOARD.slate, BOARD.bone];
      k.box((-0.5 + (i + 0.5) / 5) * (W + 3), -1.34, 1.2, ((W + 3) / 5) * 0.95, 1.6,
        0.3, panels[i]!, { noAo: true, shade: 0.84 });
    }
    k.box(0, -2.3, 1.22, W + 3.4, 0.32, 0.34, C.concreteDark, { noAo: true, shade: 0.86 });
    k.box(0, -4.6, 1.14, W + 3.2, 4.4, 0.26, C.concreteDark, { noAo: true, shade: 0.6 });

    for (let r = 0; r < ROWS; r++) {
      const y = 0.5 + r * 0.55, z = -r * 1.05;
      for (let i = 0; i < 5; i++) {
        k.box(-W / 2 + 1.3 + i * 2.6, y, z, 2.5, 0.1, 1.0, C.timber,
          { ao: 0.45, aoHeight: 3, shade: i % 2 ? 1.0 : 0.93 });
      }
      for (let i = 0; i <= 4; i++) {
        const x = -W / 2 + i * 3.25;
        k.strut(x, 0, z, x, y, z, 0.07, C.galv, { ao: 0.5, aoHeight: 3 });
        k.strut(x, 0, z, x, y, z - 1.05, 0.05, C.galv, { ao: 0.5, aoHeight: 3 });
      }
    }
    k.box(0, 0.62, 0.72, W, 1.05, 0.06, C.orange, { ao: 0.4, aoHeight: 3, shade: 0.94 });
    k.strut(-W / 2, 1.15, 0.72, W / 2, 1.15, 0.72, 0.06, C.galv, { ao: 0.3, aoHeight: 3 });
    // A scaffold back wall with a run of pennants, so the terrace has a top
    // line instead of ending in a fuzzy edge of heads.
    const backZ = -ROWS * 1.05 - 0.4;
    for (let i = 0; i <= 4; i++) {
      const x = -W / 2 + i * 3.25;
      k.strut(x, 0, backZ, x, 4.6, backZ, 0.07, C.galv, { noAo: true });
      if (i === 4) continue;
      k.box(x + 1.62, 4.05, backZ, 3.0, 0.66, 0.05,
        [BOARD.clay, BOARD.bone, BOARD.slate, BOARD.ochre][i]!, { noAo: true });
    }
    k.box(0, 2.5, backZ, W, 1.9, 0.16, C.concreteDark, { noAo: true, shade: 0.82 });
    k.strut(-W / 2, 4.66, backZ, W / 2, 4.66, backZ, 0.06, C.orange, { noAo: true });
  }, 0.45);
}

/** A marshal post: a raised box, a striped pole and an extinguisher board. */
export function marshalPostGeo(): THREE.BufferGeometry {
  return buildProp('marshalPost', (k) => {
    k.box(0, 0.14, 0, 2.6, 0.28, 2.2, C.concreteDark, { ao: 0.6 });
    for (const sx of [-1, 1]) {
      k.strut(sx * 1.2, 0.28, -1.0, sx * 1.2, 2.5, -1.0, 0.07, C.galv, { ao: 0.4, aoHeight: 2.4 });
      k.strut(sx * 1.2, 0.28, 1.0, sx * 1.2, 2.5, 1.0, 0.07, C.galv, { ao: 0.4, aoHeight: 2.4 });
    }
    k.box(0, 2.62, 0, 2.9, 0.16, 2.6, C.orange, { noAo: true });
    k.box(0, 0.9, -1.05, 2.5, 1.2, 0.1, C.white, { ao: 0.45, aoHeight: 2.4 });
    k.box(0, 0.9, -1.12, 2.5, 0.36, 0.05, C.red, { ao: 0.45, aoHeight: 2.4 });
    k.box(0.95, 0.72, 1.06, 0.5, 0.86, 0.34, C.red, { ao: 0.5, aoHeight: 2 });
    for (let i = 0; i < 5; i++) {
      k.cyl(-1.6, 0.3 + i * 0.5, 0, 0.09, 0.09, 0.5, 6, i % 2 ? C.white : C.red,
        { ao: 0.35, aoHeight: 2.4 });
    }
  }, 0.45);
}

/** A bare flagpole. The flag itself is a separate kind, because it ripples and
 *  therefore lives on the cloth material. */
export function flagPoleGeo(h = 7): THREE.BufferGeometry {
  return buildProp('flagPole', (k) => {
    k.cyl(0, 0.22, 0, 0.34, 0.44, 0.44, 8, C.concreteDark, { ao: 0.55 });
    k.cyl(0, h * 0.5, 0, 0.06, 0.11, h, 7, C.galv, { ao: 0.4, aoHeight: 3 });
    k.sph(0, h + 0.12, 0, 0.13, C.yellow, 6, { noAo: true });
  }, 0.5);
}

// ── things that flap ───────────────────────────────────────────────────────

/**
 * A flag on a mast.
 *
 * Authored in the XY plane with the hoist at x=0 so the ripple travels along x
 * and the weight ramps away from the pole — nothing ever detaches from its mast.
 *
 * It carries actual artwork, which sounds like a detail and is not: the first
 * version was one flat rectangle with a stripe along the bottom, and beside the
 * grandstand it read as an untextured placeholder rather than as a flag. Three
 * designs — chevron, bands, roundel — is enough that a line of masts down the
 * pit straight looks like a set of course flags instead of a set of swatches.
 *
 * Only the main field uses the position-driven ripple weight: `aAmp` is
 * evaluated in each *primitive's* own frame, so a rotated bar would get a
 * weight that runs along the bar rather than along the flag. Every applied mark
 * therefore takes a constant weight from where it sits on the flag instead.
 */
export function flagGeo(
  w = 2.6, h = 1.7, color: number = C.orange, accent: number = C.white,
  design = 0,
): THREE.BufferGeometry {
  const PH = 0.31;
  return buildProp('flag', (k) => {
    /**
     * One patch of the flag, in fractions: `u` along the hoist-to-fly axis,
     * `v` up the height. Every patch derives its own ripple weight from where
     * it sits, which is the whole trick — a patch that took a constant weight
     * would ride rigidly through a field that is bending underneath it and poke
     * straight through the front of the flag.
     */
    const quad = (
      u0: number, u1: number, v0: number, v1: number, col: number, z: number,
    ): void => {
      const uc = (u0 + u1) * 0.5;
      const du = u1 - u0;
      const amp = (x: number): number => { const t = uc + x * du; return t * t; };
      const seg = Math.max(1, Math.round(du * 8));
      k.panel(w * uc, h * (v0 + v1) * 0.5, z, w * du, h * (v1 - v0), col,
        { noAo: true, amp, phase: PH }, seg, 1);
      // The reverse. The cloth material is double-sided, so a mark applied only
      // to the front leaves a plain rectangle on the back — and from half the
      // camera angles on the circuit the back is the side you see. That was
      // exactly the "blank cyan trapezoid beside the grandstand".
      if (z !== 0) {
        k.panel(w * uc, h * (v0 + v1) * 0.5, -z, w * du, h * (v1 - v0), col,
          { noAo: true, amp, phase: PH }, seg, 1);
      }
    };

    quad(0, 1, -0.5, 0.5, color, 0);
    // The hoist band. Dark on every design, so a flag has a hard edge where it
    // meets the mast instead of fading into the sky.
    quad(0, 0.1, -0.5, 0.5, C.ink, 0.01);

    switch (design % 3) {
      case 0: {
        // A chevron pointing down the fly, stepped rather than rotated.
        const N = 5;
        for (let i = 0; i < N; i++) {
          const v = -0.44 + (i / (N - 1)) * 0.88;
          const u = 0.28 + (1 - Math.abs(v) / 0.44) * 0.26;
          quad(u, u + 0.2, v - 0.1, v + 0.1, accent, 0.012);
          quad(u + 0.3, u + 0.5, v - 0.1, v + 0.1, accent, 0.012);
        }
        break;
      }
      case 1: {
        // Bands and a hoist block: the plainest thing that still reads as a
        // design rather than as a blank swatch.
        quad(0.12, 1, 0.16, 0.42, accent, 0.012);
        quad(0.12, 1, -0.42, -0.16, accent, 0.012);
        quad(0.16, 0.34, -0.22, 0.22, accent, 0.014);
        break;
      }
      default: {
        // Quartered, with a bar across the fly.
        quad(0.12, 0.52, 0.02, 0.48, accent, 0.012);
        quad(0.52, 0.92, -0.48, -0.02, accent, 0.012);
        quad(0.9, 1, -0.5, 0.5, accent, 0.014);
        break;
      }
    }
  }, 0);
}

/** A line of bunting between two poles, sagging in the middle. */
export function buntingGeo(span = 14): THREE.BufferGeometry {
  return buildProp('bunting', (k) => {
    const N = 18;
    const cols = [C.orange, C.yellow, C.white, C.cyan];
    const amp = (_x: number, y: number): number => Math.min(1, Math.max(0, -y / 0.55));
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const z = (t - 0.5) * span;
      const sag = -Math.sin(t * Math.PI) * 1.5;
      if (i < N) {
        const t2 = (i + 1) / N;
        const z2 = (t2 - 0.5) * span;
        const sag2 = -Math.sin(t2 * Math.PI) * 1.5;
        k.strut(0, sag, z, 0, sag2, z2, 0.035, C.ink, { noAo: true });
      }
      if (i === N) continue;
      k.push();
      k.move(0, sag - 0.05, z + span / N * 0.5).rotY(Math.PI * 0.5);
      k.panel(0, -0.28, 0, 0.42, 0.55, cols[i % cols.length]!,
        { noAo: true, amp, phase: (i * 0.37) % 1 }, 1, 2);
      k.pop();
    }
  }, 0);
}

/** A vent: a capped pipe with a column of steam standing on it. The puffs are
 *  authored at the origin — the vertex program lifts and grows them. */
export function ventPipeGeo(): THREE.BufferGeometry {
  return buildProp('ventPipe', (k) => {
    k.cyl(0, 0.1, 0, 0.85, 0.95, 0.2, 12, C.concreteDark, { ao: 0.6 });
    k.cyl(0, 0.75, 0, 0.42, 0.48, 1.3, 10, C.rust, { ao: 0.45, aoHeight: 1.6 });
    k.cyl(0, 1.46, 0, 0.56, 0.5, 0.16, 10, C.steelDark, { ao: 0.3, aoHeight: 1.8 });
    for (let i = 0; i < 4; i++) {
      k.box(0, 1.6, 0, 0.14, 0.16, 1.1, C.steelDark, { ao: 0.3, aoHeight: 1.8 });
    }
  }, 0.5);
}

/** Seven puffs, all sitting on the origin. The vertex program lifts, grows and
 *  pinches each one out on its own phase, so the column is continuous. */
export function steamGeo(): THREE.BufferGeometry {
  return buildProp('steam', (k) => {
    for (let i = 0; i < 7; i++) {
      k.sph(0, 0, 0, 1, 0xf2f6fa, 7,
        { noAo: true, amp: 0.55 + (i % 3) * 0.16, phase: i / 7 });
    }
  }, 0);
}

/** A soaring bird. Rides the crowd material: `aAmp` is the wing-tip weight, so
 *  the "bob" becomes a slow flap. */
export function birdGeo(): THREE.BufferGeometry {
  return buildProp('bird', (k) => {
    k.box(0, 0, 0, 0.18, 0.15, 0.7, 0x3a3630, { noAo: true, phase: 0.5 });
    k.box(0, 0.04, 0.42, 0.12, 0.1, 0.22, 0x2e2a26, { noAo: true, phase: 0.5 });
    k.push(); k.move(0, 0.03, 0).rotZ(0.16);
    k.box(0.52, 0, 0, 0.94, 0.05, 0.36, 0x2e2a26,
      { noAo: true, amp: (x) => x + 0.5, phase: 0.5 });
    k.pop();
    k.push(); k.move(0, 0.03, 0).rotZ(-0.16);
    k.box(-0.52, 0, 0, 0.94, 0.05, 0.36, 0x2e2a26,
      { noAo: true, amp: (x) => 0.5 - x, phase: 0.5 });
    k.pop();
  }, 0);
}

/** A rotating-beacon lens, on the glow material. */
export function beaconGeo(): THREE.BufferGeometry {
  return buildProp('beacon', (k) => {
    k.cyl(0, 0.14, 0, 0.10, 0.15, 0.28, 6, C.yellow, { noAo: true });
  }, 0);
}

/** The contact patch every prop drops on the dirt. The landscape is drawn
 *  unlit and receives no shadow map, so this is the only shadow out here. */
export function blobGeo(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI * 0.5);
  g.name = 'contact';
  return g;
}
