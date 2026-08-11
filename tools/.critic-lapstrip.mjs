// Five frames evenly spaced around one lap of each course.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = '/home/user/mario.cone';
const OUT = '/tmp/review-courses-r1/lap';
const COURSES = ['cone-canyon', 'jackhammer-quarry', 'saltpan-bypass', 'switchback-summit'];
const N = 5;

const server = await createServer({ root: ROOT, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, optimizeDeps: { include: ['three'] } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 560 } });
page.setDefaultTimeout(180000);
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120000 });
await mkdir(OUT, { recursive: true });

for (const course of COURSES) {
  const len = await page.evaluate(async (c) => {
    const g = window.__GAME;
    await g.reset({ courseId: c, instant: true });
    g.setAutopilot(true);
    g.setCamera('chase');
    g.step(1);
    return window.__CTX.track.length;
  }, course);
  for (let i = 0; i < N; i++) {
    const target = (len * (i + 0.5)) / N;
    const at = await page.evaluate((t) => {
      const g = window.__GAME;
      for (let k = 0; k < 4000; k++) {
        const p = g.snapshot().racers.find((r) => r.isPlayer);
        if (p.progress >= t) break;
        g.step(0.05);
      }
      g.advance(0.4);
      const p = g.snapshot().racers.find((r) => r.isPlayer);
      return { progress: Math.round(p.progress), speed: Math.round(p.speed), surface: p.surface, air: !p.grounded };
    }, target);
    await page.screenshot({ path: path.join(OUT, `${course}-${i}.png`), timeout: 180000 });
    console.log(course, i, JSON.stringify(at));
  }
}
await browser.close(); await server.close();
console.log('DONE');
