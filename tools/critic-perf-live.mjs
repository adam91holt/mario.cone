#!/usr/bin/env node
/**
 * critic-perf-live.mjs — independent critic probe for the quality governor.
 *
 * Deliberately does NOT drive through step()/advance(): the governor exists for
 * the rAF path, so this lets the real loop run in real wall time and samples
 * `stats()` plus the canvas backing store while it does.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const SECONDS = Number(opt('seconds', 40));
const EVERY = Number(opt('every', 1000));
const W = Number(opt('width', 1280));
const H = Number(opt('height', 720));
const OUT = opt('out', '/tmp/perf-live');
const SHOTS = (opt('shots', '') || '').split(',').map(Number).filter((n) => !Number.isNaN(n) && n > 0);

await mkdir(OUT, { recursive: true });

const server = await createServer({ root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['three'] } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.error('  pageerror:', e.message));
page.on('crash', () => console.error('  !! PAGE CRASH'));
page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.error('  !! NAVIGATED ->', f.url()); });
page.on('console', (m) => { const t = m.text(); if (/webgl|context|lost|error|warn/i.test(t)) console.error('  console:', m.type(), t.slice(0,200)); });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180_000 });

const call = (fn, ...args) => page.evaluate(([f, a]) => {
  const r = window.__GAME[f](...a);
  return r instanceof Promise ? r.then(() => null) : (r ?? null);
}, [fn, args]);

if (!flag('menu')) {
  await call('reset', { vehicleId: opt('vehicle', 'cone'), courseId: opt('course', 'cone-canyon'), instant: true });
  await call('setAutopilot', true);
}

// Instrument the rAF loop itself from outside: record real delivered-frame times.
await page.evaluate(() => {
  window.__probe = { t: [], last: performance.now() };
  const tick = () => {
    const now = performance.now();
    window.__probe.t.push(now - window.__probe.last);
    window.__probe.last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const hdr = ['wall', 'rung', 'label', 'tier', 'scale', 'canvas', 'gov', 'liveMs', 'worst', 'liveS', 'ms', 'draws', 'tris', 'shadow', 'parts', 'dist', 'skip'];
console.log(hdr.join('\t'));

const t0 = Date.now();
const rows = [];
let n = 0;
while (Date.now() - t0 < SECONDS * 1000) {
  await new Promise((r) => setTimeout(r, EVERY));
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  let s;
  try { s = await page.evaluate(() => {
    const st = window.__GAME.stats();
    const c = document.querySelector('canvas');
    const probe = window.__probe.t.slice(-30);
    return {
      st,
      canvas: c ? `${c.width}x${c.height}@${Math.round(c.clientWidth)}` : 'none',
      rafMean: probe.length ? probe.reduce((a, b) => a + b, 0) / probe.length : 0,
      rafWorst: probe.length ? Math.max(...probe) : 0,
      frames: window.__probe.t.length,
    };
  }); } catch (e) { console.error('  !! evaluate failed:', String(e).split('\n')[0]); break; }
  const st = s.st;
  rows.push({ wall, ...st, canvas: s.canvas, rafMean: s.rafMean, rafWorst: s.rafWorst });
  console.log([
    wall, st.rung, st.rungLabel, st.tier, st.renderScale, s.canvas, st.governor,
    (st.liveWallMs ?? 0).toFixed(1), (st.liveWorstMs ?? 0).toFixed(1), (st.liveSeconds ?? 0).toFixed(1),
    (st.ms ?? 0).toFixed(1), st.drawCalls, st.triangles, st.shadowSize, st.particles, st.drawDistance,
    st.drawSkipped ? 'SKIP' : '',
    `raf ${s.rafMean.toFixed(0)}/${s.rafWorst.toFixed(0)}ms n=${s.frames}`,
  ].join('\t'));
  n++;
  if (SHOTS.includes(n)) await page.screenshot({ path: `${OUT}/live-${String(n).padStart(2, '0')}-rung${st.rung}.png` });
}

if (flag('finalshot')) await page.screenshot({ path: `${OUT}/final.png` });

const errs = await page.evaluate(() => window.__GAME.errors);
if (errs.length) { console.error('\nconsole errors:'); for (const e of errs.slice(0, 10)) console.error('  x', e); }

await browser.close();
await server.close();
