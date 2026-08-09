export const meta = {
  name: 'mario-cone-coherence',
  description: 'Play MARIO.CONE end to end and smooth the seams between pieces into one game',
  whenToUse: 'Between build waves, once the parallel builders have landed and merged.',
  phases: [
    { title: 'Survey', detail: 'fresh agent plays the whole game and ranks the seams' },
    { title: 'Smooth', detail: 'one agent, whole-repo ownership, fixes the seams' },
    { title: 'Judge', detail: 'fresh critic judges the game as a single work' },
  ],
};

const REPO = '/home/user/mario.cone';

/**
 * This workflow is the counterweight to the build waves.
 *
 * Every other agent in this project is deliberately boxed in: strict file
 * ownership is what lets eight of them edit the same repo at once without
 * trampling each other. But the cost of that is real and it compounds — nobody
 * owns the space *between* the pieces. The HUD agent picks a yellow, the item
 * agent picks a different yellow, both are individually defensible, and the game
 * ends up looking like it was made by eight people who never met.
 *
 * So this one runs alone and owns everything. It must never be launched while a
 * build wave is in flight: whole-repo ownership and strict file ownership cannot
 * both be true at the same time, and the builder loses that race silently.
 */
const COMMON = `
You are working in the repo at ${REPO} — a Mario Kart-class racing game in
TypeScript + Three.js called MARIO.CONE. The racers are roadworks machines: a
road cone, a plane, a helicopter, a digger, a train, a truck and a car.

Read ${REPO}/ARCHITECTURE.md in full first, then ${REPO}/src/types.ts.

How this game was built, and why you exist: it was built by many agents working
in parallel, each owning a disjoint set of files, each judged alone by a critic
who only ever looked at that one piece. That produced strong pieces. It cannot,
by construction, produce a coherent game — no agent has ever been responsible
for the space between the pieces, and no critic has ever been asked whether the
whole thing feels like one work by one studio.

That is your entire job.

Driving the real game — this is how you see it, never by reading code and
imagining the result:
    node tools/capture.mjs                     full review sheet -> shots/
    node tools/capture.mjs --list              every available shot
    node tools/capture.mjs --only drift,boost --out /tmp/x
    node tools/trace.mjs --seconds 20 --fields speed,lap,progress,place
    node tools/trace.mjs --manual --accel 1 --steer 0.6 --drift
    node tools/clip.mjs --seconds 8            deterministic video
LOOK at the PNGs with the Read tool.

window.__GAME (src/core/harness.ts) is the driving surface: step(), render(),
advance(), reset(), setInput(), setAutopilot(), snapshot(), stats(), seek().
`;

const SEAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['seams', 'wholeGameVerdict'],
  properties: {
    wholeGameVerdict: {
      type: 'string',
      description: 'Does this feel like one game by one studio, or a bag of good parts? Be specific.',
    },
    seams: {
      type: 'array',
      description: 'Ranked worst-first. A seam is a discontinuity BETWEEN pieces, not a flaw within one.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'kind', 'evidence', 'fix', 'severity'],
        properties: {
          title: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['visual', 'timing', 'tone', 'audio', 'language', 'input', 'continuity', 'dead-end'],
          },
          evidence: {
            type: 'string',
            description: 'What you observed, with the shot or trace that shows it. Not a code reading.',
          },
          fix: { type: 'string', description: 'The specific change, naming files.' },
          severity: { type: 'number', description: '1-5, 5 = a player would notice in the first minute' },
        },
      },
    },
  },
};

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'pass', 'blindPick', 'biggestGap', 'directive', 'evidence'],
  properties: {
    score: { type: 'number', description: '0-10 for the game AS A WHOLE. 8.5+ is first-party.' },
    pass: { type: 'boolean' },
    blindPick: { type: 'string', enum: ['ours', 'mario-kart', 'tie'] },
    biggestGap: { type: 'string' },
    directive: { type: 'string' },
    evidence: { type: 'string' },
  },
};

function surveyPrompt(round, prior) {
  return `${COMMON}
── SURVEY ROUND ${round} ──

Play the whole game, front to back, as a player would meet it: the first frame
after load, the menus, choosing a racer, the grid, the lights, the race itself,
the finish, the results, and whatever comes after results. Use the harness to
reach each of those states and LOOK at every one.

You are hunting SEAMS — discontinuities between pieces that no single-piece
critic could ever have seen:

- Visual: two modules that picked different yellows, different corner radii,
  different fonts, different outline weights, different shadow language. A
  gradient in one panel and a flat fill in another. Anything that says "two
  authors".
- Timing: the countdown holds 0.9s but the results row cascade holds 0.4s; a
  transition that snaps where every other one eases. Does the game have ONE
  rhythm?
- Tone: is it the same game's voice in the menu, the item names, the results
  screen and the announcer? Roadworks joy, or three different jokes?
- Audio: does everything that flashes also make a sound, and vice versa? A
  visual event with no audio partner is a seam.
- Language: is the same thing called the same name everywhere — in the HUD, the
  menu, the results, the code?
- Input: does a button mean the same thing in every state? Can you get stuck?
- Continuity: does state survive the transitions? Does the racer you picked show
  up on the grid, in the HUD portrait, on the results sheet?
- Dead-end: a state with no way out, a screen that never appears, a system built
  but never wired to anything that can reach it.

That last one matters most. Find the things that were BUILT BUT NEVER CONNECTED.
Ninety percent of parallel-agent work fails here: the piece exists, is good, and
nothing in the running game ever calls it.

${prior ? `The last judge said:\n${prior}\nStart by checking whether that is fixed.\n` : ''}
Rank worst-first by what a player meets soonest and notices hardest. Do not
report flaws that live entirely inside one piece — those have their own critics.
Do not fix anything. Survey only.`;
}

function smoothPrompt(survey, round) {
  return `${COMMON}
── SMOOTH ROUND ${round} ──

You own the WHOLE REPO. No file ownership restrictions apply to you — you are
the only agent running. That is deliberate: the seams below exist precisely
because they fall between the boxes every other agent was confined to.

A fresh player just went through the whole game and reported this:

WHOLE-GAME VERDICT: ${survey.wholeGameVerdict}

SEAMS, worst first:
${survey.seams
  .map(
    (s, i) =>
      `${i + 1}. [${s.kind}, severity ${s.severity}] ${s.title}\n   evidence: ${s.evidence}\n   suggested fix: ${s.fix}`,
  )
  .join('\n')}

Fix them, worst first. Where two pieces disagree, do not split the difference —
pick the better one and make the other match it, then say which you picked and
why. If the right fix is to promote a value into a shared constant so it cannot
drift again, do that; a seam you close by hand reopens next wave.

You are allowed, and encouraged, to delete. A system built but never reachable
is worse than no system: it costs frame time, it costs the next agent's reading
time, and it makes the repo lie about what the game is. Wire it up or take it
out.

Hard rules that still bind you:
- Deterministic simulation: gameplay in fixedUpdate at constant dt, never
  Math.random (use ctx.rng), never a wall-clock read. Visuals go in update.
- \`alpha\` passed to update() is a 0..1 blend. Feed it to lerp, nothing else.
- Never break window.__GAME — every reviewer drives the game through it.
- No network at runtime, no asset files. Everything procedural.
- Nothing allocates per frame in a hot path.

Before you finish you MUST run, from ${REPO}:
    npm run typecheck                  (must be clean)
    node tools/capture.mjs --smoke     (must pass)
    node tools/capture.mjs             (then LOOK at the sheet)
Both of the first two take minutes under software GL. Run them in the background
and poll; do not assume they have hung.

Typecheck-clean is a weaker gate than it feels. It has passed on a build that
did not boot. The smoke run is the real gate — it is the one that proves the
game still starts.`;
}

function judgePrompt(round) {
  return `${COMMON}
── WHOLE-GAME JUDGEMENT, ROUND ${round} ──

You are a harsh critic with fresh eyes. You have never seen this project. You do
not get the builder's summary and you must not read their report — you play the
game.

STEP 1 — Before you look at anything in this repo, write down from memory what
it feels like to sit down with Mario Kart 8 Deluxe for ninety seconds: boot,
menu, character select, course select, the grid, the race, the finish, results.
Not the graphics — the FEEL of the whole thing. Its rhythm, its confidence, how
it never once makes you wonder what to press. Write that first, because after
you have looked at ours you will unconsciously grade on a curve.

STEP 2 — Now drive our game through every one of those same beats. Capture and
READ the PNGs. Do not reason about what the code renders.

STEP 3 — Blind A/B. Put our frame beside the Mario Kart 8 beat it corresponds
to, and say plainly which one you would rather be playing. Judge the WHOLE, not
the pieces: a game of eight excellent parts that do not agree with each other
loses to a game of seven good parts that do.

STEP 4 — Verdict. Score the game as a single work. 8.5+ means "I would believe
this shipped as a first-party Nintendo game". Name the SINGLE biggest gap in one
sentence, then a directive specific enough to act on without asking a question.

Be genuinely harsh. 7 is a normal score for competent work. The question is not
"is this impressive for a web game" — it is "is this one game, and is it as good
as the one it is imitating".`;
}

// ── run ────────────────────────────────────────────────────────────────────

const input = (() => {
  if (!args) return {};
  if (typeof args !== 'string') return args;
  try {
    return JSON.parse(args);
  } catch (err) {
    throw new Error(`workflow args were a string but not valid JSON: ${String(err)}`);
  }
})();

const MAX_ROUNDS = input.rounds || 2;
const PASS_SCORE = 8.5;

let prior = input.prior || null;
const history = [];

for (let round = 1; round <= MAX_ROUNDS; round++) {
  phase('Survey');
  const survey = await agent(surveyPrompt(round, prior), {
    label: `survey r${round}`,
    phase: 'Survey',
    schema: SEAM_SCHEMA,
  });

  if (!survey) {
    log(`round ${round}: survey agent died — stopping rather than smoothing blind`);
    break;
  }

  log(`round ${round}: ${survey.seams.length} seam(s); worst = ${survey.seams[0]?.title ?? 'none'}`);
  if (survey.seams.length === 0) {
    log('no seams reported — going straight to judgement');
  } else {
    phase('Smooth');
    await agent(smoothPrompt(survey, round), { label: `smooth r${round}`, phase: 'Smooth' });
  }

  phase('Judge');
  const verdict = await agent(judgePrompt(round), {
    label: `judge r${round}`,
    phase: 'Judge',
    schema: VERDICT,
  });

  if (!verdict) {
    log(`round ${round}: judge died — no verdict, treating the round as unproven`);
    break;
  }

  history.push({ round, seams: survey.seams.length, verdict });
  log(`round ${round}: ${verdict.score}/10, blind pick "${verdict.blindPick}" — ${verdict.biggestGap}`);

  if (verdict.pass && verdict.score >= PASS_SCORE) {
    log(`coherence passed at round ${round}`);
    return { passed: true, rounds: round, history };
  }
  prior = `score ${verdict.score}/10. biggest gap: ${verdict.biggestGap}. directive: ${verdict.directive}`;
}

return { passed: false, rounds: history.length, history, lastDirective: prior };
