// Art direction: lighting, sky, atmosphere, post.
//
// The position this file takes:
//
//   Warm key, cool everything else. A single hard sun does the modelling; the
//   fill is sky-blue and comes from above, the bounce is sand-warm and comes
//   from below, and a cold rim sits opposite the sun purely so silhouettes cut
//   away from the background. A safety-orange cone should read orange in the
//   light, orange-in-shadow (never grey), and be outlined in cold blue against
//   whatever is behind it. That triangle — warm / cool / cold edge — is the
//   whole look, and everything else here is in service of it.
//
//   Depth comes from air, not from grey. Distant geometry fades into the
//   colour of the sky *in that direction*, gaining the sun's glow when it sits
//   near the sun and the zenith's blue when it does not. Fog and sky are the
//   same function evaluated twice (see sky.ts), so they cannot disagree.
//
//   Contact is non-negotiable. The shadow map is deliberately small and
//   snapped to its own texel grid, following the player rather than covering
//   the course, so the thing that matters — the dark patch directly under a
//   kart — is sharp instead of averaged away across a kilometre of desert.
//
// Ownership note: this file installs `ctx.composer`. The engine renders through
// it whenever `ctx.quality.postfx` is on and falls back to a direct draw when
// it is not; the film stock is shared between both paths, so switching quality
// changes how much is going on, never what colour the game is.

import * as THREE from 'three';
import { clamp, clamp01, damp } from '../core/math.ts';
import { installFilmStock } from './grade.ts';
import { installMaterialStyle } from './materials.ts';
import { createSky, makeAtmosphereUniforms } from './sky.ts';
import { createPostStack } from './post.ts';
import { createContactShadows } from './contact.ts';
import type { ContactShadows } from './contact.ts';
import type { PostStack } from './post.ts';
import type { CourseTheme, GameContext, GameSystem, QualitySettings } from '../types.ts';

/**
 * Extra exposure on top of the engine's, so the grade is tuned in one place.
 *
 * Nudged up when the fill came down: cutting the ambient by more than half is
 * what buys the modelling, but taken on its own it also takes a stop out of the
 * whole picture, and this game is high-key. The ratio is the art direction; the
 * absolute level is a knob.
 */
const EXPOSURE_TRIM = 1.12;

/** Shadow map extent in metres, per quality tier. Smaller = sharper contact. */
const SHADOW_EXTENT: Record<QualitySettings['tier'], number> = {
  high: 62,
  med: 52,
  low: 46,
};

/**
 * The sun's working range, radians above the horizon.
 *
 * Mid-morning, not noon. Above about 35 degrees a kart's cast shadow is shorter
 * than the kart is tall, which means it hides underneath the chassis and the
 * player never sees it; below about 25 it starts throwing thirty-metre streaks
 * across the racing line and the road stops being readable. This window is
 * narrow on purpose — courses get an opinion about *where* the sun is, not about
 * whether the game has shadows.
 */
const SUN_ELEVATION = { min: 0.50, max: 0.60 };

/**
 * House rotation applied on top of whatever azimuth a course asks for.
 *
 * Courses tend to author the sun facing down the start straight, which throws
 * every shadow directly away from the chase camera where it is invisible. A
 * quarter turn puts the light across the road instead, so shadows rake sideways
 * and a player reads them in peripheral vision.
 */
const AZIMUTH_TRIM = Math.PI * 0.5;

const WHITE = new THREE.Color(0xffffff);

/** Defaults for a course whose theme leaves the sky out. */
const DEFAULT_SKY = { top: 0x2e86d6, bottom: 0xbfe7ff, horizon: 0xffe2b0 };
const DEFAULT_SUN = { color: 0xfff2d8, intensity: 2.6, azimuth: 0.7, elevation: 0.85 };

export function createLightingSystem(ctx: GameContext): GameSystem {
  const group = new THREE.Group();
  group.name = 'lighting';

  const atmos = makeAtmosphereUniforms();
  // Inside the far plane, outside anything the track builds. A dome that
  // clips the ground plane leaves a ring on the horizon.
  const sky = createSky(atmos, ctx.config.camera.far * 0.9);
  let post: PostStack | null = null;
  let contact: ContactShadows | null = null;

  // ── the three lights ─────────────────────────────────────────────────────

  // Key. Hard, warm, and the only thing casting a shadow.
  const sun = new THREE.DirectionalLight(0xfff0d2, 3.0);
  sun.castShadow = ctx.quality.shadows;
  sun.shadow.mapSize.set(ctx.quality.shadowSize, ctx.quality.shadowSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 460;
  sun.shadow.bias = -0.00042;
  sun.shadow.normalBias = 0.034;
  // Widens the PCF kernel. A pin-sharp shadow edge on a cartoon kart reads as a
  // decal; a texel or so of penumbra reads as contact. Kept tight, because the
  // contact pass owns softness now and a wide PCF radius on a four-tap kernel
  // is where the stipple in the penumbra was coming from.
  sun.shadow.radius = 1.15;
  group.add(sun, sun.target);

  // Fill. Cool from the sky, warm from the ground the sun is bouncing off.
  // This is what stops shadowed sides going to a dead neutral grey — but it is
  // *fill*, at roughly a fifth of key. At parity, which is where this was, the
  // game has no light side and no dark side and every model reads as paper.
  const hemi = new THREE.HemisphereLight(0xa8dcff, 0xd4a870, 0.78);
  group.add(hemi);

  // Rim. Cold, low, and opposite the sun: it lands on the shaded edge of every
  // object. Kept deliberately faint — the rim that actually draws the line
  // around a silhouette is the view-dependent Fresnel term in materials.ts; a
  // second directional light at any real strength is just more flat fill.
  const rim = new THREE.DirectionalLight(0x9fd4ff, 0.50);
  group.add(rim);

  // ── scratch ──────────────────────────────────────────────────────────────
  const _dir = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _centre = new THREE.Vector3();
  const _xAxis = new THREE.Vector3();
  const _yAxis = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  let boost = 0;

  function sunDirection(az: number, el: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az))
      .normalize();
  }

  function applyTheme(theme: CourseTheme): void {
    const s = { ...DEFAULT_SKY, ...(theme.sky ?? {}) };
    atmos.uZenith.value.setHex(s.top);
    atmos.uHorizon.value.setHex(s.bottom);
    atmos.uHaze.value.setHex(s.horizon ?? s.bottom);

    const su = { ...DEFAULT_SUN, ...(theme.sun ?? {}) };
    // A 50-degree sun flattens everything and leaves nothing under the karts.
    // Courses get a say, but not enough of one to lose the shadows — and the
    // house quarter-turn puts what is left across the road rather than down it.
    sunDirection(
      su.azimuth + AZIMUTH_TRIM,
      clamp(su.elevation, SUN_ELEVATION.min, SUN_ELEVATION.max),
      _dir,
    );
    atmos.uSunDir.value.copy(_dir);
    atmos.uSunColor.value.setHex(su.color);

    sun.color.setHex(su.color);
    sun.intensity = su.intensity * 1.16;
    sun.position.copy(_dir).multiplyScalar(200);

    // The rim mirrors the sun across the vertical axis and sits low, so it
    // grazes rather than lights. Its colour is the sky's own blue, pushed.
    rim.position.set(-_dir.x, 0.20, -_dir.z).normalize().multiplyScalar(200);
    rim.color.copy(atmos.uZenith.value).lerp(WHITE, 0.34);

    // Fill picks its two ends off the theme: sky above, ground below. Saturated
    // on purpose — a neutral hemisphere light is what makes a scene look like a
    // render instead of a painting — and weighted toward the sky end, because
    // the whole point of the fill is that the *shaded* side of a safety-orange
    // cone comes back blue rather than brown.
    hemi.color.copy(atmos.uHorizon.value).lerp(atmos.uZenith.value, 0.58);
    // Bounce off sand is warm but not *orange*: the ground already is, and
    // multiplying the two turns the desert into a traffic cone. Held well below
    // the sky end so a vertical surface reads cool rather than neutral.
    hemi.groundColor.setHex(theme.ground ?? 0xc9a063)
      .lerp(WHITE, 0.18).multiplyScalar(0.58);

    // Distance. `far` is treated as a visibility hint rather than a hard plane:
    // the atmosphere is exponential, so there is no wall for things to pop
    // through, only air getting thicker.
    const f = theme.fog;
    atmos.uFogDistance.value = f ? Math.max(300, (f.far ?? 1600) * 0.78) : 1250;
    atmos.uFogHeight.value = 165;

    // Postfx owns the atmosphere when it is on (depth-driven, directional, sun
    // aware). With it off, three's own fog stands in — same colour, so the
    // horizon still dissolves rather than ending in a line.
    applyFogFallback();
  }

  function applyFogFallback(): void {
    if (ctx.quality.postfx) {
      if (ctx.scene.fog) ctx.scene.fog = null;
      return;
    }
    const colour = atmos.uHaze.value;
    // FogExp2 falls off as exp(-(d*density)^2), so it needs a tighter constant
    // than the postfx path to reach the same "gone by the far ridge" point.
    const density = 1 / Math.max(atmos.uFogDistance.value * 0.78, 1);
    const fog = ctx.scene.fog as THREE.FogExp2 | null;
    if (fog && (fog as THREE.FogExp2).isFogExp2) {
      fog.color.copy(colour);
      fog.density = density;
    } else {
      ctx.scene.fog = new THREE.FogExp2(colour.getHex(), density);
    }
  }

  /**
   * Fit the shadow frustum to the action.
   *
   * Two things matter. The box is pushed *ahead* of the player, because a
   * shadow behind the camera is a shadow nobody sees; and its centre is snapped
   * to whole shadow-map texels in light space, because without that the whole
   * map crawls every time the camera turns and every contact shadow shimmers.
   */
  function fitShadow(): void {
    const focus = ctx.player ?? ctx.racers[0];
    if (!focus) return;

    const extent = SHADOW_EXTENT[ctx.quality.tier];
    ctx.camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1); else _fwd.normalize();

    _centre.copy(focus.pos).addScaledVector(_fwd, extent * 0.34);

    // Light-space basis, matching how three orients the shadow camera.
    _xAxis.crossVectors(_up, atmos.uSunDir.value).normalize();
    _yAxis.crossVectors(atmos.uSunDir.value, _xAxis).normalize();
    const texel = (extent * 2) / Math.max(sun.shadow.mapSize.x, 1);
    const px = _centre.dot(_xAxis);
    const py = _centre.dot(_yAxis);
    _centre.addScaledVector(_xAxis, Math.round(px / texel) * texel - px);
    _centre.addScaledVector(_yAxis, Math.round(py / texel) * texel - py);

    const cam = sun.shadow.camera;
    if (cam.right !== extent) {
      cam.left = -extent; cam.right = extent;
      cam.top = extent; cam.bottom = -extent;
      cam.updateProjectionMatrix();
    }
    sun.target.position.copy(_centre);
    sun.position.copy(_centre).addScaledVector(atmos.uSunDir.value, 220);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  }

  function applyQuality(): void {
    contact?.applyQuality();
    sun.castShadow = ctx.quality.shadows;
    if (sun.shadow.mapSize.x !== ctx.quality.shadowSize) {
      sun.shadow.mapSize.setScalar(ctx.quality.shadowSize);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    applyFogFallback();
  }

  ctx.bus.on<{ track: { theme: CourseTheme } }>('track:built', ({ track }) => applyTheme(track.theme));
  ctx.bus.on('quality:changed', () => applyQuality());

  return {
    name: 'lighting',
    order: 25,

    init(): void {
      // Both of these rewrite three's shader chunks, so they have to land
      // before the first material compiles.
      installMaterialStyle();
      installFilmStock(ctx.renderer, ctx.config.render.exposure * EXPOSURE_TRIM);
      // PCFSoft is deprecated in this three build and silently falls back to
      // PCF anyway, with a console warning on every boot. Ask for what we
      // actually get, and shape the penumbra with shadow.radius instead.
      ctx.renderer.shadowMap.type = THREE.PCFShadowMap;

      ctx.scene.add(group);
      ctx.scene.add(sky.mesh);

      contact = createContactShadows(ctx);
      ctx.scene.add(contact.mesh);

      post = createPostStack(ctx, atmos, sky.noise);
      post.setExposure(ctx.config.render.exposure * EXPOSURE_TRIM);
      ctx.composer = post;

      applyTheme(ctx.track?.theme ?? {});
      applyQuality();
    },

    reset(): void {
      boost = 0;
      post?.setBoost(0);
    },

    update(dt: number, alpha: number): void {
      fitShadow();
      sky.update(ctx.camera, ctx.time.elapsed);
      contact?.update(alpha);

      // The frame leans into a boost: a directional streak out of the middle,
      // a warm push and a vignette pulse. Read off sim state rather than an
      // event so it decays with the boost instead of on a timer of its own.
      //
      // Normalised, not proportional. The weakest boost in the game (a
      // slipstream, power 24) and the strongest drift release (purple, 46) are
      // both *events*, and both have to land. Scaling linearly off raw power
      // meant a slipstream barely moved the frame at the fastest the game ever
      // goes; this floors the response and lets power decide the top of it.
      const p = ctx.player;
      let target = 0;
      if (p && p.boost.time > 0) {
        const strength = 0.58 + 0.42 * clamp01((p.boost.power - 20) / 30);
        target = strength * clamp01(p.boost.time / 0.18);
      }
      // Fast attack, slower release — the punch should arrive on the frame it
      // is earned and let go over about a fifth of a second.
      boost = damp(boost, target, target > boost ? 1e-8 : 0.02, dt);
      post?.setBoost(boost);
    },

    dispose(): void {
      ctx.scene.remove(group);
      ctx.scene.remove(sky.mesh);
      if (contact) ctx.scene.remove(contact.mesh);
      contact?.dispose();
      contact = null;
      sky.dispose();
      post?.dispose();
      if (ctx.composer === post) ctx.composer = null;
      post = null;
    },
  };
}
