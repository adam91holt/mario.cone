// HUD.
//
// DOM overlay rather than in-scene sprites: text stays crisp at any resolution,
// layout is trivial to iterate on, and it costs no draw calls. The rule is that
// the HUD reads state and never writes it.

import { formatTime } from '../core/math.ts';
import type { GameContext, GameSystem, Racer } from '../types.ts';

const CSS = `
#hud {
  position: fixed; inset: 0; pointer-events: none; z-index: 10;
  font-family: 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif;
  color: #FFF8F0; user-select: none;
  text-shadow: 0 2px 0 rgba(0,0,0,.45), 0 0 12px rgba(0,0,0,.3);
}
#hud .corner { position: absolute; display: flex; align-items: baseline; gap: .35rem; }
#hud .tl { top: 1.4rem; left: 1.6rem; }
#hud .tr { top: 1.4rem; right: 1.6rem; }
#hud .bl { bottom: 1.4rem; left: 1.6rem; }
#hud .br { bottom: 1.4rem; right: 1.6rem; }

#hud .place { font-size: 4.6rem; font-weight: 900; line-height: .9; letter-spacing: -.04em; }
#hud .place .suffix { font-size: 1.8rem; font-weight: 800; margin-left: .1rem; }
#hud .place.p1 { color: #FFD84D; }

#hud .lap { font-size: 2.1rem; font-weight: 800; }
#hud .lap .sep { opacity: .7; margin: 0 .12rem; }
#hud .lap .total { font-size: 1.4rem; opacity: .8; }
#hud .label { font-size: .8rem; letter-spacing: .18em; opacity: .75; text-transform: uppercase; }

#hud .timer { font-size: 1.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }

#hud .speedo { font-size: 3.2rem; font-weight: 900; font-variant-numeric: tabular-nums; line-height: 1; }
#hud .speedo .unit { font-size: 1rem; font-weight: 700; opacity: .8; margin-left: .2rem; }

#hud .coins { font-size: 1.6rem; font-weight: 800; color: #FFD84D; }

#hud .centre {
  position: absolute; inset: 0; display: grid; place-items: center;
}
#hud .countdown {
  font-size: 12rem; font-weight: 900; line-height: 1;
  color: #FFF8F0; opacity: 0;
  text-shadow: 0 6px 0 rgba(0,0,0,.35), 0 0 40px rgba(255,190,60,.6);
}
#hud .countdown.go { color: #7CFF5A; }

#hud .flash {
  position: absolute; inset: 0; background: #fff; opacity: 0; mix-blend-mode: screen;
}
`;

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] ?? s[v] ?? s[0]!;
}

export function createHudSystem(ctx: GameContext): GameSystem {
  let root: HTMLDivElement | null = null;
  let placeEl: HTMLDivElement;
  let placeNum: HTMLSpanElement;
  let placeSuffix: HTMLSpanElement;
  let lapNum: HTMLSpanElement;
  let lapTotal: HTMLSpanElement;
  let timerEl: HTMLDivElement;
  let speedEl: HTMLSpanElement;
  let coinsEl: HTMLDivElement;
  let countdownEl: HTMLDivElement;

  let countdownAnim = 0;
  let countdownText = '';

  function build(): void {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    root = document.createElement('div');
    root.id = 'hud';
    root.innerHTML = `
      <div class="corner bl">
        <div>
          <div class="label">Position</div>
          <div class="place"><span class="num">1</span><span class="suffix">st</span></div>
        </div>
      </div>
      <div class="corner tl">
        <div>
          <div class="label">Lap</div>
          <div class="lap"><span class="cur">1</span><span class="sep">/</span><span class="total">3</span></div>
        </div>
      </div>
      <div class="corner tr">
        <div style="text-align:right">
          <div class="label">Time</div>
          <div class="timer">0:00.000</div>
          <div class="coins">✦ 0</div>
        </div>
      </div>
      <div class="corner br">
        <div style="text-align:right">
          <div class="speedo"><span class="v">0</span><span class="unit">km/h</span></div>
        </div>
      </div>
      <div class="centre"><div class="countdown"></div></div>
    `;
    document.body.appendChild(root);

    placeEl = root.querySelector('.place')!;
    placeNum = root.querySelector('.place .num')!;
    placeSuffix = root.querySelector('.place .suffix')!;
    lapNum = root.querySelector('.lap .cur')!;
    lapTotal = root.querySelector('.lap .total')!;
    timerEl = root.querySelector('.timer')!;
    speedEl = root.querySelector('.speedo .v')!;
    coinsEl = root.querySelector('.coins')!;
    countdownEl = root.querySelector('.countdown')!;
  }

  ctx.bus.on<{ n: number }>('race:countdown', ({ n }) => {
    countdownText = n > 0 ? String(n) : 'GO!';
    countdownAnim = 1;
    countdownEl?.classList.toggle('go', n <= 0);
  });

  return {
    name: 'hud',
    order: 100,

    init(): void {
      if (typeof document !== 'undefined') build();
    },

    update(dt: number): void {
      if (!root) return;
      const p: Racer | null = ctx.player;
      if (!p) return;

      const place = p.place;
      placeNum.textContent = String(place);
      placeSuffix.textContent = ordinal(place);
      placeEl.classList.toggle('p1', place === 1);

      lapNum.textContent = String(Math.min(Math.max(1, p.lap + 1), ctx.race.totalLaps));
      lapTotal.textContent = String(ctx.race.totalLaps);

      timerEl.textContent = formatTime(ctx.race.time);

      // m/s reads as a small unimpressive number; scale it so speed feels fast.
      speedEl.textContent = String(Math.round(Math.abs(p.speed) * 3.6));
      coinsEl.textContent = `✦ ${p.coins}`;

      if (countdownAnim > 0) {
        countdownAnim = Math.max(0, countdownAnim - dt * 1.5);
        const t = 1 - countdownAnim;
        // Punch in fast, hold, then fade — standard countdown beat.
        const scale = t < 0.25 ? 0.6 + (t / 0.25) * 0.55 : 1.15 - (t - 0.25) * 0.16;
        const opacity = t < 0.15 ? t / 0.15 : Math.max(0, 1 - (t - 0.15) / 0.85);
        countdownEl.textContent = countdownText;
        countdownEl.style.opacity = String(opacity);
        countdownEl.style.transform = `scale(${scale})`;
      } else if (countdownEl.style.opacity !== '0') {
        countdownEl.style.opacity = '0';
      }
    },

    dispose(): void {
      root?.remove();
      root = null;
    },
  };
}
