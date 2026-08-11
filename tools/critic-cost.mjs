#!/usr/bin/env node
/**
 * critic-cost.mjs — independent critic bench. What does the ladder actually buy?
 *
 * Frozen racing frame. For each rung: install the WHOLE rung (`set`) and take
 * the median real rAF period, then repeat the walk with `mid()` only — which is
 * the ladder a player gets inside a single race. Interleaved passes so page
 * warm-up cannot flatter whichever went first.
 *
 * WARNING about the times this prints: under SwiftShader a frame is ~1s, so a
 * 2.2s window is one or two samples and the medians it reports are noise. Read
 * the TRIANGLES and DRAW CALLS from this bench, which are exact, and take
 * throughput from tools/critic-bloom.mjs, which counts frames over a fixed wall
 * window instead of trying to time one.
 *
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
const OUT = opt('out', '/tmp/critic-cost');
const W = Number(opt('width', 1280)), H = Number(opt('height', 720));
const PASSES = Number(opt('passes', 3));
const SAMPLE = Number(opt('sample', 2200)); // ms per rung per pass
await mkdir(OUT, { recursive: true });

const server = await createServer({ root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, optimizeDeps: { include: ['three'] } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 240000 });

// Get to a real racing moment, then freeze the simulation.
await page.evaluate(async () => {
  window.__MENU?.set?.({ vehicleId: 'cone', courseId: 'cone-canyon' });
  window.__MENU?.close?.();
  window.__GAME.setAutopilot(true);
  window.__GAME.seek('racing');
  window.__GAME.step(9);
  window.__GAME.render();
  window.__GAME.setTimeScale(0);
});

// A rAF period recorder we can arm and read.
await page.evaluate(() => {
  window.__PACE = { on: false, dts: [], last: 0 };
  const tick = () => {
    const now = performance.now();
    if (window.__PACE.on) {
      if (window.__PACE.last) window.__PACE.dts.push(now - window.__PACE.last);
      window.__PACE.last = now;
    } else window.__PACE.last = 0;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const ladder = await page.evaluate(() => window.__QUALITY.ladder);
const audit = await page.evaluate(() => window.__QUALITY.audit());

async function measure(mode, i) {
  await page.evaluate(({ mode, i }) => {
    if (mode === 'set') window.__QUALITY.set(i);
    else { window.__QUALITY.set(0); window.__QUALITY.mid(i); }
    window.__PACE.on = false; window.__PACE.dts.length = 0;
  }, { mode, i });
  await new Promise((r) => setTimeout(r, 350));           // let the change settle
  await page.evaluate(() => { window.__PACE.on = true; });
  await new Promise((r) => setTimeout(r, SAMPLE));
  return page.evaluate(() => {
    window.__PACE.on = false;
    const d = window.__PACE.dts.slice().sort((a, b) => a - b);
    const s = window.__GAME.stats();
    const q = window.__QUALITY.probe();
    return {
      n: d.length,
      median: d.length ? +d[Math.floor(d.length / 2)].toFixed(1) : 0,
      p90: d.length ? +d[Math.floor(d.length * 0.9)].toFixed(1) : 0,
      calls: s.drawCalls, tris: s.triangles, programs: s.programs,
      simMs: +(s.simMs ?? 0).toFixed(2), updateMs: +(s.updateMs ?? 0).toFixed(2), drawMs: +(s.drawMs ?? 0).toFixed(2),
      scale: q.scale, tier: q.tier, aa: q.aa, dd: q.drawDistance, particles: q.particles,
      systems: (s.systems ?? []).slice(0, 8),
    };
  });
}

const acc = { set: [], mid: [] };
for (let p = 0; p < PASSES; p++) {
  for (const mode of ['set', 'mid']) {
    for (let i = 0; i < ladder.length; i++) {
      const r = await measure(mode, i);
      (acc[mode][i] ??= []).push(r);
      console.log(`pass${p} ${mode}(${i}) ${ladder[i].label.padEnd(6)} med=${String(r.median).padStart(7)}ms p90=${String(r.p90).padStart(7)} n=${r.n} calls=${r.calls} tris=${r.tris} progs=${r.programs} scale=${r.scale}`);
    }
  }
}

function fold(list) {
  const med = list.map((r) => r.median).sort((a, b) => a - b);
  return {
    median: +med[Math.floor(med.length / 2)].toFixed(1),
    calls: list[list.length - 1].calls, tris: list[list.length - 1].tris,
    programs: list[list.length - 1].programs, scale: list[list.length - 1].scale,
    tier: list[list.length - 1].tier, aa: list[list.length - 1].aa,
    simMs: list[list.length - 1].simMs, updateMs: list[list.length - 1].updateMs, drawMs: list[list.length - 1].drawMs,
  };
}

console.log('\n=== WHOLE RUNG (set) — what a race build lands ===');
const setF = acc.set.map(fold);
for (let i = 0; i < setF.length; i++) {
  const f = setF[i];
  console.log(`rung ${i} ${ladder[i].label.padEnd(6)} ${String(f.median).padStart(7)}ms  x${(setF[0].median / f.median).toFixed(2)}  ${String(f.calls).padStart(4)} calls  ${String(f.tris).padStart(7)} tris  progs ${f.programs}  scale ${f.scale} tier ${f.tier} aa ${f.aa}`);
}
console.log('\n=== FRAME-HALF ONLY (mid) — what a player gets inside one race ===');
const midF = acc.mid.map(fold);
for (let i = 0; i < midF.length; i++) {
  const f = midF[i];
  console.log(`mid  ${i} ${ladder[i].label.padEnd(6)} ${String(f.median).padStart(7)}ms  x${(midF[0].median / f.median).toFixed(2)}  ${String(f.calls).padStart(4)} calls  ${String(f.tris).padStart(7)} tris  progs ${f.programs}  scale ${f.scale}`);
}
console.log('\n=== per-system CPU at rung 0 ===');
for (const s of acc.set[0][acc.set[0].length - 1].systems) console.log(` ${s.name.padEnd(12)} sim ${s.simMs.toFixed(3)}ms  update ${s.updateMs.toFixed(3)}ms`);
console.log('\n=== frame composition at rung 0 ===');
console.log('total', JSON.stringify(audit.total));
for (const g of audit.groups.slice(0, 10)) console.log(' ', JSON.stringify(g));
console.log('offenders (same geo+material drawn by N separate meshes):');
for (const o of (audit.offenders ?? []).slice(0, 12)) console.log(' ', JSON.stringify(o));
console.log('errors:', errors.slice(0, 8));

await writeFile(path.join(OUT, 'cost.json'), JSON.stringify({ ladder, setF, midF, audit, raw: acc, errors }, null, 2));
await browser.close();
await server.close();
