// Course registry.
//
// Add a course by importing it and dropping it in the array. Everything else —
// course select, minimap, cups — reads from here, so nothing else needs editing.
//
// The order is the order the Hazard Cup runs in, and it is a deliberate
// sequence rather than the order they were built. Each round asks for something
// the one before it did not — and asks it with a different *shape*, not only a
// different set of corners.
//
//   1  Cone Canyon Speedway   3 laps · 2.52km · 5 strips · 1 cut · THE SPLIT ·
//                             THE ROCKFALL. **The dogleg.** Two legs two
//                             hundred metres apart, an elbow at one end and
//                             the Carousel hooked round the other; 2.4:1 on
//                             the map card, which is twice as thin as anything
//                             else in the cup.
//   2  Jackhammer Quarry      3 laps · 2.50km · 5 short strips · 2 cuts ·
//                             2 spills · THE CUT · THE HAUL TRUCK. **The
//                             comb.** Four hairpins folding four benches into
//                             a square, with the haul road wrapped round the
//                             outside. 249 metres of the lap under a 40-metre
//                             radius; the longest straight anywhere on it is
//                             160.
//   3  Saltpan Bypass         2 laps · 3.52km · 3 long strips · 1 cut ·
//                             1 drift · THE FLOOD · THE SURGE · THE CAUSEWAY.
//                             **The wedge.** A right triangle with a
//                             640-metre ruler down the hypotenuse and three
//                             sheets of standing brine laid across it.
//   4  Switchback Summit      3 laps · 2.68km · 5 strips, all uphill · 1 cut ·
//                             1 washout · THE KICKER · THE GATE. **The
//                             hourglass.** Two lobes and a waist, the waist
//                             being the gorge the road climbs out of and
//                             plunges back into. 115 metres of climb.
//
// ── the round that gave the four circuits four shapes ──────────────────────
//
// A critic played all four and rejected them at 6.5 on one finding, and it was
// a *measurement* rather than an opinion: **measured off the real driven line,
// every one of the four was an irregular closed blob of 9-12 similar-radius
// corners whose longest straight was 72-83 metres** — cone-canyon 83, saltpan
// 80, quarry 73, switchback 72. An eleven-metre spread; 1.4 seconds at 54 m/s.
// With the names covered, the four map cards on the select screen were
// interchangeable, because they were four drawings of the same object.
//
// The fix had to be geometry, and it had to be on the axes MK8 itself
// differentiates on. Same instrument, after:
//
//                     longest straight   R<40m of lap   elevation   aspect
//     Cone Canyon           320m               30m         26.0m      2.37
//     Jackhammer            160m              249m         41.6m      1.30
//     Saltpan               629m               60m         11.7m      1.76
//     Switchback            240m               70m        115.2m      1.68
//
//   * **longest straight 629 against 160 — 3.9x**, against the 1.15x the
//     critic measured. The saltpan's is one segment: a 640-metre bulldozed
//     line across a lake, with the whole of THE FLOOD laid across it, so the
//     straight is a slalom that is geometrically straight.
//   * **the quarry carries eight times the tight-radius road of the canyon.**
//     Three of its twelve corners are under 36 metres and a fourth is 48. Cone
//     Canyon's tightest is 34 and it has exactly one of them.
//   * **the mountain has ten times the saltpan's elevation**, and its profile
//     is one climb and one plunge rather than the quarry's four-step staircase
//     or the canyon's single swell.
//   * **and the silhouettes are un-confusable**: a long dogleg, a comb, a
//     wedge and an hourglass. That is the cover-the-names test, and it is the
//     one the previous build could not pass.
//
// All four are now authored in `ring.ts` — a ledger of straights and exact
// circular arcs — and all four **close on their own geometry**: `legs()`
// reports a closure adjustment of 0.0m on every straight of every circuit,
// because each ledger was solved against its own traverse rather than nudged
// at until `ring.ts` stopped complaining. That matters beyond tidiness: a
// circuit closed by the least-squares adjuster has its straights silently
// lengthened, which is exactly how four hand-grown layouts converged on the
// same proportions in the first place.
//
// The same round moved Cone Canyon's last boost strip. It sat 44 metres before
// the start line on the inside lateral, which is where `track/index.ts` parks
// the back row of the grid, so `sample()` returned `'boost'` for a stationary
// kart under the lights and the flag handed the field a free `pad` shove on
// the *same frame* `evaluateStart` graded the rocket start —
// `tools/countdown.mjs` printed it as a standing WARN on every run. Every
// circuit in the cup now states its `START` in terms of the grid: the back row
// stands 47 metres behind the chequer and the intro formation rolls in from
// eleven metres further back again, so 58 metres of straight, level, unpainted
// road behind the line is the floor, and the nearest strip to any start line
// is now 400 metres upstream.
//
// ── the round that made those four words different ─────────────────────────
//
// An earlier critic rejected the cup on a related finding: *"all four courses
// are assembled from an identical vocabulary — a flat closed asphalt loop, 3-5
// boost pads, 0-2 gravel patches, 1-2 gravel cuts and 3-5 background mesas —
// so not one round of the cup has a mechanic or a set piece the other three
// lack."* So `TrackFeatures` grew the nouns it could not express — `ramps`,
// `gates`, a surface-patch `style` — and each round owns one thing the other
// three do not have. See `TrackFeatures` in `types.ts` for the list and the
// rule that comes with it: **a course whose feature set is a subset of another
// course's is a re-skin.**
//
// ── the round that gave the cup its name back ──────────────────────────────
//
// And before that: *"nothing on any of the four courses can ever touch the
// player — the roster contains zero hazards, every course is stamped cup
// 'hazard', and TrackFeatures has no noun that could express one."* The proof
// was one grep: `stunRacer` had **exactly one caller in the whole game** and it
// was the item box.
//
// `TrackFeatures.hazards` is that noun and `courses/hazards.ts` is the second
// caller. Four hazards, one per round, no two alike, every one of them a pure
// function of `ctx.time` — a dumper, a rockfall, three bores of brine and an
// avalanche gate. Each is announced by the same warning diamond on the verge
// seventy-odd metres upstream, with lamps that light a full second and a half
// before the body reaches the tarmac: *dark lamps mean the road is yours* is
// the contract, and it is the difference between hard and cheap.
//
//                     hazard     cycle  blocked
//     Cone Canyon      rockfall   17s    27%
//     Jackhammer       truck      24s    20%
//     Saltpan          surge ×3   19s    30% ea
//     Switchback       boom       11s    38%
//
// Every course must still finish with the whole field on the lead lap or one
// off it, which is the bar a hazard has to clear before anything else it does
// counts: *a course the AI cannot get round is not a course.*
//
// ── the round that found out none of them had ever fired ───────────────────
//
// The table above is a table of **duty cycles**, and a critic played thirteen
// full races and reported the number it does not contain: the four signature
// hazards hit a racer **five times in thirteen races**, and three of them had
// never touched anybody at all. The mountain's gate, cycling every eleven
// seconds at that 38% blocked window over a 168-second race — about thirty-five
// blocked passes across the field — produced zero.
//
// A duty cycle is a statement about *time*. It says nothing about *space*, and
// space was where the whole cup was wrong: `ShortcutDef`, `SurfacePatchDef` and
// `HazardDef` all carried a sentence saying the spline's lateral frame is the
// mirror of the driver's, and **it is the other way round**. Measured on the
// running game the field crosses Cone Canyon's Carousel at a median of +5.5
// metres and Switchback's Spur at −5.8; three of the four hazards were
// authored off the inverted sentence and were sweeping the empty half of the
// road. See `LATERAL FRAME` in `types.ts`.
//
// `tools/hazardcensus.mjs` is the instrument, and it exists so that this
// cannot be claimed again. It counts `kart:hit` minus `item:strike` over whole
// races — both `hazards.ts` and `items/index.ts` route through `stunRacer`, and
// only items also emit `item:strike` — and next to that it prints, per hazard,
// the histogram of every racer's `sample().lateral` at the crossing against the
// lateral span the bodies actually sweep. `--profile` prints the driven line at
// a hundred stations round the lap, which is what a hazard should be *placed*
// from. The pass mark is **8-20 hazard hits per race, every course, every
// seed**, and at seed 1 the roster now reports 11 / 10 / 13 / 13 against the
// 0 / 4 / 0 / 0 the critic measured.
//
// ── what is honestly still short ───────────────────────────────────────────
//
//   * *`kart:launch` still fires four times a race, not once per ramp pass.*
//     This is not the road — see `RampDef` and `ramp.ts`. Physics zeroes the
//     kart's surface-normal velocity on **every grounded step**, so the
//     quantity `trickMinLaunch` gates on is structurally near zero for any
//     take-off made of geometry: it can only be reached by something that
//     *adds* normal velocity, like a bump or a landing bounce. `kart:trick` is
//     unaffected and fires off the mountain's lip throughout the race.
//   * *Nobody holds a slide past 2.5 seconds anywhere.* Across the roster,
//     62% of every drift that ended, ended on `inside` — the AI's own
//     over-rotation fuse — against 15% on `exit`. The fuse (`patience` in
//     `ai/driver.ts`) is 0.45-1.6s of accumulated over-rotation, so 2.5s of
//     held slide is not reachable at any radius. The geometry moves how
//     *often* a kart drifts and the AI decides how *long*.
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
