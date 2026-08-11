// Independent critic: drive a full lap of each course and record the real line.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = '/home/user/mario.cone';
const OUT = '/tmp/review-courses-r1/tele';
const COURSES = ['cone-canyon', 'jackhammer-quarry', 'saltpan-bypass', 'switchback-summit'];

const server = await createServer({ root: ROOT, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, optimizeDeps: { include: ['three'] } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120000 });
await mkdir(OUT, { recursive: true });

const report = {};
for (const course of COURSES) {
  console.log('--', course);
  const line = await page.evaluate(async (c) => {
    const g = window.__GAME;
    await g.reset({ courseId: c, instant: true });
    g.setAutopilot(true);
    const ctx = window.__CTX;
    const events = { launch: 0, trick: 0, boost: 0, hit: 0, wall: 0, offroad: 0, driftStart: 0, mt: [0, 0, 0, 0] };
    const offs = [
      ctx.bus.on('kart:launch', (e) => { if (e.racer?.isPlayer) events.launch++; }),
      ctx.bus.on('kart:trick', (e) => { if (e.racer?.isPlayer) events.trick++; }),
      ctx.bus.on('kart:boost', (e) => { if (e.racer?.isPlayer) events.boost++; }),
      ctx.bus.on('kart:hit', (e) => { if (e.racer?.isPlayer) events.hit++; }),
      ctx.bus.on('kart:wall', (e) => { if (e.racer?.isPlayer) events.wall++; }),
      ctx.bus.on('kart:offroad', (e) => { if (e.racer?.isPlayer) events.offroad++; }),
      ctx.bus.on('kart:drift:start', (e) => { if (e.racer?.isPlayer) events.driftStart++; }),
      ctx.bus.on('kart:drift:charge', (e) => { if (e.racer?.isPlayer) events.mt[e.tier]++; }),
    ];
    g.step(2);
    const pts = [];
    let s = g.snapshot();
    const startLap = s.racers.find((r) => r.isPlayer).lap;
    for (let i = 0; i < 2000; i++) {
      g.step(0.1);
      s = g.snapshot();
      const p = s.racers.find((r) => r.isPlayer);
      pts.push([+p.pos[0].toFixed(1), +p.pos[1].toFixed(2), +p.pos[2].toFixed(1),
        +p.speed.toFixed(1), p.surface, p.grounded ? 1 : 0, p.drift.active ? p.drift.tier : -1]);
      if (p.lap > startLap) break;
    }
    for (const o of offs) o();
    return { pts, events, laps: ctx.race.totalLaps, len: ctx.track.length,
      name: ctx.track.name, id: ctx.track.id, width: ctx.track.course.width,
      theme: JSON.parse(JSON.stringify(ctx.track.theme)) };
  }, course);
  await writeFile(path.join(OUT, `${course}.json`), JSON.stringify(line));
  const xs = line.pts.map((p) => p[0]), ys = line.pts.map((p) => p[1]), zs = line.pts.map((p) => p[2]);
  const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...zs) - Math.min(...zs);
  const surf = line.pts.reduce((a, p) => (a[p[4]] = (a[p[4]] || 0) + 1, a), {});
  report[course] = {
    id: line.id, name: line.name, lapLen: +line.len.toFixed(0), laps: line.laps,
    lapTimeS: +(line.pts.length * 0.1).toFixed(1),
    footprint: `${w.toFixed(0)}x${d.toFixed(0)}`, aspect: +(Math.max(w, d) / Math.min(w, d)).toFixed(2),
    elev: +(Math.max(...ys) - Math.min(...ys)).toFixed(1),
    speed: `${Math.min(...line.pts.map((p) => p[3])).toFixed(0)}-${Math.max(...line.pts.map((p) => p[3])).toFixed(0)}`,
    airPct: +(line.pts.filter((p) => p[5] === 0).length / line.pts.length * 100).toFixed(1),
    driftPct: +(line.pts.filter((p) => p[6] >= 0).length / line.pts.length * 100).toFixed(1),
    surf, events: line.events,
  };
  console.log('  ', JSON.stringify(report[course]));
}
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
await browser.close(); await server.close();
console.log('DONE');
