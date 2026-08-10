// Screen effects that belong on the glass rather than in the world.
//
// A DOM layer, for the same reasons the HUD is one: it costs no draw calls, it
// survives the post stack being switched off, and a full-screen gradient is one
// composited rectangle rather than a fragment shader run over two million
// pixels. It sits *under* the HUD, so a boost never washes out the lap counter.
//
// Two things live here. The flash is the punctuation — a boost firing, a tier
// locking in, a shell landing, the lights going out. The rush is the sustain: a
// warm ring closing in from the edges of the frame for as long as a boost is
// live, which is what tells a player at a glance that they are still on it.
//
// Every style write is guarded against writing the same value twice. Touching
// `style.opacity` sixty times a second with a string that has not changed is a
// layout invalidation for nothing.

const CSS = `
#fx-screen {
  position: fixed; inset: 0; pointer-events: none; z-index: 9;
  overflow: hidden; contain: strict;
}
#fx-screen .flash {
  position: absolute; inset: -2%;
  opacity: 0; mix-blend-mode: screen;
  will-change: opacity;
}
/* The rush has to be a *frame*, and it has to stay out of the driving line.

   The previous version used farthest-corner, which sizes the ellipse so its
   100% stop lands on the corner of the picture — and with nothing before 78%
   that confined the whole effect to the four corners. Four corners is precisely
   where the HUD lives: lap counter, minimap, coins, position. Measured on a
   live mini-turbo boost with the rush element sitting at 0.79 opacity, almost
   none of it reached a pixel the player could see, because the panels were
   drawn over all four of the places it had been carefully confined to. The
   loudest sustained signal in the game was being emitted into the furniture.

   farthest-side puts the 100% stop on the middles of the four edges instead, so
   the hot band runs the whole way round the rim — including the top and bottom
   centre, which no HUD element occupies — and the corners simply saturate. The
   opening stop is what keeps it out of the driving line, and 66% of the
   half-height is a long way outside the road ahead: at 900px tall that is the
   outer 150px of the frame, and the horizon sits near the middle. The centre
   two thirds stay completely clean, which was always the point. */
#fx-screen .rush {
  position: absolute; inset: 0;
  opacity: 0; mix-blend-mode: screen;
  transform-origin: 50% 50%;
  will-change: opacity, transform;
  background:
    radial-gradient(ellipse farthest-side at 50% 50%,
      rgba(255,190,90,0) 69%,
      rgba(255,182,86,0.09) 84%,
      rgba(255,158,60,0.30) 94%,
      rgba(255,126,34,0.64) 100%);
}
/* The charge ring. Its colour follows the mini-turbo tier, so the frame itself
   is part of the meter — the sparks say it loudest, this says it in peripheral
   vision, where a player who is busy driving actually reads it.

   The per-tier rules are *generated* from the tuning table — see "chargeCss"
   below. Quoted that way, not in backticks, because this is inside a CSS
   template literal and a backtick in here closes it (ARCHITECTURE section 2).
   They used to be written out here by hand, and this file was the third copy of
   a list that config.ts had already been through one round of this exact bug
   with: the table says tier two is green, ui/theme.ts was fixed to derive from
   the table, and these three rules were missed. Measured on a frozen tier-two
   drift, the sparks at the wheels were green and the frame border was orange —
   the player's foveal cue and their peripheral cue naming different tiers for
   the same charge. There is now one list. */
#fx-screen .rush.charge {
  background:
    radial-gradient(ellipse farthest-side at 50% 50%,
      rgba(255,242,216,0) 84%,
      rgba(255,242,216,0.03) 93%,
      rgba(255,242,216,0.08) 100%);
}
`;

/**
 * One tier's charge-ring rule, built from that tier's own colour.
 *
 * The peak alpha climbs with the tier so the border gets heavier as the charge
 * gets more valuable, and the inner stops are lightened toward white — a
 * saturated hue at 10% over a bright sky is invisible, and the point of the
 * ring is that it is readable without being looked at.
 *
 * ── why it is half of what it was, and starts twice as far out ──────────────
 *
 * Because it was repainting the world. Measured on a frozen drift, the top-left
 * corner of the *sky* went cyan at tier one, green at tier two and violet at
 * tier three, and the tarmac went with it. The sky is a named palette anchor
 * (ARCHITECTURE section 12) and a gameplay state was hue-rotating it for the
 * whole of every corner — which is not a peripheral cue, it is a colour grade.
 *
 * Two numbers fix it and both matter. The peak comes down by half, so the rim
 * tints rather than washes; and the first stop moves from 68% of the
 * half-height out to 84%, which at 900px tall confines the whole gradient to
 * the outer 70px of the frame instead of the outer 145. What is left is a
 * coloured edge a player reads without looking at it, over a picture whose own
 * colours are still its own.
 */
function chargeCss(tier: number, hex: number): string {
  const r = (hex >> 16) & 0xff, g = (hex >> 8) & 0xff, b = hex & 0xff;
  const lift = (k: number): string =>
    `${Math.round(r + (255 - r) * k)},${Math.round(g + (255 - g) * k)},${Math.round(b + (255 - b) * k)}`;
  const peak = 0.14 + 0.025 * tier;
  return `
#fx-screen .rush.charge.t${tier} {
  background:
    radial-gradient(ellipse farthest-side at 50% 50%,
      rgba(${lift(0.35)},0) 83%,
      rgba(${lift(0.22)},${(peak * 0.34).toFixed(3)}) 93%,
      rgba(${lift(0)},${peak.toFixed(3)}) 100%);
}`;
}

/**
 * One tier's *rush* rule — the sustained edge glow while a boost is live.
 *
 * This is the correction to the loudest colour bug the module had. The tier a
 * player spends three seconds earning was being paid off in a screen flash of
 * 0.10 lasting a single frame, while the rush — 0.90 for the entire boost, the
 * thing that is actually on the glass while they are looking at it — ran a
 * generic warm orange gradient whatever fired it. A violet ultra and a blue
 * tier one therefore paid off identically, and the one channel with enough
 * screen time to carry the difference was spending it on a constant.
 *
 * So the rush takes the tier. The hot outer stop is the tier's own hue at full
 * saturation; the inner stops are lifted toward white so the band reads as
 * *light* rather than as a coloured filter, and the innermost is warmed a
 * little toward flame in every tier — a boost is fire whatever charged it, and
 * a rim of pure cyan with no warmth in it reads as a freeze, not as thrust.
 */
function rushCss(tier: number, hex: number): string {
  const r = (hex >> 16) & 0xff, g = (hex >> 8) & 0xff, b = hex & 0xff;
  // Toward white by k, then a touch toward flame so no tier reads as cold.
  const mix = (k: number, warm: number): string => {
    const wr = r + (255 - r) * k, wg = g + (255 - g) * k, wb = b + (255 - b) * k;
    return `${Math.round(wr + (255 - wr) * warm)},`
      + `${Math.round(wg + (170 - wg) * warm)},`
      + `${Math.round(wb + (60 - wb) * warm)}`;
  };
  return `
#fx-screen .rush.boost.b${tier} {
  background:
    radial-gradient(ellipse farthest-side at 50% 50%,
      rgba(${mix(0.45, 0.35)},0) 69%,
      rgba(${mix(0.34, 0.30)},0.09) 84%,
      rgba(${mix(0.16, 0.22)},0.30) 94%,
      rgba(${mix(0.00, 0.14)},0.64) 100%);
}`;
}

export interface ScreenFx {
  /** A one-shot pop. `amount` is 0..1; a stronger flash overrides a weaker one. */
  flash(color: number, amount: number): void;
  /** Warm edge rush, 0..1. Set every frame; it eases on its own. */
  setRush(amount: number): void;
  /** Which mini-turbo tier the live boost came out of, 0 for anything else.
   *  The rush is the only cue with enough screen time to carry it. */
  setRushTier(tier: number): void;
  /** Mini-turbo charge ring, 0..1. Set every frame. */
  setCharge(amount: number): void;
  /** Which tier that ring is showing: 0 uncharged, then whatever
   *  `config.kart.drift.tiers[]` says each tier's colour is. */
  setChargeTier(tier: number): void;
  update(dt: number): void;
  /** What is actually on the glass. Debug only — see the probe in `index.ts`. */
  debug(): Record<string, number | string | boolean>;
  reset(): void;
  dispose(): void;
}

function hexToCss(hex: number): string {
  return `#${(hex & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * @param tierHex the game's mini-turbo colours, index 0 being the uncharged
 *   state. Passed in rather than written here — see the note above `chargeCss`.
 */
export function createScreenFx(tierHex: readonly number[]): ScreenFx {
  let root: HTMLDivElement | null = null;
  let flashEl: HTMLDivElement | null = null;
  let rushEl: HTMLDivElement | null = null;
  let chargeEl: HTMLDivElement | null = null;
  let style: HTMLStyleElement | null = null;

  let flashAmt = 0;
  let flashHex = 0xffffff;
  let rush = 0;
  let rushTarget = 0;
  let charge = 0;
  let chargeTarget = 0;
  let chargeTier = 0;
  let rushTier = 0;

  // Last values actually written to the DOM.
  let wroteFlash = -1;
  let wroteFlashHex = -1;
  let wroteRush = -1;
  let wroteRushScale = -1;
  let wroteCharge = -1;
  let wroteTier = -1;
  let wroteRushTier = -1;

  if (typeof document !== 'undefined') {
    style = document.createElement('style');
    style.textContent = CSS
      + chargeCss(1, tierHex[1] ?? 0x4FC3F7)
      + chargeCss(2, tierHex[2] ?? 0x3CFF6B)
      + chargeCss(3, tierHex[3] ?? 0xE040FB)
      + rushCss(1, tierHex[1] ?? 0x4FC3F7)
      + rushCss(2, tierHex[2] ?? 0x3CFF6B)
      + rushCss(3, tierHex[3] ?? 0xE040FB);
    document.head.appendChild(style);

    root = document.createElement('div');
    root.id = 'fx-screen';
    root.innerHTML =
      '<div class="rush boost"></div><div class="rush charge"></div><div class="flash"></div>';
    document.body.appendChild(root);
    rushEl = root.querySelector('.rush.boost');
    chargeEl = root.querySelector('.rush.charge');
    flashEl = root.querySelector('.flash');
  }

  return {
    flash(color: number, amount: number): void {
      if (amount <= flashAmt) return;
      flashAmt = amount > 1 ? 1 : amount;
      flashHex = color;
    },

    setRush(amount: number): void {
      rushTarget = amount > 1 ? 1 : amount < 0 ? 0 : amount;
    },

    setRushTier(tier: number): void {
      rushTier = tier < 0 ? 0 : tier > 3 ? 3 : tier | 0;
    },

    setCharge(amount: number): void {
      chargeTarget = amount > 1 ? 1 : amount < 0 ? 0 : amount;
    },

    setChargeTier(tier: number): void {
      chargeTier = tier < 0 ? 0 : tier > 3 ? 3 : tier | 0;
    },

    update(dt: number): void {
      const step = dt > 0.1 ? 0.1 : dt;

      // A flash is a transient: it lands on the frame it is asked for and is
      // gone in about a fifth of a second. Anything slower reads as a fade, and
      // a fade is not an impact.
      flashAmt *= Math.exp(-9 * step);
      if (flashAmt < 0.002) flashAmt = 0;

      // Fast attack, slower release. The rush has to be up before the player
      // notices the speed, and has to let go slowly enough that the end of a
      // boost is felt rather than cut.
      // Release deliberately slow. The rush is the one cue that says "still on
      // it", and a fast release means a frame photographed a tenth of a second
      // after a boost shows nothing at all — which is how the same boosting
      // state came to read four different ways across one review sheet.
      const rk = 1 - Math.exp(-(rushTarget > rush ? 26 : 3.4) * step);
      rush += (rushTarget - rush) * rk;
      const ck = 1 - Math.exp(-(chargeTarget > charge ? 12 : 8) * step);
      charge += (chargeTarget - charge) * ck;

      if (flashEl) {
        const a = Math.round(flashAmt * 100) / 100;
        if (a !== wroteFlash) {
          flashEl.style.opacity = a === 0 ? '0' : String(a);
          wroteFlash = a;
        }
        if (a > 0 && flashHex !== wroteFlashHex) {
          flashEl.style.backgroundColor = hexToCss(flashHex);
          wroteFlashHex = flashHex;
        }
      }

      if (rushEl) {
        const a = Math.round(rush * 100) / 100;
        if (a !== wroteRush) {
          rushEl.style.opacity = a === 0 ? '0' : String(a);
          wroteRush = a;
        }
        // The ring closes in as it comes up, so the frame narrows around the
        // kart instead of simply getting brighter at the corners. At rest the
        // element is a tenth larger than the frame, which carries the gradient's
        // hot last stop clean off the glass; at full rush it lands exactly on
        // the corners. That is the whole travel of the effect.
        const s = Math.round((1.16 - a * 0.16) * 100) / 100;
        if (s !== wroteRushScale) {
          rushEl.style.transform = `scale(${s})`;
          wroteRushScale = s;
        }
        // The tier only changes on the frame a boost fires, so this is a
        // class swap a handful of times a race rather than a per-frame write.
        if (rushTier !== wroteRushTier) {
          rushEl.className = rushTier > 0 ? `rush boost b${rushTier}` : 'rush boost';
          wroteRushTier = rushTier;
        }
      }

      if (chargeEl) {
        const a = Math.round(charge * 100) / 100;
        if (a !== wroteCharge) {
          chargeEl.style.opacity = a === 0 ? '0' : String(a);
          wroteCharge = a;
        }
        if (chargeTier !== wroteTier) {
          chargeEl.className = chargeTier > 0 ? `rush charge t${chargeTier}` : 'rush charge';
          wroteTier = chargeTier;
        }
      }
    },

    debug(): Record<string, number | string | boolean> {
      return {
        mounted: !!root && root.isConnected,
        flash: Math.round(flashAmt * 1000) / 1000,
        flashHex: `#${(flashHex & 0xffffff).toString(16).padStart(6, '0')}`,
        rush: Math.round(rush * 1000) / 1000,
        rushTarget: Math.round(rushTarget * 1000) / 1000,
        rushTier,
        charge: Math.round(charge * 1000) / 1000,
        tier: chargeTier,
        opacity: rushEl?.style.opacity ?? '',
      };
    },

    reset(): void {
      flashAmt = 0;
      rush = rushTarget = 0;
      charge = chargeTarget = 0;
      chargeTier = 0;
      rushTier = 0;
      wroteFlash = wroteRush = wroteRushScale = wroteCharge = -1;
      wroteFlashHex = -1;
      wroteTier = -1;
      wroteRushTier = -1;
    },

    dispose(): void {
      root?.remove();
      style?.remove();
      root = null;
      style = null;
      flashEl = rushEl = chargeEl = null;
    },
  };
}
