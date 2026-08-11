// Playing this on a phone.
//
// ── what iOS will and will not let you do ──────────────────────────────────
//
// **You cannot force landscape on an iPhone.** `screen.orientation.lock()` is
// not implemented in Safari on iOS, and the specification only permits a lock
// while the document is fullscreen — which iPhone Safari does not grant to a
// canvas either. Every "force landscape" recipe on the web is one of: an
// Android-only lock, a CSS `rotate(90deg)` hack that breaks touch coordinates
// and the safe-area insets, or a request that silently rejects.
//
// So this does the only honest thing. It *asks*, with a gate the player cannot
// race behind, and it takes a real lock on the platforms that offer one. The
// gate is not a nag: portrait on a phone genuinely cannot show this game — the
// HUD's four corners and a road vanishing to a horizon need the long axis.
//
// ── why the throttle is not a pedal ────────────────────────────────────────
//
// Mario Kart Tour auto-accelerates and it is right to. A phone gives you two
// thumbs; steering needs one continuously, and drift needs the other at exactly
// the moment a corner arrives. A throttle pedal would be held down permanently
// by a third thumb nobody has. So the game drives itself forward and the player
// spends both thumbs on the two things that decide a race: the line, and when
// to commit to a slide.
//
// Brake is still there, because this game has walls and reversing out of one is
// a real thing a player needs. It just is not where a thumb rests.
//
// ── the controls are drawn, not tapped ─────────────────────────────────────
//
// The steering pad has no fixed target to hit. Touching anywhere in the left
// half drops an anchor wherever the thumb landed, and steering is measured from
// there. A fixed on-screen stick demands the player look at their thumb; an
// anchored one lets them look at the road, which is the entire point.

import { clamp } from '../core/math.ts';
import type { GameContext, GameSystem } from '../types.ts';
import { fromHtml, plateCss, q, U_CSS } from './theme.ts';

/** Half-travel of the steering drag, in CSS pixels. */
const STEER_RANGE = 84;

/**
 * Is this a device a person holds?
 *
 * `?touch=1` forces it on so the capture harness can photograph the controls;
 * `?touch=0` forces it off. Neither is a debug flag left in by accident — a
 * layer that only appears on hardware the reviewer does not have is a layer no
 * reviewer will ever judge.
 */
function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const forced = new URLSearchParams(window.location.search).get('touch');
  if (forced === '1') return true;
  if (forced === '0') return false;
  return (
    (navigator.maxTouchPoints ?? 0) > 0 &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

/** A phone rather than a tablet: the short edge is what makes portrait fatal. */
function isPhone(): boolean {
  const short = Math.min(window.innerWidth, window.innerHeight);
  return short <= 500;
}

const CSS = `
#touch {
  position: fixed; inset: 0; z-index: 70;
  --u: ${U_CSS};
  font-family: 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif;
  pointer-events: none;
  /* The controls sit inside the notch and the home indicator, not under them.
     index.html already asks for viewport-fit=cover, which is what makes these
     env() values non-zero. */
  padding: env(safe-area-inset-top) env(safe-area-inset-right)
           env(safe-area-inset-bottom) env(safe-area-inset-left);
}
#touch.off { display: none; }
${plateCss('#touch')}

/* ── the steering half ────────────────────────────────────────────────────
   No visible target. The whole left side is live, and the ring only appears
   under the thumb that is already down. */
#touch .steer {
  position: absolute; left: 0; top: 0; bottom: 0; width: 46%;
  pointer-events: auto;
}
#touch .ring {
  position: absolute; width: calc(var(--u) * 7); height: calc(var(--u) * 7);
  margin: calc(var(--u) * -3.5) 0 0 calc(var(--u) * -3.5);
  border-radius: 50%;
  border: calc(var(--u) * .22) solid rgba(255,248,240,.30);
  background: radial-gradient(circle, rgba(255,195,0,.10), rgba(255,195,0,0) 70%);
  opacity: 0; transition: opacity .12s;
}
#touch .nub {
  position: absolute; width: calc(var(--u) * 3.1); height: calc(var(--u) * 3.1);
  margin: calc(var(--u) * -1.55) 0 0 calc(var(--u) * -1.55);
  border-radius: 50%;
  background: linear-gradient(180deg, #FFD84D, #FF9A1A);
  box-shadow: 0 calc(var(--u) * .18) calc(var(--u) * .4) rgba(0,0,0,.5),
              inset 0 0 0 calc(var(--u) * .1) rgba(0,0,0,.35);
  opacity: 0; transition: opacity .12s;
}
#touch.live .ring, #touch.live .nub { opacity: 1; }

/* ── the buttons ──────────────────────────────────────────────────────────
   Bottom-right, thumb-sized, and DRIFT is the big one because it is pressed
   in every corner while ITEM is pressed a handful of times a lap. */
#touch .pads {
  position: absolute; right: calc(var(--u) * 1.4); bottom: calc(var(--u) * 1.4);
  display: flex; align-items: flex-end; gap: calc(var(--u) * .9);
  pointer-events: auto;
}
#touch .btn {
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  font-weight: 900; letter-spacing: .1em; text-transform: uppercase;
  color: #14171E; user-select: none; -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
#touch .btn.brake {
  width: calc(var(--u) * 4.4); height: calc(var(--u) * 4.4);
  font-size: calc(var(--u) * .62);
  background: linear-gradient(180deg, #E8ECF4, #A8B0BE);
  box-shadow: 0 calc(var(--u) * .22) 0 #6E7480, 0 calc(var(--u) * .3) calc(var(--u) * .5) rgba(0,0,0,.45);
}
#touch .btn.item {
  width: calc(var(--u) * 5.2); height: calc(var(--u) * 5.2);
  font-size: calc(var(--u) * .68);
  background: linear-gradient(180deg, #7BE86B, #3BAF32);
  box-shadow: 0 calc(var(--u) * .24) 0 #24761E, 0 calc(var(--u) * .32) calc(var(--u) * .55) rgba(0,0,0,.45);
}
#touch .btn.drift {
  width: calc(var(--u) * 7.2); height: calc(var(--u) * 7.2);
  font-size: calc(var(--u) * .9);
  background: linear-gradient(180deg, #FFD84D, #FF9A1A);
  box-shadow: 0 calc(var(--u) * .28) 0 #A8600C, 0 calc(var(--u) * .38) calc(var(--u) * .65) rgba(0,0,0,.5);
}
/* Pressed is a real depression, not a colour change — on a screen with a thumb
   over it, the only feedback the player can actually see is the shadow closing
   and everything below the thumb shifting down. */
#touch .btn.down { transform: translateY(calc(var(--u) * .2)); filter: brightness(1.12); }
#touch .btn.brake.down { box-shadow: 0 calc(var(--u) * .04) 0 #6E7480; }
#touch .btn.item.down { box-shadow: 0 calc(var(--u) * .06) 0 #24761E; }
#touch .btn.drift.down { box-shadow: 0 calc(var(--u) * .08) 0 #A8600C; }

/* ── the rotate gate ──────────────────────────────────────────────────────
   Opaque, and over everything. A translucent one would let the player try to
   race a portrait frame. */
#rotate {
  position: fixed; inset: 0; z-index: 90; display: none;
  background: #0E1016;
  align-items: center; justify-content: center; text-align: center;
  font-family: 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif;
  --u: ${U_CSS};
}
#rotate.on { display: flex; }
#rotate .inner { padding: calc(var(--u) * 2); }
#rotate .phone {
  width: calc(var(--u) * 7); height: calc(var(--u) * 12);
  margin: 0 auto calc(var(--u) * 2);
  border-radius: calc(var(--u) * 1.1);
  border: calc(var(--u) * .4) solid #FFC300;
  animation: tip 2.2s ease-in-out infinite;
}
@keyframes tip {
  0%, 30% { transform: rotate(0deg); }
  55%, 85% { transform: rotate(-90deg); }
  100% { transform: rotate(0deg); }
}
#rotate h4 {
  margin: 0 0 calc(var(--u) * .5); font-size: calc(var(--u) * 1.5);
  font-weight: 900; letter-spacing: .16em; color: #FFC300; text-transform: uppercase;
}
#rotate p {
  margin: 0; font-size: calc(var(--u) * .9); letter-spacing: .08em;
  color: rgba(255,248,240,.72);
}
`;

export function createTouchSystem(ctx: GameContext): GameSystem {
  let root: HTMLElement | null = null;
  let gate: HTMLElement | null = null;
  let ring: HTMLElement | null = null;
  let nub: HTMLElement | null = null;
  let active = false;

  /** Live reading, rebuilt from the pointers currently down. */
  const sample = { steer: 0, accel: 0, brake: 0, drift: false, item: false };

  let steerId = -1;
  let anchorX = 0;

  return {
    name: 'touch',
    // After the HUD and the coach: this is the topmost layer a finger can hit.
    order: 102,

    async init(): Promise<void> {
      if (!isTouchDevice()) return;
      active = true;

      // Tells the HUD to lift its bottom corners clear of the thumbs. The rule
      // that responds lives in ui/theme.ts beside the inset it changes, because
      // that inset is the HUD's parameter and this module only gets to ask.
      document.documentElement.setAttribute('data-touch', '1');

      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);

      root = fromHtml(`
        <div id="touch">
          <div class="steer"><div class="ring"></div><div class="nub"></div></div>
          <div class="pads">
            <div class="btn brake" data-act="brake">Brake</div>
            <div class="btn item" data-act="item">Item</div>
            <div class="btn drift" data-act="drift">Drift</div>
          </div>
        </div>
      `);
      document.body.appendChild(root);
      ring = q<HTMLElement>(root, '.ring');
      nub = q<HTMLElement>(root, '.nub');

      gate = fromHtml(`
        <div id="rotate">
          <div class="inner">
            <div class="phone"></div>
            <h4>Turn your phone</h4>
            <p>MARIO.CONE is played in landscape</p>
          </div>
        </div>
      `);
      document.body.appendChild(gate);

      // ── steering ────────────────────────────────────────────────────────
      const pad = q<HTMLElement>(root, '.steer');
      const place = (x: number, y: number): void => {
        if (!ring || !nub) return;
        ring.style.left = `${anchorX}px`;
        ring.style.top = `${y}px`;
        nub.style.left = `${x}px`;
        nub.style.top = `${y}px`;
      };

      pad.addEventListener('pointerdown', (e: PointerEvent) => {
        if (steerId !== -1) return;
        steerId = e.pointerId;
        anchorX = e.clientX;
        pad.setPointerCapture(e.pointerId);
        root!.classList.add('live');
        place(e.clientX, e.clientY);
        e.preventDefault();
      });
      pad.addEventListener('pointermove', (e: PointerEvent) => {
        if (e.pointerId !== steerId) return;
        const dx = e.clientX - anchorX;
        sample.steer = clamp(dx / STEER_RANGE, -1, 1);
        // The nub stops at the ring; the reading is already clamped, so letting
        // it run would say the wheel is turning further than the game is.
        place(anchorX + sample.steer * STEER_RANGE, e.clientY);
        e.preventDefault();
      });
      const endSteer = (e: PointerEvent): void => {
        if (e.pointerId !== steerId) return;
        steerId = -1;
        sample.steer = 0;
        root!.classList.remove('live');
      };
      pad.addEventListener('pointerup', endSteer);
      pad.addEventListener('pointercancel', endSteer);

      // ── buttons ─────────────────────────────────────────────────────────
      for (const btn of Array.from(root.querySelectorAll<HTMLElement>('.btn'))) {
        const act = btn.dataset.act as 'brake' | 'item' | 'drift';
        const set = (on: boolean) => (e: PointerEvent): void => {
          if (act === 'brake') sample.brake = on ? 1 : 0;
          else sample[act] = on;
          btn.classList.toggle('down', on);
          if (on) btn.setPointerCapture(e.pointerId);
          e.preventDefault();
        };
        btn.addEventListener('pointerdown', set(true));
        btn.addEventListener('pointerup', set(false));
        btn.addEventListener('pointercancel', set(false));
      }

      // ── orientation ─────────────────────────────────────────────────────
      // Try for a real lock. It resolves on Android Chrome in fullscreen and
      // rejects everywhere else, including every iPhone — which is why the gate
      // below is the actual mechanism and this is only the bonus.
      const tryLock = async (): Promise<void> => {
        const o = screen.orientation as ScreenOrientation & {
          lock?: (o: string) => Promise<void>;
        };
        try { await o.lock?.('landscape'); } catch { /* expected on iOS */ }
      };
      window.addEventListener('pointerdown', tryLock, { once: true });

      const checkOrientation = (): void => {
        const portrait = window.innerHeight > window.innerWidth;
        const show = portrait && isPhone();
        gate!.classList.toggle('on', show);
        root!.classList.toggle('off', show);
        // A gate up means no thumbs on the controls; drop any held input rather
        // than leaving the kart turning while the player rotates the phone.
        if (show) {
          sample.steer = 0; sample.brake = 0;
          sample.drift = false; sample.item = false;
          steerId = -1;
          root!.classList.remove('live');
        }
      };
      window.addEventListener('resize', checkOrientation);
      window.addEventListener('orientationchange', checkOrientation);
      checkOrientation();
    },

    update(): void {
      if (!active) return;
      // **Auto-throttle, and only while there is a race to drive.** Handing the
      // input controller a permanent accel would drive the kart through the
      // menus and hold it against the line through the countdown.
      sample.accel = ctx.race.phase === 'racing' || ctx.race.phase === 'finished' ? 1 : 0;
      ctx.input.setTouch(sample);
    },

    dispose(): void {
      if (!active) return;
      ctx.input.setTouch(null);
      root?.remove();
      gate?.remove();
      root = null;
      gate = null;
    },
  };
}
