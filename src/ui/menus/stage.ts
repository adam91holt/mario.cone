// The menu's set.
//
// Everything a player sees before the flag falls is staged in 3D here, on a
// canvas and a renderer of its own, over the top of the race. That is a
// deliberate choice and it is worth stating why, because the cheap version of
// this screen is a photograph of the game with a dark rectangle over it.
//
//   *A menu that shows the race behind it shows the HUD behind it too.* The lap
//   counter, the minimap and the item socket do not belong on a title screen,
//   and this module does not own them, so the only honest way to keep them off
//   is to put an opaque set in front. Once the set is opaque anyway, it may as
//   well be a *good* set.
//
//   *A character select needs a machine you can look at.* Not a picture of one:
//   the actual model, lit, turning, with its beacon going round and its face
//   blinking. Every machine in this game has secondary animation built into its
//   rig — rotors, coupling rods, tipping trays, a cone tip that lags a beat
//   behind the turn — and none of that survives being screenshotted.
//
//   *A second context is cheap and a second scene is safe.* Measured under the
//   software rasteriser the reviewers run: 0.4ms for a machine at 900x520, and
//   the race's own renderer is untouched — no shared state, no draw ordering to
//   negotiate, nothing this module can do to a frame the race owns.
//
// The models come from `vehicles/registry.ts` and are driven by a *display
// racer* — a real `Racer` built by the physics module's own factory, never
// simulated, whose speed and steering this file writes by hand. The rigs cannot
// tell the difference, which is how a parked machine on a title screen ends up
// with its wheels turning and its cone tip wobbling.

import * as THREE from 'three';
import { clamp01, damp, ease, lerp } from '../../core/math.ts';
import { createRacer } from '../../physics/kart.ts';
import { disposeTree, mergeStatic, part, roundedBox, mat } from '../../vehicles/parts.ts';
import { getVehicle, listVehicles } from '../../vehicles/registry.ts';
import type { GameContext, Racer, VehicleId, VehicleModel } from '../../types.ts';

/** Where the lens is for each screen, and what it is looking at. */
export type ShotName = 'title' | 'hero' | 'board';

interface Shot {
  pos: readonly [number, number, number];
  look: readonly [number, number, number];
  fov: number;
}

/**
 * Three poses, and every screen is one of them.
 *
 * `hero` and `board` both frame the chosen machine left of centre, because
 * everything the player is reading on those screens — the dossier, the cards —
 * is printed on the right. `board` is the same shot pulled back and opened out,
 * so moving between choosing a machine and choosing a course is a camera move
 * rather than a cut.
 */
const SHOTS: Record<ShotName, Shot> = {
  title: { pos: [0.5, 3.0, 13.5], look: [0, 2.9, -8], fov: 38 },
  hero: { pos: [4.3, 2.9, 12.6], look: [2.3, 0.75, -1.2], fov: 32 },
  board: { pos: [6.9, 3.3, 14.2], look: [4.9, 1.1, -1.6], fov: 34 },
};

/** Machines in the title parade, and the lane each one runs in. */
const PARADE_LANES = [-4.6, -7.4, -10.6, -14.0] as const;
const PARADE_SPAN = 19;

interface Display {
  id: VehicleId;
  racer: Racer;
  model: VehicleModel;
}

interface ParadeEntry {
  d: Display;
  x: number;
  z: number;
  speed: number;
  /** Radians of yaw wiggle, so the line never looks like it is on rails. */
  wob: number;
}

export interface Stage {
  readonly canvas: HTMLCanvasElement;
  /** Cut to a shot instantly (used when a screen is opened, not moved to). */
  cut(shot: ShotName): void;
  /** Move to a shot on the stage's own eased clock. */
  go(shot: ShotName): void;
  /** Which machine stands on the mark. Null clears it. */
  setHero(id: VehicleId | null): void;
  /** Fade the cast parade in or out — the title has one, the choosers do not. */
  setParade(on: boolean): void;
  /** How lit the set is, 0..1. Driven down while a wipe is across the frame. */
  setLevel(v: number): void;
  update(dt: number): void;
  render(): void;
  dispose(): void;
}

// Scratch. Nothing in the per-frame path may allocate.
const _look = new THREE.Vector3();
const _pos = new THREE.Vector3();

// ── procedural textures ────────────────────────────────────────────────────

function gradientSky(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.00, '#2A63AE');
  grad.addColorStop(0.30, '#5F9AD6');
  grad.addColorStop(0.52, '#A7CDE9');
  grad.addColorStop(0.63, '#DCD3BE');
  grad.addColorStop(0.68, '#B79A76');
  grad.addColorStop(0.84, '#7C6650');
  grad.addColorStop(1.00, '#4A3D31');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Tarmac with a painted centre line and a dashed lane. One tile, repeated. */
function roadTexture(): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#32353D';
  g.fillRect(0, 0, S, S);
  // Aggregate. Deterministic — a menu that is speckled differently on every
  // boot is a menu whose screenshots cannot be compared.
  let seed = 0x2f6f;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 2600; i++) {
    const v = 44 + Math.floor(rnd() * 34);
    g.fillStyle = `rgb(${v},${v + 2},${v + 6})`;
    g.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 24);
  tex.anisotropy = 4;
  return tex;
}

/** A soft round falloff, used for the pool of light and for the dust. */
function blobTexture(hard = 0.0): THREE.Texture {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(S / 2, S / 2, S * 0.5 * hard, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,255,255,.34)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}

// ── the set ────────────────────────────────────────────────────────────────

export function createStage(ctx: GameContext): Stage | null {
  const canvas = document.createElement('canvas');
  canvas.className = 'stage';

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, stencil: false });
  } catch {
    // No second context available. The caller falls back to a flat backdrop —
    // a front-end with no 3D is worse, but a front-end that throws is fatal.
    return null;
  }
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.16;
  renderer.shadowMap.enabled = false;
  renderer.info.autoReset = true;

  const scene = new THREE.Scene();
  scene.background = gradientSky();
  scene.fog = new THREE.Fog(0xb7cadb, 58, 250);

  const camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.2, 400);

  // ── light ───────────────────────────────────────────────────────────────
  // Warm key from the left and high, cool sky bounce, and a cold kicker from
  // behind that the material module's Fresnel rim then rides on. Same three
  // lights the race is lit with, so a machine looks like itself in both.
  const key = new THREE.DirectionalLight(0xffe6c2, 3.1);
  key.position.set(-7, 9, 6);
  const kick = new THREE.DirectionalLight(0x8fc4ff, 1.35);
  kick.position.set(6, 3.4, -8);
  const sky = new THREE.HemisphereLight(0x9ad4ff, 0x3b2f24, 1.5);
  scene.add(key, kick, sky);

  // ── ground ──────────────────────────────────────────────────────────────
  const roadTex = roadTexture();
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(150, 48),
    new THREE.MeshStandardMaterial({ map: roadTex, color: 0xb6bac4, roughness: 0.86, metalness: 0.02 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Painted markings: a lane line down the set and hazard kerbs either side of
  // the mark, so the machine on it is standing on a *road* and not on a colour.
  const paint = new THREE.Group();
  part(paint, roundedBox(120, 0.02, 0.28, 0.01), mat(0xfff8f0, { roughness: 0.5 }), [0, 0.012, -7.8]);
  for (let i = -9; i <= 9; i++) {
    part(paint, roundedBox(1.6, 0.02, 0.22, 0.01), mat(0xfff8f0, { roughness: 0.5 }),
      [i * 4.2, 0.012, -1.9]);
  }
  for (const side of [-1, 1]) {
    for (let i = 0; i < 14; i++) {
      part(paint, roundedBox(0.62, 0.024, 0.7, 0.01),
        mat(i % 2 ? 0x14171e : 0xffc300, { roughness: 0.6 }),
        [-4.2 + i * 0.66, 0.014, side * 3.15]);
    }
  }
  mergeStatic(paint);
  scene.add(paint);

  // The works. A run of barriers closing off the far side of the set, four
  // floodlight masts above it and a scatter of cones — the horizon needed
  // something between the road and the land, and this game has an obvious
  // answer to what that something is.
  const dressing = new THREE.Group();
  {
    const ORANGE = mat(0xff6b1a, { roughness: 0.6 });
    const CREAM = mat(0xfff8f0, { roughness: 0.5 });
    const DARK = mat(0x2b3038, { roughness: 0.7 });
    for (let i = -16; i <= 16; i++) {
      const x = i * 3.3;
      part(dressing, roundedBox(3.0, 0.9, 0.34, 0.14), i % 2 ? CREAM : ORANGE, [x, 0.47, -30]);
      part(dressing, roundedBox(3.2, 0.14, 0.44, 0.06), DARK, [x, 0.98, -30]);
    }
    for (const x of [-30, -11, 11, 30]) {
      part(dressing, new THREE.CylinderGeometry(0.15, 0.22, 11, 8), mat(0x8e99a8, { roughness: 0.5 }),
        [x, 5.5, -33]);
      part(dressing, roundedBox(2.8, 0.55, 0.8, 0.22), DARK, [x, 11.1, -32.5]);
      part(dressing, roundedBox(2.6, 0.18, 0.6, 0.07),
        mat(0xfff3c4, { roughness: 0.2, emissive: 0xffe8a8, emissiveIntensity: 0.8 }),
        [x, 10.8, -32.3]);
    }
    // Cones marking the mark itself, small and set back — they frame the
    // machine, they do not compete with it.
    for (const [cx, cz] of [[-9, -3.4], [9, -3.4], [-15, -10], [15, -10]] as const) {
      part(dressing, new THREE.ConeGeometry(0.32, 0.92, 12), ORANGE, [cx, 0.46, cz]);
      part(dressing, new THREE.CylinderGeometry(0.24, 0.28, 0.16, 12), CREAM, [cx, 0.45, cz]);
      part(dressing, roundedBox(0.74, 0.08, 0.74, 0.03), DARK, [cx, 0.04, cz]);
    }
    mergeStatic(dressing);
    scene.add(dressing);
  }

  // The pool of light the hero stands in. A gradient on the floor rather than a
  // spotlight: a real cone of light through no atmosphere is invisible, and
  // this is the part a player actually reads as "on show".
  const poolMat = new THREE.MeshBasicMaterial({
    map: blobTexture(), color: 0xffd9a0, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(11, 11), poolMat);
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.03;
  pool.renderOrder = -2;
  scene.add(pool);

  // ── the horizon ─────────────────────────────────────────────────────────
  // Twelve blocks in a ring, dark and fogged. Not scenery — a *horizon*, so the
  // set has a far edge instead of the ground simply stopping.
  const hills = new THREE.Group();
  {
    let s = 7;
    const rnd = (): number => {
      s = (s * 48271) % 2147483647;
      return s / 2147483647;
    };
    // Two rings at different depths. One ring of blocks reads as a fence; two
    // reads as land, because the near one occludes the far one.
    // Tapered six-sided buttes, not boxes. A cuboid at this distance reads as a
    // wall the moment its top edge is horizontal across the frame; a taper puts
    // a slope on both sides of every one of them and the horizon becomes land.
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2 + rnd() * 0.22;
      const far = i % 2 === 0;
      const r = far ? 230 + rnd() * 60 : 150 + rnd() * 40;
      const h = far ? 30 + rnd() * 34 : 14 + rnd() * 16;
      const w = far ? 46 + rnd() * 54 : 30 + rnd() * 34;
      part(hills, new THREE.CylinderGeometry(w * (0.3 + rnd() * 0.3), w, h, 6, 1),
        mat(far ? 0x7d6449 : 0x8d7152, { roughness: 0.98, flat: true }),
        [Math.sin(a) * r, h / 2 - 5, Math.cos(a) * r],
        [0, rnd() * 2, 0]);
    }
    mergeStatic(hills);
    scene.add(hills);
  }

  // ── dust ────────────────────────────────────────────────────────────────
  // A still frame has to feel alive. Sixty warm motes drifting up through the
  // key light do that for the price of one draw call.
  const MOTES = 60;
  const motePos = new Float32Array(MOTES * 3);
  const moteVel = new Float32Array(MOTES);
  {
    let s = 991;
    const rnd = (): number => {
      s = (s * 48271) % 2147483647;
      return s / 2147483647;
    };
    for (let i = 0; i < MOTES; i++) {
      motePos[i * 3] = (rnd() - 0.5) * 30;
      motePos[i * 3 + 1] = rnd() * 5.5;
      motePos[i * 3 + 2] = -14 + rnd() * 20;
      moteVel[i] = 0.18 + rnd() * 0.4;
    }
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  const moteMat = new THREE.PointsMaterial({
    size: 0.13, map: blobTexture(), color: 0xffdcae, transparent: true, opacity: 0.34,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true, toneMapped: false,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  scene.add(motes);

  // ── the cast ────────────────────────────────────────────────────────────

  const heroGroup = new THREE.Group();
  scene.add(heroGroup);
  const paradeGroup = new THREE.Group();
  scene.add(paradeGroup);

  const built = new Map<VehicleId, Display>();

  /** Build a machine and the display racer that drives its rig. Cached: the
   *  same instance is re-parented between the parade and the mark. */
  function displayOf(id: VehicleId): Display {
    const found = built.get(id);
    if (found) return found;
    const def = getVehicle(id);
    const model = def.build(ctx);
    const racer = createRacer(-1, def.name, id, { ...def.stats }, false);
    racer.maxSpeed = 34;
    racer.grounded = true;
    const d: Display = { id, racer, model };
    built.set(id, d);
    return d;
  }

  const parade: ParadeEntry[] = [];
  /** Ids still waiting to join the parade. One is built per rendered frame, so
   *  a title screen assembles over half a second instead of stalling on seven
   *  shader compiles at once. */
  let paradeQueue: VehicleId[] = [];
  let paradeWant = false;
  let paradeLevel = 0;

  let heroId: VehicleId | null = null;
  /** 0..1 clock for the one full revolution a machine makes as it arrives. */
  let arriveT = 1;
  let heroSpin = 0;
  let heroLevel = 0;

  function clearParade(): void {
    for (const e of parade) paradeGroup.remove(e.d.model.root);
    parade.length = 0;
    paradeQueue = [];
  }

  function enqueueParade(): void {
    const all = listVehicles();
    paradeQueue = all.map((v) => v.id).filter((id) => id !== heroId);
  }

  function joinParade(id: VehicleId): void {
    const d = displayOf(id);
    if (d.model.root.parent) d.model.root.parent.remove(d.model.root);
    const n = parade.length;
    const lane = PARADE_LANES[n % PARADE_LANES.length]!;
    const speed = 7.5 + (n % 3) * 1.9;
    parade.push({
      d,
      x: -PARADE_SPAN + (n / 6) * PARADE_SPAN * 2,
      z: lane - (n >= PARADE_LANES.length ? 1.4 : 0),
      speed,
      wob: n * 1.7,
    });
    paradeGroup.add(d.model.root);
  }

  // ── shot ────────────────────────────────────────────────────────────────

  let from: Shot = SHOTS.title;
  let to: Shot = SHOTS.title;
  let shotT = 1;
  let level = 1;
  let levelTarget = 1;
  let clock = 0;

  function applyShot(): void {
    // Eased, and biased toward the front of the move, so a screen change reads
    // as a camera operator committing rather than as a slider being dragged.
    const u = ease.inOutCubic(clamp01(shotT));
    _pos.set(
      lerp(from.pos[0], to.pos[0], u),
      lerp(from.pos[1], to.pos[1], u),
      lerp(from.pos[2], to.pos[2], u));
    _look.set(
      lerp(from.look[0], to.look[0], u),
      lerp(from.look[1], to.look[1], u),
      lerp(from.look[2], to.look[2], u));
    // A breath of handheld float. Deterministic, tiny, and the difference
    // between a set and a rendering of a set.
    _pos.x += Math.sin(clock * 0.53) * 0.075;
    _pos.y += Math.sin(clock * 0.41 + 1.9) * 0.055;
    camera.position.copy(_pos);
    camera.lookAt(_look);
    const fov = lerp(from.fov, to.fov, u);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  function resize(): void {
    const w = Math.max(2, canvas.clientWidth || 1280);
    const h = Math.max(2, canvas.clientHeight || 720);
    // Capped, because this set is drawn *on top of* a game that is already
    // paying for a full frame, and the reviewers' rasteriser is software.
    const scale = Math.min(1, 1200 / w);
    const bw = Math.round(w * scale);
    const bh = Math.round(h * scale);
    if (canvas.width === bw && canvas.height === bh) return;
    renderer.setSize(bw, bh, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  const api: Stage = {
    canvas,

    cut(shot): void {
      from = SHOTS[shot];
      to = SHOTS[shot];
      shotT = 1;
      applyShot();
    },

    go(shot): void {
      if (to === SHOTS[shot]) return;
      // Start the new move from wherever the last one had actually reached.
      const u = ease.inOutCubic(clamp01(shotT));
      from = {
        pos: [lerp(from.pos[0], to.pos[0], u), lerp(from.pos[1], to.pos[1], u),
          lerp(from.pos[2], to.pos[2], u)],
        look: [lerp(from.look[0], to.look[0], u), lerp(from.look[1], to.look[1], u),
          lerp(from.look[2], to.look[2], u)],
        fov: lerp(from.fov, to.fov, u),
      };
      to = SHOTS[shot];
      shotT = 0;
    },

    setHero(id): void {
      if (heroId === id) return;
      heroId = id;
      // Out of the parade first. The same model instance serves both, and the
      // parade drives its transform every frame — a machine left in that list
      // is a machine that quietly drives off the character select.
      if (id) {
        const i = parade.findIndex((e) => e.d.id === id);
        if (i >= 0) { paradeGroup.remove(parade[i]!.d.model.root); parade.splice(i, 1); }
      }
      for (let i = heroGroup.children.length - 1; i >= 0; i--) {
        heroGroup.remove(heroGroup.children[i]!);
      }
      if (id) {
        const d = displayOf(id);
        if (d.model.root.parent) d.model.root.parent.remove(d.model.root);
        // **Put it back on the mark.** The same model instance is re-parented
        // between the parade and the pedestal, and the parade drives its
        // position every frame — without this the machine arrives on the
        // character select wherever it happened to be driving past, which is
        // usually somewhere off the side of the frame.
        d.model.root.position.set(0, 0, 0);
        d.model.root.rotation.set(0, heroSpin, 0);
        void 0;
        heroGroup.add(d.model.root);
        // Framing follows the machine's own size, exactly as the chase camera
        // does: a 4.8m locomotive and a 1.9m cone cannot share a distance. Small
        // machines come *forward*, or the cone this game is named after is a
        // thumbnail on its own character select.
        const size = getVehicle(id).size;
        const span = Math.max(size.length, size.width);
        const push = (span - 2.6) * 0.85;
        heroGroup.position.set(0, 0, -Math.max(-0.4, Math.min(2.8, push)));
        // A full turn on arrival, decaying onto the presenting angle: the
        // machine *shows itself off* and then holds still enough to be read.
        arriveT = 0;
      }
      if (paradeWant) { clearParade(); enqueueParade(); }
    },

    setParade(on): void {
      if (paradeWant === on) return;
      paradeWant = on;
      clearParade();
      if (on) enqueueParade();
    },

    setLevel(v): void { levelTarget = clamp01(v); },

    update(dt): void {
      clock += dt;
      if (shotT < 1) shotT = Math.min(1, shotT + dt / 0.52);
      level = damp(level, levelTarget, 0.0006, dt);
      applyShot();

      // One machine joins the parade per frame while there is a queue.
      if (paradeWant && paradeQueue.length > 0) joinParade(paradeQueue.shift()!);

      paradeLevel = damp(paradeLevel, paradeWant ? 1 : 0, 0.0009, dt);
      heroLevel = damp(heroLevel, heroId ? 1 : 0, 0.0006, dt);

      // ── the parade ───────────────────────────────────────────────────────
      for (const e of parade) {
        e.x += e.speed * dt;
        if (e.x > PARADE_SPAN) e.x -= PARADE_SPAN * 2;
        const wob = Math.sin(clock * 0.7 + e.wob) * 0.09;
        const root = e.d.model.root;
        root.position.set(e.x, 0, e.z + Math.sin(clock * 0.35 + e.wob) * 0.22);
        root.rotation.y = Math.PI / 2 + wob;
        root.visible = paradeLevel > 0.02;
        const r = e.d.racer;
        r.speed = e.speed;
        r.steerAngle = wob * 1.6;
        r.drift.angle = 0;
        e.d.model.update?.(r, dt, 1);
      }

      // ── the machine on the mark ──────────────────────────────────────────
      if (heroId) {
        const d = displayOf(heroId);
        // **A sweep, not a turntable.** Every machine in this cast has a face,
        // and the face is the character — a continuous spin means that half the
        // time the thing a player is choosing has its back to them, and every
        // screenshot ever taken of this screen lands on an arbitrary angle. So
        // the machine rocks through the front three-quarters instead, and only
        // *arrives* on a full revolution.
        if (arriveT < 1) arriveT = Math.min(1, arriveT + dt / 0.85);
        const extra = (1 - ease.outCubic(arriveT)) * Math.PI * 2;
        heroSpin = 0.55 + Math.sin(clock * 0.46) * 0.62 + extra;
        d.model.root.position.set(0, 0, 0);
        d.model.root.rotation.set(0, heroSpin, 0);
        d.model.root.visible = heroLevel > 0.02;
        // Idling, not parked: enough rolling speed that wheels turn, rotors
        // spin and the plane's prop blurs, with a slow weave so the rigs' lean
        // and the cone's tip have something to answer.
        const r = d.racer;
        r.speed = 7 + (1 - arriveT) * 12;
        r.steerAngle = Math.sin(clock * 0.8) * 0.16;
        d.model.update?.(r, dt, 1);
      }

      // ── the set ──────────────────────────────────────────────────────────
      poolMat.opacity = heroLevel * level * 0.5;
      pool.visible = poolMat.opacity > 0.01;
      pool.position.set(heroGroup.position.x, 0.03, heroGroup.position.z);

      for (let i = 0; i < MOTES; i++) {
        let y = motePos[i * 3 + 1]! + moteVel[i]! * dt;
        if (y > 5.5) y -= 5.5;
        motePos[i * 3 + 1] = y;
        motePos[i * 3] = motePos[i * 3]! + Math.sin(clock * 0.4 + i) * dt * 0.12;
      }
      moteGeo.attributes.position!.needsUpdate = true;
      moteMat.opacity = 0.34 * level;

      // The whole set dims under a wipe, so the transition happens *in front of*
      // a stage that is going dark rather than over a stage that is not.
      key.intensity = 3.1 * level;
      kick.intensity = 1.35 * level;
      sky.intensity = 1.5 * level;
      renderer.toneMappingExposure = 1.16 * (0.35 + 0.65 * level);
    },

    render(): void {
      resize();
      renderer.render(scene, camera);
    },

    dispose(): void {
      clearParade();
      for (const d of built.values()) {
        if (d.model.root.parent) d.model.root.parent.remove(d.model.root);
        d.model.dispose?.();
      }
      built.clear();
      disposeTree(scene);
      (scene.background as THREE.Texture | null)?.dispose?.();
      roadTex.dispose();
      moteGeo.dispose();
      moteMat.dispose();
      poolMat.dispose();
      renderer.dispose();
    },
  };

  api.cut('title');
  return api;
}
