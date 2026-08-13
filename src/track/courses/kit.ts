// What each circuit is *built out of* — the arrival structure over the line and
// the barrier down both edges of the road.
//
// ── the finding this answers ───────────────────────────────────────────────
//
// A critic played the cup after the four layouts were re-cut and scored it 7/10
// on a single sentence: *"the four circuits are now genuinely different shapes
// but they are still the same place."* The evidence was four screenshots taken
// from the grid — `cone-canyon-grid.png`, `jackhammer-quarry-grid.png`,
// `saltpan-bypass-grid.png`, `switchback-summit-grid.png` — which shared, to
// the pixel, the same yellow truss gantry, the same navy hazard-striped banner
// with gold type, the same five-bulb light rig, the same chequered strip, and
// the same orange-and-white striped panel barrier on grey drums for the entire
// lap. Only the terrain tint and the sky changed.
//
// That is not a decoration problem. **The barrier is the second-largest object
// in the frame after the tarmac**, it is on screen for every metre of every
// lap, and the arrival structure is what the player stares at for the whole
// countdown — the establishing shot of the course, held for four seconds while
// nothing else moves. Two objects, and they were constants.
//
// ── why this is a system and not a builder ─────────────────────────────────
//
// `track/gantry.ts`, `track/barriers.ts` and `track/road.ts` each build exactly
// one of their thing, unconditionally, and none of them belongs to this module.
// So the kit listens for `track:built`, hides the stock pieces the course has
// replaced, and stands its own where they were. That is precisely the
// intervention `render/ground.ts` already makes on the shoulder gravel —
// *"only the material's map is swapped… the smallest possible intervention that
// makes the shoulder answer to the course"* — and it carries the same promise:
// the moment `track/` grows a barrier vocabulary of its own, this file
// evaporates into a parameter.
//
// Nothing here touches the driving. The barrier is drawn where physics already
// stops a kart (`width/2 + verge - 0.8`), the road surface, its width, its
// kerb *geometry* and every collision line are road.ts's and stay road.ts's.
// A kit changes what the circuit is made of, never where it goes.
//
// ── the rules a kit is held to ─────────────────────────────────────────────
//
//   1. **Silhouette first.** The four barriers have four profiles, not four
//      palettes: a striped board on posts, a continuous concrete batter, a low
//      capped wall and a slatted timber fence you can see the landscape
//      through. Read as black shapes at a hundred metres they are still four
//      things.
//   2. **The road stays readable.** Nothing gets taller than the stock 1.5m
//      panel and nothing leans over the tarmac, because the barrier's real job
//      is to say where the road ends at 60 m/s.
//   3. **Everything the countdown needs comes with it.** An arrival piece that
//      replaces the gantry replaces its banner *and* its five-lamp board, off
//      `config.race.startLights` — the same table `race/stage.ts` draws the
//      screen board from. Two boards, one truth, and no course may ship a dead
//      signal over its own grid.
//   4. **Build cost only.** Every texture is drawn once and cached by key,
//      every repeated part is instanced, and `update()` does nothing but sway a
//      banner and toggle five lamp meshes. No allocation in any hot path.
//
// ── and one thing in here that is not a kit ────────────────────────────────
//
// `unfoldSkirt`, at the bottom. It is the fix for the chase camera driving
// underground — a player report, reproduced by `tools/underground.mjs` on two
// of these four circuits — and it is here because it is a defect in a landscape
// the courses in this directory are the ones to expose, and because
// `track/terrain.ts` is not this module's file. It runs on every course, kit or
// no kit, and it is a no-op on a circuit that does not fold back over itself.
// Its own comment says what it is, what it measured, and where it belongs.

import * as THREE from 'three';
import { MeshBuilder, fbm, noise2, smoothstep, surfacePoint, type Lane } from '../geom.ts';
import { makeCheckerTexture, makeKerbTexture, makePaintTexture } from '../textures.ts';
import { config } from '../../core/config.ts';
import { resolveTheme } from '../../render/theme.ts';
// Imported, never copied. See `buildTreeline` — a second conifer drawn in this
// directory would be two kinds of tree on one hillside.
import { pineStandGeo } from '../../world/landprops.ts';
import { LAND_PALETTES, type LandPalette } from '../../world/themes.ts';
import {
  features, type BarrierKind, type BenchRimDef, type ChapterDef,
  type EnclosureDef, type KitDef, type SkylineDef, type StackDef, type TreelineDef,
} from './types.ts';
import type { TrackSpline } from '../spline.ts';
import type {
  CourseDef, GameContext, GameSystem, SplineSample, Track,
} from '../../types.ts';

// ── texture bench ──────────────────────────────────────────────────────────
//
// Same three rules as `track/textures.ts`: drawn to a canvas at build time so
// the game ships no image files, tiled in **metres** rather than in road
// widths, and cached by key so that resetting the race a hundred times through
// the harness allocates one of each. Nothing here reads a clock or
// `Math.random`, so two boots of the same course are the same pixels.

const _cache = new Map<string, THREE.CanvasTexture>();

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas context unavailable');
  return [c, g];
}

/** Deterministic PRNG. The grain has to be byte-identical on every boot. */
function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tex(
  key: string, w: number, h: number,
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
  wrap: THREE.Wrapping = THREE.RepeatWrapping,
): THREE.CanvasTexture {
  const hit = _cache.get(key);
  if (hit) return hit;
  const [c, g] = canvas(w, h);
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = wrap;
  t.wrapT = wrap;
  t.anisotropy = 4;
  _cache.set(key, t);
  return t;
}

// ── the four barrier skins ─────────────────────────────────────────────────
//
// u runs **across the profile** — 0 at the toe on the road side, 1 at the back
// — and v runs along the track in metres, which is what keeps a stripe the same
// size on a 34-metre salt highway and a 12-metre quarry cut.

/** Concrete jersey: a battered grey face with black-and-yellow toe bands. */
function jerseyTexture(): THREE.CanvasTexture {
  return tex('kit:jersey', 128, 256, (g, W, H) => {
    const rnd = rand(0x51b7a3);
    // Base concrete, lighter along the top of the batter where rain washes it.
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#8E8A80');
    grad.addColorStop(0.34, '#C9C4B6');
    grad.addColorStop(0.62, '#DAD5C7');
    grad.addColorStop(1, '#9A958A');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    // Pour joints every 3m of v — the panels are cast, not extruded.
    for (let i = 0; i < 4; i++) {
      const y = (i + 0.5) * (H / 4);
      g.fillStyle = 'rgba(48,44,38,0.42)';
      g.fillRect(0, y, W, 2);
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(0, y + 2, W, 1);
    }
    // The toe band: hazard black and yellow on the lowest third of the face,
    // which is the part a wheel actually meets.
    g.save();
    g.beginPath(); g.rect(0, 0, W * 0.30, H); g.clip();
    g.fillStyle = '#F2B705';
    g.fillRect(0, 0, W * 0.30, H);
    g.fillStyle = '#22262E';
    const pitch = H / 6;
    for (let i = -1; i < 8; i++) {
      g.beginPath();
      g.moveTo(0, i * pitch);
      g.lineTo(0, i * pitch + pitch * 0.5);
      g.lineTo(W * 0.30, i * pitch + pitch * 0.5 - W * 0.30);
      g.lineTo(W * 0.30, i * pitch - W * 0.30);
      g.closePath();
      g.fill();
    }
    g.restore();
    // Rock dust down the whole face, heaviest at the toe.
    for (let i = 0; i < 420; i++) {
      const x = rnd() * W;
      const a = 0.05 + 0.16 * (1 - x / W);
      g.fillStyle = `rgba(120,114,100,${(rnd() * a).toFixed(3)})`;
      g.fillRect(x, rnd() * H, 1 + rnd() * 3, 1 + rnd() * 8);
    }
    // Scuffs where a kart has been along it.
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(30,28,26,${(0.05 + rnd() * 0.14).toFixed(3)})`;
      g.fillRect(rnd() * W * 0.5, rnd() * H, 2 + rnd() * 5, 3 + rnd() * 26);
    }
  });
}

/** Salt works: white render, blue capping, crust creeping up the foot. */
function seawallTexture(): THREE.CanvasTexture {
  return tex('kit:seawall', 128, 256, (g, W, H) => {
    const rnd = rand(0x2ad9f1);
    g.fillStyle = '#EFEDE4';
    g.fillRect(0, 0, W, H);
    // The blue capping owns the top band of the profile.
    const cap = g.createLinearGradient(W * 0.42, 0, W, 0);
    cap.addColorStop(0, '#2E6C9E');
    cap.addColorStop(0.45, '#3E82B8');
    cap.addColorStop(1, '#22557D');
    g.fillStyle = cap;
    g.fillRect(W * 0.42, 0, W * 0.58, H);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(W * 0.42, 0, 3, H);
    // Render courses. Wide, shallow, slightly uneven — a wall somebody built.
    for (let i = 0; i < 6; i++) {
      const y = (i + 0.5) * (H / 6);
      g.fillStyle = 'rgba(150,148,138,0.32)';
      g.fillRect(0, y, W * 0.42, 1.5);
    }
    // Crust: salt blooming out of the foot, which is where the pan wets it.
    for (let i = 0; i < 320; i++) {
      const x = rnd() * W * 0.34;
      g.fillStyle = `rgba(255,255,255,${(0.10 + rnd() * 0.55).toFixed(3)})`;
      g.beginPath();
      g.arc(x, rnd() * H, 1 + rnd() * 4.5, 0, Math.PI * 2);
      g.fill();
    }
    // Tide staining just above it, so the crust reads as deposited rather than
    // as noise.
    const stain = g.createLinearGradient(W * 0.24, 0, W * 0.42, 0);
    stain.addColorStop(0, 'rgba(150,140,110,0.30)');
    stain.addColorStop(1, 'rgba(150,140,110,0)');
    g.fillStyle = stain;
    g.fillRect(W * 0.24, 0, W * 0.18, H);
  });
}

/**
 * Timber snow fence: vertical slats with real gaps.
 *
 * The gaps are the whole point and they are **alpha**, not paint — a snow fence
 * you cannot see the mountain through is a painted wall. u runs up the fence
 * (0 at the foot, 1 at the cap) and v along the road, so a slat is a band in v
 * and the two rails are bands in u.
 */
function snowfenceTexture(): THREE.CanvasTexture {
  return tex('kit:snowfence', 64, 128, (g, W, H) => {
    const rnd = rand(0x7c31d5);
    g.clearRect(0, 0, W, H);
    // Four slats per 2m of road: a 31cm board on a 50cm pitch. The gap is what
    // makes it a snow fence rather than a hoarding, and the board is what makes
    // it read as one at a hundred metres — under about half and half it stops
    // being either.
    const SLATS = 4;
    for (let i = 0; i < SLATS; i++) {
      const y = i * (H / SLATS);
      const wSlat = (H / SLATS) * 0.62;
      const shade = 0.84 + 0.16 * rnd();
      const r = Math.round(0x9a * shade), gg = Math.round(0x6d * shade), b = Math.round(0x4a * shade);
      g.fillStyle = `rgb(${r},${gg},${b})`;
      g.fillRect(0, y, W, wSlat);
      // Weathered top edge and a dark grain line down each board.
      g.fillStyle = 'rgba(226,214,192,0.30)';
      g.fillRect(0, y, W, 1.5);
      g.fillStyle = 'rgba(24,16,10,0.35)';
      g.fillRect(0, y + wSlat - 1.5, W, 1.5);
      for (let k = 0; k < 5; k++) {
        g.fillStyle = `rgba(40,26,16,${(0.06 + rnd() * 0.12).toFixed(3)})`;
        g.fillRect(rnd() * W, y + 2, 1 + rnd() * 2, wSlat - 4);
      }
    }
    // Two horizontal rails, opaque all the way along, so the fence hangs
    // together instead of reading as loose sticks.
    for (const [u, h] of [[0.22, 5], [0.80, 5]] as const) {
      g.fillStyle = '#6B4A32';
      g.fillRect(u * W, 0, h, H);
      g.fillStyle = 'rgba(232,220,198,0.28)';
      g.fillRect(u * W, 0, 1.5, H);
    }
    // Snow packed along the foot of the fence.
    const snow = g.createLinearGradient(0, 0, W * 0.16, 0);
    snow.addColorStop(0, 'rgba(255,255,255,0.92)');
    snow.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = snow;
    g.fillRect(0, 0, W * 0.16, H);
  }, THREE.RepeatWrapping);
}

/**
 * The name banner.
 *
 * -- the round it stopped being a plate ------------------------------------
 *
 *   *"The start banners on rounds 2, 3 and 4 are plain untextured plates
 *   (grey/yellow, white, grey) against Cone Canyon's designed hazard-striped
 *   one."*
 *
 * Round one's banner is not this function -- it is `track/gantry.ts`'s, kept
 * deliberately as the reference the other three are read against -- so what
 * this had to do was stop being a rectangle with a word on it. Four things,
 * all of them paint, none of them a draw call:
 *
 *   * **ends.** A banner is bolted to a structure at both ends and the
 *     fixings are the loudest part of it: two hazard-striped end blocks in the
 *     livery's own colours, with the fastening line down the inside of each.
 *   * **light.** The field is lit from above, with the sky in the top eighth
 *     and its own shadow in the bottom sixth, so it reads as a sheet of
 *     something rather than as a fill.
 *   * **fixings.** A bolt line along both flanges. It is the detail that sets
 *     the *scale* of the object -- without it a banner is any size at all.
 *   * **the name.** Drawn with a bright top edge under it, because the one
 *     thing on this object that has to survive being photographed at four
 *     hundred metres through haze is the word.
 */
function bannerTexture(name: string, s: { field: string; ink: string; strip: string }): THREE.CanvasTexture {
  return tex(`kit:banner:${name}:${s.field}:${s.ink}:${s.strip}`, 1024, 128, (g, W, H) => {
    g.fillStyle = s.field;
    g.fillRect(0, 0, W, H);
    // Sheet light: sky in the top, its own shade in the bottom.
    const lit = g.createLinearGradient(0, 0, 0, H);
    lit.addColorStop(0, 'rgba(255,255,255,0.22)');
    lit.addColorStop(0.16, 'rgba(255,255,255,0.04)');
    lit.addColorStop(0.78, 'rgba(0,0,0,0.05)');
    lit.addColorStop(1, 'rgba(0,0,0,0.26)');
    g.fillStyle = lit;
    g.fillRect(0, 0, W, H);
    // Flanges top and bottom, in the livery's strip colour.
    g.fillStyle = s.strip;
    g.fillRect(0, 0, W, 11);
    g.fillRect(0, H - 11, W, 11);
    g.fillStyle = 'rgba(0,0,0,0.20)';
    g.fillRect(0, 11, W, 4);
    g.fillRect(0, H - 15, W, 4);

    // The end blocks.
    const END = W * 0.115;
    for (const side of [0, 1]) {
      const x0 = side ? W - END : 0;
      g.save();
      g.beginPath();
      g.rect(x0, 0, END, H);
      g.clip();
      g.fillStyle = s.strip;
      g.fillRect(x0, 0, END, H);
      // Hazard chevrons, leaning away from the middle of the banner.
      g.fillStyle = 'rgba(24,26,32,0.86)';
      const dir = side ? -1 : 1;
      for (let i = -2; i < 8; i++) {
        const x = x0 + i * 34;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x + 16, 0);
        g.lineTo(x + 16 + dir * H, H);
        g.lineTo(x + dir * H, H);
        g.closePath();
        g.fill();
      }
      g.restore();
      // The fastening line down the inside edge of the block.
      g.fillStyle = 'rgba(0,0,0,0.34)';
      g.fillRect(side ? W - END - 3 : END, 0, 3, H);
      g.fillStyle = 'rgba(255,255,255,0.20)';
      g.fillRect(side ? W - END : END - 2, 0, 2, H);
    }

    // Bolts along both flanges, and only across the field: an end block is a
    // plate over the fixing, not another thing bolted through it.
    for (let x = END + 26; x < W - END - 20; x += 52) {
      for (const y of [19, H - 19]) {
        g.fillStyle = 'rgba(0,0,0,0.34)';
        g.beginPath(); g.arc(x, y + 1, 4, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.30)';
        g.beginPath(); g.arc(x, y, 3.2, 0, Math.PI * 2); g.fill();
      }
    }

    g.font = '900 62px "Trebuchet MS", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.46)';
    g.fillText(name.toUpperCase(), W / 2 + 3, H / 2 + 5);
    // A hairline of the strip colour along the top of the letters, which is
    // what stops the word going soft against the field at distance.
    g.fillStyle = s.strip;
    g.fillText(name.toUpperCase(), W / 2, H / 2 - 2.5);
    g.fillStyle = s.ink;
    g.fillText(name.toUpperCase(), W / 2, H / 2);
  }, THREE.ClampToEdgeWrapping);
}

/**
 * The housing five lamps sit proud of. Painted; the lit lenses are meshes.
 *
 * ── an unlit lamp is still a lamp ──────────────────────────────────────────
 *
 * *"All four five-lamp boards render as unlit grey circles."* Correct, and
 * that is what they were: a black disc with a grey ring on it. But the five
 * seconds this board is lit are five seconds of a three-minute race, and every
 * other frame in the review sheet photographs it *off* — so the off state is
 * the state this object is actually judged in, and it was drawn as an absence.
 *
 * A signal lens that is not lit is not grey. It is deep, saturated glass with
 * the sky in the top of it and its own filament shadow in the bottom, sitting
 * in a chrome bezel with a hood over it. All of that is paint on this canvas
 * and none of it costs a draw call, and it is the difference between a board
 * that is off and a board that is broken.
 */
function lampBoardTexture(steel: number): THREE.CanvasTexture {
  const hex = `#${steel.toString(16).padStart(6, '0')}`;
  return tex(`kit:board:${hex}`, 320, 80, (g, W, H) => {
    const body = g.createLinearGradient(0, 0, 0, H);
    body.addColorStop(0, '#2A2F3A');
    body.addColorStop(0.5, '#171A21');
    body.addColorStop(1, '#0E1015');
    g.fillStyle = body;
    g.fillRect(0, 0, W, H);
    g.fillStyle = hex;
    g.fillRect(0, 0, W, 7);
    g.fillRect(0, H - 7, W, 7);
    for (let i = 0; i < 5; i++) {
      const x = (i + 0.5) * (W / 5);
      // Bezel: a bright ring with a dark inner shoulder, so the lens sits in
      // something rather than on it.
      g.fillStyle = '#C2C9D4';
      g.beginPath(); g.arc(x, H / 2, 29, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#3A414C';
      g.beginPath(); g.arc(x, H / 2, 26, 0, Math.PI * 2); g.fill();
      // The glass. Dark red, not grey — a cold signal lens is still red.
      const lens = g.createRadialGradient(x - 8, H / 2 - 9, 2, x, H / 2, 24);
      lens.addColorStop(0, '#8E2318');
      lens.addColorStop(0.55, '#511209');
      lens.addColorStop(1, '#230703');
      g.fillStyle = lens;
      g.beginPath(); g.arc(x, H / 2, 23, 0, Math.PI * 2); g.fill();
      // Fresnel rings across the glass, and the sky caught in the top of it.
      g.strokeStyle = 'rgba(255,190,170,0.13)';
      g.lineWidth = 2;
      for (let r = 7; r < 23; r += 5) {
        g.beginPath(); g.arc(x, H / 2, r, 0, Math.PI * 2); g.stroke();
      }
      g.fillStyle = 'rgba(226,240,255,0.34)';
      g.beginPath();
      g.ellipse(x - 7, H / 2 - 10, 9, 5, -0.5, 0, Math.PI * 2);
      g.fill();
      // The hood, which is what makes a signal readable in the sun and what
      // makes it read as a signal at a hundred metres.
      g.fillStyle = 'rgba(10,12,16,0.72)';
      g.beginPath();
      g.ellipse(x, H / 2 - 22, 31, 9, 0, Math.PI, Math.PI * 2);
      g.fill();
    }
  }, THREE.ClampToEdgeWrapping);
}

/**
 * The belt housing's skin: dark works grey with a hazard band along the bottom
 * edge and a rivet line every course.
 *
 * Tiled along the bridge rather than stretched over it — sixty-seven metres of
 * one unstretched decal is a pale slab, and a pale slab across the top of the
 * frame is what a monorail looks like.
 */
function conveyorSkin(): THREE.CanvasTexture {
  return tex('kit:conveyorSkin', 128, 128, (g, W, H) => {
    const rnd = rand(0x28ba61);
    const base = g.createLinearGradient(0, 0, 0, H);
    base.addColorStop(0, '#79848C');
    base.addColorStop(0.55, '#5C666D');
    base.addColorStop(1, '#454E55');
    g.fillStyle = base;
    g.fillRect(0, 0, W, H);
    // Hazard band along the lower edge — v = 0 is the bottom of the box.
    g.fillStyle = '#F2B705';
    g.fillRect(0, H * 0.70, W, H * 0.22);
    g.fillStyle = '#22262E';
    for (let i = -1; i < 6; i++) {
      g.beginPath();
      g.moveTo(i * (W / 4), H * 0.92);
      g.lineTo(i * (W / 4) + W / 8, H * 0.92);
      g.lineTo(i * (W / 4) + W / 8 + H * 0.22, H * 0.70);
      g.lineTo(i * (W / 4) + H * 0.22, H * 0.70);
      g.closePath();
      g.fill();
    }
    g.fillStyle = 'rgba(10,12,16,0.45)';
    g.fillRect(0, H * 0.92, W, H * 0.08);
    // Ribs and rivets.
    for (let i = 0; i < 4; i++) {
      const x = (i + 0.5) * (W / 4);
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(x, 0, 2, H * 0.70);
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(x + 2, 0, 2, H * 0.70);
    }
    for (let i = 0; i < 180; i++) {
      g.fillStyle = `rgba(150,144,130,${(rnd() * 0.16).toFixed(3)})`;
      g.fillRect(rnd() * W, rnd() * H * 0.7, 1 + rnd() * 5, 1 + rnd() * 2);
    }
  });
}

/** Galvanised plate, for jetty decks and pylon cross-arms. */
function plateTexture(key: string, base: string, dark: string): THREE.CanvasTexture {
  return tex(`kit:plate:${key}`, 128, 128, (g, W, H) => {
    const rnd = rand(0x3f9c22);
    g.fillStyle = base;
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(255,255,255,${(rnd() * 0.10).toFixed(3)})`;
      g.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 14, 1 + rnd() * 3);
    }
    for (let i = 0; i < 6; i++) {
      g.fillStyle = dark;
      g.fillRect(0, i * (H / 6), W, 1.5);
    }
  });
}

// ── the barrier ────────────────────────────────────────────────────────────

/**
 * Everything a barrier profile needs to know, resolved once.
 *
 * `edge(s)` is the line **physics enforces** — `width/2 + verge`. Every profile
 * below is quoted as an offset from it, so a kart pressed against the barrier
 * is resting on the thing it can see whatever the course's width does.
 */
interface BarrierCtx {
  spline: TrackSpline;
  verge: number;
  edge(s: SplineSample): number;
  root: THREE.Group;
  materials: THREE.Material[];
}

type Profile = Array<{ off: number; lift: number; u: number }>;

/** Sweep one profile down both sides of the circuit as a single mesh. */
function sweep(
  c: BarrierCtx, name: string, profile: Profile, mat: THREE.Material, vScale: number,
): void {
  const b = new MeshBuilder();
  for (const side of [-1, 1] as const) {
    const lanes: Lane[] = profile.map((p) => ({
      lat: (s: SplineSample) => side * (c.edge(s) + p.off),
      lift: () => p.lift,
      u: p.u,
    }));
    if (side < 0) lanes.reverse();
    b.addRibbon(c.spline, lanes, { verge: c.verge, step: 3, vScale, closed: true });
  }
  if (b.isEmpty) return;
  const mesh = new THREE.Mesh(b.toGeometry(), mat);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  c.root.add(mesh);
}

/**
 * Concrete jersey barrier — Jackhammer Quarry.
 *
 * The real profile, because the real profile is the recognisable thing: a
 * near-vertical 7cm toe, a 55° batter up to about knee height, then a steep
 * upper face to a flat 1.05m top. No posts, no rail, no gaps. A pit wall.
 */
function buildJersey(c: BarrierCtx): void {
  const mat = new THREE.MeshLambertMaterial({ map: jerseyTexture(), side: THREE.DoubleSide });
  c.materials.push(mat);
  sweep(c, 'kitJersey', [
    { off: 0.00, lift: -0.40, u: 0.00 },
    { off: 0.06, lift: 0.06, u: 0.06 },
    { off: 0.30, lift: 0.34, u: 0.30 },
    { off: 0.40, lift: 1.02, u: 0.66 },
    { off: 0.62, lift: 1.10, u: 0.80 },
    { off: 0.84, lift: 1.02, u: 0.90 },
    { off: 0.96, lift: -0.40, u: 1.00 },
  ], mat, 3.2);
}

/**
 * Salt-crusted low wall — Saltpan Bypass.
 *
 * 0.82m and no higher. A 1.5m panel run down 3.5km of lake bed fences in the
 * one view this circuit is built around, and the course already declares
 * `wallHeight: 1.1` for the same reason.
 */
function buildSeawall(c: BarrierCtx): void {
  const mat = new THREE.MeshLambertMaterial({ map: seawallTexture(), side: THREE.DoubleSide });
  c.materials.push(mat);
  sweep(c, 'kitSeawall', [
    { off: 0.00, lift: -0.40, u: 0.00 },
    { off: 0.10, lift: 0.10, u: 0.10 },
    { off: 0.20, lift: 0.74, u: 0.50 },
    { off: 0.28, lift: 0.82, u: 0.62 },
    { off: 0.60, lift: 0.82, u: 0.74 },
    { off: 0.68, lift: 0.72, u: 0.86 },
    { off: 0.78, lift: -0.40, u: 1.00 },
  ], mat, 2.6);
}

/**
 * Timber snow fence — Switchback Summit.
 *
 * Three pieces: a bank of packed snow along the foot, the slatted screen
 * standing on it (alpha-tested, so the mountain shows through the gaps), and a
 * raking post every four metres holding it up. The posts are one InstancedMesh.
 */
function buildSnowFence(c: BarrierCtx): void {
  const bankMat = new THREE.MeshLambertMaterial({ color: 0xdfe8ef });
  const fenceMat = new THREE.MeshLambertMaterial({
    map: snowfenceTexture(),
    side: THREE.DoubleSide,
    // 0.35, not 0.5. A 30cm board on a 50cm pitch mips down to roughly 60%
    // coverage, and a half-alpha cut erodes the fence away exactly where a
    // player is looking longest — down the road, at distance.
    alphaTest: 0.35,
    transparent: false,
  });
  c.materials.push(bankMat, fenceMat);

  sweep(c, 'kitSnowBank', [
    { off: 0.00, lift: -0.40, u: 0.00 },
    { off: 0.16, lift: 0.22, u: 0.30 },
    { off: 0.52, lift: 0.30, u: 0.60 },
    { off: 0.78, lift: -0.40, u: 1.00 },
  ], bankMat, 4);

  // The screen itself: a single vertical plane. u is height up the fence, so
  // the texture's rails and slats land where they were drawn.
  const screen = new MeshBuilder();
  for (const side of [-1, 1] as const) {
    const lanes: Lane[] = [
      { lat: (s) => side * (c.edge(s) + 0.34), lift: () => 0.10, u: 0 },
      { lat: (s) => side * (c.edge(s) + 0.30), lift: () => 1.68, u: 1 },
    ];
    if (side < 0) lanes.reverse();
    screen.addRibbon(c.spline, lanes, { verge: c.verge, step: 2, vScale: 2, closed: true });
  }
  const screenMesh = new THREE.Mesh(screen.toGeometry(), fenceMat);
  screenMesh.name = 'kitSnowFence';
  screenMesh.castShadow = true;
  c.root.add(screenMesh);

  // Raking posts. One box geometry, one draw call, both sides of the lap.
  const L = c.spline.length;
  const STEP = 4.5;
  const per = Math.max(4, Math.floor(L / STEP));
  const geo = new THREE.BoxGeometry(0.16, 1, 0.16);
  geo.translate(0, 0.5, 0);
  const postMat = new THREE.MeshLambertMaterial({ color: 0x5c4130 });
  c.materials.push(postMat);
  const posts = new THREE.InstancedMesh(geo, postMat, per * 2);
  posts.name = 'kitFencePosts';
  posts.castShadow = true;
  const s: SplineSample = c.spline.atDistance(0);
  const pos = new THREE.Vector3();
  const up = new THREE.Vector3();
  const right = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const scl = new THREE.Vector3();
  const lean = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  let n = 0;
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < per; i++) {
      c.spline.atDistance((i / per) * L, s);
      surfacePoint(s, side * (c.edge(s) + 0.52), c.verge, 0.18, pos);
      up.copy(s.up);
      right.copy(s.right);
      fwd.crossVectors(right, up).normalize();
      m.makeBasis(right, up, fwd);
      q.setFromRotationMatrix(m);
      // Rake the post back away from the road, which is how a snow fence
      // stands and what stops it reading as a row of railway sleepers.
      lean.setFromAxisAngle(fwd, side * 0.17);
      q.multiply(lean);
      scl.set(1, 2.02, 1);
      m.compose(pos, q, scl);
      posts.setMatrixAt(n++, m);
    }
  }
  posts.count = n;
  posts.instanceMatrix.needsUpdate = true;
  c.root.add(posts);
}

// ── the arrival structures ─────────────────────────────────────────────────

/**
 * Struts, collected so an entire lattice is one InstancedMesh.
 *
 * Lifted from `track/gantry.ts`, which is the right shape for the problem and
 * not exported. Two hundred members at two draw calls is what makes a lattice
 * affordable at all.
 */
class Struts {
  readonly list: THREE.Matrix4[] = [];
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private scl = new THREE.Vector3();

  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number): void {
    this.a.set(ax, ay, az);
    this.b.set(bx, by, bz);
    this.dir.subVectors(this.b, this.a);
    const len = this.dir.length();
    if (len < 1e-4) return;
    this.dir.divideScalar(len);
    this.q.setFromUnitVectors(UP, this.dir);
    this.scl.set(t, len, t);
    this.list.push(new THREE.Matrix4().compose(
      this.a.addScaledVector(this.dir, len * 0.5), this.q, this.scl,
    ));
  }

  mesh(color: number, name: string, materials: THREE.Material[]): THREE.InstancedMesh {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.4 });
    materials.push(mat);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, this.list.length);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (let i = 0; i < this.list.length; i++) mesh.setMatrixAt(i, this.list[i]!);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

const _shade = new THREE.Color();
/** Scratch for the second colour in a two-colour mix. See `talusTexture`. */
const _grey = new THREE.Color();
/** A darker mix of a kit colour, so one declared steel can carry two values. */
function shade(color: number, f: number): number {
  return _shade.setHex(color).multiplyScalar(f).getHex();
}

/** A square lattice tower from `y0` to `y1`, half-width `r`, centred at `cx`. */
function tower(st: Struts, cx: number, y0: number, y1: number, r: number, splay = 1.3): void {
  for (const ox of [-r, r]) {
    for (const oz of [-r, r]) {
      st.add(cx + ox * splay, y0, oz * splay, cx + ox, y1, oz, 0.22);
    }
  }
  for (let y = y0 + 0.6; y < y1; y += 1.8) {
    const f = 1 + (splay - 1) * Math.max(0, 1 - (y - y0) / (y1 - y0));
    st.add(cx - r * f, y, -r * f, cx + r * f, y, -r * f, 0.12);
    st.add(cx - r * f, y, r * f, cx + r * f, y, r * f, 0.12);
    st.add(cx - r * f, y, -r * f, cx - r * f, y, r * f, 0.12);
    st.add(cx + r * f, y, -r * f, cx + r * f, y, r * f, 0.12);
    const flip = Math.round((y - y0) / 1.8) % 2 === 0 ? 1 : -1;
    st.add(cx - r * f, y, flip * r * f, cx + r * f, y + 1.8, flip * r * f, 0.10);
    st.add(cx + r * f, y, -flip * r * f, cx - r * f, y + 1.8, -flip * r * f, 0.10);
  }
}

interface ArrivalParts {
  /** Sways every frame. A dead-still banner reads as a photograph. */
  banner: THREE.Object3D;
  /** The five lenses, hidden until the count arms. */
  lamps: THREE.Mesh[];
}

interface BuildArgs {
  group: THREE.Group;
  /** Half the road plus the shoulder plus clearance: where a leg may stand. */
  span: number;
  kit: KitDef;
  name: string;
  materials: THREE.Material[];
  /**
   * Build the structure and nothing else.
   *
   * The same four objects are stood over the start line *and*, since a critic
   * measured that a course's signature noun was four hundred metres behind the
   * camera by the time the review frame is taken, further round the lap. See
   * `CrossingDef`. What a crossing must not carry is the *signage*: one course
   * name and one set of start lights per circuit, on the line, or the lap has
   * two start lines in it.
   */
  bare?: boolean;
}

/** Height of the banner's hanging point. The same on every structure, so the
 *  signage rig is interchangeable and only the thing carrying it changes. */
const BANNER_Y = 9.2;

/**
 * Hang the name banner at `BANNER_Y`, on drop rods reaching up to whatever is
 * carrying it. The height is the same on all four structures on purpose: the
 * signage rig is interchangeable and only the thing over it changes.
 */
function addBanner(a: BuildArgs, width: number, carriedAt: number): THREE.Object3D {
  if (a.bare) return new THREE.Group();
  const style = a.kit.banner ?? { field: '#1B2A4A', ink: '#FFC300', strip: '#FF6B1A' };
  const map = bannerTexture(a.name, style);
  const mat = new THREE.MeshStandardMaterial({
    map,
    roughness: 0.78,
    side: THREE.DoubleSide,
    // **The name has to survive being lit from behind.**
    //
    // The grid shot stands the camera *under* the arrival structure looking up
    // the road, which is the side of the banner the sun is not on — and this is
    // a `DoubleSide` plane, so what a player sees on the establishing shot of
    // three of the four rounds is the back face, keyed by nothing but ambient.
    // A critic read Switchback Summit's plate as "grey type on a dark navy
    // plate, close to illegible", and the texture under it is #F2F7FB on
    // #123B52 — about as much contrast as two colours can carry. It was not the
    // livery, it was the light.
    //
    // The map doubles as its own emissive, so the *ink* carries a floor of its
    // own and the field does not: white text lifts, the navy plate stays navy,
    // and the contrast goes up rather than the whole sign going flat. A third
    // is a sign that is legible in shade, not a sign that glows.
    emissive: 0xffffff,
    emissiveMap: map,
    emissiveIntensity: 0.34,
  });
  a.materials.push(mat);

  if (carriedAt > BANNER_Y + 0.2) {
    const rodMat = new THREE.MeshStandardMaterial({ color: 0x333a44, roughness: 0.55, metalness: 0.4 });
    a.materials.push(rodMat);
    const h = carriedAt - BANNER_Y;
    const geo = new THREE.BoxGeometry(0.13, h, 0.13);
    geo.translate(0, h * 0.5, 0);
    for (const x of [-width * 0.42, width * 0.42]) {
      const rod = new THREE.Mesh(geo, rodMat);
      rod.position.set(x, BANNER_Y, 0);
      rod.castShadow = true;
      a.group.add(rod);
    }
  }

  const pivot = new THREE.Group();
  pivot.position.set(0, BANNER_Y, 0);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, 2.5), mat);
  mesh.position.y = -1.25;
  mesh.castShadow = true;
  pivot.add(mesh);
  a.group.add(pivot);
  return pivot;
}

function addLampBoard(a: BuildArgs, y: number): THREE.Mesh[] {
  if (a.bare) return [];
  const steel = a.kit.steel ?? 0xf0d64a;
  const boardMat = new THREE.MeshStandardMaterial({
    map: lampBoardTexture(steel), roughness: 0.5, side: THREE.DoubleSide,
  });
  a.materials.push(boardMat);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.6), boardMat);
  board.position.set(0, y, 0.12);
  board.castShadow = true;
  a.group.add(board);

  // Two hangers, so the board is bolted to something.
  const hangMat = new THREE.MeshStandardMaterial({ color: 0x30363f, roughness: 0.6 });
  a.materials.push(hangMat);
  for (const side of [-1, 1]) {
    const hang = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.0, 0.12), hangMat);
    hang.position.set(side * 2.6, y + 1.8, 0.12);
    a.group.add(hang);
  }

  // The lenses. Unlit on purpose — a bulb is a light source, not a surface.
  const geo = new THREE.CircleGeometry(0.44, 14);
  const red = new THREE.MeshBasicMaterial({ color: 0xff2a16, toneMapped: false });
  a.materials.push(red);
  const lamps: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(geo, red);
    m.position.set((i + 0.5) * (6.4 / 5) - 3.2, 0, 0.04);
    m.visible = false;
    m.frustumCulled = false;
    board.add(m);
    lamps.push(m);
  }
  return lamps;
}

/**
 * **The quarry conveyor.** An inclined overland belt crossing the haul road on
 * two steel trestles, running shot rock from the crusher out to the stockpile.
 *
 * The belt is what makes it read: it climbs across the frame instead of
 * spanning it level, so the structure has a direction and the grid is standing
 * *under* something that is working rather than beside a decoration.
 */
function buildConveyor(a: BuildArgs): ArrivalParts {
  const steel = a.kit.steel ?? 0x7f8a92;
  const accent = a.kit.accent ?? 0xf2b705;
  const span = a.span;
  const st = new Struts();
  // Trestles. The far one stands five metres taller, because the belt is
  // climbing — the whole silhouette is a diagonal and that is the point.
  const LOW = 11.0, HIGH = 16.4;
  tower(st, -span, -3, LOW, 1.15);
  tower(st, span, -3, HIGH, 1.15);
  // The hanger beam the signage rig swings from, slung under the bridge on two
  // short rods. A banner hung off nothing is the tell that a structure was
  // designed round a fitting rather than the other way about.
  if (!a.bare) {
    st.add(-13, BANNER_Y + 1.4, 0, 13, BANNER_Y + 1.4, 0, 0.28);
    st.add(-10, BANNER_Y + 1.4, 0, -10, 11.3, 0, 0.15);
    st.add(10, BANNER_Y + 1.4, 0, 10, 13.5, 0, 0.15);
  }
  a.group.add(st.mesh(steel, 'kitConveyorTrestle', a.materials));

  // The belt housing: a long box, rolled about z so it climbs left to right.
  const run = span * 2 + 26;
  const angle = Math.atan2(HIGH - LOW, span * 2);
  const belt = new THREE.Group();
  belt.position.set(0, (LOW + HIGH) * 0.5, 0);
  belt.rotation.z = angle;

  const skin = conveyorSkin();
  skin.repeat.set(run / 6, 1);
  const hoodMat = new THREE.MeshStandardMaterial({ map: skin, roughness: 0.62, metalness: 0.25 });
  a.materials.push(hoodMat);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(run, 1.7, 2.9), hoodMat);
  housing.castShadow = true;
  housing.receiveShadow = true;
  belt.add(housing);

  // A rounded hood on top — the silhouette people recognise a conveyor by.
  // Matte and darker than the frame: a polished half-cylinder sixty metres long
  // catches the whole sky and photographs as a white slab across the top of the
  // frame, which is what a monorail looks like.
  const capMat = new THREE.MeshStandardMaterial({
    color: shade(steel, 0.72), roughness: 0.78, metalness: 0.12,
  });
  a.materials.push(capMat);
  // A full barrel rather than a half shell. A half-cylinder has to be aimed —
  // `thetaLength` selects an arc, the arc rotates with the group, and a hood
  // that ends up on the *underside* leaves the flat top of the housing facing
  // the sky, which is exactly the pale slab this was drawn to get rid of.
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, run, 14), capMat);
  cap.rotation.z = Math.PI * 0.5;
  cap.position.y = 0.62;
  cap.castShadow = true;
  belt.add(cap);

  // Toe boards and a walkway handrail down the near side, in high-vis.
  const railMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5 });
  a.materials.push(railMat);
  for (const y of [-0.72, 0.55, 1.15]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(run, 0.13, 0.13), railMat);
    rail.position.set(0, y, -1.75);
    rail.castShadow = true;
    belt.add(rail);
  }
  const stanchion = new THREE.BoxGeometry(0.11, 1.7, 0.11);
  const stan = new THREE.InstancedMesh(stanchion, railMat, 18);
  stan.name = 'kitConveyorRail';
  stan.castShadow = true;
  const m = new THREE.Matrix4();
  for (let i = 0; i < 18; i++) {
    m.makeTranslation(-run * 0.5 + (i + 0.5) * (run / 18), 0.25, -1.75);
    stan.setMatrixAt(i, m);
  }
  stan.instanceMatrix.needsUpdate = true;
  belt.add(stan);

  // The stringer truss under the belt. Forty metres of unsupported housing
  // reads as a floating box; a Warren web under it reads as a bridge.
  const web = new Struts();
  const bays = Math.max(8, Math.round(run / 4.2));
  for (let i = 0; i < bays; i++) {
    const x0 = -run * 0.5 + i * (run / bays);
    const x1 = x0 + run / bays;
    for (const dz of [-1.3, 1.3]) {
      web.add(x0, -1.6, dz, x1, -1.6, dz, 0.16);
      web.add(x0, -0.85, dz, x0, -1.6, dz, 0.12);
      web.add(x0, -0.85, dz, x1, -1.6, dz, 0.10);
    }
    if (i % 2 === 0) web.add(x0, -1.6, -1.3, x0, -1.6, 1.3, 0.10);
  }
  belt.add(web.mesh(steel, 'kitConveyorWeb', a.materials));
  a.group.add(belt);

  // The head chute, dropping fines off the high end onto a cone of stockpile
  // outside the barrier. This is what tells you which way the belt runs.
  const chuteMat = new THREE.MeshStandardMaterial({ color: 0x5d666e, roughness: 0.7 });
  a.materials.push(chuteMat);
  const chute = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 2.0, 10, 8), chuteMat);
  chute.position.set(span + 12, 12.6, 0);
  chute.castShadow = true;
  a.group.add(chute);
  const pileMat = new THREE.MeshLambertMaterial({ color: 0xa9a396 });
  a.materials.push(pileMat);
  const pile = new THREE.Mesh(new THREE.ConeGeometry(9, 11, 14), pileMat);
  pile.position.set(span + 12, 2.6, 0);
  pile.castShadow = true;
  pile.receiveShadow = true;
  a.group.add(pile);

  // Operator cabin bolted to the near trestle.
  const cabMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.55 });
  a.materials.push(cabMat);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.4, 2.4), cabMat);
  cab.position.set(-span - 2.1, 5.6, 0);
  cab.castShadow = true;
  a.group.add(cab);
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x1d2a33, roughness: 0.2, metalness: 0.5 });
  a.materials.push(glassMat);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(2.66, 1.1, 1.9), glassMat);
  glass.position.set(-span - 2.1, 6.2, 0);
  a.group.add(glass);

  return {
    banner: addBanner(a, Math.min(span * 2 - 2, 26), BANNER_Y + 1.4),
    lamps: addLampBoard(a, BANNER_Y - 3.4),
  };
}

/**
 * **The salt-loading jetty.** A timber-piled deck crossing the bypass, with two
 * loading chutes hanging over the road and a heap of raw salt on the deck.
 *
 * It is horizontal where the conveyor climbs and pale where the conveyor is
 * grey, and it stands on piles rather than lattice — three different words for
 * "the thing over the start line".
 */
function buildJetty(a: BuildArgs): ArrivalParts {
  const steel = a.kit.steel ?? 0x2e6c9e;
  const accent = a.kit.accent ?? 0xffffff;
  const span = a.span;

  const timber = plateTexture('jettyTimber', '#D8D0BC', 'rgba(120,108,86,0.45)');
  const timberMat = new THREE.MeshStandardMaterial({ map: timber, roughness: 0.85 });
  a.materials.push(timberMat);

  // Piles: three per side, cross-braced, standing in salt.
  const pileGeo = new THREE.CylinderGeometry(0.46, 0.54, 13.6, 8);
  const piles = new THREE.InstancedMesh(pileGeo, timberMat, 6);
  piles.name = 'kitJettyPiles';
  piles.castShadow = true;
  piles.receiveShadow = true;
  const m = new THREE.Matrix4();
  let n = 0;
  for (const side of [-1, 1]) {
    for (const dz of [-3.2, 0, 3.2]) {
      m.makeTranslation(side * span, 3.4, dz);
      piles.setMatrixAt(n++, m);
    }
  }
  piles.instanceMatrix.needsUpdate = true;
  a.group.add(piles);

  const brace = new Struts();
  for (const side of [-1, 1]) {
    brace.add(side * span, 1.2, -3.2, side * span, 9.6, 3.2, 0.16);
    brace.add(side * span, 1.2, 3.2, side * span, 9.6, -3.2, 0.16);
    brace.add(side * span - 1.4, 9.8, 0, side * span + 1.4, 9.8, 0, 0.2);
  }
  // The span itself, and it is a **through** truss — the web stands on top of
  // the deck rather than under it. Nothing may stand between the pile lines,
  // because that is the road, so sixty metres has to be carried rather than
  // propped; and putting the steel above the deck leaves the underside clean
  // for the banner and the loading chutes instead of fighting them for the one
  // band of air the driver looks through.
  {
    const bays = Math.max(10, Math.round((span * 2) / 5.5));
    for (let i = 0; i <= bays; i++) {
      const x0 = -span + i * ((span * 2) / bays);
      const x1 = x0 + (span * 2) / bays;
      for (const dz of [-3.2, 3.2]) {
        if (i < bays) {
          brace.add(x0, 10.7, dz, x1, 10.7, dz, 0.20);
          brace.add(x0, 13.5, dz, x1, 13.5, dz, 0.20);
          brace.add(x0, 10.7, dz, x1, 13.5, dz, 0.12);
        }
        brace.add(x0, 10.7, dz, x0, 13.5, dz, 0.14);
      }
      if (i % 2 === 0) brace.add(x0, 13.5, -3.2, x0, 13.5, 3.2, 0.12);
    }
  }
  a.group.add(brace.mesh(steel, 'kitJettyBrace', a.materials));

  // The deck.
  const deckW = span * 2 + 9;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(deckW, 0.55, 7.2), timberMat);
  deck.position.set(0, 10.35, 0);
  deck.castShadow = true;
  deck.receiveShadow = true;
  a.group.add(deck);

  // A windrow of raw salt heaped down the middle of the deck, between the two
  // truss walls: the jetty has cargo on it, so it is a working jetty and not a
  // footbridge with a name on it.
  const saltMat = new THREE.MeshLambertMaterial({ color: 0xf6f4ec });
  a.materials.push(saltMat);
  const heap = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 1.6, deckW * 0.66, 10), saltMat);
  heap.rotation.z = Math.PI * 0.5;
  heap.position.set(0, 11.4, 0);
  heap.castShadow = true;
  a.group.add(heap);

  // Two loading chutes hanging off the deck ends, each with a dribble of salt
  // caught in mid-fall and a cone of it built up underneath. This is the one
  // thing on this circuit that reads as *vertical* on a lake bed where nothing
  // else does, and it is what makes the deck a working jetty rather than a
  // footbridge with a name on it.
  //
  // **Outside the barrier line, and that is a rule rather than a composition
  // choice.** What comes out of a chute lands, and a three-metre heap of salt
  // standing on twelve metres of drivable crust is an obstacle the course never
  // declared and physics has never heard of. Everything the world module places
  // starts outside the barrier footing for the same reason; so does this.
  const chuteMat = new THREE.MeshStandardMaterial({ color: steel, roughness: 0.5, metalness: 0.3 });
  a.materials.push(chuteMat);
  for (const sx of [-1.12, 1.12]) {
    const chute = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 0.75, 3.4, 10), chuteMat);
    chute.position.set(sx * span, 8.3, 0);
    chute.castShadow = true;
    a.group.add(chute);
    const fall = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.72, 2.6, 8), saltMat);
    fall.position.set(sx * span, 5.6, 0);
    a.group.add(fall);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(3.4, 3.6, 12), saltMat);
    cone.position.set(sx * span, 1.6, 0);
    cone.castShadow = true;
    cone.receiveShadow = true;
    a.group.add(cone);
  }

  // The works plate on the deck fascia, white on works blue.
  const fasciaMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.7 });
  a.materials.push(fasciaMat);
  const fascia = new THREE.Mesh(new THREE.BoxGeometry(deckW, 0.85, 0.2), fasciaMat);
  fascia.position.set(0, 9.9, 3.7);
  a.group.add(fascia);

  return {
    banner: addBanner(a, Math.min(span * 2 - 2, 30), 10.05),
    lamps: addLampBoard(a, BANNER_Y - 3.4),
  };
}

/**
 * **The cable-car pylon pair.** A tall galvanised lattice mast on one side of
 * the road and a shorter one on the other, a pair of cables slung between them
 * with two gondolas hanging on the span, and a portal beam under the cables
 * carrying the name and the lights.
 *
 * The gondolas are the point. They are the only part of any arrival structure
 * that is *above* the frame line, so the mountain's start is the only one where
 * a player looks up.
 */
function buildPylon(a: BuildArgs): ArrivalParts {
  const steel = a.kit.steel ?? 0xb7c0c9;
  const accent = a.kit.accent ?? 0xe04a2b;
  const span = a.span;
  const TALL = 23.5, SHORT = 16.5;

  const st = new Struts();
  tower(st, -span, -3, TALL, 1.5, 1.6);
  tower(st, span, -3, SHORT, 1.3, 1.5);
  // Cross-arms at the head of each mast.
  for (const [cx, h, w] of [[-span, TALL, 3.6], [span, SHORT, 3.2]] as const) {
    st.add(cx - w, h, 0, cx + w, h, 0, 0.26);
    st.add(cx - w, h, 0, cx, h - 2.4, 0, 0.16);
    st.add(cx + w, h, 0, cx, h - 2.4, 0, 0.16);
  }
  // The portal beam the signage hangs off, plus its knee braces.
  st.add(-span, BANNER_Y + 1.5, 0, span, BANNER_Y + 1.5, 0, 0.30);
  st.add(-span + 0.6, BANNER_Y + 1.5, 0, -span + 0.6, BANNER_Y + 4.2, 0, 0.14);
  st.add(span - 0.6, BANNER_Y + 1.5, 0, span - 0.6, BANNER_Y + 4.2, 0, 0.14);
  st.add(-span, BANNER_Y + 4.2, 0, -span + 3.4, BANNER_Y + 1.5, 0, 0.13);
  st.add(span, BANNER_Y + 4.2, 0, span - 3.4, BANNER_Y + 1.5, 0, 0.13);

  // The two cables. Straight members chained through a shallow sag, because a
  // dead-straight cable over a valley reads as a scaffold pole.
  const SEGS = 14;
  for (const dz of [-2.6, 2.6]) {
    for (let i = 0; i < SEGS; i++) {
      const t0 = i / SEGS, t1 = (i + 1) / SEGS;
      const yOf = (t: number): number =>
        TALL + (SHORT - TALL) * t - 2.6 * Math.sin(Math.PI * t);
      st.add(-span + t0 * span * 2, yOf(t0), dz, -span + t1 * span * 2, yOf(t1), dz, 0.11);
    }
  }
  a.group.add(st.mesh(steel, 'kitPylonMast', a.materials));

  // Gondolas, hung off the downhill cable at two points along the span.
  const cabMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.4, metalness: 0.1 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x16222c, roughness: 0.18, metalness: 0.55 });
  const armMat = new THREE.MeshStandardMaterial({ color: 0x39424c, roughness: 0.5, metalness: 0.5 });
  a.materials.push(cabMat, glassMat, armMat);
  for (const [t, dz] of [[0.34, -2.6], [0.68, 2.6]] as const) {
    const y = TALL + (SHORT - TALL) * t - 2.6 * Math.sin(Math.PI * t);
    const x = -span + t * span * 2;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.6, 0.16), armMat);
    arm.position.set(x, y - 1.3, dz);
    arm.castShadow = true;
    a.group.add(arm);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.9, 2.3), cabMat);
    cab.position.set(x, y - 4.1, dz);
    cab.castShadow = true;
    a.group.add(cab);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(2.36, 1.25, 2.36), glassMat);
    glass.position.set(x, y - 3.7, dz);
    a.group.add(glass);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.24, 2.5), armMat);
    roof.position.set(x, y - 2.6, dz);
    roof.castShadow = true;
    a.group.add(roof);
  }

  // Snow lying on the portal beam and the cross-arms, because on this course it
  // lies on everything.
  const snowMat = new THREE.MeshLambertMaterial({ color: 0xf2f7fb });
  a.materials.push(snowMat);
  const capBeam = new THREE.Mesh(new THREE.BoxGeometry(span * 2, 0.16, 0.44), snowMat);
  capBeam.position.set(0, BANNER_Y + 1.72, 0);
  capBeam.castShadow = true;
  a.group.add(capBeam);

  // The drive house at the foot of the tall mast: a shed with a big sheave in
  // it, so the cableway has somewhere to be driven from.
  const houseMat = new THREE.MeshStandardMaterial({ color: 0x8a6a4c, roughness: 0.75 });
  a.materials.push(houseMat);
  const house = new THREE.Mesh(new THREE.BoxGeometry(7.4, 5.6, 6.2), houseMat);
  house.position.set(-span - 6.4, 1.5, 0);
  house.castShadow = true;
  house.receiveShadow = true;
  a.group.add(house);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.5, 7.2), snowMat);
  roof.position.set(-span - 6.4, 4.5, 0);
  roof.castShadow = true;
  a.group.add(roof);

  return {
    banner: addBanner(a, Math.min(span * 2 - 2, 26), BANNER_Y + 1.35),
    lamps: addLampBoard(a, BANNER_Y - 3.4),
  };
}

// ── chapters: the places one lap passes through ────────────────────────────
//
// **The finding.** A critic photographed the same chase view at 22%, 50% and
// 78% of one lap of every course: *"Cone Canyon — three near-identical frames,
// same orange verge, same striped fence, same tan hills, same sky; with the
// minimap covered you cannot say which third of the lap you are on. Saltpan —
// same white salt, same black ribbon, same distant butte, three times. Only one
// of four courses has chapters."*
//
// The one that passed — Switchback Summit, valley floor to summit works — did
// it with a hundred and sixteen metres of climb, and that is not a style the
// other two can copy. `track/terrain.ts` anchors the landscape to the elevation
// of the **nearest road** (`ref` in `terrainHeight`, which does not reach the
// datum until 340 metres out), so on a flat circuit the ground beside the road
// is the same ground for the whole lap by construction, and raising one section
// of tarmac simply lifts the landscape with it. There is no course-side number
// that digs a valley next to a bypass.
//
// So a chapter is **built**. It stands something along a span of the road that
// is big enough to change the shape of the frame — a trench between two faces,
// a deck with a truss on it, an arch across the road — and two spans of the
// same lap under the same sky then read as two places. See `ChapterDef`.
//
// Everything here obeys the same three rules as the barrier: nothing leans over
// the tarmac inside the line physics enforces, nothing is taller than it needs
// to be to close the horizon, and every piece is one mesh or one InstancedMesh.
// A chapter is scenery — it changes what the road looks like and never where it
// goes.

/** Rock face: bedded strata across the profile, fractures up it. */
/**
 * The face of a rock cutting.
 *
 * **x is height up the face and y is distance along the track.** Every lane in
 * `buildCutting`'s profile carries a `u` that is its fraction of the way from
 * the buried toe to the crest, and `MeshBuilder` writes it straight into the
 * texture's first coordinate — so this canvas is a *section* through the cut,
 * drawn once and swept a hundred metres. Anything that varies with height is
 * drawn here; anything that varies along the cut is drawn in the geometry.
 *
 * ── the round this was rewritten in ────────────────────────────────────────
 *
 *   *"The 15m face fills ~55% of the frame in one uniform orange from toe to
 *   crest — no value gradient, no AO where it meets the ground, no sky-facing
 *   highlight on the bench. The 'strata' are thin wobbly pencil-weight lines of
 *   identical weight everywhere that run straight over the one horizontal bench
 *   step, so the step reads as texture rather than geometry."*
 *
 * Three of those four were one fault. The old shade ramp went dark at x=0,
 * neutral by x=0.22 and then **flat until x=0.80** — and 0.22 to 0.80 is the
 * whole of the face a driver ever sees, the buried toe and the crest shelf
 * being the parts outside it. So the wall had a gradient everywhere except on
 * itself. The bench is at u≈0.36-0.41 (see the `face` lanes) and nothing here
 * knew that, so every bed and every joint ran straight over it.
 *
 * What is drawn now, bottom to top:
 *
 *   * **the lower lift**, warmer and two stops down — it is in its own shade
 *     for most of the day and it has the fines off the fan blown up it;
 *   * **the bench**, as a hard three-part event: a black line of shadow under
 *     the lip, the lit floor of the shelf, and a bright sky-facing edge;
 *   * **the upper lift**, cooler and lighter, with its bedding *offset* from
 *     the lower one — a bench is cut on a bedding plane, so the beds above it
 *     are not the beds below it;
 *   * **the crest**, catching the sky.
 *
 * `benched` is passed in rather than assumed because a face under nine metres
 * is cut in one lift and a shelf painted across it would be a lie about
 * geometry that is not there.
 */
function rockFaceTexture(tint: number, benched = true): THREE.CanvasTexture {
  const key = `kit:rock:${tint.toString(16)}:${benched ? 'b' : 's'}`;
  return tex(key, 256, 256, (g, W, H) => {
    const rnd = rand(0x9e3b17 ^ tint);
    const base = new THREE.Color(tint);
    const hex = (c: THREE.Color, f: number): string =>
      `#${_shade.copy(c).multiplyScalar(f).getHexString()}`;
    g.fillStyle = hex(base, 1);
    g.fillRect(0, 0, W, H);

    /** Where the catch berm sits, as a fraction of the face. Matches `face`. */
    const BX0 = 0.355, BX1 = 0.415;
    const bench0 = BX0 * W, bench1 = BX1 * W;

    /**
     * One lift's worth of bedding.
     *
     * `weight` scales how hard the partings are cut, so the lower lift — which
     * is nearer, larger on screen, and in shade — carries the heavy joints and
     * the upper lift carries fine ones. Identical line weight everywhere was
     * half of *"pencil-weight lines of identical weight"*; the other half is
     * that there is now a range of band heights inside each lift instead of
     * one distribution across the whole face.
     */
    const beds = (x0: number, x1: number, lo: number, hi: number, weight: number): void => {
      let x = x0;
      while (x < x1) {
        const band = lo + rnd() * (hi - lo);
        const f = 0.60 + rnd() * 0.76;
        const w = Math.min(band, x1 - x);
        g.save();
        g.beginPath();
        g.rect(x0, 0, x1 - x0, H);
        g.clip();
        g.fillStyle = hex(base, f);
        g.beginPath();
        g.moveTo(x, 0);
        for (let y = 0; y <= H; y += 12) g.lineTo(x + Math.sin(y * 0.035 + x) * 3.5, y);
        for (let y = H; y >= 0; y -= 12) {
          g.lineTo(x + w + Math.sin(y * 0.035 + x * 1.7) * 3.5, y);
        }
        g.closePath();
        g.fill();
        // The parting between two beds, which is where a face weathers first.
        // Its weight is the bed's own — a thick bed parts on a thick joint —
        // so the face has heavy lines and hairlines rather than one gauge.
        const jw = (0.9 + band * 0.10) * weight;
        g.fillStyle = `rgba(24,13,7,${(0.16 + 0.34 * weight * rnd()).toFixed(3)})`;
        g.beginPath();
        g.moveTo(x, 0);
        for (let y = 0; y <= H; y += 12) g.lineTo(x + Math.sin(y * 0.035 + x) * 3.5, y);
        for (let y = H; y >= 0; y -= 12) {
          g.lineTo(x + jw + Math.sin(y * 0.035 + x) * 3.5, y);
        }
        g.closePath();
        g.fill();
        g.restore();
        x += band;
      }
    };

    if (benched) {
      // Thick beds below, thin above, and the two runs start at different
      // phases — which is the whole point of cutting a face in two lifts.
      beds(0, bench0, 9, 30, 1.0);
      beds(bench1, W, 6, 20, 0.74);
    } else {
      beds(0, W, 6, 26, 0.8);
    }

    // ── the value structure ─────────────────────────────────────────────────
    //
    // A single ramp across the *whole* face, so no part of it is flat. The
    // shape: black at the buried toe, still two stops down two metres up where
    // the fan throws its own shadow, recovering through the lower lift, a step
    // at the bench, and the top third catching the sky.
    const shadeGrad = g.createLinearGradient(0, 0, W, 0);
    shadeGrad.addColorStop(0.00, 'rgba(14,7,3,0.70)');
    // Roughly the bottom two metres of a fifteen-metre face — the band a
    // critic asked to be darkened, and where the scree fan's own occlusion is.
    shadeGrad.addColorStop(0.13, 'rgba(16,8,4,0.34)');
    shadeGrad.addColorStop(0.26, 'rgba(18,10,5,0.20)');
    shadeGrad.addColorStop(BX0 - 0.005, 'rgba(20,11,6,0.13)');
    shadeGrad.addColorStop(BX1 + 0.005, 'rgba(255,241,214,0.05)');
    shadeGrad.addColorStop(0.72, 'rgba(255,243,218,0.09)');
    // Cool, not warm, at the very top. The crest is the one part of a cut face
    // that sees the whole sky and none of the ground bounce, and a warm
    // highlight there washed the upper lift out into the same pale orange the
    // finding was about.
    shadeGrad.addColorStop(0.93, 'rgba(226,238,255,0.13)');
    shadeGrad.addColorStop(1.00, 'rgba(206,226,255,0.22)');
    g.fillStyle = shadeGrad;
    g.fillRect(0, 0, W, H);

    if (benched) {
      // ── the bench, as three lines ───────────────────────────────────────
      //
      // A shelf is read from its shadow, not from its floor. Under the lip of
      // the upper lift there is a hard dark line; the floor of the berm is
      // lighter than either lift because it is the one horizontal surface on
      // the wall and it is pointed at the sky; and the outer edge of it takes
      // a hot rim. Painted as three narrow bands rather than a gradient, so
      // the eye reads an *edge* — the failure being fixed is that the step
      // read as texture.
      g.fillStyle = 'rgba(12,6,2,0.52)';
      g.fillRect(bench0, 0, (bench1 - bench0) * 0.34, H);
      g.fillStyle = 'rgba(255,247,228,0.30)';
      g.fillRect(bench0 + (bench1 - bench0) * 0.34, 0, (bench1 - bench0) * 0.5, H);
      g.fillStyle = 'rgba(255,250,236,0.52)';
      g.fillRect(bench1 - 2, 0, 3, H);
      // Spoil that has fallen onto the berm and sits along the back of it.
      for (let i = 0; i < 90; i++) {
        const y = rnd() * H;
        g.fillStyle = `rgba(26,15,8,${(0.10 + rnd() * 0.22).toFixed(3)})`;
        g.fillRect(bench0 + rnd() * (bench1 - bench0) * 0.7, y, 1 + rnd() * 3, 2 + rnd() * 5);
      }
    }

    // ── the joints ──────────────────────────────────────────────────────────
    //
    // A joint runs *up* the face, so it is a line at constant y. Three
    // populations rather than one: a handful of deep ones that go the whole
    // height, a lot of short ones inside the lower lift only, and a few
    // hairlines up top. That is what stops them reading as a single hatch —
    // and none of them crosses the bench, because a joint that ran over a
    // three-metre shelf would be drawing the wall as one plane again.
    const joint = (y: number, x0: number, x1: number, a: number, t: number): void => {
      g.fillStyle = `rgba(18,10,6,${a.toFixed(3)})`;
      g.fillRect(x0, y, x1 - x0, t);
    };
    for (let i = 0; i < 9; i++) {
      const y = rnd() * H;
      joint(y, rnd() * W * 0.16, benched ? bench0 : W, 0.34 + rnd() * 0.22, 2 + rnd() * 3);
      if (benched && rnd() > 0.45) joint(y + 1 + rnd() * 4, bench1, W, 0.22, 1 + rnd() * 2);
    }
    for (let i = 0; i < 22; i++) {
      const y = rnd() * H;
      const x0 = rnd() * (benched ? bench0 : W) * 0.6;
      joint(y, x0, x0 + (benched ? bench0 : W) * (0.3 + rnd() * 0.6), 0.08 + rnd() * 0.16, 1);
    }
    if (benched) {
      for (let i = 0; i < 14; i++) {
        const y = rnd() * H;
        joint(y, bench1 + rnd() * (W - bench1) * 0.4, W, 0.06 + rnd() * 0.12, 1);
      }
    }

    // Blast scar and dust, heaviest at the toe where the spoil piles up — and
    // a second pass of pale fines blown *up* the lower lift off the fan, which
    // is what actually joins a rock face to the heap at its foot.
    for (let i = 0; i < 520; i++) {
      const px = rnd() * W;
      g.fillStyle = `rgba(255,242,220,${(rnd() * 0.10 * (px / W)).toFixed(3)})`;
      g.fillRect(px, rnd() * H, 1 + rnd() * 4, 1 + rnd() * 3);
    }
    for (let i = 0; i < 260; i++) {
      const px = rnd() ** 2.4 * W * 0.30;
      g.fillStyle = `rgba(226,205,176,${(rnd() * 0.16).toFixed(3)})`;
      g.fillRect(px, rnd() * H, 1 + rnd() * 5, 1 + rnd() * 2);
    }
  });
}

/**
 * The scree fan at the toe of a rock cutting.
 *
 * Same axes as the face: x is *across* the fan (barrier at 0, wall at 1) and y
 * runs along the cut. Pale and grey where the rock is fresh at the foot of the
 * wall, dirtier and warmer out where the fines wash toward the road, with a
 * scatter of chips that is coarse near the wall and fine away from it.
 */
function talusTexture(tint: number): THREE.CanvasTexture {
  const key = `kit:talus:${tint.toString(16)}`;
  return tex(key, 256, 256, (g, W, H) => {
    const rnd = rand(0x4c17a3 ^ tint);
    const base = new THREE.Color(tint);
    const hex = (f: number, gy: number): string =>
      `#${_shade.copy(base).lerp(_grey.setRGB(gy, gy, gy), 0.34)
        .multiplyScalar(f).getHexString()}`;
    const ramp = g.createLinearGradient(0, 0, W, 0);
    ramp.addColorStop(0, hex(0.80, 0.55));
    ramp.addColorStop(0.55, hex(1.02, 0.66));
    ramp.addColorStop(1, hex(1.24, 0.74));
    g.fillStyle = ramp;
    g.fillRect(0, 0, W, H);
    // Chips. Coarse and pale at the wall end, fine and dark toward the road —
    // which is how a fan actually sorts itself.
    for (let i = 0; i < 1500; i++) {
      const t = rnd();
      const px = t * W;
      const sz = 1 + (t ** 2) * 5 * rnd();
      const v = 0.55 + rnd() * 0.75;
      g.fillStyle = `rgba(${(210 * v) | 0},${(198 * v) | 0},${(182 * v) | 0},${(0.10 + 0.34 * rnd()).toFixed(3)})`;
      g.fillRect(px, rnd() * H, sz, sz * (0.5 + rnd()));
    }
    // Runnels: the lines the rain leaves down a fan, across it rather than
    // along it, so they read as flow and not as bedding.
    for (let i = 0; i < 26; i++) {
      const y = rnd() * H;
      g.fillStyle = `rgba(38,24,14,${(0.05 + rnd() * 0.10).toFixed(3)})`;
      g.fillRect(rnd() * W * 0.4, y, W, 1 + rnd() * 2);
    }
  });
}

/** Works wall: ribbed sheet pile, concrete capping, hazard band at the toe. */
function worksWallTexture(tint: number, accent: number): THREE.CanvasTexture {
  const key = `kit:works:${tint.toString(16)}:${accent.toString(16)}`;
  return tex(key, 256, 256, (g, W, H) => {
    const rnd = rand(0x1f5c88 ^ tint);
    const body = `#${new THREE.Color(tint).getHexString()}`;
    g.fillStyle = body;
    g.fillRect(0, 0, W, H);
    // Sheet pile: the pans and webs run up the face, so a rib is a stripe along
    // v. Two tones, because a pile wall is a folded plate and half of it faces
    // away from the sun.
    for (let y = 0; y < H; y += 22) {
      g.fillStyle = 'rgba(255,255,255,0.13)';
      g.fillRect(0, y, W, 8);
      g.fillStyle = 'rgba(20,24,30,0.22)';
      g.fillRect(0, y + 12, W, 6);
    }
    // Capping beam along the crest, and a walkway kerb under it.
    g.fillStyle = '#D9D5C8';
    g.fillRect(W * 0.86, 0, W * 0.14, H);
    g.fillStyle = 'rgba(30,34,40,0.35)';
    g.fillRect(W * 0.845, 0, W * 0.02, H);
    // Hazard band along the toe: the part a kart can actually reach.
    g.fillStyle = `#${new THREE.Color(accent).getHexString()}`;
    g.fillRect(0, 0, W * 0.11, H);
    g.fillStyle = '#22262E';
    for (let y = -30; y < H; y += 30) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(0, y + 15);
      g.lineTo(W * 0.11, y + 15 - W * 0.11);
      g.lineTo(W * 0.11, y - W * 0.11);
      g.closePath();
      g.fill();
    }
    // Salt bloom and streaking down the face.
    for (let i = 0; i < 320; i++) {
      const px = W * 0.11 + rnd() * W * 0.72;
      g.fillStyle = `rgba(244,241,232,${(rnd() * 0.22).toFixed(3)})`;
      g.fillRect(px, rnd() * H, 2 + rnd() * 9, 1 + rnd() * 2);
    }
  });
}

interface ChapterCtx {
  spline: TrackSpline;
  verge: number;
  root: THREE.Group;
  materials: THREE.Material[];
  /** Metres from the ring's origin to the start line — lap fractions are off it. */
  start: number;
  L: number;
}

/** A span of lap fractions resolved to an absolute distance and a length. */
function chapterSpan(c: ChapterCtx, ch: { from: number; to: number }): [number, number] {
  const d0 = (((c.start + ch.from * c.L) % c.L) + c.L) % c.L;
  let span = (ch.to - ch.from) * c.L;
  if (span < 0) span += c.L;
  return [d0, Math.max(20, span)];
}

const edgeOf = (verge: number) => (s: SplineSample): number => s.width * 0.5 + verge;

/**
 * A lateral offset outside the barrier, **clamped so it cannot fold through the
 * centre of a corner**.
 *
 * `track/terrain.ts` carries the same clamp on its skirt rings and says why: on
 * the inside of a tight turn, a lane laid a fixed distance out from a
 * curved centreline runs out of room at the radius of curvature and then turns
 * itself inside out. Digger's Elbow is 34 metres of radius on a road whose
 * barrier line is already 17.9 metres from the centreline, so a wall wanting to
 * sit twelve metres behind that has three metres of world to sit in. Clamping
 * costs a metre of wall on the apex of the tightest corners in the cup;
 * not clamping costs the mesh.
 */
function offsetAt(s: SplineSample, edge: number, off: number, side: -1 | 1): number {
  const inner = (s.curvature > 0 ? -1 : 1) === side;
  if (!inner || Math.abs(s.curvature) <= 1e-4) return side * (edge + off);
  const limit = Math.max(0, 1 / Math.abs(s.curvature) - edge - 2.5);
  return side * (edge + Math.min(off, limit));
}

/**
 * A cutting: a face standing just outside the barrier, and the horizon gone.
 *
 * The whole read is the *crest line* — a wall of one height is a fence, and a
 * rock face has a broken top that moves against the sky as you drive under it.
 * So the crest is noise on the along-track distance, and it ramps in and out
 * over the first and last forty metres of the span so the road is not walled by
 * a step.
 *
 * ── and then it was photographed, and it was a painted backdrop ────────────
 *
 * A critic reviewed the round this shipped in and named the failure exactly:
 * *"the rock face is one smooth swept surface with a painted strata-and-streak
 * texture, a continuous unbroken top edge, and no talus, boulders, ledges or
 * vegetation where it meets the flat brown verge — it reads as a painted
 * backdrop, and it fills 45% of the frame at the course's own chapter."*
 *
 * Every word of that follows from one property of the first build: **the plan
 * line of the wall was a constant offset from the road.** Lift varied along the
 * span; lateral did not. A surface whose cross-section is the same five numbers
 * at every station is a *ruled* surface, and no amount of texture rescues one —
 * the strata slide along it because the geometry underneath them never turns.
 *
 * Three things answer it, and they are all geometry:
 *
 *   1. **The face wanders.** Each lane's offset carries its own along-track
 *      noise, so the wall bulges into the verge and stands back off it. The
 *      noise is one-sided (`noise2` is 0..1) so it can only ever move a face
 *      *away* from the road, never inside the barrier line.
 *   2. **The face is benched.** A blasted face is cut in lifts with a catch
 *      berm between them, so the profile is face → shelf → face rather than one
 *      batter. The shelf sits on a fraction of the *crest*, which is already
 *      noisy, so the ledge line breaks along the span exactly as the top does.
 *      It is a separate ribbon, which is what makes its edge hard: `MeshBuilder`
 *      averages normals within a ribbon and not across two.
 *   3. **The toe has rock at it.** Talus was already here and was a smooth
 *      heap; a scatter of blocks now stands on it, biggest at the foot and
 *      deterministic from `d0`, so the place where the wall meets the verge is
 *      the one part of it a driver can measure distance against.
 */
function buildCutting(c: ChapterCtx, ch: ChapterDef): void {
  const h = ch.height ?? 11;
  const batter = ch.batter ?? 3.4;
  const isRock = (ch.face ?? 'rock') === 'rock';
  const tint = ch.tint ?? (isRock ? 0xa9633a : 0x8f9aa4);
  const [d0, span] = chapterSpan(c, ch);
  const benchedFace = isRock && h >= 9;
  const map = isRock
    ? rockFaceTexture(tint, benchedFace)
    : worksWallTexture(tint, ch.accent ?? 0xffc300);
  const mat = new THREE.MeshLambertMaterial({ map, side: THREE.DoubleSide });
  c.materials.push(mat);

  /**
   * Metres the toe of a rock face stands back behind the barrier line.
   *
   * ── the street lamp halfway up the cliff ────────────────────────────────
   *
   * A critic photographed Digger's Cutting and found *"a street lamp and a
   * small blue box stuck to the middle of the vertical rock face"*. They are
   * not this file's objects — `world/index.ts` drops a `lightColumn` every 52
   * metres at 3.2-4.4m outboard of the barrier and a `flagPole` every 104 at
   * 4.4-5.6 — and neither placement consults anything a chapter has built.
   * The wall's toe was at 0.35m and its batter reaches the crest by about
   * 3.5m, so a column standing at 4.0 was **inside** the face, at whatever
   * height the batter had got to there: halfway up.
   *
   * A cutting cannot ask the world module not to light the road, and a road
   * beside a rock cutting *is* lit in real life. What it can do is leave the
   * furniture somewhere to stand: the toe moves out past the far end of both
   * placement bands, and the talus fan below fills the ground it vacated, so a
   * column stands in front of the wall on the scree instead of inside it. That
   * also answers the second half of the same finding — *"two hexagonal
   * boulders across the whole 900px span sit on flat dirt with no scree fan"* —
   * because a fan needs somewhere to be, and 0.35m of verge is not somewhere.
   *
   * The proper fix is still owed by `world/index.ts` and is filed in this
   * round's report; this is the half that is in this file, and it is the half
   * that makes the toe of the wall a *place*.
   */
  const stand = isRock ? 4.0 : 0;
  const edge0 = edgeOf(c.verge);
  const edge = (s: SplineSample): number => edge0(s) + stand;
  const tp = Math.min(0.34, 46 / span);
  const ramp = (f: number): number => smoothstep(0, tp, f) * smoothstep(0, tp, 1 - f);
  const b = new MeshBuilder();
  // One flank or two. See `ChapterDef.side`: a trench has two faces and a
  // quarry bench has one, and the difference is the whole difference between a
  // corridor and a road on the side of a hole.
  const sides: readonly (-1 | 1)[] = ch.side ? [ch.side] : [-1, 1];

  for (const side of sides) {
    // The crest, in metres above the road. Rock breaks; a works wall is built,
    // so it only breathes a few per cent.
    const crest = (s: SplineSample, f: number): number => {
      // Two wavelengths on a rock crest, and the short one is the reason: at a
      // single 27-metre period the skyline came back as a smooth curve — a wall
      // — and what separates a cliff from a wall at a hundred metres is that
      // its top edge breaks. A works wall is built, so it only breathes.
      const n = isRock
        ? 0.62 + 0.52 * noise2(s.distance / 26 + side * 4.5, side * 2.3)
          + 0.30 * noise2(s.distance / 9.5 - side * 2.1, side * 5.7)
        : 0.96 + 0.08 * noise2(s.distance / 40, side);
      return h * ramp(f) * n;
    };
    // ── the wander: why the wall is not a parallel offset ─────────────────
    //
    // `noise2` is 0..1, which is the property this depends on rather than a
    // detail of it: the term can only ever push a lane *outboard*. A signed
    // noise would eventually hand a lane a smaller offset than `0.35` and put
    // the toe of the wall inside the line physics enforces, which is a wall a
    // kart drives through rather than into. A built wall does not wander.
    const wander = isRock
      ? (s: SplineSample, f: number): number =>
        ramp(f) * (1.7 * noise2(s.distance / 33 + side * 9.1, side * 3.3)
          + 0.7 * noise2(s.distance / 12.5 - side * 4.4, side * 6.1))
      : (): number => 0;
    // Every lane goes through `offsetAt`, and the whole offset goes through it
    // — the wander and the berm's set-back included. Adding a metre *after* the
    // clamp is how a wall folds itself inside out on the apex of a 34-metre
    // corner, which is the failure the clamp exists to prevent.
    const at = (off: (s: SplineSample, f: number) => number) =>
      (s: SplineSample, f: number): number => offsetAt(s, edge(s), off(s, f), side);
    const flat = (off: number, w = 1) =>
      at((s, f) => off + w * wander(s, f));
    // ── the face, the bench and the top, as three ribbons ─────────────────
    //
    // Deliberately separate, because `MeshBuilder` averages normals within one
    // ribbon and across a crest that is exactly wrong: the first cut of this
    // was one profile from the toe over the top and back down, and it
    // photographed as a smooth grey whale-back — a dune, not a cut face.
    // Ribbons do not share vertices, so every break in this profile — the
    // berm's lip, its back, the crest — is a hard edge that holds one value
    // against the sky.
    //
    // The berm is `bench` metres up a face cut in two lifts, which is how a
    // face this tall is actually cut, and it is the piece that stops the wall
    // being one sweep. Below about nine metres there is only one lift and the
    // profile falls back to the single batter it always was.
    const benched = benchedFace;
    const lift1 = h > 16 ? 0.46 : 0.36;
    const bench = (s: SplineSample, f: number): number => crest(s, f) * lift1;
    /**
     * Metres the upper lift stands back behind the lower one.
     *
     * Two to four, and the reason it is that wide is that a catch berm is
     * photographed almost edge-on from a kart: a shelf a metre deep is a line
     * on the wall and a shelf three metres deep is a *place* on it, with its
     * own light on the floor of it and its own shadow under the lip.
     */
    const shelf = (s: SplineSample, f: number): number =>
      benched ? ramp(f) * (2.0 + 1.9 * noise2(s.distance / 21 - side * 3.1, side * 8.8)) : 0;
    const o1 = 1.05 + batter * 0.10;
    const o2 = 1.35 + batter * 0.42;
    const o3 = 1.35 + batter * 0.62;
    const face: Lane[] = benched
      ? [
        // Buried toe, so there is no gap under the wall on a cambered corner.
        { lat: flat(0.35, 0.35), lift: () => -1.6, u: 0 },
        { lat: flat(0.70, 0.55), lift: (s, f) => -0.30 + 0.5 * ramp(f), u: 0.05 },
        { lat: flat(o1), lift: (s, f) => bench(s, f) * 0.74, u: 0.26 },
        // The lip of the berm, and its back wall a metre and a half behind it.
        // Both carry the same wander, so the shelf stays a shelf.
        { lat: flat(o1 + 0.28), lift: bench, u: 0.36 },
        {
          lat: at((s, f) => o1 + 0.28 + wander(s, f) + shelf(s, f)),
          lift: (s, f) => bench(s, f) + 0.26, u: 0.41,
        },
        {
          lat: at((s, f) => o2 + wander(s, f) + shelf(s, f)),
          lift: (s, f) => crest(s, f) * 0.86, u: 0.80,
        },
        { lat: at((s, f) => o3 + wander(s, f) + shelf(s, f)), lift: crest, u: 1 },
      ]
      : [
        { lat: flat(0.35, 0.35), lift: () => -1.6, u: 0 },
        { lat: flat(0.70, 0.55), lift: (s, f) => -0.30 + 0.5 * ramp(f), u: 0.05 },
        { lat: flat(1.05), lift: (s, f) => crest(s, f) * 0.46, u: 0.42 },
        { lat: flat(o2), lift: (s, f) => crest(s, f) * 0.88, u: 0.82 },
        { lat: flat(o3), lift: crest, u: 1 },
      ];
    // The top: a narrow crest shelf, then the back falling away into the
    // landscape — which is what stops the wall reading as a cardboard flat the
    // moment the camera gets above it.
    const top: Lane[] = [
      { lat: at((s, f) => o3 + wander(s, f) + shelf(s, f)), lift: crest, u: 1 },
      {
        lat: at((s, f) => 1.35 + batter + wander(s, f) + shelf(s, f)),
        lift: (s, f) => crest(s, f) * (isRock ? 0.94 : 1), u: 0.88,
      },
      {
        lat: at((s, f) => 1.35 + batter + 7 + wander(s, f) + shelf(s, f)),
        lift: (s, f) => crest(s, f) * 0.42 - 2.5, u: 0.5,
      },
    ];
    if (side < 0) { face.reverse(); top.reverse(); }
    const opts = {
      verge: c.verge, from: d0, to: d0 + span, step: 3.2, vScale: isRock ? 16 : 11,
    };
    b.addRibbon(c.spline, face, opts);
    b.addRibbon(c.spline, top, opts);
  }
  const mesh = new THREE.Mesh(b.toGeometry(), mat);
  mesh.name = `chapter:cutting:${ch.name}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  c.root.add(mesh);

  // ── what closes the top of a works cutting ──────────────────────────────
  //
  // A rock cutting is closed by its own crest, which breaks and leans. A wall
  // built by people is level and would leave a strip of sky exactly as wide as
  // the road, so a works cutting is bridged: a pipe rack every forty metres,
  // carrying two runs of pipe over the carriageway. It is the piece that makes
  // this a *place inside a works* rather than a road with two grey walls beside
  // it, and it costs one InstancedMesh.
  //
  // **Thin, and grey.** The first cut ran three 42cm members in the kit's
  // hazard yellow at two thirds of the wall's height, and photographed as three
  // enormous olive timbers lying across the top of the frame — the loudest
  // thing on the circuit, at the exact moment a driver is trying to read a
  // thirty-metre-radius chicane under them. A service run is 20cm of painted
  // steel and it belongs *above* the eye line, not across it.
  if (!isRock) {
    const st = new Struts();
    const s: SplineSample = c.spline.atDistance(d0);
    const racks = Math.max(1, Math.round(span / 42));
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i < racks; i++) {
      const f = (i + 0.5) / racks;
      if (ramp(f) < 0.55) continue;
      c.spline.atDistance(d0 + span * f, s);
      const off = edge(s) + 1.1;
      const top = h * 1.02;
      for (let j = 0; j < 2; j++) {
        const y = top + j * 0.62;
        surfacePoint(s, -off, c.verge, y, a);
        surfacePoint(s, off, c.verge, y, b);
        st.add(a.x, a.y, a.z, b.x, b.y, b.z, 0.22 - j * 0.04);
      }
      // The two stools the rack sits on, standing on the wall crest.
      for (const side of [-1, 1] as const) {
        surfacePoint(s, side * off, c.verge, h * 0.55, a);
        surfacePoint(s, side * off, c.verge, top + 1.1, b);
        st.add(a.x, a.y, a.z, b.x, b.y, b.z, 0.34);
      }
    }
    if (st.list.length) {
      c.root.add(st.mesh(shade(tint, 0.72), `chapter:rack:${ch.name}`, c.materials));
    }
  }

  // ── the toe: talus, and the blocks standing in it ───────────────────────
  //
  // A cut face sheds, and the toe of the heap is the one place the driver's eye
  // can measure how far away the wall is. The heap was here first and was not
  // enough on its own: a smooth ramp of one colour where a wall meets a flat
  // verge is exactly the join a matte painting has. What reads is **blocks** —
  // things with facets and cast shadows, at a size the eye already knows, in a
  // scatter that gets sparser away from the foot.
  if (isRock) {
    // ── the fan is not the face ─────────────────────────────────────────
    //
    // It was `shade(tint, 0.86)` — a flat fill fourteen per cent off the wall
    // standing on it — and with the fan now several metres wide that is a
    // brown apron reading as part of the same object. Freshly shed rock is
    // paler and greyer than a weathered face: it has broken along clean
    // surfaces, and the fines washed out of it sit on top. So it gets its own
    // value *and* its own texture, and the wall gets an edge to stand on.
    const talusMat = new THREE.MeshLambertMaterial({
      map: talusTexture(tint), side: THREE.DoubleSide,
    });
    c.materials.push(talusMat);
    const t = new MeshBuilder();
    /** The height of the heap itself, at the ridge of it. */
    const heap = (s: SplineSample, f: number, side: -1 | 1): number =>
      ramp(f) * (0.9 + 1.9 * noise2(s.distance / 13 + side * 7.7, side));
    /**
     * ...and the height of its *surface* at a given offset, which is the
     * number the blocks need and the reason they were invisible for a round:
     * scattered at road level they sat inside two and a half metres of their
     * own talus. A rock on a heap has to be on the heap.
     */
    const heapAt = (s: SplineSample, f: number, side: -1 | 1, o: number): number => {
      const hgt = heap(s, f, side);
      // The same four knots the ribbon above is swept through, read as a
      // piecewise line. It has to be the *same* four: a block placed off a
      // profile the fan is not built to is a block floating over it or buried
      // in it, which is the bug this function was written to fix the first
      // time and would be the bug again if the fan moved and this did not.
      const k0 = -stand - 0.1, k1 = -stand * 0.45;
      if (o <= k0) return -0.45;
      if (o <= k1) {
        const t = k1 > k0 ? (o - k0) / (k1 - k0) : 1;
        return -0.45 + (hgt * 0.34 + 0.45) * t;
      }
      if (o <= 1.1) {
        const t = (o - k1) / (1.1 - k1);
        return hgt * (0.34 + 0.66 * t);
      }
      if (o <= 2.4) return hgt * (1 - 0.5 * (o - 1.1) / 1.3);
      return Math.max(0, hgt * 0.5 * (1 - (o - 2.4) / 2.2));
    };
    for (const side of sides) {
      const at = (off: number) => (s: SplineSample): number => offsetAt(s, edge(s), off, side);
      // ── the fan runs from the barrier to the toe, not from the toe ──────
      //
      // With `stand` metres of ground between the kerb and the foot of the
      // wall there is finally a scree fan to build rather than a lip to hint
      // at. It rises from nothing at the barrier line to the full heap where
      // the rock starts, which is the profile a fan actually has and the
      // reason the wall stops looking pasted onto flat dirt.
      const lanes: Lane[] = [
        { lat: at(-stand - 0.1), lift: () => -0.45, u: 0 },
        { lat: at(-stand * 0.45), lift: (s, f) => heap(s, f, side) * 0.34, u: 0.24 },
        { lat: at(1.1), lift: (s, f) => heap(s, f, side), u: 0.7 },
        { lat: at(2.4), lift: (s, f) => heap(s, f, side) * 0.5, u: 1 },
      ];
      if (side < 0) lanes.reverse();
      t.addRibbon(c.spline, lanes, {
        verge: c.verge, from: d0, to: d0 + span, step: 2.6, vScale: 9,
      });
    }
    const talus = new THREE.Mesh(t.toGeometry(), talusMat);
    talus.name = `chapter:talus:${ch.name}`;
    talus.receiveShadow = true;
    c.root.add(talus);

    // ── the blocks ────────────────────────────────────────────────────────
    //
    // One InstancedMesh for the whole cutting, both flanks, seeded off `d0` so
    // the same course lays the same rocks every run and no two cuttings in the
    // cup get the same scatter. A dodecahedron at detail 0 is fourteen faceted
    // triangles per block, which is the cheapest thing in three.js that is not
    // a box and does not read as one.
    const rnd = rand(0x51a7c3 ^ Math.round(d0 * 7.3));
    // One block every four and a half metres of wall, before the thinning
    // below takes about a third of them out again. Photographed at span/7.5 the
    // chase camera caught two of them in a sixty-metre view, which is a prop
    // rather than a toe.
    const per = Math.max(8, Math.round(span / 3.2));
    const blocks: THREE.Matrix4[] = [];
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const s: SplineSample = c.spline.atDistance(d0);
    const up = new THREE.Vector3();
    const spin = new THREE.Quaternion();
    for (const side of sides) {
      for (let i = 0; i < per; i++) {
        const f = (i + rnd() * 0.9) / per;
        if (ramp(f) < 0.3) continue;
        c.spline.atDistance(d0 + span * f, s);
        // Away from the wall, the blocks get smaller and rarer — which is what
        // makes the heap read as something that fell rather than something that
        // was laid out. `u` is cubed so most of them are at the foot.
        const u = rnd() ** 3;
        if (rnd() > 0.2 + 0.55 * (1 - u)) continue;
        const size = (1.1 + 2.2 * rnd()) * (1 - 0.45 * u) * (h > 16 ? 1.3 : 1);
        // **Outboard of the barrier line, always.** `edge` is where the barrier
        // and the wall physics enforces both stand; a block inside it is a rock
        // in the road that every kart in the field drives straight through.
        //
        // `u` measures *away from the wall*, so with `u` cubed the scatter is
        // dense at the toe and thins across the fan toward the road — which is
        // the distribution a rockfall actually leaves, and the reason the fan
        // reads as something that fell rather than something that was graded.
        const o = 1.6 - u * (stand + 1.4);
        const off = offsetAt(s, edge(s), o, side);
        surfacePoint(s, off, c.verge, heapAt(s, f, side, o) + size * 0.28, p);
        up.copy(s.up).normalize();
        q.setFromUnitVectors(UP, up);
        q.multiply(spin.setFromAxisAngle(UP, rnd() * Math.PI * 2));
        scl.set(size, size * (0.5 + 0.45 * rnd()), size * (0.8 + 0.4 * rnd()));
        blocks.push(new THREE.Matrix4().compose(p, q, scl));
      }
    }
    if (blocks.length) {
      const bm = new THREE.MeshLambertMaterial({ color: shade(tint, 0.94) });
      c.materials.push(bm);
      const im = new THREE.InstancedMesh(
        new THREE.DodecahedronGeometry(0.5, 0), bm, blocks.length,
      );
      im.name = `chapter:blocks:${ch.name}`;
      im.castShadow = true;
      im.receiveShadow = true;
      // ── the blocks may not all be the wall's colour ────────────────────
      //
      // They were `shade(tint, 0.94)` — six per cent off the face behind them
      // — and a critic counted *"two hexagonal boulders across the whole 900px
      // span"* on a fan that had thirty of them in it. The rest were there and
      // invisible, because a faceted object the same value as its background
      // is a background. Freshly broken rock is lighter than a weathered face
      // and the shadowed underside of a block is much darker than either, so
      // the spread here is wide on purpose: 0.62 to 1.28 of the face, per
      // instance, off the same deterministic stream that placed them.
      const _c = new THREE.Color();
      im.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(blocks.length * 3), 3,
      );
      for (let i = 0; i < blocks.length; i++) {
        const v = 0.62 + 0.66 * rnd() ** 1.4;
        _c.setRGB(v, v * (0.99 + 0.02 * rnd()), v * (0.97 + 0.06 * rnd()));
        im.instanceColor.setXYZ(i, _c.r, _c.g, _c.b);
      }
      im.instanceColor.needsUpdate = true;
      for (let i = 0; i < blocks.length; i++) im.setMatrixAt(i, blocks[i]!);
      im.instanceMatrix.needsUpdate = true;
      c.root.add(im);
    }
  }
}

/**
 * A viaduct: the road up on a structure, because the ground will not go down.
 *
 * Four pieces, and the order matters — the fascia is what says *there is
 * nothing under the edge of this road*, and without it a parapet is a wall and
 * a truss is a fence:
 *
 *   1. a deck fascia overhanging both flanks, with a beam hanging under it;
 *   2. a solid parapet standing on the fascia;
 *   3. two through trusses standing on the parapets;
 *   4. portal braces across the top every fifth panel, which is the member that
 *      makes it a bridge rather than two fences.
 */
function buildViaduct(c: ChapterCtx, ch: ChapterDef): void {
  const h = ch.height ?? 6.2;
  const over = ch.batter ?? 2.4;
  const steel = ch.tint ?? 0x3a6f9c;
  const accent = ch.accent ?? 0xf1efe6;
  const [d0, span] = chapterSpan(c, ch);
  const edge = edgeOf(c.verge);
  const tp = Math.min(0.22, 30 / span);
  const ramp = (f: number): number => smoothstep(0, tp, f) * smoothstep(0, tp, 1 - f);

  // ── the deck ────────────────────────────────────────────────────────────
  const deckMat = new THREE.MeshLambertMaterial({
    color: accent, side: THREE.DoubleSide,
  });
  const beamMat = new THREE.MeshLambertMaterial({ color: shade(steel, 0.8) });
  c.materials.push(deckMat, beamMat);
  const deck = new MeshBuilder();
  const fascia = new MeshBuilder();
  for (const side of [-1, 1] as const) {
    const at = (off: number) => (s: SplineSample): number => offsetAt(s, edge(s), off, side);
    const top: Lane[] = [
      { lat: at(-0.2), lift: () => -0.34, u: 0 },
      { lat: at(over * 0.6), lift: () => -0.26, u: 0.5 },
      { lat: at(over), lift: () => -0.26, u: 1 },
    ];
    // The hanging beam. It ramps to nothing at both ends of the span so the
    // structure grows out of the embankment instead of starting in mid-air.
    const face: Lane[] = [
      { lat: at(over), lift: () => -0.26, u: 0 },
      { lat: at(over * 0.94), lift: (s, f) => -0.26 - 2.6 * ramp(f) - 0.4, u: 1 },
    ];
    if (side < 0) { top.reverse(); face.reverse(); }
    deck.addRibbon(c.spline, top, { verge: c.verge, from: d0, to: d0 + span, step: 3, vScale: 6 });
    fascia.addRibbon(c.spline, face, { verge: c.verge, from: d0, to: d0 + span, step: 3, vScale: 6 });
    // The parapet: a solid box profile standing on the deck edge.
    const wall: Lane[] = [
      { lat: at(over - 0.62), lift: () => -0.3, u: 0 },
      { lat: at(over - 0.62), lift: (s, f) => 0.35 + 0.72 * ramp(f), u: 0.4 },
      { lat: at(over), lift: (s, f) => 0.38 + 0.74 * ramp(f), u: 0.6 },
      { lat: at(over), lift: () => -0.3, u: 1 },
    ];
    if (side < 0) wall.reverse();
    deck.addRibbon(c.spline, wall, { verge: c.verge, from: d0, to: d0 + span, step: 3, vScale: 6 });
  }
  const deckMesh = new THREE.Mesh(deck.toGeometry(), deckMat);
  deckMesh.name = `chapter:deck:${ch.name}`;
  deckMesh.castShadow = true;
  deckMesh.receiveShadow = true;
  c.root.add(deckMesh);
  const fasciaMesh = new THREE.Mesh(fascia.toGeometry(), beamMat);
  fasciaMesh.name = `chapter:fascia:${ch.name}`;
  fasciaMesh.castShadow = true;
  c.root.add(fasciaMesh);

  // ── the truss ───────────────────────────────────────────────────────────
  const st = new Struts();
  const PANEL = 6.2;
  const bays = Math.max(3, Math.round(span / PANEL));
  const s: SplineSample = c.spline.atDistance(d0);
  // Two chords a side, so a bay is four points: (low,high) at each end.
  const pts: THREE.Vector3[][] = [];
  for (let i = 0; i <= bays; i++) {
    const f = i / bays;
    c.spline.atDistance(d0 + span * f, s);
    const lift = ramp(f);
    const row: THREE.Vector3[] = [];
    for (const side of [-1, 1] as const) {
      const lat = offsetAt(s, edge(s), over - 0.3, side);
      row.push(surfacePoint(s, lat, c.verge, 0.9 * lift, new THREE.Vector3()));
      row.push(surfacePoint(s, lat, c.verge, (0.9 + h) * lift, new THREE.Vector3()));
    }
    pts.push(row);
  }
  const V = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];
  for (let i = 0; i < bays; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    for (const k of [0, 2]) {
      // Chords.
      st.add(...V(a[k]!), ...V(b[k]!), 0.30);
      st.add(...V(a[k + 1]!), ...V(b[k + 1]!), 0.30);
      // Vertical and diagonal — the diagonal alternates hand, which is what a
      // Warren web looks like and what stops it reading as a ladder.
      st.add(...V(a[k]!), ...V(a[k + 1]!), 0.20);
      if (i % 2 === 0) st.add(...V(a[k]!), ...V(b[k + 1]!), 0.17);
      else st.add(...V(a[k + 1]!), ...V(b[k]!), 0.17);
    }
    // Portal bracing overhead. Every fifth bay, plus knee braces into the top
    // chords so the frame has a corner rather than a butt joint.
    if (i % 5 === 2) {
      st.add(...V(a[1]!), ...V(a[3]!), 0.26);
      const kneeL = a[1]!.clone().lerp(a[3]!, 0.14);
      const kneeR = a[3]!.clone().lerp(a[1]!, 0.14);
      st.add(...V(a[0]!.clone().lerp(a[1]!, 0.72)), ...V(kneeL), 0.15);
      st.add(...V(a[2]!.clone().lerp(a[3]!, 0.72)), ...V(kneeR), 0.15);
    }
  }
  if (st.list.length) {
    const mesh = st.mesh(steel, `chapter:truss:${ch.name}`, c.materials);
    c.root.add(mesh);
  }
}

/**
 * A portal: a natural rock bridge across the road.
 *
 * Not a span of road but a gate on one — the frame you drive *through* on the
 * way into the next chapter, and the cheapest thing in this file per metre of
 * memory it buys.
 *
 * ── one solid sweep, and it took a photograph to know that ─────────────────
 *
 * The first cut was voussoirs: thirty boxes stood along the half ellipse with
 * their scale and roll shaken by noise, on the reasoning that a smooth tube
 * photographs as a plastic croquet hoop. It photographs as **a chain of loose
 * slabs** — a caterpillar of separate rectangles with daylight between them,
 * because the along-arc spacing of an arch this size is three metres and no
 * honest block is six metres long. A rock arch is one piece of rock.
 *
 * So it is a swept section: a rectangular profile carried along the ellipse,
 * four quads per station, the radial half-thickness swelling at the crown and
 * at the springings the way a natural bridge does, and the section's outline
 * broken by the same deterministic hash noise the cutting's crest uses. Each
 * quad gets its own normals — `addQuad` accumulates per batch — so it is
 * flat-shaded and rocky rather than smooth and inflatable. The sweep runs from
 * `t = -0.05` to `1.05`, which drives both feet into the ground instead of
 * standing them on it.
 */
function buildPortal(c: ChapterCtx, ch: ChapterDef): void {
  const tint = ch.tint ?? 0xa9633a;
  const d = (((c.start + (ch.from + ch.to) * 0.5 * c.L) % c.L) + c.L) % c.L;
  const s = c.spline.atDistance(d);
  const edge = s.width * 0.5 + c.verge;
  const foot = edge + 3.0;
  const rise = ch.height ?? 15;
  const mat = new THREE.MeshLambertMaterial({ map: rockFaceTexture(tint) });
  c.materials.push(mat);

  const fwd = new THREE.Vector3().crossVectors(s.right, s.up).normalize();
  const b = new MeshBuilder();
  const SEC = 26;

  // Centreline of the arch at parameter t, into `out`.
  const centre = (t: number, out: THREE.Vector3): THREE.Vector3 => {
    const a = Math.PI * t;
    return surfacePoint(s, -Math.cos(a) * foot, c.verge, Math.sin(a) * rise - 1.2, out);
  };
  // The four corners of the section at t, in order: inner-near, inner-far,
  // outer-far, outer-near.
  const _c0 = new THREE.Vector3();
  const _c1 = new THREE.Vector3();
  const _tan = new THREE.Vector3();
  const _rad = new THREE.Vector3();
  const section = (t: number): THREE.Vector3[] => {
    const a = Math.PI * t;
    centre(t, _c0);
    centre(t + 0.01, _c1);
    _tan.subVectors(_c1, _c0).normalize();
    _rad.crossVectors(_tan, fwd).normalize();
    const wob = noise2(t * 9.4, 3.3);
    // Thick at the crown, thick where it lands, thinnest a third of the way up
    // each leg — and never thin enough to read as a handle.
    const half = 2.4 + 1.7 * Math.abs(Math.cos(a)) + 1.9 * Math.pow(Math.sin(a), 2) + wob * 1.5;
    const deep = 4.2 + wob * 2.6;
    const out: THREE.Vector3[] = [];
    for (const [r, f] of [[-1, -1], [-1, 1], [1, 1], [1, -1]] as const) {
      out.push(_c0.clone().addScaledVector(_rad, r * half).addScaledVector(fwd, f * deep));
    }
    return out;
  };

  let prev = section(-0.05);
  for (let i = 1; i <= SEC; i++) {
    const t = -0.05 + (1.1 * i) / SEC;
    const next = section(t);
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      b.addQuad(prev[k]!, prev[k2]!, next[k]!, next[k2]!, [0, 0, 1, 1]);
    }
    prev = next;
  }

  const mesh = new THREE.Mesh(b.toGeometry(), mat);
  mesh.name = `chapter:portal:${ch.name}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  c.root.add(mesh);
}

function buildChapters(c: ChapterCtx, chapters: ChapterDef[]): void {
  for (const ch of chapters) {
    if (ch.kind === 'cutting') buildCutting(c, ch);
    else if (ch.kind === 'viaduct') buildViaduct(c, ch);
    else buildPortal(c, ch);
  }
}

// ── the treeline ───────────────────────────────────────────────────────────
//
// **The finding.** *"Switchback Summit is a 102m alpine mountain with no trees,
// bushes or vegetation of any kind — five metres past the kerb the world
// becomes a flat desaturated olive plane with a handful of tiny scatter props,
// and Mount Wario's equivalent moment is a dense pine forest."*
//
// See `TreelineDef` for why `world/`'s 190 stands are not the answer to that
// and were never meant to be: they are a *landscape* layer, spread over a
// 190-metre band round a 2.7km lap, and the band a chase camera actually looks
// into — the first thirty metres past the barrier — is the one band `world/`
// deliberately reserves for cones, drums and trestles.
//
// ── three things this is careful about ─────────────────────────────────────
//
//   1. **The geometry is not drawn here.** `pineStandGeo` is imported from
//      `world/landprops.ts`. Two conifers on one hillside, drawn by two
//      modules, is the exact coherence fault this file exists to answer.
//   2. **It stands on the ground, not on the road.** Every stand is dropped by
//      the same `terrainHeight()` the skirt is clamped against, queried at the
//      *nearest* road rather than the one the belt is being walked along — so
//      where the circuit folds back over itself, as the neck of the gorge does
//      at 120 metres, a tree planted off the climb lands on the ground the
//      plunge established and not forty metres in the air.
//   3. **It stops below the snow.** A forest growing up through
//      `render/theme.ts`'s snow ramp would undo the one cue that makes a
//      mountain read as a mountain, so anything standing more than `ceiling`
//      metres above the road beside it is dropped rather than drawn.
//
// Two instanced draws per flank per belt, no shadow casting — `world/index.ts`
// makes the same call for the same reason: *"they are foliage — a shadow of
// one is a mess of thin triangles"*.

/**
 * Metres past the shoulder at which a stand stops being drawn in full.
 *
 * The detailed build is a trunk, four skirts and two snow lines per tree and
 * costs about three times the silhouette. `world/index.ts` splits at 48 metres
 * because it is scattering over a two-hundred-metre band and most of its
 * forest is a long way off; a belt planted from the barrier out is the other
 * way round, so the split has to come in or the whole thing is detailed.
 */
const PINE_NEAR = 24;

function buildTreeline(
  c: ChapterCtx, belts: TreelineDef[], o: HeightOpts, tint: LandPalette,
): void {
  const near: THREE.Matrix4[] = [];
  const far: THREE.Matrix4[] = [];
  const s: SplineSample = c.spline.atDistance(0);
  const probe = new THREE.Vector3();
  const nearSample: SplineSample = c.spline.atDistance(0);
  const at = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const scale = new THREE.Vector3();

  for (let bi = 0; bi < belts.length; bi++) {
    const belt = belts[bi]!;
    const [d0, span] = chapterSpan(c, belt);
    const n0 = belt.near ?? 3;
    const n1 = belt.far ?? 56;
    const density = belt.density ?? 18;
    const ceiling = belt.ceiling ?? 22;
    const sides: (-1 | 1)[] = belt.side ? [belt.side] : [-1, 1];
    // Deterministic, and decorrelated per belt: two belts on one course must
    // not plant the same forest twice.
    const rnd = rand(0x2f81b3 + bi * 9173);

    for (const side of sides) {
      const count = Math.max(1, Math.round((span / 100) * density));
      for (let i = 0; i < count; i++) {
        const d = d0 + span * ((i + rnd() * 0.9) / count);
        c.spline.atDistance(d, s);
        // Biased outward. A belt with a uniform offset puts as many trunks in
        // the first four metres as in the last twenty, which walls the road in
        // at the shoulder and leaves the depth behind it empty — the opposite
        // of a forest, which is thin at its edge and solid behind.
        const off = n0 + (n1 - n0) * Math.pow(rnd(), 0.62);
        const lat = side * (s.width * 0.5 + c.verge + off);
        at.copy(s.pos).addScaledVector(s.right, lat);

        // Where is the ground *really*? Ask the nearest road, not this one.
        probe.set(at.x, 0, at.z);
        c.spline.nearest(probe, nearSample);
        const dx = at.x - nearSample.pos.x;
        const dz = at.z - nearSample.pos.z;
        const beyond = Math.max(0, Math.hypot(dx, dz) - (nearSample.width * 0.5 + c.verge));
        // Nothing plants on the tarmac, or in the two metres of run-off beside
        // it: the barrier footing stands there.
        if (beyond < 1.6) continue;
        const y = terrainHeight(beyond, nearSample.pos.y, at.x, at.z, o);
        if (y - nearSample.pos.y > ceiling) continue;

        const h = 0.62 + rnd() * 0.62;
        at.y = y - 0.4;
        q.setFromAxisAngle(up, rnd() * Math.PI * 2);
        scale.set(h, h * (0.86 + rnd() * 0.3), h);
        const m = new THREE.Matrix4().compose(at, q, scale);
        (beyond < PINE_NEAR ? near : far).push(m);
      }
    }
  }

  const stand = (list: THREE.Matrix4[], detail: boolean): void => {
    if (!list.length) return;
    // Three trees to a stand rather than four, near and far alike. The belt is
    // dense by design, so the missing trunk is behind two others from every
    // angle a player reaches — and it is a quarter of the triangle count of the
    // most expensive object this file builds. Measured: the first cut of this
    // belt put Switchback Summit at 1,008,922 triangles against a rung-0
    // ceiling of a million.
    const geo = pineStandGeo(detail ? 3 : 11, tint, detail ? { count: 3 } : { far: true });
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.72, metalness: 0,
    });
    mat.name = 'treeline';
    c.materials.push(mat);
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = detail ? 'treeline:near' : 'treeline:far';
    for (let i = 0; i < list.length; i++) mesh.setMatrixAt(i, list[i]!);
    mesh.instanceMatrix.needsUpdate = true;
    // Foliage receives and does not cast, exactly as `world/index.ts` decides
    // for the same object: a shadow map of a few hundred thin cones is noise.
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = true;
    mesh.computeBoundingSphere();
    c.root.add(mesh);
  };
  stand(near, true);
  stand(far, false);
}

// ── the skyline: horizontal lines, where the height field only has cones ───
//
// **The finding this exists to answer**, and it is the one that held the whole
// roster at 6.5:
//
//   *"Cone Canyon and Jackhammer Quarry share the same orange-brown ground and
//   the same low-poly conical orange peaks on the horizon, so with the HUD
//   cropped a player cannot tell which round they are driving. Delete the
//   conical orange peaks from the quarry's horizon — that exact silhouette is
//   Cone Canyon's — and replace them with the quarry's own stepped bench
//   profile and the Tip Face, so the horizon states 'pit' instead of
//   'desert'."*
//
// The peaks were `LandmarkDef`s, and no arrangement of them could have been
// anything else. `track/terrain.ts` offers two shapes — a dome and a needle —
// both radially symmetric, both smooth, and both **summed** into one height
// field, so overlapping a ring of them to make a wall gives a taller ring of
// lumps. The primitive is wrong: what makes a pit read as a pit is a
// *horizontal* line repeated up a face, the flat catch bench between two
// blasted lifts, and a horizontal line is a property of a profile rather than
// of a point.
//
// So the horizon is lofted here instead, out of the same ribbon-of-quads
// machinery the chapters use, and it obeys the same three rules: one mesh, no
// clock, nothing that a second boot of the same course would draw differently.
//
// Three things keep it from reading as a bullseye:
//
//   1. **Every lift wanders on its own phase.** The plan radius of each step
//      carries three harmonics with a per-step phase offset, so bench four is
//      not bench three moved outward — the benches pinch together on one
//      bearing and open out on another, the way a face that has been worked
//      unevenly actually does.
//   2. **The crest is broken.** A height wobble that grows with the lift index
//      puts up to half a lift of relief along the top edge, so the skyline is a
//      ragged rampart rather than a ring at one elevation.
//   3. **Bench and face are different materials.** The flats carry fines and
//      the faces carry blasted rock, at a value separation wide enough to
//      survive a kilometre of haze — which is what makes the terrace lines
//      legible at all from the road.

/** One station of a revolved profile: a plan radius, an elevation, and what it is. */
interface Step {
  r: number;
  y: number;
  /** True on a blasted face, false on the flat of a catch bench. */
  face: boolean;
}

/** Radial wander at one bearing, on the phase belonging to one step. */
function wobbleR(th: number, k: number, amp: number): number {
  const p = k * 0.83;
  return amp * (
    0.55 * Math.sin(3 * th + p)
    + 0.30 * Math.sin(5 * th + 1.7 - p * 0.6)
    + 0.15 * Math.sin(8 * th + 4.1 + p * 1.4)
  );
}

/**
 * Revolve a profile about a centre and hand back one mesh.
 *
 * `segs` is the angular resolution; `cap` closes the last station into a point
 * at the axis, which is what turns the same routine from a rim (an annulus,
 * open in the middle, with the circuit inside it) into a tip (a solid heap).
 */
function loftProfile(
  steps: Step[], cx: number, cz: number, segs: number,
  wander: number, crestJitter: number, ellipse: number, bearing: number,
  rock: number, fines: number, cap: boolean, inward = false,
): THREE.BufferGeometry {
  const n = steps.length;
  const pos: number[] = [];
  const uvs: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  const rockC = new THREE.Color(rock);
  const finesC = new THREE.Color(fines);

  // Arc length up the profile, so the strata in `rockFaceTexture` keep one
  // pitch whether a lift is four metres or fourteen.
  const arc: number[] = [0];
  for (let k = 1; k < n; k++) {
    const a = steps[k - 1]!;
    const b = steps[k]!;
    arc.push(arc[k - 1]! + Math.hypot(b.r - a.r, b.y - a.y));
  }

  for (let i = 0; i <= segs; i++) {
    const th = (i / segs) * Math.PI * 2;
    // Elongation along `bearing`. A tip is tipped from one end, so it is longer
    // than it is wide, and a rim that is a perfect circle is a stadium.
    const stretch = 1 + ellipse * Math.cos(2 * (th - bearing));
    for (let k = 0; k < n; k++) {
      const s = steps[k]!;
      const r = Math.max(0, s.r * stretch + wobbleR(th, k, wander));
      const rise = (k / Math.max(1, n - 1));
      const jit = crestJitter * rise
        * (0.6 * Math.sin(2 * th + 0.4) + 0.4 * Math.sin(5 * th + 2.2));
      pos.push(cx + Math.cos(th) * r, s.y + jit, cz + Math.sin(th) * r);
      // u climbs the face (the texture's beds are bands in u); v runs along the
      // wall in metres, so one bearing of rock is not one bearing of stretched
      // rock.
      uvs.push(arc[k]! / 26, (th * (steps[0]!.r + 60)) / 34);
      c.copy(s.face ? rockC : finesC);
      // Lower lifts sit in the shade of the hole, upper lifts catch the sky.
      // The ramp is deliberately shallow: at 0.80..1.10 the bottom of a
      // nine-lift wall went black at dusk and the terrace lines with it, and
      // the terrace lines are the only reason this object exists.
      c.multiplyScalar(0.88 + 0.24 * rise);
      // Long-wavelength mottle so a forty-metre quad is not one flat value.
      c.multiplyScalar(1 + 0.09 * Math.sin(th * 6.3 + k * 1.7));
      col.push(c.r, c.g, c.b);
    }
  }
  // ── which way the surface faces, and why it is not the same both times ────
  //
  // A heap is seen from outside and a pit wall is seen from inside, and the
  // same winding cannot serve both: the geometric normal of a revolved strip
  // is `(dy, -dr, 0)` in the radial plane, so a profile that widens as it
  // rises (a rim) faces outward and down while one that narrows (a tip) faces
  // outward and up. Wound one way, the entire rim was back-facing from every
  // camera inside the circuit, and what a review frame photographed was four
  // hairlines across the sky where the bench edges caught an odd pixel.
  for (let i = 0; i < segs; i++) {
    for (let k = 0; k < n - 1; k++) {
      const a = i * n + k;
      const b = a + n;
      if (inward) idx.push(a, b, a + 1, a + 1, b, b + 1);
      else idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  if (cap) {
    // A flat top, closed on a centre vertex. A tip that is open at the top is a
    // funnel from any camera above it, and the overhead shot is above it.
    const centre = pos.length / 3;
    const last = steps[n - 1]!;
    pos.push(cx, last.y, cz);
    uvs.push(arc[n - 1]! / 26, 0);
    c.copy(finesC).multiplyScalar(1.06);
    col.push(c.r, c.g, c.b);
    for (let i = 0; i < segs; i++) {
      idx.push(centre, (i + 1) * n + (n - 1), i * n + (n - 1));
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * The benched rim: the wall of the hole, seen from inside it.
 *
 * The profile climbs face → bench → face → bench out of the ground, holds a
 * crest wide enough to be a rim road rather than a knife edge, and then falls
 * away outward so that nothing on the far side has to be modelled. From the
 * pit floor the silhouette is a staircase; from overhead it is a set of
 * concentric contour lines, which is what a quarry looks like on a map.
 */
function buildBenchRim(
  root: THREE.Group, materials: THREE.Material[], d: BenchRimDef,
): void {
  const rock = d.tint ?? 0x7c7f86;
  const fines = d.dust ?? 0x9d9a90;
  const steps: Step[] = [];
  let r = d.radius;
  let y = d.base;
  steps.push({ r, y, face: true });
  for (let k = 0; k < d.lifts; k++) {
    r += d.batter;
    y += d.lift;
    steps.push({ r, y, face: true });
    r += d.bench;
    steps.push({ r, y, face: false });
  }
  // The crest, then the back of the rim going away. Both are outside anything a
  // player can reach; what they buy is a horizon that ends in ground rather
  // than in a cliff edge with sky under it.
  steps.push({ r: r + 74, y, face: false });
  steps.push({ r: r + 190, y: y - d.lift * 2.4, face: true });
  steps.push({ r: r + 330, y: d.base + d.lift, face: true });

  const map = rockFaceTexture(rock);
  // Double-sided: the crest is a knife edge from a chase camera in the pit and
  // a flat top from the overhead shot, and a rim that vanishes when a reviewer
  // presses the one button that shows a course's layout is not a rim.
  const mat = new THREE.MeshLambertMaterial({ map, vertexColors: true, side: THREE.DoubleSide });
  materials.push(mat);
  const geo = loftProfile(
    steps, d.x, d.z, 132, d.wander ?? 46, d.lift * 0.55, 0.07, 0.7,
    rock, fines, false, true,
  );
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'skylineRim';
  // Far enough out that a shadow map has nothing to say about it, and big
  // enough that asking would cost the whole cascade.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  root.add(mesh);
}

/** A stacker: an inclined belt on legs, running up the face of a tip. */
function buildTipBelt(
  root: THREE.Group, materials: THREE.Material[], d: StackDef,
): void {
  const bearing = d.bearing ?? 0;
  const steel = 0x6d777e;
  const st = new Struts();
  // From the foot on the tipping side up to a head pulley standing proud of the
  // top. Built in the tip's own frame and then rotated onto its bearing.
  const r0 = d.foot * 1.02;
  const r1 = d.top * 0.35;
  const y0 = d.base + 1;
  const y1 = d.base + d.height + 11;
  const bays = 9;
  // A stacker on a tip two hundred metres across is half a kilometre from any
  // camera that can see it, so its members are sized off the tip rather than
  // off a walkway: a 0.9m chord on a 200m belt is under a pixel at that range
  // and the whole structure disappears into the haze it was built to stand
  // against.
  const t = Math.max(1.1, d.foot * 0.026);
  const deep = t * 3.6;
  for (let i = 0; i < bays; i++) {
    const t0 = i / bays;
    const t1 = (i + 1) / bays;
    const ax = r0 + (r1 - r0) * t0;
    const bx = r0 + (r1 - r0) * t1;
    const ay = y0 + (y1 - y0) * t0;
    const by = y0 + (y1 - y0) * t1;
    for (const dz of [-deep * 0.7, deep * 0.7]) {
      st.add(ax, ay, dz, bx, by, dz, t);
      st.add(ax, ay - deep, dz, bx, by - deep, dz, t * 0.8);
      st.add(ax, ay, dz, ax, ay - deep, dz, t * 0.7);
      st.add(ax, ay - deep, dz, bx, by, dz, t * 0.55);
    }
    // Legs, standing on the face under the belt.
    if (i % 3 === 1) {
      const foot = d.base + d.height * (0.10 + 0.62 * t0);
      st.add(ax, ay - deep, -deep * 0.7, ax, foot, -deep * 0.7, t * 0.9);
      st.add(ax, ay - deep, deep * 0.7, ax, foot, deep * 0.7, t * 0.9);
    }
  }
  const lattice = st.mesh(steel, 'skylineStacker', materials);
  lattice.castShadow = false;
  lattice.receiveShadow = false;
  const g = new THREE.Group();
  g.add(lattice);
  // The head, and the cone of fresh material coming off it. This is the part
  // that says the plant is running.
  const headMat = new THREE.MeshLambertMaterial({ color: 0xf2b705 });
  materials.push(headMat);
  const head = new THREE.Mesh(new THREE.BoxGeometry(t * 6, t * 4, t * 5.4), headMat);
  head.position.set(r1, y1, 0);
  g.add(head);
  const pileMat = new THREE.MeshLambertMaterial({ color: d.dust ?? 0x9d9a90 });
  materials.push(pileMat);
  const pile = new THREE.Mesh(new THREE.ConeGeometry(t * 4.5, t * 6, 12), pileMat);
  pile.position.set(r1 - t * 2, d.base + d.height + t * 3, 0);
  g.add(pile);
  g.position.set(d.x, 0, d.z);
  g.rotation.y = -bearing;
  root.add(g);
}

/**
 * A spoil tip: flat top, terraced tipping face, stacker up the side.
 *
 * The same loft as the rim with a cap on it, and deliberately elongated: the
 * one thing on a quarry skyline that is *not* the pit needs a silhouette of its
 * own, and a heap tipped from one end is a wedge rather than a dome.
 */
function buildStack(
  root: THREE.Group, materials: THREE.Material[], d: StackDef,
): void {
  const rock = d.tint ?? 0x84837c;
  const fines = d.dust ?? 0xa9a396;
  const lifts = d.lifts ?? 5;
  const steps: Step[] = [];
  const rise = d.height / lifts;
  const run = (d.foot - d.top) / lifts;
  let r = d.foot;
  let y = d.base;
  steps.push({ r: r + 34, y: y - 14, face: true });
  steps.push({ r, y, face: true });
  for (let k = 0; k < lifts; k++) {
    // The split is what a terrace *is*: a shallow bench is a bevel on a cone
    // and reads as one. Nearly half the run goes into the flat, so from half a
    // kilometre away the tip is a stack of horizontal lines rather than a
    // smooth heap with a texture on it.
    r -= run * 0.58;
    y += rise;
    steps.push({ r, y, face: true });
    r -= run * 0.42;
    steps.push({ r, y, face: false });
  }
  const map = rockFaceTexture(rock);
  const mat = new THREE.MeshLambertMaterial({ map, vertexColors: true, side: THREE.DoubleSide });
  materials.push(mat);
  const geo = loftProfile(
    // The crest jitter is held well under a lift: at half of one, the wander on
    // bench four crosses bench three and the terrace lines stop being lines.
    steps, d.x, d.z, 72, d.foot * 0.10, rise * 0.26, 0.26, d.bearing ?? 0,
    rock, fines, true,
  );
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'skylineStack';
  // A stack may be a horizon two kilometres out or a butte standing in an
  // infield eighty metres from the barrier, and the near one has to sit on the
  // ground rather than hover over it. The shadow camera's own frustum culls the
  // far ones, so this costs nothing where it would not have paid.
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  if (d.stacker) buildTipBelt(root, materials, d);
}

function buildSkyline(
  root: THREE.Group, materials: THREE.Material[], sky: SkylineDef,
): void {
  if (sky.rim) buildBenchRim(root, materials, sky.rim);
  for (const t of sky.stacks ?? []) buildStack(root, materials, t);
}

// ── the enclosure: the one place in the cup with no sky in it ──────────────
//
// **The finding.** *"All four rounds are the same kind of place — a wide
// asphalt ribbon on open ground under the same midday blue sky. B is Mount
// Wario section three, and B wins because B changes what kind of place you are
// in mid-course and A does not change it across four whole courses."*
//
// Everything above this line is an **outdoor** noun. A cutting narrows the sky
// to a strip, a viaduct puts the ground a long way down, a portal is one arch
// you are through in half a second. None of them takes the key light off the
// road, and taking the key light off the road is the only thing that changes
// what kind of place a player is in without moving them somewhere else.
//
// ── what it is made of, and the one number that decides all of it ──────────
//
// A gallery is a shed roof standing on a wall and a row of piers, and the
// number is **the pitch of the piers**. At 9 metres and 50 m/s that is five and
// a half bars of sun across the bonnet every second, which is fast enough to
// read as speed and slow enough that each one is a separate event. Everything
// else follows from it: the ribs sit on the pier stations so the soffit has the
// same rhythm as the floor, and the lamps sit on the half-stations so the two
// runs beat against each other instead of marching in step.
//
// The bars are **real shadows**, not painted ones. `render/lighting.ts` gives
// the key a 62-metre shadow extent around the player, so the deck and the piers
// cast onto a road that already declares `receiveShadow` in `track/road.ts`, and
// the strobe therefore tracks the actual sun the course declared rather than a
// texture that would be wrong the moment anybody changed the azimuth.
//
// ── and why the roof falls toward the valley ───────────────────────────────
//
// Because that is what makes the frame asymmetric, which is the whole trick.
// A tube is dark on both sides and is the same picture as a cutting with the
// lights off. A shed has a black wall and a lamp run to one hand and a row of
// hot slots onto a hundred-metre drop to the other, and no other frame in this
// game is lit from one side only.
//
// Cost: six draw calls for two hundred metres of road — body, soffit, deck and
// mouths as four merged meshes, plus one InstancedMesh of ribs and one of
// lamps. Nothing here runs after `init`.

/**
 * Shuttered concrete. `u` runs **up** the wall and `v` along the road in metres,
 * the same convention `rockFaceTexture` uses, so canvas x is height and canvas
 * y is along-track.
 */
function galleryConcreteTexture(tint: number): THREE.CanvasTexture {
  const key = `kit:gallery:${tint.toString(16)}`;
  return tex(key, 256, 256, (g, W, H) => {
    const rnd = rand(0x51c0de ^ tint);
    const base = new THREE.Color(tint);
    const hex = (f: number): string => `#${_shade.copy(base).multiplyScalar(f).getHexString()}`;
    g.fillStyle = hex(1);
    g.fillRect(0, 0, W, H);
    // Lift joints: concrete goes in horizontal pours, so a joint is a line at
    // constant height — constant x — and the pour above it is a shade off the
    // pour below. Wide bands, because a wall whose every board reads separately
    // photographs as corrugation.
    let x = 0;
    while (x < W) {
      const lift = 26 + rnd() * 34;
      g.fillStyle = hex(0.86 + rnd() * 0.26);
      g.fillRect(x, 0, lift, H);
      g.fillStyle = 'rgba(16,18,24,0.34)';
      g.fillRect(x, 0, 2, H);
      // Form-board grain inside the lift.
      for (let k = x + 4; k < x + lift; k += 5 + rnd() * 3) {
        g.fillStyle = `rgba(255,255,255,${(rnd() * 0.05).toFixed(3)})`;
        g.fillRect(k, 0, 1.5, H);
      }
      x += lift;
    }
    // Panel joints across the wall: constant along-track distance, so a line at
    // constant y. This is the only thing in the texture that tells a driver how
    // fast the wall is going past.
    for (let y = 0; y < H; y += 32) {
      g.fillStyle = 'rgba(14,16,22,0.30)';
      g.fillRect(0, y, W, 1.5);
      // Tie-rod plugs, two per panel.
      for (let i = 0; i < 2; i++) {
        g.fillStyle = 'rgba(20,22,28,0.26)';
        g.fillRect(W * (0.28 + i * 0.34), y + 12, 4, 4);
      }
    }
    // Water staining runs *down* the wall, so it is a streak along x, heaviest
    // under the joints. A grey wall with no streaks is a grey card.
    for (let i = 0; i < 260; i++) {
      const y = rnd() * H;
      const x0 = rnd() * W * 0.7;
      g.fillStyle = `rgba(28,30,38,${(0.05 + rnd() * 0.14).toFixed(3)})`;
      g.fillRect(x0, y, 6 + rnd() * 52, 1 + rnd() * 2);
    }
    // Snow and salt bloom along the top of the wall and grime at the toe: the
    // two ends of a wall on a mountain pass are never the same colour.
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, 'rgba(14,16,22,0.46)');
    grad.addColorStop(0.30, 'rgba(14,16,22,0.06)');
    grad.addColorStop(0.86, 'rgba(238,246,252,0.00)');
    grad.addColorStop(1, 'rgba(238,246,252,0.24)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
  });
}

/** The deck: old snow lying on concrete, drifted along the road. */
function galleryDeckTexture(): THREE.CanvasTexture {
  return tex('kit:gallerydeck', 256, 256, (g, W, H) => {
    const rnd = rand(0x2ad51f);
    g.fillStyle = '#E8EFF6';
    g.fillRect(0, 0, W, H);
    // Drift ridges run along the road, so they are bands at constant u.
    for (let i = 0; i < 26; i++) {
      const x = rnd() * W;
      g.fillStyle = `rgba(168,190,212,${(0.10 + rnd() * 0.22).toFixed(3)})`;
      g.fillRect(x, 0, 3 + rnd() * 16, H);
    }
    for (let i = 0; i < 340; i++) {
      g.fillStyle = `rgba(255,255,255,${(rnd() * 0.5).toFixed(3)})`;
      g.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 8, 2 + rnd() * 5);
    }
    // Blown-clear concrete along both edges, where the wind scours it.
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, 'rgba(120,126,138,0.62)');
    grad.addColorStop(0.16, 'rgba(120,126,138,0.00)');
    grad.addColorStop(0.86, 'rgba(120,126,138,0.00)');
    grad.addColorStop(1, 'rgba(120,126,138,0.55)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
  });
}

/** The mouth: hazard chevrons round a black hole, readable at 200 metres. */
function galleryMouthTexture(accent: number): THREE.CanvasTexture {
  const key = `kit:gallerymouth:${accent.toString(16)}`;
  return tex(key, 256, 64, (g, W, H) => {
    g.fillStyle = '#20242C';
    g.fillRect(0, 0, W, H);
    g.fillStyle = `#${new THREE.Color(accent).getHexString()}`;
    for (let x = -H; x < W + H; x += H * 1.6) {
      g.beginPath();
      g.moveTo(x, H);
      g.lineTo(x + H * 0.8, 0);
      g.lineTo(x + H * 1.6, 0);
      g.lineTo(x + H * 0.8, H);
      g.closePath();
      g.fill();
    }
    // A white lip along the bottom edge — the line the driver actually aims
    // under, and the thing that stops the mouth reading as a flat sticker.
    g.fillStyle = '#F2F7FB';
    g.fillRect(0, H - 7, W, 7);
    g.fillStyle = 'rgba(10,12,16,0.55)';
    g.fillRect(0, 0, W, 5);
  });
}

const _fwd = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _size = new THREE.Vector3();

/**
 * An oriented box on the road frame: `size` is (across, up, along) in metres.
 *
 * `makeBasis` gives the rotation, `setPosition` the translation and `scale`
 * multiplies the basis columns — which applies the scale *inside* the rotation,
 * which is the only order that leaves a pier square to the road on a banked
 * corner.
 */
function boxAt(
  s: SplineSample, lat: number, verge: number, lift: number,
  ax: number, ay: number, az: number, out: THREE.Matrix4,
): THREE.Matrix4 {
  _fwd.crossVectors(s.right, s.up).normalize();
  surfacePoint(s, lat, verge, lift, _pos);
  out.copy(_basis.makeBasis(s.right, s.up, _fwd)).setPosition(_pos);
  return out.scale(_size.set(ax, ay, az));
}

function buildEnclosure(c: ChapterCtx, e: EnclosureDef): void {
  const clear = e.height ?? 8.2;
  const fall = e.fall ?? 2.3;
  const pitch = e.pitch ?? 9;
  const wallSide: -1 | 1 = e.side ?? -1;
  const openSide: -1 | 1 = wallSide === 1 ? -1 : 1;
  const tint = e.tint ?? 0x8f96a2;
  const accent = e.accent ?? 0xe04a2b;
  const lampColor = e.lamp ?? 0xffcf86;
  /** Roof slab thickness, and the depth of the transverse ribs under it. */
  const SLAB = 0.85;
  const RIB = 0.62;
  /** Half-width and half-depth of a pier. */
  const PW = 0.85;
  const PD = 1.55;
  /** How far the deck oversails the pier line. */
  const OVER = 1.9;

  const [d0, span] = chapterSpan(c, e);
  const edge = edgeOf(c.verge);
  const map = galleryConcreteTexture(tint);

  // Two thirds of the declared value. A wall facing sideways under a bright
  // sky picks up half the hemisphere fill whatever colour it is painted, and
  // the inside of a gallery is not a place that is the same value as the snow
  // outside it.
  const bodyMat = new THREE.MeshLambertMaterial({
    map, color: 0xa9aeb6, side: THREE.DoubleSide,
  });
  // The same texture at four tenths of the value. A soffit is the one surface
  // in the game the key light never reaches, so it has to be dark *as
  // authored* — waiting for the shadow map to do it leaves the far half of the
  // gallery lit, because the map only covers 62 metres round the player.
  const soffitMat = new THREE.MeshLambertMaterial({
    map, color: 0x5a6068, side: THREE.DoubleSide,
  });
  const deckMat = new THREE.MeshLambertMaterial({
    map: galleryDeckTexture(), side: THREE.DoubleSide,
  });
  const mouthMat = new THREE.MeshLambertMaterial({
    map: galleryMouthTexture(accent), side: THREE.DoubleSide,
  });
  c.materials.push(bodyMat, soffitMat, deckMat, mouthMat);

  const body = new MeshBuilder();
  const soffit = new MeshBuilder();
  const deck = new MeshBuilder();
  const mouth = new MeshBuilder();

  // Height of the soffit at a lateral offset: level at the wall, `fall` lower
  // at the pier line, carried on out to the oversail.
  const reach = (s: SplineSample): number => edge(s) + OVER;
  const soffitY = (s: SplineSample, lat: number): number => {
    const t = Math.min(1, Math.max(0, (lat * openSide + reach(s)) / (2 * reach(s))));
    return clear - fall * t;
  };

  const opts = { verge: c.verge, from: d0, to: d0 + span, step: 3.0, vScale: 9 };
  const wallAt = (off: number) => (s: SplineSample): number =>
    offsetAt(s, edge(s), off, wallSide);
  const openAt = (off: number) => (s: SplineSample): number =>
    offsetAt(s, edge(s), off, openSide);

  // ── the wall ────────────────────────────────────────────────────────────
  // One double-sided plane on the barrier line, driven well under the road so
  // there is no gap where the camber falls away from it. Four lanes rather
  // than two so the concrete tiles up the wall instead of being stretched.
  //
  // **`u` runs 0..1 over the wall's whole height, not per metre**, and that is
  // the one thing in here that had to be photographed to get right. The
  // concrete texture carries its own tonal ramp — grime at the toe, salt bloom
  // at the crest — which is what gives a flat wall a foot and a top. Tiled by
  // the metre that ramp repeats two and a half times up an eight-metre wall,
  // every band of it reads as a highlight, and the gallery's mountain flank
  // photographed as the *brightest* object in a set piece whose whole job is to
  // be dark. One tile from toe to crest, and the ramp means what it says.
  const wallTop = (s: SplineSample): number => soffitY(s, wallSide * edge(s)) + SLAB;
  const wallH = (s: SplineSample, t: number): number => -2.2 + (wallTop(s) + 2.2) * t;
  const wall: Lane[] = [
    ...[0, 0.34, 0.68, 1].map((t) => ({
      lat: wallAt(0.05),
      lift: (s2: SplineSample) => wallH(s2, t),
      u: t,
    })),
    // A capping shelf and a short back face, so the wall has a *thickness*.
    // Without them it is one plane: from outside the up-course mouth — which is
    // the establishing shot of this whole set piece, taken from the corner
    // before it — an eight-metre wall photographed as a piece of card with a
    // hairline top edge.
    { lat: wallAt(1.35), lift: (s2: SplineSample) => wallH(s2, 1), u: 1.13 },
    { lat: wallAt(1.35), lift: (s2: SplineSample) => wallH(s2, 1) - 3, u: 1.45 },
  ];
  if (wallSide < 0) wall.reverse();
  body.addRibbon(c.spline, wall, { ...opts, vScale: 18 });

  // ── the piers ───────────────────────────────────────────────────────────
  //
  // On the valley side, and they are the clock this whole set piece runs on.
  // Between them is the only daylight in two hundred metres of road.
  const s: SplineSample = c.spline.atDistance(d0);
  const bays = Math.max(3, Math.round(span / pitch));
  const m = new THREE.Matrix4();
  const ribs = new Struts();
  const lampMats: THREE.Matrix4[] = [];
  const a = new THREE.Vector3();
  const b2 = new THREE.Vector3();

  for (let i = 0; i <= bays; i++) {
    const f = i / bays;
    c.spline.atDistance(d0 + span * f, s);
    const lat = openAt(0.05)(s);
    const top = soffitY(s, lat);
    // A pier is four quads round an oriented box; the box helper gives the
    // frame and `addQuad` gives it the same concrete as the wall. It is driven
    // 2.4m under the road plane, because on the valley side of a mountain road
    // the ground beside the tarmac is on its way somewhere else.
    boxAt(s, lat, c.verge, (top - 2.4) * 0.5, PW * 2, top + 2.4, PD * 2, m);
    const p: THREE.Vector3[] = [];
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      for (const sy of [-1, 1] as const) {
        p.push(new THREE.Vector3(sx * 0.5, sy * 0.5, sz * 0.5).applyMatrix4(m));
      }
    }
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      body.addQuad(p[k * 2]!, p[k2 * 2]!, p[k * 2 + 1]!, p[k2 * 2 + 1]!, [0, 0, 0.5, 1.4]);
    }

    // A transverse rib on the same station, hard under the soffit. This is what
    // gives the ceiling the floor's rhythm.
    surfacePoint(s, wallSide * (edge(s) - 0.2), c.verge, soffitY(s, wallSide * edge(s)) - RIB * 0.5, a);
    surfacePoint(s, lat, c.verge, top - RIB * 0.5, b2);
    ribs.add(a.x, a.y, a.z, b2.x, b2.y, b2.z, RIB);

    // Lamps on the half-stations, so the two runs beat against each other.
    if (i < bays) {
      c.spline.atDistance(d0 + span * ((i + 0.5) / bays), s);
      const ly = soffitY(s, wallSide * edge(s)) - 0.55;
      lampMats.push(boxAt(
        s, wallSide * (edge(s) - 2.1), c.verge, ly, 2.6, 0.30, 0.62, new THREE.Matrix4(),
      ));
    }
  }

  // ── the roof ────────────────────────────────────────────────────────────
  //
  // Three ribbons and no more: the soffit a driver is under, the deck an
  // avalanche crosses, and the fascia joining them at the valley edge, which is
  // the only part of it visible from the other side of the gorge.
  //
  // Five lanes across, and the `u` on each is *metres from the wall over 4.6*,
  // so the concrete on the ceiling tiles at exactly the pitch it does on the
  // wall it grows out of. A roof whose texture is stretched to fit reads as a
  // painted plane the first time the camera gets under it.
  const roofLats: Array<(s: SplineSample) => number> = [
    wallAt(0.05),
    (s2) => wallSide * edge(s2) * 0.5,
    () => 0,
    (s2) => openSide * edge(s2) * 0.5,
    openAt(OVER),
  ];
  const soffitLanes: Lane[] = roofLats.map((lat) => ({
    lat,
    lift: (s2: SplineSample) => soffitY(s2, lat(s2)),
    u: (s2: SplineSample) => (lat(s2) * openSide + edge(s2)) / 12,
  }));
  const deckLanes: Lane[] = roofLats.map((lat) => ({
    lat,
    lift: (s2: SplineSample) => soffitY(s2, lat(s2)) + SLAB,
    u: (s2: SplineSample) => (lat(s2) * openSide + edge(s2)) / 9,
  }));
  // The edge beam, and it is not trim. It hangs 1.25m *below* the soffit along
  // the valley side, which takes that much off the height of every opening
  // between the piers: without it a 26-metre gallery has a six-metre-tall slot
  // down one flank and photographs as a carport. With it the slot is under five
  // and the frame is a corridor.
  const fascia: Lane[] = [
    { lat: openAt(OVER), lift: (s2) => soffitY(s2, openSide * reach(s2)) + SLAB + 0.75, u: 0 },
    { lat: openAt(OVER), lift: (s2) => soffitY(s2, openSide * reach(s2)) - 1.25, u: 0.62 },
  ];
  if (openSide < 0) { soffitLanes.reverse(); deckLanes.reverse(); fascia.reverse(); }
  soffit.addRibbon(c.spline, soffitLanes, opts);
  deck.addRibbon(c.spline, deckLanes, opts);
  body.addRibbon(c.spline, fascia, opts);

  // ── the two mouths ──────────────────────────────────────────────────────
  //
  // The face of the slab, chevroned. From up the road this is a bright band
  // over a black rectangle, which is the read the whole set piece is aimed at:
  // a thing to drive *into*, visible from the corner before it.
  for (const [d, dir] of [[d0, -1], [d0 + span, 1]] as const) {
    c.spline.atDistance(d, s);
    const lw = wallAt(0.05)(s);
    const lo = openAt(OVER)(s);
    const yw = soffitY(s, wallSide * edge(s));
    const yo = soffitY(s, openSide * reach(s));
    const q = (lat: number, lift: number): THREE.Vector3 =>
      surfacePoint(s, lat, c.verge, lift, new THREE.Vector3());
    const p0 = q(lw, yw);
    const p1 = q(lo, yo);
    const p2 = q(lw, yw + SLAB + 0.75);
    const p3 = q(lo, yo + SLAB + 0.75);
    if (dir < 0) mouth.addQuad(p1, p0, p3, p2, [0, 0, 3.4, 1]);
    else mouth.addQuad(p0, p1, p2, p3, [0, 0, 3.4, 1]);
  }

  const add = (bd: MeshBuilder, mat: THREE.Material, name: string, cast: boolean): void => {
    if (!bd.vertexCount) return;
    const mesh = new THREE.Mesh(bd.toGeometry(), mat);
    mesh.name = `enclosure:${name}:${e.name}`;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    c.root.add(mesh);
  };
  add(body, bodyMat, 'body', true);
  add(soffit, soffitMat, 'soffit', false);
  add(deck, deckMat, 'deck', true);
  add(mouth, mouthMat, 'mouth', true);

  if (ribs.list.length) {
    c.root.add(ribs.mesh(shade(tint, 0.52), `enclosure:ribs:${e.name}`, c.materials));
  }
  if (lampMats.length) {
    // `MeshBasicMaterial`, untoned: the lamp run is the only light source in
    // the gallery and a lamp that dims with the exposure is a painted lamp.
    const lm = new THREE.MeshBasicMaterial({ color: lampColor, toneMapped: false });
    c.materials.push(lm);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), lm, lampMats.length);
    mesh.name = `enclosure:lamps:${e.name}`;
    for (let i = 0; i < lampMats.length; i++) mesh.setMatrixAt(i, lampMats[i]!);
    mesh.instanceMatrix.needsUpdate = true;
    c.root.add(mesh);
  }
}

// ── the skirt that folds over itself ───────────────────────────────────────
//
// **This is the camera-underground bug, and it is measured on these courses.**
//
// A player reported *"the screen just went brown above the racer and you can't
// see them"*. `tools/underground.mjs` reproduces it: the chase lens ends up
// inside the landscape on 51 of 171 samples at Jackhammer Quarry and 24 of 171
// at Switchback Summit — the mountain's worst is **9.5 metres under, at t=0,
// with the kart sitting on the start grid**. The ray comes back with three and
// four stacked surfaces at a single XZ.
//
// ── what it actually is ────────────────────────────────────────────────────
//
// `track/terrain.ts` builds the landscape in two pieces. The **field** is a
// heightfield: every vertex asks `spline.nearest()` which road is closest and
// takes its elevation, so it is right everywhere by construction. The **skirt**
// is *swept* — for each station on the centreline it lays nine rings out to
// 150 metres, all anchored to **that station's** elevation, and it never asks
// what else is nearby.
//
// On a circuit that never comes back near itself that is the same answer. On
// one that folds, it is not:
//
//     course              stations with another road >5m above them inside 165m
//     Cone Canyon          82   worst +11.2m     passes: 5.99m of clearance
//     Saltpan Bypass       21   worst +11.2m     passes: 6.04m
//     Jackhammer Quarry   171   worst +40.4m     FAILS:  4.15m under
//     Switchback Summit   211   worst +62.4m     FAILS:  9.49m under
//
// So the skirt of the weighbridge — 40 metres above the pit floor and 139
// metres from it in plan — is a shelf hanging in the air over the pit floor's
// road, and the chase camera drives straight into the underside of it. The
// arithmetic is not subtle: a skirt sits about 5.75m below its own road and
// drifts a fifth of the way toward the datum by 150m out, so it clears a road
// **about nine metres** below it and buries everything under that. Cone Canyon
// and Saltpan are inside that budget. The pit and the mountain are not, by a
// factor of four and seven.
//
// ── why this is not fixed in the layout ────────────────────────────────────
//
// It was the obvious answer and it is the wrong one, and it took a measurement
// to know that. Getting Jackhammer inside the nine-metre budget means cutting
// the pit from 42 metres deep to about 12, and getting Switchback inside it
// means deleting its 115-metre climb — which is the single measurement the last
// review round *praised*: "elevation 115.2m switchback vs 13.6m saltpan, 8.5x".
// Trading the cup's whole elevation range for a workaround to a construction
// fault in the landscape builder is not a fix, it is a retreat.
//
// ── what this does instead ─────────────────────────────────────────────────
//
// It gives the skirt the answer the field already has. Every skirt vertex past
// the twenty-metre ring — where the sweep has finished blending out of the
// road's banked frame and is a pure height query — is clamped to the height the
// **nearest** road establishes at its own XZ. Where the swept road *is* the
// nearest road, `d` comes out equal to the ring offset and the clamp is exactly
// the value already there: a no-op, to the bit. Where another road is nearer
// and lower, the shelf drops onto that road's own terrain, which is where the
// two skirts then agree instead of stacking.
//
// It only ever lowers, it changes nothing on a circuit that does not fold, and
// it degrades to nothing the day `terrain.ts` sweeps the skirt against
// `nearest()` itself — which is where this belongs and is not this module's
// file. See the report.
//
// The height function below is terrain.ts's, verbatim. It is the **third** copy
// in the repo: `world/place.ts` already carries one, privately, for exactly the
// same reason ("there is no runtime 'how high is the ground here' to call").
// Three mirrors of one function is a defect of its own and the fix is one
// exported `terrainHeight` in `track/terrain.ts`.

interface HeightOpts {
  groundY: number;
  rimStart: number;
  rimEnd: number;
  rimHeight: number;
  landmarks: ReadonlyArray<{ x: number; z: number; radius: number; height: number; kind?: string }>;
}

/** terrain.ts's height function, verbatim. `d` is metres beyond the shoulder. */
function terrainHeight(d: number, sy: number, x: number, z: number, o: HeightOpts): number {
  const embankment = 0.35 + 5.4 * smoothstep(0, 26, d);
  const ref = sy + (o.groundY - sy) * smoothstep(70, 340, d);
  const hills = fbm(x / 260, z / 260) * 26 * smoothstep(55, 320, d);
  const dunes = fbm(x / 150 + 11, z / 150 - 7) * 3.6 * smoothstep(20, 110, d);

  const gate = smoothstep(o.rimStart, o.rimEnd, d);
  const plateau = smoothstep(0.40, 0.57, noise2(x / 420 + 3, z / 420 + 5));
  const terrace = 0.42 + 0.58 * smoothstep(0.34, 0.52, noise2(x / 165 + 9, z / 165 - 4));
  const erosion = 0.86 + 0.14 * noise2(x / 58 - 21, z / 58 + 13);
  const rim = plateau * terrace * erosion * o.rimHeight * gate;

  let hero = 0;
  for (let i = 0; i < o.landmarks.length; i++) {
    const lm = o.landmarks[i]!;
    const r = Math.hypot(x - lm.x, z - lm.z) / lm.radius;
    if (r >= 1.35) continue;
    const shape = lm.kind === 'spire'
      ? Math.pow(Math.max(0, 1 - r), 2.2)
      : 1 - smoothstep(0.52, 1.05, r);
    const wobble = 0.84 + 0.16 * noise2(x / 44 + lm.x * 0.01, z / 44 + lm.z * 0.01);
    hero += lm.height * shape * wobble * smoothstep(o.rimStart * 0.7, o.rimStart * 1.5, d);
  }
  return ref - embankment + hills + dunes + rim + hero;
}

/** Columns in the skirt — `RINGS.length` in terrain.ts, mirrored in place.ts. */
const SKIRT_COLS = 9;
/** The first ring at which the sweep has fully left the road's banked frame. */
const SKIRT_FREE_COL = 4;

const _probe = new THREE.Vector3();

function unfoldSkirt(track: Track, spline: TrackSpline, verge: number): number {
  const mesh = track.group.getObjectByName('embankment') as THREE.Mesh | undefined;
  if (!mesh?.isMesh) return 0;
  const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!attr) return 0;
  // Both sides of the circuit are laid out as whole rings of nine, so a
  // vertex's column is its index modulo nine. If terrain.ts ever changes the
  // ring table this stops being true, and the clamp falls back to a five-metre
  // margin rather than guessing — it does less, never something wrong.
  const layout = attr.count % (SKIRT_COLS * 2) === 0;

  const t = features(track.course).terrain ?? {};
  const o: HeightOpts = {
    groundY: track.course.groundY ?? -8,
    rimStart: t.rimStart ?? 260,
    rimEnd: t.rimEnd ?? 560,
    rimHeight: t.rimHeight ?? 42,
    landmarks: t.landmarks ?? [],
  };

  const s: SplineSample = spline.atDistance(0);
  let moved = 0;
  for (let i = 0; i < attr.count; i++) {
    const x = attr.getX(i), y = attr.getY(i), z = attr.getZ(i);
    _probe.set(x, 0, z);
    spline.nearest(_probe, s);
    const dx = x - s.pos.x, dz = z - s.pos.z;
    const d = Math.max(0, Math.hypot(dx, dz) - (s.width * 0.5 + verge));
    const ceiling = terrainHeight(d, s.pos.y, x, z, o);
    // Inside the twenty-metre ring the sweep is still partly in the road's
    // banked frame, which legitimately stands above the level height by a few
    // metres on a cambered corner. Past it the two are the same query — but not
    // to the centimetre, because the hill and dune terms are scaled by `d` and
    // `nearest()` answers with the closest *sample* rather than the exact foot
    // of the perpendicular. A metre and a half of slack covers that and is
    // nothing next to the tens of metres a real shelf stands proud by.
    const margin = layout && i % SKIRT_COLS >= SKIRT_FREE_COL ? 1.5 : 5.0;
    // Dropped a little *under* the ceiling rather than onto it. A foreign
    // shelf lowered to exactly the local terrain height is coplanar with the
    // local skirt that is already there, and two coplanar surfaces are a
    // shimmer. Under it, it is simply gone.
    if (y > ceiling + margin) { attr.setY(i, ceiling - 0.8); moved++; }
  }
  if (!moved) return 0;
  attr.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingSphere();
  return moved;
}

// ── the system ─────────────────────────────────────────────────────────────

/** Seconds the board holds green after the flag before going dark. */
const GO_HOLD = 1.6;

const NONE: readonly number[] = [];
const ALL = [0, 1, 2, 3, 4] as const;
const LAMP_GREEN = 0x3cff6b;

export function createCourseKitSystem(ctx: GameContext): GameSystem {
  let root: THREE.Group | null = null;
  let materials: THREE.Material[] = [];
  let banner: THREE.Object3D | null = null;
  let lamps: THREE.Mesh[] = [];
  let green: THREE.MeshBasicMaterial | null = null;
  let red: THREE.Material | null = null;
  let clock = 0;
  /** Seconds since the flag while the board holds green. -1 when dark. */
  let goT = -1;

  function setLamps(on: readonly number[], mat: THREE.Material | null): void {
    for (let i = 0; i < lamps.length; i++) {
      const b = lamps[i]!;
      b.visible = on.includes(i);
      if (mat) b.material = mat;
    }
  }

  ctx.bus.on<{ n: number }>('race:countdown', ({ n }) => {
    if (!lamps.length) return;
    if (n > 0) setLamps(config.race.startLights[n] ?? NONE, red);
    else setLamps(ALL, green);
  });
  ctx.bus.on('race:racing', () => { goT = 0; });
  ctx.bus.on('race:intro', () => { goT = -1; setLamps(NONE, red); });

  function dispose(): void {
    if (root) {
      ctx.scene.remove(root);
      root.traverse((o) => { (o as THREE.Mesh).geometry?.dispose(); });
      root = null;
    }
    for (const m of materials) m.dispose();
    materials = [];
    banner = null;
    lamps = [];
    green = null;
    red = null;
    goT = -1;
  }

  /**
   * Hide a stock piece the course has replaced.
   *
   * `visible = false` rather than removal: `track/index.ts` owns those objects,
   * rebuilds them with the road and disposes them with it, and a system that
   * *removed* them would be quietly leaking whatever it took out of a group
   * somebody else is about to dispose. Hiding is reversible, costs one boolean
   * and leaves the ownership where it was.
   */
  function hide(group: THREE.Object3D, name: string): void {
    const o = group.getObjectByName(name);
    if (o) o.visible = false;
  }

  /**
   * Repaint the parts of the road that road.ts builds one of.
   *
   * Only the material's `map` is swapped, which is exactly what
   * `render/ground.ts` does to the shoulder gravel and for the same stated
   * reason: the mesh, the material, its vertex colours (which carry the baked
   * kerb shadow) and its shading stay road.ts's.
   */
  function repaint(track: Track, name: string, next: THREE.Texture): void {
    const mesh = track.group.getObjectByName(name) as THREE.Mesh | undefined;
    if (!mesh?.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      const withMap = mat as THREE.Material & { map?: THREE.Texture | null };
      if (!withMap.map) continue;
      // The builders cache by key and hand back shared instances, so the wrap
      // and repeat the road chose have to be carried across by hand.
      next.wrapS = withMap.map.wrapS;
      next.wrapT = withMap.map.wrapT;
      next.repeat.copy(withMap.map.repeat);
      next.anisotropy = withMap.map.anisotropy;
      withMap.map = next;
      mat.needsUpdate = true;
    }
  }

  function build(track: Track): void {
    dispose();
    const course: CourseDef = track.course;
    // `Track` publishes the spline as `TrackSplineLike` — the read-only subset
    // other modules are allowed to depend on. The ribbon builder wants the
    // class, and every member it touches (`length`, `atDistance`, `nearest`) is
    // in the published subset, so this narrows rather than widens what is
    // depended on.
    const spline = track.spline as unknown as TrackSpline;
    const verge = course.vergeWidth ?? 5;

    // Before anything is built on it: stop the landscape from hanging over its
    // own road. Runs for every course, kit or no kit — a circuit that does not
    // fold is untouched to the bit. See `unfoldSkirt`.
    unfoldSkirt(track, spline, verge);

    const kit = features(course).kit;
    const spans = features(course).enclosures;
    const sky = features(course).skyline;
    if (!kit && !spans?.length && !sky) return;

    root = new THREE.Group();
    root.name = 'courseKit';

    // ── the horizon ─────────────────────────────────────────────────────────
    //
    // Off `features` rather than off `kit`, and first, for the same reason the
    // enclosures are: a skyline is not a livery choice, it is what kind of
    // place the course is in. See `SkylineDef`.
    if (sky) buildSkyline(root, materials, sky);

    const chapterCtx: ChapterCtx = {
      spline,
      verge,
      root,
      materials,
      start: course.startDistance ?? 0,
      L: spline.length,
    };

    // ── the enclosures ──────────────────────────────────────────────────────
    //
    // Off `features` rather than off `kit`, and built before anything else in
    // here. An enclosure is not a livery choice — it is a stretch of road where
    // the sun stops reaching the tarmac — so a course may have one without
    // declaring a kit at all. See `EnclosureDef`.
    if (spans?.length) for (const e of spans) buildEnclosure(chapterCtx, e);

    if (!kit) { ctx.scene.add(root); return; }

    // ── the road's own paint ────────────────────────────────────────────────
    if (kit.kerb) {
      repaint(track, 'kerbs', makeKerbTexture({ a: kit.kerb.a, b: kit.kerb.b }));
      const mesh = track.group.getObjectByName('kerbs') as THREE.Mesh | undefined;
      const mat = mesh?.material as (THREE.Material & { map?: THREE.Texture | null }) | undefined;
      // The kerb ribbon is laid at 5.5m of track per unit of v, so a stripe
      // pair asked for in metres is that over the pitch.
      if (mat?.map && kit.kerb.pitch) mat.map.repeat.y = 5.5 / kit.kerb.pitch;
    }
    if (kit.paint) repaint(track, 'markings', makePaintTexture(kit.paint));
    if (kit.chequer) {
      repaint(track, 'startLine', makeCheckerTexture(2, kit.chequer.dark, kit.chequer.light));
    }

    // ── the barrier ─────────────────────────────────────────────────────────
    const barrier: BarrierKind = kit.barrier ?? 'panel';
    if (barrier !== 'panel' && course.walls !== false) {
      for (const n of ['barrierPanels', 'barrierBase', 'barrierPosts']) hide(track.group, n);
      const bc: BarrierCtx = {
        spline,
        verge,
        edge: (s) => s.width * 0.5 + verge,
        root,
        materials,
      };
      if (barrier === 'jersey') buildJersey(bc);
      else if (barrier === 'seawall') buildSeawall(bc);
      else buildSnowFence(bc);
    }

    // ── the chapters ────────────────────────────────────────────────────────
    //
    // Built before the arrival structure so that a chapter which runs over the
    // start line is under it rather than through it. See `ChapterDef`.
    if (kit.chapters?.length) buildChapters(chapterCtx, kit.chapters);

    // ── what grows beside the road ──────────────────────────────────────────
    //
    // After the chapters, so a belt declared across a cutting plants on the
    // ground behind the face rather than inside it. See `buildTreeline`.
    if (kit.treeline?.length) {
      const t = features(course).terrain ?? {};
      buildTreeline(chapterCtx, kit.treeline, {
        groundY: course.groundY ?? -8,
        rimStart: t.rimStart ?? 260,
        rimEnd: t.rimEnd ?? 560,
        rimHeight: t.rimHeight ?? 42,
        landmarks: t.landmarks ?? [],
      }, LAND_PALETTES[resolveTheme(course.theme).land]);
    }

    // ── the arrival ─────────────────────────────────────────────────────────
    const arrival = kit.arrival ?? 'gantry';
    if (arrival !== 'gantry') {
      hide(track.group, 'gantry');
      const d = course.startDistance ?? 0;
      const s = spline.atDistance(d);
      const group = new THREE.Group();
      group.name = `arrival:${arrival}`;
      const at = new THREE.Vector3();
      surfacePoint(s, 0, verge, 0, at);
      const fwd = new THREE.Vector3().crossVectors(s.right, s.up).normalize();
      group.position.copy(at);
      group.setRotationFromMatrix(new THREE.Matrix4().makeBasis(s.right, s.up, fwd));

      const args: BuildArgs = {
        group,
        span: s.width * 0.5 + verge + 2.6,
        kit,
        name: course.name,
        materials,
      };
      const parts = arrival === 'conveyor' ? buildConveyor(args)
        : arrival === 'jetty' ? buildJetty(args)
          : buildPylon(args);
      banner = parts.banner;
      lamps = parts.lamps;
      red = lamps[0]?.material as THREE.Material ?? null;
      green = new THREE.MeshBasicMaterial({ color: LAMP_GREEN, toneMapped: false });
      materials.push(green);
      setLamps(NONE, red);
      root.add(group);
    }

    // ── the same plant, further round the lap ───────────────────────────────
    //
    // See `CrossingDef`. Identical construction to the arrival, minus the
    // signage, plus a skew — because an overland belt is laid where the
    // material has to go and a structure square to the road reads as a gantry.
    for (const cr of kit.crossings ?? []) {
      const L = spline.length;
      const d = ((((course.startDistance ?? 0) + cr.at * L) % L) + L) % L;
      const s = spline.atDistance(d);
      const group = new THREE.Group();
      group.name = `crossing:${cr.kind}`;
      const at = new THREE.Vector3();
      surfacePoint(s, 0, verge, cr.lift ?? 0, at);
      const fwd = new THREE.Vector3().crossVectors(s.right, s.up).normalize();
      group.position.copy(at);
      group.setRotationFromMatrix(new THREE.Matrix4().makeBasis(s.right, s.up, fwd));
      group.rotateY(cr.skew ?? 0);
      const args: BuildArgs = {
        group,
        // The skew lengthens the crossing: a belt laid at thirty degrees off
        // square has to reach further to clear the same road.
        span: (s.width * 0.5 + verge + 3.4) / Math.max(0.5, Math.cos(cr.skew ?? 0)),
        kit,
        name: course.name,
        materials,
        bare: true,
      };
      if (cr.kind === 'jetty') buildJetty(args);
      else buildConveyor(args);
      root.add(group);
    }

    ctx.scene.add(root);
  }

  return {
    name: 'coursekit',
    /**
     * Between the track (20) and the ground bake (21), and it has to be.
     *
     * `core/engine.ts` sorts systems by `order` and initialises them in that
     * sorted order, so `order` is also the order the `track:built` handlers
     * subscribe in and therefore the order they run in. `render/ground.ts`
     * bakes the landscape's vertex colours from its vertex *positions* — so if
     * this ran after it, every skirt vertex `unfoldSkirt` lowers would keep the
     * colour it had thirty metres higher up.
     */
    order: 20.5,

    init(): void {
      ctx.bus.on<{ track: Track }>('track:built', ({ track }) => build(track));
      if (ctx.track) build(ctx.track);
    },

    reset(): void {
      goT = -1;
      setLamps(NONE, red);
    },

    /** Visuals only: the banner breathes and the board holds its green. */
    update(dt: number): void {
      clock += dt;
      if (banner) {
        banner.rotation.x = Math.sin(clock * 1.3) * 0.035;
        banner.rotation.z = Math.sin(clock * 0.9 + 1.1) * 0.012;
      }
      if (goT >= 0) {
        goT += dt;
        if (goT > GO_HOLD) { goT = -1; setLamps(NONE, red); }
      }
    },

    dispose,
  };
}
