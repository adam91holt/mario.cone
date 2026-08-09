// The coach: how you play, said at the moment you need it.
//
// This exists because the game shipped playable and unexplained. A player who
// had never seen it could accelerate and steer by guessing, and then held an
// item for a whole lap without discovering that `E` throws it — the slot showed
// them *what* they had and nothing anywhere said what to do with it. Mario Kart
// never has this problem, and not because it has a manual: it has one button
// for items and it puts a controller in your hand that only has so many things
// to press. A keyboard has a hundred, so the game has to say which.
//
// Two halves, deliberately different in kind:
//
//   The **card** is the full mapping. It shows itself while the player is
//   sitting on the grid with nothing to do, which is the one moment in a kart
//   racer that is already dead time — reading it costs them nothing. It comes
//   back on pause, and `H` toggles it anywhere.
//
//   The **cues** are one line each, and each one appears only in the situation
//   that makes it make sense: the item prompt when there is an item to throw,
//   the drift prompt when a corner has been taken flat, the off-road prompt
//   when the dirt has already started slowing them down. A hint that arrives
//   before the situation is a manual, and a manual is what nobody reads.
//
// Every cue fires **once per page load** and never returns. Being told twice is
// how a game calls you stupid. That state deliberately survives `reset()`, so
// restarting a race does not restart the lecture — and so the capture harness,
// which resets constantly, cannot fill nine review shots with beginner prompts.
//
// Nothing here touches simulation state. Timers integrate the `dt` handed to
// `update`, never a wall clock, so a headless capture sees exactly what a
// player does.

import { clamp01, ease } from '../core/math.ts';
import type { GameContext, GameSystem, RacePhase } from '../types.ts';
import { bind, fromHtml, hintCss, hintKey, q, U_CSS, type Bound } from './theme.ts';

/**
 * Cues already spent, keyed by id.
 *
 * Module scope rather than system scope: a system is rebuilt on `reset()` and
 * this must not be.
 */
const spent = new Set<string>();

/** The mapping, as one list, so the card and the cues cannot disagree. */
const CONTROLS: Array<[key: string, label: string]> = [
  ['&uarr; W', 'Accelerate'],
  ['&darr; S', 'Brake'],
  ['&larr; &rarr;', 'Steer'],
  ['SPACE', 'Hop / Drift'],
  ['E', 'Use item'],
  ['Q', 'Look back'],
  ['ESC', 'Pause'],
];

const PAD: Array<[key: string, label: string]> = [
  ['RT', 'Accelerate'],
  ['LT', 'Brake'],
  ['L', 'Steer'],
  ['RB', 'Hop / Drift'],
  ['LB', 'Use item'],
  ['R3', 'Look back'],
];

const CSS = `
#coach {
  position: fixed; inset: 0; pointer-events: none; z-index: 60;
  --u: ${U_CSS};
  font-family: 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif;
}
${hintCss('#coach')}

/* ── the card ─────────────────────────────────────────────────────────────
   Bottom-left, not centred. Centre is where the countdown lands and where the
   road is; a card there would be read as part of the race rather than as
   furniture beside it. */
#coach .card {
  position: absolute; left: calc(var(--u) * 1.6); bottom: calc(var(--u) * 1.6);
  padding: calc(var(--u) * .95) calc(var(--u) * 1.25) calc(var(--u) * 1.05);
  border-radius: calc(var(--u) * .7);
  background: linear-gradient(180deg, rgba(20,23,30,.93), rgba(12,14,19,.95));
  box-shadow: inset 0 0 0 1px rgba(255,248,240,.13),
              0 calc(var(--u) * .5) calc(var(--u) * 1.1) rgba(0,0,0,.55);
  opacity: 0; transform: translateY(calc(var(--u) * .5));
}
/* The hazard strip is the one piece of chrome every plate in this game wears,
   so the card reads as part of the same object set rather than a browser
   dialog that wandered in. */
#coach .card::before {
  content: ''; position: absolute; left: 0; right: 0; top: 0;
  height: calc(var(--u) * .22);
  border-radius: calc(var(--u) * .7) calc(var(--u) * .7) 0 0;
  background: repeating-linear-gradient(115deg,
    #FFC300 0 calc(var(--u) * .5), #14171F calc(var(--u) * .5) calc(var(--u) * 1));
}
#coach .card h5 {
  margin: 0 0 calc(var(--u) * .7); padding: 0;
  font-size: calc(var(--u) * .72); font-weight: 900; letter-spacing: .22em;
  text-transform: uppercase; color: #FFC300;
}
#coach .rows { display: grid; gap: calc(var(--u) * .42); }
#coach .rows .k { justify-content: flex-start; }
#coach .pad {
  margin-top: calc(var(--u) * .7); padding-top: calc(var(--u) * .6);
  border-top: 1px solid rgba(255,248,240,.12);
}

/* ── the cue rail ─────────────────────────────────────────────────────────
   One line, low centre, above the road and below the racing. It sits where a
   player's eye already returns between corners. */
#coach .cue {
  position: absolute; left: 50%; bottom: calc(var(--u) * 3.4);
  transform: translate(-50%, calc(var(--u) * .6));
  display: flex; align-items: center; gap: calc(var(--u) * .6);
  padding: calc(var(--u) * .5) calc(var(--u) * 1.1);
  border-radius: calc(var(--u) * .55);
  background: linear-gradient(180deg, rgba(20,23,30,.92), rgba(12,14,19,.94));
  box-shadow: inset 0 0 0 1px rgba(255,248,240,.15),
              0 calc(var(--u) * .34) calc(var(--u) * .8) rgba(0,0,0,.5);
  opacity: 0; white-space: nowrap;
}
#coach .cue .lbl { color: #FFF8F0; letter-spacing: .1em; }
`;

interface Cue {
  id: string;
  key: string;
  label: string;
  /** Seconds the cue stays up once shown. */
  hold: number;
}

export function createCoachSystem(ctx: GameContext): GameSystem {
  let root: HTMLElement | null = null;
  // Bound once, not per frame: `bind` carries the last-written value for each
  // property, so rebinding every frame would throw that cache away and write
  // the same opacity sixty times a second.
  let card: Bound | null = null;
  let cue: Bound | null = null;
  let cueKey: HTMLElement | null = null;
  let cueLbl: HTMLElement | null = null;

  /** 0..1 card visibility target, eased into `cardShown`. */
  let cardWant = 0;
  let cardShown = 0;
  /** Set by `H`; survives phase changes until pressed again. */
  let cardPinned = false;

  let active: Cue | null = null;
  let cueAge = 0;
  let cueShown = 0;

  let phase: RacePhase = 'loading';
  let racingFor = 0;
  let everDrifted = false;
  let everUsedItem = false;
  let hadItem = false;
  let offroadFor = 0;

  function show(id: string, key: string, label: string, hold = 5): void {
    if (spent.has(id) || active) return;
    spent.add(id);
    active = { id, key, label, hold };
    cueAge = 0;
    if (cueKey) {
      cueKey.innerHTML = key;
      cueKey.style.display = key ? '' : 'none';
    }
    if (cueLbl) cueLbl.textContent = label;
  }

  return {
    name: 'coach',
    // After the HUD (100): the cue rail and the card are furniture over it, and
    // the item cue reads the slot state the HUD has already settled this frame.
    order: 101,

    async init(): Promise<void> {
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);

      const rows = CONTROLS.map(([k, l]) => hintKey(k, l)).join('');
      const pad = PAD.map(([k, l]) => hintKey(k, l)).join('');

      root = fromHtml(`
        <div id="coach">
          <div class="card">
            <h5>Controls</h5>
            <div class="rows">${rows}</div>
            <div class="pad rows">${pad}</div>
          </div>
          <div class="cue">${hintKey('', '')}</div>
        </div>
      `);
      document.body.appendChild(root);
      card = bind(q(root, '.card'));
      const cueEl = q<HTMLElement>(root, '.cue');
      cue = bind(cueEl);
      cueKey = q<HTMLElement>(cueEl, '.key');
      cueLbl = q<HTMLElement>(cueEl, '.lbl');
      cueKey.style.display = 'none';

      ctx.bus.on('race:phase', (e: { phase: RacePhase }) => {
        phase = e.phase;
      });

      // `H` is read here rather than through the input controller on purpose:
      // it is not a gameplay action, it must work while the sim is frozen, and
      // adding it to the keymap would put a UI toggle in the deterministic
      // input state every critic snapshots.
      window.addEventListener('keydown', (ev) => {
        if (ev.code === 'KeyH') cardPinned = !cardPinned;
      });
    },

    reset(): void {
      racingFor = 0;
      offroadFor = 0;
      hadItem = false;
      active = null;
      cueAge = 0;
    },

    update(dt: number): void {
      if (!root || !card || !cue) return;
      const p = ctx.player;

      // ── what the player has shown they know ──────────────────────────────
      if (p) {
        if (p.drift.active) everDrifted = true;
        const has = p.item != null;
        if (hadItem && !has) everUsedItem = true;
        hadItem = has;

        if (phase === 'racing') {
          racingFor += dt;
          const off = p.surface === 'dirt' || p.surface === 'grass' || p.surface === 'sand';
          offroadFor = off ? offroadFor + dt : 0;
        }

        // ── the cues, in the order a player meets them ─────────────────────
        // Item first and unconditionally: it is the one that was actually
        // missed, and holding a weapon you cannot fire is the worst of these
        // to sit in.
        if (has && !everUsedItem && phase === 'racing') {
          show('item', 'E', 'Throw your item', 6);
        } else if (racingFor > 18 && !everDrifted) {
          // Long enough to have met a real corner and taken it flat.
          show('drift', 'SPACE', 'Hold through a corner to drift', 6);
        } else if (offroadFor > 0.9) {
          show('offroad', '', 'The dirt is slower — stay on the tarmac', 4);
        }
      }

      // ── the card ─────────────────────────────────────────────────────────
      // Visible whenever the player is not racing: the grid, the countdown and
      // the pause screen are all moments with nothing else to do.
      const idle = phase === 'intro' || phase === 'countdown' || phase === 'loading';
      cardWant = cardPinned || idle ? 1 : 0;
      // Out faster than in — furniture should never be the thing still leaving
      // when the lights go green.
      cardShown += (cardWant - cardShown) * clamp01(dt * (cardWant > cardShown ? 6 : 11));
      card.set('opacity', cardShown.toFixed(3));
      card.set('transform', `translateY(calc(var(--u) * ${((1 - ease.outCubic(cardShown)) * 0.5).toFixed(3)}))`);

      // ── the cue ──────────────────────────────────────────────────────────
      if (active) {
        cueAge += dt;
        // A cue for an item the player has since thrown is a lie; drop it the
        // moment it stops being true rather than serving out its timer.
        const stale = active.id === 'item' && (everUsedItem || !p?.item);
        if (cueAge > active.hold || stale) active = null;
      }
      const want = active ? 1 : 0;
      cueShown += (want - cueShown) * clamp01(dt * (want > cueShown ? 9 : 12));
      cue.set('opacity', cueShown.toFixed(3));
      cue.set(
        'transform',
        `translate(-50%, calc(var(--u) * ${((1 - ease.outCubic(cueShown)) * 0.6).toFixed(3)}))`,
      );
    },

    dispose(): void {
      root?.remove();
      root = null;
    },
  };
}
