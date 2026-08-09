// The three readouts: lap, position, coins.
//
// Each one is a sign, and each one has a job beyond printing a number.
//
//   *Lap* has to say how much race is left, which is why the pips are there —
//   "2/3" is arithmetic, three squares with two of them lit is a glance.
//   *Position* has to say when it changes. A place gained silently is the single
//   most wasted moment in a kart racer: it is the thing the player has been
//   working at for the last thirty seconds, and it arrives as a digit quietly
//   becoming a different digit. Here it throws the old number out, drops the new
//   one in, flashes the plate in the colour of the news and fires a chevron.
//   *Coins* has to reward the pickup, and cost the hit — both with a number that
//   leaves the readout and flies.
//
// **Two things used to be here and are gone on purpose.**
//
// A speedometer — a 220° dial with tick marks reading "226 km/h" — occupied the
// bottom-right corner in a larger plate than the one telling the player what
// place they were in. Mario Kart has never shipped a speed readout, for the
// reason that the number is not actionable: the player already knows how fast
// they are going, because the world is going past them, and a figure that only
// confirms it is competing for the same corner of the eye as the things they can
// still change. The mini-turbo ring it carried was worth keeping and moved to
// `itemslot.ts`, onto a thin arc around the socket the player is already
// watching. Position took the corner it left.
//
// And a millisecond race clock, labelled TIME, under the lap counter. A Grand
// Prix has no target time — nothing the player does in the next corner is
// changed by knowing it is 2:10.908 — so it was three digits of telemetry
// updating sixty times a second in the most valuable corner of the screen. The
// lap splits still exist, on the banner, at the one moment they mean something.
//
// What is left carries no labels either. `LAP`, `POSITION` and `TIME` all named
// readouts that a three-square pip row, a giant ordinal and a clock face already
// named. Nintendo labels nothing; the numeral is the label.

import { clamp01, ease } from '../core/math.ts';
import type { GameContext, Racer } from '../types.ts';
import { glyphBox, ordinalWord, type GlyphBox } from './glyphs.ts';
import { CHEVRON_SVG, COIN_SVG } from './icons.ts';
import { createRoller, rollerHtml, type Roller } from './roller.ts';
import { bind, fromHtml, q, rgba, type Bound } from './theme.ts';

export const CSS_READOUTS = `
/* ── lap ─────────────────────────────────────────────────────────────────── */
/* Every size below is a *height*, not a font-size: these are drawn numerals now
   (see glyphs.ts) and a glyph run is sized by the box it is given. */
#hud .lap-plate { padding: calc(var(--u) * .46) calc(var(--u) * .78) calc(var(--u) * .42); }
#hud .lap-head { display: flex; align-items: center; gap: calc(var(--u) * .95); }
#hud .lap-num { display: flex; align-items: flex-end; gap: calc(var(--u) * .16); }
#hud .lap-num .num { height: calc(var(--u) * 4.3); color: #FFF8F0; }
#hud .lap-num .sep { height: calc(var(--u) * 2.5); color: #FFF8F0; opacity: .42;
  margin-bottom: calc(var(--u) * .12); }
#hud .lap-num .tot { height: calc(var(--u) * 2.8); color: #FFF8F0; opacity: .88;
  margin-bottom: calc(var(--u) * .06); }
#hud .pips { display: flex; gap: calc(var(--u) * .22); margin-left: auto; align-self: center; }
#hud .pips i {
  display: block; width: calc(var(--u) * .5); height: calc(var(--u) * 1.5);
  border-radius: calc(var(--u) * .14);
  background: rgba(255,248,240,.16);
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.5);
}
#hud .pips i.done { background: #FFC300; box-shadow: inset 0 0 0 1px rgba(0,0,0,.5), 0 0 calc(var(--u) * .34) rgba(255,195,0,.75); }
#hud .pips i.now { background: #FFF8F0; box-shadow: inset 0 0 0 1px rgba(0,0,0,.5), 0 0 calc(var(--u) * .4) rgba(255,248,240,.8); }
/* The last lap is a different race and the sign says so — hazard orange, and a
   slow pulse that never quite settles. */
#hud .lap-plate.final::before { background: linear-gradient(90deg, #FF6B1A, #FFC300 50%, #FF6B1A); }
#hud .lap-plate.final .lap-num .num { color: #FFC98A; }
#hud .lap-plate.final .lap-num .tot { color: #FFB259; }
#hud .lap-plate.final .lap-num .sep { color: #FFB259; }

/* ── position ────────────────────────────────────────────────────────────── */
/* The biggest thing on the screen, in a corner of its own. It used to be a
   3.9u numeral stacked under the coin plate in the bottom-left, sharing a corner
   and losing the argument to a speedometer; at 7u in the bottom-right it is
   about an eighth of the frame's height, which is where Mario Kart puts it and
   is the size a number has to be to be the thing you glance at rather than the
   thing you read. */
#hud .pos-wrap { position: relative; display: flex; flex-direction: column; align-items: center; }
#hud .pos-plate { padding: calc(var(--u) * .34) calc(var(--u) * .82) calc(var(--u) * .5) calc(var(--u) * .74); }
#hud .pos-row { display: flex; align-items: flex-end; }
#hud .pos-row .num { height: calc(var(--u) * 8); color: #FFF8F0; }
#hud .pos-row .suf { height: calc(var(--u) * 2.9); color: #FFF8F0;
  margin-left: calc(var(--u) * .1); margin-bottom: calc(var(--u) * .18); }
#hud .pos-plate.p1 .num, #hud .pos-plate.p1 .suf { color: #FFD84D; }
#hud .pos-plate.p1::before { background: linear-gradient(90deg, #FFD84D, #FFF3B0 50%, #FFD84D); }
#hud .pos-flash {
  position: absolute; inset: 0; border-radius: calc(var(--u) * .55);
  opacity: 0; mix-blend-mode: screen; pointer-events: none;
}
/* **The tell lives above the plate, both ways.** It used to be pinned to the
   plate's vertical centre and thrown 145% of its own height in whichever
   direction the news went — which was fine for a gain and off the bottom of the
   frame for a loss, because the plate sits in a corner and the corner has a
   viewport edge under it. A chevron whose point is clipped by the screen is not
   a tell. Both directions now play out in the strip of clear air above the
   sign: a gain lifts away from it, a loss falls onto it. */
#hud .delta {
  position: relative;
  width: calc(var(--u) * 3.4); height: calc(var(--u) * 3.4);
  margin-bottom: calc(var(--u) * .1);
  opacity: 0;
}
#hud .delta svg { width: 100%; height: 100%; display: block;
  filter: drop-shadow(0 calc(var(--u) * .14) 0 rgba(0,0,0,.75))
          drop-shadow(0 0 calc(var(--u) * .6) rgba(0,0,0,.6)); }

/* ── coins ───────────────────────────────────────────────────────────────── */
#hud .coin-wrap { position: relative; }
/* Scaled up with the rest of the set. Coins are a speed stat in this game, not
   trivia — at 1.5u against a 7u place indicator the readout was small enough to
   read as decoration, and a player who does not notice they are on two coins
   does not know why they are slow. */
#hud .coin-plate {
  display: flex; align-items: center; gap: calc(var(--u) * .42);
  padding: calc(var(--u) * .34) calc(var(--u) * .78) calc(var(--u) * .38) calc(var(--u) * .5);
  perspective: calc(var(--u) * 24);
}
#hud .coin-plate .coin-ico { width: calc(var(--u) * 2.3); height: calc(var(--u) * 2.3); display: block; }
#hud .coin-plate .c { height: calc(var(--u) * 3); color: #FFE08A; }
/* Ten coins is the speed cap. The plate goes gold to say "this is done" — a
   number the player has stopped needing to grow. */
#hud .coin-plate.max::before { background: linear-gradient(90deg, #FFD84D, #FFF6C8 50%, #FFD84D); }
#hud .coin-plate.max .c { color: #FFF6C8;
  filter: drop-shadow(0 0 calc(var(--u) * .5) rgba(255,216,77,.85)); }
/* Anchored to the *top* edge of the plate, not the inside of it. The plate lives
   in the bottom-left corner, so a "-3" thrown downward out of it goes straight
   into the frame edge and loses its bottom third — the same mistake the
   place-lost chevron used to make in the opposite corner. Both floats now play
   out in the clear air above the sign: the gain lifts away from it, the loss
   drops onto it. */
#hud .floats { position: absolute; left: calc(var(--u) * 2.4); bottom: 100%; width: 0; height: 0; }
#hud .floats b {
  position: absolute; left: 0; top: 0; white-space: nowrap;
  height: calc(var(--u) * 2.1); opacity: 0;
}
`;

export interface Panel {
  readonly root: HTMLElement;
  update(dt: number): void;
  reset(): void;
  dispose(): void;
}

// ── lap ────────────────────────────────────────────────────────────────────

export function createLapPanel(ctx: GameContext): Panel {
  const root = fromHtml(`
    <div class="plate lap-plate">
      <div class="lap-head">
        <div class="lap-num">
          <span class="num">${rollerHtml('cur')}</span>
          <span class="sep"></span><span class="tot"></span>
        </div>
        <div class="pips"></div>
      </div>
    </div>
  `);

  const plate = bind(root);
  const roller: Roller = createRoller(q(root, '.roll.cur'));
  glyphBox(q(root, '.sep'), '/');
  const total = glyphBox(q(root, '.tot'), '3');
  const pipBox = q(root, '.pips');

  let pips: HTMLElement[] = [];
  let laps = 0;
  let shownLap = -1;
  let punch = 0;
  let finalLap = false;

  function buildPips(n: number): void {
    if (laps === n) return;
    laps = n;
    pipBox.innerHTML = '<i></i>'.repeat(Math.max(1, Math.min(9, n)));
    pips = Array.from(pipBox.querySelectorAll('i'));
  }

  return {
    root,

    reset(): void {
      shownLap = -1;
      punch = 0;
      finalLap = false;
      roller.reset('1');
      plate.cls('final', false);
    },

    update(dt: number): void {
      const race = ctx.race;
      const player = ctx.player;
      buildPips(race.totalLaps);
      total.set(String(race.totalLaps));

      // `lap` counts from -1 on the run-up to the line, so the displayed lap is
      // one more than it and never leaves 1..total.
      const lap = Math.min(Math.max(1, (player?.lap ?? 0) + 1), race.totalLaps);
      if (lap !== shownLap) {
        if (shownLap >= 0) punch = 1;
        shownLap = lap;
        // Counting up: the new lap arrives from underneath, the way a mechanical
        // counter turns.
        roller.set(String(lap), 1);
      }
      const isFinal = lap >= race.totalLaps && race.totalLaps > 1;
      if (isFinal !== finalLap) {
        finalLap = isFinal;
        plate.cls('final', isFinal);
      }

      for (let i = 0; i < pips.length; i++) {
        const want = i < lap - 1 ? 'done' : i === lap - 1 ? 'now' : '';
        if (pips[i]!.className !== want) pips[i]!.className = want;
      }

      roller.update(dt);
      if (punch > 0) punch = Math.max(0, punch - dt * 2.6);
      const pulse = finalLap ? 1 + Math.sin(ctx.time.elapsed * 5.2) * 0.014 : 1;
      plate.set('transform', `scale(${(pulse + punch * punch * 0.09).toFixed(4)})`);
    },

    dispose(): void { root.remove(); },
  };
}

// ── position ───────────────────────────────────────────────────────────────

/**
 * How long a new place has to survive before the readout commits to it.
 *
 * **Measured, and it is the reason this exists.** A render-free 25-second trace
 * of the sim shows `player.place` holding for runs of 3, 3, 5, 12, 12, 13, 17
 * and 23 frames — eight of sixteen runs under three tenths of a second, two of
 * them fifty milliseconds. Those are not places changed, they are two karts
 * trading a metre of progress at a hairpin. The readout used to spend a full
 * plate punch, a colour flash and a chevron on every one of them, which is how
 * the loudest moment in a kart racer gets spent on noise: if 5th flashes past
 * for three frames, the player learns to stop trusting the corner it happens in.
 *
 * A quarter of a second is the shortest hold that survives a swap-back at a
 * hairpin and the longest that still lands inside the same beat as the overtake
 * — the pass is still on screen when the number confirms it. It is a *display*
 * delay and nothing more: the HUD reads state and never writes it, so the race
 * director's own answer is untouched and a place that genuinely changed is shown
 * a quarter of a second later, which no one can perceive as late.
 *
 * The proper fix is upstream — see the report: `race/` should be settling the
 * standings itself rather than re-sorting a noisy progress key every step.
 */
const PLACE_HOLD = 0.25;

export function createPositionPanel(ctx: GameContext): Panel {
  const root = fromHtml(`
    <div class="pos-wrap">
      <div class="delta">${CHEVRON_SVG}</div>
      <div class="plate pos-plate">
        <div class="pos-row">
          <span class="num">${rollerHtml('place')}</span><span class="suf"></span>
        </div>
        <div class="pos-flash"></div>
      </div>
    </div>
  `);

  const plate = bind(q(root, '.pos-plate'));
  const flash = bind(q(root, '.pos-flash'));
  const suffix: GlyphBox = glyphBox(q(root, '.suf'), 'ST');
  const delta = bind(q(root, '.delta'));
  const roller = createRoller(q(root, '.roll.place'));

  let shown = -1;
  /** The candidate the sim is currently reporting, and how long it has held. */
  let pending = -1;
  let pendingT = 0;
  let punch = 0;
  let flashT = 0;
  let flashUp = true;
  let deltaT = 0;
  let deltaUp = true;

  return {
    root,

    reset(): void {
      shown = -1;
      pending = -1;
      pendingT = 0;
      punch = 0;
      flashT = 0;
      deltaT = 0;
      roller.reset('1');
      suffix.set('ST');
      plate.cls('p1', true);
    },

    update(dt: number): void {
      const live = ctx.player?.place ?? 1;
      // ── hysteresis ───────────────────────────────────────────────────────
      if (live === shown) {
        pending = live;
        pendingT = 0;
      } else {
        if (live !== pending) { pending = live; pendingT = 0; }
        pendingT += dt;
      }
      // The first read of a race, and the finish, are committed on the spot:
      // there is nothing on screen to protect at the start, and the place a
      // player finished in is never going to be taken back.
      const settled = shown < 0 || (ctx.player?.finished ?? false)
        || pendingT >= PLACE_HOLD;
      const place = settled ? live : shown;

      if (place !== shown) {
        const gained = shown >= 0 && place < shown;
        const lost = shown >= 0 && place > shown;
        roller.set(String(place), place < shown ? -1 : 1);
        suffix.set(ordinalWord(place));
        plate.cls('p1', place === 1);
        if (gained || lost) {
          punch = 1;
          flashT = 1;
          flashUp = gained;
          deltaT = 1;
          deltaUp = gained;
          flash.set('background', gained
            ? `linear-gradient(180deg, ${rgba(0x8CFF6A, 0.75)}, ${rgba(0x2FA015, 0)} 78%)`
            : `linear-gradient(0deg, ${rgba(0xFF5B45, 0.7)}, ${rgba(0x8E1A0C, 0)} 78%)`);
        }
        shown = place;
      }

      roller.update(dt);

      if (punch > 0) punch = Math.max(0, punch - dt * 2.4);
      if (flashT > 0) flashT = Math.max(0, flashT - dt * 2.2);
      if (deltaT > 0) deltaT = Math.max(0, deltaT - dt * 1.35);

      // A gain shoves the plate up and a loss drops it — the sign itself moves
      // in the direction the news went.
      //
      // The travel is a percentage of the plate rather than an `em`, because
      // this plate sets no font-size of its own: `em` here resolved against the
      // document's 16px and produced a 5px nudge under a 140px numeral. And the
      // punch is 28%, not the 7.5% it was — measured, that was four pixels of
      // growth on the biggest number in the game, which is under the threshold
      // at which a person notices anything happened at all. The colour flash and
      // the roller were doing all the work; now the scale lands with them.
      const dir = flashUp ? -1 : 1;
      const kick = punch * punch;
      plate.set('transform',
        `translateY(${(dir * kick * 9).toFixed(2)}%) scale(${(1 + kick * 0.28).toFixed(4)})`);
      flash.set('opacity', flashT > 0.004 ? (flashT * flashT * 0.85).toFixed(3) : '0');

      if (deltaT > 0.004) {
        const t = 1 - deltaT;
        const travel = ease.outQuart(clamp01(t * 1.5));
        // Both tells play in the clear strip above the plate, and they play in
        // opposite directions through it: a gain starts on the sign and lifts
        // off it, a loss starts high and comes down onto it. Nothing leaves the
        // strip, so nothing can be clipped by the frame edge underneath.
        const y = deltaUp ? -travel * 78 : (travel - 1) * 78;
        delta.set('opacity', (Math.min(1, deltaT * 2.4) * 0.97).toFixed(3));
        delta.set('transform',
          `translateY(${y.toFixed(1)}%) scale(${(0.75 + (deltaUp ? travel : 1 - travel) * 0.5).toFixed(3)}) rotate(${deltaUp ? 0 : 180}deg)`);
        delta.set('color', deltaUp ? '#8CFF6A' : '#FF6A55');
      } else {
        delta.set('opacity', '0');
      }
    },

    dispose(): void { root.remove(); },
  };
}

// ── coins ──────────────────────────────────────────────────────────────────

interface Float { el: Bound; glyphs: GlyphBox; t: number; up: boolean; }

export function createCoinPanel(ctx: GameContext): Panel {
  const root = fromHtml(`
    <div class="coin-wrap">
      <div class="plate coin-plate">${COIN_SVG}<span class="c"></span></div>
      <div class="floats"><b></b><b></b><b></b><b></b></div>
    </div>
  `);

  const plate = bind(q(root, '.coin-plate'));
  const value = glyphBox(q(root, '.c'), '0');
  const icon = bind(q(root, '.coin-ico'));
  const floats: Float[] = Array.from(root.querySelectorAll<HTMLElement>('.floats b'))
    .map((el) => ({ el: bind(el), glyphs: glyphBox(el), t: 0, up: true }));
  let nextFloat = 0;

  let shown = -1;
  let punch = 0;
  let shake = 0;
  let spin = 0;
  const unsubs: Array<() => void> = [];

  function fire(text: string, up: boolean, color: string): void {
    const f = floats[nextFloat % floats.length]!;
    nextFloat++;
    f.t = 1;
    f.up = up;
    f.glyphs.set(text);
    f.el.set('color', color);
  }

  unsubs.push(ctx.bus.on<{ racer: Racer; total: number }>('coin:get', (e) => {
    if (!e.racer.isPlayer) return;
    punch = 1;
    spin = 1;
    fire('+1', true, '#FFE08A');
  }));
  unsubs.push(ctx.bus.on<{ racer: Racer; count: number }>('coin:lose', (e) => {
    if (!e.racer.isPlayer) return;
    shake = 1;
    fire(`-${e.count}`, false, '#FF7A66');
  }));

  return {
    root,

    reset(): void {
      shown = -1;
      punch = shake = spin = 0;
      for (const f of floats) { f.t = 0; f.el.set('opacity', '0'); }
    },

    update(dt: number): void {
      const coins = ctx.player?.coins ?? 0;
      if (coins !== shown) {
        shown = coins;
        value.set(String(coins));
        // Mirrors COIN_CAP in the item system, which does not export it. If the
        // two ever drift the plate simply stops lighting up — it cannot lie
        // about the count itself.
        plate.cls('max', coins >= 10);
      }

      if (punch > 0) punch = Math.max(0, punch - dt * 3.1);
      if (shake > 0) shake = Math.max(0, shake - dt * 2.6);
      if (spin > 0) spin = Math.max(0, spin - dt * 1.7);

      // ...and the same for the coin plate's shake: 1.4% of the plate, which is
      // a real nudge at any resolution, rather than a fraction of a font-size
      // this element does not set.
      const wobble = shake > 0 ? Math.sin(ctx.time.elapsed * 46) * shake * 1.4 : 0;
      plate.set('transform',
        `translateX(${wobble.toFixed(3)}%) scale(${(1 + punch * punch * 0.16).toFixed(4)})`);
      // The coin flips on its axis when one is collected: the icon is the part
      // of this readout the eye is on, so the icon is the part that reacts.
      icon.set('transform', spin > 0
        ? `rotateY(${(spin * 540).toFixed(0)}deg) scale(${(1 + spin * 0.2).toFixed(3)})`
        : 'none');

      for (const f of floats) {
        if (f.t <= 0) continue;
        f.t = Math.max(0, f.t - dt * 1.25);
        const t = 1 - f.t;
        const e = ease.outQuart(t);
        // A gain leaves upward; a loss falls out of the air onto the plate. Both
        // stay inside the strip above the sign — see `.floats`.
        // Percentages of the float's own box, not `em`. These are drawn glyphs
        // now and the holder sets no font-size, so an `em` here would resolve
        // against the document's 16px and quietly halve the travel — the same
        // trap the position plate's punch fell into.
        const rise = f.up ? e * -160 : (e - 1) * 133 + 23;
        f.el.set('transform',
          `translateY(${rise.toFixed(1)}%) scale(${(0.8 + ease.outBack(Math.min(1, t * 2.5)) * 0.35).toFixed(3)})`);
        f.el.set('opacity', (Math.min(1, f.t * 2.2) * 0.98).toFixed(3));
        if (f.t === 0) f.el.set('opacity', '0');
      }
    },

    dispose(): void {
      for (const off of unsubs) off();
      unsubs.length = 0;
      root.remove();
    },
  };
}
