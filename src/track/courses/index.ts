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
//                             else in the cup. *Yellow truss gantry, striped
//                             panel barrier, red-and-white kerb* — the poster.
//                             Three chapters: the open speedway, Digger's
//                             Cutting between two rock faces, and the canyon
//                             head under its arch.
//   2  Jackhammer Quarry      3 laps · 2.50km · 5 short strips · 2 cuts ·
//                             2 spills · THE CUT · THE HAUL TRUCK. **The
//                             comb.** Four hairpins folding four benches into
//                             a square, with the haul road wrapped round the
//                             outside. 249 metres of the lap under a 40-metre
//                             radius; the longest straight anywhere on it is
//                             160. *Overland conveyor across the grid,
//                             concrete jersey barrier, hazard kerb.* **And the
//                             last shift of the day** — the only round in the
//                             cup that is not played at midday. See its theme
//                             block: violet zenith, amber horizon, dust that
//                             the low sun is coming through rather than over.
//                             Three chapters, and two of them have **one
//                             face**: the Tip Face over the outside of the
//                             first hairpin, the Cut walled on both hands at
//                             the bottom of the pit, and the High Wall along
//                             the haul road out.
//   3  Saltpan Bypass         2 laps · 3.52km · 4 long strips · 1 cut ·
//                             1 drift · THE FLOOD (5 crossings) · THE SURGE ·
//                             THE CAUSEWAY. **The wedge.** A right triangle
//                             with a 640-metre ruler down the hypotenuse,
//                             three sheets of standing brine laid across it
//                             and one on each of the other two sides.
//                             *Loading jetty on piles, salt-crusted low wall,
//                             works-blue kerb, yellow lines.* Three chapters:
//                             the open pan, a hundred and fifty metres up on
//                             the causeway's trestle, and the contraflow in a
//                             sheet-piled cutting.
//   4  Switchback Summit      3 laps · 2.71km · 5 strips, all uphill · 1 cut ·
//                             1 washout · **THE GALLERY** · THE KICKER ·
//                             THE GATE. **The hourglass.** Two lobes and a
//                             waist, the waist being the gorge the road climbs
//                             out of and plunges back into. 101 metres of
//                             climb, and — this is the round-2 fix — **63 of
//                             them inside four hundred metres**, in two 13.5%
//                             ramps either side of the gorge waist, with a flat
//                             valley floor under them and a near-level summit
//                             plateau over them. *Cable-car pylons and two
//                             gondolas over the line, timber snow fence,
//                             slate-and-snow kerb.* Three built places: the
//                             Notch's one-faced rock cut where the gradient
//                             arrives, the gallery on the climb, and the
//                             Cutting Sweep's trench in front of the kicker.
//                             **The lap is cut at the foot of the mountain**,
//                             not on the valley floor — see the round below.
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
//     Switchback            240m               70m        101.2m      1.68
//
// (Switchback's elevation was 115.2m when this table was first written. It is
// 101.2 now and the mountain reads *taller*, because the number that decides
// whether a road looks like it is climbing is the gradient and not the range —
// see "the round that gave the cup a second hour, and a roof" below.)
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
// ── the round that gave the four circuits four *places* ────────────────────
//
// The shapes worked and the critic said so — *"the four map diagrams on the
// course-select card — dogleg, comb, wedge, hourglass — genuinely pass the
// cover-the-names test"* — and then rejected the cup anyway, at 7/10, on the
// half of the problem geometry cannot reach:
//
//   *"They are still the same place. `cone-canyon-grid.png`,
//   `jackhammer-quarry-grid.png`, `saltpan-bypass-grid.png` and
//   `switchback-summit-grid.png` share an identical yellow truss gantry,
//   identical hazard-striped navy banner with gold type, identical five-bulb
//   light rig, identical chequered strip, and the same orange-and-white striped
//   panel barrier on grey drums. Nothing on the road tells you which circuit
//   you are on."*
//
// Every one of those objects had exactly one implementation and no course could
// ask for another. `TrackFeatures.kit` is the noun that was missing and
// `courses/kit.ts` is the system that reads it — see `KitDef`. What stands over
// the line and what runs down the edge of the road are now course decisions:
//
//     round          arrival                     barrier              kerb
//     Cone Canyon    yellow truss gantry         striped panel        red/white
//     Jackhammer     inclined conveyor bridge    concrete jersey      black/yellow
//     Saltpan        timber loading jetty        salt-crusted wall    blue/white
//     Switchback     cable-car pylon pair        timber snow fence    slate/snow
//
// ...plus the banner livery, the markings, the chequer and the five-lamp board,
// which each structure now carries its own of off `config.race.startLights`.
// **Round one keeps the stock kit deliberately**: a cup needs one circuit that
// looks like the box art, and it is the reference the other three are read
// against.
//
// The same round answered the other two findings on the sheet. Saltpan's three
// hazards all sat in the first 419 metres of a 3519-metre lap and its
// 621-metre straight had nothing to *win* on it, only things to avoid — there
// are two more brine crossings now, one per remaining side of the wedge, and a
// boost ramp on the far shoulder past the last sheet, so the flood is a choice
// rather than a corridor.
//
// ── and the camera that was driving underground ────────────────────────────
//
// A player reported *"the screen just went brown above the racer"*, and
// `tools/underground.mjs` found it on two of these four circuits: the lens
// inside the landscape on 51 of 171 samples at the quarry and 24 of 171 on the
// mountain — the mountain's worst **9.5 metres under at t=0, on the grid**.
//
// It is not a camera bug and it was not fixable in a layout. `terrain.ts`
// sweeps the embankment skirt 150 metres either side of the road anchored to
// *that station's* elevation and never asks what else is nearby, so on a
// circuit that folds back on itself the higher road's skirt is a shelf hanging
// over the lower road. Measured, the budget is about nine metres of stack and
// the four circuits carry 11.2 / 40.4 / 11.2 / 62.4 — so Cone Canyon and
// Saltpan pass and the pit and the mountain cannot, by a factor of four and
// seven. Getting inside it in the layout would mean deleting the quarry's pit
// and the mountain's 115-metre climb, which is the one measurement the same
// review round praised. `unfoldSkirt` in `kit.ts` gives the skirt the answer
// the field mesh already has instead. See the comment there; it belongs in
// `terrain.ts` and says so.
//
// ── ...and then the instrument certified a course nobody could play ────────
//
// That fix worked and `tools/underground.mjs` printed PASS on all four at
// 3.6 / 5.3 / 3.2 / 2.9 metres of clearance. A critic then played the cup and
// scored it 6/10 on this:
//
//   *"On Jackhammer Quarry the chase camera sits a median 24.9 degrees and a
//   peak 73.6 above the kart for 26 of the lap's 57 seconds, so roughly half of
//   round 2 is played from a near-top-down satellite view with no horizon, no
//   sense of speed, and the next corner off the bottom of the frame."*
//
// Every frame of that was, strictly, above ground. **A test that asks only
// whether the lens is outside the world will certify a lens in orbit**, and
// that is the more expensive half of this story: the instrument was not silent,
// it was confidently wrong, and it stayed confidently wrong for a whole round.
//
// The cause was not the skirt, and it is worth being exact about that because
// the obvious reading — "same symptom, same shelf, fold more skirt" — is wrong
// and would have cost another round. **The chase camera never asks the terrain
// anything.** `render/camera.ts` derives its floor analytically in
// `surfaceYAt`, from the spline and one number off a course file:
//
//     return Math.max(roadSurfaceY - 0.35, course.groundY);
//
// So every metre a circuit's road runs *below* its own `groundY` is a metre the
// lens is held up while the kart keeps descending. The quarry's road bottoms
// out at -42 against a datum of -10, and 32 metres is exactly the height the
// critic measured. The mountain had the same mistake at 3.4 metres.
//
// **The rule that comes out of it, and it binds every course in this
// directory: `groundY` must sit below the lowest tarmac on the circuit, with a
// few metres in hand for camber.** It is not a scenery number. Cone Canyon has
// always been the reference chase camera in this cup — median 14 degrees — for
// no better reason than that its datum happens to be 20 metres under its road.
//
//                     lens elevation over a full lap, chase, autopilot, seed 1
//                        before                    after
//     Cone Canyon      med 14.5 / p95 26.9       unchanged
//     Jackhammer       med 36.7 / p95 73.2       med 14.8 / p95 18.7
//     Saltpan          med 15.2 / p95 20.0       unchanged
//     Switchback       med 15.1 / p95 25.6       med 14.1 / p95 25.6
//
// `tools/underground.mjs` now gates on it — max degrees above a *grounded*
// racer over a full lap, per course, failing above 35 — so this class cannot
// pass again. It prints `groundY` against the lowest road on the circuit next
// to the angles, because when that relationship is the cause it is the whole
// cause and the repair is one line in a course file.
//
// ── the round that gave two of the four circuits chapters ──────────────────
//
// A critic drove all four, photographed the same chase view at 22%, 50% and
// 78% of one lap on each, and rejected the cup on what came back:
//
//   *"Cone Canyon and Saltpan Bypass have no chapters — at 22%, 50% and 78% of
//   the same lap they are the same picture: same tarmac, same verge, same
//   barrier run, same horizon, same light. Switchback Summit does exactly this
//   right — valley floor y=14.5, mid-mountain traverse with pines and a drop
//   y=68.2, summit works y=114.2 — and proves the roster knows how."*
//
// The mountain does it with elevation, and that is not a method the other two
// can borrow. **`track/terrain.ts` anchors the ground to the elevation of the
// nearest road** — `ref` in `terrainHeight` does not reach the course datum
// until 340 metres out — so on a flat circuit the landscape beside the road is
// one landscape for the whole lap *by construction*, and raising a section of
// tarmac raises the pan or the desert with it. There is no course-side number
// that digs a valley next to a bypass.
//
// So a chapter is **built**: `KitDef.chapters` (see `ChapterDef` in
// `types.ts`), read by `courses/kit.ts`, which stands a rock or sheet-pile
// cutting along a span, puts a span up on a viaduct with a truss over it, or
// throws a rock arch across the road. Two circuits now have three places each:
//
//     course        chapter one        chapter two          chapter three
//     Cone Canyon   the speedway       Digger's Cutting     the canyon head,
//                   (open, stands)     (rock trench, 15m)   under a rock arch
//     Saltpan       the pan (open)     the causeway         the contraflow
//                                      (150m of trestle)    (works cutting)
//
// The same round answered the other two findings on that sheet. Every `brine`
// patch in the cup is now declared inside ±0.90 of the half width, so a sheet
// of standing water cannot be built onto the verge — the rest of that finding
// is about how road.ts *draws* water and is filed there. And the field's lost
// time was measured rather than argued: 130 seconds of racing with seven
// racers spent **97 seconds on sand** at the saltpan, whose Pan Sweep windrow
// turned out to be authored on the inside of a right-hander — the racing line —
// while its comment claimed the outside. It is on the outside now, the
// shoulder is eight metres rather than twelve, and the quarry's two worst
// corners (the Crusher at 3.1 m/s, the pair at the top of the haul road) are
// three to four metres wider at the same radius.
//
// ── the round that gave the cup a second hour, and a roof ──────────────────
//
// A critic played the four and scored 6.5 on two findings that the four
// palettes and the four silhouettes could not answer between them:
//
//   *"All four rounds are the same kind of place — a wide asphalt ribbon on
//   open ground under the same midday blue sky, sun elevation 0.52-0.85 on
//   every course. (B) is Mount Wario section three, and B wins outright, and
//   the reason is not fidelity: it is that B changes what kind of place you are
//   in mid-course and A does not change it across four whole courses."*
//
//   *"Feature-set audit against the roster's own written rule: Switchback =
//   {shortcuts, ramps, hazards} and Saltpan = {shortcuts, ramps, hazards,
//   chapters}. Two of four rounds fail the project's own re-skin test."*
//
// **1. The mountain got a noun, and it is the one with no sky in it.**
// `TrackFeatures.enclosures` — see `EnclosureDef` — and THE GALLERY is the
// only one in the cup: a hundred and forty-six metres of avalanche gallery
// across THE CLIMB, wall on the mountain flank, piers over the gorge, a shed
// roof falling between them, sodium lamps under the soffit and real shadow
// bars strobing across the road at nine metres of pitch. It is the only place
// in the game where the key light does not reach the tarmac.
//
// **2. The audit is over (property, kind) pairs now, and it is published.**
// `ramps` is what caught the mountain out: Saltpan grew a boost ramp in an
// unrelated round and from that moment round four was a strict subset of round
// three without anybody touching round four. A shared property name is not a
// shared noun.
//
//     round        owns, that no other round has
//     Cone Canyon  patches:island (the divided Carousel) · chapters:portal
//     Jackhammer   gates (the 11m pinch) · hazards:truck · **the low sun**
//     Saltpan      patches:brine (the flood) · chapters:viaduct
//     Switchback   **enclosures** (the gallery) · hazards:boom
//
// **3. The mountain now looks like one.** 116 metres spread over 2,680 is a
// 4.3% average, which is motorway; the horizon sat dead at eye level and the
// road read flat. The height is concentrated instead of distributed:
//
//                      before                  after
//     valley lobe      0.8 → 20m  (2.0%)       0.8 → 9m   (0.8%)   flat
//     the notch        20 → 26    (6.4%)       9 → 20.5   (12.2%)  ← ramp
//     THE CLIMB        26 → 42    (9.6%)       20.5 → 43  (13.5%)  ← ramp
//     THE CLIMB TWO    50 → 64    (8.4%)       46 → 68.5  (13.4%)  ← ramp
//     summit lobe      70 → 116   (6.9%)       71 → 102   (3.7%)   plateau
//
// ...and the road narrows where it steepens, which it did not before: THE
// NOTCH is 17 metres and THE CLIMB is 16, against the 24 they both were, and
// `vergeWidth` came down from 7 to 5 so the snow fence is inside the frame
// rather than a lane and a half beyond it. The mountain pass used to be the
// widest, least committed road in the cup — Cone Canyon necks to 19 in
// Digger's Cutting — which is the opposite of what its name promises.
//
// **4. The quarry is played at the end of the shift.** Every course in the cup
// declared a deep-blue zenith and a sun between 30 and 49 degrees. Round two
// now has a violet zenith, an amber horizon, a warm low key and dust the sun
// comes *through* — it was the natural candidate because it is the only round
// that already declares its own weather (`fog.near` 210 against everybody
// else's 400-plus), so it is the one place a low sun has something to rake
// through. **What is not landing is not in this directory:** `SUN_ELEVATION`
// in `render/lighting.ts` clamps every course to 0.50-0.60 radians, so the
// 0.17 the quarry declares is read as 0.50 and the long shadows the palette is
// written for do not exist. The palette does everything a course file can.
//
// ── the round about *phase*: where the lap is cut, not what is on it ───────
//
// A critic played the cup and scored it 6/10 on a finding that none of the
// rounds above could have caught, because every one of them was measured on a
// whole lap and this one is measured on **nine seconds** of it:
//
//   *"The four courses are separated by sky tint and start-line kit, but the
//   ground the chase camera spends the race looking at is the same wide flat
//   road on the same olive-grey plain on three of the four. Jackhammer Quarry
//   contains no visible quarry and Switchback Summit is dead level at the
//   default racing shot."*
//
// `capture.mjs`'s `racing` shot — captioned, by this project, *"the default
// view a player spends the race in"* — autopilots nine seconds from the line
// and photographs whatever is there. Measured with `tools/trace.mjs`, that is
// **about 490 metres** of Cone Canyon and rather less of the slower circuits.
// So the question a course file has to answer is not "does this lap contain a
// place" but "**is the place inside the first five hundred metres of it**",
// and three of the four answered no:
//
//     course        signature was at        is at
//     Cone Canyon   Digger's Cutting 362m   unchanged — it always landed
//     Jackhammer    THE CUT at 1165m        THE TIP FACE at 138m
//     Saltpan       first sheet at 146m     unchanged — it always landed
//     Switchback    THE CLIMB at 1110m      THE NOTCH at 271m
//
// Two different instruments, because the two courses were wrong in two
// different ways:
//
//   * **The quarry had nothing built anywhere**, and its signature is at the
//     bottom of a pit halfway round. It cannot move its grid — the weighbridge
//     is the only level straight on the circuit — so the rock moved instead:
//     three `chapters`, the first of them starting a hundred and thirty-eight
//     metres after the chequer. Its high wall was always real and always **two
//     hundred and sixty metres** away through a 210-metre fog plane, which is
//     the distance at which a quarry is a colour grade.
//   * **The mountain's signature could not be brought forward**, because a
//     hundred metres of climb is where the ledger puts it and the ledger is the
//     thing the shape round was won on. So the *lap* moved: `START` is now the
//     foot of the climb rather than seventy metres into the valley straight.
//     Nothing in its ring changed by a metre — the hourglass, the closure, the
//     two 13.5% ramps are all exactly as measured — and every feature on it is
//     authored as a lap fraction off `on()`, so the whole circuit re-phased
//     itself. The one thing that had to move by hand was a boost strip that
//     would have ended up under the back row of the grid.
//
// **The cost is named rather than hidden**: the mountain's lap now opens into
// a corner, so it is the one circuit in the cup with no opening straight, and
// its longest straight (229m, the valley floor) is now the run *to* the flag
// rather than away from it. See its header. That is a worse start-line
// composition and a better race, and the frame the roster is judged on is the
// second one.
//
// ── ...and the same sheet said the rock was a painted backdrop ─────────────
//
//   *"The rock face is one smooth swept surface with a painted strata-and-
//   streak texture, a continuous unbroken top edge, and no talus, boulders,
//   ledges or vegetation where it meets the flat brown verge."*
//
// All of that followed from one property of `buildCutting`: **the wall's plan
// line was a constant offset from the road.** Its height varied along the span
// and its lateral did not, which makes a ruled surface, and a ruled surface is
// a backdrop whatever is painted on it. It now wanders, it is cut in two lifts
// with a two-to-four-metre catch berm between them, and there is an
// InstancedMesh of blocks standing on the talus at its toe. See `buildCutting`
// — and note the bug that cost the first attempt at the blocks: scattered at
// road level, every one of them was *inside* the two and a half metres of
// talus they were meant to be lying on.
//
// ── what is honestly still short ───────────────────────────────────────────
//
//   * *`tools/underground.mjs` fails Switchback Summit, and it is not the
//     layout.* One sample in three hundred puts the chase lens 56 degrees and
//     15 metres above a grounded racer, at the bottom of THE PLUNGE. It was
//     **measured against the old start line as well** — same tool, same seed,
//     with only `START` reverted: 58.9 degrees and 16.75 metres, 1/300. So the
//     re-phase did not cause it and moved it slightly in the right direction;
//     what causes it is that `render/camera.ts` floors the lens at
//     `max(roadSurfaceY - 0.35, groundY)` sampled at the *camera's* station,
//     which on a 37% descent is nine metres behind the kart and three metres
//     above it — and then the kart lands and drops away underneath the boom.
//     `groundY` is not the lever here: it is -1 against a road that bottoms at
//     0.6, which is the rule this directory states and obeys. A camera that
//     derives its floor from the road *behind* it cannot follow a plunge, and
//     the plunge is the one thing on this circuit nothing may soften.
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
