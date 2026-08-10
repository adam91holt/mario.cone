// Words, drawn. **The game's display face — front-end and race alike.**
//
// `ui/glyphs.ts` draws every numeral the HUD says, and it stops there on
// purpose: the HUD says sixteen capitals in total. A results screen says
// *names* — BOLLARD, SANDBAG, CHEVRON — and the moment one of them lands in
// `'Trebuchet MS', system-ui` next to a drawn numeral, the screen stops looking
// like one object. Half the table would be geometry and half would be whatever
// grotesque the player's operating system happened to supply.
//
// So this is the second face in the set: a condensed industrial signage face,
// A-Z and 0-9, built from **stroked chamfered polylines** rather than filled
// outlines. That is not a shortcut, it is the point — a stroked stencil with cut
// corners is what a roadworks sign is actually made of, it pairs with the slab
// numerals the way a sign's legend pairs with its digits, and it is honest at
// the size a results table needs (a name is 1.6u tall; a filled face rendered
// that small turns to mud, a 15-unit stroke does not).
//
// The construction matches `glyphs.ts` exactly so the two faces read as
// relatives: the same 100-unit cap height, the same 6.5° back-slant, the same
// dark extrusion under a hard ink keyline under a `currentColor` face. Sized by
// CSS `height`, like everything else in this game's interface.
//
// Anything not in the table advances a space rather than throwing. A results
// screen is never worth a crash.
//
// ── The typographic rule for the whole game ────────────────────────────────
//
// This file used to live in `src/race/`, and the consequence was a game set in
// two alphabets with a hard cut one second wide between them: everything before
// the flag was Trebuchet MS and everything after it was drawn geometry. The
// launch card and the course card said CONE CANYON SPEEDWAY a second apart in
// two different typefaces. So the face moved here, where `ui/` owns it, and the
// rule is stated rather than left to each screen to rediscover:
//
//   **Anything that *names* is drawn.** Headings, machine names, circuit names,
//   cup names, calls to action, option plates, results rows — `signRun` here, or
//   `glyphRun` in `glyphs.ts` when the run is purely numerals.
//
//   **Anything that *describes* is set.** Blurbs, class copy, unit captions
//   ("METRES", "TOTAL KM"), keycap legends. These are sentences and labels, not
//   objects, and hand-authored path data is the wrong tool for a sentence.
//
// Nothing sits between those two. `signCss(scope)` below hands the sizing rule
// to any layer that wants the face, so `#hud`, `#race` and `#menu` can never
// disagree about how a drawn word is measured.

const CAP = 100;
/** Extrusion depth, keyline weight and face weight, in glyph units. */
const EXT = 9;
const INK_W = 30;
const FACE_W = 15;
const PAD = 18;
const SLANT = 6.5;
const SKEW_HALF = (Math.tan((SLANT * Math.PI) / 180) * (CAP + EXT)) / 2;
/** Letterspacing. Wide enough that the chamfers of two neighbours never touch. */
const TRACK = 13;
const SPACE = 30;

const INK = '#0A0D13';
const UNDER = '#232B3B';

interface Letter { d: string; w: number }

/**
 * The face. Every glyph is drawn in a 0..100 cap box, most of them inside
 * x 6..48, and every corner is a chamfer rather than a curve — one construction
 * rule, applied to twenty-six letters, which is what makes a set of hand-drawn
 * glyphs look like a typeface instead of like twenty-six drawings.
 */
const L: Record<string, Letter> = {
  A: { w: 54, d: 'M6 98L27 2L48 98M14 64L40 64' },
  B: { w: 54, d: 'M13 2L13 98M13 2L36 2L46 12L46 36L38 46L13 46M13 46L38 46L48 56L48 88L38 98L13 98' },
  C: { w: 54, d: 'M47 20L35 2L20 2L8 16L8 84L20 98L35 98L47 80' },
  D: { w: 54, d: 'M13 2L34 2L47 16L47 84L34 98L13 98L13 2' },
  E: { w: 52, d: 'M46 2L13 2L13 98L46 98M13 50L39 50' },
  F: { w: 50, d: 'M46 2L13 2L13 98M13 50L39 50' },
  G: { w: 55, d: 'M47 20L35 2L20 2L8 16L8 84L20 98L35 98L47 84L47 54L31 54' },
  H: { w: 54, d: 'M11 2L11 98M45 2L45 98M11 50L45 50' },
  I: { w: 24, d: 'M12 2L12 98' },
  J: { w: 50, d: 'M43 2L43 82L31 98L19 98L8 84' },
  K: { w: 54, d: 'M11 2L11 98M45 2L16 50M24 38L47 98' },
  L: { w: 50, d: 'M13 2L13 98L46 98' },
  M: { w: 58, d: 'M8 98L8 2L27 42L46 2L46 98' },
  N: { w: 56, d: 'M9 98L9 2L45 98L45 2' },
  O: { w: 56, d: 'M8 18L21 2L34 2L47 18L47 82L34 98L21 98L8 82Z' },
  P: { w: 54, d: 'M13 98L13 2L36 2L47 14L47 40L36 52L13 52' },
  Q: { w: 56, d: 'M8 18L21 2L34 2L47 18L47 82L34 98L21 98L8 82ZM33 72L50 99' },
  R: { w: 55, d: 'M13 98L13 2L36 2L47 14L47 40L36 52L13 52M29 52L47 98' },
  S: { w: 54, d: 'M47 18L35 2L20 2L8 16L8 34L18 46L37 52L47 64L47 84L35 98L19 98L8 82' },
  T: { w: 52, d: 'M6 2L48 2M27 2L27 98' },
  U: { w: 54, d: 'M9 2L9 82L23 98L32 98L46 82L46 2' },
  V: { w: 54, d: 'M7 2L27 98L48 2' },
  W: { w: 60, d: 'M5 2L15 98L27 46L39 98L50 2' },
  X: { w: 54, d: 'M8 2L47 98M47 2L8 98' },
  Y: { w: 54, d: 'M8 2L27 50L47 2M27 50L27 98' },
  Z: { w: 54, d: 'M8 2L47 2L8 98L47 98' },

  '0': { w: 56, d: 'M8 18L21 2L34 2L47 18L47 82L34 98L21 98L8 82Z' },
  '1': { w: 40, d: 'M10 20L26 2L26 98' },
  '2': { w: 54, d: 'M8 18L20 2L35 2L47 16L47 34L8 98L47 98' },
  '3': { w: 54, d: 'M8 16L20 2L35 2L47 14L47 34L37 46L25 46M37 46L47 58L47 84L35 98L19 98L8 84' },
  '4': { w: 54, d: 'M37 98L37 2L8 64L47 64' },
  '5': { w: 54, d: 'M46 2L14 2L11 44L34 44L47 56L47 84L35 98L19 98L8 84' },
  '6': { w: 54, d: 'M44 14L33 2L20 2L8 16L8 84L20 98L34 98L47 84L47 64L34 50L18 50L8 62' },
  '7': { w: 52, d: 'M8 2L47 2L24 98' },
  '8': { w: 54, d: 'M20 2L34 2L45 14L45 34L34 46L20 46L9 34L9 14ZM20 46L35 46L47 60L47 84L34 98L20 98L7 84L7 60Z' },
  '9': { w: 54, d: 'M10 84L21 98L34 98L47 84L47 16L35 2L21 2L8 16L8 36L21 50L36 50L47 38' },

  '.': { w: 22, d: 'M11 96L12 96' },
  ',': { w: 22, d: 'M12 92L8 102' },
  ':': { w: 22, d: 'M11 42L12 42M11 96L12 96' },
  '-': { w: 46, d: 'M8 52L38 52' },
  '+': { w: 52, d: 'M25 28L25 76M7 52L43 52' },
  '/': { w: 48, d: 'M42 2L8 98' },
  "'": { w: 22, d: 'M12 2L12 26' },
  '!': { w: 26, d: 'M13 2L13 66M13 96L14 96' },
  '?': { w: 52, d: 'M8 20L20 2L34 2L46 16L46 32L27 50L27 64M27 96L28 96' },
  '(': { w: 30, d: 'M24 2L12 22L12 78L24 98' },
  ')': { w: 30, d: 'M8 2L20 22L20 78L8 98' },
  '×': { w: 46, d: 'M10 20L38 80M38 20L10 80' },
};

function advance(ch: string): number {
  return L[ch]?.w ?? SPACE;
}

/** Width of a run in glyph units — for laying a column out without measuring DOM. */
export function runWidth(text: string): number {
  let x = 0;
  for (const raw of text) x += advance(raw.toUpperCase()) + TRACK;
  return Math.max(1, x - TRACK);
}

/**
 * A string as one self-contained `<svg>`, three passes over one path.
 *
 * The whole run is a *single* path element per pass — the glyphs are translated
 * inside the `d` string rather than wrapped in `<g>`s — so a name costs three
 * DOM nodes whatever its length. A results table with eight names, eight times
 * and a championship column beside it is over a hundred runs on screen at once,
 * and this is what keeps that free.
 */
export function signRun(text: string, cls = ''): string {
  let x = 0;
  let body = '';
  for (const raw of text) {
    const ch = raw.toUpperCase();
    const g = L[ch];
    if (g) {
      // Translate by rewriting the leading M of each subpath. Cheaper than a
      // wrapping transform and it keeps the run to one path element.
      body += translate(g.d, x);
    }
    x += advance(ch) + TRACK;
  }
  const runW = Math.max(1, x - TRACK);

  const vbX = (-PAD - SKEW_HALF).toFixed(1);
  const vbW = (runW + PAD * 2 + SKEW_HALF * 2).toFixed(1);
  const vbH = (CAP + EXT + PAD * 2).toFixed(1);
  const common = 'fill="none" stroke-linecap="round" stroke-linejoin="round"';

  return `<svg class="sg ${cls}" viewBox="${vbX} ${-PAD} ${vbW} ${vbH}"`
    + ` preserveAspectRatio="xMidYMid meet" aria-hidden="true">`
    + `<g transform="translate(${(-SKEW_HALF).toFixed(2)} 0) skewX(${SLANT})">`
    + `<path d="${body}" transform="translate(0 ${EXT})" ${common}`
    + ` stroke="${UNDER}" stroke-width="${INK_W}"/>`
    + `<path d="${body}" ${common} stroke="${INK}" stroke-width="${INK_W}"/>`
    + `<path d="${body}" ${common} stroke="currentColor" stroke-width="${FACE_W}"/>`
    + `</g></svg>`;
}

/** Shift every absolute coordinate pair in a glyph's path by `dx`. */
function translate(d: string, dx: number): string {
  if (dx === 0) return d;
  // The table is written with absolute M/L only (plus Z), so a translation is a
  // rewrite of every x coordinate. Done once per glyph per text change, and the
  // callers cache by string — see `signBox`.
  return d.replace(/([ML])\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g,
    (_m, cmd: string, sx: string, sy: string) => `${cmd}${(+sx + dx).toFixed(1)} ${sy}`);
}

/** An element whose contents are a run, rewritten only when the text changes. */
export interface SignBox {
  readonly el: HTMLElement;
  set(text: string): void;
  readonly text: string;
}

export function signBox(el: HTMLElement, initial = ''): SignBox {
  // A value no caller can pass, so the first `set()` always paints — `''` is a
  // legitimate thing to set later, so it cannot double as "nothing yet".
  // Spelled exactly as `glyphBox` spells it in `glyphs.ts`, and that matters
  // more than it looks: this was a **literal NUL byte typed into the source**,
  // which worked and cost the whole file. `file(1)` called `letters.ts` binary
  // data, so `grep -rn` skipped it silently — the game's display face, one of
  // the two things ARCHITECTURE.md §11a says every screen is set in, was
  // invisible to the one tool every agent uses to find anything.
  let shown = '\u0000';
  const api: SignBox = {
    el,
    get text(): string { return shown; },
    set(text: string): void {
      if (text === shown) return;
      shown = text;
      el.innerHTML = text ? signRun(text) : '';
    },
  };
  api.set(initial);
  return api;
}

/**
 * The sizing rule for a drawn run, for one layer.
 *
 * Every consumer of this face sizes it the same way — a caller gives the holder
 * a height and the run fills it — and this is that rule, generated per scope so
 * `#hud`, `#race` and `#menu` cannot drift into three versions of it.
 */
export function signCss(scope: string): string {
  return `
${scope} .sg { display: block; height: 100%; width: auto; overflow: visible;
  filter: drop-shadow(0 calc(var(--u) * .08) calc(var(--u) * .18) rgba(0,0,0,.6)); }
${scope} .word { display: block; }
${scope} .word > .sg { height: 100%; }
`;
}

export const CSS_LETTERS = signCss('#race');
