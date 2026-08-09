// The four screens.
//
// Each one is built once, sits in the DOM for the life of the page, and is
// moved and faded by `index.ts` — nothing here is created or destroyed as a
// player walks the flow, because a menu that rebuilds its own markup on every
// keypress is a menu that drops a frame on every keypress.
//
// Every screen exposes the same three things: a root, an `update(dt, show)`
// that integrates its own motion from the frame delta, and — where it has
// something to choose from — an index. `show` is 0..1: how present this screen
// is right now. A screen at 0 is off the frame and does no work.
//
// **No CSS transitions, no keyframes.** Same rule as the HUD, same reason: the
// capture harness renders frames by hand with no wall clock, so anything the
// browser animates on its own would land somewhere different in every
// screenshot. Everything below is integrated from `dt`.
//
// ── Why a spring and not a damp ────────────────────────────────────────────
//
// `damp` — the exponential approach the rest of this front-end runs on — is the
// right tool for anything that must *arrive*: a screen fading in, a camera
// settling, a bar travelling to a value. It is the wrong tool for a cursor.
// It has no overshoot, so a selection driven by one steps to its rest size in
// two frames and then reports the same transform for the next twenty-five: a
// jump, not a pop. Measured, that is exactly what the roster used to do —
// 1.000 → 1.072 → 1.224 in 33ms and then dead still.
//
// Every selection on these screens now runs on a real spring: it overshoots its
// rest size by about a third of the growth, rings back into it inside a fifth
// of a second, and then *breathes* — a percent and a half at a bit under a
// hertz, which is what stops a held cursor from being a screenshot of a cursor.

import { clamp01, damp, ease, lerp } from '../../core/math.ts';
import { listVehicles } from '../../vehicles/registry.ts';
import { listCourses } from '../../track/courses/index.ts';
import { glyphRun } from '../glyphs.ts';
import { vehicleMark, wordmark } from './art.ts';
import {
  bind, courseMap, cupEmblem, fromHtml, hexCss, plannedMap, q, title, unitPx, type Bound,
} from './chrome.ts';
import type { CourseDef, EngineClass, GameContext, VehicleId } from '../../types.ts';

export const CSS_SCREENS = `
#menu .scr-course .cups { transform: translateX(-50%); }
#menu .scr-course .cards { top: calc(var(--ey) + var(--u) * 9.2); }
#menu .scr-class .cards { top: calc(var(--ey) + var(--u) * 6.6); }

/* The call to action. It used to be bare orange display text with no plate,
   floating forty pixels above a prompt rail that said the same words — the
   least legible thing on the screen was the thing the screen is for. It is a
   sign now, like every other statement this product makes, and it carries its
   own keycap so the rail does not have to repeat it. */
#menu .scr-class .go {
  position: absolute; right: var(--er); bottom: calc(var(--eb) + var(--u) * 3.1);
  display: flex; align-items: center; gap: calc(var(--u) * .8);
  padding: calc(var(--u) * .62) calc(var(--u) * 1.15) calc(var(--u) * .7);
}
#menu .scr-class .go .t { font-size: calc(var(--u) * 1.5); color: var(--gold); }
#menu .scr-class .go .sub {
  margin-top: calc(var(--u) * .26); font-size: calc(var(--u) * .6); font-weight: 800;
  letter-spacing: .2em; text-transform: uppercase; color: rgba(255,248,240,.62);
}
#menu .scr-class .go .glow {
  position: absolute; inset: calc(var(--u) * -.24); border-radius: calc(var(--u) * .8);
  box-shadow: 0 0 0 calc(var(--u) * .2) ${hexCss(0xFFC300)},
              0 0 0 calc(var(--u) * .32) rgba(9,11,15,.95),
              0 0 calc(var(--u) * 1.6) rgba(255,180,40,.6);
  pointer-events: none;
}

/* A closed cup is dimmed by dimming its *contents*. Filtering the tab itself
   dims the selection ring with it, and a highlight you cannot see is a cursor
   the player has lost. */
#menu .cupTab.locked .t { color: rgba(255,248,240,.44); }
#menu .cupTab.locked .em { opacity: .3; }
#menu .card .mapbox { display: block; }
#menu .scr-racer .roster .tile.rnd .mark {
  display: flex; align-items: center; justify-content: center;
  font-size: calc(var(--u) * 3.4); font-weight: 900; color: var(--yellow);
  text-shadow: 0 calc(var(--u) * .1) 0 #0A0D13, 0 calc(var(--u) * .22) calc(var(--u) * .3) rgba(0,0,0,.7);
}

/* The circuit screen's lower-right corner: which round of the cup the
   highlighted circuit is. The corner used to be bare road. */
#menu .scr-course .brief {
  position: absolute; right: var(--er); bottom: calc(var(--eb) + var(--u) * 3.1);
  padding: calc(var(--u) * .55) calc(var(--u) * 1) calc(var(--u) * .66);
  display: flex; align-items: center; gap: calc(var(--u) * .8);
}
#menu .scr-course .brief .em { width: calc(var(--u) * 2.4); height: calc(var(--u) * 2.4); }
#menu .scr-course .brief .t { font-size: calc(var(--u) * 1.05); }
#menu .scr-course .brief .cap { font-size: calc(var(--u) * .58); margin-bottom: calc(var(--u) * .2); }
#menu .scr-course .brief .pips { display: flex; gap: calc(var(--u) * .22); margin-top: calc(var(--u) * .34); }
#menu .scr-course .brief .pips b {
  display: block; width: calc(var(--u) * 1.1); height: calc(var(--u) * .26);
  border-radius: calc(var(--u) * .13); background: rgba(255,248,240,.22);
}
#menu .scr-course .brief .pips b.on { background: linear-gradient(90deg, var(--yellow), var(--orange)); }
`;

// ── the spring ─────────────────────────────────────────────────────────────

interface Spring { v: number; vel: number }

/** 240Hz substeps. A spring this stiff is unstable integrated at a 30fps
 *  delta, and 30fps is exactly what the capture harness renders at. */
const SUB = 1 / 240;

function springTo(s: Spring, target: number, k: number, c: number, dt: number): number {
  let left = dt > 0.25 ? 0.25 : dt;
  while (left > 0) {
    const h = left > SUB ? SUB : left;
    left -= h;
    s.vel += ((target - s.v) * k - s.vel * c) * h;
    s.v += s.vel * h;
  }
  return s.v;
}

/** The selection spring: overshoots ~37% of the growth, rings back in ~0.2s. */
const SEL_K = 2100;
const SEL_C = 27.5;
/** The cursor's own travel between cells — faster and nearly critical, because
 *  a ring that wallows between two tiles reads as lag rather than as weight. */
const ROVE_K = 4200;
const ROVE_C = 96;
/** Idle breath on whatever is currently chosen. */
const BREATHE_HZ = 0.9;
const BREATHE_AMP = 0.015;

// ── the roving cursor ──────────────────────────────────────────────────────
//
// One ring per screen, not one per cell. Fading a ring out of one tile and into
// another says "something changed"; sliding the same ring across says *where
// the cursor went*, and it is the difference between a list of buttons and a
// cursor moving over a list of buttons.

/** Bumped by the one resize listener below; rovers re-measure when it moves. */
let layoutEpoch = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => { layoutEpoch++; });
}

interface Rover {
  /** `pop` is the chosen cell's spring value; `lift` is its rise, in fractions
   *  of its own height. */
  update(dt: number, index: number, pop: number, show: number, lift: number, grow: number): void;
}

function makeRover(
  host: HTMLElement, items: readonly HTMLElement[], cls: string, padU: number,
): Rover {
  const el = document.createElement('div');
  el.className = `rove ${cls}`;
  host.appendChild(el);
  const b = bind(el);

  const boxes: Array<{ cx: number; cy: number; w: number; h: number }> = [];
  let epoch = -1;
  const sx: Spring = { v: 0, vel: 0 };
  const sy: Spring = { v: 0, vel: 0 };
  let started = false;

  function measure(): void {
    boxes.length = 0;
    for (const it of items) {
      boxes.push({
        cx: it.offsetLeft + it.offsetWidth / 2,
        cy: it.offsetTop + it.offsetHeight / 2,
        w: it.offsetWidth,
        h: it.offsetHeight,
      });
    }
    epoch = layoutEpoch;
  }

  return {
    update(dt, index, pop, show, lift, grow): void {
      if (show <= 0.001) { b.set('opacity', '0'); return; }
      if (epoch !== layoutEpoch || boxes.length !== items.length
        || (boxes[0] && boxes[0].w === 0)) measure();
      const box = boxes[Math.max(0, Math.min(boxes.length - 1, index))];
      if (!box || box.w === 0) { b.set('opacity', '0'); return; }

      const pad = unitPx() * padU;
      const tx = box.cx;
      const ty = box.cy - box.h * lift * pop;
      if (!started) { started = true; sx.v = tx; sy.v = ty; }
      const x = springTo(sx, tx, ROVE_K, ROVE_C, dt);
      const y = springTo(sy, ty, ROVE_K, ROVE_C, dt);

      const w = box.w + pad * 2;
      const h = box.h + pad * 2;
      b.set('width', `${w.toFixed(1)}px`);
      b.set('height', `${h.toFixed(1)}px`);
      const sc = 1 + pop * grow;
      b.set('transform',
        `translate(${(x - w / 2).toFixed(2)}px, ${(y - h / 2).toFixed(2)}px) scale(${sc.toFixed(4)})`);
      b.set('opacity', ease.outQuart(clamp01(show)).toFixed(3));
    },
  };
}

// ── shared bits ────────────────────────────────────────────────────────────

/** The chrome every chooser screen wears above its own content. */
const head = (text: string, step: number): string => {
  let pips = '';
  for (let i = 0; i < 3; i++) {
    pips += `<b class="${i < step ? 'done' : i === step ? 'now' : ''}"></b>`;
  }
  return `<div class="head">${title(text)}<div class="step">${pips}</div></div>`;
};

export interface Screen {
  readonly root: HTMLElement;
  update(dt: number, show: number): void;
  /** Restart this screen's arrival. Called the frame the board swings clear. */
  enter?(): void;
  dispose?(): void;
}

/** Slide-and-fade, shared by every screen so they all leave the same way. */
function present(root: Bound, show: number, dx: number): void {
  const e = ease.outQuart(clamp01(show));
  root.set('opacity', e.toFixed(3));
  root.set('transform', `translateX(${((1 - e) * dx).toFixed(2)}%)`);
}

/**
 * One element of a staggered arrival.
 *
 * A screen whose panels, roster, tray and dossier are all fully formed the
 * instant it appears is a screen that was switched on rather than one that
 * arrived. Every chooser below runs its own entrance clock and hands each part
 * a slice of it.
 */
function stagger(t: number, delay: number, span = 0.36): number {
  return ease.outQuart(clamp01((t - delay) / span));
}

// ── title ──────────────────────────────────────────────────────────────────

export interface TitleScreen extends Screen {
  /** Restart the assembly of the wordmark. */
  enter(): void;
}

export function createTitleScreen(): TitleScreen {
  const root = fromHtml(`
    <div class="scr scr-title">
      <div class="mark-wrap">
        <div class="board"></div>
        ${wordmark()}
        <div class="tagline">Roadworks Racing</div>
      </div>
      <div class="start">
        ${title('Press Start')}
        <div class="sub">Enter &nbsp;·&nbsp; Space &nbsp;·&nbsp; (A)</div>
      </div>
      <div class="cast">Cone &nbsp;·&nbsp; Sedan &nbsp;·&nbsp; Tipper &nbsp;·&nbsp; Digger
        &nbsp;·&nbsp; Shunter &nbsp;·&nbsp; Plane &nbsp;·&nbsp; Chopper</div>
    </div>`);

  const b = bind(root);
  const wrap = bind(q(root, '.mark-wrap'));
  const start = bind(q(root, '.start'));
  const startInk = bind(q(root, '.start .t'));
  const letters = Array.from(root.querySelectorAll<SVGGElement>('.wl'));
  // The SVG `transform` *attribute*, not the CSS property: a CSS transform on
  // an SVG child resolves against a transform-box the rest of this mark does
  // not share, and the letters would assemble in the wrong space.
  const lastTf = new Array<string>(letters.length).fill('');

  let t = 0;
  let clock = 0;

  return {
    root,

    enter(): void { t = 0; },

    update(dt, show): void {
      if (show <= 0) { b.set('display', 'none'); return; }
      b.set('display', 'block');
      clock += dt;
      t += dt;

      const e = ease.outQuart(clamp01(show));
      b.set('opacity', e.toFixed(3));

      // The mark assembles: one letter every 55ms, each arriving on an
      // overshoot from above. It is nine tenths of a second in total, which is
      // long enough to be a performance and short enough that nobody waiting to
      // press start ever sees it as a delay.
      //
      // **The drop is a letter and a half, not two and a half.** It used to be
      // 150 units — over two cap heights, which at any viewport this game is
      // played at is *off the top of the screen*: for the first half second of
      // the first thing anybody ever sees, half the game's name was outside the
      // frame. Fifty-two units clears the board's own top edge and no more, so
      // the letters fall onto the sign rather than in from somewhere else.
      for (let i = 0; i < letters.length; i++) {
        const u = clamp01((t - 0.16 - i * 0.055) / 0.42);
        const k = ease.outBack(u);
        const dy = (1 - k) * -52;
        const sc = lerp(1.32, 1, k);
        // Scale about the letter's own middle so it drops in rather than
        // growing out of its top-left corner.
        const tf = `translate(0 ${dy.toFixed(1)}) translate(30 56) scale(${sc.toFixed(3)}) translate(-30 -56)`;
        if (lastTf[i] !== tf) {
          lastTf[i] = tf;
          // The letter's x placement lives on the parent group; this is the
          // animation slot inside it, so kerning survives the assembly.
          letters[i]!.setAttribute('transform', tf);
        }
      }

      // A slow float on the whole board. Two frequencies, so it never returns
      // to the same place on a beat you can count.
      const bob = Math.sin(clock * 0.62) * 0.5 + Math.sin(clock * 0.31 + 1.1) * 0.3;
      const rise = (1 - ease.outQuart(clamp01(t / 0.9))) * 3;
      wrap.set('transform',
        `translate(-50%, ${(bob + rise - 50).toFixed(2)}%) scale(${(0.98 + e * 0.02).toFixed(3)})`);

      // PRESS START. A pulse rather than a blink: the prompt should breathe,
      // and it should be brightest at the moment it is most legible.
      const pulse = 0.5 + 0.5 * Math.sin(clock * 3.4);
      const on = clamp01((t - 0.95) / 0.4);
      start.set('opacity', (on * (0.42 + pulse * 0.58)).toFixed(3));
      start.set('transform',
        `translateX(-50%) scale(${(0.97 + pulse * 0.05 * on).toFixed(3)})`);
      startInk.set('color', pulse > 0.55 ? hexCss(0xFFF8F0) : hexCss(0xFFC300));
    },
  };
}

// ── character select ───────────────────────────────────────────────────────

const STAT_ROWS = [
  ['speed', 'Speed'], ['accel', 'Accel'], ['weight', 'Weight'],
  ['handling', 'Handling'], ['traction', 'Traction'],
] as const;

/** How long the change segment stands on a bar after a swap. */
const DELTA_HOLD = 1.15;

export interface RacerScreen extends Screen {
  /** The random slot is the last index; it resolves to a real machine on pick. */
  readonly randomIndex: number;
  index: number;
  vehicleAt(i: number): VehicleId | null;
  setIndex(i: number): void;
  onHover: ((i: number) => void) | null;
  onPick: ((i: number) => void) | null;
}

export function createRacerScreen(): RacerScreen {
  const defs = listVehicles();

  let tiles = '';
  for (let i = 0; i < defs.length; i++) {
    const v = defs[i]!;
    tiles += `<div class="tile" data-i="${i}" style="--tint:${hexCss(v.colors.primary)}">`
      + `<div class="face"><div class="wash"></div></div>`
      + `<div class="mark">${vehicleMark(v.id)}</div></div>`;
  }
  tiles += `<div class="tile rnd" data-i="${defs.length}" style="--tint:${hexCss(0x5FC8F5)}">`
    + `<div class="face"><div class="wash"></div></div>`
    + `<div class="mark">?</div></div>`;

  let rows = '';
  for (const [, label] of STAT_ROWS) {
    rows += `<div class="stat"><span class="sname">${label}</span>`
      + `<span class="track"><i></i><span class="fill"></span><span class="delta"></span></span>`
      + `<b class="arrow"></b></div>`;
  }

  const root = fromHtml(`
    <div class="scr scr-racer">
      ${head('Pick your machine', 0)}
      <div class="plate dossier">
        <span class="cap kind"></span>
        ${title('', 'who')}
        <div class="p blurb"></div>
        <div class="stats">${rows}</div>
      </div>
      <div class="roster">${tiles}</div>
    </div>`);

  const b = bind(root);
  const headBox = bind(q(root, '.head'));
  const dossier = bind(q(root, '.dossier'));
  const kind = bind(q(root, '.kind'));
  const name = q<HTMLElement>(root, '.who > i');
  const blurb = bind(q(root, '.blurb'));
  const nameB = bind(name);
  const rosterEl = q<HTMLElement>(root, '.roster');

  const tileNodes = Array.from(root.querySelectorAll<HTMLElement>('.tile'));
  const tileEls = tileNodes.map((el) => ({
    box: bind(el),
    face: bind(q(el, '.face')),
    s: { v: 0, vel: 0 } as Spring,
  }));
  const rover = makeRover(rosterEl, tileNodes, 'tileRing', 0.28);

  const bars = Array.from(root.querySelectorAll<HTMLElement>('.stat')).map((el) => ({
    fill: bind(q(el, '.fill')),
    delta: bind(q(el, '.delta')),
    arrow: bind(q(el, '.arrow')),
    /** Target, and where the bar has actually travelled to. */
    v: 0,
    shown: 0,
    /** The segment between the old value and the new one, and its clock. */
    from: 0,
    to: 0,
    hold: 0,
  }));

  let clock = 0;
  let tIn = 99;

  const api: RacerScreen = {
    root,
    randomIndex: defs.length,
    index: 0,
    onHover: null,
    onPick: null,
    vehicleAt(i): VehicleId | null { return defs[i]?.id ?? null; },
    setIndex(i): void {
      const n = defs.length + 1;
      const next = ((i % n) + n) % n;
      if (next === api.index) return;
      api.index = next;
      paint();
    },
    enter(): void { tIn = 0; },
    update(dt, show): void {
      if (show <= 0) { b.set('display', 'none'); return; }
      b.set('display', 'block');
      clock += dt;
      tIn += dt;
      present(b, show, 3.5);
      const e = ease.outQuart(clamp01(show));

      // ── the arrival ────────────────────────────────────────────────────
      const hIn = stagger(tIn, 0);
      headBox.set('transform', `translateX(${((1 - hIn) * -16).toFixed(1)}%)`);
      headBox.set('opacity', hIn.toFixed(3));
      const dIn = stagger(tIn, 0.1, 0.42);
      dossier.set('transform',
        `translate(${(((1 - e) * 24) + (1 - dIn) * 26).toFixed(1)}%, -50%)`);
      dossier.set('opacity', dIn.toFixed(3));

      // ── the roster ─────────────────────────────────────────────────────
      // The chosen tile lifts out of the row and grows, overshooting its rest
      // size and ringing back into it; everything else sinks back and loses
      // contrast, so the row has one subject and seven neighbours rather than
      // eight equals.
      const breathe = 1 + BREATHE_AMP * Math.sin(clock * Math.PI * 2 * BREATHE_HZ);
      for (let i = 0; i < tileEls.length; i++) {
        const t = tileEls[i]!;
        const on = i === api.index;
        const raw = springTo(t.s, on ? 1 : 0, SEL_K, SEL_C, dt);
        // The outgoing tile is allowed to sink, but only a little — a spring
        // released from 1 undershoots by a third of its travel, and a tile
        // that dips 8% reads as a fault rather than as recoil.
        const k = raw < -0.12 ? -0.12 : raw;
        const cell = stagger(tIn, 0.16 + i * 0.038, 0.4);
        const scale = (1 + k * 0.22) * (on ? lerp(1, breathe, clamp01(k)) : 1) * lerp(0.8, 1, cell);
        t.box.set('transform',
          `translateY(${(-k * 13 + (1 - cell) * 46).toFixed(2)}%) scale(${scale.toFixed(4)})`);
        t.box.set('opacity', cell.toFixed(3));
        t.face.set('filter',
          `brightness(${(0.76 + clamp01(k) * 0.24).toFixed(3)}) saturate(${(0.55 + clamp01(k) * 0.45).toFixed(3)})`);
      }
      const selK = clamp01(tileEls[api.index]?.s.v ?? 0);
      rover.update(dt, api.index,
        Math.max(-0.12, tileEls[api.index]?.s.v ?? 0) * (selK > 0 ? breathe : 1),
        show * stagger(tIn, 0.2, 0.3), 0.13, 0.22);

      // ── the stat bars ──────────────────────────────────────────────────
      for (const bar of bars) {
        // The bar travels to its new value rather than jumping, and the change
        // itself is drawn *over* the fill as a hatched segment between the old
        // reading and the new one.
        //
        // It used to be a ghost of the old value drawn *behind* the fill, which
        // meant every improvement was hidden underneath the very bar that had
        // just grown past it: swapping the cone for the sedan gains 27 points
        // of speed and 119 of weight and the player saw neither, because the
        // only visible segments were the two stats that got worse.
        bar.shown = damp(bar.shown, bar.v, 0.00004, dt);
        bar.fill.set('width', `${(bar.shown * 100).toFixed(2)}%`);
        if (bar.hold > 0) {
          bar.hold = Math.max(0, bar.hold - dt / DELTA_HOLD);
          const lo = Math.min(bar.from, bar.to);
          const hi = Math.max(bar.from, bar.to);
          const up = bar.to >= bar.from;
          const a = ease.inQuad(clamp01(bar.hold / 0.75));
          bar.delta.set('left', `${(lo * 100).toFixed(2)}%`);
          bar.delta.set('width', `${((hi - lo) * 100).toFixed(2)}%`);
          bar.delta.set('opacity', a.toFixed(3));
          bar.arrow.set('opacity', a.toFixed(3));
          bar.delta.cls('up', up);
          bar.arrow.cls('up', up);
          bar.arrow.text(up ? '▲' : '▼');
        } else {
          bar.delta.set('opacity', '0');
          bar.arrow.set('opacity', '0');
        }
      }
    },
  };

  function setBars(get: (key: (typeof STAT_ROWS)[number][0]) => number): void {
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]!;
      const next = clamp01(get(STAT_ROWS[i]![0]));
      // Only claim a change when there is one. A repaint that reports a delta
      // of zero puts a hatched sliver of nothing on five bars at once.
      if (Math.abs(next - bar.v) > 0.004) {
        bar.from = bar.v;
        bar.to = next;
        bar.hold = 1;
      }
      bar.v = next;
    }
  }

  function paint(): void {
    const def = defs[api.index];
    if (!def) {
      kind.text('Racer 8 of 8');
      nameB.text('Surprise Me');
      blurb.text('Let the site pick. It has opinions.');
      setBars(() => 0.5);
      return;
    }
    kind.text(`Racer ${api.index + 1} of ${defs.length}`);
    nameB.text(def.name);
    blurb.text(def.blurb);
    setBars((key) => def.stats[key]);
  }
  paint();
  // Nothing was traded on the very first paint — there is no previous machine.
  for (const bar of bars) { bar.hold = 0; bar.shown = bar.v; }

  const hit = (ev: Event): number => {
    const el = (ev.target as HTMLElement | null)?.closest?.('[data-i]') as HTMLElement | null;
    return el ? Number(el.dataset.i) : -1;
  };
  root.addEventListener('pointermove', (ev) => {
    const i = hit(ev);
    if (i >= 0 && i !== api.index) api.onHover?.(i);
  });
  root.addEventListener('pointerdown', (ev) => {
    const i = hit(ev);
    if (i >= 0) api.onPick?.(i);
  });

  return api;
}

// ── cup & course ───────────────────────────────────────────────────────────

export interface CupDef {
  id: string;
  name: string;
  color: number;
}

/** The cups, and the order they are presented in. A cup with no courses in it
 *  yet is still shown — this is a game about roadworks, and a circuit that is
 *  not open yet is the most on-brand thing in the product. It cannot be
 *  entered, and it says so on its face. */
export const CUPS: CupDef[] = [
  { id: 'hazard', name: 'Hazard Cup', color: 0xFFC300 },
  { id: 'detour', name: 'Detour Cup', color: 0xFF6B1A },
  { id: 'gravel', name: 'Gravel Cup', color: 0x6FE04A },
  { id: 'summit', name: 'Summit Cup', color: 0x5FC8F5 },
];

/** Metres, measured along the control points the track is actually built from. */
function courseLength(c: CourseDef): number {
  let d = 0;
  for (let i = 0; i < c.points.length; i++) {
    const a = c.points[i]!;
    const b = c.points[(i + 1) % c.points.length]!;
    d += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return d;
}

export interface CourseScreen extends Screen {
  /** 0 = the cup row has focus, 1 = the course row. */
  row: 0 | 1;
  cupIndex: number;
  courseIndex: number;
  readonly cupCount: number;
  courseCount(): number;
  coursesOf(cupIndex: number): CourseDef[];
  setCup(i: number): void;
  setCourse(i: number): void;
  setRow(r: 0 | 1): void;
  onHover: ((row: 0 | 1, i: number) => void) | null;
  onPick: ((row: 0 | 1, i: number) => void) | null;
}

export function createCourseScreen(): CourseScreen {
  const all = listCourses();
  const byCup = new Map<string, CourseDef[]>();
  for (const cup of CUPS) byCup.set(cup.id, all.filter((c) => c.cup === cup.id));
  /** The widest cup decides how many card slots exist. */
  const SLOTS = Math.max(4, ...CUPS.map((c) => (byCup.get(c.id) ?? []).length));

  let tabs = '';
  for (let i = 0; i < CUPS.length; i++) {
    const cup = CUPS[i]!;
    const open = (byCup.get(cup.id) ?? []).length > 0;
    tabs += `<div class="plate vis cupTab${open ? '' : ' locked'}" data-row="0" data-i="${i}">`
      + cupEmblem(cup.color, !open)
      + title(cup.name)
      + `<div class="held"></div></div>`;
  }

  // Card slots. Built once and shown or hidden, so adding a course to the
  // registry fills one in without a line changing here.
  let cards = '';
  for (let i = 0; i < SLOTS; i++) {
    cards += `<div class="plate vis card courseCard" data-row="1" data-i="${i}">`
      + `<div class="mapbox"></div>`
      + title('', 'nm')
      + `<div class="facts">`
      + `<div><span class="v len"></span><span class="k">Metres</span></div>`
      + `<div><span class="v lap"></span><span class="k">Laps</span></div>`
      + `<div><span class="v tot"></span><span class="k">Total km</span></div>`
      + `</div><div class="shut"><span>In construction</span></div><div class="held"></div></div>`;
  }

  const root = fromHtml(`
    <div class="scr scr-course">
      ${head('Choose a circuit', 1)}
      <div class="cups">${tabs}</div>
      <div class="cards">${cards}</div>
      <div class="plate brief">
        <div class="em-wrap">${cupEmblem(CUPS[0]!.color)}</div>
        <div><span class="cap cupname">Hazard Cup</span>${title('Round 1', 'rnd')}
          <div class="pips"></div></div>
      </div>
    </div>`);

  const b = bind(root);
  const headBox = bind(q(root, '.head'));
  const cupsBox = bind(q(root, '.cups'));
  const cardsBox = bind(q(root, '.cards'));
  const briefBox = bind(q(root, '.brief'));
  const briefEm = q<HTMLElement>(root, '.brief .em-wrap');
  const briefCup = bind(q(root, '.brief .cupname'));
  const briefRound = bind(q(root, '.brief .rnd > i'));
  const briefPips = q<HTMLElement>(root, '.brief .pips');

  const tabNodes = Array.from(root.querySelectorAll<HTMLElement>('.cupTab'));
  const tabEls = tabNodes.map((el) => ({
    box: bind(el), held: bind(q(el, '.held')), s: { v: 0, vel: 0 } as Spring, held01: 0,
  }));
  const cardNodes = Array.from(root.querySelectorAll<HTMLElement>('.courseCard'));
  const cardEls = cardNodes.map((el) => ({
    el,
    box: bind(el),
    held: bind(q(el, '.held')),
    shut: bind(q(el, '.shut')),
    mapbox: q<HTMLElement>(el, '.mapbox'),
    nm: bind(q(el, '.nm > i')),
    len: bind(q(el, '.len')),
    lap: bind(q(el, '.lap')),
    tot: bind(q(el, '.tot')),
    s: { v: 0, vel: 0 } as Spring,
    held01: 0,
  }));

  const cupRover = makeRover(q<HTMLElement>(root, '.cups'), tabNodes, 'cupRing', 0.2);
  const cardRover = makeRover(q<HTMLElement>(root, '.cards'), cardNodes, 'cardRing', 0.26);

  let clock = 0;
  let tIn = 99;

  const api: CourseScreen = {
    root,
    row: 1,
    cupIndex: 0,
    courseIndex: 0,
    cupCount: CUPS.length,
    coursesOf(i): CourseDef[] { return byCup.get(CUPS[i]?.id ?? '') ?? []; },
    courseCount(): number { return api.coursesOf(api.cupIndex).length; },
    onHover: null,
    onPick: null,
    setCup(i): void {
      const n = CUPS.length;
      const next = ((i % n) + n) % n;
      if (next === api.cupIndex) return;
      api.cupIndex = next;
      api.courseIndex = 0;
      paint();
    },
    setCourse(i): void {
      const n = Math.max(1, api.courseCount());
      const next = ((i % n) + n) % n;
      if (next === api.courseIndex) return;
      api.courseIndex = next;
      paintBrief();
    },
    setRow(r): void { api.row = r; },
    enter(): void { tIn = 0; },
    update(dt, show): void {
      if (show <= 0) { b.set('display', 'none'); return; }
      b.set('display', 'block');
      clock += dt;
      tIn += dt;
      present(b, show, 3.5);
      const e = ease.outQuart(clamp01(show));
      const breathe = 1 + BREATHE_AMP * Math.sin(clock * Math.PI * 2 * BREATHE_HZ);

      const hIn = stagger(tIn, 0);
      headBox.set('transform', `translateX(${((1 - hIn) * -16).toFixed(1)}%)`);
      headBox.set('opacity', hIn.toFixed(3));
      const cupIn = stagger(tIn, 0.08, 0.34);
      const cardIn = stagger(tIn, 0.2, 0.42);
      cupsBox.set('transform',
        `translate(-50%, ${((1 - e) * -90 + (1 - cupIn) * -50).toFixed(1)}%)`);
      cupsBox.set('opacity', cupIn.toFixed(3));
      cardsBox.set('transform',
        `translate(-50%, ${((1 - e) * 40 + (1 - cardIn) * 22).toFixed(1)}%)`);
      const briefIn = stagger(tIn, 0.34, 0.4);
      briefBox.set('opacity', briefIn.toFixed(3));
      briefBox.set('transform', `translateY(${((1 - briefIn) * 60).toFixed(1)}%)`);

      // **The row that has focus wears the ring; the row that does not wears a
      // keyline.** They used to differ by nothing but the opacity of the same
      // gold ring, 1.0 against 0.55, which measured as no difference at all:
      // pressing the key the prompt rail advertises changed the screen in no
      // way a player could see. Now the unfocused row's choice is marked by a
      // thin cream keyline with no glow and no lift, its plates are dimmed, and
      // the roving gold cursor is only ever on the row that is live.
      const live = api.courseCount();
      const cupsHot = api.row === 0;

      for (let i = 0; i < tabEls.length; i++) {
        const t = tabEls[i]!;
        const on = cupsHot && i === api.cupIndex;
        const k = Math.max(-0.12, springTo(t.s, on ? 1 : 0, SEL_K, SEL_C, dt));
        const held = i === api.cupIndex && !cupsHot ? 1 : 0;
        t.held01 = damp(t.held01, held, 0.00004, dt);
        t.held.set('opacity', t.held01.toFixed(3));
        const sc = (1 + k * 0.06) * (on ? lerp(1, breathe, clamp01(k)) : 1);
        t.box.set('transform',
          `translateY(${(-k * 9).toFixed(2)}%) scale(${sc.toFixed(4)})`);
        t.box.set('filter', `brightness(${(cupsHot ? 1 : 0.74).toFixed(2)})`);
        t.box.cls('hot', on);
      }
      cupRover.update(dt, api.cupIndex,
        cupsHot ? Math.max(-0.12, tabEls[api.cupIndex]?.s.v ?? 0) * breathe : 0,
        cupsHot ? show * cupIn : 0, 0.09, 0.06);

      for (let i = 0; i < cardEls.length; i++) {
        const c = cardEls[i]!;
        if (i >= Math.max(1, live)) { c.box.set('display', 'none'); continue; }
        c.box.set('display', 'flex');
        const on = !cupsHot && i === api.courseIndex && live > 0;
        const k = Math.max(-0.12, springTo(c.s, on ? 1 : 0, SEL_K, SEL_C, dt));
        const held = i === api.courseIndex && cupsHot && live > 0 ? 1 : 0;
        c.held01 = damp(c.held01, held, 0.00004, dt);
        c.held.set('opacity', c.held01.toFixed(3));
        const cell = stagger(tIn, 0.22 + i * 0.05, 0.4);
        const sc = (1 + k * 0.05) * (on ? lerp(1, breathe, clamp01(k)) : 1) * lerp(0.9, 1, cell);
        c.box.set('transform',
          `translateY(${(-k * 4 + (1 - cell) * 30).toFixed(2)}%) scale(${sc.toFixed(4)})`);
        c.box.set('opacity', cell.toFixed(3));
        c.box.set('filter', `brightness(${(cupsHot ? 0.7 : 0.72 + clamp01(k) * 0.28).toFixed(3)})`);
        c.box.cls('hot', on);
        c.shut.set('opacity', live > 0 ? '0' : '1');
      }
      cardRover.update(dt, api.courseIndex,
        !cupsHot && live > 0 ? Math.max(-0.12, cardEls[api.courseIndex]?.s.v ?? 0) * breathe : 0,
        !cupsHot && live > 0 ? show * cardIn : 0, 0.04, 0.05);
    },
  };

  function paintBrief(): void {
    const cup = CUPS[api.cupIndex]!;
    const list = api.coursesOf(api.cupIndex);
    briefEm.innerHTML = cupEmblem(cup.color, list.length === 0);
    briefCup.text(cup.name);
    briefRound.text(list.length === 0
      ? 'Surveying' : `Round ${api.courseIndex + 1} of ${list.length}`);
    let pips = '';
    for (let i = 0; i < Math.max(1, list.length); i++) {
      pips += `<b class="${list.length > 0 && i === api.courseIndex ? 'on' : ''}"></b>`;
    }
    briefPips.innerHTML = pips;
  }

  function paint(): void {
    const list = api.coursesOf(api.cupIndex);
    for (let i = 0; i < cardEls.length; i++) {
      const c = cardEls[i]!;
      const course = list[i];
      if (course) {
        c.mapbox.innerHTML = courseMap(course.points);
        c.nm.text(course.name);
        const len = Math.round(courseLength(course));
        const laps = course.laps ?? 3;
        c.len.text(String(len));
        c.lap.text(String(laps));
        c.tot.text(((len * laps) / 1000).toFixed(1));
      } else if (i === 0) {
        // The placeholder a closed cup shows: the card stays, wearing tape.
        c.mapbox.innerHTML = plannedMap();
        c.nm.text('Surveying');
        c.len.text('—');
        c.lap.text('—');
        c.tot.text('—');
      }
    }
    paintBrief();
  }
  paint();

  const hit = (ev: Event): { row: 0 | 1; i: number } | null => {
    const el = (ev.target as HTMLElement | null)?.closest?.('[data-i]') as HTMLElement | null;
    if (!el) return null;
    return { row: Number(el.dataset.row) === 0 ? 0 : 1, i: Number(el.dataset.i) };
  };
  root.addEventListener('pointermove', (ev) => {
    const h = hit(ev);
    if (h) api.onHover?.(h.row, h.i);
  });
  root.addEventListener('pointerdown', (ev) => {
    const h = hit(ev);
    if (h) api.onPick?.(h.row, h.i);
  });

  return api;
}

// ── engine class ───────────────────────────────────────────────────────────

const CLASS_COPY: Record<EngineClass, string> = {
  '50cc': 'Room to look around. The pack waits for you.',
  '100cc': 'They stop being polite about the racing line.',
  '150cc': 'The real game. Mini-turbos or nothing.',
  '200cc': 'The brakes become a mechanic. Good luck.',
};

export interface ClassScreen extends Screen {
  index: number;
  readonly classes: EngineClass[];
  setIndex(i: number): void;
  onHover: ((i: number) => void) | null;
  onPick: ((i: number) => void) | null;
}

export function createClassScreen(ctx: GameContext): ClassScreen {
  const classes = Object.keys(ctx.config.race.classes) as EngineClass[];

  let cards = '';
  for (let i = 0; i < classes.length; i++) {
    const id = classes[i]!;
    // The whole headline is drawn geometry — `50CC` is entirely inside the
    // HUD's own glyph table — so the loudest thing on this screen is cut from
    // exactly the same face as the place indicator during the race.
    cards += `<div class="plate vis card cc" data-i="${i}">`
      + `<div class="num">${glyphRun(id.toUpperCase())}</div>`
      + `<div class="meter"><i></i></div>`
      + `<div class="p desc">${CLASS_COPY[id]}</div></div>`;
  }

  const root = fromHtml(`
    <div class="scr scr-class">
      ${head('Engine class', 2)}
      <div class="cards">${cards}</div>
      <div class="plate go">
        <span class="key">↵</span>
        <div>${title('Start race')}<div class="sub">Space &nbsp;·&nbsp; (A)</div></div>
        <div class="glow"></div>
      </div>
    </div>`);

  const b = bind(root);
  const headBox = bind(q(root, '.head'));
  const cardsBox = bind(q(root, '.cards'));
  const cardsEl = q<HTMLElement>(root, '.cards');
  const go = bind(q(root, '.go'));
  const goGlow = bind(q(root, '.go .glow'));

  const cardNodes = Array.from(root.querySelectorAll<HTMLElement>('.cc'));
  const cardEls = cardNodes.map((el, i) => {
    const id = classes[i]!;
    const meter = bind(q(el, '.meter i'));
    // The speed multiplier the simulation actually uses, mapped so the slowest
    // class is a third of the bar rather than empty — 50cc is a choice, not a
    // deficiency.
    const mul = ctx.config.race.classes[id].speedMul;
    meter.set('width', `${(lerp(34, 100, clamp01((mul - 0.72) / 0.52))).toFixed(1)}%`);
    return { box: bind(el), s: { v: 0, vel: 0 } as Spring };
  });
  const rover = makeRover(cardsEl, cardNodes, 'classRing', 0.26);

  let clock = 0;
  let tIn = 99;

  const api: ClassScreen = {
    root,
    classes,
    index: Math.max(0, classes.indexOf(ctx.config.race.defaultClass as EngineClass)),
    onHover: null,
    onPick: null,
    setIndex(i): void {
      const n = classes.length;
      api.index = ((i % n) + n) % n;
    },
    enter(): void { tIn = 0; },
    update(dt, show): void {
      if (show <= 0) { b.set('display', 'none'); return; }
      b.set('display', 'block');
      clock += dt;
      tIn += dt;
      present(b, show, 3.5);
      const e = ease.outQuart(clamp01(show));
      const breathe = 1 + BREATHE_AMP * Math.sin(clock * Math.PI * 2 * BREATHE_HZ);

      const hIn = stagger(tIn, 0);
      headBox.set('transform', `translateX(${((1 - hIn) * -16).toFixed(1)}%)`);
      headBox.set('opacity', hIn.toFixed(3));
      const cardIn = stagger(tIn, 0.1, 0.4);
      cardsBox.set('transform',
        `translate(-50%, ${((1 - e) * 30 + (1 - cardIn) * 20).toFixed(1)}%)`);

      for (let i = 0; i < cardEls.length; i++) {
        const c = cardEls[i]!;
        const on = i === api.index;
        const k = Math.max(-0.12, springTo(c.s, on ? 1 : 0, SEL_K, SEL_C, dt));
        const cell = stagger(tIn, 0.14 + i * 0.05, 0.4);
        const sc = (1 + k * 0.075) * (on ? lerp(1, breathe, clamp01(k)) : 1) * lerp(0.9, 1, cell);
        c.box.set('transform',
          `translateY(${(-k * 5 + (1 - cell) * 26).toFixed(2)}%) scale(${sc.toFixed(4)})`);
        c.box.set('opacity', cell.toFixed(3));
        c.box.set('filter', `brightness(${(0.72 + clamp01(k) * 0.28).toFixed(3)})`);
        c.box.cls('hot', on);
      }
      rover.update(dt, api.index,
        Math.max(-0.12, cardEls[api.index]?.s.v ?? 0) * breathe,
        show * cardIn, 0.05, 0.075);

      // The call to action. A plate, so it is as legible as everything else on
      // the screen; the pulse is on the ring around it rather than on the ink,
      // because a word that changes colour twice a second is a word nobody can
      // read at the moment they are meant to read it.
      const pulse = 0.5 + 0.5 * Math.sin(clock * 3.2);
      const goIn = stagger(tIn, 0.3, 0.4);
      go.set('opacity', (e * goIn).toFixed(3));
      go.set('transform',
        `translateY(${((1 - goIn) * 70).toFixed(1)}%) scale(${(1 + pulse * 0.022).toFixed(4)})`);
      goGlow.set('opacity', (0.45 + pulse * 0.55).toFixed(3));
    },
  };

  const hit = (ev: Event): number => {
    const el = (ev.target as HTMLElement | null)?.closest?.('[data-i]') as HTMLElement | null;
    return el ? Number(el.dataset.i) : -1;
  };
  root.addEventListener('pointermove', (ev) => {
    const i = hit(ev);
    if (i >= 0) api.onHover?.(i);
  });
  root.addEventListener('pointerdown', (ev) => {
    const i = hit(ev);
    if (i >= 0) api.onPick?.(i);
  });
  // The whole plate is the button, not just whatever `data-i` is under the
  // pointer: a call to action you can only press by hitting one of the cards is
  // not a call to action.
  q(root, '.go').addEventListener('pointerdown', () => api.onPick?.(api.index));

  return api;
}
