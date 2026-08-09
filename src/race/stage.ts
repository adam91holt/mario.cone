// The furniture around the race: the course card, the start lights, and the
// ticker that reads the field home.
//
// None of these are menus and none of them take input — they are the three
// moments the race needs *said out loud*.
//
//   The **card** is the ten seconds before a race in every Nintendo racer: the
//   name of the circuit, the cup it belongs to, how many laps and what class,
//   arriving with the camera sweep and gone before the lights. Without it a
//   player is dropped onto a grid with no idea what they are about to drive.
//
//   The **lights** are the start. The countdown numerals already exist in the
//   HUD, and they are a *clock* — they tell you how long is left. A light board
//   is a *state*: five bulbs filling up and then going out, which is the thing
//   a player's foot times against, and the only honest cue for a rocket start
//   window that is a quarter of a second wide.
//
//   The **ticker** is the flag. A kart racer where the other seven machines
//   quietly stop existing the moment you cross the line has thrown away its
//   own ending: the race is still happening behind you, and every one of them
//   coming home is a result landing.
//
// All three animate off integrated `dt` and nothing else — see the note in
// `results.ts`.

import { clamp01, ease } from '../core/math.ts';
import { glyphBox } from '../ui/glyphs.ts';
import { bind, fromHtml, q, rgba, type Bound } from '../ui/theme.ts';
import { signBox } from './letters.ts';

export const CSS_STAGE = `
/* ── the course card ─────────────────────────────────────────────────────── */
/* Bottom centre: the one band of the frame the HUD leaves empty, and low enough
   that the camera sweep's subject — a grid of machines — is never behind it. */
#race .card {
  position: absolute; left: 50%; bottom: 9%;
  display: flex; flex-direction: column; align-items: flex-start;
  gap: calc(var(--u) * .18);
  padding: calc(var(--u) * .55) calc(var(--u) * 2.2) calc(var(--u) * .7) calc(var(--u) * 1.5);
  transform: translateX(-50%); opacity: 0;
}
#race .card .c-top { display: flex; align-items: center; gap: calc(var(--u) * .55); }
#race .card .c-cup { height: calc(var(--u) * 1.05); color: #FFC300; }
#race .card .c-round { height: calc(var(--u) * 1.05); color: #FFC300; opacity: .85; }
#race .card .c-name { height: calc(var(--u) * 2.7); color: #FFF8F0; }
#race .card .c-meta { display: flex; align-items: flex-end; gap: calc(var(--u) * .42);
  margin-top: calc(var(--u) * .16); }
#race .card .c-meta .num { height: calc(var(--u) * 1.25); color: #FFD84D; }
#race .card .c-meta .word { height: calc(var(--u) * .95); color: #D6DEEA; }
#race .card .c-meta .dot { width: calc(var(--u) * .3); height: calc(var(--u) * .3);
  border-radius: 50%; background: #FF6B1A; margin-bottom: calc(var(--u) * .28); }

/* ── the start lights ────────────────────────────────────────────────────── */
/* Between the item socket and the countdown numeral — the one clear strip of
   sky in the middle of the frame on a start grid. */
#race .lights {
  position: absolute; left: 50%; top: 21%;
  transform: translateX(-50%); opacity: 0;
}
#race .lights .board {
  display: flex; align-items: center; gap: calc(var(--u) * .62);
  padding: calc(var(--u) * .55) calc(var(--u) * 1.6) calc(var(--u) * .6);
}
#race .lights .board::after { content: none; }
#race .lights i {
  display: block; width: calc(var(--u) * 1.7); height: calc(var(--u) * 1.7);
  border-radius: 50%;
  background: radial-gradient(circle at 38% 32%, #3A404E, #14171F 70%);
  box-shadow: inset 0 0 0 calc(var(--u) * .12) rgba(6,8,12,.9),
              inset 0 calc(var(--u) * .1) calc(var(--u) * .2) rgba(255,255,255,.12);
}
#race .lights i.on {
  background: radial-gradient(circle at 38% 32%, #FFEDD0, #FF3A1E 58%, #8E1405 100%);
  box-shadow: inset 0 0 0 calc(var(--u) * .1) rgba(60,6,0,.5),
              0 0 calc(var(--u) * 1.1) rgba(255,80,30,.85);
}
#race .lights i.go {
  background: radial-gradient(circle at 38% 32%, #EEFFE0, #4CFF52 55%, #0C8A1E 100%);
  box-shadow: inset 0 0 0 calc(var(--u) * .1) rgba(0,50,10,.5),
              0 0 calc(var(--u) * 1.5) rgba(90,255,110,.95);
}

/* ── the note ────────────────────────────────────────────────────────────── */
/* One line, left edge, above where the ticker will later stack. Small on
   purpose: it is a *reward*, not an instruction, and it must never compete with
   the lap banner it arrives underneath. */
#race .note {
  position: absolute; left: calc(var(--u) * 1.3); top: 24%;
  display: flex; align-items: flex-end; gap: calc(var(--u) * .5);
  padding: calc(var(--u) * .28) calc(var(--u) * .95) calc(var(--u) * .34) calc(var(--u) * .6);
  opacity: 0;
}
#race .note .lbl { height: calc(var(--u) * .85); color: #FFD84D;
  margin-bottom: calc(var(--u) * .12); }
#race .note .val { height: calc(var(--u) * 1.45); color: #FFF8F0; }

/* ── the finish ticker ───────────────────────────────────────────────────── */
#race .ticker {
  position: absolute; left: calc(var(--u) * 1.3); top: 31%;
  display: flex; flex-direction: column; gap: calc(var(--u) * .26);
}
#race .ticker .tick {
  display: flex; align-items: center; gap: calc(var(--u) * .55);
  padding: calc(var(--u) * .26) calc(var(--u) * .9) calc(var(--u) * .32) calc(var(--u) * .55);
  opacity: 0;
}
#race .ticker .tick .pl { display: flex; align-items: flex-end; gap: calc(var(--u) * .1); }
#race .ticker .tick .tp { height: calc(var(--u) * 1.35); color: #FFF8F0; }
#race .ticker .tick .ts { height: calc(var(--u) * .72); color: #FFF8F0; opacity: .8;
  margin-bottom: calc(var(--u) * .09); }
#race .ticker .tick .chip { width: calc(var(--u) * .42); height: calc(var(--u) * 1.15);
  transform: skewX(-9deg); border-radius: calc(var(--u) * .06);
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.6); }
#race .ticker .tick .tn { height: calc(var(--u) * 1.05); color: #E8EEF6; min-width: calc(var(--u) * 5.4); }
#race .ticker .tick .tg { height: calc(var(--u) * 1.05); color: #9FB0C6; margin-left: auto; }
#race .ticker .tick.you .tn { color: #FFD84D; }
#race .ticker .tick.you .tp { color: #FFD84D; }
`;

// ── the course card ────────────────────────────────────────────────────────

export interface CardInfo {
  cup: string;
  round: number;
  rounds: number;
  course: string;
  laps: number;
  engineClass: string;
}

export interface Card {
  readonly root: HTMLElement;
  show(info: CardInfo, hold: number): void;
  retire(): void;
  update(dt: number): void;
  reset(): void;
}

export function createCard(): Card {
  const root = fromHtml(`
    <div class="card plate">
      <div class="c-top"><div class="c-cup word"></div><div class="c-round num"></div></div>
      <div class="c-name word"></div>
      <div class="c-meta">
        <span class="c-laps num"></span><span class="c-lapw word"></span>
        <span class="dot"></span>
        <span class="c-class num"></span>
      </div>
    </div>
  `);
  const box = bind(root);
  const cup = signBox(q(root, '.c-cup'));
  const round = glyphBox(q(root, '.c-round'));
  const name = signBox(q(root, '.c-name'));
  const laps = glyphBox(q(root, '.c-laps'));
  const lapWord = signBox(q(root, '.c-lapw'));
  const klass = glyphBox(q(root, '.c-class'));

  let t = -1;
  let hold = 2.2;
  const IN = 0.42;
  const OUT = 0.3;

  return {
    root,

    show(info, holdFor): void {
      cup.set(info.cup);
      round.set(info.rounds > 1 ? `${info.round}/${info.rounds}` : '');
      name.set(info.course);
      laps.set(String(info.laps));
      lapWord.set(info.laps === 1 ? 'LAP' : 'LAPS');
      klass.set(info.engineClass.toUpperCase());
      hold = Math.max(0.4, holdFor);
      t = 0;
    },

    retire(): void {
      // Cut the hold short without skipping the exit, wherever it had got to.
      if (t >= 0 && t < IN + hold) t = Math.max(t, IN + hold);
    },

    reset(): void {
      t = -1;
      box.set('opacity', '0');
    },

    update(dt): void {
      if (t < 0) return;
      t += dt;
      let x = 0, alpha = 1, y = 0, scale = 1;
      if (t < IN) {
        const u = ease.outQuart(clamp01(t / IN));
        x = (u - 1) * 26;
        alpha = clamp01(t / (IN * 0.5));
        scale = 1.04 - u * 0.04;
      } else if (t < IN + hold) {
        // A slow drift right for the whole hold. A card that is perfectly still
        // for two seconds reads as a screenshot pasted over the game.
        x = (t - IN) * 0.28;
      } else {
        const u = clamp01((t - IN - hold) / OUT);
        const e = ease.inQuad(u);
        y = -e * 40;
        alpha = 1 - e;
        scale = 1 - e * 0.06;
        if (u >= 1) { t = -1; box.set('opacity', '0'); return; }
      }
      box.set('opacity', alpha.toFixed(3));
      box.set('transform',
        `translate(calc(-50% + ${x.toFixed(2)}%), ${y.toFixed(2)}%) scale(${scale.toFixed(3)})`);
    },
  };
}

// ── the start lights ───────────────────────────────────────────────────────

/** Which bulbs are lit at each beat. Symmetric, filling inward: the board is
 *  *filling up*, and the middle bulb landing is the last thing before the
 *  flag. */
const BEAT_BULBS: Record<number, number[]> = {
  3: [0, 4],
  2: [0, 1, 3, 4],
  1: [0, 1, 2, 3, 4],
};

export interface Lights {
  readonly root: HTMLElement;
  arm(): void;
  /** 3, 2, 1 — the beat currently showing. */
  beat(n: number): void;
  /** The flag. Every bulb goes green and the board retires. */
  go(): void;
  update(dt: number): void;
  reset(): void;
}

export function createLights(): Lights {
  const root = fromHtml(`
    <div class="lights">
      <div class="board plate">
        <i></i><i></i><i></i><i></i><i></i>
      </div>
    </div>
  `);
  const box = bind(root);
  const board = bind(q(root, '.board'));
  const bulbs = Array.from(root.querySelectorAll('i')).map((el) => bind(el as HTMLElement));
  /** Per-bulb time since it lit, for the flash-on punch. */
  const litAt = new Float32Array(bulbs.length).fill(-1);

  let armed = false;
  let t = 0;
  let goT = -1;
  let shown = -1;

  function setBulbs(on: number[], green: boolean): void {
    for (let i = 0; i < bulbs.length; i++) {
      const lit = on.includes(i);
      const b = bulbs[i]!;
      if (lit && litAt[i]! < 0) litAt[i] = 0;
      if (!lit) litAt[i] = -1;
      b.cls('on', lit && !green);
      b.cls('go', lit && green);
    }
  }

  return {
    root,

    arm(): void {
      armed = true;
      t = 0;
      goT = -1;
      shown = -1;
      setBulbs([], false);
    },

    beat(n): void {
      if (!armed || n === shown || n <= 0) return;
      shown = n;
      setBulbs(BEAT_BULBS[n] ?? [], false);
    },

    go(): void {
      if (!armed) return;
      goT = 0;
      shown = 0;
      setBulbs([0, 1, 2, 3, 4], true);
    },

    reset(): void {
      armed = false;
      t = 0;
      goT = -1;
      shown = -1;
      setBulbs([], false);
      box.set('opacity', '0');
    },

    update(dt): void {
      if (!armed) return;
      t += dt;
      // Drops in on its mounting when the countdown starts...
      const inU = ease.outBack(clamp01(t / 0.36));
      let alpha = clamp01(t / 0.2);
      let y = (1 - inU) * -110;
      let scale = 1;

      if (goT >= 0) {
        goT += dt;
        // ...and leaves upward the moment the flag falls, with one hard punch on
        // the frame the lights go green.
        const punch = Math.exp(-goT * 9);
        scale = 1 + punch * 0.16;
        const out = clamp01((goT - 0.35) / 0.4);
        alpha = 1 - ease.inQuad(out);
        y = -ease.inQuad(out) * 70;
        if (out >= 1) { armed = false; box.set('opacity', '0'); return; }
      }

      box.set('opacity', alpha.toFixed(3));
      box.set('transform', `translate(-50%, ${y.toFixed(2)}%) scale(${scale.toFixed(3)})`);

      // Each bulb blooms as it lights, then settles.
      for (let i = 0; i < bulbs.length; i++) {
        const at = litAt[i]!;
        if (at < 0) { bulbs[i]!.set('transform', 'none'); continue; }
        litAt[i] = at + dt;
        const k = Math.exp(-(at + dt) * 7);
        bulbs[i]!.set('transform', `scale(${(1 + k * 0.35).toFixed(3)})`);
      }
      board.set('transform', goT >= 0
        ? `translateY(${(Math.exp(-goT * 12) * -6).toFixed(2)}%)` : 'none');
    },
  };
}

// ── the note ───────────────────────────────────────────────────────────────

export interface Note {
  readonly root: HTMLElement;
  show(label: string, value: string): void;
  update(dt: number): void;
  reset(): void;
}

/**
 * A one-line aside: currently only "BEST LAP 0:41.203".
 *
 * A quick lap is the one thing a player does in a Grand Prix that nothing else
 * on screen acknowledges — the lap banner reports every split identically,
 * whether it was their fastest of the race or their worst. This says which.
 */
export function createNote(): Note {
  const root = fromHtml(`
    <div class="note plate"><span class="lbl word"></span><span class="val num"></span></div>
  `);
  const box = bind(root);
  const lbl = signBox(q(root, '.lbl'));
  const val = glyphBox(q(root, '.val'));

  let t = -1;
  const IN = 0.3;
  const HOLD = 2.2;
  const OUT = 0.28;

  return {
    root,

    show(label, value): void {
      lbl.set(label);
      val.set(value);
      t = 0;
    },

    reset(): void {
      t = -1;
      box.set('opacity', '0');
    },

    update(dt): void {
      if (t < 0) return;
      t += dt;
      let x = 0, alpha = 1;
      if (t < IN) {
        const e = ease.outBack(clamp01(t / IN));
        x = (e - 1) * 55;
        alpha = clamp01(t / (IN * 0.5));
      } else if (t < IN + HOLD) {
        x = 0;
      } else {
        const u = clamp01((t - IN - HOLD) / OUT);
        x = -ease.inQuad(u) * 55;
        alpha = 1 - u;
        if (u >= 1) { t = -1; box.set('opacity', '0'); return; }
      }
      box.set('opacity', alpha.toFixed(3));
      box.set('transform', `translateX(${x.toFixed(2)}%)`);
    },
  };
}

// ── the finish ticker ──────────────────────────────────────────────────────

export interface TickerEntry {
  place: number;
  suffix: string;
  name: string;
  gap: string;
  color: number;
  isPlayer: boolean;
}

export interface Ticker {
  readonly root: HTMLElement;
  add(entry: TickerEntry): void;
  update(dt: number): void;
  clear(): void;
}

export function createTicker(): Ticker {
  const root = fromHtml('<div class="ticker"></div>');
  interface Chip { box: Bound; el: HTMLElement; t: number }
  let chips: Chip[] = [];

  return {
    root,

    add(entry): void {
      const el = fromHtml(`
        <div class="tick plate">
          <span class="pl"><span class="tp num"></span><span class="ts num"></span></span>
          <div class="chip"></div>
          <div class="tn word"></div>
          <div class="tg num"></div>
        </div>
      `);
      glyphBox(q(el, '.tp'), String(entry.place));
      glyphBox(q(el, '.ts'), entry.suffix);
      signBox(q(el, '.tn'), entry.name);
      glyphBox(q(el, '.tg'), entry.gap);
      bind(q(el, '.chip')).set('background',
        `linear-gradient(160deg, ${rgba(entry.color, 1)}, ${rgba(entry.color, 0.55)})`);
      const b = bind(el);
      b.cls('you', entry.isPlayer);
      root.appendChild(el);
      chips.push({ box: b, el, t: 0 });
    },

    clear(): void {
      for (const c of chips) c.el.remove();
      chips = [];
    },

    update(dt): void {
      for (const c of chips) {
        c.t += dt;
        const u = clamp01(c.t / 0.34);
        const e = ease.outBack(u);
        c.box.set('opacity', clamp01(u * 2.6).toFixed(3));
        c.box.set('transform', `translateX(${((1 - e) * -60).toFixed(2)}%)`);
      }
    },
  };
}
