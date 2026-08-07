// The item slot, and the roulette that fills it.
//
// This is the one widget on screen the player looks at while they are busy
// driving, so it sits dead centre at the top of the frame — directly above the
// kart, on the line their eye is already on — and it is the loudest object in
// the HUD: a hazard-ringed socket, the size of a road sign, that shakes while
// it is deciding and punches when it lands.
//
// **How it coordinates with the item system.** `items/reel.ts` ships a slot of
// its own and stands down the moment it finds an element marked
// `data-item-slot`, leaving its screen effects (ink, warning vignette, hit
// flash) in place. That handoff is why this widget is built in the *factory*
// rather than in `init()`: systems initialise in `order`, items (50) is long
// before ui (100), and a marker that arrives after the item system has looked
// for it is a marker that never existed. See `createHudSystem`.
//
// Everything the slot shows is read from `ctx.player.item` / `.itemCount` — the
// simulation's own truth, so a lightning bolt that empties the slot, a boo that
// steals from it and the harness' `__ITEMS.give` all land here without any of
// them having to know this widget exists. The bus is used only for the two
// things state cannot express: when the roulette *started* spinning, and when
// it stopped.

import { clamp01, ease } from '../core/math.ts';
import { ITEMS, REEL_FACES } from '../items/defs.ts';
import type { GameContext, ItemId, Racer } from '../types.ts';
import { itemIconSvg, ITEM_IDS } from './icons.ts';
import { bind, fromHtml, hexCss, q, rgba, TIER_COLORS, TIER_RING, type Bound } from './theme.ts';

/**
 * How long the reel is assumed to spin, for the shape of its deceleration.
 *
 * The bus says *that* a roulette started and *that* it settled; it does not say
 * how long the spin will be. A reel that cycles at a constant rate has no
 * ending, so this mirrors `SPIN_PLAYER` in the item system to slow the cadence
 * into the answer. If the two ever disagree the reel simply lands early or
 * late — it is snapped to the real item by the settle either way, so the
 * picture can never be wrong, only less well timed.
 */
const ASSUMED_SPIN = 1.05;

// ── the charge collar ──────────────────────────────────────────────────────
//
// The mini-turbo meter, moved here off the speedometer that used to carry it.
//
// The drift charge has to be readable without looking away from the road, and
// the socket at the top of the frame is the one piece of HUD the player is
// already glancing at every few seconds. So the meter is a collar around it: a
// rounded track following the socket's own corners, filling symmetrically from
// twelve o'clock, changing colour, stroke weight and halo at each tier.
//
// Filled in *thirds* rather than linearly against the raw charge. The sim's
// thresholds are not evenly spaced — blue lands at 0.80 and purple at 3.00 — so
// a linear arc puts blue at a quarter of the collar and spends the whole second
// half of the sweep inside one tier. An equal third per tier means the geometry
// says the same thing the colour does, and "two thirds round" always means
// "one more beat to purple".

const SLOT_U = 6.1;
const SLOT_RADIUS_U = 1.15;
/** How far the collar's box extends past the socket, and where its line sits. */
const COLLAR_OUT = 0.62;
const COLLAR_GAP = 0.3;

const COLLAR_BOX = SLOT_U + COLLAR_OUT * 2;
/** viewBox units per `--u` — the collar is square, so one scale for both axes. */
const VB_PER_U = 100 / COLLAR_BOX;
const COLLAR_HALF = (SLOT_U / 2 + COLLAR_GAP) * VB_PER_U;
const COLLAR_R = (SLOT_RADIUS_U + COLLAR_GAP) * VB_PER_U;

/**
 * The collar path, drawn clockwise from top dead centre.
 *
 * Starting at the top matters: with `stroke-dashoffset` at half the dash the
 * fill then grows symmetrically out of twelve o'clock in both directions, which
 * is the shape of a thing charging rather than a thing being poured into.
 */
function collarPath(): string {
  const lo = 50 - COLLAR_HALF, hi = 50 + COLLAR_HALF, r = COLLAR_R;
  const n = (v: number): string => v.toFixed(2);
  return `M 50 ${n(lo)}
    L ${n(hi - r)} ${n(lo)} A ${n(r)} ${n(r)} 0 0 1 ${n(hi)} ${n(lo + r)}
    L ${n(hi)} ${n(hi - r)} A ${n(r)} ${n(r)} 0 0 1 ${n(hi - r)} ${n(hi)}
    L ${n(lo + r)} ${n(hi)} A ${n(r)} ${n(r)} 0 0 1 ${n(lo)} ${n(hi - r)}
    L ${n(lo)} ${n(lo + r)} A ${n(r)} ${n(r)} 0 0 1 ${n(lo + r)} ${n(lo)} Z`;
}

/** Perimeter of that rounded rectangle, for the dash arithmetic. */
const COLLAR_LEN =
  8 * COLLAR_HALF - 8 * COLLAR_R + 2 * Math.PI * COLLAR_R;

export const CSS_ITEM = `
#hud .slot-wrap { position: relative; }
/* The collar sits behind the socket and outside it, so the count badge in the
   bottom-right corner of the wrap still wins the overlap. */
#hud .slot-wrap .collar {
  position: absolute; inset: calc(var(--u) * ${-COLLAR_OUT});
  display: block; overflow: visible; pointer-events: none;
}
#hud .slot-wrap .collar path { fill: none; stroke-linecap: round; }
#hud .slot {
  position: relative;
  width: calc(var(--u) * ${SLOT_U}); height: calc(var(--u) * ${SLOT_U});
  border-radius: calc(var(--u) * ${SLOT_RADIUS_U});
  background:
    linear-gradient(163deg, rgba(96,107,128,.62), rgba(23,27,37,.8)),
    repeating-linear-gradient(128deg,
      rgba(255,107,26,.2) 0 calc(var(--u) * .55),
      rgba(0,0,0,0) calc(var(--u) * .55) calc(var(--u) * 1.1));
  box-shadow:
    inset 0 0 0 calc(var(--u) * .2) rgba(255,195,0,.95),
    inset 0 0 0 calc(var(--u) * .34) rgba(20,24,34,.85),
    inset 0 calc(var(--u) * -.62) calc(var(--u) * 1.1) rgba(0,0,0,.45),
    0 calc(var(--u) * .34) calc(var(--u) * .9) rgba(0,0,0,.5);
  display: grid; place-items: center;
  overflow: hidden;
}
/* An empty slot is *waiting*, not disabled: the ring stays lit and a hazard "?"
   sits in it, so it reads as a socket with nothing in it rather than a control
   that has been greyed out. */
#hud .slot.empty {
  box-shadow:
    inset 0 0 0 calc(var(--u) * .2) rgba(255,195,0,.6),
    inset 0 0 0 calc(var(--u) * .34) rgba(20,24,34,.8),
    inset 0 calc(var(--u) * -.62) calc(var(--u) * 1.1) rgba(0,0,0,.45),
    0 calc(var(--u) * .34) calc(var(--u) * .9) rgba(0,0,0,.45);
}
#hud .slot .mark {
  position: absolute; font-size: calc(var(--u) * 3.2); font-weight: 900; line-height: 1;
  color: #FFC300; opacity: 0;
  text-shadow:
    calc(var(--u) * .12) calc(var(--u) * .12) 0 rgba(18,21,29,.95),
    calc(var(--u) * -.12) calc(var(--u) * .12) 0 rgba(18,21,29,.95),
    calc(var(--u) * .12) calc(var(--u) * -.12) 0 rgba(18,21,29,.95),
    calc(var(--u) * -.12) calc(var(--u) * -.12) 0 rgba(18,21,29,.95),
    0 calc(var(--u) * .26) 0 rgba(0,0,0,.5);
}
#hud .slot.empty .mark { opacity: .95; }

#hud .reel { position: relative; width: calc(var(--u) * 4.1); height: calc(var(--u) * 4.1); }
#hud .reel .face { position: absolute; inset: 0; }
#hud .reel svg {
  position: absolute; inset: 0; width: 100%; height: 100%; display: none;
  filter: drop-shadow(0 calc(var(--u) * .16) 0 rgba(0,0,0,.45));
}
#hud .reel svg.on { display: block; }

/* The scanner. A bright bar that runs down the face while the reel is spinning:
   the movement of the icons alone is a smear at 18Hz, and this is what tells
   the eye the machine is *working* rather than glitching. */
#hud .slot .sweep {
  position: absolute; left: 0; right: 0; height: 46%; top: 0; opacity: 0;
  background: linear-gradient(180deg, rgba(255,240,190,0) 0%, rgba(255,240,190,.5) 55%, rgba(255,240,190,0) 100%);
  mix-blend-mode: screen;
}
#hud .slot .glow {
  position: absolute; inset: -22%; opacity: 0; mix-blend-mode: screen;
  background: radial-gradient(circle, rgba(255,236,186,.95), rgba(255,236,186,0) 62%);
}
#hud .slot-wrap .count {
  position: absolute; right: calc(var(--u) * -.34); bottom: calc(var(--u) * -.3);
  min-width: calc(var(--u) * 1.6); padding: 0 calc(var(--u) * .3);
  border-radius: calc(var(--u) * .5);
  background: linear-gradient(180deg, #FF8A2A, #E24E06);
  box-shadow: 0 0 0 calc(var(--u) * .13) rgba(12,14,20,.92), 0 calc(var(--u) * .16) calc(var(--u) * .3) rgba(0,0,0,.5);
  font-size: calc(var(--u) * 1.05); font-weight: 900; line-height: calc(var(--u) * 1.5);
  text-align: center; color: #FFF8F0; opacity: 0;
  text-shadow: 0 calc(var(--u) * .1) 0 rgba(0,0,0,.5);
}
`;

export interface ItemSlot {
  readonly root: HTMLElement;
  update(dt: number): void;
  reset(): void;
  dispose(): void;
}

export function createItemSlot(ctx: GameContext): ItemSlot {
  const collarD = collarPath();
  const root = fromHtml(`
    <div class="slot-wrap" data-item-slot>
      <svg class="collar" viewBox="0 0 100 100" aria-hidden="true">
        <path class="bed" d="${collarD}" stroke="rgba(8,10,15,.72)" stroke-width="${(0.5 * VB_PER_U).toFixed(2)}" opacity="0"/>
        <path class="halo" d="${collarD}" stroke="#4FC3F7" stroke-width="${(0.6 * VB_PER_U).toFixed(2)}" opacity="0"/>
        <path class="arc" d="${collarD}" stroke="#4FC3F7" stroke-width="${(0.26 * VB_PER_U).toFixed(2)}" opacity="0"/>
      </svg>
      <div class="slot empty">
        <div class="glow"></div>
        <div class="sweep"></div>
        <div class="mark">?</div>
        <div class="reel">
          <div class="face a">${ITEM_IDS.map(itemIconSvg).join('')}</div>
          <div class="face b">${ITEM_IDS.map(itemIconSvg).join('')}</div>
        </div>
      </div>
      <div class="count"></div>
    </div>
  `);

  const slot = bind(q(root, '.slot'));
  const reel = bind(q(root, '.reel'));
  const sweep = bind(q(root, '.sweep'));
  const glow = bind(q(root, '.glow'));
  const count = bind(q(root, '.count'));
  const collarSvg = bind(q<SVGElement>(root, '.collar'));
  const collarBed = bind(q<SVGPathElement>(root, '.collar .bed'));
  const collarHalo = bind(q<SVGPathElement>(root, '.collar .halo'));
  const collarArc = bind(q<SVGPathElement>(root, '.collar .arc'));

  /** The sim's own tier thresholds, so the collar's thirds can never drift. */
  const THRESHOLDS = ctx.config.kart.drift.tiers.map((t) => t.at);

  /**
   * Charge → 0..1 around the collar, one equal third per tier.
   *
   * Past purple the meter is simply full: the sim keeps accruing a little
   * further, and a bar that carries on creeping after the last tier has landed
   * is a bar telling the player about something they cannot spend.
   */
  function collarFill(charge: number): number {
    let lo = 0;
    for (let i = 0; i < THRESHOLDS.length; i++) {
      const hi = THRESHOLDS[i]!;
      if (charge < hi) return (i + (charge - lo) / Math.max(1e-3, hi - lo)) / THRESHOLDS.length;
      lo = hi;
    }
    return 1;
  }

  /** Two identical icon stacks; the reel cross-fades between them. */
  const layers: Array<{ box: Bound; faces: Map<string, SVGElement>; shown: string }> = [];
  for (const cls of ['.face.a', '.face.b']) {
    const box = q(root, cls);
    const faces = new Map<string, SVGElement>();
    for (const svg of Array.from(box.querySelectorAll<SVGElement>('svg'))) {
      faces.set(svg.dataset.face ?? '', svg);
    }
    layers.push({ box: bind(box), faces, shown: '' });
  }

  let front = 0;
  /** 0..1 through the current icon-to-icon slide. */
  let roll = 1;
  let rollDur = 0.1;

  let spinning = false;
  let spinTime = 0;
  let nextTick = 0;
  let reelIndex = 0;

  let heldId: ItemId | null = null;
  let heldCount = 0;
  let punch = 0;
  let ejecting = 0;
  let badgePunch = 0;
  let glowAmount = 0;
  let jitter = 0;
  let clock = 0;

  /** Collar state: how far round it is drawn, and how lit it is. */
  let collar = 0;
  let collarLive = 0;
  let boostFlare = 0;

  const unsubs: Array<() => void> = [];

  function showFace(id: ItemId | null, dur: number): void {
    const key = id ?? '';
    const cur = layers[front]!;
    if (cur.shown === key) return;
    const next = layers[front ^ 1]!;
    if (next.shown) next.faces.get(next.shown)?.classList.remove('on');
    next.shown = key;
    if (key) next.faces.get(key)?.classList.add('on');
    front ^= 1;
    roll = 0;
    rollDur = dur;
  }

  function setGlow(hex: number, amount: number): void {
    glowAmount = Math.max(glowAmount, amount);
    glow.set('background',
      `radial-gradient(circle, ${rgba(hex, 0.95)}, ${rgba(hex, 0)} 62%)`);
  }

  unsubs.push(ctx.bus.on<{ racer: Racer; phase: 'start' | 'settle' }>('item:roulette', (e) => {
    if (!e.racer.isPlayer) return;
    if (e.phase === 'start') {
      spinning = true;
      spinTime = 0;
      nextTick = 0;
      setGlow(0xFFF0C4, 0.55);
    } else {
      // The icon itself comes from the racer's own state on the next frame —
      // one source of truth for what is in the slot. All this has to do is stop
      // the reel.
      spinning = false;
    }
  }));

  // A carried item that eats a shell for you is spent without being used: the
  // slot has to report that as a *loss*, not as a quiet decrement.
  unsubs.push(ctx.bus.on<{ racer: Racer }>('item:block', (e) => {
    if (!e.racer.isPlayer) return;
    punch = Math.max(punch, 0.8);
    setGlow(0xFFFFFF, 0.85);
  }));

  // The collar spends its charge the moment the boost fires: a full white ring
  // blowing outward off the socket. It is the release half of the mini-turbo,
  // and without it the meter simply vanishes at the instant it mattered most.
  unsubs.push(ctx.bus.on<{ racer: Racer }>('kart:boost', (e) => {
    if (!e.racer.isPlayer) return;
    boostFlare = 1;
  }));

  return {
    root,

    reset(): void {
      spinning = false;
      heldId = null;
      heldCount = 0;
      punch = 0;
      ejecting = 0;
      badgePunch = 0;
      glowAmount = 0;
      jitter = 0;
      clock = 0;
      roll = 1;
      front = 0;
      collar = 0;
      collarLive = 0;
      boostFlare = 0;
      collarBed.set('opacity', '0');
      collarHalo.set('opacity', '0');
      collarArc.set('opacity', '0');
      collarSvg.set('transform', 'none');
      // Both stacks emptied outright rather than rolled: a reset is not a
      // transition, and half a shell sliding out of the socket as the lights go
      // down for the next race is not a beat anybody asked for.
      for (const l of layers) {
        if (l.shown) l.faces.get(l.shown)?.classList.remove('on');
        l.shown = '';
        l.box.set('transform', 'none');
        l.box.set('opacity', '1');
      }
      slot.cls('empty', true);
      slot.set('transform', 'none');
      count.set('opacity', '0');
    },

    update(dt: number): void {
      clock += dt;
      const player = ctx.player;
      const id = player?.item ?? null;
      const n = player?.itemCount ?? 0;

      // ── the reel ─────────────────────────────────────────────────────────
      if (spinning) {
        spinTime += dt;
        // A roulette can be *cancelled* rather than settled: a lightning bolt
        // takes the draw out of the player's hand mid-spin and there is no
        // event for it. Without a stop of its own the reel would keep spinning
        // for the rest of the race over an empty slot.
        if (spinTime > ASSUMED_SPIN * 3) spinning = false;
        nextTick -= dt;
        if (nextTick <= 0) {
          // Fast at the top of the spin, slowing into the answer. The curve is
          // the same shape the item system uses for its own reel.
          const t = clamp01(spinTime / ASSUMED_SPIN);
          const gap = 0.05 + 0.11 * t * t;
          nextTick = gap;
          reelIndex = (reelIndex + 1) % REEL_FACES.length;
          showFace(REEL_FACES[reelIndex]!.id, gap * 0.8);
        }
        jitter = 1;
      } else {
        jitter = Math.max(0, jitter - dt * 6);
      }

      // ── what is actually in the slot ─────────────────────────────────────
      if (!spinning && id !== heldId) {
        if (id) {
          // It landed. This is the beat the whole widget exists for.
          showFace(id, 0.2);
          punch = 1;
          setGlow(ITEMS[id].color, 1);
          ejecting = 0;
        } else if (heldId) {
          // Spent, stolen or struck out of the player's hand.
          ejecting = 1;
          setGlow(ITEMS[heldId].color, 0.5);
        }
        heldId = id;
      }
      if (n !== heldCount) {
        if (heldId && n > 0 && n < heldCount) badgePunch = 1;
        heldCount = n;
        count.text(n > 1 ? `×${n}` : '');
      }

      if (ejecting > 0) {
        ejecting = Math.max(0, ejecting - dt * 4.5);
        if (ejecting === 0) showFace(null, 0.14);
      }

      // The hazard "?" waits for the spent item to finish leaving, or it pops in
      // behind an icon that is still on its way out.
      slot.cls('empty', !heldId && !spinning && ejecting <= 0);
      count.set('opacity', heldCount > 1 ? '1' : '0');

      // ── motion ───────────────────────────────────────────────────────────
      if (roll < 1) {
        roll = Math.min(1, roll + dt / Math.max(0.04, rollDur));
        const e = ease.outQuart(roll);
        // The reel runs upward: the old face leaves through the top of the
        // socket as the new one arrives from underneath it.
        layers[front]!.box.set('transform', `translateY(${((1 - e) * 108).toFixed(1)}%)`);
        layers[front ^ 1]!.box.set('transform', `translateY(${(-e * 108).toFixed(1)}%)`);
        layers[front]!.box.set('opacity', Math.min(1, e * 2.2).toFixed(2));
        layers[front ^ 1]!.box.set('opacity', Math.max(0, 1 - e * 1.6).toFixed(2));
      }

      if (punch > 0) punch = Math.max(0, punch - dt * 2.9);
      if (badgePunch > 0) badgePunch = Math.max(0, badgePunch - dt * 3.4);
      if (glowAmount > 0) glowAmount = Math.max(0, glowAmount - dt * 2.3);

      const shake = jitter > 0 ? Math.sin(clock * 52) * 0.028 * jitter : 0;
      const pop = 1 + punch * punch * 0.4 - ejecting * 0.12;
      slot.set('transform',
        `scale(${(pop + shake).toFixed(3)}) rotate(${(shake * 13).toFixed(2)}deg)`);

      // Idle float, so a held item never looks pasted on. Deliberately tiny:
      // this is a readout, and a readout that wanders is a readout that is hard
      // to read.
      const bob = heldId && !spinning ? Math.sin(clock * 2.3) * 2.2 : 0;
      reel.set('transform',
        `translateY(${bob.toFixed(2)}%) scale(${(1 + punch * 0.22 - ejecting * 0.25).toFixed(3)})`);
      reel.set('opacity', (1 - ejecting * 0.9).toFixed(2));

      glow.set('opacity', glowAmount > 0.004 ? (glowAmount * 0.95).toFixed(3) : '0');
      if (glowAmount > 0.004) {
        glow.set('transform', `scale(${(0.7 + (1 - glowAmount) * 0.7).toFixed(3)})`);
      }

      if (jitter > 0.004) {
        sweep.set('opacity', (0.75 * jitter).toFixed(2));
        sweep.set('transform', `translateY(${(((clock * 220) % 160) - 6).toFixed(1)}%)`);
      } else {
        sweep.set('opacity', '0');
      }

      count.set('transform', `scale(${(1 + badgePunch * 0.55).toFixed(3)})`);

      // ── the mini-turbo collar ────────────────────────────────────────────
      const drift = player?.drift;
      const charging = (drift?.active ?? false) && (drift?.charge ?? 0) > 0.02;
      if (boostFlare > 0) boostFlare = Math.max(0, boostFlare - dt * 1.45);

      // Most of a race is spent not drifting, and the whole block below builds a
      // handful of short strings a frame to hand the same values back to a write
      // cache that will throw them away. The dead state is one comparison.
      if (!charging && boostFlare <= 0.004 && collar <= 0.002 && collarLive <= 0.002) {
        collarArc.set('opacity', '0');
        collarHalo.set('opacity', '0');
        collarBed.set('opacity', '0');
        collarSvg.set('transform', 'none');
        return;
      }

      // The fill snaps to the charge on the way up — a meter that lags the thing
      // it measures is a meter that lies about when the tier landed — and eases
      // back to nothing on release, so the collar drains rather than blinking
      // out from under the boost it just paid for.
      const want = charging ? collarFill(drift?.charge ?? 0) : 0;
      collar = want > collar ? want : Math.max(want, collar - dt * 3.4);
      collarLive = charging
        ? Math.min(1, collarLive + dt * 8)
        : Math.max(0, collarLive - dt * 3.2);

      const flare = boostFlare * boostFlare;
      const hot = flare > 0.02;
      const tier = charging ? (drift?.tier ?? 0) : 0;
      const ring = TIER_RING[tier]!;
      // Every write below goes through the cache in `bind`, so re-deriving the
      // colour and the weights on every frame costs a string compare and a map
      // lookup — and buys the release beat, which needs a hue this ring never
      // wears while it is charging.
      const hex = hot ? '#FFF6D8' : hexCss(TIER_COLORS[tier]!);
      const width = hot ? Math.max(ring.stroke, 0.4) : ring.stroke;
      collarArc.set('stroke', hex);
      collarHalo.set('stroke', hex);
      collarArc.set('strokeWidth', (width * VB_PER_U).toFixed(2));
      collarHalo.set('strokeWidth', (width * ring.haloWidth * VB_PER_U).toFixed(2));

      // The release spends the charge: the collar snaps to a full ring and blows
      // outward off the socket as it fades. Without it the meter simply vanishes
      // at the instant it mattered most, which is the half of a mini-turbo the
      // player actually gets paid for.
      const shown = hot ? Math.max(collar, flare) : collar;
      if (shown > 0.002) {
        const len = shown * COLLAR_LEN;
        // **The gap is the rest of the perimeter, not something larger.**
        //
        // The dash pattern has to repeat with a period of exactly one lap of the
        // collar, because that is what makes the pattern *wrap*: offset by half
        // the dash and the fill then appears as `[0, len/2]` at the start of the
        // path and `[P - len/2, P]` at the end of it — one continuous band
        // growing out of twelve o'clock in both directions. With an
        // over-long gap there is no wrap, the second half of the dash falls off
        // the front of the path, and the collar fills clockwise down one side
        // only, which reads as a bar that has come loose rather than a charge.
        const gap = COLLAR_LEN - len;
        const dash = gap < 0.5 ? 'none' : `${len.toFixed(2)} ${gap.toFixed(2)}`;
        const off = (len * 0.5).toFixed(2);
        collarArc.set('strokeDasharray', dash);
        collarHalo.set('strokeDasharray', dash);
        collarArc.set('strokeDashoffset', off);
        collarHalo.set('strokeDashoffset', off);

        // Tier 3 is the one that never sits still: a fast shimmer on top of the
        // halo, so "purple" is a different *behaviour* and not only a hue.
        const shimmer = tier >= 3 ? 0.82 + 0.18 * Math.sin(clock * 21) : 1;
        collarArc.set('opacity', Math.max(collarLive, flare).toFixed(3));
        collarHalo.set('opacity',
          (Math.max(ring.halo * collarLive, flare) * shimmer).toFixed(3));
        collarBed.set('opacity', (collarLive * 0.5).toFixed(3));
      } else {
        collarArc.set('opacity', '0');
        collarHalo.set('opacity', '0');
        collarBed.set('opacity', '0');
      }
      collarSvg.set('transform', boostFlare > 0.004
        ? `scale(${(1 + (1 - boostFlare) * 0.26).toFixed(3)})`
        : 'none');
    },

    dispose(): void {
      for (const off of unsubs) off();
      unsubs.length = 0;
      root.remove();
    },
  };
}
