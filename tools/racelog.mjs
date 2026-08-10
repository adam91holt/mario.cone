#!/usr/bin/env node
/**
 * racelog.mjs — run one whole race headlessly and count what happened.
 *
 * capture.mjs answers "what does one moment look like" and trace.mjs answers
 * "what is the player doing right now". Neither can answer the question that
 * actually decides whether the race is the race the menus are selling: *how
 * often does the field leave the road, hit a wall, and land a mini-turbo, over
 * a whole race, for everybody*.
 *
 * That question has to be asked of the bus rather than of a snapshot, because
 * every one of those things is an edge. So this subscribes to the events and
 * steps the sim to the flag with no rendering at all — which is why a 3-lap,
 * 8-racer race costs about a minute here and twenty under capture.
 *
 * Usage
 *   node tools/racelog.mjs                       Cone Canyon, 8 racers, seed 1
 *   node tools/racelog.mjs --course jackhammer-quarry --seconds 240
 *   node tools/racelog.mjs --json                machine-readable
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const COURSE = opt('course', 'cone-canyon');
const VEHICLE = opt('vehicle', 'cone');
const SEED = Number(opt('seed', 1));
const LIMIT = Number(opt('seconds', 260));
const JSON_OUT = flag('json');

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  // No HMR and no watcher: a race takes minutes to simulate, and a source edit
  // made while one is running otherwise navigates the page out from under it.
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
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

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120_000 });

const call = (fn, ...args) =>
  page.evaluate(([f, a]) => {
    const r = window.__GAME[f](...a);
    return r instanceof Promise ? r.then(() => null) : (r ?? null);
  }, [fn, args]);

await call('reset', { vehicleId: VEHICLE, courseId: COURSE, seed: SEED, instant: true });
// The player is a CPU too, so the count covers the whole field on one line.
await call('setAutopilot', true);

// The tally lives in the page: the bus is synchronous and in-page, and shipping
// every edge over the CDP bridge would cost more than the simulation.
await page.evaluate(() => {
  const bus = window.__CTX.bus;
  const T = { offroad: {}, wall: {}, tier: [0, 0, 0, 0], boost: {}, finish: [] };
  window.__TALLY = T;
  const name = (r) => (r && (r.name ?? String(r.id))) || '?';
  bus.on('kart:offroad', (e) => { const n = name(e.racer); T.offroad[n] = (T.offroad[n] ?? 0) + 1; });
  bus.on('kart:wall', (e) => { const n = name(e.racer); T.wall[n] = (T.wall[n] ?? 0) + 1; });
  bus.on('kart:drift:charge', (e) => { T.tier[e.tier] = (T.tier[e.tier] ?? 0) + 1; });
  bus.on('kart:boost', (e) => { T.boost[e.source] = (T.boost[e.source] ?? 0) + 1; });
  bus.on('race:finish', (e) => {
    T.finish.push({ name: name(e.racer), place: e.place, time: e.time });
  });
});

let t = 0;
let phase = 'racing';
while (t < LIMIT) {
  await call('step', 4);
  t += 4;
  const snap = await call('snapshot');
  phase = snap.race?.phase;
  if (phase === 'results') break;
}

const out = await page.evaluate(() => {
  const T = window.__TALLY;
  const snap = window.__GAME.snapshot();
  return {
    tally: T,
    ai: globalThis.__AI?.tally?.() ?? [],
    racers: snap.racers.map((r) => ({
      name: r.name, place: r.place, lap: r.lap, surface: r.surface,
      progress: Math.round(r.progress),
    })),
  };
});

const keys = [...new Set([...Object.keys(out.tally.offroad), ...Object.keys(out.tally.wall)])];
const result = {
  course: COURSE, seed: SEED, simSeconds: t, phase,
  finish: out.tally.finish,
  spread: out.tally.finish.length > 1
    ? +(out.tally.finish[out.tally.finish.length - 1].time - out.tally.finish[0].time).toFixed(2)
    : null,
  perRacer: keys.map((k) => {
    const ai = out.ai.find((a) => a.name === k);
    return {
      name: k, offroad: out.tally.offroad[k] ?? 0, wall: out.tally.wall[k] ?? 0,
      offPct: ai?.offPct ?? null, driftPct: ai?.driftPct ?? null,
      tierHit: ai?.tierHit ?? null, why: ai?.why ?? null,
    };
  }),
  driftTiers: { 1: out.tally.tier[1] ?? 0, 2: out.tally.tier[2] ?? 0, 3: out.tally.tier[3] ?? 0 },
  boosts: out.tally.boost,
  final: out.racers,
  ai: out.ai,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n${COURSE}  seed ${SEED}  ${t}s sim  phase ${phase}`);
  console.log(`\n  racer          offroad   wall   off%  drift%  tierHit`);
  for (const r of result.perRacer) {
    console.log(`  ${r.name.padEnd(14)} ${String(r.offroad).padStart(6)} ${String(r.wall).padStart(6)}`
      + ` ${String(r.offPct ?? '-').padStart(6)} ${String(r.driftPct ?? '-').padStart(7)}`
      + `  ${JSON.stringify(r.tierHit ?? [])}  ${JSON.stringify(r.why ?? {})}`);
  }
  const o = result.perRacer.map((r) => r.offroad);
  const w = result.perRacer.map((r) => r.wall);
  const avg = (a) => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(1);
  console.log(`  ${'AVG'.padEnd(14)} ${avg(o).padStart(6)} ${avg(w).padStart(6)}`);
  console.log(`\n  drift charges  tier1 ${result.driftTiers[1]}  tier2 ${result.driftTiers[2]}  tier3 ${result.driftTiers[3]}`);
  console.log(`  boosts         ${JSON.stringify(result.boosts)}`);
  console.log(`  finish spread  ${result.spread}s over ${result.finish.length} finishers`);
  console.log(`  surfaces       ${result.final.map((r) => r.surface).join(', ')}`);
  console.log();
}

const errs = await page.evaluate(() => window.__GAME.errors);
if (errs.length) {
  console.error('console errors:');
  for (const e of errs.slice(0, 10)) console.error('  ✗', e);
}

await browser.close();
await server.close();
