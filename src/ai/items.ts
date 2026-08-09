// When a CPU spends what it is holding.
//
// The rule this file exists to enforce: **an item thrown at an empty road
// teaches the player that items are noise.** Every branch below asks a question
// about the world first — is there anybody there, is the road straight enough
// for a shell to reach them, is this the exit where a mushroom is worth double
// — and only fires when the answer is yes. Where the answer is no, the item is
// *kept*, which is itself a tactic: a trailing banana is a shield, and a
// mushroom in the hand is a shortcut you have not taken yet.
//
// The decision is expressed the way a human expresses it: as presses of the
// item button. `aim` items tap forward and hold backward (items/index.ts,
// `playerUse`), so the driver's button state machine can translate an intent
// into exactly the input a player would have produced. That keeps the CPU
// honest — it has no way to place a shell a human could not have placed.

import { clamp01, lerp } from '../core/math.ts';
import { ITEMS } from '../items/defs.ts';
import type { ItemId, Racer } from '../types.ts';

/** Everything the policy is allowed to know. Assembled by the driver. */
export interface ItemView {
  /** Seconds this item has been in hand. */
  held: number;
  /** Metres to the nearest rival up the road, Infinity if the road is clear. */
  aheadGap: number;
  /** Radians off our nose that rival sits. */
  aheadBearing: number;
  /** Metres to the nearest rival behind us. */
  behindGap: number;
  behindBearing: number;
  /** How many rivals are between us and the lead. */
  rivalsAhead: number;
  /** 0..1: how straight the next 50m is. 1 is a drag strip. */
  straightness: number;
  /** True while the wheels are on anything that is not tarmac. */
  offroad: boolean;
  /** True while the kart is on the marked gravel cut. */
  onCut: boolean;
  /** Metres to the start of the next gravel cut this driver intends to take. */
  cutIn: number;
  /** Speed as a fraction of the kart's own top speed. */
  speedFrac: number;
  /** Metres until the road stops bending. 0 on a straight. */
  cornerExitIn: number;
  place: number;
  fieldSize: number;
}

export interface ItemIntent {
  fire: boolean;
  /** Throw it up the road rather than laying it behind. */
  forward: boolean;
  /** Why, for the AI bench. Never read by the simulation. */
  why: string;
}

const HOLD: ItemIntent = { fire: false, forward: true, why: 'hold' };
/** Reused so a decision allocates nothing. Copied out immediately by the caller. */
const _out: ItemIntent = { fire: false, forward: true, why: '' };

const fire = (forward: boolean, why: string): ItemIntent => {
  _out.fire = true;
  _out.forward = forward;
  _out.why = why;
  return _out;
};

/** A shell only reaches a rival who is more or less in front of the nose. */
const inCone = (bearing: number, halfAngle: number): boolean =>
  Math.abs(bearing) < halfAngle;

/**
 * Decide what to do with what is in hand.
 *
 * `aggression` and `patience` come from the driver's profile: an aggressive
 * driver throws at longer range and holds less; a patient one waits for the
 * shot it cannot miss. That is the difference between a field that all fires at
 * once and a field where one kart is clearly stalking another.
 */
export function decideItem(
  racer: Racer, view: ItemView, aggression: number, patience: number,
): ItemIntent {
  const id = racer.item;
  if (!id) return HOLD;

  // Every item gets a beat in the hand first. Instant reflexes read as a
  // machine; a heartbeat reads as a decision.
  const def = ITEMS[id];
  if (view.held < def.aiDelay * lerp(1.3, 0.55, aggression)) return HOLD;

  /** Give up and use it. Nothing may sit in a hand for a whole lap. */
  const stale = lerp(9, 4.5, aggression);

  switch (id as ItemId) {
    // ── shields and traps ───────────────────────────────────────────────
    case 'banana': {
      // A held banana is a shield. Spend it when somebody is close enough that
      // it becomes a *mine* instead — and at the apex, where they have nowhere
      // to go around it.
      const chased = view.behindGap < lerp(18, 30, aggression)
        && inCone(view.behindBearing, 0.55);
      if (chased) return fire(false, 'trap the kart behind');
      if (view.cornerExitIn > 8 && view.behindGap < 55 && view.held > 3.5) {
        return fire(false, 'lay it on the apex');
      }
      if (view.held > stale + 4) return fire(false, 'stale');
      return HOLD;
    }

    case 'greenShell': {
      // Straight-line weapon: it only ever hits somebody it can see.
      const shot = view.aheadGap < lerp(34, 52, aggression)
        && inCone(view.aheadBearing, lerp(0.16, 0.28, aggression))
        && view.straightness > 0.45;
      if (shot) return fire(true, 'shot at the kart ahead');
      // Otherwise it is worth more sitting behind us as a mine, and more still
      // orbiting as a shield while somebody is lining us up.
      if (view.behindGap < 16) return fire(false, 'mine the kart behind');
      if (view.held > stale) return fire(true, 'stale');
      return HOLD;
    }

    case 'bomb': {
      // Wide blast: it does not need the accuracy a shell does, but it does
      // need somebody inside the radius by the time it gets there.
      if (view.aheadGap < 34 && inCone(view.aheadBearing, 0.5)) {
        return fire(true, 'lob it into the kart ahead');
      }
      if (view.behindGap < 22) return fire(false, 'drop it in their path');
      if (view.held > stale) return fire(true, 'stale');
      return HOLD;
    }

    case 'redShell': {
      // Homing, so range is what matters, not aim. Nothing to gain by holding
      // one when there is somebody to lock onto — but plenty by not wasting it
      // on a rival about to be out of reach anyway.
      if (view.place > 1 && view.aheadGap < 110) return fire(true, 'lock onto the kart ahead');
      if (view.held > stale) return fire(true, 'stale');
      return HOLD;
    }

    // ── speed ───────────────────────────────────────────────────────────
    case 'mushroom':
    case 'tripleMushroom': {
      // The whole point of this item is *where* it is spent.
      //
      // On the gravel cut it pays twice: it cancels the surface's speed cap for
      // the length of the detour, which is exactly the trade the cut is
      // designed around. Second best is a corner exit onto a straight, where a
      // boost is carried rather than scrubbed off in the next braking zone.
      // Spending it mid-corner throws most of it away.
      if (view.onCut) return fire(true, 'power through the cut');
      if (view.offroad && view.speedFrac < 0.7) return fire(true, 'dig out of the gravel');
      if (view.cutIn < 40 && view.cutIn > 0) return HOLD; // saving it for the cut
      const exit = view.cornerExitIn > 0 && view.cornerExitIn < 14
        && view.straightness > 0.35 && view.speedFrac > 0.45;
      if (exit) return fire(true, 'fire it off the corner exit');
      if (view.straightness > 0.8 && view.speedFrac > 0.6) return fire(true, 'spend it on the straight');
      if (view.held > stale + 3) return fire(true, 'stale');
      return HOLD;
    }

    case 'star': {
      // Invincibility is worth most where it is hardest to stay on the road, or
      // where there is traffic to drive straight through.
      const traffic = view.aheadGap < 26 || view.behindGap < 14;
      if (traffic || view.cornerExitIn > 10 || view.offroad) {
        return fire(true, 'seven seconds of not caring');
      }
      if (view.held > 2.5) return fire(true, 'no reason to wait');
      return HOLD;
    }

    case 'bulletBill': {
      // A rescue, not a weapon: worth most from the back, and wasted on a
      // straight where the kart was going to be fast anyway.
      const backmarker = view.place > view.fieldSize * 0.5;
      if (backmarker && view.straightness < 0.8) return fire(true, 'ride it back into the pack');
      if (view.held > stale) return fire(true, 'stale');
      return HOLD;
    }

    // ── field effects ───────────────────────────────────────────────────
    case 'lightning': {
      // Hits everybody but the user, so its value is the number of karts up the
      // road — and doubly so if any of them are in a place they can fall off.
      if (view.rivalsAhead >= 2) return fire(true, 'shrink the whole field ahead');
      if (view.held > stale) return fire(true, 'stale');
      return HOLD;
    }

    case 'blooper': {
      if (view.rivalsAhead >= 1 && view.held > 1.5) return fire(true, 'ink the leaders');
      if (view.held > stale) return fire(true, 'stale');
      return HOLD;
    }

    case 'boo': {
      // Steals from somebody ahead. Worth most when there is somebody ahead
      // *holding* something, which we cannot see — so: worth most from behind.
      if (view.place > 2) return fire(true, 'steal from up the road');
      if (view.held > stale) return fire(true, 'stale');
      return HOLD;
    }

    case 'horn': {
      // Its real job is eating a red shell, and a CPU cannot see one coming.
      // Close-quarters traffic is the next best use and the one a player can
      // read: the horn goes off when somebody is on the CPU's bumper.
      if (view.behindGap < 9 || view.aheadGap < 9) return fire(true, 'blast the traffic');
      if (view.held > stale) return fire(true, 'clear the air');
      return HOLD;
    }

    case 'coin':
    default:
      return fire(true, 'nothing to think about');
  }
}

/**
 * How long the button has to be held to express an intent.
 *
 * `aim` items read the *duration* of the press: under TAP_TIME (0.24s) throws
 * forward, longer lays it behind. `instant` items fire on the edge and do not
 * care. These numbers sit comfortably inside those windows so a step of jitter
 * cannot flip a forward throw into a backward one.
 */
export function pressDuration(id: ItemId, forward: boolean): number {
  if (ITEMS[id].mode === 'instant') return 0.05;
  return forward ? 0.10 : 0.42;
}

/** 0..1 straightness of the road over the next `span` metres. */
export function straightnessOf(curvature: number): number {
  return clamp01(1 - Math.abs(curvature) / 0.02);
}
