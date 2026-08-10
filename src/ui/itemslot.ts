// The item slot, and the roulette that fills it.
//
// This is the one widget on screen the player looks at while they are busy
// driving, so it sits dead centre at the top of the frame — directly above the
// kart, on the line their eye is already on — and it is the loudest object in
// the HUD: a hazard-ringed socket, the size of a road sign, that shakes while
// it is deciding and punches when it lands.
//
// **How it coordinates with the item system.** `items/reel.ts` ships a slot of
// its own and stands down the moment it finds an element marked
// `data-item-slot`, leaving its screen effects (ink, warning vignette, hit
// flash) in place. That handoff is why this widget is built in the *factory*
// rather than in `init()`: systems initialise in `order`, items (50) is long
// before ui (100), and a marker that arrives after the item system has looked
// for it is a marker that never existed. See `createHudSystem`.
//
// Everything the slot shows is read from `ctx.player.item` / `.itemCount` — the
// simulation's own truth, so a lightning bolt that empties the slot, a boo that
// steals from it and the harness' `__ITEMS.give` all land here without any of
// them having to know this widget exists. The bus carries only what state
// cannot express: that a roulette *started* and how long it will run
// (`item:roulette` `start`, with its `duration`), where its reel is and how much
// of it is left (`item:reel`, once per face), and that it stopped. The drum in
// this socket therefore turns on the item system's clock rather than on a copy
// of its tuning constants — including when the player cuts the spin short.

import { clamp01, ease } from '../core/math.ts';
import { ITEMS, REEL_FACES } from '../items/defs.ts';
import type { GameContext, ItemId, Racer } from '../types.ts';
import { glyphBox } from './glyphs.ts';
import { itemIconSvg, ITEM_IDS } from './icons.ts';
import {
  bind, fromHtml, hexCss, q, rgba, TIER_COLORS, TIER_RING, unitPx, type Bound,
} from './theme.ts';

/**
 * The spin length to fall back on if the item system ever stops stating one.
 *
 * **It is a fallback and nothing else now.** This used to be a copy of
 * `SPIN_PLAYER` — two modules holding the same tuning constant, which is a
 * desync waiting for the first time either is touched — and worse, a constant
 * cannot know about the things that change a spin's length while it is running.
 * The item system's contract (ARCHITECTURE §7) hands both facts over on the
 * bus: `item:roulette` `start` carries the `duration` this spin will actually
 * run for, and `item:reel` fires once per face of the drum with `remaining`
 * counting down to zero on the settle. This widget decelerates on those, so a
 * player who *slot-stops* the reel — taps the item button to cut a second of
 * theatre down to eighty milliseconds — sees the drum snap into the answer
 * instead of carrying on at a cadence timed for a spin that is no longer
 * happening.
 */
const FALLBACK_SPIN = 1.05;

// ── the spin, as a function of the race rather than of the frame rate ──────
//
// **The drum's position is derived, not integrated, and that is the whole fix.**
//
// What was here before advanced `drumPhase` by `speed * dt` inside `update`, and
// `update` is the *render* clock. `window.__GAME.step()` — how every capture,
// every trace and every reviewer's bench drives this game — runs the simulation
// with no render at all, so a roulette that the item system ran for a full 1.05
// seconds of race handed this widget about 0.067 seconds of `dt` to spend on it.
// Measured, not guessed: the drum crossed three faces in a fourteen-face spin and
// then sat still while a second of race went past, and the answer appeared with
// no wheel behind it. The animation was not slow, it was *unaddressed* — nothing
// was ever wrong in real time, and nothing was ever right in a photograph.
//
// So the drum is now a pure function of how far through the spin the *simulation*
// is: `item:reel` states the time left on every face of the item system's own
// reel, and the position, the speed and the blur all fall out of that one number.
// A single frame rendered anywhere in the spin is therefore the frame that spin
// should show, whether sixty of them were drawn or one.

/** Faces the drum travels in a nominal spin, before it is squared to land. */
const SPIN_CELLS = 14;
/** Deceleration: velocity falls as (1-u)^(SPIN_EASE-1) across the spin. */
const SPIN_EASE = 2.4;
/** ...and the creep it keeps to the last frame, so it never looks parked. */
const SPIN_CREEP = 0.06;
/** Seconds the final face takes to clunk into the answer. */
const LAND_TIME = 0.17;

/** 0..1 of the travel, against 0..1 of the spin. Eases out; never quite stops. */
const spinShape = (u: number): number =>
  (1 - Math.pow(1 - u, SPIN_EASE)) * (1 - SPIN_CREEP) + u * SPIN_CREEP;
/** ...and its derivative, which is the smear. */
const spinRate = (u: number): number =>
  SPIN_EASE * Math.pow(1 - u, SPIN_EASE - 1) * (1 - SPIN_CREEP) + SPIN_CREEP;

// ── the charge collar ──────────────────────────────────────────────────────
//
// The mini-turbo meter, moved here off the speedometer that used to carry it.
//
// The drift charge has to be readable without looking away from the road, and
// the socket at the top of the frame is the one piece of HUD the player is
// already glancing at every few seconds. So the meter is a collar around it: a
// rounded track following the socket's own corners, filling symmetrically from
// twelve o'clock, changing colour, stroke weight and halo at each tier.
//
// Filled in *thirds* rather than linearly against the raw charge. The sim's
// thresholds are not evenly spaced — blue lands at 0.80 and purple at 3.00 — so
// a linear arc puts blue at a quarter of the collar and spends the whole second
// half of the sweep inside one tier. An equal third per tier means the geometry
// says the same thing the colour does, and "two thirds round" always means
// "one more beat to purple".

/**
 * The socket, in `--u`.
 *
 * **Sized against the rest of the set, not against the space available.** At
 * 6.1 this was the *smallest* of the five clusters on screen — a third of the
 * area of the minimap, two thirds the height of the place indicator — while
 * being, by this module's own argument, the one widget the player looks at
 * while they are busy driving. A first-party racer gives the item frame about
 * an eighth of the frame's height, which is what this is: at review resolution
 * a 116px socket, comfortably clear of the banner line at 21% and of the
 * countdown numeral below it, and unmistakably the loudest object in the HUD.
 */
const SLOT_U = 6.8;
const SLOT_RADIUS_U = 1.28;

// ── the drum ───────────────────────────────────────────────────────────────
//
// **A wheel, not a slideshow.**
//
// What was here before cross-faded between two stacked icons about a dozen
// times a second. In motion that is a flicker; in a *still frame* — and a still
// frame is how every reviewer and half the players see this game — it is
// indistinguishable from a settled item, because most of the time the cross-fade
// has just finished and one icon is sitting dead centre in the socket. A player
// glancing down could not tell whether they were holding a bomb or still finding
// out, which is the one thing a roulette exists to say.
//
// So the faces are stacked into a strip inside the socket and the strip
// *travels*, continuously, at a rate that decays into the answer. Three things
// fall out of that and all three matter: the motion is a continuation rather
// than a cut, so it reads as a wheel; there is no moment at which a face is
// perfectly centred, so no frame of it can be mistaken for a decision; and the
// housing can darken at the lip, which is what turns a scrolling list into
// something turning inside a machine.
//
// The strip carries one extra cell — a copy of the first face — so the wrap from
// the last face back to the first is a continuation rather than a jump backwards
// through the whole drum.
const DRUM_INSET = 0.42;
const DRUM_CELL = SLOT_U - DRUM_INSET * 2;
/** One icon size for the drum and for the settled face, so the two are the same
 *  picture in the same place and the landing hand-over is invisible. */
const ICON_U = 4.9;
/** How far the collar's box extends past the socket, and where its line sits. */
const COLLAR_OUT = 0.62;
const COLLAR_GAP = 0.3;

const COLLAR_BOX = SLOT_U + COLLAR_OUT * 2;
/** viewBox units per `--u` — the collar is square, so one scale for both axes. */
const VB_PER_U = 100 / COLLAR_BOX;
const COLLAR_HALF = (SLOT_U / 2 + COLLAR_GAP) * VB_PER_U;
const COLLAR_R = (SLOT_RADIUS_U + COLLAR_GAP) * VB_PER_U;

/**
 * The collar path, drawn clockwise from top dead centre.
 *
 * Starting at the top matters: with `stroke-dashoffset` at half the dash the
 * fill then grows symmetrically out of twelve o'clock in both directions, which
 * is the shape of a thing charging rather than a thing being poured into.
 */
function collarPath(): string {
  const lo = 50 - COLLAR_HALF, hi = 50 + COLLAR_HALF, r = COLLAR_R;
  const n = (v: number): string => v.toFixed(2);
  return `M 50 ${n(lo)}
    L ${n(hi - r)} ${n(lo)} A ${n(r)} ${n(r)} 0 0 1 ${n(hi)} ${n(lo + r)}
    L ${n(hi)} ${n(hi - r)} A ${n(r)} ${n(r)} 0 0 1 ${n(hi - r)} ${n(hi)}
    L ${n(lo + r)} ${n(hi)} A ${n(r)} ${n(r)} 0 0 1 ${n(lo)} ${n(hi - r)}
    L ${n(lo)} ${n(lo + r)} A ${n(r)} ${n(r)} 0 0 1 ${n(lo + r)} ${n(lo)} Z`;
}

/** Perimeter of that rounded rectangle, for the dash arithmetic. */
const COLLAR_LEN =
  8 * COLLAR_HALF - 8 * COLLAR_R + 2 * Math.PI * COLLAR_R;

/** How wide a tier mark is cut across the collar, in viewBox units. */
const TICK_W = 1.1;

/**
 * The tier boundaries, cut across the collar as two pairs of short marks.
 *
 * A meter with no scale on it is a glow. These are what make the collar an
 * *instrument*: the player can see that they are a third of the way to the next
 * tier rather than only that the ring is a different colour than it was, which
 * is the difference between holding a drift for one more beat on purpose and
 * holding it and hoping.
 *
 * Positions are mirrored either side of twelve o'clock because the fill grows
 * both ways out of it, and the dash pattern sums to exactly one lap of the
 * collar so it cannot creep.
 */
function tickDash(tiers: number): string {
  const marks: number[] = [];
  for (let i = 1; i < tiers; i++) {
    const p = (i / tiers) * COLLAR_LEN * 0.5;
    marks.push(p, COLLAR_LEN - p);
  }
  marks.sort((a, b) => a - b);

  const parts: number[] = [0];
  let cur = 0;
  for (const p of marks) {
    parts.push(Math.max(0, p - TICK_W / 2 - cur), TICK_W);
    cur = p + TICK_W / 2;
  }
  parts.push(Math.max(0, COLLAR_LEN - cur));
  // An odd-length dasharray is duplicated by the renderer, which halves the
  // period and puts marks where no tier boundary is.
  if (parts.length % 2) parts.push(0);
  return parts.map((v) => v.toFixed(2)).join(' ');
}

export const CSS_ITEM = `
#hud .slot-wrap { position: relative; }
/* The collar sits behind the socket and outside it, so the count badge in the
   bottom-right corner of the wrap still wins the overlap. */
#hud .slot-wrap .collar {
  position: absolute; inset: calc(var(--u) * ${-COLLAR_OUT});
  display: block; overflow: visible; pointer-events: none;
}
#hud .slot-wrap .collar path { fill: none; stroke-linecap: round; }
/* Butt caps on the tier marks, or a zero-length leading dash draws a dot at
   twelve o'clock and the marks themselves grow a cap-width at each end. */
#hud .slot-wrap .collar .ticks { stroke-linecap: butt; }
#hud .slot {
  position: relative;
  width: calc(var(--u) * ${SLOT_U}); height: calc(var(--u) * ${SLOT_U});
  border-radius: calc(var(--u) * ${SLOT_RADIUS_U});
  background:
    linear-gradient(163deg, rgba(96,107,128,.62), rgba(23,27,37,.8)),
    repeating-linear-gradient(128deg,
      rgba(255,107,26,.2) 0 calc(var(--u) * .55),
      rgba(0,0,0,0) calc(var(--u) * .55) calc(var(--u) * 1.1));
  box-shadow:
    inset 0 0 0 calc(var(--u) * .2) rgba(255,195,0,.95),
    inset 0 0 0 calc(var(--u) * .34) rgba(20,24,34,.85),
    inset 0 calc(var(--u) * -.62) calc(var(--u) * 1.1) rgba(0,0,0,.45),
    0 calc(var(--u) * .34) calc(var(--u) * .9) rgba(0,0,0,.5);
  display: grid; place-items: center;
  overflow: hidden;
}
/* ── the shutter ──────────────────────────────────────────────────────────
   **The empty state is an object, not an absence.**

   This is the widget's most-photographed frame by a distance. A player holds
   nothing for most of a lap, so eighteen of nineteen organic race frames catch
   this socket empty — and what they caught was a near-black square with a
   yellow border in the dead centre of the top edge, which reads as a texture
   that failed to load rather than as a slot with nothing in it. Two previous
   attempts at "empty" both worked the same seam and both landed in the same
   place: a hazard "?" (the *same* glyph the world paints on an uncollected
   box, so two different states wore one picture), then a deeper, darker recess
   (which is just a better-lit hole).

   The answer is not a symbol in the well and it is not a better hole: it is
   that the machine has a *door*. Empty means the roller shutter is down —
   painted steel slats with a hazard band across them, the same object a road
   crew locks a tool store with. It is lit, it has a silhouette, it reads at a
   glance from across the room, and it can never be mistaken for something
   sitting in the slot because it spans the housing edge to edge.

   And it *moves*: the shutter rolls up out of the way the instant a box is
   taken and drops back when the item is spent, so getting an item opens a
   machine instead of tinting a plate. See "shut" in the update loop. */
#hud .slot .shut {
  position: absolute; inset: calc(var(--u) * ${DRUM_INSET});
  border-radius: calc(var(--u) * ${SLOT_RADIUS_U - DRUM_INSET});
  overflow: hidden;
  /* Six slats. A lit hairline along the top of each, a body that falls away
     under it, and a hard seam at the bottom — which is what makes a flat
     gradient read as pressed steel rather than as stripes. */
  background: repeating-linear-gradient(180deg,
    #9AA6BA 0 calc(var(--u) * .07),
    #6B7688 calc(var(--u) * .07) calc(var(--u) * .46),
    #3D4553 calc(var(--u) * .46) calc(var(--u) * .9),
    #14171E calc(var(--u) * .9) calc(var(--u) * .99));
}
/* The key light, from the top left, same as every other painted surface in this
   game. Without it the slats are a flat grille and the socket is a vent. */
#hud .slot .shut::before {
  content: ''; position: absolute; inset: 0;
  background:
    radial-gradient(120% 90% at 26% 8%, rgba(255,255,255,.3), rgba(255,255,255,0) 62%),
    linear-gradient(163deg, rgba(255,255,255,.1), rgba(0,0,0,.28) 72%);
}
/* ...and the recess. The shutter sits *inside* the housing, so it is in the
   housing's shadow at the top and bottom lips. */
#hud .slot .shut::after {
  content: ''; position: absolute; inset: 0;
  box-shadow:
    inset 0 calc(var(--u) * .42) calc(var(--u) * .8) rgba(0,0,0,.55),
    inset 0 calc(var(--u) * -.42) calc(var(--u) * .8) rgba(0,0,0,.6);
}
/* The hazard band across the middle. Edge to edge on purpose: a mark that
   stopped short of the sides would read as an object lying in the slot, which
   is exactly the mistake the hazard "?" made. Orange rather than the ring's
   yellow, so the band and the housing are two parts and not one smear. */
#hud .slot .shut .band {
  position: absolute; left: 0; right: 0; top: 50%;
  height: calc(var(--u) * 1.5); margin-top: calc(var(--u) * -.75);
  background: repeating-linear-gradient(128deg,
    #FF6B1A 0 calc(var(--u) * .44), #171B24 calc(var(--u) * .44) calc(var(--u) * .88));
  box-shadow:
    inset 0 calc(var(--u) * .1) 0 rgba(255,255,255,.22),
    0 calc(var(--u) * -.1) 0 rgba(8,10,14,.9),
    0 calc(var(--u) * .1) 0 rgba(8,10,14,.9);
}
/* A socket that is deciding is *lit*. The ring goes white-hot while the drum
   runs, so the state is carried by the housing as well as by the motion inside
   it — which is what makes a single photograph of it unambiguous. */
#hud .slot.spinning {
  box-shadow:
    inset 0 0 0 calc(var(--u) * .22) rgba(255,246,214,.98),
    inset 0 0 0 calc(var(--u) * .36) rgba(20,24,34,.9),
    inset 0 calc(var(--u) * -.62) calc(var(--u) * 1.1) rgba(0,0,0,.45),
    0 calc(var(--u) * .34) calc(var(--u) * .9) rgba(0,0,0,.5),
    0 0 calc(var(--u) * 1.5) rgba(255,236,170,.55);
}

/* **The settled face and a face on the drum are the same object in the same
   place.** The reel's window is exactly one drum cell tall and its icon is
   exactly a drum icon, so when the wheel finishes rolling the answer into the
   window this layer can be switched on underneath it and the drum switched off
   with nothing moving by a pixel. That invisible handover is what lets the reel
   *land* on the item rather than cut to it. */
#hud .reel {
  position: relative;
  width: calc(var(--u) * ${DRUM_CELL}); height: calc(var(--u) * ${DRUM_CELL});
}
#hud .reel .face { position: absolute; inset: 0; }
#hud .reel svg {
  position: absolute; left: 50%; top: 50%; display: none;
  width: calc(var(--u) * ${ICON_U}); height: calc(var(--u) * ${ICON_U});
  margin: calc(var(--u) * ${-ICON_U / 2});
  filter: drop-shadow(0 calc(var(--u) * .16) 0 rgba(0,0,0,.45));
}
#hud .reel svg.on { display: block; }

/* ── the drum ─────────────────────────────────────────────────────────────── */
#hud .slot .drum {
  position: absolute; inset: calc(var(--u) * ${DRUM_INSET});
  border-radius: calc(var(--u) * ${SLOT_RADIUS_U - DRUM_INSET});
  overflow: hidden; display: none;
}
/* Carried through the landing clunk as well: the class means "the wheel is what
   is in this socket", and the last face rolling into place is still the wheel. */
#hud .slot.spinning .drum { display: block; }
/* The settled face and the count belong to a socket that has finished deciding.
   While it is deciding, the drum is the only thing in it. */
#hud .slot.spinning .reel { opacity: 0; }
#hud .slot .strip { position: absolute; left: 0; right: 0; top: 0; }
#hud .slot .strip i {
  position: relative; display: grid; place-items: center;
  /* One cell per window, so a whole number of cells travelled always puts a
     face dead centre — which is what makes the deceleration land somewhere
     rather than stopping wherever it happened to be. */
  height: calc(var(--u) * ${DRUM_CELL});
}
#hud .slot .strip i > svg {
  width: calc(var(--u) * ${ICON_U}); height: calc(var(--u) * ${ICON_U}); display: block;
  filter: drop-shadow(0 calc(var(--u) * .16) 0 rgba(0,0,0,.45));
}
/* The landing cell. It is the wrap copy of the first face for the whole spin —
   which is all it has ever been — and on the settle its face is switched to
   whatever was actually drawn, one cell below the window where nothing can see
   it change. The wheel then rolls that last cell up into place, and the item the
   player is holding is the item the wheel stopped on. */
#hud .slot .strip i.land > svg { display: none; }
#hud .slot .strip i.land > svg.on { display: block; }
/* The lip. A drum whose faces stay bright to the rim of the window reads as a
   list being scrolled; one that goes under a shadow at the top and bottom reads
   as something turning inside a housing. */
#hud .slot .drum::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(180deg,
    rgba(9,11,17,.9) 0%, rgba(9,11,17,0) 28%,
    rgba(9,11,17,0) 72%, rgba(9,11,17,.9) 100%);
}

/* The scanner. A bright bar that runs down the face while the reel is spinning:
   the movement of the icons alone is a smear at 18Hz, and this is what tells
   the eye the machine is *working* rather than glitching. */
#hud .slot .sweep {
  position: absolute; left: 0; right: 0; height: 46%; top: 0; opacity: 0;
  background: linear-gradient(180deg, rgba(255,240,190,0) 0%, rgba(255,240,190,.5) 55%, rgba(255,240,190,0) 100%);
  mix-blend-mode: screen;
}
#hud .slot .glow {
  position: absolute; inset: -22%; opacity: 0; mix-blend-mode: screen;
  background: radial-gradient(circle, rgba(255,236,186,.95), rgba(255,236,186,0) 62%);
}
/* The landing ring. The wheel stopping is the beat this whole widget exists for
   and it used to be carried by a scale pop alone — which is invisible in a still
   frame, because a still frame has nothing to compare the scale to. A ring
   leaving the housing is the same beat with a shape: it is outside the socket,
   so it cannot be confused with the item that just arrived, and it is the
   release half of the same gesture the mini-turbo collar already makes, so the
   two moments this socket has to announce are announced the same way. */
#hud .slot-wrap .flare {
  position: absolute; inset: calc(var(--u) * -.3);
  border-radius: calc(var(--u) * ${SLOT_RADIUS_U + 0.3});
  box-shadow: 0 0 0 calc(var(--u) * .2) rgba(255,246,214,.95),
              0 0 calc(var(--u) * 1.3) rgba(255,232,160,.6);
  opacity: 0; pointer-events: none;
}
#hud .slot-wrap .count {
  position: absolute; right: calc(var(--u) * -.34); bottom: calc(var(--u) * -.3);
  min-width: calc(var(--u) * 1.6); padding: 0 calc(var(--u) * .3);
  border-radius: calc(var(--u) * .5);
  background: linear-gradient(180deg, #FF8A2A, #E24E06);
  box-shadow: 0 0 0 calc(var(--u) * .13) rgba(12,14,20,.92), 0 calc(var(--u) * .16) calc(var(--u) * .3) rgba(0,0,0,.5);
  height: calc(var(--u) * 1.5); display: grid; place-items: center;
  color: #FFF8F0; opacity: 0;
}
/* The count is a number too, so it is drawn like every other number in this
   HUD rather than set in whatever the browser has. */
#hud .slot-wrap .count .gl { height: calc(var(--u) * .92); }
`;

export interface ItemSlot {
  readonly root: HTMLElement;
  update(dt: number): void;
  reset(): void;
  dispose(): void;
}

export function createItemSlot(ctx: GameContext): ItemSlot {
  const collarD = collarPath();
  const drumFaces = REEL_FACES.map((e) => e.id);
  const DRUM_N = drumFaces.length;
  /**
   * The drum: one cell per face, and one more on the end.
   *
   * That last cell has always been the wrap copy of the first face, so the roll
   * from the bottom of the strip back to the top is a continuation rather than a
   * jump backwards through the whole wheel. It now carries every icon in the game
   * instead of one, because it is also the cell the answer lands in — switching
   * a face that is sitting a whole cell below the window costs nothing and is
   * seen by nobody, and it is what lets the wheel stop *on* the item.
   */
  const drumCells = drumFaces.map((id) => `<i>${itemIconSvg(id)}</i>`).join('')
    + `<i class="land">${ITEM_IDS.map(itemIconSvg).join('')}</i>`;

  const root = fromHtml(`
    <div class="slot-wrap" data-item-slot>
      <svg class="collar" viewBox="0 0 100 100" aria-hidden="true">
        <path class="bed" d="${collarD}" stroke="rgba(7,9,14,.9)" stroke-width="${(0.72 * VB_PER_U).toFixed(2)}" opacity="0"/>
        <path class="halo" d="${collarD}" stroke="#4FC3F7" stroke-width="${(0.6 * VB_PER_U).toFixed(2)}" opacity="0"/>
        <path class="ticks" d="${collarD}" stroke="rgba(255,248,240,.85)"
          stroke-width="${(0.72 * VB_PER_U).toFixed(2)}"
          stroke-dasharray="${tickDash(ctx.config.kart.drift.tiers.length)}" opacity="0"/>
        <path class="arc" d="${collarD}" stroke="#4FC3F7" stroke-width="${(0.26 * VB_PER_U).toFixed(2)}" opacity="0"/>
      </svg>
      <div class="slot empty">
        <div class="glow"></div>
        <div class="reel">
          <div class="face a">${ITEM_IDS.map(itemIconSvg).join('')}</div>
          <div class="face b">${ITEM_IDS.map(itemIconSvg).join('')}</div>
        </div>
        <div class="drum"><div class="strip">${drumCells}</div></div>
        <div class="shut"><div class="band"></div></div>
        <div class="sweep"></div>
      </div>
      <div class="flare"></div>
      <div class="count"></div>
    </div>
  `);

  const slot = bind(q(root, '.slot'));
  const reel = bind(q(root, '.reel'));
  const strip = bind(q(root, '.strip'));
  const sweep = bind(q(root, '.sweep'));
  const glow = bind(q(root, '.glow'));
  const shut = bind(q(root, '.shut'));
  const landRing = bind(q(root, '.flare'));
  const count = bind(q(root, '.count'));
  const countText = glyphBox(q(root, '.count'));
  const collarSvg = bind(q<SVGElement>(root, '.collar'));
  const collarBed = bind(q<SVGPathElement>(root, '.collar .bed'));
  const collarHalo = bind(q<SVGPathElement>(root, '.collar .halo'));
  const collarTicks = bind(q<SVGPathElement>(root, '.collar .ticks'));
  const collarArc = bind(q<SVGPathElement>(root, '.collar .arc'));

  /** The sim's own tier thresholds, so the collar's thirds can never drift. */
  const THRESHOLDS = ctx.config.kart.drift.tiers.map((t) => t.at);

  /**
   * Charge → 0..1 around the collar, one equal third per tier.
   *
   * Past purple the meter is simply full: the sim keeps accruing a little
   * further, and a bar that carries on creeping after the last tier has landed
   * is a bar telling the player about something they cannot spend.
   */
  function collarFill(charge: number): number {
    let lo = 0;
    for (let i = 0; i < THRESHOLDS.length; i++) {
      const hi = THRESHOLDS[i]!;
      if (charge < hi) return (i + (charge - lo) / Math.max(1e-3, hi - lo)) / THRESHOLDS.length;
      lo = hi;
    }
    return 1;
  }

  /** Two identical icon stacks; the reel cross-fades between them. */
  const layers: Array<{ box: Bound; faces: Map<string, SVGElement>; shown: string }> = [];
  for (const cls of ['.face.a', '.face.b']) {
    const box = q(root, cls);
    const faces = new Map<string, SVGElement>();
    for (const svg of Array.from(box.querySelectorAll<SVGElement>('svg'))) {
      faces.set(svg.dataset.face ?? '', svg);
    }
    layers.push({ box: bind(box), faces, shown: '' });
  }

  /** The face switcher for the drum's landing cell. See `drumCells`. */
  const landFaces = new Map<string, SVGElement>();
  for (const svg of Array.from(q(root, '.strip .land').querySelectorAll<SVGElement>('svg'))) {
    landFaces.set(svg.dataset.face ?? '', svg);
  }
  /** What the landing cell is showing. Defaults to the first face, which is what
   *  makes it the wrap copy for every revolution before the last one. */
  let landShown = drumFaces[0]!;
  landFaces.get(landShown)?.classList.add('on');
  function setLandFace(id: ItemId): void {
    if (id === landShown) return;
    landFaces.get(landShown)?.classList.remove('on');
    landShown = id;
    landFaces.get(id)?.classList.add('on');
  }

  let front = 0;
  /** 0..1 through the current icon-to-icon slide. */
  let roll = 1;
  let rollDur = 0.1;

  let spinning = false;
  /** This spin's length and what is left of it, both stated by the item system. */
  let spinDur = FALLBACK_SPIN;
  let spinLeft = 0;
  /** True until the first `item:reel` lands, which is what the drum aligns to. */
  let alignPending = false;
  /** The face the wheel opened on, and the exact travel from it. */
  let spinFrom = 0;
  let spinCells = SPIN_CELLS;
  /** Where the drum is, in cells travelled. Fractional — that is the point. */
  let drumPhase = 0;
  /** ...and how fast, in cells per second, which is what drives the smear. */
  let spinSpeed = 0;

  /** Seconds left of the clunk that rolls the answer into the window. */
  let landing = 0;
  let landFrom = 0;
  /** What the clunk is landing on, held until it has finished landing on it. */
  let landItem: ItemId | null = null;
  /** ...and the ring that leaves the housing when it does. */
  let landFlare = 0;

  let heldId: ItemId | null = null;
  let heldCount = 0;
  let punch = 0;
  let ejecting = 0;
  let badgePunch = 0;
  let glowAmount = 0;
  let jitter = 0;
  let clock = 0;
  /** The roller shutter, 0 down and 1 clear of the window. */
  let shutOpen = 0;

  /** Collar state: how far round it is drawn, and how lit it is. */
  let collar = 0;
  let collarLive = 0;
  let boostFlare = 0;

  const unsubs: Array<() => void> = [];

  /**
   * The HUD unit in CSS pixels, cached.
   *
   * The smear is the one number in this widget that has to be in real pixels
   * rather than in `--u`, and `unitPx()` reads the viewport. Doing that inside
   * `update` would put a viewport read in among the HUD's style writes on every
   * frame of every spin, for an answer that only changes when somebody drags a
   * window edge. Same discipline as the minimap's canvas sizing.
   */
  let unit = unitPx();
  unsubs.push(ctx.bus.on('engine:resize', () => { unit = unitPx(); }));

  /**
   * Put a face in the socket.
   *
   * `snap` writes the arrival straight to its resting place instead of rolling
   * it in, and **an arriving item always snaps.** The roll is integrated from
   * `update`'s `dt`, and `dt` is the render clock: a reviewer who puts an item
   * in the player's hand and then draws a frame — `__ITEMS.give` then
   * `render()`, which is exactly how this widget is inspected — gets one frame's
   * worth of a fifth-of-a-second slide, so the icon is written at four per cent
   * opacity, a whole cell below the window, and the socket photographs empty
   * with a faint coloured wash on it. That is not a slow animation, it is an
   * item that does not appear, and it is what the last review saw.
   *
   * Nothing is lost by snapping, because the arrival already has motion that
   * does not depend on a clock: the wheel rolls the answer into the window (see
   * `landing`) and the housing punches. The roll is kept for the *departure* —
   * an item leaving the socket has no such gesture of its own.
   */
  function showFace(id: ItemId | null, dur: number, snap = false): void {
    const key = id ?? '';
    const cur = layers[front]!;
    if (cur.shown === key) return;
    const next = layers[front ^ 1]!;
    if (next.shown) next.faces.get(next.shown)?.classList.remove('on');
    next.shown = key;
    if (key) next.faces.get(key)?.classList.add('on');
    front ^= 1;
    roll = snap ? 1 : 0;
    rollDur = dur;
    if (snap) {
      layers[front]!.box.set('transform', 'none');
      layers[front]!.box.set('opacity', '1');
      layers[front ^ 1]!.box.set('transform', 'translateY(-100%)');
      layers[front ^ 1]!.box.set('opacity', '0');
    }
  }

  /**
   * Square the wheel's travel so that the spin ends on the *last* face.
   *
   * The cell after it is the landing cell, so a spin that stops square on
   * `DRUM_N - 1` is a spin whose next cell can be made into the answer — which
   * is the whole difference between a wheel that stops and a wheel that stops on
   * something. The nominal travel is nudged to the nearest whole number of
   * revolutions that satisfies it, so the spin is never visibly longer or
   * shorter for the sake of the arithmetic.
   */
  function squareTravel(from: number): void {
    spinFrom = ((from % DRUM_N) + DRUM_N) % DRUM_N;
    const want = (((DRUM_N - 1 - spinFrom) % DRUM_N) + DRUM_N) % DRUM_N;
    let cells = want;
    while (cells < SPIN_CELLS - DRUM_N / 2) cells += DRUM_N;
    spinCells = cells;
  }

  function setGlow(hex: number, amount: number): void {
    glowAmount = Math.max(glowAmount, amount);
    glow.set('background',
      `radial-gradient(circle, ${rgba(hex, 0.95)}, ${rgba(hex, 0)} 62%)`);
  }

  unsubs.push(ctx.bus.on<{
    racer: Racer; phase: 'start' | 'settle'; duration?: number; item?: ItemId;
  }>('item:roulette', (e) => {
    if (!e.racer.isPlayer) return;
    if (e.phase === 'start') {
      spinning = true;
      spinDur = e.duration && e.duration > 0.05 ? e.duration : FALLBACK_SPIN;
      spinLeft = spinDur;
      alignPending = true;
      landing = 0;
      landItem = null;
      squareTravel(drumPhase);
      drumPhase = spinFrom;
      setGlow(0xFFF0C4, 0.55);
    } else {
      spinning = false;
      spinLeft = 0;
      // A settle carrying no item is the contract's "the reel stopped and there
      // is nothing in the slot" — lightning mid-draw, the flag, or the bench
      // putting something straight into the hand. There is nothing to land on,
      // so the wheel simply goes.
      if (e.item) {
        // The answer goes into the cell below the window and the wheel rolls it
        // up. Started from at most a cell and a bit out, so a spin that was cut
        // short — a slot-stop, or a reel event that never arrived — still gets a
        // short travel into place rather than a lap of the drum.
        setLandFace(e.item);
        landItem = e.item;
        landFrom = Math.max(drumPhase, DRUM_N - 1.35);
        landing = LAND_TIME;
      }
    }
  }));

  // One event per face of the item system's own reel. Two things come off it:
  // the authoritative time left in this spin — which is what a slot-stop
  // changes, and which no clock of our own could know about — and, on the first
  // tick, *which face* the sim's reel is on, so the drum in the socket and the
  // reel in the simulation are turning through the same items in the same
  // order on the same seed.
  unsubs.push(ctx.bus.on<{
    racer: Racer; index: number; remaining: number; total: number;
  }>('item:reel', (e) => {
    if (!e.racer.isPlayer) return;
    if (e.total > 0.05) spinDur = e.total;
    spinLeft = e.remaining > 0 ? e.remaining : 0;
    if (alignPending) {
      alignPending = false;
      // Lands within a step of the start, long before a frame is drawn, so the
      // alignment is never a visible jump.
      squareTravel(e.index);
      drumPhase = spinFrom;
    }
  }));

  // A carried item that eats a shell for you is spent without being used: the
  // slot has to report that as a *loss*, not as a quiet decrement.
  unsubs.push(ctx.bus.on<{ racer: Racer }>('item:block', (e) => {
    if (!e.racer.isPlayer) return;
    punch = Math.max(punch, 0.8);
    setGlow(0xFFFFFF, 0.85);
  }));

  // The collar spends its charge the moment the boost fires: a full white ring
  // blowing outward off the socket. It is the release half of the mini-turbo,
  // and without it the meter simply vanishes at the instant it mattered most.
  unsubs.push(ctx.bus.on<{ racer: Racer }>('kart:boost', (e) => {
    if (!e.racer.isPlayer) return;
    boostFlare = 1;
  }));

  return {
    root,

    reset(): void {
      spinning = false;
      heldId = null;
      heldCount = 0;
      punch = 0;
      ejecting = 0;
      badgePunch = 0;
      glowAmount = 0;
      jitter = 0;
      clock = 0;
      roll = 1;
      front = 0;
      collar = 0;
      collarLive = 0;
      boostFlare = 0;
      drumPhase = 0;
      spinSpeed = 0;
      landing = 0;
      landItem = null;
      landFlare = 0;
      landFrom = 0;
      spinFrom = 0;
      spinCells = SPIN_CELLS;
      setLandFace(drumFaces[0]!);
      shutOpen = 0;
      shut.set('transform', 'none');
      landRing.set('opacity', '0');
      sweep.set('opacity', '0');
      collarBed.set('opacity', '0');
      collarHalo.set('opacity', '0');
      collarTicks.set('opacity', '0');
      collarArc.set('opacity', '0');
      collarSvg.set('transform', 'none');
      spinDur = FALLBACK_SPIN;
      spinLeft = 0;
      alignPending = false;
      slot.cls('spinning', false);
      strip.set('transform', 'none');
      strip.set('filter', 'none');
      // Both stacks emptied outright rather than rolled: a reset is not a
      // transition, and half a shell sliding out of the socket as the lights go
      // down for the next race is not a beat anybody asked for.
      for (const l of layers) {
        if (l.shown) l.faces.get(l.shown)?.classList.remove('on');
        l.shown = '';
        l.box.set('transform', 'none');
        l.box.set('opacity', '1');
      }
      slot.cls('empty', true);
      slot.set('transform', 'none');
      count.set('opacity', '0');
    },

    update(dt: number): void {
      clock += dt;
      const player = ctx.player;
      const id = player?.item ?? null;
      const n = player?.itemCount ?? 0;

      // ── the drum ─────────────────────────────────────────────────────────
      //
      // Position, speed and smear are all read off how far through the spin the
      // *simulation* is, never accumulated across frames — see the note on
      // `SPIN_CELLS`. `spinLeft` is restated by every `item:reel` and only
      // interpolated by `dt` between them, so the wheel is smooth at sixty
      // frames a second and still correct on a single frame drawn after a
      // thousand simulation steps with nothing rendered in between.
      if (spinning) {
        spinLeft = spinLeft > dt ? spinLeft - dt : 0;
        const u = clamp01(1 - spinLeft / Math.max(0.05, spinDur));
        const travelled = spinFrom + spinCells * spinShape(u);
        drumPhase = travelled % DRUM_N;
        spinSpeed = (spinCells * spinRate(u)) / Math.max(0.05, spinDur);
        jitter = 1;
      } else if (landing > 0) {
        // The clunk. One cell, eased out, onto the face the draw actually made.
        landing = Math.max(0, landing - dt);
        const p = ease.outQuart(1 - landing / LAND_TIME);
        const span = DRUM_N - landFrom;
        drumPhase = landFrom + span * p;
        spinSpeed = span * 4 * (1 - p) * (1 - p) * (1 - p);
        jitter = Math.max(0, jitter - dt * 9);
        if (landing <= 0 && landItem) {
          // Hand over. The drum's landing cell and the settled face are the same
          // icon at the same size in the same place, so switching one off and
          // the other on moves nothing — which is why this reads as the wheel
          // stopping rather than as a cut to a different widget.
          showFace(landItem, 0.14, true);
          heldId = landItem;
          punch = 1;
          landFlare = 1;
          ejecting = 0;
          setGlow(ITEMS[landItem].color, 1);
          landItem = null;
        }
      } else {
        jitter = Math.max(0, jitter - dt * 6);
      }
      const wheeling = spinning || landing > 0 || landItem !== null;
      slot.cls('spinning', wheeling);
      if (wheeling) {
        // Percentages of the strip's own height, which is (N+1) cells — the
        // extra one is the landing cell, and the travel only reaches it on the
        // way round or on the way in.
        strip.set('transform', `translateY(${(-drumPhase * (100 / (DRUM_N + 1))).toFixed(3)}%)`);
        // **Smeared by how fast it is going.**
        //
        // The drum is the honest cue, but honesty is not the same as legibility
        // in a *single frame*: land the shutter on the moment a face happens to
        // be centred and a photograph of a wheel at full speed is a photograph
        // of a settled item. Blur is the cue that has no such moment — it is a
        // function of the speed and nothing else, so every frame of the spin
        // looks like a spin and the first frame that does not is the answer.
        // Scaled by the HUD unit so it is the same smear at any resolution.
        const blur = Math.min(2.6, spinSpeed * 0.15) * (unit / 17);
        strip.set('filter', blur > 0.15 ? `blur(${blur.toFixed(2)}px)` : 'none');
      } else {
        strip.set('filter', 'none');
      }

      // ── what is actually in the slot ─────────────────────────────────────
      if (!wheeling && id !== heldId) {
        if (id) {
          // An item that arrived without a wheel behind it: the reviewer's
          // bench, a steal, a lightning strike redistributing the field. It
          // *snaps* — see `showFace` — and the housing carries the beat.
          showFace(id, 0.2, true);
          punch = 1;
          landFlare = Math.max(landFlare, 0.8);
          setGlow(ITEMS[id].color, 1);
          ejecting = 0;
        } else if (heldId) {
          // Spent, stolen or struck out of the player's hand.
          //
          // **The icon leaves on the same frame the item does.** What used to
          // happen here was that `ejecting` was set and the reel's opacity was
          // driven by `1 - ejecting * 0.9` — which, since `ejecting` counts
          // *down* from 1, dropped the spent item to a tenth of its opacity on
          // the frame it was fired and then faded it back **up** to full over
          // the next fifth of a second before finally sliding it out. Firing a
          // shell made the shell blink and come back. The exit the widget
          // already owns — the roller, which lifts the outgoing face up through
          // the top of the socket — is the right one, so it is what runs; and
          // `ejecting` goes back to being what its name says, the socket's own
          // recoil.
          ejecting = 1;
          setGlow(ITEMS[heldId].color, 0.5);
          showFace(null, 0.18);
        }
        heldId = id;
      }
      if (n !== heldCount) {
        if (heldId && n > 0 && n < heldCount) badgePunch = 1;
        heldCount = n;
        // "X2", drawn — the multiplication cross is the letter X in this face.
        countText.set(n > 1 ? `X${n}` : '');
      }

      if (ejecting > 0) ejecting = Math.max(0, ejecting - dt * 4.5);

      // The shutter waits for the spent item to finish leaving, or the door
      // comes down on an icon that is still on its way out of the socket.
      const loaded = !!heldId || wheeling || ejecting > 0;
      slot.cls('empty', !loaded);
      count.set('opacity', heldCount > 1 ? '1' : '0');

      // ── the shutter ──────────────────────────────────────────────────────
      // Up fast, because it is opening on a decision that has already been made;
      // down a little slower, because a door that is dropped is a door, and a
      // door that is snapped shut is a shutter effect. Both short enough that no
      // photograph of this socket ever catches it looking undecided.
      shutOpen = loaded
        ? Math.min(1, shutOpen + dt / 0.1)
        : Math.max(0, shutOpen - dt / 0.15);
      shut.set('transform', shutOpen > 0.999
        ? 'translateY(-101%)'
        : `translateY(${(-101 * ease.outCubic(shutOpen)).toFixed(2)}%)`);

      // ── motion ───────────────────────────────────────────────────────────
      if (roll < 1) {
        roll = Math.min(1, roll + dt / Math.max(0.04, rollDur));
        const e = ease.outQuart(roll);
        // The reel runs upward: the old face leaves through the top of the
        // socket as the new one arrives from underneath it. A whole window, not
        // a hundred and eight per cent of one — the box is exactly one drum cell
        // now, so a full travel is exactly the wheel's own step.
        layers[front]!.box.set('transform', `translateY(${((1 - e) * 100).toFixed(1)}%)`);
        layers[front ^ 1]!.box.set('transform', `translateY(${(-e * 100).toFixed(1)}%)`);
        layers[front]!.box.set('opacity', Math.min(1, e * 2.2).toFixed(2));
        layers[front ^ 1]!.box.set('opacity', Math.max(0, 1 - e * 1.6).toFixed(2));
      }

      if (punch > 0) punch = Math.max(0, punch - dt * 2.9);
      if (badgePunch > 0) badgePunch = Math.max(0, badgePunch - dt * 3.4);
      if (glowAmount > 0) glowAmount = Math.max(0, glowAmount - dt * 2.3);

      const shake = jitter > 0 ? Math.sin(clock * 52) * 0.028 * jitter : 0;
      const pop = 1 + punch * punch * 0.4 - ejecting * 0.12;
      slot.set('transform',
        `scale(${(pop + shake).toFixed(3)}) rotate(${(shake * 13).toFixed(2)}deg)`);

      // Idle float, so a held item never looks pasted on. Deliberately tiny:
      // this is a readout, and a readout that wanders is a readout that is hard
      // to read.
      const bob = heldId && !wheeling ? Math.sin(clock * 2.3) * 2.2 : 0;
      reel.set('transform',
        `translateY(${bob.toFixed(2)}%) scale(${(1 + punch * 0.2).toFixed(3)})`);
      // **Written here rather than left to `.slot.spinning .reel`.** The stack
      // carries an inline opacity, and an inline style beats a stylesheet rule
      // every time — so the settled icon would sit visible underneath a
      // transparent drum for the whole spin. The eject is the roller's job now;
      // this is only the drum's mask.
      reel.set('opacity', wheeling ? '0' : '1');

      glow.set('opacity', glowAmount > 0.004 ? (glowAmount * 0.95).toFixed(3) : '0');
      if (glowAmount > 0.004) {
        glow.set('transform', `scale(${(0.7 + (1 - glowAmount) * 0.7).toFixed(3)})`);
      }

      // The landing ring: a full ring blowing off the housing as the wheel
      // stops. Same gesture as the collar's mini-turbo release, on purpose —
      // this socket has exactly two things to announce and they announce alike.
      if (landFlare > 0) {
        landFlare = Math.max(0, landFlare - dt * 3.2);
        landRing.set('opacity', (landFlare * landFlare * 0.95).toFixed(3));
        landRing.set('transform', `scale(${(1 + (1 - landFlare) * 0.3).toFixed(3)})`);
      } else {
        landRing.set('opacity', '0');
      }

      if (jitter > 0.004) {
        // The scanner, while the wheel is running.
        sweep.set('opacity', (0.75 * jitter).toFixed(2));
        sweep.set('transform', `translateY(${(((clock * 220) % 160) - 6).toFixed(1)}%)`);
      } else if (shutOpen < 0.02) {
        // ...and the idle sheen on the closed shutter. A still frame of this
        // game should still be a frame of something running, and this socket is
        // shut for most of a lap — a slow specular pass down the slats every few
        // seconds is the cheapest possible statement that the machine is on.
        const ph = (clock * 0.3) % 1;
        const vis = ph < 0.44 ? Math.sin((ph / 0.44) * Math.PI) : 0;
        sweep.set('opacity', vis > 0.02 ? (vis * 0.26).toFixed(3) : '0');
        if (vis > 0.02) sweep.set('transform', `translateY(${((ph / 0.44) * 160 - 24).toFixed(1)}%)`);
      } else {
        sweep.set('opacity', '0');
      }

      count.set('transform', `scale(${(1 + badgePunch * 0.55).toFixed(3)})`);

      // ── the mini-turbo collar ────────────────────────────────────────────
      const drift = player?.drift;
      const charging = (drift?.active ?? false) && (drift?.charge ?? 0) > 0.02;
      if (boostFlare > 0) boostFlare = Math.max(0, boostFlare - dt * 1.45);

      // Most of a race is spent not drifting, and the whole block below builds a
      // handful of short strings a frame to hand the same values back to a write
      // cache that will throw them away. The dead state is one comparison.
      if (!charging && boostFlare <= 0.004 && collar <= 0.002 && collarLive <= 0.002) {
        collarArc.set('opacity', '0');
        collarHalo.set('opacity', '0');
        collarTicks.set('opacity', '0');
        collarBed.set('opacity', '0');
        collarSvg.set('transform', 'none');
        return;
      }

      // The fill snaps to the charge on the way up — a meter that lags the thing
      // it measures is a meter that lies about when the tier landed — and eases
      // back to nothing on release, so the collar drains rather than blinking
      // out from under the boost it just paid for.
      const want = charging ? collarFill(drift?.charge ?? 0) : 0;
      collar = want > collar ? want : Math.max(want, collar - dt * 3.4);
      collarLive = charging
        ? Math.min(1, collarLive + dt * 8)
        : Math.max(0, collarLive - dt * 3.2);

      const flare = boostFlare * boostFlare;
      const hot = flare > 0.02;
      const tier = charging ? (drift?.tier ?? 0) : 0;
      const ring = TIER_RING[tier]!;
      // Every write below goes through the cache in `bind`, so re-deriving the
      // colour and the weights on every frame costs a string compare and a map
      // lookup — and buys the release beat, which needs a hue this ring never
      // wears while it is charging.
      const hex = hot ? '#FFF6D8' : hexCss(TIER_COLORS[tier]!);
      const width = hot ? Math.max(ring.stroke, 0.4) : ring.stroke;
      collarArc.set('stroke', hex);
      collarHalo.set('stroke', hex);
      collarArc.set('strokeWidth', (width * VB_PER_U).toFixed(2));
      collarHalo.set('strokeWidth', (width * ring.haloWidth * VB_PER_U).toFixed(2));

      // The release spends the charge: the collar snaps to a full ring and blows
      // outward off the socket as it fades. Without it the meter simply vanishes
      // at the instant it mattered most, which is the half of a mini-turbo the
      // player actually gets paid for.
      // **A whole ring for the whole flare.** This used to draw the release at
      // `flare` — a length that decays with the fade — so the shockwave was a
      // shrinking arc: at two thirds through, a pale croissant hanging off the
      // top of the socket, which is what the photograph showed. A release is a
      // ring *leaving*, so the geometry stays closed for the whole beat and the
      // fade is carried by opacity and scale, which is what "blowing outward"
      // actually looks like.
      const shown = hot ? 1 : collar;
      if (shown > 0.002) {
        const len = shown * COLLAR_LEN;
        // **The gap is the rest of the perimeter, not something larger.**
        //
        // The dash pattern has to repeat with a period of exactly one lap of the
        // collar, because that is what makes the pattern *wrap*: offset by half
        // the dash and the fill then appears as `[0, len/2]` at the start of the
        // path and `[P - len/2, P]` at the end of it — one continuous band
        // growing out of twelve o'clock in both directions. With an
        // over-long gap there is no wrap, the second half of the dash falls off
        // the front of the path, and the collar fills clockwise down one side
        // only, which reads as a bar that has come loose rather than a charge.
        const gap = COLLAR_LEN - len;
        const dash = gap < 0.5 ? 'none' : `${len.toFixed(2)} ${gap.toFixed(2)}`;
        const off = (len * 0.5).toFixed(2);
        collarArc.set('strokeDasharray', dash);
        collarHalo.set('strokeDasharray', dash);
        collarArc.set('strokeDashoffset', off);
        collarHalo.set('strokeDashoffset', off);

        // Tier 3 is the one that never sits still: a fast shimmer on top of the
        // halo, so "purple" is a different *behaviour* and not only a hue.
        const shimmer = tier >= 3 ? 0.82 + 0.18 * Math.sin(clock * 21) : 1;
        collarArc.set('opacity', Math.max(collarLive, flare).toFixed(3));
        collarHalo.set('opacity',
          (Math.max(ring.halo * collarLive, flare) * shimmer).toFixed(3));
        // **The bed is nearly opaque, not half of it.** This ring is drawn over
        // whatever the camera is pointed at — a white cloud on one side of this
        // circuit and wet tarmac on the other — and a translucent channel means
        // the meter changes colour with the scenery. Dark and solid, it is the
        // same instrument everywhere on the lap.
        collarBed.set('opacity', (collarLive * 0.92).toFixed(3));
        collarTicks.set('opacity', (collarLive * 0.5).toFixed(3));
      } else {
        collarArc.set('opacity', '0');
        collarHalo.set('opacity', '0');
        collarTicks.set('opacity', '0');
        collarBed.set('opacity', (collarLive * 0.92).toFixed(3));
      }
      collarSvg.set('transform', boostFlare > 0.004
        ? `scale(${(1 + (1 - boostFlare) * 0.26).toFixed(3)})`
        : 'none');
    },

    dispose(): void {
      for (const off of unsubs) off();
      unsubs.length = 0;
      root.remove();
    },
  };
}
