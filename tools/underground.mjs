// Does the camera ever end up inside the ground?
//
// Reported by a player: "sometimes the map is below a layer or something and you
// kinda go underground and the screen just went brown above the racer and you
// can't see them."
//
// That is the chase lens sinking through the landscape. It is not a rendering
// question and it is not judged by eye — the terrain is a real mesh, so the
// test casts a ray straight down onto it from well above the camera and asks
// whether the camera's own Y is under the surface at its own XZ. Under it by
// any amount means the player is looking at the world from inside it.
//
// It is a camera test, not a course test: it drives every course because the
// failure needs the ground beside the road to be higher than the road, and
// which corner does that is a property of the layout. When it first ran, one
// course put the lens 8.5m inside a hillside while the kart was on the road.
//
//   node tools/underground.mjs
//   node tools/underground.mjs --course cone-canyon --seconds 40

import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const COURSES = opt('course', 'cone-canyon,saltpan-bypass,jackhammer-quarry,switchback-summit').split(',');
const SECONDS = Number(opt('seconds', 34));
const STEP = 0.2;

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist'],
});
// Small viewport on purpose: this renders hundreds of frames under software GL
// and none of them are looked at, only measured.
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 120_000 });
// The app's own three, from the dev server it is already served by.
await page.evaluate(async () => { window.__THREE = await import('/node_modules/three/build/three.module.js'); });

const fails = [];

for (const course of COURSES) {
  // `reset` takes courseId/vehicleId and silently ignores anything else, so
  // asking for `course` loads the default and says nothing. This test spent its
  // first run measuring cone-canyon four times and reporting four courses; the
  // giveaway was three of them agreeing to the centimetre. Whatever it loaded
  // is checked against what was asked for, every time.
  const reset = await page.evaluate(async (c) => {
    try { await window.__GAME.reset({ courseId: c, vehicleId: 'cone', seed: 1 }); }
    catch (e) { return String(e); }
    return window.__GAME.snapshot().track?.id ?? '(no track)';
  }, course);
  if (reset !== course) {
    fails.push(`${course}: asked for it and got "${reset}" — the harness did not load the course under test`);
    continue;
  }

  // Freeze wall-clock stepping, AFTER the reset, because reset puts the scale
  // back to 1. The engine's own rAF loop keeps simulating in real time
  // alongside anything the harness drives, so without this the kart travels
  // between one page.evaluate and the next and a sample labelled t=2s is
  // nothing of the sort. capture.mjs has always done this and says why; the
  // first version of this test did not, held full steer for thirty *real*
  // seconds, drove off the road into a mountain, and reported the camera 12m
  // underground on the one course with mountains. The camera was fine. The
  // kart was inside a hill.
  await page.evaluate(() => window.__GAME.setTimeScale(0));

  const worst = await page.evaluate(async ({ secs, step }) => {
    const THREE = window.__THREE, ctx = window.__CTX, g = window.__GAME;
    g.seek('racing');
    g.setAutopilot(true);

    const ray = new THREE.Raycaster();
    ray.far = 4000;
    const down = new THREE.Vector3(0, -1, 0);
    const from = new THREE.Vector3();
    // The landscape is exactly two meshes and they are named. Picking them by
    // vertex count instead is how the first version of this test "reproduced"
    // the bug: the filter caught grandstands, crowds and an overhead sign, and
    // reported the lens 8.5m inside the ground when it was passing under a
    // gantry with clear sky above it. Going under something built is not going
    // underground.
    const ground = [];
    ctx.scene.traverse((o) => {
      if (o.isMesh && (o.name === 'ground' || o.name === 'embankment')) ground.push(o);
    });

    let worst = null;
    let breaches = 0;
    let samples = 0;
    for (let t = 0; t < secs; t += step) {
      g.advance(step, 10);
      const cam = ctx.camera.position;
      from.set(cam.x, cam.y + 600, cam.z);
      ray.set(from, down);
      const hits = ray.intersectObjects(ground, false);
      if (!hits.length) continue;
      samples++;
      const surfY = Math.max(...hits.map((h) => h.point.y));
      const under = surfY - cam.y;
      if (under > 0) breaches++;
      if (!worst || under > worst.under) {
        const p = ctx.racers.find((r) => r.isPlayer);
        worst = {
          under: +under.toFixed(2), t: +t.toFixed(1),
          camY: +cam.y.toFixed(2), surfY: +surfY.toFixed(2),
          playerSurface: p?.surface, speed: +(p?.speed ?? 0).toFixed(1),
        };
      }
    }
    return { worst, breaches, samples, ground: ground.length };
  }, { secs: SECONDS, step: STEP });

  if (!worst.ground) { fails.push(`${course}: no terrain mesh in the scene to test against`); continue; }
  if (!worst.samples) { fails.push(`${course}: no samples — the ray never found the ground`); continue; }

  const w = worst.worst;
  const margin = w ? -w.under : 0;
  console.log(`  ${course.padEnd(20)} ${worst.samples} samples, closest approach ${margin.toFixed(2)}m`
    + ` above the surface at ${w.t}s (kart on ${w.playerSurface} at ${w.speed} m/s)`);
  if (worst.breaches > 0) {
    fails.push(`${course}: the camera was inside the ground on ${worst.breaches}/${worst.samples} samples`
      + `, worst ${w.under}m under at ${w.t}s — camera Y ${w.camY}, surface ${w.surfY},`
      + ` with the kart on ${w.playerSurface}`);
  }
}

if (errors.length) fails.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

if (fails.length) {
  for (const f of fails) console.log(`  FAIL  ${f}`);
  console.log('\n  THE CAMERA GOES UNDERGROUND');
} else {
  console.log('\n  THE LENS STAYS OUT OF THE GROUND — every course, every sample');
}

await browser.close();
await server.close();
process.exit(fails.length ? 1 : 0);
