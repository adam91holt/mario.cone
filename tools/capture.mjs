#!/usr/bin/env node
/**
 * capture.mjs — drive the real game headlessly and photograph it.
 *
 * This is how every reviewer sees the game. It boots a Vite dev server, loads
 * the page in headless Chromium, and drives the simulation through
 * `window.__GAME` — the deterministic step API — rather than in realtime. That
 * matters: this container renders through SwiftShader (software GL), so a
 * realtime capture would produce different frames on every run. Stepping the
 * fixed timestep by hand makes "4.0 seconds into the race" mean exactly one
 * thing.
 *
 * Usage
 *   node tools/capture.mjs --smoke              boot, drive, assert, exit non-zero on failure
 *   node tools/capture.mjs                      write the standard review sheet to shots/
 *   node tools/capture.mjs --out dir/           choose the output directory
 *   node tools/capture.mjs --only drift,boost   capture just those shots
 *   node tools/capture.mjs --list               list available shots
 *   node tools/capture.mjs --width 1600 --height 900
 *   node tools/capture.mjs --vehicle plane --course cone-canyon
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');

// ── argument parsing ───────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OPTIONS = {
  smoke: flag('smoke'),
  list: flag('list'),
  out: opt('out', 'shots'),
  only: opt('only', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  width: Number(opt('width', 1600)),
  height: Number(opt('height', 900)),
  vehicle: opt('vehicle', 'cone'),
  course: opt('course', 'cone-canyon'),
  seed: Number(opt('seed', 1)),
  keep: flag('keep'),
  quiet: flag('quiet'),
};

const log = (...a) => { if (!OPTIONS.quiet) console.log(...a); };

// ── the standard review sheet ──────────────────────────────────────────────
//
// Each shot is a named recipe run against a freshly reset race. Add shots here
// when you add a feature that needs looking at — a feature with no shot is a
// feature no reviewer will ever see.

const SHOTS = [
  {
    name: 'grid',
    caption: 'Start grid, pre-countdown. Framing, model quality, lighting, ground contact.',
    async run(game) {
      await game.reset({ instant: false });
      await game.advance(0.6);
    },
  },
  {
    name: 'countdown',
    caption: 'Countdown beat. HUD punch and the pre-race camera.',
    async run(game) {
      await game.reset({ instant: false });
      await game.seek('countdown');
      await game.advance(2.4);
    },
  },
  {
    name: 'racing',
    caption: 'Flat out on a racing line. The default view a player spends the race in.',
    async run(game) {
      await game.reset({ instant: true });
      await game.setAutopilot(true);
      await game.advance(9);
    },
  },
  {
    name: 'drift',
    caption: 'Mid-drift with a charged mini-turbo. Sparks, chassis angle, camera offset.',
    async run(game) {
      // Hand-driven: autopilot picks its own line, and this shot needs a
      // guaranteed committed drift.
      await game.reset({ instant: true });
      await game.setInput({ accel: 1 });
      await game.advance(3.2);
      await game.setInput({ accel: 1, steer: 0.85, drift: true });
      await game.advance(1.9);
    },
  },
  {
    name: 'boost',
    caption: 'The frame right after a mini-turbo fires. FOV kick, flames, speed cues.',
    async run(game) {
      await game.reset({ instant: true });
      await game.setInput({ accel: 1 });
      await game.advance(3.2);
      await game.setInput({ accel: 1, steer: 0.85, drift: true });
      await game.advance(2.2);
      await game.setInput({ accel: 1, steer: 0.2, drift: false });
      await game.advance(0.35);
    },
  },
  {
    name: 'pack',
    caption: 'Mid-pack traffic. Do the racers read apart from each other at speed?',
    async run(game) {
      await game.reset({ instant: true });
      await game.setAutopilot(true);
      await game.advance(16);
    },
  },
  {
    name: 'overhead',
    caption: 'Track layout from above. Course design, silhouette, world dressing.',
    async run(game) {
      await game.reset({ instant: true });
      await game.setAutopilot(true);
      await game.advance(6);
      await game.setCamera('overhead');
      await game.render();
    },
  },
  {
    name: 'offroad',
    caption: 'Off the road surface. Does leaving the track look and feel punishing?',
    async run(game) {
      await game.reset({ instant: true });
      await game.setAutopilot(false);
      await game.setInput({ accel: 1 });
      await game.advance(2.5);
      await game.setInput({ accel: 1, steer: -1 });
      await game.advance(2.2);
    },
  },
  {
    name: 'far',
    caption: 'Pulled-back chase. Reads the environment and horizon, not just the kart.',
    async run(game) {
      await game.reset({ instant: true });
      await game.setAutopilot(true);
      await game.advance(11);
      await game.setCamera('far');
      await game.advance(0.5);
    },
  },
];

// ── browser-side driver ────────────────────────────────────────────────────

/**
 * Wraps window.__GAME in an await-able facade. Every call round-trips into the
 * page, which keeps the node side ignorant of game internals.
 */
function makeGameProxy(page) {
  const call = (fn, ...args) =>
    page.evaluate(
      ([f, a]) => {
        const g = window.__GAME;
        if (!g) throw new Error('window.__GAME missing');
        const result = g[f](...a);
        return result instanceof Promise ? result.then(() => null) : (result ?? null);
      },
      [fn, args],
    );

  return {
    reset: (opts = {}) => call('reset', { vehicleId: OPTIONS.vehicle, courseId: OPTIONS.course, seed: OPTIONS.seed, ...opts }),
    step: (s) => call('step', s),
    render: () => call('render'),
    advance: (s, fps) => call('advance', s, fps),
    setInput: (i) => call('setInput', i),
    clearInput: () => call('clearInput'),
    press: (n) => call('press', n),
    setCamera: (m) => call('setCamera', m),
    setQuality: (q) => call('setQuality', q),
    setAutopilot: (on) => call('setAutopilot', on),
    seek: (p) => call('seek', p),
    stats: () => call('stats'),
    snapshot: () => call('snapshot'),
    errors: () => page.evaluate(() => window.__GAME?.errors ?? []),
  };
}

async function withPage(fn) {
  const server = await createServer({
    root: ROOT,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    // A dev server needs no bundling pass, so iteration stays fast.
    optimizeDeps: { include: ['three'] },
  });
  await server.listen();
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}/index.html`;

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-gpu-blocklist',
      '--hide-scrollbars',
    ],
  });

  const page = await browser.newPage({
    viewport: { width: OPTIONS.width, height: OPTIONS.height },
    deviceScaleFactor: 1,
  });

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Boot compiles shaders under software GL, which is slow — be patient.
    await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120_000 });
    return await fn(page, makeGameProxy(page), consoleErrors);
  } finally {
    await browser.close();
    await server.close();
  }
}

// ── modes ──────────────────────────────────────────────────────────────────

async function runSmoke() {
  return withPage(async (page, game, consoleErrors) => {
    const failures = [];

    // Autopilot, so this asserts the kart can actually race the course rather
    // than that it can accelerate into the first barrier.
    await game.reset({ instant: true });
    await game.setAutopilot(true);
    await game.advance(12);

    const snap = await game.snapshot();
    const stats = await game.stats();
    const player = snap.racers.find((r) => r.isPlayer);

    if (!player) failures.push('no player racer in snapshot');
    if (player && player.speed < 20) {
      failures.push(`player is not getting up to speed: ${player.speed} m/s after 12s`);
    }
    // 12s of autopilot should cover a good fraction of a lap on any sane course.
    if (player && player.progress < 250) {
      failures.push(`player made little track progress: ${player.progress}m in 12s`);
    }
    if (snap.racers.length < 2) failures.push(`expected a field, got ${snap.racers.length} racer(s)`);
    if (snap.race?.phase !== 'racing') failures.push(`expected phase "racing", got "${snap.race?.phase}"`);
    if (stats.drawCalls === 0) failures.push('nothing was drawn (0 draw calls)');

    // Any racer leaving the world means physics or the track query is broken.
    for (const r of snap.racers) {
      if (!Number.isFinite(r.pos[0]) || Math.abs(r.pos[1]) > 500) {
        failures.push(`racer ${r.name} left the world at ${r.pos.join(',')}`);
      }
    }

    const pageErrors = [...consoleErrors, ...(await game.errors())];
    if (pageErrors.length) failures.push(`console errors:\n    ${pageErrors.slice(0, 8).join('\n    ')}`);

    console.log('\n── smoke ──────────────────────────────────────────');
    console.log(`  phase        ${snap.race?.phase}`);
    console.log(`  racers       ${snap.racers.length}`);
    console.log(`  player speed ${player?.speed} m/s`);
    console.log(`  progress     ${player?.progress} m`);
    console.log(`  draw calls   ${stats.drawCalls}`);
    console.log(`  triangles    ${stats.triangles}`);
    console.log('───────────────────────────────────────────────────');

    if (failures.length) {
      console.error('\nSMOKE FAILED:');
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exitCode = 1;
      return false;
    }
    console.log('\nSMOKE PASSED\n');
    return true;
  });
}

async function runShots() {
  const outDir = path.resolve(ROOT, OPTIONS.out);
  if (existsSync(outDir) && !OPTIONS.keep) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const wanted = OPTIONS.only.length ? SHOTS.filter((s) => OPTIONS.only.includes(s.name)) : SHOTS;
  if (!wanted.length) {
    console.error(`No shots matched --only "${OPTIONS.only.join(',')}"`);
    process.exitCode = 1;
    return;
  }

  return withPage(async (page, game, consoleErrors) => {
    const index = [];

    for (const shot of wanted) {
      const started = Date.now();
      await game.clearInput();
      await shot.run(game);
      await game.render();

      const file = path.join(outDir, `${shot.name}.png`);
      await page.screenshot({ path: file });

      const snap = await game.snapshot();
      const stats = await game.stats();
      const player = snap.racers.find((r) => r.isPlayer);

      index.push({
        name: shot.name,
        caption: shot.caption,
        file: path.relative(ROOT, file),
        phase: snap.race?.phase,
        playerSpeed: player?.speed,
        playerPlace: player?.place,
        drifting: player?.drift?.active,
        driftTier: player?.drift?.tier,
        boosting: (player?.boost?.time ?? 0) > 0,
        drawCalls: stats.drawCalls,
        triangles: stats.triangles,
      });

      log(`  ✓ ${shot.name.padEnd(10)} ${String(Date.now() - started).padStart(5)}ms  ${path.relative(ROOT, file)}`);
    }

    const errors = [...consoleErrors, ...(await game.errors())];
    await writeFile(
      path.join(outDir, 'index.json'),
      JSON.stringify({ options: OPTIONS, shots: index, errors }, null, 2),
    );

    log(`\n${index.length} shot(s) → ${path.relative(ROOT, outDir)}/`);
    if (errors.length) {
      console.error(`\n${errors.length} console error(s):`);
      for (const e of errors.slice(0, 10)) console.error(`  ✗ ${e}`);
      process.exitCode = 1;
    }
  });
}

// ── entry ──────────────────────────────────────────────────────────────────

if (OPTIONS.list) {
  console.log('\nAvailable shots:\n');
  for (const s of SHOTS) console.log(`  ${s.name.padEnd(12)} ${s.caption}`);
  console.log();
} else if (OPTIONS.smoke) {
  await runSmoke();
} else {
  await runShots();
}
