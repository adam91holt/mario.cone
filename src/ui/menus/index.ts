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

import { clamp01, ease, makeRng } from '../../core/math.ts';
import { getVehicle, listVehicles } from '../../vehicles/registry.ts';
import { bind, CSS_MENU, fromHtml, hintKey, q, title } from './chrome.ts';
import { createLaunchCard, CSS_LAUNCH } from './launch.ts';
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

/**
 * What the prompt rail says, given where the cursor actually is.
 *
 * The rail states *only* keys that do something from where the player is
 * standing. That is not a nicety: this rail used to advertise "▲ CUPS" beside
 * four cup tabs, three of which had no circuits in them and could never be
 * entered, and a legend naming a key that does not do what it says is worse
 * than no legend at all — the player concludes the game is broken rather than
 * that the control was aspirational. The circuit screen now has a cup row only
 * when there is more than one cup with circuits in it, and the rail says so.
 *
 * The class screen does not offer "↵ Start race" either: the call to action on
 * that screen is a plate with the key printed on it, and a rail repeating it
 * forty pixels below was the same instruction twice.
 */
function hintsFor(screen: ScreenName, courseRow: 0 | 1, cupRow: boolean): string {
  switch (screen) {
    case 'racer':
      return hintKey('◀ ▶', 'Choose') + hintKey('↵', 'Select') + hintKey('Esc', 'Back');
    case 'course':
      if (!cupRow) {
        return hintKey('◀ ▶', 'Circuit') + hintKey('↵', 'Select') + hintKey('Esc', 'Back');
      }
      return courseRow === 0
        ? hintKey('◀ ▶', 'Cup') + hintKey('▼', 'Circuits')
          + hintKey('↵', 'Open cup') + hintKey('Esc', 'Back')
        : hintKey('◀ ▶', 'Circuit') + hintKey('▲', 'Cups')
          + hintKey('↵', 'Select') + hintKey('Esc', 'Back');
    case 'class':
      return hintKey('◀ ▶', 'Choose') + hintKey('Esc', 'Back');
    default:
      return '';
  }
}

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
/** Directions repeat when held. Confirm and back never do — holding A through a
 *  transition must not enter three screens. */
const REPEATS = new Set(['menu.up', 'menu.down', 'menu.left', 'menu.right']);

/**
 * The push between two screens.
 *
 * The board wipe used to run on *every* navigation, which is why no screen in
 * this front-end had an entrance: the whole screen change happened behind a
 * closed curtain and what opened onto was already settled. A 0.8s curtain is
 * also a very expensive way to move one step down a four-step flow. It is
 * reserved now for the one moment it was built for — the commit into a race —
 * and everything else is a push: the outgoing screen leaves one way, the
 * incoming one arrives the other, both on the frame at once, and the incoming
 * screen's own staggered arrival plays out in front of the player rather than
 * behind a panel.
 */
const PUSH_OUT = 0.11;
const PUSH_LEAD = 0.045;
const PUSH_IN = 0.185;
const PUSH_TOTAL = PUSH_LEAD + PUSH_IN;
/** How far a screen travels while it is arriving or leaving, in per cent. */
const PUSH_DX = 7;

/** One tick of a held direction. Returns the new held time. */
function tickRepeat(held: number, dt: number, fire: () => void): number {
  const next = held + dt;
  if (held < REPEAT_DELAY) {
    if (next >= REPEAT_DELAY) fire();
  } else if (Math.floor((held - REPEAT_DELAY) / REPEAT_RATE)
    !== Math.floor((next - REPEAT_DELAY) / REPEAT_RATE)) {
    fire();
  }
  return next;
}

export interface CellProbe { scale: number; opacity: number; shown: boolean }
export interface RingProbe { opacity: number; x: number; y: number; w: number; h: number }

export interface UiProbe {
  screen: ScreenName;
  row: 0 | 1;
  /** Scale of the cell that currently has the cursor. */
  sel: number;
  ring: RingProbe;
  cells: CellProbe[];
  cupRing: RingProbe;
  cardRing: RingProbe;
  cards: CellProbe[];
  cupTabs: CellProbe[];
  held: number[];
}

export interface MenuProbe {
  open: boolean;
  screen: ScreenName;
  vehicleId: VehicleId;
  /** True while the cursor is on the random slot — nothing has been picked. */
  random: boolean;
  courseId: string;
  cup: string;
  engineClass: EngineClass;
  /** How much of the frame the hand-off board covers, 0..1. Only ever non-zero
   *  for the commit into a race; menu-to-menu navigation is a push. */
  wipe: number;
  /** The push between two screens, 0..1. -1 when nothing is in flight. */
  push: number;
  /** How much of the launch card is on the board, 0..1. */
  card: number;
  /** The hand-off, so a reviewer can photograph it without guessing at it. */
  launch: { active: boolean; built: boolean; t: number; hold: number; outro: number };
}

export function createMenuSystem(ctx: GameContext): GameSystem {
  // No document (a typecheck, a headless unit run): an inert system rather than
  // an exception on the first DOM call.
  if (typeof document === 'undefined') return { name: 'menus', order: 110 };

  const style = document.createElement('style');
  style.textContent = CSS_MENU + CSS_SCREENS + CSS_LAUNCH;
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
  // ...and the launch card above the board, because it is printed on it.
  const card = createLaunchCard();
  root.appendChild(card.root);
  document.body.appendChild(root);

  const railTop = bind(q(root, '.rail.top i'));
  const railBot = bind(q(root, '.rail.bot i'));
  /** Everything that is *backdrop* rather than board: the set, the grade and
   *  the two hazard rails. Taken off together, behind the closed board. */
  const backdrop = [
    stage ? bind(stage.canvas) : null,
    bind(q(root, '.grade')),
    bind(q(root, '.rail.top')),
    bind(q(root, '.rail.bot')),
  ].filter((b): b is ReturnType<typeof bind> => b !== null);
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

  /** The push's own clock. -1 when nothing is in flight. */
  let pushT = -1;
  /** The screen being pushed off, while it is still on the frame. */
  let pushFrom: ScreenName | null = null;
  /** Has the launch board finished closing? */
  let wipeSwapped = false;
  /** How much of the frame the board covers right now, 0..1. */
  let cover = 0;
  /** How much of the launch card is on the board, 0..1. */
  let cardShow = 0;

  // ── the hand-off ────────────────────────────────────────────────────────
  //
  // Four states, and the board is across the frame for the middle two:
  //
  //   launching        a race has been asked for; the board is closing, then
  //                    holding, and the card is on it
  //   raceBuilt        `reset()` has fired — the race exists behind the board
  //   outro            the board is swinging away onto it
  //   (neither)        the front-end is gone
  //
  // The board is released only when the race exists *and* the card has had its
  // beat *and* nobody has asked for longer. Anyone who wants to author the
  // arrival — a course fly-through, a grid reveal — gets `hold(seconds)` on the
  // `menu:launch` payload and the board waits for them.
  //
  // **The set goes off behind the closed board, not after it opens.** This is
  // the hard cut the critique named, and it was not the wipe: the board used to
  // swing away onto *this module's own 3D set* — a dim roadworks road with
  // nothing on it — hold there for half a second, and only then vanish in a
  // single frame onto a sunlit canyon. Two reveals, the first of them onto
  // scenery the player had already finished with. The stage, the grade and the
  // hazard rails are now switched off on the frame the board covers them, which
  // costs nothing to look at and means the one reveal there is lands on the
  // race.
  let launching = false;
  let raceBuilt = false;
  let launchT = 0;
  let holdWanted = 0;
  /** Counts down while the board swings away. -1 when it is not. */
  let outro = -1;
  /** How long the card is guaranteed on screen, board fully closed. */
  const CARD_HOLD = 1.05;
  /** ...and how long the board takes to swing off it. */
  const SWING = 0.55;
  /** Nothing may hold the frame for ever, listener or not. */
  const HOLD_CAP = 7;

  let clock = 0;
  let railScroll = 0;
  let booted = false;
  let hintText = ' ';

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

  /** Is the cursor sitting on the roster's random slot? Nothing is chosen while
   *  it is, and every part of the front-end that names the machine has to say
   *  so — the breadcrumb used to keep reporting whichever machine had last been
   *  hovered, so the tray said CHOPPER over a slot that had not decided. */
  function onRandom(): boolean {
    return screen === 'racer' && screens.racer.index >= screens.racer.randomIndex;
  }

  function paintTray(): void {
    const m = traySlots.get('machine');
    if (m) {
      m.text.text(onRandom() ? 'Surprise Me' : getVehicle(choice.vehicleId).name);
      m.box.classList.remove('empty');
    }
    traySlots.get('cup')?.text.text(CUPS.find((c) => c.id === choice.cup)?.name ?? '—');
    const course = screens.course.coursesOf(screens.course.cupIndex)
      .find((c) => c.id === choice.courseId);
    traySlots.get('course')?.text.text(course?.name ?? 'Surveying');
    traySlots.get('class')?.text.text(choice.engineClass.toUpperCase());
  }

  /** The rail follows the cursor, not just the screen — so it is repainted from
   *  `update` rather than only when a screen changes. */
  function paintHint(): void {
    const want = hintsFor(screen, screens.course.row, screens.course.hasCupRow);
    if (want === hintText) return;
    hintText = want;
    hintBox.el.innerHTML = want;
  }

  // ── flow ────────────────────────────────────────────────────────────────

  /** Put the set into whatever pose the current screen and cursor want. */
  function syncStage(): void {
    if (!stage) return;
    if (screen === 'title') {
      stage.setShuffle(false);
      stage.setParade(true);
      stage.setHero(null);
      return;
    }
    stage.setParade(false);
    const random = onRandom();
    stage.setShuffle(random);
    if (!random) stage.setHero(choice.vehicleId);
  }

  /**
   * Move to another screen.
   *
   * `dir` is which way the player is travelling through the flow — forward
   * through the four steps, or back up them — and it is the whole difference
   * between a push and a slide: the incoming screen enters from the side the
   * player is heading toward and the outgoing one leaves the other way, so the
   * direction of the transition and the direction of the journey agree.
   */
  function goTo(next: ScreenName, dir: 1 | -1): void {
    if (next === screen && pushT < 0) return;
    pushFrom = next === screen ? null : screen;
    screen = next;
    pushT = 0;
    screens[next].dx = PUSH_DX * dir;
    if (pushFrom) screens[pushFrom].dx = -PUSH_DX * dir;
    // The incoming screen restarts its own arrival on the frame the push
    // starts, so its head, roster and dossier cascade in *in front of* the
    // player rather than behind a panel that then opens onto them settled.
    screens[next].enter?.();
    if (next === 'racer') screens.racer.setBaseline(choice.vehicleId);
    syncStage();
    stage?.go(SHOT[next]);
    paintHint();
    paintTray();
  }

  function pickRandomVehicle(): VehicleId {
    return vehicleIds[Math.floor(rng.next() * vehicleIds.length) % vehicleIds.length]!;
  }

  function chooseVehicle(index: number, commit: boolean): void {
    const random = index >= screens.racer.randomIndex;
    if (random && !commit) {
      // Nothing has been chosen, so nothing stands on the mark: the set runs
      // the whole cast past instead, and the dossier says "???" rather than
      // printing five made-up numbers with change arrows on them.
      stage?.setShuffle(true);
      sfx('ui.click', 0.5, 1.5);
      paintTray();
      return;
    }
    const id = random ? pickRandomVehicle() : screens.racer.vehicleAt(index);
    if (id) {
      choice.vehicleId = id;
      stage?.setShuffle(false);
      stage?.setHero(id);
      // The machine says its own name. `sig.*` is the one sound in the bank
      // that belongs to a *character* rather than to an event, which is exactly
      // what a roster is for.
      sfx(`sig.${id}`, 0.85);
    }
    paintTray();
  }

  function launch(): void {
    if (launching) return;
    launching = true;
    raceBuilt = false;
    launchT = 0;
    holdWanted = 0;
    sfx('boost', 0.95);
    ctx.audio?.setMusic('auto');
    // **The card is painted from `choice` at the moment the board starts to
    // close, and from nothing else.** It used to be filled once and then shown
    // on every navigation for as long as the board was across the frame, which
    // meant the first full-screen statement a new player ever saw was a card
    // reading CONE CANYON SPEEDWAY / ROAD CONE with three empty unit labels
    // under an empty map — while they had actually chosen Jackhammer Quarry and
    // the tipper truck. A card that is on screen for a second and is wrong is
    // worse than no card, so it is built here, once, from the four choices this
    // module exists to collect, and it is the only thing that ever shows it.
    const list = screens.course.coursesOf(screens.course.cupIndex);
    const cup = CUPS.find((c) => c.id === choice.cup) ?? CUPS[0]!;
    card.set({
      courseId: choice.courseId,
      vehicleId: choice.vehicleId,
      engineClass: choice.engineClass,
      cupName: cup.name,
      cupColor: cup.color,
      round: Math.max(0, list.findIndex((c) => c.id === choice.courseId)),
      rounds: Math.max(1, list.length),
    });
    // Said out loud a beat before `reset()`, so anything that wants to author
    // the arrival — a course fly-through, a name card, a grid reveal — has the
    // choice in hand while the board is still closing rather than after the
    // race has already been built underneath it. Nothing depends on it being
    // listened to; `hold` is how a listener that does take it asks the board to
    // stay across the frame until its own arrival is ready to be revealed.
    ctx.bus.emit('menu:launch', {
      courseId: choice.courseId,
      vehicleId: choice.vehicleId,
      engineClass: choice.engineClass,
      hold: (seconds: number): void => {
        if (!(seconds > 0)) return;
        holdWanted = Math.min(HOLD_CAP, Math.max(holdWanted, seconds));
      },
    });
    wipeSwapped = false;
    pushT = -1;
    pushFrom = null;
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
      goTo('racer', 1);
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
      // A random pick resolves *here*, so the roster lands on the machine the
      // player has actually been given rather than leaving the cursor on a
      // question mark and the tray on the last thing hovered.
      const i = vehicleIds.indexOf(choice.vehicleId);
      if (i >= 0) r.setIndex(i);
      r.setBaseline(choice.vehicleId);
      sfx('ui.click', 0.9, 1.4);
      goTo('course', 1);
    } else if (v === 'menu.back') {
      sfx('ui.click', 0.6, 0.72);
      goTo('title', -1);
    }
  }

  function navCourse(v: string): void {
    const c = screens.course;
    // With one cup there is no cup row, nothing advertises a key to reach one,
    // and ▲/▼ are inert rather than making a noise about a row that is not
    // there.
    if (v === 'menu.up') {
      if (c.hasCupRow) { c.setRow(0); sfx('ui.click', 0.5, 1.15); }
      return;
    }
    if (v === 'menu.down') {
      if (c.hasCupRow) { c.setRow(1); sfx('ui.click', 0.5, 0.95); }
      return;
    }
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
      if (c.row === 0) { c.setRow(1); sfx('ui.click', 0.7, 1.2); return; }
      choice.cup = CUPS[c.cupIndex]!.id;
      choice.courseId = list[c.courseIndex]?.id ?? choice.courseId;
      paintTray();
      sfx('ui.click', 0.9, 1.4);
      goTo('class', 1);
      return;
    }
    if (v === 'menu.back') {
      sfx('ui.click', 0.6, 0.72);
      goTo('racer', -1);
    }
  }

  function navClass(v: string): void {
    const k = screens.class;
    if (v === 'menu.left' || v === 'menu.right') {
      k.setIndex(k.index + (v === 'menu.right' ? 1 : -1));
      choice.engineClass = k.classes[k.index]!;
      paintTray();
      sfx('ui.click', 0.55, 1.08);
    } else if (v === 'menu.ok') {
      choice.engineClass = k.classes[k.index]!;
      paintTray();
      launch();
    } else if (v === 'menu.back') {
      sfx('ui.click', 0.6, 0.72);
      goTo('course', -1);
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
  // A tap on something that is not already chosen *chooses* it; a tap on the
  // thing already under the cursor confirms. With a mouse the hover above has
  // already moved the cursor, so one click still does both — but a finger on a
  // touchscreen has no hover, and a single tap that both picks a machine and
  // commits to it is a front-end that can be walked through by accident.
  screens.racer.onPick = (i): void => {
    if (!live || screen !== 'racer') return;
    if (i !== screens.racer.index) {
      screens.racer.setIndex(i);
      chooseVehicle(i, false);
      sfx('ui.click', 0.55, 1.08);
      return;
    }
    nav('menu.ok');
  };
  screens.course.onHover = (row, i): void => {
    if (!live || screen !== 'course') return;
    const c = screens.course;
    if (c.row === row && (row === 0 ? c.cupIndex : c.courseIndex) === i) return;
    c.setRow(row);
    if (row === 0) c.setCup(i);
    else c.setCourse(i);
    // ...and the choice follows the cursor, exactly as it does under the arrow
    // keys. It did not, which meant a player who picked a circuit with the
    // mouse and pressed Enter started the one the keyboard had last been on.
    choice.cup = CUPS[c.cupIndex]!.id;
    choice.courseId = c.coursesOf(c.cupIndex)[c.courseIndex]?.id ?? choice.courseId;
    paintTray();
    sfx('ui.click', 0.45, 1.08);
  };
  screens.course.onPick = (row, i): void => {
    if (!live || screen !== 'course') return;
    const c = screens.course;
    const already = c.row === row && (row === 0 ? c.cupIndex : c.courseIndex) === i;
    c.setRow(row);
    if (row === 0) c.setCup(i);
    else c.setCourse(i);
    if (!already) {
      choice.cup = CUPS[c.cupIndex]!.id;
      choice.courseId = c.coursesOf(c.cupIndex)[c.courseIndex]?.id ?? choice.courseId;
      paintTray();
      sfx('ui.click', 0.55, 1.08);
      return;
    }
    nav('menu.ok');
  };
  screens.class.onHover = (i): void => {
    if (!live || screen !== 'class' || i === screens.class.index) return;
    screens.class.setIndex(i);
    choice.engineClass = screens.class.classes[screens.class.index]!;
    paintTray();
    sfx('ui.click', 0.45, 1.08);
  };
  screens.class.onPick = (i): void => {
    if (!live || screen !== 'class') return;
    if (i !== screens.class.index) {
      screens.class.setIndex(i);
      choice.engineClass = screens.class.classes[screens.class.index]!;
      paintTray();
      sfx('ui.click', 0.55, 1.08);
      return;
    }
    nav('menu.ok');
  };
  // Anywhere on the title screen: the whole frame is the start button.
  screens.title.root.addEventListener('pointerdown', () => nav('menu.ok'));

  // ── the edge: keyboard, pad, and the harness ────────────────────────────

  /**
   * A verb that has been raised but not yet consumed by a fixed step.
   *
   * The normal path is the shared input controller: `press()` here,
   * `inputState.pressed` in `fixedUpdate` there, one code path for a key, a pad
   * button, a click and `__GAME.press()`. But a fixed step only happens while
   * the simulation is running, and this front-end sits in front of a race that
   * another module is entitled to pause — a paused simulation takes no fixed
   * steps at all, and a menu that stops responding because the race behind it
   * stopped is a menu that has locked the player out of the game. So the verb
   * is queued here as well, and `update` drains the queue on any frame that no
   * fixed step touched. Never both: `fixedUpdate` clears the queue as it runs.
   */
  const queued: string[] = [];
  /** Did a fixed step run under the frame we are about to draw? */
  let stepped = false;

  function raise(verb: string): void {
    ctx.input.press(verb);
    if (queued.length < 4) queued.push(verb);
  }

  /**
   * The direction currently held on the keyboard, and how long for.
   *
   * The browser's own key repeat is deliberately not used. Two reasons, and the
   * second is the one that matters: its rate is an OS preference this product
   * has no say in, and the automated critics hold a key through the debug
   * protocol, which does not auto-repeat at all — two seconds of held ArrowRight
   * used to advance the roster by exactly one slot. A repeat this front-end
   * integrates itself from `dt` is the same repeat for a player, a pad and a
   * reviewer.
   */
  let heldCode: string | null = null;
  let heldVerb: string | null = null;
  let heldT = 0;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!live) return;
    const verb = KEYS[e.code];
    if (!verb) return;
    e.preventDefault();
    if (e.repeat) return;
    raise(verb);
    if (REPEATS.has(verb)) { heldCode = e.code; heldVerb = verb; heldT = 0; }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === heldCode) { heldCode = null; heldVerb = null; }
  };
  const onBlur = (): void => {
    heldCode = null;
    heldVerb = null;
    padHeld.clear();
  };
  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

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
        raise(verb);
      } else if (REPEATS.has(verb)) {
        padHeld.set(verb, tickRepeat(held, dt, () => raise(verb)));
      } else {
        padHeld.set(verb, held + dt);
      }
    }
    for (const verb of Array.from(padHeld.keys())) if (!down.has(verb)) padHeld.delete(verb);
  }

  // ── open / close ────────────────────────────────────────────────────────

  function open(at: ScreenName = 'title'): void {
    if (visible && live) { goTo(at, 1); return; }
    visible = true;
    live = true;
    launching = false;
    raceBuilt = false;
    outro = -1;
    pushT = -1;
    pushFrom = null;
    cover = 0;
    cardShow = 0;
    wipeSwapped = false;
    screen = at;
    for (const k of Object.keys(show) as ScreenName[]) show[k] = k === at ? 1 : 0;
    screens[at].dx = PUSH_DX;
    root.classList.add('on');
    // The bed the whole front-end runs on. Stated rather than inherited: with
    // no override the music follows the race behind the menus, so a front-end
    // opened over a finished race would come up to a victory fanfare.
    ctx.audio?.setMusic('grid');
    screens[at].enter?.();
    if (at === 'racer') screens.racer.setBaseline(choice.vehicleId);
    stage?.cut(SHOT[at]);
    stage?.setLevel(1);
    syncStage();
    paintHint();
    paintTray();
    ctx.bus.emit('ui:menu', { open: true, screen: at });
  }

  function close(immediate: boolean): void {
    if (!visible) return;
    live = false;
    heldCode = null;
    heldVerb = null;
    if (immediate) {
      visible = false;
      root.classList.remove('on');
      stage?.setShuffle(false);
      stage?.setParade(false);
      stage?.setHero(null);
      // `update` returns early once this is gone, so anything still on screen
      // has to be taken off here or it is on screen for ever.
      cardShow = 0;
      card.update(0, 0);
    }
    ctx.bus.emit('ui:menu', { open: false, screen });
  }

  // The way back in from anywhere else in the game. The results screen is owned
  // by the race module, so its "quit to menu" needs a door rather than a
  // dependency: emit this and the front-end comes up.
  ctx.bus.on('ui:menu:open', () => open('racer'));

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
        // Our own race, and it now exists. The board does *not* open on this —
        // it opens when `update` decides the card has been read and any hold a
        // listener asked for has run out.
        live = false;
        raceBuilt = true;
        return;
      }
      close(true);
    },

    fixedUpdate(): void {
      stepped = true;
      queued.length = 0;
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
      // Read and clear before the early return, or a frame spent closed leaves
      // the flag set and the fallback nav below never fires again.
      const ran = stepped;
      stepped = false;
      if (!visible) return;
      // Sanitised at the one point that hands it out — the same discipline the
      // HUD applies, and for the same reason: the capture harness can hand this
      // module a delta measured between two different clocks, and one negative
      // frame runs every timer in here backwards.
      const dt = frameDt > 0.1 ? 0.1 : frameDt > 0 ? frameDt : 0;
      clock += dt;

      pollPad(dt);
      if (live && heldVerb) {
        const verb = heldVerb;
        heldT = tickRepeat(heldT, dt, () => raise(verb));
      }

      // No fixed step ran under this frame — the simulation behind us is
      // paused or stopped. Drive the nav from the queue instead, so the front
      // end never becomes a picture of itself.
      if (live && !ran && queued.length > 0) {
        nav(queued[0]!);
        queued.length = 0;
      }

      // ── the push ──────────────────────────────────────────────────────────
      if (pushT >= 0) {
        pushT += dt;
        if (pushT >= PUSH_TOTAL && pushT >= PUSH_OUT) { pushT = -1; pushFrom = null; }
      }

      // ── the hand-off board ────────────────────────────────────────────────
      // The only thing left that draws the curtain, and the only thing that
      // ever shows the card.
      cover = 0;
      if (launching) {
        launchT += dt;
        cover = ease.outQuart(clamp01(launchT / 0.34));
        if (!wipeSwapped && launchT >= 0.34) {
          wipeSwapped = true;
          doLaunch();
          // The machine says its own name once more as the card lands on the
          // board. It is the last thing heard before the engines, and it is
          // the only sound in the bank that belongs to the machine the player
          // is about to be handed.
          sfx(`sig.${choice.vehicleId}`, 0.9);
        }
        // A race takes a moment to build. The board stays across the frame
        // until it is ready rather than opening onto the menus we are about to
        // leave, and then for as long again as the card on it needs to be read.
        const until = 0.34 + CARD_HOLD + holdWanted;
        // ...and a floor under it: a `hold` whose owner never comes back, or a
        // race that never finishes building, must not leave a player looking at
        // a board for ever.
        if ((raceBuilt && launchT >= until) || launchT > until + 2.5) {
          launching = false;
          outro = SWING;
        }
      }
      if (outro >= 0) {
        outro -= dt;
        cover = ease.inOutCubic(clamp01(outro / SWING));
        if (outro <= 0) { outro = -1; close(true); return; }
      }
      // Backdrop off, behind the board, once this front-end is handing over.
      // See the note at the top of the hand-off block: this is what turns two
      // reveals into one.
      const handing = outro >= 0 || (launching && wipeSwapped);
      for (const el of backdrop) el.set('opacity', handing ? '0' : '1');

      // The card rides the closed board: it arrives as the last of the board
      // lands and leaves with the first of it moving, so it is never seen
      // hanging over an open frame. It exists only for the commit into a race,
      // which is why the show is gated on the hand-off and not merely on the
      // board's coverage — a card is a promise about what is about to happen,
      // and one that fires on every arrow key is a promise about nothing.
      cardShow = launching || outro >= 0 ? clamp01((cover - 0.86) / 0.14) : 0;
      card.update(dt, cardShow);
      // Per cent of the panel's own width, and the panel is 78% of the frame
      // hung 10% outside it: 108% of 78% is 84% of the frame, which clears a
      // panel whose far edge sits at 68%.
      const off = (1 - cover) * 108;
      wipeL.set('transform', `translateX(${(-off).toFixed(2)}%) skewX(-7deg)`);
      wipeR.set('transform', `translateX(${off.toFixed(2)}%) skewX(-7deg)`);
      stage?.setLevel(1 - cover * 0.82);

      // ── screens ───────────────────────────────────────────────────────────
      paintHint();
      // Once the board is fully across for a launch, the screens behind it are
      // done: they must not be there to be revealed when it swings away.
      const hidden = handing;
      // Both screens in a push are on the frame at once, on one clock. The
      // outgoing one clears in a tenth of a second and the incoming one takes
      // the rest, which is what puts the arriving screen's own cascade in front
      // of the player instead of behind a panel.
      for (const k of Object.keys(show) as ScreenName[]) {
        let want: number;
        if (hidden) want = 0;
        else if (pushT >= 0) {
          if (k === screen) want = ease.outQuart(clamp01((pushT - PUSH_LEAD) / PUSH_IN));
          else if (k === pushFrom) want = 1 - ease.inQuad(clamp01(pushT / PUSH_OUT));
          else want = 0;
        } else want = k === screen ? 1 : 0;
        show[k] = want;
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

      // ...and a set nobody can see is a set nobody should pay for. The stage
      // is the single most expensive thing this module draws — a whole second
      // scene, over the top of a race already paying for a full frame — and
      // during the hand-off it is behind a closed board at zero opacity while
      // the engine is building a track. Those are exactly the frames worth
      // giving back.
      if (!handing) {
        stage?.update(dt);
        stage?.render();
      }
    },

    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
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
    /** Where the ground is worth reading, for the contact check. */
    marks: () => stage?.marks() ?? [],
    /**
     * What the cursor is actually doing, read the way a reviewer reads it: out
     * of the computed style, not out of the variable that was supposed to
     * produce it. The last critique of this screen was made entirely of numbers
     * like these — a tile that steps 1.000 → 1.224 in 33ms and then reports the
     * same matrix for twenty-five frames, a ring at opacity 0 on every cell of
     * every row — and none of them were checkable without a browser and a
     * stopwatch. Now they are one call.
     */
    uiProbe: (): UiProbe => {
      const read = (q: string): CellProbe[] =>
        Array.from(root.querySelectorAll<HTMLElement>(q)).map((el) => {
          const cs = getComputedStyle(el);
          const m = /matrix\(([-\d.]+)/.exec(cs.transform);
          return {
            scale: m ? +Number(m[1]).toFixed(4) : 1,
            opacity: +Number(cs.opacity).toFixed(3),
            shown: cs.display !== 'none',
          };
        });
      const ring = (q: string): RingProbe => {
        const el = root.querySelector<HTMLElement>(q);
        if (!el) return { opacity: 0, x: 0, y: 0, w: 0, h: 0 };
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          opacity: +Number(cs.opacity).toFixed(3),
          x: +r.x.toFixed(1), y: +r.y.toFixed(1),
          w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        };
      };
      const which = screen === 'racer' ? '.scr-racer .tile'
        : screen === 'class' ? '.scr-class .cc'
          : screens.course.row === 0 ? '.scr-course .cupTab' : '.scr-course .courseCard';
      const idx = screen === 'racer' ? screens.racer.index
        : screen === 'class' ? screens.class.index
          : screens.course.row === 0 ? screens.course.cupIndex : screens.course.courseIndex;
      const cells = read(which);
      const ringSel = screen === 'racer' ? '.rove.tileRing'
        : screen === 'class' ? '.rove.classRing'
          : screens.course.row === 0 ? '.rove.cupRing' : '.rove.cardRing';
      return {
        screen,
        row: screens.course.row,
        sel: cells[idx]?.scale ?? 0,
        ring: ring(ringSel),
        cells,
        cupRing: ring('.rove.cupRing'),
        cardRing: ring('.rove.cardRing'),
        cards: read('.scr-course .courseCard'),
        cupTabs: read('.scr-course .cupTab'),
        held: read('.scr-course .held').map((c) => c.opacity),
      };
    },
    probe: (): MenuProbe => ({
      open: visible,
      screen,
      vehicleId: choice.vehicleId,
      random: onRandom(),
      courseId: choice.courseId,
      cup: choice.cup,
      engineClass: choice.engineClass,
      wipe: +cover.toFixed(3),
      push: pushT < 0 ? -1 : +clamp01(pushT / PUSH_TOTAL).toFixed(3),
      card: +cardShow.toFixed(3),
      launch: {
        active: launching,
        built: raceBuilt,
        t: +launchT.toFixed(3),
        hold: +holdWanted.toFixed(3),
        outro: +outro.toFixed(3),
      },
    }),
  };

  return system;
}
