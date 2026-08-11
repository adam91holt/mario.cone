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
//
// ── Contact ────────────────────────────────────────────────────────────────
//
// The art direction has one rule it states more emphatically than any other:
// *every object needs a grounded shadow*. This set used to break it on all four
// screens — the machine on the mark stood in an **additive** pool of warm light
// and nothing else, so the ground directly under a hero measured 129% brighter
// than the asphalt beside it while the same machine on the race grid, a quarter
// of a second later, sat in a shadow 30% darker than the road. A front-end that
// contradicts its own game's most emphatic rule is worse than one with no set
// at all.
//
// So contact here is now built the same way the race builds it, in two layers:
//
//   *A real cast shadow.* The key is a shadow-casting directional light with an
//   orthographic frustum that follows the subject — tight around the machine on
//   the mark, wide enough for the whole line-up on the title. That is the layer
//   that puts a shadow under the digger's *bucket teeth and front blade*, which
//   hang two metres in front of anything a blob could cover.
//
//   *A contact patch.* A soft dark ellipse under every machine, drawn with a
//   pure-darkening blend (`dst * (1 - a)`) rather than a black quad, so it
//   deepens the ground under the chassis without flattening its colour. It is
//   the ambient-occlusion layer the cast shadow cannot supply, and it is also
//   the floor under the whole feature: with shadow maps off it still reads.
//
// The warm pool survives, but as a *halo* — a ring of light with a hole in the
// middle where the machine stands. It is what says "on show" without ever
// putting light where a shadow belongs.
//
// ── Why the first attempt at that still measured as a light pool ────────────
//
// Both layers were built, and neither of them was visible. Two reasons, and
// they are worth writing down because they are the reasons a contact shadow
// fails anywhere:
//
//   *A shadow needs a lit ground.* This set was pitched at dusk — asphalt at a
//   luminance of about 36, against 61 for the same road on the race grid. A
//   multiply-darkening patch on a ground that is already nearly black has
//   nothing left to take away, so it measured as no change at all. The set is
//   now lit at the same hour Cone Canyon is, which is also what closes the
//   hand-off the critique named: a dim navy road cutting to a sunlit canyon.
//
//   *A shadow behind the subject is a shadow nobody sees.* The key was at
//   (-7, 9, 6) — camera side — so every shadow it cast fell *away* from the
//   lens and hid behind the machine that cast it. The key is now nearly
//   side-on, at (-9.4, 7.4, 1.6): high enough for a short shadow, lateral
//   enough that the shadow lands beside the machine where the camera can see
//   it, and still from the left so the warm key stays on the same cheek of
//   every machine as it is in the race.
//
// `marks()` at the bottom of this file is the measurement, so neither of those
// can quietly come back: it hands out the ground samples — raycast, so they are
// only ever points where the ground is genuinely visible — and the ring hugging
// a machine has to read darker than the road four metres away.

import * as THREE from 'three';
import { clamp01, damp, ease, lerp } from '../../core/math.ts';
import { createRacer } from '../../physics/kart.ts';
import { disposeTree, mergeStatic, part, roundedBox, mat } from '../../vehicles/parts.ts';
import { getVehicle, listVehicles } from '../../vehicles/registry.ts';
import { EXPOSURE_TRIM, installFilmStock } from '../../render/grade.ts';
import type { GameContext, Racer, VehicleDef, VehicleId, VehicleModel } from '../../types.ts';

/** Where the lens is for each screen, and what it is looking at. */
export type ShotName = 'title' | 'hero' | 'board';

interface Shot {
  pos: readonly [number, number, number];
  look: readonly [number, number, number];
  fov: number;
  /** Where the shadow frustum sits for this shot, and how wide it opens. */
  focus: readonly [number, number];
  radius: number;
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
  // Lifted, and looking a little further down than it used to. The lanes of the
  // parade used to project onto within a few pixels of the same screen row, so
  // a machine four metres behind another was simply drawn on top of it; from
  // here each lane sits on its own line of the road.
  title: { pos: [0.4, 4.9, 13.6], look: [0, 1.35, -8.0], fov: 40, focus: [0, -8], radius: 20 },
  hero: { pos: [4.3, 2.9, 12.6], look: [2.3, 0.75, -1.2], fov: 32, focus: [1.5, -3], radius: 12 },
  // The circuit and class screens print their cards across the top of the
  // frame, so this shot puts the machine *under* them rather than behind them.
  // It used to look level at a machine standing dead centre of the composition
  // with four cards laid over it — a half-occluded prop poking out from behind
  // the leftmost card, which is exactly how it photographed. Looking seven
  // degrees over its head drops it into the lower-left quarter, where it is a
  // whole machine standing on a road with nothing on top of it.
  board: { pos: [3.8, 3.9, 13.6], look: [3.8, 2.35, -0.6], fov: 34, focus: [0.5, -2], radius: 13 },
};

/**
 * The title line-up.
 *
 * Two rules, and both of them exist because the first cut of this parade had
 * neither: the digger drove through the red car at t≈3s and the road cone — the
 * machine the game is *named after* — left frame entirely and stayed gone.
 *
 *   *Nothing may occupy the same space as anything else.* Machines run in
 *   lanes; within a lane they share one speed and sit exactly half a loop
 *   apart, so the gap between them is a constant and no machine can ever
 *   overtake another. Lanes are spaced from the actual `size.width` of the
 *   widest machine in each, widest at the back, so a 4.5m wingspan cannot
 *   clip the helicopter in the lane in front of it.
 *
 *   *The mascot never leaves.* The cone does not join the parade at all. It
 *   stands on its own mark, front and centre under the wordmark, weaving on
 *   the spot — the star of the game, present in every frame of its own title
 *   screen, with the rest of the cast driving past behind it.
 */
const MASCOT: VehicleId = 'cone';
/** Left of the wordmark and nearer the lens than any lane, so it is the biggest
 *  machine on the screen and can never be the one hidden behind another. */
const MASCOT_AT = { x: -5.0, z: -3.2 } as const;
/**
 * Half a loop each way, and the number that decides how much of the cast is on
 * screen at once.
 *
 * The first parade ran six machines two-to-a-lane on a 48m loop, which put them
 * 24m apart — and the camera sees about 15m either side of the mark. Exactly
 * one of every pair could be on screen at any moment, so a title card advertising
 * seven machines showed three. Three to a lane on a 41m loop puts them 13.6m
 * apart: two or three of every lane are in frame at all times, and the wrap
 * still happens five metres outside it.
 */
const PARADE_SPAN = 20.4;
const PARADE_LANES = 2;
/** Metres of clear air between the widest machine in one lane and the next. */
const LANE_MARGIN = 1.25;
const NEAR_LANE_Z = -7.6;
/** Nearest lane first. Near runs fastest, so the line-up reads with parallax. */
const LANE_SPEED = [7.4, 5.8] as const;

interface Display {
  id: VehicleId;
  racer: Racer;
  model: VehicleModel;
  /** The soft dark ellipse this machine stands on. */
  patch: THREE.Mesh;
  patchMat: THREE.MeshBasicMaterial;
}

interface ParadeEntry {
  d: Display;
  x: number;
  z: number;
  speed: number;
  /** Radians of yaw wiggle, so the line never looks like it is on rails. */
  wob: number;
}

/**
 * A ground sample point for the contact check, in CSS pixels of the canvas.
 *
 * The contact critique was made by reading the luminance of the ground *under*
 * a machine against the asphalt beside it, out of a screenshot. That is the
 * right measurement and it should not need a human with an eyedropper, so the
 * set hands out the points to read: visible ground inside the machine's own
 * footprint, and visible ground four metres clear of it. `under` must come back
 * darker than `beside`, on every screen.
 *
 * Two rules make the instrument mean something, and both were learned the hard
 * way by watching it report a pass on a machine with no shadow and a fail on
 * one with a good shadow:
 *
 *   *"Under" is the declared footprint, not the bounding box.* A helicopter's
 *   rotor disc is five metres across and two metres in the air. Ground hugging
 *   its *bounding box* is ground two and a half metres from anything the
 *   machine is standing on, in full sun, and no shadow that belonged there
 *   would ever be seen. `size` — the same number the camera framing and the
 *   collision radius come from — is where the machine actually touches.
 *
 *   *A shadow is measured against the surface it falls on.* The set has white
 *   lane lines and a black-and-yellow kerb through it, and a sample that lands
 *   on one of those reads 200 or 20 for reasons that have nothing to do with
 *   contact. Painted markings are excluded from the ground set, so such a
 *   sample is discarded rather than counted.
 */
export interface StageMark {
  id: VehicleId;
  /** Visible ground inside the machine's own footprint. */
  near: Array<[number, number]>;
  /** Visible ground four metres clear of it. */
  far: Array<[number, number]>;
}

export interface Stage {
  readonly canvas: HTMLCanvasElement;
  /** Screen-space ground samples for every machine currently on the set. */
  marks(): StageMark[];
  /** Cut to a shot instantly (used when a screen is opened, not moved to). */
  cut(shot: ShotName): void;
  /** Move to a shot on the stage's own eased clock. */
  go(shot: ShotName): void;
  /** Which machine stands on the mark. Null clears it. */
  setHero(id: VehicleId | null): void;
  /**
   * Cycle the whole cast on the mark instead of standing one machine on it.
   *
   * What the roster's random slot puts on the stage. It used to leave whichever
   * machine had last been hovered standing there, which is the one thing a slot
   * called SURPRISE ME must not do: the screen showed a helicopter, the
   * breadcrumb said CHOPPER, and the pick was going to be something else.
   */
  setShuffle(on: boolean): void;
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
/**
 * The key's direction, normalised once. Moving the light and its target by the
 * same delta keeps this constant while the shadow volume follows the subject.
 *
 * Nearly side-on, and only a little toward the lens. A key at 45° to the camera
 * axis throws its shadow behind the thing it lights, where the thing it lights
 * is standing on it; from here a two-metre machine puts a shadow 2.5m to its
 * right and only half a metre back, which is a shadow on screen.
 */
const LIGHT_DIR = new THREE.Vector3(-9.4, 7.4, 1.6).normalize();

// ── procedural textures ────────────────────────────────────────────────────

function gradientSky(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d')!;
  // The same hour as Cone Canyon: a bright blue overhead, a pale warm band at
  // the horizon, and sunlit land under it. It used to run to dusk, which is
  // what made the hand-off from this set to the race a cut between two
  // different times of day.
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.00, '#3D86D8');
  grad.addColorStop(0.30, '#79B4E6');
  grad.addColorStop(0.52, '#BEDCF2');
  grad.addColorStop(0.62, '#EFE6CE');
  grad.addColorStop(0.68, '#D3B78E');
  grad.addColorStop(0.84, '#A98A66');
  grad.addColorStop(1.00, '#7C6650');
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
  // Read against the race's own road, not against a mood board. Cone Canyon's
  // asphalt photographs at a luminance of about 61 with a machine's shadow at
  // 43; a menu road that reads 36 has no room left underneath it for a shadow
  // to be, which is precisely how a contact pass can be built twice and
  // measure as absent both times.
  g.fillStyle = '#4B505B';
  g.fillRect(0, 0, S, S);
  // Aggregate. Deterministic — a menu that is speckled differently on every
  // boot is a menu whose screenshots cannot be compared.
  let seed = 0x2f6f;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 2600; i++) {
    const v = 62 + Math.floor(rnd() * 40);
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

/** A soft round falloff, used for the dust motes. */
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

/**
 * The pool of light the hero stands in — with a hole in it.
 *
 * The old pool was a filled additive blob, which is why the brightest patch of
 * ground on the character select was the patch directly under the machine. A
 * halo says exactly the same thing about "this one is on show" while leaving
 * the contact area to the shadow that belongs there.
 */
function haloTexture(): THREE.Texture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  // The hole is wide on purpose. The biggest machine in the cast is 4.8m long,
  // so a ring that starts lifting at 30% of a 13.5m plane was putting warm
  // light on the tarmac under the locomotive's own buffers.
  //
  // It is wider again now, and for a second reason: `marks()` reads the asphalt
  // four metres out from a machine as its control, and a halo whose brightest
  // band was at four and a half metres was standing exactly where the control
  // is taken. A measurement that passes because the *reference* is lit is not a
  // measurement. The band sits at five metres now, outside the reading.
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0.00, 'rgba(255,255,255,0)');
  grad.addColorStop(0.56, 'rgba(255,255,255,0)');
  grad.addColorStop(0.74, 'rgba(255,255,255,.9)');
  grad.addColorStop(0.88, 'rgba(255,255,255,.3)');
  grad.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}

/**
 * The contact patch: white with an alpha falloff, drawn through a blend that
 * throws the source colour away and keeps only `dst * (1 - a)`.
 *
 * A black quad at 60% opacity would wash the asphalt toward grey; this darkens
 * it and leaves its hue alone, which is what a shadow on a coloured ground
 * actually does. The corners of the plane fall outside the gradient's last stop
 * and are fully transparent, so the patch is an ellipse and not a square.
 */
function patchTexture(): THREE.Texture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(S / 2, S / 2, S * 0.04, S / 2, S / 2, S / 2);
  grad.addColorStop(0.00, 'rgba(255,255,255,.92)');
  grad.addColorStop(0.40, 'rgba(255,255,255,.78)');
  grad.addColorStop(0.70, 'rgba(255,255,255,.34)');
  grad.addColorStop(1.00, 'rgba(255,255,255,0)');
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
  // **The game's own film stock, not a second one.**
  //
  // This used to be stock ACES at 1.16 exposure with no composite behind it,
  // while the race renders through `installFilmStock` — the studio's own grade
  // GLSL — plus a bloom pyramid, atmosphere, vignette and dither. Measured on
  // the same cone at the 90th percentile of lit orange, the machine on the
  // select screen came out at (222,119,63) against (247,139,80) on the grid: a
  // player picks a duller, unbloomed machine and is handed a brighter one one
  // second later. Same grade, same exposure, and the trim is the render
  // module's own, so the two cannot drift apart again.
  //
  // There is no composite here and there will not be: a second HDR buffer and a
  // bloom pyramid over the top of a race that is already paying for a full
  // frame is not worth it for a backdrop. The `.grade` layer in `chrome.ts`
  // supplies the vignette the post stack would have; what mattered was the
  // *colour*, and that is now identical.
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // The one number, computed once. The dimmer in `update` writes
  // `toneMappingExposure` every frame to fade the set under a wipe, and it used
  // to rebuild its base from a literal `1.16` — the old stock-ACES value this
  // block was supposed to have retired. So the constructor set the shared
  // exposure and the very next frame overwrote it with the number the fix was
  // removing, and `config.render.exposure` moved the race without moving the
  // front-end. Whatever the base is, both ends of this file now read it here.
  const EXPOSURE = ctx.config.render.exposure * EXPOSURE_TRIM;
  installFilmStock(renderer, EXPOSURE);
  renderer.info.autoReset = true;

  // Shadows follow the game's own quality switch, and take the same filter the
  // engine uses — the front-end was the one surface in the product with hard
  // shadow edges on it.
  //
  // That filter is `PCFShadowMap`, not `PCFSoftShadowMap`. `PCFSoftShadowMap`
  // is deprecated in the vendored three: `WebGLShadowMap.render` rewrites it to
  // `PCFShadowMap` on the first shadow pass and warns on the console while it
  // does — which is the boot-time warning ARCHITECTURE §13 forbids, and it was
  // coming from *this* renderer, `render/lighting.ts` and `core/engine.ts`
  // having both already been corrected. Asking for what the build actually
  // gives keeps "the same filter the engine uses" true instead of aspirational;
  // the penumbra is shaped with `shadow.radius` on the key light below, the way
  // the race's sun rig does it.
  const SHADOWS = ctx.quality.shadows !== false;
  renderer.shadowMap.enabled = SHADOWS;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = gradientSky();
  scene.fog = new THREE.Fog(0xcfe0ee, 80, 320);

  const camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.2, 400);

  // ── light ───────────────────────────────────────────────────────────────
  // Warm key from the left and high, cool sky bounce, and a cold kicker from
  // behind that the material module's Fresnel rim then rides on. Same three
  // lights the race is lit with, so a machine looks like itself in both — and,
  // now, the same one of the three casting.
  const KEY_I = 3.5;
  const KICK_I = 0.95;
  const SKY_I = 1.05;
  const key = new THREE.DirectionalLight(0xffeccb, KEY_I);
  key.position.copy(LIGHT_DIR).multiplyScalar(34);
  key.castShadow = SHADOWS;
  // 1024, not 2048. The shadow frustum here is a twelve-metre box around one
  // machine, so a thousand texels across it is four to the centimetre — finer
  // than the contact patch underneath is, and a quarter of the fill. That
  // matters more than it looks: this set is drawn *on top of* a race that is
  // already paying for a full frame, and the reviewers rasterise in software,
  // where a 4-megapixel depth pass costs more than the 0.8-megapixel colour one
  // it is there to darken.
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.026;
  key.shadow.radius = 2.1;
  const kick = new THREE.DirectionalLight(0x8fc4ff, KICK_I);
  kick.position.set(6, 3.4, -8);
  // The fill is dropped a third from where it was. A hemisphere strong enough
  // to light the underside of every machine is a hemisphere strong enough to
  // fill in the shadow the key just cast, and the two together are why the
  // first contact pass measured flat.
  const sky = new THREE.HemisphereLight(0xa8dcff, 0x4e4132, SKY_I);
  scene.add(key, key.target, kick, sky);

  let shadowR = -1;
  /** Point the shadow volume at whatever the current shot is about. */
  function focusShadow(fx: number, fz: number, r: number): void {
    key.target.position.set(fx, 0.5, fz);
    key.position.set(
      fx + LIGHT_DIR.x * 34, 0.5 + LIGHT_DIR.y * 34, fz + LIGHT_DIR.z * 34);
    key.target.updateMatrixWorld();
    if (Math.abs(shadowR - r) > 0.05) {
      shadowR = r;
      const cam = key.shadow.camera;
      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      cam.near = 6;
      cam.far = 62 + r * 2.4;
      cam.updateProjectionMatrix();
    }
  }

  // ── ground ──────────────────────────────────────────────────────────────
  const roadTex = roadTexture();
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(150, 48),
    new THREE.MeshStandardMaterial({ map: roadTex, color: 0xeef0f4, roughness: 0.88, metalness: 0.02 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
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
  // Paint is *ground*. It receives and never casts — a lane line two
  // centimetres proud of the road casting its own shadow is a stripe with a
  // drop shadow, which is exactly what a road marking is not.
  for (const m of paint.children) { m.castShadow = false; m.receiveShadow = true; }
  scene.add(paint);

  // The works. A run of barriers closing off the far side of the set, four
  // floodlight masts above it and a scatter of cones — the horizon needed
  // something between the road and the land, and this game has an obvious
  // answer to what that something is.
  const dressing = new THREE.Group();
  const marks = new THREE.Group();
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
    // machine, they do not compete with it. These live in their own group
    // because they are the only dressing close enough to the mark to need a
    // shadow: a cone standing on the same tarmac as the hero, with nothing
    // under it, is the tell that the hero's shadow was faked.
    for (const [cx, cz] of [[-9, -3.4], [9, -3.4], [-15, -10], [15, -10]] as const) {
      part(marks, new THREE.ConeGeometry(0.32, 0.92, 12), ORANGE, [cx, 0.46, cz]);
      part(marks, new THREE.CylinderGeometry(0.24, 0.28, 0.16, 12), CREAM, [cx, 0.45, cz]);
      part(marks, roundedBox(0.74, 0.08, 0.74, 0.03), DARK, [cx, 0.04, cz]);
    }
    // A second run of hazard boards along the barrier line, a metre in front of
    // the first and half a metre lower — the works read as *deep* rather than
    // as one fence line, and the near row catches the key where the far one is
    // in its own shadow.
    //
    // There was a gantry here, and it came out. It was the right object — the
    // race has them — but on two of this set's three shots the cards are laid
    // across the top of the frame, so the whole truss sat behind them and the
    // only part of it a player ever saw was an orange banner cropped by the top
    // edge. A structure that is only ever visible as an unexplained slab is
    // worse than no structure.
    for (let i = -14; i <= 14; i++) {
      const x = i * 3.3 + 1.65;
      part(dressing, roundedBox(2.6, 0.72, 0.3, 0.12), i % 2 ? ORANGE : CREAM,
        [x, 0.38, -26.5]);
      part(dressing, roundedBox(2.8, 0.12, 0.4, 0.05), DARK, [x, 0.79, -26.5]);
    }

    // Bunting between the floodlight masts. Two runs, sagging, so the top of
    // the frame has something in it that is not sky.
    {
      const FLAGS = [0xffc300, 0xff6b1a, 0xfff8f0, 0x5fc8f5];
      const span = [-30, -11, 11, 30];
      for (let s = 0; s < span.length - 1; s++) {
        const a = span[s]!;
        const b = span[s + 1]!;
        const n = Math.max(6, Math.round((b - a) / 1.5));
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const x = a + (b - a) * t;
          // A catenary, near enough: the sag is what stops a string of flags
          // reading as a ruler with triangles on it.
          const y = 10.4 - Math.sin(t * Math.PI) * 1.5;
          part(dressing, new THREE.ConeGeometry(0.24, 0.66, 3),
            mat(FLAGS[(s * 3 + i) % FLAGS.length]!, { roughness: 0.6, flat: true }),
            [x, y - 0.33, -32.6], [Math.PI, (i % 2 ? 0.3 : -0.3), 0]);
        }
        part(dressing, roundedBox(b - a, 0.07, 0.07, 0.03), mat(0x20242c, { roughness: 0.8 }),
          [(a + b) / 2, 10.05, -32.6]);
      }
    }

    mergeStatic(dressing);
    mergeStatic(marks);
    // The far dressing is thirty metres behind the mark and never inside the
    // shadow frustum; leaving it out of the depth pass is free.
    for (const m of dressing.children) { m.castShadow = false; m.receiveShadow = false; }
    for (const m of marks.children) { m.castShadow = true; m.receiveShadow = true; }
    scene.add(dressing, marks);
  }

  // ── the crowd ───────────────────────────────────────────────────────────
  //
  // A raked stand behind the barriers with a hundred and twenty people on it,
  // bobbing. One instanced draw call for the whole bank, and it is the single
  // cheapest thing on this set that makes it read as the same product as the
  // race — which has crowds along every straight.
  const CROWD = 120;
  const crowdGeo = new THREE.CapsuleGeometry(0.24, 0.5, 3, 6);
  const crowdMat = new THREE.MeshLambertMaterial({ vertexColors: false });
  const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, CROWD);
  crowd.frustumCulled = false;
  crowd.castShadow = false;
  crowd.receiveShadow = false;
  /** Base transform per person, and the phase of their bob. */
  const crowdAt = new Float32Array(CROWD * 4);
  {
    const stand = new THREE.Group();
    const TIERS = 5;
    for (let t = 0; t < TIERS; t++) {
      const y = 0.55 + t * 0.78;
      const z = -37.5 - t * 1.5;
      part(stand, roundedBox(70, 0.7, 1.5, 0.08), mat(0x6b7280, { roughness: 0.9 }), [0, y, z]);
      part(stand, roundedBox(70, 0.9, 0.24, 0.06), mat(0x2b3038, { roughness: 0.8 }),
        [0, y + 0.65, z - 0.7]);
    }
    // A roof on posts over the back of it, so the bank has a silhouette.
    for (let i = -5; i <= 5; i++) {
      part(stand, new THREE.CylinderGeometry(0.16, 0.16, 6.6, 6), mat(0x8e99a8, { roughness: 0.5 }),
        [i * 6.6, 3.3, -45.6]);
    }
    part(stand, roundedBox(72, 0.5, 12, 0.2), mat(0x3b4250, { roughness: 0.85 }),
      [0, 6.8, -40.4], [-0.09, 0, 0]);
    part(stand, roundedBox(72, 0.7, 0.5, 0.16), mat(0xffc300, { roughness: 0.55 }),
      [0, 6.5, -34.6]);
    mergeStatic(stand);
    for (const m of stand.children) { m.castShadow = false; m.receiveShadow = false; }
    scene.add(stand);

    let s = 20261;
    const rnd = (): number => { s = (s * 48271) % 2147483647; return s / 2147483647; };
    const SHIRTS = [0xff6b1a, 0xffc300, 0xfff8f0, 0x5fc8f5, 0x6fe04a, 0xff4b3a];
    const colour = new THREE.Color();
    for (let i = 0; i < CROWD; i++) {
      const tier = Math.floor(rnd() * 5);
      crowdAt[i * 4] = (rnd() - 0.5) * 66;
      crowdAt[i * 4 + 1] = 1.2 + tier * 0.78;
      crowdAt[i * 4 + 2] = -37.2 - tier * 1.5;
      crowdAt[i * 4 + 3] = rnd() * Math.PI * 2;
      crowd.setColorAt(i, colour.setHex(SHIRTS[Math.floor(rnd() * SHIRTS.length)]!));
    }
    if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
    scene.add(crowd);
  }
  /** Scratch for the crowd's per-frame transforms. Nothing here allocates. */
  const _cm = new THREE.Matrix4();
  const _cp = new THREE.Vector3();
  const _cq = new THREE.Quaternion();
  const _cs = new THREE.Vector3(1, 1, 1);
  const _up = new THREE.Vector3(0, 1, 0);

  // The halo the hero stands in. A gradient on the floor rather than a
  // spotlight: a real cone of light through no atmosphere is invisible, and
  // this is the part a player actually reads as "on show". It is a *ring* —
  // see haloTexture — so it never lands where the shadow does.
  const poolMat = new THREE.MeshBasicMaterial({
    map: haloTexture(), color: 0xffd0a0, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(13.5, 13.5), poolMat);
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.03;
  pool.renderOrder = -3;
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
    for (const m of hills.children) { m.castShadow = false; m.receiveShadow = false; }
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
  const mascotGroup = new THREE.Group();
  mascotGroup.position.set(MASCOT_AT.x, 0, MASCOT_AT.z);
  scene.add(mascotGroup);

  const patchTex = patchTexture();
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

    // The rigs ship a contact blob of their own that the race's contact pass
    // switches off and replaces. Nothing was replacing it here, and nothing was
    // switching it off either — so hide it and draw the patch this set wants.
    model.root.traverse((o) => { if (o.name === 'shadowBlob') o.visible = false; });

    const patchMat = new THREE.MeshBasicMaterial({
      map: patchTex,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      // Pure darkening: throw the source colour away and keep dst * (1 - a).
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      opacity: 0,
    });
    // Sized to the footprint and not much more. A patch half again the
    // machine's own length is a smudge the machine happens to be standing near;
    // the occlusion this layer is standing in for lives under the chassis.
    //
    // Half a footprint of margin, though, and not a quarter: the gradient has
    // given away two thirds of its alpha by the time it reaches its own edge,
    // so a patch that stops exactly at the skirt puts nothing at all on the
    // ground the skirt is standing over. Measured at the footprint's own rim,
    // this geometry darkens the asphalt by about a quarter — the race's grid
    // shadow, arrived at from the other direction.
    const patch = new THREE.Mesh(
      new THREE.PlaneGeometry(def.size.width * 1.52, def.size.length * 1.42), patchMat);
    patch.rotation.x = -Math.PI / 2;
    patch.position.y = 0.017;
    patch.renderOrder = -1;
    patch.matrixAutoUpdate = true;
    model.root.add(patch);

    const d: Display = { id, racer, model, patch, patchMat };
    built.set(id, d);
    return d;
  }

  /** How strong a contact patch is. With a real cast shadow under it the patch
   *  is the occlusion term only; without one it is the whole shadow. */
  const PATCH_MAX = SHADOWS ? 0.56 : 0.92;

  const parade: ParadeEntry[] = [];
  /** Ids still waiting to join the parade. One is built per rendered frame, so
   *  a title screen assembles over half a second instead of stalling on seven
   *  shader compiles at once. */
  let paradeQueue: VehicleId[] = [];
  let paradeWant = false;
  let paradeLevel = 0;
  /** Lane z and speed, recomputed whenever the line-up changes. */
  const laneZ: number[] = [];
  /** Which lane each queued machine belongs in, and where in it. */
  const laneOf = new Map<VehicleId, { lane: number; slot: number; of: number }>();

  let heroId: VehicleId | null = null;
  /**
   * 0..1 clock for the arrival of a newly chosen machine.
   *
   * It used to drive a full revolution, which is why flicking the roster
   * regularly showed a vehicle's back: the machine arrived on the running
   * turntable angle and then spun through 360° from wherever that was, so the
   * frame after a keypress could be — and measurably was — rear-on. A character
   * select exists to show a player a face. So the machine now *snaps* to a
   * fixed three-quarter presentation, turns the last twelfth of a turn into it
   * and scales up off the ground, which is a swap you can read at a glance and
   * an angle that is the same in every screenshot ever taken of it.
   */
  let swapT = 1;
  /** The presenting angle. Three-quarter front, camera-left shoulder forward. */
  const PRESENT_YAW = 0.62;
  let heroSpin = PRESENT_YAW;
  let heroLevel = 0;
  /** Where the mark sits for the current machine, and where it is heading —
   *  damped, so a swap between a cone and a locomotive is a move rather than a
   *  jump. */
  let pushZ = 0;
  let pushTarget = 0;
  /**
   * How much the machine on the mark is scaled to fit the frame, and what it is
   * heading toward.
   *
   * The cast spans 1.9m (the cone) to 4.8m (the locomotive), and standing all
   * seven on the same mark at the same scale is why the cone photographed 250px
   * across and the tipper truck 700px and into the panel beside it. A character
   * select frames its subject; the distance the chase camera picks per vehicle
   * is the same idea. This is a *partial* normalisation on purpose — the big
   * machines stay visibly bigger, they just stop being twice the size of the
   * frame's subject.
   */
  let frameNow = 1;
  let frameTarget = 1;
  /** What a machine is framed to fill, in metres of its longest axis. */
  const FRAME_SPAN = 3.1;
  /** The random slot: the whole cast, cycled on the mark. */
  let shuffling = false;
  const shuffleIds = listVehicles().map((v) => v.id);

  function clearParade(): void {
    for (const e of parade) paradeGroup.remove(e.d.model.root);
    parade.length = 0;
    paradeQueue = [];
  }

  /**
   * Deal the cast into lanes and work out where the lanes are.
   *
   * Widest at the back, and each lane pushed away from the one in front of it
   * by half of each one's widest machine plus a fixed margin — so the spacing
   * rule is derived from the models rather than guessed at, and a wider machine
   * arriving later cannot silently start clipping its neighbour.
   */
  function enqueueParade(): void {
    laneOf.clear();
    laneZ.length = 0;
    const rest = listVehicles()
      .filter((v) => v.id !== MASCOT && v.id !== heroId);
    if (rest.length === 0) { paradeQueue = []; return; }
    const order = rest.slice().sort((a, b) => b.size.width - a.size.width);
    const per = Math.ceil(order.length / PARADE_LANES);
    const chunks: VehicleDef[][] = [];
    for (let i = 0; i < order.length; i += per) chunks.push(order.slice(i, i + per));
    // Built widest-first, so reversing puts the nearest lane at index 0.
    chunks.reverse();

    let z = NEAR_LANE_Z;
    let prevHalf = 0;
    for (let i = 0; i < chunks.length; i++) {
      const half = Math.max(...chunks[i]!.map((v) => v.size.width)) / 2;
      if (i > 0) z -= prevHalf + half + LANE_MARGIN;
      prevHalf = half;
      laneZ.push(z);
      for (let k = 0; k < chunks[i]!.length; k++) {
        laneOf.set(chunks[i]![k]!.id, { lane: i, slot: k, of: chunks[i]!.length });
      }
    }
    // Nearest lane first into the build queue: the machines closest to the lens
    // are the ones a player sees appear.
    paradeQueue = [];
    for (const chunk of chunks) for (const v of chunk) paradeQueue.push(v.id);
  }

  function joinParade(id: VehicleId): void {
    const d = displayOf(id);
    if (d.model.root.parent) d.model.root.parent.remove(d.model.root);
    const place = laneOf.get(id) ?? { lane: 0, slot: 0, of: 1 };
    const lane = Math.min(place.lane, Math.max(0, laneZ.length - 1));
    // Exactly one loop-fraction apart, and every machine in a lane runs at the
    // lane's speed — which is what makes the gap a constant and a collision
    // arithmetically impossible.
    //
    // The lanes are then offset by *half* a slot against each other, so the far
    // lane's machines sit in the near lane's gaps rather than directly behind
    // them. That is a screen-space rule rather than a clearance one — nothing
    // in two different lanes can ever touch — but a line-up photographed with
    // the truck parked squarely on top of the sedan reads as two machines
    // colliding whatever the depth buffer says about it.
    const phase = ((place.slot + (lane % 2) * 0.5) / place.of) * PARADE_SPAN * 2;
    let x = -PARADE_SPAN + (phase % (PARADE_SPAN * 2));
    if (x > PARADE_SPAN) x -= PARADE_SPAN * 2;
    parade.push({
      d,
      x,
      z: laneZ[lane] ?? NEAR_LANE_Z,
      speed: LANE_SPEED[Math.min(lane, LANE_SPEED.length - 1)]!,
      wob: lane * 1.9 + place.slot * 3.1,
    });
    paradeGroup.add(d.model.root);
  }

  /** The mascot, parked on its own mark. Null while the parade is off. */
  let mascot: Display | null = null;

  function takeMascot(): void {
    if (mascot || heroId === MASCOT) return;
    const d = displayOf(MASCOT);
    if (d.model.root.parent) d.model.root.parent.remove(d.model.root);
    d.model.root.position.set(0, 0, 0);
    mascotGroup.add(d.model.root);
    mascot = d;
  }

  function releaseMascot(): void {
    if (!mascot) return;
    mascotGroup.remove(mascot.model.root);
    mascot = null;
  }

  /**
   * Stand a machine on the mark.
   *
   * `pop` is the difference between a player choosing something — which gets
   * the snap, the turn-in and the scale-up — and the reel cycling underneath a
   * random pick, which must not restart that flourish forty times a second.
   */
  function mount(id: VehicleId | null, pop: boolean): void {
    if (heroId === id) return;
    heroId = id;
    // Out of the parade first. The same model instance serves both, and the
    // parade drives its transform every frame — a machine left in that list
    // is a machine that quietly drives off the character select.
    if (id) {
      const i = parade.findIndex((e) => e.d.id === id);
      if (i >= 0) { paradeGroup.remove(parade[i]!.d.model.root); parade.splice(i, 1); }
      if (id === MASCOT) releaseMascot();
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
      heroGroup.add(d.model.root);
      // Framing follows the machine's own size, exactly as the chase camera
      // does: a 4.8m locomotive and a 1.9m cone cannot share a distance. Small
      // machines come *forward*, or the cone this game is named after is a
      // thumbnail on its own character select.
      const size = getVehicle(id).size;
      const span = Math.max(size.length, size.width);
      pushTarget = -Math.max(-0.5, Math.min(0.9, (span - FRAME_SPAN) * 0.38));
      frameTarget = Math.max(0.74, Math.min(1.42, (FRAME_SPAN / span) ** 0.62));
      if (pop) swapT = 0;
    }
    if (paradeWant) { clearParade(); enqueueParade(); }
  }

  // ── shot ────────────────────────────────────────────────────────────────

  let from: Shot = SHOTS.title;
  let to: Shot = SHOTS.title;
  let shotT = 1;
  let level = 1;
  let levelTarget = 1;
  let clock = 0;
  let focusX = SHOTS.title.focus[0];
  let focusZ = SHOTS.title.focus[1];
  let focusR = SHOTS.title.radius;

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

  /**
   * Scratch for the contact probe. It is not a per-frame path — a reviewer
   * calls it between screenshots — but it reuses its vectors anyway, because a
   * debug hook that allocates is a debug hook someone eventually calls in a
   * loop.
   */
  const _mk = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _wp = new THREE.Vector3();
  const _ws = new THREE.Vector3();
  const _ray = new THREE.Raycaster();
  /** Everything a ground sample is allowed to land on, and everything that can
   *  legitimately be in the way of one. */
  const _hitList: THREE.Object3D[] = [];

  const api: Stage = {
    canvas,

    marks(): StageMark[] {
      const out: StageMark[] = [];
      const w = canvas.clientWidth || 1600;
      const h = canvas.clientHeight || 900;
      camera.updateMatrixWorld();
      scene.updateMatrixWorld();

      // A ground sample is only worth reading if the ground is what the camera
      // can see there. Every naive version of this measurement reads the roof
      // of the machine it is trying to find the shadow of — the point under a
      // digger, projected from a lens 15° above the road, is behind the digger.
      // So each candidate is raycast, and only the ones where the first thing
      // hit is the road itself survive.
      _hitList.length = 0;
      _hitList.push(ground);
      for (const m of paint.children) _hitList.push(m);
      for (const m of marks.children) _hitList.push(m);
      for (const d of built.values()) if (d.model.root.parent) _hitList.push(d.model.root);
      // Only the asphalt counts as ground. The painted markings are in the hit
      // list so a sample that lands on one is *rejected* — a white lane line
      // under a machine and a black kerb beside it would otherwise decide this
      // measurement between them.
      const groundIds = new Set<number>([ground.id]);

      const sample = (x: number, z: number): [number, number] | null => {
        _mk.set(x, 0.015, z);
        _dir.copy(_mk).sub(camera.position).normalize();
        _ray.set(camera.position, _dir);
        _ray.far = camera.position.distanceTo(_mk) + 0.4;
        const hits = _ray.intersectObjects(_hitList, true);
        // The contact patch and the halo are transparent overlays lying on the
        // road; they are the thing being measured, not an obstruction.
        for (const hit of hits) {
          if (groundIds.has(hit.object.id)) break;
          if ((hit.object as THREE.Mesh).material === undefined) continue;
          const mm = (hit.object as THREE.Mesh).material as THREE.Material;
          if (Array.isArray(mm) ? false : mm.transparent && mm.depthWrite === false) continue;
          return null;
        }
        _mk.project(camera);
        if (Math.abs(_mk.x) > 0.98 || Math.abs(_mk.y) > 0.98) return null;
        return [(_mk.x * 0.5 + 0.5) * w, (-_mk.y * 0.5 + 0.5) * h];
      };

      // A disc, not a ring. Most of the ground inside a machine's footprint is
      // behind the machine from any camera that can see the machine, so a
      // single ring of twenty-four survives the occlusion test five times and
      // the median of five points is not a measurement. Three bands at sixteen
      // angles leaves ten to twenty on each side.
      const ANGLES = 24;
      /**
       * Fractions of the footprint's half-extent — under the machine.
       *
       * Out to nine tenths of it, because how much of a machine's own footprint
       * a camera can see depends on how the machine stands on it. A kart with
       * wheels has daylight under the chassis and the lens looks straight
       * through it; the digger sits on two continuous tracks and there is *no*
       * visible ground inside 0.7 of its footprint from any angle a player can
       * reach. With the inner bands alone the instrument could read every
       * machine in the cast except the one the critique was written about.
       */
      const UNDER = [0.3, 0.5, 0.7, 0.9];
      /**
       * Metres clear of the footprint — the asphalt to read it against.
       *
       * Close in, deliberately, and starting closer still. Two metres out is
       * already past the widest contact patch on the set and inside the halo's
       * hole, and — the reason the nearest band exists at all — it is *inside
       * the frame*: on the character select the lens is fourteen metres away at
       * 32°, so ground five metres to the left of a machine standing left of
       * centre is not on screen, and a control sample that lands off the edge
       * of the picture is a control sample thrown away. With only the outer
       * bands, that screen reported nothing at all.
       */
      const BESIDE = [2.3, 2.9, 3.5, 4.2];
      /** Below this on either side, the machine is too obscured to judge. */
      const ENOUGH = 6;

      const add = (d: Display): void => {
        const root = d.model.root;
        if (!root.parent || !root.visible) return;
        root.updateWorldMatrix(true, false);
        root.getWorldPosition(_wp);
        const cx = _wp.x;
        const cz = _wp.z;
        // A machine half outside the frame cannot be measured: the samples that
        // survive are the handful nearest the edge, all on one side of it. Say
        // nothing about it rather than something wrong.
        _mk.set(cx, 0.015, cz).project(camera);
        if (Math.abs(_mk.x) > 0.86 || Math.abs(_mk.y) > 0.9) return;
        // The machine's own heading, so a parade machine driving across the set
        // is measured along its length rather than across it.
        const e = root.matrixWorld.elements;
        const yaw = Math.atan2(e[8]!, e[10]!);
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        // The footprint in *world* metres. The machine on the mark is framed by
        // scaling the group it stands in, so the declared size is only half the
        // answer — a probe that reads the unscaled footprint of a cone shown at
        // 1.4x samples ground the cone is no longer standing on.
        root.getWorldScale(_ws);
        const size = getVehicle(d.id).size;
        const hx = size.width * 0.5 * _ws.x;
        const hz = size.length * 0.5 * _ws.z;
        const near: Array<[number, number]> = [];
        const far: Array<[number, number]> = [];
        const at = (ox: number, oz: number): [number, number] | null =>
          sample(cx + ox * cy + oz * sy, cz - ox * sy + oz * cy);
        for (let i = 0; i < ANGLES; i++) {
          const a = (i / ANGLES) * Math.PI * 2;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          for (const k of UNDER) {
            const n = at(ca * hx * k, sa * hz * k);
            if (n) near.push(n);
          }
          for (const m of BESIDE) {
            const f = at(ca * (hx + m), sa * (hz + m));
            if (f) far.push(f);
          }
        }
        if (near.length >= ENOUGH && far.length >= ENOUGH) out.push({ id: d.id, near, far });
      };

      if (heroId && heroLevel > 0.5) add(displayOf(heroId));
      if (paradeLevel > 0.5) {
        if (mascot) add(mascot);
        for (const e of parade) add(e.d);
      }
      return out;
    },

    cut(shot): void {
      from = SHOTS[shot];
      to = SHOTS[shot];
      shotT = 1;
      focusX = to.focus[0];
      focusZ = to.focus[1];
      focusR = to.radius;
      focusShadow(focusX, focusZ, focusR);
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
        focus: to.focus,
        radius: to.radius,
      };
      to = SHOTS[shot];
      shotT = 0;
    },

    setHero(id): void { mount(id, true); },

    setShuffle(on): void {
      if (shuffling === on) return;
      shuffling = on;
      if (on) swapT = 1;
    },

    setParade(on): void {
      if (paradeWant === on) return;
      paradeWant = on;
      clearParade();
      if (on) { enqueueParade(); takeMascot(); } else releaseMascot();
    },

    setLevel(v): void { levelTarget = clamp01(v); },

    update(dt): void {
      clock += dt;
      if (shotT < 1) shotT = Math.min(1, shotT + dt / 0.52);
      level = damp(level, levelTarget, 0.0006, dt);
      applyShot();

      // One machine joins the parade per frame while there is a queue.
      if (paradeWant && paradeQueue.length > 0) joinParade(paradeQueue.shift()!);
      if (paradeWant && !mascot) takeMascot();

      paradeLevel = damp(paradeLevel, paradeWant ? 1 : 0, 0.0009, dt);
      heroLevel = damp(heroLevel, heroId ? 1 : 0, 0.0006, dt);

      // ── the parade ───────────────────────────────────────────────────────
      for (const e of parade) {
        e.x += e.speed * dt;
        if (e.x > PARADE_SPAN) e.x -= PARADE_SPAN * 2;
        // The weave is lateral only, and small: a lane's whole spacing budget
        // is spent on clearance, and a machine that wanders 40cm across it is
        // a machine that eventually finds its neighbour.
        const wob = Math.sin(clock * 0.7 + e.wob) * 0.075;
        const root = e.d.model.root;
        root.position.set(e.x, 0, e.z + Math.sin(clock * 0.35 + e.wob) * 0.16);
        root.rotation.y = Math.PI / 2 + wob;
        root.visible = paradeLevel > 0.02;
        e.d.patchMat.opacity = PATCH_MAX * paradeLevel * level;
        const r = e.d.racer;
        r.speed = e.speed;
        r.steerAngle = wob * 1.6;
        r.drift.angle = 0;
        e.d.model.update?.(r, dt, 1);
      }

      // ── the mascot ───────────────────────────────────────────────────────
      // Front and centre, facing the lens, weaving on the spot. It is the only
      // machine on the title screen that never goes anywhere, which is the
      // point: the game's namesake is in every frame of its own title card.
      if (mascot) {
        const root = mascot.model.root;
        root.position.set(Math.sin(clock * 0.31) * 0.62, 0, Math.sin(clock * 0.23) * 0.2);
        root.rotation.y = 0.34 + Math.sin(clock * 0.44) * 0.46;
        root.visible = paradeLevel > 0.02;
        mascot.patchMat.opacity = PATCH_MAX * paradeLevel * level;
        const r = mascot.racer;
        r.speed = 8.5;
        r.steerAngle = Math.sin(clock * 0.62) * 0.2;
        r.drift.angle = 0;
        mascot.model.update?.(r, dt, 1);
      }

      // ── the machine on the mark ──────────────────────────────────────────
      // The reel, when the cursor is on the random slot: the whole cast cycled
      // on the mark, six a second, spinning. Off the stage's own clock, so it
      // is the same reel in every screenshot at the same moment.
      if (shuffling) {
        const i = Math.floor(clock / 0.16) % shuffleIds.length;
        mount(shuffleIds[i]!, false);
      }
      if (heroId) {
        const d = displayOf(heroId);
        // **A sweep, not a turntable.** Every machine in this cast has a face,
        // and the face is the character — a continuous spin means that half the
        // time the thing a player is choosing has its back to them, and every
        // screenshot ever taken of this screen lands on an arbitrary angle. So
        // the machine holds the presenting three-quarter and rocks a third of a
        // radian either side of it, and a swap *snaps* to that angle rather than
        // inheriting whatever the last machine happened to be showing.
        if (swapT < 1) swapT = Math.min(1, swapT + dt / 0.3);
        const turnIn = (1 - ease.outCubic(swapT)) * 0.95;
        heroSpin = shuffling
          ? clock * 7.4
          : PRESENT_YAW + Math.sin(clock * 0.46) * 0.34 - turnIn;
        // ...and it grows onto the mark. A machine that is simply *there* one
        // frame after the keypress reads as a texture swap; one that comes up
        // off the ground reads as a machine being presented.
        const grow = shuffling ? 1 : lerp(0.68, 1, ease.outBack(swapT));
        frameNow = damp(frameNow, shuffling ? 1 : frameTarget, 0.00005, dt);
        heroGroup.scale.setScalar(grow * frameNow);
        pushZ = damp(pushZ, shuffling ? -1.1 : pushTarget, 0.0004, dt);
        heroGroup.position.set(0, 0, pushZ);
        d.model.root.position.set(0, 0, 0);
        d.model.root.rotation.set(0, heroSpin, 0);
        d.model.root.visible = heroLevel > 0.02;
        d.patchMat.opacity = PATCH_MAX * heroLevel * level * clamp01(swapT * 2.6);
        // Idling, not parked: enough rolling speed that wheels turn, rotors
        // spin and the plane's prop blurs, with a slow weave so the rigs' lean
        // and the cone's tip have something to answer.
        const r = d.racer;
        r.speed = shuffling ? 16 : 7 + (1 - swapT) * 7;
        r.steerAngle = Math.sin(clock * 0.8) * 0.16;
        d.model.update?.(r, dt, 1);
      }

      // ── the set ──────────────────────────────────────────────────────────
      // The halo is a ring: it lights the ground *around* the machine and
      // leaves the ground under it to the shadow.
      poolMat.opacity = heroLevel * level * 0.24;
      pool.visible = poolMat.opacity > 0.01;
      pool.position.set(heroGroup.position.x, 0.03, heroGroup.position.z);

      // The shadow volume follows the shot, eased on the same clock, so the
      // frustum tightens onto the hero as the camera arrives on it.
      const u = ease.inOutCubic(clamp01(shotT));
      const tx = lerp(from.focus[0], to.focus[0], u);
      const tz = lerp(from.focus[1], to.focus[1], u);
      const tr = lerp(from.radius, to.radius, u);
      focusX = damp(focusX, heroId ? tx + heroGroup.position.x * 0.5 : tx, 0.0008, dt);
      focusZ = damp(focusZ, heroId ? tz + heroGroup.position.z * 0.5 : tz, 0.0008, dt);
      focusR = damp(focusR, tr, 0.0008, dt);
      focusShadow(focusX, focusZ, focusR);

      // The crowd bobs. Two frequencies per person off one phase, so the bank
      // ripples rather than pulsing in time — a stand of a hundred people all
      // at the same point in the same bounce is a stand nobody believes.
      for (let i = 0; i < CROWD; i++) {
        const ph = crowdAt[i * 4 + 3]!;
        const bob = Math.sin(clock * 2.6 + ph) * 0.11 + Math.sin(clock * 1.3 + ph * 1.7) * 0.06;
        _cp.set(crowdAt[i * 4]!, crowdAt[i * 4 + 1]! + bob, crowdAt[i * 4 + 2]!);
        _cq.setFromAxisAngle(_up, Math.sin(clock * 0.8 + ph) * 0.25);
        _cm.compose(_cp, _cq, _cs);
        crowd.setMatrixAt(i, _cm);
      }
      crowd.instanceMatrix.needsUpdate = true;

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
      key.intensity = KEY_I * level;
      kick.intensity = KICK_I * level;
      sky.intensity = SKY_I * level;
      renderer.toneMappingExposure = EXPOSURE * (0.35 + 0.65 * level);
    },

    render(): void {
      resize();
      renderer.render(scene, camera);
    },

    dispose(): void {
      clearParade();
      releaseMascot();
      for (const d of built.values()) {
        if (d.model.root.parent) d.model.root.parent.remove(d.model.root);
        d.patch.geometry.dispose();
        d.patchMat.dispose();
        d.model.dispose?.();
      }
      built.clear();
      crowd.dispose();
      crowdGeo.dispose();
      crowdMat.dispose();
      disposeTree(scene);
      (scene.background as THREE.Texture | null)?.dispose?.();
      roadTex.dispose();
      patchTex.dispose();
      moteGeo.dispose();
      moteMat.dispose();
      poolMat.dispose();
      renderer.dispose();
    },
  };

  api.cut('title');
  return api;
}
