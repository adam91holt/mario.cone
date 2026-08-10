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

import { config } from '../core/config.ts';
import { clamp01, ease } from '../core/math.ts';
import { glyphBox } from '../ui/glyphs.ts';
import {
  bind, curtainCss, curtainTransform, CURTAIN_IN, CURTAIN_OUT, fromHtml, hazardCss,
  q, rgba, type Bound,
} from '../ui/theme.ts';
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
/* Above the countdown numeral, in what is now an empty top third of the frame.
   The vertical budget on a start grid:

     top of frame  ..  1.05u   the HUD's own edge inset
     1.05u .. 7.85u            the item socket — **stood down until the flag**
     ~21%  .. ~27%             the banner band — "ROCKET START" lands here
     35%   ..                  the countdown numeral, 14.2u tall

   16.5% clears the socket at every aspect the unit supports and still leaves
   the banner band free, and the board is 2.4u tall rather than 2.85u so that
   clearance is real at both ends. That was a *near miss*, though, not a
   composition: photographed at 1600x900 the board's lit top edge sat about
   fifteen pixels under the socket's rim and the two read as one two-storey
   widget — and then disagreed with each other about the corner radius, the
   yellow and the face, because one is a sign and the other is a recess.

   The socket now waits for the flag ("slotIn" in ui/hud.ts) and this board has
   the top of the frame to itself for the one moment it exists. It is a plate,
   whole: it used to cancel the chevron texture every other plate in the game
   wears, which was the last thing making it a different object from its
   neighbours.

   **Above the banner band, not on it.** This used to sit at 21%, which is the
   exact line the HUD prints its interrupt banners on, and the race overlay is
   the layer above the HUD: the frame the flag falls on is also the frame the
   HUD slams "ROCKET START" onto the screen, and the board — still lit, still
   green — covered its middle. Photographed, the payoff of the one mechanic in
   the countdown read "R...KET ST...T". The board now clears that band, and it
   leaves faster than the banner arrives (see go()). */
#race .lights {
  position: absolute; left: 50%; top: 16.5%;
  transform: translateX(-50%); opacity: 0;
}
#race .lights .board {
  display: flex; align-items: center; gap: calc(var(--u) * .56);
  padding: calc(var(--u) * .44) calc(var(--u) * 1.35) calc(var(--u) * .48);
}
#race .lights i {
  display: block; width: calc(var(--u) * 1.5); height: calc(var(--u) * 1.5);
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

/* ── the start verdict ───────────────────────────────────────────────────── */
/* The other half of the rocket start, and until now the silent half: the flag
   falls, the engine bogs, and the only thing that happened on screen was a red
   outline pulse lasting a fraction of the penalty. This lands on the banner
   line — the same strip of frame a good start's "ROCKET START" lands on, so the
   two possible answers to "what was my start worth" arrive in one place — and it
   holds for as long as the machine is actually stuck. */
/* Sized against the thing it is the opposite of. The good answer is the HUD's
   own gold banner, whose word is 1.9u of cap height on a plate 2.6u wide at the
   ends; a 2.35u headline with a 0.92u footnote under it read, photographed
   beside it, as the smaller of the two — the reward shouting and the penalty
   muttering. Both answers to "what was my start worth" are now the same size. */
#race .verdict {
  position: absolute; left: 50%; top: 21%;
  display: flex; flex-direction: column; align-items: center;
  gap: calc(var(--u) * .1);
  padding: calc(var(--u) * .48) calc(var(--u) * 2.5) calc(var(--u) * .58);
  transform: translateX(-50%); opacity: 0;
}
/* Smoke and hot metal: a dark, sooty plate with a hazard-red top edge, against
   the gold the reward wears. */
#race .verdict.plate {
  background: linear-gradient(178deg, rgba(70,44,34,.95) 0%, rgba(36,22,18,.96) 50%, rgba(16,10,9,.97) 100%);
}
#race .verdict.plate::before { background: linear-gradient(90deg, #FF3A1E, #FF8A2B 50%, #FF3A1E); }
#race .verdict .big {
  height: calc(var(--u) * 2.9); color: #FFB07A;
  filter: drop-shadow(0 0 calc(var(--u) * .55) rgba(255,90,30,.55));
}
#race .verdict .sub { height: calc(var(--u) * 1.05); color: #D8B4A4; opacity: .95; }
/* The quiet half of the same mechanic. Being *a bit* early costs nothing and
   must not be dressed as a catastrophe — but it used to be dressed as nothing
   at all, so a whole second of the countdown meant a start the player could
   neither win nor lose and was never told about. Steel rather than soot, and
   two thirds the size of the answer that actually bites. */
#race .verdict.mild.plate {
  background: linear-gradient(178deg, rgba(50,60,78,.94) 0%, rgba(26,32,43,.95) 52%, rgba(14,17,24,.96) 100%);
}
#race .verdict.mild.plate::before { background: linear-gradient(90deg, #7E93B4, #B7C6DC 50%, #7E93B4); }
#race .verdict.mild .big { height: calc(var(--u) * 1.9); color: #D3DEEE; filter: none; }
#race .verdict.mild .sub { height: calc(var(--u) * .9); color: #93A4BC; }

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

/* ── the wrong way ───────────────────────────────────────────────────────── */
/* Dead centre and unmissable. It is the one readout in the game that exists to
   be *obeyed*, and it is only ever on screen while the player is doing the one
   thing the circuit cannot forgive, so nothing it covers matters. */
#race .wrong {
  position: absolute; left: 50%; top: 44%;
  display: flex; align-items: center; gap: calc(var(--u) * .9);
  padding: calc(var(--u) * .5) calc(var(--u) * 1.5) calc(var(--u) * .58);
  transform: translate(-50%, -50%); opacity: 0;
}
#race .wrong.plate {
  background: linear-gradient(178deg, rgba(88,26,20,.95) 0%, rgba(46,14,12,.96) 52%, rgba(20,7,6,.97) 100%);
}
#race .wrong.plate::before { background: linear-gradient(90deg, #FF3A1E, #FFC300 50%, #FF3A1E); }
/* A U-turn, not a left arrow. "That way" is not the instruction — "turn round"
   is, and an arrow pointing at the barrier on your left says the first one. */
#race .wrong .arrow { display: block; height: calc(var(--u) * 2.5); width: calc(var(--u) * 2.9);
  filter: drop-shadow(0 calc(var(--u) * .08) calc(var(--u) * .2) rgba(0,0,0,.7)); }
#race .wrong .arrow .stem { fill: none; stroke: #FF4B3A; stroke-width: 16;
  stroke-linecap: round; }
#race .wrong .arrow .head { fill: #FF4B3A; }
#race .wrong .big { height: calc(var(--u) * 2.3); color: #FFF8F0;
  filter: drop-shadow(0 0 calc(var(--u) * .5) rgba(255,60,30,.6)); }

/* ── the finish beat ─────────────────────────────────────────────────────── */
/* The last child of #race, so it paints over the whole interface: the in-race
   HUD is a layer below this one, and the results sheet is an earlier sibling.
   That ordering is the point — this layer's job is to *cover* things, not to
   sit beside them.

   It was briefly its own root outside #race, so that its wash could carry a
   backdrop-filter (a "contain: paint" ancestor is a backdrop root, and a filter
   under one samples an empty layer). The filter is gone — see the wash — and
   with it the reason for a second full-screen compositing layer. */
#racefin {
  position: absolute; inset: 0; pointer-events: none;
}
/* The letterbox. A kart racer's finish is the one moment the game takes the
   frame off the player, and bars arriving is how that is said without a word. */
#racefin .bar {
  position: absolute; left: 0; right: 0; height: 9%;
  background: linear-gradient(180deg, #04060A, #0A0E15);
  transform: translateY(-101%);
}
#racefin .bar.t { top: 0; }
#racefin .bar.b { bottom: 0; }
#racefin .bar::after {
  content: ''; position: absolute; left: 0; right: 0;
  height: calc(var(--u) * .16);
  background: ${hazardCss(0.786)};
  opacity: .9;
}
#racefin .bar.t::after { bottom: 0; }
#racefin .bar.b::after { top: 0; }

/* The two possible endings, said in colour before they are said in a word.
   **Paint, not a filter.** The honest way to drain a frame is a backdrop-filter,
   and it was tried: a full-screen "saturate(.26)" under this project's software
   renderer took a single frame past thirty seconds. A radial wash costs one
   composited quad, reads identically in a still, and cannot fall off a
   performance cliff on somebody's laptop. */
#racefin .wash { position: absolute; inset: 0; opacity: 0; }
#racefin .wash.gold {
  background:
    radial-gradient(52% 48% at 50% 50%, rgba(255,226,130,.34), rgba(255,132,32,.18) 44%, rgba(0,0,0,0) 72%),
    radial-gradient(98% 92% at 50% 50%, rgba(0,0,0,0) 36%, rgba(104,48,2,.60) 100%);
}
/* Off the podium the colour goes out of the frame. The confetti is still there
   — it belongs to the field, not to the player — but the picture it lands in is
   cold, dark and closing in, and no still of it can be mistaken for a win. */
/* A *grey* over the frame, not a black one. Blending a picture toward a mid
   grey is what desaturation is; blending it toward black only turns the lights
   down and leaves every colour in it as saturated as it was. The difference is
   the whole point here — the confetti belongs to the race and goes on falling,
   and it has to look like weather rather than like a party. */
#racefin .wash.grey {
  background:
    radial-gradient(74% 68% at 50% 53%,
      rgba(64,70,82,.56) 0%, rgba(28,32,41,.74) 58%, rgba(5,7,11,.93) 100%);
}
/* One band of light crossing the frame on the crossing itself. */
#racefin .sweep {
  position: absolute; top: -20%; bottom: -20%; left: 0; width: 46%;
  opacity: 0; transform: translateX(-140%) skewX(-14deg);
  background: linear-gradient(90deg,
    rgba(255,248,240,0), rgba(255,248,240,.30) 46%, rgba(255,216,77,.42) 62%, rgba(255,248,240,0));
}
#racefin.grey .sweep {
  background: linear-gradient(90deg,
    rgba(190,205,225,0), rgba(190,205,225,.16) 50%, rgba(150,165,190,.20) 64%, rgba(190,205,225,0));
}

/* ── the hand-off ────────────────────────────────────────────────────────── */
/* Two blades that close over the whole frame and open again on the results
   sheet. Not decoration: it is the only way three live layers — the in-race
   HUD, the flag's own furniture and an arriving results table — can be swapped
   without a second of all three being legible at once. Nothing gets torn down
   in front of the player; it gets torn down behind a curtain.

   **The same curtain the front-end swings to start a race.** It was not: this
   one was 62% wide hung at x=0, and the front-end's was 78% hung 10% outside
   the frame in edge-to-edge orange stripe at roughly twice the duration. Two
   builds of one gesture, ninety seconds apart. The geometry, the paint and the
   two travel times now come from "ui/theme.ts" and only the hold below is this
   caller's own — see the curtain note there, including why 62% at x=0 leaves a
   wedge of bare screen in one corner at the moment the curtain is shut. */
${curtainCss('#racefin', '.blade')}
#racefin .blade { opacity: 0; }
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

/**
 * Which bulbs are lit at each beat.
 *
 * `config.race.startLights`, not a table of this module's own: the gantry hangs
 * a five-bulb board of its own over the grid two hundred pixels below this one,
 * and two boards counting the same race in must count it the same way.
 */
const BEAT_BULBS = config.race.startLights;

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

  function setBulbs(on: readonly number[], green: boolean): void {
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
        //
        // **Quickly.** The board has said everything it has to say by the time
        // the green has registered, and the screen it is standing on belongs, on
        // that same frame, to the start's own verdict — the banner, or the
        // burnout. 0.1s of green and a 0.24s exit clears the frame inside a
        // third of a second while still landing the punch.
        const punch = Math.exp(-goT * 9);
        scale = 1 + punch * 0.16;
        const out = clamp01((goT - 0.1) / 0.24);
        alpha = 1 - ease.inQuad(out);
        y = -ease.inQuad(out) * 80;
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

// ── the start verdict ──────────────────────────────────────────────────────

export interface Verdict {
  readonly root: HTMLElement;
  /** One loud line, plus a quiet one under it. `mild` is the steel treatment —
   *  a start that was early enough to cost the boost but not the race. */
  show(big: string, sub?: string, tone?: 'bad' | 'mild'): void;
  update(dt: number): void;
  reset(): void;
}

/**
 * What the player's start was worth, when the answer is bad.
 *
 * The good answer already has a home — the HUD slams a gold ROCKET START banner
 * on the same line — and the bad one had nothing but a red outline flash on the
 * item socket, over in a fraction of a second, while the penalty ran for a
 * second and a quarter. A player cannot learn a mechanic whose failure state is
 * invisible; they just conclude the game ate their race.
 *
 * So: a plate that arrives with a hard slam and *shakes* while it holds, because
 * a bogged engine is a machine sitting there vibrating, and the motion is the
 * part that reads at a glance.
 */
export function createVerdict(): Verdict {
  const root = fromHtml(`
    <div class="verdict plate">
      <div class="big word"></div>
      <div class="sub word"></div>
    </div>
  `);
  const box = bind(root);
  const big = signBox(q(root, '.big'));
  const sub = signBox(q(root, '.sub'));

  let t = -1;
  let mild = false;
  const IN = 0.16;
  const OUT = 0.3;

  return {
    root,

    show(text, subText = '', tone = 'bad'): void {
      big.set(text);
      sub.set(subText);
      mild = tone === 'mild';
      box.cls('mild', mild);
      t = 0;
    },

    reset(): void {
      t = -1;
      mild = false;
      box.cls('mild', false);
      box.set('opacity', '0');
    },

    update(dt): void {
      if (t < 0) return;
      // A bogged engine is stuck for as long as the penalty runs; a jumped start
      // is one line of information and then out of the way.
      const HOLD = mild ? 0.85 : 1.25;
      t += dt;
      let alpha = 1, scale = 1, x = 0, y = 0;
      if (t < IN) {
        // Down and in, overshooting — the same slam the HUD's own alert banner
        // uses, so the two read as one interface.
        const u = ease.outBack(clamp01(t / IN));
        scale = 0.72 + u * 0.28;
        alpha = clamp01(t / (IN * 0.45));
        y = (1 - u) * -40;
      } else if (t < IN + HOLD) {
        // The shudder. Two detuned frequencies so it never looks like a loop,
        // decaying as the engine picks itself up. Nothing is shaking on a mild
        // verdict — the machine is fine, the timing was not.
        const u = (t - IN) / HOLD;
        const k = mild ? 0 : (1 - u) * (1 - u);
        x = Math.sin((t) * 41) * 1.7 * k;
        y = Math.sin((t) * 29 + 1.1) * 1.3 * k;
        scale = 1 + Math.sin(t * 37) * 0.012 * k;
      } else {
        const u = clamp01((t - IN - HOLD) / OUT);
        const e = ease.inQuad(u);
        alpha = 1 - e;
        y = e * 26;
        scale = 1 - e * 0.08;
        if (u >= 1) { t = -1; box.set('opacity', '0'); return; }
      }
      box.set('opacity', alpha.toFixed(3));
      box.set('transform',
        `translate(calc(-50% + ${x.toFixed(2)}%), ${y.toFixed(2)}%) scale(${scale.toFixed(3)})`);
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
  /** Fade the read-out off screen rather than deleting it mid-frame. Used by the
   *  hand-off: the lines have to be *gone* before the results sheet exists, not
   *  sharing the frame with it. */
  retire(): void;
  update(dt: number): void;
  clear(): void;
}

/** Seconds between two lines of a *batch*. Anything arriving on its own — a CPU
 *  crossing the line behind the player — is already spaced by the race. */
const TICK_GAP = 0.17;
/** Seconds a retiring ticker takes to leave. Shorter than the hand-off curtain
 *  takes to close, so the lines are gone before anything can see them go. */
const TICK_OUT = 0.2;

export function createTicker(): Ticker {
  const root = fromHtml('<div class="ticker"></div>');
  interface Chip { box: Bound; el: HTMLElement; t: number }
  let chips: Chip[] = [];
  /**
   * Lines waiting their turn.
   *
   * A player who takes the flag in seventh has six results *already decided*,
   * and `beginFlag` hands all six over in one call — so the whole order landed
   * on a single frame as one block of plates, which is a table appearing, not a
   * field being read home. They are released one at a time instead. The gap is
   * short enough that a full field is in within a second and a half — well
   * inside the two seconds the flag holds before the sheet is allowed to start
   * — and long enough that each line is its own event.
   */
  let queue: TickerEntry[] = [];
  let gap = 0;
  /** Seconds into the fade-out. Negative while the read-out is live. */
  let outT = -1;

  function mount(entry: TickerEntry): void {
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
  }

  return {
    root,

    add(entry): void {
      if (outT >= 0) return;
      // Straight on if nothing is waiting and nothing landed a moment ago;
      // otherwise it takes its place in the queue.
      if (gap <= 0 && !queue.length) { mount(entry); gap = TICK_GAP; return; }
      queue.push(entry);
    },

    retire(): void {
      if (outT >= 0 || !chips.length) { queue = []; return; }
      queue = [];
      outT = 0;
    },

    clear(): void {
      for (const c of chips) c.el.remove();
      chips = [];
      queue = [];
      gap = 0;
      outT = -1;
    },

    update(dt): void {
      if (outT >= 0) {
        outT += dt;
        const u = clamp01(outT / TICK_OUT);
        const e = ease.inQuad(u);
        for (const c of chips) {
          c.box.set('opacity', (1 - u).toFixed(3));
          c.box.set('transform', `translateX(${(e * -70).toFixed(2)}%)`);
        }
        if (u >= 1) {
          for (const c of chips) c.el.remove();
          chips = [];
          outT = -1;
        }
        return;
      }
      if (gap > 0) gap = Math.max(0, gap - dt);
      if (gap <= 0 && queue.length) { mount(queue.shift()!); gap = TICK_GAP; }
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

// ── the wrong way ──────────────────────────────────────────────────────────

export interface WrongWay {
  readonly root: HTMLElement;
  set(on: boolean): void;
  update(dt: number): void;
  reset(): void;
}

/**
 * The circuit's one non-negotiable instruction.
 *
 * A racer can leave the road, hit a wall, spin, stall — every one of those the
 * game already says something about. Turning round and driving at the field was
 * the single mistake it stayed silent on, and silence there is not neutral: a
 * player who cannot tell they are going the wrong way concludes the track is
 * broken. So it arrives hard, it strobes for as long as the mistake lasts, and
 * it leaves the instant the machine is pointing the right way again.
 */
export function createWrongWay(): WrongWay {
  const root = fromHtml(`
    <div class="wrong plate">
      <svg class="arrow" viewBox="0 0 120 104" aria-hidden="true">
        <path class="stem" d="M98 96L98 44A30 30 0 0 0 38 44L38 62"/>
        <path class="head" d="M8 56L38 98L68 56Z"/>
      </svg>
      <div class="big word"></div>
    </div>
  `);
  const box = bind(root);
  signBox(q(root, '.big'), 'WRONG WAY');

  let on = false;
  /** Rises to 1 while the warning is up, falls to 0 when it is not. */
  let amt = 0;
  let t = 0;

  return {
    root,

    set(next): void {
      if (next === on) return;
      on = next;
      if (on) t = 0;
    },

    reset(): void {
      on = false;
      amt = 0;
      t = 0;
      box.set('opacity', '0');
    },

    update(dt): void {
      if (!on && amt <= 0) return;
      t += dt;
      amt = on ? Math.min(1, amt + dt / 0.12) : Math.max(0, amt - dt / 0.18);
      // Two beats a second, square-ish rather than sinusoidal — an alarm, not a
      // breath. The plate itself never fully leaves while the warning is up, so
      // the words stay readable through the flash.
      const flash = 0.62 + 0.38 * (Math.sin(t * 11) > -0.2 ? 1 : 0);
      const pop = ease.outBack(clamp01(t / 0.16));
      box.set('opacity', (amt * flash).toFixed(3));
      box.set('transform',
        `translate(-50%, -50%) scale(${(0.76 + 0.24 * pop * amt + (1 - amt) * 0.0).toFixed(3)})`);
      if (!on && amt <= 0) box.set('opacity', '0');
    },
  };
}

// ── the finish beat ────────────────────────────────────────────────────────

export interface FinishBeat {
  readonly root: HTMLElement;
  /** Which of the two endings this beat is. Called once, on the crossing. */
  arm(place: number, podium: boolean): void;
  /**
   * Draw the beat, and the hand-off curtain, at the given clocks. Negative
   * means "not running".
   *
   * **Both clocks are the race's, not the frame's.** Every other widget in this
   * overlay integrates the render delta, which is right for furniture: it should
   * animate at the same rate whatever the simulation is doing. This one is the
   * opposite case twice over. It is a *beat of the race* — its length is stated
   * in the same seconds as the flag hold that follows it — and it plays over a
   * slow-motion ramp, so a beat measured in real time would run at normal speed
   * through a frame that had visibly stopped. Driven by the simulation clock it
   * stretches with the slow-motion exactly as it should, it survives a pause,
   * and it lands on the same frame in every capture of the same race.
   */
  at(beat: number, wipe: number): void;
  reset(): void;
}

/**
 * The beat's *colour*: in, hold, out. 2.55s of race time — the window the
 * director keeps for itself after the player's own crossing.
 *
 * **The letterbox is not on this clock.** It used to be, and that is what left
 * the game with nothing on the screen at all between the flag and the results
 * sheet: the bars retracted at 2.55s, the HUD had already retired, and the
 * sheet was still several seconds away, so a player who had just *won* was
 * shown a motionless kart in a ditch with one orphaned ticker plate at the edge
 * of the frame for up to fourteen seconds. Three modules each ended cleanly and
 * nobody owned the join.
 *
 * So the wash and the sweep run on this clock and the bars do not: they close
 * once and stay closed until the hand-off curtain takes the frame off them. The
 * gap between the beat and the sheet is now a held, letterboxed frame with the
 * finish lens orbiting the machine and the ticker landing a plate for each
 * racer as they come home — which is what the gap was always for.
 */
export const FIN_IN = 0.2;
export const FIN_HOLD = 1.9;
export const FIN_OUT = 0.45;
export const FIN_TOTAL = FIN_IN + FIN_HOLD + FIN_OUT;
/** The hand-off curtain. The two travel times are the game's, shared with the
 *  front-end's launch board; the hold is this caller's, and is only as long as
 *  it takes to tear three layers down behind a covered frame. */
const WIPE_IN = CURTAIN_IN;
const WIPE_HOLD = 0.2;
const WIPE_OUT = CURTAIN_OUT;
export const WIPE_COVERED = WIPE_IN;
export const WIPE_TOTAL = WIPE_IN + WIPE_HOLD + WIPE_OUT;

/**
 * The two-and-a-half seconds after the player's own line crossing.
 *
 * Everything here is *frame-level*: bars, a wash and a sweep of light. It says
 * nothing in words — the place and the time are the HUD's banner to print, and
 * two modules announcing the same result is how a finish ends up with two
 * plates fighting over the middle of the screen.
 *
 * What it does say, and says before any number is legible, is **which of the
 * two endings this was**. A podium warms and saturates the frame and takes a
 * gold sweep across it. Fourth or worse drains the colour out of the whole
 * picture — the confetti included, because that burst belongs to the race and
 * not to the player — and closes a cold vignette in. A still frame from either
 * one is unmistakably not the other, which is the entire complaint this widget
 * exists to answer.
 *
 * It lives on its own root above the HUD rather than inside the race overlay,
 * for two reasons: it has to cover the in-race furniture rather than sit beside
 * it, and a backdrop-filter under a `contain: paint` ancestor filters nothing.
 */
export function createFinishBeat(): FinishBeat {
  const root = fromHtml(`
    <div id="racefin">
      <div class="wash"></div>
      <div class="sweep"></div>
      <div class="bar t"></div>
      <div class="bar b"></div>
      <div class="blade l"></div>
      <div class="blade r"></div>
    </div>
  `);
  const box = bind(root);
  const wash = bind(q(root, '.wash'));
  const sweep = bind(q(root, '.sweep'));
  const barT = bind(q(root, '.bar.t'));
  const barB = bind(q(root, '.bar.b'));
  const bladeL = bind(q(root, '.blade.l'));
  const bladeR = bind(q(root, '.blade.r'));

  let podium = true;
  let clear = true;

  function bars(v: number): void {
    // v is 0 (clear) .. 1 (closed).
    const y = (1 - v) * -101;
    barT.set('transform', `translateY(${y.toFixed(2)}%)`);
    barB.set('transform', `translateY(${(-y).toFixed(2)}%)`);
  }

  function clearBeat(): void {
    if (clear) return;
    clear = true;
    bars(0);
    wash.set('opacity', '0');
    sweep.set('opacity', '0');
  }

  const api: FinishBeat = {
    root,

    arm(_place, isPodium): void {
      podium = isPodium;
      clear = false;
      box.cls('grey', !isPodium);
      wash.cls('gold', isPodium);
      wash.cls('grey', !isPodium);
    },

    reset(): void {
      clear = false;
      clearBeat();
      bladeL.set('opacity', '0');
      bladeR.set('opacity', '0');
      bladeL.set('transform', curtainTransform(0, -1));
      bladeR.set('transform', curtainTransform(0, 1));
      box.cls('grey', false);
    },

    at(t, wipeT): void {
      if (t < 0) clearBeat();
      else {
        clear = false;
        // The bars close once and hold. Nothing retracts them: the hand-off
        // curtain closes over them and the sheet arrives on a clear frame,
        // which is the only moment they are allowed to be gone.
        bars(ease.outQuart(clamp01(t / FIN_IN)));

        // The wash arrives a shade behind the bars, holds, and leaves — it is
        // the *verdict*, and a verdict said once is a verdict. What is left
        // behind it is a composed frame with a race still finishing in it.
        const outU = ease.inQuad(clamp01((t - FIN_IN - FIN_HOLD) / FIN_OUT));
        const wu = ease.outQuad(clamp01(t / 0.3)) * (1 - outU);
        // A slow breath while it holds, so a held frame is never a still.
        const breathe = 1 + Math.sin(t * 1.9) * 0.06;
        wash.set('opacity', (wu * breathe).toFixed(3));

        // One band of light across the frame, on the crossing itself.
        const su = clamp01(t / 0.62);
        if (su < 1) {
          sweep.set('opacity', (Math.sin(su * Math.PI) * (podium ? 1 : 0.6)).toFixed(3));
          sweep.set('transform',
            `translateX(${(-140 + ease.outQuad(su) * 400).toFixed(1)}%) skewX(-14deg)`);
        } else sweep.set('opacity', '0');
      }

      if (wipeT < 0 || wipeT >= WIPE_TOTAL) {
        bladeL.set('opacity', '0');
        bladeR.set('opacity', '0');
        return;
      }
      let v: number;
      if (wipeT < WIPE_IN) v = ease.outQuart(wipeT / WIPE_IN);
      else if (wipeT < WIPE_IN + WIPE_HOLD) v = 1;
      else v = 1 - ease.inQuad(clamp01((wipeT - WIPE_IN - WIPE_HOLD) / WIPE_OUT));
      bladeL.set('opacity', '1');
      bladeR.set('opacity', '1');
      bladeL.set('transform', curtainTransform(v, -1));
      bladeR.set('transform', curtainTransform(v, 1));
    },
  };

  api.reset();
  return api;
}
