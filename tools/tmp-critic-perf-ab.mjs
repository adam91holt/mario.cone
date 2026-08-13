#!/usr/bin/env node
/**
 * Alternating A/B so "the pictures differ" cannot be confused with "time passed".
 * A = mid(0) top rung, B = mid(6) floor, taken A,B,A,B on a frozen sim with the
 * camera allowed to settle first.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/perf-r2-ab');
const RIDE = Number(arg('ride', 12));
const CAM = arg('cam', 'chase');
const METHOD = arg('method', 'mid');
const DRIFT = process.argv.includes('--drift');

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
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 240000 });
await mkdir(OUT, { recursive: true });
const log = [];
const say = (s) => { console.log(s); log.push(s); };

await page.evaluate(async ({ ride, cam, drift }) => {
  await window.__GAME.reset({ vehicleId: 'cone', courseId: 'cone-canyon', seed: 3, instant: true });
  window.__GAME.setAutopilot(true);
  window.__GAME.step(ride);
  if (drift) {
    // Hand-drive a drift so the mini-turbo is actually charging.
    window.__GAME.setAutopilot(false);
    window.__GAME.setInput({ accel: 1, steer: 0.7, drift: true });
    window.__GAME.step(1.6);
  }
  window.__GAME.setTimeScale(0);
  window.__GAME.setCamera(cam);
  globalThis.__QUALITY.set(0);
  // Let the camera rig settle so an A/B is not a camera move.
  for (let i = 0; i < 10; i++) window.__GAME.render();
}, { ride: RIDE, cam: CAM, drift: DRIFT });

const plan = [['A-top', 0], ['B-floor', 6], ['A2-top', 0], ['B2-floor', 6]];
for (const [name, i] of plan) {
  const r = await page.evaluate(({ i, method }) => {
    globalThis.__QUALITY[method](i);
    for (let k = 0; k < 4; k++) window.__GAME.render();
    const s = window.__GAME.stats();
    const snap = window.__GAME.snapshot();
    const p = snap.racers.find((x) => x.isPlayer);
    return {
      label: s.rungLabel, scale: s.renderScale, calls: s.drawCalls, tris: s.triangles,
      dd: s.drawDistance, part: s.particles,
      cam: snap.camera.pos.map((n) => +n.toFixed(2)),
      drift: p.drift, speed: +p.speed.toFixed(2), t: +snap.time.elapsed.toFixed(3),
    };
  }, { i, method: METHOD });
  await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 240000 });
  say(`${name.padEnd(9)} ${String(r.label).padEnd(7)} scale=${r.scale} dd=${r.dd} part=${r.part} calls=${r.calls} tris=${r.tris} cam=${r.cam} drift=${JSON.stringify(r.drift)} spd=${r.speed} t=${r.t}`);
}
say('errors: ' + JSON.stringify(errs.slice(0, 8)));
await writeFile(path.join(OUT, 'log.txt'), log.join('\n'));
await browser.close();
await server.close();
