// A numeral that changes visibly.
//
// "Position must animate when it changes — a silent number swap is a wasted
// moment." This is that moment, factored out, because the lap counter needs the
// same treatment: the value the player was is thrown upward out of the frame
// while the value they are now drops in over it and overshoots, in the colour
// of whether the change was good news or bad.
//
// Driven from `update(dt)` rather than a CSS transition. See theme.ts — the
// capture harness renders frames with no wall clock, so a CSS animation is in a
// different place in its timeline in every screenshot ever taken of the game.

import { ease } from '../core/math.ts';
import { bind } from './theme.ts';

export interface Roller {
  readonly root: HTMLElement;
  /** Set the displayed text. `dir` -1 improved, +1 worsened, 0 neutral. */
  set(text: string, dir: number): void;
  /** True while the swap is playing — callers use it to punch the plate too. */
  readonly active: boolean;
  /** 0..1 through the current swap. */
  readonly t: number;
  update(dt: number): void;
  reset(text: string): void;
}

const SWAP = 0.34;

export function createRoller(root: HTMLElement): Roller {
  const prev = bind(root.querySelector<HTMLElement>('.r-prev')!);
  const cur = bind(root.querySelector<HTMLElement>('.r-cur')!);

  let t = 1;
  let dir = 0;
  let shown = '';

  const api: Roller = {
    root,

    get active(): boolean { return t < 1; },
    get t(): number { return t; },

    set(text: string, d: number): void {
      if (text === shown) return;
      // Mid-swap and asked to change again: whatever was on screen is what the
      // player last saw, so that is what gets thrown out. Anything else pops.
      prev.text(shown);
      shown = text;
      cur.text(text);
      dir = d;
      t = 0;
      prev.set('display', 'block');
    },

    reset(text: string): void {
      shown = text;
      cur.text(text);
      prev.text('');
      prev.set('display', 'none');
      cur.set('transform', 'none');
      cur.set('opacity', '1');
      t = 1;
      dir = 0;
    },

    update(dt: number): void {
      if (t >= 1) return;
      t = Math.min(1, t + dt / SWAP);

      // The old value leaves the way the counter is turning: a place gained
      // rolls the old number downward out of frame, a place lost throws it up.
      const away = dir >= 0 ? -1 : 1;
      const out = ease.inQuad(t);
      prev.set('transform',
        `translateY(${(away * out * 0.62).toFixed(3)}em) scale(${(1 - out * 0.26).toFixed(3)})`);
      prev.set('opacity', (1 - Math.min(1, out * 1.6)).toFixed(3));

      // ...and the new one arrives from the other side with a little overshoot,
      // which is the whole difference between a value updating and a value
      // *landing*.
      const inT = ease.outBack(Math.min(1, t * 1.18));
      cur.set('transform',
        `translateY(${(-away * (1 - inT) * 0.62).toFixed(3)}em) scale(${(0.72 + inT * 0.28).toFixed(3)})`);
      cur.set('opacity', Math.min(1, t * 3.4).toFixed(3));

      if (t >= 1) {
        cur.set('transform', 'none');
        cur.set('opacity', '1');
        prev.set('display', 'none');
      }
    },
  };

  api.reset('');
  return api;
}

/** The markup a roller expects. `cls` lands on the outer span. */
export const rollerHtml = (cls: string): string =>
  `<span class="roll ${cls}"><span class="r-prev"></span><span class="r-cur"></span></span>`;
