// Does pressing Right actually go right?
//
// The harness cannot answer this. `setInput({steer})` writes the virtual input,
// which short-circuits the whole device path — so the one thing that shipped
// broken, the keyboard mapping, is precisely the thing the harness skips. This
// drives real key events instead.
//
// The test is geometric rather than a guess about signs: hold accelerate plus
// one steering key, then project the kart's displacement onto the chase
// camera's right vector. Positive means it moved to the right of the screen.
// That is the player's actual question, and it stays true no matter which
// coordinate convention the simulation settles on.
//
//   node tools/steercheck.mjs

import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium';

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars',
  ],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120_000 });

async function run(steerKey) {
  await page.evaluate(() => window.__GAME.reset());
  // Get past the countdown so throttle and steering are live.
  await page.evaluate(() => window.__GAME.step(5));

  const before = await page.evaluate(() => {
    const s = window.__GAME.snapshot();
    const p = s.racers.find((r) => r.isPlayer);
    return { pos: p.pos, cam: s.camera.pos };
  });

  await page.keyboard.down('ArrowUp');
  if (steerKey) await page.keyboard.down(steerKey);
  // step() runs the simulation without drawing; keys are read per fixed step.
  await page.evaluate(() => window.__GAME.step(2.5));
  await page.keyboard.up('ArrowUp');
  if (steerKey) await page.keyboard.up(steerKey);

  const after = await page.evaluate(() => {
    const p = window.__GAME.snapshot().racers.find((r) => r.isPlayer);
    return { pos: p.pos };
  });

  // Camera sits behind the kart, so kart-minus-camera is the view direction.
  const fwd = [
    before.pos[0] - before.cam[0],
    0,
    before.pos[2] - before.cam[2],
  ];
  const len = Math.hypot(fwd[0], fwd[2]) || 1;
  fwd[0] /= len; fwd[2] /= len;

  // Screen right for a camera looking along `fwd` with +Y up.
  const right = [-fwd[2], 0, fwd[0]];

  const d = [after.pos[0] - before.pos[0], 0, after.pos[2] - before.pos[2]];
  const lateral = d[0] * right[0] + d[2] * right[2];
  const forward = d[0] * fwd[0] + d[2] * fwd[2];

  return { lateral, forward };
}

const straight = await run(null);
const right = await run('ArrowRight');
const left = await run('ArrowLeft');

const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(1);
console.log('');
console.log('  input        forward    screen-lateral   verdict');
console.log('  ─────────────────────────────────────────────────');
for (const [name, r] of [['(none)', straight], ['Right', right], ['Left', left]]) {
  // Compare against the no-steer baseline: the track itself curves.
  const rel = r.lateral - straight.lateral;
  const dir = Math.abs(rel) < 1 ? 'straight' : rel > 0 ? 'went RIGHT' : 'went LEFT';
  console.log(`  ${name.padEnd(10)} ${fmt(r.forward).padStart(8)}m ${fmt(rel).padStart(14)}m   ${dir}`);
}

const ok =
  right.lateral - straight.lateral > 1 &&
  left.lateral - straight.lateral < -1;
console.log('');
console.log(ok ? '  STEERING CORRECT' : '  STEERING INVERTED OR UNRESPONSIVE');
if (errors.length) console.log('  page errors:', errors.slice(0, 3));

await browser.close();
await server.close();
process.exit(ok ? 0 : 1);
