// Every item, built out of primitives.
//
// The rule these are drawn to: an item has to be identifiable in the two frames
// before it hits you. That means silhouette and colour do all the work — a
// banana is a yellow crescent lying flat, a green shell is a green dome with a
// white rim, a bob-omb is a black sphere with a lit fuse. Detail beyond that is
// for the frames where the item is sitting still on the road.
//
// Each kind is built once as a prototype and cloned into the pool, so geometry
// and materials are shared across every copy in flight. Anything that animates
// its own material (a fuse spark, a blast, an aura) gets a private material at
// clone time — see `cloneWithMaterials`.

import * as THREE from 'three';
import { mat, roundedBox, mergeStatic, castShadows, makeShadowBlob } from '../vehicles/parts.ts';

const TAU = Math.PI * 2;

// ── shared helpers ─────────────────────────────────────────────────────────

/** Unlit, additive-ish glow. Owns its material so callers may fade it. */
function glowMaterial(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
}

/**
 * A rim-light shell: transparent where it faces you, bright at the silhouette.
 *
 * This exists because the obvious way to draw an aura — an additive sphere over
 * the kart — paints a flat coloured disc across the machine and reads as a
 * rendering fault rather than as power. Driving the brightness off the fresnel
 * term inverts that: the middle disappears, the edge lights up, and the kart
 * inside stays perfectly legible. Every glowing shell in this module uses it.
 *
 * Written as a ShaderMaterial rather than a patch on a standard one because an
 * aura wants none of the lighting path: it is emission, and emission only.
 */
export function rimMaterial(color: number, power = 2.6, strength = 1,
  core = 0.04, side: THREE.Side = THREE.FrontSide): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uPower: { value: power },
      uStrength: { value: strength },
      // How much light the shell gives off face-on. Small on purpose: this is
      // the number that decides whether the machine inside is still legible,
      // and at 0.12 with a two-sided shell it was a balloon with a kart in it.
      uCore: { value: core },
    },
    vertexShader: `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 wp = modelMatrix * vec4( position, 1.0 );
        vN = normalize( mat3( modelMatrix ) * normal );
        vV = normalize( cameraPosition - wp.xyz );
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uPower;
      uniform float uStrength;
      uniform float uCore;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float f = 1.0 - abs( dot( normalize( vN ), normalize( vV ) ) );
        float a = pow( clamp( f, 0.0, 1.0 ), uPower ) + uCore;
        gl_FragColor = vec4( uColor * a * uStrength, 1.0 );
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // Front faces only by default. Drawing both halves of a shell doubles every
    // pixel of it, and the doubling lands hardest exactly in the middle — over
    // the machine, which is the one place the glow must not be. Shells the
    // camera ends up *inside* (the horn's shockwave) ask for both.
    side,
    toneMapped: false,
  });
}

/** Set the `uStrength` of every rim material under a node. */
export function setRimStrength(root: THREE.Object3D, value: number): void {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
    if (m && (m as THREE.ShaderMaterial).uniforms?.uStrength) {
      (m as THREE.ShaderMaterial).uniforms.uStrength!.value = value;
    }
  });
}

/** Solid painted plastic, with a little emissive lift so shadows stay coloured. */
function plastic(color: number, rough = 0.42, emissive = 0.10): THREE.MeshStandardMaterial {
  return mat(color, { roughness: rough, emissiveIntensity: emissive });
}

function addMesh(
  parent: THREE.Object3D, geo: THREE.BufferGeometry, material: THREE.Material,
  pos?: readonly [number, number, number], rot?: readonly [number, number, number],
  scale?: readonly [number, number, number],
): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  if (pos) m.position.set(pos[0], pos[1], pos[2]);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  if (scale) m.scale.set(scale[0], scale[1], scale[2]);
  parent.add(m);
  return m;
}

/**
 * Deep clone that also clones every material.
 *
 * `Object3D.clone()` shares materials, which is exactly what we want for the
 * twenty static bananas in the pool and exactly what we do not want for the
 * three blasts fading out at different rates.
 */
export function cloneWithMaterials(source: THREE.Object3D): THREE.Object3D {
  const copy = source.clone(true);
  copy.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.material = Array.isArray(m.material)
      ? m.material.map((x) => x.clone())
      : (m.material as THREE.Material).clone();
  });
  return copy;
}

/**
 * A soft radial disc: a triangle fan with a bright centre vertex and black rim
 * vertices, shaded by vertex colour rather than by a texture.
 *
 * Every soft glow in this module is one of these — the halo behind an item box,
 * the light pool a star lays on the tarmac. `CircleGeometry` is the obvious
 * alternative and the wrong one: it has a hard rim, and a hard-rimmed additive
 * disc on a dark road reads as a decal somebody forgot to feather. Additive
 * blending makes the black rim literally nothing, so the falloff has no edge to
 * give itself away.
 *
 * Built in the XY plane facing +Z; rotate it to lay it on the ground.
 */
export function radialGlowGeometry(radius = 2.5, seg = 20): THREE.BufferGeometry {
  const pos = new Float32Array(seg * 3 * 3);
  const col = new Float32Array(seg * 3 * 3);
  let k = 0;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * TAU;
    const a1 = ((i + 1) / seg) * TAU;
    // centre, then the two rim points. Centre bright, rim black.
    const tri = [
      [0, 0, 1], [Math.cos(a0) * radius, Math.sin(a0) * radius, 0],
      [Math.cos(a1) * radius, Math.sin(a1) * radius, 0],
    ] as const;
    for (const [x, y, c] of tri) {
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = 0;
      col[k] = c; col[k + 1] = c; col[k + 2] = c;
      k += 3;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Set the opacity of every material under a node. Used by fading effects. */
export function setOpacity(root: THREE.Object3D, value: number): void {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    if (Array.isArray(m)) for (const x of m) (x as THREE.MeshBasicMaterial).opacity = value;
    else (m as THREE.MeshBasicMaterial).opacity = value;
  });
}

/** Recolour every material under a node — the hit burst takes the item's colour. */
export function setColor(root: THREE.Object3D, color: number): void {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
    if (m && m.color) m.color.setHex(color);
  });
}

// ── wheel chock ────────────────────────────────────────────────────────────

/**
 * The thing you leave on the road behind you: a **wheel chock**.
 *
 * This was a banana — a literal yellow crescent with a brown stalk, lying on
 * the tarmac of a circuit whose cast, whose drivers and whose corner names are
 * all roadworks. The slot said "Wheel Chock", the road showed a piece of fruit,
 * and the item everybody in a kart racer meets first was the one place the
 * whole joke stopped.
 *
 * A chock is the better object for the job as well as the honest one. What a
 * dropped item has to do is read, from a chase camera, as *something to go
 * round*, in the half second before a wheel finds it — and a hazard-yellow
 * wedge with a black tread bar across it is a shape whose entire meaning in the
 * real world is "this stops a wheel". The banana relied on a fruit-shaped
 * silhouette that a moving camera flattens into a lozenge; the wedge relies on
 * a hard triangular profile and a flat top plane that catches the key light,
 * neither of which needs to be recognised from a particular angle.
 *
 * Sized to the banana it replaces — about 1.15m nose to tail, a third of the
 * width of the widest machine in the cast. Big enough to be an obstacle, small
 * enough not to read as scenery.
 */
function chockProfile(): THREE.Shape {
  const s = new THREE.Shape();
  // Side view: X down the road, Y up. The blunt face is at +X, the nose at -X.
  s.moveTo(-0.58, 0);
  s.lineTo(0.5, 0);
  s.lineTo(0.5, 0.4);
  // The cradle. Dished rather than straight, because the face a chock presents
  // to a tyre is a curve — and because a slight concavity puts a soft shadow
  // along the top of the wedge that a flat ramp does not get.
  s.quadraticCurveTo(-0.02, 0.16, -0.58, 0.04);
  s.closePath();
  return s;
}

export function buildChock(): THREE.Object3D {
  const g = new THREE.Group();
  const bodyMat = plastic(0xFFD429, 0.42, 0.12);
  const gripMat = plastic(0x2A2E38, 0.6, 0.02);
  const steelMat = plastic(0x9AA5B4, 0.42, 0.05);

  const geo = new THREE.ExtrudeGeometry(chockProfile(), {
    depth: 0.54, bevelEnabled: true, bevelSize: 0.035,
    bevelThickness: 0.035, bevelSegments: 1,
  });
  // Extruded along +Z from the shape plane: centre it across the road and stand
  // it on the tarmac.
  geo.translate(0, 0.035, -0.27);
  addMesh(g, geo, bodyMat);

  // The rubber foot. Dark, and it is what stops the wedge looking like it is
  // hovering a centimetre off the road on a bright surface.
  addMesh(g, roundedBox(1.12, 0.07, 0.6, 0.03), gripMat, [-0.03, 0.035, 0]);

  // Two tread bars across the cradle, angled with it. From directly above —
  // which is most of the frames a dropped item is seen in — these are the whole
  // read: a yellow rectangle is a plank, a yellow rectangle with two black bars
  // across it is a chock.
  for (const [x, y] of [[0.3, 0.34], [-0.06, 0.21]] as const) {
    addMesh(g, roundedBox(0.13, 0.055, 0.5, 0.025), gripMat, [x, y, 0], [0, 0, -0.34]);
  }

  // The grab loop on the blunt end. One vertical shape on an object that is
  // otherwise all horizontals, so the silhouette from the side has a top edge
  // that is not a straight line.
  addMesh(g, new THREE.TorusGeometry(0.11, 0.03, 6, 14), steelMat, [0.44, 0.5, 0]);

  mergeStatic(g);
  castShadows(g, true, false);
  return g;
}

// ── shells ─────────────────────────────────────────────────────────────────

/**
 * The shell — which in a world of roadworks machinery is a **hard hat**.
 *
 * The role is Mario Kart's: a domed thing with a bright rim that skitters down
 * the road and bounces off the barriers. The object is this game's own. It also
 * happens to be the better model for the job: a hat has a *brim*, and a brim is
 * a hard horizontal line that catches the key light and tells you instantly
 * which way the thing is spinning — which a smooth dome, photographed at sixty
 * metres a second, does not.
 *
 * Built about its own centre so it can roll on the axis it travels along.
 */
export function buildShell(color: number, spot: number, homing = false): THREE.Object3D {
  const g = new THREE.Group();
  // 0.44, not 0.28. At the tighter roughness the dome carried a specular that
  // clipped to white over a third of its surface, and a blown highlight is not
  // a highlight — it is a hole in the model. Painted vinyl, per ARCHITECTURE
  // §12: a broad soft sheen that describes the curve instead of erasing it.
  const shellMat = plastic(color, 0.44, 0.16);
  const trimMat = plastic(0xFFF8F0, 0.46, 0.12);
  const bandMat = plastic(spot, 0.36, 0.1);

  // The crown.
  const dome = addMesh(g, new THREE.SphereGeometry(0.4, 18, 10, 0, TAU, 0, Math.PI * 0.5),
    shellMat, [0, 0.13, 0]);
  dome.scale.set(1, 1.14, 1.04);

  // The brim. Wide, flat and slightly coned, and the single detail that makes
  // this a hat rather than a bowl.
  addMesh(g, new THREE.CylinderGeometry(0.5, 0.58, 0.075, 24), shellMat, [0, 0.12, 0]);
  // ...with a white edge. Same job the white rim did on the old shell: it is
  // what stops a coloured lump disappearing against a coloured road.
  addMesh(g, new THREE.TorusGeometry(0.55, 0.055, 8, 26), trimMat, [0, 0.115, 0],
    [Math.PI / 2, 0, 0]);
  // The underside, so a hat seen from below is not an open shell.
  addMesh(g, new THREE.SphereGeometry(0.38, 16, 6, 0, TAU, Math.PI * 0.5, Math.PI * 0.5),
    trimMat, [0, 0.12, 0], undefined, [1, 0.38, 1]);

  // The crown ridge, front to back over the top. Reads as a hard hat at a
  // glance and as *rotation* when the thing is spinning.
  addMesh(g, new THREE.TorusGeometry(0.435, 0.048, 6, 20, Math.PI), shellMat,
    [0, 0.13, 0], [0, Math.PI / 2, 0]);
  // A hazard band round the base of the crown.
  addMesh(g, new THREE.TorusGeometry(0.375, 0.05, 6, 22), bandMat, [0, 0.24, 0],
    [Math.PI / 2, 0, 0]);

  if (homing) {
    /**
     * The **supervisor's** helmet — and this is a silhouette job, not a paint
     * job.
     *
     * Green and red used to be the same mesh in two hues, which is the worst
     * possible answer for the two most-thrown items in the game: a player
     * glancing in the mirror at something coming up the inside has to know
     * *now* whether it will follow them round the corner, and hue alone does
     * not survive a small mirror, motion blur, or a red kart in front of it.
     * So the homing one gets three shapes the plain one has not: a peak over
     * the eyes that points where it is going, ear defenders that widen it, and
     * a beacon on the crown that breaks the dome. Black shapes, they are two
     * different objects.
     */
    // The peak. Forward-facing, so a shell nose-on is an arrow.
    const peak = addMesh(g, new THREE.CylinderGeometry(0.30, 0.34, 0.06, 16, 1, false,
      -0.85, 1.7), shellMat, [0, 0.155, 0.36]);
    peak.rotation.x = -0.16;
    peak.scale.set(1, 1, 1.5);
    // Ear defenders.
    for (const sx of [-1, 1]) {
      addMesh(g, new THREE.CylinderGeometry(0.15, 0.15, 0.11, 12), bandMat,
        [sx * 0.42, 0.19, 0], [0, 0, Math.PI / 2]);
    }
    // The beacon: a stalk and a lamp that is a light source in its own right,
    // so the thing behind you is *lit* rather than merely red.
    addMesh(g, new THREE.CylinderGeometry(0.055, 0.07, 0.1, 10), trimMat, [0, 0.44, 0]);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.115, 12, 9),
      new THREE.MeshStandardMaterial({
        color: 0xFFE9C8, emissive: 0xFF4A20, emissiveIntensity: 2.4,
        roughness: 0.3, metalness: 0,
      }));
    lamp.position.set(0, 0.52, 0);
    lamp.name = 'beacon';
    g.add(lamp);
  }

  mergeStatic(g);
  castShadows(g, true, false);
  return g;
}

// ── mushroom ───────────────────────────────────────────────────────────────

/**
 * The instant boost — a **compressed-air canister**, not a mushroom.
 *
 * Every machine in this cast is a roadworks machine; the items were the one
 * thing that had not been re-themed, and a red cap with white spots is somebody
 * else's property besides. The canister does the same two jobs the mushroom did
 * and does them in this game's own language: a fat bright cylinder is legible
 * as a silhouette from any angle, and the nozzle and flame at the bottom say
 * *speed* before the player has read anything else about it.
 */
export function buildMushroom(cap = 0xFF6B1A): THREE.Object3D {
  const g = new THREE.Group();
  const bodyMat = plastic(cap, 0.34, 0.16);
  const bandMat = plastic(0xFFC300, 0.36, 0.2);
  const steelMat = plastic(0xB9C2D0, 0.4, 0.06);

  // The bottle.
  addMesh(g, new THREE.CylinderGeometry(0.26, 0.26, 0.42, 16), bodyMat, [0, 0.3, 0]);
  const top = addMesh(g, new THREE.SphereGeometry(0.26, 16, 8, 0, TAU, 0, Math.PI * 0.5),
    bodyMat, [0, 0.51, 0]);
  top.scale.y = 0.8;
  // Two hazard bands. They are what identifies it at forty metres, when the
  // valve and the nozzle have mipmapped away to nothing.
  for (const y of [0.2, 0.42]) {
    addMesh(g, new THREE.CylinderGeometry(0.268, 0.268, 0.075, 16), bandMat, [0, y, 0]);
  }
  // The valve on top.
  addMesh(g, new THREE.CylinderGeometry(0.075, 0.09, 0.12, 8), steelMat, [0, 0.68, 0]);
  addMesh(g, new THREE.TorusGeometry(0.1, 0.028, 5, 12), steelMat, [0, 0.73, 0],
    [Math.PI / 2, 0, 0]);
  // ...and the nozzle underneath, which is the end that does the work.
  addMesh(g, new THREE.CylinderGeometry(0.19, 0.11, 0.15, 12), steelMat, [0, 0.03, 0]);

  mergeStatic(g);
  castShadows(g, true, false);

  // A cold jet at the nozzle. Unlit and additive, so it reads as pressure
  // rather than as a painted-on cone.
  const jet = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.34, 10, 1, true),
    glowMaterial(0xBFE6FF, 0.55));
  jet.rotation.x = Math.PI;
  jet.position.y = -0.14;
  jet.userData.noShadow = true;
  g.add(jet);
  return g;
}

// ── star ───────────────────────────────────────────────────────────────────

function starShape(outer: number, inner: number, points = 5): THREE.Shape {
  const s = new THREE.Shape();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (points * 2)) * TAU + Math.PI / 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

export function buildStar(): THREE.Object3D {
  const g = new THREE.Group();
  const geo = new THREE.ExtrudeGeometry(starShape(0.46, 0.19), {
    depth: 0.14, bevelEnabled: true, bevelSize: 0.055, bevelThickness: 0.05, bevelSegments: 1,
  });
  geo.center();
  const m = new THREE.Mesh(geo, mat(0xFFD84D, { roughness: 0.22, emissiveIntensity: 0.75 }));
  m.position.y = 0.5;
  g.add(m);
  castShadows(g, true, false);
  return g;
}

// ── gas bottle ─────────────────────────────────────────────────────────────

/**
 * The one that goes off: a **gas bottle**.
 *
 * It was a black sphere with a lit fuse and a wind-up key's worth of personality
 * — somebody else's object, sitting in the middle of a road crew's circuit. A
 * bottle of propane left lying about a work site is the same idea told in this
 * game's own words, and it is a *better* silhouette for what the item does: a
 * sphere reads the same from every angle and therefore reads as nothing in
 * particular, while an upright cylinder with a valve on top is unmistakably an
 * object standing on the road, and unmistakably one you do not want to be near.
 *
 * The fuse becomes the valve lamp. It keeps the node name `spark`, because the
 * entity layer pulses it by name and the *behaviour* — brighter and faster the
 * closer this is to going off — is exactly right for a warning light.
 */
export function buildGasBottle(): THREE.Object3D {
  const g = new THREE.Group();
  const body = plastic(0x2E3340, 0.34, 0.05);
  const band = plastic(0xFF6B1A, 0.4, 0.18);
  const steel = plastic(0x9AA5B4, 0.44, 0.04);

  // The bottle. Squat rather than tall: a slim cylinder photographed from a
  // chase camera at forty metres is a line, and a line is not a thing.
  addMesh(g, new THREE.CylinderGeometry(0.29, 0.29, 0.56, 16), body, [0, 0.34, 0]);
  const shoulder = addMesh(g,
    new THREE.SphereGeometry(0.29, 16, 8, 0, TAU, 0, Math.PI * 0.5), body, [0, 0.62, 0]);
  shoulder.scale.y = 0.66;
  // The foot ring, which is what a gas bottle actually stands on.
  addMesh(g, new THREE.CylinderGeometry(0.31, 0.31, 0.08, 16), body, [0, 0.04, 0]);

  // Two hazard bands. They are the identification at distance, when the valve
  // and the collar have mipmapped away to nothing — and they are the same
  // language the canister and the pile driver are painted in.
  for (const y of [0.18, 0.5]) {
    addMesh(g, new THREE.CylinderGeometry(0.298, 0.298, 0.09, 16), band, [0, y, 0]);
  }

  // The neck, the handwheel and the collar that protects them.
  addMesh(g, new THREE.CylinderGeometry(0.075, 0.095, 0.16, 10), steel, [0, 0.78, 0]);
  addMesh(g, new THREE.TorusGeometry(0.09, 0.026, 5, 12), steel, [0, 0.86, 0],
    [Math.PI / 2, 0, 0]);
  addMesh(g, new THREE.TorusGeometry(0.17, 0.032, 6, 16), band, [0, 0.8, 0],
    [Math.PI / 2, 0, 0]);

  mergeStatic(g);
  castShadows(g, true, false);

  // The valve lamp keeps its own material: it is pulsed per bottle, per frame.
  const spark = new THREE.Mesh(new THREE.SphereGeometry(0.105, 8, 6),
    glowMaterial(0xFFC24A, 0.9));
  spark.name = 'spark';
  spark.position.set(0, 0.98, 0);
  spark.userData.noShadow = true;
  g.add(spark);
  return g;
}

// ── the bullet husk ────────────────────────────────────────────────────────

/**
 * The bullet bill casing.
 *
 * A bullet bill turns the *kart* into the projectile, so the machine goes
 * inside a solid shell rather than under a tinted bubble. The first version of
 * this was translucent, and from the chase camera — which is where the player
 * spends the entire six seconds — it read as a soap bubble with a road cone in
 * it. Opaque is the correct answer: for the duration, you are a bullet.
 *
 * Which means the *tail* is what has to carry the read, because the tail is all
 * you can see. Hence: a flat charcoal stern with a hazard-chevron collar, a
 * bright plume, and a shock ring around it. The nose, the eyes and the profile
 * are for everyone else's screen and for the replay cameras.
 */
export function buildBulletHusk(): THREE.Object3D {
  const g = new THREE.Group();
  const R = 1.12;
  const shell = mat(0x2B3140, { roughness: 0.32, metalness: 0.4, emissiveIntensity: 0.05 });

  // Body: a barrel with a domed nose and a domed stern. Built along +Z, which
  // is forward. Both ends are *convex* on purpose — a flat or open end seen
  // from directly astern reads as a pipe with a light in it, and astern is
  // where the chase camera spends the entire six seconds.
  const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 3.6, 20, 1, false), shell);
  body.rotation.x = Math.PI / 2;
  body.position.set(0, 0.95, 0.2);
  g.add(body);

  const nose = new THREE.Mesh(
    new THREE.SphereGeometry(R, 20, 12, 0, TAU, 0, Math.PI * 0.5), shell);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.95, 2.0);
  nose.scale.y = 1.45;
  g.add(nose);

  // The stern is the only part of this the driver ever sees, so it is not
  // allowed to be black. At 0x1B1F28 with a 0.62 cap it photographed as a
  // bowling ball hung off the back of the kart — no silhouette, no material
  // read, nothing that says "bullet". Lighter, flatter, and framed by a hazard
  // collar, it reads as the back of a machine.
  const stern = new THREE.Mesh(
    new THREE.SphereGeometry(R, 20, 10, 0, TAU, 0, Math.PI * 0.5),
    mat(0x39404F, { roughness: 0.42, metalness: 0.35, emissiveIntensity: 0.1 }));
  stern.rotation.x = -Math.PI / 2;
  stern.position.set(0, 0.95, -1.6);
  stern.scale.y = 0.48;
  g.add(stern);

  // The collar on the stern rim. This is the single most load-bearing detail on
  // the whole model: it is the bright ring that frames the exhaust from
  // directly astern, which is where the player spends every second of the six.
  const collar = new THREE.Mesh(new THREE.TorusGeometry(R * 0.99, 0.15, 8, 26),
    mat(0xFFC300, { roughness: 0.3, emissiveIntensity: 0.8 }));
  collar.position.set(0, 0.95, -1.62);
  g.add(collar);
  const collarInner = new THREE.Mesh(new THREE.TorusGeometry(R * 0.6, 0.1, 8, 22),
    mat(0xFF6B1A, { roughness: 0.32, emissiveIntensity: 0.7 }));
  collarInner.position.set(0, 0.95, -1.88);
  g.add(collarInner);

  // The roadworks collar: hazard bands where a bullet bill would have its seam.
  // This is the one place the item is allowed to say what world it is in, and
  // from directly behind it is most of what identifies the thing.
  for (const [z, c] of [[-1.5, 0xFFC300], [-1.16, 0xFF6B1A], [1.4, 0xFF6B1A]] as const) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.04, R * 1.04, 0.3, 20, 1, true),
      mat(c, { roughness: 0.35, emissiveIntensity: 0.5 }));
    band.rotation.x = Math.PI / 2;
    band.position.set(0, 0.95, z);
    g.add(band);
  }

  // Arms — the silhouette cue that says "bullet bill" and not "missile".
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 1.0, 4, 8), shell);
    arm.position.set(sx * 1.16, 0.95, 0.15);
    arm.rotation.z = sx * 0.7;
    g.add(arm);
  }

  const white = mat(0xFFF8F0, { roughness: 0.3, emissiveIntensity: 0.4 });
  const dark = mat(0x14171F, { roughness: 0.5 });
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.46, 12, 10), white);
    e.position.set(sx * 0.58, 1.2, 1.72);
    e.scale.z = 0.6;
    g.add(e);
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), dark);
    p.position.set(sx * 0.62, 1.18, 2.06);
    p.scale.z = 0.5;
    g.add(p);
  }

  // Eight blades round the stern, and they are here to break a *circle*.
  //
  // Everything the driver can see of this thing is concentric: a collar at the
  // rim, a shock ring inside that, a white-hot core in the middle. Photographed
  // from the chase camera — which is the only camera that ever sees it — those
  // three rings composited into a bullseye. A roundel is not a machine, and it
  // is certainly not a bullet: it reads as a target painted on the back of the
  // kart, which is very nearly the opposite of what the item is saying.
  //
  // Radial blades cut every one of those rings eight times. The silhouette from
  // astern becomes a hub with spokes, the alternating hazard colours give it a
  // direction of rotation the eye can hold, and — because they stand proud of
  // the stern dome — they catch the key light and give the flat back of the
  // casing somewhere for a highlight to live.
  const bladeHot = mat(0xFFC300, { roughness: 0.3, emissiveIntensity: 0.55 });
  const bladeDark = mat(0x20242E, { roughness: 0.45, metalness: 0.3 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    const r = 0.84;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.54, 0.13),
      i % 2 === 0 ? bladeHot : bladeDark);
    // The casing's axis is +Z and its centre line sits at y = 0.95, so the
    // radial plane is (x, y - 0.95). Rotating the box by -a about Z points its
    // long axis straight out along that radius.
    blade.position.set(Math.sin(a) * r, 0.95 + Math.cos(a) * r, -1.99);
    blade.rotation.z = -a;
    g.add(blade);
  }

  mergeStatic(g);
  castShadows(g, true, false);

  // ── the tail ────────────────────────────────────────────────────────────
  //
  // A balancing act with a narrow window. Too long and the plume is a metre
  // from the chase lens and the frame is fog; too short — which is what the
  // first version was — and every glowing part of it sits *inside* the stern
  // dome, leaving the driver with an unlit black hemisphere for six seconds.
  // The rule that resolves it: the stern cap ends at z ≈ -2.14, so everything
  // hot starts aft of that and nothing reaches past -3.1.
  const flare = new THREE.Mesh(new THREE.ConeGeometry(0.68, 1.2, 14, 1, true),
    glowMaterial(0x8FD0FF, 0.62));
  flare.rotation.x = -Math.PI / 2;
  flare.position.set(0, 0.95, -2.45);
  flare.name = 'flare';
  flare.userData.noShadow = true;
  flare.renderOrder = 4;
  g.add(flare);

  const core = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 10),
    glowMaterial(0xFFF6E0, 0.85));
  core.position.set(0, 0.95, -2.15);
  core.scale.z = 1.5;
  core.name = 'core';
  core.userData.noShadow = true;
  core.renderOrder = 5;
  g.add(core);

  // A pulse ring that runs out of the exhaust — thin, hot, and gone in a third
  // of a second, which is the beat that says "still under power". Wider than
  // the flare it surrounds, so it reads as a ring leaving rather than as a
  // brighter part of the same cone.
  const shock = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.08, 6, 24),
    glowMaterial(0xBFE6FF, 0.7));
  shock.position.set(0, 0.95, -2.12);
  shock.name = 'shock';
  shock.userData.noShadow = true;
  shock.renderOrder = 5;
  g.add(shock);

  return g;
}

// ── tar sprayer ────────────────────────────────────────────────────────────

/**
 * The machine that throws the tar: a **road sprayer**, launched over the field.
 *
 * This was a squid with two eyes and six tentacles. There is no reading of a
 * roadworks circuit in which the thing that dirties everybody's windscreen is a
 * cephalopod, and the item's own screen effect had already been built as tar on
 * the glass — so the object in the air was the last part still telling the other
 * studio's joke.
 *
 * A hand sprayer is the right shape as well as the right idea: a drum on a pair
 * of wheels with a spray bar under it is a *machine*, so it reads as something
 * that was thrown rather than something that is alive, and the nozzles pointing
 * down say what is about to happen to everyone in front. It is only ever seen
 * from behind and below, arcing away up the road, so the silhouette is all
 * horizontal — drum, bar, wheels — against the sky.
 */
export function buildSprayer(): THREE.Object3D {
  const g = new THREE.Group();
  const shellMat = plastic(0x39404F, 0.42, 0.06);
  const band = plastic(0xFF6B1A, 0.4, 0.18);
  const steel = plastic(0x9AA5B4, 0.44, 0.05);
  const rubber = plastic(0x1E222C, 0.7, 0.02);

  // The drum, lying across the direction of travel.
  addMesh(g, new THREE.CylinderGeometry(0.42, 0.42, 0.92, 14), shellMat, [0, 0.62, 0],
    [0, 0, Math.PI / 2]);
  for (const x of [-0.26, 0.26]) {
    addMesh(g, new THREE.CylinderGeometry(0.435, 0.435, 0.13, 14), band, [x, 0.62, 0],
      [0, 0, Math.PI / 2]);
  }
  // The filler cap on top, so the drum has an up.
  addMesh(g, new THREE.CylinderGeometry(0.12, 0.14, 0.1, 10), steel, [0.1, 1.02, 0]);

  // The spray bar and its nozzles — the business end, and the only part of this
  // that has to be legible when it is a handful of pixels over the horizon.
  addMesh(g, roundedBox(1.06, 0.09, 0.11, 0.04), steel, [0, 0.2, 0.1]);
  for (const x of [-0.36, 0, 0.36]) {
    addMesh(g, new THREE.ConeGeometry(0.075, 0.14, 8), steel, [x, 0.12, 0.1],
      [Math.PI, 0, 0]);
  }

  // Wheels, on a cross axle under the drum.
  for (const z of [-0.3, 0.32]) {
    addMesh(g, new THREE.CylinderGeometry(0.19, 0.19, 0.1, 12), rubber, [0, 0.19, z],
      [0, 0, Math.PI / 2]);
  }
  // The push handle, folded back. One diagonal on a machine of horizontals.
  for (const x of [-0.3, 0.3]) {
    addMesh(g, new THREE.CylinderGeometry(0.035, 0.035, 0.8, 6), steel,
      [x, 0.78, -0.42], [0.7, 0, 0]);
  }
  addMesh(g, new THREE.CylinderGeometry(0.04, 0.04, 0.66, 6), band, [0, 1.02, -0.66],
    [0, 0, Math.PI / 2]);

  mergeStatic(g);
  castShadows(g, true, false);

  // The plume. Not additive — this is the one effect in the module that has to
  // read as something *dark* leaving the machine, so it is a plain transparent
  // cone under the bar, wide end down.
  const plume = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 1.05, 10, 1, true),
    new THREE.MeshBasicMaterial({
      // Bitumen. It was navy, which is the colour of the thing this replaced
      // rather than of the thing it is — and the plume and the tar it puts on
      // the glass have to be the same substance or the item is two objects.
      color: 0x1B140E, transparent: true, opacity: 0.34,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }));
  plume.position.set(0, -0.4, 0.1);
  plume.rotation.x = Math.PI;
  plume.name = 'plume';
  plume.userData.noShadow = true;
  g.add(plume);
  return g;
}

// ── dust sheet ─────────────────────────────────────────────────────────────

/**
 * What hides you while you rummage through somebody's toolbox: a **dust sheet**.
 *
 * It was a boo — a white blob with two eyes and a mouth. The eyes were the whole
 * problem: they made the object a *character*, and a character from a game this
 * one is not. A sheet does the same job in this world's own language, and the
 * job is unchanged: a pale, half-there shape draped over the machine that says
 * "you cannot be seen and neither can they see you coming".
 *
 * What replaces the face is the hem. A rectangle of canvas hanging in the air
 * would be a flag; a *draped* one — high in the middle, scalloped along the
 * bottom, with brass eyelets catching the light where it hangs — is a dust sheet
 * with something under it, which is exactly the read.
 */
export function buildDustSheet(): THREE.Object3D {
  const g = new THREE.Group();
  const canvas = new THREE.MeshStandardMaterial({
    color: 0xF2EADA, emissive: 0xD8CDB4, emissiveIntensity: 0.3,
    roughness: 0.85, transparent: true, opacity: 0.72, depthWrite: false,
  });
  // The drape: taller than it is wide, so it hangs rather than floats.
  const drape = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12), canvas);
  drape.position.y = 0.55;
  drape.scale.set(1, 1.06, 0.92);
  g.add(drape);
  // The hem. Five lobes at uneven heights — cloth that has been thrown over
  // something does not hang level, and the unevenness is what stops the
  // silhouette reading as a dome.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + 0.5;
    const lobe = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), canvas);
    lobe.position.set(Math.sin(a) * 0.36, 0.2 - (i % 2) * 0.08, Math.cos(a) * 0.34);
    lobe.scale.set(0.9, 1.5 + (i % 3) * 0.25, 0.9);
    g.add(lobe);
  }
  // One corner caught and lifted, which is the only asymmetry it needs.
  const corner = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.44, 7), canvas);
  corner.position.set(-0.44, 0.72, 0.24);
  corner.rotation.set(0.3, 0, 0.9);
  g.add(corner);

  // Eyelets. Small, dark, unlit rings along the hem — the detail that names the
  // object, in the same way the two dots used to name the one it replaces.
  const brass = new THREE.MeshBasicMaterial({ color: 0x6E5B36, toneMapped: false });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.9;
    const eye = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.018, 5, 10), brass);
    eye.position.set(Math.sin(a) * 0.4, 0.1 + (i % 2) * 0.06, Math.cos(a) * 0.38);
    eye.rotation.set(Math.PI / 2, 0, 0);
    g.add(eye);
  }
  g.traverse((o) => { o.userData.noShadow = true; });
  return g;
}

// ── effects ────────────────────────────────────────────────────────────────

/**
 * The super horn's shockwave. Scaled by the entity to its blast radius.
 *
 * Flat annuli rather than tori, and that is the whole point: a torus scaled
 * nine times in X and Z but not in Y becomes a ribbon six centimetres thick
 * seen almost edge-on, which is to say invisible — which is exactly what
 * happened to the first version of this. A `RingGeometry` keeps its proportions
 * because its thickness is *in* the plane being scaled.
 *
 * The dome on top is what stops it reading as a decal on the road.
 */
export function buildRing(color: number): THREE.Object3D {
  const g = new THREE.Group();

  // Two annuli, and they are the part of the wave that stays in shot: they
  // sweep out across the road *ahead* of the kart, which is the one direction
  // the chase camera is pointing.
  //
  // Their width is set by what happens at the end. A band a third of the radius
  // thick is fine at one metre and is a solid orange floor at nine, because the
  // last thing the wave does before it dies is pass under the lens — so the
  // final read of a super horn was "the road turned orange". A seventh of the
  // radius stays a *ring* all the way out, and the gap between the two is what
  // says it is travelling.
  const outer = new THREE.Mesh(new THREE.RingGeometry(0.86, 1.0, 56), glowMaterial(color, 0.72));
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = 0.02;
  g.add(outer);

  const inner = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.65, 48), glowMaterial(0xFFF8F0, 0.6));
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.03;
  g.add(inner);

  // Tall, not flat. A ground-hugging ring centred on the kart that fired it is
  // invisible from that kart's own chase camera — it expands straight past the
  // lens at knee height. A dome sweeps *up* through the view instead, which is
  // the thing the player is supposed to feel go off around them.
  //
  // Front faces only, and that single word is the whole design. This dome grows
  // to nine metres in under half a second, so for most of its life the camera is
  // *inside* it — and a two-sided additive shell seen from within is a wall of
  // orange painted over the road, which is exactly what it photographed as.
  // Culling the back faces means the wave is drawn while it is still in front of
  // the player, and vanishes the instant it has swept past them. That is also
  // what a shockwave does.
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.95, 20, 12, 0, TAU, 0, Math.PI * 0.5),
    rimMaterial(color, 2.2, 1.35, 0.03));
  dome.scale.y = 0.62;
  g.add(dome);

  g.traverse((o) => { o.userData.noShadow = true; });
  return g;
}

/**
 * An explosion: a hot core, a fresnel shell, and a ground ring.
 *
 * A bob-omb that goes off next to you puts the camera *inside* this, and the
 * obvious build — two additive icosahedra at full opacity — is unrecoverable
 * there: an eighty-face ball six metres across seen from a metre away is a
 * single flat triangle of orange laid over a third of the screen, with a
 * straight edge across it where two faces meet. It photographed exactly like a
 * rendering fault.
 *
 * The fix is the same one the star aura and the horn's dome needed. Drive the
 * outer shell off the fresnel term so it is nearly transparent face-on and
 * burns at the silhouette, subdivide it far enough that the silhouette is a
 * curve rather than a polygon, and keep the solid white-hot part small enough
 * that it never fills the lens.
 */
export function buildBlast(): THREE.Object3D {
  const g = new THREE.Group();
  // The only part of this that is a solid fill, and it is kept small for the
  // same reason: a bob-omb that goes off three metres from the lens put a
  // pale-yellow ball across a hundred and thirty degrees of view.
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 2), glowMaterial(0xFFE7A8, 0.9));
  g.add(core);
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 3),
    rimMaterial(0xFF7A22, 1.7, 1.6, 0.06));
  shell.name = 'shell';
  g.add(shell);
  const flame = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, 3),
    rimMaterial(0xFFC85A, 2.4, 1.5, 0.05));
  flame.name = 'flame';
  g.add(flame);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.1, 8, 40), glowMaterial(0xFFC300, 0.85));
  ring.rotation.x = -Math.PI / 2;
  ring.name = 'ring';
  g.add(ring);
  g.traverse((o) => { o.userData.noShadow = true; });
  return g;
}

/**
 * The contact shadow and the flight halo an item in flight needs.
 *
 * Both exist for the same reason and it is ARCHITECTURE §12: every object needs
 * a grounded shadow, and a projectile crossing a road at sixty metres a second
 * needs something brighter than its own diffuse colour or it is a coloured lump
 * on a coloured road. Photographed without these, a green shell in mid-flight
 * was indistinguishable from a fleck of scenery and a red shell fired seven
 * tenths of a second earlier could not be found in the frame at all.
 *
 * The shadow's local Y is written per frame by the entity field, because how
 * far the item is off the road is the only thing that makes it read as flying.
 */
/**
 * The contact shadow itself.
 *
 * Its own texture rather than the vehicle rig's, and for one measured reason:
 * the shared blob peaks at 62% alpha, which is right under a kart that is also
 * casting a real shadow-map shadow, and *invisible* under an item on this
 * circuit's tarmac. Photographed with the map stripped out and the colour
 * forced to red, five box shadows were plainly there and correctly placed; with
 * the map back on, none of them could be found. A shadow you cannot see is a
 * shadow that does not exist.
 */
/**
 * A soft dark disc that *multiplies* the road underneath it.
 *
 * The obvious build — the vehicle rig's blob texture, a black radial gradient
 * with alpha — was tried first and photographs as nothing at all on this
 * circuit's tarmac. It is not a placement problem: with the map stripped out
 * and the colour forced to red, five box shadows appeared exactly where they
 * belonged. It is that a soft alpha-blended black over asphalt this dark has
 * almost no contrast left to spend.
 *
 * Multiply blending has no such problem. The falloff is carried in the vertex
 * colour — 1 at the rim, which is a no-op, down to `darkness` at the middle —
 * so the disc scales the road's own brightness instead of trying to out-paint
 * it, needs no texture, and stays a shadow on tarmac, on dirt and on paint.
 *
 * **It needs a core, and for two rounds it did not have one.** The build this
 * replaces was a single triangle fan: one dark vertex at the centre, `seg` pale
 * ones round the rim, and a linear ramp between them. Exactly one *point* of
 * that disc ever reached `darkness`. Integrated over the area — which is what a
 * photograph measures — a fan from 0.20 to 1.0 multiplies the road by 0.73, so
 * a shadow authored at "take four fifths of the light away" delivered "take a
 * quarter of it away, in the middle, fading to nothing", and every item in the
 * game photographed as floating: five boxes in an overhead frame with hard
 * black kart shadows beside them and not one of their own, three hats orbiting
 * a kart that was casting one.
 *
 * So it is built as concentric rings instead, with the inner 55% *solid* at
 * `darkness` and the feather spent on the outer 45%. Same vertex format, same
 * material, one draw call — the mean is now 0.35 rather than 0.73 for the same
 * authored number, and the disc reads as a shadow because it has a body.
 */
export function contactShadowGeometry(radius: number, darkness = 0.34, seg = 22): THREE.BufferGeometry {
  // Radius and shade at each ring. The first two carry the same value, which is
  // what makes the core solid; the last is 1, which under multiply blending is
  // a no-op and therefore an invisible edge.
  const rings: ReadonlyArray<readonly [number, number]> = [
    [0, darkness],
    [0.55, darkness],
    [0.80, darkness + (1 - darkness) * 0.40],
    [1, 1],
  ];
  // One triangle per segment for the inner fan, two for each of the two bands.
  const tris = seg * 5;
  const pos = new Float32Array(tris * 3 * 3);
  const col = new Float32Array(tris * 3 * 3);
  let k = 0;
  const put = (x: number, y: number, c: number): void => {
    pos[k] = x; pos[k + 1] = y; pos[k + 2] = 0;
    col[k] = c; col[k + 1] = c; col[k + 2] = c;
    k += 3;
  };
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * TAU;
    const a1 = ((i + 1) / seg) * TAU;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    // The solid middle.
    put(0, 0, rings[0]![1]);
    put(c0 * rings[1]![0] * radius, s0 * rings[1]![0] * radius, rings[1]![1]);
    put(c1 * rings[1]![0] * radius, s1 * rings[1]![0] * radius, rings[1]![1]);
    // ...and the two feather bands outside it.
    for (let b = 1; b < rings.length - 1; b++) {
      const [ri, vi] = rings[b]!;
      const [ro, vo] = rings[b + 1]!;
      put(c0 * ri * radius, s0 * ri * radius, vi);
      put(c0 * ro * radius, s0 * ro * radius, vo);
      put(c1 * ro * radius, s1 * ro * radius, vo);
      put(c0 * ri * radius, s0 * ri * radius, vi);
      put(c1 * ro * radius, s1 * ro * radius, vo);
      put(c1 * ri * radius, s1 * ri * radius, vi);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export function contactShadowMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0xFFFFFF, vertexColors: true, blending: THREE.MultiplyBlending,
    // three insists on this for MultiplyBlending, and warns once per draw call
    // if it is missing. With the falloff carried in the vertex colour and the
    // material at full opacity it changes nothing about the result.
    premultipliedAlpha: true,
    transparent: true, depthWrite: false, toneMapped: false,
    // A blob lies within a few centimetres of the surface it is a shadow *on*,
    // and this road is crowned and banked — so the disc and the tarmac
    // interpenetrate, and the depth test eats whichever part of the disc lost.
    // Photographed, that is a shadow reduced to a thin crescent, or to nothing.
    // Biasing the fragment toward the camera is the standard answer and costs a
    // state change; the alternative — lifting the disc far enough to clear the
    // crown — is a shadow visibly floating off the ground.
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12,
  });
}

/** A flat contact shadow lying in the XZ plane, ready to parent to an item. */
export function contactShadow(size: number, darkness = 0.26): THREE.Mesh {
  const mesh = new THREE.Mesh(
    contactShadowGeometry(size * 0.5, darkness), contactShadowMaterial());
  mesh.name = 'shadow';
  mesh.renderOrder = -1;
  mesh.userData.noShadow = true;
  return mesh;
}

export function addProjectileShadow(node: THREE.Object3D, size = 1.15): void {
  // 0.24, not 0.42. Multiply blending scales the road's own brightness, and
  // this road is asphalt — there is not much brightness there to scale, so a
  // disc that only takes 58% of it off is a shadow you have to be told about.
  node.add(contactShadow(size, 0.24));
}

export function addProjectileGlow(node: THREE.Object3D, color: number, radius = 0.62): void {
  // Inside the silhouette, not around it. A halo wider than the object it
  // belongs to *replaces* it: photographed in flight, a 0.72m glow around a
  // 0.58m hat was a featureless green dome with no brim, no crown and no
  // rotation — the model was still there, entirely hidden inside its own light.
  const glow = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 10),
    rimMaterial(color, 2.4, 0.85, 0.03));
  glow.name = 'glow';
  glow.position.y = 0.26;
  glow.userData.noShadow = true;
  glow.renderOrder = 4;
  node.add(glow);
}

/**
 * What a bob-omb leaves on the road.
 *
 * A blast that vanishes without a trace is an event the track has no memory of,
 * and the road is the thing the player is looking at. The scorch is a soft dark
 * mark with a ring of embers cooling in it — the embers are gone in a second,
 * the mark takes several, and by the next lap there is nothing.
 *
 * Built at unit radius and scaled by the entity.
 */
export function buildScorch(): THREE.Object3D {
  const g = new THREE.Group();
  const mark = makeShadowBlob(2, 2);
  const mm = mark.material as THREE.MeshBasicMaterial;
  mm.color.setHex(0x171A20);
  mm.opacity = 0.85;
  mark.name = 'mark';
  mark.position.y = 0.03;
  g.add(mark);

  // A ring of ash, and it is the part that actually reads. Tarmac is nearly
  // black, so a *dark* mark on it is a change of a few percent and photographs
  // as nothing at all — which is exactly what the first version of this did.
  // What survives on a dark road is the pale rim a blast throws outwards.
  const ash = new THREE.Mesh(new THREE.RingGeometry(0.52, 1.0, 32),
    new THREE.MeshBasicMaterial({
      color: 0xA89A88, transparent: true, opacity: 0.45,
      depthWrite: false, toneMapped: false,
    }));
  ash.rotation.x = -Math.PI / 2;
  ash.position.y = 0.05;
  ash.name = 'ash';
  ash.renderOrder = -1;
  g.add(ash);

  const embers = new THREE.Mesh(new THREE.RingGeometry(0.48, 0.92, 32),
    glowMaterial(0xFF7A22, 0.85));
  embers.rotation.x = -Math.PI / 2;
  embers.position.y = 0.07;
  embers.name = 'embers';
  g.add(embers);

  g.traverse((o) => { o.userData.noShadow = true; });
  return g;
}

/**
 * The starburst that marks a connection, and the flare a box comes apart in.
 *
 * Three parts, on three clocks, and the count is the whole point. A single
 * additive star photographed frame by frame is a bright shape on the frame it
 * spawned and nothing two frames later — which is what the box break was: a
 * flash at 0ms, a smear at 17ms, gone by 50ms. Nobody at sixty frames a second
 * ever saw it.
 *
 * `core` is the flash — brightest, smallest, first to go. `star` is the spikes,
 * which carry the shape. `ring` is the shockwave, and it is the part that
 * actually survives: a thin expanding annulus reads at any size, against any
 * background, for as long as you let it live. The entity animates all three off
 * one age.
 */
export function buildBurst(): THREE.Object3D {
  const g = new THREE.Group();
  const geo = new THREE.ExtrudeGeometry(starShape(1, 0.34, 6), {
    depth: 0.06, bevelEnabled: false,
  });
  geo.center();
  const a = new THREE.Mesh(geo, glowMaterial(0xFFF8F0, 1));
  a.name = 'star';
  g.add(a);
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), glowMaterial(0xFFF8F0, 0.9));
  b.name = 'core';
  g.add(b);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1.0, 30),
    glowMaterial(0xFFF8F0, 0.9));
  ring.name = 'ring';
  g.add(ring);
  g.traverse((o) => { o.userData.noShadow = true; });
  return g;
}

/**
 * The star's aura.
 *
 * Three layers, and the order matters. A *rim shell* so the machine is haloed
 * rather than hidden — see `rimMaterial` for why an ordinary additive sphere is
 * the wrong answer. A *light pool* on the tarmac underneath, because a glow
 * with no ground contact floats and this one is meant to be sitting on the road
 * at 250km/h. And *orbiting stars*, which are the part the eye actually reads
 * as "invincible" — big enough to be stars rather than sparks.
 */
export const STAR_SPARKS = 10;

export function buildStarAura(): THREE.Object3D {
  const g = new THREE.Group();

  const shell = new THREE.Mesh(new THREE.SphereGeometry(1.5, 20, 14),
    rimMaterial(0xFFD84D, 2.8, 1, 0.03));
  shell.scale.set(1.16, 0.88, 1.3);
  shell.position.y = 0.72;
  shell.name = 'shell';
  shell.renderOrder = 6;
  g.add(shell);

  // The pool. Flat on the road, additive, so an invincible kart lights the
  // tarmac it is standing on. Feathered rather than cut: see
  // `radialGlowGeometry`.
  //
  // Two metres, not three, and that is a correction rather than a taste. A
  // ground disc six metres across, six centimetres above the road, sits between
  // a chase camera and everything the player is steering by: photographed from
  // behind the kart it filled the whole lower half of the frame with gold and
  // the road, the kerb and the machine itself went with it. The pool's job is
  // to say the kart is *on* the road at 250km/h, and it can do that at four
  // metres across — which is still wider than the widest machine in the cast —
  // without becoming the floor.
  const poolGeo = radialGlowGeometry(2.0, 28);
  poolGeo.rotateX(-Math.PI / 2);
  const pool = new THREE.Mesh(poolGeo, new THREE.MeshBasicMaterial({
    color: 0xFFD84D, vertexColors: true, transparent: true, opacity: 0.4,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  pool.position.y = 0.06;
  pool.name = 'pool';
  pool.renderOrder = 5;
  g.add(pool);

  const sparkGeo = new THREE.ExtrudeGeometry(starShape(0.34, 0.14), { depth: 0.05, bevelEnabled: false });
  sparkGeo.center();
  for (let i = 0; i < STAR_SPARKS; i++) {
    const s = new THREE.Mesh(sparkGeo, glowMaterial(0xFFF3B0, 0.95));
    s.name = `spark${i}`;
    s.renderOrder = 7;
    g.add(s);
  }
  g.traverse((o) => { o.userData.noShadow = true; });
  return g;
}

/**
 * The sheet's shroud: what a racer looks like while they are under it.
 *
 * The user has to be able to see that *they* are the one who has gone
 * spectral — the alternative is an item whose only tell is a stolen shell four
 * seconds later. A pale rim and a corner of canvas flapping alongside does it
 * in one frame.
 */
export function buildSheetShroud(): THREE.Object3D {
  const g = new THREE.Group();
  // A *tight* rim, and no face-on core at all. The star can afford a lit core
  // because a star is meant to be blinding; this cannot, because it lasts four
  // and a half seconds and the player has to keep driving through it. At power
  // 3.0 with a 0.05 core this photographed as an opaque milky bubble with the
  // kart nowhere to be seen — which is not "spectral", it is "broken".
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1.38, 16, 12),
    rimMaterial(0xCFE0FF, 4.2, 1.1, 0.025));
  shell.scale.set(1.1, 0.92, 1.26);
  shell.position.y = 0.68;
  shell.name = 'shell';
  shell.renderOrder = 6;
  g.add(shell);

  // The passenger sits *outboard*. On the axis it read as a white growth on top
  // of whatever machine was underneath it — photographed over a road cone, the
  // sheet and the cone's tip fused into one pale lump and neither shape
  // survived. Off to one side and level with the roofline it is plainly a
  // second object, riding along, which is the whole joke.
  const sheet = buildDustSheet();
  sheet.name = 'rider';
  sheet.scale.setScalar(0.7);
  sheet.position.set(0.95, 1.55, -0.35);
  g.add(sheet);

  g.traverse((o) => { o.userData.noShadow = true; });
  return g;
}

// ── coins ──────────────────────────────────────────────────────────────────

export function coinGeometry(): THREE.BufferGeometry {
  // A bevelled disc, lathed rather than boxed: the chamfer is what catches the
  // key light and makes a spinning coin flash instead of strobing between two
  // flat sides. Cheap on purpose — there are a couple of hundred of these on
  // the circuit and every triangle is paid for once per frame.
  // The profile carries a stamped face: a raised outer band, a step down into
  // the field, and a boss in the middle. All of it is *shape*, so the key light
  // does the drawing — a flat disc with a texture on it would be a decal, and
  // photographed from three metres up at speed it read as a featureless gold
  // blob, which is what this replaced.
  const geo = new THREE.LatheGeometry([
    new THREE.Vector2(0.001, -0.058),
    new THREE.Vector2(0.115, -0.062),
    new THREE.Vector2(0.145, -0.040),
    new THREE.Vector2(0.300, -0.044),
    new THREE.Vector2(0.355, -0.062),
    new THREE.Vector2(0.430, -0.050),
    new THREE.Vector2(0.470, 0),
    new THREE.Vector2(0.430, 0.050),
    new THREE.Vector2(0.355, 0.062),
    new THREE.Vector2(0.300, 0.044),
    new THREE.Vector2(0.145, 0.040),
    new THREE.Vector2(0.115, 0.062),
    new THREE.Vector2(0.001, 0.058),
  ], 16);
  // Lathed about Y, but a coin stands on edge: tip it so it faces the driver.
  geo.rotateX(Math.PI / 2);
  return geo;
}

export function coinMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    // Emissive is doing a job here, not decorating: a coin lying on dark tarmac
    // in the shadow of the canyon has to stay gold, and a purely lit metal
    // reads brown there.
    color: 0xFFC300, emissive: 0xFFA51F, emissiveIntensity: 0.55,
    roughness: 0.24, metalness: 0.45,
  });
}

// ── the item box ───────────────────────────────────────────────────────────

/**
 * The `?` itself, as a path.
 *
 * Drawn rather than typed, and that is not fussiness. `fillText` depends on a
 * font actually being installed: on the headless renderer every reviewer
 * photographs this game through, "Trebuchet MS" is not, and the fallback's
 * question mark rendered with a fat round-joined outline fused its dot into its
 * stem and photographed — unmistakably — as the numeral 2. A path is the same
 * shape on every machine that will ever run this.
 */
function drawGlyph(g: CanvasRenderingContext2D, strokes: ReadonlyArray<readonly [number, string]>): void {
  const hook = new Path2D();
  hook.moveTo(38, 50);
  // Over the top of the bowl, left to right...
  hook.bezierCurveTo(37, 31, 90, 29, 86, 51);
  // ...then in and down into the stem, which stops clear of the dot.
  hook.bezierCurveTo(83, 67, 64, 67, 64, 81);
  for (const [w, style] of strokes) {
    g.lineWidth = w;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = style;
    g.stroke(hook);
    // The dot, sized off the same stroke so the two always agree.
    g.fillStyle = style;
    g.beginPath();
    g.arc(64, 104, w * 0.5, 0, TAU);
    g.fill();
  }
}

/**
 * The face texture: a hazard frame on glass, and **no glyph**.
 *
 * The glyph used to live here, on all six faces, and that was the single worst
 * read in the item system. The shell is translucent and draws with
 * `depthWrite: false` and `DoubleSide`, so a cube photographed from any angle
 * showed three to six question marks at once — the near faces the right way
 * round, the far faces mirrored, all overlapping. It did not read as a `?`. It
 * read as a scribble, and an item box that reads as a scribble is a gift-wrapped
 * parcel sitting on a racetrack.
 *
 * So the glass keeps only what glass should have — an edge — and the glyph moves
 * inside the cube as a single camera-facing billboard. See `boxGlyphMaterial`.
 */
function boxFaceTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;

  // Near-neutral, and fainter than it was. The colour of an item box is now the
  // iridescence in the shader below; a warm wash baked into the texture fought
  // it and won, which is why a row of these photographed as five identical
  // orange parcels rather than as a rainbow strung across the road.
  g.fillStyle = 'rgba(255,246,232,0.13)';
  g.fillRect(0, 0, 128, 128);

  // A hazard frame, and only a frame. Thin bands read as an edge on glass and
  // still survive mipmapping down a straight, because a frame is a shape and
  // not a detail.
  g.strokeStyle = 'rgba(255,107,26,0.92)';
  g.lineWidth = 8;
  g.strokeRect(6, 6, 116, 116);
  g.strokeStyle = 'rgba(255,248,240,0.85)';
  g.lineWidth = 3;
  g.strokeRect(17, 17, 94, 94);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * The glyph that rides inside the cube, on its own transparent plate.
 *
 * One per box, always square to the lens, so there is exactly one `?` on screen
 * per item box no matter where the camera is. Three strokes, widest first: a
 * dark backing so it survives against a bright sky, a hazard-orange midline,
 * then the white face — the same treatment every readable sign in this game
 * gets, because half this circuit is framed against cloud and half against
 * tarmac.
 */
export function boxGlyphMaterial(): THREE.MeshBasicMaterial {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  // Widest first: a near-black rim so the mark holds against cloud *and* against
  // tarmac, a hazard keyline for warmth, then a broad white core. It used to be
  // the other way round — a 16px orange stroke with a 9px white centre — which
  // made the `?` a mid-tone orange-brown mark on a pale translucent face. Two
  // mid-tones against each other is the one contrast pairing that dies first at
  // distance, and at forty metres the glyph was simply not there.
  drawGlyph(g, [
    [30, 'rgba(20,23,32,0.96)'], [22, 'rgba(255,107,26,1)'], [14, '#FFFDF6'],
  ]);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, toneMapped: false,
    // Alpha, not additive. An additive glyph over a bright sky is a ghost, and
    // the whole point of this plate is that the `?` is the one thing about an
    // item box that is legible from anywhere.
    side: THREE.FrontSide,
  });
}

export function boxGlyphGeometry(size = 1.1): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(size, size);
}

export interface BoxMaterials {
  shell: THREE.MeshStandardMaterial;
  core: THREE.MeshBasicMaterial;
  glyph: THREE.MeshBasicMaterial;
  /** The chips a broken box throws. Opaque and lit — see `makeBoxMaterials`. */
  shard: THREE.MeshStandardMaterial;
  /** Advance the iridescence. Visual only. */
  tick(t: number): void;
  dispose(): void;
}

/**
 * The hue every box is wearing right now — the CPU-side twin of `mcHue` in the
 * shell shader, and it takes no position because the shader's seed no longer
 * does either. One colour, cycling, shared by the whole circuit: see the
 * `vMcSeed` note in `makeBoxMaterials` for why five different-coloured boxes in
 * a row is a bug and not a flourish.
 */
export function boxHue(t: number, out: THREE.Color): THREE.Color {
  const h = t * 0.16 + 0.27;
  return out.setRGB(
    0.55 + 0.45 * Math.cos(TAU * h),
    0.55 + 0.45 * Math.cos(TAU * (h + 0.33)),
    0.55 + 0.45 * Math.cos(TAU * (h + 0.67)),
  );
}

/**
 * The box shell: glassy, and *iridescent* — the hue sweeps around the cube with
 * view angle and with time. That shimmer is the single cue that says "pick this
 * up" from across the circuit, and a flat translucent cube does not have it.
 *
 * Done by patching the standard material rather than writing a custom shader,
 * so the box still takes the scene's own lighting, fog and tone mapping.
 */
export function makeBoxMaterials(): BoxMaterials {
  const tex = boxFaceTexture();
  const uTime = { value: 0 };

  const shell = new THREE.MeshStandardMaterial({
    color: 0xFFF8F0,
    map: tex,
    transparent: true,
    // 0.58, not 0.9. This is the number that decides whether the cube is glass
    // or painted plastic, and at 0.9 — over a face texture that was itself more
    // than half solid orange — it was plastic. You have to be able to see the
    // far side of the box through the near one; that is the whole read.
    opacity: 0.58,
    roughness: 0.1,
    metalness: 0.0,
    emissive: 0xFFFFFF,
    // An item box is a light source in every kart racer ever made: it has to
    // hold its colour in the shadow of a canyon wall, and a purely lit box goes
    // brown there and stops looking like a pickup. Pulled back with the opacity
    // so the glass is lit rather than painted.
    emissiveIntensity: 0.38,
    emissiveMap: tex,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  shell.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vMcNormal;
        varying vec3 vMcView;
        varying float vMcSeed;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        // The boxes are one InstancedMesh, so the instance rotation has to be
        // folded into both the position and the normal by hand — three only
        // does it for the attributes its own lighting path uses.
        vec4 mcLocal = vec4( transformed, 1.0 );
        vec3 mcNormal = objectNormal;
        vec3 mcOrigin = vec3( 0.0 );
        #ifdef USE_INSTANCING
          mcLocal = instanceMatrix * mcLocal;
          mcNormal = mat3( instanceMatrix ) * mcNormal;
          mcOrigin = instanceMatrix[ 3 ].xyz;
        #endif
        vec4 mcWorld = modelMatrix * mcLocal;
        vMcNormal = normalize( mat3( modelMatrix ) * mcNormal );
        vMcView = normalize( cameraPosition - mcWorld.xyz );
        // **Every box is the same box.** The seed is a constant, not a function
        // of where the cube stands, and that is a gameplay decision rather than
        // an art one. A row of five in five different colours is a *false
        // affordance*: a player reads five distinct objects and concludes the
        // colour picks the item, spends a lap testing the theory, and learns
        // that the game lied to them. Mario Kart makes every box identical
        // precisely because the unknown is the whole point of the pickup.
        // The shimmer stays — it comes from view angle and time below, which
        // vary across a single cube's faces and give it life without ever
        // making two boxes different from each other.
        vMcSeed = 0.0;
        mcOrigin;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        varying vec3 vMcNormal;
        varying vec3 vMcView;
        varying float vMcSeed;
        vec3 mcHue( float h ) {
          return 0.55 + 0.45 * cos( 6.28318 * ( h + vec3( 0.0, 0.33, 0.67 ) ) );
        }`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        // Fresnel sweeps the hue *across each face* as well as round the
        // silhouette. The old exponent of 1.8 confined the whole rainbow to the
        // grazing rim, so a cube seen square-on — which is most of them, most of
        // the time — wore only the warm base colour and photographed as painted
        // card. At 1.0 the sweep covers the face and the box is iridescent from
        // every angle a player can reach.
        float mcF = 1.0 - abs( dot( normalize( vMcNormal ), normalize( vMcView ) ) );
        vec3 mcTint = mcHue( vMcSeed + mcF * 0.55 + uTime * 0.16 );
        // Held below a blow-out: the shimmer has to sit *on* the faces, not
        // erase them. A box that clips to white loses its frame, which is the
        // only thing holding its silhouette together at distance.
        gl_FragColor.rgb += mcTint * ( mcF * 0.62 + 0.30 );
        gl_FragColor.a = clamp( gl_FragColor.a + mcF * mcF * 0.42, 0.0, 1.0 );`);
  };

  // The light *behind* the glyph, not the thing in the middle of the box. It
  // was the octahedron that photographed as a white blob crowding the `?`; now
  // it is a small backing lamp that gives the plate something to sit against.
  const core = new THREE.MeshBasicMaterial({
    color: 0xFFEFC0, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });

  const glyph = boxGlyphMaterial();

  /**
   * What the box comes apart into.
   *
   * Opaque and lit, deliberately — the shell is glass and the shards are not.
   * A shatter made of translucent pieces of the same material photographs as
   * the box going slightly blurry; a spray of hard hazard-yellow chips reads,
   * on the single frame most players ever see of it, as a thing being broken.
   */
  const shard = new THREE.MeshStandardMaterial({
    color: 0xFFC300, emissive: 0xFF8A2A, emissiveIntensity: 0.55,
    roughness: 0.32, metalness: 0, flatShading: true,
  });

  return {
    shell,
    core,
    glyph,
    shard,
    tick(t: number): void { uTime.value = t; },
    dispose(): void {
      tex.dispose();
      shell.dispose();
      core.dispose();
      shard.dispose();
      glyph.map?.dispose();
      glyph.dispose();
    },
  };
}

export function boxShellGeometry(size = 1.5): THREE.BufferGeometry {
  return roundedBox(size, size, size, size * 0.19, 3);
}

export function boxCoreGeometry(size = 1.5): THREE.BufferGeometry {
  return new THREE.OctahedronGeometry(size * 0.24, 0);
}

/**
 * The halo behind an item box: a soft radial billboard.
 *
 * A 1.8m cube is four pixels tall at eighty metres, and four pixels of
 * translucent glass on a road the same colour as the sky is invisible. The
 * halo is what survives that distance — it is the reason a player *aims* at a
 * box from the exit of the previous corner instead of noticing it at ten
 * metres. Vertex-coloured so the falloff costs no texture.
 */
export function boxHaloGeometry(radius = 2.5): THREE.BufferGeometry {
  return radialGlowGeometry(radius, 20);
}

export function boxHaloMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    // White, because the hue arrives per instance — see `boxHue` and
    // `setColorAt` in the box field. A tinted base would multiply into it and
    // pull every box back toward the same warm smear.
    // 0.55, not 0.7, and the disc it is painted on is now less than a third of
    // the area it was — see HALO_R in boxes.ts. An additive glow that reaches
    // past the object it belongs to does not read as that object glowing, it
    // reads as a coloured light being shone on whatever is behind it, and what
    // was behind it here was the racing line.
    color: 0xFFFFFF, vertexColors: true, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
}
