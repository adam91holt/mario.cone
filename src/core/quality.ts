// The quality governor: what the game gives up, when, and on whose evidence.
//
// ── Why this is measured and not chosen ─────────────────────────────────────
//
// `config.quality` has always held three tiers and `harness.setQuality` has
// always been able to pick one, and between them that is a settings menu, not a
// frame budget. Nothing in the game had ever *looked* at how long a frame took
// on the machine it was running on. The tier was decided once, at boot, by a
// literal — `makeQuality('high')` in main.ts — and a laptop that could not hold
// sixty frames a second ran the same shadow map, the same draw distance and the
// same particle budget as one that could, and hitched.
//
// ── The instrument comes before the ladder ─────────────────────────────────
//
// The first version of this file walked a ladder against `budget.meanMs`, which
// is *CPU work*: the time spent inside `fixedUpdate`, inside the systems'
// `update`, and inside the call to `renderer.render()`. That last one is the
// trap. `renderer.render()` returns when the command buffer has been handed to
// the driver, not when the picture exists, so on a machine whose GPU is the
// bottleneck it returns almost immediately and the frame's cost lands in the
// *gap before the next callback* where nothing was looking.
//
// Measured live, at 1600x900 on a software rasteriser, that gap was everything:
// `meanMs` averaged 23ms while real frames were arriving 250ms apart. The
// governor read 23, called it "in band", and sat at the top rung for five and a
// half minutes while the player watched four frames a second. A ten-fold
// under-read is not a tuning problem, it is the wrong instrument.
//
// So the verdict is taken from **wall time between delivered frames**, sampled
// here rather than read off `budget.wallMs`, for two reasons: this file needs a
// short window it can reset the moment it changes something, and it needs the
// spread — the worst frame and the share of frames that hitched — not just a
// mean. A game that averages 12ms and stutters to 40ms every twentieth frame is
// not a game running well, and a mean cannot say so.
//
// ── ...and the instrument must not throw away the evidence ─────────────────
//
// Twice now this file has been failed for a *gate* rather than for a ladder,
// and both times the gate had the same shape: a threshold that a slow machine
// could not cross, sitting in front of the machinery that exists for slow
// machines. First a warm-up counted in 240 rendered frames — four seconds at
// sixty and two minutes twenty at 1.7. Then, one layer down, a rule that any
// frame longer than two seconds "was not a frame": on a machine delivering
// frames 1.7 to 2.6 seconds apart, that discarded most of them, and the
// seconds-counted warm-up it was feeding accrued **1.66 seconds in 200 seconds
// of wall time**. The probe read `priming, samples 0` for three minutes.
//
// The rule now: **nothing about a frame's duration is ever evidence that it was
// not a frame.** A frame is discarded only when something observable says the
// page was not running through it — a `visibilitychange` edge, or the harness
// having stepped the simulation inside the gap (`budget.benchSteps`). Both are
// causes, not symptoms, and both are counted and reported in `probe()` as
// `suspended` and `hijacked`, because an instrument that silently throws things
// away is exactly how the last two rounds were lost.
//
// `budget.meanMs`, `meanSimMs` and `meanDrawMs` are still read, but only to
// *attribute* a frame the wall clock has already convicted: work above about
// two thirds of the frame means the CPU is the problem and says which half of
// it, and work far below it means the cost is downstream — the GPU, or vsync.
//
// ── The unit rule: a gate is denominated in the thing it gates ─────────────
//
// Three rounds have now been lost in this file to three different mechanisms
// that share one shape. A warm-up counted in 240 rendered frames, which a
// machine too slow to render cannot reach. A stall filter counted in
// milliseconds, which discarded the exact frames the governor exists to
// measure. And a moment gate that read `race.phase` — which ARCHITECTURE §11a
// says outright cannot see the front-end — with a ceremony grace counted in
// delivered-play seconds against a beat measured in race seconds.
//
// The class is not "counted in frames" or "counted in milliseconds". It is a
// gate denominated in a **different unit from the thing it gates**, in a file
// where the available clocks come apart by three orders of magnitude the
// moment the machine gets slow. At 0.7 delivered frames a second — the state
// this file exists for — one delivered frame is 1.43 seconds of wall time and
// 0.067 seconds of *race* time, because `engine.ts` caps the fixed step at
// eight per frame and the simulation drops into slow motion underneath. A
// second is not a second is not a second.
//
// Four units, and the rule for choosing between them:
//
//   a statistic         → delivered frames. Samples are what a median has.
//   a beat of the game  → race seconds (`ctx.race.time`). The countdown is
//                         three race-seconds long at every frame rate.
//   a person waiting    → wall seconds of delivered play (`liveSeconds`).
//   a machine's speed   → milliseconds between delivered frames.
//
// ...and the corollary, which is the other half of the third round: **a gate
// needs a valve only when the thing it waits for depends on the frame rate.**
// The intro sweep ends when the simulation reaches the end of it, and the
// simulation is slowed by the very cost the governor is trying to cut — a
// genuine circle, and why `CEREMONY_PATIENCE` exists.
//
// The round-3 version of this paragraph carried on: *"The front-end ends when
// the player presses a key, and the flag's grace ends after 1.2 race-seconds
// that every delivered frame buys 0.067 of. Both are bounded without a valve,
// and fitting them with one would only put the bug back."* Half of that
// survived round 4 and half of it was the round-4 failure, and the difference
// between the two halves is worth stating because it is the rule:
//
//   **The flag's grace was right.** It is measured on the fixed-step clock, so
//   every delivered frame buys exactly 0.067 of it however slow the machine
//   is. Eighteen pictures, at any frame rate. Bounded in the unit that matters
//   without anybody having to do anything.
//
//   **The front-end was wrong, and so was the countdown seal.** "It ends when
//   the player presses a key" describes what ends the wait and says nothing
//   about *how long the player is in it*, which is the thing a gate costs.
//   Measured: fifty seconds of a player reading four screens at 0.7fps behind
//   `holding: 'front-end'`, and fifty-six more inside a three-race-second
//   countdown at 1.2fps behind `holding: 'mid-ceremony'`. A wait a hundred
//   seconds long is not bounded merely because something eventually ends it.
//
// So the test is not "does this terminate" but **"how long is this in wall
// seconds on the machine the file exists for, and is that a number anybody
// would defend out loud"**. Everything here now answers that question in the
// audit above, and everything whose answer was tens of seconds has a door.
//
// ── The audit ──────────────────────────────────────────────────────────────
//
// Every gate, threshold and accumulator in this file, what it is denominated
// in, and what it is worth at 0.7fps. This is the list the third round was
// lost for not having written down:
//
//   WARMUP_S 3             wall s of delivered play   2 frames        ok (*)
//   PANIC_ARM_S 1.4        wall s of delivered play   1 frame         ok (*)
//   MIN_SAMPLES 6          delivered frames           8.6s            ok
//   PANIC_SAMPLES 4        delivered frames           5.7s            ok
//   VERDICT_SAMPLES 14     delivered frames           20s             ok
//   SKIP_FRAMES 3          delivered frames           4.3s            ok (now measured)
//   WALL_WINDOW 64         delivered frames           91s of history  ok
//   DOWN/LATE/PANIC/UP     ms between delivered frames   unchanged    ok
//   UP_WORK_MS, UP_WORST   ms of CPU work             unchanged       ok
//   FUTILE_* , RETRY       dimensionless ratios       unchanged       ok
//   BENCH_HOLD 4, BURST 1  wall s                     3 / 1 frames    ok
//   UP_DWELL 9             wall s under budget        unreachable     ok
//   liveSeconds            wall s of delivered play   honest          ok
//   CEREMONY_PATIENCE 20   wall s inside the sweep    a valve         ok
//   SEAL_PATIENCE 35       wall s inside one beat     a valve         ok (r4)
//   FRONT_END_PATIENCE 12  wall s behind the menu     a valve         ok (r4)
//   CEREMONY_GRACE 2.2     race s after the flag      33 frames       ok (r5)
//   LAUNCH_PATIENCE 22     wall s inside the launch   a valve         ok (r5)
//   RUNG_GAIN 1.2          dimensionless ratio        measured        ok (r5)
//   PANIC_MAX_STEP 3       rungs per change           2 changes       ok (r5)
//   minPx / shellPx        screen pixels of radius    scale-relative  ok (r5)
//   crowd / scatter        shares of a population     dimensionless   ok (r5)
//
// ...and the five that were wrong, every one of them in the same direction —
// a protection that shrinks to nothing exactly when the machine needs it:
//
//   CEREMONY_GRACE 1.2     was delivered-play seconds, so one frame of cover
//                          for a beat that is 1.2 *race*-seconds long. Now
//                          race seconds, read straight off `ctx.race.time`.
//                          Measured before the fix: rung 3→4 fired between
//                          race time 0.0 and 0.2s, on GO, and rung 4→5 at 1.2s.
//   pictureLocked()        was `race.phase` and nothing else, so the whole
//                          front-end was invisible to it: three of five rung
//                          changes in a live 180-second session were made with
//                          the title screen and the roster on the display, all
//                          three logged `phase: intro`. Now the `ui:menu`
//                          edges and the `race:pause` edges, the way
//                          `race/director.ts` has always done it, with the
//                          phase as the third opinion rather than the only one.
//   VERDICT_ABANDON        was 30 wall seconds, against a window that fills in
//                          *frames*: SKIP_FRAMES + VERDICT_SAMPLES is 17 of
//                          them, which is 24s at 0.7fps and 34s at 0.5 — so
//                          below about 0.55fps every verdict was abandoned and
//                          the futility check could never run at all. Now
//                          delivered frames, and it fires only when frames are
//                          genuinely being discarded.
//   DOWN_DWELL 1.2         wall seconds over budget, which is one frame at
//   PANIC_DWELL 0.35       0.7fps: "never act on a single hitch" had become
//                          "act on a single hitch". Now a wall dwell *and* a
//                          frame count, and the slow machine is bound by the
//                          frames.
//   SETTLE 2.2             wall seconds since a change, which is one frame at
//   PANIC_SETTLE 0.9       0.7fps — so the settle that exists to let a change's
//                          own transient pass could be satisfied by the
//                          transient itself. Now both, same shape.
//
//   (*) `WARMUP_S` and `PANIC_ARM_S` stay in wall seconds on purpose. They
//   gate a statistic, the sample counts beside them are what actually binds on
//   a slow machine, and the thing they are waiting out — shader compilation,
//   texture upload, the JIT — is wall-clock work.
//
// ...and the two the *fourth* round was lost for, which is the same bug once
// more with a different mechanism: `CEREMONY_GRACE` was converted to race
// seconds and marked "ok" without anyone converting it back into **what a
// player waits**. Three race-seconds of countdown plus 1.2 of grace is 56 wall
// seconds at 1.2fps, and the governor was sealed for every one of them. A unit
// audit that never asks "and how long is that in the unit the player is in" is
// half an audit. The two new rows above are the answer, and the rule they
// encode is: *every* refusal in this file is a wait, and the only ones without
// a door are the ones whose length does not depend on the frame rate —
// `loading`, which is the boot and the pause screen.
//
// The flag's grace used to be on that short list, on the argument that it is
// measured on the fixed-step clock and is therefore bounded in *pictures* at
// any frame rate. That argument was true and it stopped one line early, which
// is the fifth round's version of the same mistake: eighteen pictures at 0.7fps
// is twenty-six wall seconds, and the grace is now long enough to cover the
// launch it is protecting — thirty-three pictures, forty-seven wall seconds.
// Nobody would defend forty-seven seconds out loud, so it has a door like
// everything else. See `LAUNCH_PATIENCE`.
//
// ── ...and then round five was about the thing the instrument had to pull ───
//
// Four rounds of this file were about *measuring*: which clock, which unit,
// which gate, whose evidence. They were all won and the file still scored a
// six, for a reason none of them could have caught, because it is not a
// property of any instrument in here:
//
//   **The ladder had nothing on it.** Measured on one frozen racing frame at
//   1600x900, rung 0 to the floor went 640,276 triangles to 616,846 and 296
//   draw calls to 253 — **3.7% of the geometry** — and bought 2.1x, all of it
//   out of the render scale. Every rung was the same picture at fewer pixels.
//   So a machine that needed more than 2.1x walked to the bottom, was handed a
//   736x414 frame, and still missed; and the last rung of that walk gave up the
//   bloom pyramid and halved the shadow map to 256px to buy nine tenths of one
//   percent.
//
// `drawDistance` was the only content lever on the ladder and it was not one.
// `world/index.ts` switches each dressing batch on its *centre* against a
// per-kind range; the batches are split by lap sector across a 2.5km circuit,
// and the ones that cost anything are the ones beside the camera at every draw
// distance. 1.0 to 0.5 removed 23k triangles out of 640k and nothing left the
// frame that anybody could see leaving.
//
// What the same frame is actually made of — `__QUALITY.audit()`, which is where
// this file's own instrument named its own targets and then had no rung that
// could spend either of them:
//
//   world     171 calls   516,356 triangles    7 materials
//   track      34 calls   167,102 triangles   22
//   the field 745 calls    36,362 triangles   75   <- seven racers
//
//   world:cone        807 instances    74,244 triangles   0.6m across
//   world:crowd0..2    30 instances   140,808 triangles
//   world:standCrowd*   3 instances    59,124 triangles
//   world:drum         96 instances    16,512 triangles
//   world:tyres        85 instances    15,300 triangles
//
// So the bottom of the ladder is three **content** rungs now, and what they
// spend is named above: the population of the verge, the population of the
// stands, and the seven machines' twenty-six-meshes-each. Measured the same
// way, on one frozen frame with the simulation actually held still:
//
//                        triangles          draw calls
//   before   rung 0 -> 6   640,276 -> 616,846   296 -> 253    -3.7%
//   now      rung 0 -> 6   775,346 -> 572,137   409 -> 278   **-26.2%**
//
// ...with the program count flat at 87 for the whole descent, so the ladder
// still compiles nothing on its way down. See `ContentTrim`, `censusContent`
// and the ladder's own block for what each rung spends and what it costs.
//
// ── The three things that make a governor either useful or a menace ─────────
//
// **0. It must not be a cliff.** Every rung on this ladder keeps the shadow
// map, the post stack, the bloom and the atmosphere. What comes off is
// resolution, shadow map *size*, particle density, draw distance and — at the
// bottom three — population: how many spectators, how many cones, and whether
// the machine two hundred metres away is thirty meshes or one. Nothing on it
// turns a feature off, which means nothing on it recompiles the game: the
// floor rung two ladders ago took the program count from 75 to 110 and cost a
// 762ms frame, so the ladder's rescue move was the worst hitch of the session,
// and it left the cone standing on the dirt casting no shadow at all while
// `world/`, `track/` and `render/` all still believed in the one shadow policy
// ARCHITECTURE §12 describes. A governor may spend the game's looks; it may not
// contradict the game's art direction.
//
// The bloom pyramid was the last survivor of that argument and it is gone from
// the ladder too, on the same reasoning applied to a smaller loss. The old
// floor spent it *and* halved the shadow map to 256px to buy 0.9%, which is a
// rung that gives up the item box's glow and softens a contact shadow into a
// smear for nothing measurable — against the most-read object on the road and
// against §12's own contact-is-everything rule. The shadow map now bottoms out
// at 448px and the glow survives to the floor; what pays for them is the
// population rungs, which buy more than either of them ever did.
//
// **1. It must not oscillate.** A ladder that drops a rung, gets faster, climbs
// back, gets slower and drops again is worse than no ladder at all: the player
// watches the shadows and the draw distance breathe. Four mechanisms stop it.
// The thresholds are far apart. The dwells are asymmetric — a rung is lost
// after 1.2s over budget and regained only after 9s under it, so a single hitch
// can cost a rung but can never win one back on its own. Every change is
// followed by a lockout long enough for the change's own transient to pass. And
// climbing back demands more than the wall clock: the frame has to be arriving
// on time *and* have measured headroom underneath it, because a vsync-locked
// 16.7ms says nothing about how close to the edge the machine is.
//
// **2. It must not change at a moment the player is looking at.** This is the
// one a purely numerical governor gets wrong, and it has three halves by now.
//
// The first is the corner. The frames that blow the budget are exactly the
// frames where a lot is happening — a hairpin with the pack alongside, a
// mini-turbo firing, dust in the air — so a naive ladder does all its switching
// at the precise moments the player is concentrating hardest, and the draw
// distance pops at the apex. Changes wait for a straight.
//
// ── ...and the moment it must not change is not the only thing that matters —
//    so does *how many times* ────────────────────────────────────────────────
//
// Every version of this gate up to round four asked "may I change the picture
// now" and never "how many times am I about to ask that". A machine forty
// times too slow is not one rung away from the target and the governor is
// reading the number that says so; it dropped one rung anyway, waited out
// `PANIC_SETTLE`, judged, and dropped again. Measured, on the session that
// sent round four back: six changes in two hundred seconds and three of them
// inside the first three and a half race-seconds after the flag, so a player
// who had just timed a good launch watched 1088x612 become 927x522 become
// 832x468 become 736x414 while their rocket start was still burning.
//
// A gate cannot fix that, because none of those three changes was made at a
// forbidden moment — they were made one after another at moments that were
// each individually fine. The fix is upstream of the gate: **one change, sized
// from the evidence**, so the ladder spends one pop where it used to spend
// three. See `RUNG_GAIN` and `PANIC_MAX_STEP`; and see `CEREMONY_GRACE`, which
// is the other half — the grace now covers the launch it was named for instead
// of expiring a tenth of a second into it.
//
// The second is the ceremony, and it was found the expensive way. `onAStraight`
// was the only "not now" this file had, and it was consulted on the *ordinary*
// path only — while the emergency path, which is the sole path a machine slow
// enough to need this file ever takes, called `applyRung` directly. Measured
// live over two hundred seconds: all seven rung changes logged
// `dropped (panic)` or `stalled`, so the moment gate was never consulted once
// in a real session, and two of the seven landed inside the countdown — one on
// the numeral "1" and one on "GO!". The picture went 1088x612 -> 927x522 ->
// 768x432 and lost its bloom across the two seconds the player is timing a
// rocket start, in front of a near-static grid camera with nothing to mask it.
//
// So the gate is now a *phase* gate as well as a curvature one, it is consulted
// by both paths, and it is the first thing either of them asks. The countdown,
// the finish and the results sheet are held — the game is being watched rather
// than played. `CEREMONY_GRACE` carries the refusal a little past the flag,
// because the beat the flag falls on is exactly as precious as the "1" before
// it.
//
// This paragraph used to end "and a machine that has been at 1.5fps for forty
// seconds can wait a few more for the flag", with the countdown *sealed* — no
// door, at any frame rate. It is not a few more. Measured on the machine that
// sentence is about: **56 seconds of delivered play**, `liveSeconds` 84 to 140,
// reporting `locked: true, holding: 'mid-ceremony'` for all of it, because a
// three-race-second countdown at 0.087x sim rate is half a minute of wall
// clock and the file's own unit audit had converted the beat into race seconds
// and stopped there. See `SEAL_PATIENCE`. Every refusal in this file is a wait
// now; the sealed beats simply wait longer than the sweep does.
//
// The third half of that — and the reason this round was lost — is that the
// phase cannot see the front-end. **ARCHITECTURE §11a says so outright**: the
// race is built at boot and keeps simulating behind an opaque title screen, so
// `race.phase` walks `intro` → `countdown` → `racing` while the player is still
// looking at the roster, and anything drawing over the game must stand off on
// the `ui:menu` edges instead. `race/director.ts` has always done this
// (`frontEndOpen`) and `ui/coach.ts` was fixed to; this file asked the race
// director what was on screen and believed the answer. Measured live over 180
// seconds: three of five rung changes were made with the title screen and the
// machine roster on the display, all three logged `phase: intro`, and the
// remaining two landed within two tenths of a second of the flag. Every change
// the session made was made at a moment this gate exists to refuse.
//
// So the gate now asks three questions in the order they can be trusted: is
// the front-end up (an edge, published by the module that owns the screen), is
// the game paused (an edge, likewise), and only then what the race thinks it
// is doing.
//
// ── ...and then the front-end turned out to be the wrong answer twice ──────
//
// The refusal above was right about *which signal to read* and wrong about
// what to do with it. `pictureLocked()` opened `if (frontEndOpen || paused)
// return true;` — no valve, no door, no measurement — and the front-end is not
// merely a screen the governor should not change the picture behind. It was
// **the most expensive frame in the game**: 0.5-0.9fps on PRESS START against
// 1.5fps actually racing, because 356-538 draw calls and 794k-827k triangles of
// race geometry went through the full HDR post stack every frame into a buffer
// the menu's own opaque set covers edge to edge. Measured live, the governor
// reported `holding: 'front-end', locked: true` for the first fifty seconds of
// delivered play and did not move a rung until `liveSeconds` 69.96.
//
// Two changes, and they are opposites of each other, which is why the bug
// survived three rounds of people looking straight at it:
//
//   **Stop drawing it.** `budget.skipDraw` — see `frontEndCovers` and
//   `FrameBudget.skipDraw`. The update still runs; only the draw is skipped,
//   and only while the module that owns the screen is covering the whole frame
//   with its own set. That is not a quality cut, it is a frame that was being
//   thrown away by the compositor and is now not being drawn.
//
//   **Stop exempting it.** An opaque front-end is the *safest* moment in the
//   entire product to change the render scale: there is nothing on the display
//   to pop. The moment-gate argument for locking here was never true, and the
//   wait it justified was fifty seconds of a player reading four screens at
//   0.7fps. `FRONT_END_PATIENCE` is the door, and it is on the emergency path
//   only — the ordinary path still refuses, because a steady-state window taken
//   behind the menu is a measurement of the menu's set rather than of the race.
//
// The intro sweep is composed too and was the first refusal to be fitted with a
// valve, because a phase gate on a starved simulation can deadlock — see
// `CEREMONY_PATIENCE`. Every refusal in this file carries one now except the
// two whose length does not depend on the frame rate.
//
// The emergency path keeps everything else it was given: it sits *above* the
// warm-up gate rather than below it, because a machine delivering twenty frames
// a second does not need another three seconds of evidence to prove it, and it
// skips the curvature lookahead, because at 2fps there is no such thing as
// between corners. It does not get to skip the ceremony.
//
// **3. It must never touch the simulation.** There is no `fixedUpdate` in this
// file and there never may be. Everything the governor writes — `ctx.quality`,
// the renderer's shadow flag, the render resolution, and now three more flags
// on the scene graph (`visible`, `InstancedMesh.count`, `drawRange`) — is read
// only from `update` and from the draw. Nothing in physics, ai, items, race or
// track reads `ctx.quality` at all, which is what makes "the same seed puts
// every racer in the same place at every rung" a property of the design rather
// than a hope. `tools/qualitydiff.mjs` proves it by running one seed at both
// ends of the ladder and diffing the snapshots, and the content rungs are
// inside that proof — it takes the ladder's *last* rung, whatever the ladder
// currently is, so adding three could not quietly exempt them:
//
//   qualitydiff — seed 7, cone-canyon, 30s, rungs 0 vs 6
//     rung 0  high   2048 / dd 1.00 / p 1.00 |  398 calls  886,752 tris
//     rung 6  floor   448 / dd 0.55 / p 0.34 |  312 calls  570,515 tris
//     saved 22% of the draw calls, 36% of the triangles
//     control: two runs at rung 0 are byte-identical
//     identical at every checkpoint: position, speed, lap, place, coins, item
//     PASSED
//
// ── The one thing on this list that is not a quality cut ───────────────────
//
// `budget.skipDraw`. It gives up nothing: the frame it removes is a frame the
// compositor was throwing away, drawn underneath a front-end whose own opaque
// set covers the display edge to edge. Measured at 1600x900 under a software
// rasteriser, on the untouched title screen, with the page driving its own rAF
// loop and nothing touching `__GAME`:
//
//                        before            after
//   PRESS START          0.5-0.9 fps       0.8-1.1 fps
//   frame                1170-1822 ms      903-1196 ms
//   race draw calls      356-538           0
//   race triangles       794k-827k         0
//   race drawMs          2.9-12.5          0
//   governor             `front-end`,      rungs 0→1→2→3 behind the menu,
//                        rung 0, locked    then `front-end (floor)`
//   rung at the flag     0 (first change   3, reached at liveSeconds 65.8
//                        at liveSeconds
//                        69.96)
//
// What is left of that frame is almost entirely the front-end's **own** second
// renderer drawing its own set, and it is the reason the numbers above are a
// third rather than a tenth: `src/ui/menus/stage.ts` sizes its backing store
// from a hardcoded `Math.min(1, 1200 / w)` and cannot hear this ladder. The
// scale now rides on `quality:changed` for it to read; until it does, see
// `FRONT_END_FLOOR` for what this file does about only half-owning that frame.
//
// ── What it will not do ────────────────────────────────────────────────────
//
// It parks itself the moment anything drives the game through `window.__GAME`.
// A capture renders six fixed steps at a time from a Node round trip on a
// software rasteriser at two hundred milliseconds a frame; read as gameplay
// that is an argument for the bottom rung, and the review sheet would quietly
// photograph the wrong game. `budget.benchFrames` is how the engine tells the
// two apart, and two of them inside a second latch this page as a bench for
// good.
//
// It also stands down permanently the moment a human or a reviewer picks a tier
// by hand, because that is a decision and this is only a measurement.
//
// And it stops cutting when cutting stops working. Every drop records what the
// frame cost before it and checks, once the change has settled, whether the
// frame actually got cheaper. Two drops in a row that buy nothing and the
// governor puts the last one back and stands down: the machine is being held up
// by something this ladder does not own, and carrying on down it would spend
// the game's looks on nothing at all.
//
// **...and one drop that makes things measurably worse counts as both.** That
// distinction was missing and it cost a live session a third of its frame rate:
// rung 3 -> 4 was scored `{call:'futile', gain:-0.562, bar:0.188}` — the frame
// got 56% *worse* — and 0.85 seconds later the governor dropped again, because
// the strike before it had been a `worked` and the two-strike counter had just
// been cleared. The player finished at 0.48 render scale on a rung the
// instrument had already measured as slower than the one above it. "It got
// worse" is not half of "it did nothing"; it is the one reading no amount of
// spread can explain away, and it is now its own verdict, `worse`, acted on the
// moment it lands.
//
// A verdict is also **about the scene it was taken on**, so both `ui:menu`
// edges clear it. A governor that correctly measured "cutting does not help
// this title screen" must not arrive at the flag unable to cut anything.
//
// **That check has to be able to count.** It is the one place in this file that
// compares two measurements rather than a measurement against a constant, and
// the first version of it did so with a four-sample *mean* against a 4% bar. On
// the machine it exists for, delivered frames run 17ms to 1233ms around a 483ms
// median — the instrument's own spread is wider than anything it is being asked
// to resolve — and it mis-fired live: a drop that an interleaved three-pass
// measurement puts at 21-31% cheaper was scored at 3.5%, called "drops buy
// nothing", rolled back, and the player was held forty seconds at a rung a
// fifth slower than the one the governor had just taken away from them.
//
// Three things fix that, and they are worth stating separately because each one
// alone would still have been a coin toss:
//
//   - **A median, not a mean.** Two thirds of that spread is one tail; the mean
//     read 642ms where the median read 483.
//   - **Enough samples, unconditionally.** The four-sample escape hatch is
//     gone. `VERDICT_SAMPLES` or no verdict.
//   - **A bar the window itself has to clear.** The gain has to beat
//     `FUTILE_GAIN` *or* the standard error of the difference of the two
//     medians, whichever is larger. When the window is too noisy to resolve a
//     real rung — `FUTILE_RESOLVE`, above which even a working cut would read
//     as nothing — the verdict is `unresolved` and no verdict is taken at all.
//
// The asymmetry in that last one is deliberate and is the whole design. A false
// "it worked" costs the player one rung of resolution on a ladder whose every
// rung keeps the shadows, the post stack, the grade and the fog. A false "it
// bought nothing" costs them a third of their frame rate for as long as they
// keep playing. So when the instrument cannot tell, it says so, the ladder
// carries on, and the futility check stays sharp for the case it was built for
// — a vsync-locked panel, where the frame is 33ms with almost no spread, the
// standard error is a rounding error, and two cuts that move it by nothing are
// unambiguous.
//
// That last mechanism is also the answer to the one thing wall time genuinely
// cannot tell you. A display running at 30Hz delivers a 33ms frame no matter
// how idle the machine is, and from inside the page it is indistinguishable
// from a GPU taking 33ms — there is no web API for the refresh rate, and a
// `render()` that returns in 8ms says nothing about what the driver did next.
// So the governor assumes it is at fault, which is the right way round: guessing
// wrong on a 30Hz panel costs a soft rung, and guessing wrong on a slow GPU is
// the five-out-of-ten this file was sent back for. The futile check then cleans
// it up — two cuts that move a vsync-locked 33ms by nothing, and the ladder
// puts one back and leaves it alone.

import { config } from './config.ts';
// Types only — this file never imports the three *runtime*, which arrives
// through `ctx.THREE` like every other system's does. The distinction matters:
// `import type` is erased, so nothing here can put a second copy of three into
// the bundle or construct an object the scene's own namespace would not
// recognise.
import type * as THREE from 'three';
import type {
  FrameBudget, GameContext, GameSystem, QualitySettings, RaceConfig, SplineSample,
} from '../types.ts';

const nowMs = (): number =>
  (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ── the ladder ─────────────────────────────────────────────────────────────

/**
 * A rung is a complete `QualitySettings` plus the resolution the 3D is drawn
 * at, derived from `config.quality` rather than written out again — the three
 * tiers stay the authored anchors and the rungs between them are trims on top,
 * so a change to `config.quality` moves the whole ladder with it.
 */
interface Rung {
  /** Shown in `stats()` and in the probe. */
  readonly label: string;
  /** Fraction of the display's own resolution the scene is rendered at. */
  readonly scale: number;
  readonly settings: QualitySettings;
  /** ...and what comes out of the frame rather than off the resolution. */
  readonly content: ContentTrim;
}

/**
 * The content rung: what the ladder takes out of the *frame*.
 *
 * ── Why this exists, in the reviewer's own numbers ──────────────────────────
 *
 * Four rounds of this file were about instruments, and the fifth was about the
 * fact that a perfect instrument had nothing useful to pull. Measured on one
 * frozen racing frame at 1600x900, the ladder's top rung to its floor went
 * **640,276 triangles to 616,846 and 296 draw calls to 253** — three point
 * seven percent of the geometry — for a 2.1x speed-up that came entirely out of
 * the render scale. The whole ladder was a resolution slider, so a machine that
 * needed more than 2.1x walked to the bottom, was handed a 736x414 picture, and
 * still missed.
 *
 * `drawDistance` was the only content lever on it and it was not one: 1.0 to
 * 0.5 removed 23k triangles out of 640k, because `world/index.ts`'s per-batch
 * distance flag is keyed on each batch's *centre*, the batches are sector-split
 * across a 2.5km lap, and the ones near the camera — which is all of the cost —
 * are near the camera at every draw distance.
 *
 * ── What a content rung is denominated in ──────────────────────────────────
 *
 * The file's own unit rule (see the audit in the header) applies here too: a
 * cut is expressed in the unit the *eye* works in, which is projected size, not
 * metres. A traffic cone 0.6m across is eleven pixels at ninety metres on a
 * 900-line frame and five on a 450-line one, and the same rung has to mean the
 * same thing on both — so `minPx` and `shellPx` are resolved against the live
 * lens and the live drawing buffer every frame, exactly as `vehicles/index.ts`
 * already does for its part ladder. A rung that drops the render scale
 * therefore tightens its own content cut for free, which is the right
 * direction: half the pixels resolve half the detail.
 *
 * `crowd` and `scatter` are shares rather than distances because what they cut
 * is *density*, and density has no distance. They are the two levers the census
 * says are worth having — see `censusContent`.
 */
export interface ContentTrim {
  /**
   * Share of each crowd geometry's **people** that are drawn.
   *
   * A spectator bank is one geometry: the stand is built first and the crowd on
   * it is built last, front row first, so a prefix of the index buffer is
   * "the whole stand and the front rows" and the tail is the back rows under
   * the canopy. `setDrawRange` is therefore a real crowd LOD that costs one
   * call, allocates nothing, recompiles nothing and is exactly reversible —
   * and it takes the least visible people first. 1 = the full house.
   */
  crowd: number;
  /** Share of each scatter batch's instances that are drawn, thinned evenly
   *  across the batch rather than off one end. See `stratify`. */
  scatter: number;
  /** Screen-pixel radius below which **one instance** of a dressing batch is
   *  not worth submitting at all. 0 turns the test off. */
  minPx: number;
  /**
   * ...and the projected radius below which a whole racer is drawn as its
   * merged shell instead of as twenty-six separate meshes. 0 turns it off.
   *
   * **The player's own machine is protected by arithmetic rather than by a
   * special case**, and that is worth stating because it is the one thing this
   * lever must never do. A machine is about 1.1m of bounding radius, so the
   * threshold converts to a distance: at the floor's 0.50 render scale on a
   * 900-line display, `shellPx` 34 is 15.6 metres, and the chase camera sits at
   * a third of that. There is no camera a player can reach that puts their own
   * kart far enough away for its wheels to stop turning — and if a reviewer
   * asks for `far` or `overhead`, where it does, that is exactly the shot in
   * which nobody can resolve a wheel anyway.
   *
   * 18 / 26 / 34 down the three content rungs is 36m / 30m / 16m at each rung's
   * own resolution. At 36m a machine is twenty-eight pixels across and its
   * wheel is seven; the strobe on the tread lugs — which is what a rotating
   * wheel actually reads as, see `makeWheel` — is sub-pixel long before then.
   */
  shellPx: number;
}

/** Everything, which is what the top of the ladder means. */
const FULL_CONTENT: ContentTrim = { crowd: 1, scatter: 1, minPx: 0, shellPx: 0 };

function rung(
  label: string, tier: QualitySettings['tier'], scale: number,
  trim: Partial<QualitySettings> = {},
  content: Partial<ContentTrim> = {},
): Rung {
  return {
    label, scale,
    settings: { tier, ...config.quality[tier], ...trim },
    content: { ...FULL_CONTENT, ...content },
  };
}

/**
 * Rung 0 is the most expensive. The governor only ever moves one step.
 *
 * ── Why resolution leads ───────────────────────────────────────────────────
 *
 * An earlier ladder gave up draw distance first, then particles, then the
 * shadow map, and it was measured — at one frozen sim state, one rung at a
 * time — to be worth almost nothing: rung 0 to rung 3 moved the frame from 359
 * draw calls and 638k triangles to 367 and 610k, and a pixel diff of the two
 * frames put the difference at 5% of pixels and a mean delta of 4/765. Three
 * visible steps, four percent of the geometry, and no measurable time.
 *
 * That is what a triangle-shaped ladder looks like on a machine that is not
 * triangle-bound. The machines this file exists for are *fill*-bound: they are
 * drawing a 1600x900 scene into an HDR target, a bright pass, five downsample
 * mips, five upsample mips, a composite and an FXAA resolve, and a shadow map
 * on top, and every one of those costs pixels rather than vertices. Culling a
 * floodlight tower two hundred metres away removes ninety triangles from a
 * pass that was never counting triangles.
 *
 * Resolution is the one lever that scales *all* of it at once — the scene, the
 * composite, the resolve and the entire bloom chain, quadratically — and it is
 * by a long way the least visible thing on this list per millisecond bought,
 * because the game is already resolving through FXAA and a bloom. So each rung
 * takes a bite out of the render scale first, and the authored looks come off
 * alongside it in much smaller pieces.
 *
 * ── ...and why leading with it is not the same as being made of it ─────────
 *
 * All of the above is still true and it is also how this ladder scored a six.
 * "Resolution is the best lever per millisecond" is an argument about the
 * *order* of the rungs; the ladder read it as an argument about their
 * *contents*, and ended up with seven rungs of one lever. Measured end to end
 * it removed 3.7% of the geometry, which means the whole ladder was worth
 * exactly what halving the pixels is worth — 2.1x — and a machine needing more
 * than that reached the bottom, was handed a 736x414 picture, and still missed.
 *
 * A ladder needs a second axis for the same reason a gearbox needs more than
 * one gear: not because the first one is bad, but because it runs out. So the
 * bottom three rungs are **content** rungs. They keep taking their bite of
 * resolution — a rung that only moves a lever worth one percent is a rung the
 * futility check will convict, and it would be right to — and on top of it they
 * take out the two populations the census names and the seven machines'
 * mesh count. See `ContentTrim` and `censusContent`.
 *
 * ── Why there is no cliff at the bottom any more ───────────────────────────
 *
 * There used to be. The floor rung was `config.quality.low`, which drops
 * shadows, the whole post stack and AA in one step, and every part of that was
 * a mistake that measurement found:
 *
 *   - **It recompiled the game.** Turning the post stack off puts
 *     `THREE.FogExp2` back on the scene, so every material in view rebuilds.
 *     Measured live: programs 75 -> 110 and a **762ms first frame**, in the one
 *     frame the governor had picked to rescue a machine that was already
 *     failing. The ladder's rescue move was the worst hitch of the session.
 *   - **It broke the one shadow policy.** `render/lighting.ts` derives the sun,
 *     `track/terrain.ts` receives from it and `world/index.ts` casts into it,
 *     and each of those depends on the other two. A rung that switches the map
 *     off is a rung on which the cone stands on the dirt casting nothing while
 *     the barriers beside it also cast nothing — see ARCHITECTURE §12. Shadow
 *     *resolution* is a dial; the shadow map is not.
 *   - **The step above it bought nothing.** Measured at 1600x900 under
 *     SwiftShader, the old rung 3 (scale 0.72) ran at 1041ms and the old rung 4
 *     (scale 0.62) at 1067ms — a drop that made the frame *worse*, which is
 *     precisely the reading the futility check exists to catch and precisely
 *     the path it could not reach.
 *
 * So every rung on this ladder now carries the same shadow policy and the same
 * post stack, and **the whole ladder compiles one program set**. Nothing below
 * rung 0 introduces a shader the top rung has not already drawn: the tier only
 * moves between `high` and `med`, which differ in numbers rather than in
 * features, `aa` picks between two programs that are both built at boot, and
 * `bloom` skips passes rather than changing any material. A rung change is a
 * few render-target resizes and a shadow-map realloc, and nothing else.
 *
 * What is given up instead, in the order it comes off: resolution, then the
 * shadow map's *size* (2048 down to 448 — still a map, still contact), then
 * particle density and draw distance, and at the bottom three rungs the
 * *population* of the frame — the crowd's back rows, the verge's clutter, and
 * the seven machines' twenty-six meshes each. The bloom pyramid is no longer on
 * the list at all; see §0 in the header.
 *
 * ── What it measured ───────────────────────────────────────────────────────
 *
 * Median real rAF period, one frozen sim state at 1600x900 under a software
 * rasteriser, interleaved passes so page warm-up could not flatter the rung
 * that happened to go first (it very nearly did once: walked in order, rung 0
 * read 1383ms against the same rung's 683ms after twenty warm-up frames, and
 * the whole ladder looked twice as good as it is).
 *
 * **Each lever, isolated** (`__QUALITY.try`, frozen sim, median rAF period,
 * three interleaved passes, against the 986ms top rung):
 *
 *   render scale 0.88 / 0.78 / 0.68 / 0.58 / 0.48   -16% / -24% / -36% / -46% / -54%
 *   bloom off                                        -8%
 *   aa off                                           -7%
 *   drawDistance 0.5                                 -5%
 *   shadow map 2048 -> 512                           -3%
 *   shadow map 2048 -> 256                           -2%
 *   shadows off entirely                            -13%   (and 462 draws -> 290)
 *   postfx off entirely                             -35%   (the cliff; not taken)
 *
 * Two things fall straight out of that table. Resolution is not merely the best
 * lever, it is worth more than every other lever on the ladder put together —
 * so it leads every rung. And the shadow *map size* is nearly free in both
 * directions: 2048 to 256 is two percent, which is why the ladder can hand the
 * whole range back to the art direction and keep a real shadow at every rung
 * for almost nothing. What shadows actually cost is the second draw of every
 * caster (462 draw calls to 290), and that is a cost the game has decided to
 * pay everywhere — see ARCHITECTURE §12.
 *
 * **Each content lever, isolated** (`__QUALITY.content`, same frozen frame at
 * full render scale, so the geometry is the only thing moving). Triangles are
 * exact — `renderer.info`, counted after the frustum — and are what this table
 * is for. **The times are not in it, and that is deliberate.** At 1600x900
 * under SwiftShader a frame is about a second, so a fourteen-second window is
 * two or three samples, and a box with other work on it produced medians
 * ranging from 1.0s to 23.8s for the *same* rung across three interleaved
 * passes. A number that noisy is not a measurement; the exact geometry is, and
 * the rung-to-rung *time* is what the live governor's own futility check
 * measures on the machine it is actually running on — which is the instrument
 * this file spent four rounds building and is the right one to trust here:
 *
 *                       triangles      calls    against 796,844 / 386
 *   crowd 0.34            770,065        —      -27k
 *   crowd 0.16            756,147        —      -41k
 *   scatter 0.48          673,266        —      -124k
 *   scatter 0.30          628,492        —      -168k
 *   minPx 5.5             769,290        —      -28k   (8 batches gone)
 *   shellPx 60            749,704       356     -47k, -30 calls  (5 of 7)
 *   shellPx ∞             724,640       289     -72k, -97 calls  (7 of 7)
 *   all four, at floor    568,230       348     **-28.7% of the frame**
 *
 * (`shellPx` 60 is far more aggressive than any rung uses — it shells a machine
 * at eighteen metres. The ladder's own values are 18/26/34, which is thirty-six
 * to sixteen metres at each rung's own resolution, and they are chosen so that
 * a wheel has stopped reading before it stops turning. See `shellPx`.)
 *
 * The two surprises in that table are worth writing down. **Scatter is the big
 * one** — the verge's clutter is a quarter of everything drawn, because eight
 * hundred traffic cones at ninety-two triangles each is 74k on its own and the
 * drums, tyre stacks, scrub and boulders are another 53k. And **the shell buys
 * triangles as well as draws**, which it should not appear to: it is the same
 * geometry. The 72k is the *shadow* pass — a machine is a dozen casters and its
 * shell is one, which is the whole silhouette either way at the distance the
 * shell is used.
 *
 * **The ladder itself**, walked at 1600x900 on **one** frozen racing frame —
 * `setTimeScale(0)` and then `render()` only, never `advance()`, which steps
 * the simulation whatever the time scale says and quietly turns a controlled
 * A/B into seven photographs of seven different moments:
 *
 *   rung   label    scale  shadow   triangles   calls  progs  culled  shelled
 *   0      high      1.00    2048     775,346     409     87       0        0
 *   1      high-     0.88    1536     770,324     397     87       0        0
 *   2      med       0.78    1024     761,536     358     87       0        0
 *   3      med-      0.68     768     762,268     362     87       0        0
 *   4      thin      0.62     640     689,257     354     87       6        1
 *   5      sparse    0.56     512     621,653     328     87       8        3
 *   6      floor     0.50     448     572,137     278     87       9        5
 *
 *   end to end: **-26.2% of the triangles and -32.0% of the draw calls**,
 *   against -3.7% and -14.5% for the ladder this replaces.
 *
 * Rungs 0 to 3 are still flat — 775k to 762k, one and a half percent — and that
 * is not a defect, it is the design: those four rungs are the resolution ladder
 * and they are the cheapest thing to give a machine that is only a little over.
 * What is new is that the ladder no longer *ends* there.
 *
 * Every step buys more than `FUTILE_GAIN`, which is the bar the ladder before
 * last could not clear — its rung 3 to rung 4 measured *worse*. And the program
 * count is **flat for the whole descent**, against 75 -> 101 two ladders ago:
 * the ladder no longer compiles anything, so it cannot hitch on the way down.
 * (The one variant that used to appear at rung 3 — the composite drawn straight
 * to the back buffer when `aa` goes off, which is a different program from the
 * same composite drawn into a target — is now built at boot by
 * `warmPrograms()` in `render/post.ts`. The content rungs add nothing here
 * either: a shell is the machine's own materials and a thinned batch is the
 * same material with a smaller count.)
 *
 * The numbers move with the course; the shape does not. Every rung has to buy
 * more than `FUTILE_GAIN` or it is not a rung, and the futility check will now
 * actually notice — see where it sits relative to the panic branch.
 *
 * ── Why the bottom three are content and not more resolution ───────────────
 *
 * Because resolution had run out, and because the two rungs that were down
 * there instead were the ones the review convicted. The old floor took the
 * shadow map from 384 to 256 **and** switched the bloom pyramid off to buy nine
 * tenths of one percent. Photographed side by side, that step lost the verge
 * cones' contact shadows to a smear and the item boxes' glow outright — both
 * named in ARCHITECTURE §12, *contact is everything* and the item box being the
 * most-read object on the road — for a gain the instrument could not resolve
 * from noise on its own window.
 *
 * The three that replace them each carry their own bite of resolution
 * (0.68 -> 0.62 -> 0.56 -> 0.50, which is -17%, -18% and -20% of the pixels)
 * because a rung that only moves a lever worth one percent is a rung the
 * futility check will convict. What is *new* on each of them is population, and
 * the order between them is the order of what a player can name:
 *
 *   **thin** is the free one. The seven machines become their own merged shells
 *   past the distance a wheel stops turning on screen — the same picture, a
 *   third of the submissions — and the crowd loses the back rows under the
 *   canopy. Nothing has left the frame that has a name.
 *
 *   **sparse** halves the verge's clutter and takes the crowd to a third. The
 *   cones thin evenly rather than stopping (see `stratify`), so a taper is
 *   still a taper, with wider spacing.
 *
 *   **floor** is a sixth of the crowd and a third of the verge. It is the
 *   emptiest frame the game can draw and it is still, in every other respect,
 *   the same game: the same shadow policy, the same post stack, the same grade,
 *   the same glow on the item box, the same depth fog.
 */
const LADDER: readonly Rung[] = [
  rung('high', 'high', 1.00),
  rung('high-', 'high', 0.88, { shadowSize: 1536, drawDistance: 0.95 }),
  rung('med', 'med', 0.78, { shadowSize: 1024, particles: 0.75, drawDistance: 0.88 }),
  rung('med-', 'med', 0.68, { shadowSize: 768, aa: false, particles: 0.55, drawDistance: 0.76 }),
  // ── the content rungs ────────────────────────────────────────────────────
  //
  // Everything above this line is the picture getting smaller. Everything below
  // it is the picture getting *emptier*, and that is the half the ladder did
  // not have.
  //
  // The first content rung is the free one: the seven machines stop being a
  // hundred and eighty separate meshes and become their own merged shells past
  // the distance a wheel stops turning on screen, which is the same picture
  // with a third of the submissions, and the far half of the crowd's back rows
  // goes.
  rung('thin', 'med', 0.62, {
    shadowSize: 640, aa: false, particles: 0.5, drawDistance: 0.70,
  }, { crowd: 0.62, scatter: 0.72, minPx: 2.2, shellPx: 18 }),
  rung('sparse', 'med', 0.56, {
    shadowSize: 512, aa: false, particles: 0.42, drawDistance: 0.62,
  }, { crowd: 0.34, scatter: 0.48, minPx: 3.6, shellPx: 26 }),
  // The floor. Still shadowed, still composited, still graded, still glowing,
  // still fogged by the same depth-driven atmosphere as the top rung. What is
  // gone is population, not features: a thinner crowd, a thinner verge, and the
  // field drawn as seven shells. It is the emptiest frame this game can draw
  // that is still recognisably this game.
  rung('floor', 'med', 0.50, {
    shadowSize: 448, aa: false, particles: 0.34, drawDistance: 0.55,
  }, { crowd: 0.16, scatter: 0.3, minPx: 5.5, shellPx: 34 }),
];

/** Where the game starts. Top of the ladder — the governor's job is to earn
 *  its way down, not to guess a machine's class before it has drawn a frame. */
const START_RUNG = 0;

// ── the thresholds ─────────────────────────────────────────────────────────
//
// All in milliseconds of **wall time between delivered frames**, which is the
// only number that is the same thing the player experiences. It includes vsync
// idle by construction, which is why the targets below are multiples of a frame
// period rather than a work budget.

/** The frame period the game is for. */
const TARGET_MS = 1000 / 60;
/** Sustained frames this much longer than the target are a machine missing it.
 *  1.22x of 16.7 is 20.4ms — under fifty frames a second. */
const DOWN_FACTOR = 1.22;
/** A frame this much over the target is a hitch the player sees. */
const LATE_FACTOR = 1.5;
/** More than this share of the window hitching costs a rung even if the mean
 *  looks respectable — the case a mean alone can never report. */
const DOWN_LATE_FRAC = 0.12;
/** Frames this far over the target are an emergency: under twenty-eight a
 *  second, the game is failing the player worse than any pop could. */
const PANIC_FACTOR = 2.2;
/** Frames arriving inside this much of the target are arriving on time. */
const UP_FACTOR = 1.05;
/** ...and to climb, the *work* underneath them must have room too. A
 *  vsync-locked 16.7ms is the same reading on a machine with 60% headroom and
 *  on one with none, so the wall clock alone can never authorise a climb. */
const UP_WORK_MS = 8.5;
/** The spike test the old ladder never made: one bad frame in the window is
 *  enough to say there is no room, however good the mean looks. */
const UP_WORST_MS = 13;

/**
 * ── Dwells and settles, in two units each ──────────────────────────────────
 *
 * Every one of these is "wait a bit before believing that", and every one of
 * them was denominated in wall seconds alone. At 0.7 delivered frames a second
 * a wall second is less than one frame, so *all four* collapsed to "the very
 * next frame may do it" on precisely the machine they exist to protect: a
 * dwell that cannot outlast a single hitch is not a dwell, and a settle that a
 * change's own transient satisfies is not a settle.
 *
 * So each one is now a pair — wall seconds **and** delivered frames — and both
 * have to be met. On a machine that is fine the seconds bind (1.2s is 72
 * frames at 60fps, so the frame counts are free); on a machine that is failing
 * the frames bind and the guarantee is stated in the only unit that means
 * anything there: *pictures the player was actually shown*.
 */
/** Seconds over budget before a rung is given up. Real seconds. */
const DOWN_DWELL = 1.2;
/** ...and delivered frames of it, so one hitch can never be the whole case. */
const DOWN_DWELL_FRAMES = 4;
/** ...and under it before one is taken back. Deliberately much longer: a hitch
 *  may cost a rung, but nothing wins one back by accident.
 *
 *  No frame companion, and that absence is a measurement rather than an
 *  oversight: "under budget" means frames are arriving inside 17.5ms, so nine
 *  seconds of them is over five hundred frames by construction. A slow machine
 *  cannot reach this condition at all, let alone reach it early. */
const UP_DWELL = 9;
/** ...and in an emergency, where the evidence is already overwhelming. */
const PANIC_DWELL = 0.35;
/** ...but still more than one picture. Two frames at 0.7fps is 2.9 seconds,
 *  and it is what stops a single stalled frame walking the whole ladder. */
const PANIC_DWELL_FRAMES = 2;
/** Seconds after any change during which nothing is decided. */
const SETTLE = 2.2;
const SETTLE_FRAMES = 6;
/** ...and after an emergency change, where waiting is its own cost. */
const PANIC_SETTLE = 0.9;
const PANIC_SETTLE_FRAMES = 2;
/** Seconds of quiet after a harness-driven frame before measuring resumes. */
const BENCH_HOLD = 4;
/**
 * Two harness-driven frames closer together than this and the governor stands
 * down for the rest of the session.
 *
 * This is the shape that tells a bench from a player, and it took a wrong
 * answer to find it. "Park while the harness is busy" is not enough: a capture
 * recipe like `rideUntil` steps the simulation for three or four seconds of
 * wall time without rendering once, and in that window the page's own rAF loop
 * is producing perfectly genuine live frames at two hundred and fifty
 * milliseconds each on a software rasteriser. A governor that only waits for
 * quiet wakes up inside that window, reads 250ms, and walks the review sheet
 * down to the bottom rung one step at a time.
 *
 * What actually separates the two is *burstiness*. `advance()` and the capture's
 * `settle()` render eighteen to twenty-eight frames back to back; the front end
 * renders exactly one, once, to prime shaders at the start of a race. So a
 * second bench frame arriving within a second of the first is a bench, full
 * stop, and no measurement taken on this page is about a player's machine.
 */
const BENCH_BURST = 1;

/**
 * Seconds of delivered frames before the first verdict — **seconds, not
 * frames.**
 *
 * The gate this replaces was 240 rendered frames, which is four seconds at
 * sixty and two minutes and twenty seconds at 1.7, so the machines that needed
 * the governor most were the machines it refused to look at. Measured: a
 * 320x180 session reached its 240th frame at t=140.5s and dropped its first
 * rung at t=149.5s, two and a half minutes into a race the player had already
 * given up on.
 *
 * Three seconds is enough for the things that make an early frame a liar —
 * shader compilation, texture upload, the JIT — and is the same three seconds
 * on every machine.
 */
const WARMUP_S = 3;
/** ...but the emergency path arms sooner, because it is the emergency path. */
const PANIC_ARM_S = 1.4;
/** Samples before any statistic is trusted. Guards the first frames after a
 *  change, when the window has been emptied on purpose. */
const MIN_SAMPLES = 6;
/** ...and for the emergency path, which is counting frames that are each a
 *  quarter of a second long and cannot afford to wait for six of them. */
const PANIC_SAMPLES = 4;
/**
 * ...and before a *drop* is judged to have bought anything. **Unconditional.**
 *
 * There was a disjunction here — this many frames *or* `VERDICT_WAIT_S` seconds
 * with `PANIC_SAMPLES` (four) behind it — on the reasoning that fourteen frames
 * is half a minute on a machine delivering 1.7 a second and waiting half a
 * minute to notice a cut did nothing is three more cuts on the way down.
 *
 * The arithmetic in that reasoning was wrong (fourteen frames at 1.7fps is
 * eight seconds, not thirty) and the escape hatch it justified was the whole
 * bug: every verdict a slow machine ever reached was taken through it, on four
 * samples, against a window whose worst frame was 2x its mean. A four-sample
 * mean cannot resolve a 14% step in that distribution, and it did not.
 *
 * Fourteen delivered frames is a quarter of a second on a machine that is fine
 * and eight seconds on one that is failing — and eight seconds is what it costs
 * to be sure, once, before spending the rest of the session on the answer.
 */
const VERDICT_SAMPLES = 14;
/**
 * ...and if the window has not filled within this many **delivered frames** of
 * the cut, the verdict is abandoned rather than taken on thin evidence.
 *
 * Not a second escape hatch: it *drops* the verdict instead of deciding it, so
 * the ladder is unblocked and `futile` is left exactly where it was.
 *
 * ── Why this is counted in frames now ──────────────────────────────────────
 *
 * It was thirty wall seconds, and it is the fourth instance of the bug this
 * round is about. The thing it is waiting for — `VERDICT_SAMPLES` entries in
 * the window, behind `SKIP_FRAMES` discarded ones — is measured in *frames*,
 * seventeen of them; and seventeen frames is a quarter of a second on a
 * machine that is fine, 20s at 0.7fps and 34s at 0.5. So under about 0.55
 * frames a second the deadline landed before the evidence could possibly
 * arrive and **every** verdict was abandoned, on exactly the machines where a
 * futile cut costs the most. A deadline in wall seconds in front of a window
 * that fills in frames is a deadline that expires faster the slower the
 * machine is.
 *
 * Counted this way it can only be reached by frames being *discarded* — the
 * page suspended, or the harness stepping the simulation inside the window —
 * because seventeen delivered frames fill the window by definition. Eight
 * frames of slack over the seventeen, so a couple of spoiled frames do not
 * throw away an answer that was one frame away.
 */
const VERDICT_ABANDON_FRAMES = 25;

/**
 * A drop that buys less than this fraction of the frame back bought nothing.
 *
 * Set under the smallest step the ladder actually contains — rung 0 to rung 1
 * measured 7% — and well over the step the previous ladder's cheapest rungs
 * measured, which was zero. It is a detector for "this lever does not apply to
 * this machine", not a quality bar on the ladder.
 *
 * It is a **floor** under the real bar rather than the bar itself: see
 * `FUTILE_Z`. A fixed 4% against a window with a 20% standard error is not a
 * measurement, it is a coin toss with a decimal point on it.
 */
const FUTILE_GAIN = 0.04;
/**
 * ...and the bar is at least this many standard errors of the difference
 * between the two medians.
 *
 * One sigma, not two. This is not a hypothesis test that has to survive
 * publication; it is a choice about which way to be wrong, and the two ways
 * are not symmetric — see the header. One sigma keeps the check sharp on a
 * quiet window (where the error is a rounding error and the bar collapses to
 * `FUTILE_GAIN`) and mute on a noisy one, which is exactly the right shape.
 */
const FUTILE_Z = 1;
/**
 * ...and if the bar the noise demands is wider than this, no verdict is taken.
 *
 * The rungs on this ladder measure 14-26% apart. A window whose own error bar
 * is wider than 12% cannot tell a working cut from a useless one, so a "futile"
 * read off it means nothing — and acting on it costs the player a fifth of
 * their frame rate for the rest of the session. Above this, the answer is
 * `unresolved`, which is a real answer and is reported as one.
 */
const FUTILE_RESOLVE = 0.12;
/** MAD -> sigma for a normal sample. */
const MAD_SIGMA = 1.4826;
/** ...and sigma -> the standard error of a *median*, which is sqrt(pi/2) wider
 *  than the standard error of a mean over the same samples. */
const MEDIAN_SE = 1.2533;
/**
 * ── How far one emergency drop is allowed to go ────────────────────────────
 *
 * The emergency path used to move exactly one rung, wait out `PANIC_SETTLE`,
 * judge, and move one more — which is correct arithmetic and the wrong *shape*
 * for what the player is looking at. Measured on the session this round was
 * sent back for: six changes in two hundred seconds, three of them inside the
 * first three and a half race-seconds after the flag, so a player who had just
 * launched watched the picture step down at 1.30, 2.44 and 3.58. Three pops
 * cost three times what one pop costs and buy exactly what one bigger pop would
 * have bought.
 *
 * A machine at 900ms a frame is not one rung away from the target, it is
 * forty-four times too slow, and the governor already knows that — it is
 * reading the number. So the emergency path now sizes its step from the
 * evidence instead of always taking one:
 *
 *   steps = round( ln(how many times too slow) / ln(RUNG_GAIN) )
 *
 * `RUNG_GAIN` is measured, not guessed: the interleaved frozen-frame walk of
 * the ladder puts adjacent rungs between 14% and 26% apart, and 1.20 is the
 * geometric middle of that. It is deliberately an *under*-estimate of what a
 * content rung buys, because the two ways of being wrong are not symmetric —
 * an under-sized jump costs one more change, an over-sized one hands the player
 * a worse picture than the machine needed and the ladder cannot climb back out
 * of it while the machine is still failing.
 *
 * The cap is the other half of that asymmetry. Three rungs reaches the floor of
 * a seven-rung ladder in two changes from the top, which is the number this
 * round is about, and it keeps a single wildly wrong reading — one stalled
 * frame, one garbage collection — from spending the entire ladder at once.
 */
const RUNG_GAIN = 1.2;
const PANIC_MAX_STEP = 3;
/** Consecutive futile drops before the governor puts one back and stands down. */
const FUTILE_LIMIT = 2;
/** ...and how much worse the frame has to get before it tries again. */
const RETRY_FACTOR = 1.4;

/** Frames of wall history. Emptied on every change, so it is never a mean
 *  across two different games. */
const WALL_WINDOW = 64;
/**
 * Frames thrown away after a change, before the window starts filling again.
 *
 * A settle counted in *seconds* is not a settle when a frame costs half of one.
 * Measured on the first live run of this ladder: the panic path's 0.9s lockout
 * was a single frame at 500ms, so every verdict included the frame in which the
 * shadow map was disposed and reallocated and the post stack's five mips were
 * resized. The change log came out non-monotone because of it — a rung that
 * dropped the frame from 913ms to 464ms was followed by one that "measured"
 * 690ms, which was the reallocation and not the game. The seconds-based settle
 * still runs on top, for the slower things (a batch of dressing coming back
 * into range).
 *
 * Three rather than two because the floor rung's shader recompiles do not all
 * land on one frame: three.js compiles a material the first time it draws it,
 * so turning the post stack off spreads its thirty new programs over however
 * many frames it takes for those objects to come into view. A 1.9-second frame
 * got past a two-frame skip on the live run and then sat in `wallWorst` for the
 * next sixty samples.
 *
 * ── ...but skipped is not the same as unmeasured ───────────────────────────
 *
 * These frames are excluded from the *steady-state* window because they are
 * the change reallocating itself rather than the game — that part was and is
 * right. What was wrong is that they were **thrown away**, which made the one
 * hitch the governor is personally responsible for the one hitch its own
 * instrument could not see. A governor structurally blind to the cost of its
 * own action cannot be asked whether its action was worth it.
 *
 * So the worst of them is now recorded on the change's own log entry as
 * `changeMs`, next to the `wallMs` the frame cost before it, and the worst of
 * the session is in the probe. See `changeCost` below and the note on
 * `precompileLadder`, which is where the number went once somebody could
 * finally read it.
 */
const SKIP_FRAMES = 3;

/**
 * ── The grave of `STALL_MS` ────────────────────────────────────────────────
 *
 * There was a constant here that read: *a gap longer than two seconds was not a
 * frame — an alt-tab, a breakpoint, a harness stall — and averaging it in would
 * convict the machine of it.* Every word of that is defensible and the rule it
 * produced destroyed the instrument.
 *
 * A numeric cut-off on frame length **discards exactly the frames this file
 * exists to measure**. Measured live at 1600x900 on a software rasteriser, the
 * top rung delivers frames 1.7 to 2.6 seconds apart; over two hundred seconds
 * of wall time the accumulator below accrued **1.66 seconds**, the sample window
 * never took a single entry, and `probe()` answered `holding: 'priming',
 * samples: 0` for three minutes on the one machine the governor exists to
 * protect. The warm-up gate that this replaced had the same property counted in
 * frames; moving it to seconds moved the bug one layer down rather than fixing
 * it. There is no third version of this shape: **frame length is never again
 * evidence about whether a frame is real.**
 *
 * What the cut-off was actually reaching for is two causes, and both of them
 * can be observed directly instead of guessed at from a duration:
 *
 *   - **The page was suspended.** A backgrounded tab, a bfcache restore, a
 *     phone locking. `document.visibilityState` says so, and the
 *     `visibilitychange` edge says exactly which gap spans it. One frame is
 *     discarded — the one that straddles the resume — and a genuine 2.4 second
 *     frame on a visible page counts as 2.4 seconds.
 *   - **The harness was driving.** `__GAME.step()` runs the simulation inside a
 *     `page.evaluate` with the rAF loop blocked behind it, so the callback that
 *     lands afterwards measures somebody else's work. `budget.benchSteps`
 *     counts those steps, so the frame that contains them is identifiable as a
 *     fact rather than as a suspiciously long one.
 *
 * Everything else — a slow GPU, a compositor stall, a garbage collection, a
 * genuinely enormous frame — is this machine being slow, which is the thing
 * being measured.
 *
 * There is deliberately no constant left here to tune.
 */

/** Curvature that still counts as straight. ~250m radius. */
const STRAIGHT = 0.004;
/** Seconds of road ahead that also has to be straight. */
const LOOKAHEAD = 1.3;

/**
 * The phases the picture is **composed** in: watched rather than driven.
 *
 * `countdown` is three beats and a flag in front of a near-static rig with the
 * player timing a rocket start; `finished` is the letterbox and the victory
 * lens; `results` is the standings sheet; `intro` is the grid sweep. `loading`
 * is both the boot and — see ARCHITECTURE §11a — the pause screen, which is a
 * still frame of the game with a plate over it and therefore the single worst
 * surface in the product to change the resolution on: nothing is moving to hide
 * it and the player is looking straight at it.
 *
 * Nothing here is about how fast the machine is. It is about whether anyone is
 * driving. How long each of them may hold the governor off *is* about how fast
 * the machine is, and that is `patienceFor` below.
 */
function isComposed(phase: string | undefined): boolean {
  return phase === 'intro' || phase === 'countdown' || phase === 'finished'
    || phase === 'results' || phase === 'loading';
}

/**
 * **Race** seconds after the flag before the picture may change again.
 *
 * The flag falling is the same beat as the "1" before it: the player is timing
 * a rocket start and about to look at a screen full of boost. A gate that
 * opened on the frame the phase turns `racing` would have moved the two
 * changes this constant exists for by a tenth of a second and photographed
 * exactly as badly.
 *
 * ── Why it is race seconds and not the seconds it used to be ───────────────
 *
 * It was 1.2 seconds of *delivered play*, accumulated in this file off the
 * wall clock, and it was the round-3 failure. The beat it is protecting is a
 * beat of the **game**: the countdown is three race-seconds long, the rocket
 * start's boost is a fixed number of race-seconds, and the whole gesture the
 * player is watching runs on `ctx.race.time`. Wall time and race time are the
 * same thing at 60fps and come apart by a factor of twenty-one at 0.7fps,
 * because `engine.ts` caps the fixed step at eight per frame and the
 * simulation goes into slow motion — so 1.2 wall seconds of protection was a
 * single frame, and the rung changes it exists to move landed on GO (race time
 * 0.0-0.2s) and at race time 1.2s, which is to say on the flag and on the
 * boost. Measured, photographed, and precisely the thing this gate is for.
 *
 * ── ...and why it is not `ctx.race.time`, which was the obvious answer ─────
 *
 * `race.time` is zero at the flag and advances only with the simulation, so it
 * is the right *unit*. It is the wrong *signal*, and the bench caught it: the
 * director's `beginCountdown()` does not reset it, so after a `race:seek` the
 * flag falls with `race.time` already reading fifteen seconds and the gate is
 * wide open on the frame the field is released. A reviewer's seek is the one
 * way a real session reaches a countdown twice, and it is precisely how this
 * gate is tested — a gate that its own test cannot arm is a gate that passes
 * its own test.
 *
 * So the flag is taken from the flag: `race:racing` is the transition edge the
 * director emits (and `setPhaseQuiet` deliberately does *not*, so pause and
 * resume do not counterfeit one), and this is measured from `ctx.time.elapsed`
 * at that moment, which is the fixed-step clock — literally "fixed steps since
 * the flag", counted in seconds. An edge published by the module that owns the
 * fact, exactly like `ui:menu` above it.
 *
 * ── ...and why it is now as long as the launch, rather than 1.2s ──────────
 *
 * 1.2 was a number. What the gate is actually protecting is a *gesture*: the
 * player times the flag, holds accelerate through the last beat, and the game
 * answers with `config.race.rocketStart.boost` — 1.5 race-seconds of boost,
 * screen effects, sound and camera kick, which is the single loudest thing the
 * game ever does and the single most-watched second and a half in a race. A
 * grace that expires at 1.2 lets go **inside** it.
 *
 * Measured, on the session this round was sent back for: six rung changes in
 * two hundred seconds, and three of them at race time 1.30, 2.44 and 3.58 —
 * every one of them after the old grace and every one of them during or
 * immediately after the rocket start. The player watched 1088x612 become
 * 927x522 become 832x468 become 736x414 across the three and a half seconds
 * they were being rewarded for a good launch.
 *
 * So it is derived from the boost rather than chosen: the launch is over when
 * the boost that *is* the launch is over, plus a beat to look away in. A
 * number two modules have to agree about is an interface, not a tuning
 * constant — ARCHITECTURE §11a — and the race owns this one.
 *
 * ── ...and why it now has a door, when the last version argued it needed none ─
 *
 * The old argument was: this is measured on the fixed-step clock, `engine.ts`
 * caps the fixed step at eight per frame, so every delivered frame buys
 * exactly 0.067 sim-seconds and the gate opens after eighteen pictures at any
 * frame rate. All of that is still true. What has changed is the arithmetic on
 * the other side of it: 2.2 race-seconds is **thirty-three** pictures, which at
 * 0.7 delivered frames a second is forty-seven wall seconds of a player sitting
 * at 0.7fps while the governor refuses to help.
 *
 * That is the exact shape `SEAL_PATIENCE` was added for — a refusal whose cost
 * in the unit a person waits in grows with the slowness it is gating — and the
 * previous round's version of this file argued its way out of it by measuring
 * the grace in pictures and never converting the answer into seconds. Eighteen
 * pictures was defensible without a door. Thirty-three is not, so it has the
 * same door every other refusal in this file has. See `LAUNCH_PATIENCE`.
 */
const CEREMONY_GRACE = config.race.rocketStart.boost.time + 0.7;
/**
 * ...and the door on it, in wall seconds of delivered play since the flag.
 *
 * Unreachable on any machine that is not failing: 2.2 race-seconds is 2.2 wall
 * seconds at 60fps and about 4 at 15fps, so the grace is over long before this
 * is. It opens only below about one and a half frames a second, which is where
 * the grace's own cost has grown past half a minute and the player has bigger
 * problems than a resolution change during their boost.
 */
const LAUNCH_PATIENCE = 22;
/**
 * ── The valve, and why one is needed at all ────────────────────────────────
 *
 * Seconds of delivered play inside the **intro sweep** before the emergency
 * path may act inside it after all. There is no equivalent for the sealed
 * phases above; this is the only door in the gate and the intro is the only
 * room it opens onto.
 *
 * A gate keyed on a *phase* has a property that is not obvious and is
 * dangerous: **its cost is proportional to the slowness it is gating.**
 * (`CEREMONY_GRACE` above is keyed on the race clock rather than on a phase,
 * which is why it is bounded in delivered frames and needs no door of its own.)
 * `engine.ts` caps the
 * fixed step at eight per frame to avoid a spiral, so once a frame costs more
 * than 66ms the simulation stops keeping up with the wall clock and the whole
 * game enters slow motion. A 3.2 second intro is 3.2 seconds at 60fps, 4.8
 * seconds at 10fps, 24 seconds at 2fps — and, measured on this box under a
 * software rasteriser at 0.65fps, **72 seconds**, with the countdown behind it
 * taking another 68. A gate keyed on the phase therefore locks the governor out
 * for longer the more the machine needs it, which is the exact shape of the two
 * bugs in the header (a warm-up counted in frames, a stall counted in
 * milliseconds) pointed at a third target. Left absolute, it deadlocks: the
 * governor cannot make the frame cheaper until the ceremony ends, and the
 * ceremony cannot end until the frame is cheaper. Measured, before this valve
 * existed: a 110-second live session that never reached the flag and never
 * moved off rung 0, reporting `mid-ceremony` for all of it.
 *
 * So the sweep — and only the sweep, which is a camera move over a field
 * driving into its slots, not a beat the player is timing — gives up after
 * this long. Twenty seconds is chosen so that it can only ever open below
 * about two and a half frames a second: at 5fps the sweep takes 9.6s and the
 * valve is unreachable, at 2fps it takes 24s and the valve opens for the last
 * four. And what comes through it pays for itself immediately — a rung off the
 * intro is a cheaper frame, a cheaper frame is a faster simulation, and the
 * countdown that follows is shorter.
 */
const CEREMONY_PATIENCE = 20;
/**
 * ...and the same door on the **sealed** beats — the countdown, the flag, the
 * results sheet.
 *
 * The round this was added is the round the sweep's valve was measured to be
 * *half* the answer. The header used to argue that only the intro needed a
 * door, on the reasoning that "a machine that has been at 1.5fps for forty
 * seconds can wait a few more for the flag". Measured, on the machine that
 * argument is about, it is not a few more: the countdown seal cost **56
 * seconds of delivered play** at 1.2-1.3fps, from `liveSeconds` 84 to 140,
 * reporting `locked: true, holding: 'mid-ceremony'` for all of it. Three
 * race-seconds of countdown plus 1.2 race-seconds of `CEREMONY_GRACE` is
 * fifty-six wall seconds once `engine.ts`'s eight-step cap puts the simulation
 * at 0.087x, and the file's own unit audit had marked both constants "ok" in
 * race seconds and never once converted them into what a person waits.
 *
 * That is the *exact* shape the header names as the class of bug this file
 * keeps losing rounds to — a gate whose cost is proportional to the slowness it
 * is gating — and the file had fitted a door to one instance of it and argued
 * the other away. So both have doors now.
 *
 * Much longer than the sweep's, because a countdown is a beat the player is
 * timing and the sweep is a camera move nobody is. Thirty-five seconds of
 * *delivered play inside this one beat* — the clock restarts on every phase
 * change, so the sweep's twenty cannot be spent on the countdown's account —
 * is a **twelve-fold** overrun of a three-race-second beat. At 60fps it is
 * unreachable by a factor of twelve; at 5fps a countdown takes 7s and it is
 * still unreachable; it opens only below about one and a half frames a second,
 * where the measured wait is fifty-six seconds and no amount of not-popping is
 * worth another twenty of them.
 *
 * It is also deliberately longer than the thirty-second pressure window in
 * `tools/perfgate.mjs`, which seeks straight into a countdown at rung 0 and
 * asserts that the rung does not move for the whole of it. That assertion is
 * the previous round's fix and it is still the right test of the *seal*; a
 * valve that its own regression test could trip would be a valve that had
 * quietly replaced the thing it was fitted to.
 */
const SEAL_PATIENCE = 35;
/**
 * ...and the front-end's, which is the one this round was actually lost for.
 *
 * `pictureLocked()` opened with `if (frontEndOpen || paused) return true;` — an
 * unconditional refusal with no valve at all, on the single most expensive
 * frame in the product. Measured: the governor held `front-end` for the first
 * ~50 seconds of delivered play at 0.6-1.0fps and did not move a rung until
 * `liveSeconds` 69.96.
 *
 * Two things make that indefensible rather than merely cautious.
 *
 * **The refusal was protecting a picture that is not on the screen.** The
 * front-end's own opaque set covers the frame edge to edge; that is what
 * `budget.skipDraw` now exploits, and it is also why a rung change made behind
 * it is the *least* visible change this governor can ever make. There is no
 * pop to hide. The moment-gate argument for locking here was never true.
 *
 * **And the wait is unbounded in the only unit that matters.** The front-end
 * ends when a player presses a key, which sounds like the bounded case in the
 * header's corollary — but the fifty seconds above are fifty seconds of a
 * player *reading four screens* at 0.7fps, where every keypress they make is
 * answered a second and a half later. The frame rate is not slowing the thing
 * being waited for; it is what the player is stuck inside.
 *
 * So the panic path gets a door here too, and a shorter one than either
 * ceremony: twelve seconds. At 60fps twelve seconds of front-end is normal and
 * the valve is harmless because the panic threshold is nowhere near met; at
 * 0.7fps it is eight delivered frames and the machine has already proved
 * itself. The ordinary path stays shut behind the menu unconditionally — it
 * decides on a steady-state window, and the window behind the front-end is a
 * measurement of the menu's set rather than of the race.
 */
const FRONT_END_PATIENCE = 12;
/**
 * ...and how far down the ladder that door opens onto.
 *
 * Behind the front-end the governor is measuring a frame it only partly owns.
 * The race's draw is switched off entirely (`FrameBudget.skipDraw`), so what is
 * left is the race's `update` — CPU, and small — plus the menus' own second
 * renderer drawing their own set. Measured with the race draw removed: 903-1175
 * ms a frame at 1600x900 under a software rasteriser, essentially all of it the
 * front-end's set, and **none of it responsive to the render scale**, because
 * `src/ui/menus/stage.ts` sizes its backing store from a hardcoded
 * `Math.min(1, 1200 / w)`. Until that reads the scale this file publishes on
 * `quality:changed`, a drop taken here cannot make this frame cheaper and every
 * verdict on one will read `futile`.
 *
 * That does not make the evidence worthless — a machine that cannot draw a
 * title screen at thirty frames a second is not going to race at rung 0, and
 * starting the race three rungs down saves the player the three minutes the
 * ladder measurably used to take to find that out (boot to the floor: 186
 * seconds of delivered play). It makes it *partial*. So the front-end may spend
 * the top of the ladder, where the losses are resolution and a shadow map
 * nobody can measure, and the bottom — the particle density, the draw distance
 * and the glow — has to be earned on the road, on evidence about the road.
 *
 * **This cap is a symptom and should be removed with its cause.** The day
 * `ui/menus/stage.ts` derives its backing store from the `scale` now carried on
 * `quality:changed` — one line, `Math.min(1, 1200 / w) * scale` — the frame
 * behind the front-end becomes a frame this ladder owns, every rung taken here
 * becomes a rung that measurably paid for itself, and the honest bottom is the
 * ladder's own bottom again.
 */
const FRONT_END_FLOOR = 3;

// ── the content pass's own constants ───────────────────────────────────────

/**
 * Instanced dressing at or under this bounding radius, in metres, is
 * **scatter**: a thing there are hundreds of, none of which is a landmark.
 *
 * Measured off the census of a settled Cone Canyon frame. Under this line sit
 * the traffic cones (0.6m, 807 of them, 74,244 triangles — the single largest
 * named row in the world), the drums (0.7m, 96), the tyre stacks (0.9m, 85),
 * the scrub (1.1m, 98) and the boulders (1.8m, 94). Over it sit the things the
 * eye navigates by — the crane, the mast, the land masses, the floodlight
 * towers, the grandstands — and thinning any of those is thinning the *place*
 * rather than the clutter in it.
 */
const SCATTER_MAX_R = 2.6;
/**
 * ...and fewer instances than this in a batch and thinning it shows.
 *
 * Nine cones taken down to five is a gap in a taper. Two hundred taken down to
 * a hundred and twenty is a slightly less busy verge, which is what a content
 * rung is allowed to look like.
 */
const SCATTER_MIN_N = 14;
/**
 * How far past a screen-size threshold a thing has to climb before it comes
 * back.
 *
 * The same dead band `vehicles/index.ts` puts on its part ladder and for the
 * same reason: a batch — or a rival — sitting exactly on the cut is a batch
 * sitting exactly on the cut for the whole corner, and without a band it
 * strobes once a frame.
 */
const CONTENT_HYSTERESIS = 1.25;

/** One entry in the change log. Built only when the ladder actually moves. */
export interface QualityChange {
  /** Seconds of delivered play since boot. */
  t: number;
  from: number;
  to: number;
  why: string;
  /** What the frame cost, in wall milliseconds, at the moment of the change. */
  wallMs: number;
  /** ...and what share of that was CPU work, so the reason is legible later. */
  workMs: number;
  bound: string;
  /**
   * The race phase the change landed in.
   *
   * Recorded because the last review of this file had to *photograph* the
   * moment of each change to discover that two of them fired inside the
   * countdown. That should be readable off the log rather than off a
   * screenshot. `racing` is the ordinary answer and `intro` is the only other
   * legal one — it means a machine so slow that the sweep had run for twenty
   * seconds, and see `CEREMONY_PATIENCE` for why that is a door rather than a
   * hole. Anything else here is a bug in the moment gate.
   */
  phase: string;
  /**
   * ...and the race clock, because the phase alone could not say *where in the
   * beat* a change landed.
   *
   * The review that sent this file back reported "rung 3 to 4 fired between
   * race time 0.0 and 0.2s, on GO" — a fact the log could not express, because
   * both changes were honestly labelled `racing`. Zero here means the flag
   * frame itself.
   */
  raceTime: number;
  /**
   * ...and the number the gate actually used: seconds on the fixed-step clock
   * since the `race:racing` edge.
   *
   * **Anything under `CEREMONY_GRACE` here is a bug in the moment gate.** It is
   * a separate field from `raceTime` because the two come apart, and the way
   * they come apart is itself the reading: `beginCountdown()` does not reset
   * `ctx.race.time`, so after a reviewer's seek the race clock says fifteen
   * seconds on the frame the flag falls. See `CEREMONY_GRACE`.
   */
  sinceFlag: number;
  /**
   * The front-end, as the gate saw it at the moment of the change.
   *
   * `true` on this line used to be a straight failure — a change made with the
   * title screen on the display. It is legal now, but only in one combination
   * and only through `FRONT_END_PATIENCE`, which is why the next field exists.
   */
  frontEnd: boolean;
  /**
   * ...and whether the front-end was actually *covering the frame* at that
   * moment, which is the fact that makes `frontEnd: true` acceptable.
   *
   * `frontEnd: true, covered: true` is a rung change made behind an opaque set
   * — the least visible change this governor can make, and the reason the
   * front-end has a valve at all. `frontEnd: true, covered: false` is the
   * round-3 failure: a change made over a screen the player can see through.
   * It should never appear on this log.
   */
  covered: boolean;
  /**
   * Seconds of delivered play the refusal that had to give way had been
   * running for: the front-end's clock behind a menu, the composed beat's
   * inside a ceremony, and 0 where the gate was simply open.
   *
   * Every gate in this file is a wait now rather than a wall, so "which gate
   * let this through, and how long had the player been inside it" is the fact a
   * reviewer needs and could not previously get without a stopwatch and a
   * screenshot. A change with `phase: 'countdown'` and `heldFor: 41.6` is a
   * countdown that has overrun its three race-seconds by a factor of fourteen;
   * the same line with `heldFor: 2` would be the round-3 bug.
   */
  heldFor: number;
  /**
   * **What the change itself cost**, in wall milliseconds: the worst delivered
   * frame of the `SKIP_FRAMES` the window discards after it.
   *
   * The governor spends the player's frame rate to buy the player's frame
   * rate, and until this field existed it could see only one side of that
   * trade — the frames it discarded to avoid measuring its own reallocation
   * were the only frames that contained its own reallocation. Compare it with
   * `wallMs` on the same line: 687 against 252 is what a rung change cost
   * before the duplicate canvas resize in `engine.ts` was removed.
   *
   * Zero until the skipped frames have gone by, so a log read the instant
   * after a change shows it as 0 rather than as a lie.
   *
   * ...and zero **for good** when any of those frames was spoiled — the page
   * suspended, the harness stepping, or a hand call into `__QUALITY` from a
   * reviewer's `page.evaluate`. That last one is not hypothetical: it is where
   * `changeWorstMs: 15,628.6` came from on a frozen-sim bench whose real switch
   * cost was 6-17.5ms, because an evaluate moves neither `benchSteps` nor
   * `benchFrames` and the Node round trip after each switch landed on the
   * governor's account. Unmeasurable is reported as unmeasured; see
   * `externalTouch`.
   */
  changeMs: number;
}

/**
 * One judgement of "did that cut buy anything", kept whatever the answer.
 *
 * The change log can only ever show the verdicts that *moved* the ladder, which
 * is the minority of them and the least interesting: a review reading it saw
 * `stalled (drops buy nothing)` with no way to see the numbers behind the call
 * or the four samples it was taken on. Every verdict is recorded here, with the
 * bar it had to clear and the spread that set the bar.
 */
export interface QualityVerdict {
  t: number;
  /** The rung the cut arrived at. */
  rung: number;
  /**
   * `worked` | `futile` | `worse` | `unresolved` | `abandoned`.
   *
   * `worse` is separate from `futile` and the separation is load-bearing. A
   * futile cut bought nothing; a `worse` cut made the frame measurably *worse*
   * than it was before, by more than the window's own error bar. Measured live
   * on the ladder this replaces: `{rung:4, call:'futile', beforeMs:537.7,
   * afterMs:839.8, gain:-0.562, bar:0.188}` — a cut that cost 56% of the frame
   * — followed by another drop 0.85s later, because `futile` had only reached
   * one and `FUTILE_LIMIT` is two. The player finished the session at 0.48
   * render scale on a rung the instrument had already measured as slower than
   * the one above it.
   *
   * "It got worse" is not half of "it did nothing". It is the one reading no
   * amount of spread can explain away, and it is acted on at once.
   */
  call: string;
  /** Median delivered frame before the cut, and after it. */
  beforeMs: number;
  afterMs: number;
  /** Fraction of the frame the cut bought back. Negative means it cost. */
  gain: number;
  /** ...and the fraction it had to beat to count, which is `FUTILE_GAIN` or
   *  the window's own standard error, whichever is larger. */
  bar: number;
  /** Delivered frames the verdict was taken over. */
  samples: number;
}

export interface QualityProbe {
  auto: boolean;
  benched: boolean;
  rung: number;
  label: string;
  tier: QualitySettings['tier'];
  /** Render resolution as a fraction of the display's. */
  scale: number;
  drawDistance: number;
  particles: number;
  shadowSize: number;
  /**
   * The content rung, and whether it found anything to spend.
   *
   * `crowd`/`scatter`/`minPx`/`shellPx` are what the rung asked for;
   * `crowdGeos`/`batches`/`cullables`/`shells` are what the census found to
   * apply it to, and `culled`/`shelled` are what it is holding off *this
   * frame*. A rung whose numbers are set and whose counts are zero is a census
   * that matched nothing — a renamed prop, a course with no crowd — and the
   * whole point of reporting both is that this reads as a broken classifier
   * rather than as a lever that mysteriously buys nothing.
   */
  content: {
    crowd: number; scatter: number; minPx: number; shellPx: number;
    crowdGeos: number; batches: number; cullables: number; shells: number;
    culled: number; shelled: number;
  };

  // ── the instrument: wall time between delivered frames ───────────────────
  /** Mean delivered frame time. **This is the number the ladder decides on.** */
  wallMs: number;
  /** ...and the median of the same window, which is what the *futility* verdict
   *  decides on. A big gap between the two is a long tail, and a long tail is
   *  the reading that makes a four-sample mean worthless. */
  wallMedianMs: number;
  /** Median absolute deviation of the window — the spread the verdict's bar is
   *  built from. Reported so a review can see why a verdict was unresolved. */
  wallMadMs: number;
  /** Worst frame in the window. A mean cannot report a stutter; this can. */
  wallWorstMs: number;
  /** Fastest frame in the window — the machine's own floor, near enough the
   *  display period whenever anything is vsync-locked. */
  wallBestMs: number;
  /** Share of the window that arrived later than 1.5 frame periods. */
  lateFrac: number;
  /** Frames in the window. Below `MIN_SAMPLES` nothing is decided. */
  samples: number;
  /** Delivered frames a second, which is the thing a player would say. */
  fps: number;

  // ── the work, kept only to attribute blame once wall time has convicted ──
  /** CPU work over the *same* frames as `wallMs`. Compare the two. */
  workMs: number;
  /** The engine's own sixty-frame mean. Kept because it is what `stats()`
   *  reports, and because the gap between it and `workMs` is itself a reading:
   *  a big one means the machine's speed changed recently. */
  meanMs: number;
  worstMs: number;
  simMs: number;
  drawMs: number;
  /** 'sim' | 'draw' | 'gpu' | 'vsync' — where the frame actually went. */
  bound: string;

  /** Seconds the current verdict has been held. Negative while settling. */
  dwell: number;
  /** Seconds of delivered play since boot. The warm-up gate counts this. */
  liveSeconds: number;
  /** Why the governor is not acting right now, or the last thing it did. */
  holding: string;
  /** Drops in a row that bought nothing, and whether it has given up. */
  futile: number;
  stalled: boolean;
  /**
   * Frames thrown away because the page was suspended through them, and frames
   * thrown away because the harness stepped the simulation inside them.
   *
   * Reported rather than silently discarded, because the last two reviews of
   * this file were both lost to an instrument that was quietly throwing
   * evidence away: `suspended` climbing while `samples` sits at zero is the
   * exact signature, and it is now visible from the probe instead of having to
   * be inferred from a governor that never moves.
   */
  suspended: number;
  hijacked: number;
  /** The race phase, as the moment gate sees it, and whether the gate is shut.
   *  A change logged with `locked: true` would be a bug. */
  phase: string;
  locked: boolean;
  /**
   * The two facts `phase` cannot carry, straight off the edges that publish
   * them: is the front-end up, and is the game paused.
   *
   * ARCHITECTURE §11a: the race keeps simulating behind an opaque title screen,
   * so a probe reporting `phase: 'racing'` may well be describing a game
   * nobody can see. These two say which.
   */
  frontEnd: boolean;
  /**
   * ...and whether the front-end is covering the *whole frame* with an opaque
   * set of its own, which is a different question and the one the engine acts
   * on. True here means the race behind it is not being drawn at all —
   * `budget.skipDraw`, and `stats().drawSkipped` on the same frame.
   */
  frontEndCovers: boolean;
  /** Seconds of delivered play the front-end and the current composed beat have
   *  each been up. The two patience valves count these; compare them against
   *  `FRONT_END_PATIENCE`, `CEREMONY_PATIENCE` and `SEAL_PATIENCE` to see how
   *  much of a refusal is left. */
  frontEndFor: number;
  ceremonyFor: number;
  paused: boolean;
  /** What the race director's clock says, and what the flag's grace actually
   *  measures — seconds on the fixed-step clock since `race:racing`. They come
   *  apart after a seek; see `QualityChange.sinceFlag`. */
  raceTime: number;
  sinceFlag: number;
  /** The worst frame of the last change's own reallocation, and the worst of
   *  the session — the cost of the governor's own action, which for three
   *  rounds it was structurally unable to see. */
  changeMs: number;
  changeWorstMs: number;
  /** Every change this session, most recent last. */
  log: QualityChange[];
  /** ...and every judgement of a change, whether or not it moved anything. */
  verdicts: QualityVerdict[];
}

export function createQualitySystem(ctx: GameContext): GameSystem {
  let index = START_RUNG;
  let auto = true;
  /** The exact object we last wrote to `ctx.quality`, so a tier set by anyone
   *  else is recognisable by identity rather than by comparing fields. */
  let applied: QualitySettings | null = null;

  // ── the wall-clock instrument ────────────────────────────────────────────
  const wall = new Float32Array(WALL_WINDOW);
  /**
   * CPU work for the same frames, sample for sample.
   *
   * `budget.meanMs` cannot be used for this. It averages sixty *frames*, which
   * is a second on a machine that is fine and thirty-five seconds on one that
   * is delivering 1.7 — so on exactly the machine the attribution matters for,
   * it reports work from half a minute ago. Measured: while the steady state
   * read 6.6ms of work against a 590ms frame, `budget.meanMs` was still saying
   * 699ms and the change log was blaming the draw for a frame that was idling
   * in the driver. Same samples, same window, or the comparison is not one.
   */
  const work = new Float32Array(WALL_WINDOW);
  let wallIdx = 0;
  let wallCount = 0;
  /** Frames still to discard after a change. See `SKIP_FRAMES`. */
  let skipFrames = 0;
  /** `performance.now()` at the previous delivered frame, or 0. */
  let lastFrameAt = 0;
  /** Rendered frames the rAF loop drove, as last seen. */
  let seenLive = -1;
  /** ...and fixed steps the *harness* drove, as last seen. A frame whose gap
   *  contains any of those measured somebody else's work. */
  let seenBenchSteps = -1;
  /** Latched between delivered frames: the harness stepped or drew inside this
   *  gap. Cleared by the live frame that discards itself for it. */
  let harnessSince = false;

  // ── was this a frame, or was the page not running ────────────────────────
  //
  // See the note where `STALL_MS` used to be. These two are the whole of the
  // suspension test, and neither of them looks at how long the frame was.
  /** The page is backgrounded; nothing it does not deliver is its fault. */
  let pageHidden = false;
  /** A visible edge landed since the last frame, so the next gap spans the
   *  suspension rather than a frame. Exactly one frame is discarded for it. */
  let resumed = false;
  /** Frames discarded because the page was not running through them. Reported,
   *  because an instrument that quietly throws things away is how this file
   *  failed its last two reviews. */
  let suspended = 0;
  /** ...and frames discarded because the harness stepped the sim inside them. */
  let hijacked = 0;
  let offVisibility: (() => void) | null = null;
  /** Real seconds of delivered play. The warm-up and every dwell count this,
   *  and none of them are clamped: at 1.7fps a clamped accumulator counted 0.25
   *  of a second per frame instead of 0.59 and stretched every timer by 2.4x. */
  let liveSeconds = 0;

  /** Recomputed once per delivered frame from the window. No allocation. */
  let wallMean = 0;
  let wallWorst = 0;
  let wallBest = 0;
  let workMean = 0;
  let lateFrac = 0;

  // ── the robust statistic, for the one comparison that needs one ───────────
  //
  // Only the futility verdict reads these, and only at the two moments it takes
  // a measurement, so they are computed on demand rather than per frame — an
  // insertion sort of sixty-four floats twice over is nothing once a rung, and
  // would be real work every frame on the machine least able to afford it.
  /** Sorting scratch. Owned, so a verdict allocates nothing either. */
  const sorted = new Float32Array(WALL_WINDOW);
  /** Written by `measureWindow()`. Two returns without an object to hold them. */
  let wallMedian = 0;
  let wallMad = 0;

  /** In-place insertion sort of the first `n` of `sorted`. */
  function sortRun(n: number): void {
    for (let i = 1; i < n; i++) {
      const v = sorted[i]!;
      let j = i - 1;
      while (j >= 0 && sorted[j]! > v) { sorted[j + 1] = sorted[j]!; j--; }
      sorted[j + 1] = v;
    }
  }

  /** Median of the sorted run. */
  function middle(n: number): number {
    if (n <= 0) return 0;
    const h = n >> 1;
    return (n & 1) === 1 ? sorted[h]! : (sorted[h - 1]! + sorted[h]!) / 2;
  }

  /** Median and median-absolute-deviation of the wall window, into the two
   *  fields above. */
  function measureWindow(): void {
    const n = wallCount;
    if (n <= 0) { wallMedian = 0; wallMad = 0; return; }
    for (let i = 0; i < n; i++) sorted[i] = wall[i]!;
    sortRun(n);
    wallMedian = middle(n);
    for (let i = 0; i < n; i++) sorted[i] = Math.abs(wall[i]! - wallMedian);
    sortRun(n);
    wallMad = middle(n);
  }

  /** Standard error of a median drawn from a window with this spread. */
  function medianSe(mad: number, n: number): number {
    if (n <= 0) return Infinity;
    return (MEDIAN_SE * MAD_SIGMA * mad) / Math.sqrt(n);
  }

  /** Seconds over budget / under it. One of the two is always zero. */
  let overFor = 0;
  let underFor = 0;
  let panicFor = 0;
  let settleFor = SETTLE;
  /**
   * ...and the same three in **delivered frames**, which is the unit the whole
   * of this round was about.
   *
   * A wall second is 60 frames on a machine that is fine and two thirds of one
   * on a machine at 0.7fps, so a dwell counted only in seconds guarantees
   * nothing at all on the machine it exists for. Both have to be satisfied; see
   * the block on `DOWN_DWELL`.
   */
  let overFrames = 0;
  let underFrames = 0;
  let panicFrames = 0;
  let settleFrames = SETTLE_FRAMES;
  /** -1 until the first frame we observe, so boot's own primed frame is free. */
  let benchFrames = -1;
  let benchQuietFor = 0;
  /** Latched: this page is a bench, and nothing it measures is about a player. */
  let benched = false;
  let holding = 'settling';

  // ── did the last cut buy anything ────────────────────────────────────────
  /** The frame's *median* wall cost immediately before the last drop. */
  let wallBefore = 0;
  /** ...and the standard error of that median, so the verdict knows how much
   *  of the difference it is about to measure could be the window itself. */
  let seBefore = 0;
  let verdictPending = false;
  /** Delivered frames since the cut being judged. The abandon deadline counts
   *  these, not seconds — see `VERDICT_ABANDON_FRAMES`. */
  let verdictFrames = 0;
  let futile = 0;
  let stalled = false;
  /** The wall cost when the governor gave up, so it can notice things changing.
   *  In *mean* units, because the retry test below reads the mean every frame
   *  and comparing a median against a mean is not a comparison. */
  let stalledAt = 0;

  // ── the moment gate ──────────────────────────────────────────────────────
  /**
   * The front-end has a screen up, and the game is paused.
   *
   * Both are taken from the **edges** the owning modules publish — `ui:menu`
   * and `race:pause` — because neither can be read off `ctx.race` at all.
   * ARCHITECTURE §11a: the race is built at boot and keeps simulating behind an
   * opaque title screen, so `race.phase` walks `intro` → `countdown` →
   * `racing` while the player is still choosing a machine, and `phase ===
   * 'loading'` means the boot *or* the pause screen with no way to tell which.
   * `race/director.ts` has stood off these edges since it was written; this
   * file asked the director what was on screen instead and was told about a
   * race nobody could see.
   */
  let frontEndOpen = false;
  let paused = false;
  /**
   * `ctx.time.elapsed` — the fixed-step clock — at the frame the flag fell.
   *
   * Latched on the `race:racing` edge rather than derived from `ctx.race.time`,
   * which a seek leaves running from the previous race. `-Infinity` until a
   * flag has actually fallen, so the grace is open before the first one and the
   * intro and countdown gates carry that stretch on their own.
   */
  let flagAt = -Infinity;
  /** Seconds on the fixed-step clock since the flag, or **-1** if no flag has
   *  fallen this session. -1 rather than an infinity because this is reported
   *  through `probe()` and a log entry, both of which are read as JSON, and
   *  `JSON.stringify(Infinity)` is `null` — a reviewer's check for "was this
   *  change inside the grace" would then compare against a null and answer
   *  yes. A gate whose evidence serialises to a falsehood is not evidence. */
  const sinceFlag = (): number =>
    (flagAt === -Infinity ? -1 : +(ctx.time.elapsed - flagAt).toFixed(2));
  /**
   * ...and the same stretch in **wall seconds of delivered play**, which is the
   * unit `LAUNCH_PATIENCE` is denominated in.
   *
   * Two clocks for one beat, on purpose. `sinceFlag` is what the gate is *for*
   * — a gesture of the game, three fixed-step seconds long at every frame rate
   * — and this is what the gate *costs*, which is a different question with a
   * different answer the moment `engine.ts`'s eight-step cap starts binding.
   * Keeping only the first is how this file has twice shipped a refusal nobody
   * had converted into what a person waits.
   */
  let flagFor = 0;
  /**
   * Seconds of delivered play spent inside **this** composed beat.
   *
   * Zero while the game is being played, and zero behind the front-end — a
   * sweep nobody can see is not a sweep anybody is waiting out. The two
   * ceremony valves read it.
   *
   * It is scoped to one beat rather than to "composed-ness" as a whole, and
   * that matters: the intro runs straight into the countdown, so a single
   * accumulator would let a sweep that had already spent its twenty seconds
   * hand the countdown a valve that was open on arrival. Each beat waits out
   * its own patience. `ceremonyPhase` is what it was last counting.
   */
  let ceremonyFor = 0;
  let ceremonyPhase = '';
  /**
   * ...and the same clock for the front-end, which is not a phase and cannot
   * share one. See `FRONT_END_PATIENCE`.
   */
  let frontEndFor = 0;
  /**
   * The front-end is covering the whole frame with its own opaque set, so the
   * race behind it is pure wasted fill. Published to `budget.skipDraw`, which
   * `engine.ts` reads immediately before the draw.
   *
   * ── What decides it, and why it is three facts and not one ────────────────
   *
   * **`ui:menu`** is the authority on whether the front-end is up: it is the
   * edge the module that owns the screen publishes, and ARCHITECTURE §11a says
   * in as many words that nothing else can answer the question.
   *
   * **`reset()`** takes it back. `ui:menu {open:false}` fires at the *end* of
   * the hand-off, not the start: the launch board closes over the menus, the
   * race is built, the board swings open again onto the race, and only then is
   * the front-end declared closed. For the length of that swing the front-end
   * is still open on the wire and the race behind it is the picture. Building
   * the race is the last thing that happens before the reveal, so the reset is
   * the earliest honest signal that the menu is about to stop covering
   * anything — and it is a whole beat early, which is the right direction to
   * be wrong in.
   *
   * **A stage canvas that exists and is opaque** is the belt to that brace.
   * `createStage()` can return null on a machine that will not give the
   * front-end its own WebGL context, and the menus fade their whole backdrop —
   * the stage canvas included — to zero opacity the moment they start handing
   * over. Reading that one inline style costs a property read per frame, forces
   * no layout, and means the very worst this can do is draw a frame nobody
   * needed rather than blank a frame somebody did.
   */
  let frontEndCovers = false;
  /** The front-end's own backdrop canvas, looked up once per open edge. Null
   *  when the front-end is down or has no set of its own to hide behind. */
  let stageEl: HTMLElement | null = null;
  /** A race has been built since the front-end came up, so the hand-off is
   *  under way and the reveal is imminent. */
  let handingOver = false;

  // ── the cost of the governor's own action ────────────────────────────────
  /** Worst delivered frame among the `SKIP_FRAMES` discarded after a change. */
  let changeCost = 0;
  /** ...that number for the most recent completed change, and the worst of the
   *  session. Both in wall milliseconds; 0 before the first change. */
  let lastChangeMs = 0;
  let changeWorst = 0;
  /** The log entry still being measured into, or null. Never allocated here —
   *  it is the entry `applyRung` already pushed. */
  let changeEntry: QualityChange | null = null;
  /**
   * ...and whether anything that is not this machine ran inside that entry's
   * measurement window: a suspension, a harness step, or a hand call into
   * `__QUALITY`. A spoiled window produces no number at all rather than a
   * number made of somebody else's work — see the recording site and
   * `externalTouch`.
   */
  let changeSpoiled = false;

  const log: QualityChange[] = [];
  const verdicts: QualityVerdict[] = [];

  // ── the content pass ──────────────────────────────────────────────────────
  //
  // The half of the ladder that takes things out of the frame rather than
  // pixels off the picture. See `ContentTrim`.
  //
  // Everything here is a *visual* write — `visible`, `InstancedMesh.count`,
  // `BufferGeometry.drawRange` — made from `update()` at order 95, after every
  // system that owns those flags has had its say and before the draw. Nothing
  // in `fixedUpdate` anywhere in the game reads any of them, which is what
  // keeps "the same seed puts every racer in the same place at every rung" a
  // property of the design; `tools/qualitydiff.mjs` proves it at both ends of
  // the ladder and the content rungs are inside that proof.

  /** A crowd geometry, and where its people start. See `ContentTrim.crowd`. */
  interface CrowdGeo {
    geo: THREE.BufferGeometry;
    /** Indices in the whole thing. */
    full: number;
    /**
     * ...and the prefix that is *not* people and may never be trimmed.
     *
     * Found from the geometry rather than from a name: `world/kit.ts` writes an
     * `aAmp` of zero on anything that does not move and a positive one on every
     * box of every spectator, because that is what the crowd material's vertex
     * program bobs. So the largest suffix of the index buffer whose vertices
     * are all animated is exactly "the people", whatever the stand around them
     * is made of, and trimming into the head — which would start deleting the
     * terracing out from under them — is arithmetically impossible rather than
     * merely discouraged.
     */
    head: number;
    /** What is currently drawn, so a re-apply with the same trim is free. */
    at: number;
  }
  /** An instanced batch small enough and numerous enough to thin. */
  interface ScatterBatch {
    mesh: THREE.InstancedMesh;
    full: number;
  }
  /**
   * Anything the screen-size test may switch off, with the two radii it needs.
   *
   * `radius` is the whole batch, used to take the *near edge* of it, so a
   * sector of verge running past the camera is never culled for the sake of its
   * far end. `item` is one instance, which is the thing an eye actually has to
   * resolve — a batch of two hundred traffic cones is three hundred metres
   * across and every cone in it is sixty centimetres.
   */
  interface Cullable {
    node: THREE.Object3D;
    cx: number; cy: number; cz: number;
    radius: number;
    item: number;
    hidden: boolean;
  }
  /**
   * A racer's merged shell: the same geometry and the same materials, baked
   * into one mesh per material, standing still.
   *
   * ── Why this is the safest cut on the ladder ───────────────────────────────
   *
   * It is the only one that is *pixel-identical* to what it replaces. The
   * shell is built from the machine's own meshes, in the machine's own
   * materials, at the transforms they were sitting at — so the only thing it
   * gives up is that the wheels stop turning and the body stops leaning. At the
   * first content rung's `shellPx` of 18 that happens at thirty-six metres,
   * where a machine is twenty-eight pixels across and its wheel is seven, with
   * sub-pixel tread lugs; there is no rotation left to see.
   *
   * What it buys is the number the review named: **the seven racers are 745 of
   * the frame's 1045 audited draw calls for 4% of its triangles**, across 187
   * separate meshes. `mat()` in `vehicles/parts.ts` already caches by colour and
   * options, so the seventy-five materials really are seventy-five different
   * paints and no merge can go below them — but twenty-six meshes a machine
   * can, and does, become about eleven.
   *
   * The shadow pass is the other half and it has to be built the other way
   * round, or a merge that halves the colour pass doubles the shadow one: the
   * part ladder in `vehicles/index.ts` has already stopped almost everything
   * casting by this distance, so a shell whose eleven meshes all cast would be
   * a regression. Only the largest bucket casts — the body — which is the mesh
   * the dark shape under a kart is made of anyway.
   */
  interface Shell {
    /** The merged group, parented under the racer's own root. */
    group: THREE.Object3D;
    /** Root's own children, which the shell stands in for. */
    hides: THREE.Object3D[];
    /** ...and what each of them was showing when the shell took over. */
    was: boolean[];
    on: boolean;
  }

  const crowdGeos: CrowdGeo[] = [];
  const scatter: ScatterBatch[] = [];
  const cullables: Cullable[] = [];
  const shells = new Map<number, Shell>();
  /** What the content pass has been asked for. Never null — rung 0 is `FULL`. */
  let content: ContentTrim = FULL_CONTENT;
  /** The track the census was taken on, so it is taken once per course. */
  let censusFor = '';
  /** Counters for the probe, so a content rung that quietly matched nothing is
   *  visible as a zero rather than as a rung that did not work. */
  let contentCrowd = 0;
  let contentScatter = 0;
  let contentCullable = 0;
  let contentShells = 0;
  /** Batches the screen-size test is holding off, and racers on their shells,
   *  this frame. The two numbers a review reads to see the rung working. */
  let culledNow = 0;
  let shelledNow = 0;
  /**
   * Frames on which every shell is drawn whether it is wanted or not.
   *
   * A shell's first draw uploads its merged buffers, and under a software
   * rasteriser that is not free: measured on a frozen 1600x900 bench, the
   * frame that first switched five machines to their shells took **5.07
   * seconds** against a 1.1s steady frame, and the same switch on the next pass
   * — buffers already resident — cost nothing measurable. A governor whose
   * rescue move is a five-second freeze is the exact failure `precompileLadder`
   * exists to prevent, one layer down.
   *
   * So the upload is moved to the one frame that is already a load: `main.ts`
   * renders once immediately after `resetAll` to prime shaders (see the note
   * beside that call), and this makes that frame draw every shell alongside
   * every machine. It costs one doubled field on a frame nobody sees, behind
   * the launch board, and it buys back the freeze.
   */
  let primeShells = 0;

  // Scratch. The content pass runs every rendered frame over a hundred-odd
  // batches and eight racers and must not allocate a byte doing it.
  const _cam = new ctx.THREE.Vector3();
  const _wp = new ctx.THREE.Vector3();

  // Our own sample buffers. `track.sample()` and `spline.atDistance()` both
  // hand back a shared scratch when none is supplied, and the camera and the
  // contact pass are reading theirs in the same frame — see the note in
  // render/contact.ts. Nothing here allocates after init.
  let here: SplineSample | null = null;
  let ahead: SplineSample | null = null;

  /** The device ratio the display actually has, before any scaling of ours. */
  function baseRatio(): number {
    return Math.min(globalThis.devicePixelRatio || 1, 2);
  }

  /**
   * Where the frame went, once the wall clock has already said it was late.
   *
   * Work that accounts for most of the frame means the CPU is the bottleneck
   * and says which half of it. Work far below the frame means the cost is
   * downstream of the last instruction we can time: the GPU, or the wait for
   * the display. The two are indistinguishable from inside the page — a
   * `render()` that returns in 8ms tells you nothing about whether the driver
   * then spent 240ms on it — so the label leans on whether the frame is late:
   * an idle frame arriving on time is vsync, an idle frame arriving late is the
   * GPU.
   */
  function boundBy(b: FrameBudget): string {
    if (wallMean <= 0) return '';
    if (workMean > wallMean * 0.66) {
      return b.meanSimMs > b.meanDrawMs ? 'sim' : 'draw';
    }
    return wallMean > TARGET_MS * UP_FACTOR ? 'gpu' : 'vsync';
  }

  /**
   * Render resolution.
   *
   * `setPixelRatio` re-sizes the drawing buffer itself, and the post stack sizes
   * its targets off `getDrawingBufferSize`, so one call moves the scene pass,
   * every bloom mip, the composite and the resolve together. The DOM HUD is
   * unaffected — it measures the viewport, not the canvas.
   */
  function applyScale(scale: number): void {
    const want = baseRatio() * scale;
    const have = ctx.renderer.getPixelRatio();
    if (have > want - 1e-3 && have < want + 1e-3) return;
    ctx.renderer.setPixelRatio(want);
  }

  // ── the content pass: the census ──────────────────────────────────────────

  /**
   * The largest suffix of `geo`'s index buffer whose every vertex is animated.
   *
   * That is "the people", exactly — see `CrowdGeo.head`. Walked backwards from
   * the end and stopped at the first vertex the crowd's vertex program does not
   * move, so a geometry that interleaves its stand with its spectators
   * (none does today) degrades to trimming nothing rather than to trimming the
   * terracing.
   */
  function crowdHead(geo: THREE.BufferGeometry): number {
    const idx = geo.getIndex();
    const amp = geo.getAttribute('aAmp') as { getX(i: number): number } | undefined;
    if (!idx || !amp) return idx ? idx.count : 0;
    for (let i = idx.count - 1; i >= 0; i--) {
      if (amp.getX(idx.getX(i)) <= 0) return i + 1;
    }
    return 0;
  }

  /**
   * Reorder a batch's instances so that **any prefix of them is spread over the
   * whole batch**.
   *
   * `InstancedMesh.count` is the only density dial that costs nothing: one
   * integer, no reallocation, no upload, exactly reversible. What it draws is
   * the first N instances, and the first N instances of a batch built in
   * placement order are the first N *metres of lap* — so used naively it does
   * not thin a verge, it deletes the end of one.
   *
   * So the matrices are permuted once, at census time, into van der Corput
   * order: index 0, then the middle, then the two quarters, then the four
   * eighths. Every prefix of that sequence is a low-discrepancy sample of the
   * whole, so `count = 0.48 * full` is a verge with half the cones on it rather
   * than half a verge, at every share and with no per-frame work at all. It is
   * deterministic, it is done once, and `count = full` puts the batch back
   * exactly as it was — the permutation is a relabelling, not a loss.
   */
  function stratify(mesh: THREE.InstancedMesh): void {
    const n = mesh.count;
    if (n < 4) return;
    // Idempotent. The census can be re-taken — a course change, a bench calling
    // `__QUALITY.census()` — and applying a low-discrepancy permutation twice
    // gives a permutation that is still valid and no longer low-discrepancy,
    // which is the worst kind of bug: it does not fail, it just quietly stops
    // thinning evenly.
    if (mesh.userData.mcStratified) return;
    mesh.userData.mcStratified = true;
    const attr = mesh.instanceMatrix;
    const arr = attr.array as Float32Array;
    const order: number[] = [];
    for (let i = 0; i < n; i++) order.push(i);
    // Radical inverse base 2: the bits of i, reversed. Cheap and exact.
    const vdc = (i: number): number => {
      let b = i;
      b = ((b & 0x55555555) << 1) | ((b >>> 1) & 0x55555555);
      b = ((b & 0x33333333) << 2) | ((b >>> 2) & 0x33333333);
      b = ((b & 0x0f0f0f0f) << 4) | ((b >>> 4) & 0x0f0f0f0f);
      b = ((b & 0x00ff00ff) << 8) | ((b >>> 8) & 0x00ff00ff);
      b = (b << 16) | (b >>> 16);
      return (b >>> 0) / 4294967296;
    };
    order.sort((a, b) => vdc(a) - vdc(b));
    const copy = arr.slice(0, n * 16);
    for (let p = 0; p < n; p++) {
      const s = order[p]! * 16;
      const d = p * 16;
      for (let k = 0; k < 16; k++) arr[d + k] = copy[s + k]!;
    }
    attr.needsUpdate = true;
  }

  /**
   * What the frame is made of, and which parts of it a rung may spend.
   *
   * Run once per course, from `reset()`, with the world built — the same load
   * moment `precompileLadder` uses, and for the same reason: a walk of the
   * scene graph is not something to do on a frame a player is watching.
   *
   * ── Why the classifier is measurements and not a list of names ─────────────
   *
   * Two of the three classes here are decided by *what the thing is like*
   * rather than by what it is called: a scatter batch is an instanced draw with
   * more than `SCATTER_MIN_N` copies of something under `SCATTER_MAX_R` across,
   * and a cullable is anything instanced at all. Those survive a course being
   * re-dressed, a prop being renamed, and a whole new landscape kit.
   *
   * The crowd is the exception and it is a name test, because "a spectator" is
   * not a shape — but even there the *trim* is derived from the geometry's own
   * animation attribute rather than from the name, so the worst a rename can do
   * is switch the crowd rung off. `probe().content` reports how many of each
   * class the census found, so that failure reads as `crowd: 0` instead of as a
   * rung that mysteriously buys nothing.
   *
   * Two things are deliberately exempt:
   *
   *   **The contact patches.** `world:contact` is the soft dark blob under
   *   every prop that stands on the dirt, and ARCHITECTURE §12 is unambiguous
   *   about what happens without it. They are two triangles each and they are
   *   not thinned at any rung, so every prop that is drawn is a prop that is
   *   grounded. (The reverse — a blob left behind by a cone the scatter rung
   *   removed — is a soft patch of shade on dirt, which is what dirt looks
   *   like.)
   *
   *   **Everything outside the `world` group.** The road, the barriers, the
   *   kerbs, the item boxes and the coins are *gameplay surfaces*: the road has
   *   to be obvious at speed and an item box that is not drawn is an item box
   *   the player drives past. A frame budget does not get to spend those.
   */
  function censusContent(): void {
    for (const c of crowdGeos) c.geo.setDrawRange(0, Infinity);
    for (const s of scatter) s.mesh.count = s.full;
    for (const c of cullables) if (c.hidden) { c.node.visible = true; c.hidden = false; }
    crowdGeos.length = 0;
    scatter.length = 0;
    cullables.length = 0;
    culledNow = 0;

    const world = ctx.scene.children.find((c) => c.name === 'world');
    if (!world) return;
    const seen = new Set<string>();
    world.traverse((o) => {
      const m = o as THREE.Mesh & { isInstancedMesh?: boolean; count?: number;
        boundingSphere?: { center: THREE.Vector3; radius: number } | null;
        computeBoundingSphere?(): void };
      if (!m.isMesh) return;
      const geo = m.geometry;
      if (!geo) return;
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      const item = geo.boundingSphere?.radius ?? 0;
      const isCrowd = /crowd/i.test(m.name);
      const isContact = /contact/i.test(m.name);

      if (isCrowd && geo.index && !seen.has(geo.uuid)) {
        seen.add(geo.uuid);
        const full = geo.index.count;
        crowdGeos.push({ geo, full, head: crowdHead(geo), at: full });
      }

      if (m.isInstancedMesh) {
        const n = m.count ?? 0;
        if (!isCrowd && !isContact && n >= SCATTER_MIN_N && item > 0 && item <= SCATTER_MAX_R) {
          stratify(m as THREE.InstancedMesh);
          scatter.push({ mesh: m as THREE.InstancedMesh, full: n });
        }
        // The screen-size test wants the batch's own sphere, which an
        // `InstancedMesh` computes across its instances. `place.ts` already
        // asked for it; ask again only if it did not.
        if (!m.boundingSphere) m.computeBoundingSphere?.();
        const bs = m.boundingSphere;
        if (bs && !isContact) {
          o.updateMatrixWorld();
          _wp.copy(bs.center).applyMatrix4(o.matrixWorld);
          cullables.push({
            node: o, cx: _wp.x, cy: _wp.y, cz: _wp.z,
            radius: bs.radius, item, hidden: false,
          });
        }
      }
    });
    contentCrowd = crowdGeos.length;
    contentScatter = scatter.length;
    contentCullable = cullables.length;
  }

  /**
   * Bake a racer's machine into one mesh per material, once, at a load moment.
   *
   * See `Shell`. Two rules make this safe to do from here rather than from the
   * module that owns the model:
   *
   *   It is **additive**. Nothing existing is removed, re-parented or
   *   re-materialised; a group is added under the racer's own root and left
   *   switched off. If this file is disposed the shell goes with it and the
   *   machine is exactly what `vehicles/registry.ts` built.
   *
   *   It **copies rather than shares** geometry, so the part ladder in
   *   `vehicles/index.ts` can go on writing `visible` and `castShadow` on the
   *   originals without either of us noticing the other. Ancestor visibility is
   *   what arbitrates: while the shell is up, root's own children are off, and
   *   every write the rig and the ladder make lands on nodes nobody is drawing.
   */
  function buildShell(root: THREE.Object3D): Shell | null {
    const T = ctx.THREE;
    const inv = new T.Matrix4();
    const local = new T.Matrix4();
    root.updateMatrixWorld(true);
    inv.copy(root.matrixWorld).invert();
    const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();

    let meshes = 0;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
      // The contact pass owns this one and moves it every frame.
      if (o.name === 'shadowBlob') return;
      // A multi-material mesh has per-group index ranges that a flat merge
      // would lose. None exist on any machine today; skip rather than corrupt.
      if (Array.isArray(mesh.material)) return;
      const src = mesh.geometry;
      if (!src.getAttribute('position')) return;
      const g = src.index ? src.toNonIndexed() : src.clone();
      local.multiplyMatrices(inv, mesh.matrixWorld);
      g.applyMatrix4(local);
      const mat = mesh.material as THREE.Material;
      const list = buckets.get(mat);
      if (list) list.push(g); else buckets.set(mat, [g]);
      meshes++;
    });
    if (meshes < 4) {
      for (const list of buckets.values()) for (const g of list) g.dispose();
      return null;
    }

    const group = new T.Group();
    group.name = 'lodShell';
    const built: Array<{ mesh: THREE.Mesh; tris: number }> = [];
    for (const [mat, list] of buckets) {
      const merged = mergeParts(list);
      for (const g of list) g.dispose();
      if (!merged) continue;
      const mesh = new T.Mesh(merged, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      group.add(mesh);
      built.push({
        mesh,
        tris: (merged.getAttribute('position')?.count ?? 0) / 3,
      });
    }
    if (!built.length) return null;
    // One caster: the biggest bucket, which is the body. See `Shell`.
    built.sort((a, b) => b.tris - a.tris);
    built[0]!.mesh.castShadow = true;
    group.visible = false;
    root.add(group);

    const hides: THREE.Object3D[] = [];
    for (const child of root.children) {
      if (child === group || child.name === 'shadowBlob') continue;
      hides.push(child);
    }
    return { group, hides, was: hides.map(() => true), on: false };
  }

  /**
   * Concatenate non-indexed geometries that share a material.
   *
   * Position and normal always; uv and vertex colour only when **every** one of
   * them has it. A merge that invents a uv channel for half its vertices
   * produces a mesh whose texture is garbage on the half that was invented, and
   * the machines that carry one — the train's plate, the digger's decals — are
   * exactly the ones a reviewer photographs. Dropping the channel entirely is
   * the safe direction to be wrong in: a shared `mat()` material declares
   * neither `map` nor `vertexColors` unless every mesh painted with it wanted
   * them, so a bucket that is not unanimous is a bucket where the channel was
   * never being read.
   */
  function mergeParts(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
    if (!list.length) return null;
    let count = 0;
    let allUv = true;
    let allColor = true;
    let allNormal = true;
    for (const g of list) {
      count += g.getAttribute('position')!.count;
      if (!g.getAttribute('uv')) allUv = false;
      if (!g.getAttribute('color')) allColor = false;
      if (!g.getAttribute('normal')) allNormal = false;
    }
    if (count <= 0) return null;
    const T = ctx.THREE;
    const pos = new Float32Array(count * 3);
    const nrm = new Float32Array(count * 3);
    const uv = allUv ? new Float32Array(count * 2) : null;
    const col = allColor ? new Float32Array(count * 3) : null;
    let o = 0;
    for (const g of list) {
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      const n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
      const u = uv ? (g.getAttribute('uv') as THREE.BufferAttribute) : null;
      const c = col ? (g.getAttribute('color') as THREE.BufferAttribute) : null;
      for (let i = 0; i < p.count; i++) {
        const k = (o + i) * 3;
        pos[k] = p.getX(i); pos[k + 1] = p.getY(i); pos[k + 2] = p.getZ(i);
        if (n) { nrm[k] = n.getX(i); nrm[k + 1] = n.getY(i); nrm[k + 2] = n.getZ(i); }
        if (u && uv) { uv[(o + i) * 2] = u.getX(i); uv[(o + i) * 2 + 1] = u.getY(i); }
        if (c && col) { col[k] = c.getX(i); col[k + 1] = c.getY(i); col[k + 2] = c.getZ(i); }
      }
      o += p.count;
    }
    const out = new T.BufferGeometry();
    out.setAttribute('position', new T.BufferAttribute(pos, 3));
    out.setAttribute('normal', new T.BufferAttribute(nrm, 3));
    if (uv) out.setAttribute('uv', new T.BufferAttribute(uv, 2));
    if (col) out.setAttribute('color', new T.BufferAttribute(col, 3));
    // A bucket where one part shipped normals and another did not would light
    // half of itself black. Recomputing is a build-time cost paid once.
    if (!allNormal) out.computeVertexNormals();
    out.computeBoundingSphere();
    return out;
  }

  /** Drop every shell, so a new field does not inherit the last one's. */
  function clearShells(): void {
    for (const s of shells.values()) {
      // Only a shell that was actually standing in has anything to give back.
      // `was` is only written on the edge, so restoring from it on a shell that
      // never came up would switch on the puffs and glows that were born
      // hidden — a machine trailing exhaust smoke while parked on the grid.
      if (s.on) for (let i = 0; i < s.hides.length; i++) s.hides[i]!.visible = s.was[i]!;
      s.group.parent?.remove(s.group);
      s.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry?.dispose();
      });
    }
    shells.clear();
    contentShells = 0;
    shelledNow = 0;
  }

  function buildShells(): void {
    clearShells();
    for (const racer of ctx.racers) {
      const root = racer.model?.root ?? racer.visual;
      if (!root) continue;
      const shell = buildShell(root);
      if (shell) shells.set(racer.id, shell);
    }
    contentShells = shells.size;
    // One frame with every shell on the screen, which `main.ts`'s priming
    // render is about to be. See `primeShells`.
    primeShells = shells.size ? 1 : 0;
  }

  /**
   * Install a content rung.
   *
   * The two density levers are set here, once per rung change — they are state,
   * not a per-frame decision, and re-applying an unchanged trim writes nothing.
   * The two screen-size levers cannot be: they depend on where the camera is,
   * so they live in `contentFrame` below.
   */
  function applyContent(next: ContentTrim): void {
    content = next;
    for (const c of crowdGeos) {
      const people = c.full - c.head;
      // Whole triangles only, or the tail of the range is a torn quad — and the
      // rounding is applied to the *people*, so it can never eat into the head.
      let keep = Math.round(people * Math.max(0, Math.min(1, next.crowd)));
      keep -= keep % 3;
      let want = c.head + keep;
      if (want > c.full) want = c.full;
      if (want === c.at) continue;
      c.at = want;
      c.geo.setDrawRange(0, want >= c.full ? Infinity : want);
    }
    for (const s of scatter) {
      const want = Math.max(1, Math.round(s.full * Math.max(0, Math.min(1, next.scatter))));
      if (s.mesh.count !== want) s.mesh.count = want;
    }
  }

  /**
   * The two levers that depend on where the camera is, run once per rendered
   * frame.
   *
   * ── The unit ──────────────────────────────────────────────────────────────
   *
   * Pixels of the *drawing buffer*, resolved against the live lens exactly as
   * `vehicles/index.ts` does. Metres would be the wrong unit twice over: the
   * lens opens with speed and kicks on every boost, and this file's own render
   * scale changes how many pixels a metre is worth. A rung that halves the
   * resolution should tighten its own content cut, and denominated this way it
   * does so without a second constant.
   *
   * ── Why it may write `visible` at all ─────────────────────────────────────
   *
   * `world/index.ts` writes the same flag at order 22 for its own draw-distance
   * test and this runs at 95, so the frame's last word is here. On the frame a
   * batch is released this hands it back as visible even if the world had just
   * hidden it for distance; the world re-asserts on the very next frame and the
   * cost of being wrong is one frame of one far batch. Hiding is never
   * speculative in the other direction — a batch the world has already switched
   * off is left alone.
   */
  function contentFrame(): void {
    const canvas = ctx.renderer.domElement;
    const h = canvas.height || canvas.clientHeight || 720;
    const pxPerMetre = (h * 0.5) / Math.tan((ctx.camera.fov * Math.PI) / 360);
    _cam.copy(ctx.camera.position);

    // ── the dressing ──────────────────────────────────────────────────────
    const minPx = content.minPx;
    let culled = 0;
    for (let i = 0; i < cullables.length; i++) {
      const c = cullables[i]!;
      if (minPx <= 0) {
        if (c.hidden) { c.node.visible = true; c.hidden = false; }
        continue;
      }
      const dx = c.cx - _cam.x, dy = c.cy - _cam.y, dz = c.cz - _cam.z;
      // The *near edge* of the batch, so a run of verge passing the camera is
      // never judged on where its far end is.
      const near = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz) - c.radius);
      const px = (c.item * pxPerMetre) / near;
      const bar = c.hidden ? minPx * CONTENT_HYSTERESIS : minPx;
      if (px < bar) {
        if (!c.hidden) { c.node.visible = false; c.hidden = true; }
        culled++;
      } else if (c.hidden) {
        c.node.visible = true;
        c.hidden = false;
      }
    }
    culledNow = culled;

    // ── the field ─────────────────────────────────────────────────────────
    //
    // The priming frame draws every shell next to every machine, once, so the
    // buffer upload lands on a load rather than on a rescue. See `primeShells`.
    if (primeShells > 0) {
      primeShells--;
      for (const s of shells.values()) if (!s.on) s.group.visible = true;
      shelledNow = 0;
      return;
    }
    const shellPx = content.shellPx;
    let shelled = 0;
    // Indexed rather than `for...of`: this is the hot path's hot path and an
    // array iterator is an allocation the engine is only *usually* clever
    // enough to remove.
    const racers = ctx.racers;
    for (let ri = 0; ri < racers.length; ri++) {
      const racer = racers[ri]!;
      const s = shells.get(racer.id);
      if (!s) continue;
      let want = false;
      if (shellPx > 0) {
        const root = racer.model?.root ?? racer.visual;
        if (root) {
          root.getWorldPosition(_wp);
          const d = Math.max(1, _wp.distanceTo(_cam));
          // A machine is about 1.1m of bounding radius; taking it off the def
          // would mean a lookup per racer per frame for a number that varies by
          // a fifth across the cast and is being compared against a threshold
          // with a 25% dead band on it.
          const px = (1.1 * pxPerMetre) / d;
          want = px < (s.on ? shellPx * CONTENT_HYSTERESIS : shellPx);
        }
      }
      if (want) {
        // Captured on the edge, re-asserted every frame. The rig at order 85
        // writes `visible` on nodes under here for its own reasons — a spin
        // disc fading in with rpm, an exhaust glow with boost — and this pass
        // has to have the last word for as long as the shell is standing in,
        // or a machine shows its glow through its own replacement.
        for (let i = 0; i < s.hides.length; i++) {
          if (!s.on) s.was[i] = s.hides[i]!.visible;
          s.hides[i]!.visible = false;
        }
        if (!s.on) s.group.visible = true;
        s.on = true;
        shelled++;
        continue;
      }
      if (!s.on) {
        // Also the frame after `primeShells`, which left every shell showing
        // so its buffers would upload on a load frame.
        if (s.group.visible) s.group.visible = false;
        continue;
      }
      s.on = false;
      {
        s.group.visible = false;
        // Back to what each child was showing when the shell took over. One
        // frame stale — the rig and the part ladder both run at order 85 and
        // re-assert on the next frame — and staleness is the right failure:
        // restoring everything to `true` would switch on the puffs and glows
        // that are somebody else's to switch on.
        for (let i = 0; i < s.hides.length; i++) s.hides[i]!.visible = s.was[i]!;
      }
    }
    shelledNow = shelled;
  }

  /**
   * Mirror the verdict into the frame budget.
   *
   * `stats()` is where every reviewer reads the frame, and until now it could
   * report the *settings* the governor had installed without ever reporting the
   * governor — so a review sheet could show a tier and a shadow size with no way
   * to tell a machine that chose them from a machine that was driven to them.
   * The budget is the one object both files already share, so this costs seven
   * field writes a frame and no allocation, and `engine.ts` still does not have
   * to know this file exists.
   */
  function publish(): void {
    const b = ctx.budget;
    if (!b) return;
    b.rung = index;
    b.rungLabel = LADDER[index]?.label ?? '';
    b.renderScale = LADDER[index]?.scale ?? 1;
    b.liveWallMs = wallMean;
    b.liveWorstMs = wallWorst;
    b.liveSeconds = liveSeconds;
    b.governor = holding;
    // ...and the one field the engine acts on rather than reports. Written
    // every frame from the same place as the rest of the verdict so there is
    // exactly one line in this file that can turn the draw off.
    b.skipDraw = frontEndCovers;
  }

  /** Record why the governor is standing still, and publish it. Returns void so
   *  the call sites can be `return hold('...')` — one statement, no fallthrough
   *  and no way to leave without the budget agreeing with the decision. */
  function hold(why: string): void {
    holding = why;
    publish();
  }

  function clearWindow(): void {
    wallCount = 0;
    wallIdx = 0;
    wallMean = 0;
    wallWorst = 0;
    wallBest = 0;
    workMean = 0;
    lateFrac = 0;
    skipFrames = SKIP_FRAMES;
    // A change measurement that never completed belongs to nothing. Dropping
    // the entry pointer leaves its `changeMs` at 0, which reads as "not
    // measured" rather than as "free".
    changeCost = 0;
    changeEntry = null;
    changeSpoiled = false;
  }

  /**
   * Something outside the rAF loop reached in and moved the ladder by hand.
   *
   * `__QUALITY.set/try/auto` are called from a reviewer's `page.evaluate`, and
   * an evaluate moves neither `budget.benchSteps` nor `budget.benchFrames` —
   * so the whole harness-detection apparatus above is blind to it, and the
   * multi-second Node round trip that follows lands on the next delivered frame
   * as if the page had produced it. That is where `probe().changeWorstMs =
   * 15,628.6` came from on a bench whose real switch cost was 6-17.5ms.
   *
   * One latch, set by every hand entry point, consumed exactly like a harness
   * step: the frame that spans the call is discarded from the window, and any
   * change measurement it lands inside is abandoned rather than charged.
   */
  function externalTouch(): void {
    harnessSince = true;
    changeSpoiled = true;
  }

  /** Recompute the front-end's cover *now* and push it to the budget.
   *
   *  The edges that change it — `ui:menu`, and a race being built underneath a
   *  closing board — arrive synchronously from inside another system's
   *  `update`, which for the menus runs at order 110, *after* this system's own
   *  update at 95 and before the engine reads `skipDraw`. Waiting for the next
   *  frame to notice would put one undrawn frame on the display at the exact
   *  moment the front-end stops covering it, which at 0.7fps is a black second
   *  and a half in the middle of the hand-off. */
  function republishCover(): void {
    frontEndCovers = frontEndOpaque();
    publish();
  }

  function applyRung(next: number, why: string): void {
    const from = index;
    index = next < 0 ? 0 : next >= LADDER.length ? LADDER.length - 1 : next;
    const r = LADDER[index]!;
    const q: QualitySettings = { ...r.settings };
    ctx.quality = q;
    applied = q;
    ctx.renderer.shadowMap.enabled = q.shadows;
    ctx.renderer.shadowMap.needsUpdate = true;
    applyScale(r.scale);
    applyContent(r.content);

    let entry: QualityChange | null = null;
    if (from !== index) {
      const b = ctx.budget;
      if (log.length >= 24) log.shift();
      entry = {
        t: +liveSeconds.toFixed(2),
        from,
        to: index,
        why,
        wallMs: +wallMean.toFixed(1),
        workMs: +workMean.toFixed(2),
        bound: b ? boundBy(b) : '',
        phase: ctx.race?.phase ?? '',
        raceTime: +(ctx.race?.time ?? 0).toFixed(2),
        sinceFlag: sinceFlag(),
        frontEnd: frontEndOpen,
        covered: frontEndCovers,
        heldFor: +(frontEndOpen ? frontEndFor : ceremonyFor).toFixed(2),
        changeMs: 0,
      };
      log.push(entry);
    }

    overFor = 0;
    underFor = 0;
    panicFor = 0;
    overFrames = 0;
    underFrames = 0;
    panicFrames = 0;
    settleFor = 0;
    settleFrames = 0;
    // Everything measured before a change was measured about a different game.
    clearWindow();
    // ...and the frames the window is about to discard are this change's own
    // reallocation. Measure them into the entry rather than throwing them away
    // — see `SKIP_FRAMES`. Set after `clearWindow`, which clears the pointer.
    changeEntry = entry;
    holding = why;
    publish();
    // The same channel main.ts's own `setQuality` uses, so lighting, fx, the
    // contact pass and the menus' 3D set all re-read on one event as they
    // already do. Nothing new has to subscribe for this file to work.
    //
    // ── ...and the render scale rides on it ──────────────────────────────────
    //
    // `renderScale` is by a long way the largest thing this ladder spends, and
    // until now it was published only into `budget.renderScale`, which is a
    // field the engine's `stats()` reports rather than a thing anybody is told
    // about. That left the one surface in the game with a second renderer of
    // its own — the front-end's set, `src/ui/menus/stage.ts` — sizing its
    // backing store from a hardcoded `Math.min(1, 1200 / w)`, which is 0.75 at
    // 1600x900 and stays 0.75 on a machine the governor has taken to 0.46. A
    // ladder that half the game's 3D cannot hear is half a ladder.
    //
    // No new event: `quality:changed` is already heard by everyone who needs
    // it, and an event nobody has subscribed to is the bug ARCHITECTURE §7
    // spends three paragraphs on. Existing listeners destructure `quality` and
    // are unaffected by the extra fields.
    ctx.bus.emit('quality:changed', {
      quality: q, scale: r.scale, rung: index, label: r.label,
    });
  }

  /**
   * Record what the frame cost before a cut, so the cut can be judged.
   *
   * Both drop sites go through here, and it takes the **median** and its
   * standard error rather than the mean — the two numbers the verdict compares
   * have to be the same statistic measured the same way, or the comparison is
   * an artefact. The panic path calls this with as few as `PANIC_SAMPLES`
   * frames in the window, which is fine and is the point: a noisy `before`
   * produces a large `seBefore`, which widens the bar, which is exactly how a
   * verdict taken on thin evidence is supposed to fail — as `unresolved`,
   * rather than as a confident wrong answer.
   */
  function markDrop(): void {
    measureWindow();
    wallBefore = wallMedian;
    seBefore = medianSe(wallMad, wallCount);
    verdictPending = true;
    verdictFrames = 0;
  }

  /** Give up on a pending verdict without deciding it, and say so. Used by the
   *  frame-counted deadline and by any edge that makes the two halves of the
   *  comparison describe different scenes — the front-end coming up over the
   *  race is the obvious one. */
  function abandonVerdict(): void {
    if (!verdictPending) return;
    verdictPending = false;
    if (verdicts.length >= 16) verdicts.shift();
    verdicts.push({
      t: +liveSeconds.toFixed(2),
      rung: index,
      call: 'abandoned',
      beforeMs: +wallBefore.toFixed(1),
      afterMs: 0,
      gain: 0,
      bar: 0,
      samples: wallCount,
    });
  }

  /**
   * The nearest rung to a `QualitySettings` somebody else installed.
   *
   * Only used to re-synchronise after a manual pick, so that turning the
   * governor back on later does not start it from a rung the game is not on.
   */
  function nearestRung(q: QualitySettings): number {
    let best = 0;
    let bestErr = Infinity;
    for (let i = 0; i < LADDER.length; i++) {
      const s = LADDER[i]!.settings;
      const err = (s.tier === q.tier ? 0 : 4)
        + Math.abs(s.drawDistance - q.drawDistance) * 2
        + Math.abs(s.particles - q.particles);
      if (err < bestErr) { bestErr = err; best = i; }
    }
    return best;
  }

  /**
   * Is the game showing a picture the player is being *shown* rather than one
   * they are driving through?
   *
   * **Both paths consult this, the ordinary one and the emergency one**, and it
   * is the first question either of them asks. See the header: for two rounds
   * the only moment gate in this file sat on the ordinary path, which is the
   * path a machine slow enough to need a governor never takes.
   *
   * It costs three field reads and three comparisons, it never allocates, and
   * it is deliberately not clever: no lookahead, no camera test, nothing that
   * could fail open. The whole of it is "is anybody driving, and has the flag
   * been down long enough to look away from".
   *
   * ── The order of the three questions is the fix ────────────────────────────
   *
   * It used to ask one, `ctx.race?.phase`, and ARCHITECTURE §11a says in as
   * many words that the phase cannot answer it: the race is built at boot and
   * simulates behind the front-end, so it reports `intro`/`countdown`/`racing`
   * over a title screen, and it reports `loading` for both the boot and the
   * pause screen. Measured live: three of five rung changes in a 180-second
   * session were made with the roster on the display and logged `phase:
   * intro`. The two edges come first now because they are *published by the
   * modules that own those screens* — the same signals `race/director.ts` and
   * `ui/coach.ts` stand off — and the phase is the third opinion rather than
   * the only one.
   *
   * ── Every refusal here is now a *wait*, not a wall ─────────────────────────
   *
   * The version this replaces opened `if (frontEndOpen || paused) return true;`
   * and answered `true` unconditionally for every sealed phase. Three of those
   * four refusals have a property the header names as the class of bug this
   * file keeps losing rounds to: **their cost in wall seconds is proportional
   * to the slowness they are gating.** `engine.ts` caps the fixed step at eight
   * per frame, so once a frame costs more than 66ms the simulation drops into
   * slow motion and every beat measured in race-seconds stretches to match.
   * Measured on one live session: 50 seconds held at `front-end`, then a
   * 56-second countdown seal, and the ladder's first rung change at
   * `liveSeconds` 69.96 on a machine that had been failing since frame one.
   *
   * The file had already found that shape once and fitted the intro sweep with
   * `CEREMONY_PATIENCE`, then argued in its own header that no other refusal
   * needed one. That argument is now measured to be wrong twice over, so:
   *
   *   front-end   `FRONT_END_PATIENCE`  12s — and it is the *safest* moment in
   *                                     the product to change the picture,
   *                                     because an opaque set is covering it
   *   intro       `CEREMONY_PATIENCE`   20s
   *   sealed      `SEAL_PATIENCE`       35s — countdown, finish, results
   *   loading     no door               boot, and the pause screen
   *   the launch  `LAUNCH_PATIENCE`     22s — the flag and the rocket start
   *
   * `loading` is the one that keeps its wall, and for the reason the others
   * lost theirs: it is not slowed by the frame rate. Boot ends when the game is
   * built and the pause screen ends when the player presses a key, and a paused
   * game is the same still frame over and over — nothing to hide a change
   * behind and no clock running down.
   *
   * The launch's row is new and it is the fifth round's correction. The grace
   * after the flag used to be argued out of needing a door because it is
   * measured in delivered frames — true, and it stopped one line short of the
   * question that matters, which is what those frames cost in seconds on the
   * machine the file exists for. It is a longer beat now (it covers the rocket
   * start it was always meant to protect, rather than expiring inside it) and
   * so it carries the same door as everything else.
   *
   * The doors are on the **emergency path only** by construction: the ordinary
   * path asks `frontEndOpen` and `pictureLocked()` as separate questions above
   * this one and refuses on either. A steady-state window taken behind the
   * front-end is a measurement of the menu's own set, not of the race.
   */
  function pictureLocked(): boolean {
    // A still frame with a plate over it. No door — see above.
    if (paused) return true;
    // Nobody is driving, and nothing behind the menu is even being drawn.
    if (frontEndOpen) return frontEndFor < FRONT_END_PATIENCE;
    const phase = ctx.race?.phase;
    if (phase === 'loading') return true;
    if (phase === 'intro') return ceremonyFor < CEREMONY_PATIENCE;
    if (isComposed(phase)) return ceremonyFor < SEAL_PATIENCE;
    // The flag's own beat and the launch that follows it, on the fixed-step
    // clock rather than on the wall clock — see `CEREMONY_GRACE`. `flagAt` is
    // latched on the `race:racing` edge, so this is the same gesture at every
    // frame rate instead of one frame at 0.7fps, and a seek re-arms it instead
    // of walking straight past it. `flagFor` is the door: the same beat costs
    // forty-seven wall seconds on a machine at 0.7fps and 2.2 on one that is
    // fine, and only the first of those is a wait worth arguing about.
    return ctx.time.elapsed - flagAt < CEREMONY_GRACE && flagFor < LAUNCH_PATIENCE;
  }

  /**
   * Is the front-end covering the entire frame with its own opaque set?
   *
   * The answer `budget.skipDraw` is built from, evaluated once per delivered
   * frame. See `frontEndCovers` for why it is three facts rather than one, and
   * `FrameBudget.skipDraw` for what it buys.
   */
  function frontEndOpaque(): boolean {
    if (!frontEndOpen || handingOver || !stageEl) return false;
    // The menus fade their whole backdrop to zero the frame the hand-off
    // starts, so this is the owning module telling us it has stopped covering
    // anything — one inline-style read, no layout, no allocation.
    return stageEl.style.opacity !== '0';
  }

  /**
   * Is this a moment the player would forgive a visible change?
   *
   * Straight road under them, straight road ahead of them, planted, and nothing
   * in flight. A corner is where every frame this governor is trying to save
   * gets spent, so it is also exactly where a naive one would do all of its
   * switching.
   *
   * The ceremony gate is inside here as well as in front of the call, so that
   * this function cannot answer "yes, go ahead" during a countdown to a caller
   * who forgot to ask — the start/finish straight is the straightest road on
   * the course and the grid sits on it, so every frame of every countdown is a
   * straight by the curvature test alone.
   */
  function onAStraight(): boolean {
    if (pictureLocked()) return false;
    const p = ctx.player;
    if (!p) return true;
    if (p.drift.active || p.boost.time > 0 || !p.grounded || p.stunned > 0) return false;
    const track = ctx.track;
    if (!track || !here || !ahead) return true;
    track.sample(p.pos, here);
    if (Math.abs(here.curvature) > STRAIGHT) return false;
    const reach = Math.max(12, Math.abs(p.speed)) * LOOKAHEAD;
    for (let i = 1; i <= 3; i++) {
      track.spline.atDistance(here.distance + (reach * i) / 3, ahead);
      if (Math.abs(ahead.curvature) > STRAIGHT) return false;
    }
    return true;
  }

  /**
   * Compile every program any rung can ask for, before any rung asks for it.
   *
   * ── Why this exists ────────────────────────────────────────────────────────
   *
   * Measured on the previous ladder: switching to the floor rung took the
   * program count from 75 to 101 and cost a **762ms** frame — the ladder's
   * rescue move being, by a factor of three, the worst hitch of the session. A
   * governor whose emergency brake is itself an emergency is not a governor.
   *
   * The real fix is upstream and is in `LADDER`: no rung introduces a shader
   * variant the top rung has not already drawn, because none of them turns the
   * post stack or the shadow map off. This is the proof and the belt to that
   * braces. It walks the ladder's *distinct render states* — the combinations
   * of `shadows`, `postfx` and `aa` that actually change which programs three
   * builds — applies each one, and asks the renderer to compile the scene under
   * it. On the current ladder that is a single state and a single compile,
   * which is exactly the point: if somebody adds a rung that flips one of those
   * flags, the cost lands here, at a load screen, instead of on the frame that
   * was already failing.
   *
   * Deliberately *not* in `init()`'s own body: systems are initialised before
   * the first `startRace`, so at that moment the scene is empty and compiling
   * it compiles nothing. It runs from `reset()`, once per course per session,
   * with the world built and immediately before main.ts's own priming frame.
   *
   * ── What it deliberately does NOT do, and the measurement that says so ─────
   *
   * The review that sent this file back asked for the ladder's *buffers* to be
   * pre-sized here as well as its programs — the eight post-stack render
   * targets and the shadow map, at every rung — on the reading that a rung
   * change costing 3.1x a steady frame with a flat program count (85, checked)
   * had to be buffer reallocation. The first half of that is exactly right. The
   * second half names the wrong buffers, and pre-sizing would have bought
   * nothing at all.
   *
   * Measured live at 320x180 under a software rasteriser, on the page's own rAF
   * loop, one lever at a time, each against the median delivered frame
   * immediately before it (~200-225ms):
   *
   *   the whole rung change, 0 -> 3                 596ms   +371
   *   render scale 1.00 -> 0.68, nothing else       541ms   +348
   *   render scale 0.68 -> 1.00, nothing else       530ms   +329
   *   shadow map 2048 -> 768, nothing else          492ms   +262
   *   shadow map 768 -> 2048, nothing else          190ms      0
   *   `quality:changed` emitted, settings unchanged 259ms    +34
   *   drawDistance 1.00 -> 0.76, nothing else       212ms      0
   *   the eight post targets resized by hand        229ms      0
   *   `setSize` to the size the canvas already has  197ms      0
   *   the same rung change, size already allocated  558ms   +330
   *
   * Four things fall out of that, and the third is the one the directive turns
   * on:
   *
   *   - **The post stack's targets are free.** `sceneTarget`, `ldrTarget`, the
   *     depth texture and the five bloom mips, all eight resized in one go,
   *     cost less than the noise on a frame. Pre-sizing them would pre-size
   *     nothing worth having.
   *   - **The canvas drawing buffer is the whole bill.** Render scale on its
   *     own is +348ms in *both* directions, and it is the only thing a scale
   *     change does that the row above it does not. It is a swap-chain rebuild,
   *     not a texture allocation — resizing the canvas to the size it already
   *     has is free, because Blink early-outs on an unchanged size.
   *   - **Pre-sizing cannot help, because nothing is cached.** The last row is
   *     the same change repeated to a size the driver had already allocated and
   *     freed once, at full price. Walking the six rung sizes at load would
   *     cost six of these reallocations — about two seconds of boot — to buy
   *     the zero that measurement says is there. So it is not done.
   *   - **The shadow map's *size* carries a hitch of its own.** Shrinking it
   *     from 2048 to 768 is +262ms on its own, the same shape as the render
   *     scale and for the same reason — a depth attachment disposed and rebuilt
   *     — while growing it back measured nothing. Four of the ladder's five
   *     transitions move it. It stays, because `LADDER`'s lever table prices
   *     the whole 2048 -> 256 range at 2% of a steady frame and 2% of a
   *     thousand-millisecond frame pays a 262ms hitch back inside twenty
   *     frames; but it is the one lever here whose hitch is comparable to what
   *     it buys, and it is the first thing to take off the ladder if a rung
   *     change ever has to get cheaper.
   *
   * What remains is one drawing-buffer reallocation per rung change, which is
   * what changing the render resolution *is*. It cannot be removed from this
   * file. The structural fix is to hold every target at the top rung's size and
   * render into a viewport sub-rectangle with each post pass sampling through a
   * uv scale — real dynamic resolution — which is a `render/post.ts` change and
   * moves the final resolve to full resolution, a lever the same table prices
   * at 7% of every frame for ever. That is a trade for a coherence pass to make
   * with the render module, not for a governor to make on its own.
   *
   * So the number is published instead of hidden: every change carries its own
   * `changeMs`, and `probe().changeWorstMs` is the worst of the session.
   */
  let precompiledFor = '';
  function precompileLadder(): void {
    const key = ctx.track?.id ?? '';
    if (!ctx.scene || !ctx.camera) return;
    if (precompiledFor === key && key !== '') return;
    precompiledFor = key;

    const before = ctx.quality;
    const seen = new Set<string>();
    for (const r of LADDER) {
      const s = r.settings;
      // Only the flags that change the *program*. `shadowSize`, `particles`,
      // `drawDistance` and the render scale reallocate buffers and cull
      // objects; none of them recompiles anything.
      const state = `${s.shadows}|${s.postfx}|${s.aa}`;
      if (seen.has(state)) continue;
      seen.add(state);
      ctx.quality = s;
      ctx.renderer.shadowMap.enabled = s.shadows;
      try {
        ctx.renderer.compile(ctx.scene, ctx.camera);
      } catch {
        // A compile failure here is a warm-up that did not happen, not a bug in
        // the game — the material will compile on its first draw as it always
        // did. Never let it take the boot down.
        break;
      }
    }
    ctx.quality = before;
    ctx.renderer.shadowMap.enabled = before.shadows;
    ctx.renderer.shadowMap.needsUpdate = true;
  }

  const probe = (): QualityProbe => {
    const b = ctx.budget;
    const q = ctx.quality;
    // Called by hand, so the sort is free here. Everything else in this file
    // reads the two fields it writes without recomputing them.
    measureWindow();
    return {
      auto,
      benched,
      rung: index,
      label: LADDER[index]?.label ?? String(q.tier),
      tier: q.tier,
      scale: LADDER[index]?.scale ?? 1,
      drawDistance: +q.drawDistance.toFixed(3),
      particles: +q.particles.toFixed(3),
      shadowSize: q.shadows ? q.shadowSize : 0,
      content: {
        crowd: content.crowd, scatter: content.scatter,
        minPx: content.minPx, shellPx: content.shellPx,
        crowdGeos: contentCrowd, batches: contentScatter,
        cullables: contentCullable, shells: contentShells,
        culled: culledNow, shelled: shelledNow,
      },

      wallMs: +wallMean.toFixed(2),
      wallMedianMs: +wallMedian.toFixed(2),
      wallMadMs: +wallMad.toFixed(2),
      wallWorstMs: +wallWorst.toFixed(2),
      wallBestMs: +wallBest.toFixed(2),
      lateFrac: +lateFrac.toFixed(3),
      samples: wallCount,
      fps: wallMean > 0 ? +(1000 / wallMean).toFixed(1) : 0,

      workMs: +workMean.toFixed(3),
      meanMs: +(b?.meanMs ?? 0).toFixed(3),
      worstMs: +(b?.worstMs ?? 0).toFixed(3),
      simMs: +(b?.meanSimMs ?? 0).toFixed(3),
      drawMs: +(b?.meanDrawMs ?? 0).toFixed(3),
      bound: b ? boundBy(b) : '',

      dwell: +(settleFor < SETTLE ? settleFor - SETTLE : overFor || underFor).toFixed(2),
      liveSeconds: +liveSeconds.toFixed(2),
      holding,
      futile,
      stalled,
      suspended,
      hijacked,
      phase: ctx.race?.phase ?? '',
      locked: pictureLocked(),
      frontEnd: frontEndOpen,
      frontEndCovers,
      frontEndFor: +frontEndFor.toFixed(2),
      ceremonyFor: +ceremonyFor.toFixed(2),
      paused,
      raceTime: +(ctx.race?.time ?? 0).toFixed(2),
      sinceFlag: sinceFlag(),
      changeMs: +lastChangeMs.toFixed(1),
      changeWorstMs: +changeWorst.toFixed(1),
      log,
      verdicts,
    };
  };

  /**
   * What the frame is actually made of, walked off the live scene graph.
   *
   * "Measure first, then cut" needs somewhere to read the measurement, and
   * `stats()` reports one number for the whole world. This groups every drawn
   * node by the top-level scene child it hangs under and reports triangles,
   * draw calls and instance counts per group, so "757k triangles" becomes a
   * list with a worst offender at the top of it.
   *
   * Called by hand from a bench, never per frame — it allocates freely and
   * walks the whole graph.
   *
   * ── ...and the instancing audit, which is the half that names a culprit ────
   *
   * A per-group triangle count tells you *where* the frame went and never *what
   * to do about it*. The rule the budget is actually held to is ARCHITECTURE
   * §2.5 — anything that appears more than a handful of times is instanced —
   * and a rule that nobody can run is a rule nobody keeps. So the walk also
   * buckets every drawable by the pair that decides whether two draws can ever
   * become one, its **geometry and its material**, and reports every bucket
   * drawn more than `REPEAT_BAR` times as a separate mesh. Each of those is a
   * draw call that an `InstancedMesh` or a merge would remove, named, with its
   * cost attached, in `offenders`.
   *
   * ── Read `materials` next to `calls`, and read `offenders` being empty ─────
   *
   * Run on a racing frame with the whole field in view, `offenders` comes back
   * **empty** — nothing in this game draws the same geometry-and-material pair
   * more than eight times without instancing it. That is not a null result, it
   * is the finding: the draw calls are not going where a missing `InstancedMesh`
   * would put them. Read `materials` next to `meshes` and the answer is
   * immediate:
   *
   *   group      calls   triangles   meshes   materials
   *   Group        745      36,362      187          75   <- the seven racers
   *   world        171     516,356      121           7
   *   track         34     167,102       23          22
   *   itemRig       37       4,790       22          15
   *
   * Sixty-eight percent of the frame's draw calls for four percent of its
   * triangles, and seventy-five materials across seven machines. Two things
   * follow, and only one of them is what it looks like.
   *
   * `mat()` in `vehicles/parts.ts` **is** cached, by colour and options, so
   * those seventy-five are seventy-five genuinely different paints and no
   * amount of merging goes below them — an earlier draft of this comment said
   * the opposite and was wrong. What can go is the *meshes*: a hundred and
   * eighty-seven of them across seven machines, where merging by material
   * identity gives about eleven a machine. That is what `Shell` does, and
   * because it is the same geometry in the same materials it is the one cut on
   * the whole ladder that changes no pixel at all.
   *
   * ── ...and read `items`, which is the row a cut can be aimed at ────────────
   *
   * `groups` says where the frame went. It never says what to do, because "the
   * world is 516k triangles" is not a lever. `items` is the same walk bucketed
   * by the name each module gave its own meshes, and on the same frame it names
   * the two things the content rungs actually spend:
   *
   *   world:cone         807 instances    74,244 tri   0.6m across
   *   world:crowd0..2     30 instances   140,808 tri  12.1m
   *   world:standCrowd*    3 instances    59,124 tri  11.5m
   *   world:drum          96 instances    16,512 tri   0.7m
   *   world:tyres         85 instances    15,300 tri   0.9m
   *   track:ground          1 instance    61,952 tri   the landscape field
   *
   * Eight hundred traffic cones at ninety-two triangles each, and a crowd that
   * is a fifth of everything drawn. See `ContentTrim`.
   *
   * ── ...and this is not `renderer.info` ────────────────────────────────────
   *
   * This walks `traverseVisible`, which is the `visible` flag and nothing else.
   * The renderer draws what survives the *frustum* on top of that, so
   * `stats().drawCalls` on the same frame reads lower — 303 against 774 here —
   * and the gap is the half of the world that is behind the camera. Use this to
   * find what the frame is made of; use `stats()` for what it cost.
   */
  interface AuditRow {
    group: string;
    calls: number;
    triangles: number;
    instances: number;
    /** Drawable nodes. `instances / meshes` is the instancing audit: anything
     *  that appears more than eight times should be a handful of meshes with a
     *  lot of instances, never a lot of meshes. */
    meshes: number;
    /** Top-level scene children that fell into this row — the vehicle roots are
     *  unnamed, so all seven collapse into one, and the row means nothing
     *  without knowing that. */
    nodes: number;
    casts: number;
    /** Draws this row owes to *multi-material* meshes, over and above one per
     *  mesh. A merge that keeps N materials produces N draws and saves nothing,
     *  which is a merge that looks done and is not. */
    matGroups: number;
    /** Distinct materials. Two parts the same colour built through two calls to
     *  `mat()` are two materials and therefore two draws, however identical
     *  they look — so this is the number a merge has to bring down. */
    materials: number;
  }
  /** Separate meshes of the same geometry+material above which the pair should
   *  have been one instanced draw. ARCHITECTURE §2.5 says ~20; eight is the
   *  bar this file's own brief sets and the stricter of the two. */
  const REPEAT_BAR = 8;
  interface AuditOffender {
    /** Where it lives, and what it is. */
    group: string;
    name: string;
    /** Separate draws of the identical geometry+material pair. */
    draws: number;
    /** ...and what collapsing them to one instanced draw would save. */
    savesCalls: number;
    triangles: number;
  }
  /**
   * One named thing in the frame, which is the row a *cut* can be aimed at.
   *
   * `groups` says the world is 362k triangles and `offenders` says nothing is
   * un-instanced, and between them they still do not say what to do: "the world
   * is expensive" is not a lever. This is the list that is — every drawable
   * bucketed by the name its own module gave it (`world:crowdBank`,
   * `land:mass`, `track:barrier`), with the two facts a content rung decides on
   * next to the cost: how big the thing is in metres, and how far off the road
   * it lives.
   */
  interface AuditItem {
    group: string;
    name: string;
    calls: number;
    triangles: number;
    meshes: number;
    instances: number;
    /** Mean world-space bounding radius of the meshes in this row, metres. */
    radius: number;
    /** ...and the mean distance from the camera at the moment of the audit. */
    dist: number;
  }
  function audit(): {
    total: AuditRow; groups: AuditRow[]; offenders: AuditOffender[];
    items: AuditItem[];
  } {
    const rows = new Map<string, AuditRow>();
    const blank = (name: string): AuditRow => ({
      group: name, calls: 0, triangles: 0, instances: 0, meshes: 0, nodes: 0,
      casts: 0, matGroups: 0, materials: 0,
    });
    const total = blank('all');
    const mats = new Map<string, Set<unknown>>();
    const row = (name: string): AuditRow => {
      let r = rows.get(name);
      if (!r) { r = blank(name); rows.set(name, r); }
      if (!mats.has(name)) mats.set(name, new Set());
      r.nodes++;
      return r;
    };

    interface DrawableLike {
      isMesh?: boolean;
      isInstancedMesh?: boolean;
      isPoints?: boolean;
      isLine?: boolean;
      name?: string;
      count?: number;
      castShadow?: boolean;
      geometry?: {
        uuid?: string;
        index?: { count: number } | null;
        drawRange?: { start: number; count: number };
        getAttribute?(name: string): { count: number } | undefined;
      };
      material?: unknown;
    }

    /** geometry+material pair -> how many separate meshes draw it. */
    const pairs = new Map<string, AuditOffender>();
    /** ...and group+name -> what that named thing costs. */
    const named = new Map<string, AuditItem>();
    const _c = new ctx.THREE.Vector3();

    for (const top of ctx.scene.children) {
      const name = top.name || top.type;
      const r = row(name);
      const seenMats = mats.get(name)!;
      top.traverseVisible((o) => {
        const mesh = o as unknown as DrawableLike;
        if (!mesh.isMesh && !mesh.isPoints && !mesh.isLine) return;
        const geo = mesh.geometry;
        if (!geo) return;
        // The **drawn** count, not the resident one. A crowd geometry the
        // content rung has trimmed with `setDrawRange` still owns all its
        // indices; reporting those would make the audit contradict
        // `renderer.info` at exactly the rungs the audit exists to explain.
        const whole = geo.index?.count ?? geo.getAttribute?.('position')?.count ?? 0;
        const ranged = geo.drawRange?.count ?? Infinity;
        const verts = ranged < whole ? ranged : whole;
        const n = mesh.isInstancedMesh ? (mesh.count ?? 0) : 1;
        // A multi-material mesh is one draw per group.
        const list = Array.isArray(mesh.material) ? mesh.material : null;
        const groups = list ? list.length : 1;
        r.meshes++;
        r.instances += n;
        if (n > 0) r.calls += groups;
        r.matGroups += groups - 1;
        if (list) for (const m of list) seenMats.add(m);
        else if (mesh.material) seenMats.add(mesh.material);
        const tris = ((verts / 3) | 0) * n;
        r.triangles += tris;
        if (mesh.castShadow && n > 0) r.casts += groups;

        // The named bucket — the one a cut can be aimed at. Radius and
        // distance come off the geometry's own bounding sphere pushed through
        // the node's world matrix, which is what a screen-size test would use.
        {
          const key = `${name}/${mesh.name || o.type}`;
          let it = named.get(key);
          if (!it) {
            it = {
              group: name, name: mesh.name || o.type,
              calls: 0, triangles: 0, meshes: 0, instances: 0, radius: 0, dist: 0,
            };
            named.set(key, it);
          }
          it.meshes++;
          it.instances += n;
          if (n > 0) it.calls += groups;
          it.triangles += tris;
          const node = o as unknown as {
            geometry?: { boundingSphere?: { radius: number; center: THREE.Vector3 } | null;
              computeBoundingSphere?(): void };
            matrixWorld: THREE.Matrix4;
          };
          const g = node.geometry;
          if (g && !g.boundingSphere) g.computeBoundingSphere?.();
          const bs = g?.boundingSphere;
          if (bs) {
            const s = o.matrixWorld.elements;
            const sx = Math.hypot(s[0]!, s[1]!, s[2]!);
            it.radius += bs.radius * sx;
            _c.copy(bs.center).applyMatrix4(o.matrixWorld);
            it.dist += _c.distanceTo(ctx.camera.position);
          }
        }

        // The instancing bucket. Instanced meshes are already the answer and
        // are skipped; everything else is a candidate to be one.
        if (mesh.isInstancedMesh || n <= 0) return;
        const mid = list
          ? list.map((m) => (m as { uuid?: string }).uuid ?? '?').join(',')
          : ((mesh.material as { uuid?: string } | undefined)?.uuid ?? '?');
        const key = `${name}|${geo.uuid ?? '?'}|${mid}`;
        const hit = pairs.get(key);
        if (hit) {
          hit.draws++;
          hit.savesCalls += groups;
          hit.triangles += tris;
          if (!hit.name && mesh.name) hit.name = mesh.name;
        } else {
          pairs.set(key, {
            group: name,
            name: mesh.name || (o.parent?.name ?? ''),
            draws: 1,
            savesCalls: 0,
            triangles: tris,
          });
        }
      });
      // Shadow casters are drawn a second time, into the map.
      if (ctx.quality.shadows) r.calls += r.casts;
    }

    for (const r of rows.values()) {
      r.materials = mats.get(r.group)?.size ?? 0;
      total.calls += r.calls;
      total.triangles += r.triangles;
      total.instances += r.instances;
      total.meshes += r.meshes;
      total.nodes += r.nodes;
      total.casts += r.casts;
      total.matGroups += r.matGroups;
      total.materials += r.materials;
    }
    const groups = [...rows.values()].sort((a, b) => b.triangles - a.triangles);
    const offenders = [...pairs.values()]
      .filter((p) => p.draws > REPEAT_BAR)
      .sort((a, b) => b.savesCalls - a.savesCalls);
    const items = [...named.values()]
      .map((it) => ({
        ...it,
        radius: +(it.radius / Math.max(1, it.meshes)).toFixed(1),
        dist: +(it.dist / Math.max(1, it.meshes)).toFixed(1),
      }))
      .sort((a, b) => b.triangles - a.triangles);
    return { total, groups, offenders, items };
  }

  return {
    name: 'quality',
    // After everything that draws and before the HUD, so a readout that wants
    // to show the tier sees this frame's answer rather than last frame's.
    order: 95,

    init(): void {
      here = blankSample(ctx);
      ahead = blankSample(ctx);
      // Start from a known rung rather than inheriting whatever main.ts built,
      // so `index` and `ctx.quality` cannot disagree from the first frame.
      applyRung(START_RUNG, 'settling');

      // ── the two edges the race phase cannot give us ──────────────────────
      //
      // ARCHITECTURE §11a. The front-end sits over a race that is already
      // simulating, and the pause screen is a still frame of the game with a
      // plate on it; `race.phase` reports `intro`/`racing` for the first and
      // `loading` for the second, which is also what it reports at boot. The
      // modules that own those screens publish both edges, `race/director.ts`
      // has always stood off them, and this file believing the phase instead
      // is what put three rung changes on a title screen.
      //
      // Both edges also empty the window, and that is not housekeeping: the
      // menus draw their own 3D set through the same post stack, so a mean
      // that straddles the curtain is a mean across two different scenes, and
      // a futility verdict that straddles it is comparing one scene's median
      // against another's. `liveSeconds` deliberately keeps running — the
      // machine did not get faster because a menu came up, and the warm-up is
      // about the machine.
      ctx.bus.on<{ open: boolean }>('ui:menu', (e) => {
        const open = e?.open === true;
        if (open === frontEndOpen) return;
        frontEndOpen = open;
        ceremonyFor = 0;
        ceremonyPhase = '';
        frontEndFor = 0;
        // A fresh front-end session is not a hand-off, and the set it hides
        // behind is worth finding again — `createStage()` can decline, and a
        // front-end with no set of its own must never have the race behind it
        // turned off. Looked up rather than held from boot because this file is
        // constructed before the menus mount their DOM.
        if (open) {
          handingOver = false;
          if (!stageEl && typeof document !== 'undefined') {
            stageEl = document.querySelector<HTMLElement>('#menu canvas.stage');
          }
        }
        // Synchronously, because this edge arrives from inside the menus' own
        // `update` — after ours, before the draw. See `republishCover`.
        republishCover();
        abandonVerdict();
        // **A futility verdict belongs to the scene it was measured on.**
        //
        // The curtain is a scene change, in both directions: on one side the
        // race with its draw switched off behind a set this ladder does not
        // size, on the other the race itself. Carrying `stalled` across it is
        // how a governor that correctly measured "cutting does not help this
        // title screen" arrives at the flag unable to cut anything, and how one
        // that gave up on a race would refuse to help the next front-end. The
        // *rung* carries — that is a statement about the machine — and the
        // verdict about whether this ladder's levers reach does not.
        stalled = false;
        futile = 0;
        clearWindow();
        overFor = 0; underFor = 0; panicFor = 0;
        overFrames = 0; underFrames = 0; panicFrames = 0;
        settleFor = 0; settleFrames = 0;
      });
      // The flag itself, from the module that drops it. `setPhase` emits this
      // on the transition into `racing` and `setPhaseQuiet` does not, so a
      // resume from pause cannot counterfeit a start. See `CEREMONY_GRACE`.
      ctx.bus.on('race:racing', () => { flagAt = ctx.time.elapsed; flagFor = 0; });
      ctx.bus.on<{ on: boolean }>('race:pause', (e) => {
        const on = e?.on === true;
        if (on === paused) return;
        paused = on;
        frontEndFor = 0;
        // A paused game renders the same still frame over and over for as long
        // as the player leaves it, which is neither this machine's speed nor
        // this scene's cost. Measuring it would flatter the ladder into
        // climbing on evidence made of a frozen picture.
        abandonVerdict();
        clearWindow();
        overFor = 0; underFor = 0; panicFor = 0;
        overFrames = 0; underFrames = 0; panicFrames = 0;
        settleFor = 0; settleFrames = 0;
      });

      // ── the only two things that mean "that was not a frame" ─────────────
      //
      // See the note where `STALL_MS` used to be. `visibilitychange` covers the
      // backgrounded tab and the locked phone; `pageshow` covers a bfcache
      // restore, which on some browsers arrives without a visibility edge. Both
      // do the same thing — mark the *next* gap as spanning a suspension — and
      // neither of them looks at how long anything took.
      if (typeof document !== 'undefined' && document.addEventListener) {
        pageHidden = document.visibilityState === 'hidden';
        const onVisible = (): void => {
          const hidden = typeof document !== 'undefined'
            && document.visibilityState === 'hidden';
          if (hidden) {
            pageHidden = true;
          } else if (pageHidden) {
            pageHidden = false;
            resumed = true;
          }
        };
        // `persisted` only, and that word is doing real work: `pageshow` also
        // fires on the *first* load, so without the test every session starts
        // by reporting one suspended frame it never had. A restore from the
        // back/forward cache is the case this is here for, and it is the only
        // one that sets the flag.
        const onShow = (e: Event): void => {
          if (!(e as PageTransitionEvent).persisted) return;
          resumed = true;
          pageHidden = false;
        };
        document.addEventListener('visibilitychange', onVisible);
        globalThis.addEventListener?.('pageshow', onShow);
        offVisibility = (): void => {
          document.removeEventListener('visibilitychange', onVisible);
          globalThis.removeEventListener?.('pageshow', onShow);
        };
      }


      // A tier chosen by hand — a player in an options screen, a reviewer
      // calling `__GAME.setQuality('low')` — is a decision, and a measurement
      // does not get to overrule a decision. Identity is the test: our own
      // emit carries the object we just wrote.
      ctx.bus.on<{ quality: QualitySettings }>('quality:changed', (e) => {
        if (!e?.quality || e.quality === applied) return;
        auto = false;
        applied = e.quality;
        index = nearestRung(e.quality);
        // Bring the render resolution to the rung that pick lands on, or a
        // reviewer who asks for `high` after the ladder has been to the floor
        // gets high's shadows and the floor's pixels, and photographs a state
        // no rung describes.
        applyScale(LADDER[index]!.scale);
        clearWindow();
        holding = 'pinned';
      });

      (globalThis as unknown as Record<string, unknown>).__QUALITY = {
        probe,
        /** Hand the ladder back to the measurement, or take it away. */
        auto(on: boolean): boolean {
          auto = on !== false;
          if (auto) {
            overFor = 0; underFor = 0; panicFor = 0; settleFor = 0;
            liveSeconds = 0;
            clearWindow();
          }
          externalTouch();
          return auto;
        },
        /** Pin a rung by index. For the bench — a player picks a tier. */
        set(i: number): number {
          auto = false;
          applyRung(i, 'pinned');
          holding = 'pinned';
          // After `applyRung`, which is what opens the measurement window this
          // is spoiling. See `externalTouch`.
          externalTouch();
          return index;
        },
        /**
         * Apply an arbitrary state and hold it, for the cost bench.
         *
         * The ladder's numbers in the comment above are only worth what the
         * measurement behind them is worth, and the measurement needs to move
         * one lever at a time against a frozen sim state — which no combination
         * of `set()` calls can do, because a rung moves five levers at once.
         *
         * The recipe, for whoever re-measures this after the course changes
         * under them again: `__GAME.seek('racing')`, `step()` to a real racing
         * moment, `__GAME.setTimeScale(0)` to freeze it, then `try()` each
         * configuration and take the *median rAF period* over a few seconds,
         * interleaved so page warm-up cannot flatter whichever went first.
         */
        try(trim: Partial<QualitySettings>, scale?: number): QualityProbe {
          auto = false;
          const q: QualitySettings = { ...ctx.quality, ...trim };
          ctx.quality = q;
          applied = q;
          ctx.renderer.shadowMap.enabled = q.shadows;
          ctx.renderer.shadowMap.needsUpdate = true;
          if (typeof scale === 'number') applyScale(scale);
          clearWindow();
          holding = 'pinned';
          externalTouch();
          ctx.bus.emit('quality:changed', {
            quality: q,
            scale: typeof scale === 'number' ? scale : LADDER[index]!.scale,
            rung: index,
            label: LADDER[index]!.label,
          });
          return probe();
        },
        /** What the frame is made of, by scene group. See `audit`. */
        audit,
        /**
         * Apply a content trim on its own, for the cost bench.
         *
         * The other half of `try()`. A rung moves five settings, a render scale
         * and four content levers together, and the only way to know what any
         * one of them is worth is to move it by itself against a frozen sim
         * state. Passing nothing puts the content back to whatever the standing
         * rung asks for.
         */
        content(trim?: Partial<ContentTrim>): QualityProbe {
          auto = false;
          applyContent(trim
            ? { ...LADDER[index]!.content, ...trim }
            : LADDER[index]!.content);
          contentFrame();
          clearWindow();
          externalTouch();
          return probe();
        },
        /** Re-take the census by hand, after a bench has rebuilt the world. */
        census(): QualityProbe {
          censusContent();
          buildShells();
          applyContent(content);
          externalTouch();
          return probe();
        },
        ladder: LADDER.map((r) => ({
          label: r.label,
          scale: r.scale,
          tier: r.settings.tier,
          shadows: r.settings.shadows,
          shadowSize: r.settings.shadowSize,
          postfx: r.settings.postfx,
          bloom: r.settings.bloom !== false,
          aa: r.settings.aa,
          particles: r.settings.particles,
          drawDistance: r.settings.drawDistance,
          content: r.content,
        })),
      };
    },

    reset(_cfg: RaceConfig): void {
      // A fresh race gets a fresh verdict: whatever the previous one measured
      // was measured against a different course, a different field and, if the
      // harness reset us, a different machine's worth of work.
      overFor = 0;
      underFor = 0;
      panicFor = 0;
      overFrames = 0;
      underFrames = 0;
      panicFrames = 0;
      settleFor = 0;
      settleFrames = 0;
      benchQuietFor = 0;
      verdictPending = false;
      ceremonyFor = 0;
      ceremonyPhase = '';
      // ── the front-end has stopped covering the frame ─────────────────────
      //
      // `ui:menu {open:false}` fires at the *end* of the hand-off, not the
      // start: the launch board closes over the menus, the race is built, the
      // board swings open onto the race, and only then is the front-end
      // declared closed. For the length of that swing the front-end is still
      // open on the wire and the race behind it is the picture the player is
      // being shown. Building the race is the last thing that happens before
      // the reveal, so this is the earliest honest moment to start drawing it
      // again — a whole beat early, which is the right direction to be wrong
      // in. Republished synchronously because `resetAll` is called from inside
      // the menus' own update, after ours and before the draw.
      //
      // ...and that beat is worth having for a second reason, measured: the
      // **first** drawn frame after a stretch of skipped ones costs about two
      // seconds under a software rasteriser — pipeline re-validation, not
      // anything this file can avoid — against 3.8ms for the frame after it.
      // Landing that on the frame the launch board is fully across, with
      // `CARD_HOLD` and the board's whole swing still to come, is the
      // difference between a hitch nobody sees and a two-second freeze in the
      // middle of the one transition the product is built around.
      handingOver = true;
      republishCover();
      // `main.ts` puts `ctx.time.elapsed` back to zero for a new race, so a
      // flag latched against the old clock would read as a flag in the distant
      // future and seal the picture until the new race caught up with it.
      flagAt = -Infinity;
      clearWindow();
      lastFrameAt = 0;
      // `benched` is deliberately *not* cleared: a page that has been driven by
      // the harness once stays a bench. `benchFrames` is, so the frame the
      // front end primes for this race reads as the first one again.
      benchFrames = -1;
      // Neither is `liveSeconds`: the warm-up is about this *machine*, and the
      // machine did not become unknown again because a race restarted. Re-arming
      // it every reset is how a governor spends a whole session warming up.
      //
      // The rung is not reset either. A machine that earned its way down to
      // `med` in the last race has not become faster by starting another one,
      // and re-climbing the ladder every race is the oscillation this whole
      // file exists to avoid — just spread over minutes instead of seconds.
      if (auto && applied !== ctx.quality) applyRung(index, 'settling');
      // The world is built by the time `resetAll` runs, so this is the first
      // moment there is anything to compile — and it lands immediately before
      // main.ts's own priming render rather than on a frame a player is
      // watching. Once per course per session; see `precompileLadder`.
      precompileLadder();
      // ── the content ladder's own load-time work ──────────────────────────
      //
      // Same moment, same argument, and the two halves have different
      // lifetimes. The census is per *course* — the dressing is a pure
      // function of the track id and `world/index.ts` skips rebuilding an
      // identical one — while the shells are per *field*, because `reset()`
      // hands out new racer objects with new models every race.
      const key = ctx.track?.id ?? '';
      if (censusFor !== key || crowdGeos.length + scatter.length === 0) {
        censusFor = key;
        censusContent();
      }
      buildShells();
      // Whatever rung is standing has to be re-installed onto the new census
      // and the new shells, or a race that starts at rung 5 starts with a full
      // crowd and seven un-merged machines until the governor next moves.
      applyContent(LADDER[index]!.content);
      // `benchSteps` is re-baselined rather than compared across the reset: the
      // harness took a great many of them getting here and the first live frame
      // after a race build has no previous frame to be spoiled relative to
      // (`lastFrameAt` is 0, so the next live frame takes no sample anyway).
      seenBenchSteps = -1;
      harnessSince = false;
    },

    /**
     * Visuals only, and only ever a read of the budget and the clock. Nothing
     * here is allowed to reach the simulation, and nothing here allocates: the
     * sample buffers are owned, the window is a typed array, and the probe and
     * the log entries are built only when something actually happens.
     */
    update(): void {
      const b = ctx.budget;
      if (!b) return;

      // ── sample the frame ─────────────────────────────────────────────────
      //
      // `liveFrames` is incremented by the engine at the *top* of `renderFrame`,
      // so by the time we run it already counts this frame. A frame the rAF loop
      // did not drive is a frame whose spacing means nothing.
      const live = b.liveFrames !== seenLive;
      seenLive = b.liveFrames;

      // ── did the harness touch anything since the last delivered frame ────
      //
      // Both kinds of harness work block the rAF loop for as long as they run:
      // `step()` inside a `page.evaluate`, which renders nothing at all and can
      // hold the thread for seconds, and `render()` bursts from a capture. The
      // live frame that lands afterwards measures a gap made of somebody else's
      // work. This is a **latch**, not a per-call test, precisely because
      // `step()` never enters `update()`: the change is noticed on whichever
      // call comes next — quite possibly a bench render — and has to survive
      // until a *live* frame consumes it.
      const benchFramesMoved = b.benchFrames !== benchFrames;
      if (b.benchSteps !== seenBenchSteps) {
        if (seenBenchSteps >= 0) harnessSince = true;
        seenBenchSteps = b.benchSteps;
      }
      if (benchFramesMoved && benchFrames >= 0) harnessSince = true;

      let secs = 0;
      /**
       * 1 on a delivered frame this file is allowed to count, 0 otherwise.
       *
       * **The unit every dwell and settle is really in.** A wall second is
       * sixty frames on a machine that is fine and two thirds of one on a
       * machine at 0.7fps, so "wait 1.2s before believing that" and "wait for
       * more than one picture before believing that" are the same sentence on
       * one machine and opposite sentences on the other. Both are now counted
       * and both have to be satisfied. A spoiled frame — the page suspended,
       * the harness driving — is not a picture the player was shown, so it
       * counts for neither.
       */
      let frameTick = 0;
      if (live) {
        const t = nowMs();
        const gap = lastFrameAt > 0 ? t - lastFrameAt : 0;
        lastFrameAt = t;
        // **No upper bound on `gap`.** See the note where `STALL_MS` used to
        // be: a frame is discarded because the page was not running through it,
        // never because it was long. A 2.4 second frame on a visible page is a
        // 2.4 second frame, and it is the whole reason this file exists.
        const spoiled = resumed || pageHidden || harnessSince;
        if (spoiled) {
          if (resumed || pageHidden) suspended++; else hijacked++;
          resumed = false;
          harnessSince = false;
          // A change whose own reallocation window contains somebody else's
          // work has no measurable cost. Latched rather than tested at the
          // recording site because the spoiled frame and the frame that closes
          // the window are usually not the same frame.
          if (changeEntry) changeSpoiled = true;
        } else if (gap > 0) {
          secs = gap / 1000;
          frameTick = 1;
          liveSeconds += secs;
          // The frames right after a change are the change reallocating itself,
          // not the game. They still count as time; they are not evidence.
          //
          // ...and they are no longer thrown away unread. The worst of them is
          // what the change *cost*, which for three rounds was the one number
          // this instrument could not produce about the one hitch it is
          // personally responsible for. See `SKIP_FRAMES`.
          if (skipFrames > 0) {
            skipFrames--;
            // **Only when there is a change to charge it to.** The window is
            // also emptied by things that are not the governor's doing — the
            // front-end opening over the race, a pause, a reviewer pinning a
            // tier — and the frame that spans one of those is somebody else's
            // work. Charged indiscriminately it read `changeWorstMs: 4921.7`
            // on a session whose worst actual rung change was 704ms, which is
            // an instrument lying in the governor's favour rather than against
            // it and is exactly as useless.
            //
            // ...and **only on a page nothing else is driving.** `changeMs` is
            // the one number in this file that is a claim about the governor's
            // own conduct, so it is the one number that must never be inflated
            // by somebody else's work. Measured on a frozen-sim ladder bench
            // where an interleaved measurement put the real cost of a switch at
            // 6-17.5ms, `probe().changeWorstMs` read **15,628.6ms**: the bench
            // drives the ladder from `page.evaluate`, which moves neither
            // `benchSteps` nor `benchFrames`, so the Node round trip that
            // followed each switch was invisible to the `spoiled` test above
            // and landed on the governor's account. `benched` and
            // `changeSpoiled` are the two facts that were missing — see
            // `externalTouch`.
            if (changeEntry) {
              if (benched || changeSpoiled) {
                // Unmeasurable rather than free: leaving `changeMs` at 0 says
                // "nobody timed this", which is true, and is the only thing
                // that is.
                if (skipFrames === 0) changeEntry = null;
              } else {
                if (gap > changeCost) changeCost = gap;
                if (skipFrames === 0) {
                  lastChangeMs = changeCost;
                  if (changeCost > changeWorst) changeWorst = changeCost;
                  changeEntry.changeMs = +changeCost.toFixed(1);
                  changeEntry = null;
                }
              }
            }
          } else {
            wall[wallIdx] = gap;
            // The budget's per-frame fields are written at the *end* of
            // `renderFrame` and we run inside the update pass, so these are the
            // previous frame's costs — which is the frame `gap` just measured.
            work[wallIdx] = b.simMs + b.updateMs + b.drawMs;
            wallIdx = (wallIdx + 1) % WALL_WINDOW;
            if (wallCount < WALL_WINDOW) wallCount++;

            let sum = 0;
            let wsum = 0;
            let worst = 0;
            let best = Infinity;
            let late = 0;
            const lateAt = TARGET_MS * LATE_FACTOR;
            for (let i = 0; i < wallCount; i++) {
              const v = wall[i]!;
              sum += v;
              wsum += work[i]!;
              if (v > worst) worst = v;
              if (v < best) best = v;
              if (v > lateAt) late++;
            }
            wallMean = sum / wallCount;
            workMean = wsum / wallCount;
            wallWorst = worst;
            wallBest = best === Infinity ? 0 : best;
            lateFrac = late / wallCount;
          }
        }
      }

      // ── the moment gate's one remaining clock ────────────────────────────
      //
      // Accrued here, above every early return, because the gate has to be
      // right on the first frame the governor is allowed to act on rather than
      // catching up afterwards — and because a pinned or benched page still
      // walks through a countdown and still deserves an honest `locked` in the
      // probe. `secs` is zero on a frame the rAF loop did not drive, so this
      // counts delivered play like everything else in this file.
      //
      // There used to be two clocks here. The second, `sinceCeremony`, counted
      // delivered-play seconds since the last composed frame and fed the flag's
      // grace — a beat measured in *race* seconds — which is the round-3 bug in
      // one line. That grace reads `ctx.race.time` now and needs no accumulator
      // of ours at all, so the clock is gone rather than converted: a number
      // this file does not keep is a number it cannot get the units of wrong.
      //
      // What remains is the two ceremony valves' and the front-end's, and all
      // three are in wall seconds because all three are about a *person
      // waiting* — see `CEREMONY_PATIENCE`. The ceremony clock is held at zero
      // behind the front-end: a sweep nobody can see is not a sweep anybody is
      // sitting through.
      //
      // It is also **scoped to one beat**. The sweep runs straight into the
      // countdown, so a single accumulator would carry the twenty seconds the
      // intro had already spent into the countdown's account and hand it a
      // valve that was open before the first numeral. Each beat waits out its
      // own patience.
      const nowPhase = ctx.race?.phase ?? '';
      if (frontEndOpen || paused) {
        ceremonyFor = 0;
        ceremonyPhase = '';
      } else if (isComposed(nowPhase)) {
        if (nowPhase !== ceremonyPhase) { ceremonyPhase = nowPhase; ceremonyFor = 0; }
        ceremonyFor += secs;
      } else {
        ceremonyFor = 0;
        ceremonyPhase = '';
      }
      frontEndFor = frontEndOpen ? frontEndFor + secs : 0;
      // ...and the launch's, which is the one clock in this file that measures
      // a *race* beat in wall seconds. See `LAUNCH_PATIENCE`.
      if (flagAt !== -Infinity) flagFor += secs;

      // ── is the race behind the front-end worth drawing at all ────────────
      //
      // Evaluated every delivered frame, above every early return, because it
      // is the one thing this file publishes that a *pinned* or *benched* page
      // still wants: a reviewer who has taken the ladder off auto has not asked
      // for the title screen to start drawing a race nobody can see again. See
      // `frontEndCovers` and `FrameBudget.skipDraw`.
      frontEndCovers = frontEndOpaque();

      // ── the content rung's per-frame half ────────────────────────────────
      //
      // Above every early return, for the same reason `frontEndCovers` is: it
      // is a property of the *frame about to be drawn*, not of the governor's
      // opinion. A pinned page, a benched page and a page whose ladder has
      // stood down all still want the machine two hundred metres away drawn as
      // one mesh rather than as thirty — that is what the rung the reviewer
      // pinned actually means, and a screenshot taken at rung 5 has to be a
      // photograph of rung 5.
      //
      // It is skipped only when there is nothing to draw: no census, no shells
      // and no cover to compute against.
      if (cullables.length || shells.size) contentFrame();

      // `benchFrames` only moves when `renderFrame` was called from outside the
      // rAF loop: the front end primes exactly one such frame per race start,
      // and the test harness renders them in bursts. Two inside a second and
      // this page is a bench for good. (`benchFramesMoved` above is the same
      // comparison, read before this block consumes it.)
      if (benchFramesMoved) {
        if (benchFrames >= 0 && benchQuietFor < BENCH_BURST) benched = true;
        benchFrames = b.benchFrames;
        benchQuietFor = 0;
      } else {
        benchQuietFor += secs;
      }

      if (!auto) return hold('pinned');
      if (benched) return hold('bench');
      if (benchQuietFor < BENCH_HOLD) {
        overFor = 0;
        underFor = 0;
        overFrames = 0;
        underFrames = 0;
        return hold('priming');
      }

      settleFor += secs;
      settleFrames += frameTick;
      if (verdictPending) verdictFrames += frameTick;
      if (wallCount < PANIC_SAMPLES) return hold('warming');

      // ── did the last cut buy anything ────────────────────────────────────
      //
      // **Above the emergency path, and that position is the whole point.**
      //
      // This block used to sit below it, and the emergency path `return`s — so
      // on the only route a genuinely slow machine ever takes, the safeguard
      // that stops cutting when cutting stops working was unreachable code.
      // Measured on the machine it exists for: a drop from rung 1 to rung 2
      // made the frame 77% *worse* and `futile` stayed at 0 for the whole run,
      // because the next frame panicked and returned before this could look at
      // it. A check that only runs when the machine is fine is not a check.
      //
      // Its evidence gate used to be a disjunction — `VERDICT_SAMPLES` frames
      // *or* `VERDICT_WAIT_S` seconds with four frames behind it — and the
      // second half of that was the only half a slow machine ever reached. Four
      // samples of a distribution running 17ms to 1233ms around a 483ms median
      // cannot resolve a 14% step, and live it convicted a drop that a
      // controlled interleave measured at 21-31% cheaper. It is one condition
      // now, it is the sample count, and there is no way round it.
      if (verdictPending && settleFor >= PANIC_SETTLE && settleFrames >= PANIC_SETTLE_FRAMES) {
        if (wallCount >= VERDICT_SAMPLES) {
          verdictPending = false;
          measureWindow();
          const after = wallMedian;
          const se = Math.hypot(seBefore, medianSe(wallMad, wallCount));
          const gain = wallBefore > 0 ? (wallBefore - after) / wallBefore : 1;
          // The bar is the larger of "a rung is worth having" and "this window
          // can tell". On a quiet machine the second term is a rounding error
          // and the bar is `FUTILE_GAIN`; on the machine this check keeps
          // getting wrong on, the second term is a fifth of the frame and says
          // so out loud instead of pretending to a decimal point.
          const bar = wallBefore > 0
            ? Math.max(FUTILE_GAIN, (FUTILE_Z * se) / wallBefore)
            : FUTILE_GAIN;
          let call: string;
          if (gain >= bar) {
            call = 'worked';
            futile = 0;
          } else if (gain <= -bar) {
            // **The frame got worse.** Not "bought nothing" — worse, by more
            // than the window's own error bar, which is the one reading no
            // amount of spread can explain away and the only one on this list
            // that is evidence *against* the direction of travel.
            //
            // It used to be folded in with `futile` and counted as one strike
            // of two, and that cost a live session its frame rate: rung 3 -> 4
            // measured `gain: -0.562` against `bar: 0.188` — 56% worse — and
            // the governor dropped to rung 5 eight tenths of a second later,
            // because the strike before it had been a `worked` and the counter
            // had just been cleared. A cut that is measured to have hurt is
            // undone on the spot; there is nothing a second sample can add
            // that this one has not already said.
            call = 'worse';
            futile = FUTILE_LIMIT;
          } else if (bar <= FUTILE_RESOLVE) {
            // The window is tight enough that a gain this small is genuinely a
            // gain this small.
            call = 'futile';
            futile++;
          } else {
            // The honest answer, and the one this check never used to have.
            // Nothing is decided: `futile` is neither raised nor cleared, the
            // ladder is free to carry on, and the reading is in the probe with
            // the bar it could not clear next to it.
            call = 'unresolved';
          }
          if (verdicts.length >= 16) verdicts.shift();
          verdicts.push({
            t: +liveSeconds.toFixed(2),
            rung: index,
            call,
            beforeMs: +wallBefore.toFixed(1),
            afterMs: +after.toFixed(1),
            gain: +gain.toFixed(3),
            bar: +bar.toFixed(3),
            samples: wallCount,
          });
          if ((call === 'futile' || call === 'worse') && futile >= FUTILE_LIMIT && index > 0) {
            // Two cuts in a row that changed nothing, or one that made things
            // worse. Whatever is holding this machine up is not on this ladder,
            // so put the last one back and stop spending the game's looks on it.
            stalled = true;
            stalledAt = wallMean;
            futile = 0;
            applyRung(index - 1, call === 'worse'
              ? 'stalled (that drop cost more than it bought)'
              : 'stalled (drops buy nothing)');
            return;
          }
        } else if (verdictFrames >= VERDICT_ABANDON_FRAMES) {
          // Twenty-five delivered frames and the window still has not taken
          // fourteen: frames are being *discarded* faster than they arrive,
          // because seventeen delivered frames fill it by definition. Drop the
          // verdict rather than take it on what is left — an abandoned verdict
          // unblocks the ladder and changes nothing about what the governor
          // believes. Counted in frames precisely so that a slow machine is not
          // the thing that trips it; see `VERDICT_ABANDON_FRAMES`.
          abandonVerdict();
        }
      }

      // Conditions changed enough that the earlier verdict is stale.
      if (stalled && wallMean > stalledAt * RETRY_FACTOR) {
        stalled = false;
        futile = 0;
      }

      // ── the emergency path ───────────────────────────────────────────────
      //
      // Above the warm-up gate and above the settle, because those exist to
      // stop the governor acting on thin evidence and a machine delivering
      // twenty-seven frames a second is not thin evidence. It still needs a
      // fresh window — `PANIC_SAMPLES` frames since the last change emptied it,
      // and `SKIP_FRAMES` of reallocation discarded before those — and a short
      // dwell on top, so no single stalled frame can walk the ladder.
      //
      // It cannot outrun the futility check above it: a panic drop sets
      // `verdictPending`, and `stalled` (which the check may set) clears
      // `canDrop`, so the ladder can be stopped from below even on a machine
      // that is panicking every frame.
      const panic = wallMean > TARGET_MS * PANIC_FACTOR;
      // Behind the front-end the ladder stops at `FRONT_END_FLOOR`: the
      // evidence there is about a frame this file only half owns, and it buys
      // the top of the ladder rather than the whole of it.
      const bottom = frontEndOpen ? FRONT_END_FLOOR : LADDER.length - 1;
      const canDrop = index < bottom && !stalled && !verdictPending;
      if (panic && canDrop && liveSeconds >= PANIC_ARM_S
        && settleFor >= PANIC_SETTLE && settleFrames >= PANIC_SETTLE_FRAMES) {
        // **The line the last three rounds were about.** The emergency path may
        // skip the curvature lookahead — at two frames a second there is no
        // such thing as between corners — but it does not get to change the
        // picture while the game is showing one, and "showing one" now includes
        // the front-end and the pause screen, which `race.phase` cannot report.
        // The dwell restarts rather than banking, so the drop lands a beat into
        // the racing rather than on the frame the gate opens.
        //
        // Every one of those refusals is now a *wait* rather than a wall — see
        // `pictureLocked` — so this branch can no longer hold a failing machine
        // for the fifty seconds of front-end and fifty-six of countdown that
        // one measured session spent inside it.
        if (pictureLocked()) {
          panicFor = 0;
          panicFrames = 0;
          return hold(frontEndOpen ? 'front-end' : paused ? 'paused' : 'mid-ceremony');
        }
        panicFor += secs;
        panicFrames += frameTick;
        if (panicFor >= PANIC_DWELL && panicFrames >= PANIC_DWELL_FRAMES) {
          markDrop();
          // ── one change, not three ──────────────────────────────────────
          //
          // Sized from how far over budget the machine actually is and clamped
          // to whatever floor this scene is allowed to reach, so a machine
          // forty times too slow spends one pop getting most of the way down
          // instead of three getting a third of the way. See `RUNG_GAIN`.
          let step = 1;
          if (wallMean > 0) {
            const over = wallMean / (TARGET_MS * DOWN_FACTOR);
            if (over > 1) {
              const n = Math.round(Math.log(over) / Math.log(RUNG_GAIN));
              step = n < 1 ? 1 : n > PANIC_MAX_STEP ? PANIC_MAX_STEP : n;
            }
          }
          let want = index + step;
          if (want > bottom) want = bottom;
          // Which gate gave way, on the log line, rather than leaving a
          // reviewer to work out why `frontEnd: true` or `phase: 'countdown'`
          // is not the failure it used to be. `heldFor` on the same entry is
          // how long it had held out, and the multiplier is how many rungs one
          // change is worth — a log line reading `x3` is three pops the player
          // did not see.
          const many = want - index > 1 ? ` x${want - index}` : '';
          applyRung(want,
            frontEndCovers ? `dropped (panic, behind the menu)${many}`
              : isComposed(ctx.race?.phase) ? `dropped (panic, ceremony overran)${many}`
                : `dropped (panic)${many}`);
          return;
        }
        return hold('panic');
      }
      panicFor = 0;
      panicFrames = 0;
      if (panic && verdictPending) return hold('panic (judging last cut)');
      // The front-end has spent everything it is allowed to spend. Say which
      // wall this is rather than leaving `panic` on a governor that has stopped
      // panicking — the rest is the race's to earn. See `FRONT_END_FLOOR`.
      if (panic && frontEndOpen && index >= FRONT_END_FLOOR) {
        return hold('front-end (floor)');
      }

      if (wallCount < MIN_SAMPLES) return hold('warming');
      if (liveSeconds < WARMUP_S) return hold('warming');
      if (settleFor < SETTLE || settleFrames < SETTLE_FRAMES) return hold('settling');

      // ── the ordinary verdict ─────────────────────────────────────────────
      const over = wallMean > TARGET_MS * DOWN_FACTOR || lateFrac > DOWN_LATE_FRAC;
      const under = wallMean < TARGET_MS * UP_FACTOR
        && lateFrac < 0.03
        && workMean < UP_WORK_MS
        && b.worstMs < UP_WORST_MS;

      if (over) {
        overFor += secs;
        overFrames += frameTick;
        underFor = 0;
        underFrames = 0;
      } else if (under) {
        underFor += secs;
        underFrames += frameTick;
        overFor = 0;
        overFrames = 0;
      } else {
        overFor = 0;
        underFor = 0;
        overFrames = 0;
        underFrames = 0;
        return hold('in band');
      }

      // `!verdictPending` on the way down: a cut that has not been judged yet
      // is a cut whose `wallBefore` a second cut would overwrite, and the pair
      // would then be scored against each other instead of against the frame
      // they were both meant to improve. One cut at a time, judged, then the
      // next. Climbing is unaffected — a climb clears the pending verdict
      // because the thing it was judging has been undone.
      const wantDown = overFor >= DOWN_DWELL && overFrames >= DOWN_DWELL_FRAMES
        && index < LADDER.length - 1 && !stalled && !verdictPending;
      const wantUp = underFor >= UP_DWELL && index > 0;
      if (!wantDown && !wantUp) {
        return hold(over
          ? (stalled ? 'over budget (stalled)'
            : verdictPending ? 'over budget (judging last cut)' : 'over budget')
          : 'under budget');
      }
      // Three refusals rather than one, because they are three different facts
      // and a probe that reports `mid-corner` over a title screen is lying
      // about which gate stopped it. `onAStraight()` asks the same questions
      // again on its own account — see the note on it.
      if (frontEndOpen) return hold('front-end');
      if (paused) return hold('paused');
      if (pictureLocked()) return hold('mid-ceremony');
      if (!onAStraight()) return hold('mid-corner');
      if (wantDown) {
        markDrop();
        applyRung(index + 1, 'dropped');
      } else {
        verdictPending = false;
        applyRung(index - 1, 'raised');
      }
    },

    dispose(): void {
      offVisibility?.();
      offVisibility = null;
      // Hand the frame back whole. Everything the content pass does is a
      // switch it holds down, so a governor that goes away without letting go
      // would leave the game running for ever on the last rung's crowd.
      applyContent(FULL_CONTENT);
      contentFrame();
      clearShells();
      crowdGeos.length = 0;
      scatter.length = 0;
      cullables.length = 0;
      censusFor = '';
      // Hand the draw back on the way out. This file is the only thing that
      // ever sets `skipDraw`, so a governor that is disposed while the
      // front-end happens to be up would otherwise leave the engine refusing to
      // draw with nobody left to change its mind.
      if (ctx.budget) ctx.budget.skipDraw = false;
      stageEl = null;
      delete (globalThis as unknown as Record<string, unknown>).__QUALITY;
    },
  };
}

/** An owned `SplineSample`, so nothing here writes into a shared scratch. */
function blankSample(ctx: GameContext): SplineSample {
  const T = ctx.THREE;
  return {
    pos: new T.Vector3(), tangent: new T.Vector3(),
    right: new T.Vector3(), up: new T.Vector3(),
    width: 0, bank: 0, curvature: 0, distance: 0, t: 0, index: 0,
  };
}
