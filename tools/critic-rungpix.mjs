#!/usr/bin/env node
/**
 * critic-rungpix.mjs — the SAME sim state at every rung, exactly.
 *
 * `advance()` ignores timeScale, so freezing and advancing is not a freeze.
 * The only honest A/B is determinism: reset the same seed and `step()` to the
 * same instant for every rung, pin the rung, and render once.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/review-perf-r1/rungpix');
const AT = Number(arg('at', 11.4));
const CAM = arg('cam', '');
const W = 1600, H = 900;

const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await mkdir(OUT, { recursive: true });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180000 });
const ev = (fn, a) => page.evaluate(fn, a);
const ladder = await ev(() => window.__QUALITY.ladder);
console.log(JSON.stringify(ladder));

const rows = [];
for (let i = 0; i < ladder.length; i++) {
  await ev(() => window.__GAME.setTimeScale(1));
  await ev(() => window.__GAME.reset({ vehicleId: 'cone', courseId: 'cone-canyon', seed: 1, instant: true }));
  await ev((n) => window.__QUALITY.set(n), i);
  await ev(() => window.__GAME.setAutopilot(true));
  await ev((t) => window.__GAME.step(t), AT);
  if (CAM) await ev((c) => window.__GAME.setCamera(c), CAM);
  await ev(() => window.__GAME.setTimeScale(0));
  // Renders only — no advance, so the sim state cannot move. A handful, so the
  // page's own rAF has run resize() for the new pixel ratio and the visual
  // springs have settled on this state.
  for (let k = 0; k < 14; k++) { await ev(() => window.__GAME.render()); await new Promise((r) => setTimeout(r, 60)); }
  const st = await ev(() => window.__GAME.stats());
  const snap = await ev(() => { const s = window.__GAME.snapshot(); const p = s.racers.find((r) => r.isPlayer); return { t: s.race?.time, pos: p?.pos, spd: p?.speed }; });
  const buf = await ev(() => { const c = document.querySelector('canvas'); return [c.width, c.height]; });
  await page.screenshot({ path: path.join(OUT, `r${i}-${ladder[i].label}.png`) });
  await page.screenshot({ path: path.join(OUT, `r${i}-${ladder[i].label}-crop.png`), clip: { x: 480, y: 330, width: 640, height: 380 } });
  rows.push({ rung: i, label: ladder[i].label, scale: ladder[i].scale, buf, stats: st, snap });
  console.log(`r${i} ${ladder[i].label}: canvas=${buf} draws=${st.drawCalls} tris=${st.triangles} progs=${st.programs} t=${snap.t?.toFixed?.(2)} pos=${snap.pos?.map?.((v) => v.toFixed(1))}`);
}
await writeFile(path.join(OUT, 'rungpix.json'), JSON.stringify({ rows, errors }, null, 2));
console.log('errors:', errors.slice(0, 5));
await browser.close();
await server.close();
