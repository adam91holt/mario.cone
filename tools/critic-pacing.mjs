#!/usr/bin/env node
/**
 * hitch.mjs — independent critic bench. Frame PACING, not frame average.
 *
 * Nintendo's bar is a flat frame time. This records every delivered frame's
 * wall period from inside the page, plus renderer program count, plus the
 * governor's rung, and reports the distribution + every moment a new shader
 * program appeared (a compile hitch the player sees as a freeze).
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = '/home/user/mario.cone';
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SECONDS = Number(opt('seconds', 70));
const W = Number(opt('width', 1280)), H = Number(opt('height', 720));
const OUT = opt('out', '/tmp/hitch');
await mkdir(OUT, { recursive: true });

const server = await createServer({ root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, optimizeDeps: { include: ['three'] } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 240000 });

// Install the recorder BEFORE closing the menu, so boot + the launch curtain +
// the first race frames are all in the trace.
await page.evaluate(() => {
  const rec = { frames: [], progEvents: [], last: performance.now(), lastProg: -1 };
  window.__HITCH = rec;
  const tick = () => {
    const now = performance.now();
    const dt = now - rec.last; rec.last = now;
    let prog = -1, calls = 0, tris = 0;
    const s = window.__GAME?.stats?.();
    if (s) { prog = s.programs; calls = s.drawCalls; tris = s.triangles; }
    rec.frames.push([+dt.toFixed(2), prog, calls, tris]);
    if (prog !== rec.lastProg) {
      rec.progEvents.push({ t: +(now / 1000).toFixed(2), from: rec.lastProg, to: prog, frame: rec.frames.length, dt: +dt.toFixed(1) });
      rec.lastProg = prog;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

await page.evaluate(() => {
  window.__MENU?.set?.({ vehicleId: 'cone', courseId: 'cone-canyon' });
  window.__MENU?.close?.();
  window.__GAME.setAutopilot(true);
});

const t0 = Date.now();
const marks = [];
while ((Date.now() - t0) / 1000 < SECONDS) {
  await new Promise((r) => setTimeout(r, 3000));
  const m = await page.evaluate(() => {
    const q = window.__QUALITY?.probe?.();
    const s = window.__GAME.snapshot();
    const pl = s.racers.find((r) => r.isPlayer);
    const st = window.__GAME.stats();
    return {
      phase: s.race?.phase, lap: pl?.lap, place: pl?.place, speed: +(pl?.speed ?? 0).toFixed(1),
      rung: q?.rung, label: q?.label, scale: q?.scale, gov: q?.holding,
      liveWall: q?.wallMs, worst: q?.wallWorstMs, live: q?.liveSeconds,
      progs: st.programs, calls: st.drawCalls, tris: st.triangles,
      frames: window.__HITCH.frames.length,
    };
  }).catch(() => null);
  if (m) { marks.push({ t: +((Date.now() - t0) / 1000).toFixed(0), ...m }); console.log(JSON.stringify(marks[marks.length - 1])); }
}
await page.screenshot({ path: path.join(OUT, 'final.png') });
const rec = await page.evaluate(() => ({ frames: window.__HITCH.frames, progEvents: window.__HITCH.progEvents }));
await writeFile(path.join(OUT, 'hitch.json'), JSON.stringify({ marks, rec, errors }, null, 2));

const dts = rec.frames.map((f) => f[0]).slice(2);
dts.sort((a, b) => a - b);
const pct = (p) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))];
console.log('\n=== frame pacing over', dts.length, 'delivered frames ===');
console.log('median', pct(0.5).toFixed(1), 'p90', pct(0.9).toFixed(1), 'p99', pct(0.99).toFixed(1), 'max', pct(1).toFixed(1));
const med = pct(0.5);
const spikes = rec.frames.filter((f) => f[0] > med * 2.5).length;
console.log('frames >2.5x median:', spikes, '(', (100 * spikes / rec.frames.length).toFixed(1), '% )');
console.log('\n=== program count changes (shader compiles) ===');
for (const e of rec.progEvents) console.log(JSON.stringify(e));
console.log('errors:', errors.slice(0, 8));
await browser.close();
await server.close();
