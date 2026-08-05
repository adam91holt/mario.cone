// The cast.
//
// Seven machines off a roadworks site. Each one has to be identifiable as a pure
// black silhouette, and each trades stats differently so picking one actually
// changes how the race plays.
//
// Stat budget: speed + accel + weight + handling + traction should land near 3.0
// for every racer, so nobody is strictly better than anybody else.

import * as THREE from 'three';
import {
  mat, METAL, RUBBER, GLASS, roundedBox, makeWheel, makeShadowBlob, makeEyes,
  makeBand, named, castShadows, disposeTree,
} from './parts.ts';
import type { GameContext, VehicleDef, VehicleModel, Racer } from '../types.ts';

/** Wheels that spin with speed and steer with input. Shared by most of the cast. */
function wheelRig(
  root: THREE.Group,
  wheels: Array<{ obj: THREE.Group; steers: boolean; radius: number }>,
): VehicleModel['update'] {
  return (racer: Racer, dt: number): void => {
    for (const w of wheels) {
      w.obj.rotation.x -= (racer.speed / Math.max(0.05, w.radius)) * dt;
      if (w.steers) {
        const steer = racer.steerAngle * 0.5 + (racer.drift.active ? racer.drift.dir * 0.22 : 0);
        w.obj.rotation.y = steer;
      }
    }
    // Lean into corners and squat under acceleration — the cheapest way to make
    // a rigid model feel like it has suspension.
    const lean = -racer.steerAngle * 0.09 - (racer.drift.active ? racer.drift.dir * 0.10 : 0);
    root.rotation.z += (lean - root.rotation.z) * Math.min(1, dt * 9);
    const squat = racer.boost.time > 0 ? 0.05 : 0;
    root.position.y += (squat - root.position.y) * Math.min(1, dt * 8);
  };
}

// ── Road Cone ──────────────────────────────────────────────────────────────
// The mascot. Light, nimble, poor top speed. Reads instantly at any distance.

const cone: VehicleDef = {
  id: 'cone',
  name: 'Road Cone',
  blurb: 'Small, springy, and absolutely everywhere.',
  stats: { speed: 0.42, accel: 0.86, weight: 0.22, handling: 0.90, traction: 0.62 },
  colors: { primary: 0xFF6B1A, secondary: 0xFFF8F0, accent: 0xFFC300 },
  size: { length: 1.7, width: 1.4, height: 1.9 },
  build(): VehicleModel {
    const root = new THREE.Group();

    const base = new THREE.Mesh(roundedBox(1.35, 0.2, 1.5, 0.07), mat(0x2B2E36));
    base.position.y = 0.34;
    root.add(base);

    const body = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.5, 22, 3), mat(0xFF6B1A));
    body.position.y = 1.12;
    root.add(body);

    const band1 = makeBand(0.44, 0.51, 0.26);
    band1.position.y = 1.16;
    root.add(band1);
    const band2 = makeBand(0.27, 0.34, 0.2);
    band2.position.y = 1.52;
    root.add(band2);

    const eyes = makeEyes(0.19, 0.13);
    eyes.position.set(0, 1.34, 0.42);
    root.add(eyes);

    const wheels: Array<{ obj: THREE.Group; steers: boolean; radius: number }> = [];
    for (const [x, z, steers] of [[-0.6, 0.52, true], [0.6, 0.52, true], [-0.62, -0.5, false], [0.62, -0.5, false]] as const) {
      const w = makeWheel({ radius: 0.34, width: 0.26, rimColor: 0xFFC300 });
      w.position.set(x, 0.34, z);
      root.add(w);
      wheels.push({ obj: w, steers, radius: 0.34 });
    }

    root.add(makeShadowBlob(2.0));
    castShadows(root);
    return {
      root,
      parts: { body, eyes },
      update: wheelRig(root, wheels),
      dispose: () => disposeTree(root),
    };
  },
};

// ── Car ────────────────────────────────────────────────────────────────────
// The all-rounder. Nothing exceptional, nothing bad — the reference point.

const car: VehicleDef = {
  id: 'car',
  name: 'Sedan',
  blurb: 'Balanced in every direction. The one you learn on.',
  stats: { speed: 0.62, accel: 0.62, weight: 0.50, handling: 0.66, traction: 0.62 },
  colors: { primary: 0xE33B2E, secondary: 0xFFF8F0, accent: 0x2B2E36 },
  size: { length: 3.2, width: 1.7, height: 1.3 },
  build(): VehicleModel {
    const root = new THREE.Group();

    const body = new THREE.Mesh(roundedBox(1.62, 0.6, 3.0, 0.26), mat(0xE33B2E));
    body.position.y = 0.62;
    root.add(body);

    const cabin = new THREE.Mesh(roundedBox(1.34, 0.52, 1.35, 0.24), GLASS());
    cabin.position.set(0, 1.06, -0.14);
    root.add(cabin);

    const spoiler = new THREE.Mesh(roundedBox(1.5, 0.08, 0.34, 0.04), mat(0x2B2E36));
    spoiler.position.set(0, 1.06, -1.42);
    root.add(spoiler);
    for (const side of [-1, 1]) {
      const stay = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.26, 0.1), mat(0x2B2E36));
      stay.position.set(side * 0.6, 0.94, -1.4);
      root.add(stay);
    }

    for (const side of [-1, 1]) {
      const light = new THREE.Mesh(
        new THREE.SphereGeometry(0.15, 12, 10),
        mat(0xFFF3C4, { roughness: 0.1, emissiveIntensity: 0.85 }));
      light.position.set(side * 0.52, 0.68, 1.48);
      light.scale.z = 0.55;
      root.add(light);
    }

    const wheels: Array<{ obj: THREE.Group; steers: boolean; radius: number }> = [];
    for (const [x, z, steers] of [[-0.84, 1.02, true], [0.84, 1.02, true], [-0.84, -1.02, false], [0.84, -1.02, false]] as const) {
      const w = makeWheel({ radius: 0.42, width: 0.32 });
      w.position.set(x, 0.42, z);
      root.add(w);
      wheels.push({ obj: w, steers, radius: 0.42 });
    }

    root.add(makeShadowBlob(3.2));
    castShadows(root);
    return { root, parts: { body, cabin }, update: wheelRig(root, wheels), dispose: () => disposeTree(root) };
  },
};

// ── Truck ──────────────────────────────────────────────────────────────────
// Heavy. Shoves everyone aside, hates changing direction.

const truck: VehicleDef = {
  id: 'truck',
  name: 'Tipper Truck',
  blurb: 'Right of way is whatever it decides it is.',
  stats: { speed: 0.72, accel: 0.36, weight: 0.94, handling: 0.34, traction: 0.74 },
  colors: { primary: 0xFFC300, secondary: 0x3A3D46, accent: 0xFF6B1A },
  size: { length: 4.4, width: 2.1, height: 2.4 },
  build(): VehicleModel {
    const root = new THREE.Group();

    const chassis = new THREE.Mesh(roundedBox(1.9, 0.34, 4.1, 0.1), mat(0x3A3D46));
    chassis.position.y = 0.72;
    root.add(chassis);

    const cab = new THREE.Mesh(roundedBox(1.95, 1.24, 1.5, 0.24), mat(0xFFC300));
    cab.position.set(0, 1.48, 1.18);
    root.add(cab);

    const windscreen = new THREE.Mesh(roundedBox(1.72, 0.62, 0.14, 0.06), GLASS());
    windscreen.position.set(0, 1.72, 1.92);
    root.add(windscreen);

    const tray = new THREE.Mesh(roundedBox(2.0, 0.94, 2.2, 0.08), mat(0xFF6B1A));
    tray.position.set(0, 1.42, -1.0);
    root.add(tray);

    // A little rubble in the tray, so the truck reads as loaded.
    for (const [x, y, z, s] of [[-0.4, 1.92, -1.3, 0.34], [0.35, 1.95, -0.7, 0.4], [0.1, 1.88, -1.5, 0.28]] as const) {
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), mat(0x8E99A8, { flat: true }));
      rock.position.set(x, y, z);
      root.add(rock);
    }

    const wheels: Array<{ obj: THREE.Group; steers: boolean; radius: number }> = [];
    for (const [x, z, steers] of [[-0.95, 1.42, true], [0.95, 1.42, true],
      [-0.95, -0.72, false], [0.95, -0.72, false], [-0.95, -1.62, false], [0.95, -1.62, false]] as const) {
      const w = makeWheel({ radius: 0.56, width: 0.4, rimColor: 0x8E99A8 });
      w.position.set(x, 0.56, z);
      root.add(w);
      wheels.push({ obj: w, steers, radius: 0.56 });
    }

    root.add(makeShadowBlob(4.4));
    castShadows(root);
    return { root, parts: { cab, tray }, update: wheelRig(root, wheels), dispose: () => disposeTree(root) };
  },
};

// ── Digger ─────────────────────────────────────────────────────────────────
// Tracked, so it grips like nothing else and accelerates hard — but slow.

const digger: VehicleDef = {
  id: 'digger',
  name: 'Digger',
  blurb: 'Grips anything. Overtakes nothing. Loves the dirt.',
  stats: { speed: 0.36, accel: 0.72, weight: 0.80, handling: 0.52, traction: 0.98 },
  colors: { primary: 0xFFC300, secondary: 0x3A3D46, accent: 0xB3502A },
  size: { length: 3.6, width: 2.0, height: 2.6 },
  build(): VehicleModel {
    const root = new THREE.Group();

    // Tracks read as a single dark mass — the strongest part of the silhouette.
    for (const side of [-1, 1]) {
      const track = new THREE.Mesh(roundedBox(0.52, 0.78, 3.2, 0.3), RUBBER(0x2B2E36));
      track.position.set(side * 0.78, 0.44, 0);
      root.add(track);
      for (let i = -2; i <= 2; i++) {
        const roller = new THREE.Mesh(
          new THREE.CylinderGeometry(0.22, 0.22, 0.58, 12),
          METAL(0x8E99A8));
        roller.rotation.z = Math.PI / 2;
        roller.position.set(side * 0.78, 0.3, i * 0.62);
        root.add(roller);
      }
    }

    const deck = new THREE.Mesh(roundedBox(1.8, 0.3, 2.4, 0.1), mat(0x3A3D46));
    deck.position.y = 0.96;
    root.add(deck);

    const cab = new THREE.Mesh(roundedBox(1.16, 1.2, 1.3, 0.2), mat(0xFFC300));
    cab.position.set(-0.28, 1.66, -0.3);
    root.add(cab);

    const cabGlass = new THREE.Mesh(roundedBox(0.98, 0.72, 0.12, 0.05), GLASS());
    cabGlass.position.set(-0.28, 1.82, 0.34);
    root.add(cabGlass);

    // Boom and bucket, angled forward so it looks ready to scoop the track.
    const boom = new THREE.Mesh(roundedBox(0.34, 0.34, 1.9, 0.1), mat(0xFFC300));
    boom.position.set(0.52, 1.42, 0.86);
    boom.rotation.x = -0.5;
    root.add(boom);

    const arm = named(new THREE.Group(), 'arm');
    const forearm = new THREE.Mesh(roundedBox(0.28, 0.28, 1.3, 0.08), mat(0xFFC300));
    forearm.position.set(0, -0.3, 0.55);
    forearm.rotation.x = 0.9;
    arm.add(forearm);
    const bucket = new THREE.Mesh(
      new THREE.CylinderGeometry(0.46, 0.34, 0.7, 10, 1, false, 0, Math.PI),
      METAL(0xB3502A));
    bucket.rotation.set(Math.PI / 2, 0, Math.PI);
    bucket.position.set(0, -0.72, 1.12);
    arm.add(bucket);
    arm.position.set(0.52, 2.14, 1.68);
    root.add(arm);

    root.add(makeShadowBlob(3.6));
    castShadows(root);

    let t = 0;
    return {
      root,
      parts: { cab, arm },
      update: (racer, dt) => {
        // The arm bounces with speed — the digger's whole personality.
        t += dt * (1 + Math.abs(racer.speed) * 0.08);
        arm.rotation.x = Math.sin(t * 3.1) * 0.12 - 0.1;
        const lean = -racer.steerAngle * 0.07 - (racer.drift.active ? racer.drift.dir * 0.08 : 0);
        root.rotation.z += (lean - root.rotation.z) * Math.min(1, dt * 7);
      },
      dispose: () => disposeTree(root),
    };
  },
};

// ── Train ──────────────────────────────────────────────────────────────────
// The heavyweight. Colossal top speed, turns like a building.

const train: VehicleDef = {
  id: 'train',
  name: 'Shunter',
  blurb: 'Takes a while to wind up. Then good luck stopping it.',
  stats: { speed: 0.98, accel: 0.24, weight: 1.00, handling: 0.24, traction: 0.60 },
  colors: { primary: 0x2E6E4F, secondary: 0xE33B2E, accent: 0xFFC300 },
  size: { length: 4.6, width: 1.9, height: 2.6 },
  build(): VehicleModel {
    const root = new THREE.Group();

    const boiler = new THREE.Mesh(
      new THREE.CylinderGeometry(0.78, 0.78, 2.6, 20),
      mat(0x2E6E4F));
    boiler.rotation.x = Math.PI / 2;
    boiler.position.set(0, 1.14, 0.5);
    root.add(boiler);

    const front = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.82, 0.2, 20), mat(0x14161C));
    front.rotation.x = Math.PI / 2;
    front.position.set(0, 1.14, 1.82);
    root.add(front);

    const cab = new THREE.Mesh(roundedBox(1.7, 1.5, 1.5, 0.18), mat(0xE33B2E));
    cab.position.set(0, 1.5, -1.3);
    root.add(cab);

    const roof = new THREE.Mesh(roundedBox(1.86, 0.16, 1.7, 0.07), mat(0x14161C));
    roof.position.set(0, 2.3, -1.3);
    root.add(roof);

    const funnel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.26, 0.72, 16), mat(0x14161C));
    funnel.position.set(0, 2.14, 1.42);
    root.add(funnel);
    const funnelLip = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.07, 8, 16), mat(0xFFC300));
    funnelLip.rotation.x = Math.PI / 2;
    funnelLip.position.set(0, 2.48, 1.42);
    root.add(funnelLip);

    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 12, 10),
      mat(0xFFF3C4, { roughness: 0.08, emissiveIntensity: 1.0 }));
    lamp.position.set(0, 1.66, 1.86);
    root.add(lamp);

    // Cowcatcher — the detail that makes the silhouette unmistakable.
    const catcher = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.9, 0.9, 3, 1),
      mat(0xFFC300, { flat: true }));
    catcher.rotation.set(Math.PI / 2, 0, 0);
    catcher.position.set(0, 0.62, 2.2);
    root.add(catcher);

    const wheels: Array<{ obj: THREE.Group; steers: boolean; radius: number }> = [];
    for (const [x, z, r] of [[-0.82, 1.36, 0.42], [0.82, 1.36, 0.42],
      [-0.86, -0.1, 0.58], [0.86, -0.1, 0.58],
      [-0.86, -1.34, 0.58], [0.86, -1.34, 0.58]] as const) {
      const w = makeWheel({ radius: r, width: 0.24, rimColor: 0xE33B2E, tyreColor: 0x14161C, spokes: 6 });
      w.position.set(x, r, z);
      root.add(w);
      wheels.push({ obj: w, steers: false, radius: r });
    }

    root.add(makeShadowBlob(4.6));
    castShadows(root);
    return { root, parts: { cab, funnel }, update: wheelRig(root, wheels), dispose: () => disposeTree(root) };
  },
};

// ── Plane ──────────────────────────────────────────────────────────────────
// Fast and slippery, but light — gets bullied in a scrum.

const plane: VehicleDef = {
  id: 'plane',
  name: 'Prop Plane',
  blurb: 'Barely touches the ground. Barely needs to.',
  stats: { speed: 0.90, accel: 0.58, weight: 0.26, handling: 0.60, traction: 0.30 },
  colors: { primary: 0xF2F4F8, secondary: 0xE33B2E, accent: 0x2E86D6 },
  size: { length: 3.6, width: 4.4, height: 1.6 },
  build(): VehicleModel {
    const root = new THREE.Group();

    const fuselage = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 2.3, 6, 16), mat(0xF2F4F8));
    fuselage.rotation.x = Math.PI / 2;
    fuselage.position.y = 0.92;
    root.add(fuselage);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.7, 16), mat(0xE33B2E));
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.92, 1.86);
    root.add(nose);

    const wing = new THREE.Mesh(roundedBox(4.4, 0.12, 0.92, 0.06), mat(0xF2F4F8));
    wing.position.set(0, 0.98, 0.16);
    root.add(wing);
    for (const side of [-1, 1]) {
      const tip = new THREE.Mesh(roundedBox(0.16, 0.3, 0.7, 0.06), mat(0xE33B2E));
      tip.position.set(side * 2.18, 1.08, 0.16);
      root.add(tip);
    }

    const tail = new THREE.Mesh(roundedBox(1.5, 0.1, 0.5, 0.05), mat(0xF2F4F8));
    tail.position.set(0, 1.12, -1.42);
    root.add(tail);
    const fin = new THREE.Mesh(roundedBox(0.1, 0.78, 0.6, 0.05), mat(0xE33B2E));
    fin.position.set(0, 1.44, -1.5);
    root.add(fin);

    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.36, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), GLASS());
    canopy.position.set(0, 1.2, 0.5);
    canopy.scale.set(1, 0.8, 1.5);
    root.add(canopy);

    const prop = named(new THREE.Group(), 'prop');
    for (let i = 0; i < 2; i++) {
      const blade = new THREE.Mesh(roundedBox(0.1, 1.5, 0.06, 0.03), mat(0x2B2E36));
      blade.rotation.z = i * Math.PI / 2;
      prop.add(blade);
    }
    const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.3, 12), mat(0xFFC300));
    spinner.rotation.x = Math.PI / 2;
    prop.add(spinner);
    prop.position.set(0, 0.92, 2.24);
    root.add(prop);

    const wheels: Array<{ obj: THREE.Group; steers: boolean; radius: number }> = [];
    for (const [x, z, steers] of [[-0.86, 0.5, false], [0.86, 0.5, false], [0, -1.5, true]] as const) {
      const w = makeWheel({ radius: 0.3, width: 0.18, rimColor: 0x8E99A8 });
      w.position.set(x, 0.3, z);
      root.add(w);
      wheels.push({ obj: w, steers, radius: 0.3 });
    }

    root.add(makeShadowBlob(4.0));
    castShadows(root);

    const base = wheelRig(root, wheels);
    return {
      root,
      parts: { prop, wing },
      update: (racer, dt, alpha) => {
        base?.(racer, dt, alpha);
        prop.rotation.z -= (14 + Math.abs(racer.speed) * 1.4) * dt;
        // Banks harder than anything else on the grid.
        const lean = -racer.steerAngle * 0.2 - (racer.drift.active ? racer.drift.dir * 0.2 : 0);
        root.rotation.z += (lean - root.rotation.z) * Math.min(1, dt * 7);
      },
      dispose: () => disposeTree(root),
    };
  },
};

// ── Helicopter ─────────────────────────────────────────────────────────────
// Nimble and forgiving. Hovers slightly, so it barely notices bumps.

const helicopter: VehicleDef = {
  id: 'helicopter',
  name: 'Chopper',
  blurb: 'Turns on the spot. Physics is a suggestion.',
  stats: { speed: 0.56, accel: 0.66, weight: 0.36, handling: 0.98, traction: 0.44 },
  colors: { primary: 0x2E86D6, secondary: 0xFFC300, accent: 0xF2F4F8 },
  size: { length: 3.8, width: 1.6, height: 2.2 },
  build(): VehicleModel {
    const root = new THREE.Group();

    const cabin = new THREE.Mesh(new THREE.SphereGeometry(0.86, 18, 14), mat(0x2E86D6));
    cabin.scale.set(0.92, 0.86, 1.15);
    cabin.position.set(0, 1.16, 0.35);
    root.add(cabin);

    const glass = new THREE.Mesh(new THREE.SphereGeometry(0.8, 16, 12), GLASS());
    glass.scale.set(0.9, 0.82, 1.1);
    glass.position.set(0, 1.14, 0.62);
    root.add(glass);

    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.1, 2.1, 12), mat(0x2E86D6));
    boom.rotation.x = Math.PI / 2;
    boom.position.set(0, 1.3, -1.34);
    root.add(boom);

    const fin = new THREE.Mesh(roundedBox(0.08, 0.62, 0.44, 0.04), mat(0xFFC300));
    fin.position.set(0, 1.6, -2.24);
    root.add(fin);

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.34, 10), METAL(0x8E99A8));
    mast.position.set(0, 2.02, 0.3);
    root.add(mast);

    const rotor = named(new THREE.Group(), 'rotor');
    for (let i = 0; i < 4; i++) {
      const blade = new THREE.Mesh(roundedBox(3.5, 0.05, 0.24, 0.02), mat(0x2B2E36));
      blade.rotation.y = (i / 4) * Math.PI * 2;
      rotor.add(blade);
    }
    rotor.position.set(0, 2.2, 0.3);
    root.add(rotor);

    const tailRotor = named(new THREE.Group(), 'tailRotor');
    for (let i = 0; i < 3; i++) {
      const blade = new THREE.Mesh(roundedBox(0.06, 0.78, 0.14, 0.02), mat(0x2B2E36));
      blade.rotation.x = (i / 3) * Math.PI * 2;
      tailRotor.add(blade);
    }
    tailRotor.position.set(0.2, 1.58, -2.3);
    root.add(tailRotor);

    // Skids instead of wheels — a completely different read from the others.
    for (const side of [-1, 1]) {
      const skid = new THREE.Mesh(roundedBox(0.12, 0.12, 2.3, 0.06), METAL(0xFFC300));
      skid.position.set(side * 0.66, 0.16, 0.2);
      root.add(skid);
      for (const z of [0.86, -0.5]) {
        const strut = new THREE.Mesh(roundedBox(0.09, 0.62, 0.09, 0.04), METAL(0x8E99A8));
        strut.position.set(side * 0.6, 0.5, z);
        strut.rotation.z = side * 0.16;
        root.add(strut);
      }
    }

    root.add(makeShadowBlob(3.4));
    castShadows(root);

    let hover = 0;
    return {
      root,
      parts: { rotor, tailRotor, cabin },
      update: (racer, dt) => {
        const spin = 26 + Math.abs(racer.speed) * 0.5;
        rotor.rotation.y += spin * dt;
        tailRotor.rotation.x += spin * 1.7 * dt;
        // A gentle bob, and a nose-down pitch under power.
        hover += dt;
        root.position.y = Math.sin(hover * 2.4) * 0.06;
        const pitch = -Math.min(0.16, Math.abs(racer.speed) * 0.003);
        root.rotation.x += (pitch - root.rotation.x) * Math.min(1, dt * 5);
        const lean = -racer.steerAngle * 0.24 - (racer.drift.active ? racer.drift.dir * 0.22 : 0);
        root.rotation.z += (lean - root.rotation.z) * Math.min(1, dt * 8);
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
export function attachModel(ctx: GameContext, racer: Racer): void {
  const def = getVehicle(racer.vehicleId);
  const model = def.build(ctx);
  racer.model = model;
  racer.visual = model.root;
  ctx.scene.add(model.root);
}
