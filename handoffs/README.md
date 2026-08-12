# Handoff — MARIO.CONE

Written 2026-08-11, at the moment the build was paused. If you are a fresh
session picking this up, read this file first and `build-system.md` second.

MARIO.CONE is a Mario Kart-class kart racer in TypeScript + Three.js, starring
roadworks machines, built almost entirely by fanned-out agents judged against
the real Mario Kart 8. Nothing in it is a texture, a model, an audio file or a
font — every pixel and every sound is generated in code.

- Playable: **https://adam91holt.github.io/mario.cone/**
- Progress board: `progress.html` in the repo root (rendered from `tools/progress.state.json`)
- The conversation that built it: `docs/session/prompts.md`
- How it works, with diagrams: `docs/how-it-works.md`

---

## 1. State — resumed 2026-08-11 18:14 UTC

**Running again.** The pause below is history; it is kept because the verdicts it
recorded are still the carry for the wave now in flight.

| | |
|---|---|
| Branch | `claude/waves-phases-routine-setup-faggxq` (in sync with `origin/main`) |
| Board | **0 of 17 pieces at "pass"** — the bar is 8.5 |
| Hourly loop | `trig_016kZX2Ms5Z3DoxxD1AKBkSE` — **enabled**, hourly at :53 UTC, self-bound to session `session_01BBCEzQ8Tntz11FNErZ1pXg` |
| Current wave | `wf_85f146bd-139` — courses + perf, 2 rounds each, both carrying prior verdicts |
| Its args | `handoffs/wave.args.json` — pass these byte-for-byte to resume |

The wave that was in flight at the pause (`wf_a4784a0d-17d`) died with the
container on its 7th agent. It returned six of seven agents and three carried
scored verdicts.
Those are already recorded in `tools/progress.state.json` — **do not re-buy
them.** A critic's measured verdict is the most expensive artifact this system
produces.

- **perf 7.0** (two rounds). The quality ladder gained a content half. Round one
  caught the governor's own rung change as the worst frame of the session —
  3,101 ms and 1,494 ms against a 512–875 ms median, because `applyScale()`
  calls `setPixelRatio()` and reallocates the drawing buffer. Round two fixed
  that and exposed the next: the crowd trim is spent mid-race on the
  start/finish straight, so the grandstands empty in front of the player.
- **courses 6.5** (one round; the second died). Hazards can touch the player
  now. New gap: all four circuits sit within 11 m of each other on longest
  straight, so the select screen's four map cards are interchangeable.
- Every critic still picked **real Mario Kart** in the blind side-by-side.

### Parked, and it must stay parked

The owner asked to rename the project to **Gary's Kart**, then said: *"Just park
the rename until I ask for it."* It is **not** triggered by the board going
green, **not** part of the definition of done, and **not** something to raise
again. It waits for them to ask in their own words. The research is preserved at
the bottom of `build-loop-prompt.txt` so nobody re-derives it — it is reference,
not a work item.

### `private/` is encrypted on purpose

Do not try to open, repair or "fix" it. See `private/README.md`.

---

## 2. Arming the hourly loop

This is the single thing that keeps the build alive across container
suspension. There is nothing else — no daemon, no background service.

### If the Routine still exists (normal case)

```js
update_trigger({
  trigger_id: "trig_016kZX2Ms5Z3DoxxD1AKBkSE",
  enabled: true,
  name: "MARIO.CONE build loop",
})
```

**One critical caveat.** That Routine is *self-bound to the session that created
it* — it fires into the original conversation, not into yours. If you are a new
session, re-enabling it wakes a session you are not in. Either work in that
session, or delete it and create a fresh one from your own (below). Check with
`list_triggers` before assuming it is still there: the previous one
(`trig_01EAQCQD9TToG7aSacVrcW2s`) had vanished by the time this session picked
the build up, which is why there is a new id here.

### If you are starting fresh (new session, or the Routine is gone)

```js
create_trigger({
  name: "MARIO.CONE build loop",
  cron_expression: "0 * * * *",          // hourly, UTC
  prompt: <the entire contents of handoffs/build-loop-prompt.txt>,
})
```

Omit `persistent_session_id` **and** `create_new_session_on_fire`. That default
is the whole trick: it self-binds to *your* session and each firing **resumes
this same conversation** rather than starting cold. A fresh-session-per-fire
Routine would lose every scrap of context each hour and is the wrong shape for
this.

Before you arm it, fix three things in the prompt text — they are session- and
run-specific and **will be wrong for you**:

1. **`WFDIR=`** on line 1. It points at the previous session's workflow directory.
   Yours is `/root/.claude/projects/<slugified-cwd>/<your-session-uuid>/subagents/workflows`.
2. **The branch.** Line 1 names the branch the loop commits to.
3. **The run id.** Either update it after you launch, or leave it — the prompt
   already says `Do NOT trust any run id written here — resolve it: RUN=$(ls -t
   $WFDIR | head -1)`, which is the habit that matters.

One thing the fired session does **not** inherit: MCP connector tools. A Routine
created from inside a session stores only the connectors that session itself
holds, and this one stored none. Firing into a *persistent* session lands in a
conversation that already has its servers connected, so it has not bitten yet —
but if a tick finds `mcp__github__*` missing, push to the branch over plain git,
say so, and leave the PR for a tick that can open one. Never let a missing PR
tool become a reason to skip the push.

### The prompt is the memory — keep editing it

Context gets compacted every few hours; the Routine prompt does not. Anything
that must survive goes **in the prompt**, and the prompt is edited in place as
the project learns. It grew from about 1 KB to 8.6 KB over six days, one scar at
a time. Treat it as a living document, not a fixed instruction.

### Disarming

```js
update_trigger({ trigger_id: "...", enabled: false })
```

Do that before a long pause, or it will keep waking a session with nothing to
do.

---

## 3. First tick after arming

The prompt drives it, but the shape is:

0. **`ls node_modules`.** A reclaimed container comes back without it, and every
   agent that runs `npm run typecheck` or `--smoke` then fails on something that
   has nothing to do with its piece. `npm install` first, before launching
   anything.
1. `node tools/session.mjs` — refresh the published conversation archive.
2. Resolve the run id with `ls -t`, then **prove liveness** (see
   `build-system.md` §6 — this is the part that has burned the most time).
3. Alive → `npx tsc --noEmit`, commit, push, stop. Do **not** run captures while
   agents are active; they starve each other on a 4-core box.
4. Dead → resume, do not relaunch.
5. Finished → typecheck, smoke, capture, **look at the PNGs**, update the board,
   PR, merge.

---

## 4. Where things live

| Path | What |
|---|---|
| `src/` | the game. `ARCHITECTURE.md` defines who owns which directory |
| `src/core/harness.ts` | `window.__GAME` — how critics drive and photograph the real build |
| `tools/wave.workflow.mjs` | the builder → critic wave (11 pieces) |
| `tools/wave1.workflow.mjs` | the original 5 pieces: feel, camera, track, look, cast |
| `tools/coherence.workflow.mjs` | survey → smooth → judge, whole-repo ownership |
| `tools/capture.mjs` | the review sheet, and `--smoke` (the real boot gate) |
| `tools/progress.state.json` | the board. `tools/progress.mjs` renders `progress.html` |
| `tools/session.mjs` | publishes the conversation to `docs/session/` |
| `tools/phone.mjs` | the phone acceptance test, written from a real bug report |
| `handoffs/build-loop-prompt.txt` | the exact hourly prompt, verbatim |
| `handoffs/wave.args.json` | the args of the wave in flight, for a byte-exact resume |
| `.github/workflows/deploy.yml` | pushes to `main` redeploy the game to Pages |

---

## 4a. Tests

```
npm test          typecheck + smoke + countdown + phone + steer
npm run smoke     the boot gate. typecheck-clean has passed on a build that did not boot
```

Each acceptance test was written from a **real report**, not from a fix, and
each one failed before its fix landed:

| | Guards |
|---|---|
| `tools/countdown.mjs` | nothing moves, and no boost is granted, before the flag |
| `tools/phone.mjs` | the race waits for the player, and there are controls on glass |
| `tools/steercheck.mjs` | left is left — it drives real key events, because `setInput()` bypasses the device layer |
| `tools/underground.mjs` | the chase lens never ends up inside the landscape |

`tools/underground.mjs` carries three guards, and every one of them was bought
with a measurement that said the wrong thing:

- **Terrain is the two meshes named `ground` and `embankment`.** Picking them by
  vertex count also catches grandstands, crowds and an overhead sign, and
  "reproduced" the bug 8.5 m underground on cone-canyon when the camera was
  passing beneath a gantry under clear sky.
- **`reset()` takes `courseId`/`vehicleId` and silently ignores unknown keys.**
  Passing `course` loads the default, so the test measured cone-canyon four
  times and printed four course names. It now checks `snapshot().track.id`
  against what it asked for.
- **The engine's rAF loop never stops**, and steps the simulation by wall time
  alongside anything the harness drives, so `setTimeScale(0)` has to be
  re-applied after *every* reset. Without it a sample labelled `t=2s` is nothing
  of the sort. `capture.mjs` has always done this and says why.

`tools/countdown.mjs` prints one standing **WARN** that is deliberately not a
failure: the start grid on cone-canyon stands on a boost strip, so the flag
hands the whole field a `pad` boost, landing on the same frame the rocket start
is evaluated. That is a course-layout defect rather than the timing one the test
guards, and it belongs to `courses` — see §5.

---

## 5. What is owed, in order

1. **courses** — re-judge. It is at 6.5 and the gap is measured: give each
   circuit a layout signature that survives being reduced to its map outline,
   and prove it with the cover-the-names test on the four map cards. **Also
   move the start grid off the boost strip** — `tools/countdown.mjs` warns
   about it on every run. The grid sits at `startDistance - 12` and reads
   `surface: 'boost'`, so the flag hands every racer a free `pad` boost on the
   exact frame `evaluateStart` grades the rocket start, which means the
   mechanic the countdown exists for is being drowned out by a shove nobody
   earned. Either the strip moves or the grid does.
2. **perf** — re-run. At 7.0. Take `crowd` off the mid-race ladder and put it
   under the same seam rule the render scale obeys: set once at `reset()`, never
   moved while `race.phase === 'racing'`.
3. **Closing verdicts on wave 1** — feel, camera, track, look, cast were merged
   long ago and never judged. The board still shows them as `review`.
4. **A coherence pass** for the gaps no single piece owns: the purple tier-3
   mini-turbo has never been seen by anyone; a single carried item is not drawn
   in the world at all, because the orbit rig is only built for `count > 1`; the
   finish letterbox guillotines the position badge on the one beat it matters.
5. **A phone critic.** `tools/phone.mjs` passes, but no critic has ever *played*
   this on glass. The touch layer shipped straight to `main` off a bug report,
   unjudged.
