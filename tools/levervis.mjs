#!/usr/bin/env node
/**
 * levervis.mjs — which of the quality ladder's levers can the player SEE move?
 *
 * `src/core/quality.ts` classifies every rung lever as seam-safe (may move
 * mid-race) or reset-only (must wait for a race build). This is the bench that
 * classification is checked against, and the round-seven review is the reason
 * it exists: the governor was spending the crowd trim mid-race on the
 * start/finish straight, a grandstand emptied in front of the player, and every
 * instrument in that file measures *time*, which a `setDrawRange` costs none of.
 *
 * Freeze one moment, move one lever, count the pixels that changed. Two things
 * make the number mean anything:
 *
 *   **Three control frames.** A harness render advances the visual clock by a
 *   fixed step, so a quarter of a frozen frame moves by itself — the crowd bobs,
 *   the flags ripple, the beacons blink. Only pixels that held still across
 *   three consecutive grabs are counted.
 *
 *   **A null row.** `none` applies nothing and goes through the identical path.
 *   Anything at or under its number is not measurable at this moment, and on a
 *   frame with a crowd in it that is most of them — see the caveat below.
 *
 * **Read the caveat before quoting the table.** The mask that removes animation
 * removes *the crowd*, which is the most animated thing in the frame, so this
 * bench systematically under-reports the one lever a human reviewer could see
 * from across the room. Look at the `-frame.png` pairs as well as the numbers.
 *
 *   node tools/levervis.mjs --course switchback-summit --at 1.2 --rung 2
 *   node tools/levervis.mjs --at 12 --rung 3 --out /tmp/levervis
 *
 * `--at` is seconds of simulation from the grid: 1.2 puts the camera on the
 * start/finish straight with both grandstands in frame, which is the shot the
 * review rejected. `--rung` is the rung the levers are moved *from*.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/levervis');
const COURSE = arg('course', 'switchback-summit');
const AT = Number(arg('at', 1.2));
const RUNG = Number(arg('rung', 2));
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
  window.__grab = () => {
    window.__GAME.render();
    const c = document.querySelector('canvas');
    const cv = document.createElement('canvas');
    cv.width = c.width; cv.height = c.height;
    cv.getContext('2d').drawImage(c, 0, 0);
    return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
  };
  window.__delta = (a, b, i) => {
    const k = i * 4;
    return Math.max(Math.abs(a.data[k] - b.data[k]), Math.abs(a.data[k + 1] - b.data[k + 1]),
      Math.abs(a.data[k + 2] - b.data[k + 2]));
  };
  window.__diff = (a, c, c2, b) => {
    const n = a.width * a.height;
    let stable = 0, changed = 0, sum = 0, max = 0, moving = 0;
    for (let i = 0; i < n; i++) {
      const anim = Math.max(window.__delta(a, c, i), window.__delta(c, c2, i));
      const d = window.__delta(c2, b, i);
      if (anim > 4) { moving++; continue; }
      stable++;
      if (d > 8) { changed++; sum += d; if (d > max) max = d; }
    }
    return { frac: +(changed / Math.max(1, stable)).toFixed(5), pixels: changed,
      movingFrac: +(moving / n).toFixed(3), meanOnChanged: +(sum / Math.max(1, changed)).toFixed(1), max };
  };
  window.__dataurl = (a, b, c, c2) => {
    const cv = document.createElement('canvas');
    cv.width = a.width; cv.height = a.height;
    const g = cv.getContext('2d');
    const out = g.createImageData(a.width, a.height);
    for (let i = 0; i < a.width * a.height; i++) {
      const k = i * 4;
      const anim = Math.max(window.__delta(c, a, i), window.__delta(c, c2, i));
      const d = anim > 4 ? 0 : window.__delta(a, b, i);
      const v = Math.min(255, d * 6);
      out.data[k] = v; out.data[k + 1] = v > 24 ? 0 : v; out.data[k + 2] = v > 24 ? 0 : v; out.data[k + 3] = 255;
    }
    g.putImageData(out, 0, 0);
    return cv.toDataURL('image/png');
  };
});

await ev(async (c) => {
  window.__GAME.setTimeScale(1);
  await window.__GAME.reset({ vehicleId: 'cone', courseId: c, seed: 3, instant: true });
  window.__GAME.setAutopilot(true);
}, COURSE);
await ev((n) => window.__QUALITY.set(n), RUNG);
await ev((t) => window.__GAME.step(t), AT);
await ev(() => window.__GAME.setTimeScale(0));
for (let k = 0; k < 30; k++) await ev(() => window.__GAME.render());
await page.screenshot({ path: path.join(OUT, 'moment.png') });

const ladder = await ev(() => window.__QUALITY.ladder);
// The rung the levers are moved *to*: the one below the base, or the base
// itself at the floor, so `--rung 6` degrades to measuring the floor's own
// values against themselves rather than reading past the end of the table.
const NEXT = Math.min(RUNG + 1, ladder.length - 1);
const rows = [];
const LEVERS = [
  ['none', null, null],
  ['crowd', 'content', ladder[NEXT].content.crowd],
  ['scatter', 'content', ladder[NEXT].content.scatter],
  ['thinFar', 'content', ladder[NEXT].content.thinFar],
  ['minPx', 'content', ladder[NEXT].content.minPx],
  ['shellPx', 'content', ladder[NEXT].content.shellPx],
  ['drawDistance', 'set', ladder[NEXT].drawDistance],
  ['tier', 'set', ladder[NEXT].tier],
  ['aa', 'set', false],
  ['crowdFloor', 'content', ladder[ladder.length - 1].content.crowd],
  ['scatterFloor', 'content', ladder[ladder.length - 1].content.scatter],
  ['thinFarFloor', 'content', ladder[ladder.length - 1].content.thinFar],
];
for (const [lever, kind, val] of LEVERS) {
  await ev((n) => window.__QUALITY.set(n), RUNG);
  await ev((n) => { for (let k = 0; k < n; k++) window.__GAME.render(); }, 10);
  const base = await ev(() => window.__GAME.stats());
  await ev(() => { window.__A = window.__grab(); });
  await ev(() => { window.__C = window.__grab(); });
  await ev(() => { window.__C2 = window.__grab(); });
  if (kind === 'content') {
    await ev((k) => window.__QUALITY.content({ [k.lever]: k.val }), { lever: lever.replace('Floor', ''), val });
  } else if (kind === 'set') {
    await ev((k) => window.__QUALITY.try({ [k.lever]: k.val }), { lever, val });
  }
  await ev(() => { window.__B = window.__grab(); });
  const d = await ev(() => window.__diff(window.__A, window.__C, window.__C2, window.__B));
  const st = await ev(() => window.__GAME.stats());
  rows.push({ lever, val, ...d, dTris: st.triangles - base.triangles, dCalls: st.drawCalls - base.drawCalls,
    baseTris: base.triangles, baseCalls: base.drawCalls });
  console.log(JSON.stringify(rows[rows.length - 1]));
  const u = await ev(() => window.__dataurl(window.__C2, window.__B, window.__C, window.__A));
  await writeFile(path.join(OUT, `${lever}-diff.png`), Buffer.from(u.split(',')[1], 'base64'));
  if (lever === 'crowdFloor' || lever === 'none') {
    await page.screenshot({ path: path.join(OUT, `${lever}-frame.png`) });
  }
}
await writeFile(path.join(OUT, 'levervis.json'), JSON.stringify({ rung: RUNG, at: AT, rows, errors }, null, 2));
console.log('errors', errors.slice(0, 5));
await browser.close();
await server.close();
