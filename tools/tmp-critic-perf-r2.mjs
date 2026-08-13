#!/usr/bin/env node
/**
 * Independent perf critic, round 2.
 *
 * Three questions a player would ask:
 *   A. When the governor bails out mid-race, does the picture visibly change?
 *      (frozen frame, set(0) then mid(1..6), same camera, same sim state)
 *   B. Does anything pop in / out as the ladder moves? pixel-diff the frames.
 *   C. Does the ladder actually buy frame time, measured as median rAF period
 *      on a frozen sim?
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/perf-r2-mine');
const RIDE = Number(arg('ride', 12));
const MODE = arg('mode', 'seam');
const CAM = arg('cam', 'chase');

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
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 240000 });
await mkdir(OUT, { recursive: true });

const log = [];
const say = (s) => { console.log(s); log.push(s); };

if (MODE === 'seam' || MODE === 'walk') {
  await page.evaluate(async ({ ride, cam }) => {
    await window.__GAME.reset({ vehicleId: 'cone', courseId: 'cone-canyon', seed: 3, instant: true });
    window.__GAME.setAutopilot(true);
    window.__GAME.step(ride);
    window.__GAME.setTimeScale(0);
    window.__GAME.setCamera(cam);
  }, { ride: RIDE, cam: CAM });

  // A: what a player gets INSIDE one race — mid() is the frame-half walk.
  const method = MODE === 'walk' ? 'set' : 'mid';
  await page.evaluate(() => { globalThis.__QUALITY.set(0); window.__GAME.render(); });
  for (const i of [0, 1, 2, 3, 4, 5, 6]) {
    const r = await page.evaluate(({ i, method }) => {
      const p = globalThis.__QUALITY[method](i);
      for (let k = 0; k < 3; k++) window.__GAME.render();
      const s = window.__GAME.stats();
      const snap = window.__GAME.snapshot();
      return {
        i, label: p.label ?? s.rungLabel, scale: s.renderScale,
        drawCalls: s.drawCalls, tris: s.triangles, tier: s.tier,
        dd: s.drawDistance, particles: s.particles, shadowSize: s.shadowSize,
        cam: snap.camera.pos.map((n) => +n.toFixed(3)),
        t: snap.time.elapsed,
      };
    }, { i, method });
    await page.screenshot({ path: path.join(OUT, `${method}-${i}-${r.label}.png`), timeout: 240000 });
    say(`${method}(${i}) ${String(r.label).padEnd(7)} scale=${r.scale} tier=${r.tier} dd=${r.dd} part=${r.particles} shadow=${r.shadowSize} calls=${r.drawCalls} tris=${r.tris} cam=${r.cam} t=${r.t.toFixed(3)}`);
  }
}

if (MODE === 'live') {
  // Let the rAF loop actually drive on this (slow) machine and watch the
  // governor decide. This is the machine a governor exists for.
  await page.evaluate(async () => {
    await window.__GAME.reset({ vehicleId: 'cone', courseId: 'cone-canyon', seed: 3, instant: true });
    window.__GAME.setAutopilot(true);
    window.__GAME.setInput({ accel: 1 });
    globalThis.__QUALITY.auto(true);
    globalThis.__TRACE = [];
    const tick = () => {
      const p = globalThis.__QUALITY.probe();
      const s = window.__GAME.stats();
      globalThis.__TRACE.push({
        t: +(performance.now() / 1000).toFixed(2), rung: s.rung, label: s.rungLabel,
        scale: s.renderScale, wall: Math.round(s.liveWallMs ?? 0), worst: Math.round(s.liveWorstMs ?? 0),
        secs: +(s.liveSeconds ?? 0).toFixed(1), gov: s.governor, fps: s.fps,
      });
    };
    globalThis.__TICK = setInterval(tick, 1000);
  });
  await page.waitForTimeout(Number(arg('secs', 75)) * 1000);
  const trace = await page.evaluate(() => { clearInterval(globalThis.__TICK); return globalThis.__TRACE; });
  for (const r of trace) say(`t=${String(r.t).padStart(6)} rung=${r.rung} ${String(r.label).padEnd(7)} scale=${r.scale} liveWall=${r.wall}ms worst=${r.worst}ms accrued=${r.secs}s gov=${r.gov}`);
  await page.screenshot({ path: path.join(OUT, 'live-settled.png'), timeout: 240000 });
}

say('errors: ' + JSON.stringify(errs.slice(0, 10)));
await writeFile(path.join(OUT, 'log.txt'), log.join('\n'));
await browser.close();
await server.close();
