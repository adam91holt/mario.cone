#!/usr/bin/env node
/** critic-rungshot.mjs — the same frozen racing frame at rung 0, rung 6 and
 *  mid(6). What the player is actually handed. Critic's bench; delete freely. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = opt('out', '/tmp/rungshot');
await mkdir(OUT, { recursive: true });
const server = await createServer({ root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, optimizeDeps: { include: ['three'] } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 240000 });
await page.evaluate(() => {
  window.__MENU?.set?.({ vehicleId: 'cone', courseId: 'cone-canyon' });
  window.__MENU?.close?.();
  window.__GAME.setAutopilot(true);
  window.__GAME.seek('racing');
  window.__GAME.step(14);
  window.__GAME.setTimeScale(0);
});
for (const [name, fn] of [
  ['rung0', () => { window.__QUALITY.set(0); }],
  ['rung6-set', () => { window.__QUALITY.set(6); }],
  ['rung0-again', () => { window.__QUALITY.set(0); }],
  ['rung6-mid', () => { window.__QUALITY.set(0); window.__QUALITY.mid(6); }],
]) {
  const s = await page.evaluate((src) => {
    // eslint-disable-next-line no-new-func
    (new Function(src))();
    window.__GAME.render();
    const st = window.__GAME.stats();
    const q = window.__QUALITY.probe();
    return { calls: st.drawCalls, tris: st.triangles, progs: st.programs, scale: q.scale, shelled: q.shelled, culled: q.culled };
  }, `(${fn.toString()})()`);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(name, JSON.stringify(s));
}
await browser.close();
await server.close();
