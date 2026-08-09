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

import { clamp01, damp, ease, lerp } from '../../core/math.ts';
import { listVehicles } from '../../vehicles/registry.ts';
import { listCourses } from '../../track/courses/index.ts';
import { glyphRun } from '../glyphs.ts';
import { vehicleMark, wordmark } from './art.ts';
import {
  bind, courseMap, cupEmblem, fromHtml, hexCss, q, title, type Bound,
} from './chrome.ts';
import type { CourseDef, EngineClass, GameContext, VehicleId } from '../../types.ts';

export const CSS_SCREENS = `
#menu .scr-course .cups { transform: translateX(-50%); }
#menu .scr-course .cards { top: calc(var(--ey) + var(--u) * 9.4); }
#menu .scr-class .cards { top: calc(var(--ey) + var(--u) * 7.2); }
#menu .scr-class .go {
  position: absolute; left: 50%; bottom: calc(var(--eb) + var(--u) * 3.4); text-align: center;
}
#menu .scr-class .go .t { font-size: calc(var(--u) * 1.7); }
#menu .scr-class .go .sub {
  margin-top: calc(var(--u) * .34); font-size: calc(var(--u) * .66); font-weight: 800;
  letter-spacing: .2em; text-transform: uppercase; color: rgba(255,248,240,.6);
}
#menu .cupTab.locked .t { color: rgba(255,248,240,.42); }
#menu .cupTab.locked { filter: saturate(.3) brightness(.72); }
#menu .card .mapbox { display: block; }
#menu .scr-racer .roster .tile.rnd .mark {
  display: flex; align-items: center; justify-content: center;
  font-size: calc(var(--u) * 3.4); font-weight: 900; color: var(--yellow);
  text-shadow: 0 calc(var(--u) * .1) 0 #0A0D13, 0 calc(var(--u) * .22) calc(var(--u) * .3) rgba(0,0,0,.7);
}
`;

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
  dispose?(): void;
}

/** Slide-and-fade, shared by every screen so they all leave the same way. */
function present(root: Bound, show: number, dx: number): void {
  const e = ease.outQuart(clamp01(show));
  root.set('opacity', e.toFixed(3));
  root.set('transform', `translateX(${((1 - e) * dx).toFixed(2)}%)`);
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
      for (let i = 0; i < letters.length; i++) {
        const u = clamp01((t - 0.16 - i * 0.055) / 0.42);
        const k = ease.outBack(u);
        const dy = (1 - k) * -150;
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

export interface RacerScreen extends Screen {
  readonly count: number;
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
      + `<div class="mark">${vehicleMark(v.id)}</div>`
      + `<div class="ring"></div></div>`;
  }
  tiles += `<div class="tile rnd" data-i="${defs.length}" style="--tint:${hexCss(0x5FC8F5)}">`
    + `<div class="face"><div class="wash"></div></div>`
    + `<div class="mark">?</div><div class="ring"></div></div>`;

  let rows = '';
  for (const [, label] of STAT_ROWS) {
    rows += `<div class="stat"><span class="sname">${label}</span>`
      + `<span class="track"><i></i><span class="ghost"></span><span class="fill"></span></span></div>`;
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
  const dossier = bind(q(root, '.dossier'));
  const kind = bind(q(root, '.kind'));
  const name = q<HTMLElement>(root, '.who > i');
  const blurb = bind(q(root, '.blurb'));
  const nameB = bind(name);

  const tileEls = Array.from(root.querySelectorAll<HTMLElement>('.tile')).map((el) => ({
    box: bind(el),
    ring: bind(q(el, '.ring')),
    face: bind(q(el, '.face')),
    sel: 0,
  }));

  const bars = Array.from(root.querySelectorAll<HTMLElement>('.stat')).map((el) => ({
    fill: bind(q(el, '.fill')),
    ghost: bind(q(el, '.ghost')),
    /** Target, and where the bar has actually travelled to. */
    v: 0,
    shown: 0,
    ghostV: 0,
    ghostA: 0,
  }));

  const api: RacerScreen = {
    root,
    count: defs.length + 1,
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
    update(dt, show): void {
      if (show <= 0) { b.set('display', 'none'); return; }
      b.set('display', 'block');
      present(b, show, 3.5);
      const e = ease.outQuart(clamp01(show));
      dossier.set('transform', `translate(${((1 - e) * 24).toFixed(1)}%, -50%)`);

      for (let i = 0; i < tileEls.length; i++) {
        const t = tileEls[i]!;
        t.sel = damp(t.sel, i === api.index ? 1 : 0, 0.00006, dt);
        const k = ease.outBack(t.sel);
        // The chosen tile lifts out of the row and grows. Everything else sinks
        // back and loses contrast, so the row has one subject and seven
        // neighbours rather than eight equals.
        t.box.set('transform',
          `translateY(${(-k * 13).toFixed(2)}%) scale(${(1 + k * 0.22).toFixed(3)})`);
        t.ring.set('opacity', t.sel.toFixed(3));
        t.face.set('filter',
          `brightness(${(0.76 + t.sel * 0.24).toFixed(3)}) saturate(${(0.55 + t.sel * 0.45).toFixed(3)})`);
      }

      for (const bar of bars) {
        // The bar travels to its new value rather than jumping, and the old one
        // is left standing for a beat: swapping machines should *show* you what
        // you just traded away.
        bar.shown = damp(bar.shown, bar.v, 0.00004, dt);
        bar.fill.set('width', `${(bar.shown * 100).toFixed(2)}%`);
        if (bar.ghostA > 0) {
          bar.ghostA = Math.max(0, bar.ghostA - dt / 0.85);
          bar.ghost.set('width', `${(bar.ghostV * 100).toFixed(2)}%`);
          bar.ghost.set('opacity', ease.inQuad(bar.ghostA).toFixed(3));
        }
      }
    },
  };

  function paint(): void {
    const def = defs[api.index];
    if (!def) {
      kind.text('Racer 8 of 8');
      nameB.text('Surprise Me');
      blurb.text('Let the site pick. It has opinions.');
      for (const bar of bars) {
        bar.ghostV = bar.v;
        bar.ghostA = 1;
        bar.v = 0.5;
      }
      return;
    }
    kind.text(`Racer ${api.index + 1} of ${defs.length}`);
    nameB.text(def.name);
    blurb.text(def.blurb);
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]!;
      const key = STAT_ROWS[i]![0];
      bar.ghostV = bar.v;
      bar.ghostA = 1;
      bar.v = clamp01(def.stats[key]);
    }
  }
  paint();

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

  let tabs = '';
  for (let i = 0; i < CUPS.length; i++) {
    const cup = CUPS[i]!;
    const open = (byCup.get(cup.id) ?? []).length > 0;
    tabs += `<div class="plate vis cupTab${open ? '' : ' locked'}" data-row="0" data-i="${i}">`
      + cupEmblem(cup.color, !open)
      + title(cup.name)
      + `<div class="sel"></div></div>`;
  }

  // Four card slots. There is one circuit today and there will be more; the
  // slots are built once and shown or hidden, so adding a course to the
  // registry fills one in without a line changing here.
  let cards = '';
  for (let i = 0; i < 4; i++) {
    cards += `<div class="plate vis card courseCard" data-row="1" data-i="${i}">`
      + `<div class="mapbox"></div>`
      + title('', 'nm')
      + `<div class="facts">`
      + `<div><span class="v len"></span><span class="k">Metres</span></div>`
      + `<div><span class="v lap"></span><span class="k">Laps</span></div>`
      + `<div><span class="v tot"></span><span class="k">Total km</span></div>`
      + `</div><div class="shut"><span>In construction</span></div><div class="sel"></div></div>`;
  }

  const root = fromHtml(`
    <div class="scr scr-course">
      ${head('Choose a circuit', 1)}
      <div class="cups">${tabs}</div>
      <div class="cards">${cards}</div>
    </div>`);

  const b = bind(root);
  const cupsBox = bind(q(root, '.cups'));
  const cardsBox = bind(q(root, '.cards'));

  const tabEls = Array.from(root.querySelectorAll<HTMLElement>('.cupTab')).map((el) => ({
    box: bind(el), sel: bind(q(el, '.sel')), v: 0,
  }));
  const cardEls = Array.from(root.querySelectorAll<HTMLElement>('.courseCard')).map((el) => ({
    el,
    box: bind(el),
    sel: bind(q(el, '.sel')),
    shut: bind(q(el, '.shut')),
    mapbox: q<HTMLElement>(el, '.mapbox'),
    nm: bind(q(el, '.nm > i')),
    len: bind(q(el, '.len')),
    lap: bind(q(el, '.lap')),
    tot: bind(q(el, '.tot')),
    v: 0,
  }));

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
    },
    setRow(r): void { api.row = r; },
    update(dt, show): void {
      if (show <= 0) { b.set('display', 'none'); return; }
      b.set('display', 'block');
      present(b, show, 3.5);
      const e = ease.outQuart(clamp01(show));
      cupsBox.set('transform', `translate(-50%, ${((1 - e) * -90).toFixed(1)}%)`);
      cardsBox.set('transform', `translate(-50%, ${((1 - e) * 40).toFixed(1)}%)`);

      for (let i = 0; i < tabEls.length; i++) {
        const t = tabEls[i]!;
        const want = api.row === 0 && i === api.cupIndex ? 1
          : i === api.cupIndex ? 0.55 : 0;
        t.v = damp(t.v, want, 0.00006, dt);
        t.sel.set('opacity', t.v.toFixed(3));
        t.box.set('transform', `translateY(${(-t.v * 8).toFixed(2)}%)`);
      }
      const live = api.courseCount();
      for (let i = 0; i < cardEls.length; i++) {
        const c = cardEls[i]!;
        if (i >= Math.max(1, live)) { c.box.set('display', 'none'); continue; }
        c.box.set('display', 'flex');
        const want = api.row === 1 && i === api.courseIndex && live > 0 ? 1
          : i === api.courseIndex && live > 0 ? 0.5 : 0;
        c.v = damp(c.v, want, 0.00006, dt);
        c.sel.set('opacity', c.v.toFixed(3));
        c.box.set('transform',
          `translateY(${(-c.v * 4).toFixed(2)}%) scale(${(1 + c.v * 0.045).toFixed(3)})`);
        c.shut.set('opacity', live > 0 ? '0' : '1');
      }
    },
  };

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
        c.mapbox.innerHTML = '';
        c.nm.text('Surveying');
        c.len.text('—');
        c.lap.text('—');
        c.tot.text('—');
      }
    }
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
      + `<div class="p desc">${CLASS_COPY[id]}</div>`
      + `<div class="sel"></div></div>`;
  }

  const root = fromHtml(`
    <div class="scr scr-class">
      ${head('Engine class', 2)}
      <div class="cards">${cards}</div>
      <div class="go">${title('Start race')}<div class="sub">Enter &nbsp;·&nbsp; Space &nbsp;·&nbsp; (A)</div></div>
    </div>`);

  const b = bind(root);
  const cardsBox = bind(q(root, '.cards'));
  const go = bind(q(root, '.go'));
  const goInk = bind(q(root, '.go .t'));

  const cardEls = Array.from(root.querySelectorAll<HTMLElement>('.cc')).map((el, i) => {
    const id = classes[i]!;
    const meter = bind(q(el, '.meter i'));
    // The speed multiplier the simulation actually uses, mapped so the slowest
    // class is a third of the bar rather than empty — 50cc is a choice, not a
    // deficiency.
    const mul = ctx.config.race.classes[id].speedMul;
    meter.set('width', `${(lerp(34, 100, clamp01((mul - 0.72) / 0.52))).toFixed(1)}%`);
    return { box: bind(el), sel: bind(q(el, '.sel')), v: 0 };
  });

  let clock = 0;

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
    update(dt, show): void {
      if (show <= 0) { b.set('display', 'none'); return; }
      b.set('display', 'block');
      clock += dt;
      present(b, show, 3.5);
      const e = ease.outQuart(clamp01(show));
      cardsBox.set('transform', `translate(-50%, ${((1 - e) * 30).toFixed(1)}%)`);

      for (let i = 0; i < cardEls.length; i++) {
        const c = cardEls[i]!;
        c.v = damp(c.v, i === api.index ? 1 : 0, 0.00006, dt);
        c.sel.set('opacity', c.v.toFixed(3));
        c.box.set('transform',
          `translateY(${(-c.v * 4).toFixed(2)}%) scale(${(1 + c.v * 0.05).toFixed(3)})`);
        c.box.set('filter', `brightness(${(0.72 + c.v * 0.28).toFixed(3)})`);
      }

      const pulse = 0.5 + 0.5 * Math.sin(clock * 3.6);
      go.set('opacity', (e * (0.5 + pulse * 0.5)).toFixed(3));
      go.set('transform', `translateX(-50%) scale(${(0.98 + pulse * 0.04).toFixed(3)})`);
      goInk.set('color', pulse > 0.55 ? hexCss(0xFFF8F0) : hexCss(0xFFC300));
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

  return api;
}
