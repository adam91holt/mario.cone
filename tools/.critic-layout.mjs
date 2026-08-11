// Independent critic capture: true whole-course top-down + driven-line telemetry.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = '/home/user/mario.cone';
const OUT = '/tmp/review-courses-r1/layout';
const CHROME = '/opt/pw-browsers/chromium';
const COURSES = ['cone-canyon', 'jackhammer-quarry', 'saltpan-bypass', 'switchback-summit'];

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
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120000 });
await mkdir(OUT, { recursive: true });

const report = {};

for (const course of COURSES) {
  console.log('--', course);
  await page.evaluate(async (c) => { await window.__GAME.reset({ courseId: c, instant: true }); }, course);
  await page.evaluate(() => { window.__GAME.setAutopilot(true); window.__GAME.step(2); });

  // a full lap of the real driven line
  const line = await page.evaluate(() => {
    const g = window.__GAME;
    const ctx = window.__CTX;
    const pts = [];
    let s = g.snapshot();
    const p0 = s.racers.find((r) => r.isPlayer);
    const startLap = p0.lap;
    for (let i = 0; i < 1600; i++) {
      g.step(0.1);
      s = g.snapshot();
      const p = s.racers.find((r) => r.isPlayer);
      pts.push([+p.pos[0].toFixed(1), +p.pos[1].toFixed(2), +p.pos[2].toFixed(1),
        +p.speed.toFixed(1), p.surface, p.grounded ? 1 : 0, +p.progress.toFixed(0)]);
      if (p.lap > startLap) break;
    }
    return { pts, laps: ctx.race.totalLaps, len: ctx.track.length, name: ctx.track.name,
      id: ctx.track.id, width: ctx.track.course.width };
  });
  await writeFile(path.join(OUT, `${course}.line.json`), JSON.stringify(line));
  const xs = line.pts.map((p) => p[0]), ys = line.pts.map((p) => p[1]), zs = line.pts.map((p) => p[2]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  report[course] = {
    span: +span.toFixed(0),
    aspect: +((Math.max(...xs) - Math.min(...xs)) / (Math.max(...zs) - Math.min(...zs))).toFixed(2),
    elev: +(Math.max(...ys) - Math.min(...ys)).toFixed(1),
    lapLen: +line.len.toFixed(0), laps: line.laps,
    speedMin: Math.min(...line.pts.map((p) => p[3])).toFixed(1),
    speedMax: Math.max(...line.pts.map((p) => p[3])).toFixed(1),
    air: +(line.pts.filter((p) => p[5] === 0).length / line.pts.length * 100).toFixed(1),
    surfaces: line.pts.reduce((a, p) => (a[p[4]] = (a[p[4]] || 0) + 1, a), {}),
  };
  console.log('  ', JSON.stringify(report[course]));

  // ── true top-down of the whole circuit, drawn straight through the renderer ──
  await page.evaluate(({ cx, cy, cz, h }) => {
    const ctx = window.__CTX;
    const cam = ctx.camera;
    const oldFar = cam.far, oldFov = cam.fov;
    cam.position.set(cx, cy + h, cz + 0.001);
    cam.up.set(0, 0, -1);
    cam.lookAt(cx, cy, cz);
    cam.fov = 55; cam.far = Math.max(oldFar, h * 3);
    cam.updateProjectionMatrix();
    ctx.renderer.setRenderTarget(null);
    ctx.renderer.render(ctx.scene, cam);
    window.__RESTORE = () => { cam.up.set(0, 1, 0); cam.fov = oldFov; cam.far = oldFar; cam.updateProjectionMatrix(); };
  }, { cx, cy, cz, h: span * 1.0 });
  await page.screenshot({ path: path.join(OUT, `${course}.top.png`) });
  await page.evaluate(() => window.__RESTORE?.());
}

await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
await server.close();
console.log('done');
