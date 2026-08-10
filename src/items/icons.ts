// The item icon set — **the one picture of each item, for the whole game.**
//
// An item icon is not decoration. It is the contract between the socket at the
// top of the screen and the object lying in the road three seconds later, and
// the only way a player ever learns what an item does is by matching one to the
// other. So there is exactly one set, it lives in the module that owns the
// items, and it draws the object in `models.ts` — never the object in the
// `ItemId`.
//
// That last sentence is here because the game shipped a round without it. The
// ids in `types.ts` still read `banana`, `greenShell`, `boo`, `bomb`, `star`,
// `blooper`; the *objects* are a wheel chock, a hard hat, a dust sheet, a gas
// bottle, a safety award and a tar sprayer. A second icon set drawn from the
// ids put a banana with a brown stalk under a plate reading WHEEL CHOCK, a
// Koopa shell with three studs under HARD HAT, a ghost with eyes and hands
// under DUST SHEET, and a lit-fuse bob-omb under GAS BOTTLE — in the same
// frame, thirty pixels apart, as this module's own what-hit-you plate drawing
// the right thing. Two sets is one set too many; this is it.
//
// Craft rules, and they are what make thirteen unrelated objects read as a set:
//
//   *One outline weight.* 3.6 units of near-black on a 64 unit box, joins
//   rounded. It is what holds an icon together against a bright socket face and
//   against a dark plate behind it.
//   *Silhouette first.* Every one has to be namable as a black shape at 30px,
//   because at 200km/h that is all the player gets. Colour is never the only
//   thing separating two icons — the green hat and the red hat are different
//   *shapes*, the way they are different meshes in the road.
//   *Lit, not filled.* Every solid takes a vertical ramp from a lighter version
//   of its own colour to a darker one, plus one soft white crescent from the
//   top left, so an icon reads as a painted object under the same key light the
//   karts are lit by rather than as clip art.

import type { ItemId } from '../types.ts';

const INK = '#141821';
const W = 3.6;

// ── shading ────────────────────────────────────────────────────────────────
//
// The ramps are collected as the bodies below are built and emitted once, as
// `ITEM_ICON_DEFS` — one definition per colour for the whole set rather than a
// `<defs>` block inside each of the forty icon copies a slot, a drum and a hit
// plate contain between them.
//
// The ids are prefixed `ii-` rather than `ig-` on purpose: another module may
// still have a paint server of its own in the document while it migrates onto
// this file, and two `<defs>` fighting over one id is a bug that only shows up
// in whichever order they happened to mount.

const ramps = new Map<string, string>();

const hexOf = (c: string): number => parseInt(c.slice(1), 16);
const mix = (c: number, t: number, target: number): string => {
  const ch = (sh: number): number => {
    const v = (c >> sh) & 255;
    return Math.round(v + (target - v) * t);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
};

/**
 * A colour, as a paint reference to its own top-lit ramp.
 *
 * Anything that is not a plain hex — `none`, or a ramp already — is handed back
 * untouched, so stroke-only paths and the flat highlights keep their own paint.
 */
function lit(fill: string): string {
  if (fill.length !== 7 || fill[0] !== '#') return fill;
  const key = fill.slice(1).toUpperCase();
  if (!ramps.has(key)) {
    const n = hexOf(fill);
    ramps.set(key, `<linearGradient id="ii-${key}" x1="0" y1="0" x2="0" y2="1">`
      + `<stop offset="0" stop-color="${mix(n, 0.34, 255)}"/>`
      + `<stop offset=".46" stop-color="${fill}"/>`
      + `<stop offset="1" stop-color="${mix(n, 0.3, 0)}"/></linearGradient>`);
  }
  return `url(#ii-${key})`;
}

/** Outline + fill in one call, so no icon can drift off the shared weight. */
const s = (d: string, fill: string, extra = ''): string =>
  `<path d="${d}" fill="${lit(fill)}" stroke="${INK}" stroke-width="${W}"
    stroke-linejoin="round" stroke-linecap="round" ${extra}/>`;

const plain = (d: string, fill: string, extra = ''): string =>
  `<path d="${d}" fill="${fill}" ${extra}/>`;

/** The shared specular: a soft crescent, always from the top left. */
const gloss = (d: string, o = 0.55): string =>
  `<path d="${d}" fill="#FFFFFF" opacity="${o}"/>`;

/** A stroke drawn twice — ink underneath, colour on top. Reads at 24px. */
const cable = (d: string, colour: string, w = 4.2, ink = 7.6): string =>
  `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${ink}"
     stroke-linecap="round" stroke-linejoin="round"/>`
  + `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${w}"
     stroke-linecap="round" stroke-linejoin="round"/>`;

// ── the hats ───────────────────────────────────────────────────────────────
//
// A green shell and a red shell are the two most-thrown items in the table and
// the two whose difference matters most: one bounces, one hunts you. `models.ts`
// answers that with two different meshes — the plain hat, and the supervisor's
// helmet with a forward peak, ear defenders and a beacon on the crown — and the
// icons carry the same three shapes, so the answer survives a small mirror, a
// motion-blurred frame and a player who cannot separate the two hues.

/** The plain hard hat: crown, ridge, hazard band, white brim. */
const HARD_HAT = (body: string, band: string): string => `
  ${s('M11 36a21 21 0 0 1 42 0z', body)}
  ${plain('M13.4 30q18.6 7.4 37.2 0v5.4q-18.6 7.4-37.2 0z', band, 'opacity=".85"')}
  ${plain('M32 15.4V36', 'none', `stroke="${INK}" stroke-width="6" stroke-linecap="round"`)}
  ${plain('M32 16.6V36', 'none', `stroke="${band}" stroke-width="3.4" stroke-linecap="round"`)}
  ${gloss('M18 32c.6-8 6.2-13.6 11.8-14.6-6.6 3.8-10 8.4-10.6 15.2z', 0.6)}
  ${s('M6 35.5h52a6.2 6.2 0 0 1 0 12.4H6a6.2 6.2 0 0 1 0-12.4z', '#FFF8F0')}
  ${plain('M7 41.7h50', 'none', `stroke="${INK}" stroke-width="1.5" opacity=".26"`)}
`;

/**
 * ...and the supervisor's, which is a **different object**, not a repaint.
 *
 * Green and red are the two most-thrown items in the table and the difference
 * between them — one bounces, one hunts you — is the one a player has to read
 * out of the corner of an eye, in a mirror, at speed. Hue alone cannot carry
 * that. `buildShell(…, homing)` gives the red one three shapes the plain one
 * has not: ear defenders that widen the silhouette, a hazard band round the
 * crown, and a beacon on top that breaks the dome. Same three here, and they
 * are all *outside* the plain hat's outline, so the two are separable as black
 * thumbnails.
 */
const FOREMANS_HAT = (body: string, band: string): string => `
  ${s('M4.5 27.5h10a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-10a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3z', '#2A2E38')}
  ${s('M49.5 27.5h10a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-10a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3z', '#2A2E38')}
  ${s('M13 36a19 19 0 0 1 38 0z', body)}
  ${plain('M15 30.4q17 7 34 0v5.2q-17 7-34 0z', '#FFC300')}
  ${gloss('M19.5 32c.6-7.6 6-13 11.4-14-6.4 3.6-9.6 8-10.2 14.6z', 0.55)}
  ${s('M6 35.5h52a6.2 6.2 0 0 1 0 12.4H6a6.2 6.2 0 0 1 0-12.4z', '#FFF8F0')}
  ${plain('M7 41.7h50', 'none', `stroke="${INK}" stroke-width="1.5" opacity=".26"`)}
  ${s('M28.6 11h6.8v7h-6.8z', '#B9C2D0')}
  ${plain('M32 8.2a6.4 6.4 0 1 1 0 .1z', INK)}
  ${plain('M32 8.2a4 4 0 1 1 0 .1z', '#FFD24A')}
  ${plain('M32 7.4a1.9 1.9 0 1 1 0 .1z', '#FFF6D8')}
  ${plain('M22 25.5h20', 'none', `stroke="${band}" stroke-width="3" stroke-linecap="round" opacity=".55"`)}
`;

// ── the canister ───────────────────────────────────────────────────────────
//
// The instant boost, drawn as the object that is actually in the road: a
// compressed-air bottle with two hazard bands, a valve on the crown and a cold
// jet at the nozzle. Built once, because the triple is three of it.

const CANISTER = `
  ${plain('M32 6.2m-4.8 0a4.8 4.8 0 1 0 9.6 0a4.8 4.8 0 1 0-9.6 0', 'none',
  `stroke="${INK}" stroke-width="6.6"`)}
  ${plain('M32 6.2m-4.8 0a4.8 4.8 0 1 0 9.6 0a4.8 4.8 0 1 0-9.6 0', 'none',
  'stroke="#C7D0DD" stroke-width="3.2"')}
  ${s('M28.4 9.5h7.2v9h-7.2z', '#AEB8C6')}
  ${s('M19 30.5a13 12.5 0 0 1 26 0v15.5a6 6 0 0 1-6 6H25a6 6 0 0 1-6-6z', '#FF6B1A')}
  ${plain('M20.9 30.4h22.2v5.6H20.9z', '#FFC300')}
  ${plain('M20.9 39.6h22.2v5.6H20.9z', '#FFC300')}
  ${gloss('M23.4 34c.2-6.4 2.6-10.6 5.6-12.4-4.6 4.6-6 8.4-6 12.4z', 0.55)}
  ${s('M26.4 51.5h11.2l-2.4 5.4h-6.4z', '#AEB8C6')}
  ${plain('M29 57.4h6l-3 5.4z', '#BFE6FF', 'opacity=".92"')}
`;

const BODIES: Record<ItemId, string> = {
  /**
   * **A wheel chock.** A hazard-yellow wedge lying on the tarmac with two black
   * tread bars across the cradle, a dark rubber foot under it and a steel grab
   * loop on the blunt end — the object `buildChock` puts in the road, seen from
   * the side it is most often seen from.
   *
   * The wedge profile is the whole silhouette: a long shallow hypotenuse from a
   * low nose to a tall blunt heel. Nothing else in the set has a diagonal top
   * edge, so it is namable as a black shape.
   */
  banana: `
    ${s('M7 47.5h41.5a3.5 3.5 0 0 0 3.5-3.5V16.5C36 23 24 32 7 43z', '#FFD429')}
    ${plain('M11 43.2C25 33.6 36.5 25.8 48.6 20.4v5.2C37.6 30.8 27.4 37.6 15.4 45.6z',
    '#FFF0A8', 'opacity=".62"')}
    ${cable('M18.5 39.5 25.5 49', '#2A2E38', 5.4, 9)}
    ${cable('M33.5 30 40.5 40', '#2A2E38', 5.4, 9)}
    ${plain('M52 14.6a7.4 7.4 0 0 0-9.6 0', 'none',
    `stroke="${INK}" stroke-width="7.4" fill="none" stroke-linecap="round"`)}
    ${plain('M52 14.6a7.4 7.4 0 0 0-9.6 0', 'none',
    'stroke="#B9C2D0" stroke-width="4" fill="none" stroke-linecap="round"')}
    ${s('M4 47h52a3.6 3.6 0 0 1 0 8.4H4A3.6 3.6 0 0 1 4 47z', '#2A2E38')}
  `,
  greenShell: HARD_HAT('#46D63C', '#1F7A1C'),
  redShell: FOREMANS_HAT('#F03A2E', '#8E1C14'),
  mushroom: CANISTER,
  /**
   * Three of them, and the two behind are *drawn* rather than implied by the
   * count badge. A triple is a different item from a single — six seconds of
   * boost instead of two — and the socket should say so before the player has
   * read a number in the corner of it.
   */
  tripleMushroom: `
    <g transform="translate(-3.84 8.92) scale(.62)">${CANISTER}</g>
    <g transform="translate(28.16 8.92) scale(.62)">${CANISTER}</g>
    <g transform="translate(10.24 14.88) scale(.68)">${CANISTER}</g>
  `,
  /**
   * **A safety award, and it has no face.** Two dots and a smile on a gold star
   * is a character out of another game; what `buildStar` puts round the kart is
   * a bevelled gold star and nothing else. The bevel is drawn instead — an
   * inner star line and one gloss crescent — so the icon still reads as a solid
   * object rather than as a flat sticker.
   */
  star: `
    ${s('M32 4.5 40.6 22l19.4 2.8-14 13.6 3.3 19.3L32 48.6 14.7 57.7 18 38.4 4 24.8 23.4 22z', '#FFD84D')}
    ${plain('M32 13 37.6 24.4l12.6 1.8-9.1 8.8 2.1 12.5L32 41.6l-11.2 5.9 2.1-12.5-9.1-8.8 12.6-1.8z',
    '#FFF3C0', 'opacity=".5"')}
    ${gloss('M32 10.5 36.6 20l-10.2 8.4.9-10.2z', 0.6)}
  `,
  /**
   * **A pile driver** — the charcoal husk the kart is fired down the road
   * inside, hazard collar and all. It had eyes and a mouth, which belonged to
   * somebody else's ordnance; the object in the world is a casing with an
   * orange band round its middle and a plume out of the back, so that is what
   * is drawn.
   */
  bulletBill: `
    ${s('M2 32 12 20l-1 12 1 12z', '#FFC300')}
    ${s('M11 32 20 22l-1.4 10 1.4 10z', '#FF6B1A')}
    ${s('M24 17.5h12a15 15 0 0 1 0 29H24a13 14.5 0 0 1 0-29z', '#5A6478')}
    ${plain('M26.5 17.5h6.5v29h-6.5z', '#FF6B1A')}
    ${plain('M37 17.5h6.5v29H37z', '#FFC300')}
    ${gloss('M27 23.5h9a11 11 0 0 1 7 3.4c-2.8-.9-13-.9-17.6 1z', 0.5)}
    ${plain('M48.5 25.5v13', 'none',
    `stroke="${INK}" stroke-width="3.4" stroke-linecap="round" opacity=".75"`)}
  `,
  /** A power cut: the bolt, and nothing else needs saying. */
  lightning: `
    ${s('M40 3 12 37h15l-5 24 26-34H33z', '#FFE24A')}
    ${gloss('M36 8 20 32h7z', 0.5)}
  `,
  /**
   * **A tar sprayer:** the drum, its hazard bands, the spray bar under it and
   * three nozzles running black. Not a squid. What lands on the glass was
   * always bitumen — see the note over "#item-ink" in reel.ts — and the object
   * in the air was the last part of it still saying otherwise.
   */
  blooper: `
    ${s('M9 12h46a7 7 0 0 1 7 7v14a7 7 0 0 1-7 7H9a7 7 0 0 1-7-7V19a7 7 0 0 1 7-7z', '#39404F')}
    ${plain('M19 12h9.5v28H19zM35.5 12H45v28h-9.5z', '#FF6B1A')}
    ${gloss('M8 18c1-2.6 3.4-4 6-4.4-2.6 2-3.6 3.6-4 6.4z', 0.5)}
    ${s('M6 42h52a3.4 3.4 0 0 1 0 7H6a3.4 3.4 0 0 1 0-7z', '#9AA5B4')}
    ${s('M13 49h7l-3.5 6zM28.5 49h7l-3.5 6zM44 49h7l-3.5 6z', '#9AA5B4')}
    ${plain('M16.5 57.5v4M32 57.5v4.6M47.5 57.5v4', 'none',
    'stroke="#1B140E" stroke-width="4.4" stroke-linecap="round"')}
  `,
  /**
   * **A dust sheet.** Canvas, a scalloped hem, one corner lifted off the ground
   * and four brass eyelets — the same pale silhouette a ghost had, and no face,
   * because two dots on a white blob make a character and the character they
   * made belonged to another game.
   */
  /**
   * ...and **where the eyelets go matters more than that they are eyelets.**
   *
   * The first draft of this put two of them low and central with a soft seam
   * curving between them, which is a face: two dark dots and a smile on a pale
   * blob is the exact silhouette this icon exists to stop being. They are along
   * the *top hem*, four of them, where the eyelets of a real dust sheet are —
   * and the folds under them are vertical, because cloth hanging off a hem
   * falls straight down.
   */
  boo: `
    ${s('M9 36a23 23 0 0 1 46 0v18l-6-6-5.5 6-6-6-6 6-5.5-6-6 6-5.5-6z', '#F2EADA')}
    ${plain('M9 36c4-9.6 12-15 20.4-16-7.4 4.2-12.4 9.6-13.4 18z', '#FFFFFF', 'opacity=".6"')}
    ${s('M54.5 22.5 62.5 13l2 12z', '#F2EADA')}
    ${plain('M22 34v18M32 32.5v20M42 34v18', 'none',
    'stroke="#CFC3A4" stroke-width="2.2" stroke-linecap="round" opacity=".85"')}
    ${plain('M15.5 26.5a2.9 2.9 0 1 1 0 .1zM26 22.4a2.9 2.9 0 1 1 0 .1z'
      + 'M38 22.4a2.9 2.9 0 1 1 0 .1zM48.5 26.5a2.9 2.9 0 1 1 0 .1z', INK)}
    ${plain('M15.5 26.5a1.4 1.4 0 1 1 0 .1zM26 22.4a1.4 1.4 0 1 1 0 .1z'
      + 'M38 22.4a1.4 1.4 0 1 1 0 .1zM48.5 26.5a1.4 1.4 0 1 1 0 .1z', '#C79A3E')}
  `,
  /**
   * **A gas bottle** with the valve lamp lit, not a sphere with a fuse. Two
   * hazard bands, a handwheel under a protective collar, and a squat body: the
   * object `buildGasBottle` stands on the road, and the picture a player has to
   * match to it in the one frame before it goes off.
   */
  bomb: `
    ${plain('M32 13.5v-4', 'none', `stroke="${INK}" stroke-width="7"`)}
    ${plain('M32 6.5a5.6 5.6 0 1 1 0 .1z', INK)}
    ${plain('M32 6.5a3.4 3.4 0 1 1 0 .1z', '#FFD98A')}
    ${s('M27.5 12.5h9v6.5h-9z', '#9AA5B4')}
    ${plain('M17 19.5h30', 'none',
    `stroke="${INK}" stroke-width="8" stroke-linecap="round"`)}
    ${plain('M17 19.5h30', 'none',
    'stroke="#FF8A2A" stroke-width="4.4" stroke-linecap="round"')}
    ${s('M16 33a16 12 0 0 1 32 0v20a6 6 0 0 1-6 6H22a6 6 0 0 1-6-6z', '#3B4252')}
    ${plain('M17 30.5h30v6H17zM17 45h30v6H17z', '#FF6B1A')}
    ${gloss('M21 33c.6-5 4-9 8-10.4-4.6 3.6-6.6 7-7 11.4z', 0.45)}
  `,
  /** No outline on the inner face: at the 24px this is drawn at in the coin
   *  readout, two concentric dark rings inside one disc are a smudge. */
  coin: `
    ${s('M32 6c11 0 20 11.6 20 26S43 58 32 58 12 46.4 12 32 21 6 32 6z', '#FFC300')}
    ${plain('M32 14.5c5.6 0 10 7.8 10 17.5S37.6 49.5 32 49.5 22 41.7 22 32s4.4-17.5 10-17.5z', '#FFE486')}
    ${gloss('M22 22c2-5 5.5-8.6 9-9.4-5 3-7.6 6-9 11z', 0.6)}
  `,
  horn: `
    ${plain('M44 20a15 15 0 0 1 0 24M51 13a26 26 0 0 1 0 38', 'none',
    `stroke="${INK}" stroke-width="7.4" fill="none" stroke-linecap="round"`)}
    ${plain('M44 20a15 15 0 0 1 0 24M51 13a26 26 0 0 1 0 38', 'none',
    'stroke="#FFC300" stroke-width="4" fill="none" stroke-linecap="round"')}
    ${s('M9 25h10L36 11v42L19 39H9z', '#FF6B1A')}
    ${gloss('M22 17 32 15v6l-10 6z', 0.4)}
  `,
};

/**
 * The backing every icon is painted on.
 *
 * **An icon cannot be responsible for its own contrast.** A socket face that
 * runs from `#333B49` down to `#0E1218` will swallow any icon painted at the
 * value of the object it depicts — a charcoal pile driver and a near-black gas
 * bottle both photograph as holes. So every icon carries a soft light pool
 * underneath it, sized to the icon and faded out well before the edge of the
 * box. Not a plate: a hard disc reads as a badge and fights the housing it sits
 * in. It is the light the object is standing in, and it puts thirteen different
 * palettes on one footing.
 */
const BACKING = `<radialGradient id="ii-back" cx=".5" cy=".46" r=".54">
<stop offset="0" stop-color="#FFF8F0" stop-opacity=".3"/>
<stop offset=".55" stop-color="#FFF8F0" stop-opacity=".16"/>
<stop offset="1" stop-color="#FFF8F0" stop-opacity="0"/></radialGradient>`;

/** The inner markup of one icon, without the `<svg>` wrapper. */
export function itemIconBody(id: ItemId): string {
  return `<circle cx="32" cy="30" r="32" fill="url(#ii-back)"/>${BODIES[id] ?? ''}`;
}

/** One `<svg>` per item, all present in the slot, one of them `.on`. */
export function itemIconSvg(id: ItemId): string {
  return `<svg viewBox="0 0 64 64" data-face="${id}" aria-hidden="true">`
    + `${itemIconBody(id)}</svg>`;
}

/**
 * The shading ramps every icon above refers to, as one hidden `<svg>`.
 *
 * It has to be in the document *before* any icon is painted and for as long as
 * any icon is on screen — a `url(#…)` paint server is resolved against the
 * document, not against the element that names it. Zero-sized and clipped
 * rather than `display:none`, which is the shape of this trick every browser
 * agrees on.
 */
export const ITEM_ICON_DEFS = `<svg class="item-icon-defs" aria-hidden="true"
  style="position:absolute;width:0;height:0;overflow:hidden"><defs>${
  [...ramps.values()].join('')
}${BACKING}</defs></svg>`;

export const ITEM_ICON_IDS = Object.keys(BODIES) as ItemId[];
