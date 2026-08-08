// The minimap.
//
// A kart racer without one is a game where the only information you have about
// the race is what happens to be inside a 70° cone in front of you. This is the
// widget that tells the player they are being caught, that the pack has split,
// and that the hairpin they cannot see yet is coming.
//
// Drawn to a canvas rather than assembled out of DOM. The course outline is
// static — it is rendered once into an offscreen buffer when the track is built
// and blitted every frame — so the per-frame cost is one `drawImage` and eight
// small circles, with no layout, no style invalidation and no allocation.
//
// The course comes off `track.spline`, the only description of the circuit that
// is guaranteed to be true: sample it at even arc-length, take the bounds, and
// fit that into the plate. Any course this game ever ships will map itself.

import { getVehicle } from '../vehicles/registry.ts';
import type { GameContext, Racer, Track } from '../types.ts';
import { blipColor, fromHtml, hexCss, q, unitPx } from './theme.ts';

/** Plate geometry, in `--u`. Cone Canyon is a landscape loop; so is the box. */
const MAP_W = 13.2;
const MAP_H = 9.4;
/** Samples around the loop. 240 is smooth at any size this plate can be. */
const SAMPLES = 240;

/**
 * Blip radius in device pixels, and the ink ring every blip wears.
 *
 * This used to be 2.9 — about six screen pixels of anonymous coloured dot, and
 * three of the four machines in front of the player are red, orange or yellow.
 * A map you have to zoom a screenshot to 8x to read is a map that does nothing
 * at 200km/h. Big enough to carry a hue, with a heavy enough casing that two
 * overlapping blips still show two lobes rather than a blob.
 */
const BLIP_R = 4.4;
const BLIP_RING = 2.0;

/**
 * How far a blip may be nudged off its true position to get out from behind
 * another one, as a multiple of its radius.
 *
 * **The map's whole job breaks down in a pack.** Eight machines racing hard
 * occupy about twenty metres of a four-hundred-metre circuit, and at the scale
 * this plate can offer that is a single coloured smudge — a photograph of it
 * cannot be counted, let alone read. The player loses the one fact they came to
 * the map for: how many are between them and the front, and are they bunched or
 * strung out.
 *
 * So overlapping blips are relaxed apart, and then each one's displacement is
 * clamped: a blip can never be moved further than this off the truth, which at
 * this scale is a couple of kart lengths. The map stays honest about *where*
 * everyone is and stops lying about *how many*.
 */
const DECLUTTER_DRIFT = 1.7;
/** Relaxation passes. Three settles a grid-start eight; the clamp does the rest. */
const DECLUTTER_PASSES = 3;
/** Field size the scratch arrays are sized for. */
const MAX_BLIPS = 24;

export const CSS_MAP = `
/* No course name under the map. It was ~15% of the plate spent telling the
   player which track they are on — a fact they chose, thirty seconds ago, and
   which the track itself is telling them continuously. */
#hud .map-plate { padding: calc(var(--u) * .5) calc(var(--u) * .46) calc(var(--u) * .42); }
#hud .map-plate canvas {
  display: block;
  width: calc(var(--u) * ${MAP_W}); height: calc(var(--u) * ${MAP_H});
}
`;

export interface Minimap {
  readonly root: HTMLElement;
  update(dt: number, alpha: number): void;
  reset(): void;
  dispose(): void;
}

/**
 * The player's arrowhead, as a path — built twice per frame, once fat for the
 * casing and once true for the fill, so the marker has one silhouette.
 *
 * Forward in map space is `(sin yaw, cos yaw)`; the base sits half a radius
 * *behind* the blip's centre so the head grows out of the disc rather than
 * balancing on it.
 */
function noseTri(
  g: CanvasRenderingContext2D, x: number, y: number,
  rad: number, yaw: number, pad: number,
): void {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  // Slim, and sitting *forward* of the blip's centre rather than through it: a
  // wide triangle based behind the middle covers the disc entirely, and then the
  // player's marker is just another solid dot in a different colour. Based ahead
  // of centre it leaves a white crescent behind the point, which is the part
  // that says "this one is you" at a glance.
  const tip = rad * 2.5 + pad * 1.7;
  const side = rad * 0.74 + pad;
  const back = rad * 0.22;
  g.beginPath();
  g.moveTo(x + s * tip, y + c * tip);
  g.lineTo(x + c * side + s * back, y - s * side + c * back);
  g.lineTo(x - c * side + s * back, y + s * side + c * back);
  g.closePath();
}

export function createMinimap(ctx: GameContext): Minimap {
  const root = fromHtml(`
    <div class="plate map-plate">
      <canvas></canvas>
    </div>
  `);

  const canvas = q<HTMLCanvasElement>(root, 'canvas');
  const gc = canvas.getContext('2d');
  const still = document.createElement('canvas');
  const sc = still.getContext('2d');

  // Projection from world XZ into canvas pixels.
  let ox = 0, oz = 0, scale = 1, cx = 0, cy = 0;
  let builtFor = '';
  let clock = 0;
  /**
   * Device pixels per CSS pixel on this canvas, and whether the buffer needs
   * re-measuring.
   *
   * Measured on a resize and on nothing else. The obvious shape — ask for the
   * viewport every frame and rebuild if it moved — puts a viewport read in
   * between the HUD's style writes and the browser's own layout pass, sixty
   * times a second, for an answer that changes when somebody drags a window
   * edge.
   */
  let dpr = 1;
  let sizeDirty = true;

  /** Per-racer blip colour, resolved once a race — `getVehicle` is a map lookup
   *  but the lightness clamp behind it is not free. */
  const colors = new Map<number, string>();
  /** Draw order, sorted in place every frame. Allocated once; eight entries. */
  const order: Racer[] = [];
  /** Blip positions: true, then relaxed. Allocated once, reused every frame. */
  const trueX = new Float32Array(MAX_BLIPS);
  const trueY = new Float32Array(MAX_BLIPS);
  const drawX = new Float32Array(MAX_BLIPS);
  const drawY = new Float32Array(MAX_BLIPS);

  const unsubs: Array<() => void> = [];

  function mapX(x: number): number { return cx + (x - ox) * scale; }
  function mapY(z: number): number { return cy + (z - oz) * scale; }

  /** Resize the buffers to match the CSS box. Returns true if they changed. */
  function ensureSize(): boolean {
    const u = unitPx();
    dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(MAP_W * u * dpr));
    const h = Math.max(1, Math.round(MAP_H * u * dpr));
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    still.width = w;
    still.height = h;
    return true;
  }

  /**
   * Draw the circuit into the offscreen buffer.
   *
   * The road is stroked at its *real* width — the spline knows how wide it is
   * at every station, and at this scale 25 metres of tarmac is about six
   * pixels, which is exactly the weight a minimap wants. A casing stroke goes
   * down first so the ribbon has an edge against the plate, and the start/
   * finish line is laid across it, because a lap map with no line on it does
   * not tell you where the lap ends.
   */
  function buildStatic(track: Track): void {
    if (!sc) return;
    const w = still.width, h = still.height;
    sc.clearRect(0, 0, w, h);

    const spline = track.spline;
    const L = spline.length;
    const xs = new Float32Array(SAMPLES);
    const zs = new Float32Array(SAMPLES);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let width = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const s = spline.atDistance((i / SAMPLES) * L);
      xs[i] = s.pos.x;
      zs[i] = s.pos.z;
      width += s.width;
      if (s.pos.x < minX) minX = s.pos.x;
      if (s.pos.x > maxX) maxX = s.pos.x;
      if (s.pos.z < minZ) minZ = s.pos.z;
      if (s.pos.z > maxZ) maxZ = s.pos.z;
    }
    width /= SAMPLES;

    // Fit, with room for the road's own width and the blips that ride on it.
    const pad = Math.max(5 * dpr, width * 0.5);
    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanZ);
    ox = (minX + maxX) * 0.5;
    oz = (minZ + maxZ) * 0.5;
    cx = w * 0.5;
    cy = h * 0.5;

    const path = new Path2D();
    path.moveTo(mapX(xs[0]!), mapY(zs[0]!));
    for (let i = 1; i < SAMPLES; i++) path.lineTo(mapX(xs[i]!), mapY(zs[i]!));
    path.closePath();

    // A shade wider than true scale. At 200 pixels across, a road drawn to the
    // metre is a hairline, and a hairline is not a map.
    const roadPx = Math.max(4.6 * dpr, Math.min(13 * dpr, width * scale * 1.3));
    sc.lineJoin = 'round';
    sc.lineCap = 'round';

    // Casing, road, and a hairline crown down the middle. Three strokes is all
    // it takes for a grey line to read as a road.
    //
    // **The ribbon is lighter than it was.** At `#6A7180` on a plate whose face
    // runs from `#3C4354` to `#111`, the circuit and the sign it is printed on
    // were four steps apart in value — and the plate carries a chevron texture
    // besides, so the road kept crossing its own stripes and dissolving into
    // them. A map that has to be looked *for* has already failed: this is a
    // glance widget. The road now sits well clear of everything behind it, which
    // also gives the blips a light ground to be dark-rimmed against.
    sc.strokeStyle = 'rgba(8,10,14,.94)';
    sc.lineWidth = roadPx + 3.4 * dpr;
    sc.stroke(path);
    sc.strokeStyle = '#98A2B4';
    sc.lineWidth = roadPx;
    sc.stroke(path);
    sc.strokeStyle = 'rgba(255,248,240,.34)';
    sc.lineWidth = Math.max(0.7, roadPx * 0.16);
    sc.stroke(path);

    drawStartLine(track, roadPx);
    builtFor = track.id;
  }

  /**
   * Start/finish, laid across the road on the course's own line.
   *
   * **Chequered, not a white bar.** The bar read as a join in the ribbon, or as
   * a fleck of the plate showing through — anything but the one place on the
   * circuit that decides the race. Two rows of squares is the universal sign
   * for it, it is the pattern already painted across the real track at that
   * exact point, and it is four `fillRect`s in a rotated frame.
   */
  function drawStartLine(track: Track, roadPx: number): void {
    if (!sc) return;
    const spline = track.spline;
    const a = spline.atDistance(track.course.startDistance ?? 0);
    const nx = -a.tangent.z, nz = a.tangent.x;
    const half = (roadPx * 0.62) / scale;
    const x0 = mapX(a.pos.x - nx * half), y0 = mapY(a.pos.z - nz * half);
    const x1 = mapX(a.pos.x + nx * half), y1 = mapY(a.pos.z + nz * half);
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (!(len > 1)) return;

    const cells = 4;
    const cw = len / cells;
    // Squarish cells, but never so deep that the line reads as a level crossing.
    const ch = Math.min(cw, roadPx * 0.34);
    const pad = 1.1 * dpr;

    sc.save();
    sc.translate((x0 + x1) * 0.5, (y0 + y1) * 0.5);
    sc.rotate(Math.atan2(y1 - y0, x1 - x0));
    sc.fillStyle = 'rgba(9,11,17,.95)';
    sc.fillRect(-len * 0.5 - pad, -ch - pad, len + pad * 2, ch * 2 + pad * 2);
    sc.fillStyle = '#FFF8F0';
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < 2; j++) {
        if ((i + j) % 2) continue;
        sc.fillRect(-len * 0.5 + i * cw, -ch + j * ch, cw, ch);
      }
    }
    sc.restore();
  }

  function ensureBuilt(): void {
    const track = ctx.track;
    if (!track) return;
    if (!sizeDirty && builtFor === track.id) return;
    sizeDirty = false;
    ensureSize();
    buildStatic(track);
  }

  function colorOf(racer: Racer): string {
    let c = colors.get(racer.id);
    if (!c) {
      // How many machines of this kind are already on the grid ahead of it —
      // the field is bigger than the cast, so somebody is always a duplicate.
      let variant = 0;
      for (const other of ctx.racers) {
        if (other === racer) break;
        if (other.vehicleId === racer.vehicleId) variant++;
      }
      c = hexCss(blipColor(getVehicle(racer.vehicleId).colors.primary, variant));
      colors.set(racer.id, c);
    }
    return c;
  }

  /**
   * Push overlapping blips apart, then hold each one near the truth.
   *
   * A few passes of pairwise relaxation — the same thing a label layout does —
   * over at most a couple of dozen points, with no allocation and no sorting.
   * The clamp at the end is what keeps it a readability aid rather than a lie:
   * however crowded the field gets, no blip ends up more than `maxDrift` pixels
   * from where its kart really is, so the shape of the pack on the map is still
   * the shape of the pack on the road.
   */
  function declutter(n: number, sep: number, maxDrift: number): void {
    if (n < 2) return;
    const sep2 = sep * sep;
    for (let pass = 0; pass < DECLUTTER_PASSES; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = drawX[j]! - drawX[i]!;
          let dy = drawY[j]! - drawY[i]!;
          let d2 = dx * dx + dy * dy;
          if (d2 >= sep2) continue;
          // Exactly coincident — a grid start, or two karts in the same skid.
          // Any direction will do so long as it is the same one every frame, or
          // the pair jitters; the index difference gives a stable fan.
          if (d2 < 1e-4) {
            const a = (i * 2.399963 + j * 0.7);
            dx = Math.cos(a);
            dy = Math.sin(a);
            d2 = 1;
          }
          const d = Math.sqrt(d2);
          const push = (sep - d) * 0.5;
          const ux = (dx / d) * push, uy = (dy / d) * push;
          drawX[i] = drawX[i]! - ux; drawY[i] = drawY[i]! - uy;
          drawX[j] = drawX[j]! + ux; drawY[j] = drawY[j]! + uy;
          moved = true;
        }
      }
      if (!moved) break;
    }
    for (let i = 0; i < n; i++) {
      const dx = drawX[i]! - trueX[i]!;
      const dy = drawY[i]! - trueY[i]!;
      const d = Math.hypot(dx, dy);
      if (d <= maxDrift || d < 1e-5) continue;
      const k = maxDrift / d;
      drawX[i] = trueX[i]! + dx * k;
      drawY[i] = trueY[i]! + dy * k;
    }
  }

  unsubs.push(ctx.bus.on('engine:resize', () => { sizeDirty = true; }));
  unsubs.push(ctx.bus.on('track:built', () => { colors.clear(); builtFor = ''; }));

  return {
    root,

    reset(): void {
      colors.clear();
      clock = 0;
      sizeDirty = true;
    },

    update(dt: number, alpha: number): void {
      if (!gc) return;
      clock += dt;
      ensureBuilt();
      if (!builtFor) return;

      const w = canvas.width, h = canvas.height;
      gc.clearRect(0, 0, w, h);
      gc.drawImage(still, 0, 0);

      const player = ctx.player;
      const r = BLIP_R * dpr;
      const ring = BLIP_RING * dpr;

      // Back of the field first, leader last, player over everything.
      //
      // Blips overlap — eight machines on a starting grid occupy about fifteen
      // metres of a four-hundred-metre circuit, and no radius makes that eight
      // separate dots. What *can* be fixed is the order they stack in, which
      // used to be `ctx.racers` order: arbitrary, and unstable frame to frame as
      // karts traded places, so whichever blip was on top flickered. Sorted by
      // progress it is always the same story — the ones you are chasing are the
      // ones on top.
      order.length = 0;
      for (const racer of ctx.racers) {
        if (order.length >= MAX_BLIPS) break;
        order.push(racer);
      }
      for (let i = 1; i < order.length; i++) {
        const item = order[i]!;
        let j = i - 1;
        while (j >= 0 && order[j]!.progress > item.progress) { order[j + 1] = order[j]!; j--; }
        order[j + 1] = item;
      }

      // ── where each blip actually goes ──────────────────────────────────────
      //
      // The interpolated position, not the simulation's — the blips have to ride
      // with the karts they are, or the map swims a step behind at 200km/h.
      const n = order.length;
      for (let i = 0; i < n; i++) {
        const racer = order[i]!;
        trueX[i] = mapX(racer.prevPos.x + (racer.pos.x - racer.prevPos.x) * alpha);
        trueY[i] = mapY(racer.prevPos.z + (racer.pos.z - racer.prevPos.z) * alpha);
        drawX[i] = trueX[i]!;
        drawY[i] = trueY[i]!;
      }
      // Separation is measured to the *casings* — two blips whose ink rims are
      // just touching are two blips, and anything tighter is one lump.
      declutter(n, (r + ring) * 1.55, r * DECLUTTER_DRIFT);

      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < n; i++) {
          const racer = order[i]!;
          const isYou = racer === player;
          // The player is drawn last, over everybody: in a four-kart scrum the
          // one blip that must never be buried is the one the player is.
          if (isYou !== (pass === 1)) continue;

          const x = drawX[i]!;
          const y = drawY[i]!;
          const rad = isYou ? r * 1.24 : r;

          if (isYou) {
            // **A ring leaving the marker, not a haze under it.**
            //
            // What was here was a fill — pale yellow at eighteen percent over a
            // near-black plate, which composites to a khaki disc. It read as a
            // smudge on the glass rather than as the one thing on this map the
            // eye has to find instantly, and it made the player's own blip the
            // *softest* object in the widget.
            //
            // A stroke does the job a fill could not: it is a hard edge, so it
            // survives being drawn over both the light ribbon and the dark
            // plate, and because it expands and fades on a fixed period it is a
            // sonar ping — motion the eye catches in the corner of the frame
            // without ever being asked to look.
            const ping = (clock % 1.15) / 1.15;
            const fade = (1 - ping).toFixed(3);
            gc.beginPath();
            gc.arc(x, y, rad * (1.05 + ping * 1.7), 0, Math.PI * 2);
            // Two strokes, dark under bright — the ring crosses the pale ribbon
            // and the dark plate within one revolution, and a single gold line
            // disappears into the first of those.
            gc.strokeStyle = `rgba(10,12,18,${fade})`;
            gc.lineWidth = 3.4 * dpr;
            gc.stroke();
            gc.strokeStyle = `rgba(255,214,90,${fade})`;
            gc.lineWidth = 1.7 * dpr;
            gc.stroke();
          }

          // ── the casing ─────────────────────────────────────────────────────
          // Every blip wears an ink outline it can hold over both the road and
          // the plate — and for the player that casing includes the nose, so the
          // whole marker is one silhouette rather than a disc with a shape
          // tucked behind it.
          gc.fillStyle = 'rgba(8,10,15,.92)';
          if (isYou) {
            noseTri(gc, x, y, rad, racer.yaw, ring);
            gc.fill();
          }
          gc.beginPath();
          gc.arc(x, y, rad + ring, 0, Math.PI * 2);
          gc.fill();

          gc.beginPath();
          gc.arc(x, y, rad, 0, Math.PI * 2);
          gc.fillStyle = isYou ? '#FFF8F0' : colorOf(racer);
          gc.fill();

          if (isYou) {
            // **The nose goes on last.** It used to be drawn and then painted
            // straight back over by the disc fill and a 1.6px stroke, which left
            // about two pixels of dark smudge poking out of a white circle —
            // legible only at 12x. The whole point of the marker is that the map
            // says which way the player is *pointing*, so the arrowhead sits on
            // top, in safety orange against the white disc it grows out of.
            noseTri(gc, x, y, rad, racer.yaw, 0);
            gc.fillStyle = '#FF6B1A';
            gc.fill();
            gc.lineWidth = 1.3 * dpr;
            gc.strokeStyle = 'rgba(8,10,15,.9)';
            gc.stroke();
          } else if (racer.finished) {
            // Finished machines stop being competition. Fade them back so the
            // map keeps describing the race that is still being run.
            gc.globalAlpha = 0.45;
            gc.beginPath();
            gc.arc(x, y, rad, 0, Math.PI * 2);
            gc.fillStyle = 'rgba(20,24,32,.6)';
            gc.fill();
            gc.globalAlpha = 1;
          }
        }
      }
    },

    dispose(): void {
      for (const off of unsubs) off();
      unsubs.length = 0;
      root.remove();
    },
  };
}
