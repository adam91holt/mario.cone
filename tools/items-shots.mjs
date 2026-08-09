#!/usr/bin/env node
/**
 * items-shots.mjs — photograph the item system on demand.
 *
 * The standard review sheet cannot reach items: a shell four metres off the
 * player's bumper is not something you can drive to. This stages each moment
 * through `__ITEMS` and photographs it.
 *
 * IMPORTANT: it calls `setTimeScale(0)` first. The engine's rAF loop steps the
 * simulation off the wall clock, so *any* tool that renders a frame and then
 * does anything slow (a screenshot under software GL costs 100-300ms) has the
 * simulation running underneath it. Timing anything — the roulette above all —
 * without freezing that loop measures the tool, not the game.
 *
 *   node tools/items-shots.mjs --out /tmp/items --only reel,box
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = path.resolve(ROOT, opt('out', '/tmp/items'));
const ONLY = opt('only', '').split(',').map((s) => s.trim()).filter(Boolean);
const W = Number(opt('width', 1280));
const H = Number(opt('height', 720));

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
    '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120_000 });

const call = (fn, ...args) => page.evaluate(([f, a]) => {
  const r = window.__GAME[f](...a);
  return r instanceof Promise ? r.then(() => null) : (r ?? null);
}, [fn, args]);
const ev = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));

if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
let n = 0;
async function shot(name) {
  await call('render');
  await page.screenshot({ path: path.join(OUT, `${name}.png`), timeout: 120_000 });
  n++;
  console.log('  ✎', name);
}

async function fresh(opts = {}) {
  await call('reset', { vehicleId: 'cone', courseId: 'cone-canyon', instant: true, racerCount: 8, ...opts });
  await call('setTimeScale', 0);
  await call('setAutopilot', false);
  await call('setInput', { accel: 1 });
}

const want = (k) => !ONLY.length || ONLY.includes(k);

// ── the reel, frame by frame ───────────────────────────────────────────────
if (want('reel')) {
  console.log('reel');
  await fresh();
  await call('step', 4);
  await ev(() => { window.__ITEMS.roll(); });
  const marks = [0, 0.15, 0.35, 0.6, 0.85, 1.0, 1.05, 1.08, 1.12, 1.2, 1.4, 1.8];
  let t = 0;
  for (const m of marks) {
    if (m > t) { await call('advance', m - t, 60); t = m; }
    const p = await ev(() => window.__ITEMS.probe());
    await shot(`reel-${String(Math.round(m * 1000)).padStart(4, '0')}ms`);
    const cls = await page.evaluate(() => document.querySelector('#hud .slot')?.className ?? 'none');
    console.log(`     spin=${p.spin.toFixed(3)} settle=${p.settle.toFixed(3)} slot="${cls}"`);
  }
}

// ── item boxes ─────────────────────────────────────────────────────────────
if (want('box')) {
  console.log('box');
  await fresh();
  await call('step', 1);
  await call('setInput', { accel: 0 });
  // Park the player a known distance short of the next row, stopped.
  for (const [name, gap, cam] of [['box-40m', 40, 'chase'], ['box-11m', 11, 'chase'],
    ['box-11m-overhead', 11, 'overhead'], ['box-6m-near', 6, 'near']]) {
    for (let i = 0; i < 12; i++) {
      await page.evaluate((g) => window.__ITEMS.park(g), gap);
      await call('advance', 0.04, 25);
    }
    await call('setCamera', cam);
    await page.evaluate((g) => window.__ITEMS.park(g), gap);
    await call('advance', 0.04, 25);
    await shot(name);
  }
}

// ── the box breaking, frame by frame ───────────────────────────────────────
if (want('burst')) {
  console.log('burst');
  await fresh();
  await call('setCamera', 'chase');
  await call('step', 1);
  await call('setInput', { accel: 0 });
  for (let i = 0; i < 12; i++) { await ev(() => window.__ITEMS.park(3)); await call('advance', 0.04, 25); }
  await ev(() => window.__ITEMS.park(3));
  await call('advance', 0.04, 25);
  await shot('burst-before');
  await ev(() => window.__ITEMS.breakBox());
  let t = 0;
  for (const m of [0, 0.08, 0.16, 0.3, 0.5, 0.8, 1.2, 2.0, 3.0, 4.2]) {
    if (m > t) { await call('advance', m - t, m - t > 0.4 ? 25 : 60); t = m; }
    await shot(`burst-${String(Math.round(m * 1000)).padStart(4, '0')}ms`);
  }
}

// ── a shell in flight ──────────────────────────────────────────────────────
if (want('shell')) {
  console.log('shell');
  await fresh({ racerCount: 2 });
  await call('setCamera', 'chase');
  await call('step', 4);
  await ev(() => window.__ITEMS.fire('greenShell'));
  let t = 0;
  for (const m of [0, 0.1, 0.2, 0.4, 0.7, 1.2]) {
    if (m > t) { await call('advance', m - t, 60); t = m; }
    await shot(`shell-${String(Math.round(m * 1000)).padStart(4, '0')}ms`);
  }
  // and the models, held still and close
  await fresh();
  await call('step', 4);
  await ev(() => { window.__ITEMS.give('greenShell', 3); });
  await call('advance', 0.6, 30);
  await shot('orbit-green');
  await ev(() => { window.__ITEMS.give('redShell', 3); });
  await call('advance', 0.6, 30);
  await shot('orbit-red');
  await ev(() => { window.__ITEMS.give('banana', 1); });
  await call('advance', 0.6, 30);
  await shot('carry-banana');
}

// ── coins ──────────────────────────────────────────────────────────────────
if (want('coin')) {
  console.log('coin');
  await fresh();
  await call('setCamera', 'near');
  await call('step', 3);
  await call('advance', 0.4, 30);
  await shot('coin-near');
  await call('setCamera', 'overhead');
  await call('advance', 0.4, 30);
  await shot('coin-overhead');
}

// ── the incoming warning, and ink ──────────────────────────────────────────
if (want('screen')) {
  console.log('screen');
  await fresh();
  await call('setCamera', 'chase');
  await call('step', 4);
  await ev(() => { window.__ITEMS.incoming(26); });
  for (let i = 0; i < 8; i++) {
    await call('advance', 0.16, 30);
    const th = await ev(() => window.__ITEMS.threat());
    console.log(`     t=${((i + 1) * 0.16).toFixed(2)} threat ${JSON.stringify(th)}`);
    if (th.level > 0.3) { await shot(`warn-${Math.round(th.level * 100)}`); break; }
  }
  await fresh();
  await call('step', 4);
  await ev(() => { window.__ITEMS.ink(4); });
  await call('advance', 0.5, 30);
  await shot('ink');
  await call('advance', 1.6, 30);
  await shot('ink-late');
}

console.log(`\n${n} shots -> ${OUT}`);
if (errors.length) { console.error('errors:'); for (const e of errors.slice(0, 8)) console.error('  ✗', e); }
await browser.close();
await server.close();
