#!/usr/bin/env node
/**
 * racetrace.mjs — a live race with every delivered frame timed, and every rung
 * change located in that timeline.
 *
 * The question this answers is the one a frozen-frame bench cannot: while a
 * person is actually playing, when does the quality governor move, what does it
 * move, and is the worst frame of the session one it caused?
 *
 * Rules, inherited from tools/critic-live.mjs: it never calls `__GAME.render`,
 * `step` or `advance`, because any of those latch the governor into `bench` and
 * it stops measuring. It does call `__GAME.reset` — twice, and deliberately:
 * that is `startRace` in main.ts, the same call the launch board makes
 * (`doLaunch` in ui/menus/index.ts), it primes exactly one frame, and
 * `reset()` re-baselines `benchFrames` first so one priming render cannot latch
 * anything. `benched` is read on every poll and printed at the end; if it is
 * ever true the trace is worthless and says so.
 *
 * The instrument is a second rAF callback registered alongside the engine's own:
 * it runs in the same frame batch, so the gap between consecutive calls is the
 * period at which frames are actually *delivered* — which is the only honest
 * measure of a frame on a machine whose GPU is the bottleneck (see the header
 * of src/core/quality.ts).
 *
 *   node tools/racetrace.mjs --course switchback-summit --seconds 600 --rebuild-at 330
 *   node tools/racetrace.mjs --seconds 240            (no second race build)
 *
 * `--rebuild-at` is the whole point of the round-seven version: it starts a
 * second race part way through, which is the **seam** — the one moment the
 * reset-only half of a rung is allowed to land. The report prints the frame
 * distribution either side of it.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/racetrace');
const COURSE = arg('course', 'switchback-summit');
const SECONDS = Number(arg('seconds', 600));
/** Wall seconds in before a second race is started — the seam. 0 disables. */
const REBUILD_AT = Number(arg('rebuild-at', 0));
const W = Number(arg('width', 1600)), H = Number(arg('height', 900));

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
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 300000 });

// The frame recorder, registered before the race starts so the trace covers it.
await page.evaluate(() => {
  window.__T = { frames: [] };
  let last = 0;
  const tick = (t) => {
    if (last) window.__T.frames.push(+(t - last).toFixed(2));
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// Into the race, on the course this trace is about. `__MENU.close()` only takes
// the front-end off; the race underneath it is the boot race on the default
// course, so a trace that means to measure the heaviest course has to build one.
await page.evaluate(async (c) => {
  window.__MENU?.close?.();
  await window.__GAME.reset({ vehicleId: 'cone', courseId: c, seed: 5 });
  window.__GAME.setAutopilot(true);
}, COURSE);

const read = () => page.evaluate(() => {
  const q = window.__QUALITY?.probe?.();
  if (!q) return null;
  return {
    n: window.__T.frames.length,
    track: window.__GAME.snapshot().track?.id,
    rung: q.rung, seamRung: q.seamRung, pending: q.pending, label: q.label,
    scale: q.scale, phase: q.phase, holding: q.holding, log: q.log,
    verdicts: q.verdicts, liveSeconds: q.liveSeconds, futile: q.futile,
    stalled: q.stalled, benched: q.benched,
    crowd: q.content.crowd, crowdLive: q.content.crowdLive,
    scatter: q.content.scatter, scatterLive: q.content.scatterLive,
    thinned: q.content.thinned, culled: q.content.culled, shelled: q.content.shelled,
    sessionMedianMs: q.sessionMedianMs, sessionWorstMs: q.sessionWorstMs,
    changeWorstMs: q.changeWorstMs, changeWorstRatio: q.changeWorstRatio,
  };
}).catch(() => null);

const t0 = Date.now();
let rebuilt = REBUILD_AT <= 0;
let lastLog = 0;
let lastPhase = '';
const changes = [];
const samples = [];
while ((Date.now() - t0) / 1000 < SECONDS) {
  await new Promise((r) => setTimeout(r, 250));
  const p = await read();
  if (!p) continue;
  const wall = +((Date.now() - t0) / 1000).toFixed(1);
  samples.push({ wall, n: p.n, rung: p.rung, seamRung: p.seamRung, pending: p.pending,
    phase: p.phase, holding: p.holding, crowdLive: p.crowdLive, thinned: p.thinned });
  if (p.log.length !== lastLog) {
    for (let i = lastLog; i < p.log.length; i++) {
      // The change is located to the poll that first saw it, so its frame index
      // is the end of a window at most 250ms wide.
      changes.push({ ...p.log[i], atFrame: p.n, wall });
    }
    lastLog = p.log.length;
    const c = p.log[p.log.length - 1];
    console.log(`CHANGE t=${wall}s frame~${p.n} ${c.from}->${c.to} why="${c.why}"`
      + ` phase=${c.phase} seam=${c.seamRung} deferred="${c.deferred}" scale=${c.scale}`);
    await page.screenshot({ path: path.join(OUT, `change-${lastLog}-r${c.to}-${c.phase}.png`) });
  }
  if (!rebuilt && (Date.now() - t0) / 1000 >= REBUILD_AT) {
    rebuilt = true;
    console.log(`--- race build: rung ${p.rung}, seam ${p.seamRung}, pending "${p.pending}" ---`);
    await page.screenshot({ path: path.join(OUT, 'before-seam.png') });
    await page.evaluate(async (c) => {
      await window.__GAME.reset({ vehicleId: 'cone', courseId: c, seed: 5 });
      window.__GAME.setAutopilot(true);
    }, COURSE);
    await new Promise((r) => setTimeout(r, 8000));
    const q = await read();
    console.log(`--- after the build: rung ${q?.rung}, seam ${q?.seamRung},`
      + ` pending "${q?.pending}", scale ${q?.scale}, crowd ${q?.crowd}/${q?.crowdLive} ---`);
    await page.screenshot({ path: path.join(OUT, 'after-seam.png') });
    changes.push({ why: 'RACE BUILD (seam)', atFrame: q?.n ?? p.n, wall,
      from: p.rung, to: q?.rung ?? p.rung, phase: q?.phase ?? '', deferred: '',
      seamRung: q?.seamRung ?? -1, scale: q?.scale ?? 0 });
  }
  if (p.phase !== lastPhase) {
    lastPhase = p.phase;
    console.log(`  phase=${p.phase} t=${wall}s rung=${p.rung} seam=${p.seamRung}`
      + ` pending="${p.pending}" crowd=${p.crowd}/${p.crowdLive} thinned=${p.thinned}`
      + ` med=${p.sessionMedianMs} worst=${p.sessionWorstMs}`);
  }
}

const final = await read();
const frames = await page.evaluate(() => window.__T.frames);
await page.screenshot({ path: path.join(OUT, 'final.png') });

// ── the report ────────────────────────────────────────────────────────────
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(1) : 0; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length * 0.95)].toFixed(1) : 0; };
const seam = changes.find((c) => c.why === 'RACE BUILD (seam)');
const rungChanges = changes.filter((c) => c.why !== 'RACE BUILD (seam)');
const worst = Math.max(...frames);
const worstAt = frames.indexOf(worst);
console.log('\n=== frames ===');
console.log(`delivered ${frames.length}  median ${med(frames)}ms  p95 ${p95(frames)}ms  worst ${worst}ms @${worstAt}`);
if (seam) {
  const before = frames.slice(0, seam.atFrame - 6);
  const after = frames.slice(seam.atFrame + 6);
  console.log(`BEFORE the seam  n=${before.length}  median ${med(before)}ms  p95 ${p95(before)}ms  worst ${Math.max(...before)}ms`);
  console.log(`AFTER  the seam  n=${after.length}  median ${med(after)}ms  p95 ${p95(after)}ms  worst ${Math.max(...after)}ms`);
}
console.log('\nworst twelve frames, and what was happening on them:');
for (const f of frames.map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v).slice(0, 12)) {
  const near = rungChanges.filter((c) => Math.abs(c.atFrame - f.i) <= 12).map((c) => `${c.from}->${c.to}`);
  const onSeam = seam && Math.abs(seam.atFrame - f.i) <= 20;
  console.log(`  frame ${f.i}  ${f.v}ms  ${near.length ? 'RUNG CHANGE ' + near.join(',') : ''}${onSeam ? ' RACE BUILD' : ''}`);
}
console.log('\n=== changes ===');
for (const c of changes) console.log(JSON.stringify(c));
console.log('\n=== verdicts ===');
for (const v of final?.verdicts ?? []) console.log(JSON.stringify(v));
console.log('\nfinal:', JSON.stringify({
  track: final?.track, benched: final?.benched, rung: final?.rung, seamRung: final?.seamRung,
  pending: final?.pending, scale: final?.scale, crowd: final?.crowd, crowdLive: final?.crowdLive,
  thinned: final?.thinned, culled: final?.culled, shelled: final?.shelled,
  sessionMedianMs: final?.sessionMedianMs, sessionWorstMs: final?.sessionWorstMs,
  changeWorstMs: final?.changeWorstMs, changeWorstRatio: final?.changeWorstRatio,
}));
// The phases the picture is composed in and a change must not land in. `intro`
// is not one of them — it carries the valve that stops the gate deadlocking a
// starved simulation; see CEREMONY_PATIENCE in src/core/quality.ts.
const SEALED = ['countdown', 'finished', 'results', 'loading'];
const bad = rungChanges.filter((c) => SEALED.includes(c.phase));
console.log(bad.length
  ? `FAIL: ${bad.length} change(s) inside a sealed phase: ${bad.map((c) => c.phase).join(',')}`
  : `PASS: no change landed in ${SEALED.join('/')}`);
const crowdMoved = rungChanges.filter((c) => !String(c.deferred ?? '').includes('crowd')
  && c.to !== c.seamRung);
console.log(crowdMoved.length
  ? `FAIL: the crowd moved on ${crowdMoved.length} mid-race change(s)`
  : 'PASS: no mid-race change moved the crowd');
console.log('errors:', errors.slice(0, 6));
await writeFile(path.join(OUT, 'racetrace.json'), JSON.stringify({
  frames, changes, samples, verdicts: final?.verdicts ?? [], final, errors,
}, null, 2));
await browser.close();
await server.close();
