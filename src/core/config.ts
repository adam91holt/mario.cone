// Central tuning. Numbers that define *feel* live here so they can be tuned in
// one place and diffed cleanly. Units: metres, seconds, radians.

export const FIXED_DT = 1 / 120;
export const MAX_STEPS_PER_FRAME = 8; // spiral-of-death guard

export const config = {
  sim: { fixedDt: FIXED_DT, maxSteps: MAX_STEPS_PER_FRAME },

  // ── Kart feel ────────────────────────────────────────────────────────────
  // Baseline for a mid-weight racer at 150cc. Per-vehicle stats scale these.
  kart: {
    maxSpeed: 62,            // m/s at full stat
    reverseSpeed: 16,
    accel: 34,               // m/s^2 at rest, falls off toward maxSpeed
    accelCurve: 1.7,         // higher = punchier off the line, softer at the top
    brakeForce: 62,
    coastDrag: 3.2,
    offroadDrag: 26,
    offroadMaxSpeedMul: 0.55,

    steerRate: 2.9,          // rad/s of yaw at reference speed
    steerSpeedFalloff: 0.55, // steering authority lost at top speed
    steerSmoothing: 0.0004,  // damp() smoothing for steer input
    counterSteerBoost: 1.25,

    grip: 15.0,              // lateral velocity killed per second
    driftGrip: 5.5,
    slideThreshold: 0.35,

    // Drift and mini-turbo. Three charge tiers, Mario Kart 8 style.
    drift: {
      minSpeed: 18,
      enterAngle: 0.30,      // rad of yaw offset when the drift snaps in
      maxAngle: 0.62,
      angleRate: 3.4,
      yawBonus: 1.55,        // extra turn rate while drifting
      chargeRate: 1.0,
      tiers: [
        { at: 0.62, boost: 0.62, power: 26, color: 0x4FC3F7, name: 'blue' },
        { at: 1.55, boost: 1.05, power: 34, color: 0xFF9800, name: 'orange' },
        { at: 2.70, boost: 1.55, power: 42, color: 0xE040FB, name: 'purple' },
      ],
      hopHeight: 1.15,
      hopTime: 0.30,
    },

    boost: {
      mushroom:  { time: 1.35, power: 40 },
      pad:       { time: 0.90, power: 38 },
      star:      { time: 7.00, power: 30 },
      bullet:    { time: 6.00, power: 70 },
      slipstream:{ time: 0.70, power: 22 },
      trick:     { time: 0.55, power: 26 },
      fovKick: 11,           // degrees added at full boost
      shake: 0.55,
    },

    air: {
      gravity: 32,
      terminal: 70,
      control: 1.5,          // yaw authority while airborne
      trickWindow: 0.35,     // seconds after leaving the ground to input a trick
      landingSquash: 0.34,
    },

    // Coins raise top speed, exactly like MK8. Ten is the cap.
    coins: { max: 10, speedPerCoin: 0.011, accelPerCoin: 0.008 },

    slipstream: { distance: 14, halfAngle: 0.38, chargeTime: 1.1 },

    hitStun: { spin: 1.5, squish: 2.2, bump: 0.55 },
  },

  // ── Camera ───────────────────────────────────────────────────────────────
  camera: {
    fov: 68,
    near: 0.3,
    far: 3000,
    chase: {
      distance: 8.4,
      height: 3.5,
      lookAhead: 7.5,
      lookHeight: 1.35,
      posSmoothing: 0.0009,  // damp() smoothing constants
      yawSmoothing: 0.0025,
      driftYawOffset: 0.30,
      speedPullback: 2.6,    // extra distance at top speed
      speedFov: 9,           // extra fov degrees at top speed
      landingDip: 0.55,
      bankRoll: 0.11,
    },
    shake: { decay: 5.5, maxOffset: 0.6, maxRoll: 0.05 },
  },

  // ── Race rules ───────────────────────────────────────────────────────────
  race: {
    laps: 3,
    racerCount: 8,
    countdownFrom: 3,
    classes: {
      '50cc':  { speedMul: 0.72, aiSkill: 0.62 },
      '100cc': { speedMul: 0.85, aiSkill: 0.76 },
      '150cc': { speedMul: 1.00, aiSkill: 0.88 },
      '200cc': { speedMul: 1.24, aiSkill: 0.96 },
    },
    defaultClass: '150cc',
    points: [15, 12, 10, 8, 6, 4, 2, 1],
    rocketStart: { window: [0.28, 0.02], boost: { time: 1.5, power: 42 }, burnout: 1.2 },
  },

  // ── AI ───────────────────────────────────────────────────────────────────
  ai: {
    lookahead: 16,
    cornerBrakeFactor: 0.85,
    lineNoise: 2.2,          // metres of racing-line variation between drivers
    rubberBand: { ahead: 0.93, behind: 1.09, range: 130 },
    reactionTime: 0.16,
    itemUseChance: 0.75,
    driftSkill: 0.8,
  },

  // ── Presentation ─────────────────────────────────────────────────────────
  render: {
    exposure: 1.06,
    shadowMapSize: 2048,
    fogNear: 220,
    fogFar: 1400,
  },

  quality: {
    high: { shadows: true,  shadowSize: 2048, postfx: true,  particles: 1.0, drawDistance: 1.0, aa: true },
    med:  { shadows: true,  shadowSize: 1024, postfx: true,  particles: 0.6, drawDistance: 0.8, aa: true },
    low:  { shadows: false, shadowSize: 512,  postfx: false, particles: 0.3, drawDistance: 0.6, aa: false },
  },

  audio: { master: 0.75, music: 0.55, sfx: 0.85, engine: 0.5 },

  // Roadworks high-vis palette. Deliberately distinct from Nintendo's own IP.
  palette: {
    orange: 0xFF6B1A,
    yellow: 0xFFC300,
    asphalt: 0x3A3D46,
    sky: 0x5FC8F5,
    grass: 0x6FCF4A,
    white: 0xFFF8F0,
    dirt: 0xC08B4E,
    rust: 0xB3502A,
    steel: 0x8E99A8,
    hazardRed: 0xE33B2E,
  },
};

export type Config = typeof config;

export default config;
