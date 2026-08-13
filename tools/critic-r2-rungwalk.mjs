#!/usr/bin/env node
/**
 * critic-r2-rungwalk.mjs — independent perf critic instrument, round 2.
 *
 * Freezes one real racing frame and photographs what each rung of the ladder
 * does to it, both as a mid-race change (`mid`) and as a race build (`set`).
 * The question this answers is the only one a player can ask: can I SEE the
 * governor working?
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : '/tmp/r2-rungwalk';
const MODE = process.argv.includes('--set') ? 'set' : 'mid';

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

// Get to a real racing moment on the racing line, then stop the world.
await page.evaluate(async () => {
  await window.__GAME.reset({ vehicleId: 'cone', courseId: 'cone-canyon', seed: 1, instant: true });
  window.__GAME.setAutopilot(true);
  window.__GAME.step(9);
  window.__GAME.setTimeScale(0);
});

const rows = [];
for (let r = 0; r <= 6; r++) {
  const probe = await page.evaluate(([mode, i]) => {
    const q = globalThis.__QUALITY;
    if (mode === 'set') q.set(i); else q.mid(i);
    window.__GAME.render();
    const s = window.__GAME.stats();
    const p = q.probe();
    return {
      rung: i, label: p.label ?? s.rungLabel, scale: p.scale ?? s.renderScale,
      drawCalls: s.drawCalls, triangles: s.triangles, programs: s.programs,
      shadowSize: s.shadowSize, tier: s.tier, particles: s.particles,
      drawDistance: s.drawDistance, drawMs: s.drawMs, meanDrawMs: s.meanDrawMs,
    };
  }, [MODE, r]);
  await page.screenshot({ path: path.join(OUT, `${MODE}-rung${r}.png`), timeout: 180000 });
  rows.push(probe);
  console.log(`${MODE} rung ${r} ${String(probe.label).padEnd(12)} scale=${probe.scale} calls=${probe.drawCalls} tris=${probe.triangles} shadow=${probe.shadowSize} dd=${probe.drawDistance}`);
}
await writeFile(path.join(OUT, `${MODE}.json`), JSON.stringify({ rows, errs }, null, 2));
if (errs.length) console.log('console errors:', errs.slice(0, 5));
await browser.close();
await server.close();
