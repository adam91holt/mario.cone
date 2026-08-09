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
import { glyphBox, ordinalWord } from './glyphs.ts';
import { bind, fromHtml, q } from './theme.ts';

export const CSS_BANNERS = `
#hud .stage { position: absolute; inset: 0; overflow: hidden; }

/* ── countdown ───────────────────────────────────────────────────────────── */
/* **Where the road is.** At 32% the count landed square on the CONE CANYON
   gantry banner and the start-light board — two busy yellow objects, one of
   which is itself a signal the player is supposed to be reading. A countdown
   numeral wants the clear dark tarmac between the gantry and the player's own
   kart, and on the start grid that band sits just above the midline. Low enough
   to clear the gantry, high enough that a 250px digit never touches the kart. */
#hud .cd {
  position: absolute; left: 0; right: 0; top: 35%;
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
   same place at the same size is a metronome, not a countdown.

   Drawn glyphs, so all this rule sets is a height, the ink colour the face
   takes, and the heat coming off it. The outline and the bevel are geometry —
   see glyphs.ts. */
#hud .cd .n {
  height: calc(var(--u) * 14.2); color: #FFF8F0;
  filter: drop-shadow(0 0 calc(var(--u) * .9) rgba(255,180,60,.75));
}
#hud .cd.go .n { color: #8CFF5A;
  filter: drop-shadow(0 0 calc(var(--u) * 1.1) rgba(120,255,90,.85)); }
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
  position: relative; display: flex; align-items: flex-end;
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
#hud .band .b-title { height: calc(var(--u) * 3.2); color: #FFF8F0; }
#hud .band .b-sub { height: calc(var(--u) * 2); color: #FFD84D; margin-bottom: calc(var(--u) * .12); }
/* An empty detail must not leave a gap the size of a word behind the title. */
#hud .band .b-sub:empty { display: none; }
#hud .band.hot .plateau { background: linear-gradient(180deg, rgba(255,122,26,.97), rgba(150,44,0,.97)); }
#hud .band.hot .b-title { color: #FFF8F0; }
#hud .band.hot .b-sub { color: #FFF0C0; }
#hud .band.gold .plateau { background: linear-gradient(180deg, rgba(255,206,64,.97), rgba(168,104,0,.97)); }
#hud .band.gold .b-title, #hud .band.gold .b-sub { color: #FFF6D8; }

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
/* ...and gold when it is a win rather than a warning. Same tape, same snap, one
   hue apart — the frame is the game shouting, and it should be able to shout
   good news with the machinery it already has. */
#hud .alert-bar.win {
  background: repeating-linear-gradient(115deg,
    #FFD84D 0 calc(var(--u) * .7), #2A1E04 calc(var(--u) * .7) calc(var(--u) * 1.4));
  box-shadow: 0 0 calc(var(--u) * 1.4) rgba(255,216,77,.8);
}
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
  const cdNum = glyphBox(q(root, '.cd .n'));
  const cdRing = bind(q(root, '.cd .ring'));
  const band = bind(q(root, '.band'));
  const plateau = bind(q(root, '.plateau'));
  const sheen = bind(q(root, '.sheen'));
  const title = glyphBox(q(root, '.b-title'));
  const sub = glyphBox(q(root, '.b-sub'));
  const barT = bind(q(root, '.alert-bar.t'));
  const barB = bind(q(root, '.alert-bar.b'));

  // countdown
  let cdT = -1;
  let cdLife = 1;
  let isGo = false;
  /** The beat currently on screen, so the state check knows what it is looking at. */
  let shownBeat = -1;
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
    title.set(text);
    sub.set(detail);
    band.cls('hot', opts.style === 'hot');
    band.cls('gold', opts.style === 'gold');
    entrance = opts.entrance ?? 'slide';
    bandIn = entrance === 'slam' ? 0.34 : 0.28;
    bandHold = opts.hold ?? 1.5;
    bandOut = 0.34;
    bandT = 0;
  }

  /**
   * Show one beat of the count.
   *
   * Called from the bus — which is what makes it land on the exact frame the
   * director changed its mind — and again from `update` as a *state* check, for
   * the case the bus alone cannot cover: `__GAME.step()` advances the simulation
   * without ever calling `update`, so a capture can step straight through "3"
   * and "2" with this widget frozen, and then start drawing halfway through a
   * beat whose clock began several seconds of game time ago. Reading
   * `ctx.race.countdown` back means the digit on screen is always the digit the
   * simulation is on, whatever happened to the frames in between.
   */
  function beat(n: number): void {
    shownBeat = n;
    isGo = n <= 0;
    cdNum.set(isGo ? 'GO!' : String(n));
    cd.cls('go', isGo);
    cd.cls('beat2', n === 2);
    cd.cls('beat1', n === 1);
    // 3 → 2 → 1 → GO, each one bigger than the last. The escalation is the
    // countdown: without it the three digits are the same object appearing
    // three times and the player's foot has nothing to time against.
    cdScale = isGo ? 1.16 : n >= 3 ? 0.82 : n === 2 ? 0.94 : 1.08;
    cdT = 0;
    // **A count is replaced, not faded.** GO gets an exit because nothing comes
    // after it; a numeral does not, because the thing that ends "2" is "1"
    // arriving on top of it. The life here is longer than the director's own
    // one-second beat purely as a backstop — if a beat never arrives, the digit
    // retires on its own rather than hanging over the grid — and the fade only
    // runs inside its last fifth, which a beat that lands on time never reaches.
    cdLife = isGo ? 1.28 : 1.5;
  }

  unsubs.push(ctx.bus.on<{ n: number }>('race:countdown', ({ n }) => beat(n)));

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
      barT.cls('win', false);
      barB.cls('win', false);
    } else {
      show(`Lap ${starting}`, formatTime(split), { hold: 2.0 });
    }
  }));

  unsubs.push(ctx.bus.on<{ racer: Racer }>('race:rocketStart', ({ racer }) => {
    if (!racer.isPlayer) return;
    show('Rocket Start', '', { style: 'gold', hold: 0.85, entrance: 'slam' });
  }));

  // **The result, not the word "finish".**
  //
  // This used to read `FINISH  2:31.418`. The player already knows they have
  // finished — they have just driven under a chequered gantry with confetti
  // coming off it — and the one thing they have been working at for three laps,
  // the number that is the entire outcome of the race, was left to a corner
  // plate they are no longer looking at. The banner now *is* the result: the
  // place, at banner size, with the time as the footnote it is.
  unsubs.push(ctx.bus.on<{ racer: Racer; place: number; time: number }>('race:finish', (e) => {
    if (!e.racer.isPlayer) return;
    const place = e.place > 0 ? e.place : (e.racer.place || 1);
    show(`${place}${ordinalWord(place)} Place`, formatTime(e.time),
      { style: place === 1 ? 'gold' : 'plain', hold: 4.2, entrance: 'slam' });
    if (place === 1) {
      alertT = 1;
      barT.cls('win', true);
      barB.cls('win', true);
    }
  }));

  return {
    root,

    reset(): void {
      cdT = -1;
      bandT = -1;
      alertT = 0;
      cdScale = 1;
      shownBeat = -1;
      cd.cls('beat2', false);
      cd.cls('beat1', false);
      cd.set('opacity', '0');
      band.set('opacity', '0');
      barT.set('opacity', '0');
      barB.set('opacity', '0');
      barT.cls('win', false);
      barB.cls('win', false);
    },

    update(dt: number): void {
      // ── countdown ────────────────────────────────────────────────────────
      // State first: whatever the bus did or did not deliver while this widget
      // was not being drawn, the digit on screen is the one the race director is
      // actually counting. See `beat`.
      if (ctx.race.phase === 'countdown' && ctx.race.countdown !== shownBeat) {
        beat(ctx.race.countdown);
      }
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
        // A numeral photographed at half opacity is a numeral nobody designed.
        // The fade above is a backstop for a beat that never arrives; the beat
        // that does arrive replaces its predecessor at full strength.
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
        let x = 0, y = 0, scale = 1, alpha = 1, rot = 0;

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
          // **It leaves upward, not sideways.**
          //
          // The exit used to slide the whole band 70% of the viewport to the
          // right while fading. The band spans the frame, so what that actually
          // did was drag a half-transparent orange FINAL LAP sign across the
          // minimap plate and off the right edge — photographed mid-exit it read
          // as a layout bug, which is a wretched way to end the best moment in
          // the HUD. An exit's whole job is to get out of the way: this one
          // lifts a fraction of its own height, shrinks a little and goes, so it
          // never crosses another widget and never sits half-clipped by the
          // frame.
          const t = clamp01((bandT - bandIn - bandHold) / bandOut);
          const e = ease.inQuad(t);
          y = -e * 34;
          scale = 1 - e * 0.14;
          alpha = 1 - e;
          sheen.set('opacity', '0');
        }

        band.set('opacity', alpha.toFixed(3));
        band.set('transform', `translate(${x.toFixed(2)}%, ${y.toFixed(2)}%)`);
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
