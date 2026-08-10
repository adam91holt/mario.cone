// The HUD's icon set. Inline SVG, drawn once into the item slot and switched by
// class — no per-frame DOM churn, no image files, crisp at any resolution.
//
// Every icon is built to the same three rules, which is what makes thirteen
// unrelated objects read as one set:
//
//   *One outline weight.* 3.6 units of near-black on a 64 unit box, joins
//   rounded. It is what holds the icon together against the bright slot face
//   and against the dark plate behind it.
//   *Silhouette first.* Each one has to be namable as a black shape at 30px,
//   because at 200km/h that is all the player gets.
//   *One highlight.* A single soft white shape, top-left, so the icons read as
//   painted vinyl in the same light the karts are lit by, rather than as flat
//   clip art.

import type { ItemId } from '../types.ts';

const INK = '#141821';
const W = 3.6;

// ── shading ────────────────────────────────────────────────────────────────
//
// **Every solid in this set is lit, not filled.**
//
// The icons used to be flat single-colour shapes with one white crescent on
// top, and photographed in the socket they read as clip art: a green shell was
// a green pentagon, a banana was a yellow arc. What a kart racer puts in that
// socket is a *render* — an object with a lit crown and a shaded underside,
// sitting in a bevelled housing — and the cheapest honest version of that in
// flat SVG is to make every body fill a vertical ramp from a lighter version of
// its own colour to a darker one.
//
// The ramps are collected as the bodies below are built and emitted once, into
// a single hidden `<svg>` mounted with the HUD (`ICON_DEFS`). One definition per
// colour for the whole instrument set, rather than a `<defs>` block inside each
// of the forty icon copies the slot and the drum between them contain.

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
    ramps.set(key, `<linearGradient id="ig-${key}" x1="0" y1="0" x2="0" y2="1">`
      + `<stop offset="0" stop-color="${mix(n, 0.34, 255)}"/>`
      + `<stop offset=".46" stop-color="${fill}"/>`
      + `<stop offset="1" stop-color="${mix(n, 0.3, 0)}"/></linearGradient>`);
  }
  return `url(#ig-${key})`;
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

/**
 * The instant boost, drawn as the object that is actually in the road: a
 * compressed-air bottle with two hazard bands, a valve on the crown and a cold
 * jet at the nozzle. Built once and reused, because the triple is three of it.
 */
const CANISTER = `
  ${plain('M32 6.2 m-4.8 0 a4.8 4.8 0 1 0 9.6 0 a4.8 4.8 0 1 0 -9.6 0', 'none',
  `stroke="${INK}" stroke-width="6.6"`)}
  ${plain('M32 6.2 m-4.8 0 a4.8 4.8 0 1 0 9.6 0 a4.8 4.8 0 1 0 -9.6 0', 'none',
  'stroke="#C7D0DD" stroke-width="3.2"')}
  ${s('M28.4 9.5h7.2v9h-7.2z', '#AEB8C6')}
  ${s('M19 30.5a13 12.5 0 0 1 26 0v15.5a6 6 0 0 1-6 6H25a6 6 0 0 1-6-6z', '#FF6B1A')}
  ${plain('M20.9 30.4h22.2v5.6H20.9z', '#FFC300')}
  ${plain('M20.9 39.6h22.2v5.6H20.9z', '#FFC300')}
  ${gloss('M23.4 34c.2-6.4 2.6-10.6 5.6-12.4-4.6 4.6-6 8.4-6 12.4z', 0.55)}
  ${s('M26.4 51.5h11.2l-2.4 5.4h-6.4z', '#AEB8C6')}
  ${plain('M29 57.4h6l-3 5.4z', '#BFE6FF', 'opacity=".92"')}
`;

/**
 * The two shells, which were the same picture in two colours.
 *
 * A green shell and a red shell were literally one function called twice with a
 * different hue: identical dome, identical three studs, identical rim. At
 * socket size and at 200km/h "is this the one that goes straight or the one
 * that hunts?" was a question about a *colour*, and a player who is
 * red-green-confused, or who glanced at it over a bright sky, had no answer at
 * all. The two most consequential items in the game cannot differ in one
 * channel.
 *
 * So the marks on the dome differ too: green wears the three blunt studs it
 * always had, red wears a stacked pair of homing chevrons pointing the way it
 * is about to go. Different shape, different count, different rhythm — legible
 * as a black-and-white thumbnail, which is the test.
 */
function shell(body: string, rim: string, marks: string): string {
  return `
    ${s('M9 37a23 23 0 0 1 46 0z', body)}
    ${plain('M32 17.5a19.5 19.5 0 0 1 19.4 17.6H12.6A19.5 19.5 0 0 1 32 17.5z', rim, 'opacity=".55"')}
    ${marks}
    ${gloss('M17 33c1-8 7.5-13 13-13.6-6 3-9.5 8-10.4 14.6z', 0.6)}
    ${s('M5 36h54a5 5 0 0 1 0 13H5a5 5 0 0 1 0-13z', '#FFF8F0')}
    ${plain('M5.5 43.5h53', 'none', `stroke="${INK}" stroke-width="1.6" opacity=".28"`)}
  `;
}

/** Green: three blunt studs, the way a shell that only bounces is marked. */
const SHELL_STUDS = (rim: string): string => `
  ${s('M32 18.4 27 30h10z', rim)}
  ${s('M14.6 29.2 22 33.6l-4.6 3.4z', rim)}
  ${s('M49.4 29.2 42 33.6l4.6 3.4z', rim)}
`;

/** Red: two chevrons, stacked and pointing forward. It is aimed at somebody. */
const SHELL_CHEVRONS = (rim: string): string => `
  ${plain('M21.5 34 32 26.5 42.5 34', 'none',
  `stroke="${INK}" stroke-width="6.4" fill="none" stroke-linejoin="round" stroke-linecap="round"`)}
  ${plain('M21.5 34 32 26.5 42.5 34', 'none',
  `stroke="${rim}" stroke-width="3.4" fill="none" stroke-linejoin="round" stroke-linecap="round"`)}
  ${plain('M22.5 25 32 18.2 41.5 25', 'none',
  `stroke="${INK}" stroke-width="6.4" fill="none" stroke-linejoin="round" stroke-linecap="round"`)}
  ${plain('M22.5 25 32 18.2 41.5 25', 'none',
  `stroke="${rim}" stroke-width="3.4" fill="none" stroke-linejoin="round" stroke-linecap="round"`)}
`;

const BODIES: Record<ItemId, string> = {
  // **A banana, not a leaf.**
  //
  // The old one was a single tapered arc with a stalk on the end, and at socket
  // size it read as a chilli or a leaf — because a banana's silhouette is not an
  // arc, it is a *fat crescent with two blunt ends and a flat belly*, and the
  // thing that names it instantly is the dark stalk at one end and the dark nib
  // at the other. This one is built from that: an even-thickness crescent lying
  // diagonally, a squared-off brown stalk at the top, a nib at the tip, and one
  // ridge line down the length so it reads as a segmented fruit and not a
  // painted stripe.
  banana: `
    ${s('M21 9C17 39 30 57 55 55C60 54.6 61 47 57 44C38 45 32 34 33 11C33 6 22 5 21 9Z', '#FFD429')}
    ${plain('M30 20C30 41 40 51 55 50C55.6 48.4 55.6 46.6 55 45C41 45.6 35 36 35 19Z',
    '#FFF3B4', 'opacity=".8"')}
    ${plain('M26 16C25 38 34 51 52 51', 'none',
    'stroke="#E0A61A" stroke-width="2.2" fill="none" opacity=".8" stroke-linecap="round"')}
    ${s('M20 10 17 3', 'none', 'stroke-width="7.6"')}
    ${plain('M20.5 10 17.5 3.6', 'none',
    'stroke="#7A5510" stroke-width="4.6" stroke-linecap="round"')}
    ${plain('M57 51.5a3 3 0 0 1 0 4.5', 'none',
    `stroke="${INK}" stroke-width="5" stroke-linecap="round"`)}
    ${plain('M57 52a2.4 2.4 0 0 1 0 3.4', 'none',
    'stroke="#7A5510" stroke-width="3" stroke-linecap="round"')}
  `,
  greenShell: shell('#46D63C', '#1F7A1C', SHELL_STUDS('#1F7A1C')),
  redShell: shell('#F03A2E', '#FFE9C4', SHELL_CHEVRONS('#FFE9C4')),
  // **A compressed-air canister, not a mushroom.** `items/models.ts` re-themed
  // the instant boost to a hazard-banded gas bottle with a nozzle under it —
  // every machine in this cast is a roadworks machine, and a red cap with white
  // spots is somebody else's property besides. The icon was left behind, so the
  // slot showed one object and the road showed another, which breaks the only
  // job an item icon has: to be the picture of the thing you are about to
  // throw. Same bottle, same hazard bands, same cold jet at the nozzle.
  mushroom: CANISTER,
  // Three of them, and the two behind are *drawn* rather than implied by the
  // count badge. A triple is a different item from a single — it is six seconds
  // of boost instead of two — and the slot should say so before the player has
  // read a number in the corner of it.
  // Two behind at the shoulders and one in front and lower — a stack of three
  // bottles rather than three overlapping ghosts of one. They are drawn at full
  // strength: every icon here already carries an ink outline, and the outline is
  // what separates them, so fading the back pair only turns the group muddy.
  tripleMushroom: `
    <g transform="translate(-3.84 8.92) scale(.62)">${CANISTER}</g>
    <g transform="translate(28.16 8.92) scale(.62)">${CANISTER}</g>
    <g transform="translate(10.24 14.88) scale(.68)">${CANISTER}</g>
  `,
  star: `
    ${s('M32 4.5 40.6 22l19.4 2.8-14 13.6 3.3 19.3L32 48.6 14.7 57.7 18 38.4 4 24.8 23.4 22z', '#FFD84D')}
    ${gloss('M32 10.5 37 21l-11 9 1-11z', 0.55)}
    ${plain('M25 33.5a3.1 3.1 0 1 1 0 .1zM39 33.5a3.1 3.1 0 1 1 0 .1z', INK)}
    ${plain('M27.5 41c2.6 3.4 6.4 3.4 9 0', 'none', `stroke="${INK}" stroke-width="3" stroke-linecap="round"`)}
  `,
  // **Lifted out of the plate.** This and the bob-omb were drawn at the values
  // of the object — a bullet bill is gunmetal, a bob-omb is black — and the
  // socket they sit in runs from #333B49 down to #0E1218. Photographed there,
  // both read as *holes*: two icons in a thirteen-icon set where the only thing
  // that registered was a pair of white eyes floating in the dark. An icon in
  // this game is a painted object under a key light, not a value study, so both
  // are now painted in the light: the same hue, three stops up, which keeps the
  // silhouette and gets it off the plate.
  bulletBill: `
    ${s('M20 17h16a15 15 0 0 1 0 30H20a13 15 0 0 1 0-30z', '#78839A')}
    ${s('M20 20 8 16l3 16-3 16 12-4z', '#4B5468')}
    ${gloss('M24 22h9a11 11 0 0 1 8 4c-3-1-14-1-19 1z', 0.5)}
    ${plain('M25 27a4.2 4.2 0 1 1 0 .1zM38 27a4.2 4.2 0 1 1 0 .1z', '#FFF8F0')}
    ${plain('M26.5 37c4 3.4 8 3.4 12 0', 'none', `stroke="#FFF8F0" stroke-width="3" stroke-linecap="round"`)}
  `,
  lightning: `
    ${s('M40 3 12 37h15l-5 24 26-34H33z', '#FFE24A')}
    ${gloss('M36 8 20 32h7z', 0.5)}
  `,
  blooper: `
    ${plain('M17 40v13M25 42v16M39 42v16M47 40v13', 'none',
    `stroke="${INK}" stroke-width="9.4" stroke-linecap="round"`)}
    ${plain('M17 40v13M25 42v16M39 42v16M47 40v13', 'none',
    'stroke="#DCE9FF" stroke-width="6" stroke-linecap="round"')}
    ${s('M32 6c13.5 0 21 11.5 21 23 0 8-4 13-7 15H18c-3-2-7-7-7-15C11 17.5 18.5 6 32 6z', '#DCE9FF')}
    ${gloss('M20 26c0-8 5.5-14 12-15-8 4-11 9-11 16z', 0.7)}
    ${plain('M23 26a5.4 5.4 0 1 1 0 .1zM38 26a5.4 5.4 0 1 1 0 .1z', '#2C3550')}
    ${plain('M26.4 24.4a1.9 1.9 0 1 1 0 .1zM41.4 24.4a1.9 1.9 0 1 1 0 .1z', '#FFFFFF')}
  `,
  // **Arms, and a warm white.** Boo and the blooper were both "white blob with
  // two dark eyes" — the same read at socket size, for two items that do
  // opposite things. Boo gets the two stubby arms it has always had in every
  // drawing of it, which changes the outline rather than the palette, and the
  // two whites are pulled apart: the squid is cold and wet, the ghost is warm.
  boo: `
    ${s('M10 39m-6.5 0a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0 -13 0', '#FFF1E4')}
    ${s('M54 39m-6.5 0a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0 -13 0', '#FFF1E4')}
    ${s('M10 33a22 22 0 0 1 44 0v20l-6-5.4-5.5 5.4L37 47.6 31.5 53 26 47.6 20.5 53 15 47.6 10 53z', '#FFF1E4')}
    ${gloss('M18 30c0-9 6.5-15 13-16-8.5 4.5-12 10-12 17z', 0.7)}
    ${plain('M23 30a4.4 4.4 0 1 1 0 .1zM39 30a4.4 4.4 0 1 1 0 .1z', '#2B3149')}
    ${plain('M32 38.5a6.4 4.4 0 1 1 0 .1z', '#2B3149')}
  `,
  bomb: `
    ${plain('M39 20q10-5 9-16', 'none', `stroke="${INK}" stroke-width="7" fill="none" stroke-linecap="round"`)}
    ${plain('M39 20q10-5 9-16', 'none', 'stroke="#9AA5B4" stroke-width="4" fill="none" stroke-linecap="round"')}
    ${plain('M48 6.5a5.6 5.6 0 1 1 0 .1z', '#FFC65A')}
    ${plain('M49.4 5.6a3 3 0 1 1 0 .1z', '#FFF6D2')}
    ${s('M29 17a21 21 0 1 1 0 42 21 21 0 0 1 0-42z', '#69738A')}
    ${gloss('M18 30c1.5-6.5 7-11 12-11.6-7 3.4-10 7-11 12z', 0.5)}
    ${plain('M11 34q18 8 36 0', 'none', 'stroke="#FF6B1A" stroke-width="6" fill="none"')}
    ${plain('M22 34a3.4 3.4 0 1 1 0 .1zM36 34a3.4 3.4 0 1 1 0 .1z', '#FFF8F0')}
  `,
  // No outline on the inner face: at the 24px this is drawn at in the coin
  // readout, two concentric dark rings inside one disc turn the whole icon into
  // a smudge. The lighter fill does the same job for nothing.
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
 * **An icon cannot be responsible for its own contrast.** The socket's face
 * runs from `#333B49` at the top to `#0E1218` at the bottom, and thirteen icons
 * drawn from thirteen different palettes cannot each be checked against it —
 * two of them, the bob-omb and the bullet bill, lost that argument outright and
 * photographed as holes with a pair of eyes floating in them. Lifting those two
 * fixes those two; the *set* needs one ground.
 *
 * So every icon carries a soft light pool underneath it, sized to the icon and
 * fading out well before the edge of the box. It is not a plate — a hard disc
 * behind an object reads as a badge and would fight the socket's own housing —
 * it is the light the object is standing in, and it puts every icon in the set
 * on the same footing whatever colour it happens to be.
 */
const BACKING = `<radialGradient id="ig-back" cx=".5" cy=".46" r=".54">
<stop offset="0" stop-color="#FFF8F0" stop-opacity=".3"/>
<stop offset=".55" stop-color="#FFF8F0" stop-opacity=".16"/>
<stop offset="1" stop-color="#FFF8F0" stop-opacity="0"/></radialGradient>`;

/** One `<svg>` per item, all present in the slot, one of them `.on`. */
export function itemIconSvg(id: ItemId): string {
  return `<svg viewBox="0 0 64 64" data-face="${id}" aria-hidden="true">`
    + `<circle cx="32" cy="30" r="32" fill="url(#ig-back)"/>${BODIES[id]}</svg>`;
}

/**
 * The shading ramps every icon above refers to, as one hidden `<svg>`.
 *
 * Mounted once with the HUD. It has to be in the document *before* any icon is
 * painted and for as long as any icon is on screen — a `url(#…)` paint server
 * is resolved against the document, not against the element that names it.
 * Zero-sized and clipped rather than `display:none`, which is the shape of this
 * trick that every browser agrees on.
 */
export const ICON_DEFS = `<svg class="icon-defs" aria-hidden="true"><defs>${
  [...ramps.values()].join('')
}${BACKING}</defs></svg>`;

export const ITEM_IDS = Object.keys(BODIES) as ItemId[];

/** The coin readout's own icon — the same coin, drawn to sit inline with text. */
export const COIN_SVG = `<svg viewBox="0 0 64 64" class="coin-ico" aria-hidden="true">
  ${BODIES.coin}
</svg>`;

/**
 * The place-change tell.
 *
 * **Filled, not stroked.** This used to be a 5-unit open stroke in
 * `currentColor`, and photographed against wet tarmac at the size it plays at
 * it was a dim bent line — the single loudest moment in a kart racer announced
 * by something you could mistake for a lens artefact. A solid chevron with an
 * ink rim is the same shape with a silhouette: it holds its colour on cloud and
 * on asphalt, and it survives being seen out of the corner of an eye, which is
 * the only way it is ever seen.
 */
export const CHEVRON_SVG = `<svg viewBox="0 0 24 24" class="chev" aria-hidden="true">
  <path d="M12 2.6 23 13.2l-4.4 4.5L12 11.3l-6.6 6.4L1 13.2z"
    fill="currentColor" stroke="#0E1119" stroke-width="1.9" stroke-linejoin="round"/>
  <path d="M12 5.4 20 13.2l-1.6 1.6L12 8.6 5.6 14.8 4 13.2z" fill="#FFFFFF" opacity=".3"/>
</svg>`;
