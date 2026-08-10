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
import { glyphRun } from './glyphs.ts';
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

const SWAP = 0.3;

/**
 * How far a face travels, as a percentage of the numeral's own box.
 *
 * **This is the whole bug the last review caught, and it was a geometry
 * mistake, not a timing one.** The travel was 82%, chosen as "most of the way
 * out of frame" — but the box a percentage resolves against is the *holder*,
 * and what fills it is a `glyphs.ts` run whose viewBox carries a 14-unit pad
 * above the cap and a 13-unit extrusion plus a pad below it. The ink therefore
 * occupies about 91% of the box, so 82% of travel put the numeral 90% of its
 * own height off-centre: a six-pixel sliver of a 135-pixel digit hanging on the
 * frame edge. Photographed at the FINAL LAP crossing the position plate showed
 * the ordinal "ND" and nothing else — the single most important number on the
 * HUD, blank at the single most dramatic moment of the race.
 *
 * At 46% the *worst* frame of a swap has one face half in and one face half
 * out, which is what a mechanical counter looks like mid-click. There is no
 * frame of this animation, at any dt, in which the window holds nothing.
 */
const TRAVEL = 46;

/**
 * Both faces of the roller are **drawn numerals**, not text nodes.
 *
 * See `glyphs.ts`: a kart racer's numbers are objects with a lit face, a shaded
 * under-face and an ink keyline, and this widget exists to throw one of those
 * objects out of the frame and drop the next one in. Writing `innerHTML` here
 * costs a parse, but it happens only when the value actually changes — once a
 * lap, or once in the several seconds it takes to gain a place — while the
 * animation itself is transforms on the two spans and touches nothing.
 */
export function createRoller(root: HTMLElement): Roller {
  const prevEl = root.querySelector<HTMLElement>('.r-prev')!;
  const curEl = root.querySelector<HTMLElement>('.r-cur')!;
  const prev = bind(prevEl);
  const cur = bind(curEl);

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
      prevEl.innerHTML = glyphRun(shown);
      shown = text;
      curEl.innerHTML = glyphRun(text);
      dir = d;
      t = 0;
      prev.set('display', 'block');
    },

    reset(text: string): void {
      shown = text;
      curEl.innerHTML = glyphRun(text);
      prevEl.innerHTML = '';
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
      //
      // **Percentages of the numeral's own box, never `em`.** This travel used
      // to be `0.62em`, and not one element in the chain above it states a
      // font-size: `#hud` sets a family and nothing else, so the em resolved
      // against the document's 16px and the biggest number in the game — a
      // 135px place indicator at review resolution — was thrown *ten pixels*
      // and faded. The swap that the whole widget exists for was, measurably,
      // a dissolve. It is the same trap `readouts.ts` fell into twice and
      // called out in its own comments; the roller is where it was still live.
      // A percentage resolves against this element's own height, which is the
      // glyph height, at every resolution.
      const away = dir >= 0 ? -1 : 1;
      // The outgoing face leaves early and quickly — it is already the past by
      // the time the swap is a third done — so the two numerals are never both
      // at full strength in the same frame.
      const out = ease.outQuad(Math.min(1, t * 1.6));
      prev.set('transform',
        `translateY(${(away * out * TRAVEL).toFixed(2)}%) scale(${(1 - out * 0.26).toFixed(3)})`);
      prev.set('opacity', (1 - out).toFixed(3));

      // ...and the new one arrives from the other side with a little overshoot,
      // which is the whole difference between a value updating and a value
      // *landing*.
      //
      // It never starts from nothing: at 0.34 of opacity on the first frame it
      // is already a legible numeral behind the one leaving, so the window is
      // occupied from the first frame of the swap to the last.
      const inT = ease.outBack(Math.min(1, t * 1.35));
      cur.set('transform',
        `translateY(${(-away * (1 - inT) * TRAVEL).toFixed(2)}%) scale(${(0.78 + inT * 0.22).toFixed(3)})`);
      cur.set('opacity', Math.min(1, 0.34 + t * 4).toFixed(3));

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
