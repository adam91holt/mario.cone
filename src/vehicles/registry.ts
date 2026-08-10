// The cast.
//
// Seven machines off a roadworks site. Each one has to be identifiable as a
// pure black silhouette at thumbnail size, each one has to have a face you can
// read at 200km/h, and each one trades stats differently so picking one
// actually changes how the race plays.
//
// How a racer is put together:
//
//   root      — carries the simulation transform and nothing else. Wheels hang
//               off it, because wheels belong to the road, not to the body.
//   chassis   — everything that leans, dives, squats and shudders (see rig.ts).
//   shell     — the static geometry inside the chassis. Merged at build time
//               into one mesh per material, which is what buys the detail
//               budget: a shell can be forty little bevelled lumps and still
//               cost four draw calls.
//
// Anything that animates lives outside the shell: faces, beacons, arms, rotors,
// tipping trays, coupling rods.
//
// Stat budget: speed + accel + weight + handling + traction lands within a
// couple of hundredths of 3.02 for every racer, so nobody is strictly better
// than anybody else — they are only better at different things.
//
// **And each one has a driver, named here.** The cast is seven names out of the
// roadworks vocabulary, one bolted to each machine:
//
//   Road Cone     FOREMAN   the one running the site, in the machine it is named for
//   Sedan         BOLLARD   ordinary, everywhere, the one you learn on
//   Tipper Truck  SKIP      a steel bin with right of way
//   Digger        GRAVEL    loves the dirt
//   Shunter       BARRIER   long, heavy, and not stopping for you
//   Prop Plane    TARMAC    the only one that actually needs a runway
//   Chopper       DETOUR    goes over everything
//
// The pairing is fixed. It used to be dealt by grid index out of a list in
// `main.ts` against a machine pool the player's own pick had a hole punched in,
// so every rival changed machine when the player changed theirs — see the note
// on `driver` in types.ts. The player reads their name off the same field as
// everybody else, so choosing the plane makes you TARMAC and leaves FOREMAN out
// there in the cone.

import * as THREE from 'three';
import { clamp, clamp01, damp, lerp } from '../core/math.ts';
import {
  mat, METAL, CHROME, RUBBER, GLASS, LAMP,
  roundedBox, taperBox, lathe, part, pair,
  makeWheel, makeTrack, makeShadowBlob, makeSpinDisc, makeBeacon, makeGlow, makePuffs,
  mergeStatic, castShadows, disposeTree,
} from './parts.ts';
import { makeFace } from './face.ts';
import { createRig } from './rig.ts';
import type { WheelSpec } from './rig.ts';
import type { GameContext, VehicleDef, VehicleModel, Racer } from '../types.ts';

// ── shared palette ─────────────────────────────────────────────────────────

const ORANGE = 0xff6b1a;
const YELLOW = 0xffc300;
const WHITE = 0xfff8f0;
const ASPHALT = 0x3a3d46;
const DARK = 0x24262e;
const RED = 0xe33b2e;
const BLUE = 0x2e86d6;
const LIME = 0x8ec63f;
const STEEL = 0x8e99a8;
const RUST = 0xb3502a;
const BRASS = 0xe0a32e;

/** Per-model phase offset, so eight racers never bob or blink in lockstep. */
let buildCount = 0;

/** Critically-ish damped spring for secondary motion — wobbling tips, swinging
 *  arms, tipping trays. Substepped, so a 20fps capture behaves like 120. */
function makeSpring(freq: number, zeta = 0.4): (target: number, dt: number) => number {
  const k = freq * freq;
  const c = 2 * zeta * freq;
  let x = 0, v = 0;
  return (target: number, dt: number): number => {
    let remaining = Math.min(Math.max(dt, 0), 0.1);
    while (remaining > 0) {
      const h = Math.min(remaining, 1 / 120);
      v += ((target - x) * k - v * c) * h;
      x += v * h;
      remaining -= h;
    }
    return x;
  };
}

interface WheelPlacement {
  x: number;
  z: number;
  radius: number;
  width: number;
  steer?: number;
  rim?: number;
  tyre?: number;
  spokes?: number;
  treads?: number;
  cap?: boolean;
  droop?: number;
}

/** Place a set of wheels on the root and hand back their rig bindings. */
function addWheels(root: THREE.Object3D, list: WheelPlacement[]): WheelSpec[] {
  const out: WheelSpec[] = [];
  for (const w of list) {
    const obj = makeWheel({
      radius: w.radius, width: w.width, rimColor: w.rim, tyreColor: w.tyre,
      spokes: w.spokes, treads: w.treads, cap: w.cap,
    });
    obj.position.set(w.x, w.radius, w.z);
    root.add(obj);
    out.push({ obj, radius: w.radius, steer: w.steer ?? 0, droop: w.droop ?? 0.05 });
  }
  return out;
}

/** Vertical hazard stripes. The cast's shared visual accent. */
function hazardPanel(
  parent: THREE.Object3D, width: number, height: number, depth: number,
  pos: readonly [number, number, number], stripes = 6,
): void {
  const geo = roundedBox(width / stripes, height, depth, depth * 0.3);
  for (let i = 0; i < stripes; i++) {
    const x = (i / (stripes - 1) - 0.5) * (width - width / stripes);
    part(parent, geo, i % 2 ? mat(DARK) : mat(YELLOW), [pos[0] + x, pos[1], pos[2]]);
  }
}

// ── Road Cone ──────────────────────────────────────────────────────────────
//
// The mascot, and the one model that has to be *likeable* rather than merely
// legible. Everything about it is built to bounce: a soft lathe belly instead
// of a hard cone, a tip on its own spring that lags a whole beat behind the
// turn, and a face that takes up nearly a third of the body.

const CONE_PROFILE = [
  [0.62, 0.68], [0.61, 0.80], [0.57, 0.98], [0.50, 1.20],
  [0.42, 1.44], [0.33, 1.66], [0.23, 1.86], [0.13, 1.99], [0.0, 2.06],
] as const;

const CONE_SPLIT = 1.44; // where the wobbling tip is hinged, hidden by a band

function coneRadius(y: number): number {
  for (let i = 1; i < CONE_PROFILE.length; i++) {
    const a = CONE_PROFILE[i - 1]!, b = CONE_PROFILE[i]!;
    if (y <= b[1]) return lerp(a[0], b[0], clamp01((y - a[1]) / (b[1] - a[1])));
  }
  return 0;
}

/** A reflective band that hugs the body it is wrapped around. */
function coneBand(parent: THREE.Object3D, y0: number, y1: number, yOffset = 0): void {
  const r0 = coneRadius(y0) + 0.028;
  const r1 = coneRadius(y1) + 0.028;
  part(parent, new THREE.CylinderGeometry(r1, r0, y1 - y0, 22, 1),
    mat(WHITE, { roughness: 0.22, emissiveIntensity: 0.24 }),
    [0, (y0 + y1) / 2 - yOffset, 0]);
}

const cone: VehicleDef = {
  id: 'cone',
  name: 'Road Cone',
  driver: 'Foreman',
  blurb: 'Small, springy, and absolutely everywhere.',
  stats: { speed: 0.42, accel: 0.86, weight: 0.22, handling: 0.90, traction: 0.62 },
  colors: { primary: ORANGE, secondary: WHITE, accent: YELLOW },
  size: { length: 1.9, width: 1.6, height: 2.1 },
  build(): VehicleModel {
    const seed = buildCount++;
    const root = new THREE.Group();
    const chassis = new THREE.Group();
    const shell = new THREE.Group();
    chassis.add(shell);
    root.add(chassis);

    // Kart deck under the cone: it is a racer, not a prop somebody kicked.
    part(shell, roundedBox(1.18, 0.2, 1.62, 0.09), mat(ASPHALT), [0, 0.42, 0]);
    pair(shell, roundedBox(0.16, 0.14, 1.5, 0.06), mat(ASPHALT), [0.62, 0.42, 0.02]);
    part(shell, roundedBox(1.36, 0.13, 0.32, 0.05), mat(YELLOW), [0, 0.4, 0.78]);
    part(shell, roundedBox(1.36, 0.13, 0.28, 0.05), mat(YELLOW), [0, 0.4, -0.76]);
    // Rubber foot.
    part(shell, roundedBox(1.16, 0.16, 1.16, 0.07), RUBBER(0x1e2027), [0, 0.62, 0]);
    part(shell, roundedBox(1.24, 0.06, 1.24, 0.03), mat(DARK), [0, 0.54, 0]);

    // Body, in two pieces so the tip can lag behind the turn.
    const lower: Array<readonly [number, number]> = [];
    for (const p of CONE_PROFILE) if (p[1] < CONE_SPLIT) lower.push(p);
    lower.push([coneRadius(CONE_SPLIT), CONE_SPLIT]);
    part(shell, lathe(lower, 24), mat(ORANGE));
    // Cap the seam, or a high camera looks straight down inside the cone.
    part(shell, new THREE.CircleGeometry(coneRadius(CONE_SPLIT), 24), mat(ORANGE),
      [0, CONE_SPLIT, 0], [-Math.PI / 2, 0, 0]);
    coneBand(shell, 0.80, 1.02);

    const tip = new THREE.Group();
    tip.position.y = CONE_SPLIT;
    const upper: Array<readonly [number, number]> = [[coneRadius(CONE_SPLIT), 0]];
    for (const p of CONE_PROFILE) if (p[1] > CONE_SPLIT) upper.push([p[0], p[1] - CONE_SPLIT]);
    const tipShell = new THREE.Group();
    part(tipShell, lathe(upper, 24), mat(ORANGE));
    part(tipShell, new THREE.CircleGeometry(coneRadius(CONE_SPLIT), 24), mat(ORANGE),
      [0, 0, 0], [Math.PI / 2, 0, 0]);
    coneBand(tipShell, 1.58, 1.76, CONE_SPLIT);
    mergeStatic(tipShell);
    tip.add(tipShell);
    chassis.add(tip);

    // Face. Deliberately oversized — this is the character the game is named
    // after, and a small face on a small body reads as a road cone, not a hero.
    const face = makeFace({
      radius: 0.17, spacing: 0.2, bulge: 0.15, flatten: 0.62,
      mouthY: -0.18, mouthZ: 0.21, mouthWidth: 0.46, browColor: 0x6d2a0a, seed,
    });
    face.group.position.set(0, 1.3, 0.3);
    chassis.add(face.group);

    // Exhaust stubs, and the heat they make when a mini-turbo fires.
    pair(shell, new THREE.CylinderGeometry(0.07, 0.085, 0.32, 10), CHROME(),
      [0.24, 0.5, -0.9], [Math.PI / 2, 0, 0]);
    const glowA = makeGlow(0.1);
    const glowB = makeGlow(0.1);
    glowA.mesh.position.set(0.24, 0.5, -1.06);
    glowB.mesh.position.set(-0.24, 0.5, -1.06);
    chassis.add(glowA.mesh, glowB.mesh);

    const wheels = addWheels(root, [
      { x: -0.64, z: 0.62, radius: 0.31, width: 0.26, steer: 1, rim: YELLOW, treads: 10 },
      { x: 0.64, z: 0.62, radius: 0.31, width: 0.26, steer: 1, rim: YELLOW, treads: 10 },
      { x: -0.68, z: -0.6, radius: 0.35, width: 0.32, rim: YELLOW, treads: 12 },
      { x: 0.68, z: -0.6, radius: 0.35, width: 0.32, rim: YELLOW, treads: 12 },
    ]);

    mergeStatic(shell);
    root.add(makeShadowBlob(1.9, 2.1));
    castShadows(root);

    const rig = createRig({
      chassis, wheels, face, seed,
      roll: 0.16, driftRoll: 0.2, pitch: 0.07, squat: 0.05,
      buzz: 0.016, stretch: 0.07, yaw: 0.05,
      stiffness: 165, damping: 12,
    });

    const tipLean = makeSpring(9.5, 0.24);
    const tipNod = makeSpring(8, 0.28);

    return {
      root,
      parts: { body: chassis, tip, face: face.group },
      update: (racer: Racer, dt: number): void => {
        rig.update(racer, dt);
        const s = rig.state;
        // The tip trails the body: it leans out of the corner, not into it,
        // and it keeps wobbling for a beat after the kart has straightened up.
        tip.rotation.z = tipLean(s.turn * 0.3 + s.drift * 0.12, dt);
        tip.rotation.x = tipNod(-s.accel * 0.16 - s.boost * 0.2 + s.bump * 0.5, dt);
        glowA.set(s.boost);
        glowB.set(s.boost);
      },
      dispose: () => disposeTree(root),
    };
  },
};

// ── Car ────────────────────────────────────────────────────────────────────
// The all-rounder, and the reference point everything else is read against.
// Low, wide, big rear wheels — the one silhouette on the grid with no roofline
// above waist height, apart from its beacon.

const car: VehicleDef = {
  id: 'car',
  name: 'Sedan',
  driver: 'Bollard',
  blurb: 'Balanced in every direction. The one you learn on.',
  stats: { speed: 0.62, accel: 0.62, weight: 0.50, handling: 0.66, traction: 0.62 },
  colors: { primary: RED, secondary: WHITE, accent: DARK },
  size: { length: 3.4, width: 1.8, height: 1.6 },
  build(): VehicleModel {
    const seed = buildCount++;
    const root = new THREE.Group();
    const chassis = new THREE.Group();
    const shell = new THREE.Group();
    chassis.add(shell);
    root.add(chassis);

    const body = mat(RED);

    // Tub, bonnet and haunches. The rear arches are deliberately fatter than
    // the front — it reads as drive going to the back wheels.
    part(shell, roundedBox(1.68, 0.56, 2.5, 0.26), body, [0, 0.7, -0.18]);
    part(shell, taperBox(1.56, 0.4, 1.25, 0.86, 0.8, 0.16), body, [0, 0.72, 1.28]);
    pair(shell, roundedBox(0.28, 0.66, 1.25, 0.22), body, [0.78, 0.78, -1.0]);
    pair(shell, roundedBox(0.26, 0.5, 1.0, 0.2), body, [0.8, 0.66, 1.06]);

    // Cabin: glass wrapped in a cream roof, so the greenhouse reads dark and
    // the roof reads as a highlight from any angle.
    part(shell, taperBox(1.3, 0.46, 1.2, 0.9, 0.92, 0.18), mat(0x1b2836,
      { roughness: 0.1, metalness: 0.25, transparent: true, opacity: 0.86 }), [0, 1.16, -0.26]);
    part(shell, roundedBox(1.42, 0.18, 1.24, 0.1), mat(WHITE), [0, 1.42, -0.32]);
    // Rear pillar only: side pillars would swallow the greenhouse from the flank.
    part(shell, roundedBox(1.34, 0.44, 0.22, 0.1), body, [0, 1.16, -0.88]);

    // Wing, bumpers, lamps, pipes.
    part(shell, roundedBox(1.66, 0.09, 0.4, 0.04), mat(DARK), [0, 1.24, -1.5]);
    pair(shell, roundedBox(0.1, 0.3, 0.12, 0.04), mat(DARK), [0.66, 1.08, -1.48]);
    part(shell, roundedBox(1.78, 0.22, 0.28, 0.1), CHROME(), [0, 0.3, 1.7]);
    part(shell, roundedBox(1.74, 0.22, 0.26, 0.1), CHROME(), [0, 0.52, -1.56]);
    pair(shell, new THREE.CylinderGeometry(0.09, 0.1, 0.3, 10), CHROME(),
      [0.42, 0.42, -1.66], [Math.PI / 2, 0, 0]);
    pair(shell, roundedBox(0.3, 0.14, 0.16, 0.05), LAMP(0xff5a3c, 0.7), [0.62, 0.78, -1.62]);

    // Face: headlamps are the eyes, the radiator is the grin.
    const face = makeFace({
      radius: 0.19, spacing: 0.52, bulge: 0.1, flatten: 0.7,
      mouth: 'grille', mouthY: -0.4, mouthZ: 0.06, mouthWidth: 1.0,
      socket: 0x2b2e36, browColor: 0xa02a20, seed,
    });
    face.group.position.set(0, 0.86, 1.62);
    chassis.add(face.group);

    part(shell, new THREE.CylinderGeometry(0.15, 0.17, 0.08, 12), mat(0x2b2e36), [0, 1.5, 0.12]);
    const beacon = makeBeacon(0.13, 0xffa11a);
    beacon.group.position.set(0, 1.54, 0.12);
    chassis.add(beacon.group);

    const glow = makeGlow(0.13);
    glow.mesh.position.set(0, 0.42, -1.86);
    chassis.add(glow.mesh);

    const wheels = addWheels(root, [
      { x: -0.86, z: 1.18, radius: 0.4, width: 0.3, steer: 1, rim: WHITE },
      { x: 0.86, z: 1.18, radius: 0.4, width: 0.3, steer: 1, rim: WHITE },
      { x: -0.88, z: -1.02, radius: 0.46, width: 0.4, rim: WHITE, treads: 14 },
      { x: 0.88, z: -1.02, radius: 0.46, width: 0.4, rim: WHITE, treads: 14 },
    ]);

    mergeStatic(shell);
    root.add(makeShadowBlob(2.2, 3.4));
    castShadows(root);

    const rig = createRig({
      chassis, wheels, face, seed,
      roll: 0.13, driftRoll: 0.15, pitch: 0.05, squat: 0.045,
      buzz: 0.01, stretch: 0.05,
    });

    return {
      root,
      parts: { body: chassis, face: face.group, beacon: beacon.group },
      update: (racer: Racer, dt: number): void => {
        rig.update(racer, dt);
        beacon.update(dt, rig.state.boost);
        glow.set(rig.state.boost);
      },
      dispose: () => disposeTree(root),
    };
  },
};

// ── Truck ──────────────────────────────────────────────────────────────────
// Heavy. Shoves everyone aside, hates changing direction. Tall cab, high tray
// and a stack: nothing else on the grid has mass up that high.

const truck: VehicleDef = {
  id: 'truck',
  name: 'Tipper Truck',
  driver: 'Skip',
  blurb: 'Right of way is whatever it decides it is.',
  stats: { speed: 0.72, accel: 0.36, weight: 0.94, handling: 0.34, traction: 0.66 },
  colors: { primary: YELLOW, secondary: ASPHALT, accent: ORANGE },
  size: { length: 4.6, width: 2.2, height: 2.7 },
  build(): VehicleModel {
    const seed = buildCount++;
    const root = new THREE.Group();
    const chassis = new THREE.Group();
    const shell = new THREE.Group();
    chassis.add(shell);
    root.add(chassis);

    const cabMat = mat(YELLOW);

    part(shell, roundedBox(1.9, 0.34, 4.3, 0.12), mat(DARK), [0, 0.72, -0.1]);

    // Forward-control cab: flat face, deep chin, visor over the screen.
    part(shell, roundedBox(2.06, 1.36, 1.62, 0.26), cabMat, [0, 1.6, 1.16]);
    part(shell, roundedBox(1.86, 0.64, 0.16, 0.07), mat(0x22303c,
      { roughness: 0.12, metalness: 0.2, transparent: true, opacity: 0.82 }), [0, 1.96, 1.95]);
    part(shell, roundedBox(2.12, 0.16, 0.42, 0.07), cabMat, [0, 2.3, 1.86]);
    pair(shell, roundedBox(0.14, 0.5, 0.14, 0.05), CHROME(), [1.06, 1.86, 1.9]);
    pair(shell, roundedBox(0.44, 0.34, 0.1, 0.04), mat(0x22303c,
      { roughness: 0.12, metalness: 0.2, transparent: true, opacity: 0.8 }), [1.06, 1.9, 1.42]);

    // Chin, bumper and step — the heavy jaw that sells the weight.
    part(shell, roundedBox(2.14, 0.3, 0.36, 0.12), CHROME(), [0, 0.44, 2.02]);
    hazardPanel(shell, 1.94, 0.22, 0.16, [0, 0.19, 2.04], 7);

    // Exhaust stack behind the cab.
    part(shell, new THREE.CylinderGeometry(0.13, 0.15, 1.5, 12), CHROME(), [0.92, 2.05, 0.42]);
    part(shell, new THREE.CylinderGeometry(0.17, 0.13, 0.2, 12), mat(DARK), [0.92, 2.85, 0.42]);

    // Tipper tray, hinged at the back so it can lift.
    const tray = new THREE.Group();
    tray.position.set(0, 1.16, -2.16);
    const trayShell = new THREE.Group();
    const trayMat = mat(ASPHALT);
    part(trayShell, roundedBox(2.02, 0.2, 2.34, 0.06), trayMat, [0, 0.1, 1.2]);
    pair(trayShell, roundedBox(0.14, 0.72, 2.34, 0.06), trayMat, [0.94, 0.52, 1.2]);
    part(trayShell, roundedBox(2.02, 0.8, 0.14, 0.06), trayMat, [0, 0.56, 2.32]);
    hazardPanel(trayShell, 1.9, 0.62, 0.12, [0, 0.5, 0.06], 7);
    part(trayShell, roundedBox(2.06, 0.12, 2.4, 0.05), mat(ORANGE), [0, 0.9, 1.2]);
    mergeStatic(trayShell);
    tray.add(trayShell);
    // Spoil in the tray. It jiggles, so the load reads as loose.
    const rocks: THREE.Mesh[] = [];
    for (const [x, z, s] of [[-0.44, 1.72, 0.34], [0.38, 1.12, 0.42], [0.05, 2.0, 0.3]] as const) {
      rocks.push(part(tray, new THREE.DodecahedronGeometry(s, 0), mat(STEEL, { flat: true }), [x, 0.44, z]));
    }
    chassis.add(tray);

    // Face: headlamps low and wide, radiator grin between them.
    const face = makeFace({
      radius: 0.22, spacing: 0.66, bulge: 0.1, flatten: 0.72,
      mouth: 'grille', mouthY: -0.46, mouthZ: 0.04, mouthWidth: 1.16,
      socket: 0x2b2e36, browColor: 0xa06a00, seed,
    });
    face.group.position.set(0, 1.22, 2.0);
    chassis.add(face.group);

    pair(shell, new THREE.CylinderGeometry(0.16, 0.18, 0.08, 12), mat(0x2b2e36), [0.6, 2.34, 1.86]);
    const beaconA = makeBeacon(0.14, 0xffa11a);
    const beaconB = makeBeacon(0.14, 0xffa11a);
    beaconA.group.position.set(-0.6, 2.38, 1.86);
    beaconB.group.position.set(0.6, 2.38, 1.86);
    chassis.add(beaconA.group, beaconB.group);

    const smoke = makePuffs(3, 0.26, 0x5a5f68);
    smoke.group.position.set(0.92, 2.95, 0.42);
    chassis.add(smoke.group);

    const wheels = addWheels(root, [
      { x: -1.0, z: 1.5, radius: 0.58, width: 0.42, steer: 1, rim: STEEL, treads: 14 },
      { x: 1.0, z: 1.5, radius: 0.58, width: 0.42, steer: 1, rim: STEEL, treads: 14 },
      { x: -1.02, z: -0.6, radius: 0.56, width: 0.48, rim: STEEL, treads: 14 },
      { x: 1.02, z: -0.6, radius: 0.56, width: 0.48, rim: STEEL, treads: 14 },
      { x: -1.02, z: -1.86, radius: 0.56, width: 0.48, rim: STEEL, treads: 14 },
      { x: 1.02, z: -1.86, radius: 0.56, width: 0.48, rim: STEEL, treads: 14 },
    ]);

    mergeStatic(shell);
    root.add(makeShadowBlob(2.6, 4.6));
    castShadows(root);

    const rig = createRig({
      chassis, wheels, face, seed,
      roll: 0.09, driftRoll: 0.11, pitch: 0.06, squat: 0.03,
      buzz: 0.012, stretch: 0.03, stiffness: 110, damping: 11,
    });

    const trayTip = makeSpring(7, 0.3);
    const rockJiggle = makeSpring(13, 0.22);

    return {
      root,
      parts: { body: chassis, tray, face: face.group },
      update: (racer: Racer, dt: number): void => {
        rig.update(racer, dt);
        const s = rig.state;
        // Braking throws the load forward and the tray nose-down; power lifts
        // it. Ten centimetres of travel is plenty to read at speed.
        tray.rotation.x = trayTip(clamp(-s.accel * 0.05 - s.boost * 0.06 + s.bump * 0.2, -0.14, 0.1), dt);
        const j = rockJiggle(s.bump * 1.4 + (racer.grounded ? 0 : 0.05), dt);
        for (let i = 0; i < rocks.length; i++) {
          rocks[i]!.position.y = 0.44 + j * (0.7 + i * 0.12);
          rocks[i]!.rotation.z = j * (1.2 + i * 0.3);
        }
        beaconA.update(dt, s.boost);
        beaconB.update(dt, s.boost);
        smoke.update(dt, 0.25 + s.speedFrac * 0.9 + s.boost * 2.2, 1.1);
      },
      dispose: () => disposeTree(root),
    };
  },
};

// ── Digger ─────────────────────────────────────────────────────────────────
// Tracked, so it grips like nothing else — but slow, and it turns like it is
// annoyed about it. The arm is the character: it swings into corners, punches
// forward on a boost, and throws itself up when the digger gets hit.

const digger: VehicleDef = {
  id: 'digger',
  name: 'Digger',
  driver: 'Gravel',
  blurb: 'Grips anything. Overtakes nothing. Loves the dirt.',
  stats: { speed: 0.30, accel: 0.78, weight: 0.74, handling: 0.30, traction: 0.90 },
  colors: { primary: LIME, secondary: DARK, accent: RUST },
  size: { length: 3.8, width: 2.1, height: 2.8 },
  build(): VehicleModel {
    const seed = buildCount++;
    const root = new THREE.Group();
    const chassis = new THREE.Group();
    const shell = new THREE.Group();
    chassis.add(shell);
    root.add(chassis);

    const bodyMat = mat(LIME);

    // Tracks: low, long, and unmistakably two of them. A dark band under a
    // bright body is the reason this can never be confused with the truck.
    const sprockets: THREE.Object3D[] = [];
    for (const side of [-1, 1]) {
      const belt = makeTrack(3.0, 0.7, 0.44, 12);
      belt.position.set(side * 0.78, 0.35, 0);
      shell.add(belt);
      // Sprockets ride proud of the belt, because a wheel buried inside a
      // track is a wheel nobody can see turning.
      for (const z of [1.06, -1.06]) {
        const sprocket = new THREE.Group();
        part(sprocket, new THREE.CylinderGeometry(0.27, 0.27, 0.12, 14), METAL(STEEL),
          [0, 0, 0], [0, 0, Math.PI / 2]);
        for (let i = 0; i < 6; i++) {
          part(sprocket, roundedBox(0.14, 0.6, 0.14, 0.04), METAL(0x6f7885),
            [0, 0, 0], [(i / 6) * Math.PI, 0, 0]);
        }
        mergeStatic(sprocket);
        sprocket.position.set(side * 1.04, 0.35, z);
        chassis.add(sprocket);
        sprockets.push(sprocket);
      }
    }
    part(shell, roundedBox(1.4, 0.28, 2.0, 0.1), mat(DARK), [0, 0.6, 0]);

    // Upper house: it slews toward the corner, which is the digger's tell.
    const house = new THREE.Group();
    house.position.set(0, 0.74, 0);
    const houseShell = new THREE.Group();
    part(houseShell, new THREE.CylinderGeometry(0.72, 0.78, 0.16, 18), mat(DARK), [0, 0.04, 0]);
    part(houseShell, roundedBox(1.6, 0.46, 1.86, 0.16), bodyMat, [0, 0.36, -0.18]);
    // Counterweight, hazard-striped, hanging off the back.
    part(houseShell, roundedBox(1.5, 0.66, 0.44, 0.14), mat(DARK), [0, 0.42, -1.12]);
    hazardPanel(houseShell, 1.42, 0.5, 0.14, [0, 0.42, -1.36], 7);
    // Cab, offset to one side like the real thing, with a proper roof lip.
    part(houseShell, roundedBox(0.98, 1.14, 1.08, 0.18), bodyMat, [-0.5, 1.18, 0.32]);
    part(houseShell, roundedBox(0.86, 0.6, 0.14, 0.05), mat(0x1b2836,
      { roughness: 0.12, metalness: 0.2, transparent: true, opacity: 0.86 }), [-0.5, 1.3, 0.88]);
    pair(houseShell, roundedBox(0.12, 0.52, 0.62, 0.05), mat(0x1b2836,
      { roughness: 0.12, metalness: 0.2, transparent: true, opacity: 0.86 }), [0.0, 1.3, 0.34]);
    part(houseShell, roundedBox(1.12, 0.14, 1.22, 0.06), mat(WHITE), [-0.5, 1.82, 0.32]);
    // Engine deck and stack.
    part(houseShell, roundedBox(0.76, 0.42, 1.24, 0.14), bodyMat, [0.52, 0.8, -0.36]);
    part(houseShell, new THREE.CylinderGeometry(0.08, 0.1, 0.56, 10), CHROME(), [0.52, 1.24, 0.1]);
    mergeStatic(houseShell);
    house.add(houseShell);
    chassis.add(house);

    const face = makeFace({
      radius: 0.16, spacing: 0.22, bulge: 0.13, flatten: 0.72,
      mouth: 'grin', mouthY: -0.34, mouthZ: 0.1, mouthWidth: 0.46,
      browColor: 0x4a6417, seed,
    });
    face.group.position.set(-0.5, 1.36, 0.92);
    house.add(face.group);

    part(houseShell, new THREE.CylinderGeometry(0.14, 0.16, 0.08, 12), mat(0x2b2e36), [-0.5, 1.84, 0.0]);
    const beacon = makeBeacon(0.12, 0xffa11a);
    beacon.group.position.set(-0.5, 1.88, 0.0);
    house.add(beacon.group);

    // Arm: boom, stick, bucket. Three hinges is all it takes to act.
    const boom = new THREE.Group();
    boom.position.set(0.42, 1.16, 0.62);
    const boomShell = new THREE.Group();
    part(boomShell, roundedBox(0.3, 0.36, 1.8, 0.12), bodyMat, [0, 0.4, 0.7], [-0.52, 0, 0]);
    part(boomShell, new THREE.CylinderGeometry(0.18, 0.18, 0.4, 10), METAL(STEEL),
      [0, 0, 0], [0, 0, Math.PI / 2]);
    part(boomShell, new THREE.CylinderGeometry(0.1, 0.1, 0.7, 8), CHROME(), [0, 0.24, 0.62], [-0.52, 0, 0]);
    mergeStatic(boomShell);
    boom.add(boomShell);

    const stick = new THREE.Group();
    stick.position.set(0, 0.82, 1.36);
    const stickShell = new THREE.Group();
    part(stickShell, roundedBox(0.24, 0.3, 1.2, 0.1), bodyMat, [0, -0.38, 0.36], [0.9, 0, 0]);
    part(stickShell, new THREE.CylinderGeometry(0.14, 0.14, 0.32, 10), METAL(STEEL),
      [0, 0, 0], [0, 0, Math.PI / 2]);
    mergeStatic(stickShell);
    stick.add(stickShell);
    boom.add(stick);

    // Bucket, built as a box with the front left open — a lathe scoop reads as
    // a bean, and a bean is not a bucket.
    const bucket = new THREE.Group();
    bucket.position.set(0, -0.76, 0.68);
    const bucketShell = new THREE.Group();
    const bMat = mat(RUST, { roughness: 0.55 });
    part(bucketShell, roundedBox(0.86, 0.56, 0.14, 0.06), bMat, [0, 0.12, -0.3]);
    part(bucketShell, roundedBox(0.86, 0.16, 0.68, 0.06), bMat, [0, -0.2, 0.02]);
    part(bucketShell, roundedBox(0.86, 0.3, 0.16, 0.06), bMat, [0, -0.06, 0.3], [0.5, 0, 0]);
    pair(bucketShell, roundedBox(0.13, 0.5, 0.68, 0.06), bMat, [0.37, 0.02, 0.02]);
    for (let i = -2; i <= 2; i++) {
      part(bucketShell, taperBox(0.13, 0.11, 0.24, 0.45, 0.5, 0.03), METAL(0xa9b2bd),
        [i * 0.17, -0.24, 0.38], [-0.2, 0, 0]);
    }
    mergeStatic(bucketShell);
    bucket.add(bucketShell);
    stick.add(bucket);
    chassis.add(boom);

    mergeStatic(shell);
    root.add(makeShadowBlob(2.4, 3.4));
    castShadows(root);

    const rig = createRig({
      chassis, wheels: [], face, seed,
      roll: 0.07, driftRoll: 0.09, pitch: 0.04, squat: 0.03,
      buzz: 0.02, stretch: 0.02, stiffness: 130, damping: 14,
    });

    const boomSwing = makeSpring(7.5, 0.3);
    const stickSwing = makeSpring(8.5, 0.28);
    const bucketChomp = makeSpring(11, 0.3);
    const slew = makeSpring(6, 0.5);
    let trackRoll = 0;

    return {
      root,
      parts: { body: chassis, house, boom, stick, bucket, face: face.group },
      update: (racer: Racer, dt: number): void => {
        rig.update(racer, dt);
        const s = rig.state;

        // Sprockets turn with the ground the tracks are covering.
        trackRoll += (racer.speed / 0.35) * Math.min(dt, 0.1);
        for (const sp of sprockets) sp.rotation.x = trackRoll;

        // The house looks into the corner half a beat before the tracks do.
        house.rotation.y = slew(-s.turn * 0.24, dt);

        // Idle bob, a hard forward punch under boost, a recoil on a hit. The
        // arm does the emoting this machine's face is too small for.
        const idle = Math.sin(s.t * 2.6 + seed) * 0.05;
        // A hit throws the arm up and folds it in — a machine flinching. Down
        // would just plant the bucket through the road.
        boom.rotation.x = boomSwing(-0.12 + idle - s.boost * 0.45 - s.stun * 0.55 - s.air * 0.3, dt);
        stick.rotation.x = stickSwing(0.3 - idle * 1.4 + s.boost * 0.6 + s.stun * 0.75, dt);
        bucket.rotation.x = bucketChomp(
          0.15 + Math.sin(s.t * 3.4 + seed * 2) * 0.14 - s.boost * 0.6 + s.stun * 0.9, dt);
        beacon.update(dt, s.boost);
      },
      dispose: () => disposeTree(root),
    };
  },
};

// ── Train ──────────────────────────────────────────────────────────────────
// The heavyweight. Colossal top speed, turns like a building. Coupling rods
// on the driving wheels, steam off the chimney: the two details that make a
// locomotive read as machinery rather than as a cylinder with a hat.

const train: VehicleDef = {
  id: 'train',
  name: 'Shunter',
  driver: 'Barrier',
  blurb: 'Takes a while to wind up. Then good luck stopping it.',
  stats: { speed: 0.98, accel: 0.24, weight: 1.00, handling: 0.24, traction: 0.56 },
  colors: { primary: 0x1f2a2c, secondary: RED, accent: BRASS },
  size: { length: 4.8, width: 2.0, height: 2.8 },
  build(): VehicleModel {
    const seed = buildCount++;
    const root = new THREE.Group();
    const chassis = new THREE.Group();
    const shell = new THREE.Group();
    chassis.add(shell);
    root.add(chassis);

    const boilerMat = mat(0x1f2a2c);
    const trimMat = mat(BRASS, { roughness: 0.3, metalness: 0.55 });

    // Running plate and valances.
    part(shell, roundedBox(1.86, 0.24, 4.4, 0.08), mat(DARK), [0, 0.66, -0.1]);
    pair(shell, roundedBox(0.1, 0.3, 3.4, 0.05), mat(RED), [0.94, 0.5, 0.1]);

    // Boiler, smokebox and the ring that joins them.
    part(shell, new THREE.CylinderGeometry(0.78, 0.78, 2.5, 22), boilerMat,
      [0, 1.3, 0.5], [Math.PI / 2, 0, 0]);
    part(shell, new THREE.CylinderGeometry(0.84, 0.84, 0.62, 22), mat(0x15191c),
      [0, 1.3, 1.92], [Math.PI / 2, 0, 0]);
    part(shell, new THREE.TorusGeometry(0.8, 0.06, 6, 22), trimMat, [0, 1.3, 1.6]);
    part(shell, new THREE.TorusGeometry(0.8, 0.05, 6, 22), trimMat, [0, 1.3, 0.1]);
    part(shell, new THREE.CylinderGeometry(0.82, 0.82, 0.1, 22), mat(0x2a3033),
      [0, 1.3, 2.23], [Math.PI / 2, 0, 0]);

    // Chimney, dome and safety valve.
    part(shell, new THREE.CylinderGeometry(0.19, 0.24, 0.6, 14), mat(0x15191c), [0, 2.28, 1.62]);
    part(shell, lathe([[0.24, 0], [0.34, 0.1], [0.33, 0.2], [0.26, 0.22], [0.26, 0.1]], 14),
      trimMat, [0, 2.56, 1.62]);
    part(shell, lathe([[0.34, 0], [0.36, 0.12], [0.3, 0.28], [0.16, 0.36], [0, 0.38]], 14),
      trimMat, [0, 2.02, 0.5]);
    part(shell, new THREE.CylinderGeometry(0.1, 0.12, 0.24, 10), trimMat, [0, 2.02, -0.24]);

    // Cab: a proper box with a curved roof, cut-out windows and a red flank.
    const cabMat = mat(RED);
    part(shell, roundedBox(1.78, 1.44, 1.5, 0.16), cabMat, [0, 1.72, -1.4]);
    pair(shell, roundedBox(0.1, 0.5, 0.46, 0.06), mat(0x141b1f, { roughness: 0.2 }), [0.9, 2.0, -1.02]);
    part(shell, roundedBox(1.5, 0.5, 0.12, 0.06), mat(0x141b1f, { roughness: 0.2 }), [0, 2.0, -2.12]);
    part(shell, roundedBox(1.66, 0.5, 0.62, 0.1), mat(0x15191c), [0, 1.24, -2.06]);
    part(shell, roundedBox(1.9, 0.16, 1.66, 0.08), mat(0x15191c), [0, 2.52, -1.4]);
    part(shell, roundedBox(1.72, 0.2, 0.16, 0.07), trimMat, [0, 2.42, -0.62]);

    // Cowcatcher: five splayed slats, which reads far better than a wedge.
    for (let i = -3; i <= 3; i++) {
      part(shell, roundedBox(0.17, 0.72, 0.14, 0.05), mat(YELLOW),
        [i * 0.2, 0.44, 2.36], [0.62, 0, i * 0.1]);
    }
    part(shell, roundedBox(1.5, 0.14, 0.18, 0.06), mat(YELLOW), [0, 0.68, 2.2]);
    // Bottom rail: without it the slats read as dangling fingers rather than a
    // plough that would actually shove something off the rails.
    part(shell, roundedBox(1.42, 0.12, 0.16, 0.05), mat(YELLOW), [0, 0.14, 2.14]);
    part(shell, roundedBox(1.9, 0.28, 0.2, 0.08), cabMat, [0, 0.86, 2.36]);
    pair(shell, new THREE.CylinderGeometry(0.14, 0.14, 0.24, 10), CHROME(),
      [0.66, 0.86, 2.5], [Math.PI / 2, 0, 0]);

    // Lamp over the smokebox.
    part(shell, roundedBox(0.26, 0.26, 0.24, 0.06), mat(0x15191c), [0, 2.16, 1.98]);
    part(shell, new THREE.SphereGeometry(0.1, 12, 10), LAMP(0xfff3c4, 1.0), [0, 2.16, 2.12]);

    // Face on the smokebox door.
    const face = makeFace({
      radius: 0.21, spacing: 0.3, bulge: 0.14, flatten: 0.66,
      mouth: 'grin', mouthY: -0.44, mouthZ: 0.12, mouthWidth: 0.72,
      socket: 0xbba24a, browColor: 0x0d1113, seed,
    });
    face.group.position.set(0, 1.42, 2.16);
    chassis.add(face.group);

    const steam = makePuffs(4, 0.34, 0xf2efe6);
    steam.group.position.set(0, 2.72, 1.62);
    chassis.add(steam.group);

    // Driving wheels, then the rods that tie them together.
    const wheels = addWheels(root, [
      { x: -0.9, z: 1.24, radius: 0.5, width: 0.24, rim: RED, tyre: 0x15191c, spokes: 8, treads: 0, cap: false },
      { x: 0.9, z: 1.24, radius: 0.5, width: 0.24, rim: RED, tyre: 0x15191c, spokes: 8, treads: 0, cap: false },
      { x: -0.9, z: -0.12, radius: 0.6, width: 0.26, rim: RED, tyre: 0x15191c, spokes: 10, treads: 0, cap: false },
      { x: 0.9, z: -0.12, radius: 0.6, width: 0.26, rim: RED, tyre: 0x15191c, spokes: 10, treads: 0, cap: false },
      { x: -0.9, z: -1.44, radius: 0.6, width: 0.26, rim: RED, tyre: 0x15191c, spokes: 10, treads: 0, cap: false },
      { x: 0.9, z: -1.44, radius: 0.6, width: 0.26, rim: RED, tyre: 0x15191c, spokes: 10, treads: 0, cap: false },
    ]);

    const CRANK = 0.24;
    const rods: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const rod = new THREE.Group();
      const rodShell = new THREE.Group();
      part(rodShell, roundedBox(0.06, 0.12, 2.76, 0.025), METAL(0xc4ccd6), [0, 0, -0.1]);
      part(rodShell, new THREE.CylinderGeometry(0.075, 0.075, 0.1, 8), METAL(0xc4ccd6),
        [0, 0, 1.24], [0, 0, Math.PI / 2]);
      part(rodShell, new THREE.CylinderGeometry(0.075, 0.075, 0.1, 8), METAL(0xc4ccd6),
        [0, 0, -1.44], [0, 0, Math.PI / 2]);
      mergeStatic(rodShell);
      rod.add(rodShell);
      rod.position.set(side * 1.06, 0.6, 0);
      rod.userData.noShadow = true;
      rodShell.userData.noShadow = true;
      root.add(rod);
      rods.push(rod);
    }

    mergeStatic(shell);
    root.add(makeShadowBlob(2.4, 4.8));
    castShadows(root);

    const rig = createRig({
      chassis, wheels, face, seed,
      roll: 0.06, driftRoll: 0.08, pitch: 0.035, squat: 0.02,
      buzz: 0.014, stretch: 0.03, stiffness: 95, damping: 10,
    });

    let crankAngle = 0;
    return {
      root,
      parts: { body: chassis, face: face.group },
      update: (racer: Racer, dt: number): void => {
        rig.update(racer, dt);
        const s = rig.state;
        // The rods orbit the crank pin: same circle the wheel makes, offset a
        // quarter turn per side so the loco never sits on dead centre.
        crankAngle += (racer.speed / 0.6) * Math.min(dt, 0.1);
        for (let i = 0; i < rods.length; i++) {
          const a = crankAngle + (i === 0 ? 0 : Math.PI / 2);
          rods[i]!.position.y = 0.6 + Math.sin(a) * CRANK;
          rods[i]!.position.z = Math.cos(a) * CRANK;
        }
        steam.update(dt, 0.4 + s.speedFrac * 1.3 + s.boost * 2.6, 1.5);
      },
      dispose: () => disposeTree(root),
    };
  },
};

// ── Plane ──────────────────────────────────────────────────────────────────
// Fast and slippery, but light — it gets bullied in a scrum. Wings and a tail
// mean control surfaces, and control surfaces mean it can visibly *fly* the
// corner instead of driving it.

const plane: VehicleDef = {
  id: 'plane',
  name: 'Prop Plane',
  driver: 'Tarmac',
  blurb: 'Barely touches the ground. Barely needs to.',
  stats: { speed: 0.94, accel: 0.62, weight: 0.24, handling: 0.68, traction: 0.52 },
  colors: { primary: 0xf2f4f8, secondary: RED, accent: BLUE },
  size: { length: 3.9, width: 4.5, height: 1.9 },
  build(): VehicleModel {
    const seed = buildCount++;
    const root = new THREE.Group();
    const chassis = new THREE.Group();
    const shell = new THREE.Group();
    chassis.add(shell);
    root.add(chassis);

    const skin = mat(0xf2f4f8);
    const trim = mat(RED);
    const AXIS = 1.0; // fuselage centreline height

    // Fuselage as a surface of revolution laid along Z: fat in the middle,
    // pinched at the tail. A cartoon aeroplane, not a scale one.
    part(shell, lathe([
      [0.0, 0], [0.13, 0.22], [0.22, 0.6], [0.34, 1.25], [0.44, 2.0],
      [0.46, 2.55], [0.43, 3.05], [0.36, 3.4], [0.2, 3.6], [0, 3.72],
    ], 20), skin, [0, AXIS, -1.86], [Math.PI / 2, 0, 0]);

    // Cowl and its trim ring.
    part(shell, new THREE.CylinderGeometry(0.5, 0.47, 0.54, 18), trim,
      [0, AXIS, 1.52], [Math.PI / 2, 0, 0]);
    part(shell, new THREE.TorusGeometry(0.49, 0.05, 6, 18), mat(BLUE), [0, AXIS, 1.26]);
    // A painted grin under the goggles, on the front of the cowl.
    part(shell, new THREE.TorusGeometry(0.2, 0.045, 6, 14, Math.PI), mat(0x1b1d24),
      [0, AXIS - 0.14, 1.8], [0, 0, Math.PI]);
    pair(shell, roundedBox(0.06, 0.13, 2.3, 0.03), mat(BLUE), [0.4, AXIS - 0.1, -0.2]);

    // Canopy.
    part(shell, new THREE.SphereGeometry(0.33, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      GLASS(0x9fd8ff), [0, AXIS + 0.24, 0.42]);
    part(shell, roundedBox(0.48, 0.3, 0.68, 0.12), skin, [0, AXIS + 0.2, -0.04]);

    // Wings. The holder gives real dihedral: rotating the whole wing about the
    // centreline lifts the tip, which a rotation on the wing itself cannot.
    const DIHEDRAL = 0.09;
    const wingGeo = taperBox(0.98, 0.15, 2.1, 0.72, 0.8, 0.06);
    const tipOf = (x: number, y: number, side: number): [number, number] => {
      const c = Math.cos(side * DIHEDRAL), s2 = Math.sin(side * DIHEDRAL);
      return [x * c - y * s2, x * s2 + y * c];
    };
    for (const side of [-1, 1]) {
      const holder = new THREE.Group();
      holder.rotation.z = side * DIHEDRAL;
      shell.add(holder);
      part(holder, wingGeo, skin, [side * 1.2, AXIS + 0.18, 0.24], [0, side * Math.PI / 2, 0]);
      part(holder, roundedBox(0.16, 0.32, 0.66, 0.07), trim, [side * 2.22, AXIS + 0.22, 0.24]);
      part(holder, roundedBox(0.07, 0.54, 0.1, 0.03), mat(STEEL),
        [side * 0.94, AXIS - 0.14, 0.26], [0, 0, side * 0.42]);
    }

    // Tail.
    part(shell, taperBox(1.5, 0.12, 0.54, 0.72, 1, 0.05), skin, [0, AXIS + 0.06, -1.44]);
    part(shell, taperBox(0.1, 0.82, 0.7, 1, 0.62, 0.05), trim, [0, AXIS + 0.44, -1.5]);
    part(shell, roundedBox(0.4, 0.12, 0.24, 0.05), mat(BLUE), [0, AXIS + 0.86, -1.62]);

    // Control surfaces — the animation, so they stay outside the shell. Their
    // positions are lifted through the same dihedral the wings got.
    const [ailX, ailY] = tipOf(1.6, AXIS + 0.18, 1);
    const aileron = roundedBox(0.9, 0.11, 0.26, 0.04);
    const ailL = part(chassis, aileron, trim, [-ailX, ailY, -0.28]);
    const ailR = part(chassis, aileron, trim, [ailX, ailY, -0.28]);
    const elev = part(chassis, roundedBox(1.44, 0.11, 0.26, 0.04), trim, [0, AXIS + 0.06, -1.82]);
    const rud = part(chassis, roundedBox(0.09, 0.72, 0.26, 0.04), trim, [0, AXIS + 0.46, -1.94]);
    for (const m of [ailL, ailR, elev, rud]) m.userData.noShadow = true;

    // Prop: solid blades plus a disc that fades in as the revs climb.
    const prop = new THREE.Group();
    const propShell = new THREE.Group();
    const bladeGeo = taperBox(0.16, 0.78, 0.07, 0.55, 1, 0.03).translate(0, 0.44, 0);
    for (let i = 0; i < 3; i++) {
      part(propShell, bladeGeo, mat(DARK), [0, 0, 0], [0, 0, (i / 3) * Math.PI * 2]);
    }
    part(propShell, lathe([[0.0, 0], [0.14, 0.06], [0.17, 0.2], [0.1, 0.34], [0, 0.38]], 12),
      mat(YELLOW), [0, 0, 0.04], [Math.PI / 2, 0, 0]);
    mergeStatic(propShell);
    prop.add(propShell);
    prop.position.set(0, AXIS, 1.86);
    chassis.add(prop);

    const disc = makeSpinDisc(0.82, 0xdce8f2, 0.6);
    disc.position.set(0, AXIS, 1.84);
    chassis.add(disc);
    const discMat = disc.material as THREE.MeshBasicMaterial;

    // Goggles on the cowl, tipped up so they look down the runway.
    const face = makeFace({
      radius: 0.18, spacing: 0.25, bulge: 0.17, flatten: 0.62,
      mouth: 'none', socket: 0x6b1c13, browColor: 0x6b1c13, seed,
    });
    face.group.position.set(0, AXIS + 0.34, 1.34);
    face.group.rotation.x = -0.5;
    chassis.add(face.group);

    // Gear: chunky spatted legs, and a castoring tailwheel on a proper leg.
    pair(shell, roundedBox(0.3, 0.22, 0.56, 0.1), trim, [0.84, 0.66, 0.46]);
    pair(shell, roundedBox(0.11, 0.46, 0.14, 0.04), mat(STEEL), [0.84, 0.62, 0.46]);
    part(shell, roundedBox(0.12, 0.6, 0.14, 0.04), mat(STEEL), [0, 0.5, -1.52]);

    const wheels = addWheels(root, [
      { x: -0.84, z: 0.46, radius: 0.3, width: 0.2, rim: 0xdfe6ee, droop: 0.08 },
      { x: 0.84, z: 0.46, radius: 0.3, width: 0.2, rim: 0xdfe6ee, droop: 0.08 },
      { x: 0, z: -1.52, radius: 0.17, width: 0.14, steer: 1, rim: 0xdfe6ee, droop: 0.04 },
    ]);

    mergeStatic(shell);
    root.add(makeShadowBlob(4.2, 3.6));
    castShadows(root);

    const rig = createRig({
      chassis, wheels, face, seed,
      roll: 0.26, driftRoll: 0.26, pitch: 0.07, squat: 0.04,
      buzz: 0.008, stretch: 0.06, yaw: 0.06,
      stiffness: 180, damping: 12,
      express: (racer, s) => ({
        look: clamp(s.turn * 1.1, -1, 1),
        lookUp: s.air * 0.6 - s.boost * 0.25,
        squint: s.boost * 0.6 + s.speedFrac * 0.35,
        wide: s.air * 0.5 + s.stun * 0.9,
        angry: s.boost * 0.8 + Math.abs(s.turn) * 0.4,
        smile: 1,
        open: 0,
        dizzy: s.stun,
      }),
    });

    const wingFlex = makeSpring(6.5, 0.3);
    let propAngle = 0;

    return {
      root,
      parts: { body: chassis, prop, face: face.group },
      update: (racer: Racer, dt: number): void => {
        rig.update(racer, dt);
        const s = rig.state;
        const rpm = 16 + s.speedFrac * 34 + s.boost * 26;
        propAngle += rpm * Math.min(dt, 0.1);
        prop.rotation.z = propAngle;
        // A hint of disc behind the blades, never a plate over the face: the
        // blades do the reading, the disc only smears the gaps between them.
        const blur = clamp01((rpm - 24) / 30);
        discMat.opacity = blur * 0.09;
        disc.visible = blur > 0.05;
        disc.scale.setScalar(0.92 + blur * 0.08);

        // Control surfaces: roll with the steering, pitch with the load.
        const roll = s.turn * 0.5;
        ailL.rotation.x = -roll;
        ailR.rotation.x = roll;
        elev.rotation.x = -s.accel * 0.28 - s.air * 0.2;
        rud.rotation.y = -s.turn * 0.42;

        // The wings flex with vertical load — the whole aeroplane breathes.
        const flex = wingFlex(-s.bump * 0.5 + s.air * 0.06, dt);
        ailL.position.y = ailY + flex * 0.5;
        ailR.position.y = ailY + flex * 0.5;
      },
      dispose: () => disposeTree(root),
    };
  },
};

// ── Helicopter ─────────────────────────────────────────────────────────────
// Nimble and forgiving. It hovers, so it barely notices bumps — and the rotor
// disc it drags around above it is a silhouette nothing else can be confused
// with.

const helicopter: VehicleDef = {
  id: 'helicopter',
  name: 'Chopper',
  driver: 'Detour',
  blurb: 'Turns on the spot. Physics is a suggestion.',
  stats: { speed: 0.56, accel: 0.66, weight: 0.36, handling: 0.98, traction: 0.46 },
  colors: { primary: BLUE, secondary: YELLOW, accent: 0xf2f4f8 },
  size: { length: 4.2, width: 1.8, height: 2.4 },
  build(): VehicleModel {
    const seed = buildCount++;
    const root = new THREE.Group();
    const chassis = new THREE.Group();
    const shell = new THREE.Group();
    chassis.add(shell);
    root.add(chassis);

    const skin = mat(BLUE);

    // Body: a fat egg with a chin, which is what a bubble helicopter is.
    const cabin = new THREE.Mesh(new THREE.SphereGeometry(0.88, 20, 16), skin);
    cabin.scale.set(0.9, 0.88, 1.14);
    cabin.position.set(0, 1.24, 0.16);
    shell.add(cabin);
    part(shell, roundedBox(1.3, 0.52, 1.5, 0.24), skin, [0, 0.74, 0.2]);
    part(shell, roundedBox(1.44, 0.18, 1.2, 0.08), mat(YELLOW), [0, 0.62, 0.16]);

    // Bubble glass, wrapped forward and down.
    const glass = new THREE.Mesh(new THREE.SphereGeometry(0.84, 18, 14),
      mat(0xbfe8ff, { roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.34,
        emissiveIntensity: 0.24 }));
    glass.scale.set(0.88, 0.86, 1.1);
    glass.position.set(0, 1.24, 0.44);
    shell.add(glass);

    // Tail boom, fin and stabiliser.
    part(shell, lathe([[0.3, 0], [0.26, 0.5], [0.2, 1.4], [0.16, 2.0], [0.0, 2.2]], 14),
      skin, [0, 1.42, -0.4], [-Math.PI / 2, 0, 0]);
    part(shell, taperBox(0.11, 0.8, 0.62, 1, 0.55, 0.05), skin, [0, 1.86, -2.42]);
    part(shell, roundedBox(0.13, 0.22, 0.4, 0.05), mat(YELLOW), [0, 2.22, -2.5]);
    part(shell, taperBox(0.86, 0.1, 0.3, 0.55, 1, 0.04), skin, [0, 1.56, -2.1]);
    pair(shell, roundedBox(0.08, 0.26, 0.22, 0.04), mat(YELLOW), [0.41, 1.66, -2.12]);
    part(shell, roundedBox(0.34, 0.1, 1.5, 0.05), mat(0xf2f4f8), [0, 1.58, -1.3]);

    // Skids: two long tubes, cross-braced. A completely different read from
    // wheels, and it is what tells the player this machine does not roll.
    for (const side of [-1, 1]) {
      part(shell, lathe([[0.0, 0], [0.09, 0.08], [0.09, 1.9], [0.0, 2.04]], 8),
        METAL(YELLOW), [side * 0.72, 0.1, -0.94], [Math.PI / 2, 0, 0]);
      part(shell, new THREE.SphereGeometry(0.1, 8, 6), METAL(YELLOW), [side * 0.72, 0.12, 1.06]);
    }
    for (const z of [0.5, -0.6]) {
      part(shell, roundedBox(1.6, 0.1, 0.1, 0.05), METAL(STEEL), [0, 0.44, z]);
      pair(shell, roundedBox(0.09, 0.5, 0.09, 0.04), METAL(STEEL), [0.72, 0.28, z], [0, 0, 0.22]);
    }

    // Mast and rotor head.
    part(shell, new THREE.CylinderGeometry(0.1, 0.12, 0.42, 10), METAL(STEEL), [0, 2.02, 0.16]);

    const rotorPivot = new THREE.Group();
    rotorPivot.position.set(0, 2.24, 0.16);
    const rotor = new THREE.Group();
    const rotorShell = new THREE.Group();
    part(rotorShell, new THREE.CylinderGeometry(0.16, 0.2, 0.2, 10), METAL(0x555c68));
    const rotorBlade = taperBox(0.28, 0.06, 1.9, 0.62, 1, 0.03).translate(0, 0, 1.0);
    for (let i = 0; i < 4; i++) {
      part(rotorShell, rotorBlade, mat(0x2b2e36), [0, 0, 0], [0, (i / 4) * Math.PI * 2, 0]);
    }
    mergeStatic(rotorShell);
    rotor.add(rotorShell);
    rotorPivot.add(rotor);
    const rotorDisc = makeSpinDisc(1.9, 0xdfe8f0, 0.1);
    rotorDisc.rotation.x = -Math.PI / 2;
    rotorDisc.position.y = 0.02;
    rotorPivot.add(rotorDisc);
    chassis.add(rotorPivot);
    const rotorDiscMat = rotorDisc.material as THREE.MeshBasicMaterial;

    // Tail rotor, same trick at a smaller scale.
    const tailRotor = new THREE.Group();
    const tailShell = new THREE.Group();
    const tailBlade = taperBox(0.09, 0.4, 0.14, 1, 0.6, 0.03).translate(0, 0.22, 0);
    for (let i = 0; i < 3; i++) {
      part(tailShell, tailBlade, mat(0x2b2e36), [0, 0, 0], [(i / 3) * Math.PI * 2, 0, 0]);
    }
    mergeStatic(tailShell);
    tailRotor.add(tailShell);
    tailRotor.position.set(0.2, 1.74, -2.44);
    chassis.add(tailRotor);
    const tailDisc = makeSpinDisc(0.34, 0xdfe8f0, 0.18);
    tailDisc.rotation.y = Math.PI / 2;
    tailDisc.position.set(0.22, 1.74, -2.44);
    chassis.add(tailDisc);
    const tailDiscMat = tailDisc.material as THREE.MeshBasicMaterial;

    const face = makeFace({
      radius: 0.23, spacing: 0.32, bulge: 0.24, flatten: 0.72,
      mouth: 'grin', mouthY: -0.54, mouthZ: 0.26, mouthWidth: 0.68,
      browColor: 0x1d5b96, seed,
    });
    face.group.position.set(0, 1.32, 0.78);
    chassis.add(face.group);

    part(shell, new THREE.CylinderGeometry(0.13, 0.15, 0.07, 12), mat(0x2b2e36), [0, 1.93, -0.7]);
    const beacon = makeBeacon(0.11, 0xff5a3c);
    beacon.group.position.set(0, 1.96, -0.7);
    chassis.add(beacon.group);

    mergeStatic(shell);
    root.add(makeShadowBlob(2.6, 4.0));
    castShadows(root);

    const rig = createRig({
      chassis, wheels: [], face, seed,
      roll: 0.3, driftRoll: 0.28, pitch: 0.09, squat: 0.03,
      buzz: 0.006, stretch: 0.04, yaw: 0.09,
      hover: 0.05, hoverRate: 2.6, stiffness: 90, damping: 9,
    });

    const boomFlex = makeSpring(7, 0.28);
    let spin = 0;

    return {
      root,
      parts: { body: chassis, rotor: rotorPivot, tailRotor, face: face.group },
      update: (racer: Racer, dt: number): void => {
        rig.update(racer, dt);
        const s = rig.state;
        const rpm = 22 + s.speedFrac * 16 + s.boost * 14;
        spin += rpm * Math.min(dt, 0.1);
        rotor.rotation.y = spin;
        tailRotor.rotation.x = spin * 2.4;

        const blur = clamp01((rpm - 20) / 18);
        rotorDiscMat.opacity = blur * 0.3;
        tailDiscMat.opacity = blur * 0.2;

        // Cyclic: the disc tips the way the machine is going, and the body
        // hangs underneath it. This is the whole reason a helicopter looks
        // alive rather than driven.
        rotorPivot.rotation.z = damp(rotorPivot.rotation.z, -s.turn * 0.16, 0.002, dt);
        rotorPivot.rotation.x = damp(rotorPivot.rotation.x, -0.04 - s.speedFrac * 0.1, 0.004, dt);
        tailRotor.position.y = 1.74 + boomFlex(-s.bump * 0.35 + s.turn * 0.02, dt);
        beacon.update(dt, s.boost);
      },
      dispose: () => disposeTree(root),
    };
  },
};

export const vehicles: VehicleDef[] = [cone, car, truck, digger, train, plane, helicopter];

const byId = new Map(vehicles.map((v) => [v.id, v]));

export function getVehicle(id: string): VehicleDef {
  const v = byId.get(id as VehicleDef['id']);
  if (!v) {
    console.error(`[vehicles] unknown vehicle "${id}", falling back to cone`);
    return cone;
  }
  return v;
}

export function listVehicles(): readonly VehicleDef[] {
  return vehicles;
}

/** Builds and attaches a model to a racer, adding it to the scene. */
export function attachModel(ctx: GameContext, racer: Racer): VehicleModel {
  const def = getVehicle(racer.vehicleId);
  const model = def.build(ctx);
  racer.model = model;
  racer.visual = model.root;
  ctx.scene.add(model.root);
  return model;
}
