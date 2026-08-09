#!/usr/bin/env node
// Reviewer-owned capture for the front-end. Drives window.__MENU + __GAME.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = process.argv[2] || '/tmp/menus';
const W = 1600, H = 900;

const server = await createServer({ root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['three'] } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await mkdir(OUT, { recursive: true });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120000 });

const ev = (fn, ...a) => page.evaluate(([f, args]) => {
  // eslint-disable-next-line no-new-func
  return new Function('args', 'return (' + f + ').apply(null, args)')(args);
}, [fn.toString(), a]);

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  console.log('  shot', name);
};

const probe = () => ev(() => JSON.parse(JSON.stringify(globalThis.__MENU?.probe?.() ?? null)));
const menu = (verb) => ev((v) => globalThis.__MENU.press(v), verb);
const open = (at) => ev((a) => globalThis.__MENU.open(a), at);
const advance = (s, fps = 30) => ev((sec, f) => window.__GAME.advance(sec, f), s, fps);
const render = () => ev(() => window.__GAME.render());
const scale = (s) => ev((v) => window.__GAME.setTimeScale(v), s);

console.log('boot probe:', JSON.stringify(await probe()));

// 1. Title exactly as it boots.
await advance(0.05, 30);
await shot('00-boot');
await advance(1.5, 30);
await shot('01-title-settled');
await advance(3.0, 30);
await shot('02-title-later');

// 2. Walk the flow the way a player does.
await menu('menu.ok');
await advance(0.12, 30); await shot('03-title-to-racer-early');
await advance(0.5, 30); await shot('04-racer-arrive');
await advance(1.2, 30); await shot('05-racer-settled');
console.log('after ok:', JSON.stringify(await probe()));

// 3. Cursor move — frame by frame with the clock frozen so the pop is visible.
await menu('menu.right');
await advance(0.05, 60); await shot('06-move-t05');
await advance(0.05, 60); await shot('07-move-t10');
await advance(0.10, 60); await shot('08-move-t20');
await advance(0.60, 30); await shot('09-move-settled');
console.log('after right:', JSON.stringify(await probe()));

await menu('menu.right'); await advance(0.7, 30);
await menu('menu.right'); await advance(0.7, 30); await shot('10-racer-third');
console.log('after 3 rights:', JSON.stringify(await probe()));

// 4. Course screen.
await menu('menu.ok');
await advance(0.15, 30); await shot('11-racer-to-course-early');
await advance(1.4, 30); await shot('12-course-settled');
console.log('course screen:', JSON.stringify(await probe()));
await menu('menu.right'); await advance(0.8, 30); await shot('13-course-next');
await menu('menu.down'); await advance(0.8, 30); await shot('14-course-cup-down');
console.log('after cup down:', JSON.stringify(await probe()));

// 5. Class screen.
await menu('menu.ok'); await advance(1.4, 30); await shot('15-class-settled');
console.log('class screen:', JSON.stringify(await probe()));
await menu('menu.right'); await advance(0.8, 30); await shot('16-class-next');
console.log('after class right:', JSON.stringify(await probe()));

// 6. Back navigation.
await menu('menu.back'); await advance(0.9, 30); await shot('17-back-to-course');
console.log('after back:', JSON.stringify(await probe()));
await menu('menu.ok'); await advance(1.2, 30);

// 7. The launch: class -> race. Photograph the wipe densely.
await menu('menu.ok');
for (let i = 0; i < 14; i++) {
  await advance(0.08, 60);
  const p = await probe();
  await shot('18-launch-' + String(i).padStart(2, '0') + '-w' + (p ? p.wipe : 'x'));
}
await advance(1.2, 30); await shot('19-launch-after');
console.log('post-launch probe:', JSON.stringify(await probe()));
console.log('post-launch snapshot phase:', await ev(() => window.__GAME.snapshot().race?.phase));

// 8. Pause: does the menu come back mid-race?
await ev(() => window.__GAME.press('pause'));
await advance(0.8, 30); await shot('20-pause-attempt');
console.log('pause probe:', JSON.stringify(await probe()));

// 9. Re-open menus over a live race (the reviewer's bench).
await open('racer'); await advance(1.2, 30); await shot('21-reopen-racer');
await open('course'); await advance(1.2, 30); await shot('22-reopen-course');
await open('class'); await advance(1.2, 30); await shot('23-reopen-class');
await open('title'); await advance(1.5, 30); await shot('24-reopen-title');

// 10. Small viewport — does it hold up?
await page.setViewportSize({ width: 900, height: 506 });
await open('racer'); await advance(1.2, 30); await shot('25-small-racer');
await open('course'); await advance(1.2, 30); await shot('26-small-course');
await page.setViewportSize({ width: W, height: H });

// 11. Held-direction repeat check + timing trace.
await open('racer'); await advance(1.0, 30);
const t0 = await probe();
console.log('repeat start:', JSON.stringify(t0));

await writeFile(path.join(OUT, 'errors.json'), JSON.stringify(errors, null, 2));
console.log('console errors:', errors.length, errors.slice(0, 10));

await browser.close();
await server.close();
