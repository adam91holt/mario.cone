#!/usr/bin/env node
/**
 * critic-bloom.mjs — what the levers the ladder refuses to pull are worth.
 *
 * Median rAF period is unusable under SwiftShader when a frame is a second
 * long: a 2s window is one sample. So this counts DELIVERED FRAMES over a fixed
 * wall window instead — a throughput measurement, which needs no per-frame
 * resolution — and alternates the configurations so contention lands on all of
 * them equally.
 *
 * Frozen racing frame, floor rung, 1280x720.
 * Not owned by any module; delete freely.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = opt('out', '/tmp/critic-bloom');
const ROUNDS = Number(opt('rounds', 4));
const WINDOW = Number(opt('window', 14000));
await mkdir(OUT, { recursive: true });

const server = await createServer({ root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, optimizeDeps: { include: ['three'] } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 240000 });
await page.evaluate(() => {
  window.__MENU?.set?.({ vehicleId: 'cone', courseId: 'cone-canyon' });
  window.__MENU?.close?.();
  window.__GAME.setAutopilot(true);
  window.__GAME.seek('racing');
  window.__GAME.step(9);
  window.__GAME.render();
  window.__GAME.setTimeScale(0);
  window.__COUNT = { on: false, n: 0 };
  const tick = () => { if (window.__COUNT.on) window.__COUNT.n++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});

// Every configuration is the FLOOR rung; only the named lever differs.
const CASES = [
  ['floor (as shipped)', {}],
  ['floor, bloom off', { bloom: false }],
  ['floor, shadows off', { shadows: false }],
  ['floor, bloom+shadows off', { bloom: false, shadows: false }],
];

const tally = CASES.map(() => []);
for (let r = 0; r < ROUNDS; r++) {
  for (let c = 0; c < CASES.length; c++) {
    const [name, trim] = CASES[c];
    await page.evaluate(({ trim }) => {
      window.__QUALITY.set(6);
      window.__QUALITY.try(trim, 0.5);
      window.__COUNT.on = false; window.__COUNT.n = 0;
    }, { trim });
    await new Promise((res) => setTimeout(res, 1200));
    await page.evaluate(() => { window.__COUNT.on = true; window.__COUNT.n = 0; });
    const t0 = Date.now();
    await new Promise((res) => setTimeout(res, WINDOW));
    const got = await page.evaluate(() => { window.__COUNT.on = false; return window.__COUNT.n; });
    const el = Date.now() - t0;
    const fps = (got / el) * 1000;
    tally[c].push(fps);
    const st = await page.evaluate(() => { const s = window.__GAME.stats(); return { calls: s.drawCalls, tris: s.triangles, progs: s.programs }; });
    console.log(`r${r} ${name.padEnd(26)} ${got} frames / ${el}ms = ${fps.toFixed(3)} fps   calls=${st.calls} tris=${st.tris} progs=${st.progs}`);
    if (r === 0) await page.screenshot({ path: path.join(OUT, `case${c}.png`) });
  }
}

console.log('\n=== throughput, median of', ROUNDS, 'interleaved rounds ===');
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const base = med(tally[0]);
for (let c = 0; c < CASES.length; c++) {
  const m = med(tally[c]);
  console.log(`${CASES[c][0].padEnd(26)} ${m.toFixed(3)} fps   x${(m / base).toFixed(3)} vs shipped floor   [${tally[c].map((v) => v.toFixed(2)).join(' ')}]`);
}
console.log('errors:', errors.slice(0, 6));
await writeFile(path.join(OUT, 'bloom.json'), JSON.stringify({ cases: CASES.map((c) => c[0]), tally, errors }, null, 2));
await browser.close();
await server.close();
