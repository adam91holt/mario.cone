#!/usr/bin/env node
// Independent critic capture for the front-end. Written by the reviewer.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = process.argv[2] || '/tmp/critic-menus';
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
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180000 });

const ev = (fn, ...a) => page.evaluate(([f, args]) =>
  new Function('args', 'return (' + f + ').apply(null, args)')(args), [fn.toString(), a]);

const shot = async (name) => { await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('  shot', name); };
const probe = () => ev(() => JSON.parse(JSON.stringify(globalThis.__MENU?.probe?.() ?? null)));
const uip = () => ev(() => JSON.parse(JSON.stringify(globalThis.__MENU?.uiProbe?.() ?? null)));
const menu = (v) => ev((verb) => globalThis.__MENU.press(verb), v);
const open = (a) => ev((at) => globalThis.__MENU.open(at), a);
const adv = (s, fps = 60) => ev((sec, f) => window.__GAME.advance(sec, f), s, fps);
const frame = () => adv(1 / 60, 1);

// Track audio/bus traffic the front-end produces.
await ev(() => {
  const ctx = window.__CTX;
  window.__EV = [];
  const orig = ctx.bus.emit.bind(ctx.bus);
  ctx.bus.emit = (n, p) => { window.__EV.push(n); return orig(n, p); };
  const a = ctx.audio;
  if (a) {
    window.__SFX = [];
    for (const k of ['play', 'sfx', 'cue', 'oneShot', 'setMusic']) {
      if (typeof a[k] === 'function') {
        const f = a[k].bind(a);
        a[k] = (...args) => { window.__SFX.push(k + ':' + String(args[0])); return f(...args); };
      }
    }
  }
});
const evs = () => ev(() => { const e = window.__EV.slice(); window.__EV.length = 0; return e; });
const sfx = () => ev(() => { const e = (window.__SFX || []).slice(); if (window.__SFX) window.__SFX.length = 0; return e; });

const log = {};
console.log('boot:', JSON.stringify(await probe()));

// ── 1. title, and whether it is alive ────────────────────────────────────
await adv(0.05, 30); await shot('a1-title-boot');
await adv(1.2, 30); await shot('a2-title-1s');
await frame(); await shot('a3-title-1s-plus1f');
await adv(2.0, 30); await shot('a4-title-3s');
await adv(3.0, 30); await shot('a5-title-6s');
log.titleSfx = await sfx();

// ── 2. title -> racer, frame by frame ────────────────────────────────────
await menu('menu.ok');
for (let i = 1; i <= 12; i++) { await frame(); if (i % 2 === 0) await shot(`b-push-${String(i).padStart(2, '0')}f`); }
log.pushProbe = await probe();
await adv(0.8, 30); await shot('b9-racer-settled');
log.racerUi = await uip();

// ── 3. cursor move: per-frame scale + ring position ──────────────────────
const track = [];
track.push({ f: 0, ...(await uip()) });
await menu('menu.right');
for (let i = 1; i <= 20; i++) { await frame(); const u = await uip(); track.push({ f: i, sel: u.sel, ringX: u.ring.x, ringO: u.ring.opacity, cells: u.cells.map((c) => c.scale) }); }
log.cursor = track.map((t) => ({ f: t.f, sel: t.sel, ringX: t.ringX, ringO: t.ringO }));
log.cursorSfx = await sfx();
await shot('c1-after-right');
await adv(0.6, 30); await shot('c2-right-settled');

// hold the cursor across the roster
for (let i = 0; i < 3; i++) { await menu('menu.right'); await adv(0.18, 30); }
await adv(0.5, 30); await shot('c3-four-right');
log.afterFour = await probe();

// down a row
await menu('menu.down'); await adv(0.5, 30); await shot('c4-row-down');
log.rowDown = await probe();

// ── 4. course screen ─────────────────────────────────────────────────────
await menu('menu.ok');
for (let i = 1; i <= 10; i++) { await frame(); if (i === 4 || i === 8) await shot(`d-course-push-${i}f`); }
await adv(0.9, 30); await shot('d3-course-settled');
log.courseUi = await uip();
await menu('menu.down'); await adv(0.5, 30); await shot('d4-course-row2');
log.courseRow2 = await uip();
await menu('menu.right'); await adv(0.5, 30); await shot('d5-course-right');
log.courseSel = await probe();

// ── 5. class screen ──────────────────────────────────────────────────────
await menu('menu.ok'); await adv(0.9, 30); await shot('e1-class-settled');
log.classUi = await uip();
await menu('menu.right'); await adv(0.5, 30); await shot('e2-class-right');
log.classSel = await probe();

// ── 6. back out one screen ───────────────────────────────────────────────
await menu('menu.back');
for (let i = 1; i <= 8; i++) { await frame(); if (i === 3 || i === 6) await shot(`f-back-${i}f`); }
await adv(0.7, 30); await shot('f3-back-settled');
log.back = await probe();
await menu('menu.ok'); await adv(0.9, 30); // forward again to class

// ── 7. the launch hand-off, frame by frame ───────────────────────────────
await ev(() => { window.__EV.length = 0; });
await menu('menu.ok');
const launch = [];
for (let i = 1; i <= 90; i++) {
  await frame();
  const p = await probe();
  launch.push({ f: i, wipe: p.wipe, card: p.card, active: p.launch.active, built: p.launch.built, t: p.launch.t, outro: p.launch.outro, open: p.open });
  if ([2, 6, 10, 14, 20, 26, 34, 42, 50, 60, 70, 80, 90].includes(i)) await shot(`g-launch-${String(i).padStart(2, '0')}f`);
}
log.launch = launch;
log.launchEvents = await evs();
log.launchSfx = await sfx();
await adv(1.0, 30); await shot('g9-after-launch');
log.afterLaunch = await probe();
log.race = await ev(() => window.__GAME.snapshot().race);

// ── 8. pause during the race ─────────────────────────────────────────────
await adv(2.0, 30);
await ev(() => window.__CTX.input.press('pause'));
await adv(0.5, 30); await shot('h1-pause');
log.pause = await probe();

// ── 9. re-open the front-end over a race ─────────────────────────────────
await open('racer'); await adv(1.0, 30); await shot('i1-reopened');
log.reopen = await probe();

log.errors = errors;
await writeFile(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2));
console.log('errors:', errors.slice(0, 10));
await browser.close();
await server.close();
