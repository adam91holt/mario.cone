// Does the field move before the flag?
//
// Reported twice now. The first report turned out to be the race running behind
// the title screen, which is fixed. This asks the narrower question the report
// actually names: from the player's seat, between the countdown appearing and
// "GO", does the kart move?
//
// Two runs, because there are two ways it could be true and they have different
// causes:
//
//   idle     no input at all. If the kart moves here it is the grid formation
//            in `intro` running under the lights, not the player.
//   throttle accelerator held from the first frame — the rocket start. In MK8
//            you are pinned until GO no matter how hard you hold it, and when
//            you pressed only decides the boost.
//
//   node tools/countdown.mjs

import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium';
const STEP = 0.1;
const SPAN = 11;

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 240_000 });

/** One run. `hold` decides whether the accelerator is down the whole time. */
async function run(name, hold) {
  await page.evaluate(() => window.__GAME.reset());
  await page.evaluate((h) => {
    window.__GAME.setInput(h ? { accel: 1 } : { accel: 0, brake: 0, steer: 0 });
  }, hold);

  const read = () => page.evaluate(() => {
    const s = window.__GAME.snapshot();
    const p = s.racers.find((x) => x.isPlayer);
    const ctx = window.__CTX;
    const c = ctx?.race;
    const me = ctx?.racers?.find((r) => r.isPlayer);
    return {
      phase: c?.phase ?? '?',
      count: c?.countdown ?? -1,
      speed: p ? Math.abs(p.speed) : -1,
      // `pos` is a [x,y,z] tuple on SnapshotRacer, not a Vector3.
      x: p ? p.pos[0] : 0, y: p ? p.pos[1] : 0, z: p ? p.pos[2] : 0,
      progress: p ? p.progress : 0,
      // The mechanism, not just the symptom. A boost handed out before the
      // flag is the specific defect this test exists to catch: the grid
      // formation crossed the strip by the start line and the pad fired.
      boost: String(me?.boost?.source ?? '-'),
      surface: String(me?.surface ?? '?'),
      // The whole field, not just the player. Seven AI drivers leaving early
      // is the same bug wearing a different hat.
      fieldSpeed: ctx ? Math.max(...ctx.racers.map((r) => Math.abs(r.speed))) : -1,
    };
  });

  const rows = [];
  const first = await read();
  let px = first.x, pz = first.z, moved = 0;
  rows.push({ t: 0, ...first, moved: 0 });

  for (let t = STEP; t <= SPAN + 1e-9; t += STEP) {
    await page.evaluate((s) => window.__GAME.step(s), STEP);
    const r = await read();
    moved += Math.hypot(r.x - px, r.z - pz);
    px = r.x; pz = r.z;
    rows.push({ t: +t.toFixed(1), ...r, moved });
    if (r.phase === 'racing' && rows.filter((q) => q.phase === 'racing').length > 12) break;
  }

  // Everything the player saw before the flag.
  const beforeFlag = rows.filter((r) => r.phase !== 'racing' && r.phase !== 'finished');
  const underLights = beforeFlag.filter((r) => r.phase === 'countdown');
  const inIntro = beforeFlag.filter((r) => r.phase === 'intro');

  const span = (a) => (a.length ? a[a.length - 1].moved - a[0].moved : 0);
  const peak = (a) => (a.length ? Math.max(...a.map((r) => r.speed)) : 0);

  console.log(`\n  ── ${name} ${'─'.repeat(56 - name.length)}`);
  console.log('    t     phase       count  speed  field   moved(m)  surface  boost');
  let last = null;
  for (const r of rows) {
    // One line per 0.2s, plus every phase change, so the transitions are visible
    // without printing 110 rows.
    const edge = last && r.phase !== last;
    if (!edge && Math.round(r.t * 10) % 2 !== 0) { last = r.phase; continue; }
    console.log(`   ${String(r.t).padStart(4)}  ${r.phase.padEnd(10)} ${String(r.count).padStart(4)}   `
      + `${r.speed.toFixed(1).padStart(5)}  ${r.fieldSpeed.toFixed(1).padStart(5)}   ${r.moved.toFixed(2).padStart(7)}`
      + `  ${r.surface.padEnd(7)}  ${r.boost}${edge ? '   <-- phase change' : ''}`);
    last = r.phase;
  }
  console.log(`    intro:     ${inIntro.length} steps, moved ${span(inIntro).toFixed(2)}m, peak speed ${peak(inIntro).toFixed(1)}`);
  console.log(`    countdown: ${underLights.length} steps, moved ${span(underLights).toFixed(2)}m, peak speed ${peak(underLights).toFixed(1)}`);

  // Every boost source seen before the flag. Must be empty.
  const earlyBoost = [...new Set(beforeFlag.filter((r) => r.boost !== '-' && r.boost !== 'null').map((r) => r.boost))];
  const fieldPeak = Math.max(0, ...beforeFlag.map((r) => r.fieldSpeed));
  if (earlyBoost.length) console.log(`    BOOST BEFORE THE FLAG: ${earlyBoost.join(', ')}`);
  const flagRow = rows.find((r) => r.phase === 'racing');
  return {
    intro: span(inIntro), countdown: span(underLights), introPeak: peak(inIntro),
    earlyBoost, fieldPeak,
    // Where the field stands when the flag actually drops.
    atFlag: flagRow?.moved ?? 0,
    // What the machine is parked on, and what the flag hands it.
    gridSurface: underLights.length ? underLights[underLights.length - 1].surface : '?',
    flagBoost: flagRow?.boost ?? '-',
  };
}

const idle = await run('idle — no input at all', false);
const held = await run('throttle held from the first frame', true);

console.log('\n  ── verdict ─────────────────────────────────────────────────────');
const fails = [];

// 1. The flag is the contract. Under the lights the field is pinned, in both
//    runs — holding the accelerator must not buy a single metre.
if (idle.countdown > 0.05) fails.push(`idle: kart moved ${idle.countdown.toFixed(2)}m under the countdown`);
if (held.countdown > 0.05) fails.push(`throttle held: kart moved ${held.countdown.toFixed(2)}m under the countdown`);

// 2. The mechanism, so a regression is named rather than merely detected. No
//    boost of any source may be granted before the flag; the shipped bug was a
//    strip under the grid firing during `intro`.
for (const [name, r] of [['idle', idle], ['throttle held', held]]) {
  if (r.earlyBoost.length) fails.push(`${name}: boost granted before the flag — source ${r.earlyBoost.join(', ')}`);
}

// 3. The grid approach is 11m by design (FORM_BACK in race/director.ts). Much
//    more than that and something is carrying the field down the circuit.
const FORM_BACK = 11;
for (const [name, r] of [['idle', idle], ['throttle held', held]]) {
  if (r.intro > FORM_BACK * 1.5) {
    fails.push(`${name}: travelled ${r.intro.toFixed(1)}m during intro — the grid approach is only ${FORM_BACK}m`);
  }
  if (r.atFlag > FORM_BACK * 1.5) {
    fails.push(`${name}: the flag dropped ${r.atFlag.toFixed(1)}m down the circuit`);
  }
}

// 4. And not just the player — seven AI drivers leaving early is the same bug.
if (idle.fieldPeak > 40) fails.push(`the field reached ${idle.fieldPeak.toFixed(1)} before the flag`);

if (errors.length) fails.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

// A warning, not a failure — it is a course-layout defect rather than the
// timing one this test guards, and a red gate should mean the thing it is
// named after. Surfaced on every run so it cannot be forgotten: the grid on
// cone-canyon stands on a boost strip, so the flag hands the whole field a
// `pad` boost that the rocket start then has to compete with.
if (idle.gridSurface === 'boost') {
  console.log(`  WARN  the start grid stands on a '${idle.gridSurface}' surface —`
    + ` the flag grants a '${idle.flagBoost}' boost nobody earned, and it lands on the`
    + ` frame the rocket start is evaluated`);
}

// The formation approach in `intro` is deliberate — the field rolls up to the
// grid and parks. Printed rather than asserted away, so a change to it is
// visible in the log rather than silent.
console.log(`  grid formation moved the kart ${idle.intro.toFixed(2)}m during intro`
  + ` (${FORM_BACK}m by design, peak speed ${idle.introPeak.toFixed(1)})`);
console.log(`  the flag dropped ${idle.atFlag.toFixed(2)}m from where the kart started`);
if (fails.length) { for (const f of fails) console.log(`  FAIL  ${f}`); console.log('\n  THE FIELD MOVES BEFORE THE FLAG'); }
else console.log('\n  PINNED UNTIL GO — no movement and no boost under the countdown, held throttle or not');

await browser.close();
await server.close();
process.exit(fails.length ? 1 : 0);
