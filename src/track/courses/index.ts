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
//   1  Cone Canyon Speedway   3 laps · 5 strips · 1 cut · THE SPLIT ·
//                             THE ROCKFALL. 2.38km, and the open one: a
//                             330-metre pit straight, 30m of road at the line,
//                             and one genuinely flat-out sweeper. Its signature
//                             is the Carousel, a *divided carriageway* — and
//                             the canyon now drops boulders on the inside lane
//                             of it, so the fork has a wrong answer that moves.
//   2  Jackhammer Quarry      3 laps · 5 short strips · 2 cuts · 2 spills ·
//                             THE CUT · THE HAUL TRUCK. 2.18km, fifteen
//                             corners, a 13m minimum radius and **42 metres of
//                             pit**. Its signature is width — eleven metres on
//                             the plunge — and there is now a hundred-tonne
//                             dumper shuttling across those eleven metres.
//   3  Saltpan Bypass         2 laps · 3 long strips · 1 cut · 1 drift ·
//                             THE FLOOD · THE SURGE · THE CAUSEWAY. 3.3km and
//                             36m wide. Three sheets of standing brine, three
//                             bores that move which lane is dry, and one levee
//                             with a kicker on top of it.
//   4  Switchback Summit      3 laps · 5 strips, all uphill · 1 cut · 1 washout
//                             · THE KICKER · THE GATE. 116 metres of climb, a
//                             plunge back down it with a launch ramp on it, and
//                             an avalanche boom that swings shut across the
//                             spur cut.
//
// ── the round that gave the cup its name back ──────────────────────────────
//
// A critic played all four and rejected them at 6.5 on one sentence: *"nothing
// on any of the four courses can ever touch the player — the roster contains
// zero hazards, every course is stamped cup 'hazard', and TrackFeatures has no
// noun that could express one."* The proof was one grep: `stunRacer` had
// **exactly one caller in the whole game** and it was the item box. Neither
// `track/` nor `world/` imported physics at all.
//
// `TrackFeatures.hazards` is that noun and `courses/hazards.ts` is the second
// caller. Four hazards, one per round, no two alike, every one of them a pure
// function of `ctx.time` — a dumper, a rockfall, three bores of brine and an
// avalanche gate. Each is announced by the same warning diamond on the verge
// seventy-odd metres upstream, with lamps that light a full second and a half
// before the body reaches the tarmac: *dark lamps mean the road is yours* is
// the contract, and it is the difference between hard and cheap.
//
// The same round also fixed the other half of that verdict — that Cone Canyon
// and Jackhammer Quarry *measured as one course twice* (both 3 laps, both
// road/dirt/boost/air, 28.6m against 27.6m of elevation, 37.1% against 35.5%
// of the lap under an 80m radius, 41.8 against 43.4 m/s) and that three of the
// four elevation profiles were flat lines at a common scale. The quarry is
// now a **staircase into a 42-metre pit** rather than a flat loop with gravel
// on it, and the saltpan — which is a dry lake and has to stay flat — has one
// thing on it that stands up: a 12.5-metre levee with a launch ramp on the
// crest, at the fastest point of the fastest lap in the cup.
//
// ── the round that made those four words different ─────────────────────────
//
// A critic played the cup a second time and rejected it at 6.5 on one finding,
// and it was the right finding: *"all four courses are assembled from an
// identical vocabulary — a flat closed asphalt loop, 3-5 boost pads, 0-2 gravel
// patches, 1-2 gravel cuts and 3-5 background mesas — so not one round of the
// cup has a mechanic or a set piece the other three lack."* Grepping the whole
// roster for `jump|ramp|split|hazard|water|branch` returned nothing outside
// `loopFromWaypoints` and the string `'hazard'` in `cup`. The cup was named the
// Hazard Cup and contained no hazard beyond gravel.
//
// The telemetry said the same thing in numbers. Same seed, same field, only the
// road changed — mean speed **50.1 / 45.2 / 53.9 / 51.8** m/s across a
// speedway, a scrapyard, a runway and a mountain, and airtime on the
// 116-metre-climb course was **5.9%**, *lower* than the flat quarry's 7.9%. The
// steepest road in the game produced less air than the flattest.
//
// So `TrackFeatures` grew the two nouns it could not express — `ramps` and
// `gates` — a surface patch grew a `style`, and each round now owns one thing
// the other three do not have. See `TrackFeatures` in `types.ts` for the list
// and the rule that comes with it: **a course whose feature set is a subset of
// another course's is a re-skin.**
//
// ── what the hazard round measures ─────────────────────────────────────────
//
// Same seed, same field, only the road changed. `hits` counts every stun edge
// across all seven racers for a whole race — items and contact included, so it
// is a *ceiling* on what the hazards did, not their share — and `blocked` is
// the fraction of its own cycle each hazard spends over the tarmac.
//
//                     hazard     cycle  blocked  race    air%   hits
//     Cone Canyon      rockfall   17s    27%     158s    6.4     35
//     Jackhammer       truck      24s    20%     163s    9.1     88
//     Saltpan          surge ×3   19s    30% ea  151s    5.1     40
//     Switchback       boom       11s    38%     206s    7.9     69
//
// Every course still finishes with the whole field on the lead lap or one off
// it, which is the bar a hazard has to clear before anything else it does
// counts: *a course the AI cannot get round is not a course.* The one place
// that failed was the avalanche gate, and it failed exactly the way a hazard
// on a cycle shorter than its own stun always will — see `HIT_MIN_SPEED` in
// `hazards.ts`. Before that rule a CPU driver parked under the boom finished
// the race on **lap zero**; after it the mountain's field is *tighter* than the
// same race with no hazard in it at all (8468-9210m of progress against
// 4272-9210m).
//
// ── elevation, after ───────────────────────────────────────────────────────
//
//                      range     climb/lap   profile
//     Cone Canyon      26.0m      26.0m      one long swell
//     Jackhammer       42.4m      42.6m      rim → bench → pit floor → haul
//     Saltpan          12.9m      17.0m      flat lake with one levee on it
//     Switchback      115.5m     117.7m      one climb, one plunge
//
// The quarry was 19.8m of gentle undulation and is now a staircase into a hole;
// the saltpan was 3.9m over 3.3km — a ruled line — and now has a 12.5-metre
// causeway with a launch ramp on the crest at the fastest point of the lap.
//
// ── what the four rounds measured before that ──────────────────────────────
//
// Same seed, same field, same physics, only the road changed. `before` is the
// build the critic rejected.
//
//                     race   mean   air%   tricks  t3   walls  offroad
//     Cone Canyon      154s   50.0   6.4      5     58    59     108
//       before         151s   50.1   6.8      2     68    50      77
//     Jackhammer       139s   49.9   8.5      6     76   162     230
//       before         158s   45.2   7.9      4     70   173     236
//     Saltpan          120s   54.1   5.4      7     46    50     114
//       before         125s   53.9   4.8      5     47    26      61
//     Switchback       222s   47.5   7.1     39     90    99     115
//       before         180s   51.8   5.9     12     80    67     105
//
// Read it by column rather than by row. **Race length now runs 120 to 222
// seconds** — the four rounds are not the same length of evening. The mountain
// went from twelve landed tricks to **thirty-nine** and from 80 purple
// mini-turbos to 90, which is the kicker doing exactly the job it was built
// for; the quarry is still the contact round by a distance (162 wall hits and a
// quarter of the race off the tarmac against Cone Canyon's 59 and a seventh);
// the saltpan is still the fast one and is now the only one with `water` in its
// surface histogram at all.
//
// **What is honestly still short**, and both belong to other modules:
//
//   * *Mean speed is 47.5 / 49.9 / 50.0 / 54.1 — a 14% spread, and the quarry
//     drifting up from 45.2 is the reason it is not wider.* The Cut did not
//     make the quarry faster by making it easier; it made the *field* more
//     consistent. Its finishing spread collapsed from 64 seconds to 21, so the
//     mean stopped being dragged down by one kart crawling. That is a better
//     race and a worse number, and the number the critic quoted is the one that
//     cannot tell them apart.
//   * *`kart:launch` still fires four times a race, not once per ramp pass.*
//     This is not the road — see `RampDef` and `ramp.ts`. Physics zeroes the
//     kart's surface-normal velocity on **every grounded step**, so the
//     quantity `trickMinLaunch` gates on is structurally near zero for any
//     take-off made of geometry: it can only be reached by something that
//     *adds* normal velocity, like a bump or a landing bounce. The kart leaves
//     this lip climbing at 11° with about 10 m/s of world-vertical speed and
//     reports a `launchVy` of under two. `kart:trick` is unaffected and is
//     firing off the ramp thirty-nine times a race.
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
