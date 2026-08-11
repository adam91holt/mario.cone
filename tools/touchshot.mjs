// Photograph the phone build, in both orientations.
//
// The touch layer only mounts on a device with a coarse pointer, which no
// reviewer here has — so `?touch=1` forces it on and this drives the game at a
// real iPhone viewport with touch emulation enabled. A control layer that can
// only be seen on hardware nobody in the loop owns is a layer nobody will judge.
//
//   node tools/touchshot.mjs [--out shots/phone]

import { chromium, devices } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const OUT = path.resolve(ROOT, argv[argv.indexOf('--out') + 1] ?? 'shots/phone');
const CHROME = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium';

await mkdir(OUT, { recursive: true });

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  // HMR off: other agents are editing src/ while this runs, and a hot reload
  // mid-capture destroys the page context under page.evaluate.
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html?touch=1`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars',
  ],
});

// iPhone 13's real logical viewport, with hasTouch so the layer mounts and
// pointer events behave the way they do on glass.
const iphone = devices['iPhone 13'];
const shots = [
  { name: 'landscape', width: 844, height: 390 },
  { name: 'portrait', width: 390, height: 844 },
];

const results = [];
for (const s of shots) {
  const context = await browser.newContext({
    ...iphone,
    viewport: { width: s.width, height: s.height },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180_000 });

  // Get into a race so the auto-throttle is live and the HUD is up.
  await page.evaluate(() => window.__GAME.reset());
  await page.evaluate(() => window.__GAME.setAutopilot(true));
  await page.evaluate(() => window.__GAME.step(6));
  await page.evaluate(() => window.__GAME.advance(0.4));

  const probe = await page.evaluate(() => {
    const t = document.getElementById('touch');
    const g = document.getElementById('rotate');
    const vis = (el) => {
      if (!el) return 'missing';
      const cs = getComputedStyle(el);
      return cs.display === 'none' ? 'hidden' : 'shown';
    };
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height),
               right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom) };
    };
    return {
      touchLayer: vis(t), rotateGate: vis(g),
      drift: rect('#touch .btn.drift'),
      item: rect('#touch .btn.item'),
      // Do the two rectangles actually intersect? The whole point of the
      // inset override, checked rather than eyeballed.
      overlap: (() => {
        const a = document.querySelector('#touch .btn.drift');
        const b = document.querySelector('#hud .br');
        if (!a || !b) return null;
        const r = a.getBoundingClientRect(), q2 = b.getBoundingClientRect();
        if (!q2.width || !q2.height) return 'hud-br-empty';
        const hit = r.left < q2.right && r.right > q2.left && r.top < q2.bottom && r.bottom > q2.top;
        return hit ? 'OVERLAPS' : 'clear';
      })(),
    };
  });

  await page.screenshot({ path: path.join(OUT, `${s.name}.png`) });
  results.push({ ...s, ...probe, errors: errors.slice(0, 3) });
  await context.close();
}

console.log('');
for (const r of results) {
  console.log(`  ${r.name.padEnd(10)} ${r.width}x${r.height}`);
  console.log(`     touch layer: ${r.touchLayer.padEnd(8)} rotate gate: ${r.rotateGate}`);
  if (r.drift) console.log(`     drift btn ${r.drift.w}x${r.drift.h} at ${r.drift.right}px from right, ${r.drift.bottom}px from bottom`);
  console.log('     drift vs HUD bottom-right: ' + r.overlap);
  if (r.errors.length) console.log(`     PAGE ERRORS: ${r.errors.join(' | ')}`);
}

const land = results.find((r) => r.name === 'landscape');
const port = results.find((r) => r.name === 'portrait');
const ok =
  land?.touchLayer === 'shown' && land?.rotateGate === 'hidden' && land?.overlap === 'clear' &&
  port?.rotateGate === 'shown' && port?.touchLayer === 'hidden' &&
  !results.some((r) => r.errors.length);
console.log('');
console.log(ok ? '  PHONE LAYER CORRECT' : '  FAILED — see above');

await browser.close();
await server.close();
process.exit(ok ? 0 : 1);
