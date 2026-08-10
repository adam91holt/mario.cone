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

/**
 * The mapping, as one list per device, so the card and the cues cannot disagree.
 *
 * **One at a time.** Both lists used to be on the card at once — thirteen rows
 * stacked bottom-left, a third of the frame on the grid, sitting over the two
 * machines on the left of the 2x4. Half of it was always wrong for the player
 * reading it: nobody holds a keyboard and a pad at the same time, and a legend
 * that lists a control you do not have is a legend you have to filter before
 * you can use. `ctx.inputState.source` already knows which device the player
 * last touched — it is how the front-end decides whether to say ENTER or (A) —
 * so the card shows that half and the other half appears the moment they pick
 * up the other thing.
 */
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
  let keyRows: Bound | null = null;
  let padRows: Bound | null = null;
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
  /**
   * True while the front-end has a screen up, and true while the race is
   * paused. Both are read off the bus rather than off `race.phase`, because
   * **`phase` cannot tell you either one.**
   *
   * The race does not stop existing when the menus come up: it is built at boot
   * and keeps simulating behind an opaque front-end, so while the player is on
   * the title screen `race.phase` walks `intro` → `countdown` → `racing` under
   * them. This card tested `phase === 'intro' || 'countdown'` and so appeared
   * over the title screen and the machine-select roster for the first few
   * seconds of the game and then vanished for no reason a player could see —
   * exactly what the comment below it forbids, and doubling the front-end's own
   * prompt rail while it lasted. It was also sitting on the launch card during
   * the hand-off curtain, which is a full-screen transition between two screens
   * and belongs to neither.
   *
   * Pause is the same problem in reverse. `togglePause` moves the phase to
   * `'loading'` — the same value the front-end's own idle state uses — so this
   * card could not distinguish "paused, nothing to do, show the mapping" from
   * "front-end up, it has its own rail" by phase alone, and the promise two
   * paragraphs down that the card "comes back on pause" was never kept.
   *
   * `race/director.ts` already stands off the same way on the same event; this
   * is that pattern, not a new one.
   */
  let frontEndOpen = false;
  let racePaused = false;
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
            <div class="rows keys">${rows}</div>
            <div class="rows pad">${pad}</div>
          </div>
          <div class="cue">${hintKey('', '')}</div>
        </div>
      `);
      document.body.appendChild(root);
      card = bind(q(root, '.card'));
      keyRows = bind(q(root, '.rows.keys'));
      padRows = bind(q(root, '.rows.pad'));
      const cueEl = q<HTMLElement>(root, '.cue');
      cue = bind(cueEl);
      cueKey = q<HTMLElement>(cueEl, '.key');
      cueLbl = q<HTMLElement>(cueEl, '.lbl');
      cueKey.style.display = 'none';

      ctx.bus.on('race:phase', (e: { phase: RacePhase }) => {
        phase = e.phase;
      });
      // Both edges, both events. See `frontEndOpen` above.
      ctx.bus.on<{ open: boolean }>('ui:menu', ({ open }) => { frontEndOpen = open; });
      ctx.bus.on<{ on: boolean }>('race:pause', ({ on }) => { racePaused = on; });

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

      // Nothing this system says is true while somebody else owns the screen.
      // The clocks stop too, not just the drawing: `racingFor` counts the phase
      // the hidden race is in, so a player who read the title screen for
      // nineteen seconds got "hold through a corner to drift" over it — and
      // because every cue is spent once per page load, that is the *only* time
      // they would ever be offered it. A tutorial that fires before the player
      // has a kart is worse than none: it is one they will never be shown again.
      const standOff = frontEndOpen || racePaused;

      // ── what the player has shown they know ──────────────────────────────
      if (p && !standOff) {
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

      // Whichever device the player last touched. `bind` swallows the write
      // when the answer has not changed, so this costs nothing per frame.
      const onPad = ctx.inputState.source === 'gamepad';
      keyRows?.set('display', onPad ? 'none' : '');
      padRows?.set('display', onPad ? '' : 'none');

      // ── the card ─────────────────────────────────────────────────────────
      // The moments with nothing else to do: sitting on the grid, watching the
      // lights, and the pause screen. Reading it costs the player nothing at
      // any of them.
      //
      // The front-end is the one place it must never appear, and that is not a
      // matter of taste: every screen over there already carries its own rail
      // of the same keycaps, built from the same `hintKey`, so the card lands
      // beside a rail that contradicts it about which keys are live. Two
      // legends describing one keyboard.
      const idle = phase === 'intro' || phase === 'countdown';
      cardWant = !frontEndOpen && (cardPinned || racePaused || idle) ? 1 : 0;
      // Out faster than in — furniture should never be the thing still leaving
      // when the lights go green.
      cardShown += (cardWant - cardShown) * clamp01(dt * (cardWant > cardShown ? 6 : 11));
      card.set('opacity', cardShown.toFixed(3));
      card.set('transform', `translateY(calc(var(--u) * ${((1 - ease.outCubic(cardShown)) * 0.5).toFixed(3)}))`);

      // ── the cue ──────────────────────────────────────────────────────────
      // Its clock stops under a stand-off rather than running out behind the
      // curtain: a cue interrupted by a pause is one the player has not read
      // yet, and it has already been spent.
      if (active && !standOff) {
        cueAge += dt;
        // A cue for an item the player has since thrown is a lie; drop it the
        // moment it stops being true rather than serving out its timer.
        const stale = active.id === 'item' && (everUsedItem || !p?.item);
        if (cueAge > active.hold || stale) active = null;
      }
      const want = active && !standOff ? 1 : 0;
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
