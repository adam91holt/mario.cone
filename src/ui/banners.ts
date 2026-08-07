// The things the HUD says out loud: the countdown, the lap split, the final-lap
// alert and the flag.
//
// A banner is the only part of a HUD that is allowed to interrupt, so each one
// here is paid for by a moment that actually deserves the screen: the lights
// going out, a lap going in the book, the last lap starting, the race ending.
// Nothing else gets a band.
//
// Two entrances, deliberately different. A lap split *slides* — it is
// information, it arrives from the side and leaves the same way without ever
// asking the player to stop driving. The final lap *slams* — it comes in at
// double size with hazard bars snapping across the top and bottom of the frame,
// because a player who misses the fact that they are on the last lap has been
// failed by the interface.

import { clamp01, ease, formatTime } from '../core/math.ts';
import type { GameContext, Racer } from '../types.ts';
import { bind, fromHtml, q } from './theme.ts';

export const CSS_BANNERS = `
#hud .stage { position: absolute; inset: 0; overflow: hidden; }

/* ── countdown ───────────────────────────────────────────────────────────── */
/* Raised from 42%: the numerals are half again as tall as they were, and a box
   that hangs *below* the midline with a 285px digit in it puts the count on the
   player's own kart rather than above it. */
#hud .cd {
  position: absolute; left: 0; right: 0; top: 32%;
  display: grid; place-items: center; opacity: 0;
}
#hud .cd .ring {
  position: absolute;
  width: calc(var(--u) * 17); height: calc(var(--u) * 17);
  border-radius: 50%; opacity: 0;
  box-shadow: 0 0 0 calc(var(--u) * .5) rgba(255,248,240,.85),
              0 0 calc(var(--u) * 3.4) rgba(255,190,80,.6);
}
/* The lights are the loudest thing this game does before the race starts, so
   the numerals are sized like it: about a fifth of the frame's height at "3"
   and a quarter by "1". Each beat is also a different colour — white, gold,
   hazard orange, then green — because three identical digits appearing in the
   same place at the same size is a metronome, not a countdown. */
#hud .cd .n {
  font-size: calc(var(--u) * 14); font-weight: 900; line-height: 1;
  letter-spacing: -.05em; color: #FFF8F0;
  text-shadow:
    .035em .035em 0 rgba(14,17,24,.96), -.035em .035em 0 rgba(14,17,24,.96),
    .035em -.035em 0 rgba(14,17,24,.96), -.035em -.035em 0 rgba(14,17,24,.96),
    0 .05em 0 rgba(14,17,24,.96),
    0 .07em 0 rgba(0,0,0,.55),
    0 0 .22em rgba(255,180,60,.75);
}
#hud .cd.go .n { color: #8CFF5A; text-shadow:
    .035em .035em 0 rgba(8,26,10,.96), -.035em .035em 0 rgba(8,26,10,.96),
    .035em -.035em 0 rgba(8,26,10,.96), -.035em -.035em 0 rgba(8,26,10,.96),
    0 .05em 0 rgba(8,26,10,.96),
    0 .07em 0 rgba(0,0,0,.55),
    0 0 .24em rgba(120,255,90,.8); }
/* Two, and then one: hotter, heavier, closer. */
#hud .cd.beat2 .n { color: #FFE9A8; }
#hud .cd.beat1 .n { color: #FFB13A; }

/* ── the band ────────────────────────────────────────────────────────────── */
#hud .band {
  position: absolute; left: 0; right: 0; top: 21%;
  display: flex; justify-content: center; opacity: 0;
}
/* Skewed rather than clipped: a parallelogram plate is the one shape that says
   "sign on a roadworks trailer" from a single glance, and skew composes with
   the entrance transform without needing a second element. */
#hud .band .plateau {
  position: relative; display: flex; align-items: baseline;
  gap: calc(var(--u) * 1.1);
  padding: calc(var(--u) * .5) calc(var(--u) * 2.6);
  transform: skewX(-9deg);
  background: linear-gradient(180deg, rgba(46,53,68,.96), rgba(15,18,25,.96));
  box-shadow:
    inset 0 calc(var(--u) * .12) 0 rgba(255,255,255,.25),
    0 0 0 calc(var(--u) * .14) rgba(9,11,15,.95),
    0 calc(var(--u) * .3) calc(var(--u) * .9) rgba(0,0,0,.55);
  overflow: hidden;
}
#hud .band .plateau > * { transform: skewX(9deg); }
/* Hazard end caps. */
#hud .band .plateau::before, #hud .band .plateau::after {
  content: ''; position: absolute; top: 0; bottom: 0; width: calc(var(--u) * 1.1);
  background: repeating-linear-gradient(115deg,
    #FFC300 0 calc(var(--u) * .42), #1A1E28 calc(var(--u) * .42) calc(var(--u) * .84));
  opacity: .95;
}
#hud .band .plateau::before { left: 0; }
#hud .band .plateau::after { right: 0; }
#hud .band .sheen {
  position: absolute; top: 0; bottom: 0; left: 0; width: 22%;
  background: linear-gradient(100deg, rgba(255,255,255,0), rgba(255,255,255,.3), rgba(255,255,255,0));
  opacity: 0; pointer-events: none; transform: none;
}
#hud .band .b-title {
  font-size: calc(var(--u) * 3.1); font-weight: 900; letter-spacing: .02em;
  text-transform: uppercase; color: #FFF8F0; white-space: nowrap;
  text-shadow:
    .035em .035em 0 rgba(10,13,19,.9), -.035em .035em 0 rgba(10,13,19,.9),
    .035em -.035em 0 rgba(10,13,19,.9), -.035em -.035em 0 rgba(10,13,19,.9),
    0 .09em 0 rgba(0,0,0,.6);
}
#hud .band .b-sub {
  font-size: calc(var(--u) * 1.8); font-weight: 900; color: #FFD84D;
  font-variant-numeric: tabular-nums; white-space: nowrap;
  text-shadow: 0 calc(var(--u) * .12) 0 rgba(0,0,0,.6);
}
/* An empty detail must not leave a gap the size of a word behind the title. */
#hud .band .b-sub:empty { display: none; }
#hud .band.hot .plateau { background: linear-gradient(180deg, rgba(255,122,26,.97), rgba(150,44,0,.97)); }
#hud .band.hot .b-title { color: #FFF8F0; }
#hud .band.hot .b-sub { color: #FFF0C0; }
#hud .band.gold .plateau { background: linear-gradient(180deg, rgba(255,206,64,.97), rgba(168,104,0,.97)); }
#hud .band.gold .b-title, #hud .band.gold .b-sub { color: #1A1206; text-shadow: 0 calc(var(--u) * .1) 0 rgba(255,255,255,.35); }

/* ── the alert frame ─────────────────────────────────────────────────────── */
/* Hazard tape snapping across the top and bottom of the frame. It is the loudest
   thing this HUD can do and it is spent exactly once a race. */
#hud .alert-bar {
  position: absolute; left: -10%; right: -10%; height: calc(var(--u) * .62);
  background: repeating-linear-gradient(115deg,
    #FF6B1A 0 calc(var(--u) * .7), #14171F calc(var(--u) * .7) calc(var(--u) * 1.4));
  opacity: 0;
  box-shadow: 0 0 calc(var(--u) * 1.2) rgba(255,107,26,.7);
}
#hud .alert-bar.t { top: 0; }
#hud .alert-bar.b { bottom: 0; }
`;

type Entrance = 'slide' | 'slam';

export interface Banners {
  readonly root: HTMLElement;
  update(dt: number): void;
  reset(): void;
  dispose(): void;
}

export function createBanners(ctx: GameContext): Banners {
  const root = fromHtml(`
    <div class="stage">
      <div class="alert-bar t"></div>
      <div class="alert-bar b"></div>
      <div class="cd"><div class="ring"></div><div class="n"></div></div>
      <div class="band">
        <div class="plateau">
          <span class="b-title"></span><span class="b-sub"></span>
          <div class="sheen"></div>
        </div>
      </div>
    </div>
  `);

  const cd = bind(q(root, '.cd'));
  const cdNum = bind(q(root, '.cd .n'));
  const cdRing = bind(q(root, '.cd .ring'));
  const band = bind(q(root, '.band'));
  const plateau = bind(q(root, '.plateau'));
  const sheen = bind(q(root, '.sheen'));
  const title = bind(q(root, '.b-title'));
  const sub = bind(q(root, '.b-sub'));
  const barT = bind(q(root, '.alert-bar.t'));
  const barB = bind(q(root, '.alert-bar.b'));

  // countdown
  let cdT = -1;
  let cdLife = 1;
  let isGo = false;
  /** Each beat lands bigger than the one before it. GO is the biggest. */
  let cdScale = 1;

  // band
  let bandT = -1;
  let bandIn = 0.3;
  let bandHold = 1.5;
  let bandOut = 0.34;
  let entrance: Entrance = 'slide';

  // alert frame
  let alertT = 0;

  const unsubs: Array<() => void> = [];

  function show(text: string, detail: string, opts: {
    style?: 'plain' | 'hot' | 'gold'; hold?: number; entrance?: Entrance;
  } = {}): void {
    title.text(text);
    sub.text(detail);
    band.cls('hot', opts.style === 'hot');
    band.cls('gold', opts.style === 'gold');
    entrance = opts.entrance ?? 'slide';
    bandIn = entrance === 'slam' ? 0.34 : 0.28;
    bandHold = opts.hold ?? 1.5;
    bandOut = 0.34;
    bandT = 0;
  }

  unsubs.push(ctx.bus.on<{ n: number }>('race:countdown', ({ n }) => {
    isGo = n <= 0;
    cdNum.text(isGo ? 'GO!' : String(n));
    cd.cls('go', isGo);
    cd.cls('beat2', n === 2);
    cd.cls('beat1', n === 1);
    // 3 → 2 → 1 → GO, each one bigger than the last. The escalation is the
    // countdown: without it the three digits are the same object appearing
    // three times and the player's foot has nothing to time against.
    cdScale = isGo ? 1.16 : n >= 3 ? 0.82 : n === 2 ? 0.94 : 1.08;
    cdT = 0;
    // GO lives longer than a count: it is the moment, not the metronome. A
    // numeral holds for its whole second and hands over to the next one — the
    // director emits these exactly a second apart, so the beat is the clock's,
    // not this widget's.
    cdLife = isGo ? 1.28 : 1.0;
  }));

  unsubs.push(ctx.bus.on<{ racer: Racer; lap: number }>('race:lap', ({ racer, lap }) => {
    if (!racer.isPlayer) return;
    const times = racer.lapTimes;
    const last = times.length ? times[times.length - 1]! : ctx.race.time;
    const prev = times.length > 1 ? times[times.length - 2]! : 0;
    const split = Math.max(0, last - prev);
    // `lap` is the lap just completed; the one starting is the next one.
    const starting = lap + 1;
    if (starting > ctx.race.totalLaps) return;
    if (starting === ctx.race.totalLaps) {
      // **No split on this one.** The last lap is an instruction, not a result:
      // the whole beat is "everything changes now", and a stopwatch reading
      // hanging off the end of it is the interface hedging. The ordinary lap
      // banner keeps its split, because "was that lap quicker than the last
      // one?" is the one time in a Grand Prix a number is worth reading.
      show('Final Lap', '', { style: 'hot', hold: 2.6, entrance: 'slam' });
      alertT = 1;
    } else {
      show(`Lap ${starting}`, formatTime(split), { hold: 2.0 });
    }
  }));

  unsubs.push(ctx.bus.on<{ racer: Racer }>('race:rocketStart', ({ racer }) => {
    if (!racer.isPlayer) return;
    show('Rocket Start', '', { style: 'gold', hold: 0.85, entrance: 'slam' });
  }));

  unsubs.push(ctx.bus.on<{ racer: Racer; place: number; time: number }>('race:finish', (e) => {
    if (!e.racer.isPlayer) return;
    show('Finish', formatTime(e.time), { style: 'gold', hold: 3.4, entrance: 'slam' });
  }));

  return {
    root,

    reset(): void {
      cdT = -1;
      bandT = -1;
      alertT = 0;
      cdScale = 1;
      cd.cls('beat2', false);
      cd.cls('beat1', false);
      cd.set('opacity', '0');
      band.set('opacity', '0');
      barT.set('opacity', '0');
      barB.set('opacity', '0');
    },

    update(dt: number): void {
      // ── countdown ────────────────────────────────────────────────────────
      if (cdT >= 0) {
        cdT += dt;
        const t = cdT;
        // Punch in over a third of a second, hold at full strength, then let go
        // in the last fifth. Holding matters: the review harness photographs
        // whatever frame it lands on, and a numeral that spends most of its life
        // half-faded is a numeral that is half-faded in every screenshot.
        const grow = ease.outBack(clamp01(t / 0.3));
        // ...and the moment the lights go out, the count goes with them. Without
        // this a seek straight into 'racing' can leave a "2" hanging over a kart
        // that is already at full speed.
        const stale = !isGo && ctx.race.phase !== 'countdown' && ctx.race.phase !== 'intro';
        const fade = stale ? 1 : clamp01((t - (cdLife - 0.22)) / 0.22);
        const scale = (0.45 + grow * 0.55) * cdScale + fade * 0.45;
        cd.set('opacity', (1 - fade).toFixed(3));
        cd.set('transform', `scale(${scale.toFixed(3)})`);

        // A shock ring leaving the numeral, once per beat.
        const rt = clamp01(t / 0.5);
        cdRing.set('opacity', rt < 1 ? ((1 - rt) * 0.7).toFixed(3) : '0');
        cdRing.set('transform', `scale(${(0.35 + ease.outQuart(rt) * 2.3).toFixed(3)})`);

        if (t >= cdLife) {
          cdT = -1;
          cd.set('opacity', '0');
        }
      }

      // ── band ─────────────────────────────────────────────────────────────
      if (bandT >= 0) {
        bandT += dt;
        const total = bandIn + bandHold + bandOut;
        let x = 0, scale = 1, alpha = 1, rot = 0;

        if (bandT < bandIn) {
          const t = bandT / bandIn;
          if (entrance === 'slam') {
            // Arrives on top of the player, from nowhere, with a shake.
            const e = ease.outQuart(t);
            scale = 2.4 - e * 1.4;
            alpha = Math.min(1, t * 3.6);
            rot = (1 - e) * (t < 0.5 ? -3.5 : 2.4);
          } else {
            const e = ease.outQuart(t);
            // Percentages here are of the *band*, which spans the viewport — so
            // this is a slide of about half a screen, not the four screens a
            // naive -130% would ask for in the same quarter of a second.
            x = (e - 1) * 45;
            alpha = Math.min(1, t * 3);
            scale = 1.06 - e * 0.06;
          }
        } else if (bandT < bandIn + bandHold) {
          const held = bandT - bandIn;
          // Settle: a little overshoot bleeding off, so the plate is never truly
          // static while it is on screen.
          const s = Math.exp(-held * 7) * Math.sin(held * 26);
          scale = 1 + s * 0.035;
          rot = s * 1.1;
          // A highlight running the length of the plate, once a second or so.
          // The travel is in multiples of the *sheen's* own width (22% of the
          // plate), so -120% to 560% is one clean pass edge to edge.
          const sweep = (held % 1.15) / 1.15;
          sheen.set('opacity', sweep < 0.55 ? '0.9' : '0');
          sheen.set('transform', `translateX(${(-120 + sweep * 1240).toFixed(1)}%) skewX(9deg)`);
        } else {
          const t = clamp01((bandT - bandIn - bandHold) / bandOut);
          x = ease.inQuad(t) * 70;
          alpha = 1 - ease.inQuad(t);
          sheen.set('opacity', '0');
        }

        band.set('opacity', alpha.toFixed(3));
        band.set('transform', `translateX(${x.toFixed(2)}%)`);
        plateau.set('transform',
          `skewX(-9deg) scale(${scale.toFixed(3)}) rotate(${rot.toFixed(2)}deg)`);

        if (bandT >= total) {
          bandT = -1;
          band.set('opacity', '0');
        }
      }

      // ── alert frame ──────────────────────────────────────────────────────
      if (alertT > 0) {
        alertT = Math.max(0, alertT - dt * 0.34);
        const t = 1 - alertT;
        const inT = ease.outQuart(clamp01(t * 6));
        const pulse = 0.55 + 0.45 * Math.abs(Math.sin(t * 11));
        const a = (alertT > 0.15 ? 1 : alertT / 0.15) * pulse;
        barT.set('opacity', a.toFixed(3));
        barB.set('opacity', a.toFixed(3));
        barT.set('transform', `translateY(${((1 - inT) * -100).toFixed(1)}%)`);
        barB.set('transform', `translateY(${((1 - inT) * 100).toFixed(1)}%)`);
        if (alertT === 0) {
          barT.set('opacity', '0');
          barB.set('opacity', '0');
        }
      }
    },

    dispose(): void {
      for (const off of unsubs) off();
      unsubs.length = 0;
      root.remove();
    },
  };
}
