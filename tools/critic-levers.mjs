#!/usr/bin/env node
/**
 * critic-levers.mjs — isolate each lever the ladder pulls, at ONE frozen sim
 * moment and at full render scale, so a pop can be attributed to a lever rather
 * than blamed on the resolution drop that came with it.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/review-perf-r1/levers');
const CAM = arg('cam', 'far');
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

await ev(() => window.__GAME.reset({ vehicleId: 'cone', courseId: 'cone-canyon', seed: 1, instant: true }));
await ev(() => window.__GAME.setAutopilot(true));
await ev(() => window.__GAME.step(11.4));
await ev((c) => window.__GAME.setCamera(c), CAM);
await ev(() => window.__GAME.setTimeScale(0));
await ev(() => window.__GAME.advance(0.5, 20));

const shot = async (name, trim, scale) => {
  await ev(([t, s]) => window.__QUALITY.try(t, s), [trim, scale]);
  await ev(() => window.__GAME.advance(0.35, 20));
  await ev(() => window.__GAME.render());
  const st = await ev(() => window.__GAME.stats());
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  console.log(`${name}: draws=${st.drawCalls} tris=${st.triangles} progs=${st.programs} scale=${st.renderScale}`);
  return { name, ...st };
};

const rows = [];
// Draw distance, isolated. Everything else at rung 0.
for (const dd of [1.0, 0.76, 0.52]) {
  rows.push(await shot(`dd-${dd}`, {
    tier: 'high', shadows: true, shadowSize: 2048, postfx: true, aa: true,
    particles: 1, bloom: true, drawDistance: dd,
  }, 1.0));
}
// Shadow map size, isolated.
for (const ss of [2048, 512, 256]) {
  rows.push(await shot(`shadow-${ss}`, {
    tier: 'high', shadows: true, shadowSize: ss, postfx: true, aa: true,
    particles: 1, bloom: true, drawDistance: 1.0,
  }, 1.0));
}
// Bloom, isolated.
for (const bl of [true, false]) {
  rows.push(await shot(`bloom-${bl}`, {
    tier: 'high', shadows: true, shadowSize: 2048, postfx: true, aa: true,
    particles: 1, bloom: bl, drawDistance: 1.0,
  }, 1.0));
}
// Resolution, isolated (everything else at rung 0 settings).
for (const sc of [1.0, 0.68, 0.48]) {
  rows.push(await shot(`scale-${sc}`, {
    tier: 'high', shadows: true, shadowSize: 2048, postfx: true, aa: true,
    particles: 1, bloom: true, drawDistance: 1.0,
  }, sc));
}
// AA, isolated.
for (const a of [true, false]) {
  rows.push(await shot(`aa-${a}`, {
    tier: 'high', shadows: true, shadowSize: 2048, postfx: true, aa: a,
    particles: 1, bloom: true, drawDistance: 1.0,
  }, 1.0));
}

await writeFile(path.join(OUT, 'levers.json'), JSON.stringify({ rows, errors }, null, 2));
console.log('errors:', errors.slice(0, 5));
await browser.close();
await server.close();
