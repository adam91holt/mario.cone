// Downscale review-sheet frames into README-sized JPEGs.
//
// The capture harness writes 1600x900 PNGs at 1-1.7MB each, which is right for a
// critic reading pixel luminance off a plate and wrong for a repo — six of them
// would put ten megabytes of screenshot in every clone, forever, and they are
// regenerated every wave.
//
// There is no image library in this project's dependency tree and there does not
// need to be: Chromium is already here for the capture harness, and a canvas
// resize plus toDataURL is exactly the operation. Same trick tools/progress.mjs
// uses to inline frames into the build board.
//
//   node tools/readmeshots.mjs [--width 1280] [--quality 0.82]

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/media');
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const WIDTH = Number(opt('width', 1280));
const QUALITY = Number(opt('quality', 0.82));

const SHOTS = ['racing', 'drift', 'overhead', 'grid', 'results'];

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();

for (const name of SHOTS) {
  const src = path.join(ROOT, 'shots', `${name}.png`);
  let raw;
  try {
    raw = await readFile(src);
  } catch {
    console.log(`  skip ${name} — no shots/${name}.png`);
    continue;
  }
  const dataUrl = `data:image/png;base64,${raw.toString('base64')}`;

  const jpeg = await page.evaluate(
    async ([url, width, quality]) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = width;
      c.height = Math.round((img.naturalHeight / img.naturalWidth) * width);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', quality);
    },
    [dataUrl, WIDTH, QUALITY],
  );

  const buf = Buffer.from(jpeg.split(',')[1], 'base64');
  await writeFile(path.join(OUT, `${name}.jpg`), buf);
  const kb = (buf.length / 1024).toFixed(0);
  const was = (raw.length / 1024).toFixed(0);
  console.log(`  ${name.padEnd(9)} ${was}KB png -> ${kb}KB jpg`);
}

await browser.close();
console.log(`\n-> docs/media/`);
