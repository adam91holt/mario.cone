// The race overlay: one DOM layer, four widgets, one stylesheet.
//
// It sits above the HUD (`z-index: 25` against the HUD's 20) because everything
// in it either precedes the race, interrupts it or replaces it. Like the HUD it
// is a DOM layer rather than in-scene geometry — crisp at any resolution, zero
// draw calls, and trivially inspectable by a reviewer who wants to know why a
// row is where it is.
//
// It inherits the HUD's vocabulary on purpose: the same `--u` viewport unit from
// `ui/theme.ts`, the same dark plate with a lit top edge, a hard black rim and a
// hazard-yellow header strip, and the same absolute rule that **nothing animates
// in CSS**. This is one product; a results screen that scales differently from
// the lap counter, or fades on a CSS transition the capture harness cannot see,
// would be a different one.

import { U_CSS } from '../ui/theme.ts';
import { CSS_LETTERS } from './letters.ts';
import { CSS_MENU } from './menu.ts';
import { CSS_RESULTS, createResults, type Results } from './results.ts';
import { CSS_PAUSE, createPauseMenu, type PauseMenu } from './pausemenu.ts';
import {
  CSS_STAGE, createCard, createFinishBeat, createLights, createNote, createTicker,
  createVerdict, createWrongWay,
  type Card, type FinishBeat, type Lights, type Note, type Ticker, type Verdict,
  type WrongWay,
} from './stage.ts';

const CSS_BASE = `
#race {
  position: fixed; inset: 0; z-index: 25; pointer-events: none;
  -webkit-user-select: none; user-select: none;
  color: #FFF8F0; -webkit-font-smoothing: antialiased;
  contain: layout style paint;
  --u: ${U_CSS};
}

/* The sign every readout in this game is printed on. Same construction as the
   one in ui/theme.ts; scoped here because that stylesheet is scoped to #hud. */
#race .plate {
  position: relative;
  border-radius: calc(var(--u) * .5);
  background: linear-gradient(178deg, rgba(60,67,84,.94) 0%, rgba(30,35,45,.95) 46%, rgba(17,20,27,.96) 100%);
  box-shadow:
    inset 0 calc(var(--u) * .1) 0 rgba(255,255,255,.28),
    inset 0 calc(var(--u) * -.14) 0 rgba(0,0,0,.5),
    0 0 0 calc(var(--u) * .12) rgba(9,11,15,.92),
    0 calc(var(--u) * .22) calc(var(--u) * .62) rgba(0,0,0,.55);
  overflow: hidden;
}
#race .plate::before {
  content: ''; position: absolute; left: 0; right: 0; top: 0;
  height: calc(var(--u) * .17);
  background: linear-gradient(90deg, #FFC300, #FF9A1A 60%, #FFC300);
  opacity: .95;
}
#race .plate::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(122deg,
    rgba(255,255,255,.045) 0 calc(var(--u) * .38),
    rgba(255,255,255,0) calc(var(--u) * .38) calc(var(--u) * .78));
}
#race .plate > * { position: relative; z-index: 1; }

/* A results row is a plate with its face on a separate layer, so the row's own
   contents can sit above the chevron texture without being inside the element
   that clips it. */
#race .row .plate-bg { position: absolute; inset: 0; }
#race .row > *:not(.plate-bg) { position: relative; }

/* Numerals come from ui/glyphs.ts; that module's sizing rule is scoped to #hud,
   so it is restated here. Both faces are sized by the box they sit in. */
#race .num { display: block; }
#race .gl {
  display: block; height: 100%; width: auto; overflow: visible;
  filter: drop-shadow(0 calc(var(--u) * .1) calc(var(--u) * .22) rgba(0,0,0,.55));
}
`;

export interface RaceOverlay {
  readonly root: HTMLElement;
  readonly card: Card;
  readonly lights: Lights;
  /** What the start was worth, when the answer is "you bogged it". */
  readonly verdict: Verdict;
  readonly note: Note;
  readonly ticker: Ticker;
  /** The two-and-a-half seconds after the player's own crossing, and the
   *  curtain that hands the frame over to the results sheet. Drawn from the
   *  *race's* clock rather than the frame's — the director owns both clocks and
   *  calls `finish.at()` itself. */
  readonly finish: FinishBeat;
  readonly wrongWay: WrongWay;
  readonly results: Results;
  readonly pause: PauseMenu;
  update(dt: number): void;
  reset(): void;
  dispose(): void;
}

/**
 * Build the overlay. Returns `null` where there is no document — a typecheck
 * run or a headless unit test — so the director can carry on being a race
 * director without one.
 */
export function createOverlay(onPick: (id: string) => void): RaceOverlay | null {
  if (typeof document === 'undefined') return null;

  const style = document.createElement('style');
  style.textContent = CSS_BASE + CSS_LETTERS + CSS_MENU + CSS_STAGE + CSS_RESULTS + CSS_PAUSE;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'race';

  const card = createCard();
  const lights = createLights();
  const verdict = createVerdict();
  const note = createNote();
  const ticker = createTicker();
  const wrongWay = createWrongWay();
  const results = createResults(onPick);
  const pause = createPauseMenu(onPick);

  root.appendChild(card.root);
  root.appendChild(lights.root);
  root.appendChild(verdict.root);
  root.appendChild(note.root);
  root.appendChild(ticker.root);
  root.appendChild(wrongWay.root);
  root.appendChild(results.root);
  root.appendChild(pause.root);
  // **Last.** The finish beat covers the interface rather than joining it: its
  // letterbox has to sit over the HUD's corners and its hand-off curtain has to
  // close over the results sheet, which is the sibling immediately above.
  const finish = createFinishBeat();
  root.appendChild(finish.root);
  document.body.appendChild(root);

  return {
    root, card, lights, verdict, note, ticker, finish, wrongWay, results, pause,

    update(dt: number): void {
      card.update(dt);
      lights.update(dt);
      verdict.update(dt);
      note.update(dt);
      ticker.update(dt);
      wrongWay.update(dt);
      results.update(dt);
      pause.update(dt);
    },

    reset(): void {
      card.reset();
      lights.reset();
      verdict.reset();
      note.reset();
      ticker.clear();
      wrongWay.reset();
      finish.reset();
      results.reset();
      pause.reset();
    },

    dispose(): void {
      results.dispose();
      pause.dispose();
      root.remove();
      style.remove();
    },
  };
}
