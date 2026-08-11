// Do the per-course hazards ever actually touch anybody? Full race, count events.
import { createServer } from 'vite';
import { chromium } from 'playwright';
const ROOT = '/home/user/mario.cone';
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

for (const c of COURSES) {
  const r = await page.evaluate(async (id) => {
    const g = window.__GAME;
    await g.reset({ courseId: id, instant: true });
    g.setAutopilot(true);
    const ctx = window.__CTX;
    const n = { kartHit: 0, itemStrike: 0, playerKartHit: 0, boost: 0, launch: 0, trick: 0 };
    const offs = [
      ctx.bus.on('kart:hit', (e) => { n.kartHit++; if (e.racer?.isPlayer) n.playerKartHit++; }),
      ctx.bus.on('item:strike', () => n.itemStrike++),
      ctx.bus.on('kart:launch', () => n.launch++),
      ctx.bus.on('kart:trick', () => n.trick++),
    ];
    // a whole race
    for (let i = 0; i < 400; i++) {
      g.step(1);
      if (ctx.race.phase === 'finished' || ctx.race.phase === 'results') break;
    }
    const snap = g.snapshot();
    for (const o of offs) o();
    return { id, phase: ctx.race.phase, t: +ctx.race.time.toFixed(1), n,
      laps: snap.racers.map((r2) => r2.lap).sort((a, b) => b - a) };
  }, c);
  console.log(JSON.stringify(r));
}
await browser.close(); await server.close();
