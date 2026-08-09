/* =============================================================================
 * SUPERMINE — js/vehicle.js                        [OWNER: Agent 2 — gameplay]
 * -----------------------------------------------------------------------------
 * THE MACHINE. Drawn entirely procedurally from modular parts so that every
 * upgrade visibly ADDS or ENLARGES machinery. Nothing here is a sprite; the
 * whole rig is rebuilt from `parts` levels every frame.
 *
 *                   [ drill heads ]        <- front (-y)
 *              ======[ cutting blade ]======
 *               \\                      //
 *      (grinder)[tr][    chassis    ][tr](grinder)
 *                   [    cabin      ]
 *               \__ [    hopper     ] __/  <- magnet arms
 *                   [   conveyor    ]      <- rear (+y)
 *
 * Everything animates every frame: drums spin, drill heads rotate, grinder
 * discs counter-rotate, treads scroll, the conveyor belt runs, pistons pump,
 * exhausts puff, warning lights strobe. When a part is installed it UNFOLDS
 * (deploy timer 0..1 with an overshooting ease).
 *
 * Public API (main.js / particles.js / camera.js / effects.js depend on these —
 * do NOT change the signatures):
 *   SM.vehicle.init() / reset() / update(dt) / render(ctx)
 *   SM.vehicle.getX() getY() getWidth() getSpeed() getMiningPower() getCollectRadius()
 *   SM.vehicle.applyUpgrade(id) / getUpgradeEffect(id)
 *   SM.vehicle.getBladeWidth() getBladeFrontY() getBank() getLateralSpeed()
 *   SM.vehicle.getResistance() isTransforming() getUpgradeCount() getStat(name)
 * Phase-2 additions (safe to call, not required by main.js):
 *   SM.vehicle.getValueMultiplier() getPartLevel(name) getOverdrive()
 *   SM.vehicle.startOverdrive(seconds)
 * Time-attack additions (the HUD is built against exactly these):
 *   SM.vehicle.getOwnedUpgrades()   LIVE, READ-ONLY [{id,title,level}, ...] in
 *                                   acquisition order; rebuilt only when an
 *                                   upgrade is applied, never per frame
 *   SM.vehicle.getUpgradeVersion()  bumps on every applyUpgrade() — cheap
 *                                   change detection for the HUD
 *   SM.vehicle.halt() / isHalted()  the "time is up" stop
 *
 * Events emitted
 *   vehicle:transform  {part, width}    a part was added / enlarged
 *   pulse:fired        {x, y, radius}   explosive pulse detonated
 *   overdrive:start    {duration}
 *   overdrive:end      {}
 * ========================================================================== */

var SM = SM || {};

SM.vehicle = (function () {
  'use strict';

  var C = SM.config;
  var TAU = Math.PI * 2;

  /* =====================================================================
   * AGENT-2 TUNABLES
   * ================================================================== */
  var TRACK_WIDTH = 24;          // one track at treads level 0, world units
  var TRACK_PER_LEVEL = 9;       // extra track width per `treads` level
  var TRACK_INSET = 2;           // overlap into the chassis
  var BLADE_ARM = 20;            // gap between chassis nose and blade
  var BLADE_THICK = 24;          // blade bar thickness at tier 0 (along y)
  var BLADE_THICK_PER_TIER = 4;
  var HOPPER_LEN = 34;           // hopper length at level 0
  var HOPPER_PER_LEVEL = 17;
  var CONVEYOR_LEN = 56;         // belt length at level 1
  var CONVEYOR_PER_LEVEL = 22;
  var GRINDER_R = 30;            // side grinder disc radius
  var DRILL_R = 26;              // drill head radius (grows with blade tier)
  var ARM_REACH = 50;            // magnet arm base reach past the hull
  var ARM_REACH_STEP = 68;       // ...plus this per arm pair

  // Hard ceilings. Max span must stay <= ~70% of the lane (1280) or the rig
  // grinds the bedrock walls and the camera has nothing left to frame.
  var MAX_BLADE = 840;           // + easeOutBack overshoot stays under 70% lane
  var MAX_BODY = 240;
  var MAX_COLLECT = 580;         // a bigger magnet just eats the whole screen
  var MAX_SPEED_MUL = 1.55;      // keeps the run in the 3-5 minute window

  // Repeat-purchase falloff. Buying the same upgrade again gives
  //   1 + (mul - 1) * FALLOFF^tier
  // so a 4th WIDER BLADE still helps but never runs away.
  var DEFAULT_FALLOFF = 0.74;

  // --- explosive pulse -------------------------------------------------
  var PULSE_PERIOD = 7.5;        // seconds between detonations at tier 1
  var PULSE_PERIOD_STEP = 1.6;   // faster per extra tier
  var PULSE_PERIOD_MIN = 3.6;
  var PULSE_RADIUS = 150;
  var PULSE_RADIUS_STEP = 38;
  var PULSE_RADIUS_MAX = 240;
  var PULSE_FORCE = 520;

  // --- overdrive -------------------------------------------------------
  var OD_PERIOD = 26;            // seconds between automatic frenzies
  var OD_PERIOD_STEP = 6;        // shorter per extra tier
  var OD_DURATION = 6.0;
  var OD_DURATION_STEP = 2.2;
  var OD_POWER = 2.0;            // stat multipliers at full ramp
  var OD_SPEED = 1.30;
  var OD_COLLECT = 1.45;
  var OD_RAMP = 6.0;             // how fast the ramp eases in / out

  // --- rear conveyor ---------------------------------------------------
  var TRAIL_RADIUS = 96;         // auto-collect bubble at conveyor level 1
  var TRAIL_RADIUS_STEP = 54;

  // --- halt ("time is up") ---------------------------------------------
  // The camera is glued to the machine with CAM_FOLLOW stiffness, so snapping
  // the speed to zero would whip the whole world. An exponential decay at 4.5
  // leaves ~1% of the entry speed after one second: it reads as brakes, not
  // as a freeze, and the camera settles on its own with no lurch.
  var HALT_DECAY = 4.5;          // e-folds per second of forward speed
  var HALT_SNAP = 1.5;           // below this, call it stopped (units/sec)

  // Extra bite on top of config's VEHICLE_RESISTANCE_SCALE. Measured over a
  // full run, the raw scale left a granite barrier only ~9% slower than open
  // dirt, so the "hard route / risk of slowing down" lever never registered.
  // At 2.3 a slab drops you to ~0.6x and an obsidian corridor to the 0.34x
  // floor, while ordinary rock still only costs ~15%.
  var RESISTANCE_BOOST = 2.3;

  var TRANSFORM_TIME = C.VEHICLE_TRANSFORM_TIME;

  /* =====================================================================
   * UPGRADE TABLE
   * ---------------------------------------------------------------------
   * Supported keys:
   *   xBlade addBlade xBody xPower addPower xCollect xSpeed xValue
   *   parts   {partName: +levels}   -> switches on / grows geometry
   *   falloff  repeat-purchase decay (default 0.74)
   * Anything that moves a *Target* value animates through easeOutBack for free.
   * ================================================================== */
  var UPGRADE_EFFECTS = {
    wider_blade: {
      title: 'WIDER CUTTING BLADE',
      description: 'Blade span +90%. Mining power +28%.',
      xBlade: 1.90, xPower: 1.28, xCollect: 1.14, xBody: 1.05,
      parts: { bladeTier: 1 }
    },
    drill_heads: {
      title: 'ROTARY DRILL HEADS',
      description: 'Two more drill heads. Mining power +45%.',
      xPower: 1.45, xBlade: 1.10, xCollect: 1.05,
      parts: { drills: 1 }
    },
    side_grinders: {
      title: 'SIDE GRINDERS',
      description: 'Lateral grinder discs. Wider hull, +14% power.',
      xPower: 1.14, xBlade: 1.18, xBody: 1.16, xCollect: 1.10,
      parts: { grinders: 1 }
    },
    mining_power: {
      title: 'REINFORCED CUTTERS',
      description: 'Mining power +55%.',
      xPower: 1.55, xBlade: 1.06,
      parts: { teeth: 1 }
    },
    speed_up: {
      title: 'TURBO DRIVE',
      description: 'Forward speed +16%. Extra exhaust stack.',
      xSpeed: 1.16, xPower: 1.06,
      parts: { stacks: 1 }
    },
    magnet: {
      title: 'MAGNETIC COLLECTORS',
      description: 'Collector arms unfold. Magnet radius +65%.',
      xCollect: 1.65, xBlade: 1.04,
      parts: { magnetArms: 1 }
    },
    multiplier: {
      title: 'ORE REFINERY',
      description: 'All resources are worth 1.7x more.',
      xValue: 1.70, xCollect: 1.08,
      parts: { refinery: 1 }
    },
    rear_conveyor: {
      title: 'REAR CONVEYOR',
      description: 'A collection belt sweeps up everything behind you.',
      xCollect: 1.18, xBody: 1.06,
      parts: { conveyor: 1 }
    },
    explosive_pulse: {
      title: 'EXPLOSIVE PULSE',
      description: 'Periodic shockwave shatters terrain around the rig.',
      xPower: 1.08, xBlade: 1.05,
      parts: { pulse: 1 }
    },
    overdrive: {
      title: 'OVERDRIVE CORE',
      description: 'Periodic frenzy: speed, power and magnet all surge.',
      xPower: 1.06, xBlade: 1.05, xSpeed: 1.05,
      parts: { overdrive: 1, stacks: 1 }
    },
    /* --- automatic threshold transformations --------------------------- */
    auto_hopper: {
      title: 'HOPPER EXPANSION',
      description: 'Storage doubled. Magnet radius +22%.',
      xCollect: 1.22, xBody: 1.10,
      parts: { hopper: 1 }
    },
    mega_treads: {
      title: 'HEAVY TREADS',
      description: 'Wider tracks. +12% power, +10% speed.',
      xBody: 1.18, xPower: 1.12, xSpeed: 1.10,
      parts: { treads: 1 }
    },
    /* --- the final station, just before the core ----------------------- */
    final_overhaul: {
      title: 'CORE BREAKER OVERHAUL',
      description: 'Everything, everywhere, all at once.',
      xBlade: 1.55, xPower: 1.75, xCollect: 1.45, xSpeed: 1.12, xBody: 1.12,
      parts: { drills: 1, grinders: 1, stacks: 1, overdrive: 1, bladeTier: 1 },
      falloff: 1.0
    }
  };

  /* =====================================================================
   * STATE
   * ================================================================== */
  var x = 0, y = 0;
  var vx = 0;                    // lateral velocity
  var speed = 0;                 // current forward speed
  var resistance = 0;            // smoothed blocked-hardness readout

  // Live stats (animated toward their targets).
  var bladeWidth = 0, bladeWidthTarget = 0, bladeWidthFrom = 0;
  var bodyWidth = 0, bodyWidthTarget = 0, bodyWidthFrom = 0;
  var miningPower = 0;
  var collectRadius = 0;
  var speedMul = 1;
  var valueMul = 1;

  // Morph animation (chassis + blade widths)
  var morphT = 1;
  var morphActive = false;

  // Animation phases — all monotonic, wrapped so they never lose precision.
  var drumPhase = 0;
  var drillPhase = 0;
  var grindPhase = 0;
  var treadPhase = 0;
  var beltPhase = 0;
  var lightPhase = 0;
  var pistonPhase = 0;
  var armPhase = 0;
  var smokePhase = 0;
  var hopperPulse = 0;
  var loadSmoothed = 0;

  /* --- modular parts ---------------------------------------------------
   * Every key is declared up front so the object keeps one hidden class.
   * PART_KEYS drives the deploy-animation sweep with no allocation.
   * ------------------------------------------------------------------ */
  var PART_KEYS = ['bladeTier', 'drills', 'grinders', 'magnetArms', 'conveyor',
                   'hopper', 'stacks', 'treads', 'pulse', 'overdrive',
                   'refinery', 'teeth'];
  var parts = {
    bladeTier: 0, drills: 0, grinders: 0, magnetArms: 0, conveyor: 0,
    hopper: 0, stacks: 0, treads: 0, pulse: 0, overdrive: 0,
    refinery: 0, teeth: 0
  };
  // deploy[k] = 0..1 unfold progress of the most recently added instance.
  var deploy = {
    bladeTier: 1, drills: 1, grinders: 1, magnetArms: 1, conveyor: 1,
    hopper: 1, stacks: 1, treads: 1, pulse: 1, overdrive: 1,
    refinery: 1, teeth: 1
  };
  var deployActive = false;

  var tierCount = Object.create(null);   // upgradeId -> times purchased
  var upgradeCount = 0;
  var bank = 0;

  /* --- owned-upgrade manifest -------------------------------------------
   * {id, title, level} in ACQUISITION order, rebuilt only inside
   * applyUpgrade(). The HUD reads this array every step, so it must never
   * be rebuilt or re-sorted per frame — repeat purchases bump `level` in
   * place instead of appending. Treat the array as READ-ONLY from outside.
   * `upgradeVersion` is the cheap change-detector: compare it against the
   * value you saw last frame instead of diffing the array.
   * ------------------------------------------------------------------- */
  var owned = [];
  var upgradeVersion = 0;

  /* --- halt state ------------------------------------------------------ */
  var halted = false;

  /* --- explosive pulse / overdrive runtime ---------------------------- */
  var pulseTimer = 0;
  var odCooldown = 0;
  var odRemaining = 0;
  var odLevel = 0;               // 0..1 smoothed ramp
  var odActive = false;

  /* --- reused event payloads (never stashed) --------------------------- */
  var evTransform = { part: '', width: 0 };
  var evPulse = { x: 0, y: 0, radius: 0 };
  var evOdStart = { duration: 0 };
  var evOdEnd = {};
  var appliedOut = { id: '', title: '', description: '', tier: 0, effect: null };

  /* =====================================================================
   * SETUP
   * ================================================================== */
  function init() {
    SM.events.on('resource:collected', onCollected);
    reset();
  }

  function onCollected() {
    // Hopper "gulp" — decays in update(). O(1), no allocation: this fires
    // up to ~30x per step.
    hopperPulse += 0.05;
    if (hopperPulse > 1) hopperPulse = 1;
  }

  function reset() {
    x = 0;
    y = C.START_Y;
    vx = 0;
    speed = C.VEHICLE_SPEED;
    resistance = 0;

    bladeWidth = bladeWidthTarget = bladeWidthFrom = C.VEHICLE_BLADE_WIDTH;
    bodyWidth = bodyWidthTarget = bodyWidthFrom = C.VEHICLE_BODY_WIDTH;
    miningPower = C.VEHICLE_MINING_POWER;
    collectRadius = C.VEHICLE_COLLECT_RADIUS;
    speedMul = 1;
    valueMul = 1;

    morphT = 1;
    morphActive = false;
    drumPhase = drillPhase = grindPhase = treadPhase = beltPhase = 0;
    lightPhase = pistonPhase = armPhase = smokePhase = 0;
    hopperPulse = 0;
    loadSmoothed = 0;
    upgradeCount = 0;
    bank = 0;
    owned.length = 0;            // same array object — the HUD may hold it
    upgradeVersion = 0;
    halted = false;

    for (var i = 0; i < PART_KEYS.length; i++) {
      parts[PART_KEYS[i]] = 0;
      deploy[PART_KEYS[i]] = 1;
    }
    deployActive = false;
    tierCount = Object.create(null);

    pulseTimer = 0;
    odCooldown = 0;
    odRemaining = 0;
    odLevel = 0;
    odActive = false;

    gradSig = -1;                // force gradient rebuild
  }

  /* =====================================================================
   * UPGRADES
   * ================================================================== */

  /**
   * Apply an upgrade by id. Starts the morph + per-part unfold animations and
   * emits one `vehicle:transform` per part that grew.
   * @return reused descriptor {id, title, description, tier, effect} or null.
   */
  function applyUpgrade(id) {
    var e = UPGRADE_EFFECTS[id];
    if (!e) return null;

    var tier = tierCount[id] || 0;
    tierCount[id] = tier + 1;

    // Diminishing returns on repeat purchases.
    var f = e.falloff === undefined ? DEFAULT_FALLOFF : e.falloff;
    var k = Math.pow(f, tier);

    bladeWidthFrom = bladeWidth;
    bodyWidthFrom = bodyWidth;

    if (e.xBlade) bladeWidthTarget *= 1 + (e.xBlade - 1) * k;
    if (e.addBlade) bladeWidthTarget += e.addBlade * k;
    if (e.xBody) bodyWidthTarget *= 1 + (e.xBody - 1) * k;
    if (e.xPower) miningPower *= 1 + (e.xPower - 1) * k;
    if (e.addPower) miningPower += e.addPower * k;
    if (e.xCollect) collectRadius *= 1 + (e.xCollect - 1) * k;
    if (e.xSpeed) speedMul *= 1 + (e.xSpeed - 1) * k;
    if (e.xValue) valueMul *= 1 + (e.xValue - 1) * k;

    if (bladeWidthTarget > MAX_BLADE) bladeWidthTarget = MAX_BLADE;
    if (bodyWidthTarget > MAX_BODY) bodyWidthTarget = MAX_BODY;
    if (collectRadius > MAX_COLLECT) collectRadius = MAX_COLLECT;
    if (speedMul > MAX_SPEED_MUL) speedMul = MAX_SPEED_MUL;

    // --- parts ---------------------------------------------------------
    if (e.parts) {
      for (var pk in e.parts) {
        if (parts[pk] === undefined) continue;      // unknown part name
        parts[pk] += e.parts[pk];
        deploy[pk] = 0;                             // unfold it
        deployActive = true;
        evTransform.part = pk;
        evTransform.width = getTargetWidth();
        SM.events.emit('vehicle:transform', evTransform);
      }
    }
    // Upgrades with no new geometry still widen something; announce the blade
    // so presentation always gets a transform beat.
    if (!e.parts) {
      evTransform.part = 'blade';
      evTransform.width = getTargetWidth();
      SM.events.emit('vehicle:transform', evTransform);
    }

    // Arm the systems that need a first tick.
    if (parts.pulse > 0 && pulseTimer <= 0) pulseTimer = 2.0;
    if (parts.overdrive > 0 && odCooldown <= 0) odCooldown = 8.0;

    morphT = 0;
    morphActive = true;
    upgradeCount++;

    /* --- owned manifest ------------------------------------------------
     * The only place `owned` is ever touched. Repeat purchases raise the
     * level of the existing entry so the machine's history stays in the
     * order it was actually built, not in purchase-count order.
     * ---------------------------------------------------------------- */
    var slot = null;
    for (var oi = 0; oi < owned.length; oi++) {
      if (owned[oi].id === id) { slot = owned[oi]; break; }
    }
    if (slot) slot.level = tier + 1;
    else owned.push({ id: id, title: e.title || id, level: 1 });
    upgradeVersion++;

    appliedOut.id = id;
    appliedOut.tier = tier;
    appliedOut.effect = e;
    appliedOut.title = tier > 0 ? (e.title + ' MK' + (tier + 1)) : e.title;
    appliedOut.description = e.description || '';
    return appliedOut;
  }

  function getUpgradeEffect(id) { return UPGRADE_EFFECTS[id] || null; }

  /** Overshooting ease — parts snap out past their target then settle. */
  function easeOutBack(t) {
    var c1 = 1.9, c3 = c1 + 1;
    var u = t - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  }

  /* =====================================================================
   * OVERDRIVE
   * ================================================================== */
  function startOverdrive(duration) {
    if (halted || parts.overdrive <= 0) return false;
    var d = duration || (OD_DURATION + (parts.overdrive - 1) * OD_DURATION_STEP);
    odRemaining = d;
    if (!odActive) {
      odActive = true;
      evOdStart.duration = d;
      SM.events.emit('overdrive:start', evOdStart);
      if (SM.camera) SM.camera.shake(16);
    }
    return true;
  }

  function updateOverdrive(dt) {
    // Halted: end any running frenzy and stop the cooldown from arming a new
    // one. odLevel still ramps below, so the glow and the engine note fade
    // out over the same second the machine takes to stop.
    if (halted) {
      if (odActive) {
        odActive = false;
        odRemaining = 0;
        SM.events.emit('overdrive:end', evOdEnd);
      }
    } else if (parts.overdrive > 0) {
      if (odActive) {
        odRemaining -= dt;
        if (odRemaining <= 0) {
          odActive = false;
          odRemaining = 0;
          odCooldown = Math.max(8, OD_PERIOD - (parts.overdrive - 1) * OD_PERIOD_STEP);
          SM.events.emit('overdrive:end', evOdEnd);
        }
      } else {
        odCooldown -= dt;
        if (odCooldown <= 0) startOverdrive(0);
      }
    }
    var target = odActive ? 1 : 0;
    odLevel += (target - odLevel) * (1 - Math.exp(-OD_RAMP * dt));
    if (odLevel < 0.001) odLevel = 0;
  }

  /* =====================================================================
   * EXPLOSIVE PULSE
   * ================================================================== */
  function updatePulse(dt) {
    if (halted || parts.pulse <= 0) return;   // the world goes quiet
    pulseTimer -= dt * (odActive ? 2.0 : 1);
    if (pulseTimer > 0) return;

    var period = PULSE_PERIOD - (parts.pulse - 1) * PULSE_PERIOD_STEP;
    if (period < PULSE_PERIOD_MIN) period = PULSE_PERIOD_MIN;
    pulseTimer = period;

    var radius = PULSE_RADIUS + (parts.pulse - 1) * PULSE_RADIUS_STEP;
    if (radius > PULSE_RADIUS_MAX) radius = PULSE_RADIUS_MAX;

    // Detonate just past the blade so the crater opens the road ahead.
    var px = x;
    var py = getBladeFrontY() - radius * 0.45;
    // Damage scales with the rig so the pulse never becomes a dud late on.
    var dmg = 8 + getMiningPower() * 0.30;

    SM.particles.explode(px, py, radius, dmg, PULSE_FORCE);

    evPulse.x = px; evPulse.y = py; evPulse.radius = radius;
    SM.events.emit('pulse:fired', evPulse);
    if (SM.camera) SM.camera.shake(18);
  }

  /* =====================================================================
   * UPDATE
   * ================================================================== */
  function update(dt) {
    /* --- 1. steering ------------------------------------------------- *
     * Once halted the stick is dead: the run is scored, so a player still
     * holding a key must not be able to nudge the wreck into one more ore
     * pocket while it coasts.
     * ------------------------------------------------------------------ */
    var steer = halted ? 0 : SM.input.getSteer();
    vx += steer * C.VEHICLE_STEER_ACCEL * dt;
    if (steer > -0.02 && steer < 0.02) {
      vx *= Math.exp(-C.VEHICLE_STEER_DRAG * dt);
    }
    var maxLat = C.VEHICLE_STEER_MAX;
    if (vx > maxLat) vx = maxLat; else if (vx < -maxLat) vx = -maxLat;
    x += vx * dt;

    // Keep the (now possibly enormous) machine roughly inside the lane.
    var halfSpan = getWidth() * 0.5;
    var bound = C.LANE_HALF_WIDTH - halfSpan * 0.92;
    if (bound < 60) bound = 60;
    if (x < -bound) { x = -bound; if (vx < 0) vx *= -0.25; }
    else if (x > bound) { x = bound; if (vx > 0) vx *= -0.25; }

    var bankTarget = -(vx / maxLat) * C.VEHICLE_BANK_MAX;
    bank += (bankTarget - bank) * (1 - Math.exp(-9 * dt));

    /* --- 2. morph + part unfold animations ---------------------------- */
    if (morphActive) {
      morphT += dt / TRANSFORM_TIME;
      if (morphT >= 1) { morphT = 1; morphActive = false; }
      var e = easeOutBack(morphT);
      bladeWidth = bladeWidthFrom + (bladeWidthTarget - bladeWidthFrom) * e;
      bodyWidth = bodyWidthFrom + (bodyWidthTarget - bodyWidthFrom) * e;
    }
    if (deployActive) {
      var stillMoving = false;
      for (var i = 0; i < PART_KEYS.length; i++) {
        var k = PART_KEYS[i];
        if (deploy[k] < 1) {
          deploy[k] += dt / TRANSFORM_TIME;
          if (deploy[k] >= 1) deploy[k] = 1; else stillMoving = true;
        }
      }
      deployActive = stillMoving;
    }

    /* --- 3. periodic systems ------------------------------------------ */
    updateOverdrive(dt);
    updatePulse(dt);

    /* --- 4. CUT ------------------------------------------------------- *
     * The cut region is the rectangle immediately in front of the blade.
     * The debris origin sits AHEAD of it so fragments are thrown backwards,
     * spraying around the sides of the machine and into the collector.
     * ------------------------------------------------------------------ */
    var frontY = getBladeFrontY();
    var halfBlade = bladeWidth * 0.5;
    var damaged = 0;
    // Halted: the blade stops removing hardness entirely. Without this the
    // rig would keep chewing the same rock it stopped against, spraying
    // debris and firing material:destroyed long after the buzzer.
    if (!halted) {
      var power = getMiningPower();
      var res = SM.particles.damageSolidInRect(
        x - halfBlade, frontY - C.VEHICLE_BLADE_DEPTH,
        x + halfBlade, frontY + 8,
        power * dt,
        x, frontY - C.VEHICLE_BLADE_DEPTH - 26
      );
      damaged = res.damaged;
      resistance += (res.resistance - resistance) * (1 - Math.exp(-12 * dt));
    } else {
      resistance -= resistance * (1 - Math.exp(-12 * dt));
    }

    /* --- 5. forward motion -------------------------------------------- *
     * Resistance is the summed hardness of everything the blade FAILED to
     * break. A wide blade meets more rock, so growth alone does not make you
     * faster — you have to keep the power curve up with it. That is the
     * self-balancing "risk of slowing down" lever from the spec.
     * ------------------------------------------------------------------ */
    if (halted) {
      speed *= Math.exp(-HALT_DECAY * dt);
      if (speed < HALT_SNAP) speed = 0;
    } else {
      var factor = 1 / (1 + resistance * C.VEHICLE_RESISTANCE_SCALE * RESISTANCE_BOOST);
      if (factor < C.VEHICLE_MIN_SPEED_FACTOR) factor = C.VEHICLE_MIN_SPEED_FACTOR;
      var odSpeed = 1 + (OD_SPEED - 1) * odLevel;
      var targetSpeed = C.VEHICLE_SPEED * speedMul * odSpeed * factor;
      speed += (targetSpeed - speed) * (1 - Math.exp(-8 * dt));
    }
    y -= speed * dt;

    /* --- 6. hand our state to the particle system --------------------- */
    var colRadius = getCollectRadius();
    SM.particles.setCollectorTarget(x, y + C.VEHICLE_BODY_LENGTH * 0.22, colRadius);
    SM.particles.setVehicleBody(
      x, y,
      bodyWidth * 0.5 + trackWidth() - TRACK_INSET,
      C.VEHICLE_BODY_LENGTH * 0.5,
      vx, -speed
    );

    // Rear conveyor: a second, smaller collection bubble dragged behind the
    // machine that sweeps up the settled trail we just ploughed through.
    // Stops with everything else on halt — but the MAIN collector above is
    // deliberately left running, so ore already in flight when the buzzer
    // went still lands in the hopper instead of being orphaned mid-air.
    if (!halted && parts.conveyor > 0) {
      var tr = TRAIL_RADIUS + (parts.conveyor - 1) * TRAIL_RADIUS_STEP;
      SM.particles.collectInRadius(x, y + rearEdge() + tr * 0.35, tr);
    }

    /* --- 7. machinery animation --------------------------------------- */
    var load = damaged / 30;
    if (load > 1) load = 1;
    loadSmoothed += (load - loadSmoothed) * (1 - Math.exp(-8 * dt));
    var rev = 1 + odLevel * 1.4;

    drumPhase += (14 + loadSmoothed * 26) * rev * dt;
    if (drumPhase > 1e6) drumPhase = 0;
    drillPhase += (18 + loadSmoothed * 34) * rev * dt;
    if (drillPhase > 1e6) drillPhase = 0;
    grindPhase += (11 + loadSmoothed * 22) * rev * dt;
    if (grindPhase > 1e6) grindPhase = 0;
    treadPhase += speed * dt * 0.06;
    if (treadPhase > 1e6) treadPhase = 0;
    beltPhase += (60 + speed * 0.35) * dt * 0.08;
    if (beltPhase > 1e6) beltPhase = 0;
    lightPhase += dt * (1 + odLevel);
    if (lightPhase > 1e6) lightPhase = 0;
    pistonPhase += (6 + speed * 0.02) * rev * dt;
    if (pistonPhase > 1e6) pistonPhase = 0;
    armPhase += (1.6 + loadSmoothed * 2.4) * dt;
    if (armPhase > 1e6) armPhase = 0;
    smokePhase += (0.8 + speed * 0.004 + odLevel) * dt;
    if (smokePhase > 1e6) smokePhase = 0;
    hopperPulse -= hopperPulse * 3.2 * dt;
  }

  /* =====================================================================
   * GEOMETRY HELPERS (shared by update, render and the public getters)
   * ================================================================== */
  function trackWidth() { return TRACK_WIDTH + parts.treads * TRACK_PER_LEVEL; }
  function hullHalf() { return bodyWidth * 0.5 + trackWidth() - TRACK_INSET; }
  function hopperLen() { return HOPPER_LEN + parts.hopper * HOPPER_PER_LEVEL; }
  function conveyorLen() {
    return parts.conveyor > 0
      ? CONVEYOR_LEN + (parts.conveyor - 1) * CONVEYOR_PER_LEVEL : 0;
  }
  /** y of the very back of the machine (+y is behind). */
  function rearEdge() {
    return C.VEHICLE_BODY_LENGTH * 0.5 + hopperLen() + conveyorLen();
  }
  function bladeThick() { return BLADE_THICK + parts.bladeTier * BLADE_THICK_PER_TIER; }

  /** Half-span reached by the outermost grinder disc (0 if none). */
  function grinderHalf() {
    if (parts.grinders <= 0) return 0;
    return hullHalf() + GRINDER_R * 1.15 + (parts.grinders - 1) * GRINDER_R * 1.55;
  }
  /** Half-span reached by the magnet collector arms (0 if none). */
  function magnetHalf() {
    if (parts.magnetArms <= 0) return 0;
    return hullHalf() + ARM_REACH + parts.magnetArms * ARM_REACH_STEP;
  }

  function spanOf(blade, body) {
    var s = blade;
    var hull = body * 0.5 + trackWidth() - TRACK_INSET;
    var h2 = hull * 2;
    if (h2 > s) s = h2;
    if (parts.grinders > 0) {
      var g = (hull + GRINDER_R * 1.15 + (parts.grinders - 1) * GRINDER_R * 1.55) * 2;
      if (g > s) s = g;
    }
    if (parts.magnetArms > 0) {
      var m = (hull + ARM_REACH + parts.magnetArms * ARM_REACH_STEP) * 2;
      if (m > s) s = m;
    }
    // Safety net: nothing may reach past the blade cap, or the rig starts
    // grinding bedrock and the camera has no lane left to frame.
    if (s > MAX_BLADE) s = MAX_BLADE;
    return s;
  }

  /* =====================================================================
   * DRAWING HELPERS
   * ================================================================== */
  function roundRect(ctx, rx, ry, w, h, r) {
    if (r > w * 0.5) r = w * 0.5;
    if (r > h * 0.5) r = h * 0.5;
    ctx.beginPath();
    ctx.moveTo(rx + r, ry);
    ctx.lineTo(rx + w - r, ry);
    ctx.quadraticCurveTo(rx + w, ry, rx + w, ry + r);
    ctx.lineTo(rx + w, ry + h - r);
    ctx.quadraticCurveTo(rx + w, ry + h, rx + w - r, ry + h);
    ctx.lineTo(rx + r, ry + h);
    ctx.quadraticCurveTo(rx, ry + h, rx, ry + h - r);
    ctx.lineTo(rx, ry + r);
    ctx.quadraticCurveTo(rx, ry, rx + r, ry);
    ctx.closePath();
  }

  /* --- cached gradients -------------------------------------------------
   * Gradient objects are allocations, so they are rebuilt only when the rig
   * actually changes size (i.e. during the ~0.85s morph), not every frame.
   * Gradient coordinates are interpreted in the local user space at paint
   * time, which is identical from frame to frame, so caching is safe.
   * ------------------------------------------------------------------- */
  var gradSig = -1, gradCtx = null;
  var gChassis = null, gHopper = null, gDrum = null, gBelt = null;

  function ensureGradients(ctx, bw, bl) {
    var sig = ((bw * 2) | 0) * 100003 + ((bladeWidth * 2) | 0) * 31 + parts.hopper;
    if (sig === gradSig && gradCtx === ctx) return;
    gradSig = sig;
    gradCtx = ctx;

    gChassis = ctx.createLinearGradient(-bw * 0.5, 0, bw * 0.5, 0);
    gChassis.addColorStop(0, '#5b636d');
    gChassis.addColorStop(0.35, '#79838f');
    gChassis.addColorStop(0.62, '#69727d');
    gChassis.addColorStop(1, '#464d55');

    var hy0 = bl * 0.32, hy1 = bl * 0.5 + hopperLen();
    gHopper = ctx.createLinearGradient(0, hy0, 0, hy1);
    gHopper.addColorStop(0, '#4a5058');
    gHopper.addColorStop(1, '#292d33');

    var top = -bl * 0.5 - BLADE_ARM - bladeThick() * 0.5;
    gDrum = ctx.createLinearGradient(0, top, 0, top + bladeThick());
    gDrum.addColorStop(0, '#9aa3ad');
    gDrum.addColorStop(0.45, '#5e666f');
    gDrum.addColorStop(1, '#33383e');

    gBelt = ctx.createLinearGradient(-bw * 0.5, 0, bw * 0.5, 0);
    gBelt.addColorStop(0, '#23272d');
    gBelt.addColorStop(0.5, '#363c44');
    gBelt.addColorStop(1, '#23272d');
  }

  /* =====================================================================
   * RENDER  (local space: -y is forward, origin is the chassis centre)
   * ================================================================== */
  function render(ctx) {
    var bl = C.VEHICLE_BODY_LENGTH;
    var bw = bodyWidth;
    var morphFlash = morphActive ? (1 - morphT) : 0;

    ensureGradients(ctx, bw, bl);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(bank);

    drawShadow(ctx, bw, bl);
    drawCollectorField(ctx, bl);
    if (parts.conveyor > 0) drawConveyor(ctx, bw, bl);
    drawHopper(ctx, bw, bl);
    // Arms draw AFTER the hopper: behind it they were completely hidden.
    if (parts.magnetArms > 0) drawMagnetArms(ctx, bw, bl);
    drawTracks(ctx, bw, bl);
    drawChassis(ctx, bw, bl, morphFlash);
    if (parts.grinders > 0) drawGrinders(ctx, bw, bl);
    drawBlade(ctx, bw, bl, morphFlash);
    if (parts.drills > 0) drawDrills(ctx, bw, bl);
    drawExhaust(ctx, bw, bl);
    drawLights(ctx, bw, bl);
    if (odLevel > 0.01) drawOverdriveGlow(ctx, bw, bl);

    ctx.restore();
  }

  /* --- ground shadow ---------------------------------------------------- */
  function drawShadow(ctx, bw, bl) {
    var hh = hullHalf();
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    roundRect(ctx, -hh + 5, -bl * 0.5 + 7, hh * 2, bl + hopperLen() + conveyorLen(), 12);
    ctx.fill();
  }

  /* --- collector field --------------------------------------------------
   * Two thin pulsing rings instead of one giant alpha-filled disc: at a
   * 600-unit magnet radius a filled gradient is over a million blended
   * pixels every frame, and strokes read better anyway.
   * ------------------------------------------------------------------- */
  function drawCollectorField(ctx, bl) {
    var r = getCollectRadius();
    var cy = bl * 0.22;
    var pulse = 0.5 + 0.5 * Math.sin(armPhase * 2.2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(120,220,255,' + (0.16 + odLevel * 0.2).toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(0, cy, r * (0.62 + pulse * 0.34), 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(120,220,255,' + (0.09 + odLevel * 0.14).toFixed(3) + ')';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, cy, r, 0, TAU);
    ctx.stroke();
  }

  /* --- tracks ------------------------------------------------------------ */
  function drawTracks(ctx, bw, bl) {
    var tw = trackWidth();
    var tl = bl * 0.98;
    var ty = -tl * 0.5;
    var pitch = 11 + parts.treads * 2;
    var off = (treadPhase % pitch + pitch) % pitch;

    for (var side = -1; side <= 1; side += 2) {
      var tx = side * (bw * 0.5 + tw * 0.5 - TRACK_INSET) - tw * 0.5;

      // Shoe — much darker than the chassis so the silhouette reads as
      // "tracked machine" instead of one grey slab.
      ctx.fillStyle = '#0f1216';
      roundRect(ctx, tx, ty, tw, tl, 7);
      ctx.fill();
      ctx.strokeStyle = '#0d0f12';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.save();
      roundRect(ctx, tx, ty, tw, tl, 7);
      ctx.clip();
      for (var p = -pitch; p < tl + pitch; p += pitch) {
        ctx.fillStyle = '#5b646f';
        ctx.fillRect(tx + 2, ty + p + off, tw - 4, 6);
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.fillRect(tx + 2, ty + p + off, tw - 4, 2);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(tx + tw * 0.28, ty, tw * 0.2, tl);
      ctx.restore();

      // drive sprockets
      ctx.fillStyle = '#4b535d';
      ctx.beginPath();
      ctx.arc(tx + tw * 0.5, ty + 9, 5.5, 0, TAU);
      ctx.arc(tx + tw * 0.5, ty + tl - 9, 5.5, 0, TAU);
      ctx.fill();

      // Extra road wheels appear with heavy treads.
      if (parts.treads > 0) {
        ctx.fillStyle = '#3a424c';
        var n = 2 + parts.treads;
        for (var w = 0; w < n; w++) {
          var wy = ty + tl * (0.24 + 0.52 * (w / Math.max(1, n - 1)));
          ctx.beginPath();
          ctx.arc(tx + tw * 0.5, wy, 4.2, 0, TAU);
          ctx.fill();
        }
      }
    }
  }

  /* --- rear hopper -------------------------------------------------------- */
  function drawHopper(ctx, bw, bl) {
    var dep = easeOutBack(deploy.hopper);
    var hl = hopperLen() * (0.5 + 0.5 * dep);
    var y0 = bl * 0.32;
    var y1 = bl * 0.5 + hl;
    var w0 = bw * 0.86, w1 = bw * (1.02 + parts.hopper * 0.10);
    var pulse = hopperPulse;

    ctx.beginPath();
    ctx.moveTo(-w0 * 0.5, y0);
    ctx.lineTo(w0 * 0.5, y0);
    ctx.lineTo(w1 * 0.5, y1);
    ctx.lineTo(-w1 * 0.5, y1);
    ctx.closePath();
    ctx.fillStyle = gHopper;
    ctx.fill();
    ctx.strokeStyle = '#15181c';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Ore glow inside the hopper, brightening with every gulp.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-w0 * 0.5, y0);
    ctx.lineTo(w0 * 0.5, y0);
    ctx.lineTo(w1 * 0.5, y1);
    ctx.lineTo(-w1 * 0.5, y1);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = 'rgba(255,190,70,' + (0.16 + pulse * 0.55).toFixed(3) + ')';
    ctx.fillRect(-w1 * 0.5, y1 - 20 - pulse * 16 - parts.hopper * 8, w1, 46 + parts.hopper * 10);
    ctx.restore();

    // ribs — one more per hopper level
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    var ribs = 3 + parts.hopper;
    for (var i = 1; i < ribs; i++) {
      var t = i / ribs;
      var yy = y0 + (y1 - y0) * t;
      var ww = (w0 + (w1 - w0) * t) * 0.5;
      ctx.beginPath();
      ctx.moveTo(-ww, yy); ctx.lineTo(ww, yy);
      ctx.stroke();
    }

    // Overflow funnels on the hopper shoulders once it has been expanded.
    if (parts.hopper > 0) {
      ctx.fillStyle = '#3b424a';
      for (var s = -1; s <= 1; s += 2) {
        ctx.beginPath();
        ctx.moveTo(s * w0 * 0.5, y0 + 6);
        ctx.lineTo(s * (w1 * 0.5 + 16 * dep), y0 + 20);
        ctx.lineTo(s * (w1 * 0.5 + 16 * dep), y0 + 40);
        ctx.lineTo(s * w0 * 0.52, y0 + 30);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#15181c';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  /* --- rear collection conveyor -------------------------------------------
   * A belt that runs FORWARD (toward the hopper) carrying scooped material.
   * Chevrons scroll along it; side scoops sweep the trail into the mouth.
   * ---------------------------------------------------------------------- */
  function drawConveyor(ctx, bw, bl) {
    var dep = easeOutBack(deploy.conveyor);
    var len = conveyorLen() * dep;
    if (len < 1) return;
    var y0 = bl * 0.5 + hopperLen() - 4;
    var w = bw * (1.06 + (parts.conveyor - 1) * 0.14);
    var halfW = w * 0.5;

    // belt bed
    ctx.fillStyle = gBelt;
    roundRect(ctx, -halfW, y0, w, len, 8);
    ctx.fill();
    ctx.strokeStyle = '#111418';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // scrolling chevrons (moving toward -y == into the hopper)
    ctx.save();
    roundRect(ctx, -halfW, y0, w, len, 8);
    ctx.clip();
    var pitch = 20;
    var off = (beltPhase * pitch) % pitch;
    ctx.strokeStyle = 'rgba(255,196,64,0.55)';
    ctx.lineWidth = 4;
    for (var cy = y0 + len + pitch; cy > y0 - pitch; cy -= pitch) {
      var yy = cy - off;
      ctx.beginPath();
      ctx.moveTo(-halfW + 4, yy + 8);
      ctx.lineTo(0, yy);
      ctx.lineTo(halfW - 4, yy + 8);
      ctx.stroke();
    }
    ctx.restore();

    // rollers
    ctx.fillStyle = '#565f6a';
    ctx.beginPath();
    ctx.arc(0, y0 + 6, 5, 0, TAU);
    ctx.arc(0, y0 + len - 6, 5, 0, TAU);
    ctx.fill();

    // side scoops that funnel the trail in
    ctx.fillStyle = '#2f353d';
    for (var s = -1; s <= 1; s += 2) {
      var reach = (36 + (parts.conveyor - 1) * 22) * dep;
      ctx.beginPath();
      ctx.moveTo(s * halfW, y0 + len * 0.15);
      ctx.lineTo(s * (halfW + reach), y0 + len * 0.75);
      ctx.lineTo(s * (halfW + reach), y0 + len);
      ctx.lineTo(s * halfW, y0 + len * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#14171b';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  /* --- magnetic collector arms --------------------------------------------
   * Two (or four) jointed arms that sweep open and closed behind the rig,
   * with glowing coil rings at the tips.
   * ---------------------------------------------------------------------- */
  function drawMagnetArms(ctx, bw, bl) {
    var dep = easeOutBack(deploy.magnetArms);
    var hh = hullHalf();
    var sweep = Math.sin(armPhase) * 0.16;

    ctx.lineCap = 'round';
    for (var a = 0; a < parts.magnetArms; a++) {
      var reach = (ARM_REACH + (a + 1) * ARM_REACH_STEP) * dep;
      var baseY = bl * 0.12 + a * 26;
      var tipY = baseY + 54 + a * 18 + Math.sin(armPhase + a) * 6;
      for (var s = -1; s <= 1; s += 2) {
        var elbowX = s * (hh + reach * 0.45);
        var elbowY = baseY + 20;
        var tipX = s * (hh + reach) * (1 + sweep);

        ctx.strokeStyle = '#39414b';
        ctx.lineWidth = 13 - a * 2;
        ctx.beginPath();
        ctx.moveTo(s * hh * 0.8, baseY);
        ctx.lineTo(elbowX, elbowY);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();
        ctx.strokeStyle = '#5f6875';
        ctx.lineWidth = 5 - a;
        ctx.beginPath();
        ctx.moveTo(s * hh * 0.8, baseY);
        ctx.lineTo(elbowX, elbowY);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();

        // joint
        ctx.fillStyle = '#5a636e';
        ctx.beginPath();
        ctx.arc(elbowX, elbowY, 7, 0, TAU);
        ctx.fill();

        // coil ring at the tip
        var glow = 0.55 + 0.35 * Math.sin(armPhase * 3 + a + s);
        ctx.strokeStyle = 'rgba(120,220,255,' + glow.toFixed(3) + ')';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(tipX, tipY, 20 - a * 2, 0, TAU);
        ctx.stroke();
        ctx.fillStyle = 'rgba(120,220,255,0.20)';
        ctx.beginPath();
        ctx.arc(tipX, tipY, 30 - a * 2, 0, TAU);
        ctx.fill();
      }
    }
    ctx.lineCap = 'butt';
  }

  /* --- chassis + cabin ------------------------------------------------------ */
  function drawChassis(ctx, bw, bl, flash) {
    ctx.fillStyle = gChassis;
    roundRect(ctx, -bw * 0.5, -bl * 0.5, bw, bl, 10);
    ctx.fill();
    ctx.strokeStyle = '#191d22';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.save();
    roundRect(ctx, -bw * 0.5, -bl * 0.5, bw, bl, 10);
    ctx.clip();
    // hazard stripes across the nose
    ctx.fillStyle = 'rgba(255,190,40,0.85)';
    var sy = -bl * 0.5 + 6;
    for (var sx = -bw * 0.5 - 14; sx < bw * 0.5 + 14; sx += 18) {
      ctx.beginPath();
      ctx.moveTo(sx, sy); ctx.lineTo(sx + 9, sy);
      ctx.lineTo(sx + 20, sy + 13); ctx.lineTo(sx + 11, sy + 13);
      ctx.closePath();
      ctx.fill();
    }
    // panel seams
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1.5;
    for (var p = -bl * 0.25; p < bl * 0.5; p += 22) {
      ctx.beginPath(); ctx.moveTo(-bw * 0.5, p); ctx.lineTo(bw * 0.5, p); ctx.stroke();
    }
    // refinery plumbing appears with the ORE REFINERY upgrade
    if (parts.refinery > 0) {
      ctx.strokeStyle = 'rgba(120,240,190,0.55)';
      ctx.lineWidth = 3;
      for (var rq = 0; rq < parts.refinery + 1; rq++) {
        var ry = -bl * 0.1 + rq * 14;
        ctx.beginPath();
        ctx.moveTo(-bw * 0.42, ry);
        ctx.lineTo(-bw * 0.1, ry + 8);
        ctx.lineTo(bw * 0.1, ry - 8);
        ctx.lineTo(bw * 0.42, ry);
        ctx.stroke();
      }
    }
    ctx.restore();

    // pistons that pump with the drum
    var pump = Math.sin(pistonPhase) * 3;
    for (var side = -1; side <= 1; side += 2) {
      ctx.fillStyle = '#2c3138';
      roundRect(ctx, side * bw * 0.31 - 4, -bl * 0.30 + pump, 8, 26, 3);
      ctx.fill();
      ctx.fillStyle = '#9aa4b0';
      roundRect(ctx, side * bw * 0.31 - 2.5, -bl * 0.30 + pump + 20, 5, 12, 2);
      ctx.fill();
    }

    // cabin
    var cw = bw * 0.52, ch = 30;
    ctx.fillStyle = '#3d444c';
    roundRect(ctx, -cw * 0.5, -6, cw, ch, 7);
    ctx.fill();
    ctx.strokeStyle = '#14171b';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = odLevel > 0.02
      ? 'rgba(255,' + (200 - odLevel * 90).toFixed(0) + ',120,0.95)'
      : 'rgba(150,235,255,0.92)';
    roundRect(ctx, -cw * 0.5 + 5, -1, cw - 10, ch - 12, 4);
    ctx.fill();

    if (flash > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + (flash * 0.45).toFixed(3) + ')';
      roundRect(ctx, -bw * 0.5, -bl * 0.5, bw, bl, 10);
      ctx.fill();
    }
  }

  /* --- side grinders --------------------------------------------------------
   * Toothed discs on outriggers. They counter-rotate and are the widest thing
   * on the machine until the blade overtakes them.
   * ---------------------------------------------------------------------- */
  function drawGrinders(ctx, bw, bl) {
    var dep = easeOutBack(deploy.grinders);
    var hh = hullHalf();

    for (var g = 0; g < parts.grinders; g++) {
      var out = (GRINDER_R * 1.15 + g * GRINDER_R * 1.55) * (g === parts.grinders - 1 ? dep : 1);
      var gy = -bl * 0.16 + g * 46;
      var rr = GRINDER_R - g * 3;
      for (var s = -1; s <= 1; s += 2) {
        var gx = s * (hh + out);

        // outrigger arm
        ctx.strokeStyle = '#39414b';
        ctx.lineWidth = 11;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(s * hh * 0.7, gy - 8);
        ctx.lineTo(gx, gy);
        ctx.stroke();
        ctx.lineCap = 'butt';

        // disc
        ctx.fillStyle = '#464e58';
        ctx.beginPath();
        ctx.arc(gx, gy, rr, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = '#14171b';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // teeth — drawn as short radial spokes at the rim
        var dir = s * (g & 1 ? -1 : 1);
        var ph = grindPhase * dir;
        var teeth = 8 + g;
        ctx.strokeStyle = '#c3ccd6';
        ctx.lineWidth = 4;
        ctx.beginPath();
        for (var t = 0; t < teeth; t++) {
          var a = ph + (t / teeth) * TAU;
          var ca = Math.cos(a), sa = Math.sin(a);
          ctx.moveTo(gx + ca * (rr - 7), gy + sa * (rr - 7));
          ctx.lineTo(gx + ca * (rr + 5), gy + sa * (rr + 5));
        }
        ctx.stroke();

        // hub
        ctx.fillStyle = '#8b95a1';
        ctx.beginPath();
        ctx.arc(gx, gy, rr * 0.32, 0, TAU);
        ctx.fill();

        // sparks under load
        if (loadSmoothed > 0.15) {
          ctx.fillStyle = 'rgba(255,170,60,' + (loadSmoothed * 0.5).toFixed(3) + ')';
          ctx.beginPath();
          ctx.arc(gx, gy - rr * 0.8, 5 + loadSmoothed * 5, 0, TAU);
          ctx.fill();
        }
      }
    }
  }

  /* --- front cutting blade --------------------------------------------------- */
  function drawBlade(ctx, bw, bl, flash) {
    var thick = bladeThick();
    var frontY = -bl * 0.5 - BLADE_ARM;      // blade bar centre line
    var halfW = bladeWidth * 0.5;
    var top = frontY - thick * 0.5;

    // Support arms MUST splay out to the blade tips or a wide upgraded blade
    // looks like it is floating unattached in front of the rig.
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#2b3138';
    ctx.lineWidth = 12;
    var s;
    for (s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.moveTo(s * bw * 0.30, -bl * 0.5 + 10);
      ctx.lineTo(s * Math.min(halfW - 10, bw * 0.30 + 30), frontY + 2);
      ctx.stroke();
    }
    ctx.strokeStyle = '#454d57';
    ctx.lineWidth = 8;
    for (s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.moveTo(s * bw * 0.46, -bl * 0.24);
      ctx.lineTo(s * (halfW - 8), frontY + 3);
      ctx.stroke();
      // One extra brace unfolds per blade tier — visible new machinery.
      for (var b = 0; b < parts.bladeTier; b++) {
        var t = (b + 1) / (parts.bladeTier + 1);
        var dp = (b === parts.bladeTier - 1) ? easeOutBack(deploy.bladeTier) : 1;
        ctx.lineWidth = 6 - b;
        ctx.beginPath();
        ctx.moveTo(s * bw * 0.5, bl * (0.06 - b * 0.06));
        ctx.lineTo(s * (halfW * (0.30 + t * 0.55)) * dp, frontY + 6);
        ctx.stroke();
      }
      ctx.lineWidth = 8;
    }
    ctx.lineCap = 'butt';

    // --- rotating drum -------------------------------------------------
    ctx.save();
    roundRect(ctx, -halfW, top, bladeWidth, thick, 7);
    ctx.clip();
    ctx.fillStyle = gDrum;
    ctx.fillRect(-halfW, top, bladeWidth, thick);

    // Diagonal stripes scrolling sideways read as a spinning cylinder.
    var pitch = 20;
    var off = (drumPhase * 3.2) % pitch;
    ctx.fillStyle = 'rgba(255,205,70,0.75)';
    for (var sx = -halfW - pitch * 2; sx < halfW + pitch; sx += pitch) {
      ctx.beginPath();
      ctx.moveTo(sx + off, top);
      ctx.lineTo(sx + off + 8, top);
      ctx.lineTo(sx + off + 8 + thick, top + thick);
      ctx.lineTo(sx + off + thick, top + thick);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(-halfW, top + 2, bladeWidth, 5);
    ctx.restore();

    ctx.strokeStyle = '#14171b';
    ctx.lineWidth = 3;
    roundRect(ctx, -halfW, top, bladeWidth, thick, 7);
    ctx.stroke();

    // --- cutting teeth ---------------------------------------------------
    var toothPitch = 15 - parts.teeth * 2;
    if (toothPitch < 9) toothPitch = 9;
    var n = Math.max(3, Math.round(bladeWidth / toothPitch));
    if (n > 90) n = 90;                        // draw-call ceiling
    var step = bladeWidth / n;
    var toothLen = 11 + parts.teeth * 3;
    for (var i = 0; i < n; i++) {
      var cx = -halfW + step * (i + 0.5);
      // Teeth chatter in a travelling wave — reads as violent grinding.
      var wob = Math.sin(drumPhase * 2.4 + i * 0.9) * 2.4;
      var len = toothLen + wob;
      ctx.beginPath();
      ctx.moveTo(cx - step * 0.38, top);
      ctx.lineTo(cx, top - len);
      ctx.lineTo(cx + step * 0.38, top);
      ctx.closePath();
      ctx.fillStyle = (i & 1) ? '#c8d2dc' : '#98a4b0';
      ctx.fill();
    }

    // hot cutting edge glow, brighter under load and in overdrive
    var glow = 0.20 + Math.min(0.5, resistance * 0.004) + odLevel * 0.3;
    ctx.fillStyle = 'rgba(255,150,40,' + glow.toFixed(3) + ')';
    ctx.fillRect(-halfW, top - 3, bladeWidth, 4);

    // --- morph flourish ---------------------------------------------------
    if (flash > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,255,255,' + (flash * 0.8).toFixed(3) + ')';
      roundRect(ctx, -halfW, top - 4, bladeWidth, thick + 8, 8);
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,220,255,' + (flash * 0.85).toFixed(3) + ')';
      ctx.lineWidth = 3;
      var rr = (1 - flash) * 70 + 10;
      for (var t2 = -1; t2 <= 1; t2 += 2) {
        ctx.beginPath();
        ctx.arc(t2 * halfW, frontY, rr, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /* --- rotating drill heads ----------------------------------------------
   * Mounted in front of the blade bar, spread across its span. Each is a
   * conical bit: a spinning spoke star inside a ring, plus a bright core.
   * ---------------------------------------------------------------------- */
  function drawDrills(ctx, bw, bl) {
    var dep = easeOutBack(deploy.drills);
    var thick = bladeThick();
    var frontY = -bl * 0.5 - BLADE_ARM;
    var baseR = DRILL_R + parts.bladeTier * 3;
    var dy = frontY - thick * 0.5 - baseR * 0.62;
    var halfW = bladeWidth * 0.5;

    var pairs = parts.drills;                 // one pair per level
    for (var p = 0; p < pairs; p++) {
      var frac = (p + 1) / (pairs + 1);       // spread across the blade half
      var isNew = (p === pairs - 1);
      var scale = isNew ? dep : 1;
      var rr = (baseR - p * 3) * scale;
      if (rr < 2) continue;
      for (var s = -1; s <= 1; s += 2) {
        var dx = s * halfW * frac;

        // mount
        ctx.fillStyle = '#2f353d';
        roundRect(ctx, dx - 7, dy, 14, baseR * 1.1, 3);
        ctx.fill();

        // housing ring
        ctx.fillStyle = '#4d5661';
        ctx.beginPath();
        ctx.arc(dx, dy, rr, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = '#14171b';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // spinning spokes
        var ph = drillPhase * (s > 0 ? 1 : -1) + p;
        ctx.strokeStyle = '#d3dae2';
        ctx.lineWidth = 5;
        ctx.beginPath();
        for (var k = 0; k < 5; k++) {
          var a = ph + (k / 5) * TAU;
          var ca = Math.cos(a), sa = Math.sin(a);
          ctx.moveTo(dx - ca * rr * 0.85, dy - sa * rr * 0.85);
          ctx.lineTo(dx + ca * rr * 0.85, dy + sa * rr * 0.85);
        }
        ctx.stroke();

        // hot core
        ctx.fillStyle = 'rgba(255,' + (150 + odLevel * 80).toFixed(0) + ',60,' +
                        (0.55 + loadSmoothed * 0.4).toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(dx, dy, rr * 0.34, 0, TAU);
        ctx.fill();
      }
    }
  }

  /* --- exhaust stacks + smoke ------------------------------------------------ */
  function drawExhaust(ctx, bw, bl) {
    var n = 1 + parts.stacks;                 // per side
    var dep = easeOutBack(deploy.stacks);
    var y0 = bl * 0.32;
    for (var s = -1; s <= 1; s += 2) {
      for (var i = 0; i < n; i++) {
        var isNew = (i === n - 1 && parts.stacks > 0);
        var sc = isNew ? dep : 1;
        var sx = s * (bw * 0.30 - i * 15);
        var h = (18 + i * 4) * sc;
        if (h < 1) continue;

        ctx.fillStyle = '#20242a';
        roundRect(ctx, sx - 4, y0 - h + 2, 8, h, 3);
        ctx.fill();

        // exhaust flame
        var flick = 0.25 + 0.2 * Math.sin(pistonPhase * 2 + s + i) + odLevel * 0.4;
        ctx.fillStyle = 'rgba(255,140,60,' + flick.toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(sx, y0 - h + 1, 3.2 + odLevel * 2, 0, TAU);
        ctx.fill();

        // three drifting smoke puffs per stack
        for (var q = 0; q < 3; q++) {
          var t = (smokePhase * 0.6 + q * 0.333 + i * 0.17) % 1;
          var a = (1 - t) * (0.18 + odLevel * 0.15);
          if (a <= 0.01) continue;
          ctx.fillStyle = 'rgba(90,90,100,' + a.toFixed(3) + ')';
          ctx.beginPath();
          ctx.arc(sx + s * t * 6, y0 - h - 4 - t * 34, 3 + t * 11, 0, TAU);
          ctx.fill();
        }
      }
    }
  }

  /* --- warning lights --------------------------------------------------------- */
  function drawLights(ctx, bw, bl) {
    var on = (lightPhase * 3) % 2 < 1;
    var hh = hullHalf();
    var n = 1 + Math.min(2, (upgradeCount / 5) | 0);
    for (var s = -1; s <= 1; s += 2) {
      for (var i = 0; i < n; i++) {
        var lit = ((lightPhase * 3 + i * 0.5) % 2) < 1;
        var lx = s * (hh + 2);
        var ly = -bl * 0.5 + 16 + i * 40;
        ctx.fillStyle = lit ? 'rgba(255,190,40,0.95)' : 'rgba(120,80,20,0.8)';
        ctx.beginPath();
        ctx.arc(lx, ly, 4.5, 0, TAU);
        ctx.fill();
        if (lit) {
          ctx.fillStyle = 'rgba(255,190,40,0.22)';
          ctx.beginPath();
          ctx.arc(lx, ly, 13, 0, TAU);
          ctx.fill();
        }
      }
    }
    // A rotating beacon on the cabin roof once the rig is seriously upgraded.
    if (upgradeCount >= 4) {
      var a = (lightPhase * 4) % TAU;
      ctx.fillStyle = 'rgba(255,80,60,' + (on ? 0.9 : 0.45) + ')';
      ctx.beginPath();
      ctx.arc(0, 8, 5, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,80,60,0.16)';
      ctx.beginPath();
      ctx.moveTo(0, 8);
      ctx.arc(0, 8, 46, a, a + 0.7);
      ctx.closePath();
      ctx.fill();
    }
  }

  /* --- overdrive overlay ------------------------------------------------------ */
  function drawOverdriveGlow(ctx, bw, bl) {
    var a = odLevel * (0.22 + 0.10 * Math.sin(lightPhase * 18));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,120,40,' + a.toFixed(3) + ')';
    roundRect(ctx, -hullHalf(), -bl * 0.5, hullHalf() * 2, bl + hopperLen(), 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,200,80,' + (odLevel * 0.7).toFixed(3) + ')';
    ctx.lineWidth = 3;
    var halfW = bladeWidth * 0.5;
    var frontY = -bl * 0.5 - BLADE_ARM;
    ctx.beginPath();
    ctx.moveTo(-halfW, frontY - bladeThick());
    ctx.lineTo(halfW, frontY - bladeThick());
    ctx.stroke();
    ctx.restore();
  }

  /* =====================================================================
   * GETTERS  (stable contract — camera, effects, sound and ui rely on these)
   * ================================================================== */
  function getWidth() { return spanOf(bladeWidth, bodyWidth); }
  function getTargetWidth() { return spanOf(bladeWidthTarget, bodyWidthTarget); }

  function getBladeFrontY() {
    return y - C.VEHICLE_BODY_LENGTH * 0.5 - BLADE_ARM - bladeThick() * 0.5;
  }

  function getMiningPower() { return miningPower * (1 + (OD_POWER - 1) * odLevel); }
  function getCollectRadius() {
    var r = collectRadius * (1 + (OD_COLLECT - 1) * odLevel);
    return r > MAX_COLLECT * 1.6 ? MAX_COLLECT * 1.6 : r;
  }

  /* =====================================================================
   * HALT — "time is up"
   * ---------------------------------------------------------------------
   * Begins the stop; it does NOT teleport anything. From here update() bleeds
   * the forward speed away over about a second, ignores steering, and shuts
   * down mining, the explosive pulse and overdrive so the world goes quiet.
   * Only reset() clears it, so a halt cannot be undone mid-run.
   * ================================================================== */
  function halt() {
    if (halted) return false;
    halted = true;
    return true;
  }

  function getStat(name) {
    switch (name) {
      case 'power': return getMiningPower();
      case 'blade': return bladeWidth;
      case 'collect': return getCollectRadius();
      case 'speed': return speed;
      case 'upgrades': return upgradeCount;
      case 'multiplier': return valueMul;
      case 'overdrive': return odLevel;
      default: return 0;
    }
  }

  return {
    init: init,
    reset: reset,
    update: update,
    render: render,
    applyUpgrade: applyUpgrade,
    getUpgradeEffect: getUpgradeEffect,

    getX: function () { return x; },
    getY: function () { return y; },
    getWidth: getWidth,
    getSpeed: function () { return speed; },
    getMiningPower: getMiningPower,
    getCollectRadius: getCollectRadius,

    getBladeWidth: function () { return bladeWidth; },
    getBladeFrontY: getBladeFrontY,
    getBank: function () { return bank; },
    getLateralSpeed: function () { return vx; },
    getResistance: function () { return resistance; },
    isTransforming: function () { return morphActive || deployActive; },
    getUpgradeCount: function () { return upgradeCount; },
    getStat: getStat,

    /* --- Phase 2 additions ------------------------------------------- */
    getValueMultiplier: function () { return valueMul; },
    getPartLevel: function (name) { return parts[name] || 0; },
    getOverdrive: function () { return odLevel; },
    isOverdriveActive: function () { return odActive; },
    startOverdrive: startOverdrive,

    /* --- TIME ATTACK (the HUD contract) ------------------------------- */
    // LIVE array, rebuilt only inside applyUpgrade(). Read-only: sorting or
    // splicing it from outside corrupts the machine's build history.
    getOwnedUpgrades: function () { return owned; },
    getUpgradeVersion: function () { return upgradeVersion; },
    halt: halt,
    isHalted: function () { return halted; }
  };
})();
