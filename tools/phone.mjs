// The phone acceptance test, written from a bug report.
//
//   "There is an issue when I open the currently deployed game on my iPhone,
//    it just starts moving the car before the countdown and there are no
//    controls."
//
// Both halves of that are checked here, at a real iPhone viewport with touch
// emulation on, because both halves shipped: the race ran from the first frame
// of a cold load with the title screen still up (main.ts boots a race so the
// menus have a world to stage against, and nothing stood it down), and the
// build had no touch layer at all.
//
// The first check is the one that matters. It sends NO INPUT — the whole claim
// is that the kart moves on its own, so any input at all would forfeit it.
//
//   node tools/phone.mjs

import { chromium, devices } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium';
const HOLD = 10; // seconds of cold load to sit through, untouched

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  // HMR off: other agents edit src/ while this runs, and a hot reload
  // mid-check destroys the page context under page.evaluate.
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars',
  ],
});

// No `?touch=1` here. The override exists so a desktop reviewer can see the
// layer; this test is asking whether a real phone gets it, so the layer has to
// decide for itself from the viewport it is handed.
const context = await browser.newContext({
  ...devices['iPhone 13'],
  viewport: { width: 844, height: 390 },
  isMobile: true, hasTouch: true, deviceScaleFactor: 2,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 240_000 });

const look = () => page.evaluate(() => {
  const g = window.__GAME;
  const s = g.snapshot();
  const p = s.racers.find((x) => x.isPlayer);
  // `snapshot()` does not carry the phase; the race owns it and `stats()` and
  // the context both publish it. Take whichever is there rather than printing
  // `undefined` in the column the whole test is about.
  const phase = s.phase ?? g.stats?.().phase ?? window.__CTX?.race?.phase ?? '?';
  const menu = document.getElementById('menu');
  const up = !!menu && menu.classList.contains('on');
  return {
    phase, up,
    speed: p ? Math.abs(p.speed) : -1,
    progress: p ? p.progress : -1,
    // The field, not just the player: seven AI drivers racing behind a
    // wordmark is the same bug wearing a different hat.
    fieldSpeed: Math.max(...s.racers.map((r) => Math.abs(r.speed))),
  };
});

const fail = [];
const line = (t, r) => console.log(
  `  ${String(t).padStart(2)}s   ${String(r.phase).padEnd(10)} ${r.speed.toFixed(1).padStart(6)}  ` +
  `${r.fieldSpeed.toFixed(1).padStart(6)}  ${String(r.progress).padStart(8)}   ${r.up ? 'yes' : 'no '}`,
);

// ── 1. cold load, untouched ────────────────────────────────────────────────
console.log('\n  COLD LOAD — no input at all, title screen up\n');
console.log('   t    phase       player   field  progress   menu');
console.log('  ──────────────────────────────────────────────────');

const first = await look();
line(0, first);
if (!first.up) fail.push('the front-end was not up on a cold load — nothing else here means anything');

const start = first.progress;
for (let t = 1; t <= HOLD; t++) {
  await page.evaluate(() => window.__GAME.advance(1));
  const r = await look();
  line(t, r);
  if (r.up && r.fieldSpeed > 0.05) {
    fail.push(`t=${t}s: the field is moving at ${r.fieldSpeed.toFixed(1)} behind the front-end`);
  }
  if (r.up && Math.abs(r.progress - start) > 0.5) {
    fail.push(`t=${t}s: progress walked ${start} → ${r.progress} behind the front-end`);
  }
}

// ── 2. the front-end still answers a tap ───────────────────────────────────
// A race frozen behind a screen nobody can get past is not a fix.
// The front-end marks the screen it is taking input on with `live`. That flag
// is the whole question here — "is the player able to act on this screen" —
// so it is read directly rather than inferred from opacity.
const at = () => page.evaluate(() => {
  const all = [...document.querySelectorAll('#menu .scr')];
  const live = all.filter((s) => s.classList.contains('live'))
    .map((s) => [...s.classList].find((c) => c.startsWith('scr-')) ?? 'scr');
  return live.length ? live.join('+') : `none (of ${all.length})`;
});

const before = await at();
// Tap where a thumb lands: the middle of the title screen, through the real
// event the front-end listens for.
await page.evaluate(() => {
  document.querySelector('#menu .scr-title')?.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true }),
  );
});
// A screen push is animated, and `update` drives it off frame time, so this
// needs frames rather than a single step.
await page.evaluate(() => window.__GAME.advance(1.5));
const afterTap = await at();
const advanced = afterTap !== before && !afterTap.startsWith('none');
console.log(`\n  TAP ON TITLE   ${before} → ${afterTap}   ${advanced ? 'ok' : 'NO RESPONSE'}`);
if (!advanced) fail.push('a tap on the title screen did not advance the front-end');

// ── 3. and the race runs once the player is actually let in ────────────────
// `reset` is the launch path — it is what doLaunch() in the front-end calls.
await page.evaluate(() => window.__GAME.reset());
await page.evaluate(() => window.__GAME.advance(0.5));
const opened = await look();
await page.evaluate(() => window.__GAME.step(12));
const running = await look();
console.log(`\n  AFTER LAUNCH   menu ${opened.up ? 'still up' : 'down'}` +
  `  →  phase ${running.phase}, field ${running.fieldSpeed.toFixed(1)}`);
if (opened.up) fail.push('the front-end did not come down on launch');
if (running.phase !== 'racing') fail.push(`the race did not reach racing (stuck at ${running.phase})`);
if (running.fieldSpeed < 1) fail.push('the field never moved after the flag — the standoff did not lift');

// ── 4. there are controls ──────────────────────────────────────────────────
const controls = await page.evaluate(() => {
  const t = document.getElementById('touch');
  const shown = !!t && getComputedStyle(t).display !== 'none';
  return { shown, buttons: t ? [...t.querySelectorAll('.btn')].map((b) => b.textContent.trim()) : [] };
});
console.log(`\n  CONTROLS       touch layer ${controls.shown ? 'shown' : 'MISSING'}` +
  `  [${controls.buttons.join(' ')}]`);
if (!controls.shown) fail.push('no touch layer on a phone viewport — the player has no controls');
if (controls.buttons.length < 2) fail.push('the touch layer has no buttons on it');

if (errors.length) fail.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);

console.log('');
if (fail.length) {
  for (const f of fail) console.log(`  FAIL  ${f}`);
  console.log('\n  PHONE BUILD BROKEN');
} else {
  console.log('  PHONE BUILD CORRECT — nothing moves until the player is let in, and then there are controls');
}

await browser.close();
await server.close();
process.exit(fail.length ? 1 : 0);
