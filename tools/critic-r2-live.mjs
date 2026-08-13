#!/usr/bin/env node
/**
 * critic-r2-live.mjs — let the real rAF loop drive, and watch the governor.
 *
 * Everything else in tools/ drives the sim through the harness, which the
 * governor is explicitly told to ignore. This one starts the race and then
 * gets out of the way: no step(), no advance(), no setTimeScale. Whatever the
 * governor does to a player on a machine that genuinely cannot hold 60fps
 * happens here, and it is sampled from outside the page every 500ms.
 *
 * It also photographs the frame at the start of the session and again at the
 * end, from the same fixed camera, so the picture the governor arrived at can
 * be compared with the one it started from.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/r2-live');
const SECONDS = Number(arg('seconds', 70));

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
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180000 });
await mkdir(OUT, { recursive: true });

// Start a race, put the CPU on the wheel, then stop touching it.
await page.evaluate(async () => {
  await window.__GAME.reset({ vehicleId: 'cone', courseId: 'cone-canyon', seed: 1, instant: true });
  window.__GAME.setAutopilot(true);
  window.__GAME.setInput({ accel: 1 });
});

await page.screenshot({ path: path.join(OUT, 'live-000-start.png'), timeout: 180000 });

const samples = [];
const t0 = Date.now();
let shotAt = new Set();
while ((Date.now() - t0) / 1000 < SECONDS) {
  const s = await page.evaluate(() => {
    const st = window.__GAME.stats();
    const p = globalThis.__QUALITY?.probe?.() ?? {};
    return {
      rung: st.rung, label: st.rungLabel, scale: st.renderScale, tier: st.tier,
      governor: st.governor, liveWallMs: st.liveWallMs, liveWorstMs: st.liveWorstMs,
      liveSeconds: st.liveSeconds, wallMs: st.wallMs,
      drawCalls: st.drawCalls, triangles: st.triangles, shadowSize: st.shadowSize,
      drawDistance: st.drawDistance, particles: st.particles, drawSkipped: st.drawSkipped,
      auto: p.auto, holding: p.holding, frames: p.frames,
    };
  });
  s.t = +((Date.now() - t0) / 1000).toFixed(1);
  samples.push(s);
  console.log(`${String(s.t).padStart(5)}s rung=${s.rung} ${String(s.label).padEnd(12)} scale=${s.scale} gov=${s.governor} liveWall=${s.liveWallMs} worst=${s.liveWorstMs} liveS=${s.liveSeconds} calls=${s.drawCalls} tris=${s.triangles} shadow=${s.shadowSize} dd=${s.drawDistance}`);
  const bucket = Math.floor(s.t / 20);
  if (!shotAt.has(bucket) && s.t > 5) {
    shotAt.add(bucket);
    await page.screenshot({ path: path.join(OUT, `live-${String(Math.round(s.t)).padStart(3, '0')}s-rung${s.rung}.png`), timeout: 180000 });
  }
  await new Promise((r) => setTimeout(r, 500));
}

await page.screenshot({ path: path.join(OUT, 'live-999-end.png'), timeout: 180000 });
await writeFile(path.join(OUT, 'live.json'), JSON.stringify({ samples, errs }, null, 2));
console.log('errors:', errs.slice(0, 6));
await browser.close();
await server.close();
