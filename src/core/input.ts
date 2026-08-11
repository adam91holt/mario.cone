// Input sampling.
//
// Everything funnels through one state object so the automated critics can drive
// the game by writing to `virtual` instead of faking DOM events. Gameplay code
// must read `ctx.inputState` and never the keyboard directly — a direct DOM read
// bypasses the harness and makes the feature untestable.

import { clamp, damp } from './math.ts';
import type { VirtualInput } from '../types.ts';

type Action =
  | 'accel' | 'brake' | 'left' | 'right'
  | 'drift' | 'item' | 'look' | 'pause' | 'confirm' | 'back';

const KEYMAP: Record<string, Action> = {
  ArrowUp: 'accel', KeyW: 'accel',
  ArrowDown: 'brake', KeyS: 'brake',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  Space: 'drift', ShiftLeft: 'drift', ShiftRight: 'drift',
  KeyE: 'item', ControlLeft: 'item', KeyZ: 'item',
  KeyQ: 'look',
  Escape: 'pause', KeyP: 'pause',
  Enter: 'confirm', NumpadEnter: 'confirm',
  Backspace: 'back',
};

export interface InputState {
  steer: number;
  accel: number;
  brake: number;
  drift: boolean;
  item: boolean;
  look: number;
  /** Edge-triggered: true for exactly one fixed step. */
  pressed: Record<string, boolean>;
  anyInput: boolean;
  source: 'keyboard' | 'gamepad' | 'touch';
}

export interface InputController {
  readonly state: InputState;
  sample(dt: number): InputState;
  /** Harness entry point — sticky until overwritten or cleared. */
  setVirtual(partial: Partial<VirtualInput> | null): void;
  clearVirtual(key?: keyof VirtualInput): void;
  press(name: string): void;
  setEnabled(v: boolean): void;
  /**
   * The on-screen controls' reading, or null when no finger is on the glass.
   *
   * Touch lives here rather than in `virtual` because `virtual` is the harness's
   * override and short-circuits the whole device path — the same short-circuit
   * that hid inverted steering from every automated critic for days. A phone is
   * a device, not a test fixture, so it samples like one.
   */
  setTouch(sample: TouchSample | null): void;
  dispose(): void;
}

/** What the on-screen controls report. Steer is in the same left-positive
 *  convention as everything else that feeds physics. */
export interface TouchSample {
  steer: number;
  accel: number;
  brake: number;
  drift: boolean;
  item: boolean;
}

export function createInput(): InputController {
  const raw: Partial<Record<Action, boolean>> = {};
  const virtual: Partial<VirtualInput> = {};
  const oneShots = new Set<string>();
  const prev: Record<string, boolean> = {};

  const state: InputState = {
    steer: 0, accel: 0, brake: 0,
    drift: false, item: false, look: 0,
    pressed: {},
    anyInput: false,
    source: 'keyboard',
  };

  let steerSmoothed = 0;
  let enabled = true;
  let touch: TouchSample | null = null;

  const onKey = (down: boolean) => (e: KeyboardEvent): void => {
    const action = KEYMAP[e.code];
    if (!action) return;
    // Arrows and space scroll the page otherwise, which yanks the canvas around.
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    raw[action] = down;
    if (down) state.source = 'keyboard';
  };

  const keyDown = onKey(true);
  const keyUp = onKey(false);
  const onBlur = (): void => { for (const k of Object.keys(raw) as Action[]) raw[k] = false; };

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', keyDown, { passive: false });
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', onBlur);
  }

  interface PadSample {
    steer: number; accel: number; brake: number;
    drift: boolean; item: boolean; look: number; pause: boolean;
  }

  function pollGamepad(): PadSample | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const dead = (v: number): number => (Math.abs(v) < 0.14 ? 0 : v);
      const used =
        Math.abs(dead(p.axes[0] ?? 0)) > 0 ||
        !!p.buttons[0]?.pressed ||
        (p.buttons[7]?.value ?? 0) > 0.05;
      if (!used && state.source !== 'gamepad') continue;
      return {
        steer: clamp(dead(p.axes[0] ?? 0), -1, 1),
        accel: Math.max(p.buttons[7]?.value ?? 0, p.buttons[0]?.pressed ? 1 : 0),
        brake: Math.max(p.buttons[6]?.value ?? 0, p.buttons[2]?.pressed ? 1 : 0),
        drift: !!(p.buttons[5]?.pressed || p.buttons[1]?.pressed),
        item: !!(p.buttons[4]?.pressed || p.buttons[3]?.pressed),
        look: p.buttons[10]?.pressed ? 1 : 0,
        pause: !!p.buttons[9]?.pressed,
      };
    }
    return null;
  }

  const has = <K extends keyof VirtualInput>(k: K): boolean =>
    Object.prototype.hasOwnProperty.call(virtual, k);

  /** Called once per fixed step, before any system reads input. */
  function sample(dt: number): InputState {
    if (!enabled) {
      state.steer = state.accel = state.brake = 0;
      state.drift = state.item = false;
      state.pressed = {};
      return state;
    }

    const pad = pollGamepad();
    if (pad) state.source = 'gamepad';

    // **Positive steer turns LEFT.** That reads backwards and it is worth being
    // exact about why, because it shipped inverted once already.
    //
    // Physics integrates `yaw += steer * turnRate` against a heading of
    // `(sin yaw, 0, cos yaw)`. Increasing that yaw swings the nose from +Z
    // toward +X, and the chase camera looks along the heading, which puts world
    // -X on the right of the screen. So a positive steer moves the nose to
    // screen *left*, and the AI — which authors `steer` from a signed angle
    // about +Y — is written to match.
    //
    // The devices are therefore what must be negated, not the simulation:
    // flipping the integration would silently invert every CPU driver too.
    // A finger on the glass outranks a gamepad and the keyboard, and is itself
    // outranked by the harness. `tou` is negated for the same reason `pad` is:
    // the on-screen stick reports screen-right as positive, like every other
    // device a person actually holds.
    const tou = touch;
    if (tou) state.source = 'touch';

    let steerTarget: number;
    if (has('steer')) steerTarget = clamp(virtual.steer!, -1, 1);
    else if (tou) steerTarget = -tou.steer;
    else if (pad) steerTarget = -pad.steer;
    else steerTarget = (raw.left ? 1 : 0) - (raw.right ? 1 : 0);

    // Digital keys get eased into an analog value; sticks and thumbs are
    // already analog.
    const digital = !pad && !tou && !has('steer');
    steerSmoothed = digital ? damp(steerSmoothed, steerTarget, 0.00002, dt) : steerTarget;
    state.steer = Math.abs(steerSmoothed) < 0.001 ? 0 : steerSmoothed;

    const pick = <T>(k: keyof VirtualInput, v: () => T, t: T, p: T, r: T): T =>
      has(k) ? v() : tou ? t : pad ? p : r;

    state.accel = pick('accel', () => clamp(virtual.accel!, 0, 1), tou?.accel ?? 0, pad?.accel ?? 0, raw.accel ? 1 : 0);
    state.brake = pick('brake', () => clamp(virtual.brake!, 0, 1), tou?.brake ?? 0, pad?.brake ?? 0, raw.brake ? 1 : 0);
    state.drift = pick('drift', () => !!virtual.drift, !!tou?.drift, !!pad?.drift, !!raw.drift);
    state.item = pick('item', () => !!virtual.item, !!tou?.item, !!pad?.item, !!raw.item);
    state.look = has('look') ? clamp(virtual.look!, -1, 1) : pad ? pad.look : raw.look ? 1 : 0;

    const nowPressed: Record<string, boolean> = {
      drift: state.drift,
      item: state.item,
      pause: has('pause') ? !!virtual.pause : pad ? pad.pause : !!raw.pause,
      confirm: !!raw.confirm,
      back: !!raw.back,
      accel: state.accel > 0.5,
    };
    state.pressed = {};
    for (const k of Object.keys(nowPressed)) {
      state.pressed[k] = !!nowPressed[k] && !prev[k];
      prev[k] = !!nowPressed[k];
    }
    for (const k of oneShots) state.pressed[k] = true;
    oneShots.clear();

    state.anyInput = state.accel > 0 || state.brake > 0 || state.steer !== 0 || state.drift;
    return state;
  }

  return {
    state,
    sample,
    setVirtual(partial) {
      if (partial === null) {
        for (const k of Object.keys(virtual) as (keyof VirtualInput)[]) delete virtual[k];
        return;
      }
      Object.assign(virtual, partial);
    },
    clearVirtual(key) {
      if (key) delete virtual[key];
      else for (const k of Object.keys(virtual) as (keyof VirtualInput)[]) delete virtual[k];
    },
    press(name) { oneShots.add(name); },
    setEnabled(v) { enabled = v; },
    setTouch(sample) { touch = sample; },
    dispose() {
      if (typeof window === 'undefined') return;
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}
