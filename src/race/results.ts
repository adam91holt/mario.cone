// The results screen.
//
// The one screen in a kart racer that is pure payoff: nothing on it is
// actionable, the race is decided, and its whole job is to tell the player what
// they just did and make them want to do it again. So it is built like a
// scoreboard being *filled in* rather than a table being displayed — the sheet
// arrives, the finishing order lands a line at a time from the outside of the
// frame, the points stamp on after their row settles, and only once the story
// is told does the championship table slide in beside it with the standings the
// race just changed.
//
// Everything on it is drawn geometry: the numerals are `ui/glyphs.ts` (the same
// slab face as the place indicator the player has been staring at for three
// laps) and every word is `letters.ts`. Nothing here is set in a system font.
//
// And nothing animates in CSS. Every position, opacity and scale below is a
// pure function of one clock integrated from the `dt` handed to `update()`,
// which is what makes the capture harness — which renders frames with no wall
// clock at all — photograph the same screen every time.

import { clamp01, ease, formatTime } from '../core/math.ts';
import { glyphBox, ordinalWord } from '../ui/glyphs.ts';
import { bind, fromHtml, q, rgba, type Bound } from '../ui/theme.ts';
import { signBox } from './letters.ts';
import { createHint, createMenu, type Menu, type MenuOption } from './menu.ts';
import type { CupStanding, ResultRow } from './book.ts';

export const CSS_RESULTS = `
#race .results { position: absolute; inset: 0; opacity: 0; display: none; }
#race .results.live { display: block; }
/* **Dark, and darkest at the edges.** The lens behind this sheet is orbiting a
   stopped kart in a world full of two-metre hazard signs, and any of them can
   end up a metre from the camera: photographed at .9 the corner of the frame
   was a bright yellow slab next to the finishing order. The centre stays open
   enough to read the confetti and the machine it is falling on. */
#race .results .scrim {
  position: absolute; inset: 0;
  background:
    radial-gradient(115% 95% at 50% 40%, rgba(8,11,17,.58) 0%, rgba(5,7,11,.97) 68%),
    linear-gradient(180deg, rgba(255,107,26,.10), rgba(0,0,0,0) 38%);
}
/* Hazard tape down both edges of the frame: the sheet is a sign, and this is
   what a sign in this world is fixed to. */
#race .results .edge {
  position: absolute; top: 0; bottom: 0; width: calc(var(--u) * .55);
  background: repeating-linear-gradient(115deg,
    #FF6B1A 0 calc(var(--u) * .7), #14171F calc(var(--u) * .7) calc(var(--u) * 1.4));
  opacity: .9;
}
#race .results .edge.l { left: 0; }
#race .results .edge.r { right: 0; }

#race .sheet {
  position: absolute;
  left: calc(var(--u) * 2.1); right: calc(var(--u) * 2.1);
  top: calc(var(--u) * 1.5); bottom: calc(var(--u) * 1.4);
  display: flex; flex-direction: column; gap: calc(var(--u) * .62);
}

/* ── header ──────────────────────────────────────────────────────────────── */
#race .rs-head {
  display: flex; align-items: center; gap: calc(var(--u) * 1.1);
  padding: calc(var(--u) * .42) calc(var(--u) * 1.2) calc(var(--u) * .5);
}
#race .rs-head .cupname { height: calc(var(--u) * 1.9); color: #FFD84D; }
#race .rs-head .course { height: calc(var(--u) * 1.45); color: #E8ECF4; margin-left: auto; }
#race .rs-head .rounds { display: flex; gap: calc(var(--u) * .26); align-items: center; }
#race .rs-head .rounds i {
  display: block; width: calc(var(--u) * 1.5); height: calc(var(--u) * .5);
  border-radius: calc(var(--u) * .1);
  background: rgba(255,248,240,.22);
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.55);
}
#race .rs-head .rounds i.done { background: #FFC300; box-shadow: inset 0 0 0 1px rgba(0,0,0,.5), 0 0 calc(var(--u) * .3) rgba(255,195,0,.7); }
#race .rs-head .rounds i.now { background: #FFF8F0; box-shadow: inset 0 0 0 1px rgba(0,0,0,.5), 0 0 calc(var(--u) * .42) rgba(255,248,240,.85); }

/* ── body ────────────────────────────────────────────────────────────────── */
#race .rs-body { flex: 1; display: flex; gap: calc(var(--u) * .8); min-height: 0; }
#race .table { flex: 1.85; display: flex; flex-direction: column; gap: calc(var(--u) * .32);
  min-height: 0; }

/* **The rows share the height rather than claiming it.** Eight fixed-height
   plates plus a header plus a footer is a layout that fits at 16:9 and clips on
   a wide, short window — and this game is photographed at whatever viewport the
   reviewer's script asked for. A "flex: 1 1 0" with a ceiling means the table
   fills the sheet at the size it was designed for and shrinks in step below it,
   which is the same discipline the --u unit applies to everything else. */
#race .row {
  position: relative; display: flex; align-items: center;
  flex: 1 1 0; min-height: 0; max-height: calc(var(--u) * 4.5);
  gap: calc(var(--u) * .72);
  padding: 0 calc(var(--u) * 1.0) 0 calc(var(--u) * 1.15);
  opacity: 0;
}
/* The livery, as a spine down the left edge of the plate rather than a chip in
   the run of text — at chip size, skewed, it read as a slash between the place
   and the name. */
#race .row .chip {
  position: absolute; left: 0; top: 0; bottom: 0;
  width: calc(var(--u) * .6); transform: none;
  border-radius: calc(var(--u) * .5) 0 0 calc(var(--u) * .5);
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.55);
}
#race .row .pos { display: flex; align-items: flex-end; width: calc(var(--u) * 4.9); }
#race .row .pos .num { height: calc(var(--u) * 3.0); color: #FFF8F0; }
#race .row .pos .suf { height: calc(var(--u) * 1.25); color: #FFF8F0;
  margin-left: calc(var(--u) * .08); margin-bottom: calc(var(--u) * .14); }
/* Gold, steel and rust for the podium — the three places that are worth
   something, said in a colour before they are said in a number. */
#race .row.p1 .pos .num, #race .row.p1 .pos .suf { color: #FFD84D; }
#race .row.p2 .pos .num, #race .row.p2 .pos .suf { color: #D8E2F0; }
#race .row.p3 .pos .num, #race .row.p3 .pos .suf { color: #FFA06A; }

#race .row .nm { height: calc(var(--u) * 1.55); color: #EEF2F8; }
#race .row .tm { height: calc(var(--u) * 1.55); color: #C7D2E2; margin-left: auto; }
#race .row.est .tm { opacity: .55; }
#race .row .pts { height: calc(var(--u) * 1.75); color: #8CFF6A;
  width: calc(var(--u) * 4.4); display: flex; justify-content: flex-end; opacity: 0; }
#race .row .pts .num { height: 100%; }

/* The player's line. It is the answer to the whole race, so it is the one row
   with a lit face and a gold strip, and it is a shade taller than the rest. */
#race .row.you { max-height: calc(var(--u) * 4.9); }
#race .row.you .plate-bg { background: linear-gradient(178deg, rgba(120,86,20,.96), rgba(60,38,8,.96) 55%, rgba(28,18,6,.96)); }
#race .row.you .plate-bg::before { background: linear-gradient(90deg, #FFD84D, #FFF3B0 50%, #FFD84D); }
#race .row.you .nm { color: #FFF8F0; }
#race .row .flash {
  position: absolute; inset: 0; border-radius: calc(var(--u) * .45);
  opacity: 0; mix-blend-mode: screen; pointer-events: none;
  background: linear-gradient(90deg, rgba(255,216,77,0), rgba(255,236,160,.85), rgba(255,216,77,0));
}

/* ── the championship ────────────────────────────────────────────────────── */
#race .cup { flex: 1; display: flex; flex-direction: column; opacity: 0;
  padding: calc(var(--u) * .5) calc(var(--u) * .85) calc(var(--u) * .7); }
#race .cup .cup-head { display: flex; align-items: center; gap: calc(var(--u) * .5);
  margin-bottom: calc(var(--u) * .45); }
#race .cup .cup-head .word { height: calc(var(--u) * 1.3); color: #FFC300; }
/* **The rows share the panel rather than sitting in the top of it.** Eight rows
   of a fixed 2.45u filled a little over half a panel that is as tall as the
   results table beside it, and the bottom third of the championship — the half
   of the screen that is supposed to be the reason to play the next race — was
   blank plate. Same rule the table on the left already runs to. */
#race .cup .crows { flex: 1; display: flex; flex-direction: column; min-height: 0; }
#race .cup .crow { display: flex; align-items: center; gap: calc(var(--u) * .5);
  flex: 1 1 0; min-height: 0; max-height: calc(var(--u) * 3.3); opacity: 0; }
#race .cup .crow .cpos { height: calc(var(--u) * 1.25); color: #9FB0C6; width: calc(var(--u) * 2.1); }
#race .cup .crow .chip { width: calc(var(--u) * .55); height: calc(var(--u) * 1.7);
  transform: skewX(-9deg); border-radius: calc(var(--u) * .08);
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.6); }
#race .cup .crow .cnm { height: calc(var(--u) * 1.12); color: #DDE5F0; flex: 1; }
#race .cup .crow .cgain { height: calc(var(--u) * 1.0); color: #8CFF6A; opacity: .9; }
#race .cup .crow .cpt { height: calc(var(--u) * 1.55); color: #FFF8F0; }
#race .cup .crow.you .cnm, #race .cup .crow.you .cpt { color: #FFD84D; }
#race .cup .crow.lead .cpt { color: #FFD84D; }

/* The end of a cup.
   Four races decide a championship and, until this line existed, the screen
   that settled it differed from the screen after race one by a single word in
   the panel header. A Grand Prix has a winner and the game has to say so. */
#race .cup .champ { display: none; }
#race .cup.done .champ {
  display: flex; align-items: center; gap: calc(var(--u) * .55);
  margin: calc(var(--u) * -.1) 0 calc(var(--u) * .5);
  padding: calc(var(--u) * .3) calc(var(--u) * .8) calc(var(--u) * .38);
  border-radius: calc(var(--u) * .4);
  background: linear-gradient(178deg, rgba(120,86,20,.96), rgba(58,38,8,.96));
  box-shadow: inset 0 calc(var(--u) * .1) 0 rgba(255,232,150,.4),
              0 0 0 calc(var(--u) * .1) rgba(9,11,15,.9);
}
#race .cup .champ .lbl { height: calc(var(--u) * .95); color: #FFC300; }
#race .cup .champ .who { height: calc(var(--u) * 1.45); color: #FFF8F0; }
#race .cup.done.mine .champ .who { color: #FFE9A8;
  filter: drop-shadow(0 0 calc(var(--u) * .5) rgba(255,200,60,.7)); }

/* ── footer ──────────────────────────────────────────────────────────────── */
#race .rs-foot { display: flex; align-items: flex-end; gap: calc(var(--u) * 1.2); opacity: 0; }
#race .rs-foot .best {
  display: flex; align-items: center; gap: calc(var(--u) * .55);
  padding: calc(var(--u) * .4) calc(var(--u) * 1.0) calc(var(--u) * .46);
}
/* No best lap means no plate. A race reached by a harness seek has nobody's
   name on it, and an empty sign is worse than no sign. */
#race .rs-foot .best.none { display: none; }
#race .rs-foot .best .lbl { height: calc(var(--u) * .95); color: #FFC300; }
#race .rs-foot .best .who { height: calc(var(--u) * 1.15); color: #EEF2F8; }
#race .rs-foot .best .tm { height: calc(var(--u) * 1.5); color: #FFF8F0; }

/* The player's own laps, in order. The one number a results screen owes a
   driver that no other readout in the game keeps: what each of their laps
   actually cost them. Their quickest is lit. */
#race .rs-foot .laps {
  display: flex; align-items: center; gap: calc(var(--u) * .7);
  padding: calc(var(--u) * .4) calc(var(--u) * 1.0) calc(var(--u) * .46);
}
#race .rs-foot .laps.none { display: none; }
#race .rs-foot .laps .lbl { height: calc(var(--u) * .95); color: #FFC300; }
#race .rs-foot .laps .splits { display: flex; align-items: center; gap: calc(var(--u) * .75); }
#race .rs-foot .laps .split { height: calc(var(--u) * 1.2); color: #C7D2E2; }
#race .rs-foot .laps .split.fast { color: #FFD84D; }
#race .rs-foot .acts { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; }
`;

/** What the screen needs beyond the table itself. */
export interface ResultsMeta {
  cupName: string;
  courseName: string;
  round: number;
  rounds: number;
  bestLapName: string;
  bestLapTime: number;
  /** The player's own laps, in order. */
  playerSplits: readonly number[];
  /** Championship complete — the sheet says so and the menu changes. */
  cupComplete: boolean;
}

export interface Results {
  readonly root: HTMLElement;
  show(rows: readonly ResultRow[], standings: readonly CupStanding[],
       meta: ResultsMeta, options: MenuOption[]): void;
  hide(): void;
  readonly visible: boolean;
  menu: Menu;
  update(dt: number): void;
  reset(): void;
  dispose(): void;
}

/** Per-row timing. The whole sequence is derived from these three numbers. */
const ROW_DELAY = 0.24;
const ROW_STEP = 0.085;
const ROW_IN = 0.34;
/** Slack after the last element has landed, before the sheet is declared still. */
const SETTLE_PAD = 1.7;

export function createResults(onPick: (id: string) => void): Results {
  const root = fromHtml(`
    <div class="results">
      <div class="scrim"></div>
      <div class="edge l"></div>
      <div class="edge r"></div>
      <div class="sheet">
        <div class="rs-head plate">
          <div class="cupname word"></div>
          <div class="rounds"></div>
          <div class="course word"></div>
        </div>
        <div class="rs-body">
          <div class="table"></div>
          <div class="cup plate">
            <div class="cup-head"><div class="word"></div></div>
            <div class="champ"><span class="lbl word"></span><span class="who word"></span></div>
            <div class="crows"></div>
          </div>
        </div>
        <div class="rs-foot">
          <div class="best plate">
            <div class="lbl word"></div>
            <div class="who word"></div>
            <div class="tm num"></div>
          </div>
          <div class="laps plate">
            <div class="lbl word"></div>
            <div class="splits"></div>
          </div>
          <div class="acts"></div>
        </div>
      </div>
    </div>
  `);

  const sheet = bind(q(root, '.sheet'));
  const scrim = bind(q(root, '.scrim'));
  const box = bind(root);
  const head = bind(q(root, '.rs-head'));
  const cupName = signBox(q(root, '.cupname'));
  const courseName = signBox(q(root, '.course'));
  const roundsRow = q(root, '.rounds');
  const table = q(root, '.table');
  const cupPanel = bind(q(root, '.cup'));
  const cupTitle = signBox(q(root, '.cup-head .word'));
  const champLbl = signBox(q(root, '.champ .lbl'));
  const champWho = signBox(q(root, '.champ .who'));
  const cupRows = q(root, '.crows');
  const foot = bind(q(root, '.rs-foot'));
  const best = bind(q(root, '.best'));
  const bestLbl = signBox(q(root, '.best .lbl'), 'BEST LAP');
  const bestWho = signBox(q(root, '.best .who'));
  const bestTime = glyphBox(q(root, '.best .tm'));
  const laps = bind(q(root, '.laps'));
  signBox(q(root, '.laps .lbl'), 'YOUR LAPS');
  const splitRow = q(root, '.laps .splits');

  const menu = createMenu(onPick);
  q(root, '.acts').appendChild(menu.root);
  q(root, '.acts').appendChild(createHint('LEFT RIGHT CHOOSE   ENTER SELECT'));

  interface Row {
    box: Bound;
    pts: Bound;
    flash: Bound;
    isPlayer: boolean;
  }
  interface CupRow { box: Bound }

  let rows: Row[] = [];
  let cupCells: CupRow[] = [];
  let count = 0;
  let t = -1;
  let live = false;
  let settleAt = 3;

  function clear(el: HTMLElement): void {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function buildRow(row: ResultRow): Row {
    const el = fromHtml(`
      <div class="row">
        <div class="plate-bg plate"></div>
        <div class="chip"></div>
        <div class="pos"><span class="pnum num"></span><span class="psuf num"></span></div>
        <div class="nm word"></div>
        <div class="tm num"></div>
        <div class="pts"><span class="num"></span></div>
        <div class="flash"></div>
      </div>
    `);
    glyphBox(q(el, '.pnum'), String(row.place));
    glyphBox(q(el, '.psuf'), ordinalWord(row.place));
    signBox(q(el, '.nm'), row.name);
    // The winner's absolute time, everybody else's gap to it. A results table
    // that prints eight total times makes the reader do the subtraction the
    // screen exists to do for them.
    glyphBox(q(el, '.tm'), row.place === 1 ? formatTime(row.time) : `+${formatGap(row.gap)}`);
    glyphBox(q(el, '.pts .num'), row.points > 0 ? `+${row.points}` : '');
    bind(q(el, '.chip')).set('background', chipPaint(row.color));
    const b = bind(el);
    b.cls('you', row.isPlayer);
    b.cls('est', row.estimated);
    b.cls(`p${row.place}`, row.place <= 3);
    table.appendChild(el);
    return { box: b, pts: bind(q(el, '.pts')), flash: bind(q(el, '.flash')), isPlayer: row.isPlayer };
  }

  function buildCupRow(s: CupStanding, leader: boolean): CupRow {
    const el = fromHtml(`
      <div class="crow">
        <span class="cpos num"></span>
        <div class="chip"></div>
        <div class="cnm word"></div>
        <div class="cgain num"></div>
        <div class="cpt num"></div>
      </div>
    `);
    glyphBox(q(el, '.cpos'), String(s.place));
    signBox(q(el, '.cnm'), s.name);
    glyphBox(q(el, '.cgain'), s.gained > 0 ? `+${s.gained}` : '');
    glyphBox(q(el, '.cpt'), String(s.points));
    bind(q(el, '.chip')).set('background', chipPaint(s.color));
    const b = bind(el);
    b.cls('you', s.isPlayer);
    b.cls('lead', leader);
    cupRows.appendChild(el);
    return { box: b };
  }

  const api: Results = {
    root,
    menu,

    get visible(): boolean { return live; },

    show(list, standings, meta, options): void {
      clear(table);
      clear(cupRows);
      clear(roundsRow);
      rows = list.map(buildRow);
      count = rows.length;

      const leaderPoints = standings.length ? standings[0]!.points : 0;
      cupCells = standings.map((s) => buildCupRow(s, s.points === leaderPoints && s.points > 0));

      cupName.set(meta.cupName);
      courseName.set(meta.courseName);
      cupTitle.set(meta.cupComplete ? 'FINAL STANDINGS' : 'CHAMPIONSHIP');
      // Who won the cup, said once, on the only screen that can say it.
      const champ = meta.cupComplete ? standings[0] : undefined;
      cupPanel.cls('done', !!champ);
      cupPanel.cls('mine', !!champ?.isPlayer);
      champLbl.set(champ ? (champ.isPlayer ? 'YOU WIN THE' : 'CHAMPION') : '');
      champWho.set(champ ? (champ.isPlayer ? meta.cupName : champ.name) : '');
      clear(splitRow);
      const mine = meta.playerSplits.filter((s) => s > 0);
      laps.cls('none', mine.length < 2);
      if (mine.length >= 2) {
        const quickest = Math.min(...mine);
        for (const s of mine) {
          const el = document.createElement('span');
          el.className = s === quickest ? 'split num fast' : 'split num';
          glyphBox(el, formatTime(s));
          splitRow.appendChild(el);
        }
      }

      const hasBest = meta.bestLapTime > 0 && !!meta.bestLapName;
      best.cls('none', !hasBest);
      bestLbl.set(hasBest ? 'BEST LAP' : '');
      bestWho.set(hasBest ? meta.bestLapName : '');
      bestTime.set(hasBest ? formatTime(meta.bestLapTime) : '');

      for (let i = 0; i < meta.rounds; i++) {
        const pip = document.createElement('i');
        if (i < meta.round) pip.className = 'done';
        else if (i === meta.round) pip.className = 'now';
        roundsRow.appendChild(pip);
      }

      menu.set(options, 0);
      settleAt = ROW_DELAY + count * ROW_STEP + SETTLE_PAD;
      t = 0;
      live = true;
      box.cls('live', true);
    },

    hide(): void {
      live = false;
      t = -1;
      box.cls('live', false);
      box.set('opacity', '0');
    },

    update(dt): void {
      if (!live || t < 0) return;
      t += dt;

      // Once the sheet has finished arriving, every term below is constant, and
      // recomputing forty transform strings a frame for a static screen is work
      // nobody sees. The menu keeps animating — it is the only live thing left.
      if (t > settleAt) { menu.update(dt); return; }

      // ── the sheet ────────────────────────────────────────────────────────
      const inT = clamp01(t / 0.34);
      const e = ease.outQuart(inT);
      box.set('opacity', e.toFixed(3));
      scrim.set('opacity', ease.outQuad(clamp01(t / 0.5)).toFixed(3));
      sheet.set('transform', `translateY(${((1 - e) * 2.6).toFixed(2)}%)`);
      head.set('transform', `translateY(${((1 - ease.outQuart(clamp01((t - 0.05) / 0.34))) * -140).toFixed(1)}%)`);
      head.set('opacity', clamp01((t - 0.05) / 0.18).toFixed(3));

      // ── the order, a line at a time ──────────────────────────────────────
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        const start = ROW_DELAY + i * ROW_STEP;
        const u = clamp01((t - start) / ROW_IN);
        const k = ease.outQuart(u);
        r.box.set('opacity', clamp01(u * 2.4).toFixed(3));
        // In from the right, with the last fraction of the travel overshooting
        // back — the line *arrives* rather than fading up.
        const over = u < 1 ? Math.sin(u * Math.PI) * 1.4 : 0;
        r.box.set('transform', `translateX(${((1 - k) * 26 - over).toFixed(2)}%)`);
        // The points stamp on after the row has settled.
        const pu = clamp01((t - start - 0.2) / 0.22);
        r.pts.set('opacity', pu.toFixed(3));
        r.pts.set('transform', `scale(${(1 + (1 - ease.outBack(pu)) * 0.9).toFixed(3)})`);
        // ...and the player's own line takes a sweep of light as it lands.
        if (r.isPlayer) {
          const f = clamp01((t - start - 0.16) / 0.5);
          r.flash.set('opacity', f < 1 ? (Math.sin(f * Math.PI) * 0.8).toFixed(3) : '0');
          r.flash.set('transform', `translateX(${(-60 + f * 120).toFixed(1)}%)`);
        }
      }

      // ── the championship ─────────────────────────────────────────────────
      const cupStart = ROW_DELAY + count * ROW_STEP + 0.12;
      const cu = clamp01((t - cupStart) / 0.3);
      cupPanel.set('opacity', cu.toFixed(3));
      cupPanel.set('transform', `translateX(${((1 - ease.outQuart(cu)) * 14).toFixed(2)}%)`);
      for (let i = 0; i < cupCells.length; i++) {
        const cu2 = clamp01((t - cupStart - 0.06 - i * 0.045) / 0.24);
        cupCells[i]!.box.set('opacity', cu2.toFixed(3));
        cupCells[i]!.box.set('transform', `translateY(${((1 - ease.outQuart(cu2)) * -34).toFixed(1)}%)`);
      }

      // ── the footer ───────────────────────────────────────────────────────
      const fu = clamp01((t - cupStart - 0.3) / 0.3);
      foot.set('opacity', fu.toFixed(3));
      foot.set('transform', `translateY(${((1 - ease.outQuart(fu)) * 40).toFixed(1)}%)`);

      menu.update(dt);
    },

    reset(): void {
      api.hide();
      clear(table);
      clear(cupRows);
      rows = [];
      cupCells = [];
      menu.reset();
    },

    dispose(): void {
      menu.dispose();
      root.remove();
    },
  };

  return api;
}

/** A gap, in the shortest form that is still unambiguous. */
export function formatGap(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '0.000';
  if (sec < 60) {
    const s = Math.floor(sec);
    const ms = Math.floor((sec % 1) * 1000);
    return `${s}.${String(ms).padStart(3, '0')}`;
  }
  return formatTime(sec);
}

/** The livery chip: the machine's colour, lit from the top like everything else. */
function chipPaint(color: number): string {
  return `linear-gradient(160deg, ${rgba(color, 1)}, ${rgba(color, 0.55)})`;
}
