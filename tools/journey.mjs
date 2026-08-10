#!/usr/bin/env node
/**
 * journey.mjs — play the game front to back and audit every screen on the way.
 *
 * `capture.mjs` photographs the race; `menushot.mjs` photographs the front-end.
 * Neither walks the *join*, which is where every seam a coherence pass has ever
 * found actually lives. This drives one continuous session — boot, title,
 * machine, cup, circuit, class, launch, grid, race, finish, results, next race
 * — and at each stop it both photographs the frame and reads the live DOM for
 * the two things that keep drifting apart: which alphabet a layer is set in,
 * and whether anything is listening to what it emits.
 *
 *   node tools/journey.mjs [outDir]
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = process.argv[2] || '/tmp/journey';
const W = 1600, H = 900;

const server = await createServer({
  root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await mkdir(OUT, { recursive: true });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180_000 });

const ev = (fn, ...a) => page.evaluate(([f, args]) =>
  new Function('args', 'return (' + f + ').apply(null, args)')(args), [fn.toString(), a]);

const advance = (s, fps = 30) => ev((sec, f) => window.__GAME.advance(sec, f), s, fps);
const menu = (verb) => ev((v) => globalThis.__MENU.press(v), verb);

// ── the audit, run at every stop ───────────────────────────────────────────
const AUDIT = () => {
  const layers = ['#menu', '#race', '#hud', '#items', '#item-fx', '#coach', '#fx-screen'];
  const out = { type: {}, sfxLog: (globalThis.__SFXLOG || []).slice() };
  for (const sel of layers) {
    const root = document.querySelector(sel);
    if (!root) continue;
    const cs0 = getComputedStyle(root);
    if (cs0.display === 'none' || cs0.visibility === 'hidden' || +cs0.opacity === 0) continue;
    let set = 0; const fonts = {}; const words = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = n.nodeValue && n.nodeValue.trim();
      if (!t) continue;
      const el = n.parentElement;
      if (!el || el.closest('svg')) continue;
      let hidden = false;
      for (let p = el; p && p !== root.parentElement; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) { hidden = true; break; }
      }
      if (hidden) continue;
      set++;
      const f = cs0 && getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim();
      fonts[f] = (fonts[f] || 0) + 1;
      words.push(t.slice(0, 48));
    }
    // Our own drawn faces: glyphs.ts emits <svg class="gl">, letters.ts "sg".
    const drawn = root.querySelectorAll('svg.gl, svg.sg').length;
    out.type[sel] = { set, drawn, fonts, words };
  }
  return JSON.parse(JSON.stringify(out));
};

const stops = [];
async function stop(name, note) {
  // Software GL plus a full-frame composite makes a screenshot expensive; the
  // default 30s deadline is not generous here, it is optimistic.
  await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 120_000, animations: 'allow' });
  const audit = await ev(AUDIT);
  stops.push({ name, note, ...audit });
  const summary = Object.entries(audit.type)
    .map(([k, v]) => `${k} ${v.set}set/${v.drawn}drawn`).join('  ');
  console.log(`  ${name.padEnd(26)} ${summary}`);
}

// Record every sound the game asks for, so "this screen is silent" is a fact.
await ev(() => {
  globalThis.__SFXLOG = [];
  const a = window.__CTX?.audio;
  if (a && !a.__tapped) {
    a.__tapped = true;
    const p = a.play.bind(a), m = a.setMusic.bind(a);
    a.play = (id, o) => { globalThis.__SFXLOG.push('sfx:' + id); return p(id, o); };
    a.setMusic = (id, o) => { globalThis.__SFXLOG.push('mus:' + id); return m(id, o); };
  }
});

console.log('── front end ──');
await advance(1.6); await stop('00-title', 'the first screen a player meets');
await menu('menu.ok'); await advance(1.4); await stop('01-machine', 'machine select, settled');
await menu('menu.right'); await advance(0.8); await stop('02-machine-moved', 'cursor moved one right');
await menu('menu.ok'); await advance(1.4); await stop('03-cup', 'cup / circuit select');
await menu('menu.down'); await advance(0.7); await stop('04-circuit-row', 'into the circuit row');
await menu('menu.right'); await advance(0.7); await stop('05-circuit-2', 'second circuit chosen');
await menu('menu.ok'); await advance(1.4); await stop('06-class', 'engine class');
await menu('menu.ok');
console.log('── the hand-off ──');
await advance(0.30); await stop('07-launch-early', 'launch card, curtain closing');
await advance(0.55); await stop('08-launch-mid', 'launch card, full cover');
await advance(0.90); await stop('09-launch-late', 'launch card, about to open');
await advance(0.60); await stop('10-handoff', 'the join itself');
await advance(0.80); await stop('11-course-card', 'the race layers course card');
console.log('── the race ──');
await advance(1.6); await stop('12-countdown', 'countdown');
await ev(() => { window.__GAME.setAutopilot(true); window.__GAME.setInput({ accel: 1 }); });
await advance(2.0); await stop('13-racing-early', 'first corner');
await ev(() => window.__GAME.step(20));
await advance(0.8); await stop('14-racing', 'mid race');
await ev(() => window.__GAME.press('pause')); await advance(0.7);
await stop('15-paused', 'pause menu');
await ev(() => window.__GAME.press('pause')); await advance(0.5);
console.log('── the flag ──');
await ev(() => window.__GAME.seek('finished'));
await advance(1.2); await stop('16-finished', 'crossing the line');
await advance(2.4); await stop('17-finish-settle', 'the finish beat');
await ev(() => window.__GAME.seek('results'));
await advance(1.2); await stop('18-results-early', 'results sheet arriving');
await advance(2.6); await stop('19-results', 'results settled');
await advance(2.0); await stop('20-results-late', 'results, fully settled');

const snap = await ev(() => JSON.parse(JSON.stringify(window.__GAME.snapshot())));
const bus = await ev(() => JSON.parse(JSON.stringify(window.__CTX.bus.inspect())));
const sfx = await ev(() => globalThis.__SFXLOG.slice());

await browser.close();
await server.close();

// ── report ─────────────────────────────────────────────────────────────────
console.log('\n── events with no listener ───────────────────────────────');
const dead = Object.entries(bus).filter(([, n]) => n === 0).map(([e]) => e);
console.log(dead.length ? '  ' + dead.join('\n  ') : '  (none)');

console.log('\n── fonts, by stop ────────────────────────────────────────');
for (const s of stops) {
  for (const [layer, v] of Object.entries(s.type)) {
    const treb = Object.entries(v.fonts).filter(([f]) => !/^(sg|gl)$/.test(f));
    if (v.set === 0) continue;
    console.log(`  ${s.name} ${layer}: ${v.set} set (${treb.map(([f, n]) => f + '×' + n).join(', ')}) / ${v.drawn} drawn`);
  }
}

console.log('\n── every word still set in a font, by stop ───────────────');
for (const s of stops) {
  for (const [layer, v] of Object.entries(s.type)) {
    if (!v.words.length) continue;
    console.log(`  ${s.name} ${layer}:`);
    for (const w of v.words) console.log('      ' + w);
  }
}

console.log('\n── sound, cumulative ─────────────────────────────────────');
console.log('  ' + (sfx.length ? sfx.join(' ') : '(silence)'));
for (let i = 1; i < stops.length; i++) {
  const before = stops[i - 1].sfxLog.length;
  const fresh = stops[i].sfxLog.slice(before);
  console.log(`  ${stops[i].name.padEnd(26)} ${fresh.length ? fresh.join(' ') : '— silent —'}`);
}

console.log('\n── console ───────────────────────────────────────────────');
console.log(errors.length ? errors.map((e) => '  ' + e).join('\n') : '  clean');

await writeFile(path.join(OUT, 'journey.json'),
  JSON.stringify({ stops, bus, sfx, snap, errors }, null, 2));
console.log(`\nwrote ${stops.length} stops to ${OUT}`);
