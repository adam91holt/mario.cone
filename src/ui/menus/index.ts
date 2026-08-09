// The front-end: everything that happens before the flag.
//
// Four screens — title, machine, circuit, class — one 3D set behind them, and
// a single job at the end of it: call the race the engine already knows how to
// start. This module never builds a field, never places a grid and never
// touches the simulation. It collects four choices and hands them to
// `harness.reset()`, which is `startRace()` in `main.ts` under another name.
//
// ── How it takes input ─────────────────────────────────────────────────────
//
// Through `ctx.input`, like everything else in this game, and for the same
// reason: the automated critics inject synthetic input and a direct DOM read
// would make the whole front-end untestable. The keyboard and gamepad handlers
// in this file do not *read* input for the menus — they translate it into
// one-shots on the shared input controller (`menu.up`, `menu.ok`, …), which the
// nav then consumes out of `ctx.inputState.pressed` inside `fixedUpdate`. A
// reviewer typing `__GAME.press('menu.down')` walks the roster by exactly the
// path a player's arrow key does, because it is the same path.
//
// The semantic names exist because the obvious mapping does not work: on a
// gamepad the A button *is* `accel`, and on a keyboard the up arrow *is*
// `accel` too, so "A confirms" and "up moves up" are the same bit. Naming the
// menu's own verbs and translating into them at the edge is what lets a
// keyboard and a pad both feel right.
//
// ── How it opens and closes ────────────────────────────────────────────────
//
// `reset()` fires on every race start, from any source. The first one is the
// boot race in `main.ts`, and that is the one that raises the title screen;
// every one after it closes the menus, which is what keeps the capture harness
// — whose first act is always `reset()` — from ever having to know this module
// exists.

import { clamp01, damp, ease, makeRng } from '../../core/math.ts';
import { getVehicle, listVehicles } from '../../vehicles/registry.ts';
import { bind, CSS_MENU, fromHtml, hintKey, q, title } from './chrome.ts';
import { createStage, type ShotName, type Stage } from './stage.ts';
import {
  CSS_SCREENS, CUPS,
  createClassScreen, createCourseScreen, createRacerScreen, createTitleScreen,
  type ClassScreen, type CourseScreen, type RacerScreen, type TitleScreen,
} from './screens.ts';
import type { EngineClass, GameContext, GameSystem, RaceConfig, VehicleId } from '../../types.ts';

type ScreenName = 'title' | 'racer' | 'course' | 'class';

/** Which shot the set holds for each screen. */
const SHOT: Record<ScreenName, ShotName> = {
  title: 'title', racer: 'hero', course: 'board', class: 'board',
};

/** What the prompt rail says on each screen. */
const HINTS: Record<ScreenName, string> = {
  title: '',
  racer: hintKey('◀ ▶', 'Choose') + hintKey('↵', 'Select') + hintKey('Esc', 'Back'),
  course: hintKey('▲ ▼', 'Cup / Circuit') + hintKey('◀ ▶', 'Choose')
    + hintKey('↵', 'Select') + hintKey('Esc', 'Back'),
  class: hintKey('◀ ▶', 'Choose') + hintKey('↵', 'Start race') + hintKey('Esc', 'Back'),
};

/** Menu verbs, and the keys that produce them. */
const KEYS: Record<string, string> = {
  ArrowUp: 'menu.up', KeyW: 'menu.up',
  ArrowDown: 'menu.down', KeyS: 'menu.down',
  ArrowLeft: 'menu.left', KeyA: 'menu.left',
  ArrowRight: 'menu.right', KeyD: 'menu.right',
  Enter: 'menu.ok', NumpadEnter: 'menu.ok', Space: 'menu.ok', KeyE: 'menu.ok',
  Escape: 'menu.back', Backspace: 'menu.back', KeyQ: 'menu.back',
};

/** Pad buttons in the standard mapping: d-pad, A, B, and start. */
const PAD_BUTTONS: Array<[number, string]> = [
  [12, 'menu.up'], [13, 'menu.down'], [14, 'menu.left'], [15, 'menu.right'],
  [0, 'menu.ok'], [9, 'menu.ok'], [1, 'menu.back'], [8, 'menu.back'],
];

/** How long a held direction waits before it starts repeating, and how fast. */
const REPEAT_DELAY = 0.36;
const REPEAT_RATE = 0.11;

export interface MenuProbe {
  open: boolean;
  screen: ScreenName;
  vehicleId: VehicleId;
  courseId: string;
  cup: string;
  engineClass: EngineClass;
  wipe: number;
}

export function createMenuSystem(ctx: GameContext): GameSystem {
  // No document (a typecheck, a headless unit run): an inert system rather than
  // an exception on the first DOM call.
  if (typeof document === 'undefined') return { name: 'menus', order: 110 };

  const style = document.createElement('style');
  style.textContent = CSS_MENU + CSS_SCREENS;
  document.head.appendChild(style);

  const root = fromHtml(`
    <div id="menu">
      <div class="grade"></div>
      <div class="rail top"><i></i></div>
      <div class="rail bot"><i></i></div>
      <div class="tray">
        <div class="plate slot" data-k="machine"><span class="cap">Machine</span>${title('—')}</div>
        <div class="plate slot" data-k="cup"><span class="cap">Cup</span>${title('—')}</div>
        <div class="plate slot" data-k="course"><span class="cap">Circuit</span>${title('—')}</div>
        <div class="plate slot" data-k="class"><span class="cap">Class</span>${title('—')}</div>
      </div>
      <div class="plate hint"></div>
      <div class="wipe"><s class="l"></s><s class="r"></s></div>
    </div>`);

  const stage: Stage | null = createStage(ctx);
  if (stage) root.insertBefore(stage.canvas, root.firstChild);

  const screens = {
    title: createTitleScreen() as TitleScreen,
    racer: createRacerScreen() as RacerScreen,
    course: createCourseScreen() as CourseScreen,
    class: createClassScreen(ctx) as ClassScreen,
  };
  for (const s of Object.values(screens)) root.appendChild(s.root);
  // The persistent chrome is moved above the screens and the wipe above that.
  // Order in this layer is the whole z-order: the tray and the prompt rail
  // outlive any one screen, and the wipe has to be in front of everything at
  // once or it is not a wipe.
  root.appendChild(q(root, '.tray'));
  root.appendChild(q(root, '.hint'));
  root.appendChild(q(root, '.wipe'));
  document.body.appendChild(root);

  const railTop = bind(q(root, '.rail.top i'));
  const railBot = bind(q(root, '.rail.bot i'));
  const trayBox = bind(q(root, '.tray'));
  const hintBox = bind(q(root, '.hint'));
  const wipeL = bind(q(root, '.wipe s.l'));
  const wipeR = bind(q(root, '.wipe s.r'));
  const traySlots = new Map<string, { box: HTMLElement; text: ReturnType<typeof bind> }>();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.tray .slot'))) {
    traySlots.set(el.dataset.k!, { box: el, text: bind(q(el, '.t > i')) });
  }

  // ── state ───────────────────────────────────────────────────────────────

  const rng = makeRng(0x63f1);
  const vehicleIds = listVehicles().map((v) => v.id);

  let visible = false;
  let live = false;
  let screen: ScreenName = 'title';
  const show: Record<ScreenName, number> = { title: 0, racer: 0, course: 0, class: 0 };

  /** The wipe's own clock. -1 when nothing is in flight. */
  let wipeT = -1;
  let wipeSwapped = false;
  let pending: ScreenName | null = null;
  let launching = false;
  /** Counts down while the menus hold the frame after a race has been asked
   *  for, so the hand-off is a board swinging away rather than a cut. */
  let outro = 0;

  let clock = 0;
  let railScroll = 0;
  let booted = false;
  let hintFor: ScreenName | null = null;

  const choice = {
    vehicleId: 'cone' as VehicleId,
    cup: CUPS[0]!.id,
    courseId: screens.course.coursesOf(0)[0]?.id ?? 'cone-canyon',
    engineClass: (ctx.config.race.defaultClass as EngineClass) ?? '150cc',
  };

  const sfx = (id: string, volume = 1, rate = 1): void => {
    ctx.audio?.play(id, { volume, rate });
  };

  // ── the tray ────────────────────────────────────────────────────────────

  function paintTray(): void {
    const m = traySlots.get('machine');
    if (m) {
      m.text.text(getVehicle(choice.vehicleId).name);
      m.box.classList.remove('empty');
    }
    traySlots.get('cup')?.text.text(CUPS.find((c) => c.id === choice.cup)?.name ?? '—');
    const course = screens.course.coursesOf(screens.course.cupIndex)
      .find((c) => c.id === choice.courseId);
    traySlots.get('course')?.text.text(course?.name ?? 'Surveying');
    traySlots.get('class')?.text.text(choice.engineClass.toUpperCase());
  }

  // ── flow ────────────────────────────────────────────────────────────────

  function goTo(next: ScreenName): void {
    if (next === screen && wipeT < 0) return;
    pending = next;
    wipeT = 0;
    wipeSwapped = false;
  }

  /** The moment the board is fully across the frame: swap everything at once. */
  function swap(): void {
    const next = pending ?? screen;
    pending = null;
    screen = next;
    if (next === 'title') {
      screens.title.enter();
      stage?.setParade(true);
      stage?.setHero(null);
    } else {
      stage?.setParade(false);
      stage?.setHero(choice.vehicleId);
    }
    stage?.go(SHOT[next]);
    if (hintFor !== next) {
      hintFor = next;
      hintBox.el.innerHTML = HINTS[next];
    }
    paintTray();
  }

  function pickRandomVehicle(): VehicleId {
    return vehicleIds[Math.floor(rng.next() * vehicleIds.length) % vehicleIds.length]!;
  }

  function chooseVehicle(index: number, commit: boolean): void {
    const id = index >= screens.racer.randomIndex
      ? (commit ? pickRandomVehicle() : null)
      : screens.racer.vehicleAt(index);
    if (id) {
      choice.vehicleId = id;
      stage?.setHero(id);
      // The machine says its own name. `sig.*` is the one sound in the bank
      // that belongs to a *character* rather than to an event, which is exactly
      // what a roster is for.
      sfx(`sig.${id}`, 0.85);
    } else {
      sfx('ui.click', 0.5, 1.5);
    }
    paintTray();
  }

  function launch(): void {
    if (launching) return;
    launching = true;
    sfx('boost', 0.95);
    ctx.audio?.setMusic('auto');
    wipeT = 0;
    wipeSwapped = false;
    pending = null;
  }

  function doLaunch(): void {
    const cfg: Partial<RaceConfig> = {
      courseId: choice.courseId,
      vehicleId: choice.vehicleId,
      engineClass: choice.engineClass,
      instant: false,
    };
    // `reset` is `startRace` in main.ts. Everything this front-end exists to
    // decide arrives there and nowhere else.
    void ctx.harness?.reset(cfg);
  }

  // ── nav ─────────────────────────────────────────────────────────────────

  function navTitle(v: string): void {
    if (v === 'menu.ok') {
      sfx('item.get', 0.9);
      ctx.audio?.setMusic('grid');
      goTo('racer');
    }
  }

  function navRacer(v: string): void {
    const r = screens.racer;
    if (v === 'menu.left' || v === 'menu.right') {
      r.setIndex(r.index + (v === 'menu.right' ? 1 : -1));
      chooseVehicle(r.index, false);
      sfx('ui.click', 0.55, 1.08);
    } else if (v === 'menu.ok') {
      chooseVehicle(r.index, true);
      sfx('ui.click', 0.9, 1.4);
      goTo('course');
    } else if (v === 'menu.back') {
      sfx('ui.click', 0.6, 0.72);
      goTo('title');
    }
  }

  function navCourse(v: string): void {
    const c = screens.course;
    if (v === 'menu.up') { c.setRow(0); sfx('ui.click', 0.5, 1.15); return; }
    if (v === 'menu.down') { c.setRow(1); sfx('ui.click', 0.5, 0.95); return; }
    if (v === 'menu.left' || v === 'menu.right') {
      const d = v === 'menu.right' ? 1 : -1;
      if (c.row === 0) c.setCup(c.cupIndex + d);
      else c.setCourse(c.courseIndex + d);
      const list = c.coursesOf(c.cupIndex);
      choice.cup = CUPS[c.cupIndex]!.id;
      choice.courseId = list[c.courseIndex]?.id ?? choice.courseId;
      paintTray();
      sfx('ui.click', 0.55, 1.08);
      return;
    }
    if (v === 'menu.ok') {
      const list = c.coursesOf(c.cupIndex);
      if (list.length === 0) {
        // A cup with nothing in it yet. Say no out loud rather than silently
        // doing nothing — an unresponsive button reads as a broken one.
        sfx('coin.lose', 0.7);
        c.setRow(0);
        return;
      }
      if (c.row === 0) { c.setRow(1); sfx('ui.click', 0.7, 1.2); return; }
      choice.cup = CUPS[c.cupIndex]!.id;
      choice.courseId = list[c.courseIndex]!.id;
      paintTray();
      sfx('ui.click', 0.9, 1.4);
      goTo('class');
      return;
    }
    if (v === 'menu.back') {
      sfx('ui.click', 0.6, 0.72);
      goTo('racer');
    }
  }

  function navClass(v: string): void {
    const k = screens.class;
    if (v === 'menu.left' || v === 'menu.right') {
      k.setIndex(k.index + (v === 'menu.right' ? 1 : -1));
      choice.engineClass = k.classes[k.index]!;
      paintTray();
      sfx('ui.click', 0.55, 1.08);
    } else if (v === 'menu.up' || v === 'menu.down') {
      sfx('ui.click', 0.4, 1);
    } else if (v === 'menu.ok') {
      choice.engineClass = k.classes[k.index]!;
      paintTray();
      launch();
    } else if (v === 'menu.back') {
      sfx('ui.click', 0.6, 0.72);
      goTo('course');
    }
  }

  function nav(verb: string): void {
    if (!live) return;
    switch (screen) {
      case 'title': navTitle(verb); break;
      case 'racer': navRacer(verb); break;
      case 'course': navCourse(verb); break;
      case 'class': navClass(verb); break;
      default: break;
    }
  }

  // Pointer routes into exactly the same verbs, so a click and a keypress can
  // never disagree about what happened.
  screens.racer.onHover = (i): void => {
    if (!live || screen !== 'racer' || i === screens.racer.index) return;
    screens.racer.setIndex(i);
    chooseVehicle(i, false);
    sfx('ui.click', 0.45, 1.08);
  };
  screens.racer.onPick = (i): void => {
    if (!live || screen !== 'racer') return;
    screens.racer.setIndex(i);
    nav('menu.ok');
  };
  screens.course.onHover = (row, i): void => {
    if (!live || screen !== 'course') return;
    screens.course.setRow(row);
    if (row === 0) screens.course.setCup(i);
    else screens.course.setCourse(i);
  };
  screens.course.onPick = (row, i): void => {
    if (!live || screen !== 'course') return;
    screens.course.setRow(row);
    if (row === 0) screens.course.setCup(i);
    else screens.course.setCourse(i);
    nav('menu.ok');
  };
  screens.class.onHover = (i): void => {
    if (!live || screen !== 'class') return;
    screens.class.setIndex(i);
    choice.engineClass = screens.class.classes[i]!;
    paintTray();
  };
  screens.class.onPick = (i): void => {
    if (!live || screen !== 'class') return;
    screens.class.setIndex(i);
    nav('menu.ok');
  };
  // Anywhere on the title screen: the whole frame is the start button.
  screens.title.root.addEventListener('pointerdown', () => nav('menu.ok'));

  // ── the edge: keyboard, pad, and the harness ────────────────────────────

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!live) return;
    const verb = KEYS[e.code];
    if (!verb) return;
    e.preventDefault();
    ctx.input.press(verb);
  };
  window.addEventListener('keydown', onKeyDown, { passive: false });

  /** Held state per pad verb, for the repeat. */
  const padHeld = new Map<string, number>();

  function pollPad(dt: number): void {
    if (!live || typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad) { padHeld.clear(); return; }

    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    const down = new Set<string>();
    for (const [i, verb] of PAD_BUTTONS) if (pad.buttons[i]?.pressed) down.add(verb);
    if (ax < -0.55) down.add('menu.left');
    if (ax > 0.55) down.add('menu.right');
    if (ay < -0.55) down.add('menu.up');
    if (ay > 0.55) down.add('menu.down');

    for (const verb of down) {
      const held = padHeld.get(verb);
      if (held === undefined) {
        padHeld.set(verb, 0);
        ctx.input.press(verb);
      } else {
        // Directions repeat when held; confirm and back never do — holding A
        // through a transition must not enter three screens.
        const repeats = verb !== 'menu.ok' && verb !== 'menu.back';
        const next = held + dt;
        if (repeats && held < REPEAT_DELAY && next >= REPEAT_DELAY) ctx.input.press(verb);
        else if (repeats && held >= REPEAT_DELAY
          && Math.floor((held - REPEAT_DELAY) / REPEAT_RATE)
             !== Math.floor((next - REPEAT_DELAY) / REPEAT_RATE)) ctx.input.press(verb);
        padHeld.set(verb, next);
      }
    }
    for (const verb of Array.from(padHeld.keys())) if (!down.has(verb)) padHeld.delete(verb);
  }

  // ── open / close ────────────────────────────────────────────────────────

  function open(at: ScreenName = 'title'): void {
    if (visible && live) { goTo(at); return; }
    visible = true;
    live = true;
    launching = false;
    outro = 0;
    wipeT = -1;
    pending = null;
    screen = at;
    for (const k of Object.keys(show) as ScreenName[]) show[k] = k === at ? 1 : 0;
    root.classList.add('on');
    screens.title.enter();
    stage?.cut(SHOT[at]);
    stage?.setLevel(1);
    stage?.setParade(at === 'title');
    stage?.setHero(at === 'title' ? null : choice.vehicleId);
    hintFor = at;
    hintBox.el.innerHTML = HINTS[at];
    paintTray();
    ctx.bus.emit('ui:menu', { open: true, screen: at });
  }

  function close(immediate: boolean): void {
    if (!visible) return;
    live = false;
    if (immediate) {
      visible = false;
      root.classList.remove('on');
      stage?.setParade(false);
      stage?.setHero(null);
    }
    ctx.bus.emit('ui:menu', { open: false, screen });
  }

  // ── the system ──────────────────────────────────────────────────────────

  const system: GameSystem = {
    name: 'menus',
    order: 110,

    reset(): void {
      // Every race start passes through here. The first one is the boot race,
      // and it is the only one that raises the title screen.
      if (!booted) {
        booted = true;
        open('title');
        return;
      }
      if (launching) {
        // Our own race. Hold the frame while the board swings away, so the
        // player is handed to the pre-race camera rather than dropped into it.
        live = false;
        outro = 0.55;
        launching = false;
        return;
      }
      close(true);
    },

    fixedUpdate(): void {
      const pressed = ctx.inputState.pressed;
      if (!visible) {
        // Escape at the results screen brings the front-end back rather than
        // leaving the player looking at a standings table with nowhere to go.
        const phase = ctx.race.phase;
        if ((pressed['menu.back'] || pressed.pause)
          && (phase === 'results' || phase === 'finished')) {
          open('racer');
        }
        return;
      }
      if (!live) return;
      // One verb per step at most: two arrow keys arriving in the same frame
      // should move the cursor once, not twice.
      if (pressed['menu.ok'] || pressed.confirm) nav('menu.ok');
      else if (pressed['menu.back'] || pressed.pause) nav('menu.back');
      else if (pressed['menu.left']) nav('menu.left');
      else if (pressed['menu.right']) nav('menu.right');
      else if (pressed['menu.up']) nav('menu.up');
      else if (pressed['menu.down']) nav('menu.down');
    },

    update(frameDt: number): void {
      if (!visible) return;
      // Sanitised at the one point that hands it out — the same discipline the
      // HUD applies, and for the same reason: the capture harness can hand this
      // module a delta measured between two different clocks, and one negative
      // frame runs every timer in here backwards.
      const dt = frameDt > 0.1 ? 0.1 : frameDt > 0 ? frameDt : 0;
      clock += dt;

      pollPad(dt);

      // ── the wipe ──────────────────────────────────────────────────────────
      let cover = 0;
      if (wipeT >= 0) {
        wipeT += dt;
        // Closes fast and opens slower: the arrival is the part worth watching.
        cover = wipeT < 0.34
          ? ease.outQuart(wipeT / 0.34)
          : 1 - ease.inOutCubic(clamp01((wipeT - 0.34) / 0.46));
        if (!wipeSwapped && wipeT >= 0.34) {
          wipeSwapped = true;
          if (launching) doLaunch();
          else swap();
        }
        if (wipeT >= 0.8) { wipeT = -1; cover = 0; }
      }
      // A race takes a moment to build. The board stays across the frame until
      // it is ready rather than opening onto the menus we are about to leave —
      // `reset()` is what releases it, into the outro below.
      if (launching && wipeSwapped) cover = 1;
      if (outro > 0) {
        outro = Math.max(0, outro - dt);
        cover = ease.inOutCubic(clamp01(outro / 0.55));
        if (outro <= 0) { close(true); return; }
      }
      const off = (1 - cover) * 102;
      wipeL.set('transform', `translateX(${(-off).toFixed(2)}%) skewX(-7deg)`);
      wipeR.set('transform', `translateX(${off.toFixed(2)}%) skewX(-7deg)`);
      stage?.setLevel(1 - cover * 0.82);

      // ── screens ───────────────────────────────────────────────────────────
      const hidden = outro > 0;
      for (const k of Object.keys(show) as ScreenName[]) {
        const want = !hidden && k === screen ? 1 : 0;
        show[k] = damp(show[k], want, 0.00002, dt);
        if (show[k] < 0.004 && want === 0) show[k] = 0;
        screens[k].update(dt, show[k]);
        screens[k].root.classList.toggle('live', live && k === screen && show[k] > 0.6);
      }

      // ── persistent chrome ─────────────────────────────────────────────────
      // The hazard rails crawl. It is two pixels a second and it is the reason
      // a still frame of this menu does not look like a photograph of one.
      railScroll = (railScroll + dt * 9) % 100;
      railTop.set('transform', `translateX(${(-railScroll).toFixed(2)}%)`);
      railBot.set('transform', `translateX(${(railScroll - 100).toFixed(2)}%)`);

      const chrome = ease.outQuart(clamp01((show.racer + show.course + show.class) * 1.2))
        * (1 - cover);
      trayBox.set('opacity', chrome.toFixed(3));
      trayBox.set('transform', `translateY(${((1 - chrome) * -40).toFixed(1)}%)`);
      hintBox.set('opacity', chrome.toFixed(3));
      hintBox.set('transform',
        `translate(-50%, ${((1 - chrome) * 60).toFixed(1)}%)`);

      stage?.update(dt);
      stage?.render();
    },

    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      stage?.dispose();
      for (const s of Object.values(screens)) s.dispose?.();
      root.remove();
      style.remove();
    },
  };

  // ── the reviewer's bench ────────────────────────────────────────────────
  //
  // Screenshots of a menu are only worth taking if a critic can get to the
  // screen they want without playing through to it. Everything here goes
  // through the same code a player's keypress does.
  (globalThis as unknown as Record<string, unknown>).__MENU = {
    open: (at: ScreenName = 'title') => open(at),
    close: () => close(true),
    /** Fire a menu verb: 'menu.up' | 'menu.down' | 'menu.left' | 'menu.right'
     *  | 'menu.ok' | 'menu.back'. Identical to a key press. */
    press: (verb: string) => ctx.input.press(verb),
    /** Skip the flow and choose directly — for a capture that wants the digger
     *  on the mark without walking the roster to it. */
    set: (opts: Partial<{ vehicleId: VehicleId; courseId: string; engineClass: EngineClass }>) => {
      if (opts.vehicleId) {
        choice.vehicleId = opts.vehicleId;
        const i = vehicleIds.indexOf(opts.vehicleId);
        if (i >= 0) screens.racer.setIndex(i);
        if (screen !== 'title') stage?.setHero(opts.vehicleId);
      }
      if (opts.courseId) choice.courseId = opts.courseId;
      if (opts.engineClass) {
        choice.engineClass = opts.engineClass;
        const i = screens.class.classes.indexOf(opts.engineClass);
        if (i >= 0) screens.class.setIndex(i);
      }
      paintTray();
    },
    probe: (): MenuProbe => ({
      open: visible,
      screen,
      vehicleId: choice.vehicleId,
      courseId: choice.courseId,
      cup: choice.cup,
      engineClass: choice.engineClass,
      wipe: wipeT < 0 ? 0 : +wipeT.toFixed(3),
    }),
  };

  return system;
}
