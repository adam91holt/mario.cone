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
import { C } from './look.ts';

// ── the small stuff you pass at arm's length ───────────────────────────────

/** One traffic cone. The game's mascot, standing in the run-off in its hundreds. */
export function coneGeo(): THREE.BufferGeometry {
  return buildProp('cone', (k) => {
    k.box(0, 0.03, 0, 0.46, 0.06, 0.46, C.ink, { ao: 0.3 });
    k.box(0, 0.085, 0, 0.34, 0.06, 0.34, C.ink, { ao: 0.3 });
    k.cone(0, 0.1, 0, 0.175, 0.8, 9, C.orange, { aoHeight: 0.5 });
    k.cyl(0, 0.38, 0, 0.118, 0.135, 0.14, 9, C.white, { ao: 0.12 });
    k.cyl(0, 0.58, 0, 0.068, 0.085, 0.10, 9, C.white, { ao: 0.08 });
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
    const cap = [C.white, C.orange, C.yellow];
    for (let i = 0; i < 4; i++) {
      k.push();
      k.rotY(i * 0.5);
      k.cyl(0, 0.16 + i * 0.3, 0, 0.52, 0.52, 0.3, 12, i === 3 ? cap[0]! : C.ink,
        { ao: 0.35, aoHeight: 1.3 });
      k.cyl(0, 0.16 + i * 0.3, 0, 0.34, 0.34, 0.33, 10, C.steelDark, { ao: 0.4 });
      k.pop();
    }
    k.cyl(0, 1.32, 0, 0.5, 0.5, 0.08, 12, cap[1]!, { ao: 0.1 });
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
export function spoilHeapGeo(): THREE.BufferGeometry {
  return buildProp('spoil', (k) => {
    k.cone(0, 0, 0, 2.6, 2.0, 9, C.dirt, { ao: 0.45, aoHeight: 2.2 });
    k.push();
    k.move(1.4, 0, -0.9).rotY(0.6);
    k.cone(0, 0, 0, 1.7, 1.3, 8, C.dirtDark, { ao: 0.45, aoHeight: 2.2 });
    k.pop();
    k.push();
    k.move(-1.1, 0, 1.3).rotY(1.9);
    k.cone(0, 0, 0, 1.4, 1.0, 8, C.dirt, { ao: 0.45, aoHeight: 2.2, shade: 1.08 });
    k.pop();
  }, 0.45);
}

export function boulderGeo(): THREE.BufferGeometry {
  return buildProp('boulder', (k) => {
    k.push();
    k.scale(1, 0.72, 0.88);
    k.sph(0, 0.55, 0, 1.0, C.rust, 6, { ao: 0.4, aoHeight: 1.4, shade: 0.92 });
    k.pop();
    k.push();
    k.move(0.7, 0.2, 0.4).rotY(0.9).scale(0.9, 0.6, 0.7);
    k.sph(0, 0.4, 0, 0.7, C.dirtDark, 6, { ao: 0.4, aoHeight: 1.4 });
    k.pop();
  }, 0.45);
}

export function scrubGeo(): THREE.BufferGeometry {
  return buildProp('scrub', (k) => {
    const sage = 0x7d8a4e;
    k.push(); k.scale(1, 0.62, 1);
    k.sph(0, 0.62, 0, 0.72, sage, 6, { ao: 0.45, aoHeight: 1.0 });
    k.pop();
    k.push(); k.move(0.62, 0, 0.3).scale(1, 0.55, 1);
    k.sph(0, 0.46, 0, 0.5, 0x6d7a42, 6, { ao: 0.45, aoHeight: 1.0 });
    k.pop();
    k.push(); k.move(-0.5, 0, -0.42).scale(1, 0.5, 1);
    k.sph(0, 0.4, 0, 0.44, 0x8b975a, 5, { ao: 0.45, aoHeight: 1.0 });
    k.pop();
  }, 0.45);
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
 * A grandstand: raked terraces, a roof on trusses, a sponsor fascia.
 *
 * Built in its own frame with the seats facing +Z, so it can be dropped beside
 * any straight and simply turned to face the road.
 */
export function grandstandGeo(bays = 7): THREE.BufferGeometry {
  return buildProp('grandstand', (k) => {
    const W = bays * 3.4, ROWS = 9, RISE = 0.52, TREAD = 0.95;
    const backZ = -ROWS * TREAD - 1.4;

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
    // Front safety rail and its debris fence.
    k.box(0, 1.05, 1.15, W, 0.14, 0.16, C.orange, { ao: 0.35, aoHeight: 2.4 });
    k.box(0, 0.62, 1.15, W, 1.0, 0.06, C.steel, { ao: 0.45, aoHeight: 2.4, shade: 0.9 });
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

/** A stepped viewing bank of scaffolding — the cheap seats at a corner. */
export function terraceGeo(): THREE.BufferGeometry {
  return buildProp('terrace', (k) => {
    const W = 13, ROWS = 5;
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

/** A flag on a mast. Authored in the XY plane so the ripple travels along x,
 *  with the weight ramping away from the pole. */
export function flagGeo(w = 2.6, h = 1.7, color = C.orange, accent = C.white): THREE.BufferGeometry {
  return buildProp('flag', (k) => {
    const amp = (x: number): number => {
      const t = (x + 0.5);
      return t * t;
    };
    k.push();
    k.move(w * 0.5, 0, 0).scale(w, h, 1);
    k.panel(0, 0, 0, 1, 1, color, { noAo: true, amp, phase: 0.31 }, 8, 2);
    k.panel(0, -0.34, 0.01, 1, 0.22, accent, { noAo: true, amp, phase: 0.31 }, 8, 1);
    k.pop();
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

export function steamGeo(): THREE.BufferGeometry {
  return buildProp('steam', (k) => {
    for (let i = 0; i < 7; i++) {
      k.push();
      k.move(0, 1.7, 0);
      k.sph(0, 0, 0, 1, 0xf2f6fa, 7,
        { noAo: true, amp: 0.55 + (i % 3) * 0.16, phase: i / 7 });
      k.pop();
    }
  }, 0);
}

/** A bird. Two wings and a body; the flap is in the vertex program. */
export function birdGeo(): THREE.BufferGeometry {
  return buildProp('bird', (k) => {
    const amp = (x: number): number => Math.abs(x) * 2;
    k.box(0, 0, 0, 0.16, 0.14, 0.62, 0x3a3630, { noAo: true, phase: 0 });
    k.push(); k.move(0, 0.02, 0.02).rotZ(0.22);
    k.box(0.42, 0, 0, 0.8, 0.05, 0.34, 0x2e2a26, { noAo: true, amp, phase: 0 });
    k.pop();
    k.push(); k.move(0, 0.02, 0.02).rotZ(-0.22);
    k.box(-0.42, 0, 0, 0.8, 0.05, 0.34, 0x2e2a26, { noAo: true, amp, phase: 0 });
    k.pop();
  }, 0);
}

/** A rotating-beacon lens, on the glow material. */
export function beaconGeo(): THREE.BufferGeometry {
  return buildProp('beacon', (k) => {
    k.cyl(0, 0.1, 0, 0.13, 0.15, 0.2, 8, C.yellow, { noAo: true });
    k.sph(0, 0.22, 0, 0.14, C.yellow, 7, { noAo: true });
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
