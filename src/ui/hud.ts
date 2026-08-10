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
import { signCss } from './letters.ts';
import { createMinimap, CSS_MAP } from './minimap.ts';
import { createBanners, CSS_BANNERS } from './banners.ts';
import {
  createCoinPanel, createIdentityPanel, createLapPanel, createPositionPanel,
  CSS_READOUTS, type Panel,
} from './readouts.ts';
import { bind, CSS_BASE, fromHtml, HUD_RETIRE, q } from './theme.ts';

const CSS_HUD = `
/* The icon shading ramps. Present, painted from, and never seen. The set's own
   markup carries the same hiding rule inline (it has to: items/reel.ts mounts
   it outside this layer when there is no HUD), so this is belt and braces on
   the copy that lands in here. */
#hud .item-icon-defs { position: absolute; width: 0; height: 0; overflow: hidden; }

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
  // `signCss('#hud')` is new here, and it is the whole of ARCHITECTURE §11a's
  // type rule arriving in the one layer that had never needed it: nothing in
  // this HUD used to *name* anything, so nothing in it was set in the display
  // face. The identity plate names a driver, so it is drawn in the same
  // alphabet the results sheet and the roster name theirs in.
  style.textContent = CSS_BASE + CSS_GLYPHS + signCss('#hud') + CSS_ITEM + CSS_MAP
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
  const corners = REVEAL.map(([name, dx, dy], i) => ({
    box: bind(q(root, `.${name}`)),
    dx, dy,
    centred: name === 'tc',
    /**
     * This cluster's own phase in the impact shake.
     *
     * **A hit used to move the HUD as one rigid slab.** The whole layer was
     * translated and rotated together, so the lap plate, the map, the coin
     * plate and the place indicator all leaned the same way by the same amount
     * at the same instant — which is not five instruments being knocked, it is
     * a photograph of five instruments being tilted. Five separate phases, from
     * an irrational step so no two ever come back into sync, and the set comes
     * apart on the bang the way a dashboard full of loose gauges would.
     */
    phase: i * 2.399963,
  }));

  const slot = createItemSlot(ctx);
  const map = createMinimap(ctx);
  const lap = createLapPanel(ctx);
  const position = createPositionPanel(ctx);
  const identity = createIdentityPanel(ctx);
  const coins = createCoinPanel(ctx);
  const banners = createBanners(ctx);

  q(root, '.tl').appendChild(lap.root);
  q(root, '.tc').appendChild(slot.root);
  q(root, '.tr').appendChild(map.root);
  q(root, '.bl').appendChild(coins.root);
  // Above the place badge, in the corner the badge already owns. The two
  // belong together: one is where you are and the other is who you are, and
  // they arrive, shake and leave as one cluster.
  q(root, '.br').appendChild(identity.root);
  q(root, '.br').appendChild(position.root);
  q(root, '.layer').appendChild(banners.root);

  // **Mounted here, in the factory, and not in `init()`.** `items/reel.ts` ships
  // an item slot of its own and stands down when it finds `data-item-slot` in
  // the document — but it looks exactly once, during its own `init`, and systems
  // initialise in `order`: items is 50, this is 100. A slot that appears after
  // the item system has looked for it is a slot that was never there, and the
  // game ends up wearing two.
  document.body.appendChild(root);

  const panels: Panel[] = [lap, position, identity, coins];

  /** Impact response, shared by every kind of thumping the player takes. */
  let jolt = 0;
  let hurt = 0;
  let hurting = false;
  let clock = 0;
  let reveal = 1;
  /**
   * How far in the item socket is, 0..1 — and it is held at 0 until the flag.
   *
   * **Two modules both claimed the top centre of the screen and neither could
   * see the other.** The socket lives at `#hud .tc`, an inch below the top
   * edge; the race's start-light board lives at 16.5% of the frame in
   * `race/stage.ts`, on the layer above. Photographed on the frame the player
   * spends the whole countdown staring at, they land about fifteen pixels apart
   * and read as one two-storey widget — and then state the same brand motif two
   * incompatible ways, because a socket is a recess with a continuous hazard
   * ring round a 1.28u corner and a plate is a sign with a yellow strip along
   * one edge and a 0.55u corner. Neither module was wrong; nobody owned the
   * space between them.
   *
   * The decision, made across both: **the socket has nothing to say before the
   * flag falls.** There is no item, there is no way to get one, and it is an
   * empty box sitting on top of the one signal that does mean something during
   * the count. So it stays parked off the top edge — the same offset the reveal
   * already flies it in from — and arrives with the race. The board keeps its
   * position and gets its chevron texture back, so the top of the frame holds
   * exactly one object at a time.
   */
  let slotIn = 1;
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
   * How far the instruments have retired, 0..1.
   *
   * The race ends and the lap counter, the socket and the map stop being
   * information — there is no next corner, no next box, and nothing left to do
   * with either. Leaving them up is the interface still talking after the
   * conversation is over. They fly back out the way they came in.
   *
   * **All five clusters, including the place indicator.** That one used to
   * hold, on the argument that it *is* the result — and it was the right
   * argument in a frame nobody else had claimed. `race/stage.ts` claims it:
   * the finish beat drops letterbox bars over the top and bottom ninth of the
   * screen and says so in its own comment ("its letterbox has to sit over the
   * HUD's corners"). Measured, the bottom bar ate the bottom 63px of a 209px
   * badge — photographed twice, once slicing a gold "1" through the middle with
   * the "ST" gone and once cutting a "3" through the numeral's waist. So the
   * race decided to cover the HUD and the HUD was never told to leave, and the
   * player was shown where they finished through a guillotine.
   *
   * The beat says it better than the badge does: a plate across the middle of
   * the frame reading 1ST PLACE with the time on it, a ticker naming the whole
   * field home, and then the results sheet. Nothing is lost by going, and a set
   * that leaves together is one gesture rather than four plates and a stump.
   */
  let retire = 0;
  /**
   * ...and the curtain, which retires the set whether or not the player
   * finished.
   *
   * The race director announces `race:handoff` on the frame its blades start to
   * close — "three live layers become one, behind a closed curtain". A race
   * abandoned from the pause menu never sets `player.finished`, so without this
   * the whole instrument set would ride the curtain down and reappear under the
   * results sheet. It is the only thing this module can do about furniture it
   * does not own.
   */
  let handed = false;
  /**
   * Whether the clusters are currently displaced from their resting place.
   *
   * The composed writer below has to run for one extra frame after everything
   * it composes has reached zero, or the last shake offset is what the set
   * stays parked at. `bind()` swallows the repeat writes, so "one extra frame"
   * costs a map lookup.
   */
  let cornersHot = true;

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
      slotIn = 0;
      cornersHot = true;
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
      // The *swell* is the whole set's, because a boost is one event happening
      // to the machine all the instruments are bolted to. The *shake* is not:
      // it is handed to the clusters below, each with its own phase, because a
      // rigid slab leaning eight degrees is a photograph of a HUD being tilted
      // rather than of five instruments being hit.
      if (jolt > 0) jolt = Math.max(0, jolt - dt * 3.1);
      if (surge > 0.0005) {
        layer.set('transform', `scale(${(1 + surge * surge * 0.016).toFixed(4)})`);
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

      // The socket waits for the flag. See `slotIn`.
      const preFlag = ctx.race.phase === 'intro' || ctx.race.phase === 'countdown';
      slotIn = preFlag ? 0 : Math.min(1, slotIn + dt / 0.34);

      // ── reveal, retire, and the shake ────────────────────────────────────
      //
      // **One writer for every cluster's transform, always.** Two writers on one
      // `transform` means whichever ran last wins, and three of these states
      // overlap in practice: "the set is arriving" and "the socket is still
      // waiting for the flag" are both true for the first third of a second of
      // every race, and a shell can land on the player in the middle of either.
      // So the arrival offset, the retirement offset and the impact shake are
      // composed here and written once.
      if (reveal < 1) reveal = Math.min(1, reveal + dt / 0.32);
      const retiring = (ctx.player?.finished ?? false) || handed || retire > 0;
      if (retiring) {
        // **It starts on the crossing and it is finished before the bars land.**
        //
        // This used to hold for a quarter of its own ramp and then take nine
        // tenths of a second to travel, while `race/stage.ts` dropped the
        // letterbox in `LETTERBOX_IN` — a fifth of a second — over the top of
        // it. Measured at 0.3s past the flag, `gone` was 0.004: the timer plate
        // and the minimap were sliced through the middle by the top bar and the
        // place badge was a gold stump with its numeral cut off by the bottom
        // one, which is the exact guillotine the note on `retire` above
        // describes as the reason the badge retires at all.
        //
        // `HUD_RETIRE` is stated in `ui/theme.ts` next to the number it has to
        // beat, so the two can never again be set by two people who never met.
        // **Clamped to the target, not to 0..1.** This used to read `Math.min(1,
        // …)` against `Math.max(0, …)`, and `want > retire` is false when both
        // are 1 — so the frame after the set finished leaving, it started coming
        // back, and the frame after that it left again. The instruments
        // sawtoothed forever at the edges of the screen at about a tenth of
        // opacity, which no capture had ever shown because the shot that
        // photographs this beat froze every visual clock in it (see the `finish`
        // recipe in tools/capture.mjs). Moving toward `want` has a resting state;
        // moving toward a bound does not.
        const want = ctx.player?.finished || handed ? 1 : 0;
        retire = want > retire
          ? Math.min(want, retire + dt / HUD_RETIRE)
          : Math.max(want, retire - dt / 0.4);
      }
      const back = 1 - ease.outQuart(reveal);
      const held = Math.max(back, 1 - ease.outQuart(slotIn));
      const gone = retiring ? ease.inQuad(retire) : 0;
      const shake = jolt * jolt;
      if (back > 0 || held > 0 || gone > 0 || shake > 0 || cornersHot) {
        cornersHot = back > 0 || held > 0 || gone > 0 || shake > 0;
        for (const c of corners) {
          const b = c.centred ? held : back;
          const leave = gone;
          let tx = (c.dx * b * 46) + (c.dx * leave * 46) + (c.centred ? -50 : 0);
          let ty = (c.dy * b * 60) + (c.dy * leave * 62);
          let rot = 0;
          if (shake > 0) {
            // Each cluster on its own beat, and rotating about its own middle —
            // which is what makes the lap plate and the map look like two
            // things that were hit rather than one thing that was tilted.
            tx += Math.sin(clock * 61 + c.phase) * shake * 3.4;
            ty += Math.sin(clock * 47 + c.phase * 1.7) * shake * 2.8;
            rot = Math.sin(clock * 53 + c.phase * 2.3) * shake * 2.2;
          }
          c.box.set('transform', rot === 0
            ? `translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%)`
            : `translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%) rotate(${rot.toFixed(2)}deg)`);
          c.box.set('opacity', ((c.centred
            ? Math.min(1, (1 - held) * 2.2)
            : Math.min(1, reveal * 2.2)) * (1 - leave)).toFixed(3));
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
