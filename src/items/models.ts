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
import { mat, roundedBox, mergeStatic, castShadows } from '../vehicles/parts.ts';

const TAU = Math.PI * 2;

// ── shared helpers ─────────────────────────────────────────────────────────

/** Unlit, additive-ish glow. Owns its material so callers may fade it. */
function glowMaterial(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false,
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

// ── banana ─────────────────────────────────────────────────────────────────

/**
 * A swept arc whose radius tapers to a point at both ends. A tube alone reads
 * as a sausage; the taper is the whole difference between that and a banana.
 */
function bananaGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  const R = 0.62;
  for (let i = 0; i <= 6; i++) {
    const a = (-0.62 + (i / 6) * 1.24) * Math.PI * 0.62;
    pts.push(new THREE.Vector3(Math.sin(a) * R, Math.cos(a) * R * 0.34, -Math.cos(a) * R));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, 22, 0.17, 8, false);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const centre = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const u = uv.getX(i);
    curve.getPointAt(Math.min(0.999, Math.max(0.001, u)), centre);
    // Fat in the middle, pinched at the tips, with the stalk end a little
    // blunter than the flower end.
    const s = Math.pow(Math.sin(Math.PI * u), 0.5) * (0.72 + 0.4 * u);
    v.fromBufferAttribute(pos, i).sub(centre).multiplyScalar(s).add(centre);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  geo.translate(0, 0.2, 0);
  return geo;
}

export function buildBanana(): THREE.Object3D {
  const g = new THREE.Group();
  addMesh(g, bananaGeometry(), plastic(0xFFD429, 0.38, 0.09));
  // The stalk. Four triangles that make the shape read the right way round.
  addMesh(g, new THREE.ConeGeometry(0.085, 0.22, 6), plastic(0x6B4A18, 0.7, 0.02),
    [0.29, 0.28, -0.5], [0.5, 0, -0.7]);
  mergeStatic(g);
  castShadows(g, true, false);
  return g;
}

// ── shells ─────────────────────────────────────────────────────────────────

export function buildShell(color: number, spot: number): THREE.Object3D {
  const g = new THREE.Group();
  const shellMat = plastic(color, 0.3, 0.14);
  const rimMat = plastic(0xFFF8F0, 0.35, 0.08);

  const dome = addMesh(g, new THREE.SphereGeometry(0.42, 18, 10, 0, TAU, 0, Math.PI * 0.52),
    shellMat, [0, 0.14, 0]);
  dome.scale.y = 1.06;
  // The white rim is what makes a green sphere read as a shell.
  addMesh(g, new THREE.TorusGeometry(0.4, 0.085, 8, 22), rimMat, [0, 0.14, 0], [Math.PI / 2, 0, 0]);
  addMesh(g, new THREE.SphereGeometry(0.4, 16, 6, 0, TAU, Math.PI * 0.5, Math.PI * 0.5),
    rimMat, [0, 0.14, 0], undefined, [1, 0.42, 1]);

  // Three plates on the crown, so rotation is visible when it is spinning.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    const m = addMesh(g, new THREE.SphereGeometry(0.13, 8, 6), plastic(spot, 0.35, 0.06),
      [Math.sin(a) * 0.23, 0.36, Math.cos(a) * 0.23]);
    m.scale.y = 0.42;
  }
  mergeStatic(g);
  castShadows(g, true, false);
  return g;
}

// ── mushroom ───────────────────────────────────────────────────────────────

export function buildMushroom(cap = 0xFF5B4A): THREE.Object3D {
  const g = new THREE.Group();
  const capMat = plastic(cap, 0.4, 0.12);
  const creamMat = plastic(0xFFF3E2, 0.45, 0.08);

  const dome = addMesh(g, new THREE.SphereGeometry(0.38, 16, 10, 0, TAU, 0, Math.PI * 0.55),
    capMat, [0, 0.2, 0]);
  dome.scale.set(1, 0.86, 1);
  addMesh(g, new THREE.TorusGeometry(0.355, 0.07, 6, 18), capMat, [0, 0.21, 0], [Math.PI / 2, 0, 0]);
  // Stalk: a short taper, wider at the foot, so it sits rather than balances.
  addMesh(g, new THREE.CylinderGeometry(0.17, 0.21, 0.24, 12), creamMat, [0, 0.1, 0]);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    const r = i % 2 === 0 ? 0.2 : 0.09;
    const d = addMesh(g, new THREE.SphereGeometry(i % 2 === 0 ? 0.105 : 0.075, 8, 6), creamMat,
      [Math.sin(a) * r, 0.36 + (i % 2 === 0 ? 0.02 : 0.06), Math.cos(a) * r]);
    d.scale.y = 0.5;
  }
  mergeStatic(g);
  castShadows(g, true, false);
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

// ── bob-omb ────────────────────────────────────────────────────────────────

export function buildBomb(): THREE.Object3D {
  const g = new THREE.Group();
  const body = plastic(0x2E3340, 0.34, 0.03);
  addMesh(g, new THREE.SphereGeometry(0.36, 16, 12), body, [0, 0.36, 0]);
  // A hazard band, because everything in this world is a roadworks machine.
  addMesh(g, new THREE.TorusGeometry(0.355, 0.055, 6, 20), plastic(0xFF6B1A, 0.4, 0.16),
    [0, 0.36, 0], [Math.PI / 2, 0, 0]);
  addMesh(g, new THREE.CylinderGeometry(0.05, 0.065, 0.26, 6), plastic(0x8E99A8, 0.5, 0.02),
    [0.08, 0.76, 0], [0, 0, -0.45]);
  mergeStatic(g);
  castShadows(g, true, false);

  // The fuse spark keeps its own material: it is pulsed per bomb, per frame.
  const spark = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), glowMaterial(0xFFE9A8, 0.9));
  spark.name = 'spark';
  spark.position.set(0.18, 0.88, 0);
  spark.userData.noShadow = true;
  g.add(spark);
  return g;
}

// ── the bullet husk ────────────────────────────────────────────────────────

/**
 * A bullet bill turns the *kart* into the projectile, so what is drawn is a
 * translucent casing thrown around whatever machine the player picked. Big
 * enough to swallow a train, additive so the kart still reads through it.
 */
export function buildBulletHusk(): THREE.Object3D {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({
    color: 0x5A6478, emissive: 0x9FC4FF, emissiveIntensity: 0.5,
    roughness: 0.25, metalness: 0.4, transparent: true, opacity: 0.42,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.35, 2.4, 6, 18), skin);
  body.rotation.x = Math.PI / 2;
  body.position.y = 0.9;
  body.scale.set(0.86, 1, 0.86);
  g.add(body);

  const eye = new THREE.MeshBasicMaterial({ color: 0xFFF8F0, transparent: true, opacity: 0.9, toneMapped: false });
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), eye);
    e.position.set(sx * 0.62, 1.35, 1.55);
    e.scale.z = 0.5;
    g.add(e);
  }
  // Exhaust flare at the tail.
  const flare = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.4, 12, 1, true), glowMaterial(0x9FD6FF, 0.5));
  flare.rotation.x = Math.PI / 2;
  flare.position.set(0, 0.9, -2.6);
  flare.name = 'flare';
  g.add(flare);
  g.traverse((o) => { o.userData.noShadow = true; });
  return g;
}

// ── blooper ────────────────────────────────────────────────────────────────

export function buildBlooper(): THREE.Object3D {
  const g = new THREE.Group();
  const skin = plastic(0xF2F6FF, 0.5, 0.1);
  const head = addMesh(g, new THREE.SphereGeometry(0.62, 16, 12), skin, [0, 0.2, 0]);
  head.scale.set(1, 1.22, 0.94);
  // Tentacles, splayed. They are the read at distance, so they are long.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const t = addMesh(g, new THREE.ConeGeometry(0.11, 0.9, 6), skin,
      [Math.sin(a) * 0.3, -0.45, Math.cos(a) * 0.3],
      [Math.cos(a) * 0.32, 0, -Math.sin(a) * 0.32]);
    t.scale.y = 1 + (i % 2) * 0.35;
  }
  mergeStatic(g);
  castShadows(g, true, false);

  const dark = plastic(0x2C3550, 0.4, 0.02);
  for (const sx of [-1, 1]) {
    const e = addMesh(g, new THREE.SphereGeometry(0.2, 10, 8), plastic(0xFFFFFF, 0.3, 0.1),
      [sx * 0.26, 0.28, 0.52]);
    e.scale.z = 0.55;
    const p = addMesh(g, new THREE.SphereGeometry(0.1, 8, 6), dark, [sx * 0.28, 0.26, 0.66]);
    p.scale.z = 0.5;
  }
  return g;
}

// ── boo ────────────────────────────────────────────────────────────────────

export function buildBoo(): THREE.Object3D {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({
    color: 0xEFF3FF, emissive: 0xBFD2FF, emissiveIntensity: 0.35,
    roughness: 0.6, transparent: true, opacity: 0.72, depthWrite: false,
  });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12), skin);
  head.position.y = 0.55;
  g.add(head);
  // A scalloped skirt: three lobes hanging off the underside.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    const lobe = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), skin);
    lobe.position.set(Math.sin(a) * 0.3, 0.18, Math.cos(a) * 0.3);
    lobe.scale.y = 1.5;
    g.add(lobe);
  }
  const dark = new THREE.MeshBasicMaterial({ color: 0x2B3149, toneMapped: false });
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), dark);
    e.position.set(sx * 0.2, 0.62, 0.46);
    e.scale.set(0.8, 1.25, 0.5);
    g.add(e);
  }
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), dark);
  mouth.position.set(0, 0.4, 0.46);
  mouth.scale.set(1, 0.55, 0.4);
  g.add(mouth);
  g.traverse((o) => { o.userData.noShadow = true; });
  return g;
}

// ── effects ────────────────────────────────────────────────────────────────

/** The super horn's shockwave, and the bob-omb's. Scaled by the entity. */
export function buildRing(color: number): THREE.Object3D {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 6, 40), glowMaterial(color, 0.9));
  ring.rotation.x = -Math.PI / 2;
  g.add(ring);
  const inner = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.035, 6, 32), glowMaterial(0xFFF8F0, 0.7));
  inner.rotation.x = -Math.PI / 2;
  g.add(inner);
  g.traverse((o) => { o.userData.noShadow = true; });
  return g;
}

/** An explosion: a hot core, a shell, and a ground ring. */
export function buildBlast(): THREE.Object3D {
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), glowMaterial(0xFFE7A8, 1));
  g.add(core);
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 1), glowMaterial(0xFF7A22, 0.55));
  g.add(shell);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.12, 6, 28), glowMaterial(0xFFC300, 0.8));
  ring.rotation.x = -Math.PI / 2;
  ring.name = 'ring';
  g.add(ring);
  g.traverse((o) => { o.userData.noShadow = true; });
  return g;
}

/** The starburst that marks a connection. Recoloured to whatever hit you. */
export function buildBurst(): THREE.Object3D {
  const g = new THREE.Group();
  const geo = new THREE.ExtrudeGeometry(starShape(1, 0.34, 6), {
    depth: 0.06, bevelEnabled: false,
  });
  geo.center();
  const a = new THREE.Mesh(geo, glowMaterial(0xFFF8F0, 1));
  g.add(a);
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), glowMaterial(0xFFF8F0, 0.9));
  g.add(b);
  g.traverse((o) => { o.userData.noShadow = true; });
  return g;
}

/** The star's aura: a stretched shell that sits over the kart, hue-cycled. */
export function buildStarAura(): THREE.Object3D {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(1.45, 16, 12),
    new THREE.MeshBasicMaterial({
      color: 0xFFD84D, transparent: true, opacity: 0.3, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.BackSide,
    }));
  shell.scale.set(1.12, 0.86, 1.32);
  shell.position.y = 0.7;
  shell.name = 'shell';
  g.add(shell);
  // Sparks orbiting the kart — the part the eye actually reads as "invincible".
  const sparkGeo = new THREE.ExtrudeGeometry(starShape(0.2, 0.08), { depth: 0.03, bevelEnabled: false });
  sparkGeo.center();
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Mesh(sparkGeo, glowMaterial(0xFFF3B0, 0.95));
    s.name = `spark${i}`;
    g.add(s);
  }
  g.traverse((o) => { o.userData.noShadow = true; });
  return g;
}

// ── coins ──────────────────────────────────────────────────────────────────

export function coinGeometry(): THREE.BufferGeometry {
  // A bevelled disc, lathed rather than boxed: the chamfer is what catches the
  // key light and makes a spinning coin flash instead of strobing between two
  // flat sides. Cheap on purpose — there are a couple of hundred of these on
  // the circuit and every triangle is paid for once per frame.
  const geo = new THREE.LatheGeometry([
    new THREE.Vector2(0.001, -0.04),
    new THREE.Vector2(0.30, -0.055),
    new THREE.Vector2(0.42, 0),
    new THREE.Vector2(0.30, 0.055),
    new THREE.Vector2(0.001, 0.04),
  ], 14);
  // Lathed about Y, but a coin stands on edge: tip it so it faces the driver.
  geo.rotateX(Math.PI / 2);
  return geo;
}

export function coinMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xFFC300, emissive: 0xFF9B12, emissiveIntensity: 0.34,
    roughness: 0.26, metalness: 0.45,
  });
}

// ── the item box ───────────────────────────────────────────────────────────

/**
 * The face texture. A bold `?` inside a chevron frame — the frame is what makes
 * a translucent cube read as an object at forty metres, where the glyph alone
 * has mipmapped away to a smudge.
 */
function boxFaceTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;

  // Warm glass, not white glass: at forty metres the fill is most of what the
  // eye gets, and a neutral one disappears against the sky.
  g.fillStyle = 'rgba(255,214,120,0.30)';
  g.fillRect(0, 0, 128, 128);

  // A heavy hazard frame. Thick on purpose — this is the part that survives
  // mipmapping down the straight, and it is what says "item box" from a
  // distance where the glyph is four pixels wide.
  g.strokeStyle = 'rgba(255,107,26,0.98)';
  g.lineWidth = 20;
  g.strokeRect(10, 10, 108, 108);
  g.strokeStyle = 'rgba(255,195,0,0.95)';
  g.lineWidth = 6;
  g.strokeRect(24, 24, 80, 80);

  g.font = 'bold 92px "Trebuchet MS", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 13;
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(46,51,64,0.92)';
  g.strokeText('?', 64, 70);
  g.fillStyle = '#FFF8F0';
  g.fillText('?', 64, 70);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export interface BoxMaterials {
  shell: THREE.MeshStandardMaterial;
  core: THREE.MeshBasicMaterial;
  /** Advance the iridescence. Visual only. */
  tick(t: number): void;
  dispose(): void;
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
    opacity: 0.86,
    roughness: 0.12,
    metalness: 0.0,
    emissive: 0xFFFFFF,
    emissiveIntensity: 0.28,
    emissiveMap: tex,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  shell.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vMcNormal;
        varying vec3 vMcView;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        // The boxes are one InstancedMesh, so the instance rotation has to be
        // folded into both the position and the normal by hand — three only
        // does it for the attributes its own lighting path uses.
        vec4 mcLocal = vec4( transformed, 1.0 );
        vec3 mcNormal = objectNormal;
        #ifdef USE_INSTANCING
          mcLocal = instanceMatrix * mcLocal;
          mcNormal = mat3( instanceMatrix ) * mcNormal;
        #endif
        vec4 mcWorld = modelMatrix * mcLocal;
        vMcNormal = normalize( mat3( modelMatrix ) * mcNormal );
        vMcView = normalize( cameraPosition - mcWorld.xyz );`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        varying vec3 vMcNormal;
        varying vec3 vMcView;
        vec3 mcHue( float h ) {
          return 0.55 + 0.45 * cos( 6.28318 * ( h + vec3( 0.0, 0.33, 0.67 ) ) );
        }`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        // Fresnel drives both the hue sweep and its strength, so the shimmer
        // rides the silhouette of the cube and the faces stay readable.
        float mcF = 1.0 - abs( dot( normalize( vMcNormal ), normalize( vMcView ) ) );
        vec3 mcTint = mcHue( mcF * 0.85 + uTime * 0.12 );
        // Held well below a blow-out: the shimmer has to sit *on* the faces, not
        // erase them. A box that clips to white loses its frame and its glyph,
        // which are the only two things that identify it.
        gl_FragColor.rgb += mcTint * ( pow( mcF, 2.2 ) * 0.42 + 0.05 );
        gl_FragColor.a = clamp( gl_FragColor.a + mcF * 0.3, 0.0, 1.0 );`);
  };

  const core = new THREE.MeshBasicMaterial({
    color: 0xFFF3C4, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });

  return {
    shell,
    core,
    tick(t: number): void { uTime.value = t; },
    dispose(): void {
      tex.dispose();
      shell.dispose();
      core.dispose();
    },
  };
}

export function boxShellGeometry(size = 1.5): THREE.BufferGeometry {
  return roundedBox(size, size, size, size * 0.19, 3);
}

export function boxCoreGeometry(size = 1.5): THREE.BufferGeometry {
  return new THREE.OctahedronGeometry(size * 0.3, 0);
}
