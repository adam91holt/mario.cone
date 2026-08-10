// The HUD's shared vocabulary: the unit, the plate, the palette, and the two
// helpers every widget uses to talk to the DOM.
//
// Three decisions are made here and inherited by everything else in `ui/`.
//
//   *Everything is a plate.* Half of Cone Canyon is framed against a bright sky
//   and the other half against near-black tarmac, and no single ink colour is
//   readable on both. So nothing in this HUD is ever bare text on the game: every
//   readout sits on a dark sign with a light bevel, a black outer edge and a
//   hazard-yellow header strip. The plate is what makes the HUD legible over
//   anything the renderer can put behind it, and the header strip is what makes
//   eight separate readouts look like one instrument set.
//
//   *Everything is sized in `--u`.* One viewport-derived unit drives every
//   dimension in the HUD, so the whole thing scales as a piece from a 1600px
//   review capture down to a phone in landscape without a single element
//   overlapping another. `unitPx()` reproduces the same number in JS for the
//   canvas minimap, from the same constants, so the two can never drift.
//
//   *Nothing animates in CSS.* Not one transition or keyframe. The capture
//   harness renders frames by hand — `step()` advances the simulation with no
//   wall clock at all — so a CSS animation would be somewhere unpredictable in
//   its timeline in every screenshot ever taken of this game. Every motion in
//   this HUD is integrated from the `dt` handed to `update()`, which makes a
//   given frame of a given seed reproducible.

import { config } from '../core/config.ts';

// ── the unit ───────────────────────────────────────────────────────────────

/**
 * The HUD's scale unit, in CSS pixels.
 *
 * `min(vw, vh)` rather than `vmin` so a wide-but-short window (a phone on its
 * side) shrinks the HUD instead of letting the tall axis vote alone. The floor
 * keeps text legible on a small screen.
 *
 * **No ceiling.** There used to be one — 16px — and it was the single worst
 * decision in this module. A HUD that stops growing above an 820px-tall viewport
 * is a HUD that occupies 7% of a 720p frame and 2.7% of a 4K one: the same
 * instrument set, photographed on a bigger screen, quietly turning into
 * telemetry. Nintendo's place indicator is about an eighth of the frame's height
 * on every display it has ever run on, because the number is the *subject*, not
 * an annotation on it. This unit is now purely proportional, so every readout
 * holds its share of the frame at any resolution.
 */
export const U_MIN = 9;
export const U_VW = 0.0106;
export const U_VH = 0.0195;

export const U_CSS = `max(${U_MIN}px, min(${U_VW * 100}vw, ${U_VH * 100}vh))`;

/** The same number the CSS `max` above resolves to, without a layout read. */
export function unitPx(): number {
  const w = typeof window === 'undefined' ? 1600 : window.innerWidth;
  const h = typeof window === 'undefined' ? 900 : window.innerHeight;
  return Math.max(U_MIN, Math.min(w * U_VW, h * U_VH));
}

// ── palette ────────────────────────────────────────────────────────────────

export const C = {
  white: 0xFFF8F0,
  yellow: 0xFFC300,
  orange: 0xFF6B1A,
  gold: 0xFFD84D,
  green: 0x6FE04A,
  red: 0xFF4B3A,
  cyan: 0x5FC8F5,
  ink: 0x10131A,
  asphalt: 0x3A3D46,
} as const;

/**
 * Mini-turbo tier colours. Index 0 is "charging, no tier yet".
 *
 * **Derived, not written.** This used to be a literal `[0xFFC300, 0x4FC3F7,
 * 0x3CFF6B, 0xE040FB]` sitting a module away from `config.kart.drift.tiers`,
 * which `fx` reads for the sparks at the wheels — and the two disagreed. The
 * sim's table called tier two orange; this called it green. One mini-turbo, two
 * colours, and which one the player got depended on whether they were looking
 * at their wheels or at the ring round the item socket.
 *
 * The argument for green is recorded in `core/config.ts` beside the table it
 * now lives in; the point here is that it can only be made once. A tier's
 * colour is the sim's statement about a sim state, so the sim's tuning table
 * owns it and every surface that draws that state reads it from there.
 *
 * Index 0 is the exception and is genuinely this module's: it is not a tier at
 * all but the ring's *idle* colour, the hazard yellow it sits at while a drift
 * is charging and has reached nothing yet. `fx` puts a warm cream in the same
 * slot for the same reason — an uncharged spark is not a tier either.
 */
export const TIER_COLORS = [
  C.yellow,
  ...config.kart.drift.tiers.map((t) => t.color),
] as const;

/**
 * ...and hue is not enough on its own. Each tier also gets a heavier stroke and
 * a louder halo, so the charge escalates in three channels at once and survives
 * being glanced at rather than looked at. The old ring topped out at 0.40 halo
 * on a fixed stroke: the difference between "nearly there" and "purple" was a
 * colour swap and nothing else.
 */
/*
 * **Measured, and then pulled back in.** The first cut ran the halo out to 3.4×
 * the arc at 0.92 opacity, and photographed at tier 1 against the sky it was a
 * fat pale arch hanging off the socket — a weather effect, not a meter. Nothing
 * in it could be read: the arc's own hue was buried inside its own glow, the
 * outer edge had no line on it, and the fill level was guesswork.
 *
 * The arc is now the loud part and the halo is only the heat coming off it. The
 * escalation still happens in three channels — hue, weight, halo — but the
 * widest halo is a little over twice the stroke rather than three and a half
 * times it, which keeps the whole collar inside the dark bed that gives it an
 * edge.
 */
export const TIER_RING = [
  { stroke: 0.24, halo: 0.13, haloWidth: 1.70 },
  { stroke: 0.30, halo: 0.26, haloWidth: 1.85 },
  { stroke: 0.36, halo: 0.42, haloWidth: 2.05 },
  { stroke: 0.44, halo: 0.66, haloWidth: 2.30 },
] as const;

export const hexCss = (n: number): string =>
  `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;

export function rgba(n: number, a: number): string {
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Push a vehicle colour into the band that reads on the minimap.
 *
 * The cast contains a near-black locomotive and a near-white aeroplane, and
 * both of them vanish on a map drawn in greys: one against the road, one
 * against the plate. Clamping lightness — and putting a floor under saturation,
 * or the greys stay grey — keeps every blip a distinguishable colour while
 * leaving the hue, which is the part the player actually matches to a machine.
 */
export function blipColor(n: number, variant = 0): number {
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  // A field of eight drawn from seven machines always contains a duplicate.
  // Nudging the second one round the wheel keeps two blips that would otherwise
  // be the same dot tellable apart, without breaking the tie to the machine.
  const L = Math.max(0.48, Math.min(0.8, l + variant * 0.16));
  const S = Math.max(0.55, s);
  return hslToHex((h + variant * 0.045 + 1) % 1, S, L);
}

/**
 * Pull a whole field's blip colours apart, in place, without losing the tie to
 * the machine each one came from.
 *
 * `blipColor` can only see one racer, and the collisions that actually break a
 * minimap are between *different* machines: this cast contains a near-black
 * locomotive (teal, 187°), a blue helicopter (207°) and a near-white aeroplane
 * whose saturation floor lands it on periwinkle (218°). Three blues within 31°
 * of each other, which photographed as one colour three times — and the same
 * thing happens to the orange cone and the red car once the duplicate-variant
 * nudge has moved one of them.
 *
 * So the field is relaxed as a set. Hues repel on the circle, each one clamped
 * to a small displacement from where the machine put it, and any pair still
 * inside the threshold afterwards is separated in *lightness* instead — which
 * is the channel that survives a six-pixel marker better than hue does anyway.
 *
 * Pure, and deliberately signature-free of anything but colours, so the results
 * sheet in `race/` can adopt it without this module learning about racers.
 */
/** Minimum circular hue distance between two blips, as a fraction of the wheel. */
const HUE_MIN = 0.085;
/** How far a hue may be pushed from where its machine put it. */
const HUE_CLAMP = 0.055;

export function spreadBlipColors(base: readonly number[]): number[] {
  const n = base.length;
  const h = new Array<number>(n);
  const s = new Array<number>(n);
  const l = new Array<number>(n);
  const h0 = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const c = base[i]!;
    const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const li = (max + min) / 2;
    const d = max - min;
    let hi = 0, si = 0;
    if (d > 1e-6) {
      si = li > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) hi = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) hi = ((b - r) / d + 2) / 6;
      else hi = ((r - g) / d + 4) / 6;
    }
    h[i] = hi; h0[i] = hi; s[i] = si; l[i] = li;
  }

  const wrap = (v: number): number => v - Math.floor(v);
  const gap = (a: number, b: number): number => {
    let d = wrap(b - a);
    if (d > 0.5) d -= 1;
    return d;
  };

  for (let pass = 0; pass < 6; pass++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = gap(h[i]!, h[j]!);
        const ad = Math.abs(d);
        if (ad >= HUE_MIN) continue;
        // Exactly coincident hues need a direction, and it has to be the same
        // one every time this runs or two racers swap colours between races.
        const dir = ad < 1e-6 ? (i < j ? -1 : 1) : Math.sign(d);
        const push = (HUE_MIN - ad) * 0.5 * dir;
        h[i] = wrap(h[i]! - push);
        h[j] = wrap(h[j]! + push);
      }
    }
    for (let i = 0; i < n; i++) {
      const off = gap(h0[i]!, h[i]!);
      if (Math.abs(off) > HUE_CLAMP) h[i] = wrap(h0[i]! + Math.sign(off) * HUE_CLAMP);
    }
  }

  // Anything the wheel could not separate is separated in value instead: the
  // darker of the pair goes darker and the lighter goes lighter, which is the
  // difference a six-pixel marker actually carries.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(gap(h[i]!, h[j]!)) >= HUE_MIN * 0.82) continue;
      if (Math.abs(l[i]! - l[j]!) >= 0.2) continue;
      const lo = l[i]! <= l[j]! ? i : j;
      const hi = lo === i ? j : i;
      l[lo] = Math.max(0.4, l[lo]! - 0.11);
      l[hi] = Math.min(0.88, l[hi]! + 0.11);
    }
  }

  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = hslToHex(h[i]!, s[i]!, l[i]!);
  return out;
}

function hslToHex(h: number, s: number, l: number): number {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const r = Math.round(f(h + 1 / 3) * 255);
  const g = Math.round(f(h) * 255);
  const b = Math.round(f(h - 1 / 3) * 255);
  return (r << 16) | (g << 8) | b;
}

// ── the curtain ────────────────────────────────────────────────────────────
//
// **One curtain, drawn once, used twice.** There were two: a hazard board the
// front-end swung across the frame to start a race, and a pair of blades the
// race swung across to hand over to the results sheet. Same gesture, ninety
// seconds apart, built by two people who never met — 78% panels in edge-to-edge
// orange stripe against 62% blades in near-black, and the second one running at
// roughly half the first one's tempo.
//
// The paint is the race's: near-black blades with a single hazard strip down
// the leading edge. Edge-to-edge orange fills the frame with the loudest colour
// in the palette at the one moment the player is meant to be looking *forward*,
// and the launch card printed on the closed board needs a dark ground to be
// read against. The geometry is the front-end's, because the race's was
// quietly wrong: a blade skewed 7° over a frame-and-a-bit of height moves each
// corner sideways by about 4% of the frame, so a 62% blade hung at x=0 leaves a
// wedge of bare screen in one corner at the exact moment the curtain is
// supposed to be *shut*. Wider, and hung outside the frame on both edges, has
// no such moment.
//
// The two durations are shared. The hold is the only thing a caller decides,
// because that is the only thing the two uses genuinely disagree about: the
// front-end holds for as long as the launch card needs to be read, the race
// holds for exactly as long as it takes to tear down three layers.

/** Seconds the blades take to close, and to open again. */
export const CURTAIN_IN = 0.3;
export const CURTAIN_OUT = 0.42;
/** Blade width and how far outside the frame it hangs, both in % of the frame. */
const CURTAIN_W = 78;
const CURTAIN_OUTSET = 10;
const CURTAIN_SKEW = -7;
/** Per cent of its *own* width a blade travels to clear the frame. 108% of 78%
 *  is 84% of the frame, which clears a blade whose far edge sits at 68%. */
const CURTAIN_TRAVEL = 108;

/** The transform for one blade at coverage `cover` (0 open, 1 shut). */
export function curtainTransform(cover: number, side: -1 | 1): string {
  const off = (1 - cover) * CURTAIN_TRAVEL * side;
  return `translateX(${off.toFixed(2)}%) skewX(${CURTAIN_SKEW}deg)`;
}

/**
 * The blades, for one layer. `sel` is the selector of a blade element; the
 * caller supplies `.l` and `.r` variants of it.
 */
export function curtainCss(scope: string, sel: string): string {
  return `
${scope} ${sel} {
  position: absolute; top: -14%; bottom: -14%; width: ${CURTAIN_W}%;
  display: block; opacity: 1;
  background: linear-gradient(178deg, #12161F 0%, #080B11 60%, #04060A 100%);
  box-shadow: 0 0 calc(var(--u) * 2) rgba(0,0,0,.7);
}
${scope} ${sel}.l { left: -${CURTAIN_OUTSET}%;
  transform: translateX(-${CURTAIN_TRAVEL}%) skewX(${CURTAIN_SKEW}deg); }
${scope} ${sel}.r { right: -${CURTAIN_OUTSET}%;
  transform: translateX(${CURTAIN_TRAVEL}%) skewX(${CURTAIN_SKEW}deg); }
/* The one stripe on the whole board: a hazard strip down the edge that leads.
   A blade is a barrier being drawn across the road, and a barrier has tape on
   the end you are meant to stop at. */
${scope} ${sel}::after {
  content: ''; position: absolute; top: 0; bottom: 0; width: calc(var(--u) * .62);
  background: repeating-linear-gradient(115deg,
    #FF6B1A 0 calc(var(--u) * .7), #14171F calc(var(--u) * .7) calc(var(--u) * 1.4));
}
${scope} ${sel}.l::after { right: calc(var(--u) * -.62); }
${scope} ${sel}.r::after { left: calc(var(--u) * -.62); }
`;
}

// ── the cursor ─────────────────────────────────────────────────────────────
//
// **One selected-state.** The front-end drew the cursor as a gold outline ring
// around an otherwise unchanged cell; the race drew it as a gold-*filled* plate
// with a white label and a chevron pointing at itself. Two games' worth of
// "this one is selected", ninety seconds apart.
//
// The ring wins, and not on taste. Half the cells this cursor has to sit on are
// *pictures* — a machine silhouette, a card carrying a painting of a circuit —
// and a gold fill obliterates them; a ring goes round anything. What the fill
// had that the ring did not is a chevron aimed at the cell, and that comes
// along: the ring below carries one on its left edge, so both layers now say
// "here" with the same object.

/** The cursor ring, as a box-shadow. `w` scales it for a smaller cell. */
export function cursorRing(w = 1): string {
  return `0 0 0 calc(var(--u) * ${(0.22 * w).toFixed(3)}) ${hexCss(C.yellow)},`
    + ` 0 0 0 calc(var(--u) * ${(0.34 * w).toFixed(3)}) rgba(9,11,15,.95),`
    + ` 0 0 calc(var(--u) * ${(1.5 * w).toFixed(2)}) rgba(255,180,40,.62)`;
}

/**
 * The chevron that hangs off the cursor's leading edge.
 *
 * The declarations only, so a caller can hang it on a pseudo-element (the
 * front-end's roving ring) or on a real one (the race's option plate, whose
 * `::before` is already spent on the plate's hazard header strip).
 */
export const CURSOR_CHEVRON = `
  position: absolute; top: 50%; left: calc(var(--u) * -1.02);
  width: calc(var(--u) * .8); height: calc(var(--u) * 1.15);
  transform: translateY(-50%);
  background: ${hexCss(C.yellow)};
  clip-path: polygon(0 0, 100% 50%, 0 100%, 36% 50%);
  filter: drop-shadow(0 0 calc(var(--u) * .18) rgba(255,190,60,.9));
`;

/** The chevron on a `::before`, for a caller whose cursor is its own element. */
export function cursorChevronCss(scope: string, sel: string): string {
  return `${scope} ${sel}::before { content: '';${CURSOR_CHEVRON}}`;
}

// ── the prompt rail ────────────────────────────────────────────────────────
//
// The front-end printed a dark plate of boxed keycaps in title case; the race
// printed a bare 62%-opacity line of drawn words with no keycaps and no "Back"
// — on a screen where Esc does in fact work. One rail now, built here, so a
// legend cannot say different things about the same keyboard in two places.

/** The keycap + label pair a prompt rail is made of. */
export const hintKey = (key: string, label: string): string =>
  `<span class="k"><span class="key">${key}</span><span class="lbl">${label}</span></span>`;

/** The rail's own styling, for one layer. */
export function hintCss(scope: string): string {
  return `
${scope} .k { display: flex; align-items: center; gap: calc(var(--u) * .38); }
${scope} .key {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: calc(var(--u) * 1.5); height: calc(var(--u) * 1.3);
  padding: 0 calc(var(--u) * .34);
  border-radius: calc(var(--u) * .28);
  background: linear-gradient(180deg, #F3F0E8, #C9C6BE);
  color: #14171E; font-weight: 900; font-size: calc(var(--u) * .74);
  font-family: 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif;
  letter-spacing: .02em;
  box-shadow: 0 calc(var(--u) * .12) 0 #6E6B65,
              0 calc(var(--u) * .2) calc(var(--u) * .3) rgba(0,0,0,.55);
}
${scope} .lbl {
  text-transform: uppercase; font-weight: 800; font-size: calc(var(--u) * .68);
  font-family: 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif;
  letter-spacing: .16em; color: rgba(255,248,240,.82);
}
/* A keycap with nothing to say. Three keys that all do the same thing — the
   title screen's ENTER / SPACE / (A) — are three caps in a row and one label
   between them, or none at all where the headline above has already said it. */
${scope} .lbl:empty { display: none; }
${scope} .k:has(.lbl:empty) { gap: 0; }
`;
}

// ── the circuit, as a diagram ──────────────────────────────────────────────
//
// The same track was drawn as two different objects: a thick grey road with a
// white dashed centre line and a yellow dot on the start for the circuit cards,
// and a pale-grey outline with a chequered marker for the HUD minimap. A player
// reads the first to choose a circuit and the second for three laps. These are
// the numbers both of them now draw from.

export const MAP = {
  /** The casing under the road, so the ribbon has an edge against any plate. */
  ink: 'rgba(8,10,14,.94)',
  /** The road itself. Light enough to clear a dark plate and give the blips a
   *  ground to be rimmed against. */
  road: '#98A2B4',
  /** The crown down the middle. Solid, not dashed — at minimap scale a dash is
   *  noise, and one road cannot be dashed on one screen and solid on another. */
  crown: 'rgba(255,248,240,.34)',
  /** Casing width as a multiple of the road's, and crown width likewise. */
  inkScale: 1.42,
  crownScale: 0.16,
  /**
   * The gravel cut, for a course that declares one.
   *
   * A circuit with a shortcut on it and a map that draws one unbroken loop is a
   * map that cannot teach the circuit — the player finds the fastest line
   * through Digger's Elbow by accident or never. Worn gravel, taken from the
   * canyon floor the cut is actually scraped through, and dashed because a
   * branch that is drawn as solidly as the tarmac reads as a second road rather
   * than as the risk it is.
   */
  cut: '#D2A465',
  /** The direction-of-travel marks painted down the crown. */
  arrow: 'rgba(255,250,236,.72)',
} as const;

// ── DOM ────────────────────────────────────────────────────────────────────

/**
 * A write-caching wrapper around one element.
 *
 * The HUD touches a couple of dozen elements sixty times a second, and setting
 * `style.transform` to the string it already holds still invalidates layout.
 * Every write in `ui/` goes through one of these, so a readout that has not
 * changed costs a map lookup and nothing else.
 */
/** Anything with a `style`, an `id` and a class list — HTML or SVG. */
export type Styled = HTMLElement | SVGElement;

export interface Bound {
  readonly el: Styled;
  set(prop: 'opacity' | 'transform' | 'color' | 'background' | 'width' | 'height'
    | 'boxShadow' | 'backgroundColor' | 'filter' | 'strokeDasharray' | 'stroke'
    | 'strokeDashoffset' | 'strokeWidth'
    | 'display' | 'left' | 'top' | 'textShadow', value: string): void;
  text(value: string): void;
  cls(name: string, on: boolean): void;
}

export function bind(el: Styled): Bound {
  const last = new Map<string, string>();
  return {
    el,
    set(prop, value): void {
      if (last.get(prop) === value) return;
      last.set(prop, value);
      (el.style as unknown as Record<string, string>)[prop] = value;
    },
    text(value): void {
      if (last.get('#text') === value) return;
      last.set('#text', value);
      el.textContent = value;
    },
    cls(name, on): void {
      const k = `#.${name}`;
      const v = on ? '1' : '';
      if (last.get(k) === v) return;
      last.set(k, v);
      el.classList.toggle(name, on);
    },
  };
}

/** Build an element tree from markup and hand back the root. */
export function fromHtml<T extends HTMLElement = HTMLDivElement>(html: string): T {
  const host = document.createElement('div');
  host.innerHTML = html.trim();
  return host.firstElementChild as T;
}

/** `q(root, '.x')` — a non-null query, because every selector here is a literal. */
export function q<T extends Element = HTMLElement>(root: ParentNode, sel: string): T {
  const found = root.querySelector<T>(sel);
  if (!found) throw new Error(`[hud] missing element: ${sel}`);
  return found;
}

// The ordinal suffix lives in `ui/glyphs.ts` as `ordinalWord()`, which returns
// it in the caps the drawn face is cut in. There was a second copy here, in
// lowercase, that nothing had ever imported — written back when a place was
// text. Every place indicator in the game is geometry now (the HUD's, the
// finish banner's, the pause card's, the results sheet's, the director's
// ticker), and they all call the same function. Two spellings of "2nd" in a
// module named `theme` is how a game ends up with two.

// ── the plate ──────────────────────────────────────────────────────────────
//
// **One sign, drawn once, used four times.** This was the last thing in the
// product that four modules each owned a copy of. The HUD's plate, the
// front-end's plate, the race overlay's plate and the coach card were the same
// twenty lines typed out four times by four agents, and they had already come
// apart: the race's corner was 10% tighter and its drop shadow a different
// alpha, and the coach card had given up on the shared parts entirely — a 1px
// hairline where every other sign has a .12u black rim, no chevron texture at
// all, and a hazard strip built out of *dashes* where every other sign wears a
// solid gold bar. Photographed on one frame, the CONTROLS card and the PAUSED
// plate four hundred pixels away read as two products.
//
// The numbers that survived are the HUD's, because this file is where the sign
// is described and a copy downstream of the description is not a variant, it is
// a drift. `.55` for the radius (two of the three agreed), `.5` for the drop
// shadow (likewise), and every layer gets the rim, the strip and the texture
// whether or not its author remembered them.
//
// A caller supplies the scope and gets the whole sign. What stays with the
// caller is only what is genuinely its own: where the sign sits, how big it is,
// and what is printed on it.

/**
 * Corner radius of every plate in the game, in `--u`.
 *
 * Exported because two callers legitimately need to *match* it from outside —
 * the front-end's selection ring has to un-clip the same corner the face
 * clips — and a second literal is how the race's copy drifted to `.5` in the
 * first place.
 */
export const PLATE_R = 0.55;
export const PLATE_RADIUS = `calc(var(--u) * ${PLATE_R})`;

/**
 * The sign, for one layer. `sel` lets a caller mount it on something other than
 * `.plate` — the coach's card is a plate that happens to be called `.card`.
 *
 * The radii on the two pseudo-elements are stated rather than left to the
 * parent's `overflow: hidden`, so a plate that has to let a selection ring out
 * of its own box (`overflow: visible`) still clips its own header strip.
 */
export function plateCss(scope: string, sel = '.plate'): string {
  return `
/* The sign. A dark face with a lit top edge and a hard black rim, so it holds
   its shape against a white cloud and against wet tarmac without changing. */
${scope} ${sel} {
  position: relative;
  border-radius: ${PLATE_RADIUS};
  background: linear-gradient(178deg, rgba(60,67,84,.94) 0%, rgba(30,35,45,.95) 46%, rgba(17,20,27,.95) 100%);
  box-shadow:
    inset 0 calc(var(--u) * .1) 0 rgba(255,255,255,.28),
    inset 0 calc(var(--u) * -.14) 0 rgba(0,0,0,.5),
    0 0 0 calc(var(--u) * .12) rgba(9,11,15,.92),
    0 calc(var(--u) * .22) calc(var(--u) * .62) rgba(0,0,0,.5);
  overflow: hidden;
}
/* The header strip: the one motif every plate shares. Hazard yellow, four
   pixels of it, along the top edge — it is what makes six separate readouts
   read as one signposted set rather than six floating boxes. */
${scope} ${sel}::before {
  content: ''; position: absolute; left: 0; right: 0; top: 0;
  height: calc(var(--u) * .17);
  border-radius: ${PLATE_RADIUS} ${PLATE_RADIUS} 0 0;
  background: linear-gradient(90deg, #FFC300, #FF9A1A 60%, #FFC300);
  opacity: .95;
}
/* ...and a whisper of chevron texture across the face, at the threshold of
   visible. Flat panels read as UI; a surface reads as a sign bolted to a post. */
${scope} ${sel}::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  border-radius: ${PLATE_RADIUS};
  background: repeating-linear-gradient(122deg,
    rgba(255,255,255,.045) 0 calc(var(--u) * .38),
    rgba(255,255,255,0) calc(var(--u) * .38) calc(var(--u) * .78));
}
${scope} ${sel} > * { position: relative; z-index: 1; }
`;
}

/**
 * The base stylesheet: the layer, the corners, and the sign every readout is
 * printed on. Widget-specific rules live with their widgets.
 */
export const CSS_BASE = `
#hud {
  position: fixed; inset: 0; z-index: 20; pointer-events: none;
  -webkit-user-select: none; user-select: none;
  font-family: 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif;
  color: #FFF8F0;
  -webkit-font-smoothing: antialiased;
  contain: layout style paint;

  --u: ${U_CSS};
  --ex: calc(var(--u) * 1.3 + env(safe-area-inset-left, 0px));
  --ey: calc(var(--u) * 1.05 + env(safe-area-inset-top, 0px));
  --eb: calc(var(--u) * 1.05 + env(safe-area-inset-bottom, 0px));
  --er: calc(var(--u) * 1.3 + env(safe-area-inset-right, 0px));

  --yellow: #FFC300;
  --orange: #FF6B1A;
  --white: #FFF8F0;
  --gold: #FFD84D;
}

/* Everything hangs off this one node so a hit can jolt the entire instrument
   set at once — a HUD that stays perfectly still while the kart is spun round
   is a HUD that is not part of the game.

   Deliberately no will-change on this node. Promoting it would hold a viewport
   sized composited layer for the whole race to buy a smoother third of a second
   after each hit — and this game is reviewed through a software rasteriser,
   where a permanent full-frame layer is charged to the same budget the road is
   drawn from. */
#hud .layer { position: absolute; inset: 0; }

#hud .corner { position: absolute; display: flex; }
#hud .tl { top: var(--ey); left: var(--ex); flex-direction: column; align-items: flex-start;
           gap: calc(var(--u) * .42); }
#hud .tr { top: var(--ey); right: var(--er); flex-direction: column; align-items: flex-end;
           gap: calc(var(--u) * .42); }
#hud .bl { bottom: var(--eb); left: var(--ex); flex-direction: column; align-items: flex-start;
           gap: calc(var(--u) * .42); }
#hud .br { bottom: var(--eb); right: var(--er); flex-direction: column; align-items: flex-end; }
#hud .tc { top: var(--ey); left: 50%; transform: translateX(-50%); }

${plateCss('#hud')}

/* The .label rule that used to live here is gone with the last text node in
   the module. Nothing in this HUD is set in a font any more: every number and
   every word on screen is drawn geometry from glyphs.ts. The font-family
   declaration at the top of this stylesheet is left as a floor under anything a
   future widget might put here in text — it is not, any longer, what any part
   of the instrument set is *made of*. */
/* **No numeral in this HUD is text any more.** Every digit, ordinal suffix and
   banner word is drawn geometry from glyphs.ts — see the note at the top of
   that file. What used to be here was a font-weight, a letter-spacing and seven
   stacked text-shadows faking an outline around whatever grotesque the player's
   operating system happened to supply, which meant the most-looked-at elements
   on the screen changed shape from machine to machine.

   The .num class is now only a *box*: a caller gives it a height in --u and the
   run inside fills it. Nothing states a font-size for a number any more. */
#hud .num { display: block; }

/* A number that changes has to be *seen* changing. The outgoing value lifts
   away and the incoming one drops in over it — no clipping mask, so the keyline
   and the extruded under-edge every numeral carries survive the swap. */
#hud .roll { position: relative; display: block; height: 100%; }
#hud .roll > span { display: block; height: 100%; }
#hud .roll .r-prev {
  position: absolute; left: 0; top: 0;
  pointer-events: none;
}
`;
