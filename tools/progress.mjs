#!/usr/bin/env node
/**
 * progress.mjs — render the live build board.
 *
 * Reads the board state from tools/progress.state.json, shrinks whatever is
 * currently in shots/ into inline JPEGs, and writes progress.html. Inlining the
 * frames matters: the board gets published as a standalone page, so it cannot
 * reference image files that live only in this container.
 *
 * Downscaling runs through headless Chromium's canvas rather than an image
 * library, so this needs no dependency the project does not already have.
 *
 * Usage: node tools/progress.mjs [--width 720] [--quality 0.72] [--no-shots]
 */

import { chromium } from 'playwright';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const WIDTH = Number(opt('width', 720));
const QUALITY = Number(opt('quality', 0.72));
const NO_SHOTS = argv.includes('--no-shots');

/** Which captures to surface on the board, in the order that tells the story. */
const FEATURED = ['grid', 'racing', 'drift', 'boost', 'pack', 'far', 'overhead', 'offroad', 'countdown'];

async function shrinkShots() {
  const dir = path.join(ROOT, 'shots');
  if (NO_SHOTS || !existsSync(dir)) return [];

  const files = (await readdir(dir)).filter((f) => f.endsWith('.png'));
  if (!files.length) return [];

  let captions = {};
  try {
    const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
    for (const s of index.shots ?? []) captions[s.name] = s.caption;
  } catch {
    // index.json is optional — a partial capture still has frames worth showing.
  }

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const out = [];

  const ordered = [
    ...FEATURED.filter((n) => files.includes(`${n}.png`)),
    ...files.map((f) => f.replace(/\.png$/, '')).filter((n) => !FEATURED.includes(n)),
  ];

  for (const name of ordered) {
    const buf = await readFile(path.join(dir, `${name}.png`));
    const src = `data:image/png;base64,${buf.toString('base64')}`;
    const jpeg = await page.evaluate(
      async ([dataUrl, width, quality]) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const scale = Math.min(1, width / img.naturalWidth);
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', quality);
      },
      [src, WIDTH, QUALITY],
    );
    out.push({ name, src: jpeg, caption: captions[name] ? ` ${captions[name]}` : '' });
  }

  await browser.close();
  return out;
}

const state = JSON.parse(await readFile(path.join(ROOT, 'tools/progress.state.json'), 'utf8'));
state.shots = await shrinkShots();
state.updated = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

const template = await readFile(path.join(ROOT, 'tools/progress.template.html'), 'utf8');
const html = template.replace('__STATE__', JSON.stringify(state, null, 2));
await writeFile(path.join(ROOT, 'progress.html'), html);

const kb = Math.round(Buffer.byteLength(html) / 1024);
const passed = state.pieces.filter((p) => p.state === 'pass').length;
console.log(`progress.html written — ${kb}KB, ${state.shots.length} frame(s), ${passed}/${state.pieces.length} pieces passed`);
