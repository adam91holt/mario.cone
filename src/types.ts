/**
 * The contract every module compiles against.
 *
 * Many agents work on this repo in parallel. These interfaces are how they stay
 * compatible without reading each other's code: if your change breaks someone
 * else's module, `npm run typecheck` fails before it ever reaches the game.
 *
 * Adding an optional field is safe. Changing or removing an existing one is a
 * cross-module change — say so in your report.
 */

import type * as THREE from 'three';
import type { EventBus } from './core/bus.ts';
import type { Rng } from './core/math.ts';
import type { InputController, InputState } from './core/input.ts';
import type { Config } from './core/config.ts';

// ── Surfaces & racing ──────────────────────────────────────────────────────

export type Surface = 'road' | 'dirt' | 'grass' | 'sand' | 'rail' | 'water' | 'boost' | 'air';

export type RacePhase = 'loading' | 'intro' | 'countdown' | 'racing' | 'finished' | 'results';

export type EngineClass = '50cc' | '100cc' | '150cc' | '200cc';

export type VehicleId = 'cone' | 'plane' | 'helicopter' | 'digger' | 'train' | 'truck' | 'car';

export type BoostSource =
  | 'mushroom' | 'pad' | 'star' | 'bullet' | 'slipstream' | 'trick'
  | 'drift1' | 'drift2' | 'drift3' | 'rocketStart';

export type ItemId =
  | 'banana' | 'greenShell' | 'redShell' | 'mushroom' | 'tripleMushroom'
  | 'star' | 'bulletBill' | 'lightning' | 'blooper' | 'boo' | 'bomb'
  | 'coin' | 'horn';

// ── Vehicle stats ──────────────────────────────────────────────────────────

/** Each 0..1. Mirrors Mario Kart's stat bars — they trade off against each other. */
export interface VehicleStats {
  speed: number;
  accel: number;
  weight: number;
  handling: number;
  traction: number;
}

export interface VehicleDef {
  id: VehicleId;
  name: string;
  /**
   * Who drives it. **The cast lives here and nowhere else.**
   *
   * The field used to be dealt out of a flat `CPU_NAMES` array in `main.ts`
   * indexed by grid slot, while the machines came from `all.filter(v => v.id
   * !== cfg.vehicleId)` indexed by the same slot — two orders that only lined up
   * by accident and came apart the moment the player's pick removed an entry
   * from the pool. BOLLARD was a Sedan or a Road Cone depending on what *you*
   * had chosen; TARMAC was a helicopter or a plane; the player was 'Foreman' in
   * whatever they happened to be sitting in. That is a costume rack, not a cast.
   *
   * A driver belongs to a machine the way a name belongs to a character, so it
   * is a field on the machine and every racer — the player included — reads its
   * own name off its own def. FOREMAN means the cone, on both sides of the
   * curtain, in every race, whoever is holding the controller.
   */
  driver: string;
  /** One-line character read, shown on the select screen. */
  blurb: string;
  stats: VehicleStats;
  /** Primary/secondary colours used by HUD, minimap blips and trails. */
  colors: { primary: number; secondary: number; accent: number };
  /** Metres. Used for camera framing, collision radius and shadow size. */
  size: { length: number; width: number; height: number };
  /** Builds the display model. Must return an Object3D centred on its contact point. */
  build(ctx: GameContext): VehicleModel;
}

/** The visual rig for a racer. Animation hooks are optional but expected. */
export interface VehicleModel {
  root: THREE.Object3D;
  /** Per-frame animation driven by the owning racer's state. */
  update?(racer: Racer, dt: number, alpha: number): void;
  /** Wheels/rotors/etc. that other systems may want to reference. */
  parts?: Record<string, THREE.Object3D>;
  dispose?(): void;
}

// ── Racer ──────────────────────────────────────────────────────────────────

export interface DriftState {
  active: boolean;
  /** -1 left, +1 right, 0 none. */
  dir: -1 | 0 | 1;
  charge: number;
  /** 0 = not yet charged, 1..3 = mini-turbo tier reached. */
  tier: 0 | 1 | 2 | 3;
  /** Visual yaw offset of the chassis relative to travel direction. */
  angle: number;
  hopTime: number;
}

export interface BoostState {
  time: number;
  power: number;
  source: BoostSource | null;
}

export interface Racer {
  id: number;
  name: string;
  vehicleId: VehicleId;
  isPlayer: boolean;

  // Simulation truth. Written only by physics.
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  /** Previous fixed-step transform, for render interpolation. */
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;

  /** Scene node. Written only by the render/vehicle layer. */
  visual: THREE.Object3D | null;
  model: VehicleModel | null;

  speed: number;
  maxSpeed: number;
  steerAngle: number;
  yaw: number;

  drift: DriftState;
  boost: BoostState;

  grounded: boolean;
  airTime: number;
  surface: Surface;

  // Written by the race director.
  lap: number;
  checkpoint: number;
  place: number;
  /** Monotonic race progress in metres, laps included. Sorting key for places. */
  progress: number;
  finished: boolean;
  finishTime: number;
  lapTimes: number[];

  // Written by the item system.
  coins: number;
  item: ItemId | null;
  itemCount: number;
  stunned: number;
  invulnerable: number;
  effects: Set<string>;

  stats: VehicleStats;
  /** AI brain, absent for the human player. */
  ai: AiDriver | null;
  /** Input the AI authored for this step. Physics reads it in place of the
   *  player's input. Absent for the human player. */
  aiInput?: InputState;
  /** Rubber-band top-speed multiplier written by the AI system and folded into
   *  top speed by physics. 1 = no adjustment. */
  rubberBand?: number;
}

export interface AiDriver {
  skill: number;
  /** Lateral offset from the racing line this driver prefers, in metres. */
  linePreference: number;
  update(racer: Racer, dt: number): void;
}

// ── Track ──────────────────────────────────────────────────────────────────

export interface SplineSample {
  pos: THREE.Vector3;
  tangent: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  width: number;
  bank: number;
  curvature: number;
  distance: number;
  t: number;
  index: number;
  /** Present only on `nearest()` results. */
  lateral?: number;
  height?: number;
  distanceTo?: number;
  onRoad?: boolean;
  edgeDistance?: number;
  surface?: Surface;
}

export interface ControlPoint {
  x: number;
  y?: number;
  z: number;
  width?: number;
  /** Roll about the tangent, radians. Positive banks the right side up. */
  bank?: number;
}

export interface Checkpoint {
  index: number;
  distance: number;
  pos: THREE.Vector3;
  forward: THREE.Vector3;
  width: number;
}

export interface GridSlot {
  pos: THREE.Vector3;
  forward: THREE.Vector3;
  up: THREE.Vector3;
  distance: number;
}

export interface CourseDef {
  id: string;
  name: string;
  /** Cup this course belongs to, for the course-select screen. */
  cup?: string;
  points: ControlPoint[];
  width?: number;
  laps?: number;
  vergeWidth?: number;
  vergeSurface?: Surface;
  offSurface?: Surface;
  walls?: boolean;
  wallHeight?: number;
  groundSize?: number;
  groundY?: number;
  startDistance?: number;
  checkpoints?: number;
  theme?: CourseTheme;
}

export interface CourseTheme {
  ground?: number;
  sky?: { top: number; bottom: number; horizon?: number };
  fog?: { color: number; near: number; far: number };
  sun?: { color: number; intensity: number; azimuth: number; elevation: number };
  road?: { base?: string; line?: string; edge?: string };
  /** Free-form hook for the world system's set dressing. */
  props?: Record<string, unknown>;
}

export interface Track {
  id: string;
  name: string;
  course: CourseDef;
  spline: TrackSplineLike;
  group: THREE.Object3D;
  length: number;
  laps: number;
  checkpoints: Checkpoint[];
  theme: CourseTheme;
  sample(worldPos: THREE.Vector3, out?: SplineSample): SplineSample;
  gridSlot(index: number, total: number): GridSlot;
}

/** The subset of TrackSpline that other modules are allowed to depend on. */
export interface TrackSplineLike {
  length: number;
  at(t: number, out?: SplineSample): SplineSample;
  atDistance(d: number, out?: SplineSample): SplineSample;
  nearest(worldPos: THREE.Vector3, out?: SplineSample): SplineSample;
  pointAt(distance: number, lateral?: number, height?: number, out?: THREE.Vector3): THREE.Vector3;
  forwardDistance(a: number, b: number): number;
  signedDistance(a: number, b: number): number;
}

// ── Race state ─────────────────────────────────────────────────────────────

export interface RaceState {
  phase: RacePhase;
  time: number;
  totalLaps: number;
  engineClass: EngineClass;
  /** Racer ids, sorted — index 0 is first place. */
  standings: number[];
  countdown: number;
  finishedCount: number;
}

// ── Systems & context ──────────────────────────────────────────────────────

/**
 * Every system is created by a factory taking the context.
 *
 * `fixedUpdate` is deterministic simulation at a constant dt. `update` is
 * per-frame visuals only. Putting gameplay in `update` desynchronises the
 * simulation from the automated critics and will be rejected.
 */
export interface GameSystem {
  readonly name: string;
  /** Lower runs first. See the reserved slots in ARCHITECTURE.md §4.1. */
  readonly order: number;
  init?(): void | Promise<void>;
  reset?(cfg: RaceConfig): void;
  fixedUpdate?(dt: number): void;
  update?(dt: number, alpha: number): void;
  dispose?(): void;
}

export interface RaceConfig {
  courseId: string;
  vehicleId: VehicleId;
  engineClass: EngineClass;
  racerCount: number;
  laps?: number;
  seed?: number;
  /** Skip intro/countdown — used by the capture harness. */
  instant?: boolean;
}

export interface QualitySettings {
  tier: 'low' | 'med' | 'high';
  shadows: boolean;
  shadowSize: number;
  postfx: boolean;
  particles: number;
  drawDistance: number;
  aa: boolean;
  /**
   * The bloom pyramid, separately from the rest of the post stack.
   *
   * `postfx` is all-or-nothing and turning it off is a cliff: the atmosphere,
   * the film stock, the vignette and the grade all go with it, `THREE.FogExp2`
   * comes back on the scene, and every material in the game recompiles in the
   * one frame the governor picked to rescue a machine that was already failing
   * — measured at 762ms and thirty new programs. The pyramid on its own is a
   * bright pass and eight blits over five mips, and dropping it changes the
   * picture by a little rather than by everything.
   *
   * Undefined means on, so a tier that predates this field keeps its bloom.
   */
  bloom?: boolean;
}

export interface TimeState {
  elapsed: number;
  dt: number;
  alpha: number;
  frame: number;
  /** Global time multiplier. Slow-mo on finish, 0 when paused. */
  scale: number;
}

/** Optional subsystem handles other modules may look up off the context. */
export interface AudioSystem {
  play(id: string, opts?: { volume?: number; rate?: number; pos?: THREE.Vector3 }): void;
  setMusic(id: string | null, opts?: { fade?: number }): void;
  setListener(pos: THREE.Vector3, quat: THREE.Quaternion): void;
  setEngine(racer: Racer): void;
  unlock(): Promise<void>;
}

export interface FxSystem {
  spawn(id: string, pos: THREE.Vector3, opts?: Record<string, unknown>): void;
  shake(amount: number, duration?: number): void;
  flash(color: number, amount?: number): void;
}

export interface GameContext {
  THREE: typeof THREE;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Post-processing stack, installed by the render module. */
  composer: { render(dt: number): void; setSize(w: number, h: number): void } | null;

  bus: EventBus;
  rng: Rng;
  config: Config;
  quality: QualitySettings;
  input: InputController;
  inputState: InputState;
  time: TimeState;

  track: Track | null;
  racers: Racer[];
  player: Racer | null;
  race: RaceState;

  audio: AudioSystem | null;
  fx: FxSystem | null;

  /**
   * The frame budget, filled in by the engine every rendered frame and mutated
   * in place — read it as often as you like without allocating. **Never from
   * `fixedUpdate`:** a simulation that branches on how fast the machine is
   * running is not a deterministic one.
   */
  budget?: FrameBudget;

  /** Set by the harness installer. */
  harness?: HarnessApi;
}

// ── Automation surface ─────────────────────────────────────────────────────

/**
 * `window.__GAME`. Every automated critic sees the game only through this.
 * Renaming or removing a member here blinds the review pipeline — don't.
 */
export interface HarnessApi {
  ready: boolean;
  version: string;
  step(seconds?: number): number;
  render(): void;
  advance(seconds?: number, fps?: number): number;
  reset(opts?: Partial<RaceConfig>): Promise<void>;
  setInput(partial: Partial<VirtualInput>): void;
  clearInput(key?: keyof VirtualInput): void;
  press(name: string): void;
  setCamera(mode: CameraMode): CameraMode;
  setQuality(tier: QualitySettings['tier']): void;
  setTimeScale(s: number): void;
  /** Hand the player's kart to a CPU driver, so a capture can travel a real
   *  racing line instead of ploughing straight into the first barrier. */
  setAutopilot(on: boolean): void;
  seek(phase: RacePhase): RacePhase;
  stats(): RenderStats;
  snapshot(): Snapshot;
  errors: string[];
}

export type CameraMode = 'chase' | 'far' | 'near' | 'cinematic' | 'free' | 'front' | 'overhead';

export interface VirtualInput {
  steer: number;
  accel: number;
  brake: number;
  drift: boolean;
  item: boolean;
  look: number;
  pause: boolean;
}

/** One system's measured cost, milliseconds per rendered frame. */
export interface SystemCost {
  name: string;
  /** Time in this system's `fixedUpdate`, summed over the frame's steps. */
  simMs: number;
  /** ...and in its `update`. */
  updateMs: number;
}

/**
 * The frame budget, mutated in place by the engine every rendered frame.
 *
 * Live on `ctx` rather than only behind `stats()` so the quality governor can
 * read it every frame without allocating an object to do it. Read-only to
 * everyone except the engine — and unreadable to `fixedUpdate` by convention,
 * because a simulation that branches on how fast the machine is running is not
 * a deterministic one.
 */
export interface FrameBudget {
  /** The last rendered frame, milliseconds. */
  simMs: number;
  updateMs: number;
  drawMs: number;
  /** Mean and worst of (sim + update + draw) over the last 60 frames. */
  meanMs: number;
  worstMs: number;
  meanSimMs: number;
  meanDrawMs: number;
  /** Mean wall-clock frame time from the rAF loop; 0 when the harness drives. */
  wallMs: number;
  /** Fixed steps folded into the last rendered frame. */
  steps: number;
  /** Rendered frames since boot. */
  frames: number;
  /**
   * Frames the rAF loop drove, and frames the test harness drove.
   *
   * These are different animals and anything tuning itself against frame cost
   * has to tell them apart. `advance()` renders six fixed steps at a time from
   * a Node round trip on a software rasteriser; a governor that reads that as
   * "this machine cannot hold 60fps" would turn the review sheet down to the
   * low tier and photograph the wrong game.
   */
  liveFrames: number;
  benchFrames: number;
  /**
   * Fixed steps driven from **outside** the rAF loop — `__GAME.step()`.
   *
   * The other half of telling a bench from a player, and the half that
   * `benchFrames` cannot cover. A capture recipe like `rideUntil` steps the
   * simulation for three or four seconds of wall time inside one
   * `page.evaluate` and renders nothing at all; the rAF callback that lands
   * afterwards then measures a gap that is entirely somebody else's work. That
   * gap is not a frame this machine drew, and the only honest way to know is a
   * *causal* one — did the harness run in it — rather than "was it longer than
   * two seconds", which is a rule that throws away exactly the frames a slow
   * machine is made of. See `STALL_MS`'s grave in `core/quality.ts`.
   */
  benchSteps: number;

  // ── what the quality governor has settled on ─────────────────────────────
  //
  // Written by `core/quality.ts`, not by the engine, and kept here so that
  // `stats()` can report the governor's verdict without `engine.ts` having to
  // know the governor exists. The engine initialises them and never touches
  // them again; with no governor installed they simply read as rung 0.
  /** Index into the ladder. 0 is the most expensive. */
  rung: number;
  rungLabel: string;
  /** Fraction of the display's own resolution the 3D is drawn at. */
  renderScale: number;
  /** Mean wall time between *delivered* frames as the governor measures it —
   *  its own short window, cleared on every change. 0 until it has one. */
  liveWallMs: number;
  liveWorstMs: number;
  /** Real seconds of delivered play the governor has actually accrued. */
  liveSeconds: number;
  /** What the governor is doing or waiting for, in one word. */
  governor: string;
  /**
   * Skip this frame's **draw** — the update still runs.
   *
   * Written by `core/quality.ts` off the `ui:menu` edges and read by
   * `engine.ts` immediately before the draw. It exists for exactly one
   * situation and should never be set for any other: the front-end is up and
   * the module that owns it is covering the entire frame with its own opaque
   * set, so every pixel of the race behind it is thrown away by the compositor.
   *
   * ARCHITECTURE §11a says the race keeps *simulating* behind the front-end.
   * It says nothing about it having to keep *drawing* there, and it was —
   * measured on the untouched title screen at 1600x900, 356-538 draw calls and
   * 794k-827k triangles through the full HDR post stack every frame, which made
   * PRESS START (0.5-0.9fps) the most expensive frame in the game, slower than
   * actually racing (1.5fps).
   *
   * The engine honours it only for frames the rAF loop drove. A harness
   * `render()` always draws, so a reviewer's screenshot and the shader-priming
   * frame in `startRace` are unaffected.
   */
  skipDraw: boolean;
}

export interface RenderStats {
  /** Frames per second the measured work implies, capped at the 60fps target. */
  fps: number;
  /** Measured work per frame: sim + update + draw. Not a wall-clock delta. */
  ms: number;
  worstMs: number;
  drawCalls: number;
  triangles: number;
  /**
   * The engine skipped this frame's draw — see `FrameBudget.skipDraw`.
   *
   * Reported next to `drawCalls` because otherwise a zero there is ambiguous:
   * a frame deliberately not drawn behind an opaque front-end and a frame whose
   * scene has gone missing report the same numbers. Only ever true for a frame
   * the rAF loop drove.
   */
  drawSkipped?: boolean;
  programs: number;
  geometries: number;
  textures: number;

  // ── the budget, split three ways ──────────────────────────────────────────
  // A frame that misses 16.7ms in the simulation and a frame that misses it in
  // the draw are different bugs. These are optional only so that adding them
  // could not break another module mid-wave; the engine always fills them.
  /** Milliseconds of the last frame spent in `fixedUpdate`, all steps together. */
  simMs?: number;
  /** ...in the systems' `update` pass. */
  updateMs?: number;
  /** ...in the draw itself, post stack included. */
  drawMs?: number;
  meanSimMs?: number;
  meanDrawMs?: number;
  /** Mean wall frame time from the rAF loop; 0 while the harness is driving. */
  wallMs?: number;
  /** Fixed steps folded into the last rendered frame. */
  steps?: number;

  // ── what the quality governor has settled on ─────────────────────────────
  tier?: QualitySettings['tier'];
  drawDistance?: number;
  particles?: number;
  /** 0 when shadows are off, so "no shadow map" and "a small one" differ. */
  shadowSize?: number;
  /** Which rung of the ladder, and its name. A tier alone cannot say: the
   *  ladder has six rungs across three tiers. */
  rung?: number;
  rungLabel?: string;
  /** Fraction of the display's resolution the 3D is drawn at. The single
   *  largest thing the ladder spends, so a review that does not report it is
   *  reporting half the picture. */
  renderScale?: number;
  /** The governor's own wall-clock window — mean and worst delivered frame —
   *  which is a different instrument from `wallMs`'s sixty-frame mean and is
   *  the one the ladder actually decides on. */
  liveWallMs?: number;
  liveWorstMs?: number;
  liveSeconds?: number;
  /** One word: what the governor is doing, or why it is not. */
  governor?: string;

  /** Per-system cost, most expensive first. Systems under 5µs are omitted. */
  systems?: SystemCost[];
}

export interface Snapshot {
  version: string;
  time: { elapsed: number; frame: number };
  race: Pick<RaceState, 'phase' | 'time' | 'totalLaps' | 'standings'> | null;
  track: { id: string; name: string; length: number } | null;
  racers: SnapshotRacer[];
  camera: { pos: [number, number, number]; fov: number };
  errors: string[];
}

export interface SnapshotRacer {
  id: number;
  name: string;
  vehicleId: VehicleId;
  isPlayer: boolean;
  pos: [number, number, number];
  speed: number;
  place: number;
  lap: number;
  progress: number;
  coins: number;
  item: ItemId | null;
  grounded: boolean;
  surface: Surface;
  drift: { active: boolean; tier: number; charge: number };
  boost: { time: number; source: BoostSource | null };
  stunned: number;
}

declare global {
  interface Window {
    __GAME?: HarnessApi;
  }
}
