// The front-end's shared vocabulary: the unit, the plate, the display face and
// the stylesheet every screen is printed on.
//
// This is `ui/theme.ts` continued into the menus rather than a second design.
// The same `--u`, the same dark sign with the lit top edge and the hazard strip
// along its head, the same chevron texture at the threshold of visible. A HUD
// and a title screen that share a product must share a *plate*, or the game
// changes hands the moment the flag falls.
//
// Two rules are inherited wholesale from the HUD and are worth restating,
// because breaking either of them here would be invisible until a reviewer's
// screenshot came back wrong:
//
//   *Nothing animates in CSS.* Not one transition, not one keyframe. The
//   capture harness renders frames by hand with no wall clock at all, so a CSS
//   animation would sit at an unpredictable point in its timeline in every
//   photograph ever taken of these screens. Every motion in this front-end is
//   integrated from the `dt` handed to `update()`.
//
//   *Everything is sized in `--u`.* One viewport-derived unit drives every
//   dimension, so the roster, the stat bars and the wordmark hold their share
//   of the frame from a 1600px review capture down to a phone in landscape.
//
// The one place the menus differ from the HUD is type. The HUD sets no text at
// all — every numeral in it is drawn geometry from `glyphs.ts` — but a
// character select has to say "Right of way is whatever it decides it is", and
// a sentence is not a job for hand-authored path data. So headings and copy are
// set text here, wearing a treatment (ink keyline, extruded under-face, ground
// shadow, back-slant) built to match the drawn face as closely as text can. The
// numerals that *can* be drawn — the engine classes, the step counters — go
// through `glyphRun` so the two faces meet somewhere.

import { U_CSS, hexCss, C } from '../theme.ts';

export { bind, fromHtml, q, hexCss } from '../theme.ts';
export type { Bound } from '../theme.ts';

// ── the stylesheet ─────────────────────────────────────────────────────────

export const CSS_MENU = `
#menu {
  position: fixed; inset: 0; z-index: 40;
  display: none;
  -webkit-user-select: none; user-select: none;
  font-family: 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif;
  color: ${hexCss(C.white)};
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
  contain: layout style paint;

  --u: ${U_CSS};
  --ex: calc(var(--u) * 2.4 + env(safe-area-inset-left, 0px));
  --er: calc(var(--u) * 2.4 + env(safe-area-inset-right, 0px));
  --ey: calc(var(--u) * 1.3 + env(safe-area-inset-top, 0px));
  --eb: calc(var(--u) * 1.3 + env(safe-area-inset-bottom, 0px));

  --yellow: ${hexCss(C.yellow)};
  --orange: ${hexCss(C.orange)};
  --white: ${hexCss(C.white)};
  --gold: ${hexCss(C.gold)};
  --green: ${hexCss(C.green)};
  --red: ${hexCss(C.red)};
  --cyan: ${hexCss(C.cyan)};
  --ink: #0A0D13;
}
#menu.on { display: block; }

/* The stage sits underneath everything: a live 3D set, not a picture of one.
   It is the whole backdrop, so the race behind it — HUD and all — is never
   visible through the menus. */
#menu .stage {
  position: absolute; inset: 0; width: 100%; height: 100%; display: block;
}

/* The grade. A cool corner-to-corner vignette and a warm floor bounce, so the
   3D set is composed rather than merely lit, plus the two hazard rails that
   frame every screen in the product. */
#menu .grade {
  position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(126% 96% at 50% 44%, rgba(0,0,0,0) 44%, rgba(6,9,16,.46) 100%),
    linear-gradient(180deg, rgba(8,11,18,.42) 0%, rgba(8,11,18,0) 22%,
                            rgba(8,11,18,0) 60%, rgba(8,11,18,.5) 100%);
}
/* The rails: hazard tape across the top and bottom of the frame. The strip is
   drawn double-width and translated by JS, so it crawls without a keyframe. */
#menu .rail {
  position: absolute; left: 0; right: 0; height: calc(var(--u) * .62);
  overflow: hidden; pointer-events: none;
  box-shadow: inset 0 0 0 calc(var(--u) * .08) rgba(9,11,15,.9);
  background: rgba(14,17,24,.9);
}
#menu .rail.top { top: 0; }
#menu .rail.bot { bottom: 0; }
#menu .rail i {
  position: absolute; top: 0; bottom: 0; left: 0; width: 300%;
  background: repeating-linear-gradient(114deg,
    ${hexCss(C.yellow)} 0 calc(var(--u) * .78),
    #14171E calc(var(--u) * .78) calc(var(--u) * 1.56));
  opacity: .92;
}

/* ── the sign ───────────────────────────────────────────────────────────── */

#menu .plate {
  position: relative;
  border-radius: calc(var(--u) * .55);
  background: linear-gradient(178deg, rgba(60,67,84,.95) 0%, rgba(30,35,45,.96) 46%, rgba(17,20,27,.96) 100%);
  box-shadow:
    inset 0 calc(var(--u) * .1) 0 rgba(255,255,255,.28),
    inset 0 calc(var(--u) * -.14) 0 rgba(0,0,0,.5),
    0 0 0 calc(var(--u) * .12) rgba(9,11,15,.92),
    0 calc(var(--u) * .22) calc(var(--u) * .62) rgba(0,0,0,.5);
  overflow: hidden;
}
#menu .plate::before {
  content: ''; position: absolute; left: 0; right: 0; top: 0;
  height: calc(var(--u) * .17);
  background: linear-gradient(90deg, #FFC300, #FF9A1A 60%, #FFC300);
  opacity: .95;
}
#menu .plate::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(122deg,
    rgba(255,255,255,.045) 0 calc(var(--u) * .38),
    rgba(255,255,255,0) calc(var(--u) * .38) calc(var(--u) * .78));
}
#menu .plate > * { position: relative; z-index: 1; }
/* A plate whose selection ring lives outside its own edge. The face still
   clips its header strip and its chevrons — they carry the corner radius
   themselves — but the ring is allowed out. Without this, every highlight on
   the course and class screens was drawn and then immediately clipped away by
   the sign it was drawn around. */
#menu .plate.vis { overflow: visible; }
#menu .plate.vis::before {
  border-radius: calc(var(--u) * .55) calc(var(--u) * .55) 0 0;
}
#menu .plate.vis::after { border-radius: calc(var(--u) * .55); }

/* ── the display face ───────────────────────────────────────────────────── */

/* A back-slant, an ink keyline, an extruded under-face and one ground shadow —
   the same four things the drawn numerals carry in their geometry, assembled
   out of what text can do. The keyline is a ring of shadows rather than
   a centred text-stroke, because a stroke painted on the outline eats half its
   width out of the stem and turns a heavy face into a hairline in a box. */
#menu .t {
  display: block; text-transform: uppercase; font-weight: 900;
  line-height: .96; letter-spacing: .012em; white-space: nowrap;
}
#menu .t > i {
  display: block; font-style: normal; transform: skewX(6.5deg);
  text-shadow:
    calc(var(--u) * -.075) 0 0 var(--ink), calc(var(--u) * .075) 0 0 var(--ink),
    0 calc(var(--u) * -.075) 0 var(--ink), 0 calc(var(--u) * .075) 0 var(--ink),
    calc(var(--u) * -.055) calc(var(--u) * -.055) 0 var(--ink),
    calc(var(--u) * .055) calc(var(--u) * -.055) 0 var(--ink),
    calc(var(--u) * -.055) calc(var(--u) * .055) 0 var(--ink),
    calc(var(--u) * .055) calc(var(--u) * .055) 0 var(--ink),
    0 calc(var(--u) * .16) 0 #232B3B,
    0 calc(var(--u) * .3) calc(var(--u) * .34) rgba(0,0,0,.6);
}
/* Copy, and everything that is information rather than a title. No slant, no
   keyline — a blurb wearing a title's costume is a blurb nobody reads. */
#menu .p {
  font-weight: 600; line-height: 1.32; letter-spacing: .015em;
  color: rgba(255,248,240,.9);
  text-shadow: 0 calc(var(--u) * .06) calc(var(--u) * .18) rgba(0,0,0,.8);
}
#menu .cap {
  display: block; text-transform: uppercase; font-weight: 800;
  letter-spacing: .24em; color: rgba(255,195,0,.92);
  text-shadow: 0 calc(var(--u) * .06) calc(var(--u) * .16) rgba(0,0,0,.85);
}
#menu .dim { color: rgba(255,248,240,.5); }

/* Drawn numerals, borrowed from the HUD's own face. The menus size them by
   giving the holder a height, exactly as the readouts do. */
#menu .gl {
  display: block; height: 100%; width: auto; overflow: visible;
  filter: drop-shadow(0 calc(var(--u) * .1) calc(var(--u) * .22) rgba(0,0,0,.55));
}
#menu .glyphs { display: block; }

/* ── screens ────────────────────────────────────────────────────────────── */

#menu .scr {
  position: absolute; inset: 0; pointer-events: none;
  will-change: transform, opacity;
}
#menu .scr.live { pointer-events: auto; }

/* The header every screen after the title wears: what you are choosing, and
   how far through choosing you are. */
#menu .head {
  position: absolute; left: var(--ex); top: calc(var(--ey) + var(--u) * .9);
  display: flex; align-items: baseline; gap: calc(var(--u) * .9);
}
#menu .head .t { font-size: calc(var(--u) * 2.1); }
#menu .step { display: flex; gap: calc(var(--u) * .3); align-items: center; }
#menu .step b {
  display: block; width: calc(var(--u) * 1.5); height: calc(var(--u) * .3);
  border-radius: calc(var(--u) * .15); background: rgba(255,248,240,.22);
  box-shadow: inset 0 0 0 calc(var(--u) * .05) rgba(9,11,15,.7);
}
#menu .step b.now { background: linear-gradient(90deg, var(--yellow), var(--orange)); }
#menu .step b.done { background: rgba(255,195,0,.5); }

/* The choices made so far, carried down the flow so a player always knows what
   they are about to start. */
#menu .tray {
  position: absolute; right: var(--er); top: calc(var(--ey) + var(--u) * .7);
  display: flex; gap: calc(var(--u) * .5); align-items: stretch;
}
#menu .tray .slot {
  padding: calc(var(--u) * .42) calc(var(--u) * .7) calc(var(--u) * .46);
  min-width: calc(var(--u) * 7.4);
}
#menu .tray .slot .cap { font-size: calc(var(--u) * .62); margin-bottom: calc(var(--u) * .22); }
#menu .tray .slot .t { font-size: calc(var(--u) * .96); }
#menu .tray .slot.empty .t { color: rgba(255,248,240,.28); }

/* The prompt rail. Every screen states its own controls; a kart game that
   makes you guess which button confirms has already lost. */
#menu .hint {
  position: absolute; left: 50%; bottom: calc(var(--eb) + var(--u) * .5);
  display: flex; gap: calc(var(--u) * 1.1); align-items: center;
  padding: calc(var(--u) * .42) calc(var(--u) * 1.1);
}
#menu .hint .k { display: flex; align-items: center; gap: calc(var(--u) * .38); }
#menu .hint .key {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: calc(var(--u) * 1.5); height: calc(var(--u) * 1.3);
  padding: 0 calc(var(--u) * .34);
  border-radius: calc(var(--u) * .28);
  background: linear-gradient(180deg, #F3F0E8, #C9C6BE);
  color: #14171E; font-weight: 900; font-size: calc(var(--u) * .74);
  letter-spacing: .02em;
  box-shadow: 0 calc(var(--u) * .12) 0 #6E6B65, 0 calc(var(--u) * .2) calc(var(--u) * .3) rgba(0,0,0,.55);
}
#menu .hint .lbl {
  text-transform: uppercase; font-weight: 800; font-size: calc(var(--u) * .68);
  letter-spacing: .16em; color: rgba(255,248,240,.82);
}

/* ── the wipe ───────────────────────────────────────────────────────────── */
/* A hazard board swung across the frame between screens. Two panels closing
   from the sides and opening again is a cut you can follow; a cross-fade is a
   cut you cannot. */
#menu .wipe { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
#menu .wipe s {
  position: absolute; top: -14%; bottom: -14%; width: 68%;
  display: block;
  background:
    linear-gradient(180deg, rgba(255,255,255,.16), rgba(0,0,0,.22)),
    repeating-linear-gradient(114deg,
      ${hexCss(C.orange)} 0 calc(var(--u) * 1.5),
      #17191F calc(var(--u) * 1.5) calc(var(--u) * 3));
  box-shadow: 0 0 calc(var(--u) * 2) rgba(0,0,0,.7);
}
#menu .wipe s.l { left: 0; transform: translateX(-124%) skewX(-7deg); }
#menu .wipe s.r { right: 0; transform: translateX(124%) skewX(-7deg); }

/* ── the roster ─────────────────────────────────────────────────────────── */

#menu .roster {
  position: absolute; left: 0; right: 0; bottom: calc(var(--eb) + var(--u) * 2.6);
  display: flex; justify-content: center; align-items: flex-end;
  gap: calc(var(--u) * .62);
}
#menu .tile {
  position: relative; width: calc(var(--u) * 6.1); height: calc(var(--u) * 6.1);
  border-radius: calc(var(--u) * .6); cursor: pointer;
  overflow: visible;
}
#menu .tile .face {
  position: absolute; inset: 0; border-radius: calc(var(--u) * .6);
  overflow: hidden;
  background: linear-gradient(168deg, rgba(74,82,101,.96), rgba(20,24,32,.97));
  box-shadow:
    inset 0 calc(var(--u) * .1) 0 rgba(255,255,255,.22),
    0 0 0 calc(var(--u) * .12) rgba(9,11,15,.92),
    0 calc(var(--u) * .22) calc(var(--u) * .55) rgba(0,0,0,.55);
}
/* The machine's own colour, banked into the tile so the roster reads as seven
   different things before a single silhouette has been looked at. */
#menu .tile .wash {
  position: absolute; inset: 0;
  background: radial-gradient(120% 92% at 50% 122%, var(--tint) 0%, rgba(0,0,0,0) 72%);
  opacity: .8;
}
#menu .tile .mark { position: absolute; inset: calc(var(--u) * .52); }
#menu .tile .mark svg { width: 100%; height: 100%; display: block; overflow: visible; }
#menu .tile .ring {
  position: absolute; inset: calc(var(--u) * -.28); border-radius: calc(var(--u) * .86);
  box-shadow:
    0 0 0 calc(var(--u) * .22) ${hexCss(C.yellow)},
    0 0 0 calc(var(--u) * .34) rgba(9,11,15,.95),
    0 0 calc(var(--u) * 1.5) rgba(255,180,40,.6);
  opacity: 0;
}
#menu .tile .no {
  position: absolute; inset: 0; border-radius: calc(var(--u) * .6);
  background: repeating-linear-gradient(114deg,
    rgba(255,195,0,.85) 0 calc(var(--u) * .5), rgba(20,23,30,.85) calc(var(--u) * .5) calc(var(--u) * 1));
  opacity: 0;
}

/* ── stat bars ──────────────────────────────────────────────────────────── */

#menu .stats { display: flex; flex-direction: column; gap: calc(var(--u) * .42); }
#menu .stat { display: flex; align-items: center; gap: calc(var(--u) * .6); }
#menu .stat .sname {
  width: calc(var(--u) * 5.2); text-align: right;
  font-size: calc(var(--u) * .68); font-weight: 800; letter-spacing: .16em;
  text-transform: uppercase; color: rgba(255,248,240,.72);
}
#menu .stat .track {
  position: relative; flex: 1; height: calc(var(--u) * .92);
  border-radius: calc(var(--u) * .2);
  background: rgba(9,11,15,.66);
  box-shadow: inset 0 0 0 calc(var(--u) * .08) rgba(9,11,15,.9),
              inset 0 calc(var(--u) * .1) calc(var(--u) * .2) rgba(0,0,0,.55);
  overflow: hidden;
}
/* Ten notches under the fill, so a bar is read as a *value* and not as a mood. */
#menu .stat .track i {
  position: absolute; inset: 0;
  background: repeating-linear-gradient(90deg,
    rgba(255,255,255,.14) 0 calc(var(--u) * .06), rgba(255,255,255,0) calc(var(--u) * .06) 10%);
}
#menu .stat .fill {
  position: absolute; left: 0; top: 0; bottom: 0; width: 0%;
  background: linear-gradient(180deg, #FFE07A, ${hexCss(C.orange)} 62%, #D8480C);
  box-shadow: inset 0 calc(var(--u) * .1) 0 rgba(255,255,255,.42);
  border-radius: calc(var(--u) * .16);
}
/* The outgoing value, left behind as a ghost for a beat: switching machines
   should show you what you traded away. */
#menu .stat .ghost {
  position: absolute; left: 0; top: 0; bottom: 0; width: 0%;
  background: rgba(95,200,245,.28);
  box-shadow: inset calc(var(--u) * -.1) 0 0 rgba(95,200,245,.85);
  border-radius: calc(var(--u) * .16);
}

/* ── cards (courses, cups, classes) ─────────────────────────────────────── */

#menu .cards {
  position: absolute; left: 50%; display: flex; gap: calc(var(--u) * .9);
  align-items: stretch;
}
#menu .card {
  position: relative; cursor: pointer;
  padding: calc(var(--u) * .7);
  display: flex; flex-direction: column; gap: calc(var(--u) * .5);
}
#menu .card .sel {
  position: absolute; inset: calc(var(--u) * -.26); border-radius: calc(var(--u) * .82);
  box-shadow: 0 0 0 calc(var(--u) * .22) ${hexCss(C.yellow)},
              0 0 0 calc(var(--u) * .34) rgba(9,11,15,.95),
              0 0 calc(var(--u) * 1.6) rgba(255,180,40,.55);
  opacity: 0; pointer-events: none;
}
#menu .card .map { display: block; width: 100%; height: auto; overflow: visible; }
#menu .card .shut {
  position: absolute; inset: 0; border-radius: calc(var(--u) * .55);
  background: rgba(8,10,16,.66);
  display: flex; align-items: center; justify-content: center;
  opacity: 0; pointer-events: none;
}
/* Tape across the card. The stripes are the *edges* of the ribbon, never the
   bed the words sit on: hazard tape behind lettering is hazard tape you cannot
   read the lettering off. */
#menu .card .shut span {
  position: relative;
  transform: rotate(-7deg);
  white-space: nowrap;
  padding: calc(var(--u) * .5) calc(var(--u) * 1.2);
  background: linear-gradient(180deg, #FFE07A, ${hexCss(C.yellow)} 55%, #E8A800);
  color: #14171E; font-weight: 900; font-size: calc(var(--u) * .84);
  letter-spacing: .08em; text-transform: uppercase;
  box-shadow: 0 0 0 calc(var(--u) * .1) rgba(9,11,15,.95),
              0 calc(var(--u) * .2) calc(var(--u) * .4) rgba(0,0,0,.65);
}
#menu .card .shut span::before,
#menu .card .shut span::after {
  content: ''; position: absolute; left: 0; right: 0; height: calc(var(--u) * .18);
  background: repeating-linear-gradient(114deg,
    #14171E 0 calc(var(--u) * .3), rgba(0,0,0,0) calc(var(--u) * .3) calc(var(--u) * .6));
}
#menu .card .shut span::before { top: 0; }
#menu .card .shut span::after { bottom: 0; }

/* ── the title screen ───────────────────────────────────────────────────── */

#menu .mark-wrap {
  position: absolute; left: 50%; top: 31%;
  width: min(74%, calc(var(--u) * 62));
}
#menu .mark-wrap .board {
  position: absolute; left: -6%; right: -6%; top: -26%; bottom: -22%;
  border-radius: calc(var(--u) * 1);
  background:
    linear-gradient(180deg, rgba(28,33,44,.72), rgba(10,13,19,.86));
  box-shadow: 0 0 0 calc(var(--u) * .16) rgba(9,11,15,.9),
              0 calc(var(--u) * .5) calc(var(--u) * 2.2) rgba(0,0,0,.62);
  transform: rotate(-1.4deg);
}
#menu .mark-wrap .board::before,
#menu .mark-wrap .board::after {
  content: ''; position: absolute; left: 0; right: 0; height: calc(var(--u) * .34);
  background: repeating-linear-gradient(114deg,
    ${hexCss(C.orange)} 0 calc(var(--u) * .7), #14171E calc(var(--u) * .7) calc(var(--u) * 1.4));
}
#menu .mark-wrap .board::before { top: 0; border-radius: calc(var(--u) * 1) calc(var(--u) * 1) 0 0; }
#menu .mark-wrap .board::after { bottom: 0; border-radius: 0 0 calc(var(--u) * 1) calc(var(--u) * 1); }
#menu .mark-wrap svg.wm { position: relative; display: block; width: 100%; height: auto; overflow: visible; }
#menu .tagline {
  position: relative; text-align: center; margin-top: calc(var(--u) * .6);
  font-size: calc(var(--u) * .8); font-weight: 800; letter-spacing: .42em;
  text-transform: uppercase; color: rgba(255,248,240,.8);
  text-shadow: 0 calc(var(--u) * .08) calc(var(--u) * .2) rgba(0,0,0,.9);
}

#menu .start {
  position: absolute; left: 50%; bottom: calc(var(--eb) + var(--u) * 4.2);
  text-align: center;
}
#menu .start .t { font-size: calc(var(--u) * 1.9); }
#menu .start .sub {
  margin-top: calc(var(--u) * .5);
  font-size: calc(var(--u) * .68); font-weight: 800; letter-spacing: .2em;
  text-transform: uppercase; color: rgba(255,248,240,.62);
}
#menu .cast {
  position: absolute; left: 0; right: 0; bottom: calc(var(--eb) + var(--u) * 1.5);
  text-align: center; font-size: calc(var(--u) * .66); font-weight: 800;
  letter-spacing: .3em; text-transform: uppercase; color: rgba(255,248,240,.4);
}

/* ── the detail plate on character select ───────────────────────────────── */

#menu .dossier {
  position: absolute; right: var(--er); top: 50%;
  width: calc(var(--u) * 24); padding: calc(var(--u) * .95) calc(var(--u) * 1.1) calc(var(--u) * 1.1);
}
#menu .dossier .who { font-size: calc(var(--u) * 2.3); margin-top: calc(var(--u) * .3); }
#menu .dossier .blurb {
  font-size: calc(var(--u) * .84); margin: calc(var(--u) * .55) 0 calc(var(--u) * .9);
  min-height: calc(var(--u) * 2.4);
}
#menu .dossier .kind { font-size: calc(var(--u) * .64); }

/* ── the class screen ───────────────────────────────────────────────────── */

#menu .cc { width: calc(var(--u) * 12.6); align-items: center; text-align: center; }
#menu .cc .num { height: calc(var(--u) * 3.5); display: flex; justify-content: center; }
#menu .cc .num .gl { color: var(--gold); }
#menu .cc .desc { font-size: calc(var(--u) * .8); min-height: calc(var(--u) * 2.6); }
#menu .cc .meter {
  position: relative; width: 100%; height: calc(var(--u) * .78);
  border-radius: calc(var(--u) * .18); overflow: hidden;
  background: rgba(9,11,15,.7);
  box-shadow: inset 0 0 0 calc(var(--u) * .08) rgba(9,11,15,.9);
}
#menu .cc .meter i {
  position: absolute; left: 0; top: 0; bottom: 0;
  background: linear-gradient(90deg, ${hexCss(C.cyan)}, ${hexCss(C.yellow)} 55%, ${hexCss(C.red)});
}

/* ── the course screen ──────────────────────────────────────────────────── */

#menu .cups {
  position: absolute; left: 50%; top: calc(var(--ey) + var(--u) * 4.6);
  display: flex; gap: calc(var(--u) * .6);
}
#menu .cupTab {
  position: relative; cursor: pointer;
  padding: calc(var(--u) * .5) calc(var(--u) * 1.05) calc(var(--u) * .56);
  display: flex; align-items: center; gap: calc(var(--u) * .5);
}
#menu .cupTab .t { font-size: calc(var(--u) * .92); }
#menu .cupTab .em { width: calc(var(--u) * 1.5); height: calc(var(--u) * 1.5); display: block; }
#menu .cupTab .sel {
  position: absolute; inset: calc(var(--u) * -.2); border-radius: calc(var(--u) * .74);
  box-shadow: 0 0 0 calc(var(--u) * .18) ${hexCss(C.yellow)},
              0 0 0 calc(var(--u) * .28) rgba(9,11,15,.95);
  opacity: 0; pointer-events: none;
}
#menu .courseCard { width: calc(var(--u) * 17.5); min-height: calc(var(--u) * 15.6); }
#menu .courseCard .t { font-size: calc(var(--u) * 1.05); }
#menu .facts { display: flex; gap: calc(var(--u) * 1.1); }
#menu .facts div { display: flex; flex-direction: column; gap: calc(var(--u) * .12); }
#menu .facts .v { font-size: calc(var(--u) * .92); font-weight: 900; }
#menu .facts .k {
  font-size: calc(var(--u) * .56); font-weight: 800; letter-spacing: .18em;
  text-transform: uppercase; color: rgba(255,248,240,.5);
}
`;

// ── small builders ─────────────────────────────────────────────────────────

/** A title run in the display face. */
export const title = (text: string, cls = ''): string =>
  `<span class="t ${cls}"><i>${text}</i></span>`;

/** The keycap + label pair the prompt rail is made of. */
export const hintKey = (key: string, label: string): string =>
  `<span class="k"><span class="key">${key}</span><span class="lbl">${label}</span></span>`;

/**
 * A course's shape, drawn straight from its control points.
 *
 * The course-select card has to show the *layout* — where the hairpin is, which
 * way the esses go — and the only honest source for that is the geometry the
 * track is actually built from. Normalised into a 100x100 box so a long
 * circuit and a short one are both readable at the same card size.
 */
export function courseMap(points: Array<{ x: number; z: number }>, cls = ''): string {
  if (points.length < 3) return '';
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const span = Math.max(maxX - minX, maxZ - minZ) || 1;
  const ox = (span - (maxX - minX)) / 2;
  const oz = (span - (maxZ - minZ)) / 2;
  let d = '';
  // Every third point: the spline is resampled to a metre or two and a card
  // 200px wide cannot show that, but it can show every corner.
  const stride = Math.max(1, Math.round(points.length / 90));
  for (let i = 0; i < points.length; i += stride) {
    const p = points[i]!;
    const x = ((p.x - minX + ox) / span) * 92 + 4;
    const y = ((p.z - minZ + oz) / span) * 92 + 4;
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  d += 'Z';
  const start = points[0]!;
  const sx = ((start.x - minX + ox) / span) * 92 + 4;
  const sy = ((start.z - minZ + oz) / span) * 92 + 4;
  return `<svg class="map ${cls}" viewBox="0 0 100 100" aria-hidden="true">`
    + `<path d="${d}" fill="none" stroke="#0A0D13" stroke-width="9.5" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<path d="${d}" fill="none" stroke="#55606F" stroke-width="6.6" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<path d="${d}" fill="none" stroke="${hexCss(C.white)}" stroke-width="1.1" stroke-linejoin="round"`
    + ` stroke-dasharray="3 4" opacity=".55"/>`
    + `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="4.2" fill="${hexCss(C.yellow)}"`
    + ` stroke="#0A0D13" stroke-width="1.6"/>`
    + `</svg>`;
}

/**
 * The card a cup with no circuits in it shows: a site plan with nothing
 * surveyed on it yet. Deliberately the same object as a real course card, at
 * the same size, wearing tape — a slot that collapses to nothing reads as a
 * layout bug, and a slot that is simply absent reads as a shorter game.
 */
export function plannedMap(): string {
  return `<svg class="map" viewBox="0 0 100 100" aria-hidden="true">`
    + `<rect x="7" y="7" width="86" height="86" rx="9" fill="none" stroke="#4C5665"`
    + ` stroke-width="3.4" stroke-dasharray="8 7" stroke-linecap="round"/>`
    + `<path d="M50 30 L61 66 H39 Z" fill="#3C434F" stroke="#4C5665" stroke-width="2.6"`
    + ` stroke-linejoin="round"/>`
    + `<rect x="41" y="56" width="18" height="5" fill="#4C5665"/>`
    + `<rect x="34" y="70" width="32" height="6" rx="2" fill="#3C434F"/>`
    + `</svg>`;
}

/**
 * A cup emblem: a shield with the cup's own colour and a cone on it.
 *
 * Procedural rather than authored one by one, so a cup added later gets a mark
 * that belongs to the same set without anybody drawing anything.
 */
export function cupEmblem(color: number, dim = false): string {
  const c = hexCss(color);
  const o = dim ? '.35' : '1';
  return `<svg class="em" viewBox="0 0 32 32" aria-hidden="true" style="opacity:${o}">`
    + `<path d="M4 4h24v14c0 6-5 10-12 10S4 24 4 18Z" fill="${c}" stroke="#0A0D13" stroke-width="2.4"`
    + ` stroke-linejoin="round"/>`
    + `<path d="M16 9l5.5 13h-11Z" fill="#FFF8F0" stroke="#0A0D13" stroke-width="1.6" stroke-linejoin="round"/>`
    + `<rect x="12.4" y="17" width="7.2" height="2.1" fill="${hexCss(C.orange)}"/>`
    + `</svg>`;
}
