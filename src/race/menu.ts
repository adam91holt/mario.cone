// The option row every screen in this module ends with.
//
// One widget, shared by the pause menu and the results screen, so "the thing
// you press" looks and behaves identically wherever the game stops. Three rules
// it is built to:
//
//   *It is a row, not a column.* This game's only analogue axis is the steering
//   wheel, and the only edge-triggered keys the input layer publishes are
//   drift, item, pause, confirm, back and accelerate. A horizontal row is
//   navigated with the stick the player already has their thumb on; a vertical
//   list would need an axis that does not exist.
//
//   *Nothing animates in CSS.* Same rule as the HUD — every motion here is
//   integrated from the `dt` handed to `update()`, so the capture harness, which
//   renders frames with no wall clock at all, photographs the same frame every
//   time.
//
//   *It is clickable too.* The HUD is `pointer-events: none` because nothing in
//   it is a control. These are controls, so they take the mouse as well as the
//   keyboard — a person who has just finished a race and reaches for the
//   pointer should not find a dead screen.

import { clamp01, ease } from '../core/math.ts';
import { signBox } from './letters.ts';
import { bind, fromHtml, q, type Bound } from '../ui/theme.ts';

export const CSS_MENU = `
#race .opts { display: flex; gap: calc(var(--u) * .85); align-items: stretch; }
#race .opt {
  position: relative; pointer-events: auto; cursor: pointer;
  display: flex; align-items: center; gap: calc(var(--u) * .5);
  padding: calc(var(--u) * .52) calc(var(--u) * 1.15) calc(var(--u) * .58);
  border-radius: calc(var(--u) * .5);
  background: linear-gradient(178deg, rgba(58,65,82,.95) 0%, rgba(28,33,43,.96) 48%, rgba(15,18,25,.96) 100%);
  box-shadow:
    inset 0 calc(var(--u) * .1) 0 rgba(255,255,255,.26),
    inset 0 calc(var(--u) * -.14) 0 rgba(0,0,0,.5),
    0 0 0 calc(var(--u) * .12) rgba(9,11,15,.92),
    0 calc(var(--u) * .22) calc(var(--u) * .6) rgba(0,0,0,.55);
  overflow: hidden;
}
/* The header strip every plate in this game wears, so an option reads as part
   of the same instrument set as the lap counter. */
#race .opt::before {
  content: ''; position: absolute; left: 0; right: 0; top: 0;
  height: calc(var(--u) * .16);
  background: linear-gradient(90deg, #FFC300, #FF9A1A 60%, #FFC300); opacity: .9;
}
#race .opt .word { height: calc(var(--u) * 1.5); color: #E8ECF4; }
#race .opt.on { background: linear-gradient(178deg, #FFD84D 0%, #FFA317 55%, #E0760A 100%); }
#race .opt.on::before { background: linear-gradient(90deg, #FFF6D8, #FFFFFF 50%, #FFF6D8); opacity: 1; }
/* **The selected label stays light.** Every word in this module is drawn with a
   near-black keyline welded to its geometry, so dark ink on a gold plate is a
   dark face inside a dark outline — measured, it turned RESUME into a smudge.
   A white face against the same keyline is the most legible thing on the
   screen, gold plate or not. */
#race .opt.on .word { color: #FFF8F0; }
#race .opt.dim { opacity: .38; }

/* The selected option carries the game's own chevron, pointing at itself. */
#race .opt .mark {
  width: calc(var(--u) * .8); height: calc(var(--u) * 1.1);
  background: #2A1503; opacity: 0;
  clip-path: polygon(0 0, 62% 50%, 0 100%, 22% 50%);
  filter: drop-shadow(0 0 calc(var(--u) * .12) rgba(255,244,210,.9));
}
#race .opt.on .mark { opacity: 1; }

#race .hint {
  display: flex; align-items: center; gap: calc(var(--u) * .55);
  opacity: .62; margin-top: calc(var(--u) * .55);
}
#race .hint .word { height: calc(var(--u) * .92); color: #CBD4E4; }
`;

export interface MenuOption {
  id: string;
  label: string;
  /** A disabled option is drawn but never selectable. */
  enabled?: boolean;
}

export interface Menu {
  readonly root: HTMLElement;
  set(options: MenuOption[], initial?: number): void;
  /** Move the cursor by `dir` over the enabled options, wrapping. */
  move(dir: number): void;
  /** Point the cursor at an index outright. Ignores disabled options. */
  focus(index: number): void;
  /** The id under the cursor, or null when the row is empty. */
  current(): string | null;
  index(): number;
  /** Fire the current option's press animation and hand back its id. */
  press(): string | null;
  update(dt: number): void;
  reset(): void;
  dispose(): void;
}

export function createMenu(onPick: (id: string) => void): Menu {
  const root = fromHtml('<div class="opts"></div>');

  interface Cell {
    el: HTMLElement;
    box: Bound;
    option: MenuOption;
  }

  let cells: Cell[] = [];
  let cursor = 0;
  /** Punch on the selected plate, and the flash on a press. */
  let pulse = 0;
  let punch = 0;

  function selectable(i: number): boolean {
    return !!cells[i] && cells[i]!.option.enabled !== false;
  }

  function paint(): void {
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      c.box.cls('on', i === cursor);
      c.box.cls('dim', c.option.enabled === false);
    }
  }

  const api: Menu = {
    root,

    set(options, initial = 0): void {
      for (const c of cells) c.el.remove();
      cells = options.map((option) => {
        const el = fromHtml(`<div class="opt"><div class="mark"></div><div class="word"></div></div>`);
        signBox(q(el, '.word'), option.label);
        root.appendChild(el);
        return { el, box: bind(el), option };
      });
      cursor = 0;
      api.focus(initial);
      // Pointer support. A click both moves the cursor and commits, which is
      // what a person reaching for the mouse expects; hovering only moves it.
      cells.forEach((c, i) => {
        c.el.addEventListener('pointerenter', () => api.focus(i));
        c.el.addEventListener('click', () => {
          api.focus(i);
          const id = api.press();
          if (id) onPick(id);
        });
      });
      pulse = 0;
      paint();
    },

    move(dir): void {
      if (!cells.length) return;
      const step = dir < 0 ? -1 : 1;
      for (let n = 0; n < cells.length; n++) {
        const next = (cursor + step * (n + 1) + cells.length * (n + 2)) % cells.length;
        if (selectable(next)) { cursor = next; pulse = 1; paint(); return; }
      }
    },

    focus(index): void {
      if (!cells.length) return;
      const i = Math.max(0, Math.min(cells.length - 1, index));
      if (!selectable(i) || i === cursor) return;
      cursor = i;
      pulse = 1;
      paint();
    },

    current(): string | null {
      return cells[cursor]?.option.id ?? null;
    },

    index(): number {
      return cursor;
    },

    press(): string | null {
      if (!selectable(cursor)) return null;
      punch = 1;
      return cells[cursor]!.option.id;
    },

    update(dt): void {
      if (pulse > 0) pulse = Math.max(0, pulse - dt * 3.4);
      if (punch > 0) punch = Math.max(0, punch - dt * 3.8);
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i]!;
        if (i === cursor) {
          // A settle on arrival, and a hit on commit. The selected plate is
          // never quite static — it is the one thing on a stopped screen that
          // still says the game is listening.
          const settle = ease.outBack(clamp01(1 - pulse)) - 1;
          const hit = punch * punch;
          const s = 1 + settle * 0.06 + hit * 0.14;
          c.box.set('transform', `translateY(${(-hit * 6).toFixed(2)}%) scale(${s.toFixed(4)})`);
        } else {
          c.box.set('transform', 'none');
        }
      }
    },

    reset(): void {
      pulse = 0;
      punch = 0;
      cursor = 0;
      paint();
    },

    dispose(): void {
      for (const c of cells) c.el.remove();
      cells = [];
      root.remove();
    },
  };

  return api;
}

/** The "what do I press" line under a menu. Built from the same drawn face. */
export function createHint(text: string): HTMLElement {
  const el = fromHtml('<div class="hint"><div class="word"></div></div>');
  signBox(q(el, '.word'), text);
  return el;
}
