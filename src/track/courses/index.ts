// Course registry.
//
// Add a course by importing it and dropping it in the array. Everything else —
// course select, minimap, cups — reads from here, so nothing else needs editing.
//
// The order is the order the Hazard Cup runs in, and it is a deliberate
// sequence rather than the order they were built. Each round asks for something
// the one before it did not — and asks it with a different *lap structure*, not
// only a different set of corners. Four three-lap loops with four strips and
// one gravel cut apiece is one course design printed four times, whatever the
// shapes on the minimap look like.
//
//   1  Cone Canyon Speedway   3 laps · 4 strips · 1 cut · no surface hazard
//                             2.24km, and the open one: a 214-metre pit
//                             straight, eight slow zones down from fifteen, one
//                             hairpin, and a 27m minimum radius. The plain
//                             statement the other three are variations on.
//   2  Jackhammer Quarry      3 laps · 5 short strips · 2 cuts · 2 spills
//                             2.18km with fifteen corners in it, nine under 40m
//                             of radius, a 16m pinch and a 13m minimum. Half
//                             the minimum radius of round one, a third more
//                             curvature at P90 and twice its drift share —
//                             this is where the cup gets hard.
//   3  Saltpan Bypass         2 laps · 3 long ramps · 1 cut · 1 drift
//                             3.3km, 36m wide, one braking point in the whole
//                             lap. Twice round is the whole race, and the pack
//                             never gets a settling-in lap.
//   4  Switchback Summit      3 laps · 5 strips, all uphill · 1 cut · 1 washout
//                             116 metres of climb and a plunge back down it.
//                             Gradient, and a crest that unloads the kart.
//
// **Those four hazard columns are real now.** For a round the spills, the drift
// and the washout were comments: three courses declared `features.patches`,
// nothing in `src/track/` outside this folder read it, and all four bands
// returned `road` when probed in the running game. The whole justification for
// this cup order was a table of things that did not happen. `buildRoad` now
// resolves each one and `sample()` walks the result, both through the same
// `patchScale()`, so the paint and the grip cannot disagree.
//
// The other thing this order was lying about was speed. Round one traced at
// 46.4s a lap against round two's 37.0 — the circuit documented as "fast, wide,
// one hairpin" was the slowest and twitchiest thing in the cup, and the pit was
// the quick one, because six boost strips and two gravel cuts had the quarry on
// boost for more than half of its own lap. Round one is now 2.24km with a
// genuine straight in it and round two runs four short strips instead of six,
// so the two courses this file calls opposites measure as opposites *by shape*:
// eight slow zones against eleven, a 27m minimum radius against 13, curvature
// P90 0.0149 against 0.0262, a 214m straight against 84, and a drift share of
// 6.3% against 23.6%. On the clock they are close — ~43.2s against ~44.2s over
// 2235m and 2176m — which is a 3% edge per metre to round one rather than the
// 25% deficit it had. Round two's boost strips move its lap by ±2s run to run,
// so they are not a lever for closing that further; the shape is.
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
