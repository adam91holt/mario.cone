#!/usr/bin/env node
/** items-probe.mjs — measure roulette timing and item-system internals. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);

const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.error('  pageerror:', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120_000 });

const call = (fn, ...args) => page.evaluate(([f, a]) => {
  const r = window.__GAME[f](...a);
  return r instanceof Promise ? r.then(() => null) : (r ?? null);
}, [fn, args]);

await call('reset', { vehicleId: 'cone', courseId: 'cone-canyon', instant: true, racerCount: 8 });
await call('setAutopilot', false);
await call('setInput', { accel: 1 });
await call('advance', 2);

// Listen for roulette events with timestamps.
await page.evaluate(() => {
  window.__PROBE = { events: [] };
  const g = window.__ITEMS;
  window.__PROBE.hasItems = !!g;
});

await call('setTimeScale', 0); // freeze the rAF loop so only advance() steps the sim
console.log('roll() timing, player, manual input accel=1 (rAF frozen):');
await page.evaluate(() => { window.__ITEMS.roll(); });
let done = false;
for (let i = 0; i < 90; i++) {
  const s = await page.evaluate(() => {
    const p = window.__ITEMS.probe();
    return { item: p ? null : null, spin: p.spin, total: p.spinTotal, face: p.spinFace, settle: p.settle };
  });
  const it = await page.evaluate(() => window.__GAME.snapshot().racers.find((r) => r.isPlayer).item);
  if (i % 3 === 0 || (it && !done)) {
    console.log(`  f${String(i).padStart(2)} ${String(Math.round(i * 1000 / 60)).padStart(4)}ms spin=${s.spin.toFixed(3)}/${s.total.toFixed(2)} face=${s.face} settle=${s.settle.toFixed(2)} item=${it}`);
  }
  if (it && !done) { done = true; console.log(`  --> item set at ${(i / 60 * 1000).toFixed(0)}ms`); }
  if (done && i > 70) break;
  await call('advance', 1 / 60);
}

// Inspect state directly
const st = await page.evaluate(() => window.__ITEMS.state ? window.__ITEMS.state() : null);
console.log('state:', JSON.stringify(st));

const errs = await page.evaluate(() => window.__GAME.errors);
if (errs.length) console.error('errors:', errs.slice(0, 5));
await browser.close();
await server.close();
