#!/usr/bin/env node
/**
 * clip.mjs — record deterministic gameplay clips.
 *
 * Recording the page in realtime would capture whatever framerate SwiftShader
 * happened to manage, which on this box is a slideshow. Instead this steps the
 * simulation by exactly 1/fps of game time per frame and screenshots each one,
 * so the clip plays back at true speed regardless of how long it took to render.
 * The kart really is doing 190km/h in the video even though each frame took a
 * second to draw.
 *
 * Usage
 *   node tools/clip.mjs                       record every clip to clips/
 *   node tools/clip.mjs --only drift          just one
 *   node tools/clip.mjs --fps 24 --width 960
 *   node tools/clip.mjs --list
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const FFMPEG = '/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

/**
 * Which checkout to serve. Recording takes minutes per clip, and build agents
 * rewrite the working tree the whole time — a mid-refactor file will not boot,
 * and a clip recorded across an edit is a clip of two different games. Point
 * this at a git worktree pinned to a verified commit:
 *
 *   git worktree add /tmp/mc-stable <sha>
 *   ln -s "$PWD/node_modules" /tmp/mc-stable/node_modules
 *   node tools/clip.mjs --root /tmp/mc-stable
 */
const ROOT = path.resolve(opt('root', path.resolve(import.meta.dirname, '..')));

const FPS = Number(opt('fps', 24));
const WIDTH = Number(opt('width', 960));
const HEIGHT = Math.round((WIDTH / 16) * 9);
const OUT = path.resolve(import.meta.dirname, "..", opt("out", "clips"));
const ONLY = opt('only', '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Each clip is a setup (fast-forwarded with step(), never rendered) followed by
 * `seconds` of recorded game time. Keep them short — every recorded second costs
 * `fps` full screenshots under software GL.
 */
const CLIPS = [
  {
    name: 'race',
    seconds: 7,
    caption: 'A lap in progress. Autopilot on a racing line through the banked sweeper.',
    async setup(game) {
      await game.reset({ instant: true });
      await game.setAutopilot(true);
      await game.step(6);
    },
  },
  {
    name: 'drift',
    seconds: 6,
    caption: 'Committed drift into a mini-turbo release — sparks charging through the tiers, then the boost.',
    async setup(game) {
      await game.reset({ instant: true });
      await game.setAutopilot(false);
      await game.setInput({ accel: 1 });
      await game.step(3.2);
      await game.setInput({ accel: 1, steer: 0.85, drift: true });
      await game.step(1.2);
    },
    /** Released mid-clip, so the boost fires on camera rather than before it. */
    async during(game, t) {
      if (t === 'release') await game.setInput({ accel: 1, steer: 0.25, drift: false });
    },
    releaseAt: 0.55,
  },
  {
    name: 'pack',
    seconds: 7,
    caption: 'Mid-pack traffic. Eight machines, items, coins and contact.',
    async setup(game) {
      await game.reset({ instant: true });
      await game.setAutopilot(true);
      await game.step(14);
    },
  },
  {
    name: 'start',
    seconds: 6,
    caption: 'Lights out. The grid, the countdown, and the run to turn one.',
    async setup(game) {
      await game.reset({ instant: false });
      await game.seek('countdown');
      await game.step(0.6);
      await game.setAutopilot(true);
    },
  },
];

function encode(dir, name, fps) {
  return new Promise((resolve, reject) => {
    const out = path.join(OUT, `${name}.webm`);
    const args = [
      '-y', '-loglevel', 'error',
      '-framerate', String(fps),
      '-i', path.join(dir, 'f%05d.png'),
      '-c:v', 'libvpx', '-b:v', '1400k', '-crf', '31',
      '-pix_fmt', 'yuv420p',
      '-an', out,
    ];
    const p = spawn(FFMPEG, args);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `ffmpeg exit ${code}`))));
  });
}

if (flag('list')) {
  console.log('\nClips:\n');
  for (const c of CLIPS) console.log(`  ${c.name.padEnd(8)} ${c.seconds}s  ${c.caption}`);
  console.log();
  process.exit(0);
}

const wanted = ONLY.length ? CLIPS.filter((c) => ONLY.includes(c.name)) : CLIPS;

if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

const call = (fn, ...args) =>
  page.evaluate(([f, a]) => {
    const r = window.__GAME[f](...a);
    return r instanceof Promise ? r.then(() => null) : (r ?? null);
  }, [fn, args]);

const game = {
  reset: (o = {}) => call('reset', { vehicleId: 'cone', courseId: 'cone-canyon', seed: 1, ...o }),
  step: (s) => call('step', s),
  advance: (s, f) => call('advance', s, f),
  setInput: (i) => call('setInput', i),
  setAutopilot: (v) => call('setAutopilot', v),
  setCamera: (m) => call('setCamera', m),
  seek: (p) => call('seek', p),
};

// Generous, because recording usually runs while build agents hold the CPU.
// Booting the game means compiling every shader on a software renderer, and
// under that contention it has taken over two minutes.
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 300_000 });

console.log(`\nrecording at ${WIDTH}x${HEIGHT}, ${FPS}fps\n`);

for (const clip of wanted) {
  const started = Date.now();
  const dir = path.join(OUT, `_${clip.name}`);
  await mkdir(dir, { recursive: true });

  await clip.setup(game);

  const frames = clip.seconds * FPS;
  const releaseFrame = clip.releaseAt ? Math.round(frames * clip.releaseAt) : -1;

  for (let i = 0; i < frames; i++) {
    if (i === releaseFrame) await clip.during(game, 'release');
    // One frame of game time, rendered. advance() interleaves the fixed steps
    // with a draw, so per-frame visual state (springs, particles) is correct.
    await game.advance(1 / FPS, 1);
    await page.screenshot({ path: path.join(dir, `f${String(i).padStart(5, '0')}.png`) });
  }

  const file = await encode(dir, clip.name, FPS);
  await rm(dir, { recursive: true, force: true });
  const size = (await import('node:fs')).statSync(file).size;
  console.log(`  ✓ ${clip.name.padEnd(8)} ${clip.seconds}s  ${(size / 1024).toFixed(0)}KB  ${Math.round((Date.now() - started) / 1000)}s to record`);
}

await browser.close();
await server.close();

const made = (await readdir(OUT)).filter((f) => f.endsWith('.webm'));
console.log(`\n${made.length} clip(s) → ${path.relative(ROOT, OUT)}/\n`);
