// Drawn marks: the wordmark, and the seven silhouettes the roster is read by.
//
// **The logo is geometry, not type.** A game's name is a designed object, and
// this one is set in the same face the HUD's numerals are cut from — condensed,
// flat-cut terminals, squared bowls, a 6.5° back-slant, an ink keyline and a
// real extruded under-face. Seven of its nine letterforms are the ones already
// drawn in `ui/glyphs.ts`; `M` is drawn here to the same metrics because that
// table never needed one. See the note in the report: the right end state is
// one alphabet, in `glyphs.ts`, that both the HUD and this front-end draw from.
//
// The full stop between the two words is a road cone. It is the only part of
// the mark that is not a letter, it is the thing the game is named after, and
// it is what stops the wordmark from being two words in a heavy sans.
//
// **The silhouettes are the roster's real content.** The art direction's first
// rule is that every racer must be identifiable as a black shape, so the tile a
// player actually chooses from is exactly that test: no colour, no detail, no
// face — a cream shape with an ink keyline over the machine's own tint. If a
// machine cannot be told from its neighbour here, it cannot be told apart at
// 200km/h either.

import { hexCss, C } from '../theme.ts';
import type { VehicleId } from '../../types.ts';

// ── the face ───────────────────────────────────────────────────────────────
//
// Metrics lifted from `ui/glyphs.ts` so the wordmark and the place indicator
// are unmistakably the same cut of lettering.

const CAP = 100;
const EXT = 13;
const KEY = 16;
const PAD = 16;
const SLANT = 6.5;
const SKEW_HALF = (Math.tan((SLANT * Math.PI) / 180) * (CAP + EXT)) / 2;
const TRACK = 7;

const INK = '#0A0D13';
const UNDER = '#232B3B';

interface Letter { d: string; w: number }

/**
 * The nine shapes the mark is built from.
 *
 * A, C, E, I, N, O and R are the `glyphs.ts` outlines unchanged — the same
 * paths the lap counter and the place indicator are drawn with. `M` is new: two
 * 19-unit stems with a chevron slung between them, cut flat top and bottom like
 * every other terminal in the face, and wide enough (68) that the condensed
 * proportion holds at the front of a five-letter word.
 */
const L: Record<string, Letter> = {
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
  E: { w: 56, d: 'M4 1L54 1L54 23L27 23L27 39L49 39L49 60L27 60L27 77L55 77L55 99L4 99Z' },
  I: { w: 27, d: 'M3 1L25 1L25 99L3 99Z' },
  M: {
    w: 68,
    d: 'M2 99L2 1L21 1L34 48L47 1L66 1L66 99L48 99L48 44L39 74L29 74L20 44L20 99Z',
  },
  N: { w: 58, d: 'M2 1L22 1L38 47L38 1L57 1L57 99L37 99L21 55L21 99L2 99Z' },
  O: {
    w: 58,
    d: 'M29 1C45 1 57 15 57 50C57 85 45 99 29 99C13 99 1 85 1 50C1 15 13 1 29 1Z'
      + 'M29 24C24 24 21 32 21 50C21 68 24 76 29 76C34 76 37 68 37 50C37 32 34 24 29 24Z',
  },
  R: {
    w: 59,
    d: 'M3 1L30 1C46 1 55 11 55 30C55 41 51 49 44 54L58 99L35 99L26 61L25 61L25 99L3 99Z'
      + 'M25 22L25 41L29 41C33 41 35 38 35 32C35 26 33 22 29 22Z',
  },
};

/** The separator. A cone, drawn on the same 100-unit cap so it sits in the
 *  line rather than beside it, standing on the baseline like a full stop with
 *  ambitions. */
const CONE: Letter = {
  w: 52,
  d: 'M26 24L44 88L46 99L6 99L8 88Z',
};
const CONE_BANDS = 'M14 74L38 74L41 86L11 86Z M19 56L33 56L35 66L17 66Z';

const BEVEL = `<linearGradient id="mc-wm-bevel" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${CAP}">
<stop offset="0" stop-color="#FFFFFF" stop-opacity=".62"/>
<stop offset=".12" stop-color="#FFFFFF" stop-opacity=".3"/>
<stop offset=".46" stop-color="#FFFFFF" stop-opacity=".2"/>
<stop offset=".46" stop-color="#000000" stop-opacity=".04"/>
<stop offset="1" stop-color="#000000" stop-opacity=".34"/>
</linearGradient>`;

/** One glyph, complete with its own extrusion, keyline, face and bevel, so the
 *  whole thing can be moved as a unit while the mark assembles itself. */
function cell(d: string, fill: string, extra = ''): string {
  return `<g transform="translate(0 ${EXT})" fill="${UNDER}" stroke="${UNDER}"`
    + ` stroke-width="${KEY * 0.62}" stroke-linejoin="round"><path d="${d}"/></g>`
    + `<g fill="none" stroke="${INK}" stroke-width="${KEY}" stroke-linejoin="round">`
    + `<path d="${d}"/></g>`
    + `<path d="${d}" fill="${fill}"/>${extra}`
    + `<path d="${d}" fill="url(#mc-wm-bevel)"/>`;
}

/**
 * The wordmark.
 *
 * Each letter is its own `<g class="wl">` so the mark can *assemble* — the
 * letters drop in one by one on the way to the title screen rather than fading
 * up as a block. The order they arrive in is the order they are written here,
 * which is why the cone lands in the middle of the word instead of at the end
 * of it.
 */
/**
 * ...and it is also the *first* frame of the game.
 *
 * The loading screen in `index.html` carries the output of this function
 * inlined, because that frame has to paint before a single module has parsed —
 * it used to carry a second, unrelated logotype (lowercase "mario.cone" in
 * Trebuchet 900) which held for seconds on a cold load and was then replaced by
 * this one. That inline copy is the one duplicated asset in the project. If any
 * of the paths above change, regenerate it:
 *
 *   node --experimental-strip-types -e "import('./src/ui/menus/art.ts')
 *     .then(m => process.stdout.write(m.wordmark()))"
 */
export function wordmark(): string {
  const runs: Array<{ ch: string; fill: string }> = [];
  for (const ch of 'MARIO') runs.push({ ch, fill: hexCss(C.white) });
  runs.push({ ch: '.', fill: hexCss(C.orange) });
  for (const ch of 'CONE') runs.push({ ch, fill: hexCss(C.yellow) });

  let x = 0;
  let body = '';
  for (let i = 0; i < runs.length; i++) {
    const { ch, fill } = runs[i]!;
    const g = ch === '.' ? CONE : L[ch]!;
    const extra = ch === '.'
      ? `<path d="${CONE_BANDS}" fill="${hexCss(C.white)}"/>`
      : '';
    // Two nested groups on purpose: the outer one carries the letter's place in
    // the word and is never touched again, the inner one is the animation slot.
    // One group doing both means the assembly overwrites the kerning.
    body += `<g transform="translate(${x.toFixed(1)} 0)"><g class="wl" data-i="${i}">`
      + cell(g.d, fill, extra) + `</g></g>`;
    x += g.w + TRACK;
  }
  const runW = Math.max(1, x - TRACK);

  const vbX = (-PAD - SKEW_HALF).toFixed(1);
  const vbW = (runW + PAD * 2 + SKEW_HALF * 2).toFixed(1);
  const vbH = (CAP + EXT + PAD * 2).toFixed(1);

  return `<svg class="wm" viewBox="${vbX} ${-PAD} ${vbW} ${vbH}"`
    + ` preserveAspectRatio="xMidYMid meet" aria-hidden="true">`
    + `<defs>${BEVEL}</defs>`
    + `<g transform="translate(${(-SKEW_HALF).toFixed(2)} 0) skewX(${SLANT})" fill-rule="evenodd">`
    + body
    + `</g></svg>`;
}

// ── the cast, as shapes ────────────────────────────────────────────────────
//
// Side elevations on a 64 x 40 box with the ground at y=36. Schematic on
// purpose: this is the silhouette test, so anything that would only read as
// detail — faces, beacons, hazard stripes — is left off.

// Wheels are circles rather than path arcs because a wheel drawn as a bezier
// blob is the single fastest way to make a machine stop reading as a vehicle.
const c = (x: number, y: number, r: number): string => `<circle cx="${x}" cy="${y}" r="${r}"/>`;
const p = (d: string): string => `<path d="${d}"/>`;

const SHAPES: Record<VehicleId, string> = {
  // A cone on a kart deck. The one silhouette in the cast with a point on top.
  cone:
    p('M32 2 L45 27 L19 27 Z')
    + p('M13 27 H51 V33 H13 Z')
    + c(21, 33, 5) + c(43, 33, 5),
  // Low, long, and nothing above waist height. The reference shape.
  car:
    p('M7 26 L11 20 L23 19 L29 12 H41 L49 19 L57 21 V26 Z')
    + c(19, 28, 5.5) + c(46, 28, 5.5),
  // Tall cab forward, tray behind, stack above. Mass up high.
  truck:
    p('M4 25 V12 H26 V25 Z')
    + p('M29 25 V7 H45 L51 14 H57 V25 Z')
    + p('M22 12 V4 H26 V12 Z')
    + c(12, 28, 5.5) + c(37, 28, 5.5) + c(50, 28, 5.5),
  // Tracks instead of wheels, and an arm out front that nothing else has.
  digger:
    p('M5 25 H41 A5 5 0 0 1 41 34 H5 A5 5 0 0 1 5 25 Z')
    + p('M12 26 V15 H23 V6 H37 V15 H43 V26 Z')
    + p('M39 17 L57 5 L61 10 L44 22 Z')
    + p('M44 20 L57 26 L52 33 L41 26 Z'),
  // Boiler, cab, chimney, dome — and spoked wheels in a row of three.
  train:
    p('M7 25 V12 H27 V25 Z')
    + p('M27 25 V5 H42 V25 Z')
    + p('M10 12 V4 H17 V12 Z')
    + p('M20 12 V8 H25 V12 Z')
    + c(13, 28, 5.5) + c(25, 28, 5.5) + c(37, 28, 5.5),
  // Wings, tail fin and a prop disc. Nothing else on the grid is this wide.
  plane:
    p('M5 24 L14 17 H41 L57 19 L61 22 L56 26 H15 Z')
    + p('M23 17 L31 4 H38 L37 17 Z')
    + p('M11 24 L4 11 H11 L18 24 Z')
    + p('M56 3 H61 V32 H56 Z')
    + c(20, 28, 4.5) + c(44, 28, 4.5),
  // The rotor bar is the whole trick: a horizontal line above everything.
  helicopter:
    p('M13 29 Q13 17 29 17 H38 L57 23 V28 Q40 33 25 33 Q13 33 13 29 Z')
    + p('M2 6 H62 V10 H2 Z')
    + p('M29 10 H34 V17 H29 Z')
    + p('M53 3 H58 V20 H53 Z')
    + p('M18 33 H24 V36 H18 Z') + p('M36 32 H42 V36 H36 Z'),
};

/**
 * The machine as a cream shape with an ink keyline. Nothing else.
 *
 * `nonzero` winding, deliberately: the parts of a machine overlap — a cab sits
 * on a chassis, a wheel sits under a wing — and under `evenodd` every overlap
 * punches a hole through the silhouette. That is exactly what a silhouette
 * cannot have.
 */
export function vehicleMark(id: VehicleId): string {
  const shapes = SHAPES[id];
  return `<svg viewBox="0 0 64 40" aria-hidden="true">`
    + `<g fill-rule="nonzero">`
    + `<g fill="none" stroke="${INK}" stroke-width="5.4" stroke-linejoin="round"`
    + ` stroke-linecap="round">${shapes}</g>`
    + `<g fill="${hexCss(C.white)}">${shapes}</g>`
    + `</g></svg>`;
}
