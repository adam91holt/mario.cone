#!/usr/bin/env node
/**
 * qualitydiff.mjs — prove that quality never touches the race.
 *
 * The quality ladder (src/core/quality.ts) turns shadows, draw distance,
 * particle density and post-processing up and down while the game is running.
 * The one thing it may never do is change who wins, and "may never" is worth
 * nothing as an intention — so this runs the *same seed* at both ends of the
 * ladder, steps both by hand through the deterministic fixed timestep, and
 * diffs the snapshots position by position.
 *
 * A pass means every racer was in the same place, at the same speed, in the
 * same place in the order, at every checkpoint along the way. A fail prints the
 * first racer that drifted and by how much.
 *
 * It also reports the frame bill at each rung, which is the other half of the
 * argument: a ladder that changes nothing costs nothing and is not a ladder.
 *
 * Usage
 *   node tools/qualitydiff.mjs
 *   node tools/qualitydiff.mjs --seconds 40 --seed 7 --course jackhammer-quarry
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const SECONDS = Number(opt('seconds', 30));
const SEED = Number(opt('seed', 7));
const COURSE = opt('course', 'cone-canyon');
const VEHICLE = opt('vehicle', 'cone');
/** Sim seconds between checkpoints. A drift shows up sooner than the finish. */
const GRAIN = 5;

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180_000 });

const call = (fn, ...args) =>
  page.evaluate(([f, a]) => {
    const r = window.__GAME[f](...a);
    return r instanceof Promise ? r.then(() => null) : (r ?? null);
  }, [fn, args]);

/**
 * One run: reset, pin a rung, autopilot, and snapshot every `GRAIN` seconds.
 *
 * Autopilot on the player as well as the CPUs, so the whole field is driven by
 * the simulation and nothing depends on an input schedule. `step()` never
 * renders, so the run costs the same at every rung — which is the point: if the
 * rung could reach the simulation, only stepping would still expose it.
 *
 * ── The whole run happens inside one `page.evaluate` ────────────────────────
 *
 * This is not tidiness, it is the only way the comparison means anything. The
 * engine's rAF loop is still running in the page and steps the simulation off
 * the *wall* clock — see the note on timing the reel in ARCHITECTURE.md — so a
 * run assembled out of Node round trips advances the race by however long each
 * round trip happened to take, and the two runs then differ by a few hundred
 * milliseconds of real time rather than by anything to do with quality.
 *
 * The first two cuts of this file did exactly that and reported a determinism
 * failure that was entirely their own: twenty-seven metres of "divergence" at
 * five seconds, on a build where nothing in the simulation reads `ctx.quality`
 * at all. `setTimeScale(0)` is not enough on its own either — there is still a
 * window between `reset()` resolving and the next round trip landing.
 *
 * Inside a single evaluate there is no window. `await` on an already-resolved
 * promise drains microtasks; a rAF callback is a *task* and cannot run during
 * that drain. So the run below is one uninterrupted block of JavaScript, and
 * the only thing that steps the simulation is `step()`.
 */
async function run(rung) {
  const result = await page.evaluate(async ([r, opts, seconds, grain]) => {
    const g = window.__GAME;
    // **Autopilot goes on before the reset, not after.**
    //
    // `startRace` reattaches a held autopilot *inside* `buildField`, between the
    // seeded RNG being installed and the AI system's own `reset` forking it —
    // so a race started with autopilot already on and a race that has it
    // switched on a moment later draw from different points in the stream and
    // are different races. The control run in this tool is what caught it: two
    // runs at the *same* rung disagreed by twenty metres at five seconds,
    // because one of them was the first race in the page and the other was not.
    //
    // Turning it on first makes every run here the second kind. (The same trap
    // is live in capture.mjs, which resets and then enables autopilot: its first
    // shot is driven by a player AI the AI system never configured, and every
    // shot after it by one it did.)
    g.setAutopilot(true);
    await g.reset(opts);
    g.setTimeScale(0);
    if (!globalThis.__QUALITY) throw new Error('__QUALITY missing — is the quality system registered?');
    globalThis.__QUALITY.set(r);

    const marks = [];
    for (let t = 0; t < seconds; t += grain) {
      g.step(grain);
      const snap = g.snapshot();
      marks.push({
        t: t + grain,
        racers: snap.racers.map((x) => ({
          id: x.id, pos: x.pos, speed: x.speed, place: x.place,
          lap: x.lap, progress: x.progress, coins: x.coins,
          surface: x.surface, item: x.item, stunned: x.stunned,
        })),
        standings: snap.race?.standings ?? [],
      });
    }
    // The frame bill at this rung, measured on a real drawn frame.
    g.render();
    return { marks, stats: g.stats(), probe: globalThis.__QUALITY.probe() };
  }, [rung, { courseId: COURSE, vehicleId: VEHICLE, seed: SEED, instant: true }, SECONDS, GRAIN]);
  return result;
}

/** Every way two runs can disagree about the race, as a list of strings. */
function diff(a, b) {
  const out = [];
  for (let i = 0; i < a.marks.length; i++) {
    const ma = a.marks[i];
    const mb = b.marks[i];
    if (!mb) { out.push(`t=${ma.t}s missing from the second run`); continue; }
    if (String(ma.standings) !== String(mb.standings)) {
      out.push(`t=${ma.t}s standings differ: [${ma.standings}] vs [${mb.standings}]`);
    }
    for (let j = 0; j < ma.racers.length; j++) {
      const ra = ma.racers[j];
      const rb = mb.racers[j];
      const d = Math.max(
        Math.abs(ra.pos[0] - rb.pos[0]),
        Math.abs(ra.pos[1] - rb.pos[1]),
        Math.abs(ra.pos[2] - rb.pos[2]),
      );
      // Snapshots are rounded to 1e-3, so anything at or under that is the
      // rounding and not a divergence. Nothing else is forgiven.
      if (d > 0.001) out.push(`t=${ma.t}s racer ${ra.id} moved ${d.toFixed(4)}m`);
      if (ra.progress !== rb.progress) {
        out.push(`t=${ma.t}s racer ${ra.id} progress ${ra.progress} vs ${rb.progress}`);
      }
      if (ra.place !== rb.place) {
        out.push(`t=${ma.t}s racer ${ra.id} place ${ra.place} vs ${rb.place}`);
      }
      if (ra.lap !== rb.lap || ra.coins !== rb.coins || ra.item !== rb.item) {
        out.push(`t=${ma.t}s racer ${ra.id} race state differs`);
      }
    }
  }
  return out;
}

const TOP = 0;
/** The last rung, whatever the ladder currently is. Hardcoding an index here
 *  meant that adding a rung silently stopped this tool testing the extreme —
 *  which is the only pair worth testing. */
const BOTTOM = (await page.evaluate(() => globalThis.__QUALITY?.ladder?.length ?? 5)) - 1;
console.log(`\nqualitydiff — seed ${SEED}, ${COURSE}, ${SECONDS}s, rungs ${TOP} vs ${BOTTOM}\n`);

const a = await run(TOP);
const b = await run(BOTTOM);
// The control. Two runs at the *same* rung must be identical, or the tool is
// measuring itself and any verdict it reaches about quality is worthless.
const control = await run(TOP);

const failures = diff(a, b);
const controlFailures = diff(a, control);

const row = (label, r) => {
  const s = r.stats;
  console.log(
    `  ${label.padEnd(7)} ${String(r.probe.label).padEnd(6)}` +
    ` shadow ${String(r.probe.shadowSize).padStart(4)}` +
    ` dd ${r.probe.drawDistance.toFixed(2)}` +
    ` particles ${r.probe.particles.toFixed(2)}` +
    ` | ${String(s.drawCalls).padStart(4)} calls` +
    ` ${String(s.triangles).padStart(7)} tris` +
    ` | sim ${String(s.meanSimMs).padStart(6)}ms draw ${String(s.meanDrawMs).padStart(8)}ms`,
  );
};
console.log('── the bill ──────────────────────────────────────────────────');
row(`rung ${TOP}`, a);
row(`rung ${BOTTOM}`, b);

const cut = (x, y) => (x > 0 ? `${(((x - y) / x) * 100).toFixed(0)}%` : 'n/a');
console.log(
  `  saved   ${cut(a.stats.drawCalls, b.stats.drawCalls)} of the draw calls, ` +
  `${cut(a.stats.triangles, b.stats.triangles)} of the triangles`,
);

console.log('\n── determinism ───────────────────────────────────────────────');
console.log(`  ${a.marks.length} checkpoints x ${a.marks[0]?.racers.length ?? 0} racers`);

if (controlFailures.length) {
  console.error(`\nCONTROL FAILED — two runs at rung ${TOP} disagree in ${controlFailures.length} place(s).`);
  console.error('  The tool, the seed or the simulation is unstable; the quality diff below means nothing.');
  for (const f of controlFailures.slice(0, 6)) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`  control: two runs at rung ${TOP} are byte-identical.`);
}

if (failures.length) {
  console.error(`\nQUALITY CHANGED THE RACE — ${failures.length} difference(s):`);
  for (const f of failures.slice(0, 12)) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log('  identical at every checkpoint: position, speed, lap, place, coins, item.');
  console.log('\nPASSED\n');
}

if (pageErrors.length) {
  console.error(`\n${pageErrors.length} page error(s):`);
  for (const e of pageErrors.slice(0, 6)) console.error(`  ✗ ${e}`);
  process.exitCode = 1;
}

await browser.close();
await server.close();
