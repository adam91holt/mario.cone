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
import {
  bind, cursorRing, CURSOR_CHEVRON, fromHtml, hintCss, hintKey, q, type Bound,
} from '../ui/theme.ts';

export const CSS_MENU = `
#race .opts { display: flex; gap: calc(var(--u) * 1.35); align-items: stretch; }
#race .opt {
  position: relative; pointer-events: auto; cursor: pointer;
  display: flex; align-items: center;
  padding: calc(var(--u) * .52) calc(var(--u) * 1.15) calc(var(--u) * .58);
  border-radius: calc(var(--u) * .5);
  background: linear-gradient(178deg, rgba(58,65,82,.95) 0%, rgba(28,33,43,.96) 48%, rgba(15,18,25,.96) 100%);
  box-shadow:
    inset 0 calc(var(--u) * .1) 0 rgba(255,255,255,.26),
    inset 0 calc(var(--u) * -.14) 0 rgba(0,0,0,.5),
    0 0 0 calc(var(--u) * .12) rgba(9,11,15,.92),
    0 calc(var(--u) * .22) calc(var(--u) * .6) rgba(0,0,0,.55);
}
/* The header strip every plate in this game wears, so an option reads as part
   of the same instrument set as the lap counter. It carries the corner radius
   itself rather than being clipped by the plate, because the plate has to let
   the cursor out — see below. */
#race .opt::before {
  content: ''; position: absolute; left: 0; right: 0; top: 0;
  height: calc(var(--u) * .16);
  border-radius: calc(var(--u) * .5) calc(var(--u) * .5) 0 0;
  background: linear-gradient(90deg, #FFC300, #FF9A1A 60%, #FFC300); opacity: .9;
}
#race .opt .word { height: calc(var(--u) * 1.5); color: #A9B6C8; }

/* ── the cursor ──────────────────────────────────────────────────────────── */
/* **One selected-state for the whole game.** This used to be a gold-*filled*
   plate with a white label, while the front-end's cursor ninety seconds earlier
   was a gold outline *ring* around an unchanged cell. Two games' worth of "this
   one is selected".
   The ring wins, and the reason is not taste: half the cells the front-end's
   cursor sits on are pictures — a machine silhouette, a card carrying a
   painting of a circuit — and a fill obliterates them, where a ring goes round
   anything. What the fill had that the ring did not is the chevron, and that
   came along: it is the same shape, in the same place, on both sides of the
   flag now. See the cursor note in ui/theme.ts. */
/* The chosen plate is lit as well as ringed, exactly as a chosen tile is on the
   roster screen. Stated as a background rather than a "filter: brightness()",
   because a filter on this element would put the chevron hanging off its left
   edge inside the filter's own region and there is no reason to find out how
   each browser sizes that. */
#race .opt.on {
  background: linear-gradient(178deg, rgba(82,91,113,.96) 0%, rgba(44,51,66,.96) 48%, rgba(24,29,39,.96) 100%);
  box-shadow:
    inset 0 calc(var(--u) * .1) 0 rgba(255,255,255,.3),
    inset 0 calc(var(--u) * -.14) 0 rgba(0,0,0,.5),
    0 calc(var(--u) * .22) calc(var(--u) * .6) rgba(0,0,0,.55),
    ${cursorRing(0.9)};
}
#race .opt.on .word { color: #FFF8F0; }
#race .opt.dim { opacity: .38; }
/* The chevron. On a real element rather than a pseudo one, because this plate's
   own ::before is already spent on the hazard strip. */
#race .opt .mark {${CURSOR_CHEVRON}  opacity: 0; }
#race .opt.on .mark { opacity: 1; }

/* ── the prompt rail ─────────────────────────────────────────────────────── */
/* Keycaps, exactly as the front-end prints them. This was a bare 62%-opacity
   line of drawn words with no keycaps in it — and, on the results screen, with
   no mention of the Escape key that does in fact work there. */
#race .hint {
  display: flex; align-items: center; gap: calc(var(--u) * .95);
  margin-top: calc(var(--u) * .7); opacity: .92;
}
${hintCss('#race')}
`;

/**
 * How a widget in this layer makes a noise.
 *
 * **Every menu in the front-end makes a sound; every menu in the race was
 * silent.** `grep -rn 'audio.play' src/race/` returned nothing at all: the
 * countdown lights, the course card, the finish letterbox, the ticker, the
 * results sheet and this row called the mixer exactly twice, both times to set
 * the music. Moving the cursor on the class screen clicked; moving it across
 * NEXT RACE / RACE AGAIN / EXIT — on the most animated screen in the game —
 * did not.
 *
 * A function rather than the whole `GameContext`: these widgets have no
 * business reading simulation state, and the one thing they need from the
 * outside world is the ability to say *that happened*. `ctx.audio` is null
 * until the player's first gesture, so the closure is resolved per call rather
 * than captured.
 */
export type Sfx = (id: string, volume?: number, rate?: number) => void;

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

export function createMenu(onPick: (id: string) => void, sfx: Sfx): Menu {
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
        if (selectable(next)) {
          cursor = next; pulse = 1; paint();
          // The same cue, at the same volume and the same rate, as the cursor
          // on every screen in the front-end.
          sfx('ui.click', 0.55, 1.08);
          return;
        }
      }
    },

    focus(index): void {
      if (!cells.length) return;
      const i = Math.max(0, Math.min(cells.length - 1, index));
      if (!selectable(i) || i === cursor) return;
      cursor = i;
      pulse = 1;
      paint();
      sfx('ui.click', 0.55, 1.08);
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
      sfx('ui.ok', 0.95);
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

/**
 * The "what do I press" line under a menu.
 *
 * Built from `hintKey` in `ui/theme.ts` — the same builder, the same keycaps
 * and the same title-case labels the front-end's rail is made of. `keys` is a
 * list of [cap, label] pairs so a caller states only what actually does
 * something from where the player is standing.
 */
export function createHint(keys: ReadonlyArray<readonly [string, string]>): HTMLElement {
  const el = fromHtml('<div class="hint"></div>');
  el.innerHTML = keys.map(([k, label]) => hintKey(k, label)).join('');
  return el;
}
