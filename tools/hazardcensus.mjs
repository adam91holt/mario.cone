#!/usr/bin/env node
/**
 * hazardcensus.mjs — does the hazard ever actually touch anybody?
 *
 * ── why this tool exists ───────────────────────────────────────────────────
 *
 * A critic played the Hazard Cup and rejected it on one measurement: the four
 * signature hazards — THE ROCKFALL, THE SURGE, THE GATE, THE HAUL TRUCK — hit a
 * racer **five times in thirteen full races**. Every one of them was declared,
 * drawn, signed, cycled and documented at a 20-38% blocked window, and three of
 * the four had never touched anything at all.
 *
 * The reason a duty cycle could not have caught that is worth stating plainly:
 * **a duty cycle is a statement about time and says nothing about space.** A
 * body can be over the tarmac for 38% of every cycle and never come within nine
 * metres of the line anybody drives, because every `lateral` in the cup was
 * authored as an offset off the road *centre*, and the centre of a corner is the
 * one place on it that nobody is.
 *
 * So this tool measures both halves at once, over whole races:
 *
 *   * **the count** — `kart:hit` minus `item:strike`. Both `hazards.ts` and
 *     `items/index.ts` route through `stunRacer`, which emits `kart:hit`, and
 *     only items also emit `item:strike`. The difference is the hazard-hit
 *     count and it is the number the roster is judged on. It is cross-checked
 *     against `__HAZARDS.census()`'s own per-hazard tally, and the two
 *     disagreeing is itself a finding.
 *   * **the geometry** — for every hazard, the histogram of every racer's
 *     `lateral` (the same dot product `track.sample()` returns) at the instant
 *     it crossed that hazard's station, against the lateral interval the
 *     hazard's bodies actually sweep while live, kart radius included.
 *
 * `lane` and `reach` overlapping is the whole question. If `lane` is [-11,-3]
 * and `reach` is [+11,+20], the hazard is furniture with a clock in it.
 *
 * Usage
 *   node tools/hazardcensus.mjs
 *   node tools/hazardcensus.mjs --seeds 1,2,7,13
 *   node tools/hazardcensus.mjs --courses switchback-summit --bins
 *   node tools/hazardcensus.mjs --seconds 200
 *   node tools/hazardcensus.mjs --profile --courses cone-canyon
 *
 * `--profile` is the other half, and it is what a hazard should be *placed*
 * from rather than checked against afterwards: it samples every racer's
 * `track.sample().lateral` over a whole race and prints the driven line, in
 * metres off the centreline, at a hundred stations round the lap. Pick the lap
 * fraction, read p05/median/p95 off the profile, and put the body there.
 *
 * Reading it: the pass mark is **8-20 hazard hits per race on every course**.
 * Under 8 and the hazard is not in the way; over 20 and it has stopped being a
 * hazard and started being a wall. The field must also still finish on the lead
 * lap or one off it — a course the AI cannot get round is not a course.
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const ROOT = path.resolve(import.meta.dirname, '..');

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const flag = (n) => argv.includes(`--${n}`);

const COURSES = opt('courses', 'cone-canyon,jackhammer-quarry,saltpan-bypass,switchback-summit').split(',');
const SEEDS = opt('seeds', '1').split(',').map(Number);
const MAX_SECONDS = Number(opt('seconds', '260'));
const SHOW_BINS = flag('bins');
const PROFILE = flag('profile');

const PASS_LO = 8;
const PASS_HI = 20;

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { include: ['three'] },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/index.html`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage',
  ],
});
const rows = [];

let page = await newPage();

async function newPage() {
  const p = await browser.newPage({ viewport: { width: 320, height: 180 } });
  p.on('pageerror', (e) => console.error('  pageerror:', e.message));
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await p.waitForFunction(() => window.__GAME?.ready === true, null, { timeout: 180_000 });
  return p;
}

for (const courseId of COURSES) {
  for (const seed of SEEDS) {
    // A whole race under software GL is long enough that the renderer process
    // occasionally goes away mid-evaluate. That is a property of the bench, not
    // of the game, so the run recovers from it rather than losing the report.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.evaluate(() => window.__GAME.ready);
        break;
      } catch {
        try { await page.close(); } catch { /* already gone */ }
        page = await newPage();
      }
    }
    await page.evaluate(async ([c, s]) => {
      await window.__GAME.reset({ courseId: c, vehicleId: 'cone', seed: s, instant: true });
      window.__GAME.setAutopilot(true);
    }, [courseId, seed]);

    // The whole race runs inside one `page.evaluate`: the bus is synchronous
    // and in-page, so a Node round trip per event would be both slower and
    // lossy. Nothing here touches the wall clock.
    const r = await page.evaluate(async ({ maxSeconds, wantProfile }) => {
      const G = window.__GAME;
      const bus = window.__CTX.bus;
      const DT = 1 / 120;

      let kartHit = 0;
      let itemStrike = 0;
      const offHit = bus.on('kart:hit', () => { kartHit++; });
      const offStrike = bus.on('item:strike', () => { itemStrike++; });

      // Race to the flag. `finished` racers stop being interesting, so the
      // loop ends when the whole field is home or the cap is reached.
      let t = 0;
      const done = () => {
        const snap = G.snapshot();
        return snap.race.phase === 'results'
          || snap.racers.every((x) => x.progress >= 0 && x.lap > snap.race.totalLaps);
      };
      // The driven-line profile: every racer's lateral, binned by lap
      // fraction. Sampled through `track.sample()` — the same call, the same
      // `right` vector and the same dot product a hazard's own frame uses — so
      // a station read off this profile and a body placed at that lateral are
      // quoted in one set of units.
      const BINS = 100;
      const LATS = 96;   // 0.5m lateral bins over ±24m
      const prof = wantProfile
        ? Array.from({ length: BINS }, () => new Int32Array(LATS))
        : null;
      const track = window.__CTX.track;
      const startD = track.course.startDistance ?? 0;
      const L = track.spline.length;
      const scratch = track.spline.atDistance(0);
      const sampleProfile = () => {
        for (const racer of window.__CTX.racers) {
          const s = track.sample(racer.pos, scratch);
          const frac = (((s.distance - startD) / L) % 1 + 1) % 1;
          const bi = Math.min(BINS - 1, Math.floor(frac * BINS));
          const li = Math.floor((s.lateral + 24) * 2);
          if (li >= 0 && li < LATS) prof[bi][li]++;
        }
      };

      let guard = 0;
      while (t < maxSeconds && guard < 400) {
        for (let i = 0; i < 60; i++) {
          G.step(DT * 10); // 0.5s of sim per inner step
          if (prof) sampleProfile();
        }
        t += 5;
        guard++;
        if (done()) break;
      }

      offHit(); offStrike();

      const snap = G.snapshot();
      const laps = snap.racers.map((x) => x.lap);
      return {
        track: snap.track,
        seconds: Math.round(t),
        totalLaps: snap.race.totalLaps,
        phase: snap.race.phase,
        kartHit,
        itemStrike,
        laps,
        lapSpread: Math.max(...laps) - Math.min(...laps),
        hazards: window.__HAZARDS ? window.__HAZARDS.census() : [],
        duty: window.__HAZARDS ? window.__HAZARDS.duty() : [],
        profile: prof
          ? prof.map((bin) => {
            let n = 0;
            for (const v of bin) n += v;
            const pct = (q) => {
              let acc = 0;
              for (let i = 0; i < LATS; i++) {
                acc += bin[i];
                if (acc >= n * q) return (i / 2) - 24 + 0.25;
              }
              return NaN;
            };
            return n ? [pct(0.05), pct(0.5), pct(0.95), n] : null;
          })
          : null,
        halfAt: prof
          ? Array.from({ length: BINS }, (_, i) => {
            const s = track.spline.atDistance((startD + (i + 0.5) / BINS * L) % L, scratch);
            return Math.round(s.width * 0.5 * 10) / 10;
          })
          : null,
        errors: G.errors.slice(0, 4),
      };
    }, { maxSeconds: MAX_SECONDS, wantProfile: PROFILE });

    const hazardHits = r.kartHit - r.itemStrike;
    const tallied = r.hazards.reduce((a, h) => a + h.hits, 0);
    rows.push({
      course: r.track.name, seed, hazardHits, tallied,
      kartHit: r.kartHit, itemStrike: r.itemStrike, lapSpread: r.lapSpread,
    });

    console.log(`\n══ ${r.track.name}  seed ${seed}  (${r.seconds}s, ${r.totalLaps} laps, field ${r.laps.join('/')}) ══`);
    console.log(`  kart:hit ${r.kartHit}   item:strike ${r.itemStrike}   ` +
      `HAZARD HITS ${hazardHits} ${hazardHits >= PASS_LO && hazardHits <= PASS_HI ? '✓' : '✗'}` +
      `   (per-hazard tally ${tallied}${tallied === hazardHits ? '' : ' ← DISAGREES'})`);
    if (r.lapSpread > 1) console.log(`  ✗ field strung out: lap spread ${r.lapSpread}`);
    if (r.errors.length) console.log('  errors:', r.errors);

    // `armed` / `covered` / `guarded` are the diagnosis, and they are three
    // different bugs. Few armed means the cycle is wrong; armed but not
    // covered means the lateral is wrong; covered but not hit means the racers
    // were arriving stunned, starred, cooling down or under the anti-pin floor,
    // which is the item system's traffic and not this hazard's fault.
    console.log('  kind      at      half  passes armed cover guard  hits   rate   lane p05/med/p95      body reach       live');
    for (const h of r.hazards) {
      const lane = h.lane.map((v) => (Number.isFinite(v) ? v.toFixed(1).padStart(6) : '   n/a')).join('');
      const reach = h.reach ? `[${h.reach[0].toFixed(1)},${h.reach[1].toFixed(1)}]` : 'never live';
      const overlap = h.reach && Number.isFinite(h.lane[1])
        && h.lane[0] < h.reach[1] && h.lane[2] > h.reach[0];
      console.log(`  ${h.kind.padEnd(9)} ${h.at.toFixed(3)}  ${String(h.half).padStart(4)} ` +
        `${String(h.passes).padStart(6)} ${String(h.armed).padStart(5)} ` +
        `${String(h.covered).padStart(5)} ${String(h.guarded).padStart(5)} ` +
        `${String(h.hits).padStart(5)} ` +
        `${(h.passes ? (h.hits / h.passes * 100).toFixed(0) + '%' : '   -').padStart(6)}  ` +
        `${lane}    ${reach.padEnd(16)} ${(h.liveDuty * 100).toFixed(0)}%` +
        `${overlap ? '' : '   ← NO OVERLAP'}`);
      if (SHOW_BINS && h.bins.length) {
        const max = Math.max(...h.bins.map((b) => b[1]));
        for (const [x, n] of h.bins) {
          const inBody = h.reach && x + 0.5 >= h.reach[0] && x + 0.5 <= h.reach[1];
          console.log(`      ${String(x).padStart(4)}m ${inBody ? '#' : ' '} ` +
            '█'.repeat(Math.max(1, Math.round(n / max * 40))) + ` ${n}`);
        }
      }
    }

    if (r.profile) {
      // The driven line round the whole lap. Read a station off the left
      // column, read where the field is off p05/med/p95, put the body there.
      console.log('\n  ── driven line (metres off centreline, + and - as `sample().lateral` reports them) ──');
      console.log('   lapfrac   half    p05    med    p95   n   -20      -10       0       +10      +20');
      for (let i = 0; i < r.profile.length; i++) {
        const p = r.profile[i];
        if (!p) continue;
        const [lo, med, hi, n] = p;
        // One character per metre from -24 to +24.
        const bar = Array.from({ length: 49 }, (_, k) => {
          const x = k - 24;
          if (Math.abs(x - med) < 0.5) return 'O';
          return x >= lo && x <= hi ? '=' : (Math.abs(x) <= r.halfAt[i] ? '.' : ' ');
        }).join('');
        console.log(`   ${(i / r.profile.length).toFixed(2)}    ${String(r.halfAt[i]).padStart(4)} ` +
          `${lo.toFixed(1).padStart(6)} ${med.toFixed(1).padStart(6)} ${hi.toFixed(1).padStart(6)} ` +
          `${String(n).padStart(4)}  ${bar}`);
      }
    }
  }
}

console.log('\n══ SUMMARY ══');
console.log('  course                 seed  kart:hit  item:strike  HAZARD  verdict');
let allPass = true;
for (const r of rows) {
  const ok = r.hazardHits >= PASS_LO && r.hazardHits <= PASS_HI;
  if (!ok) allPass = false;
  console.log(`  ${r.course.padEnd(22)} ${String(r.seed).padStart(4)} ` +
    `${String(r.kartHit).padStart(9)} ${String(r.itemStrike).padStart(12)} ` +
    `${String(r.hazardHits).padStart(7)}  ${ok ? 'PASS' : r.hazardHits < PASS_LO ? 'TOO FEW' : 'TOO MANY'}`);
}
console.log(`\n  ${allPass ? 'PASS' : 'FAIL'} — target ${PASS_LO}-${PASS_HI} hazard hits per race, every course, every seed.\n`);

await browser.close();
await server.close();
process.exit(allPass ? 0 : 1);
