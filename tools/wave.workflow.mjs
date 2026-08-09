export const meta = {
  name: 'mario-cone-wave',
  description: 'Build and adversarially review a wave of MARIO.CONE pieces',
  whenToUse: 'Any build wave after the first. Pass {pieces:[ids], rounds:N} as args.',
  phases: [
    { title: 'Build', detail: 'one owner agent per piece, strict file ownership' },
    { title: 'Judge', detail: 'fresh critic plays the real game and compares against Mario Kart 8' },
  ],
};

const REPO = '/home/user/mario.cone';

const COMMON = `
You are working in the repo at ${REPO} — a Mario Kart-class racing game in
TypeScript + Three.js called MARIO.CONE. The racers are roadworks machines: a
road cone, a plane, a helicopter, a digger, a train, a truck and a car.

BEFORE YOU DO ANYTHING: read ${REPO}/ARCHITECTURE.md in full — it is the contract
between the many agents working here in parallel — then ${REPO}/src/types.ts,
which encodes that contract as real types.

Where the project is: the engine, track, physics, camera, art direction and the
seven vehicle models are built and have been through critic rounds. The game
runs: eight racers, drift with three mini-turbo tiers, lap and position
tracking, a nine-corner circuit with boost pads and a shortcut.

Hard rules:
- The quality bar is Nintendo first-party. Not "good for a web game". If a
  Nintendo art director would flag it, it is not done.
- STRICT FILE OWNERSHIP. Only edit the files in your brief. Other agents are
  editing other files right now. Touching a file you do not own gets reverted
  and wastes the round. Need a change elsewhere? Say so in your report.
- Deterministic simulation: gameplay in fixedUpdate at constant dt, never
  Math.random (use ctx.rng), never a wall-clock read. Visuals go in update.
- \`alpha\` passed to update() is a 0..1 blend. Feed it to lerp, nothing else.
- Never break window.__GAME (src/core/harness.ts) — every reviewer drives the
  game through it, so breaking it makes your work unjudgeable.
- No network at runtime, no asset files. Everything procedural.
- Nothing may allocate per frame in a hot path. Reuse scratch vectors.

Before you finish you MUST run, from ${REPO}:
    npm run typecheck                  (must be clean)
    node tools/capture.mjs --smoke     (must pass)
Both take a few minutes under software GL. Run them in the background and poll;
do not assume they have hung.

Seeing the real game:
    node tools/capture.mjs                        full review sheet -> shots/
    node tools/capture.mjs --only drift,boost --out /tmp/x
    node tools/capture.mjs --list
    node tools/trace.mjs --seconds 20 --fields speed,lap,progress,place
    node tools/trace.mjs --manual --accel 1 --steer 0.6 --drift
LOOK at the PNGs with the Read tool. Never reason about what the code probably
renders — look at it.
`;

const PIECES = {
  items: {
    name: 'Items',
    owns: 'src/items/** (new module), plus adding your events to the table in ARCHITECTURE.md §7',
    shots: 'racing,pack,drift,boost',
    brief: `
Own the item system. It does not exist yet — this is the single biggest missing
piece of the game, and without it this is a time trial, not a kart racer.

Build:
- Item boxes on the course: floating, rotating, iridescent, with a respawn
  timer. They need to be placed on the racing line where taking them costs
  nothing and off it where they are a real detour.
- The roulette: a visible cycling reel that settles. Distribution must be
  position-weighted the way MK8 is — the leader gets coins and bananas, last
  place gets the good stuff. That weighting IS the game's comeback mechanic.
- The items themselves, each with real behaviour, a model, and a hit reaction:
  banana (dropped or thrown), green shell (bounces off walls), red shell
  (homes along the spline to the racer ahead), triple variants that orbit the
  kart, mushroom (instant boost), triple mushroom, star (invulnerable, faster,
  knocks others aside), bullet bill (auto-drives the racing line at speed),
  lightning (shrinks the field), blooper (ink on rivals' screens), boo (steals),
  bomb, coin, horn.
- Coins on the track: +1 top speed each up to ten, dropped when you are hit.
  Physics already reads racer.coins — it is never incremented by anything.
- Getting hit must be readable and fair: spin-out, squish, or knockback, with
  invulnerability after, and it must be obvious what hit you.

Use ctx.rng for every random draw, never Math.random. Fire events on the bus
(item:get, item:use, kart:hit, coin:get are already in the contract) so the
audio, HUD and fx modules can hang off them without touching your files.

physics/kart.ts already exports boostRacer() and stunRacer() — use them rather
than reaching into racer state yourself.`,
  },

  fx: {
    name: 'Effects & spectacle',
    owns: 'src/fx/** (new module)',
    shots: 'drift,boost,racing,pack,offroad',
    brief: `
Own the particle and effects layer. It does not exist yet. Right now a drift
looks identical to driving straight, and a boost looks like the numbers went up.

Build, and wire to the events already on the bus:
- Drift sparks. The single most important effect in the game: they must appear
  the moment a drift charges, and change colour at each mini-turbo tier
  (blue -> orange -> purple). A player reads their charge level entirely from
  these. Listen for kart:drift:start and kart:drift:charge.
- Boost: flame plume, speed lines, a screen-edge rush, dust kicked up behind.
  Listen for kart:boost. A boost has to be unmistakable with the sound off.
- Surface response: dust colour and volume from racer.surface, so dirt throws
  tan dust and tarmac throws almost none. Tyre marks that persist and fade.
- Landing impacts, wall scrapes, kart-to-kart bumps, spin-out stars.
- Race moments: countdown flashes, the finish-line confetti burst.

Everything must be instanced or pooled — no per-frame allocation, no one draw
call per particle. Respect ctx.quality.particles (0..1) as a density scale.

Install yourself as ctx.fx implementing the FxSystem interface in types.ts
(spawn/shake/flash) so other modules can trigger effects without importing you.`,
  },

  hud: {
    name: 'HUD & minimap',
    owns: 'src/ui/** ',
    shots: 'racing,countdown,pack,boost',
    brief: `
Own the HUD. It currently shows lap, position, time, coins and speed as plain
text in four corners — functional, and nothing like a Nintendo HUD.

Build:
- An item slot with the roulette animation, in the place a player's eye goes.
  Coordinate with the items module through bus events; do not edit their files.
- A minimap: the course outline from the track spline, with a blip per racer
  coloured from VehicleDef.colors, the player's blip distinct.
- Position, lap and coins as designed graphic elements, with motion. Position
  must animate when it changes — a silent number swap is a wasted moment.
- A lap-time banner on each lap, and a final-lap alert that actually lands.
- Coin, boost and hit feedback: the HUD should react to being hit.
- It must stay readable over both bright sky and dark asphalt, and it must
  scale to a phone-sized viewport without overlapping.

The HUD reads state, never writes it. Everything comes from ctx.race, ctx.player
and bus events.`,
  },

  ai: {
    name: 'CPU racers',
    owns: 'src/ai/**',
    shots: 'pack,racing,overhead',
    brief: `
Own the CPU drivers. They currently follow a lookahead point with a crude apex
bias, brake for curvature and drift occasionally.

What is missing:
- They must use items, and use them plausibly: hold a shell when someone is
  close behind, fire forward when someone is just ahead, save a mushroom for a
  shortcut or a corner exit.
- They must react to the world: dodge a banana, avoid a spinning rival, take
  the shortcut when it pays, hit the boost pads.
- They must feel like different drivers, not one driver with noise. Give them
  aggression, consistency and cornering style, and let those show.
- The pack must string out and re-converge rather than travelling as one lump —
  watch the pack capture, the field currently bunches badly.
- Rubber-banding must stay invisible. If a player can see it, it is too strong.

They produce the same input struct a human does and hand it to the same physics.
Keep it that way — an AI that cheats hides bad handling.`,
  },

  audio: {
    name: 'Music & sound',
    owns: 'src/audio/** (new module)',
    shots: 'racing',
    brief: `
Own all sound. There is none. Everything must be synthesized with the WebAudio
API — no audio files, the game ships as one self-contained bundle.

Build:
- Engine sound per vehicle, pitched to speed and load, and genuinely different
  per machine: the train chuffs, the helicopter thumps, the plane drones, the
  cone is a little buzzing motor.
- Drift: the scrub, and a charge tone that rises through each mini-turbo tier
  so a player can hear their charge without looking.
- Impacts, item pickups and uses, coins, boost, countdown, lap, finish.
- Music: a real loop, upbeat and in the roadworks spirit, that ducks under
  effects and lifts on the final lap.
- Positional audio for rivals, so you can hear a shell coming.

Install as ctx.audio implementing the AudioSystem interface in types.ts. Browsers
block audio before a user gesture — unlock on first input and never throw if
audio is unavailable, since the capture harness runs with no audio device.`,
  },

  flow: {
    name: 'Race flow & results',
    owns: 'src/race/**',
    shots: 'countdown,grid,racing',
    brief: `
Own everything around the race rather than in it. The director counts laps and
positions correctly, and that is all it does — the race currently starts without
ceremony and ends without acknowledgement.

Build:
- A start sequence worth watching: the grid forming, a camera sweep, the lights,
  the rocket-start window, and a GO! that lands.
- Real grid positions. Every racer currently sits at place 1 through the
  countdown, which the HUD critic caught firing four false lost-a-place alarms
  in the first two seconds. Assign actual starting places in reset().
- Finishing: crossing the line should be an event — slow-mo, a camera change, a
  banner, the CPU field finishing behind you one by one.
- A results screen: finishing order with times and gaps, points awarded, the
  cup standings table, and a way to race again.
- Lap times, best lap, and a final-lap state the whole game reacts to.
- Pause, and a way out of a race.

You own the race director and the results UI under src/race. Coordinate with ui
through bus events rather than editing their files.`,
  },

  menus: {
    name: 'Front-end & menus',
    owns: 'src/ui/menus/** (new), and one engine.add line in src/main.ts',
    shots: 'grid',
    brief: `
Own everything before the race. There is no front-end at all: the game boots
straight into a race on a fixed course with a fixed vehicle.

Build:
- A title screen with real presence — the game's name, the cast, motion,
  something happening behind the logo.
- Character select: all seven machines with their stat bars, blurbs, a rotating
  preview and a sound. Picking a racer is the first thing a player does and it
  should feel good.
- Course select, engine class (50/100/150/200cc), and cup selection.
- Transitions between every screen that feel authored rather than instant.
- The whole thing has to be navigable by keyboard and by gamepad, and it must
  drive the existing startRace() rather than reimplementing it.

Look at how the HUD does its plates and units (src/ui/theme.ts) and stay
consistent with it — this is the same product.`,
  },

  courses: {
    name: 'Course roster',
    owns: 'src/track/courses/**',
    shots: 'overhead,racing,far',
    brief: `
Own the circuit roster. There is exactly one course. A kart racer needs a cup.

Build three more, each with a distinct theme, silhouette and problem:
- They must look nothing like each other from the overhead shot.
- Each needs its own theme block — sky, sun, fog, ground, and the props hooks
  the world module reads.
- Each needs a signature: a genuinely memorable corner or set piece.
- Vary the shape: something tighter and more technical than Cone Canyon,
  something faster and more open, something with real elevation.
- Follow the two rules Cone Canyon is held to: width follows speed, and nothing
  is dead straight for longer than the run to the first corner.

Use the same waypoint authoring path (loopFromWaypoints) so banking is derived
rather than hand-tuned. Register them in courses/index.ts. Verify each one is
drivable by running the capture harness against it — a course the AI cannot get
around is not a course.`,
  },

  world: {
    name: 'World dressing',
    owns: 'src/world/** (new module)',
    shots: 'racing,far,overhead,grid,pack',
    brief: `
Own everything beside the track. The canyon terrain and buttes exist; the world
between them and the road is empty.

Build:
- Roadworks set dressing that makes the theme sing: cone stacks, barriers,
  diggers parked in the run-off, portaloos, skips, scaffolding, warning signs,
  a crane, floodlight towers.
- Crowds. Stands near the start/finish and clusters at the good corners, with
  bobbing, waving, flags. A still frame must still feel alive.
- Animated set pieces the player passes: a swinging wrecking ball, a tipping
  load, a level crossing, steam vents, birds.
- A proper start/finish gantry area that reads as an event, not a line.
- Depth cues: things at three distances so speed reads.

Everything must be instanced. A thousand cones should cost a handful of draw
calls. Respect ctx.quality.drawDistance. Nothing you add may block the racing
line or be mistaken for a hazard the player can hit.

You own a new module: register a system with order 22 (after track, before
physics) and build from ctx.track once track:built fires.`,
  },

  themewire: {
    name: 'Theme wiring',
    owns: 'src/render/**, src/world/**',
    shots: 'racing,far,overhead',
    brief: `
Own the wiring between a course's declared theme and what the renderer and the
world module actually draw. Right now that wiring mostly does not exist, and it
is blocking the course roster outright.

What a critic measured, with file and line — verify each before you fix it:
- \`theme.ground\` is read in exactly one place, src/render/lighting.ts:176, as a
  hemisphere-light ground colour. It never paints the terrain material. Saltpan
  Bypass declares 0xe0dccc, near-white salt, and photographs as rgb(122,100,59)
  off-road — within 12 points of Switchback Summit's.
- All thirteen \`theme.props\` keys — saltpan, alpine, snowPoles, pines,
  avalancheFence, windsocks, machinery, conveyors, dust, heatShimmer, surveyPegs,
  quarry, canyon — have ZERO property reads anywhere in src/. They are prose in a
  data structure, not switches. Jackhammer Quarry cannot contain a quarry.

Build:
- A per-course terrain material driven by \`theme.ground\`, so the ground under
  the tyres is the colour the course says it is. Not a tint on one shared
  material — salt, quarry dust, alpine rock and canyon sand are different
  surfaces, not one surface at four brightnesses.
- A prop-set switch keyed off \`theme.props\`. Each key names a set the world
  module builds and places; an unknown key is a loud error, not a silent no-op,
  because silent no-op is exactly how this got shipped.
- The same treatment for anything else a course declares and nobody reads. Audit
  the whole theme block and report every key with no consumer. Either wire it or
  delete it from the type — a field that lies about being read is worse than no
  field.

Judge yourself the way the critic will: photograph all four courses from the
overhead and far shots and put them side by side. If you cannot tell which is
which without the minimap, you are not done.

Everything you add must be instanced and must respect ctx.quality.drawDistance,
and nothing you add may block the racing line or read as a hazard.`,
  },

  perf: {
    name: 'Performance',
    owns: 'src/core/quality.ts (new), plus render-budget changes anywhere',
    shots: 'pack,racing,far',
    brief: `
Own the frame budget. The world is now 723k triangles across 304 draw calls and
nobody has ever measured whether it holds 60fps on a machine that is not this
one. A racer that hitches is not first-party, no matter how it photographs.

Measure first, then cut. Use window.__GAME.stats() and add whatever counters you
need to it; do not guess at what is expensive.

Build:
- An honest frame budget. Instrument the fixed-step and the render separately so
  a sim spike and a draw spike are distinguishable. Report both in stats().
- LOD on everything with a silhouette: vehicles, crowd, dressing, terrain. The
  pack shot must keep its detail; the far shot must not pay for detail nobody
  can resolve.
- Instancing audit. Anything that appears more than eight times and is not
  already instanced is a bug. Merge static shells per material the way
  mergeStatic() already does for vehicles.
- A quality ladder driven by measured frame time, not by a hardcoded guess:
  drawDistance, shadow resolution, particle caps, crowd density. It must settle,
  not oscillate — hysteresis, and never mid-corner.
- Kill per-frame allocation in the hot path. Scratch vectors, no closures per
  racer per step, no array churn in fixedUpdate.

Hard constraints: the simulation is deterministic and must stay that way — LOD
and culling may never touch anything fixedUpdate reads. A quality change must
not alter a single racer's position. Prove it: run the same seed at two quality
levels and diff the snapshots.`,
  },
};

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'pass', 'mkReference', 'blindPick', 'biggestGap', 'directive', 'evidence'],
  properties: {
    score: { type: 'number', description: '0-10. 8.5+ means genuinely first-party.' },
    pass: { type: 'boolean', description: 'true only if you cannot name a gap that matters' },
    mkReference: { type: 'string', description: 'The specific Mario Kart 8 behaviour you judged against' },
    blindPick: { type: 'string', enum: ['ours', 'mario-kart', 'tie'] },
    biggestGap: { type: 'string', description: 'The single biggest gap, one sentence. Empty only if pass.' },
    directive: { type: 'string', description: 'Exactly what the builder must change next. Specific and actionable.' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'What you actually observed in frames/traces' },
  },
};

/**
 * A verdict's `evidence` is an array in the schema, but a verdict handed in as
 * `carry` is hand-authored and arrives however the author typed it. `.join` on a
 * string is a TypeError, and a TypeError here does not fail loudly — it throws
 * inside a pipeline stage, which drops that piece to null and skips it. A wave
 * would launch, report itself started, and quietly build one piece out of three.
 */
function evidenceLine(evidence) {
  if (!evidence) return '';
  return Array.isArray(evidence) ? evidence.join(' | ') : String(evidence);
}

function buildPrompt(piece, round, last) {
  const feedback = last ? `
── ROUND ${round}. A critic played the previous build and rejected it. ──
Score ${last.score}/10. Blind A/B against Mario Kart: ${last.blindPick}.
Biggest gap: ${last.biggestGap}
Directive: ${last.directive}
Observed: ${evidenceLine(last.evidence)}
Close that gap first. Do not start a redesign.
` : '';

  return `${COMMON}

── YOUR PIECE: ${piece.name} ──
YOU OWN (and may only edit): ${piece.owns}
${piece.brief}
${feedback}

If your module is new, you must also register it in src/main.ts — that is the
ONE file outside your ownership you may touch, and only to add your import and
one engine.add() line. Nothing else in it.

Work until the piece is genuinely excellent, then verify with typecheck and
smoke. Look at your own screenshots before declaring done:
\`node tools/capture.mjs --only ${piece.shots} --out /tmp/build-${piece.id}\` and Read the PNGs.

Return a short report: what you changed, what you could not do inside your
ownership, and anything another module must do for this piece to land.`;
}

function judgePrompt(piece, round, dir) {
  return `${COMMON}

You are a HARSH, INDEPENDENT CRITIC. You did not build this. Do not read the
builder's report or commit messages. Judge only what the running game does.

── PIECE UNDER REVIEW: ${piece.name} (${piece.owns}) ── round ${round}

STEP 1 — Write the reference from memory, BEFORE looking at our game.
From your knowledge of Mario Kart 8 Deluxe, write down precisely what this piece
looks and behaves like there. Concrete and specific: exact cues, timings, what
happens frame by frame, what the player sees and feels. Name the exact moment
you are using as your reference. Do NOT look at our game yet.

STEP 2 — Play our game for real.
    cd ${REPO}
    node tools/capture.mjs --only ${piece.shots} --out ${dir}
READ every PNG with the Read tool. Actually look. Then drive it:
node tools/trace.mjs (--manual for hand inputs) to check behaviour over time.
Write your own capture script if the standard shots do not show what you need —
the harness API is in ARCHITECTURE.md §11. Never judge from source alone.

STEP 3 — Blind A/B.
Write two unlabelled descriptions of the same moment: ours, and the Mario Kart
reference from step 1. Pick which is better as a player would experience it.
Our game is new; the default expectation is that Mario Kart wins. Only pick ours
if it genuinely deserves it.

STEP 4 — Verdict.
Score 0-10, where 8.5+ means "I would believe this shipped as a first-party
Nintendo game". Name the SINGLE biggest gap in one sentence. Then a specific,
actionable directive — not "make it better" but "drift sparks do not change
colour at tier 2, so the player cannot read their charge".

Be genuinely harsh. 7 is a normal score for competent work. If you can name a
gap a player would notice, it fails.`;
}

// ── run ────────────────────────────────────────────────────────────────────

/**
 * `args` can arrive as an object or as a JSON string depending on how the
 * workflow was invoked. Parsing both matters more than it looks: when this read
 * `args.pieces` directly, a stringified payload silently produced `undefined`,
 * the script fell through to its defaults, and a wave launched for ai/audio/world
 * spent ninety minutes rebuilding the pieces it already had — while every
 * `carry` directive was dropped on the floor. A misrouted wave should be a loud
 * failure, so anything unparseable throws rather than defaulting.
 */
const input = (() => {
  if (!args) return {};
  if (typeof args !== 'string') return args;
  try {
    return JSON.parse(args);
  } catch (err) {
    throw new Error(`workflow args were a string but not valid JSON: ${String(err)}`);
  }
})();

const ids = input.pieces || ['items', 'fx', 'hud'];
const MAX_ROUNDS = input.rounds || 2;
const PASS_SCORE = 8.5;

/**
 * Verdicts carried in from an earlier run, keyed by piece id.
 *
 * A wave that ends without a pass has produced its most valuable output — a
 * critic's measured directive — and that has to survive into the next run.
 * Without this, round 3 opens by rediscovering what round 2 already proved.
 */
const CARRY = input.carry || {};

const selected = ids.map((id) => ({ id, ...PIECES[id] })).filter((p) => p.name);
log(`Wave: ${selected.map((p) => p.id).join(', ')} — up to ${MAX_ROUNDS} rounds each.`);
for (const id of Object.keys(CARRY)) log(`  carrying forward a prior verdict for ${id}`);

const results = await pipeline(
  selected,
  async (piece) => {
    let verdict = CARRY[piece.id] || null;
    let round = 0;
    const history = [];

    while (round < MAX_ROUNDS) {
      round++;

      await agent(buildPrompt(piece, round, verdict), {
        label: `build:${piece.id}${round > 1 ? ` r${round}` : ''}`,
        phase: 'Build',
      });

      verdict = await agent(judgePrompt(piece, round, `/tmp/review-${piece.id}-r${round}`), {
        label: `judge:${piece.id} r${round}`,
        phase: 'Judge',
        schema: VERDICT,
      });

      if (!verdict) {
        log(`${piece.id}: critic returned nothing on round ${round}; stopping this piece.`);
        break;
      }

      history.push({ round, score: verdict.score, blindPick: verdict.blindPick, gap: verdict.biggestGap });

      const accepted = verdict.pass && verdict.score >= PASS_SCORE && verdict.blindPick !== 'mario-kart';
      log(`${piece.id} r${round}: ${verdict.score}/10, blind pick "${verdict.blindPick}" — ${accepted ? 'PASSED' : `sent back: ${verdict.biggestGap}`}`);

      if (accepted) return { piece: piece.id, name: piece.name, rounds: round, passed: true, verdict, history };
    }

    return { piece: piece.id, name: piece.name, rounds: round, passed: false, verdict, history };
  },
);

const done = results.filter(Boolean);
log(`Wave complete: ${done.filter((r) => r.passed).length}/${done.length} passed.`);

return {
  passed: done.filter((r) => r.passed).map((r) => r.piece),
  outstanding: done.filter((r) => !r.passed).map((r) => ({
    piece: r.piece, score: r.verdict?.score, gap: r.verdict?.biggestGap, directive: r.verdict?.directive,
  })),
  detail: done,
};
