// Pause.
//
// The whole screen stops, so the screen has to say so — loudly enough that a
// player who hit the key by accident knows instantly, and quietly enough that
// the race behind it is still readable, because half of pausing a kart racer is
// looking at the corner you are about to take.
//
// The state itself lives in the director: pausing is a *race phase*, not a
// widget's boolean, because the karts, the item reels, the AI and the engine
// note all have to stop with it. This is only the face of it.

import { clamp01, ease } from '../core/math.ts';
import { glyphBox, ordinalWord } from '../ui/glyphs.ts';
import { bind, fromHtml, q } from '../ui/theme.ts';
import { signBox } from './letters.ts';
import { createHint, createMenu, type Menu, type MenuOption, type Sfx } from './menu.ts';

export const CSS_PAUSE = `
#race .pause { position: absolute; inset: 0; opacity: 0; display: none; }
#race .pause.live { display: block; }
#race .pause .scrim {
  position: absolute; inset: 0;
  background: radial-gradient(120% 100% at 50% 50%, rgba(8,11,17,.5), rgba(6,8,13,.86));
}
#race .pause .p-plate {
  position: absolute; left: 50%; top: 50%;
  display: flex; flex-direction: column; align-items: center;
  gap: calc(var(--u) * .55);
  padding: calc(var(--u) * 1.1) calc(var(--u) * 2.6) calc(var(--u) * 1.25);
  transform: translate(-50%, -50%);
}
#race .pause .p-title { height: calc(var(--u) * 3.1); color: #FFC300; }
#race .pause .p-state { display: flex; align-items: flex-end; gap: calc(var(--u) * .7);
  opacity: .9; margin-bottom: calc(var(--u) * .2); }
#race .pause .p-state .grp { display: flex; align-items: flex-end; gap: calc(var(--u) * .26); }
#race .pause .p-state .num { height: calc(var(--u) * 1.3); color: #E8EEF6; }
#race .pause .p-state .poss { height: calc(var(--u) * .8); margin-bottom: calc(var(--u) * .08); }
#race .pause .p-state .word { height: calc(var(--u) * .95); color: #9FB0C6;
  margin-bottom: calc(var(--u) * .1); }
#race .pause .p-state .dot { width: calc(var(--u) * .26); height: calc(var(--u) * .26);
  border-radius: 50%; background: #FF6B1A; margin-bottom: calc(var(--u) * .34); }
#race .pause .acts { display: flex; flex-direction: column; align-items: center; }
`;

export interface PauseState {
  lap: number;
  totalLaps: number;
  place: number;
}

export interface PauseMenu {
  readonly root: HTMLElement;
  show(options: MenuOption[], state: PauseState): void;
  hide(): void;
  readonly visible: boolean;
  menu: Menu;
  update(dt: number): void;
  reset(): void;
  dispose(): void;
}

export function createPauseMenu(onPick: (id: string) => void, sfx: Sfx): PauseMenu {
  const root = fromHtml(`
    <div class="pause">
      <div class="scrim"></div>
      <div class="p-plate plate">
        <div class="p-title word"></div>
        <div class="p-state">
          <span class="grp"><span class="lapw word"></span><span class="lapn num"></span></span>
          <span class="dot"></span>
          <span class="grp"><span class="posn num"></span><span class="poss num"></span></span>
        </div>
        <div class="acts"></div>
      </div>
    </div>
  `);

  const box = bind(root);
  const scrim = bind(q(root, '.scrim'));
  const plate = bind(q(root, '.p-plate'));
  signBox(q(root, '.p-title'), 'PAUSED');
  signBox(q(root, '.lapw'), 'LAP');
  const lapNum = glyphBox(q(root, '.lapn'));
  const posNum = glyphBox(q(root, '.posn'));
  const posSuf = glyphBox(q(root, '.poss'));

  const menu = createMenu(onPick, sfx);
  q(root, '.acts').appendChild(menu.root);
  q(root, '.acts').appendChild(createHint([['\u25C0 \u25B6', 'Choose'], ['\u21B5', 'Select'], ['Esc', 'Resume']]));

  let t = -1;
  let live = false;

  const api: PauseMenu = {
    root,
    menu,

    get visible(): boolean { return live; },

    show(options, state): void {
      lapNum.set(`${Math.max(1, Math.min(state.lap, state.totalLaps))}/${state.totalLaps}`);
      posNum.set(String(state.place));
      posSuf.set(ordinalWord(state.place));
      menu.set(options, 0);
      t = 0;
      live = true;
      box.cls('live', true);
    },

    hide(): void {
      live = false;
      t = -1;
      box.cls('live', false);
      box.set('opacity', '0');
    },

    update(dt): void {
      if (!live || t < 0) return;
      t += dt;
      const u = clamp01(t / 0.22);
      box.set('opacity', u.toFixed(3));
      scrim.set('opacity', ease.outQuad(u).toFixed(3));
      const s = 0.9 + ease.outBack(clamp01(t / 0.3)) * 0.1;
      plate.set('transform', `translate(-50%, -50%) scale(${s.toFixed(4)})`);
      menu.update(dt);
    },

    reset(): void {
      api.hide();
      menu.reset();
    },

    dispose(): void {
      menu.dispose();
      root.remove();
    },
  };

  return api;
}
