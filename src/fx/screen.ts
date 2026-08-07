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
/* farthest-corner puts the 100% stop exactly at the corner of the frame, so
   the percentages below mean what they say: nothing at all inside the middle
   half, and the colour confined to the outer third. Sizing the ellipse by hand
   instead landed the last stop a third of the way out and washed the entire
   sky. */
#fx-screen .rush {
  position: absolute; inset: -6%;
  opacity: 0; mix-blend-mode: screen;
  transform-origin: 50% 52%;
  will-change: opacity, transform;
  background:
    radial-gradient(ellipse farthest-corner at 50% 52%,
      rgba(255,190,90,0) 46%,
      rgba(255,170,70,0.20) 76%,
      rgba(255,120,30,0.58) 100%);
}
/* The charge ring. Its colour follows the mini-turbo tier, so the frame itself
   is part of the meter — the sparks say it loudest, this says it in peripheral
   vision, where a player who is busy driving actually reads it. */
#fx-screen .rush.charge {
  background:
    radial-gradient(ellipse farthest-corner at 50% 52%,
      rgba(255,242,216,0) 62%,
      rgba(255,242,216,0.08) 84%,
      rgba(255,242,216,0.22) 100%);
}
#fx-screen .rush.charge.t1 {
  background:
    radial-gradient(ellipse farthest-corner at 50% 52%,
      rgba(120,205,255,0) 60%,
      rgba(110,195,255,0.12) 82%,
      rgba(79,195,247,0.34) 100%);
}
#fx-screen .rush.charge.t2 {
  background:
    radial-gradient(ellipse farthest-corner at 50% 52%,
      rgba(255,180,80,0) 60%,
      rgba(255,168,60,0.13) 82%,
      rgba(255,152,0,0.36) 100%);
}
#fx-screen .rush.charge.t3 {
  background:
    radial-gradient(ellipse farthest-corner at 50% 52%,
      rgba(224,110,251,0) 60%,
      rgba(224,90,251,0.14) 82%,
      rgba(224,64,251,0.40) 100%);
}
`;

export interface ScreenFx {
  /** A one-shot pop. `amount` is 0..1; a stronger flash overrides a weaker one. */
  flash(color: number, amount: number): void;
  /** Warm edge rush, 0..1. Set every frame; it eases on its own. */
  setRush(amount: number): void;
  /** Mini-turbo charge ring, 0..1. Set every frame. */
  setCharge(amount: number): void;
  /** Which tier that ring is showing: 0 uncharged, 1..3 blue/orange/purple. */
  setChargeTier(tier: number): void;
  update(dt: number): void;
  reset(): void;
  dispose(): void;
}

function hexToCss(hex: number): string {
  return `#${(hex & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function createScreenFx(): ScreenFx {
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

  // Last values actually written to the DOM.
  let wroteFlash = -1;
  let wroteFlashHex = -1;
  let wroteRush = -1;
  let wroteRushScale = -1;
  let wroteCharge = -1;
  let wroteTier = -1;

  if (typeof document !== 'undefined') {
    style = document.createElement('style');
    style.textContent = CSS;
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
      const rk = 1 - Math.exp(-(rushTarget > rush ? 26 : 6) * step);
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
        // kart instead of simply getting brighter at the corners.
        const s = Math.round((1.12 - a * 0.16) * 100) / 100;
        if (s !== wroteRushScale) {
          rushEl.style.transform = `scale(${s})`;
          wroteRushScale = s;
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

    reset(): void {
      flashAmt = 0;
      rush = rushTarget = 0;
      charge = chargeTarget = 0;
      chargeTier = 0;
      wroteFlash = wroteRush = wroteRushScale = wroteCharge = -1;
      wroteFlashHex = -1;
      wroteTier = -1;
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
