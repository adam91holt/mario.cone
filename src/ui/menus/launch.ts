// The hand-off.
//
// The last thing this front-end does is stop being the front-end, and until now
// that was a 0.35s hazard board swung across the frame and then swung back to
// reveal a race that had been built behind it — a curtain ending in a hard cut
// from a dim navy road to a sunlit canyon. The board is the right idea and the
// cut is the problem: nothing happens *while* the board is closed, so the one
// moment in the whole flow that should feel like a race about to start is dead
// air with a texture on it.
//
// So the closed board carries a card: the circuit you chose, drawn from its own
// control points, with the cup it belongs to, its length, its laps, the machine
// you are about to drive it in and the class you are about to drive it at. It
// is the last statement of the four choices this module exists to collect, and
// it is on screen for about a second while the race builds behind it — which is
// time the hand-off was spending anyway.
//
// ── The hold ───────────────────────────────────────────────────────────────
//
// The board stays across the frame until three things are true: the race exists,
// the card has had its beat, and nobody has asked for longer. That last one is
// the door this module leaves open for the arrival the critique asked for — a
// course fly-through with a name lower-third. `menu:launch` carries a `hold(s)`
// callback; a camera or race module that wants to author the arrival calls it
// from its own listener and the board stays shut for exactly that long, then
// swings away onto whatever that module has put on screen. Nothing has to
// listen, and the default without a listener is the beat this card needs.

import { clamp01, ease, lerp } from '../../core/math.ts';
import { glyphRun } from '../glyphs.ts';
import { vehicleMark } from './art.ts';
import { bind, courseMap, cupEmblem, fromHtml, hexCss, q, title } from './chrome.ts';
import { getVehicle } from '../../vehicles/registry.ts';
import { getCourse } from '../../track/courses/index.ts';
import type { EngineClass, VehicleId } from '../../types.ts';

export const CSS_LAUNCH = `
/* Above the board, which is itself above everything else. The card is the only
   thing in this front-end that is allowed in front of the wipe, because it is
   the only thing that is *printed on* it. */
#menu .launch {
  position: absolute; inset: 0; z-index: 60; pointer-events: none;
  display: flex; align-items: center; justify-content: center;
  opacity: 0;
}
#menu .launch .board {
  position: relative;
  width: min(76%, calc(var(--u) * 42));
  padding: calc(var(--u) * 1) calc(var(--u) * 1.5) calc(var(--u) * 1.45);
  display: flex; flex-direction: column; align-items: center;
  gap: calc(var(--u) * .5);
}
/* The cup line: emblem, cup name, and which round of it this is. */
#menu .launch .cup {
  display: flex; align-items: center; gap: calc(var(--u) * .6);
}
#menu .launch .cup .em { width: calc(var(--u) * 1.9); height: calc(var(--u) * 1.9); display: block; }
#menu .launch .cup .cap { font-size: calc(var(--u) * .68); }
#menu .launch .name .t { font-size: calc(var(--u) * 2.4); text-align: center; }
#menu .launch .row {
  display: flex; align-items: center; gap: calc(var(--u) * 1.8);
  width: 100%; justify-content: center;
}
#menu .launch .mapbox {
  width: calc(var(--u) * 12.4); height: calc(var(--u) * 12.4);
  flex: 0 0 auto;
}
#menu .launch .mapbox svg { width: 100%; height: 100%; display: block; overflow: visible; }
/* Centred against the map, not hung off its top edge. The column carries three
   short statements and the map is twelve units tall; top-aligning them left a
   third of the card empty under the class badge and read as a layout that had
   run out of things to say. */
#menu .launch .side {
  display: flex; flex-direction: column; gap: calc(var(--u) * 1.05);
  justify-content: center; align-items: flex-start;
}
#menu .launch .facts { display: flex; gap: calc(var(--u) * 1.3); }
#menu .launch .facts div { display: flex; flex-direction: column; gap: calc(var(--u) * .14); }
#menu .launch .facts .v { font-size: calc(var(--u) * 1.3); font-weight: 900; }
#menu .launch .facts .k {
  font-size: calc(var(--u) * .56); font-weight: 800; letter-spacing: .18em;
  text-transform: uppercase; color: rgba(255,248,240,.5);
}
/* The machine and the class on one line, divided: the two choices that are not
   the circuit, stated once more before they stop being choices. */
#menu .launch .kit {
  display: flex; align-items: center; gap: calc(var(--u) * .8);
  padding-top: calc(var(--u) * .75);
  border-top: calc(var(--u) * .1) solid rgba(255,248,240,.16);
  width: 100%;
}
#menu .launch .sil {
  width: calc(var(--u) * 4.6); height: calc(var(--u) * 2.9); flex: 0 0 auto;
}
#menu .launch .sil svg { width: 100%; height: 100%; display: block; overflow: visible; }
#menu .launch .kit .t { font-size: calc(var(--u) * 1.1); }
#menu .launch .cc { height: calc(var(--u) * 1.85); display: flex; margin-left: auto; }
#menu .launch .cc .gl { color: var(--gold); }
/* The strip along the foot: a crawling hazard band, so a card that is on screen
   for a second is never a still photograph of a card. */
#menu .launch .crawl {
  position: absolute; left: 0; right: 0; bottom: 0; height: calc(var(--u) * .42);
  overflow: hidden; border-radius: 0 0 calc(var(--u) * .55) calc(var(--u) * .55);
}
#menu .launch .crawl i {
  position: absolute; top: 0; bottom: 0; left: 0; width: 300%;
  background: repeating-linear-gradient(114deg,
    ${hexCss(0xFFC300)} 0 calc(var(--u) * .62),
    #14171E calc(var(--u) * .62) calc(var(--u) * 1.24));
}
/* ...and the same again above the head, under the plate's own gold strip. */
#menu .launch .flag {
  display: flex; gap: calc(var(--u) * .26);
}
#menu .launch .flag b {
  display: block; width: calc(var(--u) * .62); height: calc(var(--u) * .62);
  border-radius: calc(var(--u) * .1);
  background: rgba(255,248,240,.22);
}
#menu .launch .flag b.on { background: linear-gradient(180deg, #FFE07A, var(--orange)); }
`;

export interface LaunchInfo {
  courseId: string;
  vehicleId: VehicleId;
  engineClass: EngineClass;
  cupName: string;
  cupColor: number;
  /** Zero-based round within the cup, and how many rounds the cup has. */
  round: number;
  rounds: number;
}

export interface LaunchCard {
  readonly root: HTMLElement;
  /** Paint the card for a race that is about to start. */
  set(info: LaunchInfo): void;
  /** `show` is 0..1: how much of the card is on the board. */
  update(dt: number, show: number): void;
}

/** Metres, along the control points the track is actually built from. */
function courseLength(points: Array<{ x: number; z: number }>): number {
  let d = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    d += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return d;
}

export function createLaunchCard(): LaunchCard {
  const root = fromHtml(`
    <div class="launch">
      <div class="plate vis board">
        <div class="cup"><div class="em-wrap">${cupEmblem(0xFFC300)}</div>
          <span class="cap cupname">Hazard Cup</span>
          <div class="flag"></div></div>
        <div class="name">${title('Cone Canyon Speedway', 'nm')}</div>
        <div class="row">
          <div class="mapbox"></div>
          <div class="side">
            <div class="facts">
              <div><span class="v len"></span><span class="k">Metres</span></div>
              <div><span class="v lap"></span><span class="k">Laps</span></div>
              <div><span class="v tot"></span><span class="k">Total km</span></div>
            </div>
            <div class="kit">
              <div class="sil"></div>
              <div>${title('Road Cone', 'mach')}</div>
              <div class="cc"></div>
            </div>
          </div>
        </div>
        <div class="crawl"><i></i></div>
      </div>
    </div>`);

  const b = bind(root);
  const board = bind(q(root, '.board'));
  const emWrap = q<HTMLElement>(root, '.cup .em-wrap');
  const cupName = bind(q(root, '.cupname'));
  const flag = q<HTMLElement>(root, '.flag');
  const nm = bind(q(root, '.nm > i'));
  const mach = bind(q(root, '.mach > i'));
  const mapbox = q<HTMLElement>(root, '.mapbox');
  const sil = q<HTMLElement>(root, '.sil');
  const cc = q<HTMLElement>(root, '.cc');
  const len = bind(q(root, '.len'));
  const lap = bind(q(root, '.lap'));
  const tot = bind(q(root, '.tot'));
  const crawl = bind(q(root, '.crawl i'));

  let clock = 0;
  let shown = false;
  let lastKey = '';

  return {
    root,

    set(info): void {
      // Rebuilding this markup costs a layout, so it happens once per race
      // rather than once per frame — and only when something in it changed.
      const key = `${info.courseId}|${info.vehicleId}|${info.engineClass}|${info.round}`;
      if (key === lastKey) return;
      lastKey = key;

      const course = getCourse(info.courseId);
      const veh = getVehicle(info.vehicleId);
      const metres = Math.round(courseLength(course.points));
      const laps = course.laps ?? 3;

      emWrap.innerHTML = cupEmblem(info.cupColor);
      cupName.text(info.cupName);
      let pips = '';
      for (let i = 0; i < Math.max(1, info.rounds); i++) {
        pips += `<b class="${i === info.round ? 'on' : ''}"></b>`;
      }
      flag.innerHTML = pips;

      nm.text(course.name);
      mapbox.innerHTML = courseMap(course.points);
      len.text(String(metres));
      lap.text(String(laps));
      tot.text(((metres * laps) / 1000).toFixed(1));
      sil.innerHTML = vehicleMark(info.vehicleId);
      mach.text(veh.name);
      cc.innerHTML = glyphRun(info.engineClass.toUpperCase());
    },

    update(dt, show): void {
      if (show <= 0.002) {
        if (shown) { shown = false; b.set('display', 'none'); }
        return;
      }
      if (!shown) { shown = true; b.set('display', 'flex'); }
      clock += dt;

      // Arrives on an overshoot and then holds dead still but for the crawl —
      // the card is meant to be *read*, and a card that is still moving while
      // it is being read is a card nobody finishes.
      const e = ease.outBack(clamp01(show));
      b.set('opacity', ease.outQuart(clamp01(show * 1.6)).toFixed(3));
      board.set('transform',
        `translateY(${((1 - e) * 5.5).toFixed(2)}%) scale(${lerp(0.94, 1, e).toFixed(4)})`);
      crawl.set('transform', `translateX(${(-((clock * 8) % 100)).toFixed(2)}%)`);
    },
  };
}
