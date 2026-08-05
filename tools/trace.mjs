#!/usr/bin/env node
/**
 * trace.mjs — print a timeline of simulation state.
 *
 * The counterpart to capture.mjs: where that answers "what does it look like",
 * this answers "what is it actually doing". Use it when a number looks wrong —
 * lap counts, positions, speed, surface, drift charge.
 *
 * Usage
 *   node tools/trace.mjs                          12s of autopilot, 1s samples
 *   node tools/trace.mjs --seconds 30 --every 2
 *   node tools/trace.mjs --manual --accel 1 --steer 0.6
 *   node tools/trace.mjs --all                    every racer, not just the player
 *   node tools/trace.mjs --fields speed,lap,progress,surface
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

const SECONDS = Number(opt('seconds', 12));
const EVERY = Number(opt('every', 1));
const MANUAL = flag('manual');
const ALL = flag('all');
const VEHICLE = opt('vehicle', 'cone');
const COURSE = opt('course', 'cone-canyon');
const FIELDS = opt('fields', 'speed,lap,progress,place,surface,grounded').split(',');
const INPUT = {
  accel: Number(opt('accel', 1)),
  steer: Number(opt('steer', 0)),
  brake: Number(opt('brake', 0)),
  drift: flag('drift'),
};

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
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.error('  pageerror:', e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120_000 });

const call = (fn, ...args) =>
  page.evaluate(([f, a]) => {
    const r = window.__GAME[f](...a);
    return r instanceof Promise ? r.then(() => null) : (r ?? null);
  }, [fn, args]);

await call('reset', { vehicleId: VEHICLE, courseId: COURSE, instant: true });
if (MANUAL) {
  await call('setAutopilot', false);
  await call('setInput', INPUT);
} else {
  await call('setAutopilot', true);
}

const track = (await call('snapshot')).track;
console.log(`\ntrack ${track.name}  length ${track.length}m  vehicle ${VEHICLE}  ${MANUAL ? 'manual' : 'autopilot'}\n`);

const header = ['t', ...(ALL ? ['racer'] : []), ...FIELDS];
const widths = header.map((h) => Math.max(h.length, 9));
const row = (cells) => cells.map((c, i) => String(c).padStart(widths[i])).join('  ');
console.log(row(header));
console.log(widths.map((w) => '─'.repeat(w)).join('  '));

const fmt = (v) => (typeof v === 'number' ? v.toFixed(2) : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
const pick = (r, f) => {
  if (f === 'driftTier') return r.drift?.tier;
  if (f === 'driftCharge') return r.drift?.charge;
  if (f === 'boost') return r.boost?.time;
  return r[f];
};

for (let t = 0; t <= SECONDS; t += EVERY) {
  if (t > 0) await call('advance', EVERY);
  const snap = await call('snapshot');
  const list = ALL ? snap.racers : snap.racers.filter((r) => r.isPlayer);
  for (const r of list) {
    console.log(row([t.toFixed(0), ...(ALL ? [r.name] : []), ...FIELDS.map((f) => fmt(pick(r, f)))]));
  }
  if (ALL) console.log();
}

const errs = await page.evaluate(() => window.__GAME.errors);
if (errs.length) {
  console.error('\nconsole errors:');
  for (const e of errs.slice(0, 10)) console.error('  ✗', e);
}

console.log();
await browser.close();
await server.close();
