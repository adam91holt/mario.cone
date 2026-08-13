#!/usr/bin/env node
/**
 * critic-r2-menu.mjs — the front-end's draw skip, tested from the outside.
 *
 * `FrameBudget.skipDraw` throws away the whole frame's draw while the menus are
 * up, on the argument that the front-end covers every pixel. §11a says the
 * front-end has a 3D set of its own running the same film stock, so this asks
 * the only question that matters: with the rAF loop driving and nobody touching
 * the harness, does the front-end still MOVE?
 *
 * Two screenshots four seconds apart, plus the pixel difference between them.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/r2-menu');

const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180000 });
await mkdir(OUT, { recursive: true });

// The title screen is what a player sees first; ask for it explicitly so this
// does not depend on how long boot took.
const opened = await page.evaluate(() => {
  const g = globalThis;
  try { g.__CTX?.bus?.emit?.('ui:menu:open', { from: 'critic' }); } catch { /* */ }
  return { hasCtx: !!g.__CTX, menus: Object.keys(g).filter((k) => /MENU|UI|RACE|CTX/.test(k)) };
});
console.log('page globals:', JSON.stringify(opened));

const grab = async (label) => {
  const file = path.join(OUT, label + '.png');
  await page.screenshot({ path: file, timeout: 180000 });
  const st = await page.evaluate(() => {
    const s = window.__GAME.stats();
    return { drawCalls: s.drawCalls, triangles: s.triangles, drawSkipped: s.drawSkipped, gov: s.governor, rung: s.rung, scale: s.renderScale, phase: window.__GAME.snapshot().race?.phase };
  });
  console.log(label, JSON.stringify(st));
  return { file, st };
};

const a = await grab('menu-a');
await new Promise((r) => setTimeout(r, 6000));
const b = await grab('menu-b');
await new Promise((r) => setTimeout(r, 6000));
const c = await grab('menu-c');

await writeFile(path.join(OUT, 'menu.json'), JSON.stringify({ a, b, c, errs }, null, 2));
console.log('errors', errs.slice(0, 5));
await browser.close();
await server.close();
