#!/usr/bin/env node
/**
 * framehalf.mjs — what is a rung of the quality ladder worth on the frame it is
 * taken on, and what does it only pay at the next race build?
 *
 * Since round seven a rung has two halves (see `SEAM_HELD` in
 * src/core/quality.ts): the seam-safe levers land immediately, and the ones a
 * player could watch move — the render scale, the crowd, the verge's share, the
 * edge resolve, the tier, the draw distance — wait for a seam. This walks the
 * ladder twice from one frozen frame:
 *
 *   `__QUALITY.set(i)`  installs a whole rung, which is what a race build does.
 *   `__QUALITY.mid(i)`  installs the frame-half only, which is what a mid-race
 *                       rung change does.
 *
 * Geometry is exact (`renderer.info`, counted after the frustum). Time is
 * measured pairwise off the page's own rAF loop with the simulation frozen,
 * alternating so contention lands on both members, first pass discarded.
 *
 * It also prints the **instancing audit** — every geometry-and-material pair
 * drawn more than eight times without an `InstancedMesh` behind it. That list
 * being empty is the finding, not a null result.
 *
 *   node tools/framehalf.mjs --course switchback-summit
 *   node tools/framehalf.mjs --at 12 --passes 3 --hold 9
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/framehalf');
const COURSE = arg('course', 'switchback-summit');
const AT = Number(arg('at', 12));
const HOLD = Number(arg('hold', 9));
const PASSES = Number(arg('passes', 3));
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
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 300000 });
const ev = (fn, a) => page.evaluate(fn, a);

await ev(() => {
  window.__T = [];
  let last = 0;
  const tick = (t) => { if (last) window.__T.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});

await ev(async (c) => {
  window.__GAME.setTimeScale(1);
  await window.__GAME.reset({ vehicleId: 'cone', courseId: c, seed: 3, instant: true });
  window.__GAME.setAutopilot(true);
}, COURSE);
await ev((t) => window.__GAME.step(t), AT);
await ev(() => window.__GAME.setTimeScale(0));
for (let k = 0; k < 30; k++) await ev(() => window.__GAME.render());

const ladder = await ev(() => window.__QUALITY.ladder);

// ── the instancing audit, on the heaviest course's own racing frame ────────
const audit = await ev(() => {
  const a = window.__QUALITY.audit();
  return { total: a.total, groups: a.groups.slice(0, 8), offenders: a.offenders.slice(0, 12),
    items: a.items.slice(0, 12) };
});
console.log('AUDIT total', JSON.stringify(audit.total));
console.log('AUDIT groups', JSON.stringify(audit.groups));
console.log('AUDIT offenders', JSON.stringify(audit.offenders));
console.log('AUDIT items', JSON.stringify(audit.items));

async function shot(label) {
  const st = await ev(() => window.__GAME.stats());
  const q = await ev(() => {
    const p = window.__QUALITY.probe();
    return { rung: p.rung, seamRung: p.seamRung, pending: p.pending, scale: p.scale,
      crowd: p.content.crowd, crowdLive: p.content.crowdLive,
      scatterLive: p.content.scatterLive, thinFar: p.content.thinFar,
      thinned: p.content.thinned, culled: p.content.culled, shelled: p.content.shelled };
  });
  return { label, tris: st.triangles, calls: st.drawCalls, ...q };
}

// ── geometry: the whole-rung walk against the frame-half walk ──────────────
const whole = [];
for (let i = 0; i < ladder.length; i++) {
  await ev((n) => window.__QUALITY.set(n), i);
  for (let k = 0; k < 6; k++) await ev(() => window.__GAME.render());
  whole.push(await shot(`set ${i} ${ladder[i].label}`));
  console.log('WHOLE', JSON.stringify(whole[whole.length - 1]));
}
const mid = [];
await ev(() => window.__QUALITY.set(0));
for (let k = 0; k < 6; k++) await ev(() => window.__GAME.render());
for (let i = 0; i < ladder.length; i++) {
  await ev((n) => window.__QUALITY.mid(n), i);
  for (let k = 0; k < 6; k++) await ev(() => window.__GAME.render());
  mid.push(await shot(`mid ${i} ${ladder[i].label}`));
  console.log('MID  ', JSON.stringify(mid[mid.length - 1]));
}

// ── time: pairwise, alternating, first pass discarded ──────────────────────
async function period(apply, seconds) {
  await apply();
  await ev(() => { window.__T.length = 0; });
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const t = await ev(() => window.__T.slice());
  if (!t.length) return { med: 0, n: 0 };
  const s = [...t].sort((a, b) => a - b);
  return { med: +s[Math.floor(s.length / 2)].toFixed(1), n: t.length };
}
const pairs = [];
for (let p = 0; p < PASSES + 1; p++) {
  const a = await period(() => ev(() => { window.__QUALITY.set(0); window.__QUALITY.mid(0); }), HOLD);
  const b = await period(() => ev(() => { window.__QUALITY.set(0); window.__QUALITY.mid(6); }), HOLD);
  const c = await period(() => ev(() => window.__QUALITY.set(6)), HOLD);
  pairs.push({ pass: p, rung0: a, midFloor: b, wholeFloor: c, warmup: p === 0 });
  console.log('PAIR', JSON.stringify(pairs[pairs.length - 1]));
}

const real = pairs.filter((p) => !p.warmup);
const avg = (f) => +(real.reduce((s, p) => s + f(p), 0) / Math.max(1, real.length)).toFixed(1);
console.log('\n=== summary ===');
console.log(`rung0 ${avg((p) => p.rung0.med)}ms  frame-half floor ${avg((p) => p.midFloor.med)}ms`
  + `  whole floor ${avg((p) => p.wholeFloor.med)}ms`);
console.log(`frame-half alone buys ${(100 * (1 - avg((p) => p.midFloor.med) / avg((p) => p.rung0.med))).toFixed(1)}%`
  + `, the whole rung buys ${(100 * (1 - avg((p) => p.wholeFloor.med) / avg((p) => p.rung0.med))).toFixed(1)}%`);
await writeFile(path.join(OUT, 'framehalf.json'), JSON.stringify({ ladder, audit, whole, mid, pairs, errors }, null, 2));
console.log('errors', errors.slice(0, 5));
await browser.close();
await server.close();
