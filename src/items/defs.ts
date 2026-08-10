// What each item *is*, and who gets which one.
//
// Two tables live here and nothing else does. The first says how an item looks
// and behaves at the level the rest of the module needs (colour, whether the
// button aims it or fires it, how long a CPU sits on it). The second is the
// roulette distribution — the single most important balance surface in a kart
// racer, because it is the comeback mechanic. A leader who can draw a red shell
// wins by more every lap; a tail-ender who cannot draw a star never comes back.
//
// Nothing here reads a clock or Math.random. The draw takes an `Rng` so a given
// seed replays the same race, items included.

import type { ItemId } from '../types.ts';
import type { Rng } from '../core/math.ts';

/** An item as it is actually held: an id plus how many of it. */
export interface ItemEntry {
  id: ItemId;
  count: number;
}

export interface ItemDef {
  id: ItemId;
  name: string;
  /** Drives the icon, the trail, and the colour of the burst when it connects.
   *  A player has to be able to name what hit them from one frame. */
  color: number;
  accent: number;
  /**
   * `aim` items are deployed by the button: a tap throws forward, a hold lays
   * them behind. `instant` items fire the moment the button goes down.
   */
  mode: 'aim' | 'instant';
  /** Seconds a CPU holds it before looking for somewhere to put it. */
  aiDelay: number;
}

const D = (
  id: ItemId, name: string, color: number, accent: number,
  mode: ItemDef['mode'], aiDelay: number,
): ItemDef => ({ id, name, color, accent, mode, aiDelay });

/**
 * **The names are this game's, not another studio's — and so are the objects.**
 *
 * The machines are a Road Cone, a Tipper Truck and a Shunter; the drivers are
 * Bollard, Tarmac, Hi-Vis and Skip; the circuits are Cone Canyon Speedway and
 * Saltpan Bypass — and the item set was Banana, Green Shell, Red Shell,
 * Mushroom, Star, Bullet Bill, Blooper, Boo and Bob-omb. The roadworks joke
 * that carries the entire cast stopped dead at the item box.
 *
 * The names went first. The *art* is the half that took a second pass, and
 * until it landed this table was the worst of both: a plate reading WHEEL CHOCK
 * over a yellow crescent with a stalk on it, DUST SHEET over a ghost with two
 * eyes and a mouth, GAS BOTTLE over a black sphere with a lit fuse. A rename
 * with the old object still under it is not a rename, it is a caption. Every
 * model in `models.ts` is now the thing its label says — chock, hard hat,
 * canister, gas bottle, tar sprayer, dust sheet, pile driver — and every icon
 * on the what-hit-you plate is a picture of that model.
 *
 * The `ItemId`s are untouched — they are a published contract in `types.ts`,
 * every module in the game switches on them, and renaming them would be churn
 * for no player. `banana` is the id of a wheel chock, and that is fine; the
 * *name* is what a player reads.
 */
export const ITEMS: Record<ItemId, ItemDef> = {
  // A hazard-yellow wedge lying flat on the tarmac that puts you sideways if
  // you find it with a wheel.
  banana:         D('banana', 'Wheel Chock', 0xFFD429, 0xC98A16, 'aim', 1.4),
  // The domed thing with the bright brim that skitters down the road — built as
  // a hard hat since the models were drawn.
  greenShell:     D('greenShell', 'Hard Hat', 0x46D63C, 0xF3FFE8, 'aim', 0.9),
  // The same hat, in a colour that means somebody is coming to find you.
  redShell:       D('redShell', "Foreman's Hat", 0xF03A2E, 0xFFEDE4, 'aim', 0.8),
  mushroom:       D('mushroom', 'Air Canister', 0xFF5B4A, 0xFFF3E2, 'instant', 1.2),
  tripleMushroom: D('tripleMushroom', 'Triple Canister', 0xFF5B4A, 0xFFF3E2, 'instant', 1.0),
  // A gold star, and on a work site a gold star is a safety record nobody can
  // touch you over. The model did not have to change a millimetre.
  star:           D('star', 'Safety Award', 0xFFD84D, 0xFFF6C8, 'instant', 0.7),
  // The kart goes inside a charcoal husk with a hazard collar and is fired down
  // the road. That is a pile driver, not a bullet.
  bulletBill:     D('bulletBill', 'Pile Driver', 0x4A5162, 0xFFF8F0, 'instant', 1.1),
  // Everyone on site shrinks, slows and loses what they were carrying.
  lightning:      D('lightning', 'Power Cut', 0xFFE24A, 0xFFFCE0, 'instant', 1.6),
  // A drum on two wheels with a spray bar under it, lobbed up the road at
  // everybody ahead. It was called the Line Marker for one round, which was the
  // wrong half of the trade: what lands on the glass is *tar*, near-black and
  // wet, and no line marker throws that. The machine and the mess it makes are
  // one object again — see `buildSprayer` and the note over "#item-ink".
  // The accent is what the machine *throws*, and it is bitumen — near-black
  // with a warm bias — not the navy it was. Navy on a screen effect is squid
  // ink wearing a new label, which is the half of the rename that a colour
  // picker can undo on its own.
  blooper:        D('blooper', 'Tar Sprayer', 0xFF8A2A, 0x1B140E, 'instant', 1.3),
  // Canvas, translucent, floats, and while it is over you nobody can see you.
  boo:            D('boo', 'Dust Sheet', 0xF2EADA, 0x6E5B36, 'instant', 1.2),
  bomb:           D('bomb', 'Gas Bottle', 0x2E3340, 0xFF6B1A, 'aim', 1.0),
  // Stays. The purse is called coins everywhere in this game — on the HUD, in
  // `coin:get`, in the racer record — and renaming the item and not the purse
  // would be a fresh version of exactly the problem this table is fixing.
  coin:           D('coin', 'Coin', 0xFFC300, 0xFF9B12, 'instant', 0.2),
  horn:           D('horn', 'Air Horn', 0xFF6B1A, 0x2E3340, 'instant', 1.1),
};

/**
 * The distribution, MK8-style.
 *
 * Eight columns, one per position band: column 0 is the leader, column 7 is
 * last. A field of any size is mapped onto those eight and interpolated, so the
 * curve holds whether eight or twelve karts started.
 *
 * The shape to preserve if these are ever retuned:
 *   - the leader draws *defence* — coins, a banana, at most a green shell;
 *   - the midfield draws *tools* — mushrooms, red shells, bombs;
 *   - the tail draws *events* — stars, lightning, bullet bills.
 * Every row overlaps its neighbours, so no position ever has a guaranteed draw.
 */
interface WeightRow {
  id: ItemId;
  count: number;
  w: readonly [number, number, number, number, number, number, number, number];
}

const TABLE: readonly WeightRow[] = [
  { id: 'coin',           count: 1, w: [34, 26, 18, 12,  8,  5,  3,  2] },
  { id: 'banana',         count: 1, w: [30, 24, 18, 12,  8,  5,  3,  2] },
  { id: 'banana',         count: 3, w: [ 6, 10, 12, 10,  7,  4,  2,  1] },
  { id: 'greenShell',     count: 1, w: [18, 18, 16, 12,  9,  6,  4,  2] },
  { id: 'greenShell',     count: 3, w: [ 4,  8, 11, 11,  9,  6,  4,  2] },
  { id: 'mushroom',       count: 1, w: [ 5, 10, 15, 17, 16, 12,  8,  5] },
  { id: 'tripleMushroom', count: 3, w: [ 0,  2,  6, 11, 14, 15, 13,  9] },
  { id: 'redShell',       count: 1, w: [ 0,  4, 11, 15, 15, 13, 10,  7] },
  { id: 'redShell',       count: 3, w: [ 0,  0,  2,  5,  8, 10, 10,  8] },
  { id: 'bomb',           count: 1, w: [ 0,  2,  5,  8, 10, 10,  8,  6] },
  { id: 'blooper',        count: 1, w: [ 0,  2,  5,  7,  8,  7,  5,  3] },
  { id: 'horn',           count: 1, w: [ 2,  3,  4,  5,  5,  5,  4,  3] },
  { id: 'boo',            count: 1, w: [ 0,  0,  2,  4,  6,  8,  8,  7] },
  { id: 'star',           count: 1, w: [ 0,  0,  0,  2,  6, 11, 15, 18] },
  { id: 'lightning',      count: 1, w: [ 0,  0,  0,  0,  2,  5,  9, 13] },
  { id: 'bulletBill',     count: 1, w: [ 0,  0,  0,  0,  0,  4, 10, 18] },
];

/** Scratch, so a draw allocates nothing. Sized once to the table. */
const _weights = new Float64Array(TABLE.length);

/**
 * Draw an item for a racer in `place` of `fieldSize`.
 *
 * The position band is interpolated rather than rounded: in a field of eight
 * that is exact, and in any other field size it keeps the curve smooth instead
 * of stepping two positions at a time.
 */
export function drawItem(rng: Rng, place: number, fieldSize: number): ItemEntry {
  const t = fieldSize > 1 ? (place - 1) / (fieldSize - 1) : 0;
  const u = (t < 0 ? 0 : t > 1 ? 1 : t) * 7;
  const i0 = Math.floor(u);
  const i1 = Math.min(7, i0 + 1);
  const f = u - i0;

  let total = 0;
  for (let i = 0; i < TABLE.length; i++) {
    const row = TABLE[i]!;
    const w = row.w[i0]! + (row.w[i1]! - row.w[i0]!) * f;
    _weights[i] = w;
    total += w;
  }

  let roll = rng.next() * total;
  for (let i = 0; i < TABLE.length; i++) {
    roll -= _weights[i]!;
    if (roll <= 0) {
      const row = TABLE[i]!;
      return { id: row.id, count: row.count };
    }
  }
  return { id: 'banana', count: 1 };
}

/**
 * What the reel cycles through on its way to the answer. Deliberately not the
 * whole table: a reel has to be *readable* as it spins, and thirteen faces at
 * 18Hz is a smear. These are the recognisable ones.
 */
export const REEL_FACES: readonly ItemEntry[] = [
  { id: 'banana', count: 1 },
  { id: 'greenShell', count: 1 },
  { id: 'mushroom', count: 1 },
  { id: 'redShell', count: 1 },
  { id: 'star', count: 1 },
  { id: 'coin', count: 1 },
  { id: 'bomb', count: 1 },
  { id: 'lightning', count: 1 },
];

/**
 * Every distinct (item, count) the table can produce.
 *
 * Not used to build the HUD — the slot keys its icons on the item alone, so a
 * triple that has been half spent still has a face. This is here as the
 * balance-facing view of the table: what a race can actually hand out.
 */
export function tableEntries(): ItemEntry[] {
  const seen = new Set<string>();
  const out: ItemEntry[] = [];
  for (const row of TABLE) {
    const key = `${row.id}:${row.count}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: row.id, count: row.count });
  }
  return out;
}
