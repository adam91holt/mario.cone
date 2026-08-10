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
//                             the circuit you learn the kart on — fast, wide,
//                             one hairpin, banking you can lean on. The plain
//                             statement the other three are variations on.
//   2  Jackhammer Quarry      4 laps · 6 short strips · 2 cuts · 2 spills
//                             fifteen corners in 2.1km, nine of them under 40m
//                             of radius, and a 16m pinch. The shortest and
//                             slowest lap in the cup, so it runs four of them.
//   3  Saltpan Bypass         2 laps · 3 long ramps · 1 cut · 1 drift
//                             3.3km, 36m wide, one braking point in the whole
//                             lap. Twice round is the whole race, and the pack
//                             never gets a settling-in lap.
//   4  Switchback Summit      3 laps · 5 strips, all uphill · 1 cut · 1 washout
//                             116 metres of climb and a plunge back down it.
//                             Gradient, and a crest that unloads the kart.
//
// ...and four *places*, which is the other half of the same job. One landscape
// key each (`render/theme.ts` allows exactly one and throws on two), one
// palette each, and the four are pulled apart rather than merely made
// different: hot terracotta under gold haze, pale rock flour under mineral
// grey, near-white evaporite under cobalt, cold schist and snow under navy.
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
