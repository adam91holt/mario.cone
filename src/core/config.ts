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
    reverseSpeed: 15,
    // Engine authority at rest. The drive curve below eats it as speed climbs,
    // so this number sets the *punch*, not the top speed.
    accel: 47,               // m/s^2 at rest
    // Exponent on (1 - v/vmax). Just above 1 gives a hard shove off the line and
    // a long, grinding approach to the top — the kart should feel like it is
    // straining for the last few m/s rather than arriving there.
    accelCurve: 1.15,
    brakeForce: 30,          // firm, but not a parachute
    coastDrag: 9.5,          // m/s^2 of engine braking at top speed
    coastDragLow: 0.30,      // fraction of that at a standstill
    offroadDrag: 26,         // legacy; the surface table drives the real values
    offroadMaxSpeedMul: 0.55,
    offroadEntryScrub: 0.07, // instant speed bite the moment two wheels leave tarmac

    // A kart that can do a U-turn inside a road width at top speed has no use
    // for a drift. Authority is deliberately generous at walking pace and heavy
    // at the top: full lock is a ~9m radius at 20 m/s and a ~48m radius at 58.
    steerRate: 3.05,         // rad/s of yaw at a standstill
    steerSpeedFalloff: 0.68, // fraction of that authority lost at top speed
    steerFalloffCurve: 0.62, // <1 sheds most of it early, then flattens out
    steerSmoothing: 0.00009, // damp() smoothing for steer input
    driftSteerSmoothing: 0.00001, // the wheel is quicker once committed
    counterSteerBoost: 1.35, // extra authority when catching a slide

    grip: 17.0,              // lateral velocity killed per second
    driftGrip: 5.0,
    // Ceiling on sideways travel, as a fraction of forward speed. Without it the
    // kart can plough sideways at 60 m/s and the whole model stops reading as a
    // vehicle. Excess beyond the ceiling bleeds off at `slipBleed` per second.
    maxSlip: 0.30,
    driftSlip: 0.55,
    slipBleed: 0.0006,       // damp() smoothing as the ceiling moves between the two
    slideThreshold: 0.16,    // lateral speed (as a fraction of forward) that counts as a slide
    slideScrub: 0.60,        // speed bled per second of undriftered sliding

    // Drift and mini-turbo. Three charge tiers, Mario Kart 8 style.
    // The loop: hop -> latch a direction -> the chassis pivots out on touchdown
    // -> charge builds in tiers -> release fires an escalating boost.
    drift: {
      minSpeed: 16,
      enterAngle: 0.30,      // rad of chassis yaw offset when countersteering out
      maxAngle: 0.66,        // ...and when leaning all the way into it
      angleRate: 4.2,        // rad/s the chassis pivots toward its target angle
      snapAngle: 0.10,       // chassis offset at the instant the drift commits
      yawBonus: 1.70,        // extra turn rate while drifting
      counterSteer: 0.15,    // baseline turn left when steering fully out of it
      yawKick: 1.60,         // ...and again, briefly, as the drift snaps in
      kickTime: 0.22,
      chargeRate: 1.16,
      airChargeMul: 0.55,    // charge still builds over jumps, slower
      entryScrub: 0.012,     // committing costs a sliver of speed
      // Charge accrues at ~1.5/s for a mid-handling kart holding full lock, so
      // these read as roughly 0.4s / 1.0s / 1.7s of committed drift.
      tiers: [
        { at: 0.62, boost: 0.70, power: 26, color: 0x4FC3F7, name: 'blue' },
        { at: 1.58, boost: 1.15, power: 34, color: 0xFF9800, name: 'orange' },
        { at: 2.60, boost: 1.75, power: 43, color: 0xE040FB, name: 'purple' },
      ],
      hopHeight: 0.42,       // metres of actual air under the tyres
      hopTime: 0.32,         // and how long it lasts — the two are kept consistent
      hopGrace: 0.55,        // window after a hop in which steering still commits
    },

    boost: {
      mushroom:  { time: 1.35, power: 40 },
      pad:       { time: 0.90, power: 38 },
      star:      { time: 7.00, power: 30 },
      bullet:    { time: 6.00, power: 70 },
      slipstream:{ time: 0.80, power: 24 },
      trick:     { time: 0.60, power: 28 },
      // `power` is a strength scalar, not a speed. These turn it into feel:
      powerScale: 0.0064,    // top-speed multiplier per unit of power (42 -> +27%)
      kick: 0.135,           // instant m/s granted per unit of power when it fires
      pull: 0.0004,          // damp() smoothing dragging speed up to the boost target
      carry: 0.05,           // ...and back down again once it expires
      fovKick: 11,           // degrees added at full boost
      shake: 0.55,
    },

    air: {
      gravity: 34,
      terminal: 70,
      control: 2.4,          // yaw authority while airborne, before speed falloff
      steerPull: 3.0,        // m/s^2 the trajectory bends toward the nose in the air
      groundStick: 0.45,     // metres of clearance the kart still counts as planted
      stickRise: 1.2,        // ...unless it is climbing away faster than this
      trickWindow: 0.35,     // seconds after leaving the ground to input a trick
      trickMinAir: 0.30,     // ...and the airtime a trick has to survive to pay out
      trickMinLaunch: 3.0,   // m/s of upward launch that counts as a real jump
      landingSquash: 0.34,
      landingScrub: 0.16,    // fraction of speed lost on the hardest landing
    },

    // Coins raise top speed, exactly like MK8. Ten is the cap.
    coins: { max: 10, speedPerCoin: 0.011, accelPerCoin: 0.008 },

    // Drafting. Sitting in a rival's wake pulls you along; hold it and it pays
    // out a boost, which is what makes the last corner of a lap worth risking.
    slipstream: {
      distance: 19,          // metres of usable wake behind a rival
      halfAngle: 0.46,       // rad off our nose the rival may sit
      chargeTime: 1.15,      // seconds in the wake before the boost fires
      pull: 0.075,           // top-speed bonus while drafting
      minSpeedFrac: 0.38,    // no draft at crawling speed
      cooldown: 1.30,
    },

    wall: {
      restitution: 0.35,     // how much of a square hit comes back at you
      scrub: 0.60,           // fraction of speed lost on a dead-square first hit
      grind: 11,             // m/s^2 bled while scraping along it afterwards
      driftBreak: 0.30,      // squareness above which a drift is knocked loose
      deflect: 1.6,          // how squarely you have to hit before the nose is turned
      deflectRate: 5.0,      // ...and how fast, per second, once it is
    },

    hitStun: { spin: 1.5, squish: 2.2, bump: 0.55 },
  },

  // ── Camera ───────────────────────────────────────────────────────────────
  // `fov` is vertical degrees; at 16:9 a 50° vertical lens is ~81° horizontal,
  // which is about as wide as a kart racer can go before the kart itself stops
  // reading as an object. Speed and boost then push it wider, and that *change*
  // is what the player feels — not the absolute number.
  camera: {
    fov: 50,
    near: 0.25,
    far: 3000,
    /** damp() constant for the lens. Fast enough to punch, slow enough to breathe. */
    fovSmoothing: 0.02,

    chase: {
      // Rig geometry is an offset on top of the player vehicle's own size, so a
      // train frames like a train and a cone like a cone with no lookup table.
      distance: 6.0,
      distancePerLength: 0.95,
      height: 2.15,
      heightPerHeight: 0.45,
      /** Point on the kart the lens frames, as a fraction of its height. */
      lookHeight: 0.55,
      /** Where the kart sits on screen: fraction of the half-frame below centre. */
      frameLow: 0.30,

      posSmoothing: 0.0011,  // damp() smoothing constants
      heightSmoothing: 0.006,
      yawSmoothing: 0.0022,
      /** Multiplier on those constants while airborne — the rig goes loose. */
      airEase: 6,

      /** Radians the rig swings around the kart at a fully committed drift. This
       *  adds to the chassis' own drift angle, so it stays modest: the flank
       *  should read, not fill the frame. */
      driftYawOffset: 0.14,
      /** Metres the aim reads down the road, at rest and at top speed. */
      lookAhead: 10,
      lookAheadSpeed: 22,
      /** Ceiling on how far the aim leads into a corner, radians. */
      cornerLead: 0.20,
      /** Ceiling on downhill/uphill aim compensation, radians. */
      slopeAim: 0.15,

      speedPullback: 2.3,    // extra distance at top speed
      speedFov: 9,           // extra fov degrees at top speed
      speedDrop: 0.55,       // the rig sinks at speed; ground rush reads faster

      landingDip: 0.55,
      dipStiffness: 88,
      dipDamping: 11,

      bankRoll: 0.075,       // roll from steering
      driftRoll: 0.055,
      rollStiffness: 70,
      rollDamping: 13,
      /** Fraction of the road's own banking the frame adopts. */
      trackBank: 0.4,

      /** Never let the lens get closer than this to the surface below it. */
      groundClearance: 1.3,
      /** Past this gap the kart was teleported, not driven — cut, don't chase. */
      cutDistance: 30,
    },

    /** Per-mode deltas on the chase rig. */
    modes: {
      far: { distance: 5.0, height: 1.9, fov: 4 },
      near: { distance: -2.0, height: -0.5, fov: -4 },
      cinematic: { distance: 13, height: 3.0, fov: -12, orbit: 0.22 },
      overhead: { height: 62 },
    },

    /** The boost punch. `fovScale` is how much of kart.boost.fovKick the lens
     *  actually sustains; the rest of these are the transient hit. */
    boost: {
      fovScale: 0.6,
      kickFov: 8,
      pullback: 2.0,
      drop: 0.5,
      attack: 0.06,
      decay: 4.6,
      roll: 0.03,
    },

    /** Trauma shake. Mostly rotational — a big positional shake clips scenery. */
    shake: { decay: 5.5, maxOffset: 0.28, maxRoll: 0.05, maxAim: 0.045, frequency: 13 },

    /** Pre-race sweep. `duration` must match the race director's intro timer. */
    intro: { duration: 3.2, beatA: 1.2, beatB: 2.2 },

    /** The rig creeps in on each beat of the countdown. */
    countdown: { pullback: 1.5, fov: 3 },

    /** Hero move when the player crosses the line. */
    victory: { time: 2.4, orbit: 1.05, distance: 3.0, height: 0.7, fov: -9 },
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
