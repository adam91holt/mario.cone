#!/usr/bin/env node
/**
 * lapsheet.mjs — critic scratch tool. Photograph N stations round one lap of
 * every course, from the chase camera, so a whole circuit can be read as a
 * sequence rather than as one frame. Also prints lap timings and the surface
 * histogram the player actually drives on.
 *
 * node tools/lapsheet.mjs --out /tmp/lapsheet [--stations 8]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = opt('out', '/tmp/lapsheet');
const STATIONS = Number(opt('stations', 8));
const COURSES = opt('courses', 'cone-canyon,jackhammer-quarry,saltpan-bypass,switchback-summit').split(',');

const server = await createServer({ root: ROOT, server: { port: 0 }, logLevel: 'silent' });
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
const report = {};

for (const course of COURSES) {
  await call('reset', { courseId: course, vehicleId: 'cone', seed: 1, instant: true });
  await call('setAutopilot', true);
  const info = await page.evaluate(() => {
    const s = window.__GAME.snapshot();
    return { len: s.track.length, laps: s.race.totalLaps, name: s.track.name };
  });
  const marks = [];
  const surf = {};
  // drive a whole lap, sampling
  let shot = 0;
  let guard = 0;
  const start = await page.evaluate(() => window.__GAME.snapshot().racers.find(r=>r.isPlayer).progress);
  while (shot < STATIONS && guard < 400) {
    await call('step', 0.25);
    guard++;
    const p = await page.evaluate(() => {
      const s = window.__GAME.snapshot();
      const p = s.racers.find(r=>r.isPlayer);
      return { progress: p.progress, speed: p.speed, surface: p.surface, lap: p.lap, y: p.pos[1], t: s.race.time };
    });
    surf[p.surface] = (surf[p.surface] ?? 0) + 1;
    const want = start + (shot + 0.5) * ((info.len ?? 2500) / STATIONS);
    if (p.progress >= want) {
      await call('setCamera', 'chase');
      await call('advance', 0.25);
      const buf = await page.screenshot({ type: 'png' });
      await writeFile(path.join(OUT, `${course}-${String(shot).padStart(2, '0')}.png`), buf);
      marks.push({ shot, ...p });
      shot++;
    }
  }
  report[course] = { info, marks, surf };
  console.log(course, JSON.stringify(info), JSON.stringify(surf));
  for (const m of marks) console.log('   ', m.shot, 'prog', Math.round(m.progress), 'spd', m.speed?.toFixed?.(1), 'y', m.y?.toFixed?.(1), m.surface, 't', m.t?.toFixed?.(1));
}

await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
await browser.close();
await server.close();
