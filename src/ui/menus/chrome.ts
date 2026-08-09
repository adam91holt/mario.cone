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
import type { CourseDef } from '../../types.ts';

export { bind, fromHtml, q, hexCss, unitPx } from '../theme.ts';
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
/* The keycap. Declared once rather than once per rail, because the call to
   action on the class screen wears one too — a button that shows the key that
   presses it never has to be repeated in the prompt rail underneath it. */
#menu .key {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: calc(var(--u) * 1.5); height: calc(var(--u) * 1.3);
  padding: 0 calc(var(--u) * .34);
  border-radius: calc(var(--u) * .28);
  background: linear-gradient(180deg, #F3F0E8, #C9C6BE);
  color: #14171E; font-weight: 900; font-size: calc(var(--u) * .74);
  letter-spacing: .02em;
  box-shadow: 0 calc(var(--u) * .12) 0 #6E6B65, 0 calc(var(--u) * .2) calc(var(--u) * .3) rgba(0,0,0,.55);
}
#menu .scr-class .go .key {
  min-width: calc(var(--u) * 2.1); height: calc(var(--u) * 1.9);
  font-size: calc(var(--u) * 1.05); border-radius: calc(var(--u) * .34);
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
/* Wider than half the frame, and hung outside it on both edges. The panels are
   skewed seven degrees, which shifts each corner sideways by about four percent
   of the frame — so a panel that starts exactly at x=0 leaves a wedge of bare
   screen in the top-left corner at the one moment the board is supposed to be
   *shut*. That wedge used to show the menu's own set behind it and was
   invisible; now that the set goes dark for the hand-off, it shows the race,
   and a tear in the curtain is the last thing a curtain may have. */
#menu .wipe s {
  position: absolute; top: -14%; bottom: -14%; width: 78%;
  display: block;
  background:
    linear-gradient(180deg, rgba(255,255,255,.16), rgba(0,0,0,.22)),
    repeating-linear-gradient(114deg,
      ${hexCss(C.orange)} 0 calc(var(--u) * 1.5),
      #17191F calc(var(--u) * 1.5) calc(var(--u) * 3));
  box-shadow: 0 0 calc(var(--u) * 2) rgba(0,0,0,.7);
}
#menu .wipe s.l { left: -10%; transform: translateX(-124%) skewX(-7deg); }
#menu .wipe s.r { right: -10%; transform: translateX(124%) skewX(-7deg); }

/* ── the roster ─────────────────────────────────────────────────────────── */

/* Clear of the prompt rail by a whole unit and a half. It used to end two
   pixels above the rail's gold edge at 1600x900 and *underneath* it at
   900x506 — the roster and the legend telling you how to drive it were the
   same object. */
#menu .roster {
  position: absolute; left: 0; right: 0; bottom: calc(var(--eb) + var(--u) * 4.7);
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

/* ── the cursor ─────────────────────────────────────────────────────────── */
/* One ring per screen, and it *travels*. Fading a ring out of one cell and
   into another says "something changed"; sliding the same ring across says
   where the cursor went, which is the difference between a list of buttons and
   a cursor moving over a list of buttons. Sized and placed from JS, because
   only JS knows which cell is chosen and how far its spring has thrown it. */
#menu .rove {
  position: absolute; left: 0; top: 0; pointer-events: none; opacity: 0;
  border-radius: calc(var(--u) * .86);
  box-shadow:
    0 0 0 calc(var(--u) * .22) ${hexCss(C.yellow)},
    0 0 0 calc(var(--u) * .34) rgba(9,11,15,.95),
    0 0 calc(var(--u) * 1.5) rgba(255,180,40,.62);
  z-index: 5;
}
#menu .rove.cupRing {
  border-radius: calc(var(--u) * .74);
  box-shadow:
    0 0 0 calc(var(--u) * .18) ${hexCss(C.yellow)},
    0 0 0 calc(var(--u) * .28) rgba(9,11,15,.95),
    0 0 calc(var(--u) * 1.2) rgba(255,180,40,.55);
}
#menu .rove.cardRing, #menu .rove.classRing { border-radius: calc(var(--u) * .82); }

/* The *other* row's choice. Deliberately not the same object as the cursor:
   a thin cream keyline with no glow and no lift. The two rows used to differ
   by nothing but the opacity of one gold ring — 1.0 against 0.55 — which
   photographed as no difference at all. */
#menu .held {
  position: absolute; inset: calc(var(--u) * -.18); border-radius: calc(var(--u) * .78);
  box-shadow:
    0 0 0 calc(var(--u) * .14) rgba(255,248,240,.82),
    0 0 0 calc(var(--u) * .26) rgba(9,11,15,.92);
  opacity: 0; pointer-events: none;
}
/* ...and a corner tick on the same object, so the difference between "this row
   holds it" and "this row has the cursor" survives a black-and-white print as
   well as it survives colour. */
#menu .held::before, #menu .held::after {
  content: ''; position: absolute; width: calc(var(--u) * .9); height: calc(var(--u) * .9);
  border: 0 solid rgba(255,248,240,.92);
}
#menu .held::before {
  left: calc(var(--u) * -.34); top: calc(var(--u) * -.34);
  border-left-width: calc(var(--u) * .2); border-top-width: calc(var(--u) * .2);
  border-radius: calc(var(--u) * .5) 0 0 0;
}
#menu .held::after {
  right: calc(var(--u) * -.34); bottom: calc(var(--u) * -.34);
  border-right-width: calc(var(--u) * .2); border-bottom-width: calc(var(--u) * .2);
  border-radius: 0 0 calc(var(--u) * .5) 0;
}
/* The chosen cell paints over its neighbours. Without this the ring around a
   scaled-up card is drawn and then covered by the card next to it. */
#menu .card.hot, #menu .cupTab.hot, #menu .tile.hot { z-index: 3; }

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
/* What just changed, drawn *over* the fill as a hatched segment between the old
   reading and the new one.
   This used to be a ghost of the previous value drawn *behind* the fill, which
   hid every improvement underneath the very bar that had just grown past it:
   swapping the cone for the sedan gains 27 points of speed and 119 of weight,
   and the only segments a player could see were the two stats that got worse.
   Half the information on the screen was invisible by construction. */
#menu .stat .delta {
  position: absolute; left: 0; top: 0; bottom: 0; width: 0%;
  border-radius: calc(var(--u) * .16);
  background: repeating-linear-gradient(114deg,
    rgba(255,75,58,.95) 0 calc(var(--u) * .17),
    rgba(255,75,58,.4) calc(var(--u) * .17) calc(var(--u) * .34));
  box-shadow: inset 0 0 0 calc(var(--u) * .07) rgba(9,11,15,.6);
  opacity: 0; pointer-events: none;
}
#menu .stat .delta.up {
  background: repeating-linear-gradient(114deg,
    rgba(111,224,74,.95) 0 calc(var(--u) * .17),
    rgba(111,224,74,.4) calc(var(--u) * .17) calc(var(--u) * .34));
}
/* ...and the same fact stated a second way, for the glance that never reaches
   the bar. */
#menu .stat .arrow {
  width: calc(var(--u) * .95); text-align: center; line-height: 1;
  font-size: calc(var(--u) * .82); font-weight: 900; font-style: normal;
  color: ${hexCss(C.red)}; opacity: 0;
  text-shadow: 0 calc(var(--u) * .06) calc(var(--u) * .14) rgba(0,0,0,.9);
}
#menu .stat .arrow.up { color: ${hexCss(C.green)}; }

/* ── cards (courses, cups, classes) ─────────────────────────────────────── */

/* The gap has to clear the *scaled* card plus its ring, or a highlight is drawn
   and then painted over by the neighbour it grew into. */
#menu .cards {
  position: absolute; left: 50%; display: flex; gap: calc(var(--u) * 1.2);
  align-items: stretch;
}
#menu .card {
  position: relative; cursor: pointer;
  padding: calc(var(--u) * .7);
  display: flex; flex-direction: column; gap: calc(var(--u) * .5);
}
#menu .card .map { display: block; width: 100%; height: auto; overflow: visible; }

/* ── the title screen ───────────────────────────────────────────────────── */

/* Higher than centre and hung on a board that hugs it. The board used to run
   from a quarter of the mark's height above it to a fifth below, which made it
   the largest object on the title screen by some distance — a black rectangle
   across the top half of the frame with the cast driving along behind its
   bottom edge, half of them cut in two by it. A sign is the right idea; a sign
   the size of the sky is not. */
#menu .mark-wrap {
  position: absolute; left: 50%; top: 27%;
  width: min(68%, calc(var(--u) * 56));
}
#menu .mark-wrap .board {
  position: absolute; left: -4.5%; right: -4.5%; top: -17%; bottom: -12%;
  border-radius: calc(var(--u) * 1);
  background:
    linear-gradient(180deg, rgba(34,40,53,.86), rgba(12,15,22,.92));
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
/* A scrim under the call to action, and the only place in this front-end where
   a statement is not made on a plate — a sign under the wordmark would be a
   second sign competing with the first. At 1600x900 the prompt lands on bare
   asphalt and needs nothing; at 900x506 the same prompt lands squarely on the
   black-and-yellow kerb across the set, and the line naming the keys that press
   it becomes unreadable. This is the vignette from the grade, local to the one
   place that needs it. */
#menu .start::before {
  content: ''; position: absolute; left: 50%; top: 46%;
  width: calc(var(--u) * 30); height: calc(var(--u) * 9);
  transform: translate(-50%, -50%);
  background: radial-gradient(58% 52% at 50% 50%,
    rgba(6,9,16,.78) 0%, rgba(6,9,16,.5) 46%, rgba(6,9,16,0) 76%);
  pointer-events: none; z-index: -1;
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
#menu .courseCard { width: calc(var(--u) * 16.4); }
#menu .courseCard .t { font-size: calc(var(--u) * 1.05); }
/* The picture of the place.

   The four cards used to be identical dark slabs each carrying a grey route
   line and three unit labels, and the critique was exactly right about it: Cone
   Canyon, Jackhammer Quarry, Saltpan Bypass and Switchback Summit were
   indistinguishable, and the only thing on them was engineering data. A circuit
   select has to answer "what is it like there" before it answers "how long is
   it".

   So every card now carries a small painting of its own circuit, drawn from the
   course's *own theme block* — its sky gradient, its ground colour, its haze,
   its road base and edge paint, and a horizon keyed off the props the world
   system dresses it with. Nothing here is authored per course; add a fifth
   circuit and it arrives with a picture. */
#menu .courseCard .scene {
  position: relative; width: 100%; line-height: 0;
  border-radius: calc(var(--u) * .34);
  overflow: hidden;
  box-shadow: inset 0 0 0 calc(var(--u) * .09) rgba(9,11,15,.8),
              0 calc(var(--u) * .1) calc(var(--u) * .3) rgba(0,0,0,.45);
}
#menu .courseCard .scene svg { display: block; width: 100%; height: auto; }
#menu .courseCard .row {
  display: flex; align-items: center; gap: calc(var(--u) * .75);
}
#menu .courseCard .mapbox { width: 47%; flex: 0 0 auto; }
#menu .courseCard .row .facts { flex-direction: column; gap: calc(var(--u) * .42); }
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

// ── the picture of a place ─────────────────────────────────────────────────

/**
 * A deterministic little RNG seeded off a string.
 *
 * Two cards must be identical on every boot — a review sheet whose horizon is a
 * different shape in every screenshot is a review sheet nobody can compare —
 * and nothing in this product may reach for `Math.random`.
 */
function seedFrom(s: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (): number => {
    h = (Math.imul(h, 48271) + 2531011) >>> 0;
    return (h >>> 8) / 0x1000000;
  };
}

/** Blend two packed colours and return CSS. Used to fog a distant ridge back
 *  toward the course's own haze, which is what makes a horizon read as far. */
function mixHex(a: number, b: number, t: number): string {
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t);
  const l = Math.round((a & 255) + ((b & 255) - (a & 255)) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | l).toString(16).slice(1)}`;
}

type Ridge = (rnd: () => number, w: number, hz: number, lo: number, hi: number) => string;

/** Flat-topped mesas — a canyon. */
const ridgeMesa: Ridge = (rnd, w, hz, lo, hi) => {
  let d = `M-8 ${hz}`;
  let x = -8;
  while (x < w + 8) {
    const bw = 22 + rnd() * 28;
    const h = lo + rnd() * (hi - lo);
    const s = 3 + rnd() * 5;
    d += `L${(x + s).toFixed(1)} ${(hz - h).toFixed(1)}`
      + `L${(x + bw - s).toFixed(1)} ${(hz - h).toFixed(1)}`
      + `L${(x + bw).toFixed(1)} ${hz}`;
    x += bw + 2 + rnd() * 13;
    if (x < w + 8) d += `L${x.toFixed(1)} ${hz}`;
  }
  return `${d}L${w + 8} ${hz}Z`;
};

/** Terraced benches — a working pit. */
const ridgeBench: Ridge = (rnd, w, hz, lo, hi) => {
  let d = `M-8 ${hz}`;
  let x = -8;
  while (x < w + 8) {
    const bw = 30 + rnd() * 24;
    const steps = 2 + Math.floor(rnd() * 3);
    const h = lo + rnd() * (hi - lo);
    for (let s = 1; s <= steps; s++) {
      const y = (hz - (h * s) / steps).toFixed(1);
      d += `L${(x + (bw * (s - 1)) / (steps * 2.2)).toFixed(1)} ${y}`
        + `L${(x + (bw * s) / (steps * 2.2)).toFixed(1)} ${y}`;
    }
    for (let s = steps; s >= 1; s--) {
      const y = (hz - (h * s) / steps).toFixed(1);
      d += `L${(x + bw - (bw * s) / (steps * 2.2)).toFixed(1)} ${y}`
        + `L${(x + bw - (bw * (s - 1)) / (steps * 2.2)).toFixed(1)} ${y}`;
    }
    x += bw + 1;
    d += `L${x.toFixed(1)} ${hz}`;
  }
  return `${d}L${w + 8} ${hz}Z`;
};

/** Sharp peaks — altitude. */
const ridgePeak: Ridge = (rnd, w, hz, lo, hi) => {
  let d = `M-10 ${hz}`;
  let x = -10;
  while (x < w + 10) {
    const bw = 24 + rnd() * 26;
    const h = lo + rnd() * (hi - lo);
    d += `L${(x + bw * 0.5).toFixed(1)} ${(hz - h).toFixed(1)}L${(x + bw).toFixed(1)} ${hz}`;
    x += bw * (0.7 + rnd() * 0.22);
  }
  return `${d}L${w + 10} ${hz}Z`;
};

/** Almost nothing, a long way off — a salt flat. */
const ridgeFlat: Ridge = (rnd, w, hz, lo, hi) => {
  let d = `M-8 ${hz}`;
  let x = -8;
  while (x < w + 8) {
    const bw = 32 + rnd() * 36;
    const h = lo * 0.3 + rnd() * (hi - lo) * 0.24;
    d += `L${(x + bw * 0.28).toFixed(1)} ${(hz - h).toFixed(1)}`
      + `L${(x + bw * 0.72).toFixed(1)} ${(hz - h * 0.72).toFixed(1)}`
      + `L${(x + bw).toFixed(1)} ${hz}`;
    x += bw;
  }
  return `${d}L${w + 8} ${hz}Z`;
};

/**
 * A picture of a circuit, drawn from the circuit's own theme.
 *
 * Sky gradient, haze band, two ridges fogged back at different depths, the
 * ground colour, and the road running to the horizon in the course's own
 * asphalt with its own edge paint on it — every one of those numbers comes out
 * of `CourseDef.theme`, which is the same block the renderer lights the real
 * place with. The horizon's *shape* is chosen off the props the world system
 * dresses that course with, so a quarry gets benches and a summit gets peaks.
 */
export function courseScene(course: CourseDef): string {
  const th = course.theme ?? {};
  const sky = th.sky ?? { top: 0x2e86d6, bottom: 0xbfe7ff, horizon: 0xffe2b0 };
  const ground = th.ground ?? 0xc99a5b;
  const haze = th.fog?.color ?? sky.bottom;
  const road = th.road ?? {};
  const props = (th.props ?? {}) as Record<string, unknown>;
  const rnd = seedFrom(course.id);

  const W = 200;
  const H = 74;
  const HZ = 41;
  const id = `cs-${course.id}`;

  const ridge: Ridge = props.quarry ? ridgeBench
    : props.alpine ? ridgePeak
      : props.saltpan ? ridgeFlat
        : ridgeMesa;

  // Two bands of land at different depths, each fogged toward the course's own
  // haze by how far away it is. One ridge reads as a fence; two read as land.
  const far = ridge(rnd, W, HZ, 14, 26);
  const near = ridge(rnd, W, HZ + 3, 7, 15);
  const farInk = mixHex(ground, haze, 0.62);
  const nearInk = mixHex(ground, haze, 0.3);

  // The sun sits where the course's own key light is: azimuth across the frame,
  // elevation up it.
  const sun = th.sun ?? { color: 0xfff2d8, intensity: 2.6, azimuth: 0.7, elevation: 0.85 };
  const sx = ((Math.sin(sun.azimuth) * 0.5 + 0.5) * 0.7 + 0.15) * W;
  const sy = HZ - Math.min(1, sun.elevation) * (HZ - 8);

  const base = road.base ?? '#3A3D46';
  const edge = road.edge ?? hexCss(C.yellow);
  const line = road.line ?? hexCss(C.white);

  // The road: a wedge from the bottom of the frame to a point on the horizon,
  // with its own edge paint down both sides and a dashed centre line.
  const vx = W * 0.54;
  const roadPoly = `${(vx - 3).toFixed(1)},${HZ + 3} ${(vx + 3).toFixed(1)},${HZ + 3}`
    + ` ${(W * 0.5 + 62).toFixed(0)},${H} ${(W * 0.5 - 52).toFixed(0)},${H}`;

  let dressing = '';
  if (props.alpine) {
    // Pines along the near ground.
    for (let i = 0; i < 9; i++) {
      const x = 6 + rnd() * (W - 12);
      const h = 7 + rnd() * 6;
      const y = HZ + 5 + rnd() * 9;
      if (Math.abs(x - vx) < 16) continue;
      dressing += `<path d="M${x.toFixed(1)} ${(y - h).toFixed(1)}`
        + `L${(x + h * 0.34).toFixed(1)} ${y.toFixed(1)}H${(x - h * 0.34).toFixed(1)}Z"`
        + ` fill="#2C4433"/>`;
    }
  } else if (props.quarry) {
    // A conveyor on legs, running off the left of the pit.
    dressing += `<path d="M6 ${HZ - 3}L58 ${HZ - 15}" stroke="#4A4E57" stroke-width="2.6"`
      + ` stroke-linecap="round"/>`
      + `<path d="M20 ${HZ - 6}v6M40 ${HZ - 10}v10" stroke="#3A3E46" stroke-width="1.8"/>`;
  } else if (props.saltpan) {
    // Survey pegs: this place has nothing in it, and that is the point.
    for (let i = 0; i < 5; i++) {
      const x = 14 + rnd() * (W - 28);
      if (Math.abs(x - vx) < 18) continue;
      dressing += `<path d="M${x.toFixed(1)} ${HZ + 2}v-7" stroke="#8A8577" stroke-width="1.4"/>`
        + `<rect x="${(x - 0.6).toFixed(1)}" y="${HZ - 6}" width="3.6" height="2.4" fill="${edge}"/>`;
    }
  } else {
    // Cones, obviously.
    for (let i = 0; i < 6; i++) {
      const x = 10 + rnd() * (W - 20);
      const y = HZ + 8 + rnd() * 12;
      if (Math.abs(x - vx) < 20) continue;
      const h = 4 + rnd() * 3;
      dressing += `<path d="M${x.toFixed(1)} ${(y - h).toFixed(1)}`
        + `L${(x + h * 0.42).toFixed(1)} ${y.toFixed(1)}H${(x - h * 0.42).toFixed(1)}Z"`
        + ` fill="${hexCss(C.orange)}"/>`;
    }
  }

  return `<svg class="place" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`
    + `<defs>`
    + `<linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${hexCss(sky.top)}"/>`
    + `<stop offset=".62" stop-color="${hexCss(sky.bottom)}"/>`
    + `<stop offset="1" stop-color="${hexCss(sky.horizon ?? sky.bottom)}"/>`
    + `</linearGradient>`
    + `<radialGradient id="${id}-sun">`
    + `<stop offset="0" stop-color="${hexCss(sun.color)}" stop-opacity=".95"/>`
    + `<stop offset="1" stop-color="${hexCss(sun.color)}" stop-opacity="0"/>`
    + `</radialGradient>`
    + `<linearGradient id="${id}-gnd" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${mixHex(ground, haze, 0.26)}"/>`
    + `<stop offset="1" stop-color="${mixHex(ground, 0x000000, 0.16)}"/>`
    + `</linearGradient>`
    + `</defs>`
    + `<rect width="${W}" height="${HZ + 4}" fill="url(#${id}-sky)"/>`
    + `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="22" fill="url(#${id}-sun)"/>`
    + `<path d="${far}" fill="${farInk}"/>`
    + `<path d="${near}" fill="${nearInk}"/>`
    + `<rect y="${HZ + 3}" width="${W}" height="${H - HZ - 3}" fill="url(#${id}-gnd)"/>`
    + `<polygon points="${roadPoly}" fill="${base}"/>`
    + `<path d="M${(vx - 3).toFixed(1)} ${HZ + 3}L${(W * 0.5 - 52).toFixed(0)} ${H}"`
    + ` stroke="${edge}" stroke-width="2" fill="none"/>`
    + `<path d="M${(vx + 3).toFixed(1)} ${HZ + 3}L${(W * 0.5 + 62).toFixed(0)} ${H}"`
    + ` stroke="${edge}" stroke-width="2" fill="none"/>`
    + `<path d="M${vx.toFixed(1)} ${HZ + 4}L${(W * 0.5 + 5).toFixed(0)} ${H}"`
    + ` stroke="${line}" stroke-width="1.6" stroke-dasharray="3 5" fill="none" opacity=".8"/>`
    + dressing
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
