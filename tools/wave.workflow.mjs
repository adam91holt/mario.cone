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

function buildPrompt(piece, round, last) {
  const feedback = last ? `
── ROUND ${round}. A critic played the previous build and rejected it. ──
Score ${last.score}/10. Blind A/B against Mario Kart: ${last.blindPick}.
Biggest gap: ${last.biggestGap}
Directive: ${last.directive}
Observed: ${(last.evidence || []).join(' | ')}
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

const ids = (args && args.pieces) || ['items', 'fx', 'hud'];
const MAX_ROUNDS = (args && args.rounds) || 2;
const PASS_SCORE = 8.5;

const selected = ids.map((id) => ({ id, ...PIECES[id] })).filter((p) => p.name);
log(`Wave: ${selected.map((p) => p.id).join(', ')} — up to ${MAX_ROUNDS} rounds each.`);

const results = await pipeline(
  selected,
  async (piece) => {
    let verdict = null;
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
