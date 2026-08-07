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
const BLIP_R = 4.2;
const BLIP_RING = 1.9;

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
    sc.strokeStyle = 'rgba(8,10,14,.92)';
    sc.lineWidth = roadPx + 3.2 * dpr;
    sc.stroke(path);
    sc.strokeStyle = '#6A7180';
    sc.lineWidth = roadPx;
    sc.stroke(path);
    sc.strokeStyle = 'rgba(255,248,240,.28)';
    sc.lineWidth = Math.max(0.7, roadPx * 0.16);
    sc.stroke(path);

    // Start/finish, laid across the road on the course's own line.
    const start = track.course.startDistance ?? 0;
    const a = spline.atDistance(start);
    const nx = -a.tangent.z, nz = a.tangent.x;
    const half = (roadPx * 0.7) / scale;
    sc.beginPath();
    sc.moveTo(mapX(a.pos.x - nx * half), mapY(a.pos.z - nz * half));
    sc.lineTo(mapX(a.pos.x + nx * half), mapY(a.pos.z + nz * half));
    // Dark first, white over it: a bar with its own edge, so the line survives
    // both the pale road it crosses and the dark plate either side of it.
    sc.strokeStyle = 'rgba(10,12,18,.95)';
    sc.lineWidth = Math.max(3.4, 5 * dpr);
    sc.stroke();
    sc.strokeStyle = '#FFF8F0';
    sc.lineWidth = Math.max(1.8, 2.6 * dpr);
    sc.stroke();

    builtFor = track.id;
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
      for (const racer of ctx.racers) order.push(racer);
      for (let i = 1; i < order.length; i++) {
        const item = order[i]!;
        let j = i - 1;
        while (j >= 0 && order[j]!.progress > item.progress) { order[j + 1] = order[j]!; j--; }
        order[j + 1] = item;
      }

      for (let pass = 0; pass < 2; pass++) {
        for (const racer of order) {
          const isYou = racer === player;
          // The player is drawn last, over everybody: in a four-kart scrum the
          // one blip that must never be buried is the one the player is.
          if (isYou !== (pass === 1)) continue;

          // The interpolated position, not the simulation's — the blips have to
          // ride with the karts they are, or the map swims a step behind at
          // 200km/h.
          const x = mapX(racer.prevPos.x + (racer.pos.x - racer.prevPos.x) * alpha);
          const y = mapY(racer.prevPos.z + (racer.pos.z - racer.prevPos.z) * alpha);
          const rad = isYou ? r * 1.24 : r;

          if (isYou) {
            // A soft pulse under the player's blip. It is the one thing on this
            // map the eye has to find instantly.
            const pulse = 0.5 + 0.5 * Math.sin(clock * 4.4);
            gc.beginPath();
            gc.arc(x, y, rad * (1.9 + pulse * 0.5), 0, Math.PI * 2);
            gc.fillStyle = `rgba(255,236,150,${(0.18 + pulse * 0.14).toFixed(3)})`;
            gc.fill();
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
