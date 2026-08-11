import { createServer } from 'vite';
import { chromium } from 'playwright';
const ROOT = '/home/user/mario.cone';
const server = await createServer({ root: ROOT, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, optimizeDeps: { include: ['three'] } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.on('console', (m) => console.log('CONSOLE', m.type(), m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120000 });
for (const c of ['cone-canyon', 'jackhammer-quarry', 'saltpan-bypass', 'switchback-summit', 'jackhammer-quarry']) {
  const got = await page.evaluate(async (id) => {
    await window.__GAME.reset({ courseId: id, instant: true });
    const ctx = window.__CTX;
    return { asked: id, got: ctx.track.id, name: ctx.track.name, len: +ctx.track.length.toFixed(0),
      laps: ctx.race.totalLaps, snapTrack: window.__GAME.snapshot().track };
  }, c);
  console.log(JSON.stringify(got));
}
await browser.close(); await server.close();
