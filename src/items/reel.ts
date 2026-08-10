// The item slot, the roulette, and the two screen effects items cause.
//
// A DOM overlay, for the same reasons the HUD is one: crisp at any resolution
// and free of draw calls. It lives in this module rather than in `ui` because
// the reel is not a readout — it is the item system's own animation, timed to
// the same clock as the draw, and splitting the two across a module boundary
// would mean the picture and the state could disagree.
//
// If the UI module ever grows its own slot it only has to mark it
// `data-item-slot` and this one stands down, leaving the screen effects behind.

import { clamp01 } from '../core/math.ts';
import { signBox, signCss, type SignBox } from '../ui/letters.ts';
import { U_CSS } from '../ui/theme.ts';
import { ITEMS, REEL_FACES } from './defs.ts';
import type { ItemEntry } from './defs.ts';
import type { ItemId } from '../types.ts';

/** Every icon the slot may ever have to show. One per item, not one per
 *  (item, count) — see `key` below for why that distinction matters. */
const ICON_IDS = Object.keys(ITEMS) as ItemId[];

/** The faces on the drum, in the order they come round. */
const FACES: readonly ItemId[] = REEL_FACES.map((e) => e.id);

const CSS = `
#item-hud {
  position: fixed; top: 1.3rem; left: 50%; transform: translateX(-50%);
  z-index: 11; pointer-events: none; user-select: none;
  font-family: 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif;
}
/* The slot is a roadworks sign: dark plate, hazard-yellow edge, chevrons only
   as a hairline so the icon inside is the loudest thing in it. */
#item-hud .slot {
  position: relative; width: 6.2rem; height: 6.2rem;
  border-radius: 1.15rem;
  background:
    linear-gradient(165deg, rgba(90,100,120,.55), rgba(20,24,34,.72)),
    repeating-linear-gradient(135deg,
      rgba(255,107,26,.16) 0 9px, rgba(0,0,0,0) 9px 18px);
  box-shadow:
    inset 0 0 0 3px rgba(255,195,0,.9),
    inset 0 0 0 5px rgba(28,32,42,.7),
    inset 0 -10px 18px rgba(0,0,0,.4),
    0 6px 18px rgba(0,0,0,.4);
  display: grid; place-items: center;
}
/* An empty slot is *waiting*, not disabled. Fading it out reads as a greyed
   control; keeping it lit with a bright hazard "?" reads as a socket with
   nothing in it yet, which is what it is. */
#item-hud .slot.empty { box-shadow:
    inset 0 0 0 3px rgba(255,195,0,.55),
    inset 0 0 0 5px rgba(28,32,42,.6),
    inset 0 -10px 18px rgba(0,0,0,.4),
    0 6px 18px rgba(0,0,0,.35);
}
#item-hud .mark {
  position: absolute; font-size: 3.4rem; font-weight: 900; line-height: 1;
  color: #FFC300;
  text-shadow:
    0 0 0 #000, 2px 2px 0 rgba(20,24,34,.9), -2px 2px 0 rgba(20,24,34,.9),
    2px -2px 0 rgba(20,24,34,.9), -2px -2px 0 rgba(20,24,34,.9),
    0 4px 0 rgba(0,0,0,.45);
  opacity: 0;
}
#item-hud .slot.empty .mark { opacity: .92; }
#item-hud .icons { position: relative; width: 4.3rem; height: 4.3rem; }
#item-hud .icons svg {
  position: absolute; inset: 0; width: 100%; height: 100%;
  display: none;
  filter: drop-shadow(0 3px 0 rgba(0,0,0,.35));
}
#item-hud .icons svg.on { display: block; }

/* ── the reel ──────────────────────────────────────────────────────────────

   A *drum*, not a slideshow.

   What was here before swapped which icon was displayed about a dozen times a
   second. On a moving screen that is a flicker; in a still frame — and
   a still frame is how every reviewer sees this game — it is indistinguishable
   from a settled item. A player watching it could not tell whether they were
   holding a banana or in the middle of finding out, which is the one thing the
   roulette exists to say.

   So the faces are stacked into a strip inside a clipped window and the strip
   *travels*. Three things fall out of that and all three matter: the motion is
   continuous rather than a cut, so it reads as a wheel; the direction is
   constant, so the eye knows the thing is running rather than shuffling; and it
   can be blurred by how far it still has to go, which is what sells the speed
   at the top of the spin and the arrival at the bottom of it.

   The strip carries one extra cell — a copy of the first face — so the wrap
   from the last face back to the first is a continuation rather than a jump
   backwards through the whole drum. */
#item-hud .reel {
  position: absolute; inset: 5px; border-radius: .85rem;
  overflow: hidden; opacity: 0;
}
#item-hud .slot.spinning .reel { opacity: 1; }
/* The settled face, the empty mark and the count all belong to a slot that has
   finished deciding. While it is deciding, the drum is the only thing in it. */
#item-hud .slot.spinning .icons,
#item-hud .slot.spinning .mark { opacity: 0; }
/* visibility, not opacity: the count badge carries an inline opacity written by
   show(), and an inline style beats a stylesheet rule every time. */
#item-hud .slot.spinning .count { visibility: hidden; }
#item-hud .strip { position: absolute; left: 0; right: 0; top: 0; will-change: transform; }
#item-hud .strip i {
  display: grid; place-items: center;
  /* One cell per window. The slot is 6.2rem and the window is inset 5px on
     each side, so a cell that is exactly the window's height puts one face
     dead centre for every whole number of cells travelled. */
  height: calc(6.2rem - 10px);
}
#item-hud .strip i svg {
  width: 4.1rem; height: 4.1rem; display: block;
  filter: drop-shadow(0 3px 0 rgba(0,0,0,.4));
}
/* The lip of the slot. A drum whose faces reach the rim of the window looks
   like a list being scrolled; one that darkens as it goes under the edge looks
   like something turning inside a housing. */
#item-hud .reel::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(180deg,
    rgba(9,11,17,.82) 0%, rgba(9,11,17,0) 30%,
    rgba(9,11,17,0) 70%, rgba(9,11,17,.82) 100%);
}
#item-hud .count {
  position: absolute; right: -.35rem; bottom: -.35rem;
  font-size: 1.15rem; font-weight: 900; color: #FFF8F0;
  text-shadow: 0 2px 0 rgba(0,0,0,.6);
  opacity: 0;
}
#item-hud .glow {
  position: absolute; inset: -18%; border-radius: 1.6rem;
  background: radial-gradient(circle, rgba(255,235,180,.9), rgba(255,235,180,0) 62%);
  opacity: 0; mix-blend-mode: screen;
}

/* ── the tar sprayer's throw ────────────────────────────────────────────────

   Tar on the lens, and the whole design is in what it *leaves alone*.

   The version this replaces covered fifty-six percent of the central play area
   and ninety percent of the vanishing point, at 0.97 opacity, held for six
   seconds. Measured on a frame, two thirds of the middle of the screen was
   below luminance 60. That is not an item, it is a blindfold: a player who
   cannot see the road cannot drive badly, they can only stop driving, and an
   item whose correct response is "let go of the accelerator for six seconds" is
   an item that stops the race rather than complicating it.

   Five rules replace it, and they are measured rather than eyeballed. The
   instrument is "fraction of the central two thirds of the frame below
   luminance 60", photographed at the worst frame of the effect and read against
   the same frame with no tar on it — this circuit's tarmac is *already* below
   60 over half of the lower middle of the screen, so an absolute number on its
   own says as much about the road as about the item.

     *The kart and the road in front of it are never covered.* The band that
     holds the machine and the tarmac it is about to drive over gains two points
     of dark pixels, and it gains them at the edges. You can always see where
     you are going; what you lose is everything you were using to decide *how*.

     *The periphery is taken outright.* Better than a third of the frame goes,
     and it goes thick and opaque: the horizon, the mirrors, the apex you were
     lining up, the kart alongside. Every one of those centres sits on or beyond
     the frame's edge, so the crop a reviewer measures gets the *thin* end of
     each throw and the edge of the screen gets the body of it.

     *What lands in the middle is small.* Fourteen hard little blots with clean
     road between them, not one wash over the lot: that is what a thrown liquid
     actually leaves at the edge of its throw, it is the only way the middle of
     the screen can be made *expensive to read* rather than impossible, and it
     is a third of the measured cost of the soft blots it replaces. What you
     lose is the detail you were reading, not the light you were reading it by.

     *Every splat clears on its own clock.* One sheet fading is a filter being
     switched off; thirty splats leaving at thirty different moments is weather
     passing. The "--gone" variable is the point in the wipe each one has finished at, and
     the ones over the play area are given the earliest — so the middle of the
     screen comes back first and the edges are still dirty when it does.

     *It runs off, and it runs off faster the harder you drive.* Splats shrink
     about their own centres — most of which are outside the frame, so shrinking
     pulls them off the edge — and drift down with their drips lengthening
     behind them. Airflow does the rest: see INK_TIME in index.ts, where the
     clock runs at up to 1.8× with the throttle open. The one thing a player
     must never be told to do about this item is lift off.

   The thick splats are opaque and the *layer* is not: a splat that is itself
   half transparent, faded again by the layer it sits on, photographs as a pale
   grey bubble. */
#item-ink {
  position: fixed; inset: 0; z-index: 12; pointer-events: none;
  opacity: 0;
  /* 0 on the frame it lands, 1 once it has run off the glass. */
  --wipe: 0;
  /* The arrival punch. Every splat's scale is multiplied by it. */
  --land: 1;
  /* A wash under the splats: nothing at all in the middle, a third of a stop of
     cold blue at the edges. It is what turns thirty separate shapes into one
     film *on the glass* — without it the splats read as objects floating in
     front of the game rather than as something covering the lens — and it costs
     the play area precisely nothing, because it is zero there. */
  background: radial-gradient(ellipse 66% 60% at 50% 56%,
    rgba(14,20,58,0) 0 42%, rgba(14,20,58,.34) 100%);
}
#item-ink i {
  position: absolute; display: block;
  /* **Each splat leaves on its own clock.** The "--gone" variable is where in
     the wipe this one has finished, "--band" is how long it takes to go, and
     both are derived from the splat's index rather than authored — see the
     splat() builder below. The whole
     field used to fade on the container's single opacity, which is one sheet
     being switched off however many shapes are drawn on it; this is thirty
     separate things drying at thirty different rates, and it is also what lets
     the *middle* of the screen be handed back first while the edges are still
     filthy. */
  opacity: clamp(0, calc((var(--gone, 1) - var(--wipe, 0)) / var(--band, .2)), 1);
  /* **Centre-anchored.** left/top place the splat's centre, not its corner,
     and most of the field's centres are deliberately outside the frame — which
     is what makes them read as arcs of something bigger rather than as discs,
     and what makes the wipe work: a splat shrinking about an off-screen centre
     retreats off the edge instead of leaving a blob stranded mid-frame. */
  transform:
    translate(-50%, -50%)
    translateY(calc(var(--fall, 5) * var(--wipe, 0) * 1vh))
    rotate(calc(var(--rot, 0) * 1deg))
    scaleY(var(--sq, 1))
    scale(calc(var(--land, 1) * (1 - var(--wipe, 0) * var(--shrink, 0.5))));
  /* Darkest where it pooled, bluer where it thinned — which is the way round
     liquid actually dries, and the way round the first pass had it backwards.
     Not a circle, either: a radial gradient on a square element can only ever
     make a disc, and a screenful of discs is weather, not ink. The silhouette
     is carried by a lopsided border-radius, per splat. */
  background:
    radial-gradient(circle closest-side at 42% 38%,
      rgba(7,9,26,1) 0 42%, rgba(20,28,74,1) 100%);
  border-radius: 74% 26% 58% 42% / 32% 68% 32% 68%;
  /* Two edges, and neither is an outline. A *hairline* of wet blue picks the
     silhouette off this circuit's near-black tarmac — without it the item reads
     as "the sky got dirty" and costs its victim nothing — and a soft dark
     spread outside feathers the cut and lets neighbouring splats run together
     into one mass rather than sitting apart like cut paper. The keyline this
     replaces was four times as thick and photographed as exactly that. */
  box-shadow:
    inset 0 0 0 0.09vmin rgba(150,180,255,.42),
    inset 0.3vmin 0.5vmin 1.3vmin rgba(96,130,230,.18),
    0 0.2vmin 1.8vmin 0.35vmin rgba(6,8,26,.5);
}
/* A second lobe, offset — the thing that turns one blob into a splat. */
#item-ink i::before {
  content: ''; position: absolute; left: -22%; top: 24%;
  width: 76%; height: 68%;
  background: rgba(9,12,34,1);
  border-radius: 62% 38% 44% 56% / 56% 44% 60% 40%;
  box-shadow: inset 0 0 0 0.09vmin rgba(150,180,255,.3);
}
/* The drip. One tapered tongue running off the low edge of each splat, and it
   *lengthens as the ink runs* — the single motion that says the stuff on the
   glass is liquid rather than a mask being faded out. */
#item-ink i::after {
  content: ''; position: absolute; left: 31%; top: 68%;
  width: 29%; height: 54%;
  transform-origin: 50% 0;
  /* Half again, not three and a half times. Past about 1.6 the tongue is longer
     than the splat that made it is wide, and a dark shape that much taller than
     it is broad stops reading as a run of ink and starts reading as a scratch
     on the lens. */
  transform: scaleY(calc(1 + var(--wipe, 0) * 1.5));
  background: linear-gradient(rgba(9,12,34,1) 0 40%, rgba(11,15,44,.72) 70%, rgba(13,18,52,0) 100%);
  border-radius: 42% 58% 50% 50% / 14% 14% 86% 86%;
}
#item-ink i:nth-child(3n) { border-radius: 34% 66% 72% 28% / 68% 30% 70% 32%; }
#item-ink i:nth-child(3n+1) { border-radius: 66% 34% 30% 70% / 28% 72% 26% 74%; }
#item-ink i:nth-child(5n) { border-radius: 52% 48% 28% 72% / 74% 26% 66% 34%; }
#item-ink i:nth-child(3n)::before { left: auto; right: -20%; top: 6%; }
#item-ink i:nth-child(4n)::after { left: 60%; width: 19%; height: 46%; }
/* ...and the satellite: one droplet thrown clear of the splat that made it.
   Spatter is what separates ink from a mask, and it is nearly free — a droplet
   is a few hundred pixels and it is the detail the eye uses to decide what the
   dark shapes on the screen *are*. */
#item-ink i b {
  position: absolute; left: 78%; top: -14%;
  width: 22%; height: 20%;
  background: rgba(9,12,34,.95);
  border-radius: 58% 42% 38% 62% / 46% 54% 46% 54%;
}
#item-ink i:nth-child(2n) b { left: -12%; top: 76%; width: 18%; height: 17%; }

/* ── the spatter ───────────────────────────────────────────────────────────

   Everything that reaches the middle of the frame, and the rule for it is
   **small and hard, never large and faint.**

   Two attempts got this wrong in opposite directions and both were the same
   mistake — treating the middle of the screen as a place to put a *filter*. The
   first covered it with one near-opaque sheet, which is a blindfold. The second
   covered it with five big half-transparent blots, which measured beautifully
   and photographed as soap bubbles: a pale grey disc with a rim around it is
   not tar on the lens, it is a smear on a camera, and it costs the player the
   whole middle of the frame anyway because there is no gap anywhere in it to
   see through.

   Thrown liquid is not a wash. It is a scatter of hard little blots with clean
   road between them, and that shape is better on both counts at once: the eye
   reads the object correctly because the edges are sharp, and the *area* is
   tiny because each one is. Fourteen spots averaging six vmin cost about five
   points of the central crop even drawn nearly opaque — a third of what five
   soft blots cost — and what a player loses is the thing they were reading, not
   the light they were reading it by. Look between them and the road is exactly
   as it was.

   They are also kept off the machine itself: nothing lands inside the box that
   holds the kart and the tarmac immediately ahead of it. */
#item-ink i.spot {
  background:
    radial-gradient(circle closest-side at 44% 40%,
      rgba(7,9,26,.95) 0 64%, rgba(18,26,70,.9) 100%);
  box-shadow:
    inset 0 0 0 0.1vmin rgba(172,200,255,.5),
    0 0.12vmin 0.9vmin rgba(6,8,26,.42);
}
#item-ink i.spot::before { background: rgba(9,12,34,.92); box-shadow: none; }
#item-ink i.spot::after {
  background: linear-gradient(rgba(9,12,34,.9) 0 44%, rgba(13,18,54,.6) 76%, rgba(16,22,66,0) 100%);
}
#item-ink i.spot b { background: rgba(9,12,34,.9); }
/* Flecks: the smallest spatter, and the cheapest attention in the item. No
   lobes, no drip — a droplet is a droplet. */
#item-ink i.fleck {
  background: radial-gradient(circle closest-side at 50% 50%,
    rgba(10,14,44,.9) 0 42%, rgba(24,34,92,.5) 76%, rgba(28,40,104,0) 100%);
  box-shadow: inset 0 0 0 0.08vmin rgba(160,190,255,.36);
}
#item-ink i.fleck::before, #item-ink i.fleck::after { display: none; }
#item-ink i.fleck b { display: none; }
#item-flash {
  position: fixed; inset: 0; z-index: 13; pointer-events: none;
  opacity: 0; mix-blend-mode: screen;
}

/* ── incoming ──────────────────────────────────────────────────────────────

   Two parts, and the split is the whole design.

   The *vignette* is the pressure: a red closing in from the edges, read in
   peripheral vision, which is the only place it can be read because the player
   is looking at the corner. It is pushed sideways away from the threat, so the
   red crowds the edge the thing is arriving from. The element is deliberately
   oversized — the gradient's outer stop is opaque, so sliding a screen-sized
   one leaves a bright seam down the far edge.

   The *chevron* is the answer to "where". It rides the perimeter of the frame
   at the threat's bearing and points outward at it, wearing that item's own
   colour: red for a red shell, green for a green shell, orange for a bob-omb,
   gold for a star. A pair of chevrons rather than one arrow, because this
   circuit's own signage is chevrons and the shape already means "danger, this
   way" everywhere else in the frame.

   What used to be here was a word — INCOMING — pinned dead centre under the
   item slot, which is exactly the vanishing point of the road. It said nothing
   about direction, it could not be read at the opacity it actually reached, and
   it sat over the one part of the frame the player is steering by. */
#item-warn {
  position: fixed; inset: 0; z-index: 10; pointer-events: none; opacity: 0;
  --wu: max(9px, min(1.06vw, 1.95vh));
}
#item-warn .vig {
  position: absolute; inset: -16%;
  background: radial-gradient(ellipse 64% 58% at 50% 50%,
    rgba(255,40,20,0) 48%, rgba(255,56,26,.36) 72%, rgba(190,10,2,.94) 100%);
}
/* The chevron. Sized in the HUD's own unit so it holds its share of the frame
   at any resolution, and given a hard dark rim so it reads on cloud and on
   tarmac without changing.

   Two things were wrong with it and both were size-of-signal rather than
   design. It was 5.2 units — about forty pixels of chevron at 720p — and it
   was a *dark* red shape laid over dark asphalt, which is the one background
   this circuit has most of. It is now half again as large, it carries a cream
   core so the brightest thing in it is lighter than anything it can land on,
   and it sits on a soft disc of its own colour so there is something to catch
   in peripheral vision before the eye ever goes looking. */
#item-warn .arrow {
  position: absolute; left: 50%; top: 50%;
  width: calc(var(--wu) * 8.4); height: calc(var(--wu) * 8.4);
  margin: calc(var(--wu) * -4.2);
  filter: drop-shadow(0 calc(var(--wu) * .2) calc(var(--wu) * .36) rgba(0,0,0,.7));
}
/* The halo. A flat disc of the item's own colour, masked to a soft falloff —
   masked rather than gradient-stopped because the colour arrives as a CSS
   variable and there is no way to write "this colour, transparent" as a second
   stop without color-mix(), which is one more thing to be wrong about. */
#item-warn .arrow::before {
  content: ''; position: absolute; inset: -40%;
  background: var(--warn, #FF3A20);
  -webkit-mask-image: radial-gradient(circle, #000 0 16%, rgba(0,0,0,0) 66%);
  mask-image: radial-gradient(circle, #000 0 16%, rgba(0,0,0,0) 66%);
  opacity: .8;
}
#item-warn .arrow svg { position: relative; width: 100%; height: 100%; display: block; }
/* A cream keyline inside the dark rim. Two hard edges, one lighter than
   anything on this circuit and one darker, so the shape survives tarmac, cloud
   and a red kart equally. */
#item-warn .arrow .core {
  fill: none; stroke: #FFF6E8; stroke-width: 2.6; stroke-linejoin: round;
}
`;

/* ── what hit you ──────────────────────────────────────────────────────────

   A stamp: the item's own icon, punched onto the screen the instant it lands
   and gone again inside a beat and a bit.

   The brief for a hit is that it must be *obvious what hit you*, and until this
   existed nothing on screen ever said. The kart spun, the instruments flashed
   red, coins came off — all of which is the same picture whether it was a
   banana, a shell, a bomb or a bolt of lightning. A player who cannot name what
   got them cannot learn to avoid it, and a hit they cannot learn from reads as
   the game being arbitrary.

   It sits directly under the item slot, on the line the player is already
   looking down. That is the one place on this screen a transient message
   belongs and the one place a *persistent* one must never be — which is why the
   incoming warning was moved off it. */
const CSS_HIT = `
/* The host for all four screen layers. "display: contents" on purpose: it gives
   this module one root in the DOM instead of four orphans on the body, and it
   does so without adding a box — no stacking context, no containing block, so
   every layer inside still paints exactly where it painted before. The unit is
   declared here so the drawn nameplate below measures itself the same way every
   other word in the game does. */
#item-fx { display: contents; --u: ${U_CSS}; }
#item-hit {
  position: fixed; left: 50%; top: calc(max(9px, min(1.06vw, 1.95vh)) * 7.9);
  z-index: 12; pointer-events: none; opacity: 0;
  --hu: max(9px, min(1.06vw, 1.95vh));
  display: flex; align-items: center; gap: calc(var(--hu) * .46);
  padding: calc(var(--hu) * .28) calc(var(--hu) * .74) calc(var(--hu) * .28) calc(var(--hu) * .34);
  border-radius: calc(var(--hu) * .6);
  background: linear-gradient(178deg, rgba(58,64,80,.95), rgba(16,19,26,.96));
  box-shadow:
    inset 0 0 0 calc(var(--hu) * .17) var(--hit, #FF6B1A),
    inset 0 calc(var(--hu) * .1) 0 rgba(255,255,255,.22),
    0 calc(var(--hu) * .26) calc(var(--hu) * .7) rgba(0,0,0,.55);
}
#item-hit .art { position: relative; width: calc(var(--hu) * 2.3); height: calc(var(--hu) * 2.3); }
#item-hit .art svg {
  position: absolute; inset: 0; width: 100%; height: 100%; display: none;
  filter: drop-shadow(0 calc(var(--hu) * .12) 0 rgba(0,0,0,.5));
}
#item-hit .art svg.on { display: block; }
/* **The last font-set word in the race, and it is gone.** This plate printed
   the item's name in 'Trebuchet MS' 900 — one word, in the operating system's
   typeface, sitting inside a game where every other word from the flag onwards
   is drawn geometry. It is cut from the same signage face as the results table
   and the pause menu now. */
#item-hit .nm { height: calc(var(--hu) * 1.05); color: #FFF1E4; }
${signCss('#item-fx')}
`;

/** Bold, flat, 64px-legible. Silhouette first — these are read at a glance. */
function iconSvg(id: ItemId): string {
  const body = (): string => {
    switch (id) {
      case 'banana':
        // A **wheel chock**, seen from the side: a hazard-yellow wedge with a
        // dished face, two tread bars and a grab loop. It was a banana with a
        // stalk, drawn under a plate that said WHEEL CHOCK, over a road that
        // now has a chock lying on it — see `buildChock`.
        return `<path d="M6 50h44a3 3 0 0 0 3-3V17c-14 6-26 15-47 26z"
          fill="#FFD429" stroke="#8A6410" stroke-width="3.5" stroke-linejoin="round"/>
          <path d="M20 41l6 9M35 32l6 10" stroke="#2A2E38" stroke-width="5" stroke-linecap="round"/>
          <path d="M53 16a7 7 0 1 1-9 0" fill="none" stroke="#8E99A8" stroke-width="4"/>
          <rect x="4" y="50" width="52" height="6" rx="3" fill="#2A2E38"/>`;
      case 'greenShell':
      case 'redShell': {
        // A *hard hat*, because that is what the thing in the world is — see
        // `buildShell`. The icon used to wear a shell's three dark spots, which
        // is a different object from the one that skitters down the road at
        // seventy metres a second, and a player learns what an item does by
        // matching the picture in the slot to the picture in the road.
        const c = id === 'greenShell' ? '#46D63C' : '#F03A2E';
        const s = id === 'greenShell' ? '#207E1D' : '#8E1C14';
        return `<path d="M8 38a24 24 0 0 1 48 0z" fill="${c}" stroke="#2A2E38" stroke-width="3.5"/>
          <path d="M32 15v23" stroke="${s}" stroke-width="6" stroke-linecap="round"/>
          <path d="M11 33q21 8 42 0" stroke="${s}" stroke-width="5" fill="none"/>
          <rect x="5" y="36" width="54" height="14" rx="7" fill="#FFF8F0" stroke="#2A2E38" stroke-width="3.5"/>`;
      }
      case 'mushroom':
      case 'tripleMushroom':
        // A compressed-air canister, not a mushroom. The model in the world was
        // re-themed to one — every machine in this cast is a roadworks machine,
        // and a red cap with white spots is somebody else's property besides —
        // and the icon was left behind, so the slot showed one object and the
        // kart carried another.
        return `<rect x="27" y="4" width="10" height="10" rx="2" fill="#B9C2D0" stroke="#2A2E38" stroke-width="3"/>
          <path d="M19 22a13 9 0 0 1 26 0v22a6 6 0 0 1-6 6H25a6 6 0 0 1-6-6z"
            fill="#FF6B1A" stroke="#2A2E38" stroke-width="3.5" stroke-linejoin="round"/>
          <rect x="19" y="24" width="26" height="5.5" fill="#FFC300"/>
          <rect x="19" y="36" width="26" height="5.5" fill="#FFC300"/>
          <path d="M26 50h12l-3 6H29z" fill="#B9C2D0" stroke="#2A2E38" stroke-width="3" stroke-linejoin="round"/>
          <path d="M29 57h6l-3 6z" fill="#BFE6FF"/>`;
      case 'star':
        return `<path d="M32 5l8 18 20 2-15 13 5 20-18-11-18 11 5-20L4 25l20-2z"
          fill="#FFD84D" stroke="#8A6410" stroke-width="3.5" stroke-linejoin="round"/>`;
      case 'bulletBill':
        // A **pile driver** — the husk the kart is fired down the road inside,
        // hazard collar and all. The eye this used to have belonged to somebody
        // else's ordnance; what is in the world is a charcoal casing with an
        // orange band round its middle, so that is what is drawn.
        return `<path d="M4 22l-2 10 2 10z" fill="#20242E"/>
          <rect x="7" y="19" width="33" height="26" rx="5" fill="#5A6478" stroke="#20242E" stroke-width="3.5"/>
          <path d="M40 19a15 13 0 0 1 0 26z" fill="#78839A" stroke="#20242E" stroke-width="3.5" stroke-linejoin="round"/>
          <rect x="18" y="19" width="7" height="26" fill="#FF6B1A"/>
          <rect x="30" y="19" width="7" height="26" fill="#FFC300"/>
          <path d="M44 26v12" stroke="#20242E" stroke-width="3" stroke-linecap="round"/>`;
      case 'lightning':
        return `<path d="M38 3L13 36h14l-4 25 26-33H35z"
          fill="#FFE24A" stroke="#8A6410" stroke-width="3.5" stroke-linejoin="round"/>`;
      case 'blooper':
        // A **tar sprayer**: the drum, its hazard band, the spray bar under it
        // and three nozzles pointing down. Not a squid. The thing it throws was
        // always tar on the glass — see the note over "#item-ink" — and the
        // object in the air is the last part of it that still said otherwise.
        return `<rect x="10" y="10" width="44" height="26" rx="7"
            fill="#39404F" stroke="#181C26" stroke-width="3.5"/>
          <rect x="20" y="10" width="9" height="26" fill="#FF6B1A"/>
          <rect x="35" y="10" width="9" height="26" fill="#FF6B1A"/>
          <rect x="8" y="40" width="48" height="6" rx="3" fill="#9AA5B4" stroke="#181C26" stroke-width="2.5"/>
          <path d="M16 46l4 7h-8zM32 46l4 7h-8zM48 46l4 7h-8z" fill="#9AA5B4"/>
          <path d="M14 58h6M30 58h6M46 58h6" stroke="#141A2E" stroke-width="4" stroke-linecap="round"/>`;
      case 'boo':
        // A **dust sheet**, and the eyes are the reason it changed: two dots on
        // a white blob make a character, and the character they made belonged
        // to another game. Canvas, a scalloped hem, one corner lifted and four
        // brass eyelets — same pale silhouette, no face.
        return `<path d="M9 36a23 23 0 0 1 46 0v18l-6-6-5 6-6-6-6 6-6-6-5 6-6-6z"
          fill="#F2EADA" stroke="#6E5B36" stroke-width="3.5" stroke-linejoin="round"/>
          <path d="M9 36c4-9 12-14 20-15-7 4-12 9-13 17z" fill="#FFFFFF" opacity=".55"/>
          <path d="M55 22l7-8 2 11z" fill="#F2EADA" stroke="#6E5B36" stroke-width="3" stroke-linejoin="round"/>
          <circle cx="20" cy="45" r="3.2" fill="none" stroke="#6E5B36" stroke-width="3"/>
          <circle cx="44" cy="45" r="3.2" fill="none" stroke="#6E5B36" stroke-width="3"/>`;
      case 'bomb':
        // A **gas bottle** with the valve lamp lit, not a sphere with a fuse.
        // The object on the road is a bottle — see `buildGasBottle` — and this
        // is the picture a player has to match to it in the frame before it
        // goes off.
        return `<circle cx="32" cy="7" r="5" fill="#FFC24A"/>
          <rect x="28" y="10" width="8" height="7" fill="#9AA5B4" stroke="#20242E" stroke-width="2.5"/>
          <path d="M18 17h28" stroke="#FF6B1A" stroke-width="4" stroke-linecap="round"/>
          <path d="M16 32a16 12 0 0 1 32 0v22a6 6 0 0 1-6 6H22a6 6 0 0 1-6-6z"
            fill="#2E3340" stroke="#14171F" stroke-width="3.5" stroke-linejoin="round"/>
          <rect x="16" y="30" width="32" height="6" fill="#FF6B1A"/>
          <rect x="16" y="46" width="32" height="6" fill="#FF6B1A"/>`;
      case 'coin':
        return `<circle cx="32" cy="32" r="22" fill="#FFC300" stroke="#A96E06" stroke-width="3.5"/>
          <ellipse cx="32" cy="32" rx="10" ry="14" fill="none" stroke="#A96E06" stroke-width="3.5"/>`;
      case 'horn':
        return `<path d="M46 22a14 14 0 0 1 0 20M53 15a24 24 0 0 1 0 34"
          stroke="#2E3340" stroke-width="3.5" fill="none" stroke-linecap="round"/>
          <path d="M12 26h10l16-13v38L22 38H12z"
          fill="#FF6B1A" stroke="#2E3340" stroke-width="3.5" stroke-linejoin="round"/>`;
      default:
        return '';
    }
  };
  return `<svg viewBox="0 0 64 64" data-face="${id}">${body()}</svg>`;
}

/**
 * The splat field: `[centre x %, centre y %, size in vmin, vertical squash,
 * rotation °]`.
 *
 * Not hand-waved. The layout is scored on a real frame — `fraction below
 * luminance 60`, worst frame, measured against the same frame clean — and those
 * numbers are the design:
 *
 * | region | what it is | clean | inked | cost |
 * |---|---|---|---|---|
 * | the road box | the kart and the tarmac ahead of it | 0.51 | 0.53 | +0.02 |
 * | the central two thirds | the crop a reviewer measures | 0.24 | 0.29 | +0.05 |
 * | the whole frame | | 0.27 | 0.52 | +0.25 |
 *
 * Every one of the thirteen thick centres sits *on or beyond* an edge of the
 * frame, and the four along the top sit a full sixth of the frame above it —
 * which is the single change that moved the measured cost of this item from
 * twenty points of the central crop to five. What is on screen is an arc of
 * each and they run together into one mass: half the picture is gone and none
 * of it is the part you steer by.
 *
 * The fourteen after them are the *spatter*: they reach into the middle third,
 * because a tar sprayer that only crowds the edges costs a driver looking at
 * the vanishing point precisely nothing. Those fourteen are small and hard (see
 * `.spot`) and given the earliest `--gone` in the field, which is how they can
 * sit over the play area without blacking it out and why the middle of the
 * screen is the first part handed back.
 *
 * Sizes are `vmin` so a splat keeps its share of the *shorter* axis: on a wide
 * monitor the field spreads sideways rather than swelling to swallow the frame,
 * which is what `vmax` did.
 */
const INK_SPLATS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  // the top band — hung from above the frame, so the crop gets the fringe
  [6, -13, 42, 1.10, -18], [36, -17, 38, 0.95, 22], [67, -14, 42, 1.15, 10],
  [97, -10, 38, 1.00, -28],
  // the sides
  [-6, 30, 42, 1.15, 40], [-4, 76, 38, 0.95, -12], [105, 40, 42, 1.20, -14],
  [102, 86, 35, 1.05, 28], [-7, 55, 33, 1.10, -66], [107, 66, 32, 1.00, 74],
  // ...and the bottom, which the kart itself already owns
  [16, 106, 35, 1.00, 52], [70, 110, 33, 0.90, -36], [43, 113, 31, 0.95, 8],
];

/** ...and the spatter that reaches the play area. Same shape data.
 *
 *  Fourteen of them, none bigger than nine vmin, and there is a hole in the
 *  layout where the machine sits — x 40-64%, y below 60% — because the one
 *  thing this item must never take is the kart and the road under it. Denser
 *  towards the sides than the middle, which is both what a throw actually does
 *  and what keeps the vanishing point legible. */
const INK_SPOTS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [26, 24, 8.0, 1.05, -30], [72, 20, 7.0, 0.95, 18], [45, 16, 5.0, 1.00, 44],
  [15, 44, 8.5, 1.10, -50], [88, 38, 8.0, 0.95, 22], [33, 52, 6.0, 1.05, -12],
  [64, 44, 5.0, 0.95, 62], [20, 70, 7.0, 1.10, 34], [80, 73, 7.5, 1.00, -22],
  [56, 29, 4.0, 1.00, 8], [38, 35, 4.5, 0.95, -66], [92, 58, 6.0, 1.05, 40],
  [8, 62, 6.0, 0.95, -8], [72, 58, 4.5, 1.10, 16],
];

/** Spatter. Deterministic — decoration, but decoration that must not differ
 *  between two runs of the same seeded capture. */
const INK_FLECKS: ReadonlyArray<readonly [number, number, number]> = [
  [30, 20, 5.0], [58, 16, 3.6], [19, 38, 4.2], [70, 40, 4.6], [45, 26, 2.8],
  [88, 50, 4.0], [24, 74, 4.8], [66, 76, 3.8], [8, 56, 3.4], [40, 66, 2.6],
  [49, 44, 2.4], [62, 52, 3.0], [36, 50, 2.2], [52, 70, 3.2], [74, 14, 2.6],
];

/**
 * One splat element.
 *
 * `--fall`, `--shrink` and `--gone` are how this one leaves the glass, derived
 * from the index rather than authored: the field has to drain *unevenly* or the
 * whole thing reads as one object being scaled down, and thirty hand-written
 * triples of numbers would be thirty more chances to be wrong about nothing.
 *
 * `gone` is the base of the departure schedule and is per *band*, not per
 * splat — the thin ones over the play area are given the earliest, the thick
 * ones round the edge the latest — so the shape of the recovery is stated in
 * one place instead of being an accident of thirty indices.
 */
function splat(
  [x, y, r, squash, rot]: readonly [number, number, number, number, number],
  i: number, cls = '', gone = 1,
): HTMLElement {
  const s = document.createElement('i');
  if (cls) s.className = cls;
  s.style.left = `${x}%`;
  s.style.top = `${y}%`;
  s.style.width = `${r}vmin`;
  s.style.height = `${r}vmin`;
  s.style.setProperty('--sq', String(squash));
  s.style.setProperty('--rot', String(rot));
  s.style.setProperty('--fall', (4.5 + (i % 4) * 1.3).toFixed(2));
  s.style.setProperty('--shrink', (0.46 + (i % 3) * 0.1).toFixed(2));
  s.style.setProperty('--gone', (gone + (i % 5) * 0.055).toFixed(3));
  s.style.setProperty('--band', (0.15 + (i % 3) * 0.06).toFixed(3));
  if (cls !== 'fleck') s.appendChild(document.createElement('b'));
  return s;
}

/**
 * Where in the wipe each band of the field has finished.
 *
 * The wipe is 0 on the frame the tar lands and 1 with a fifth of the life still
 * to run, so these are the *order* the screen comes back in: the play area
 * first, then the spatter, then the edges. A player who has just been hit
 * should be able to see the road again inside about a second and a half of a
 * three-and-a-half second item — and still be able to tell they were hit.
 */
const GONE_SPOT = 0.40;
const GONE_FLECK = 0.30;
const GONE_THICK = 0.72;

/** Fraction of the ink's life the arrival punch takes. Short: it is thrown at
 *  you, and a thrown thing lands. */
const INK_LAND = 0.045;
/** ...and the fraction it holds full strength for before the *container* starts
 *  to fade. Small, because the fade is per splat now: this is only the sweep
 *  that guarantees nothing is left stranded on the glass at the end. */
const INK_HOLD = 0.14;
/** Peak opacity of the whole field. */
const INK_PEAK = 0.94;

export interface ItemHud {
  build(): void;
  /** The settled item, or null when the slot is empty. */
  setItem(entry: ItemEntry | null): void;
  /**
   * Advance the drum by one face.
   *
   * Called from the fixed step, on the item system's own decelerating cadence,
   * so the *rhythm* of the spin is simulation-timed and deterministic. How the
   * strip travels between two faces is this module's business and runs on the
   * render clock — which is what keeps the motion smooth at any framerate
   * without the sim ever having to know what a frame is.
   */
  reelTick(): void;
  /** `from` is the face the drum starts on — drawn from `ctx.rng`, so a seeded
   *  race replays with the reel showing the same thing on the same frame. */
  spinning(on: boolean, from?: number): void;
  /** Punch the slot: the reel has landed. */
  punch(): void;
  /**
   * Ink on the lens.
   *
   * `remaining` is the *fraction of the blooper's life still to run* — 1 on the
   * frame it lands, 0 when it is gone — not an opacity. The shape of an item's
   * screen effect is a picture, and the picture belongs here: the arrival
   * punch, how long it holds, when it starts to run off the glass and how fast
   * it drains are all read off this one number, so the ink can never get out of
   * step with the timer that owns it.
   */
  setInk(remaining: number): void;
  /**
   * The nearest thing that is actually going to hit the player.
   *
   * `amount` is urgency: 0 for nothing, 1 on the frame of impact. `bearing` is
   * where it is in the player's own frame — 0 dead ahead, positive to the
   * right, ±π behind — and `color` is that item's own, so the chevron names the
   * threat as well as placing it.
   */
  warn(amount: number, bearing: number, color: number): void;
  /** Stamp what just hit the player. */
  strike(item: ItemId): void;
  /** One-off coloured wash: lightning, a hit, a star. */
  flash(color: number, amount: number): void;
  /** Wipe every transient back to nothing — a race is starting. */
  reset(): void;
  update(dt: number): void;
  dispose(): void;
}

export function createItemHud(): ItemHud {
  let root: HTMLDivElement | null = null;
  let slot: HTMLDivElement | null = null;
  let countEl: HTMLDivElement | null = null;
  let glowEl: HTMLDivElement | null = null;
  let stripEl: HTMLDivElement | null = null;
  let inkEl: HTMLDivElement | null = null;
  let flashEl: HTMLDivElement | null = null;
  let warnEl: HTMLDivElement | null = null;
  let vigEl: HTMLDivElement | null = null;
  let arrowEl: HTMLDivElement | null = null;
  let chevronEl: SVGPathElement | null = null;
  let hitEl: HTMLDivElement | null = null;
  let fxRoot: HTMLDivElement | null = null;
  let hitName: SignBox | null = null;
  let style: HTMLStyleElement | null = null;
  const faces = new Map<string, SVGElement>();
  const hitFaces = new Map<string, SVGElement>();
  let shown: string | null = null;
  let hitShown: string | null = null;

  let punchT = 0;
  let spin = 0;
  let glow = 0;
  /** Where the drum is, in faces, and where it is going. Both grow forward and
   *  are folded back by a whole revolution once they pass one, so neither can
   *  drift into the range where a float stops being able to count in sixteenths. */
  let reelPos = 0;
  let reelTarget = 0;
  let reelBlur = -1;
  let flashAmount = 0;
  /** Fraction of the ink's life still to run; see `setInk`. */
  let inkTarget = 0;
  let inkShown = 0;
  /** Held rather than recomputed once the ink is over, so the field fades out
   *  where it got to instead of snapping back to nothing. */
  let inkWipe = 0;
  let inkLand = 1;
  let jitterPhase = 0;
  let warnTarget = 0;
  let warnShown = 0;
  let warnPhase = 0;
  let warnBearing = 0;
  let warnColor = -1;
  let hitT = 0;

  /**
   * The face is keyed on the *item*, never on the item and its count.
   *
   * Keying on both looks tidier and is wrong: fire one of a triple and the slot
   * is asked for "greenShell:2", which no table ever produced, so the icon
   * silently vanishes and the player is left holding two invisible shells. The
   * count is a badge on the corner, and that is all it ever was.
   */
  const key = (e: ItemEntry): string => e.id;

  function build(): void {
    if (root || typeof document === 'undefined') return;

    style = document.createElement('style');
    style.textContent = CSS + CSS_HIT;
    document.head.appendChild(style);

    // **One root, not four.** These four screen layers were four separate
    // orphans on `document.body` — left there when this module stood its own
    // socket down for `ui/itemslot.ts` and kept its screen effects. They are
    // one layer conceptually and they are one element now; the z-indexes inside
    // it are unchanged, and the host carries the same stacking position the
    // loosest of them used to, so nothing about what paints over what moves.
    fxRoot = document.createElement('div');
    fxRoot.id = 'item-fx';
    document.body.appendChild(fxRoot);

    // Screen effects always exist. The slot stands down if the UI module has
    // published one of its own.
    inkEl = document.createElement('div');
    inkEl.id = 'item-ink';
    let k = 0;
    for (const s of INK_SPLATS) inkEl.appendChild(splat(s, k++, '', GONE_THICK));
    for (const s of INK_SPOTS) inkEl.appendChild(splat(s, k++, 'spot', GONE_SPOT));
    for (const [x, y, r] of INK_FLECKS) {
      inkEl.appendChild(splat([x, y, r, 1, 0], k++, 'fleck', GONE_FLECK));
    }
    fxRoot.appendChild(inkEl);

    warnEl = document.createElement('div');
    warnEl.id = 'item-warn';
    // The chevron pair points along -Y in its own box, so a rotation by the
    // bearing aims it straight at whatever is arriving.
    const chevrons = `M32 6 L58 34 L48 42 L32 26 L16 42 L6 34 Z
               M32 26 L58 54 L48 62 L32 46 L16 62 L6 54 Z`;
    warnEl.innerHTML = `<div class="vig"></div><div class="arrow"><svg viewBox="0 0 64 64">
      <path d="${chevrons}"
        fill="#FF3A20" stroke="#14171F" stroke-width="5" stroke-linejoin="round"/>
      <path class="core" d="${chevrons}"/>
      </svg></div>`;
    fxRoot.appendChild(warnEl);
    vigEl = warnEl.querySelector('.vig');
    arrowEl = warnEl.querySelector('.arrow');
    chevronEl = warnEl.querySelector('path');

    hitEl = document.createElement('div');
    hitEl.id = 'item-hit';
    hitEl.innerHTML =
      `<div class="art">${ICON_IDS.map((id) => iconSvg(id)).join('')}</div>`
      + `<div class="nm word"></div>`;
    fxRoot.appendChild(hitEl);
    const nmEl = hitEl.querySelector<HTMLElement>('.nm');
    hitName = nmEl ? signBox(nmEl) : null;
    for (const svg of Array.from(hitEl.querySelectorAll<SVGElement>('svg'))) {
      hitFaces.set(svg.dataset.face ?? '', svg);
    }

    flashEl = document.createElement('div');
    flashEl.id = 'item-flash';
    fxRoot.appendChild(flashEl);

    if (document.querySelector('[data-item-slot]')) return;

    // The drum: one cell per face, plus a copy of the first so the wrap is a
    // continuation rather than a jump back through the whole strip.
    const cells = [...FACES, FACES[0]!]
      .map((id) => `<i>${iconSvg(id)}</i>`).join('');

    root = document.createElement('div');
    root.id = 'item-hud';
    root.innerHTML = `<div class="slot empty">
      <div class="glow"></div>
      <div class="mark">?</div>
      <div class="icons">${ICON_IDS.map((id) => iconSvg(id)).join('')}</div>
      <div class="reel"><div class="strip">${cells}</div></div>
      <div class="count"></div>
    </div>`;
    document.body.appendChild(root);

    slot = root.querySelector('.slot');
    countEl = root.querySelector('.count');
    glowEl = root.querySelector('.glow');
    stripEl = root.querySelector('.strip');
    // The settled-icon layer only. The drum's own copies live inside `.strip`
    // and must never be caught by the face lookup, or showing an item would
    // switch on a cell in the middle of the reel as well.
    const iconLayer = root.querySelector('.icons');
    for (const svg of Array.from(iconLayer?.querySelectorAll<SVGElement>('svg') ?? [])) {
      faces.set(svg.dataset.face ?? '', svg);
    }
  }

  function show(entry: ItemEntry | null): void {
    if (!root) return;
    const k = entry ? key(entry) : null;
    if (k === shown) return;
    if (shown) faces.get(shown)?.classList.remove('on');
    shown = k;
    if (k) faces.get(k)?.classList.add('on');
    if (countEl) {
      const n = entry?.count ?? 1;
      countEl.textContent = n > 1 ? `×${n}` : '';
      countEl.style.opacity = n > 1 ? '1' : '0';
    }
    slot?.classList.toggle('empty', !entry);
  }

  return {
    build,

    setItem(entry: ItemEntry | null): void {
      show(entry);
      if (entry) {
        const def = ITEMS[entry.id];
        if (glowEl) glowEl.style.background =
          `radial-gradient(circle, ${hex(def.color)}, ${hex(def.color)}00 62%)`;
      }
    },

    reelTick(): void { reelTarget += 1; },

    spinning(on: boolean, from = 0): void {
      spin = on ? 1 : 0;
      slot?.classList.toggle('spinning', on);
      if (on) {
        // Square onto a face before the first tick, or the spin opens already
        // blurred and halfway between two icons.
        reelPos = ((from % FACES.length) + FACES.length) % FACES.length;
        reelTarget = reelPos;
        reelBlur = -1;
      }
    },

    punch(): void { punchT = 1; glow = 1; },

    setInk(remaining: number): void {
      inkTarget = remaining > 0 ? (remaining > 1 ? 1 : remaining) : 0;
    },

    warn(amount: number, bearing: number, color: number): void {
      warnTarget = amount;
      if (amount <= 0) return;
      warnBearing = bearing;
      if (color !== warnColor) {
        warnColor = color;
        chevronEl?.setAttribute('fill', hex(color));
        warnEl?.style.setProperty('--warn', hex(color));
      }
    },

    strike(item: ItemId): void {
      if (!hitEl) return;
      const def = ITEMS[item];
      hitT = 1;
      if (hitShown !== item) {
        if (hitShown) hitFaces.get(hitShown)?.classList.remove('on');
        hitShown = item;
        hitFaces.get(item)?.classList.add('on');
        hitName?.set(def.name.toUpperCase());
        hitEl.style.setProperty('--hit', hex(def.color));
      }
    },

    flash(color: number, amount: number): void {
      if (!flashEl) return;
      flashEl.style.background = hex(color);
      flashAmount = Math.max(flashAmount, amount);
    },

    reset(): void {
      reelPos = 0;
      reelTarget = 0;
      reelBlur = -1;
      slot?.classList.remove('spinning');
      if (stripEl) { stripEl.style.transform = 'translateY(0%)'; stripEl.style.filter = 'none'; }
      warnTarget = 0;
      warnShown = 0;
      warnPhase = 0;
      inkTarget = 0;
      inkShown = 0;
      inkWipe = 0;
      inkLand = 1;
      flashAmount = 0;
      hitT = 0;
      spin = 0;
      punchT = 0;
      glow = 0;
      if (warnEl) warnEl.style.opacity = '0';
      if (inkEl) {
        inkEl.style.opacity = '0';
        inkEl.style.setProperty('--wipe', '0');
        inkEl.style.setProperty('--land', '1');
      }
      if (flashEl) flashEl.style.opacity = '0';
      if (hitEl) hitEl.style.opacity = '0';
    },

    update(dt: number): void {
      if (flashEl && (flashAmount > 0 || flashEl.style.opacity !== '0')) {
        flashAmount = Math.max(0, flashAmount - dt * 2.6);
        flashEl.style.opacity = flashAmount > 0.002 ? String(flashAmount) : '0';
      }

      if (inkEl && (inkTarget > 0 || inkShown > 0)) {
        const t = inkTarget;
        if (t > 0) {
          // The punch. Classic back-ease: the field arrives a shade oversized
          // and settles, so the ink *lands* rather than appearing.
          const a = clamp01((1 - t) / INK_LAND) - 1;
          inkLand = 1 + 2.9 * a * a * a + 1.9 * a * a;
          // ...and the run. Nothing moves for the first twelfth of the life —
          // the hit has to register before it starts giving the screen back —
          // and from there the field drains off the glass.
          inkWipe = clamp01((1 - t - 0.08) / 0.8);
        }
        // The container holds full strength for all but the last sixth of the
        // life: the *field* empties on the splats' own staggered schedules, and
        // this is only the sweep that guarantees the glass is clean at the end
        // however the individual clocks landed. Chased rather than written
        // straight through so the arrival cannot land on a frame boundary and
        // flicker, and so a race reset fades instead of cutting.
        const want = t > INK_HOLD ? 1 : t / INK_HOLD;
        inkShown += (want - inkShown) * Math.min(1, dt * (want > inkShown ? 26 : 7));
        if (inkShown < 0.004 && want <= 0) inkShown = 0;
        inkEl.style.opacity = inkShown > 0 ? (inkShown * INK_PEAK).toFixed(3) : '0';
        // Two custom properties on the container drive all thirty splats: the
        // per-splat rates live in the elements' own variables, so a frame of
        // the wipe is two style writes rather than sixty.
        inkEl.style.setProperty('--wipe', inkWipe.toFixed(3));
        inkEl.style.setProperty('--land', inkLand.toFixed(3));
      }

      if (warnEl && (warnTarget > 0 || warnShown > 0)) {
        // Rises fast, releases slowly, and pulses harder the closer it gets —
        // the pulse rate is the time-to-impact readout.
        warnShown += (warnTarget - warnShown) * Math.min(1, dt * (warnTarget > warnShown ? 20 : 6));
        if (warnShown < 0.004) {
          // All the way off, on this frame. The floor below means "on at all is
          // loud", which also means the last frame of a release cannot be
          // allowed to leave the element sitting at the floor for ever.
          warnShown = 0;
          warnPhase = 0;
          warnEl.style.opacity = '0';
        } else {
          warnPhase += dt * (7 + warnShown * 22);
          const pulse = 0.82 + Math.sin(warnPhase) * 0.18;
          // **It arrives already loud.** The old curve multiplied a squared
          // proximity by a pulse that bottomed out at 0.44, so the number this
          // element actually wore over a race never got past 0.79 and spent
          // most of its life around a fifth — visible to an instrument, not to
          // a player. The floor is what fixes that: the moment this is on at
          // all, something is going to hit you inside a second and a half, and
          // it says so at better than a third of full strength.
          warnEl.style.opacity = String((0.42 + 0.5 * warnShown) * pulse);

          // Push the red away from the threat, so the thickest part of the
          // vignette is the edge it is coming from.
          const sx = Math.sin(warnBearing);
          const sy = -Math.cos(warnBearing);
          if (vigEl) {
            vigEl.style.transform =
              `translate(${(-sx * 5.5).toFixed(2)}%, ${(-sy * 5).toFixed(2)}%)`;
          }
          if (arrowEl) {
            // Ride the perimeter of an inset frame rather than a circle: a
            // threat from dead ahead then parks at the top *below the item
            // slot*, and one from behind at the bottom between the coin and
            // position plates, instead of either landing on a readout.
            const ay = sy < 0 ? 30 : 39;
            const kx = Math.abs(sx) > 1e-3 ? 41 / Math.abs(sx) : 1e9;
            const ky = Math.abs(sy) > 1e-3 ? ay / Math.abs(sy) : 1e9;
            const k = Math.min(kx, ky);
            const deg = (warnBearing * 180) / Math.PI;
            const s = 0.86 + 0.5 * warnShown + (pulse - 0.82) * 0.7;
            arrowEl.style.left = `${(50 + sx * k).toFixed(2)}%`;
            arrowEl.style.top = `${(50 + sy * k).toFixed(2)}%`;
            arrowEl.style.transform = `rotate(${deg.toFixed(1)}deg) scale(${s.toFixed(3)})`;
          }
        }
      }

      if (hitEl && hitT > 0) {
        hitT = Math.max(0, hitT - dt * 0.86);
        // Punches in over the first sixth of a second, holds, then lifts away.
        const age = 1 - hitT;
        const pop = age < 0.14 ? 1.9 - (age / 0.14) * 0.9 : 1 + Math.max(0, 0.16 - age) * 0.5;
        const fade = hitT > 0.24 ? 1 : hitT / 0.24;
        hitEl.style.opacity = fade > 0.004 ? fade.toFixed(3) : '0';
        hitEl.style.transform =
          `translate(-50%, ${((1 - fade) * -0.9).toFixed(2)}rem) scale(${pop.toFixed(3)})`;
      }

      if (!slot) return;

      // ── the drum ───────────────────────────────────────────────────────────
      //
      // Chased rather than snapped, and the rate of the chase is the whole
      // animation. The item system calls a new face every 0.05s at the top of
      // the spin and every 0.15s at the bottom of it; a chase at 16 cannot
      // close a whole cell inside the shorter of those, so early on the strip
      // never arrives anywhere and simply *runs*, and by the end it is settling
      // between calls with a moment to spare. The reel therefore decelerates —
      // fast blur, then travel with a pause, then a face that lands and holds —
      // without anything anywhere having to describe a deceleration.
      if (stripEl && (spin > 0 || reelPos !== reelTarget)) {
        const n = FACES.length;
        const gap = reelTarget - reelPos;
        reelPos += gap * Math.min(1, dt * 16);
        if (reelTarget - reelPos < 0.004) reelPos = reelTarget;
        if (reelPos >= n) { reelPos -= n; reelTarget -= n; }
        const p = ((reelPos % n) + n) % n;
        stripEl.style.transform = `translateY(${(-p / (n + 1) * 100).toFixed(3)}%)`;
        // Blurred by how far it still has to travel, not by measured speed —
        // measured speed is a difference of two floats over a frame time and
        // flickers whenever a frame runs long. The remaining distance is the
        // same number the eye is reading anyway: full when a face has just been
        // called, nothing by the time it settles.
        const blur = gap > 0.02 ? Math.min(4.2, gap * 3.4) : 0;
        if (Math.abs(blur - reelBlur) > 0.05) {
          reelBlur = blur;
          stripEl.style.filter = blur > 0.06 ? `blur(${blur.toFixed(2)}px)` : 'none';
        }
      }

      if (punchT > 0) punchT = Math.max(0, punchT - dt * 3.2);
      if (glow > 0) glow = Math.max(0, glow - dt * 2.2);

      // The reel shakes while it spins and snaps out on the settle.
      jitterPhase += dt * 47;
      const jitter = spin > 0 ? Math.sin(jitterPhase) * 0.035 : 0;
      const pop = 1 + punchT * punchT * 0.42;
      slot.style.transform = `scale(${pop + jitter}) rotate(${jitter * 12}deg)`;
      if (glowEl) glowEl.style.opacity = String(glow * 0.9);
    },

    dispose(): void {
      root?.remove();
      inkEl?.remove();
      warnEl?.remove();
      fxRoot?.remove();
      style?.remove();
      root = null;
      stripEl = null;
      inkEl = null;
      warnEl = null;
      vigEl = null;
      arrowEl = null;
      chevronEl = null;
      hitEl = null;
      fxRoot = null;
      hitName = null;
      flashEl = null;
      style = null;
      faces.clear();
      hitFaces.clear();
      shown = null;
      hitShown = null;
    },
  };
}

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
