#!/usr/bin/env node
/**
 * critic-futile.mjs — was the governor right to stand down?
 *
 * On this machine the ladder walked to rung 3, decided two more cuts bought
 * nothing, put one back and stalled at 1.4fps. That verdict is taken from a
 * four-sample mean. This measures the same two rungs over long, interleaved
 * windows on a LIVE page (its own rAF loop, no harness renders) so the answer
 * is not a four-frame coin toss.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/review-perf-r1');
const WINDOW_MS = Number(arg('window', 22000));
const PASSES = Number(arg('passes', 3));
const RUNGS = (arg('rungs', '3,4,5')).split(',').map(Number);

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
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await mkdir(OUT, { recursive: true });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180000 });

// Into a real race, the player's way. seek() and setAutopilot() neither render
// nor step, so nothing here makes the page a bench.
await page.evaluate(() => {
  window.__MENU?.close?.();
  window.__GAME.seek('racing');
  window.__GAME.setAutopilot(true);
});
await new Promise((r) => setTimeout(r, 8000));

const measure = (ms) => page.evaluate(async (dur) => {
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
  const mean = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);
  return { median: gaps[gaps.length >> 1] ?? 0, mean, n: gaps.length, min: gaps[0], max: gaps[gaps.length - 1] };
}, ms);

const acc = new Map(RUNGS.map((r) => [r, []]));
for (let p = 0; p < PASSES; p++) {
  for (const r of RUNGS) {
    await page.evaluate((n) => window.__QUALITY.set(n), r);
    await new Promise((x) => setTimeout(x, 3500));   // let the realloc pass
    const m = await measure(WINDOW_MS);
    acc.get(r).push(m);
    console.log(`pass${p} rung${r}: median=${m.median.toFixed(0)}ms mean=${m.mean.toFixed(0)}ms n=${m.n} min=${m.min?.toFixed(0)} max=${m.max?.toFixed(0)}`);
  }
}

console.log('\n=== pooled ===');
const out = [];
for (const r of RUNGS) {
  const meds = acc.get(r).map((m) => m.median).sort((a, b) => a - b);
  const med = meds[meds.length >> 1];
  const totalN = acc.get(r).reduce((a, m) => a + m.n, 0);
  out.push({ rung: r, medianOfMedians: +med.toFixed(1), passes: meds.map((v) => +v.toFixed(0)), frames: totalN });
  console.log(`rung${r}: median-of-medians ${med.toFixed(0)}ms  (${meds.map((v) => v.toFixed(0)).join(', ')})  frames=${totalN}`);
}
const base = out[0].medianOfMedians;
for (const o of out) console.log(`rung${o.rung}: ${(100 * (base - o.medianOfMedians) / base).toFixed(1)}% cheaper than rung${out[0].rung}`);
await writeFile(path.join(OUT, 'futile.json'), JSON.stringify(out, null, 2));
await browser.close();
await server.close();
