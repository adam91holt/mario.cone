#!/usr/bin/env node
/**
 * critic-r2-gate.mjs — is the frame budget gate judging the frame it says it is?
 *
 * `capture.mjs --smoke` prints "frame budget — 1600x900, 7 racers, cone-canyon,
 * rung 0" and then, two lines later, "at rung 6, scene 800x450", and enforces
 * anyway. This asks `gate()` directly at a governor-settled state and at a
 * pinned rung 0, and prints `applies` for both.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180000 });

// Exactly the smoke's own recipe.
const out = await page.evaluate(async () => {
  await window.__GAME.reset({ vehicleId: 'cone', courseId: 'cone-canyon', seed: 1, instant: true });
  window.__GAME.setTimeScale(0);
  window.__GAME.setAutopilot(true);
  window.__GAME.step(11);
  window.__GAME.advance(1);
  const asSmokeSees = globalThis.__QUALITY.gate();
  const pick = (g) => ({
    applies: g.applies, pass: g.pass, rung: g.rung, scenePx: g.scenePx,
    frame: { drawCalls: g.frame.drawCalls, triangles: g.frame.triangles, cpuMs: g.frame.cpuMs },
    target: g.target, failures: g.failures,
  });
  // Now pin the rung the ceilings are stated for and re-ask, same moment.
  globalThis.__QUALITY.set(0);
  window.__GAME.render();
  const atRung0 = globalThis.__QUALITY.gate();
  return { asSmokeSees: pick(asSmokeSees), atRung0: pick(atRung0) };
});

console.log('── what --smoke actually gated ───────────────────');
console.log(JSON.stringify(out.asSmokeSees, null, 2));
console.log('── the same moment, pinned to rung 0 ─────────────');
console.log(JSON.stringify(out.atRung0, null, 2));
await browser.close();
await server.close();
