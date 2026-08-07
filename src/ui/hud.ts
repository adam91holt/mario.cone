// The HUD.
//
// A DOM overlay rather than in-scene sprites: text stays crisp at any
// resolution, layout is trivial to iterate on, and it costs no draw calls. The
// rule the whole module is held to is that **the HUD reads state and never
// writes it** — everything on screen is derived from `ctx.race`, `ctx.player`
// and the bus, and nothing here can change who wins the race.
//
// The set, and where the eye goes:
//
//   top centre    the item slot, on the line the player is already looking down,
//                 wearing the mini-turbo charge as a collar
//   top left      lap and lap pips
//   top right     the minimap
//   bottom left   coins
//   bottom right  position — the biggest number on the screen, in a corner of
//                 its own
//   centre        the countdown, and the four things worth interrupting for
//
// Three rules hold it together. Everything sits on a *plate*, because half this
// circuit is framed against a white sky and half against black tarmac and no
// bare ink is readable on both. Everything is sized in one viewport-derived
// unit, so the whole set scales to a phone without a single collision. And
// nothing animates in CSS — every motion is integrated from the `dt` handed to
// `update`, so the capture harness, which renders frames with no wall clock at
// all, photographs the same frame every time.
//
// See `theme.ts` for the unit and the plate, and `itemslot.ts` for how this
// module hands the item slot off with the item system.

import { clamp01, ease } from '../core/math.ts';
import type { GameContext, GameSystem, Racer } from '../types.ts';
import { createItemSlot, CSS_ITEM } from './itemslot.ts';
import { createMinimap, CSS_MAP } from './minimap.ts';
import { createBanners, CSS_BANNERS } from './banners.ts';
import {
  createCoinPanel, createLapPanel, createPositionPanel,
  CSS_READOUTS, type Panel,
} from './readouts.ts';
import { bind, CSS_BASE, fromHtml, q } from './theme.ts';

const CSS_HUD = `
/* Being hit turns every warning strip in the instrument set red at once. The
   cheapest possible reaction, and the one that reads fastest: the HUD is part
   of the kart, and the kart just got hit. */
#hud.hurt .plate::before { background: linear-gradient(90deg, #FF3A22, #FF7A4A 55%, #FF3A22); }
#hud.hurt .slot { box-shadow:
    inset 0 0 0 calc(var(--u) * .2) rgba(255,70,40,.95),
    inset 0 0 0 calc(var(--u) * .34) rgba(20,24,34,.85),
    inset 0 calc(var(--u) * -.62) calc(var(--u) * 1.1) rgba(0,0,0,.45),
    0 calc(var(--u) * .34) calc(var(--u) * .9) rgba(0,0,0,.5); }
`;

/** Where each cluster flies in from when a race starts. */
const REVEAL: Array<[string, number, number]> = [
  ['tl', -1, -0.5], ['tc', 0, -1.2], ['tr', 1, -0.5], ['bl', -1, 0.6], ['br', 1, 0.6],
];

export function createHudSystem(ctx: GameContext): GameSystem {
  // No document (typecheck, or a headless unit run): hand back an inert system
  // rather than exploding on the first DOM call.
  if (typeof document === 'undefined') {
    return { name: 'hud', order: 100 };
  }

  const style = document.createElement('style');
  style.textContent = CSS_BASE + CSS_ITEM + CSS_MAP + CSS_READOUTS + CSS_BANNERS + CSS_HUD;
  document.head.appendChild(style);

  const root = fromHtml(`
    <div id="hud">
      <div class="layer">
        <div class="corner tl"></div>
        <div class="corner tc"></div>
        <div class="corner tr"></div>
        <div class="corner bl"></div>
        <div class="corner br"></div>
      </div>
    </div>
  `);

  const layer = bind(q(root, '.layer'));
  const corners = REVEAL.map(([name, dx, dy]) => ({
    box: bind(q(root, `.${name}`)),
    dx, dy,
    centred: name === 'tc',
  }));

  const slot = createItemSlot(ctx);
  const map = createMinimap(ctx);
  const lap = createLapPanel(ctx);
  const position = createPositionPanel(ctx);
  const coins = createCoinPanel(ctx);
  const banners = createBanners(ctx);

  q(root, '.tl').appendChild(lap.root);
  q(root, '.tc').appendChild(slot.root);
  q(root, '.tr').appendChild(map.root);
  q(root, '.bl').appendChild(coins.root);
  q(root, '.br').appendChild(position.root);
  q(root, '.layer').appendChild(banners.root);

  // **Mounted here, in the factory, and not in `init()`.** `items/reel.ts` ships
  // an item slot of its own and stands down when it finds `data-item-slot` in
  // the document — but it looks exactly once, during its own `init`, and systems
  // initialise in `order`: items is 50, this is 100. A slot that appears after
  // the item system has looked for it is a slot that was never there, and the
  // game ends up wearing two.
  document.body.appendChild(root);

  const panels: Panel[] = [lap, position, coins];

  /** Impact response, shared by every kind of thumping the player takes. */
  let jolt = 0;
  let hurt = 0;
  let hurting = false;
  let clock = 0;
  let reveal = 1;

  const unsubs: Array<() => void> = [];

  function hit(power: number, damage: boolean): void {
    jolt = Math.min(1, Math.max(jolt, power));
    if (damage) hurt = Math.max(hurt, 0.55);
  }

  // An item landing on the player: the loudest of the three, and the only one
  // that turns the warning strips red.
  unsubs.push(ctx.bus.on<{ racer: Racer }>('item:strike', (e) => {
    if (e.racer.isPlayer) hit(1, true);
  }));
  // ...and anything else physics considers a hit, for the cases items does not
  // own — a spin from a wall, a shunt from another machine.
  unsubs.push(ctx.bus.on<{ racer: Racer }>('kart:hit', (e) => {
    if (e.racer.isPlayer) hit(0.85, true);
  }));
  unsubs.push(ctx.bus.on<{ racer: Racer; force: number }>('kart:wall', (e) => {
    if (e.racer.isPlayer) hit(clamp01(e.force) * 0.5, false);
  }));
  unsubs.push(ctx.bus.on<{ racer: Racer; impact: number }>('kart:land', (e) => {
    if (e.racer.isPlayer) hit(clamp01(e.impact * 0.5) * 0.35, false);
  }));

  return {
    name: 'hud',
    order: 100,

    reset(): void {
      jolt = 0;
      hurt = 0;
      clock = 0;
      if (hurting) { hurting = false; root.classList.remove('hurt'); }
      layer.set('transform', 'none');
      // The set flies in as the grid forms. Short on purpose — it is a flourish,
      // not a loading screen, and every review capture renders less than a
      // second of the moment it happens in.
      reveal = 0;
      slot.reset();
      map.reset();
      banners.reset();
      for (const p of panels) p.reset();
    },

    update(frameDt: number, alpha: number): void {
      // **Clamped, at the one point that hands it out.**
      //
      // Every animation in this module integrates `dt`, and the engine's
      // realtime loop keeps ticking underneath the capture harness — which
      // means `update` can be handed a frame delta measured between two
      // different clocks. A single negative delta runs every timer in the HUD
      // backwards: it took one to inflate the item slot's spin jitter into a
      // permanent 20x wobble and to park the countdown at an opacity it never
      // came back from. Neither bug was visible in the code, only in the
      // photographs. A blend is a blend and a delta is a delta; both get
      // sanitised here rather than in fifteen places downstream.
      const dt = frameDt > 0.1 ? 0.1 : frameDt > 0 ? frameDt : 0;
      clock += dt;

      slot.update(dt);
      map.update(dt, alpha);
      banners.update(dt);
      for (const p of panels) p.update(dt);

      // ── impact ───────────────────────────────────────────────────────────
      if (jolt > 0) {
        jolt = Math.max(0, jolt - dt * 3.1);
        const k = jolt * jolt;
        const x = Math.sin(clock * 61) * k * 1.1;
        const y = Math.sin(clock * 47 + 1.3) * k * 0.7;
        layer.set('transform',
          `translate(${x.toFixed(3)}%, ${y.toFixed(3)}%) rotate(${(Math.sin(clock * 53) * k * 0.8).toFixed(3)}deg)`);
        if (jolt === 0) layer.set('transform', 'none');
      }
      // A spun-out kart is not a moment, it is a *state*, and the HUD holds the
      // damage colour for as long as the player is actually out of control
      // rather than for a fixed fifth of a second after the bang.
      if ((ctx.player?.stunned ?? 0) > 0) hurt = Math.max(hurt, 0.25);
      if (hurt > 0) {
        hurt = Math.max(0, hurt - dt);
        // Flicker rather than fade: damage in this game blinks.
        const on = hurt > 0 && Math.sin(clock * 30) > -0.6;
        if (on !== hurting) {
          hurting = on;
          root.classList.toggle('hurt', on);
        }
      }

      // ── reveal ───────────────────────────────────────────────────────────
      if (reveal < 1) {
        reveal = Math.min(1, reveal + dt / 0.32);
        const e = ease.outQuart(reveal);
        const back = 1 - e;
        for (const c of corners) {
          const tx = c.dx * back * 46 + (c.centred ? -50 : 0);
          const ty = c.dy * back * 60;
          c.box.set('transform', `translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%)`);
          c.box.set('opacity', Math.min(1, reveal * 2.2).toFixed(3));
        }
      }
    },

    dispose(): void {
      for (const off of unsubs) off();
      unsubs.length = 0;
      slot.dispose();
      map.dispose();
      banners.dispose();
      for (const p of panels) p.dispose();
      root.remove();
      style.remove();
    },
  };
}
