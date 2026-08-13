#!/usr/bin/env node
/**
 * critic-perf-seam.mjs — does the deferred half of a rung ever land?
 *
 * Runs the live rAF loop until the governor has walked down the ladder, then
 * takes each of the seams the ladder says it is waiting for (a race reset, a
 * resize) and reports what actually changed.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SETTLE = Number(opt('settle', 90));
const OUT = opt('out', '/tmp/perf-seam');
await mkdir(OUT, { recursive: true });

const server = await createServer({ root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['three'] } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('  !! pageerror:', e.message));
page.on('crash', () => console.error('  !! PAGE CRASH (renderer gone)'));
page.on('close', () => console.error('  !! PAGE CLOSED'));
page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.error('  !! NAVIGATED ->', f.url()); });
page.on('console', (m) => { const t = m.text(); if (/lost|context|crash|memory|fail/i.test(t)) console.error('  !! console', m.type(), t.slice(0,240)); });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180_000 });

const call = (fn, ...args) => page.evaluate(([f, a]) => {
  const r = window.__GAME[f](...a);
  return r instanceof Promise ? r.then(() => null) : (r ?? null);
}, [fn, args]);

const probeRaw = () => page.evaluate(() => {
  const st = window.__GAME.stats();
  const c = document.querySelector('canvas');
  return {
    rung: st.rung, label: st.rungLabel, tier: st.tier, scale: st.renderScale,
    aa: window.__CTX?.quality?.aa, shadows: window.__CTX?.quality?.shadows,
    shadowSize: st.shadowSize, particles: st.particles, drawDistance: st.drawDistance,
    draws: st.drawCalls, tris: st.triangles, gov: st.governor,
    liveMs: st.liveWallMs, liveS: st.liveSeconds,
    canvas: c ? `${c.width}x${c.height} css ${c.clientWidth}x${c.clientHeight} dpr ${window.devicePixelRatio}` : 'none',
  };
});
const probe = async () => {
  for (let i = 0; i < 3; i++) {
    try { return await probeRaw(); }
    catch (e) { console.error('  !! probe failed:', String(e).split('\n')[0]); await new Promise(r => setTimeout(r, 3000)); }
  }
  return { rung:'?', label:'?', tier:'?', scale:'?', canvas:'?', draws:'?', tris:'?', gov:'DEAD', liveMs:0, liveS:0 };
};
const show = (tag, p) => console.log(
  `${tag.padEnd(28)} rung ${p.rung} ${String(p.label).padEnd(7)} tier ${String(p.tier).padEnd(5)} scale ${p.scale}  canvas ${p.canvas}\n` +
  `${''.padEnd(28)} aa ${p.aa} shadows ${p.shadows} shadowSize ${p.shadowSize} parts ${p.particles} dist ${p.drawDistance}  draws ${p.draws} tris ${p.tris}  gov "${p.gov}" liveMs ${Math.round(p.liveMs)} liveS ${Math.round(p.liveS)}`);

await call('reset', { vehicleId: 'cone', courseId: 'cone-canyon', instant: true });
await call('setAutopilot', true);
show('boot / rung 0', await probe());

console.log(`\n… letting the real rAF loop run ${SETTLE}s so the governor descends …\n`);
const t0 = Date.now();
while (Date.now() - t0 < SETTLE * 1000) {
  await new Promise((r) => setTimeout(r, 10_000));
  show(`live +${Math.round((Date.now() - t0) / 1000)}s`, await probe());
}
await page.screenshot({ path: `${OUT}/a-descended.png` });
const before = await probe();

console.log('\n── SEAM 1: harness reset() (a race build) ──');
await call('reset', { vehicleId: 'cone', courseId: 'cone-canyon', instant: true });
await call('setAutopilot', true);
await new Promise((r) => setTimeout(r, 4000));
show('after reset', await probe());
await page.screenshot({ path: `${OUT}/b-after-reset.png` });

console.log('\n── SEAM 2: a window resize ──');
await page.setViewportSize({ width: 1281, height: 721 });
await new Promise((r) => setTimeout(r, 6000));
show('after resize', await probe());
await page.setViewportSize({ width: 1280, height: 720 });
await new Promise((r) => setTimeout(r, 6000));
show('after resize back', await probe());
await page.screenshot({ path: `${OUT}/c-after-resize.png` });

console.log('\n── does it CLIMB BACK when the machine gets cheap? (viewport 320x180) ──');
await page.setViewportSize({ width: 320, height: 180 });
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  show(`cheap +${(i + 1) * 10}s`, await probe());
}
await page.screenshot({ path: `${OUT}/d-cheap.png` });

console.log('\nbefore-seam snapshot for reference:');
show('descended', before);

const errs = await page.evaluate(() => window.__GAME.errors);
if (errs.length) { console.error('\nconsole errors:'); for (const e of errs.slice(0, 10)) console.error('  x', e); }
await browser.close();
await server.close();
