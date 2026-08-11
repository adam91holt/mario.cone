#!/usr/bin/env node
/**
 * perfgate.mjs — does the quality governor ever change the picture at a moment
 * the player is looking at one?
 *
 * The last review of `core/quality.ts` found the answer by *photographing* the
 * moment of every rung change and reading the countdown numeral off the
 * screenshot. That should not have been necessary and now it is not: every
 * entry in `__QUALITY.probe().log` carries the `phase` it fired in, and every
 * judgement of a cut — including the ones that move nothing — is in
 * `.verdicts`. This bench reads both, and still takes the photograph.
 *
 * Rules of this bench, inherited from tools/critic-live.mjs: it never calls
 * __GAME.render / step / advance / reset, because any of those latch the
 * governor into 'bench' and it stops measuring. It gets into the game the way a
 * player does (__MENU.close) and then only reads — with one exception, marked
 * PRESSURE below, which uses seek() (an event emit; it neither renders nor
 * steps) to put a fresh countdown in front of a governor deliberately re-armed
 * at the top rung. That is the case the fix exists for and it will not occur by
 * itself on a machine that has already walked down.
 *
 *   node tools/perfgate.mjs --seconds 120 --out /tmp/perfgate
 *   node tools/perfgate.mjs --no-pressure       (just watch it play)
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/perfgate');
const SECONDS = Number(arg('seconds', 120));
const W = Number(arg('width', 1600)), H = Number(arg('height', 900));
const PRESSURE = !process.argv.includes('--no-pressure');
/** Seconds of ordinary play before the pressure test is applied. */
const PRESSURE_AT = Number(arg('pressure-at', 70));

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

// Close the front end exactly the way the OK key does, then hand the kart to a
// CPU driver so the machine is doing real racing work rather than idling on the
// grid. setAutopilot neither renders nor steps, so the governor is untouched.
await page.evaluate(() => {
  window.__MENU?.set?.({ vehicleId: 'cone', courseId: 'cone-canyon' });
  window.__MENU?.close?.();
  window.__GAME.setAutopilot(true);
});

const read = () => page.evaluate(() => {
  const q = window.__QUALITY?.probe?.();
  if (!q) return null;
  return {
    rung: q.rung, label: q.label, scale: q.scale, phase: q.phase, locked: q.locked,
    holding: q.holding, wallMs: q.wallMs, medianMs: q.wallMedianMs, madMs: q.wallMadMs,
    worstMs: q.wallWorstMs, samples: q.samples, fps: q.fps, liveSeconds: q.liveSeconds,
    futile: q.futile, stalled: q.stalled, benched: q.benched, auto: q.auto,
    suspended: q.suspended, hijacked: q.hijacked, log: q.log, verdicts: q.verdicts,
  };
}).catch(() => null);

const samples = [];
const seenRung = new Set();
const t0 = Date.now();
let pressureDone = !PRESSURE;
let lastLog = 0;

while ((Date.now() - t0) / 1000 < SECONDS) {
  // Fast poll: a countdown is three seconds long and the whole question is
  // whether anything moved inside it.
  await new Promise((r) => setTimeout(r, 400));
  const p = await read();
  if (!p) continue;
  const wall = +((Date.now() - t0) / 1000).toFixed(1);
  samples.push({ wall, ...p, log: undefined, verdicts: undefined });

  if (p.log.length !== lastLog || !seenRung.has(p.rung)) {
    console.log(`t=${wall}s rung=${p.rung}(${p.label}) sc=${p.scale} phase=${p.phase}`
      + ` lock=${p.locked ? 'Y' : 'n'} hold="${p.holding}" wall=${p.wallMs} med=${p.medianMs}`
      + ` mad=${p.madMs} n=${p.samples} live=${p.liveSeconds}s futile=${p.futile}`
      + ` stall=${p.stalled} bench=${p.benched}`);
  }
  if (p.log.length !== lastLog) {
    lastLog = p.log.length;
    const c = p.log[p.log.length - 1];
    // Photograph the frame the change landed on, with the phase in the name.
    await page.screenshot({ path: path.join(OUT, `change-${lastLog}-r${c.to}-${c.phase}-t${wall}.png`) });
  }
  if (!seenRung.has(p.rung)) {
    seenRung.add(p.rung);
    await page.screenshot({ path: path.join(OUT, `rung${p.rung}-${p.label}-${p.phase}-t${wall}.png`) });
  }

  // ── PRESSURE ────────────────────────────────────────────────────────────
  // Re-arm the governor at the top rung and put a countdown in front of it. On
  // this machine rung 0 is two frames a second, so the emergency path is armed
  // and wants to fire within the countdown's three seconds. Before the moment
  // gate it did exactly that — twice, on the "1" and on "GO!".
  if (!pressureDone && wall >= PRESSURE_AT) {
    pressureDone = true;
    console.log('--- pressure: rung 0, auto on, straight into a countdown ---');
    await page.evaluate(() => {
      window.__QUALITY.set(0);
      window.__QUALITY.auto(true);
      window.__GAME.seek('countdown');
    });
    const held = [];
    // Long enough for the governor to re-arm from scratch on a machine at
    // 1.5s a frame: SKIP_FRAMES + PANIC_SAMPLES is seven delivered frames
    // before it is even allowed to have an opinion.
    const until = Date.now() + Number(arg('pressure-for', 30)) * 1000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
      const q = await read();
      if (!q) continue;
      held.push({
        t: +((Date.now() - t0) / 1000).toFixed(1),
        phase: q.phase, locked: q.locked, rung: q.rung, holding: q.holding,
        wallMs: q.wallMs, live: q.liveSeconds,
      });
      const line = held[held.length - 1];
      console.log(`   ${line.t}s phase=${line.phase} lock=${line.locked ? 'Y' : 'n'}`
        + ` rung=${line.rung} hold="${line.holding}" wall=${line.wallMs} live=${line.live}`);
      if (q.phase === 'countdown') {
        await page.screenshot({ path: path.join(OUT, `pressure-countdown-r${q.rung}-t${line.t}.png`) });
      }
    }
    await writeFile(path.join(OUT, 'pressure.json'), JSON.stringify(held, null, 2));
    const inCeremony = held.filter((h) => h.phase !== 'racing');
    const rungs = new Set(inCeremony.map((h) => h.rung));
    console.log(`--- pressure verdict: rungs seen during ceremony = ${[...rungs].join(',')}`
      + ` (must be a single value) ---`);
  }
}

await page.screenshot({ path: path.join(OUT, 'final.png') });
const final = await read();
console.log('\n=== change log (phase must read "racing" on every line) ===');
for (const c of final?.log ?? []) console.log(JSON.stringify(c));
console.log('\n=== verdicts ===');
for (const v of final?.verdicts ?? []) console.log(JSON.stringify(v));
console.log('\nerrors:', errors.slice(0, 10));
// The sealed phases. `intro` is not one of them — it carries the valve that
// stops the gate deadlocking a machine whose simulation has been starved into
// slow motion by the very slowness the governor is trying to fix. See
// CEREMONY_PATIENCE in src/core/quality.ts.
const SEALED = ['countdown', 'finished', 'results', 'loading'];
const bad = (final?.log ?? []).filter((c) => SEALED.includes(c.phase));
console.log(bad.length
  ? `FAIL: ${bad.length} change(s) inside a sealed phase: ${bad.map((c) => c.phase).join(',')}`
  : `PASS: no change landed in ${SEALED.join('/')}`);
await writeFile(path.join(OUT, 'perfgate.json'),
  JSON.stringify({ samples, log: final?.log ?? [], verdicts: final?.verdicts ?? [], errors }, null, 2));
await browser.close();
await server.close();
