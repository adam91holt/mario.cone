#!/usr/bin/env node
/**
 * critic-perf-attrib.mjs — where does the frame actually go?
 *
 * The ladder claims render scale is "by a long way the largest thing this
 * ladder spends". This measures that claim directly: freeze the sim on one
 * frame, then time N raw draws with one thing changed at a time.
 *
 * Read-only with respect to the repo — it pokes the live renderer from the
 * page, restores it, and reports milliseconds.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const W = Number(opt('width', 1280));
const H = Number(opt('height', 720));
const N = Number(opt('draws', 4));

const server = await createServer({ root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['three'] } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.error('  pageerror:', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180_000 });

await page.evaluate(() => window.__GAME.reset({ vehicleId: 'cone', courseId: 'cone-canyon', instant: true }));
await page.evaluate(() => window.__GAME.setAutopilot(true));
await page.evaluate(() => window.__GAME.step(6));
await page.evaluate(() => window.__GAME.setTimeScale(0));

const result = await page.evaluate(async (n) => {
  const G = window.__GAME;
  const R = window.__CTX?.renderer;
  if (!R) return [{ label: 'NO RENDERER HANDLE', ms: 0, draws: 0, tris: 0 }];
  const pr = R.getPixelRatio();
  const shadowOn = () => { R.shadowMap.enabled = true; R.shadowMap.needsUpdate = true; };
  const shadowOff = () => { R.shadowMap.enabled = false; R.shadowMap.needsUpdate = true; };
  const cases = {
    'baseline (shadows on, full res)': () => { shadowOn(); R.setPixelRatio(pr); },
    'shadows OFF': () => { shadowOff(); R.setPixelRatio(pr); },
    'half res (1/4 pixels)': () => { shadowOn(); R.setPixelRatio(pr * 0.5); },
    'quarter res (1/16 pixels)': () => { shadowOn(); R.setPixelRatio(pr * 0.25); },
    'shadows OFF + half res': () => { shadowOff(); R.setPixelRatio(pr * 0.5); },
  };
  const names = Object.keys(cases);
  const samples = {}; for (const k of names) samples[k] = [];
  // long warm-up first, then round-robin so drift hits every case equally
  cases[names[0]](); for (let i = 0; i < 25; i++) G.render();
  for (let round = 0; round < 5; round++) {
    for (const k of names) {
      cases[k]();
      G.render(); G.render();
      const t = performance.now();
      for (let i = 0; i < n; i++) G.render();
      samples[k].push((performance.now() - t) / n);
    }
  }
  cases[names[0]]();
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return names.map((k) => ({ label: k, ms: med(samples[k]), all: samples[k].map((v) => Math.round(v)) }));
}, N);

console.log(`\nviewport ${W}x${H}, ${N} draws per sample\n`);
for (const r of result) console.log(`  ${String(r.label).padEnd(36)} median ${r.ms.toFixed(1).padStart(8)} ms   samples [${(r.all||[]).join(', ')}]`);
console.log();

await browser.close();
await server.close();
