#!/usr/bin/env node
/**
 * capture.mjs — drive the real game headlessly and photograph it.
 *
 * This is how every reviewer sees the game. It boots a Vite dev server, loads
 * the page in headless Chromium, and drives the simulation through
 * `window.__GAME` — the deterministic step API — rather than in realtime. That
 * matters: this container renders through SwiftShader (software GL), so a
 * realtime capture would produce different frames on every run. Stepping the
 * fixed timestep by hand makes "4.0 seconds into the race" mean exactly one
 * thing.
 *
 * Usage
 *   node tools/capture.mjs --smoke              boot, drive, assert, exit non-zero on failure
 *   node tools/capture.mjs                      write the standard review sheet to shots/
 *   node tools/capture.mjs --out dir/           choose the output directory
 *   node tools/capture.mjs --only drift,boost   capture just those shots
 *   node tools/capture.mjs --list               list available shots
 *   node tools/capture.mjs --width 1600 --height 900
 *   node tools/capture.mjs --vehicle plane --course cone-canyon
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');

// ── argument parsing ───────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OPTIONS = {
  smoke: flag('smoke'),
  list: flag('list'),
  out: opt('out', 'shots'),
  only: opt('only', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  width: Number(opt('width', 1600)),
  height: Number(opt('height', 900)),
  vehicle: opt('vehicle', 'cone'),
  course: opt('course', 'cone-canyon'),
  seed: Number(opt('seed', 1)),
  keep: flag('keep'),
  quiet: flag('quiet'),
};

const log = (...a) => { if (!OPTIONS.quiet) console.log(...a); };

// ── the standard review sheet ──────────────────────────────────────────────
//
// Each shot is a named recipe run against a freshly reset race. Add shots here
// when you add a feature that needs looking at — a feature with no shot is a
// feature no reviewer will ever see.

// `step()` advances the simulation without drawing, which costs almost nothing;
// `advance()` renders every frame, which under software GL is the entire budget.
// So each shot fast-forwards with step() and only renders the last moment, long
// enough for the visual springs (camera, squash, dip) to settle. They are all
// framerate-independent, so the settled frame is identical either way.
const SETTLE = 0.9;

// ── driving to the shot ────────────────────────────────────────────────────
//
// **A shot recipe that can land off-road is a recipe that will.** Three of the
// nine frames on this sheet used to be composed by steering blind from a
// standing start — `drift` held 0.85 of lock and the drift button for 4.2s and
// photographed whatever that produced, which was the kart on the dirt shoulder
// in eighth place with the WRONG WAY alarm across the middle of the frame.
// `boost` did the same and landed twenty metres off the road grinding along a
// barrier. `pack`, captioned "do the racers read apart from each other at
// speed", put the player on autopilot from the back of the grid for sixteen
// seconds and photographed them completely alone.
//
// Nine frames are the entire visual record this project is reviewed from, and a
// third of them were of a kart that had left the circuit. So the recipes below
// *drive to the shot*: hand the kart to the CPU driver, which knows the racing
// line, and only take it back at the moment the shot needs a human input. The
// helpers are here rather than inline because every recipe wants the same two
// things — be somewhere real, and be somewhere real *with the field*.

/** Autopilot up to speed on the racing line, then hand back to the recipe. */
async function rideTo(game, seconds) {
  await game.setAutopilot(true);
  await game.step(seconds);
  await game.setAutopilot(false);
}

/**
 * Drive — really drive, on the CPU's own racing line — until the moment this
 * shot is *of* actually happens, then stop.
 *
 * This is the difference between a recipe and a photograph. "Hold 0.85 of lock
 * and the drift button for 4.2 seconds from a standing start" is not a
 * description of a drift, it is a description of an input, and what it produced
 * was a kart on the dirt shoulder in eighth place under a WRONG WAY alarm.
 * "Keep going until the kart is sideways with a charge on it" is a description
 * of the subject, and it cannot land anywhere else.
 *
 * Still deterministic: the same seed steps the same simulation and the
 * predicate goes true on the same fixed step every run. It is only the *number*
 * of seconds that stops being hardcoded, and that number was never the point.
 */
async function rideUntil(game, test, limit = 34, grain = 0.1) {
  await game.setAutopilot(true);
  for (let t = 0; t < limit; t += grain) {
    await game.step(grain);
    const snap = await game.snapshot();
    const p = snap.racers.find((r) => r.isPlayer);
    if (p && test(p, snap)) return p;
  }
  return null;
}

/**
 * Let the visual springs settle **without moving the simulation.**
 *
 * `render()` runs every `update()` — camera boom, drift swing, FOV kick,
 * particles — and never calls `stepFixed`, so the look of the world catches up
 * while the world itself holds still. That distinction is the whole reason a
 * shot of a transient state is possible at all: `advance(0.9)` settles the
 * camera beautifully and spends nine tenths of a second of race doing it, which
 * is longer than a mini-turbo charge lasts. The drift shot came back as the
 * boost shot twice before this existed.
 *
 * **The time scale is what actually holds it still.** The engine's own rAF loop
 * is still running in the page and steps the simulation off the *wall* clock —
 * see the note on timing the reel in ARCHITECTURE.md — so twenty-eight round
 * trips at 150-300ms each is four to eight seconds of real time, and four to
 * eight seconds of race, quietly happening underneath a settle that believes it
 * froze the frame. Measured: the `drift` shot photographed a genuine drift and
 * then reported `driftTier: 0` and `boosting: false` in the index, because by
 * the time the snapshot was taken the kart was a corner further on.
 *
 * Deliberately left frozen. The screenshot and the index snapshot happen after
 * the recipe returns and cost another few hundred milliseconds each, so putting
 * the clock back here would hand the race exactly the seconds this exists to
 * take away from it. Every shot begins with `reset()`, and the race director
 * puts `time.scale` back to 1 in its own reset — so the freeze cannot leak into
 * the next recipe.
 */
async function settle(game, frames = 28) {
  await game.setTimeScale(0);
  for (let i = 0; i < frames; i++) await game.render();
}

/** Metres to the nearest other machine, and how many are within `r`. */
function crowding(snap, r = 34) {
  const me = snap.racers.find((x) => x.isPlayer);
  if (!me) return 0;
  let n = 0;
  for (const o of snap.racers) {
    if (o.isPlayer) continue;
    const d = Math.hypot(o.pos[0] - me.pos[0], o.pos[2] - me.pos[2]);
    if (d < r) n++;
  }
  return n;
}

const SHOTS = [
  {
    name: 'grid',
    caption: 'Start grid, pre-countdown. Framing, model quality, lighting, ground contact.',
    async run(game) {
      await game.reset({ instant: false });
      await game.advance(0.6);
    },
  },
  {
    name: 'countdown',
    caption: 'Countdown beat. HUD punch and the pre-race camera.',
    async run(game) {
      await game.reset({ instant: false });
      await game.seek('countdown');
      await game.step(1.6);
      await game.advance(0.8);
    },
  },
  {
    name: 'racing',
    caption: 'Flat out on a racing line. The default view a player spends the race in.',
    async run(game) {
      await game.reset({ instant: true });
      await game.setAutopilot(true);
      await game.step(9);
      await game.advance(SETTLE);
    },
  },
  {
    name: 'drift',
    caption: 'Mid-drift with a charged mini-turbo. Sparks, chassis angle, camera offset.',
    async run(game) {
      // The subject is a committed, charged drift on the circuit — so drive
      // until there is one. The CPU driver picks the corner, which is the whole
      // point: the frame is of the game drifting, not of a script steering.
      await game.reset({ instant: true });
      await rideUntil(game,
        (p) => p.drift.active && p.drift.tier >= 1 && p.surface === 'road');
      // Settled without advancing the race. A settle long enough to let the
      // camera springs arrive is also long enough for the drift to end and the
      // mini-turbo to fire, and then this is the boost shot with a different
      // caption — which is what the first two attempts at this recipe produced.
      await settle(game);
    },
  },
  {
    name: 'boost',
    caption: 'The frame right after a mini-turbo fires. FOV kick, flames, speed cues.',
    async run(game) {
      // Likewise: wait for a real mini-turbo to fire rather than manufacturing
      // one at a place on the circuit that cannot absorb it.
      await game.reset({ instant: true });
      await rideUntil(game,
        (p) => p.boost.time > 0 && String(p.boost.source ?? '').startsWith('drift'));
      // Immediately — the boost frame is the point, and the kick decays.
      await settle(game);
    },
  },
  {
    name: 'pack',
    caption: 'Mid-pack traffic. Do the racers read apart from each other at speed?',
    async run(game) {
      // The subject of this shot is the *other* machines. The player starts
      // eighth of eight, and eighth of eight on a clean lap is alone — this
      // recipe used to photograph an empty circuit under a caption asking
      // whether the racers read apart from each other. So it waits for traffic:
      // three machines inside thirty-four metres, at speed, on the road.
      await game.reset({ instant: true });
      // Past the start-line scramble — everybody is crowded on the grid, and a
      // photograph of the grid is a different shot on this sheet already.
      await rideUntil(game,
        (p, snap) => p.progress > 320 && p.speed > 42 && crowding(snap) >= 3, 40);
      await game.advance(SETTLE);
    },
  },
  {
    name: 'overhead',
    caption: 'Track layout from above. Course design, silhouette, world dressing.',
    async run(game) {
      await game.reset({ instant: true });
      await game.setAutopilot(true);
      await game.step(6);
      await game.setCamera('overhead');
      await game.advance(0.3);
    },
  },
  {
    name: 'offroad',
    caption: 'Off the road surface. Does leaving the track look and feel punishing?',
    async run(game) {
      // The one shot on this sheet that is *supposed* to end in the gravel —
      // but from racing speed on a real part of the circuit, because the
      // question is what leaving the road costs, not what a standing start into
      // the verge looks like.
      await game.reset({ instant: true });
      await rideTo(game, 6);
      await game.setInput({ accel: 1, steer: -1 });
      await game.step(1.2);
      await game.advance(0.8);
    },
  },
  {
    name: 'pause',
    caption: 'Paused mid-race: the pause plate, and the controls card that now lives here.',
    async run(game) {
      // The controls card moved off the start grid and onto pause, and pause had
      // no shot — so the card, the only place this game explains itself, was
      // reviewable nowhere. It is also the one frame where two signs are on
      // screen together, which is how the four hand-copies of the plate were
      // caught disagreeing in the first place.
      await game.reset({ instant: true });
      await rideTo(game, 7);
      await game.press('pause');
      await game.advance(0.8);
    },
  },
  {
    name: 'finish',
    caption: 'Half a second after winning: bars landed on a cleared HUD, the winner centred, confetti up.',
    async run(game) {
      // **Driven with `advance`, not `step`.**
      //
      // This recipe used to `step(3.4)` and then `advance(0.6)`, and `step()` is
      // pure sim — it never calls `update()`. So every visual clock in the
      // finish beat (the letterbox `t`, the HUD's retire, the banner, the
      // confetti, the curtain wipe) was frozen for the whole of those 3.4
      // seconds and then started from zero on the trailing advance: the
      // published `shots/finish.png` was a composite no player could ever
      // reach, four seconds of race with six tenths of a second of interface on
      // top. That is why "the HUD is sliced by the letterbox" was reported and
      // "fixed" more than once — the shot that was supposed to prove it never
      // showed the real timing in either direction.
      //
      // `advance` steps the simulation and renders every frame from the same
      // delta, so the beat is photographed at the moment it actually looks like
      // this. `__RACE.flag` stays: a race cannot be driven to a first place on
      // demand, and it runs the real branch.
      //
      // **And the page's own clock is stopped first.** The engine's rAF loop is
      // still running underneath the harness and steps the simulation off the
      // wall clock (see the note on `settle` below); under software GL a single
      // round trip is most of a second of race, so an unfrozen `advance(0.9)`
      // landed anywhere between the crossing and the hand-off curtain depending
      // on how busy the machine was — twice it photographed a beat that was
      // four seconds old with the confetti already spent. With the scale at
      // zero the only thing that moves the race is `advance`, which steps and
      // renders from the same delta, so half a second into the beat means half a
      // second: bars landed, instruments gone, banner slammed, confetti in the
      // air. Photographed at 0.9 the storm has already crossed the frame.
      // The flag and the beat go in **one** round trip, and the page's own clock
      // is stopped first. Both halves of that matter. Every round trip under
      // software GL is a large fraction of a second, and the rAF loop underneath
      // the harness spends it stepping the simulation *and* ageing the
      // particles; split across two calls, the confetti was a second and a half
      // old — thirty metres down the road — before the first frame of the beat
      // was ever drawn, and the shot came back as an empty win.
      // The clock is stopped **before the ride**, not after it. `step()` drives
      // the simulation directly and ignores the scale, so the ride is unchanged
      // — but the page's rAF loop is then contributing nothing, and "nine
      // seconds in" means the same corner of the circuit on every machine
      // instead of wherever four round trips of software-GL latency happened to
      // leave the kart. Measured before this line existed: the same recipe
      // photographed 1:41 and 2:30 of the same race on two consecutive runs.
      await game.reset({ instant: true });
      await game.setTimeScale(0);
      await rideTo(game, 9);
      await game.evaluate(() => {
        globalThis.__RACE.flag(1);
        window.__GAME.advance(0.5, 20);
      });
    },
  },
  {
    name: 'results',
    caption: 'The results sheet: finishing order, machines, championship, podium behind it.',
    async run(game) {
      // **A real race, run to a real flag.** This shot is about what is printed
      // on the sheet — the order, the gaps, the machines, the points — and
      // every one of those was a fiction while the recipe forced the flag nine
      // seconds into lap one: the whole field was force-finished on one frame
      // and the times came out of the estimator rather than out of the race.
      //
      // Three laps of autopilot is one round trip per `step()` and no rendered
      // frames at all, which is the cheapest part of this whole sheet.
      await game.reset({ instant: true });
      await game.setAutopilot(true);
      for (let i = 0; i < 40; i++) {
        await game.step(8);
        const snap = await game.snapshot();
        if (snap.race?.phase === 'results') break;
      }
      // ...and then let the sheet actually arrive: the rows land one at a time
      // off a clock integrated from the render delta, so a sheet photographed
      // without rendered frames is a sheet with nothing on it. 2.2s is past the
      // last championship total finishing its climb.
      await game.advance(2.2);
    },
  },
  {
    name: 'far',
    caption: 'Pulled-back chase. Reads the environment and horizon, not just the kart.',
    async run(game) {
      await game.reset({ instant: true });
      await game.setAutopilot(true);
      await game.step(11);
      await game.setCamera('far');
      await game.advance(SETTLE);
    },
  },
];

// ── browser-side driver ────────────────────────────────────────────────────

/**
 * Wraps window.__GAME in an await-able facade. Every call round-trips into the
 * page, which keeps the node side ignorant of game internals.
 */
function makeGameProxy(page) {
  const call = (fn, ...args) =>
    page.evaluate(
      ([f, a]) => {
        const g = window.__GAME;
        if (!g) throw new Error('window.__GAME missing');
        const result = g[f](...a);
        return result instanceof Promise ? result.then(() => null) : (result ?? null);
      },
      [fn, args],
    );

  return {
    reset: (opts = {}) => call('reset', { vehicleId: OPTIONS.vehicle, courseId: OPTIONS.course, seed: OPTIONS.seed, ...opts }),
    step: (s) => call('step', s),
    render: () => call('render'),
    // Default to 20 rendered frames per simulated second rather than 60. The
    // simulation still steps at the full 120Hz — only the number of *rendered*
    // frames drops, which is what costs time on a software renderer. Every
    // visual spring in the game is framerate-independent, so the settled frame
    // we photograph is the same either way.
    advance: (s, fps = 20) => call('advance', s, fps),
    setInput: (i) => call('setInput', i),
    clearInput: () => call('clearInput'),
    press: (n) => call('press', n),
    setCamera: (m) => call('setCamera', m),
    setQuality: (q) => call('setQuality', q),
    setAutopilot: (on) => call('setAutopilot', on),
    setTimeScale: (s) => call('setTimeScale', s),
    seek: (p) => call('seek', p),
    stats: () => call('stats'),
    snapshot: () => call('snapshot'),
    /**
     * The frame budget, judged.
     *
     * `stats()` says what a frame cost; this says what it was *allowed* to
     * cost and whether it did. The ceilings live in `src/core/quality.ts`
     * beside the ladder that spends against them rather than here, so the
     * number a reviewer reads in the file is the number the gate applies —
     * three tables in that file once disagreed with each other and with the
     * game, and a gate with a fourth copy of the numbers would have been a
     * fourth thing to keep in step.
     */
    gate: () => page.evaluate(() => globalThis.__QUALITY?.gate?.() ?? null),
    /** Run a function in the page. For the reviewer's-bench front doors —
     *  `__RACE.flag()` and friends — which reach states no amount of driving
     *  can. Everything a *player* can do goes through the harness above. */
    evaluate: (fn) => page.evaluate(fn),
    errors: () => page.evaluate(() => window.__GAME?.errors ?? []),
  };
}

async function withPage(fn) {
  const server = await createServer({
    root: ROOT,
    logLevel: 'error',
    // No HMR and no file watcher. A full sheet takes four minutes under
    // software GL, and a source edit made while one is running otherwise
    // navigates the page out from under it — the capture then fails on a
    // timeout waiting for a `__GAME` that a half-saved module never installed,
    // which reads exactly like a boot failure and is not one.
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    // A dev server needs no bundling pass, so iteration stays fast.
    optimizeDeps: { include: ['three'] },
  });
  await server.listen();
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}/index.html`;

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-gpu-blocklist',
      '--hide-scrollbars',
    ],
  });

  const page = await browser.newPage({
    viewport: { width: OPTIONS.width, height: OPTIONS.height },
    deviceScaleFactor: 1,
  });

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Boot compiles shaders under software GL, which is slow — be patient.
    await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120_000 });
    return await fn(page, makeGameProxy(page), consoleErrors);
  } finally {
    await browser.close();
    await server.close();
  }
}

// ── modes ──────────────────────────────────────────────────────────────────

async function runSmoke() {
  return withPage(async (page, game, consoleErrors) => {
    const failures = [];

    // Autopilot, so this asserts the kart can actually race the course rather
    // than that it can accelerate into the first barrier. Same step-then-settle
    // shape as the shots: rendering all twelve seconds costs more than the whole
    // rest of the suite and proves nothing extra.
    //
    // **The page's own clock is stopped first**, for the reason the `finish`
    // recipe spells out at length: the engine's rAF loop keeps stepping the
    // simulation off the wall clock between round trips, and under software GL
    // a round trip is most of a second of race. That was tolerable while this
    // function only asserted "the kart is moving"; it is not tolerable now that
    // it enforces a frame budget, because the frame the budget is judged on has
    // to be the *same frame* every run. Measured before this line existed: two
    // consecutive smokes of this identical recipe photographed 542m and 614m of
    // progress and **381 and 323 draw calls** — a 15% spread on the number the
    // gate fails the build over. With it, three runs measured 379, 381 and 381.
    // `step()` and `advance()` drive the simulation directly and ignore the
    // scale, so the ride itself is unchanged.
    //
    // It does not make the frame *identical* — progress still lands anywhere in
    // a fifty-metre band, so something in the loop is still ageing the world
    // between round trips — and the remaining 2.7% of spread in the triangle
    // count is carried by the ceiling rather than papered over. See `RUNG0`.
    await game.reset({ instant: true });
    await game.setTimeScale(0);
    await game.setAutopilot(true);
    await game.step(11);
    await game.advance(1);

    const snap = await game.snapshot();
    const stats = await game.stats();
    const player = snap.racers.find((r) => r.isPlayer);

    if (!player) failures.push('no player racer in snapshot');
    if (player && player.speed < 20) {
      failures.push(`player is not getting up to speed: ${player.speed} m/s after 12s`);
    }
    // 12s of autopilot should cover a good fraction of a lap on any sane course.
    if (player && player.progress < 250) {
      failures.push(`player made little track progress: ${player.progress}m in 12s`);
    }
    if (snap.racers.length < 2) failures.push(`expected a field, got ${snap.racers.length} racer(s)`);
    if (snap.race?.phase !== 'racing') failures.push(`expected phase "racing", got "${snap.race?.phase}"`);
    if (stats.drawCalls === 0) failures.push('nothing was drawn (0 draw calls)');

    // ── the frame budget ──────────────────────────────────────────────────
    //
    // For a long time the line above was the *entire* performance assertion in
    // this project. The smoke printed 452 draw calls and 906,072 triangles two
    // lines further down and asserted nothing about either, so the top rung —
    // the picture every player who is not struggling actually gets — had never
    // had a stated cost, let alone a checked one, while `src/core/quality.ts`
    // grew seven rungs of machinery for degrading it.
    //
    // The ceilings are in `quality.ts` beside the ladder rather than here, and
    // the derivation is with them: 60fps on a mid laptop at 1600x900, a quarter
    // of the frame budgeted for draw-call submission, and a triangle count that
    // is a regression tripwire rather than a limit. This reads them off the
    // game so there is one copy of the numbers.
    //
    // Only enforced on the course and viewport the ceilings were derived on,
    // and only at rung 0 — a governor that has walked down is *supposed* to
    // draw a cheaper frame, and failing a build for that would be reading the
    // instrument upside down. Everywhere else the reading is printed.
    const gate = await game.gate();
    const budgetCourse = OPTIONS.course === 'cone-canyon'
      && OPTIONS.width === 1600 && OPTIONS.height === 900;
    if (!gate) {
      failures.push('__QUALITY.gate() missing — the frame budget cannot be checked');
    } else if (!gate.applies) {
      console.log(`\n  (budget not checked: rung ${gate.rung} at ${gate.scenePx})`);
    } else if (budgetCourse) {
      for (const f of gate.failures) failures.push(`frame budget: ${f}`);
    } else {
      // Said out loud rather than skipped in silence. A gate that quietly does
      // not run reads exactly like a gate that passed, and this one is meant to
      // be the answer to "has anybody costed the frame".
      console.log(`\n  (budget reported, not enforced: ${OPTIONS.course} at `
        + `${OPTIONS.width}x${OPTIONS.height}; the ceilings are stated for `
        + `${gate.target.at})`);
      for (const f of gate.failures) console.log(`    over: ${f}`);
    }

    // Any racer leaving the world means physics or the track query is broken.
    for (const r of snap.racers) {
      if (!Number.isFinite(r.pos[0]) || Math.abs(r.pos[1]) > 500) {
        failures.push(`racer ${r.name} left the world at ${r.pos.join(',')}`);
      }
    }

    const pageErrors = [...consoleErrors, ...(await game.errors())];
    if (pageErrors.length) failures.push(`console errors:\n    ${pageErrors.slice(0, 8).join('\n    ')}`);

    const bar = (have, ceiling) => {
      const pct = ceiling > 0 ? Math.round((have / ceiling) * 100) : 0;
      return `${String(have).padStart(9)} / ${String(ceiling).padEnd(8)} ${pct}%`;
    };
    console.log('\n── smoke ──────────────────────────────────────────');
    console.log(`  phase        ${snap.race?.phase}`);
    console.log(`  racers       ${snap.racers.length}`);
    console.log(`  player speed ${player?.speed} m/s`);
    console.log(`  progress     ${player?.progress} m`);
    if (gate) {
      console.log(`\n  frame budget — ${gate.target.at}`);
      console.log(`    draw calls ${bar(gate.frame.drawCalls, gate.target.drawCalls)}`);
      console.log(`    triangles  ${bar(gate.frame.triangles, gate.target.triangles)}`);
      console.log(`    sim+update ${bar(gate.frame.cpuMs.toFixed(2), gate.target.cpuMs)}`
        + `   (target ${gate.target.cpuTargetMs})`);
      console.log(`    at rung ${gate.rung}, scene ${gate.scenePx}`);
      console.log('    where the draws went   colour  shadow   triangles');
      for (const g of gate.groups.slice(0, 6)) {
        console.log(`      ${g.group.padEnd(18)}${String(g.drawn).padStart(6)}`
          + `${String(g.shadow).padStart(8)}${String(g.triangles).padStart(12)}`);
      }
      // ── and every rung, not only the one the governor is standing on ─────
      //
      // The budget used to be printed for rung 0 alone, which is the rung a
      // struggling machine is trying to get *away* from. A reviewer walked the
      // other six by hand and found every one of them above rung 0 on draw
      // calls, with the first rescue rung 14% over the ceiling — and nothing in
      // the build said so, because nothing in the build had ever looked. The
      // walk is `__QUALITY.gate().ladder`; the assertions on it are in
      // `src/core/quality.ts` beside the ceilings, so there is still one copy
      // of the numbers.
      if (gate.ladder?.length) {
        console.log('    the ladder             calls  triangles  shelled  progs');
        for (const r of gate.ladder) {
          console.log(`      rung ${r.rung} ${r.label.padEnd(12)}`
            + `${String(r.drawCalls).padStart(6)}${String(r.triangles).padStart(11)}`
            + `${String(r.shelled).padStart(9)}${String(r.programs).padStart(7)}`);
        }
      }
    } else {
      console.log(`  draw calls   ${stats.drawCalls}`);
      console.log(`  triangles    ${stats.triangles}`);
    }
    console.log('───────────────────────────────────────────────────');

    if (failures.length) {
      console.error('\nSMOKE FAILED:');
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exitCode = 1;
      return false;
    }
    console.log('\nSMOKE PASSED\n');
    return true;
  });
}

async function runShots() {
  const outDir = path.resolve(ROOT, OPTIONS.out);
  if (existsSync(outDir) && !OPTIONS.keep) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const wanted = OPTIONS.only.length ? SHOTS.filter((s) => OPTIONS.only.includes(s.name)) : SHOTS;
  if (!wanted.length) {
    console.error(`No shots matched --only "${OPTIONS.only.join(',')}"`);
    process.exitCode = 1;
    return;
  }

  return withPage(async (page, game, consoleErrors) => {
    const index = [];

    for (const shot of wanted) {
      const started = Date.now();
      await game.clearInput();
      await shot.run(game);
      await game.render();

      const file = path.join(outDir, `${shot.name}.png`);
      // Not the 30s default. A full-frame DOM overlay — the results sheet is
      // one, edge to edge, with a scrim, sixteen plates and a blend mode on it
      // — takes the software rasteriser well past half a minute to hand back,
      // and a timeout there reads exactly like a crash and is not one.
      await page.screenshot({ path: file, timeout: 180_000 });

      const snap = await game.snapshot();
      const stats = await game.stats();
      const gate = await game.gate();
      const player = snap.racers.find((r) => r.isPlayer);

      index.push({
        name: shot.name,
        caption: shot.caption,
        file: path.relative(ROOT, file),
        phase: snap.race?.phase,
        playerSpeed: player?.speed,
        playerPlace: player?.place,
        playerSurface: player?.surface,
        playerPos: player?.pos,
        cameraPos: snap.camera?.pos,
        drifting: player?.drift?.active,
        driftTier: player?.drift?.tier,
        boosting: (player?.boost?.time ?? 0) > 0,
        drawCalls: stats.drawCalls,
        triangles: stats.triangles,
        // ── what the frame cost, and what it was allowed to cost ───────────
        //
        // `drawCalls` and `triangles` above have been on this sheet for
        // several rounds with nothing to compare them against — a reviewer
        // could read "422 calls" and had no way to know whether that was fine.
        // The budget is the missing half and it comes off the game rather than
        // out of this file; see `RUNG0` in src/core/quality.ts.
        budget: gate && {
          pass: gate.pass,
          applies: gate.applies,
          rung: gate.rung,
          scenePx: gate.scenePx,
          target: gate.target,
          frame: gate.frame,
          failures: gate.failures,
          groups: gate.groups,
        },
        // ── and which system spent the CPU half of it ──────────────────────
        //
        // `stats()` has carried per-system sim and update costs for rounds and
        // nothing published them, so every question of the form "what got
        // slower between these two sheets" was answerable only by rebuilding
        // the old commit. Cheap to record — it is one array of small numbers —
        // and it is the difference between "the frame got slower" and "`fx`
        // got slower".
        systems: stats.systems,
        cpu: {
          meanMs: stats.ms,
          worstMs: stats.worstMs,
          simMs: stats.meanSimMs,
          drawMs: stats.meanDrawMs,
          steps: stats.steps,
        },
      });

      log(`  ✓ ${shot.name.padEnd(10)} ${String(Date.now() - started).padStart(5)}ms  ${path.relative(ROOT, file)}`);
    }

    const errors = [...consoleErrors, ...(await game.errors())];
    await writeFile(
      path.join(outDir, 'index.json'),
      JSON.stringify({ options: OPTIONS, shots: index, errors }, null, 2),
    );

    log(`\n${index.length} shot(s) → ${path.relative(ROOT, outDir)}/`);
    if (errors.length) {
      console.error(`\n${errors.length} console error(s):`);
      for (const e of errors.slice(0, 10)) console.error(`  ✗ ${e}`);
      process.exitCode = 1;
    }
  });
}

// ── entry ──────────────────────────────────────────────────────────────────

if (OPTIONS.list) {
  console.log('\nAvailable shots:\n');
  for (const s of SHOTS) console.log(`  ${s.name.padEnd(12)} ${s.caption}`);
  console.log();
} else if (OPTIONS.smoke) {
  await runSmoke();
} else {
  await runShots();
}
