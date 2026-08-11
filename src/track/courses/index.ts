// Course registry.
//
// Add a course by importing it and dropping it in the array. Everything else —
// course select, minimap, cups — reads from here, so nothing else needs editing.
//
// The order is the order the Hazard Cup runs in, and it is a deliberate
// sequence rather than the order they were built. Each round asks for something
// the one before it did not — and asks it with a different *lap structure*, not
// only a different set of corners.
//
//   1  Cone Canyon Speedway   3 laps · 4 strips · 1 cut · no surface hazard
//                             2.38km, and the open one: a 330-metre pit
//                             straight, 30m of road at the line, and one
//                             genuinely flat-out sweeper. The plain statement
//                             the other three are variations on.
//   2  Jackhammer Quarry      3 laps · 5 short strips · 2 cuts · 2 spills
//                             2.18km with fifteen corners in it, a 16m pinch
//                             and a 13m minimum radius. The narrowest road in
//                             the cup and the most contact: a quarter of this
//                             race is spent off the tarmac.
//   3  Saltpan Bypass         2 laps · 3 long ramps · 1 cut · 1 drift
//                             3.3km and 36m wide. Twice round is the whole
//                             race, and the pack never gets a settling-in lap.
//   4  Switchback Summit      3 laps · 5 strips, all uphill · 1 cut · 1 washout
//                             116 metres of climb and a plunge back down it.
//                             Gradient, and a crest that unloads the kart.
//
// ── the round that changed all of this ─────────────────────────────────────
//
// A critic played the cup and rejected it at 6.5, on one finding: **three of
// the four circuits could not produce the game's own signature mechanic.** A
// fixed-seed autopilot lap of the whole field, same physics, same seed, only
// the course changed:
//
//                          drifts/racer   purple fires   longest slide
//     Cone Canyon               5.0             8            1.75s
//     Jackhammer Quarry         7.1            14            2.35s
//     Saltpan Bypass            1.3             0            1.30s
//     Switchback Summit         2.6             3            1.38s
//
// One purple mini-turbo per lap on the saltpan, across seven racers, on a
// circuit with fourteen corners in it. The reason was a single number nobody
// had been measuring: **a kart at this game's top speed holds a 62-metre radius
// without lifting**, and thirty-one of this cup's thirty-nine corners were
// wider than that. They were long, they were banked, they were beautifully
// aimed, and every one of them was taken flat.
//
// Three courses were re-cut on `ring.ts`, which authors a lap as a ledger of
// straights and *exact circular arcs* rather than as points on a map. That
// second word is the other half of the fix: a hand-placed corner has a peak
// radius somewhere in the middle and a long tail either side — measured across
// this cup, a mean radius about 1.4x the tightest point — so a drift laid at
// turn-in is asked to change arc by two thirds before the exit, and it breaks.
// A declared radius holds from turn-in to exit.
//
//     after                 drifts/racer   purple fires   longest slide
//     Cone Canyon               9.1            15            1.50s
//     Jackhammer Quarry         7.1            11            2.35s
//     Saltpan Bypass            9.6            18            1.77s
//     Switchback Summit         9.9            17            1.65s
//
// Same seed, same field, same physics; the only thing that changed is the road.
// Eighteen purple mini-turbos a lap on the circuit that used to produce none.
//
// **What is honestly still short.** Two things, and both belong to other
// modules:
//
//   * *Jackhammer Quarry sits at 7.1.* It is the one circuit the round's
//     directive said to leave alone, and it is still hand-authored, so its
//     corners are still peaky: two of them measure R48 and R63 at their
//     tightest and are declined by the planner because the *apex* station is
//     wider than the peak, which is exactly the defect `ring.ts` exists to
//     remove. Converting it is a one-file job and the next obvious one.
//   * *Nobody holds a slide past 2.5 seconds anywhere.* This is not the road.
//     Across all four circuits, **62% of every drift that ended, ended on
//     `inside`** — the AI's own over-rotation fuse — against 15% on `exit` and
//     18% on contact. The fuse (`patience` in `ai/driver.ts`) is 0.45-1.6s of
//     accumulated over-rotation, so 2.5s of held slide is not reachable at any
//     radius. Measured on Cone Canyon's signature corner, moving it from R47 on
//     21m of road to R57 on 27m changed the field's longest slide by six
//     hundredths of a second while changing the drift count by 11% — the
//     geometry moves how *often* a kart drifts and the AI decides how *long*.
//
// ...and four *places*, which is the other half of the same job. One landscape
// key each (`render/theme.ts` allows exactly one and throws on two), one
// palette each, and the four are pulled apart rather than merely made
// different: hot terracotta under gold haze, pale rock flour under mineral
// grey, near-white evaporite under cobalt, cold schist and snow under navy.
// That now includes the tarmac itself, which it did not: all four bases sat
// between #2B2D34 and #3A3D46 and photographed as one road. Warm ironstone,
// cold basalt, blue-black bitumen and pale weathered chipseal.
//
// **The hazard columns above are real.** For a round the spills, the drift and
// the washout were comments: three courses declared `features.patches`, nothing
// in `src/track/` outside this folder read it, and all four bands returned
// `road` when probed in the running game. `buildRoad` now resolves each one and
// `sample()` walks the result, both through the same `patchScale()`, so the
// paint and the grip cannot disagree.
//
// Four rounds is what `race/director.ts` opens a cup with, so this array is
// also the cup.

import { coneCanyon } from './coneCanyon.ts';
import { jackhammerQuarry } from './jackhammerQuarry.ts';
import { saltpanBypass } from './saltpanBypass.ts';
import { switchbackSummit } from './switchbackSummit.ts';
import type { CourseDef } from '../../types.ts';

export const courses: CourseDef[] = [
  coneCanyon,
  jackhammerQuarry,
  saltpanBypass,
  switchbackSummit,
];

const byId = new Map(courses.map((c) => [c.id, c]));

export function getCourse(id: string): CourseDef {
  const c = byId.get(id);
  if (!c) {
    console.error(`[courses] unknown course "${id}", falling back to ${courses[0]!.id}`);
    return courses[0]!;
  }
  return c;
}

export function listCourses(): readonly CourseDef[] {
  return courses;
}

export function coursesInCup(cup: string): CourseDef[] {
  return courses.filter((c) => c.cup === cup);
}
