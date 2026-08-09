// The geometry kit every piece of set dressing is built from.
//
// Nothing out here is a mesh file and nothing out here is its own draw call. A
// portaloo is forty boxes; a lattice crane is two hundred struts; a grandstand
// is a thousand little terraces and spectators. Built the obvious way that is
// three hundred meshes standing beside a race track, which is three hundred
// draw calls the game does not have.
//
// So the kit does two things:
//
//   * It *bakes*. Every primitive is transformed on the CPU at build time and
//     appended to one set of vertex arrays, carrying its colour per vertex. A
//     whole prop comes out as a single geometry with a single material, which
//     is the precondition for instancing it.
//   * It *shades while it bakes*. Real set dressing sits in a landscape with
//     ambient occlusion; ours cannot afford any, so the kit darkens vertices
//     toward the ground as it writes them. That vertical gradient is most of
//     what makes a cone look planted rather than pasted on.
//
// Two optional attributes ride along — `aAmp` and `aPhase` — for the props that
// move. They mean nothing to a static prop, but they are what lets ten thousand
// spectators bob out of phase inside a single draw call.

import * as THREE from 'three';

const _nm = new THREE.Matrix3();
const _col = new THREE.Color();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/** Per-vertex animation weight: a constant, or a function of local position. */
export type AmpFn = number | ((x: number, y: number, z: number) => number);

export interface AddOptions {
  /** How dark the base of the piece goes, 0..1. Fake contact occlusion. */
  ao?: number;
  /** Metres over which that darkening lifts. */
  aoHeight?: number;
  /** Flat multiplier on the colour — a cheap way to break up repeated parts. */
  shade?: number;
  /** Animation weight written to `aAmp`. */
  amp?: AmpFn;
  /** Animation phase written to `aPhase`, 0..1. */
  phase?: number;
  /** Opt out of the vertical gradient — for anything that does not touch down. */
  noAo?: boolean;
}

// ── cached primitives ──────────────────────────────────────────────────────
//
// Every prop in the game is drawn from a few dozen distinct primitives. Making
// them once and copying their vertices is far cheaper than a BoxGeometry per
// rivet, and it keeps the whole world build inside a frame.

const _geoCache = new Map<string, THREE.BufferGeometry>();

function prim(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = _geoCache.get(key);
  if (!g) { g = make(); _geoCache.set(key, g); }
  return g;
}

export function disposeKitCache(): void {
  for (const g of _geoCache.values()) g.dispose();
  _geoCache.clear();
}

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * A bakery for one prop.
 *
 * Holds a transform stack so sub-assemblies can be authored in their own frame
 * — `push(); move(); rotY(); …; pop()` — and one set of vertex arrays that
 * everything lands in.
 */
export class Kit {
  private P: number[] = [];
  private N: number[] = [];
  private C: number[] = [];
  private A: number[] = [];
  private H: number[] = [];
  private I: number[] = [];
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];

  /** Set once anything asks for `amp`/`phase`; gates the extra attributes. */
  animated = false;
  /** Default darkening at the foot of the prop. */
  ao = 0.42;
  /** Metres that darkening fades over. */
  aoHeight = 1.6;

  get xf(): THREE.Matrix4 { return this.stack[this.stack.length - 1]!; }
  get vertexCount(): number { return this.P.length / 3; }
  get isEmpty(): boolean { return this.I.length === 0; }

  push(): this { this.stack.push(this.xf.clone()); return this; }
  pop(): this { if (this.stack.length > 1) this.stack.pop(); return this; }

  move(x: number, y: number, z: number): this {
    this.xf.multiply(_local.makeTranslation(x, y, z));
    return this;
  }

  rotX(a: number): this { this.xf.multiply(_local.makeRotationX(a)); return this; }
  rotY(a: number): this { this.xf.multiply(_local.makeRotationY(a)); return this; }
  rotZ(a: number): this { this.xf.multiply(_local.makeRotationZ(a)); return this; }

  scale(x: number, y = x, z = x): this {
    this.xf.multiply(_local.makeScale(x, y, z));
    return this;
  }

  // ── the one write path ───────────────────────────────────────────────────

  /** Append `geo` transformed by the current frame times `local`. */
  addWith(
    geo: THREE.BufferGeometry, color: number, local: THREE.Matrix4 | null,
    opts: AddOptions = {},
  ): void {
    const m = local ? _world.multiplyMatrices(this.xf, local) : this.xf;
    _nm.getNormalMatrix(m);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const nor = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const idx = geo.getIndex();
    const base = this.P.length / 3;
    const count = pos.count;

    _col.set(color);
    const shade = opts.shade ?? 1;
    const ao = opts.noAo ? 0 : (opts.ao ?? this.ao);
    const aoH = Math.max(0.05, opts.aoHeight ?? this.aoHeight);
    const amp = opts.amp;
    const ampConst = typeof amp === 'number' ? amp : 0;
    const ampFn = typeof amp === 'function' ? amp : null;
    const phase = opts.phase ?? 0;
    if (amp !== undefined || opts.phase !== undefined) this.animated = true;

    for (let i = 0; i < count; i++) {
      const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
      _p.set(lx, ly, lz).applyMatrix4(m);
      this.P.push(_p.x, _p.y, _p.z);

      if (nor) {
        _n.set(nor.getX(i), nor.getY(i), nor.getZ(i)).applyMatrix3(_nm).normalize();
        this.N.push(_n.x, _n.y, _n.z);
      } else {
        this.N.push(0, 1, 0);
      }

      // Vertical gradient, keyed on the height the vertex lands at in the
      // prop's own frame — so a stack of parts darkens as one object rather
      // than each part darkening independently.
      const k = ao > 0 ? shade * (1 - ao * (1 - smooth(_p.y / aoH))) : shade;
      this.C.push(_col.r * k, _col.g * k, _col.b * k);

      // Always written, only published if something asked for animation.
      this.A.push(ampFn ? ampFn(lx, ly, lz) : ampConst);
      this.H.push(phase);
    }

    if (idx) {
      for (let i = 0; i < idx.count; i++) this.I.push(base + idx.getX(i));
    } else {
      for (let i = 0; i < count; i++) this.I.push(base + i);
    }
  }

  /** Append `geo` at (x,y,z) in the current frame. */
  add(
    geo: THREE.BufferGeometry, x: number, y: number, z: number,
    color: number, opts: AddOptions = {},
  ): void {
    this.addWith(geo, color, _local.makeTranslation(x, y, z), opts);
  }

  // ── primitives ───────────────────────────────────────────────────────────

  /** A box centred at (x,y,z). */
  box(
    x: number, y: number, z: number, w: number, h: number, d: number,
    color: number, opts: AddOptions = {},
  ): void {
    this.addWith(prim('box', () => new THREE.BoxGeometry(1, 1, 1)), color,
      _local.makeTranslation(x, y, z).scale(_s.set(w, h, d)), opts);
  }

  /** A box standing *on* y, so props can be authored from the ground up. */
  post(
    x: number, y: number, z: number, w: number, h: number, d: number,
    color: number, opts: AddOptions = {},
  ): void {
    this.box(x, y + h * 0.5, z, w, h, d, color, opts);
  }

  /** A vertical cylinder centred at (x,y,z). Tapers when rTop != rBot. */
  cyl(
    x: number, y: number, z: number, rTop: number, rBot: number, h: number,
    seg: number, color: number, opts: AddOptions = {},
  ): void {
    const taper = Math.abs(rTop - rBot) > 1e-4 ? +(rTop / Math.max(1e-4, rBot)).toFixed(3) : 1;
    const g = prim(`cyl:${seg}:${taper}`,
      () => new THREE.CylinderGeometry(taper, 1, 1, seg, 1, false));
    this.addWith(g, color, _local.makeTranslation(x, y, z).scale(_s.set(rBot, h, rBot)), opts);
  }

  /** A cone standing on its base at y. */
  cone(
    x: number, y: number, z: number, r: number, h: number, seg: number,
    color: number, opts: AddOptions = {},
  ): void {
    const g = prim(`cone:${seg}`, () => {
      const c = new THREE.ConeGeometry(1, 1, seg, 1, false);
      c.translate(0, 0.5, 0);
      return c;
    });
    this.addWith(g, color, _local.makeTranslation(x, y, z).scale(_s.set(r, h, r)), opts);
  }

  sph(
    x: number, y: number, z: number, r: number, color: number,
    seg = 10, opts: AddOptions = {},
  ): void {
    const g = prim(`sph:${seg}`, () => new THREE.SphereGeometry(1, seg, Math.max(4, seg >> 1)));
    this.addWith(g, color, _local.makeTranslation(x, y, z).scale(_s.set(r, r, r)), opts);
  }

  /** A flat quad in the XY plane facing +Z, centred at (x,y,z). */
  panel(
    x: number, y: number, z: number, w: number, h: number, color: number,
    opts: AddOptions = {}, segX = 1, segY = 1,
  ): void {
    const g = prim(`plane:${segX}:${segY}`, () => new THREE.PlaneGeometry(1, 1, segX, segY));
    this.addWith(g, color, _local.makeTranslation(x, y, z).scale(_s.set(w, h, 1)), opts);
  }

  /**
   * A strut between two points. Lattice towers, cranes, scaffolding, handrails
   * and pylons are nothing but this, several hundred times over.
   */
  strut(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    r: number, color: number, opts: AddOptions = {}, seg = 5,
  ): void {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    const g = prim(`cyl:${seg}:1`, () => new THREE.CylinderGeometry(1, 1, 1, seg, 1, false));
    _q.setFromUnitVectors(UP, _n.set(dx / len, dy / len, dz / len));
    _p.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    _s.set(r, len, r);
    this.addWith(g, color, _local.compose(_p, _q, _s), opts);
  }

  // ── output ───────────────────────────────────────────────────────────────

  build(name = 'prop'): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    if (this.animated) {
      g.setAttribute('aAmp', new THREE.Float32BufferAttribute(this.A, 1));
      g.setAttribute('aPhase', new THREE.Float32BufferAttribute(this.H, 1));
    }
    g.setIndex(this.I);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Build one prop in a closure without juggling a Kit by hand. */
export function buildProp(
  name: string, fn: (k: Kit) => void, ao = 0.42,
): THREE.BufferGeometry {
  const k = new Kit();
  k.ao = ao;
  fn(k);
  return k.build(name);
}
