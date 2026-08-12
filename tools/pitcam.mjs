#!/usr/bin/env node
/**
 * pitcam.mjs — critic scratch. Drive a course with EVERY frame rendered (so the
 * chase-camera spring is never stepped past) and log, per station, the camera's
 * height above the player and its pitch. Photographs the worst offenders.
 *
 * node tools/pitcam.mjs --course jackhammer-quarry --out /tmp/pitcam
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = opt('out', '/tmp/pitcam');
const COURSES = opt('courses', 'cone-canyon,jackhammer-quarry,saltpan-bypass,switchback-summit').split(',');
const SECONDS = Number(opt('seconds', 60));

const server = await createServer({ root: ROOT, server: { port: 0, hmr: false, watch: { ignored: ['**/tools/**', '**/shots/**'] } }, logLevel: 'silent' });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GAME?.ready === true, { timeout: 120000 });
const call = (fn, ...args) => page.evaluate(([f, a]) => {
  const r = window.__GAME[f](...a);
  return r instanceof Promise ? r.then(() => null) : (r ?? null);
}, [fn, args]);

await mkdir(OUT, { recursive: true });

for (const course of COURSES) {
  await call('reset', { courseId: course, vehicleId: 'cone', seed: 1, instant: true });
  await call('setAutopilot', true);
  await call('setCamera', 'chase');
  await call('advance', 1.5, 30);
  const rows = [];
  for (let i = 0; i < SECONDS * 2; i++) {
    await call('advance', 0.5, 24);
    const m = await page.evaluate(() => {
      const s = window.__GAME.snapshot();
      const p = s.racers.find((r) => r.isPlayer);
      const c = s.camera.pos;
      const dx = c[0] - p.pos[0], dy = c[1] - p.pos[1], dz = c[2] - p.pos[2];
      const horiz = Math.hypot(dx, dz);
      return {
        t: s.race.time, prog: p.progress, y: p.pos[1],
        dh: +dy.toFixed(2), horiz: +horiz.toFixed(2),
        // degrees the camera sits above the racer, measured from horizontal
        elev: +(Math.atan2(dy, horiz) * 180 / Math.PI).toFixed(1),
      };
    });
    rows.push(m);
    if (m.t > SECONDS) break;
  }
  const worst = rows.slice().sort((a, b) => b.elev - a.elev).slice(0, 3);
  const es = rows.map((r) => r.elev);
  es.sort((a, b) => a - b);
  const q = (p) => es[Math.min(es.length - 1, Math.floor(p * es.length))];
  console.log(`\n== ${course}  n=${rows.length}  cam elevation deg above racer: p05 ${q(0.05)}  med ${q(0.5)}  p95 ${q(0.95)}  max ${es[es.length - 1]}`);
  console.log('   worst:', worst.map((w) => `t${w.t.toFixed(0)} prog${Math.round(w.prog)} y${w.y.toFixed(0)} elev${w.elev}deg dh${w.dh}`).join(' | '));
  console.log('   over 35deg:', rows.filter((r) => r.elev > 35).length, '/', rows.length,
              '   over 50deg:', rows.filter((r) => r.elev > 50).length);
  await writeFile(path.join(OUT, `${course}.json`), JSON.stringify(rows, null, 1));
}
await browser.close();
await server.close();
