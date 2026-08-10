// The HUD's icons.
//
// **There is one drawing of each item in this game and it is not here.**
//
// This file used to carry a second, complete set: thirteen bodies, its own
// shading ramps, its own backing pool, three hundred lines of it — drawn from
// the `ItemId`s rather than from the objects in `items/models.ts`, so the
// socket at the top of the screen showed a banana with a brown stalk under a
// plate reading WHEEL CHOCK and a lit-fuse Bob-omb under GAS BOTTLE. It was
// never seen: `items/reel.ts` walked the published socket at build and
// repainted every `<svg data-face>` from its own set, so two agents drew
// thirteen objects each and one of them was overwritten before a player saw a
// frame of it. A runtime patch over a duplication is not a fix, it is a bill.
//
// So the set is imported, and the repaint in `items/reel.ts` — which walked the
// published socket at build rewriting every face from the item module's own
// drawings — is deleted along with it. What is left in this file is the two
// pictures that are *not* items and have no home in the item module: the coin
// readout's coin (drawn from the item set's coin all the same, so even that is
// one drawing) and the place-change chevron.

import { itemIconBody, itemIconSvg, ITEM_ICON_DEFS, ITEM_ICON_IDS } from '../items/icons.ts';

export { itemIconSvg };
/** The item set's paint servers, mounted with the HUD. See `ITEM_ICON_DEFS`. */
export const ICON_DEFS = ITEM_ICON_DEFS;
/** Every item that has a face, in the order the drum shows them. */
export const ITEM_IDS = ITEM_ICON_IDS;

/**
 * The coin readout's own icon — the same coin the socket draws, sized to sit
 * inline beside the count rather than inside a housing.
 *
 * The light pool comes with it. Every icon in this game stands in that pool, and
 * a coin that does not is the one object in the set painted on a different
 * ground.
 */
export const COIN_SVG = `<svg viewBox="0 0 64 64" class="coin-ico" aria-hidden="true">${
  itemIconBody('coin')
}</svg>`;

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
 *
 * Not an item, so it lives here rather than in the item set.
 */
export const CHEVRON_SVG = `<svg viewBox="0 0 24 24" class="chev" aria-hidden="true">
  <path d="M12 2.6 23 13.2l-4.4 4.5L12 11.3l-6.6 6.4L1 13.2z"
    fill="currentColor" stroke="#0E1119" stroke-width="1.9" stroke-linejoin="round"/>
  <path d="M12 5.4 20 13.2l-1.6 1.6L12 8.6 5.6 14.8 4 13.2z" fill="#FFFFFF" opacity=".3"/>
</svg>`;
