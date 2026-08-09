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
import { CSS_GLYPHS } from './glyphs.ts';
import { ICON_DEFS } from './icons.ts';
import { createItemSlot, CSS_ITEM } from './itemslot.ts';
import { createMinimap, CSS_MAP } from './minimap.ts';
import { createBanners, CSS_BANNERS } from './banners.ts';
import {
  createCoinPanel, createLapPanel, createPositionPanel,
  CSS_READOUTS, type Panel,
} from './readouts.ts';
import { bind, CSS_BASE, fromHtml, q } from './theme.ts';

const CSS_HUD = `
/* The icon shading ramps. Present, painted from, and never seen. */
#hud .icon-defs { position: absolute; width: 0; height: 0; overflow: hidden; }

/* A boost lights every warning strip in the instrument set white-hot while the
   kart is on it, and the whole set swells a percent as it fires — the
   instruments are bolted to a machine that has just been kicked, and they
   should move like it.

   Deliberately the *strips* and not the plate faces: fx/screen.ts owns the
   amber that closes in from the edges of the frame during a boost, and two
   modules both washing the middle of the screen orange is how a HUD stops being
   readable at the one moment the player most needs to read it. */
#hud.surge .plate::before { background: linear-gradient(90deg, #FFF3C4, #FFFFFF 50%, #FFF3C4); }
#hud.surge .plate { box-shadow:
    inset 0 calc(var(--u) * .1) 0 rgba(255,255,255,.4),
    inset 0 calc(var(--u) * -.14) 0 rgba(0,0,0,.5),
    0 0 0 calc(var(--u) * .12) rgba(9,11,15,.92),
    0 calc(var(--u) * .22) calc(var(--u) * .62) rgba(0,0,0,.5),
    0 0 calc(var(--u) * 1.6) rgba(255,226,150,.5); }
/* ...and the socket with them. It is the one cluster on screen that is not a
   plate, so it was also the one object that sat there unmoved while every other
   instrument in the set lit up — a hole in the middle of the reaction, in the
   middle of the frame. Declared here rather than in itemslot.ts for the
   ordering the states need: after the socket's own empty and spinning rules, so
   a boost shows in either, and before the damage rules below, so a shunt taken
   mid-boost still reads as damage. */
#hud.surge .slot { box-shadow:
    inset 0 0 0 calc(var(--u) * .21) rgba(255,246,214,.98),
    inset 0 0 0 calc(var(--u) * .34) rgba(20,24,34,.88),
    inset 0 calc(var(--u) * -.62) calc(var(--u) * 1.1) rgba(0,0,0,.45),
    0 calc(var(--u) * .34) calc(var(--u) * .9) rgba(0,0,0,.5),
    0 0 calc(var(--u) * 1.5) rgba(255,232,160,.55); }

/* ...and the same trick in the other direction. Being hit turns every strip red
   at once: the cheapest possible reaction, and the one that reads fastest,
   because the HUD is part of the kart and the kart just got hit.

   **Declared after the boost rules on purpose.** The two states have identical
   specificity and a player can absolutely be shunted while boosting, so source
   order is what decides which one the strips wear — and the answer has to be the
   damage. A boost is good news the player can already feel; a hit is the one
   they have to react to. */
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
  style.textContent = CSS_BASE + CSS_GLYPHS + CSS_ITEM + CSS_MAP
    + CSS_READOUTS + CSS_BANNERS + CSS_HUD;
  document.head.appendChild(style);

  const root = fromHtml(`
    <div id="hud">
      ${ICON_DEFS}
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
    /** Stays on screen when the rest of the set retires at the flag. */
    keep: name === 'br',
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
  /** Boost response: a white-hot beat across the whole instrument set. */
  let surge = 0;
  let surging = false;
  /**
   * ...and how much longer the set is allowed to stay hot.
   *
   * The glow follows `boost.time` rather than a timer of its own, because a
   * boost is a *state* — the same reason the damage colour is held for as long
   * as the player is actually spun out rather than for a fixed moment after the
   * bang. The cap is what stops a star or a bullet bill leaving every header
   * strip in the instrument set bleached white for eight seconds: the surge is
   * the launch, not the ride.
   */
  let surgeHold = 0;
  /**
   * How far the working instruments have retired, 0..1.
   *
   * The race ends and the lap counter, the socket and the map stop being
   * information — there is no next corner, no next box, and nothing left to do
   * with either. Leaving them up is the interface still talking after the
   * conversation is over. They fly back out the way they came in, and the place
   * indicator stays: that one *is* the result.
   */
  let retire = 0;
  /**
   * ...and then the curtain closes, and even the place indicator goes.
   *
   * The race director announces `race:handoff` on the frame its blades start to
   * close over the frame — "three live layers become one, behind a closed
   * curtain" — and until now nothing in the game listened to it, so the one
   * readout this HUD deliberately keeps up after the flag was still on screen
   * behind the curtain and then underneath the results sheet. It is the only
   * thing this module can do about furniture it does not own, and it is now
   * done.
   */
  let handed = false;

  const unsubs: Array<() => void> = [];
  unsubs.push(ctx.bus.on('race:handoff', () => { handed = true; }));

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
  // Every kind of boost, weighted by how big it is: a mini-turbo release and a
  // bullet bill should not read as the same event.
  unsubs.push(ctx.bus.on<{ racer: Racer; power: number }>('kart:boost', (e) => {
    if (!e.racer.isPlayer) return;
    surge = Math.max(surge, clamp01(0.55 + (e.power ?? 0) * 0.45));
    surgeHold = 1;
  }));

  return {
    name: 'hud',
    order: 100,

    reset(): void {
      jolt = 0;
      hurt = 0;
      clock = 0;
      surge = 0;
      surgeHold = 0;
      retire = 0;
      handed = false;
      if (hurting) { hurting = false; root.classList.remove('hurt'); }
      if (surging) { surging = false; root.classList.remove('surge'); }
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

      // ── impact, and its opposite ─────────────────────────────────────────
      //
      // One transform for the whole set, composed from both responses: a hit
      // shakes it and a boost swells it. Written from a single place because two
      // writers on one `transform` means whichever ran last wins, and a boost
      // taken while still shaking is exactly when both are happening.
      if (jolt > 0) jolt = Math.max(0, jolt - dt * 3.1);
      if (jolt > 0 || surge > 0) {
        const k = jolt * jolt;
        const x = Math.sin(clock * 61) * k * 1.1;
        const y = Math.sin(clock * 47 + 1.3) * k * 0.7;
        const rot = Math.sin(clock * 53) * k * 0.8;
        const s = 1 + surge * surge * 0.016;
        layer.set('transform',
          `translate(${x.toFixed(3)}%, ${y.toFixed(3)}%) rotate(${rot.toFixed(3)}deg) scale(${s.toFixed(4)})`);
      } else {
        layer.set('transform', 'none');
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

      // ── boost ────────────────────────────────────────────────────────────
      if (surge > 0) surge = Math.max(0, surge - dt * 3.4);
      if (surgeHold > 0) {
        surgeHold = Math.max(0, surgeHold - dt);
        const on = (ctx.player?.boost.time ?? 0) > 0 || surge > 0.3;
        if (on !== surging) {
          surging = on;
          root.classList.toggle('surge', on);
        }
      } else if (surging) {
        surging = false;
        root.classList.remove('surge');
      }

      // ── reveal, and its opposite ─────────────────────────────────────────
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
      } else if (ctx.player?.finished || handed || retire > 0) {
        // The working instruments leave once the race is decided; the place
        // indicator holds, because it is the answer. A beat of delay first, so
        // the crossing itself is not competing with the furniture moving.
        const want = ctx.player?.finished || handed ? 1 : 0;
        retire = want > retire
          ? Math.min(1, retire + dt / 0.9)
          : Math.max(0, retire - dt / 0.4);
        const out = ease.inQuad(clamp01((retire - 0.25) / 0.75));
        for (const c of corners) {
          if (c.keep && !handed) continue;
          const tx = c.dx * out * 46 + (c.centred ? -50 : 0);
          const ty = c.dy * out * 62;
          c.box.set('transform', `translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%)`);
          c.box.set('opacity', (1 - out).toFixed(3));
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
