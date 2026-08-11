# The build system

How this game gets made. Written 2026-08-11 for whoever picks it up next.

The short version: **the thing that builds is never the thing that judges.** A
builder agent writes code and then dies. A different agent, with no memory of
the build and no access to the builder's account of it, boots the real game,
drives it, photographs it, compares it blind against actual Mario Kart 8, and
returns a number. That separation is the entire product. Everything below is
scaffolding around it.

---

## 1. The unit of work: a piece

The game is cut into **pieces** — small enough that one agent can own one
outright, and each mapping to a directory it exclusively owns. Ownership is
written down in `ARCHITECTURE.md` and enforced by the type contract in
`src/types.ts`: two agents editing the same file at once is the fastest way to
lose an afternoon, and `npx tsc --noEmit` catches anyone who reaches across a
boundary.

There are 17 pieces on the board:

```
feel  camera  track  look  cast            <- wave 1 (tools/wave1.workflow.mjs)
items fx hud ai audio flow menus
courses world themewire perf                <- tools/wave.workflow.mjs
coherence                                   <- tools/coherence.workflow.mjs
```

A piece is done when a critic scores it **8.5 or higher** and cannot name a gap
that matters. Nothing has reached that yet.

---

## 2. A wave: build → judge, repeat

`tools/wave.workflow.mjs`. Two phases, and it pipelines — piece B is still
building while piece A is already being judged.

```
                round 1                    round 2
piece ──▶ [ build ] ──▶ [ judge ] ──pass?──▶ [ build ] ──▶ [ judge ] ──▶ verdict
             │              │       no                                      │
             │              └── directive ─────────────────────────────────▶│
             └── owns exactly one directory
```

**Build.** One agent, one piece, strict file ownership. If a previous verdict
exists it arrives as a directive — the builder is told precisely what to change,
not asked to guess.

**Judge.** A *fresh* agent with no build context. Its brief, in order:

1. **Write down the Mario Kart 8 reference from memory, before looking at our
   build.** This is deliberate and it is load-bearing. A critic who studies our
   game first will grade it against itself and find it good.
2. Drive the real game through `window.__GAME` — not a description of it, not
   the builder's summary.
3. Blind A/B against Mario Kart 8. Name which is which only after picking.
4. Return the verdict.

```js
{
  score: 0-10,           // 8.5+ means genuinely first-party
  pass: boolean,         // true only if you cannot name a gap that matters
  mkReference: string,   // the specific MK8 behaviour judged against
  blindPick: 'ours' | 'mario-kart' | 'tie',
  biggestGap: string,    // ONE sentence. the single biggest gap.
  directive: string,     // exactly what the builder changes next
  evidence: string[],    // what was actually observed in frames and traces
}
```

`biggestGap` being one sentence is a constraint, not a style note. A critic
allowed a list produces a list; a critic allowed one sentence has to decide what
actually matters.

### Launching one

```js
Workflow({
  scriptPath: "/home/user/mario.cone/tools/wave.workflow.mjs",
  args: {
    pieces: ["courses", "perf"],   // keep it to two
    rounds: 2,                     // and two rounds
    carry: {                       // prior verdicts, so round 1 doesn't
      courses: { /* verdict */ },  // rediscover what the last run proved
    },
  },
})
```

**`carry` is the important one.** A wave that ends without a pass has still
produced its most valuable output — a measured directive. Without `carry`, the
next run opens by rediscovering it. The verdicts currently on the board (courses
6.5, perf 7.0) should be carried into their next wave.

Keep waves **short — two pieces, two rounds.** Long waves do not survive
container suspension, and a wave that dies at agent 19 of 30 wastes more than
one that dies at agent 3 of 8.

---

## 3. A coherence pass: making it one thing

`tools/coherence.workflow.mjs`. Waves produce good pieces that do not
necessarily add up to one game. This is the corrective.

```
[ Survey ] ──▶ [ Smooth ] ──▶ [ Judge ]
    │              │              │
    │              │              └── judges the game as a single work
    │              └── ONE agent, whole-repo ownership
    └── fresh agent plays the WHOLE game, ranks the seams worst-first
```

A **seam** is a discontinuity no single-piece owner can see, because it lives
between two pieces. The survey classifies them: `visual`, `timing`, `tone`,
`audio`, `language`, `input`, `continuity`, `dead-end`.

Two rules:

- **Smooth is the only agent in the whole system allowed to touch any file.**
  That is the point — seams are cross-cutting by definition.
- **It must never run while a wave is running.** Whole-repo ownership and
  per-piece ownership cannot coexist.

---

## 4. The harness: why critics can be trusted

`src/core/harness.ts` exposes `window.__GAME`:

| Call | Does |
|---|---|
| `reset(cfg)` | hard reset into a specific race configuration |
| `step(s)` | advance the simulation `s` seconds, **no rendering** |
| `advance(s)` | advance and render — what you want before a screenshot |
| `setInput(partial)` | drive the kart directly |
| `setAutopilot(on)` | hand the player's kart to the AI |
| `seek(phase)` | jump to `intro` / `countdown` / `racing` / `finished` / `results` |
| `snapshot()` | every racer's position, speed, item, progress |
| `stats()` | draw calls, triangles, frame budget |
| `setQuality(tier)` | force a quality rung |

This exists so a reviewer can **drive and photograph the real build** instead of
trusting a description of it. It only works because the simulation is
deterministic: `fixedUpdate(dt)` at 120 Hz, a seeded `ctx.rng`, no
`Math.random()`, no wall-clock reads anywhere in the simulation. `update(dt,
alpha)` is visuals only. Two runs from the same seed produce identical frames,
which is what makes a screenshot evidence rather than an anecdote.

One trap, learned the hard way: `setInput()` short-circuits the device layer, so
it **cannot** test key or touch mapping. `tools/steercheck.mjs` dispatches real
key events for that reason — an inverted-steering bug shipped because a test
drove the wrong layer.

---

## 5. The board

`tools/progress.state.json` is the source of truth; `node tools/progress.mjs`
renders `progress.html`. Each piece carries `state`, `rounds`, `score`,
`verdict`, `gap`. There is also a `log` — a running narrative of what landed,
which is what makes the page readable to someone who was not here.

Update it with **real verdicts only**, from the workflow journal. It is the
project's memory of what has actually been judged.

---

## 6. Keeping it alive — the part that costs time

Work runs **in-process inside the main `claude` process**. Workflows are not
daemons. When the container suspends — roughly every 35–90 minutes here — every
in-flight agent dies instantly, mid-sentence.

So the hourly loop's real job is not keeping things alive. It is **noticing
death and resuming**.

### Proving liveness

```bash
date -u
ls -lt --time-style=+%H:%M:%S $WFDIR/$RUN/agent-*.jsonl | head -3
ps -eo etime,comm | grep -w claude
```

1. Newest `agent-*.jsonl` older than ~25 minutes → probably dead.
2. **The decisive test: elapsed age of the main `claude` process versus the
   write gap.** If `claude` has been alive for *less* time than the gap since
   the last agent write, the container restarted and everything in flight is
   dead — however recent the file timestamps look. This test has never been
   wrong.

Scars, each of which cost real hours:

- **Use `ls -t`.** A plain `ls | tail` sorts *alphabetically* and once hid the
  only live agent behind eleven finished ones. A healthy wave got killed over it.
- **`ps aux | grep claude` shows nothing during a healthy wave**, because
  subagents run in-process. Never judge liveness by process count or by counting
  Chrome.
- **Do not look for `claude` in a `--sort=-pcpu | head -4` list** — Chrome
  outranks it and it never appears.
- **Two agents whose last write is the identical second** is the signature of a
  suspend, not of coincidence.

### Resume, never relaunch

```js
Workflow({
  scriptPath: "<the same script>",
  resumeFromRunId: "<the dead run>",
  args: <the SAME args object, byte-for-byte>,
})
```

Completed `agent()` calls return from cache instantly; only the killed ones
re-run, carry intact. **Args must match exactly or the cache misses** and you
pay for the whole wave again.

Before resuming, read the dead run's `journal.jsonl` for results that already
carry a `score`. Those verdicts are earned and must never be re-bought:

```bash
node -e "const fs=require('fs');
for(const l of fs.readFileSync(process.argv[1],'utf8').trim().split('\n')){
  try{const e=JSON.parse(l);
    if(e.type==='result'&&e.result?.score!==undefined)
      console.log(e.agentId, e.result.score, e.result.biggestGap);
  }catch{}
}" $WFDIR/$RUN/journal.jsonl
```

### Half-written files

- **Agent dead, file mid-write** → it is not coming back and the resumed agent
  restarts that step from scratch. `git checkout --` those files rather than
  committing a build that cannot compile.
- **Agent alive, file mid-write** → wait. Do not touch it.

### Other hazards

- **Never `pkill` on a pattern matching your own tooling.** Agents run the same
  commands you do; `pkill -f capture.mjs` kills theirs.
- **Do not run captures or smoke while agents are active.** Four cores, and
  every capture is a headless Chromium with software GL.
- Vite HMR will destroy a page context mid-capture when another agent edits
  `src/`. Capture tools set `server: { hmr: false }` for this reason.

---

## 7. Gates, in the order they earn trust

1. `npx tsc --noEmit` — catches cross-module breakage.
2. `node tools/capture.mjs --smoke` — **the real gate.** Typecheck-clean has
   passed on a build that did not boot.
3. `node tools/capture.mjs` — the review sheet. Then **look at the PNGs with
   `Read`.** Never trust an agent's summary of its own work; this single habit
   is why the project works.
4. `node tools/phone.mjs` — the phone build, at a real iPhone viewport.

Then commit, push, PR against `main` (`draft: false`), merge. Merges are
squashed, so afterwards:

```bash
git fetch origin main && git reset --hard origin/main && git push --force-with-lease
```

`ff-only` will refuse. A push to `main` redeploys the game to Pages via
`.github/workflows/deploy.yml`.

---

## 8. If you are rebuilding this system elsewhere

The transferable parts, in order of how much they matter:

1. **The builder never judges.** A fresh critic, no build context, that drives
   the real artifact.
2. **The critic writes its reference from memory before looking.** Otherwise it
   grades the work against itself.
3. **A machine-readable harness on the artifact**, so review is measurement
   rather than opinion.
4. **One sentence for the biggest gap.** Forces a decision.
5. **A self-binding hourly Routine whose prompt is the durable memory**, edited
   in place as the project learns. Context compacts; the prompt does not.
6. **Resume, never relaunch.**
7. **A hard silence rule** — *message the user only when a wave lands, a wave
   had to be restarted, something needs a decision, or the build is finished.*
   Without it an hourly loop becomes hourly spam and stops being read.
