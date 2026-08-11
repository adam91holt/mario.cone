#!/usr/bin/env node
/**
 * critic-live.mjs — let the page run its OWN rAF loop, like a player's machine,
 * and watch the quality governor govern.
 *
 * Rule of this bench: it never calls __GAME.render/step/advance/reset, because
 * any of those latch the governor into 'bench' and it stops measuring. It gets
 * into a race the way a player does (__MENU.close()) and then only *reads*.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/review-perf-r1/live');
const SECONDS = Number(arg('seconds', 150));
const W = Number(arg('width', 1600)), H = Number(arg('height', 900));
const AUTOPILOT = !process.argv.includes('--no-autopilot');

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
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180000 });

// Close the front end exactly the way the OK key does. Then hand the kart to a
// CPU driver so the machine is doing real racing work rather than idling on the
// grid — setAutopilot neither renders nor steps, so the governor is untouched.
await page.evaluate((auto) => {
  window.__MENU?.set?.({ vehicleId: 'cone', courseId: 'cone-canyon' });
  window.__MENU?.close?.();
  if (auto) window.__GAME.setAutopilot(true);
}, AUTOPILOT);

const samples = [];
const t0 = Date.now();
let shotAt = new Set();
while ((Date.now() - t0) / 1000 < SECONDS) {
  await new Promise((r) => setTimeout(r, 2000));
  const p = await page.evaluate(() => {
    const q = window.__QUALITY?.probe?.();
    const s = window.__GAME.snapshot();
    const pl = s.racers.find((r) => r.isPlayer);
    return q ? {
      rung: q.rung, label: q.label, scale: q.scale, tier: q.tier,
      shadowSize: q.shadowSize, particles: q.particles, drawDistance: q.drawDistance,
      wallMs: q.wallMs, worst: q.wallWorstMs, best: q.wallBestMs, lateFrac: q.lateFrac,
      fps: q.fps, samples: q.samples, workMs: q.workMs, bound: q.bound,
      dwell: q.dwell, liveSeconds: q.liveSeconds, holding: q.holding,
      futile: q.futile, stalled: q.stalled, benched: q.benched, auto: q.auto,
      suspended: q.suspended, hijacked: q.hijacked, log: q.log,
      phase: s.race?.phase, speed: pl ? +pl.speed.toFixed(1) : 0,
      lap: pl?.lap, drift: pl?.drift?.active, boost: pl?.boost?.time > 0,
    } : null;
  }).catch(() => null);
  if (!p) continue;
  const wall = ((Date.now() - t0) / 1000).toFixed(0);
  samples.push({ wall: +wall, ...p });
  console.log(`t=${wall}s rung=${p.rung}(${p.label}) sc=${p.scale} fps=${p.fps} wall=${p.wallMs}ms worst=${p.worst} late=${p.lateFrac} n=${p.samples} live=${p.liveSeconds}s hold="${p.holding}" bench=${p.benched} futile=${p.futile} stall=${p.stalled} susp=${p.suspended}/${p.hijacked} phase=${p.phase} spd=${p.speed}`);
  // Photograph the picture at each distinct rung, and at the end.
  if (!shotAt.has(p.rung)) {
    shotAt.add(p.rung);
    await page.screenshot({ path: path.join(OUT, `live-rung${p.rung}-${p.label}-t${wall}.png`) });
  }
}
await page.screenshot({ path: path.join(OUT, 'live-final.png') });
const final = samples[samples.length - 1];
console.log('\n=== change log ===');
for (const c of final?.log ?? []) console.log(JSON.stringify(c));
console.log('errors:', errors.slice(0, 10));
await writeFile(path.join(OUT, 'live.json'), JSON.stringify({ samples, errors }, null, 2));
await browser.close();
await server.close();
