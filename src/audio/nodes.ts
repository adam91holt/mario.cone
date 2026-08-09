// Placement, and the small amount of bookkeeping that keeps a per-frame
// parameter update from becoming a per-frame allocation.
//
// Positioning is done by hand rather than with PannerNode. A PannerNode in
// HRTF mode is a convolution per voice — eight of those for the field alone —
// and in 'equalpower' mode it is a stereo pan with a distance curve, which is
// exactly what is written out below except that the curve cannot be shaped and
// the air absorption does not exist. Doing it here costs three ordinary nodes
// per voice, and buys the two cues that actually tell a player where a rival
// is: the top end coming off a machine as it drops back, and the pitch of one
// that is closing.

import { clamp, clamp01, lerp } from '../core/math.ts';
import type { AudioBackend } from './context.ts';

/**
 * Where the ears are, in world space, plus how fast they are travelling.
 *
 * Mutated in place once a frame and read by everything — never reallocated.
 */
export interface Listener {
  px: number; py: number; pz: number;
  /** Right and forward axes of the listener's frame. */
  rx: number; ry: number; rz: number;
  fx: number; fy: number; fz: number;
  /** World velocity, for doppler. */
  vx: number; vy: number; vz: number;
}

export function createListener(): Listener {
  return { px: 0, py: 0, pz: 0, rx: 1, ry: 0, rz: 0, fx: 0, fy: 0, fz: 1, vx: 0, vy: 0, vz: 0 };
}

/** The answer, written into a scratch object the caller owns. */
export interface Placement {
  gain: number;
  pan: number;
  /** Lowpass corner, hertz. Distance eats the top end long before the level. */
  cut: number;
  /** Playback-rate multiplier from doppler. 1 when nothing is moving. */
  rate: number;
  distance: number;
}

export function createPlacement(): Placement {
  return { gain: 1, pan: 0, cut: 20000, rate: 1, distance: 0 };
}

/**
 * Reference distance, in metres, at which a source is heard at half strength.
 *
 * Tuned against the track rather than against physics. A true inverse-square
 * law over a field strung out across two hundred metres puts every rival but
 * the one beside you at nothing, which is the correct answer acoustically and
 * the wrong one for a racing game: the pack has to sound like a pack. This
 * rolls off gently and then hands the rest of the job to the lowpass, which is
 * how distance actually reads anyway.
 */
const REF = 16;
/** Past this, a source is not worth a node. */
const CULL = 130;
/**
 * Speed of sound, deliberately slowed.
 *
 * At the real 343 m/s a kart doing 60 m/s produces about a fifth of a tone of
 * doppler, which is audible but polite. This is a game where the whole point of
 * the sound of a rival is that you can tell it is coming past you, so the
 * effect is pushed to roughly a semitone and a half at closing speed — the
 * amount a cartoon uses, which is to say the amount an audience reads as
 * "past me" rather than as "slightly out of tune".
 */
const SOUND_SPEED = 190;

/**
 * Place a source. `out` is reused; nothing here allocates.
 *
 * `vx/vy/vz` is the source's own world velocity — pass zeros for something
 * standing still, and the doppler term falls out to 1.
 */
export function place(
  l: Listener, x: number, y: number, z: number,
  vx: number, vy: number, vz: number, out: Placement,
): Placement {
  const dx = x - l.px, dy = y - l.py, dz = z - l.pz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  out.distance = dist;
  if (dist > CULL) {
    out.gain = 0; out.pan = 0; out.cut = 800; out.rate = 1;
    return out;
  }
  out.gain = REF / (REF + dist);

  const inv = dist > 1e-4 ? 1 / dist : 0;
  const ux = dx * inv, uy = dy * inv, uz = dz * inv;

  // Pan collapses toward centre at close range: a rival two metres off the
  // nose swinging hard between the ears is a mixing artefact, not a cue.
  const spread = clamp01((dist - 1.5) / 6);
  out.pan = clamp((ux * l.rx + uy * l.ry + uz * l.rz) * spread, -1, 1);

  // Air absorption, plus a little extra for anything behind the camera —
  // the sound of the pack you have just passed should be *duller*, not just
  // quieter, or the mix behind the player never clears out of the way.
  const behind = clamp01(-(ux * l.fx + uy * l.fy + uz * l.fz));
  const far = clamp01(dist / 90);
  out.cut = lerp(19000, 620, far * far * 0.7 + far * 0.3) * lerp(1, 0.55, behind * 0.55);

  // Closing rate along the line of sight. Positive = receding = flatter.
  const rel = (vx - l.vx) * ux + (vy - l.vy) * uy + (vz - l.vz) * uz;
  out.rate = clamp(SOUND_SPEED / (SOUND_SPEED + rel), 0.72, 1.42);
  return out;
}

/**
 * An AudioParam with the last value we asked for remembered next to it.
 *
 * Every voice in this module is driven from the render loop, sixty times a
 * second, across a dozen parameters. Writing `.value` directly at that rate
 * steps the parameter and the steps are audible as zipper noise on anything
 * with a gain in it; calling `setTargetAtTime` unconditionally instead pushes
 * tens of thousands of events a second into the audio thread's automation
 * lists. So each parameter carries a deadband, and a write that would not
 * change what anyone hears never reaches the graph at all. In practice that
 * discards most of them.
 */
export interface Param {
  p: AudioParam;
  last: number;
  eps: number;
  tc: number;
}

export function param(p: AudioParam, value: number, eps: number, tc: number): Param {
  p.value = value;
  return { p, last: value, eps, tc };
}

export function set(s: Param, value: number, now: number): void {
  if (Math.abs(s.last - value) < s.eps) return;
  s.last = value;
  s.p.setTargetAtTime(value, now, s.tc);
}

/** Same, but for a value that must land immediately — a pitch snap, a cut. */
export function jump(s: Param, value: number, now: number): void {
  s.last = value;
  s.p.setValueAtTime(value, now);
}

/**
 * The chain every positioned voice ends in: level, air, then the stereo field.
 *
 * Also feeds the reverb send, and it feeds it *pre*-lowpass and post-distance,
 * so a distant explosion arrives as mostly reflected sound. That single routing
 * choice is most of what makes the canyon read as a canyon rather than as a
 * reverb plug-in someone left switched on.
 */
export interface Spatial {
  input: GainNode;
  gain: Param;
  cut: Param;
  pan: Param | null;
  apply(p: Placement, level: number, now: number): void;
  disconnect(): void;
}

export function createSpatial(be: AudioBackend, dest: AudioNode, send: number): Spatial {
  const input = be.ac.createGain();
  input.gain.value = 0;
  const lp = be.ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 19000;
  lp.Q.value = 0.4;
  input.connect(lp);

  let panNode: StereoPannerNode | null = null;
  if (typeof be.ac.createStereoPanner === 'function') {
    panNode = be.ac.createStereoPanner();
    lp.connect(panNode);
    panNode.connect(dest);
  } else {
    lp.connect(dest);
  }

  let sendGain: GainNode | null = null;
  if (send > 0) {
    sendGain = be.ac.createGain();
    sendGain.gain.value = send;
    input.connect(sendGain);
    sendGain.connect(be.verb);
  }

  const gain = param(input.gain, 0, 0.002, 0.03);
  const cut = param(lp.frequency, 19000, 60, 0.05);
  const pan = panNode ? param(panNode.pan, 0, 0.01, 0.04) : null;

  return {
    input, gain, cut, pan,
    apply(p, level, now) {
      set(gain, p.gain * level, now);
      set(cut, p.cut, now);
      if (pan) set(pan, p.pan, now);
    },
    disconnect() {
      try {
        input.disconnect();
        lp.disconnect();
        panNode?.disconnect();
        sendGain?.disconnect();
      } catch { /* a graph that is already torn down is not a problem */ }
    },
  };
}
