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

/** Outline + fill in one call, so no icon can drift off the shared weight. */
const s = (d: string, fill: string, extra = ''): string =>
  `<path d="${d}" fill="${fill}" stroke="${INK}" stroke-width="${W}"
    stroke-linejoin="round" stroke-linecap="round" ${extra}/>`;

const plain = (d: string, fill: string, extra = ''): string =>
  `<path d="${d}" fill="${fill}" ${extra}/>`;

/** The shared specular: a soft crescent, always from the top left. */
const gloss = (d: string, o = 0.55): string =>
  `<path d="${d}" fill="#FFFFFF" opacity="${o}"/>`;

function shell(body: string, rim: string): string {
  return `
    ${s('M9 37a23 23 0 0 1 46 0z', body)}
    ${plain('M32 17.5a19.5 19.5 0 0 1 19.4 17.6H12.6A19.5 19.5 0 0 1 32 17.5z', rim, 'opacity=".55"')}
    ${s('M32 18.4 27 30h10z', rim)}
    ${s('M14.6 29.2 22 33.6l-4.6 3.4z', rim)}
    ${s('M49.4 29.2 42 33.6l4.6 3.4z', rim)}
    ${gloss('M17 33c1-8 7.5-13 13-13.6-6 3-9.5 8-10.4 14.6z', 0.6)}
    ${s('M5 36h54a5 5 0 0 1 0 13H5a5 5 0 0 1 0-13z', '#FFF8F0')}
    ${plain('M5.5 43.5h53', 'none', `stroke="${INK}" stroke-width="1.6" opacity=".28"`)}
  `;
}

const BODIES: Record<ItemId, string> = {
  banana: `
    ${s('M11 45C11 24 27 9 51 11c-8 6-11 12-14 21-6 18-20 25-26 13z', '#FFD429')}
    ${plain('M18 44c-3-14 7-27 22-30-11 6-17 17-16 29z', '#FFEE9B', 'opacity=".75"')}
    ${s('M47 12.5 55 6', 'none', 'stroke-width="5.4"')}
    ${plain('M47 12.5 55 6', 'none', 'stroke="#6B4A0C" stroke-width="4" stroke-linecap="round"')}
  `,
  greenShell: shell('#46D63C', '#1F7A1C'),
  redShell: shell('#F03A2E', '#8E1C14'),
  mushroom: `
    ${s('M23 37h18v10a9 7.5 0 0 1-18 0z', '#FFF3E2')}
    ${s('M6 38a26 24 0 0 1 52 0z', '#FF5B4A')}
    ${plain('M22.5 20.5a7 7 0 1 1 0 .1z', '#FFF3E2')}
    ${plain('M42 22.5a5 5 0 1 1 0 .1z', '#FFF3E2')}
    ${gloss('M13 34c1.5-9 8-14.5 15-16-8 4.5-12 10-13 16z', 0.5)}
    ${plain('M28 42.5a2.6 2.6 0 1 1 0 .1zM36 42.5a2.6 2.6 0 1 1 0 .1z', INK, 'opacity=".8"')}
  `,
  tripleMushroom: `
    ${s('M23 37h18v10a9 7.5 0 0 1-18 0z', '#FFF3E2')}
    ${s('M6 38a26 24 0 0 1 52 0z', '#FF5B4A')}
    ${plain('M22.5 20.5a7 7 0 1 1 0 .1z', '#FFF3E2')}
    ${plain('M42 22.5a5 5 0 1 1 0 .1z', '#FFF3E2')}
    ${gloss('M13 34c1.5-9 8-14.5 15-16-8 4.5-12 10-13 16z', 0.5)}
  `,
  star: `
    ${s('M32 4.5 40.6 22l19.4 2.8-14 13.6 3.3 19.3L32 48.6 14.7 57.7 18 38.4 4 24.8 23.4 22z', '#FFD84D')}
    ${gloss('M32 10.5 37 21l-11 9 1-11z', 0.55)}
    ${plain('M25 33.5a3.1 3.1 0 1 1 0 .1zM39 33.5a3.1 3.1 0 1 1 0 .1z', INK)}
    ${plain('M27.5 41c2.6 3.4 6.4 3.4 9 0', 'none', `stroke="${INK}" stroke-width="3" stroke-linecap="round"`)}
  `,
  bulletBill: `
    ${s('M20 17h16a15 15 0 0 1 0 30H20a13 15 0 0 1 0-30z', '#4A5162')}
    ${s('M20 20 8 16l3 16-3 16 12-4z', '#2E3340')}
    ${gloss('M24 22h9a11 11 0 0 1 8 4c-3-1-14-1-19 1z', 0.35)}
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
    'stroke="#F2F6FF" stroke-width="6" stroke-linecap="round"')}
    ${s('M32 6c13.5 0 21 11.5 21 23 0 8-4 13-7 15H18c-3-2-7-7-7-15C11 17.5 18.5 6 32 6z', '#F2F6FF')}
    ${gloss('M20 26c0-8 5.5-14 12-15-8 4-11 9-11 16z', 0.7)}
    ${plain('M23 26a5.4 5.4 0 1 1 0 .1zM38 26a5.4 5.4 0 1 1 0 .1z', '#2C3550')}
    ${plain('M26.4 24.4a1.9 1.9 0 1 1 0 .1zM41.4 24.4a1.9 1.9 0 1 1 0 .1z', '#FFFFFF')}
  `,
  boo: `
    ${s('M10 33a22 22 0 0 1 44 0v20l-6-5.4-5.5 5.4L37 47.6 31.5 53 26 47.6 20.5 53 15 47.6 10 53z', '#EFF3FF')}
    ${gloss('M18 30c0-9 6.5-15 13-16-8.5 4.5-12 10-12 17z', 0.7)}
    ${plain('M23 30a4.4 4.4 0 1 1 0 .1zM39 30a4.4 4.4 0 1 1 0 .1z', '#2B3149')}
    ${plain('M32 38.5a6.4 4.4 0 1 1 0 .1z', '#2B3149')}
  `,
  bomb: `
    ${plain('M39 20q10-5 9-16', 'none', `stroke="${INK}" stroke-width="7" fill="none" stroke-linecap="round"`)}
    ${plain('M39 20q10-5 9-16', 'none', 'stroke="#9AA5B4" stroke-width="4" fill="none" stroke-linecap="round"')}
    ${plain('M48 6.5a5.6 5.6 0 1 1 0 .1z', '#FFC65A')}
    ${plain('M49.4 5.6a3 3 0 1 1 0 .1z', '#FFF6D2')}
    ${s('M29 17a21 21 0 1 1 0 42 21 21 0 0 1 0-42z', '#2E3340')}
    ${gloss('M18 30c1.5-6.5 7-11 12-11.6-7 3.4-10 7-11 12z', 0.28)}
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

/** One `<svg>` per item, all present in the slot, one of them `.on`. */
export function itemIconSvg(id: ItemId): string {
  return `<svg viewBox="0 0 64 64" data-face="${id}" aria-hidden="true">${BODIES[id]}</svg>`;
}

export const ITEM_IDS = Object.keys(BODIES) as ItemId[];

/** The coin readout's own icon — the same coin, drawn to sit inline with text. */
export const COIN_SVG = `<svg viewBox="0 0 64 64" class="coin-ico" aria-hidden="true">
  ${BODIES.coin}
</svg>`;

/** A chevron, used for the place-change tell and the banner end caps. */
export const CHEVRON_SVG = `<svg viewBox="0 0 24 24" class="chev" aria-hidden="true">
  <path d="M3 15 12 6l9 9" fill="none" stroke="currentColor" stroke-width="5"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
