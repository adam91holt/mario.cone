#!/usr/bin/env node
/**
 * critic-r2-crop.mjs — magnify the same rectangle out of several PNGs and lay
 * them out one above the other so a reviewer can actually see the difference
 * between two render scales instead of squinting at two downsampled 1600x900
 * contact prints.
 *
 * node tools/critic-r2-crop.mjs --x 600 --y 380 --w 400 --h 200 --zoom 3 \
 *   --out /tmp/cmp.png a.png b.png
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const X = Number(arg('x', 0)), Y = Number(arg('y', 0));
const W = Number(arg('w', 400)), H = Number(arg('h', 200));
const Z = Number(arg('zoom', 3));
const OUT = arg('out', '/tmp/crop.png');

const imgs = [];
for (const f of files) {
  const b = await readFile(path.resolve(f));
  imgs.push({ name: path.basename(f), uri: 'data:image/png;base64,' + b.toString('base64') });
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: W * Z, height: (H * Z + 26) * imgs.length }, deviceScaleFactor: 1 });
await page.setContent(`<style>
  body{margin:0;background:#111;font:12px monospace;color:#fff}
  .r{position:relative;height:${H * Z + 26}px}
  .r canvas{display:block;image-rendering:pixelated}
  .l{position:absolute;left:0;bottom:0;height:26px;line-height:26px;padding:0 8px;background:#000c}
</style>` + imgs.map((_, i) => `<div class="r"><canvas id="c${i}" width="${W * Z}" height="${H * Z}"></canvas><div class="l" id="l${i}"></div></div>`).join(''));
await page.evaluate(async ({ imgs, X, Y, W, H, Z }) => {
  for (let i = 0; i < imgs.length; i++) {
    const im = new Image();
    await new Promise((r) => { im.onload = r; im.src = imgs[i].uri; });
    const cv = document.getElementById('c' + i);
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(im, X, Y, W, H, 0, 0, W * Z, H * Z);
    document.getElementById('l' + i).textContent = imgs[i].name;
  }
}, { imgs, X, Y, W, H, Z });
await page.screenshot({ path: OUT });
await browser.close();
console.log('wrote', OUT);
