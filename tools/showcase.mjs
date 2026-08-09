#!/usr/bin/env node
/**
 * showcase.mjs — build the standalone gallery page.
 *
 * Everything is inlined as a data URI. The page gets published as an artifact
 * with a strict CSP and no access to this container, so a page that referenced
 * shots/racing.png would render as a row of broken images.
 *
 * Stills are downscaled to JPEG through headless Chromium's canvas (no image
 * dependency needed); clips are embedded as-is, since they are already small.
 *
 * Usage: node tools/showcase.mjs [--width 1100] [--quality 0.78]
 */

import { chromium } from 'playwright';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const WIDTH = Number(opt('width', 1100));
const QUALITY = Number(opt('quality', 0.78));

/** Order tells the story: the grid, then speed, then the drift, then the pack. */
const SHOTS = [
  ['grid', 'The grid', 'Eight machines, staggered. Every racer has to read as a black silhouette at thumbnail size — that is the test Nintendo applies, and it is the one that matters.'],
  ['drift', 'Committed drift', 'The chassis pivots out while the kart keeps travelling forward. Sparks charge through three mini-turbo tiers; the colour tells you how much boost you have banked.'],
  ['boost', 'Mini-turbo fires', 'The frame after release. FOV widens, the camera punches, the flame plume lights the road.'],
  ['pack', 'Traffic', 'Mid-pack at speed. Seven rival machines, items on the road, coins, and contact.'],
  ['racing', 'Hi-Vis Sweep', 'Turn one — 300m of banked right, flat if you trust the camber. The road pinches where the corner tightens.'],
  ['far', 'Canyon Wall', 'The long banked sweeper home. Buttes sit at the end of every straight so each corner exit has something at its vanishing point.'],
  ['overhead', 'The circuit', 'Cone Canyon Speedway: nine named corners, boost strips on the Detour Straight, and a gravel shortcut across the hairpin apex.'],
  ['offroad', 'Off the island', 'Leaving the road costs about half your top speed. It has to be punishing and recoverable, and it has to read instantly.'],
  ['countdown', 'Lights out', 'Hold the throttle in the last fraction of the countdown for a rocket start. Hold it too early and you bog down.'],
];

const CLIPS = [
  ['drift', 'Drift into mini-turbo', 'Hop, commit, charge, release. Recorded by stepping the simulation a frame at a time, so it plays at true speed — the kart really is doing this, even though each frame took seconds to draw on a software renderer.'],
  ['race', 'A lap in progress', 'CPU driver on a racing line through the banked sweeper.'],
  ['pack', 'Mid-pack', 'Eight machines, items and contact.'],
  ['start', 'The start', 'Grid, countdown, and the run to turn one.'],
];

async function inlineStills() {
  const dir = path.join(ROOT, 'shots');
  if (!existsSync(dir)) return new Map();
  const files = new Set((await readdir(dir)).filter((f) => f.endsWith('.png')));
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const out = new Map();

  for (const [name] of SHOTS) {
    if (!files.has(`${name}.png`)) continue;
    const buf = await readFile(path.join(dir, `${name}.png`));
    const src = `data:image/png;base64,${buf.toString('base64')}`;
    const jpeg = await page.evaluate(async ([d, w, q]) => {
      const img = new Image();
      img.src = d;
      await img.decode();
      const s = Math.min(1, w / img.naturalWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', q);
    }, [src, WIDTH, QUALITY]);
    out.set(name, jpeg);
  }
  await browser.close();
  return out;
}

async function inlineClips() {
  const dir = path.join(ROOT, 'clips');
  const out = new Map();
  if (!existsSync(dir)) return out;
  const files = new Set((await readdir(dir)).filter((f) => f.endsWith('.webm')));
  for (const [name] of CLIPS) {
    if (!files.has(`${name}.webm`)) continue;
    const buf = await readFile(path.join(dir, `${name}.webm`));
    out.set(name, `data:video/webm;base64,${buf.toString('base64')}`);
  }
  return out;
}

const stills = await inlineStills();
const clips = await inlineClips();

const hero = CLIPS.find(([n]) => clips.has(n));
const restClips = CLIPS.filter(([n]) => clips.has(n) && n !== (hero && hero[0]));

const html = `<title>MARIO.CONE</title>

<style>
  /* Committed to one visual world on purpose: this is a press page for a game
     that is mostly asphalt, hazard tape and low sun. A light variant would be
     a different game. Every colour is painted explicitly. */
  :root {
    --ink: #14161C;
    --ink-2: #1C1F27;
    --line: #2A2E38;
    --cream: #FFF8F0;
    --mute: #9AA1AE;
    --orange: #FF6B1A;
    --yellow: #FFC300;
    --green: #6FCF4A;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--ink); color: var(--cream);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .hazard { height: 9px; background: repeating-linear-gradient(-45deg, var(--yellow) 0 14px, var(--ink) 14px 28px); }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 0 clamp(1rem, 4vw, 2.4rem) 6rem; }

  header { padding: 3rem 0 1.4rem; }
  h1 {
    font-family: "Arial Black", Impact, sans-serif; font-weight: 900;
    font-size: clamp(2.6rem, 8vw, 5.4rem); letter-spacing: -.045em; line-height: .92;
    margin: 0; color: var(--orange);
  }
  h1 .dot { color: var(--yellow); }
  .kicker {
    margin: .9rem 0 0; font-size: .74rem; font-weight: 700;
    letter-spacing: .34em; text-transform: uppercase; color: var(--mute);
  }
  .lede { margin: 1.4rem 0 0; max-width: 60ch; font-size: 1.12rem; color: #D8DCE4; }

  .stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
    gap: 1px; background: var(--line); border: 1px solid var(--line);
    border-radius: 10px; overflow: hidden; margin: 2.4rem 0 0;
  }
  .stat { background: var(--ink-2); padding: .95rem 1.1rem; }
  .stat dt { margin: 0; font-size: .64rem; font-weight: 700; letter-spacing: .17em; text-transform: uppercase; color: var(--mute); }
  .stat dd { margin: .28rem 0 0; font-size: 1.55rem; font-weight: 800; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .stat dd small { font-size: .82rem; font-weight: 600; color: var(--mute); }

  h2 {
    margin: 4rem 0 .3rem; font-size: .72rem; font-weight: 800;
    letter-spacing: .22em; text-transform: uppercase; color: var(--yellow);
  }
  h2 + p.note { margin: 0 0 1.5rem; color: var(--mute); max-width: 66ch; font-size: .95rem; }

  figure { margin: 0; background: var(--ink-2); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  figure img, figure video { display: block; width: 100%; height: auto; background: #000; }
  figcaption { padding: .85rem 1.05rem 1rem; }
  figcaption b { display: block; font-size: 1rem; font-weight: 750; margin-bottom: .25rem; }
  figcaption span { font-size: .9rem; color: var(--mute); }

  .hero { margin-top: 1rem; }
  .hero figcaption b { font-size: 1.1rem; }

  .grid { display: grid; gap: 1.1rem; grid-template-columns: repeat(auto-fill, minmax(430px, 1fr)); }
  @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }

  .honest {
    margin-top: 3rem; padding: 1.3rem 1.5rem;
    background: var(--ink-2); border: 1px solid var(--line);
    border-left: 3px solid var(--orange); border-radius: 10px;
  }
  .honest h3 { margin: 0 0 .6rem; font-size: .95rem; font-weight: 750; }
  .honest ul { margin: 0; padding-left: 1.1rem; color: var(--mute); font-size: .93rem; }
  .honest li { margin-bottom: .45rem; }
  .honest b { color: var(--cream); font-weight: 650; }

  footer { margin-top: 3rem; padding-top: 1.2rem; border-top: 1px solid var(--line); color: var(--mute); font-size: .82rem; }
  a { color: var(--yellow); }
</style>

<div class="hazard"></div>
<div class="wrap">
  <header>
    <h1>mario<span class="dot">.</span>cone</h1>
    <p class="kicker">A Mario Kart-class racer in Three.js</p>
    <p class="lede">
      Seven machines off a roadworks site — a road cone, a plane, a helicopter, a
      digger, a train, a truck and a car — racing a nine-corner circuit through a
      canyon. TypeScript and Three.js, no art assets: every model, texture and
      particle is generated in code at load time.
    </p>

    <dl class="stats">
      <div class="stat"><dt>Racers</dt><dd>8</dd></div>
      <div class="stat"><dt>Top speed</dt><dd>62<small> m/s</small></dd></div>
      <div class="stat"><dt>Simulation</dt><dd>120<small> Hz</small></dd></div>
      <div class="stat"><dt>Draw calls</dt><dd>375</dd></div>
      <div class="stat"><dt>Triangles</dt><dd>281<small>k</small></dd></div>
      <div class="stat"><dt>Art assets</dt><dd>0</dd></div>
    </dl>
  </header>

${hero && clips.has(hero[0]) ? `
  <h2>In motion</h2>
  <p class="note">${hero[2]}</p>
  <figure class="hero">
    <video src="${clips.get(hero[0])}" autoplay loop muted playsinline controls></video>
    <figcaption><b>${hero[1]}</b><span>Cone Canyon Speedway · 150cc</span></figcaption>
  </figure>` : ''}

${restClips.length ? `
  <h2>More footage</h2>
  <p class="note">Each clip is recorded by stepping the simulation one frame at a time and photographing every frame, so playback is true speed rather than whatever the software renderer managed.</p>
  <div class="grid">
    ${restClips.map(([n, t, c]) => `
    <figure>
      <video src="${clips.get(n)}" autoplay loop muted playsinline controls></video>
      <figcaption><b>${t}</b><span>${c}</span></figcaption>
    </figure>`).join('')}
  </div>` : ''}

  <h2>Stills</h2>
  <p class="note">Pulled straight from the running game by the review harness — the same frames the critics judge.</p>
  <div class="grid">
    ${SHOTS.filter(([n]) => stills.has(n)).map(([n, t, c]) => `
    <figure>
      <img src="${stills.get(n)}" alt="${t}" loading="lazy" />
      <figcaption><b>${t}</b><span>${c}</span></figcaption>
    </figure>`).join('')}
  </div>

  <div class="honest">
    <h3>What you are looking at, honestly</h3>
    <ul>
      <li><b>This is mid-build, not finished.</b> Every piece is reviewed by an independent critic that plays the real game and compares it against Mario Kart 8. Items currently score 7/10, effects and the HUD 6.5. None have passed yet, and every blind comparison so far has gone to Mario Kart.</li>
      <li><b>Rendered on a software GPU.</b> This container has no graphics hardware, so everything here is drawn by SwiftShader at seconds per frame. Lighting, antialiasing and particle density are all rougher than the same code on a real machine.</li>
      <li><b>Known faults, measured.</b> The blooper darkens 66% of the play area where Mario Kart's ink darkens a fraction of it. Smoke puffs are 16-gons with straight edges at high zoom. The item roulette is visually dead for 92% of its spin. All three are queued with numeric pass conditions.</li>
      <li><b>AI, audio and world dressing do not exist yet</b> — they are in build now. The game is silent.</li>
    </ul>
  </div>

  <footer>
    Built with Claude Code · <a href="https://github.com/adam91holt/mario.cone">github.com/adam91holt/mario.cone</a>
  </footer>
</div>`;

await writeFile(path.join(ROOT, 'showcase.html'), html);
const size = (await stat(path.join(ROOT, 'showcase.html'))).size;
console.log(`showcase.html — ${(size / 1024 / 1024).toFixed(2)}MB, ${stills.size} still(s), ${clips.size} clip(s)`);
if (size > 15 * 1024 * 1024) console.error('WARNING: over the 16MB artifact limit — drop --width or --quality.');
