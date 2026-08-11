#!/usr/bin/env node
/**
 * critic-perf-honesty.mjs — does stats() tell the truth about the frame?
 *
 * Compares what the game reports (stats().fps / .ms / its three-way split)
 * against the wall clock between delivered rAF frames, measured from outside.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const W = Number(opt('width', 1280));
const H = Number(opt('height', 720));
const SECONDS = Number(opt('seconds', 60));

const server = await createServer({ root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['three'] } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.error('  pageerror:', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180_000 });
await page.evaluate(() => window.__GAME.reset({ vehicleId: 'cone', courseId: 'cone-canyon', instant: true }));
await page.evaluate(() => window.__GAME.setAutopilot(true));

await page.evaluate(() => {
  window.__p = { d: [], last: performance.now(), t0: performance.now() };
  const tick = () => {
    const n = performance.now();
    window.__p.d.push(n - window.__p.last); window.__p.last = n;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

console.log('\nwall\treportedFps\treportedMs\tsim/upd/draw\twallMs(60f)\tliveWallMs\tREAL rAF mean\tREAL fps\tracesec\trung');
const t0 = Date.now();
while (Date.now() - t0 < SECONDS * 1000) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = await page.evaluate(() => {
    const st = window.__GAME.stats();
    const d = window.__p.d.slice(-20);
    const mean = d.length ? d.reduce((a, b) => a + b, 0) / d.length : 0;
    return { st, mean, n: window.__p.d.length, race: window.__GAME.snapshot().race.time };
  });
  const st = s.st;
  console.log([
    ((Date.now() - t0) / 1000).toFixed(0) + 's',
    (st.fps ?? 0).toFixed(1),
    (st.ms ?? 0).toFixed(1),
    `${(st.simMs ?? 0).toFixed(1)}/${(st.updateMs ?? 0).toFixed(1)}/${(st.drawMs ?? 0).toFixed(1)}`,
    (st.wallMs ?? 0).toFixed(0),
    (st.liveWallMs ?? 0).toFixed(0),
    s.mean.toFixed(0) + 'ms',
    (1000 / Math.max(1, s.mean)).toFixed(2),
    s.race.toFixed(1) + 's',
    `${st.rung} ${st.rungLabel}`,
  ].join('\t'));
}
await browser.close();
await server.close();
