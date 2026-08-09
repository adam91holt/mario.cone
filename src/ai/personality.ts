// Who is driving.
//
// A field of CPUs separated only by a skill scalar is one driver with noise on
// it: everybody brakes in the same place, takes the same line and makes the
// same mistake, just more or less often. That reads as a difficulty slider, not
// as a race.
//
// So each CPU gets a *profile* — a small set of traits that reach into every
// decision the brain makes, and each of which has a visible consequence:
//
//   aggression   how close they will race, how hard they defend, whether they
//                lunge or wait. Shows up in wheel-to-wheel traffic.
//   consistency  how repeatable they are. Shows up as steering wander, a
//                braking point that moves lap to lap, and the mistake budget.
//   bravery      how close to the limit they *plan*. Shows up as the braking
//                point and as corner entry speed.
//   driftLove    appetite for committing, and for holding one to a higher tier.
//                Shows up as sparks and as mini-turbos out of corners.
//   apexShift    metres the apex is moved along the road. Negative turns in
//                early and unwinds early; positive holds the outside longer and
//                fires late. This is *cornering style*, and it is geometric —
//                two drivers with different shifts take physically different
//                paths through the same corner.
//   lineGain     how much of the road width they use.
//   patience     willingness to sit in a wake and let the draft do the work
//                rather than diving at the first gap.
//   greed        appetite for boost strips and the gravel cut.
//
// The archetypes below are deliberately extreme. A field assembled from them
// is legible from the grandstand: you can watch one lap and say "that one
// always runs wide", "that one is never off the road", "that one drifts
// everything".

import { clamp, clamp01, lerp } from '../core/math.ts';
import type { Rng } from '../core/math.ts';

export interface DriverProfile {
  readonly key: string;
  /** One line, for the AI bench and for anybody reading a trace. */
  readonly blurb: string;
  readonly aggression: number;
  readonly consistency: number;
  readonly bravery: number;
  readonly driftLove: number;
  /** Metres. Negative = early apex, positive = late apex. */
  readonly apexShift: number;
  readonly lineGain: number;
  readonly patience: number;
  readonly greed: number;
}

/**
 * Eight characters. The field takes seven of them, dealt from a shuffled bag so
 * a given seed always produces the same grid but two consecutive races do not
 * look identical.
 */
export const ARCHETYPES: readonly DriverProfile[] = [
  {
    key: 'metronome',
    blurb: 'never off the road, never off the line, never quite quick enough',
    aggression: 0.32, consistency: 0.98, bravery: 0.60, driftLove: 0.62,
    apexShift: -3, lineGain: 0.94, patience: 0.85, greed: 0.55,
  },
  {
    key: 'lateBraker',
    blurb: 'arrives at the corner far too fast and mostly gets away with it',
    aggression: 0.74, consistency: 0.58, bravery: 0.98, driftLove: 0.70,
    apexShift: 8, lineGain: 1.08, patience: 0.30, greed: 0.60,
  },
  {
    key: 'bulldozer',
    blurb: 'owns the inside line and will not be asked to give it back',
    aggression: 0.96, consistency: 0.72, bravery: 0.78, driftLove: 0.56,
    apexShift: -7, lineGain: 0.80, patience: 0.18, greed: 0.42,
  },
  {
    key: 'drifter',
    blurb: 'sideways through everything, chaining mini-turbos out of it',
    aggression: 0.58, consistency: 0.82, bravery: 0.80, driftLove: 1.00,
    apexShift: 2, lineGain: 1.12, patience: 0.55, greed: 0.70,
  },
  {
    key: 'opportunist',
    blurb: 'hits every boost strip and takes the gravel cut whenever it pays',
    aggression: 0.60, consistency: 0.88, bravery: 0.70, driftLove: 0.62,
    apexShift: 0, lineGain: 1.00, patience: 0.72, greed: 1.00,
  },
  {
    key: 'nervous',
    blurb: 'brakes early, weaves under pressure, occasionally lifts for nothing',
    aggression: 0.20, consistency: 0.42, bravery: 0.40, driftLove: 0.44,
    apexShift: -9, lineGain: 0.86, patience: 0.92, greed: 0.28,
  },
  {
    key: 'cruiser',
    blurb: 'immense down the straights, careful and wide through the corners',
    aggression: 0.44, consistency: 0.90, bravery: 0.54, driftLove: 0.48,
    apexShift: 5, lineGain: 1.10, patience: 0.78, greed: 0.50,
  },
  {
    key: 'scrapper',
    blurb: 'lunges at gaps that are not there, half of them turn out to be',
    aggression: 0.88, consistency: 0.52, bravery: 0.90, driftLove: 0.82,
    apexShift: 6, lineGain: 0.92, patience: 0.22, greed: 0.82,
  },
];

/**
 * The reference driver: what the harness' autopilot gets, and the fallback for
 * a driver built outside a race reset. Fast, tidy, no personality tics — a
 * capture wants a clean lap, not a character study.
 */
export const REFERENCE: DriverProfile = {
  key: 'reference',
  blurb: 'the tidy fast one the capture rig drives',
  // Tidy first, quick second. Every screenshot and every clip in the review
  // pipeline is filmed from this kart, so a tenth of lap time is worth far less
  // here than never being photographed halfway into the gravel.
  aggression: 0.50, consistency: 0.98, bravery: 0.80, driftLove: 0.80,
  apexShift: 0, lineGain: 1.00, patience: 0.70, greed: 0.80,
};

/**
 * Deal `count` distinct archetypes.
 *
 * Fisher-Yates off the race's own seeded rng, so the grid is reproducible for a
 * given seed and different between seeds. Beyond eight racers the bag refills,
 * which is correct: a twelve-kart field should contain two late brakers rather
 * than four drivers with no character at all.
 */
export function dealProfiles(rng: Rng, count: number): DriverProfile[] {
  const out: DriverProfile[] = [];
  const bag: DriverProfile[] = [];
  while (out.length < count) {
    if (bag.length === 0) {
      for (const a of ARCHETYPES) bag.push(a);
      for (let i = bag.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        const t = bag[i];
        bag[i] = bag[j];
        bag[j] = t;
      }
    }
    out.push(bag.pop() as DriverProfile);
  }
  return out;
}

/**
 * Bend a profile by the engine class' skill rating and by a little per-driver
 * scatter, so two races with the same archetype are not the same driver.
 *
 * Skill is the *floor* under bravery and consistency — at 50cc even the
 * bulldozer is slow and tidy, at 200cc even the nervous one is quick — while
 * the traits keep their relative order, which is what preserves the character.
 */
export function temper(base: DriverProfile, skill: number, rng: Rng): DriverProfile {
  const s = clamp01(skill);
  const jitter = (v: number, amount: number): number =>
    clamp01(v + rng.gauss() * amount);
  return {
    key: base.key,
    blurb: base.blurb,
    aggression: jitter(base.aggression, 0.06),
    // A poor driver is a scruffy driver. Consistency is the trait skill owns
    // most directly — it is what "worse" actually looks like from outside.
    consistency: jitter(lerp(base.consistency * 0.62, base.consistency, s), 0.04),
    bravery: jitter(lerp(base.bravery * 0.70, base.bravery, s), 0.05),
    driftLove: jitter(base.driftLove * lerp(0.72, 1, s), 0.05),
    apexShift: base.apexShift + rng.gauss() * 1.6,
    lineGain: clamp(base.lineGain + rng.gauss() * 0.04, 0.7, 1.2),
    patience: jitter(base.patience, 0.06),
    greed: jitter(base.greed * lerp(0.6, 1, s), 0.05),
  };
}
