// The item slot, the roulette, and the two screen effects items cause.
//
// A DOM overlay, for the same reasons the HUD is one: crisp at any resolution
// and free of draw calls. It lives in this module rather than in `ui` because
// the reel is not a readout — it is the item system's own animation, timed to
// the same clock as the draw, and splitting the two across a module boundary
// would mean the picture and the state could disagree.
//
// If the UI module ever grows its own slot it only has to mark it
// `data-item-slot` and this one stands down, leaving the screen effects behind.

import { ITEMS } from './defs.ts';
import type { ItemEntry } from './defs.ts';
import type { ItemId } from '../types.ts';

/** Every icon the slot may ever have to show. One per item, not one per
 *  (item, count) — see `key` below for why that distinction matters. */
const ICON_IDS = Object.keys(ITEMS) as ItemId[];

const CSS = `
#item-hud {
  position: fixed; top: 1.3rem; left: 50%; transform: translateX(-50%);
  z-index: 11; pointer-events: none; user-select: none;
  font-family: 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif;
}
/* The slot is a roadworks sign: dark plate, hazard-yellow edge, chevrons only
   as a hairline so the icon inside is the loudest thing in it. */
#item-hud .slot {
  position: relative; width: 6.2rem; height: 6.2rem;
  border-radius: 1.15rem;
  background:
    linear-gradient(165deg, rgba(90,100,120,.55), rgba(20,24,34,.72)),
    repeating-linear-gradient(135deg,
      rgba(255,107,26,.16) 0 9px, rgba(0,0,0,0) 9px 18px);
  box-shadow:
    inset 0 0 0 3px rgba(255,195,0,.9),
    inset 0 0 0 5px rgba(28,32,42,.7),
    inset 0 -10px 18px rgba(0,0,0,.4),
    0 6px 18px rgba(0,0,0,.4);
  display: grid; place-items: center;
}
/* An empty slot is *waiting*, not disabled. Fading it out reads as a greyed
   control; keeping it lit with a bright hazard "?" reads as a socket with
   nothing in it yet, which is what it is. */
#item-hud .slot.empty { box-shadow:
    inset 0 0 0 3px rgba(255,195,0,.55),
    inset 0 0 0 5px rgba(28,32,42,.6),
    inset 0 -10px 18px rgba(0,0,0,.4),
    0 6px 18px rgba(0,0,0,.35);
}
#item-hud .mark {
  position: absolute; font-size: 3.4rem; font-weight: 900; line-height: 1;
  color: #FFC300;
  text-shadow:
    0 0 0 #000, 2px 2px 0 rgba(20,24,34,.9), -2px 2px 0 rgba(20,24,34,.9),
    2px -2px 0 rgba(20,24,34,.9), -2px -2px 0 rgba(20,24,34,.9),
    0 4px 0 rgba(0,0,0,.45);
  opacity: 0;
}
#item-hud .slot.empty .mark { opacity: .92; }
#item-hud .icons { position: relative; width: 4.3rem; height: 4.3rem; }
#item-hud .icons svg {
  position: absolute; inset: 0; width: 100%; height: 100%;
  display: none;
  filter: drop-shadow(0 3px 0 rgba(0,0,0,.35));
}
#item-hud .icons svg.on { display: block; }
#item-hud .count {
  position: absolute; right: -.35rem; bottom: -.35rem;
  font-size: 1.15rem; font-weight: 900; color: #FFF8F0;
  text-shadow: 0 2px 0 rgba(0,0,0,.6);
  opacity: 0;
}
#item-hud .glow {
  position: absolute; inset: -18%; border-radius: 1.6rem;
  background: radial-gradient(circle, rgba(255,235,180,.9), rgba(255,235,180,0) 62%);
  opacity: 0; mix-blend-mode: screen;
}

/* Blooper ink. It has to *hurt to see through* without being a black screen:
   the splats crowd the edges, leave a gap where the road vanishes, and carry
   a soft falloff so there is always something readable between them.

   "closest-side" is doing the load-bearing work. A radial-gradient defaults to
   "farthest-corner", so on a square element its 100% stop sits out at the
   corner and the alpha where the circle actually ends is still around 0.4 —
   which is why the first version of this photographed as a screenful of hard
   grey discs rather than as ink. Pinning 100% to the edge of the circle is what
   turns a disc into a splat. */
#item-ink {
  position: fixed; inset: 0; z-index: 12; pointer-events: none;
  opacity: 0;
}
/* The pale ring at 88% is not decoration. Ink is near-black, the road is
   near-black, and a splat that lands on tarmac with no rim is a splat the
   player never sees — so the item reads as "the sky got dirty" and costs them
   nothing. A thin lifted edge gives every splat a silhouette on both. */
#item-ink i {
  position: absolute; display: block;
  background: radial-gradient(circle closest-side at 44% 40%,
    rgba(9,11,26,1) 0 34%, rgba(14,17,38,.96) 55%,
    rgba(24,30,62,.66) 76%, rgba(96,112,168,.42) 88%, rgba(20,26,52,0) 100%);
}
/* A few flecks thrown clear of the main splats. Ink that is all circles reads
   as a lens problem; ink that has spatter reads as something hitting you. */
#item-ink i.fleck {
  background: radial-gradient(circle closest-side at 50% 50%,
    rgba(9,11,26,.98) 0 46%, rgba(16,20,44,.5) 78%, rgba(16,20,44,0) 100%);
}
#item-flash {
  position: fixed; inset: 0; z-index: 13; pointer-events: none;
  opacity: 0; mix-blend-mode: screen;
}

/* Incoming. A red vignette that closes in from the edges as the thing chasing
   you gets nearer — read in peripheral vision, which is the only place it can
   be read, because the player is looking at the corner. */
#item-warn {
  position: fixed; inset: 0; z-index: 10; pointer-events: none; opacity: 0;
  background: radial-gradient(ellipse 78% 68% at 50% 50%,
    rgba(255,40,20,0) 40%, rgba(255,45,20,.30) 74%, rgba(190,15,5,.72) 100%);
}
/* Below the item slot, not behind it. The slot is the one thing on screen the
   player checks under pressure, and this is the moment they are under it.

   On its own plate, because half the circuit is framed against a bright sky and
   glowing text on a cloud is a smudge: the word has to be legible at the moment
   it first fades up, not only once it is at full strength. */
#item-warn b {
  position: absolute; left: 50%; top: 8.9rem; transform: translateX(-50%);
  display: block; padding: .34rem .8rem .3rem; border-radius: .42rem;
  font: 900 1.05rem/1 'Trebuchet MS', system-ui, sans-serif;
  letter-spacing: .22em; color: #FFF1E4; white-space: nowrap;
  background: linear-gradient(180deg, rgba(150,18,6,.92), rgba(74,8,2,.92));
  box-shadow: inset 0 0 0 2px rgba(255,120,80,.9), 0 3px 10px rgba(0,0,0,.5);
  text-shadow: 0 0 9px rgba(255,90,50,.9), 0 2px 0 rgba(0,0,0,.7);
}
`;

/** Bold, flat, 64px-legible. Silhouette first — these are read at a glance. */
function iconSvg(id: ItemId): string {
  const body = (): string => {
    switch (id) {
      case 'banana':
        return `<path d="M12 44C12 22 30 8 54 12c-7 6-10 11-13 19-6 17-19 24-29 13z"
          fill="#FFD429" stroke="#7A5310" stroke-width="3.5" stroke-linejoin="round"/>
          <path d="M50 12l6-5" stroke="#4B3407" stroke-width="5" stroke-linecap="round"/>`;
      case 'greenShell':
      case 'redShell': {
        const c = id === 'greenShell' ? '#46D63C' : '#F03A2E';
        const s = id === 'greenShell' ? '#207E1D' : '#8E1C14';
        return `<path d="M8 38a24 24 0 0 1 48 0z" fill="${c}" stroke="#2A2E38" stroke-width="3.5"/>
          <circle cx="32" cy="24" r="5.5" fill="${s}"/>
          <circle cx="17" cy="33" r="4" fill="${s}"/><circle cx="47" cy="33" r="4" fill="${s}"/>
          <rect x="5" y="36" width="54" height="14" rx="7" fill="#FFF8F0" stroke="#2A2E38" stroke-width="3.5"/>`;
      }
      case 'mushroom':
      case 'tripleMushroom':
        return `<path d="M22 38h20v9a10 8 0 0 1-20 0z" fill="#FFF3E2" stroke="#2A2E38" stroke-width="3.5" stroke-linejoin="round"/>
          <path d="M7 38a25 23 0 0 1 50 0z" fill="#FF5B4A" stroke="#2A2E38" stroke-width="3.5" stroke-linejoin="round"/>
          <circle cx="23" cy="26" r="6" fill="#FFF3E2"/><circle cx="42" cy="24" r="4.5" fill="#FFF3E2"/>`;
      case 'star':
        return `<path d="M32 5l8 18 20 2-15 13 5 20-18-11-18 11 5-20L4 25l20-2z"
          fill="#FFD84D" stroke="#8A6410" stroke-width="3.5" stroke-linejoin="round"/>`;
      case 'bulletBill':
        return `<path d="M6 20l-4 12 4 12z" fill="#2E3340"/>
          <rect x="8" y="20" width="34" height="24" rx="4" fill="#4A5162" stroke="#20242E" stroke-width="3.5"/>
          <path d="M42 20a14 12 0 0 1 0 24z" fill="#5A6478" stroke="#20242E" stroke-width="3.5" stroke-linejoin="round"/>
          <circle cx="36" cy="28" r="4" fill="#FFF8F0"/>`;
      case 'lightning':
        return `<path d="M38 3L13 36h14l-4 25 26-33H35z"
          fill="#FFE24A" stroke="#8A6410" stroke-width="3.5" stroke-linejoin="round"/>`;
      case 'blooper':
        return `<path d="M17 40v14M25 42v16M39 42v16M47 40v14"
          stroke="#F2F6FF" stroke-width="7" stroke-linecap="round"/>
          <path d="M32 6c13 0 20 11 20 22 0 8-4 13-7 15H19c-3-2-7-7-7-15C12 17 19 6 32 6z"
          fill="#F2F6FF" stroke="#2C3550" stroke-width="3.5" stroke-linejoin="round"/>
          <circle cx="25" cy="27" r="5" fill="#2C3550"/><circle cx="39" cy="27" r="5" fill="#2C3550"/>`;
      case 'boo':
        return `<path d="M10 34a22 22 0 0 1 44 0v18l-6-5-5 5-5-5-5 5-5-5-6 5z"
          fill="#EFF3FF" stroke="#2B3149" stroke-width="3.5" stroke-linejoin="round"/>
          <circle cx="25" cy="31" r="4" fill="#2B3149"/><circle cx="39" cy="31" r="4" fill="#2B3149"/>
          <ellipse cx="32" cy="43" rx="6" ry="4" fill="#2B3149"/>`;
      case 'bomb':
        return `<path d="M40 20q9-5 8-15" stroke="#8E99A8" stroke-width="4.5" fill="none" stroke-linecap="round"/>
          <circle cx="50" cy="6" r="5" fill="#FFE9A8"/>
          <circle cx="29" cy="38" r="21" fill="#2E3340" stroke="#14171F" stroke-width="3"/>
          <path d="M9 34q20 8 40 0" stroke="#FF6B1A" stroke-width="6" fill="none"/>`;
      case 'coin':
        return `<circle cx="32" cy="32" r="22" fill="#FFC300" stroke="#A96E06" stroke-width="3.5"/>
          <ellipse cx="32" cy="32" rx="10" ry="14" fill="none" stroke="#A96E06" stroke-width="3.5"/>`;
      case 'horn':
        return `<path d="M46 22a14 14 0 0 1 0 20M53 15a24 24 0 0 1 0 34"
          stroke="#2E3340" stroke-width="3.5" fill="none" stroke-linecap="round"/>
          <path d="M12 26h10l16-13v38L22 38H12z"
          fill="#FF6B1A" stroke="#2E3340" stroke-width="3.5" stroke-linejoin="round"/>`;
      default:
        return '';
    }
  };
  return `<svg viewBox="0 0 64 64" data-face="${id}">${body()}</svg>`;
}

export interface ItemHud {
  build(): void;
  /** The settled item, or null when the slot is empty. */
  setItem(entry: ItemEntry | null): void;
  /** Show a face without settling on it — the reel mid-spin. */
  showFace(entry: ItemEntry): void;
  spinning(on: boolean): void;
  /** Punch the slot: the reel has landed. */
  punch(): void;
  /** Ink on the lens, 0..1. */
  setInk(amount: number): void;
  /** How close the nearest thing aimed at you is, 0..1. Drives the vignette. */
  warn(amount: number): void;
  /** One-off coloured wash: lightning, a hit, a star. */
  flash(color: number, amount: number): void;
  update(dt: number): void;
  dispose(): void;
}

export function createItemHud(): ItemHud {
  let root: HTMLDivElement | null = null;
  let slot: HTMLDivElement | null = null;
  let countEl: HTMLDivElement | null = null;
  let glowEl: HTMLDivElement | null = null;
  let inkEl: HTMLDivElement | null = null;
  let flashEl: HTMLDivElement | null = null;
  let warnEl: HTMLDivElement | null = null;
  let style: HTMLStyleElement | null = null;
  const faces = new Map<string, SVGElement>();
  let shown: string | null = null;

  let punchT = 0;
  let spin = 0;
  let glow = 0;
  let flashAmount = 0;
  let inkTarget = 0;
  let inkShown = 0;
  let jitterPhase = 0;
  let warnTarget = 0;
  let warnShown = 0;
  let warnPhase = 0;

  /**
   * The face is keyed on the *item*, never on the item and its count.
   *
   * Keying on both looks tidier and is wrong: fire one of a triple and the slot
   * is asked for "greenShell:2", which no table ever produced, so the icon
   * silently vanishes and the player is left holding two invisible shells. The
   * count is a badge on the corner, and that is all it ever was.
   */
  const key = (e: ItemEntry): string => e.id;

  function build(): void {
    if (root || typeof document === 'undefined') return;

    style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Screen effects always exist. The slot stands down if the UI module has
    // published one of its own.
    inkEl = document.createElement('div');
    inkEl.id = 'item-ink';
    // x%, y%, size in vmax, and a squash/rotation so no two are the same disc.
    // Weighted to the corners and the bottom, where the player is not looking
    // for the apex — the hole left in the middle is deliberate, and it is the
    // difference between a handicap and a blindfold.
    const SPLATS: Array<[number, number, number, number, number]> = [
      [-6, -2, 30, 1.15, -18], [20, -10, 24, 0.9, 24], [62, -9, 28, 1.2, 12],
      [86, 4, 26, 0.95, -30], [-9, 42, 27, 1.1, 40], [79, 48, 30, 1.25, -12],
      [12, 60, 32, 0.92, 18], [50, 70, 34, 1.3, -8], [36, 22, 17, 1.0, 55],
      [70, 24, 14, 0.85, -40], [4, 22, 13, 1.1, 10],
    ];
    for (const [x, y, r, squash, rot] of SPLATS) {
      const s = document.createElement('i');
      s.style.left = `${x}%`;
      s.style.top = `${y}%`;
      s.style.width = `${r}vmax`;
      s.style.height = `${r}vmax`;
      s.style.transform = `rotate(${rot}deg) scaleY(${squash})`;
      inkEl.appendChild(s);
    }
    // Spatter. Deterministic positions — this is decoration, but decoration
    // that must not differ between two runs of the same seeded capture.
    const FLECKS: Array<[number, number, number]> = [
      [30, 8, 4.5], [58, 14, 3.2], [15, 34, 3.8], [72, 38, 4.2], [44, 52, 3],
      [88, 30, 3.6], [26, 74, 4.4], [64, 62, 3.4], [8, 58, 3],
    ];
    for (const [x, y, r] of FLECKS) {
      const s = document.createElement('i');
      s.className = 'fleck';
      s.style.left = `${x}%`;
      s.style.top = `${y}%`;
      s.style.width = `${r}vmax`;
      s.style.height = `${r}vmax`;
      inkEl.appendChild(s);
    }
    document.body.appendChild(inkEl);

    warnEl = document.createElement('div');
    warnEl.id = 'item-warn';
    warnEl.innerHTML = '<b>INCOMING</b>';
    document.body.appendChild(warnEl);

    flashEl = document.createElement('div');
    flashEl.id = 'item-flash';
    document.body.appendChild(flashEl);

    if (document.querySelector('[data-item-slot]')) return;

    root = document.createElement('div');
    root.id = 'item-hud';
    root.innerHTML = `<div class="slot empty">
      <div class="glow"></div>
      <div class="mark">?</div>
      <div class="icons">${ICON_IDS.map((id) => iconSvg(id)).join('')}</div>
      <div class="count"></div>
    </div>`;
    document.body.appendChild(root);

    slot = root.querySelector('.slot');
    countEl = root.querySelector('.count');
    glowEl = root.querySelector('.glow');
    for (const svg of Array.from(root.querySelectorAll<SVGElement>('svg'))) {
      faces.set(svg.dataset.face ?? '', svg);
    }
  }

  function show(entry: ItemEntry | null): void {
    if (!root) return;
    const k = entry ? key(entry) : null;
    if (k === shown) return;
    if (shown) faces.get(shown)?.classList.remove('on');
    shown = k;
    if (k) faces.get(k)?.classList.add('on');
    if (countEl) {
      const n = entry?.count ?? 1;
      countEl.textContent = n > 1 ? `×${n}` : '';
      countEl.style.opacity = n > 1 ? '1' : '0';
    }
    slot?.classList.toggle('empty', !entry);
  }

  return {
    build,

    setItem(entry: ItemEntry | null): void {
      show(entry);
      if (entry) {
        const def = ITEMS[entry.id];
        if (glowEl) glowEl.style.background =
          `radial-gradient(circle, ${hex(def.color)}, ${hex(def.color)}00 62%)`;
      }
    },

    showFace(entry: ItemEntry): void { show(entry); },

    spinning(on: boolean): void { spin = on ? 1 : 0; },

    punch(): void { punchT = 1; glow = 1; },

    setInk(amount: number): void { inkTarget = amount; },

    warn(amount: number): void { warnTarget = amount; },

    flash(color: number, amount: number): void {
      if (!flashEl) return;
      flashEl.style.background = hex(color);
      flashAmount = Math.max(flashAmount, amount);
    },

    update(dt: number): void {
      if (flashEl && (flashAmount > 0 || flashEl.style.opacity !== '0')) {
        flashAmount = Math.max(0, flashAmount - dt * 2.6);
        flashEl.style.opacity = flashAmount > 0.002 ? String(flashAmount) : '0';
      }

      if (inkEl) {
        // Ink arrives instantly and drains away — you should feel it land.
        inkShown += (inkTarget - inkShown) * Math.min(1, dt * (inkTarget > inkShown ? 22 : 4));
        if (inkShown < 0.002) inkShown = 0;
        inkEl.style.opacity = String(inkShown);
      }

      if (warnEl && (warnTarget > 0 || warnShown > 0)) {
        // Rises fast, releases slowly, and pulses harder the closer it gets —
        // the pulse rate is the distance readout.
        warnShown += (warnTarget - warnShown) * Math.min(1, dt * (warnTarget > warnShown ? 16 : 7));
        if (warnShown < 0.004) warnShown = 0;
        warnPhase += dt * (5 + warnShown * 16);
        const pulse = 0.72 + Math.sin(warnPhase) * 0.28;
        warnEl.style.opacity = String(warnShown * pulse);
      }

      if (!slot) return;
      if (punchT > 0) punchT = Math.max(0, punchT - dt * 3.2);
      if (glow > 0) glow = Math.max(0, glow - dt * 2.2);

      // The reel shakes while it spins and snaps out on the settle.
      jitterPhase += dt * 47;
      const jitter = spin > 0 ? Math.sin(jitterPhase) * 0.035 : 0;
      const pop = 1 + punchT * punchT * 0.42;
      slot.style.transform = `scale(${pop + jitter}) rotate(${jitter * 12}deg)`;
      if (glowEl) glowEl.style.opacity = String(glow * 0.9);
    },

    dispose(): void {
      root?.remove();
      inkEl?.remove();
      warnEl?.remove();
      flashEl?.remove();
      style?.remove();
      root = null;
      inkEl = null;
      warnEl = null;
      flashEl = null;
      style = null;
      faces.clear();
      shown = null;
    },
  };
}

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
