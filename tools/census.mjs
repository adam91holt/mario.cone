#!/usr/bin/env node
/**
 * census.mjs — the drift census.
 *
 * The instrument the course roster is judged on, and the one a screenshot
 * cannot replace. A fixed-seed autopilot lap on each circuit, same field, same
 * physics, only the road changing, counting across the whole grid:
 *
 *   * drifts started, per racer per lap
 *   * tier-3 (purple) mini-turbo fires
 *   * the longest single slide anybody holds
 *   * why every drift that ended, ended — read off `__AI.tally()`
 *
 * The last of those is the one that stops a course round being guesswork. A
 * lap can be short of drifts because the corners are too wide to need one
 * (`gripV` never falls under the gate), because they are too tight to hold one
 * (`inside`), because they open under the slide (`strain`), or because the
 * field is simply crashing into each other (`hit`) — and those four have
 * nothing to do with each other. The histogram says which.
 *
 * Usage
 *   node tools/census.mjs
 *   node tools/census.mjs --courses cone-canyon
 *   node tools/census.mjs --corners        # per-corner radii as the AI sees them
 *   node tools/census.mjs --seed 12345
 *
 * Reading it: the pass marks are >= 8 drifts per racer per lap, and at least
 * one racer holding a slide past 2.5s. Note that the second of those is not a
 * property of the road — see the `endings` line, and `patience` in
 * `ai/driver.ts`.
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
const flag = (n) => argv.includes(`--${n}`);

const COURSES = opt('courses', 'cone-canyon,jackhammer-quarry,saltpan-bypass,switchback-summit').split(',');
const SEED = Number(opt('seed', 20250811));
const CORNERS = flag('corners');

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => console.error('  pageerror:', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180_000 });

const rows = [];

for (const courseId of COURSES) {
  await page.evaluate(async ([c, seed]) => {
    await window.__GAME.reset({ courseId: c, vehicleId: 'cone', seed, instant: true });
    window.__GAME.setAutopilot(true);
  }, [courseId, SEED]);

  // The whole measurement runs inside one `page.evaluate`. Stepping the sim
  // from Node would be a round trip per sample, and the sample rate has to be
  // fine enough to time a slide that lasts a second and a half.
  const result = await page.evaluate(({ wantCorners }) => {
    const G = window.__GAME;
    const DT = 1 / 60;

    // Settle: run out the opening lap, so what is counted is a lap driven at
    // racing speed rather than a standing start and a first-corner pile-up.
    const lapOf = () => G.snapshot().racers.find((r) => r.isPlayer).lap;
    let guard = 0;
    const start = lapOf();
    while (lapOf() <= start && guard < 120 * 120) { G.step(DT); guard += 2; }

    const st = new Map();
    const out = new Map();
    let elapsed = 0;
    const lapAt = lapOf();
    guard = 0;
    while (lapOf() <= lapAt && guard < 120 * 240) {
      G.step(DT); guard += 2; elapsed += DT;
      for (const r of G.snapshot().racers) {
        let o = out.get(r.id);
        if (!o) out.set(r.id, (o = { name: r.name, drifts: 0, t3: 0, longest: 0, driftTime: 0 }));
        let s = st.get(r.id);
        if (!s) st.set(r.id, (s = { active: false, t: 0, maxTier: 0 }));
        if (r.drift.active) {
          if (!s.active) { s.active = true; s.t = 0; s.maxTier = 0; o.drifts++; }
          s.t += DT; o.driftTime += DT;
          if (r.drift.tier > s.maxTier) s.maxTier = r.drift.tier;
          if (s.t > o.longest) o.longest = s.t;
        } else if (s.active) {
          if (s.maxTier >= 3) o.t3++;
          s.active = false;
        }
      }
    }
    for (const [id, s] of st) if (s.active && s.maxTier >= 3) out.get(id).t3++;

    const snap = G.snapshot();
    return {
      track: snap.track,
      lapSeconds: elapsed,
      racers: [...out.values()],
      tally: window.__AI ? window.__AI.tally() : [],
      corners: wantCorners && window.__AI
        ? window.__AI.corners(snap.racers.find((r) => !r.isPlayer).id)
        : [],
      errors: G.errors.slice(0, 5),
    };
  }, { wantCorners: CORNERS });

  const n = result.racers.length;
  const drifts = result.racers.reduce((a, r) => a + r.drifts, 0);
  const t3 = result.racers.reduce((a, r) => a + r.t3, 0);
  const longest = Math.max(...result.racers.map((r) => r.longest));
  const perRacer = drifts / n;
  rows.push({ name: result.track.name, drifts, t3, perRacer, longest });

  console.log(`\n══ ${result.track.name}  (${Math.round(result.track.length)}m, lap ${result.lapSeconds.toFixed(1)}s, ${n} racers) ══`);
  console.log('  racer            drifts  tier3  longest  drift-s');
  for (const r of result.racers.sort((a, b) => b.drifts - a.drifts)) {
    console.log(`  ${r.name.padEnd(16)} ${String(r.drifts).padStart(6)} ${String(r.t3).padStart(6)} ${r.longest.toFixed(2).padStart(8)} ${r.driftTime.toFixed(1).padStart(8)}`);
  }
  console.log(`  TOTAL  drifts ${drifts}  (${perRacer.toFixed(1)}/racer)   tier3 ${t3}   longest held ${longest.toFixed(2)}s`);
  if (result.errors.length) console.log('  errors:', result.errors);

  if (result.tally.length) {
    const why = {};
    let maxTier = 0;
    for (const t of result.tally) {
      for (const [k, v] of Object.entries(t.why || {})) why[k] = (why[k] || 0) + v;
      if (t.maxTier > maxTier) maxTier = t.maxTier;
    }
    const mean = (f) => (result.tally.reduce((a, t) => a + f(t), 0) / result.tally.length).toFixed(1);
    console.log(`  drift share ${mean((t) => t.driftPct)}%  offroad ${mean((t) => t.offPct)}%  maxTier ${maxTier}  endings: ` +
      Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('  '));
  }

  if (CORNERS && result.corners.length) {
    console.log('\n   #     at    d0    len  Rline  Rroad   dir   entry  apex  tier');
    for (const c of result.corners) {
      console.log(`  ${String(c.i).padStart(2)}  ${(c.d0 / result.track.length).toFixed(3)} ${String(c.d0).padStart(5)} ` +
        `${String(c.len).padStart(6)} ${String(c.radius).padStart(6)} ${String(c.rRoad).padStart(6)}  ` +
        `${c.dir.padEnd(5)} ${String(c.entry).padStart(6)} ${String(c.apex).padStart(5)} ${String(c.driftTier).padStart(5)}`);
    }
  }
}

console.log('\n══ SUMMARY ══');
console.log('  course                 drifts  /racer  tier3  longest');
for (const r of rows) {
  console.log(`  ${r.name.padEnd(22)} ${String(r.drifts).padStart(6)} ${r.perRacer.toFixed(1).padStart(7)}` +
    `${r.perRacer >= 8 ? '✓' : '✗'} ${String(r.t3).padStart(6)} ${r.longest.toFixed(2).padStart(8)}${r.longest >= 2.5 ? '✓' : '✗'}`);
}
console.log();

await browser.close();
await server.close();
