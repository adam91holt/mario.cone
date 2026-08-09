// The HUD's numerals. Drawn, not typed.
//
// **Why this file exists.** Every number in a kart racer is a *designed object*:
// the place indicator, the lap counter, the count that hits three, two, one. Up
// to now this HUD set all of them in `'Trebuchet MS', 'Segoe UI', system-ui` —
// which means the most-looked-at elements on the screen were whatever grotesque
// the player's operating system happened to supply, wearing a flat drop shadow.
// The glyph shapes literally changed depending on which machine the game was
// opened on. No first-party racer has ever shipped that.
//
// So the numerals are geometry now. One condensed, back-slanted, chunky face,
// drawn as SVG paths on a 100-unit cap height, with a real bevel: a lit top
// face, a shaded lower face, a dark extruded under-edge and a hard ink keyline
// all the way round. That last part is what makes them work over Cone Canyon,
// where half the lap is framed against a white sky and half against black
// tarmac — the keyline is the silhouette, so the numeral holds its shape
// against anything the renderer puts behind it, *plate or no plate*.
//
// It stays inside the no-asset-files rule: this is path data in a source file,
// exactly like `icons.ts`, not a webfont. There is no `@font-face` anywhere in
// this module and there must never be one — a downloaded font is a network
// fetch, and a locally-installed one is a lottery.
//
// The set is deliberately small: 0-9, the sixteen capitals the HUD actually
// says (the four ordinal suffixes, GO!, FINAL LAP, LAP n, ROCKET START, nTH
// PLACE), and the punctuation the readouts need. Anything not in the table is
// skipped with a space's worth of advance rather than throwing — a banner is
// never worth a crash.

// ── metrics ────────────────────────────────────────────────────────────────

/** Cap height, in glyph units. Every path in the table is drawn 0 → 100. */
const CAP = 100;
/**
 * How far the under-face is extruded below the lit one.
 *
 * Deep enough that the slab actually shows past the keyline — at 6.5 the whole
 * extrusion hid underneath the outline and the "bevel" was a gradient and
 * nothing else. 13 units on a 100 cap leaves about a twentieth of an em of
 * visible side, which is the difference between a numeral with a shadow and a
 * numeral with a *thickness*.
 */
const EXT = 13;
/**
 * The keyline.
 *
 * Stroked *under* the face rather than over it, so only the outer half shows:
 * 16 units of stroke is 8 units of visible line, or 0.08em, and — this is the
 * part that matters — the face keeps its full stem width. Drawn on top instead,
 * the same line ate eight units out of both sides of a twenty-unit stem and
 * every digit came out as a hairline in a heavy box.
 */
const KEY = 16;
/** Breathing room in the viewBox so the keyline and the glow are never clipped. */
const PAD = 14;
/**
 * The back-slant, in degrees.
 *
 * Positive skew in a y-down space pushes the baseline right and leaves the cap
 * line where it is, so the glyph leans *backwards*. It is the one move that
 * separates a racing numeral from an italic one — forward italics read as
 * speed-lines on a poster, a back-slant reads as a moulded plastic number bolted
 * to a machine, which is what these are.
 */
const SLANT = 6.5;
/** Half the horizontal travel the slant costs, so the run stays optically centred. */
const SKEW_HALF = (Math.tan((SLANT * Math.PI) / 180) * (CAP + EXT)) / 2;
/** Letterspacing, in glyph units. Tight — this is a condensed face. */
const TRACK = 9;
/** Advance for a space, and for any character not in the table. */
const SPACE = 30;
/** Every digit advances the same, so a changing number never shifts its neighbours. */
const DIGIT_ADVANCE = 64;

const INK = '#0A0D13';
/** The extruded face: dark, but a hair off the keyline so it reads as a side. */
const UNDER = '#232B3B';

interface Glyph {
  /** Outer contour plus any counters, evenodd. Drawn in a 0..100 cap box. */
  d: string;
  /** Advance width. Digits override this to a common value. */
  w: number;
  /** Optional left bearing, used to centre a narrow digit in its tabular slot. */
  x?: number;
}

// ── the face ───────────────────────────────────────────────────────────────
//
// Condensed, flat-cut terminals, 20-24 units of stem on a 100 cap. Bowls are
// squared off rather than circular: a road sign is stamped out of sheet, not
// drawn with a compass, and the flatter sides give the bevel a face to sit on.

const G: Record<string, Glyph> = {
  '0': {
    w: 58, x: 3,
    d: 'M29 1C45 1 57 13 57 31L57 69C57 87 45 99 29 99C13 99 1 87 1 69L1 31'
      + 'C1 13 13 1 29 1Z'
      + 'M29 25C24 25 21 29 21 34L21 66C21 71 24 75 29 75C34 75 37 71 37 66'
      + 'L37 34C37 29 34 25 29 25Z',
  },
  '1': { w: 50, x: 8, d: 'M34 1L55 1L55 99L29 99L29 34L11 44L5 23Z' },
  '2': {
    w: 57, x: 3,
    d: 'M2 44L2 31C2 13 14 1 30 1C46 1 57 12 57 28C57 39 52 48 42 59L28 74'
      + 'L57 74L57 99L2 99L2 79L31 47C35 42 37 38 37 32C37 27 34 24 30 24'
      + 'C25 24 22 28 22 34L22 44Z',
  },
  '3': {
    w: 58, x: 3,
    d: 'M3 28C5 11 17 1 31 1C46 1 56 10 56 24C56 33 51 40 44 44C53 48 58 56 58 67'
      + 'C58 86 45 99 29 99C14 99 4 91 1 76L23 70C25 76 27 79 31 79C36 79 39 75 39 69'
      + 'C39 62 35 58 28 58L21 58L21 39L27 39C33 39 36 36 36 31C36 26 33 23 30 23'
      + 'C26 23 24 26 23 31Z',
  },
  '4': {
    w: 56, x: 4,
    d: 'M26 1L56 1L56 99L36 99L36 80L1 80L1 56Z'
      + 'M36 20L36 56L19 56Z',
  },
  '5': {
    w: 58, x: 3,
    d: 'M6 1L54 1L54 24L27 24L25 39C29 36 33 35 37 35C50 35 58 45 58 64'
      + 'C58 84 45 99 29 99C14 99 4 91 1 77L23 71C25 77 28 80 32 80C37 80 40 75 40 68'
      + 'C40 61 37 57 31 57C27 57 24 59 22 62L3 58Z',
  },
  '6': {
    w: 56, x: 4,
    d: 'M55 26L33 31C32 26 30 23 27 23C23 23 20 28 20 43C23 39 28 37 33 37'
      + 'C46 37 56 47 56 66C56 85 44 99 28 99C11 99 0 85 0 55C0 20 11 1 29 1'
      + 'C43 1 52 10 55 26Z'
      + 'M28 55C24 55 21 59 21 66C21 73 24 78 28 78C32 78 35 73 35 66'
      + 'C35 59 32 55 28 55Z',
  },
  '7': { w: 56, x: 4, d: 'M2 1L56 1L56 23L32 99L7 99L31 24L2 24Z' },
  '8': {
    w: 57, x: 3,
    d: 'M29 1C44 1 54 9 54 21C54 30 49 37 42 41C51 45 57 53 57 66C57 85 45 99 29 99'
      + 'C13 99 1 85 1 66C1 53 7 45 16 41C9 37 4 30 4 21C4 9 14 1 29 1Z'
      + 'M29 19C25 19 22 22 22 26C22 30 25 33 29 33C33 33 36 30 36 26C36 22 33 19 29 19Z'
      + 'M29 56C24 56 20 60 20 66C20 72 24 77 29 77C34 77 38 72 38 66C38 60 34 56 29 56Z',
  },
  '9': {
    w: 57, x: 3,
    d: 'M2 74L24 69C25 74 27 77 30 77C34 77 37 72 37 57C34 61 29 63 24 63'
      + 'C11 63 1 53 1 34C1 15 13 1 29 1C46 1 57 15 57 45C57 80 46 99 28 99'
      + 'C14 99 5 90 2 74Z'
      + 'M29 22C25 22 22 26 22 33C22 40 25 45 29 45C33 45 36 40 36 33C36 26 33 22 29 22Z',
  },

  A: {
    w: 60,
    d: 'M20 1L40 1L59 99L36 99L32 74L28 74L24 99L1 99Z'
      + 'M30 31L34 56L26 56Z',
  },
  C: {
    w: 57,
    d: 'M56 29L35 34C33 27 31 23 28 23C23 23 20 30 20 50C20 70 23 77 28 77'
      + 'C31 77 33 73 35 66L56 71C53 89 42 99 28 99C11 99 0 83 0 50C0 17 11 1 28 1'
      + 'C42 1 53 11 56 29Z',
  },
  D: {
    w: 57,
    d: 'M3 1L29 1C46 1 56 17 56 50C56 83 46 99 29 99L3 99Z'
      + 'M25 24L25 76L29 76C34 76 35 67 35 50C35 33 34 24 29 24Z',
  },
  E: { w: 56, d: 'M4 1L54 1L54 23L27 23L27 39L49 39L49 60L27 60L27 77L55 77L55 99L4 99Z' },
  F: { w: 54, d: 'M4 1L54 1L54 23L27 23L27 42L49 42L49 63L27 63L27 99L4 99Z' },
  G: {
    w: 58,
    d: 'M57 28L36 33C34 26 32 23 29 23C24 23 21 30 21 50C21 70 24 77 29 77'
      + 'C33 77 36 74 36 68L30 68L30 48L57 48L57 99L45 99L43 91C39 96 34 99 29 99'
      + 'C11 99 0 83 0 50C0 17 11 1 29 1C43 1 54 11 57 28Z',
  },
  H: { w: 57, d: 'M2 1L23 1L23 39L35 39L35 1L56 1L56 99L35 99L35 61L23 61L23 99L2 99Z' },
  I: { w: 27, d: 'M3 1L25 1L25 99L3 99Z' },
  K: { w: 66, d: 'M2 1L23 1L23 39L42 1L64 1L42 46L66 99L42 99L29 66L23 74L23 99L2 99Z' },
  L: { w: 55, d: 'M4 1L26 1L26 76L54 76L54 99L4 99Z' },
  N: { w: 58, d: 'M2 1L22 1L38 47L38 1L57 1L57 99L37 99L21 55L21 99L2 99Z' },
  O: {
    w: 58,
    d: 'M29 1C45 1 57 15 57 50C57 85 45 99 29 99C13 99 1 85 1 50C1 15 13 1 29 1Z'
      + 'M29 24C24 24 21 32 21 50C21 68 24 76 29 76C34 76 37 68 37 50C37 32 34 24 29 24Z',
  },
  P: {
    w: 56,
    d: 'M3 1L30 1C46 1 55 12 55 31C55 50 46 61 30 61L25 61L25 99L3 99Z'
      + 'M25 22L25 40L29 40C33 40 35 37 35 31C35 25 33 22 29 22Z',
  },
  R: {
    w: 59,
    d: 'M3 1L30 1C46 1 55 11 55 30C55 41 51 49 44 54L58 99L35 99L26 61L25 61L25 99L3 99Z'
      + 'M25 22L25 41L29 41C33 41 35 38 35 32C35 26 33 22 29 22Z',
  },
  S: {
    w: 58,
    d: 'M55 29L34 34C33 26 31 22 28 22C25 22 23 25 23 29C23 34 26 37 34 41L40 44'
      + 'C51 49 57 57 57 70C57 88 45 99 28 99C12 99 2 89 0 72L22 67C23 74 25 78 29 78'
      + 'C33 78 35 75 35 71C35 66 32 63 24 59L18 56C7 51 1 43 1 30C1 12 12 1 28 1'
      + 'C43 1 52 11 55 29Z',
  },
  T: { w: 57, d: 'M1 1L56 1L56 24L39 24L39 99L18 99L18 24L1 24Z' },
  X: { w: 58, d: 'M1 1L24 1L29 38L34 1L57 1L40 50L57 99L34 99L29 62L24 99L1 99L18 50Z' },

  '!': { w: 30, d: 'M4 1L28 1L25 65L7 65Z M5 74L27 74L27 99L5 99Z' },
  '/': { w: 46, d: 'M28 1L46 1L18 99L0 99Z' },
  ':': { w: 30, d: 'M4 27L26 27L26 49L4 49Z M4 76L26 76L26 98L4 98Z' },
  '.': { w: 30, d: 'M4 76L26 76L26 98L4 98Z' },
  '+': { w: 56, d: 'M17 26L39 26L39 47L56 47L56 67L39 67L39 88L17 88L17 67L0 67L0 47L17 47Z' },
  '-': { w: 46, d: 'M2 47L44 47L44 67L2 67Z' },
};

// ── the run ────────────────────────────────────────────────────────────────

/**
 * The bevel, as one gradient over the whole run.
 *
 * `userSpaceOnUse` rather than the default bounding box on purpose: measured
 * per-path, a full stop would sit at the same point in *its own* height as a
 * numeral does in its, and the light would break across a line of text. Pinned
 * to the cap box, one straight terminator crosses every glyph in the run at the
 * same height — which is what a bevelled sign actually looks like.
 *
 * The stop is doubled at 0.46 so the change is a *line*, not a fade. A gradient
 * ramp is a plastic shine; a hard terminator is a moulded edge.
 */
const BEVEL = `<linearGradient id="gl-bevel" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${CAP}">
<stop offset="0" stop-color="#FFFFFF" stop-opacity=".55"/>
<stop offset=".12" stop-color="#FFFFFF" stop-opacity=".28"/>
<stop offset=".46" stop-color="#FFFFFF" stop-opacity=".2"/>
<stop offset=".46" stop-color="#000000" stop-opacity=".03"/>
<stop offset="1" stop-color="#000000" stop-opacity=".3"/>
</linearGradient>`;

/** Advance of one character, so callers can lay out around a run if they need to. */
function advance(ch: string): number {
  const g = G[ch];
  if (!g) return SPACE;
  return ch >= '0' && ch <= '9' ? DIGIT_ADVANCE : g.w;
}

/**
 * A string, as one self-contained `<svg>`.
 *
 * Four passes over the same path data, which is why the body is built once and
 * reused — bottom to top: the extruded under-face, the keyline, the flat colour
 * face, and the bevel over it.
 *
 * **The keyline goes underneath.** Painted on top it is centred on the outline
 * and eats half its width out of the stem, which turned every digit into a
 * hairline inside a heavy box. Underneath, the face covers the inner half and
 * only the outer half survives — full stems, and an outline of exactly the
 * weight it was drawn at.
 *
 * The face is `currentColor`, so a caller re-colours a numeral with one CSS
 * property and the bevel, the keyline and the extrusion come along unchanged.
 * Sized by CSS `height`; the width follows from the viewBox's aspect ratio.
 */
export function glyphRun(text: string, cls = ''): string {
  let x = 0;
  let body = '';
  for (const raw of text) {
    const ch = raw.toUpperCase();
    const g = G[ch];
    const adv = advance(ch);
    if (g) {
      const dx = (adv === DIGIT_ADVANCE ? (g.x ?? 0) : 0) + x;
      body += `<path d="${g.d}" transform="translate(${dx.toFixed(1)} 0)"/>`;
    }
    x += adv + TRACK;
  }
  const runW = Math.max(1, x - TRACK);

  const vbX = (-PAD - SKEW_HALF).toFixed(1);
  const vbW = (runW + PAD * 2 + SKEW_HALF * 2).toFixed(1);
  const vbH = (CAP + EXT + PAD * 2).toFixed(1);

  return `<svg class="gl ${cls}" viewBox="${vbX} ${-PAD} ${vbW} ${vbH}"`
    + ` preserveAspectRatio="xMidYMid meet" aria-hidden="true">`
    + `<defs>${BEVEL}</defs>`
    + `<g transform="translate(${(-SKEW_HALF).toFixed(2)} 0) skewX(${SLANT})" fill-rule="evenodd">`
    + `<g transform="translate(0 ${EXT})" fill="${UNDER}" stroke="${UNDER}"`
    + ` stroke-width="${KEY * 0.62}" stroke-linejoin="round">${body}</g>`
    + `<g fill="none" stroke="${INK}" stroke-width="${KEY}" stroke-linejoin="round">${body}</g>`
    + `<g fill="currentColor">${body}</g>`
    + `<g fill="url(#gl-bevel)">${body}</g>`
    + `</g></svg>`;
}

/**
 * An element whose contents are a glyph run, rewritten only when the text
 * changes.
 *
 * Same discipline as `bind()` in theme.ts: the HUD asks for the same string
 * sixty times a second and only pays for it when the answer is different.
 */
export interface GlyphBox {
  readonly el: HTMLElement;
  set(text: string): void;
  readonly text: string;
}

export function glyphBox(el: HTMLElement, initial = ''): GlyphBox {
  let shown = '\u0000';
  const api: GlyphBox = {
    el,
    get text(): string { return shown; },
    set(text: string): void {
      if (text === shown) return;
      shown = text;
      // Empty means *empty*, not a zero-width run — callers hide these holders
      // with `:empty`, and a banner with no detail must not leave a gap the size
      // of a word behind its title.
      el.innerHTML = text ? glyphRun(text) : '';
    },
  };
  api.set(initial);
  return api;
}

/** "1ST", "2ND", "13TH" — the suffix only, as a glyph run's worth of text. */
export function ordinalWord(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'TH';
  const t = v % 10;
  return t === 1 ? 'ST' : t === 2 ? 'ND' : t === 3 ? 'RD' : 'TH';
}

export const CSS_GLYPHS = `
/* The numerals themselves carry their outline and their bevel in the geometry,
   so all this rule does is size them and give the whole object one soft ground
   shadow — the same shadow, at the same fraction of the unit, whatever size the
   run is drawn at. */
#hud .gl {
  display: block; height: 100%; width: auto; overflow: visible;
  filter: drop-shadow(0 calc(var(--u) * .1) calc(var(--u) * .22) rgba(0,0,0,.55));
}
/* A glyph run is sized by the box it sits in: every caller sets a height on the
   holder and the run fills it, so nothing in this module ever states a
   font-size for a number again. */
#hud .glyphs { display: block; }
#hud .glyphs > .gl { height: 100%; }
`;
