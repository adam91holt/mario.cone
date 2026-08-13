#!/usr/bin/env node
/**
 * critic-r2-popin.mjs — does the game's draw distance cut anything a player
 * would watch appear?
 *
 * Freezes one frame and renders it at the shipped drawDistance and at 1.0,
 * ALTERNATING (A,B,A,B) and logging the camera position with each render, so
 * that "the two pictures differ" cannot be confused with "time passed between
 * them" — which is the trap in any A/B taken as a single ordered walk.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/r2-popin');
const RIDE = Number(arg('ride', 9));

const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180000 });
await mkdir(OUT, { recursive: true });

await page.evaluate(async (ride) => {
  await window.__GAME.reset({ vehicleId: 'cone', courseId: 'cone-canyon', seed: 1, instant: true });
  window.__GAME.setAutopilot(true);
  window.__GAME.step(ride);
  window.__GAME.setTimeScale(0);
  // The far camera sees the most world, which is where a cull edge would show.
  window.__GAME.setCamera('far');
}, RIDE);

const plan = [['dd055', 0.55], ['dd100', 1.0], ['dd055b', 0.55], ['dd100b', 1.0], ['dd030', 0.3]];
const rows = [];
for (const [name, dd] of plan) {
  const r = await page.evaluate((dd) => {
    globalThis.__QUALITY.try({ drawDistance: dd }, 1);
    window.__GAME.render();
    const s = window.__GAME.stats();
    const snap = window.__GAME.snapshot();
    return { dd, drawCalls: s.drawCalls, triangles: s.triangles, cam: snap.camera.pos.map((n) => +n.toFixed(3)) };
  }, dd);
  await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 180000 });
  r.name = name;
  rows.push(r);
  console.log(`${name.padEnd(8)} dd=${r.dd} calls=${r.drawCalls} tris=${r.triangles} cam=${r.cam.join(',')}`);
}
await writeFile(path.join(OUT, 'popin.json'), JSON.stringify({ rows, errs }, null, 2));
console.log('errors', errs.slice(0, 5));
await browser.close();
await server.close();
