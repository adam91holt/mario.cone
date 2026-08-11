#!/usr/bin/env node
/**
 * critic-rungs.mjs — photograph the SAME frozen racing moment at every rung of
 * the quality ladder, and time each rung honestly (median real rAF period).
 *
 * Independent critic's bench. Not owned by any module; delete freely.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1] : '/tmp/review-perf-r1/rungs';
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
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await mkdir(OUT, { recursive: true });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120000 });

const ev = (fn, arg) => page.evaluate(fn, arg);

// Drive to a real racing moment with the field around us.
await ev(() => window.__GAME.reset({ vehicleId: 'cone', courseId: 'cone-canyon', seed: 1, instant: true }));
await ev(() => window.__GAME.setAutopilot(true));
await ev(() => window.__GAME.step(9));
await ev(() => window.__GAME.setAutopilot(true));
await ev(() => window.__GAME.step(2.4));
await ev(() => window.__GAME.setTimeScale(0));     // freeze: identical sim state every rung
await ev(() => window.__GAME.advance(0.5, 20));

const ladder = await ev(() => window.__QUALITY.ladder);
console.log('ladder:', JSON.stringify(ladder, null, 1));

// Median real rAF period at the current settings, with the sim frozen.
const timeRaf = (ms) => page.evaluate(async (dur) => {
  const gaps = [];
  await new Promise((res) => {
    let last = 0, t0 = 0;
    const tick = (t) => {
      if (!t0) t0 = t;
      if (last) gaps.push(t - last);
      last = t;
      if (t - t0 < dur) requestAnimationFrame(tick); else res();
    };
    requestAnimationFrame(tick);
  });
  gaps.sort((a, b) => a - b);
  return { median: gaps[gaps.length >> 1] ?? 0, n: gaps.length };
}, ms);

const results = [];
// Interleave two passes so warm-up cannot flatter whichever went first.
for (const pass of [0, 1]) {
  for (let i = 0; i < ladder.length; i++) {
    await ev((n) => window.__QUALITY.set(n), i);
    await ev(() => window.__GAME.advance(0.4, 20));   // let targets reallocate
    const t = await timeRaf(2600);
    const st = await ev(() => window.__GAME.stats());
    const pr = await ev(() => window.__QUALITY.probe());
    const dpr = await ev(() => window.__GAME && window.devicePixelRatio);
    const buf = await ev(() => {
      const c = document.querySelector('canvas');
      return c ? [c.width, c.height, c.clientWidth, c.clientHeight] : null;
    });
    if (pass === 1) {
      await ev(() => window.__GAME.render());
      await page.screenshot({ path: path.join(OUT, `rung${i}-${ladder[i].label}.png`) });
      // zoom crop on the kart + verge, where softening shows
      await page.screenshot({
        path: path.join(OUT, `rung${i}-${ladder[i].label}-crop.png`),
        clip: { x: 300, y: 380, width: 700, height: 400 },
      });
      results.push({
        rung: i, label: ladder[i].label, scale: ladder[i].scale, tier: ladder[i].tier,
        shadowSize: ladder[i].shadowSize, aa: ladder[i].aa, bloom: ladder[i].bloom,
        particles: ladder[i].particles, drawDistance: ladder[i].drawDistance,
        medianRafMs: +t.median.toFixed(1), frames: t.n,
        drawCalls: st.drawCalls, triangles: st.triangles, programs: st.programs,
        ms: st.ms, drawMs: st.drawMs, canvas: buf, dpr,
        probeScale: pr.scale, probeShadow: pr.shadowSize,
      });
      console.log(`pass${pass} rung${i} ${ladder[i].label}: raf=${t.median.toFixed(1)}ms draws=${st.drawCalls} tris=${st.triangles} progs=${st.programs} canvas=${buf}`);
    } else {
      console.log(`pass${pass} rung${i} ${ladder[i].label}: raf=${t.median.toFixed(1)}ms progs=${st.programs}`);
    }
  }
}

await writeFile(path.join(OUT, 'rungs.json'), JSON.stringify({ results, errors }, null, 2));
console.log('errors:', errors.slice(0, 10));
console.log('\nrung  label  scale  rafMs  draws  tris  progs  canvasPx');
for (const r of results) {
  console.log(`${r.rung}  ${r.label.padEnd(6)} ${r.scale}  ${String(r.medianRafMs).padStart(7)}  ${String(r.drawCalls).padStart(4)}  ${String(r.triangles).padStart(7)}  ${String(r.programs).padStart(3)}  ${r.canvas?.[0]}x${r.canvas?.[1]}`);
}
const top = results[0]?.medianRafMs ?? 0;
for (const r of results) {
  console.log(`rung${r.rung} ${r.label}: ${top ? (100 * (top - r.medianRafMs) / top).toFixed(0) : '?'}% cheaper than rung0`);
}

await browser.close();
await server.close();
