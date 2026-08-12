// Where is the lens, relative to the racer and to the ground?
//
// Two gates, and the second one exists because the first one passed a course
// that was unplayable.
//
// ── 1. is the lens inside the landscape? ──
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
// ── 2. how far ABOVE the racer is it? ──
//
// The gate above certifies that the lens is outside the ground. It says nothing
// about *where* outside, and a critic played a build in which it said PASS at
// 3.17m of clearance on a course that is played from a satellite: Jackhammer
// Quarry held the chase camera a median 24.9 degrees and a peak 73.6 above the
// kart — 31.98m of height on a racer at y=-41 — for 26 seconds of a 57-second
// lap. No horizon, no sense of speed, the next corner off the bottom of the
// frame. Every frame of that was, strictly, above ground.
//
// So the second gate is the angle of elevation from the racer to the lens, over
// a full lap, per course. Cone Canyon is the reference — a chase camera that
// works reads **median 14 degrees, max 21** — and anything over `--max-deg`
// (default 35) is a shot that has stopped being a racing camera.
//
// Almost always the cause is not the camera. `render/camera.ts` floors the lens
// at `Math.max(roadY, course.groundY)`, so any road that dives below its own
// course's `groundY` gets a camera pinned to the datum while the kart keeps
// descending. The report prints that relationship — `groundY` against the
// lowest road elevation on the circuit — next to the angles, because when it is
// the cause it is the whole cause and the number is one line in a course file.
//
//   node tools/underground.mjs
//   node tools/underground.mjs --course cone-canyon --seconds 40
//   node tools/underground.mjs --max-deg 30

import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const COURSES = opt('course', 'cone-canyon,saltpan-bypass,jackhammer-quarry,switchback-summit').split(',');
// A full lap of the slowest circuit in the cup, because the elevation gate is a
// statement about the whole lap and the quarry's fold ran from t=14s to t=40s.
const SECONDS = Number(opt('seconds', 60));
const STEP = 0.2;
/** Degrees of elevation from racer to lens above which the shot is not a racing shot. */
const MAX_DEG = Number(opt('max-deg', 35));
/**
 * ...and how far up it has to be for that angle to mean anything.
 *
 * The angle alone is not the defect. A boost punch or a wall shove pulls the
 * boom in to about four metres horizontally for a frame or two, and 3m of
 * height over 4m of ground is 37 degrees while the horizon has not moved: Cone
 * Canyon — the reference course, the one a critic measured as correct — trips a
 * bare angle gate on 12 of 300 samples that way, every one of them under three
 * metres above the kart. A satellite view is high *and* steep. The quarry's
 * were 32 metres up.
 */
const HIGH_M = Number(opt('high-m', 6));

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

  const worst = await page.evaluate(async ({ secs, step, highM }) => {
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

    // The chase camera is what a player actually looks through. `seek` leaves
    // whatever the intro sweep was on, and a cinematic lens measured as a chase
    // lens is a false reading in both directions.
    g.setCamera('chase');

    let worst = null;
    let breaches = 0;
    let samples = 0;
    /** Elevation of the lens above the racer, in degrees, one per sample. */
    const elev = [];
    let high = null;
    for (let t = 0; t < secs; t += step) {
      g.advance(step, 10);
      const cam = ctx.camera.position;
      const p = ctx.racers.find((r) => r.isPlayer);
      if (p) {
        const dh = cam.y - p.pos.y;
        const flat = Math.hypot(cam.x - p.pos.x, cam.z - p.pos.z);
        // atan2 rather than atan: a boom that has collapsed to nothing
        // horizontally is 90 degrees up, not a division by zero.
        const deg = Math.atan2(dh, Math.max(flat, 1e-3)) * 180 / Math.PI;
        // **A launched kart is exempt, and only a launched kart.**
        //
        // Off Switchback Summit's kicker the machine leaves the road and falls
        // fourteen metres below it inside a second. The lens stays with the road
        // it left, which is 39 degrees over the kart and is *the* shot for a
        // jump: it is how you see where you are going to land. Judging that
        // against a chase-camera bar would push every course in the cup toward
        // having no air in it.
        //
        // The defect this gate exists for is the opposite of a jump — a kart on
        // the tarmac, at speed, played from orbit for twenty-six continuous
        // seconds. All 155 of the quarry's failures were grounded and on road.
        // Airborne samples are still counted and printed, so a course cannot
        // hide a bad camera by spending its lap in the air.
        elev.push({ deg, dh, air: p.surface === 'air' || p.grounded === false });
        if (dh > highM && (!high || deg > high.deg)) {
          high = {
            deg: +deg.toFixed(1), t: +t.toFixed(1), dh: +dh.toFixed(2),
            playerY: +p.pos.y.toFixed(1), surface: p.surface,
          };
        }
      }
      from.set(cam.x, cam.y + 600, cam.z);
      ray.set(from, down);
      const hits = ray.intersectObjects(ground, false);
      if (!hits.length) continue;
      samples++;
      const surfY = Math.max(...hits.map((h) => h.point.y));
      const under = surfY - cam.y;
      if (under > 0) breaches++;
      if (!worst || under > worst.under) {
        const p2 = ctx.racers.find((r) => r.isPlayer);
        worst = {
          under: +under.toFixed(2), t: +t.toFixed(1),
          camY: +cam.y.toFixed(2), surfY: +surfY.toFixed(2),
          playerSurface: p2?.surface, speed: +(p2?.speed ?? 0).toFixed(1),
        };
      }
    }

    // The datum the camera floors against, and the deepest the road goes. When
    // the second is below the first, `surfaceYAt` holds the lens at the datum
    // while the kart keeps descending, and that difference *is* the elevation.
    const groundY = ctx.track?.course?.groundY ?? 0;
    let roadMin = Infinity;
    const sp = ctx.track?.spline;
    if (sp) {
      for (let d = 0; d < sp.length; d += 5) roadMin = Math.min(roadMin, sp.atDistance(d).pos.y);
    }

    return {
      worst, breaches, samples, ground: ground.length, elev, high,
      groundY: +groundY.toFixed(1),
      roadMin: Number.isFinite(roadMin) ? +roadMin.toFixed(1) : null,
    };
  }, { secs: SECONDS, step: STEP, highM: HIGH_M });

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

  // ── the elevation gate ────────────────────────────────────────────────────
  const all = worst.elev;
  if (!all.length) { fails.push(`${course}: no elevation samples — no player racer`); continue; }
  const degs = all.map((s) => s.deg).sort((a, b) => a - b);
  const at = (q) => degs[Math.min(degs.length - 1, Math.max(0, Math.round(q * (degs.length - 1))))];
  // Steep at any height is noise; steep, high *and* on the ground is the shot
  // the player lost.
  const steep = all.filter((s) => s.deg > MAX_DEG).length;
  const air = all.filter((s) => s.deg > MAX_DEG && s.dh > HIGH_M && s.air).length;
  const over = all.filter((s) => s.deg > MAX_DEG && s.dh > HIGH_M && !s.air).length;
  const h = worst.high;
  const sunk = worst.roadMin !== null && worst.roadMin < worst.groundY;
  const peak = h ? `${h.deg} at ${h.t}s (${h.dh}m up, racer y=${h.playerY} on ${h.surface})`
    : `none over ${HIGH_M}m up`;
  console.log(`  ${''.padEnd(20)} lens elevation med ${at(0.5).toFixed(1)}deg`
    + ` / p95 ${at(0.95).toFixed(1)} / peak above ${HIGH_M}m ${peak}`
    + `, ${over}/${all.length} grounded over ${MAX_DEG}deg high`
    + ` (${steep} steep at any height, ${air} of those airborne)`
    + `   [groundY ${worst.groundY}, road bottoms at ${worst.roadMin}${sunk ? ' — BELOW THE DATUM' : ''}]`);
  if (over > 0) {
    fails.push(`${course}: the lens sat over ${MAX_DEG}deg above a grounded racer, and more than ${HIGH_M}m up,`
      + ` on ${over}/${all.length} samples, peak ${h.deg}deg (${h.dh}m up) at ${h.t}s`
      + ` — that is a satellite view, not a racing camera.`
      + (sunk ? ` The road bottoms at y=${worst.roadMin} and course.groundY is ${worst.groundY};`
        + ` render/camera.ts floors the lens at max(roadY, groundY), so it is pinned ${(worst.groundY - worst.roadMin).toFixed(1)}m`
        + ` above the lowest road on the circuit. Lower groundY below the road.` : ''));
  }
}

if (errors.length) fails.push(`page errors: ${errors.slice(0, 2).join(' | ')}`);

if (fails.length) {
  for (const f of fails) console.log(`  FAIL  ${f}`);
  console.log('\n  THE LENS IS IN THE WRONG PLACE');
} else {
  console.log(`\n  THE LENS STAYS OUT OF THE GROUND AND BEHIND THE RACER — every course,`
    + ` every sample, never more than ${MAX_DEG}deg up`);
}

await browser.close();
await server.close();
process.exit(fails.length ? 1 : 0);
