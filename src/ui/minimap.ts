// The minimap.
//
// A kart racer without one is a game where the only information you have about
// the race is what happens to be inside a 70° cone in front of you. This is the
// widget that tells the player they are being caught, that the pack has split,
// and that the hairpin they cannot see yet is coming.
//
// Drawn to a canvas rather than assembled out of DOM. The course outline is
// static — it is rendered once into an offscreen buffer when the track is built
// and blitted every frame — so the per-frame cost is one `drawImage`, eight
// small paths and one re-stamp of the start line, with no layout, no style
// invalidation and no allocation.
//
// The course comes off `track.spline`, the only description of the circuit that
// is guaranteed to be true: sample it at even arc-length, take the bounds, and
// fit that into the plate. Any course this game ever ships will map itself.

import { features } from '../track/courses/types.ts';
import { getVehicle } from '../vehicles/registry.ts';
import type { GameContext, Racer, SplineSample, Track, VehicleId } from '../types.ts';
import { blipColor, fromHtml, hexCss, MAP, q, spreadBlipColors, unitPx } from './theme.ts';

/**
 * Plate geometry, in `--u`.
 *
 * **Nearly square, because the circuit is.** Cone Canyon measures about 430m by
 * 450m, and it was being fitted into a 1.4:1 landscape box — so the height
 * decided the scale, a third of the plate's width went to empty chevron
 * texture, and the whole map was drawn smaller than the plate could afford. A
 * box that matches the course's own proportions buys about 20% more scale for
 * the same corner of the screen, and every pixel of that goes into the one
 * measurement this widget lives or dies by: how wide the road is compared to the
 * markers riding on it.
 */
const MAP_W = 12.6;
const MAP_H = 11.2;
/** Samples around the loop. 240 is smooth at any size this plate can be. */
const SAMPLES = 240;

/**
 * How big a racer's marker is, **as a fraction of the road it is driving on**.
 *
 * This is the number the last review was about, and it is now expressed against
 * the right thing. It used to be a fraction of `--u`: 0.30u of radius, which
 * came out at ten pixels of coloured disc against a nine-pixel ribbon, so every
 * machine on the circuit was as wide as the road under it and any two of them
 * within a kart length were one lump. Sized against the ribbon instead, a
 * marker is *always* narrower than the tarmac it sits on, on any course, at any
 * viewport, whatever the plate's scale works out to be.
 *
 * `BLIP_SPAN` is the marker's bounding radius — every silhouette below is
 * normalised so its furthest point lands on it — so 0.29 of a 13px ribbon is a
 * 7.5px machine inside it, with road showing on both sides.
 */
const BLIP_SPAN = 0.29;
/** ...with a floor in device pixels, so a phone never draws a two-pixel racer. */
const BLIP_MIN = 2.4;
/** The ink casing every marker wears, in device pixels. */
const BLIP_CASE = 1.5;

/**
 * The player's marker, as a multiple of everybody else's.
 *
 * **The moment the map exists for is the moment it was failing at.** Eight
 * markers in a scrum at the same size, one of them white: the player's own was
 * swallowed by the clump exactly when they needed to know where in it they
 * were. Half again as big, with its own arrowhead, its own casing and a sonar
 * ping leaving it, it is a different *object* from the field rather than a
 * different colour of the same one — which is what survives being seen in
 * peripheral vision.
 */
const PLAYER_SCALE = 1.5;

/**
 * How far a marker may be nudged off its true position to get out from behind
 * another one, as a multiple of its span.
 *
 * **The map's whole job breaks down in a pack.** Eight machines racing hard
 * occupy about twenty metres of a four-hundred-metre circuit, and at the scale
 * this plate can offer that is a single coloured smudge — a photograph of it
 * cannot be counted, let alone read. The player loses the one fact they came to
 * the map for: how many are between them and the front, and are they bunched or
 * strung out.
 *
 * So overlapping markers are relaxed apart, and then each one's displacement is
 * clamped: a marker can never be moved further than this off the truth, which
 * at this scale is a couple of kart lengths. The map stays honest about *where*
 * everyone is and stops lying about *how many*.
 */
const DECLUTTER_DRIFT = 1.5;
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

// ── the cast, from above ───────────────────────────────────────────────────
//
// **Seven machines, seven shapes.** The map used to draw all seven rivals as
// the same flat disc, which meant the only thing separating a locomotive from
// an aeroplane was a hue — and three of this cast's seven hues are blue. A
// player who could not tell which dot was the digger could not tell whether the
// machine catching them was the one that corners or the one that does not.
//
// These are plan views, cut down to the one fact each machine's outline
// carries at seven pixels: the plane is *wide*, the train is *long*, the digger
// has a *boom*, the truck is a *slab*, the car is a *wedge*, the helicopter has
// a *rotor disc*. Nothing here survives being looked at closely; all of it
// survives being glanced at, which is the only way a minimap is ever read.
//
// Authored in a frame where +Y is the direction of travel and the numbers are
// arbitrary — each shape is normalised to its own furthest point at build time,
// so the whole set draws inside one bounding circle and no machine can end up
// wider than the ribbon.

const SHAPES: Record<VehicleId, number[]> = {
  // A wedge: pointed front, square tail. The default racing shape.
  car: [0, 1.10, 0.58, 0.30, 0.52, -1.00, -0.52, -1.00, -0.58, 0.30],
  // A slab. Blunt at both ends and wide — the one that reads as "big".
  truck: [
    0.42, 1.16, 0.42, 0.62, 0.68, 0.52, 0.68, -1.02,
    -0.68, -1.02, -0.68, 0.52, -0.42, 0.62, -0.42, 1.16,
  ],
  // Long, narrow, with a stack on the nose.
  train: [
    0.20, 1.52, 0.20, 1.20, 0.42, 1.20, 0.42, -1.42,
    -0.42, -1.42, -0.42, 1.20, -0.20, 1.20, -0.20, 1.52,
  ],
  // A blocky body with the boom out front — the only marker with a limb.
  digger: [
    0.68, -1.00, 0.68, 0.32, 0.26, 0.32, 0.34, 1.34,
    -0.04, 1.42, -0.14, 0.32, -0.68, 0.32, -0.68, -1.00,
  ],
  // Swept wings. The widest thing on the map by a distance.
  plane: [
    0, 1.42, 0.22, 0.30, 1.16, -0.26, 1.16, -0.60, 0.20, -0.50,
    0.54, -1.24, -0.54, -1.24, -0.20, -0.50, -1.16, -0.60, -1.16, -0.26, -0.22, 0.30,
  ],
  // A bulb with a tail boom and a fin, under a rotor disc drawn separately.
  helicopter: [
    0, 0.92, 0.46, 0.26, 0.32, -0.34, 0.13, -0.46, 0.13, -1.26,
    0.44, -1.26, 0.44, -1.52, -0.44, -1.52, -0.44, -1.26, -0.13, -1.26,
    -0.13, -0.46, -0.32, -0.34, -0.46, 0.26,
  ],
  // A triangle. The only marker with three sides, which is the whole tell.
  cone: [0, 1.30, 0.74, -0.92, -0.74, -0.92],
};

interface Silhouette {
  path: Path2D;
  /** Multiplier that puts this shape's furthest point on the bounding radius. */
  norm: number;
}

function buildSilhouettes(): Map<VehicleId, Silhouette> {
  const out = new Map<VehicleId, Silhouette>();
  for (const key of Object.keys(SHAPES) as VehicleId[]) {
    const pts = SHAPES[key];
    const path = new Path2D();
    let far = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i]!, y = pts[i + 1]!;
      far = Math.max(far, Math.hypot(x, y));
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    path.closePath();
    out.set(key, { path, norm: 1 / Math.max(0.001, far) });
  }
  return out;
}

/**
 * The player's arrowhead, as a path — built twice per frame, once fat for the
 * casing and once true for the fill, so the marker has one silhouette.
 *
 * Forward in map space is `(sin yaw, cos yaw)`; the base sits half a radius
 * *behind* the marker's centre so the head grows out of the disc rather than
 * balancing on it.
 */
function noseTri(
  g: CanvasRenderingContext2D, x: number, y: number,
  rad: number, yaw: number, pad: number,
): void {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  // Slim, and sitting *forward* of the marker's centre rather than through it:
  // a wide triangle based behind the middle covers the disc entirely, and then
  // the player's marker is just another solid dot in a different colour. Based
  // ahead of centre it leaves a white crescent behind the point, which is the
  // part that says "this one is you" at a glance.
  const tip = rad * 2.4 + pad * 1.7;
  const side = rad * 0.72 + pad;
  const back = rad * 0.2;
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
  const silhouettes = buildSilhouettes();

  // Projection from world XZ into canvas pixels.
  let ox = 0, oz = 0, scale = 1, cx = 0, cy = 0;
  let builtFor = '';
  let clock = 0;
  /** Ribbon width in device pixels, decided by `buildStatic` and read by both. */
  let roadPx = 6;
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
  /** The HUD unit in CSS pixels, cached alongside `dpr` and for the same reason. */
  let unit = 16;
  let sizeDirty = true;

  /**
   * The start line, solved once and stamped twice.
   *
   * **The one landmark on the plate, and the pack used to park on top of it.**
   * A second after the flag all eight machines are within fifteen metres of the
   * line, which at this scale is exactly where the chequer is — so the map's
   * only fixed reference was covered at the one moment a player is most likely
   * to look at it. The geometry is solved when the circuit is built and drawn
   * into the still buffer for the empty case, and then stamped again over the
   * field every frame. It is four `fillRect`s in a rotated frame; nothing about
   * doing it twice costs anything worth counting.
   */
  const startLine = { x: 0, y: 0, angle: 0, len: 0, cell: 0, ok: false };

  /**
   * One sample, handed to every `atDistance` call in this module.
   *
   * `TrackSpline.atDistance` allocates a fresh sample — four `Vector3`s — when
   * it is not given somewhere to write, and rebuilding this plate takes about
   * three hundred of them between the outline, the arrows and the cut. Allocated
   * lazily, because the spline is the only thing that knows how to make one.
   */
  let scratch: SplineSample | null = null;
  const sample = (track: Track, d: number): SplineSample => {
    scratch = track.spline.atDistance(d, scratch ?? undefined);
    return scratch;
  };

  /** Per-racer blip colour, resolved once a race — see `assignColors`. */
  const colors = new Map<number, string>();
  /** Draw order, sorted in place every frame. Allocated once; eight entries. */
  const order: Racer[] = [];
  /** Blip positions: true, then relaxed. Allocated once, reused every frame. */
  const trueX = new Float32Array(MAX_BLIPS);
  const trueY = new Float32Array(MAX_BLIPS);
  const drawX = new Float32Array(MAX_BLIPS);
  const drawY = new Float32Array(MAX_BLIPS);
  /** Each marker's own bounding radius, so a big one clears its own room. */
  const radius = new Float32Array(MAX_BLIPS);

  const unsubs: Array<() => void> = [];

  function mapX(x: number): number { return cx + (x - ox) * scale; }
  function mapY(z: number): number { return cy + (z - oz) * scale; }

  /** Resize the buffers to match the CSS box. Returns true if they changed. */
  function ensureSize(): boolean {
    const u = unitPx();
    unit = u;
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
   * The road is stroked at a stylised multiple of its *real* width — the spline
   * knows how wide it is at every station — with a casing under it so the ribbon
   * has an edge against the plate, a crown down the middle, arrowheads along
   * the crown saying which way the lap runs, the gravel cut where the course
   * declares one, and the chequer across the start.
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
      const s = sample(track, (i / SAMPLES) * L);
      xs[i] = s.pos.x;
      zs[i] = s.pos.z;
      width += s.width;
      if (s.pos.x < minX) minX = s.pos.x;
      if (s.pos.x > maxX) maxX = s.pos.x;
      if (s.pos.z < minZ) minZ = s.pos.z;
      if (s.pos.z > maxZ) maxZ = s.pos.z;
    }
    width /= SAMPLES;

    // Fit, with room for the road's own width and the markers that ride on it.
    // A margin in `--u`, like everything else, rather than in metres — the old
    // `width * 0.5` was half the road's width in *metres* used as a count of
    // pixels, which happened to land near the right answer on this circuit and
    // on no other.
    const pad = Math.max(6 * dpr, 0.68 * unit * dpr);
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

    // ── how wide the road is drawn ─────────────────────────────────────────
    //
    // **Wider than true scale, on purpose.** A 26-metre road at this plate's
    // scale is about ten pixels, and a minimap's job is to say who is where in
    // the order rather than to survey the circuit — so the ribbon is stylised up
    // to roughly twice scale, which is what every kart racer's map does: wide
    // enough to *hold* the machines on it. The cap keeps a short course from
    // turning into a sausage; the floor keeps a long one from becoming thread.
    //
    // Both are in `--u` for the same reason everything else here is: a ceiling
    // in device pixels meant that on a large display the ribbon stopped growing
    // while the plate and the machines on it carried on.
    roadPx = Math.min(
      Math.max(width * scale * 1.95, 0.42 * unit * dpr),
      1.35 * unit * dpr,
    );
    sc.lineJoin = 'round';
    sc.lineCap = 'round';

    // Casing, road, and a hairline crown down the middle. Three strokes is all
    // it takes for a grey line to read as a road.
    //
    // **The same three strokes the circuit cards draw.** They were not: the
    // course-select card drew a mid-grey road with a white dashed crown and a
    // yellow dot on the start, and this drew a pale ribbon with a chequer — so
    // the picture a player chooses a circuit from and the picture they read for
    // three laps were two different diagrams of the same track. Both now take
    // their palette from `MAP` in ui/theme.ts.
    sc.strokeStyle = MAP.ink;
    sc.lineWidth = roadPx + Math.max(2.4 * dpr, 0.2 * unit * dpr);
    sc.stroke(path);
    sc.strokeStyle = MAP.road;
    sc.lineWidth = roadPx;
    sc.stroke(path);
    sc.strokeStyle = MAP.crown;
    sc.lineWidth = Math.max(0.7, roadPx * MAP.crownScale);
    sc.stroke(path);

    drawShortcuts(track, L);
    drawArrows(track, L);
    solveStartLine(track);
    if (startLine.ok) stampStart(sc);
    builtFor = track.id;
  }

  /**
   * The gravel cut, where the course declares one.
   *
   * `coneCanyon` has `shortcuts: [{ from: .679, to: .716, side: -1 }]` — the
   * scrape across the inside of Digger's Elbow that saves about twenty-five
   * metres — and the map drew one unbroken loop, so the circuit's single most
   * valuable piece of local knowledge was something a player could only find by
   * running wide into it. A map that cannot teach the track is decoration.
   *
   * **Drawn as the chord it is, not as an offset of the road.** The first cut
   * of this pushed each station sideways onto its verge and then out again
   * until it cleared the stylised ribbon — and at Digger's Elbow, where the
   * corner's radius is smaller than the push, the offset curve folded through
   * itself and printed a tan blob on the plate. A shortcut is not a road moved
   * ten pixels sideways; it is the *straight line the corner is hiding*. So
   * this takes the chord between the two ends, measures how far the centreline
   * bows away from it, and lays the branch along that gap — which meets the
   * ribbon at both ends by construction, cannot invert however tight the corner
   * is, and is a picture of the twenty-five metres the cut actually saves.
   */
  function drawShortcuts(track: Track, L: number): void {
    if (!sc) return;
    const cuts = features(track.course).shortcuts;
    if (!cuts || !cuts.length) return;
    const cutPx = Math.max(2 * dpr, roadPx * 0.32);
    const steps = 26;
    const cxs = new Float32Array(steps + 1);
    const cys = new Float32Array(steps + 1);

    for (const cut of cuts) {
      const from = cut.from * L;
      const span = (cut.to - cut.from) * L;
      if (!(span > 1)) continue;

      for (let i = 0; i <= steps; i++) {
        const s = sample(track, from + (i / steps) * span);
        cxs[i] = mapX(s.pos.x);
        cys[i] = mapY(s.pos.z);
      }
      const x0 = cxs[0]!, y0 = cys[0]!;
      const x1 = cxs[steps]!, y1 = cys[steps]!;

      // Which side of the chord the road bows away to — that is the side the
      // cut is on, read off the geometry rather than trusted from the course
      // file, whose `side` is in the spline's lateral frame and is the opposite
      // of the driver's.
      const mid = steps >> 1;
      let nx = (x0 + x1) * 0.5 - cxs[mid]!;
      let ny = (y0 + y1) * 0.5 - cys[mid]!;
      const bow = Math.hypot(nx, ny);
      if (bow < 0.5) continue;
      nx /= bow; ny /= bow;

      // The branch is the chord, held clear of the ribbon by exactly enough
      // plate to be seen as a separate road, and pinched back onto the tarmac
      // at both ends so it forks and rejoins.
      //
      // **Scaling the deviation instead was the trap.** Multiplying the road's
      // own bow by whatever factor cleared the ribbon meant a gentle corner got
      // a wild curve and a hairpin got a fat sausage, because the multiplier is
      // unbounded in exactly the case the ribbon is widest. A fixed clearance is
      // bounded by construction and looks the same on every corner of every
      // course.
      const clear = roadPx * 0.5 + cutPx * 0.5 + 1.4 * dpr;
      const p = new Path2D();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const pinch = Math.sin(Math.PI * t) ** 0.55;
        const px = x0 + (x1 - x0) * t + nx * clear * pinch;
        const py = y0 + (y1 - y0) * t + ny * clear * pinch;
        if (i === 0) p.moveTo(px, py); else p.lineTo(px, py);
      }
      sc.lineCap = 'round';
      sc.lineJoin = 'round';
      sc.setLineDash([]);
      sc.strokeStyle = MAP.ink;
      sc.lineWidth = cutPx + Math.max(1.8 * dpr, 0.14 * unit * dpr);
      sc.stroke(p);
      // Dashed, because a cut drawn as solidly as the tarmac reads as a second
      // road rather than as the gamble it is.
      //
      // **Butt caps, and only here.** A round cap adds half the stroke's width
      // to each end of every dash, so at this weight the caps closed the gaps
      // and the branch photographed as one solid tan sausage — a dashed line
      // whose dashes had been eaten by its own line ends.
      sc.lineCap = 'butt';
      sc.setLineDash([cutPx * 1.7, cutPx * 1.25]);
      sc.strokeStyle = MAP.cut;
      sc.lineWidth = cutPx;
      sc.stroke(p);
      sc.setLineDash([]);
      sc.lineCap = 'round';
    }
  }

  /**
   * Which way the lap runs.
   *
   * **A fixed-orientation map with no arrow on it cannot answer its own first
   * question.** A marker fifty pixels ahead of the player along the ribbon and
   * a marker fifty pixels behind look identical, and so do a rival in front and
   * a rival a whole lap down. Arrowheads painted along the crown say it once,
   * everywhere, for nothing: they are part of the road, they never move, and
   * they cost one pass at build time.
   */
  function drawArrows(track: Track, L: number): void {
    if (!sc) return;
    const spacing = Math.max(26 * dpr, roadPx * 2.6);
    const count = Math.min(26, Math.max(8, Math.round((L * scale) / spacing)));
    const len = roadPx * 0.34;
    const wide = roadPx * 0.3;
    sc.lineCap = 'round';
    sc.lineJoin = 'round';
    for (let i = 0; i < count; i++) {
      // Offset half a step so no arrowhead lands on the chequer.
      const s = sample(track, ((i + 0.5) / count) * L);
      const px = mapX(s.pos.x), py = mapY(s.pos.z);
      let dx = s.tangent.x, dy = s.tangent.z;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      const nx = -dy, ny = dx;
      sc.beginPath();
      sc.moveTo(px - dx * len + nx * wide, py - dy * len + ny * wide);
      sc.lineTo(px, py);
      sc.lineTo(px - dx * len - nx * wide, py - dy * len - ny * wide);
      sc.strokeStyle = 'rgba(10,13,19,.5)';
      sc.lineWidth = Math.max(1.6 * dpr, roadPx * 0.24);
      sc.stroke();
      sc.strokeStyle = MAP.arrow;
      sc.lineWidth = Math.max(0.9 * dpr, roadPx * 0.13);
      sc.stroke();
    }
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
  function solveStartLine(track: Track): void {
    const a = sample(track, track.course.startDistance ?? 0);
    const nx = -a.tangent.z, nz = a.tangent.x;
    const half = (roadPx * 0.62) / scale;
    const x0 = mapX(a.pos.x - nx * half), y0 = mapY(a.pos.z - nz * half);
    const x1 = mapX(a.pos.x + nx * half), y1 = mapY(a.pos.z + nz * half);
    const len = Math.hypot(x1 - x0, y1 - y0);
    startLine.ok = len > 1;
    if (!startLine.ok) return;
    startLine.x = (x0 + x1) * 0.5;
    startLine.y = (y0 + y1) * 0.5;
    startLine.angle = Math.atan2(y1 - y0, x1 - x0);
    startLine.len = len;
    // Squarish cells, but never so deep that the line reads as a level crossing.
    startLine.cell = Math.min(len / 4, roadPx * 0.34);
  }

  function stampStart(g: CanvasRenderingContext2D): void {
    const { x, y, angle, len, cell } = startLine;
    const cells = 4;
    const cw = len / cells;
    const pad = 1.1 * dpr;

    g.save();
    g.translate(x, y);
    g.rotate(angle);
    g.fillStyle = 'rgba(9,11,17,.95)';
    g.fillRect(-len * 0.5 - pad, -cell - pad, len + pad * 2, cell * 2 + pad * 2);
    g.fillStyle = '#FFF8F0';
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < 2; j++) {
        if ((i + j) % 2) continue;
        g.fillRect(-len * 0.5 + i * cw, -cell + j * cell, cw, cell);
      }
    }
    // Two posts, standing a little proud of the ribbon on both sides. A chequer
    // the width of the road is a chequer a machine parked on the line covers
    // entirely; the posts are the part that still shows.
    const post = Math.max(1.4 * dpr, roadPx * 0.16);
    g.fillStyle = '#FFC300';
    g.fillRect(-len * 0.5 - post * 1.5, -cell * 1.9, post, cell * 3.8);
    g.fillRect(len * 0.5 + post * 0.5, -cell * 1.9, post, cell * 3.8);
    g.restore();
  }

  function ensureBuilt(): void {
    const track = ctx.track;
    if (!track) return;
    if (!sizeDirty && builtFor === track.id) return;
    sizeDirty = false;
    ensureSize();
    buildStatic(track);
  }

  /**
   * Resolve the whole field's colours at once.
   *
   * Per-racer was not enough: `blipColor` clamps one machine's own paint into
   * the band that reads on a map and has no idea what the other seven look
   * like, and this cast supplies a teal locomotive, a blue helicopter and an
   * aeroplane whose saturation floor lands it on periwinkle — three blues
   * inside thirty degrees. `spreadBlipColors` relaxes them apart as a set,
   * starting from exactly the colours the results sheet uses, so only the
   * markers that actually collide move at all.
   */
  function assignColors(): void {
    colors.clear();
    const racers = ctx.racers;
    if (!racers.length) return;
    const base: number[] = [];
    // No duplicate-variant nudge any more: the field is the cast, one entrant
    // per machine (see `racerCount` in core/config.ts), so two blips can only
    // collide because two *different* machines are painted alike — which is
    // exactly and only what `spreadBlipColors` is for.
    for (const racer of racers) {
      base.push(blipColor(getVehicle(racer.vehicleId).colors.primary));
    }
    const spread = spreadBlipColors(base);
    for (let i = 0; i < racers.length; i++) {
      colors.set(racers[i]!.id, hexCss(spread[i]!));
    }
  }

  function colorOf(racer: Racer): string {
    const c = colors.get(racer.id);
    if (c) return c;
    assignColors();
    return colors.get(racer.id) ?? '#FFF8F0';
  }

  /**
   * Push overlapping markers apart, then hold each one near the truth.
   *
   * A few passes of pairwise relaxation — the same thing a label layout does —
   * over at most a couple of dozen points, with no allocation and no sorting.
   * The clamp at the end is what keeps it a readability aid rather than a lie:
   * however crowded the field gets, no marker ends up more than `maxDrift`
   * pixels from where its kart really is, so the shape of the pack on the map
   * is still the shape of the pack on the road.
   */
  function declutter(n: number, gap: number): void {
    if (n < 2) return;
    for (let pass = 0; pass < DECLUTTER_PASSES; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          // Measured between the two markers' *own* radii, not against one
          // shared number: the player's marker is half again the size of a
          // rival's, so a pair that clears at rival-to-rival spacing is still
          // a rival buried under the player's roundel at rival-to-player.
          const sep = radius[i]! + radius[j]! + gap;
          let dx = drawX[j]! - drawX[i]!;
          let dy = drawY[j]! - drawY[i]!;
          let d2 = dx * dx + dy * dy;
          if (d2 >= sep * sep) continue;
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
      const maxDrift = radius[i]! * DECLUTTER_DRIFT;
      const dx = drawX[i]! - trueX[i]!;
      const dy = drawY[i]! - trueY[i]!;
      const d = Math.hypot(dx, dy);
      if (d <= maxDrift || d < 1e-5) continue;
      const k = maxDrift / d;
      drawX[i] = trueX[i]! + dx * k;
      drawY[i] = trueY[i]! + dy * k;
    }
  }

  /**
   * One rival, as its own machine.
   *
   * Stroke first and fill over it, so the ink casing only shows on the outside
   * and the silhouette keeps its full width — the same trick the numerals in
   * `glyphs.ts` use for their keyline. The whole marker is drawn under one
   * `rotate`, so the shape *is* the direction indicator: a plane crossing the
   * plate nose-first and a plane sliding sideways are two different pictures.
   */
  function drawRacer(
    g: CanvasRenderingContext2D, racer: Racer,
    x: number, y: number, span: number, dim: boolean,
  ): void {
    const shape = silhouettes.get(racer.vehicleId) ?? silhouettes.get('car')!;
    const s = span * shape.norm;
    g.globalAlpha = dim ? 0.62 : 1;

    if (racer.vehicleId === 'helicopter') {
      // The rotor disc does not turn with the fuselage, and it is the one thing
      // that names this machine at six pixels.
      g.beginPath();
      g.arc(x, y, span * 0.94, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(8,10,15,.9)';
      g.lineWidth = BLIP_CASE * dpr * 1.3;
      g.stroke();
      g.strokeStyle = colorOf(racer);
      g.lineWidth = Math.max(0.8 * dpr, BLIP_CASE * dpr * 0.55);
      g.stroke();
    }

    g.save();
    g.translate(x, y);
    g.rotate(-racer.yaw);
    g.scale(s, s);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.lineWidth = (BLIP_CASE * dpr * 2) / s;
    g.strokeStyle = 'rgba(8,10,15,.94)';
    g.stroke(shape.path);
    g.fillStyle = racer.finished ? 'rgba(120,130,148,.9)' : colorOf(racer);
    g.fill(shape.path);
    g.restore();
    g.globalAlpha = 1;
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
      const span = Math.max(BLIP_MIN * dpr, roadPx * BLIP_SPAN);
      const ring = BLIP_CASE * dpr;
      const playerSpan = span * PLAYER_SCALE;

      // Back of the field first, leader last, player over everything.
      //
      // Markers overlap — eight machines on a starting grid occupy about fifteen
      // metres of a four-hundred-metre circuit, and no size makes that eight
      // separate objects. What *can* be fixed is the order they stack in, which
      // used to be `ctx.racers` order: arbitrary, and unstable frame to frame as
      // karts traded places, so whichever marker was on top flickered. Sorted by
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

      // ── where each marker actually goes ────────────────────────────────────
      //
      // The interpolated position, not the simulation's — the markers have to
      // ride with the karts they are, or the map swims a step behind at 200km/h.
      const n = order.length;
      for (let i = 0; i < n; i++) {
        const racer = order[i]!;
        trueX[i] = mapX(racer.prevPos.x + (racer.pos.x - racer.prevPos.x) * alpha);
        trueY[i] = mapY(racer.prevPos.z + (racer.pos.z - racer.prevPos.z) * alpha);
        drawX[i] = trueX[i]!;
        drawY[i] = trueY[i]!;
        radius[i] = racer === player ? playerSpan : span;
      }
      // Separation is measured to the *casings* — two markers whose ink rims are
      // just touching are two markers, and anything tighter is one lump.
      declutter(n, ring * 2.4);

      // ── the field ─────────────────────────────────────────────────────────
      //
      // A machine a whole lap away from the player is not in the player's race,
      // and a map that draws it at full strength is inviting them to defend a
      // place they already hold by a lap — which, on a fixed-orientation map,
      // is exactly the mistake a rival's marker sitting "just ahead" invites.
      // Dimmed, not hidden.
      //
      // **Measured in progress, not in `lap`.** The lap counter starts at -1 and
      // ticks as each machine crosses the line, so for the several seconds
      // after the flag the player is on lap 0 and the seven machines a metre
      // behind them are on lap -1 — and a map that reads `lap` greys out the
      // entire field at the start of every race. Progress is monotonic metres
      // and has no such edge.
      const lapLen = ctx.track?.length ?? 0;
      const myProgress = player?.progress ?? 0;
      const lapAway = lapLen > 1 ? lapLen * 0.72 : Infinity;
      let px = 0, py = 0, hasPlayer = false;
      for (let i = 0; i < n; i++) {
        const racer = order[i]!;
        if (racer === player) {
          px = drawX[i]!; py = drawY[i]!; hasPlayer = true;
          continue;
        }
        drawRacer(gc, racer, drawX[i]!, drawY[i]!, span,
          racer.finished || Math.abs(racer.progress - myProgress) >= lapAway);
      }

      // ── the start line, again ─────────────────────────────────────────────
      // Over the field, under the player. The chequer is the map's only fixed
      // reference and the pack sits on it for the whole of lap one.
      if (startLine.ok) stampStart(gc);

      // ── the player, last, always ──────────────────────────────────────────
      if (hasPlayer && player) {
        // **A ring leaving the marker, not a haze under it.**
        //
        // What was here first was a fill — pale yellow at eighteen percent over
        // a near-black plate, which composites to a khaki disc. It read as a
        // smudge on the glass rather than as the one thing on this map the eye
        // has to find instantly. A stroke does the job a fill could not: it is
        // a hard edge, so it survives being drawn over both the light ribbon
        // and the dark plate, and because it expands and fades on a fixed
        // period it is a sonar ping — motion the eye catches in the corner of
        // the frame without ever being asked to look.
        const ping = (clock % 1.15) / 1.15;
        const fade = (1 - ping).toFixed(3);
        gc.beginPath();
        gc.arc(px, py, playerSpan * (1.05 + ping * 1.6), 0, Math.PI * 2);
        gc.strokeStyle = `rgba(10,12,18,${fade})`;
        gc.lineWidth = ring * 2.4;
        gc.stroke();
        gc.strokeStyle = `rgba(255,214,90,${fade})`;
        gc.lineWidth = ring * 1.2;
        gc.stroke();

        // The casing includes the nose, so the whole marker is one silhouette
        // rather than a disc with a shape tucked behind it.
        const cas = ring * 1.9;
        gc.fillStyle = 'rgba(8,10,15,.94)';
        noseTri(gc, px, py, playerSpan, player.yaw, cas);
        gc.fill();
        gc.beginPath();
        gc.arc(px, py, playerSpan + cas, 0, Math.PI * 2);
        gc.fill();

        gc.beginPath();
        gc.arc(px, py, playerSpan, 0, Math.PI * 2);
        gc.fillStyle = '#FFF8F0';
        gc.fill();

        // **The nose goes on last.** It used to be drawn and then painted
        // straight back over by the disc fill, which left about two pixels of
        // dark smudge poking out of a white circle — legible only at 12x. The
        // whole point of the marker is that the map says which way the player
        // is *pointing*, so the arrowhead sits on top, in safety orange against
        // the white disc it grows out of.
        noseTri(gc, px, py, playerSpan, player.yaw, 0);
        gc.fillStyle = '#FF6B1A';
        gc.fill();
        gc.lineWidth = Math.max(1, ring * 0.62);
        gc.strokeStyle = 'rgba(8,10,15,.9)';
        gc.stroke();
      }
    },

    dispose(): void {
      for (const off of unsubs) off();
      unsubs.length = 0;
      root.remove();
    },
  };
}
