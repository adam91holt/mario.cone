export const meta = {
  name: 'mario-cone-wave1',
  description: 'Build and adversarially review the five foundation pieces of MARIO.CONE',
  whenToUse: 'Wave 1 of the MARIO.CONE build: kart feel, camera, track, art direction, cast.',
  phases: [
    { title: 'Build', detail: 'one owner agent per piece, strict file ownership' },
    { title: 'Judge', detail: 'fresh critic plays the real game and compares against Mario Kart 8' },
  ],
};

// ── shared context every agent gets ────────────────────────────────────────

const REPO = '/home/user/mario.cone';

const COMMON = `
You are working in the repo at ${REPO} — a Mario Kart-class racing game in
TypeScript + Three.js called MARIO.CONE. The racers are roadworks machines: a
road cone, a plane, a helicopter, a digger, a train, a truck and a car.

BEFORE YOU DO ANYTHING: read ${REPO}/ARCHITECTURE.md in full. It is the contract
between the many agents working on this repo in parallel. Then read
${REPO}/src/types.ts, which encodes that contract as real types.

Hard rules:
- The quality bar is Nintendo first-party. Not "good for a web game". If a
  Nintendo art director would flag it, it is not done.
- STRICT FILE OWNERSHIP. You may only edit the files listed in your brief. Other
  agents are editing other files at the same time. Touching a file you do not own
  will be reverted and wastes everyone's round. If you need a change elsewhere,
  say so in your report instead.
- The simulation must stay deterministic: all gameplay in fixedUpdate at constant
  dt, no Math.random (use ctx.rng), no wall-clock reads. Visuals go in update.
- Never break window.__GAME (src/core/harness.ts). Every reviewer drives the game
  through it. Breaking it makes your work unjudgeable.
- No network at runtime, no asset files. Everything procedural or vendored.

Before you finish you MUST run, from ${REPO}:
    npm run typecheck          (must be clean)
    node tools/capture.mjs --smoke   (must pass)
Fix anything you broke. These take a few minutes each under software GL — be patient,
run them in the background and poll rather than assuming they hung.

Tools you have for seeing the real game:
    node tools/capture.mjs                      full review sheet -> shots/
    node tools/capture.mjs --only drift,boost --out /tmp/x   selected shots
    node tools/capture.mjs --list               what shots exist
    node tools/trace.mjs --seconds 20 --fields speed,lap,progress,place
    node tools/trace.mjs --manual --accel 1 --steer 0.6 --drift
You can and should LOOK at the PNGs with the Read tool. Do not trust reasoning
about what the code probably renders — look at it.
`;

const PIECES = [
  {
    id: 'feel',
    name: 'Kart feel & drift',
    owns: 'src/physics/** and the `kart` section of src/core/config.ts',
    shots: 'racing,drift,boost,offroad',
    brief: `
Own the driving model. This is the single most important piece in the game: if
the kart does not feel good, nothing else matters.

What "Nintendo first-party" means here, concretely:
- Acceleration has a punchy low end and a long soft top end. The kart should feel
  like it is straining at top speed.
- Drift is the core loop. Hop -> commit -> the chassis pivots out while the kart
  keeps travelling forward -> charge builds visibly in tiers -> release fires a
  boost that is *felt*, not just a number change. Three tiers, escalating.
- Steering authority must fall off with speed, and rise sharply in a drift.
- Every state change wants weight: hop has anticipation, landing has a squash and
  a speed scrub, wall hits scrub proportional to how square the hit was.
- Off-road must be punishing but recoverable, and must read instantly.
- Coins raise top speed. Slipstream behind a rival gives a real, usable draft.
- Trick on landing: input during the air window gives a boost on touchdown.

Currently implemented at a basic level: accel curve, drift with 3 tiers, hop,
grip model, boost, wall scrub, off-road drag. Slipstream and tricks are declared
in config but NOT implemented — implement them.

Tune the numbers by actually driving. Use tools/trace.mjs with --manual to feel
out the curves, and check that a full drift-to-boost cycle reads on screen.`,
  },
  {
    id: 'camera',
    name: 'Camera',
    owns: 'src/render/camera.ts and the `camera` section of src/core/config.ts',
    shots: 'racing,drift,boost,far,grid',
    brief: `
Own the chase camera. In a kart racer the camera is half the feel.

What to get right:
- It trails the direction of travel, not the chassis yaw, so a drift shows the
  kart's flank rather than swinging the whole world.
- Speed reads through the camera: pull-back, FOV widening, and a distinct punch
  when a boost fires. A boost should be unmistakable with the sound off.
- Landing dips, impacts shake, corners bank — all spring-driven, never linear.
- The pre-race intro sweep should feel authored, not procedural.
- Look-behind must be usable and snap back cleanly.
- It must never clip through the track, never lose the kart, never gimbal-flip
  at the top of a crest or in a steep bank.

Currently implemented: chase with damping, drift yaw offset, FOV/pullback by
speed, trauma shake, landing dip spring, roll banking, an intro sweep, and
overhead/far/near/front modes.

Judge it by capturing at speed and in a drift and looking at the frames.`,
  },
  {
    id: 'track',
    name: 'Track surface & course design',
    owns: 'src/track/** (spline, builder, textures, courses)',
    shots: 'overhead,racing,far,grid,offroad',
    brief: `
Own the road itself and the shape of the circuit.

What to get right:
- The road must be unmistakably readable at 60 m/s: high-contrast edge lines, a
  centreline that gives a sense of motion without strobing, kerbs that pop.
- Kerbs/rumble strips on the inside of every corner, banking through the fast
  sweepers, a crest that pops karts airborne, at least one genuine hairpin and
  one flowing esse section. Corners must have distinct character.
- Add boost pads and at least one shortcut that costs something to take.
- The start/finish line needs a real start gantry and grid markings.
- Elevation change must be visible from the chase camera, not just in the data.
- The verge and off-road must read as clearly different surfaces at a glance.
- Barriers should look built, not extruded — posts, panels, hazard chevrons.

Currently: a spline with banking/width bands, a road ribbon with baked markings,
verges, extruded barrier walls, a flat ground plane, one course (Cone Canyon).
The ground plane is a flat coloured quad — that is the weakest part of the frame.

Keep TrackSpline's public shape (types.ts TrackSplineLike) — physics, AI and the
race director all depend on it.`,
  },
  {
    id: 'look',
    name: 'Art direction: lighting, sky, post',
    owns: 'src/render/** EXCEPT camera.ts (so: lighting.ts, and new files you add)',
    shots: 'racing,grid,far,overhead,drift',
    brief: `
Own how the game *looks*. Right now it renders; it does not yet look like a
Nintendo game.

What to get right:
- Saturated, high-key, joyful. Warm key light, cool sky fill, strong rim
  separation so silhouettes pop off the background.
- Add a post-processing stack: bloom on highlights and boost flames, subtle
  vignette, a colour grade with real intent. Wire it to ctx.composer — the engine
  already renders through it when ctx.quality.postfx is on. It must degrade
  cleanly when postfx is off.
- Shadows need to actually ground everything. Contact is what stops objects
  looking like stickers.
- The sky is a gradient shader now; give it clouds and depth.
- Distance fog should read as atmosphere, not as grey wash.
- Colour must stay readable: the road must never fight the karts for attention.

You own the look. Take a real position on it rather than adding effects
one at a time.`,
  },
  {
    id: 'cast',
    name: 'Vehicle models & animation',
    owns: 'src/vehicles/**',
    shots: 'grid,pack,racing,drift',
    brief: `
Own the seven racers: cone, car, truck, digger, train, plane, helicopter.

What to get right:
- Each must be identifiable as a pure black silhouette at thumbnail size. That is
  the test Nintendo applies and it is the one that matters.
- They need CHARACTER, not just correct geometry. Faces, expressions, reactions.
  The cone is the mascot — it should be impossible not to like.
- Animation: suspension compresses under load, bodies lean into corners, wheels
  actually spin at the right rate, rotors and props turn, the digger's arm reacts.
  Nothing should be rigid.
- React to game state: a boost should visibly strain the model, a hit should make
  it recoil, a drift should make it lean hard.
- They must read apart from each other in a pack at speed — silhouette, colour,
  and scale all doing work.
- Proportions should be chunky and appealing, not realistic.

Currently: all seven exist, built from primitives, with basic wheel spin and lean.
They are serviceable blockouts and no more. Make them characters.

Keep VehicleDef/VehicleModel shape from types.ts, and keep the stat budget roughly
balanced (see the comment at the top of registry.ts).`,
  },
];

// ── verdict schema ─────────────────────────────────────────────────────────

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'pass', 'mkReference', 'blindPick', 'biggestGap', 'directive', 'evidence'],
  properties: {
    score: { type: 'number', description: '0-10. 8.5+ means genuinely first-party.' },
    pass: { type: 'boolean', description: 'true only if you cannot name a gap that matters' },
    mkReference: { type: 'string', description: 'The specific Mario Kart 8 behaviour/frame you judged against' },
    blindPick: { type: 'string', enum: ['ours', 'mario-kart', 'tie'] },
    biggestGap: { type: 'string', description: 'The single biggest gap, one sentence. Empty only if pass.' },
    directive: { type: 'string', description: 'Exactly what the builder must change next. Specific and actionable.' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'What you actually observed in frames/traces' },
  },
};

function buildPrompt(piece, round, lastVerdict) {
  const feedback = lastVerdict
    ? `
── THIS IS ROUND ${round}. A critic played the previous build and rejected it. ──

Score: ${lastVerdict.score}/10. Blind A/B against Mario Kart: ${lastVerdict.blindPick}.
Biggest gap: ${lastVerdict.biggestGap}
What they want: ${lastVerdict.directive}
What they observed: ${(lastVerdict.evidence || []).join(' | ')}

Fix that gap as your first priority. Do not start a redesign; close the gap.
`
    : '';

  return `${COMMON}

── YOUR PIECE: ${piece.name} ──
YOU OWN (and may only edit): ${piece.owns}
${piece.brief}
${feedback}

Work until the piece is genuinely excellent, then verify with typecheck and the
smoke test. Look at your own screenshots before you declare done —
\`node tools/capture.mjs --only ${piece.shots} --out /tmp/build-${piece.id}\` and Read the PNGs.

Return a short report: what you changed, what you could not do from inside your
file ownership, and anything another module must do for this piece to land.`;
}

function judgePrompt(piece, round, reviewDir) {
  return `${COMMON}

You are a HARSH, INDEPENDENT CRITIC. You did not build this and you must not read
the builder's report or their commit messages. Judge only what the running game
actually does.

── THE PIECE UNDER REVIEW: ${piece.name} (${piece.owns}) ── round ${round}

Follow these steps IN ORDER. Step 1 happens BEFORE you look at our game — this is
what makes the comparison honest rather than rationalised after the fact.

STEP 1 — Write the reference from memory, first.
From your knowledge of Mario Kart 8 Deluxe, write down precisely what this piece
looks and behaves like in that game. Be concrete and specific: exact cues, timings,
what happens frame by frame, what the player sees and feels. Name the specific
moment you are using as your reference. Do NOT look at our game yet.

STEP 2 — Play our game for real.
    cd ${REPO}
    node tools/capture.mjs --only ${piece.shots} --out ${reviewDir}
Then READ every PNG it produced with the Read tool. Actually look at them.
Also drive it: node tools/trace.mjs (--manual for hand inputs) to check behaviour
over time. Write your own short capture script if the standard shots do not show
what you need — the harness API is in ARCHITECTURE.md §11.
Never judge from source code alone. Never judge from the builder's description.

STEP 3 — Blind A/B.
Write two unlabelled descriptions of the same moment: one of our frame, one of the
Mario Kart reference from step 1. Then pick which is better *as a player would
experience it* — and be honest. Our game is new; the default expectation is that
Mario Kart wins. Only pick ours if it genuinely deserves it.

STEP 4 — Verdict.
Score 0-10 where 8.5+ means "I would believe this shipped as a first-party
Nintendo game". Name the SINGLE biggest gap in one sentence. Then write a
specific, actionable directive for the builder — not "make it better" but
"the drift charge has no visual tell until tier 2; sparks must appear at tier 1
and change colour at each tier".

Be genuinely harsh. A 7 is a normal score for competent work. Do not award a pass
out of politeness — if you can name a gap that a player would notice, it fails.`;
}

// ── run ────────────────────────────────────────────────────────────────────

// This script used to hardcode all five pieces at three rounds — up to thirty
// agents in one wave, on a box that suspends every 35-90 minutes and whose
// journal cannot always be recovered afterwards. Every other wave in the
// project runs two pieces and two rounds and leans on resume. So it takes the
// same {pieces, rounds, carry} args wave.workflow.mjs does, and the old
// behaviour is what you get by passing nothing.
const input = (() => {
  if (typeof args === 'undefined' || !args) return {};
  if (typeof args !== 'string') return args;
  try {
    return JSON.parse(args);
  } catch (err) {
    throw new Error(`workflow args were a string but not valid JSON: ${String(err)}`);
  }
})();

const MAX_ROUNDS = input.rounds || 3;
const PASS_SCORE = 8.5;
const CARRY = input.carry || {};
const SELECTED = input.pieces
  ? input.pieces.map((id) => PIECES.find((p) => p.id === id)).filter(Boolean)
  : PIECES;

log(`Wave 1: ${SELECTED.map((p) => p.id).join(', ')} — up to ${MAX_ROUNDS} rounds each.`);
for (const id of Object.keys(CARRY)) log(`  carrying forward a prior verdict for ${id}`);

const results = await pipeline(
  SELECTED,
  async (piece) => {
    // A carried verdict is round 1's brief, so the wave does not spend its
    // first round rediscovering what the last one already named.
    let verdict = CARRY[piece.id] || null;
    let round = 0;
    const history = [];

    while (round < MAX_ROUNDS) {
      round++;

      await agent(buildPrompt(piece, round, verdict), {
        label: `build:${piece.id}${round > 1 ? ` r${round}` : ''}`,
        phase: 'Build',
      });

      const reviewDir = `/tmp/review-${piece.id}-r${round}`;
      verdict = await agent(judgePrompt(piece, round, reviewDir), {
        label: `judge:${piece.id} r${round}`,
        phase: 'Judge',
        schema: VERDICT,
      });

      if (!verdict) {
        log(`${piece.id}: critic returned nothing on round ${round}, stopping this piece.`);
        break;
      }

      history.push({
        round,
        score: verdict.score,
        blindPick: verdict.blindPick,
        gap: verdict.biggestGap,
      });

      const accepted = verdict.pass && verdict.score >= PASS_SCORE && verdict.blindPick !== 'mario-kart';
      log(`${piece.id} r${round}: ${verdict.score}/10, blind pick "${verdict.blindPick}" — ${accepted ? 'PASSED' : `sent back: ${verdict.biggestGap}`}`);

      if (accepted) return { piece: piece.id, name: piece.name, rounds: round, passed: true, verdict, history };
    }

    log(`${piece.id}: hit the ${MAX_ROUNDS}-round cap without passing. Carrying forward for the next wave.`);
    return { piece: piece.id, name: piece.name, rounds: round, passed: false, verdict, history };
  },
);

const done = results.filter(Boolean);
const passed = done.filter((r) => r.passed);

log(`Wave 1 complete: ${passed.length}/${done.length} pieces passed.`);

return {
  wave: 1,
  passed: passed.map((r) => r.piece),
  outstanding: done.filter((r) => !r.passed).map((r) => ({
    piece: r.piece,
    score: r.verdict?.score,
    gap: r.verdict?.biggestGap,
    directive: r.verdict?.directive,
  })),
  detail: done,
};
