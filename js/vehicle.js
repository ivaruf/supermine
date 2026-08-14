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
 * ADVENTURE MODE DRAWS A DIFFERENT MACHINE FROM THE SAME PARTS. The diagram
 * above is the TIME ATTACK rig, built by UPGRADE_EFFECTS. Adventure's geometry
 * comes from SM.rig.getPartFlags(), and its two big subassemblies are their own
 * thing because they have to communicate a SHOP LADDER rather than a pickup:
 *
 *              [ point ]                    <- front (-y)
 *             [[ auger ]]                   drawDrillRig()  — the DRILL tiers:
 *          ===[ reamer bar ]===             one bit that gets longer, thicker,
 *      [tr][      chassis      ][tr]        deeper-fluted, then hot, then lit
 *          [   intake throat   ]            drawIntake()    — where ore goes in
 *          [ bay 0: the load   ]            drawOreBed()    — the CARGO tiers:
 *          [ bay 1 ] [ bay 2 ]              a tub that grows into an ore train
 *
 * The seam is `advMode()` and it is taken in exactly two places, both inside
 * drawMachine(). Everything else — tracks, chassis, cabin, exhaust, lamps,
 * radiators, armour, dish — is shared and identical in both modes.
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
 *   boost:start        {duration}      one per BOOST BLOCK, not per fragment:
 *                                      `duration` is the whole block's worth,
 *                                      and the HUD prints it, so it is emitted
 *                                      only after the cloud has stopped
 *                                      arriving (see BOOST_ANNOUNCE)
 *   boost:end          null
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

  // --- speed boost (scattered 'boostcell' blocks) ----------------------
  // Deliberately a LESSER effect than overdrive, in scope rather than in
  // length: overdrive is the machine's own periodic frenzy and buffs
  // everything (2.0x power, 1.3x speed, 1.45x collect), a boost block is a
  // found object that only makes you FAST. Keeping them distinct means the
  // orange glow always means the same thing even when both are running, and
  // means catching a block mid-frenzy is a genuine bonus rather than a
  // rounding error.
  var BOOST_SPEED = 1.55;        // top speed multiplier at full ramp
  // Paid per collected fragment. A whole block is ~15 deposits of 5 fragments
  // (see terrain.js PICKUP_RADIUS), so taking one cleanly is ~6 seconds — the
  // same order as an overdrive, because a speed-only buff that lasted half as
  // long as the frenzy would not be worth the detour it costs to reach.
  var BOOST_PER_PIECE = 0.08;
  // Cap, so a lucky pair of blocks is not a free run. One clean block is ~6s,
  // so this is "a block and a bit": a second block caught mid-boost tops you
  // up rather than doubling you.
  var BOOST_MAX = 8.0;
  var BOOST_RAMP = 9.0;          // snappier than overdrive's 6.0 — it's a kick
  // How long addBoost() waits for the rest of the cloud before announcing.
  // Same job as level.js TIME_FLUSH and the same reasoning: the splash prints
  // the duration off this event, so it must not fire while fragments of the
  // same block are still arriving or it announces a number that is already
  // wrong by the time it is on screen.
  var BOOST_ANNOUNCE = 0.22;

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
   * AGENT-1 TUNABLES — ADVENTURE MODE (free 2D driving)
   * ---------------------------------------------------------------------
   * THE FEEL WE ARE AFTER, because every number below only makes sense against
   * it: a TRACKED DIGGER chewing through material that closes around it. Not a
   * cursor, not a ship. Three things sell it and there is no gravity to help:
   *
   *   1. IT TAKES A MOMENT TO GET GOING. Thrust is an acceleration budget, not
   *      a velocity assignment, so a tap of the stick leans the machine and a
   *      held stick winds it up. ADV_SPINUP is the whole difference between
   *      "heavy" and "floaty", so tune it before anything else.
   *   2. IT ONLY PULLS HARD IN THE DIRECTION IT FACES. The hull swings toward
   *      the stick at ADV_TURN rad/s and thrust is scaled by how well the two
   *      agree (down to ADV_ALIGN_MIN when they do not), so reversing means
   *      turning around, and turning is something the machine visibly DOES.
   *   3. IT GRINDS TO A HALT AGAINST ROCK. Surviving hardness under the bit
   *      becomes resistance becomes lost speed, exactly as in classic; and rock
   *      above SM.rig.getHardnessCap() is not slow, it is a WALL.
   *
   * THE DRILL DAMAGE BOX IS A SQUARE AROUND THE BIT, AND THAT IS DELIBERATE.
   * particles.damageSolidInRect() is axis-aligned and particles.js is frozen,
   * so there is no rotated rect to be had. The bit, however, is a round drill
   * head: a square centred on it is rotation-INVARIANT, which means the cut is
   * identical whichever way the machine is pointing — the correct answer here
   * rather than a compromise. Debris still erupts outward because the origin
   * handed to the cutter is the bit centre itself.
   *
   * WHY THERE IS A SECOND, WEAKER BOX ON THE HULL
   * The bit cuts a corridor ADV_CUT_HALF*2 wide, which the machine fits down.
   * Spinning on the spot, though, sweeps the chassis corners through rock the
   * bit never touched, and there is no vehicle-versus-solid collision in this
   * engine — the hull would simply be drawn standing inside the ground. So the
   * hull grinds too, at ADV_HULL_GRIND of drill power: enough to clear its own
   * flanks over a second or two, never enough to be a way of mining.
   * ================================================================== */
  var A = SM.config.ADV;

  // --- weight and inertia ----------------------------------------------
  // Acceleration is expressed as a TIME rather than a rate, and deliberately:
  // SM.rig's engines run from 110 to 275 units/sec, and a fixed units/sec^2
  // would make the starter feel sluggish and the top engine feel identical.
  // Spending the same ~0.85s reaching whatever top speed you own means every
  // engine has the same character and a better one is unmistakably stronger —
  // getThrust() (1.0 -> 2.0) then buys the difference on top.
  var ADV_SPINUP = 0.85;         // seconds from standstill to top speed
  var ADV_STOPTIME = 0.55;       // seconds from top speed to standstill
  var ADV_DRAG = 1.9;            // e-folds/sec of standing drag, always on
  var ADV_DEADZONE = 0.14;       // stick magnitude below this reads as centred
  var ADV_TURN = 2.9;            // rad/sec the hull swings at rig turn tier 0
  var ADV_TURN_REF = 2.2;        // SM.rig.getTurnRate() at tier 0 (its unit ref)
  var ADV_ALIGN_MIN = 0.32;      // thrust available while facing the wrong way
  var ADV_BANK_GAIN = 0.22;      // visual roll per rad/sec of swing
  var ADV_SPAWN_Y = 120;         // where the machine parks inside the mouth
  var ADV_CEIL_MARGIN = 40;      // closest the hull centre may get to the roof
  var ADV_WALL_BOUNCE = 0.18;    // how much of the impact a wall gives back

  // --- the cut ---------------------------------------------------------
  var ADV_CUT_HALF = 84;         // half-extent of the drill box, world units
  var ADV_CUT_PER_TIER = 8;      // ...plus this per blade tier flag
  var ADV_HULL_HALF = 76;        // the hull's own janitor box (see the note)
  var ADV_HULL_GRIND = 0.16;     // fraction of drill power the hull applies
  var ADV_CORE_HALF = 26;        // the bit proper, for the hardness gate

  /* --- resistance: SECONDS OF WORK, not summed hardness -----------------
   * Classic slows the machine by the summed hardness of what its blade FAILED
   * to break this step. Measured in adventure, that model is nearly flat: a
   * drill four, eight, sixteen times too weak for the rock in front of it still
   * ploughed along at 94-96% of top speed, because the quantity only ever
   * reflects the ABSOLUTE hardness of the material — dirt contributes 0.55 to
   * it whether your drill can eat it in a tenth of a second or a whole one.
   * (Full sweep: power 8 -> 96%, power 4 -> 98%, power 2 -> 95%, power 1.2 ->
   * 96%, power 0.8 -> 95%, power 0.5 -> 94%. A sixteen-fold difference in drill
   * strength was worth two percent of speed.)
   *
   * That is fatal for this mode specifically, because adventure's whole
   * progression is "the same rock, a better drill" — a tier-5 bit that moved
   * through granite at exactly the tier-0 speed makes the workshop a shop for
   * hardness caps and nothing else.
   *
   * So the load term here is the honest quantity instead:
   *
   *     load = (total hardness standing in front of the bit) / drill power
   *
   * which is SECONDS OF WORK AHEAD. It falls when the rock is softer AND when
   * the drill is stronger, it is already free (the hardness gate's pre-scan
   * sums it), and it reads directly as "how long is this wall going to take".
   * MEASURED with this model live, driving into virgin ground, expressing each
   * rock as the drill-power ratio that reproduces it (load, then % of top):
   *     dirt 0.55   ->   3 s ->  95%      sandstone 2.2  ->  34 s -> 63%
   *     clay 1.1    ->   5 s ->  92%      granite 6.2    ->  67 s -> 46%
   *     obsidian    -> 267 s ->  34% (the VEHICLE_MIN_SPEED_FACTOR floor)
   * The floor still bites, so there is headroom left for the deep mines, and
   * the knee sits where it should: soft ground is free, rock is a decision.
   * ------------------------------------------------------------------ */
  /* RETUNED — the SHAPE as well as the coefficient, and both for measured
   * reasons.
   *
   * 0.017 with a linear 1/(1+kL) was solved when the tier-0 drill had 21 power
   * and virgin ground measured 3 to 267 "seconds of work". rig.js now ships tier
   * 0 at 8.0 power, and the quantity it multiplies has moved with it: MEASURED
   * live, the load while cutting the top layers of Old Creek is 0.1 to 0.7, and
   * the load standing in front of the bit in granite is 50+. At 0.017 the first
   * of those is a 2% slowdown, so drilling ran at the full rated 110 units/sec —
   * indistinguishable from driving down an open corridor, which erases the whole
   * point of owning a better drill.
   *
   * The linear form cannot fix that by coefficient alone, because the load spans
   * nearly three decades: any k that makes soft ground meaningfully slow puts
   * every real rock on the floor, and a floor is not a difficulty curve. THE
   * SQRT DOES: it is gentle where the load is small and keeps resolving where the
   * load is large.
   *
   *     factor = 1 / (1 + k * sqrt(load)),  k = 1.45
   *         load 0.1  (soft dirt, overpowered)  -> 0.69 x
   *         load 0.5  (clay)                    -> 0.49 x
   *         load 2    (stone)                   -> 0.33 x
   *         load 10   (granite for a tier-0 bit)-> 0.18 x
   *         load 50   (a face it can only just cut) -> the floor
   *
   * MEASURED in Old Creek with the tier-0 bit: the descent runs 3 to 6 m/s and
   * the climb back up the same corridor runs 14.5 m/s. The range cost of that is
   * real and it is reported — see the note on advReportWork().
   *
   * Against the 2.5x travel gear that is 3x to 20x between cutting and running,
   * which is the rhythm the mode is built on. And because load is hardness over
   * POWER, every drill tier buys that pace back in the same rock — the upgrade is
   * FELT rather than read off a stat card.
   *
   * There is a feedback loop in here worth knowing about before you touch k:
   * cutting slower leaves the cut box emptier, which lowers the load, which
   * speeds you up. It is self-limiting and it is why the coefficient had to be
   * measured in the mine rather than solved on paper.
   *
   * The floor is ours rather than config's VEHICLE_MIN_SPEED_FACTOR (0.34): that
   * number is the time attack's, where the machine must never stop making
   * progress against the clock. Here a face you can only just cut SHOULD be a
   * crawl, and the hardness gate stops it ever being an infinite one. */
  var ADV_LOAD_SCALE = 1.45;     // slowdown per root-second of work ahead
  var ADV_MIN_FACTOR = 0.12;     // ...and the slowest a cuttable face may make us
  var ADV_LOAD_LERP = 10;        // e-folds/sec of smoothing on the load

  /* --- TRAVEL vs DRILLING: two gears, and why the fuel follows ----------
   * Drilling pace and travelling pace are different jobs. Chewing a fresh face
   * is meant to be slow; crawling back up two hundred metres of tunnel you
   * already dug at that same pace is just the player waiting, and the round trip
   * is the loop this mode is built out of. So when the bit has nothing in front
   * of it — an open cavern, or your own corridor — the machine runs at
   * ADV_TRAVEL_MUL of its rated speed, and the moment the bit bites it gears
   * back down over ADV_TRAVEL_RAMP.
   *
   * The gate is `advLoad`, the seconds of work ahead of the bit, because it is
   * already the honest answer to "is this machine digging or driving".
   * MEASURED, tier-0 rig, 8.0 drill power: cutting virgin ground reads 0.60 to
   * 2.94 (mean 1.14 — it swings because the cut clears the box faster than the
   * machine can advance into it), and reversing back up the corridor it just
   * carved reads a flat 0.00. So the thresholds sit low and close together: any
   * real cutting is drilling pace, and your own tunnel is the top gear.
   *
   * A footprint-based signal was tried first — hardness within one bit radius —
   * and MEASURED USELESS: damageSolidInRect() clears the whole 168-wide box, so
   * the bit is permanently sitting in a void of its own making and the number
   * read 0.04 while drilling. The box total is the one that carries the answer.
   *
   * FUEL SCALES WITH THE SAME NUMBER, and that is not optional. rig.js's tank
   * sizes and mines.js's depths are solved against fuel per METRE; leaving the
   * burn at its old per-SECOND rate while the machine covers 2.5x the ground
   * would hand every tank 2.5x the range and quietly undo that balance. See
   * advReportWork() — the drive term is multiplied by advTravel, so a metre of
   * tunnel costs exactly what it did, and only the clock moves.
   * ------------------------------------------------------------------ */
  var ADV_TRAVEL_MUL = 2.5;      // top-speed multiplier with the bit in clear air
  var ADV_TRAVEL_FREE = 0.03;    // load below this is free travel
  var ADV_TRAVEL_LOAD = 0.32;    // ...and at this it is drilling pace again
  var ADV_TRAVEL_RAMP = 3.2;     // e-folds/sec — a gear change, not a switch

  // --- the lurch -------------------------------------------------------
  // Breaking through a wall you were straining against should throw the machine
  // forward. Gated on the load PEAK rather than on one step's numbers: a wall
  // gives way over several steps, and what makes the lurch read is that it
  // lands once, on the step the way opens. Open ground never reaches the peak
  // and so never lurches.
  var ADV_LURCH_LOAD = 7;        // seconds of work that counts as "straining"
  var ADV_LURCH_FALL = 0.5;      // ...then the load dropping to this much of it
  var ADV_LURCH_KICK = 95;       // world units/sec added along the facing
  var ADV_LURCH_COOL = 0.4;      // minimum seconds between lurches

  // --- the hardness gate ----------------------------------------------
  // Rock above SM.rig.getHardnessCap() cannot be cut at all. particles.js
  // damages every solid in a rect with no way to filter, so the box is
  // PRE-SCANNED and the whole cut is refused when the bit is up against
  // uncuttable material — which is also the only honest reading of "the drill
  // cannot bite". Two triggers, because one alone is wrong in one direction:
  //   * anything over the cap inside the CORE box (the bit itself) blocks
  //     immediately — that is the bit sitting on the wall;
  //   * over the cap across ADV_BLOCK_FRAC of the wider box blocks too, so a
  //     wall stops you before its face has quite reached the core.
  // A single hard pebble embedded in soft ground therefore does NOT lock the
  // machine up: you cut past it and it stays behind as a stone.
  // The fraction test counts only what is IN THE PATH — ahead of the bit along
  // the facing — not the whole box. Measured against a real bedrock floor: the
  // box straddling the boundary is mostly ordinary rock, so a whole-box fraction
  // came out under the threshold, the gate never fired, and the cutter chewed
  // hardness-26 bedrock at about 1.2 s a deposit while the hull slowly died.
  // Classifying per deposit is rotation-correct even though the BOX cannot be:
  // the box stays axis-aligned for particles.js, and a dot product decides what
  // is in front of us.
  var ADV_BLOCK_FRAC = 0.22;
  var ADV_PATH_BEHIND = 8;       // tolerance: material level with the bit counts
  var ADV_STALL_DECAY = 14;      // e-folds/sec bled off the blocked direction
  // ...and then a hard refusal below this, because an exponential alone leaves a
  // standing equilibrium between the thrust budget and the decay: measured, the
  // machine still bulldozed into rock it cannot cut at 14 units/sec, 35 units in
  // under three seconds, which draws the hull standing inside the wall. Above
  // this speed the contact still reads as a crunch that takes a tenth of a
  // second to arrest; below it, the rock simply wins.
  var ADV_STALL_CREEP = 26;      // units/sec of push into a wall that is refused
  var ADV_STALL_FX = 0.13;       // seconds between spark bursts while blocked
  /* HITTING A WALL IS A HARD STOP, NOT A SLOW DEATH.
   * Continuous wear while stalled (this was 0.5 integrity/sec) means leaning on
   * anything impenetrable — and the mine's bedrock FLOOR is the one every player
   * meets — quietly kills the machine while the player is still working out that
   * the wall is a wall. It also punishes the exact moment the mode most wants to
   * be legible: "there is something behind this I cannot reach yet".
   * So the hull cost is an IMPACT, once, on the step contact is made and only
   * above a real closing speed. Ramming bedrock at full tilt dents you; resting
   * against it does not. Leaning costs FUEL and HEAT, which are recoverable and
   * on the HUD. */
  var ADV_RAM_SPEED = 45;        // closing speed below which a wall is free
  var ADV_RAM_WEAR = 2.5;        // integrity points for a full-speed ram
  // The gate can flicker on and off for a step at a boundary (the pre-scan is
  // sampling a moving box), and without a cooldown each flicker counts as a
  // fresh impact. Measured on the bedrock floor: 6 s of grinding produced two
  // rams. One dent per approach is the honest number.
  var ADV_RAM_COOL = 1.2;        // seconds before a wall can dent us again
  // Heat from ORDINARY drilling belongs to SM.mines.heatGainRate() (adv.js
  // integrates it); this is the extra a jammed bit makes on top, which is why
  // it is small next to the ambient numbers in mines.js.
  // 3.0 sits just under tier-0 cooling's 3.5/sec shed, so grinding on a wall in
  // a cool mine never overheats on its own — the deep mines' ambient heat is
  // what turns a jam into an overheat, which is where that pressure belongs.
  var ADV_STALL_HEAT = 3.0;      // heat points/sec while stalled on the cap
  var ADV_STALL_SHAKE = 7;       // trauma floor while stalled
  var ADV_STALL_SAY = 1.1;       // seconds between `drill:blocked` captions

  // --- what the work costs (reported to SM.adv) ------------------------
  // THE RATES ARE SM.rig's. getDriveBurn() and getDrillBurn() are published
  // there precisely so that this module reports the duty cycle and rig.js keeps
  // ownership of the fuel economy its tank sizes were solved against. The only
  // number here is the PENALTY for grinding on rock the drill cannot cut, which
  // is a gameplay judgement rather than an engine spec: hitting a wall you
  // cannot beat should be the most expensive thing in the game.
  var ADV_HARD_BURN_MUL = 1.7;   // multiplier on drill burn while stalled
  var ADV_FALLBACK_DRIVE_BURN = 0.30;
  var ADV_FALLBACK_DRILL_BURN = 0.60;

  // --- visible subassemblies -------------------------------------------
  // Adventure geometry is driven ENTIRELY by SM.rig.getPartFlags(); tiers are
  // never read here, so Agent 2 can re-tier without touching this renderer.
  var ADV_BLADE_WIDTH = 150;     // drawn reamer span at bladeTier 0
  var ADV_BLADE_PER_TIER = 22;
  var ADV_ARMOR_WIDTH = 5;       // extra chassis width per armour flag

  /* --- THE AUGER: what the DRILL upgrade looks like ---------------------
   * See the note above drawDrillRig(). The tip is pinned to the front of the cut
   * box (ADV_AUGER_REACH of the box half-extent, plus a bit per tier) so the
   * drawn bit reaches as far as the machine really cuts; girth is a fraction of
   * the reamer span so the head stays in proportion as the blade widens.
   * ------------------------------------------------------------------ */
  var ADV_AUGER_REACH = 0.82;    // of the cut box half-extent, ahead of the bit
  var ADV_AUGER_PER_TIER = 11;   // ...and this much more length per drill tier
  // Girth is deliberately shy of the length: MEASURED on screen, a body wider
  // than about half its length stops reading as a bit and starts reading as a
  // box with a point on it. Tier 0 is 39 x 73 units, tier 5 is 76 x 139.
  var ADV_AUGER_GIRTH = 0.26;    // base radius as a fraction of the reamer half
  var ADV_AUGER_GIRTH_STEP = 0.022;
  var ADV_AUGER_SHANK = 0.66;    // fraction of the length that is straight shank
  var ADV_FLUTE_PITCH = 19;      // helical groove spacing at tier 0, world units
  var ADV_DRILL_THERMAL = 4;     // bladeTier at which the bit runs hot
  var ADV_DRILL_PLASMA = 5;      // ...and at which it is energised

  /* --- THE ORE BED: what the CARGO upgrade looks like ------------------
   * The cargo ladder has to read as ONE thing — "this machine can carry more
   * ore" — from a top-down view at about 0.65 scale, which is roughly 90 px of
   * hull. So the whole budget goes on VOLUME:
   *
   *   LENGTH   the bed grows rearward every tier, and past ADV_BAY2 it grows by
   *            gaining WHOLE BAYS. That is the silhouette change, and it is the
   *            only cue that survives being small on a phone.
   *   WALL     wall thickness IS wall height in a top-down view: the rim band
   *            you see around the cavity is the top of the plate, so a thicker
   *            rim plus a deeper inner shadow is a taller side. This is the
   *            "high-sided" tier's entire job.
   *   FILL     the cavity is drawn empty and the load is drawn INTO it, from
   *            SM.adv.getCargoPct(). A bigger bed therefore looks emptier with
   *            the same ore in it, which is exactly what the upgrade bought.
   *
   * Nothing here reaches outboard. The old collector arms were the widest thing
   * on the machine and read as antennae; the magnet is now an INTAKE THROAT on
   * the deck (drawIntake) plus the collector rings that were always there.
   * Anything that does stick out is a rib, a hinge or a coupling.
   * ------------------------------------------------------------------ */
  var ADV_BED_LEN = 54;          // first bay's length at cargo flag 0
  var ADV_BED_PER_TIER = 28;     // ...plus this per flag, up to ADV_BAY2
  var ADV_BED_LEN_LATE = 6;      // ...and this much per flag after that
  var ADV_BED_HALF = 0.76;       // bed half-width as a fraction of hullHalf()
  var ADV_BED_HALF_STEP = 0.075;
  var ADV_BED_HALF_MAX = 1.16;   // the top tiers are an over-wide load
  var ADV_WALL = 3.4;            // side-wall thickness (= height) at flag 0
  var ADV_WALL_STEP = 1.9;
  var ADV_BAY_GAP = 10;          // coupling gap between bays
  var ADV_BAY2_LEN = 0.60;       // second bay length, relative to the first
  var ADV_BAY3_LEN = 0.45;
  // Feature thresholds on the `hopper` flag (== the CARGO tier).
  var ADV_TAILGATE = 1;          // hinged tailgate instead of an open lip
  var ADV_HIGHSIDE = 2;          // bolted side-board extensions + fill gauge
  var ADV_RAM = 3;               // compactor ram on hydraulic cylinders
  var ADV_BAY2 = 4;              // a second bay behind a bulkhead
  var ADV_BAY3 = 5;              // ...and a third, with load straps: the train

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
  // The last four are ADVENTURE-ONLY (js/rig.js flags `lamps`, `radiators`,
  // `armor`, `dish`). No classic upgrade in UPGRADE_EFFECTS touches them, so they
  // stay at 0 for the whole of a time attack and classic geometry is unchanged.
  var PART_KEYS = ['bladeTier', 'drills', 'grinders', 'magnetArms', 'conveyor',
                   'hopper', 'stacks', 'treads', 'pulse', 'overdrive',
                   'refinery', 'teeth', 'lamps', 'radiators', 'armor', 'dish'];
  var parts = {
    bladeTier: 0, drills: 0, grinders: 0, magnetArms: 0, conveyor: 0,
    hopper: 0, stacks: 0, treads: 0, pulse: 0, overdrive: 0,
    refinery: 0, teeth: 0, lamps: 0, radiators: 0, armor: 0, dish: 0
  };
  // deploy[k] = 0..1 unfold progress of the most recently added instance.
  var deploy = {
    bladeTier: 1, drills: 1, grinders: 1, magnetArms: 1, conveyor: 1,
    hopper: 1, stacks: 1, treads: 1, pulse: 1, overdrive: 1,
    refinery: 1, teeth: 1, lamps: 1, radiators: 1, armor: 1, dish: 1
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

  /* --- speed boost runtime -------------------------------------------- */
  var boostRemaining = 0;
  var boostLevel = 0;            // 0..1 smoothed ramp
  var boostActive = false;
  // Fragments of a shattered block arrive over several steps, so the "you got
  // a boost" event is emitted once per pickup rather than once per fragment.
  var boostAnnounce = 0;
  // Run totals for the end card, in BLOCKS and SECONDS. Deliberately not the
  // fragment count: a boost block is one object you aimed at, and reporting
  // the ~350 chips it shattered into told the player nothing they did.
  // boostGap is a second, independent gap detector — boostAnnounce only runs
  // while the boost is IDLE, so a block caught mid-boost would never be
  // counted by it, and topping up is exactly when you most want the credit.
  var boostBlocks = 0;
  var boostSeconds = 0;
  var boostGap = 0;

  // Resolved once in init(): comparing an integer on the collection hot path
  // beats a material-table lookup and a string compare ~30x per step.
  var MI_BOOST = -1;

  /* --- ADVENTURE runtime -----------------------------------------------
   * `heading` is the hull's facing in radians, 0 = local -y = the classic
   * forward direction, so heading 0 renders EXACTLY as classic does. The facing
   * unit vector is (sin h, -cos h). (dvx, dvy) is the real 2D velocity;
   * `speed` is kept as its magnitude so every existing getter, the camera, the
   * engine note and the dust all keep working with no adventure special case.
   * ------------------------------------------------------------------ */
  var heading = 0;
  var dvx = 0, dvy = 0;
  var stalled = false;           // the bit is against rock above the cap
  var cutting = false;           // the bit removed hardness this step
  var advLoad = 0;               // smoothed seconds of work ahead of the bit
  var loadPeak = 0;              // highest load since the last breakthrough
  var stallFxTimer = 0;
  var stallSay = 0;              // caption rate limiter (see advStallFeedback)
  var stallPrev = false;         // stalled on the previous step (ram detection)
  var ramCool = 0;               // rate limit on wall impacts
  var stallHold = 0;             // seconds continuously stalled
  var lurchCool = 0;
  var blockedMat = -1;           // material index of what is blocking us
  var blockedHard = 0;
  var driveBurn = 0;             // smoothed fuel/sec from driving + drilling
  var advDry = false;            // the tank came up empty on the last draw
  var advTurning = 0;            // rad/sec actually applied, for the bank
  var advTravel = 1;             // 1 = drilling pace .. ADV_TRAVEL_MUL = clear air

  /* --- hardness cache + pre-scan accumulators --------------------------
   * Module-level so the queryRect callback is a single hoisted function with no
   * per-step closure allocation. Rebuilt only if the material table grows.
   * ------------------------------------------------------------------ */
  var advHard = null;            // Float32Array: matIndex -> hardness
  var advHardN = -1;
  var PD = null;                 // SM.particles.data, cached (READ-ONLY)
  var scCap = 0;                 // hardness ceiling for this scan
  var scCount = 0, scOver = 0, scCoreOver = 0;
  var scPath = 0, scPathOver = 0;      // ...and the same, restricted to the path
  var scHardSum = 0, scHardest = 0, scHardestMat = -1;
  var scBitX = 0, scBitY = 0, scFx = 0, scFy = 0;

  /* --- reused event payloads (never stashed) --------------------------- */
  var evBlocked = { x: 0, y: 0, matIndex: -1, hardness: 0, cap: 0 };
  var evTransform = { part: '', width: 0 };
  var evPulse = { x: 0, y: 0, radius: 0 };
  var evOdStart = { duration: 0 };
  var evOdEnd = {};
  var evBoost = { duration: 0 };
  var appliedOut = { id: '', title: '', description: '', tier: 0, effect: null };

  /* =====================================================================
   * SETUP
   * ================================================================== */
  function init() {
    SM.events.on('resource:collected', onCollected);
    MI_BOOST = SM.materials ? SM.materials.indexOf('boostcell') : -1;

    /* ADVENTURE geometry is pulled from SM.rig.getPartFlags() on the two
     * occasions it can actually have changed — a workshop purchase and a screen
     * transition — rather than every step. getPartFlags() is Agent 2's function
     * and may well build its object on the fly; polling it 60 times a second
     * for an answer that changes once a minute would be a needless allocation
     * in the fixed step. */
    SM.events.on('adv:rig', syncRig);
    SM.events.on('adv:state', syncRig);

    reset();
  }

  function onCollected(p) {
    // Hopper "gulp" — decays in update(). O(1), no allocation: this fires
    // up to ~30x per step.
    hopperPulse += 0.05;
    if (hopperPulse > 1) hopperPulse = 1;

    // A boost block shatters into several fragments and pays per fragment, so
    // driving cleanly through the whole cloud is worth more than clipping it.
    if (p && p.matIndex === MI_BOOST) addBoost(BOOST_PER_PIECE);
  }

  /**
   * Extend the speed boost. Called once per collected boost fragment.
   * The announcement is deferred to update() so a block that lands over ~70
   * fragments and a second of flight still produces exactly one 'boost:start',
   * carrying the total it actually came to.
   */
  function addBoost(seconds) {
    if (halted) return false;
    // Count the block on the first fragment after a gap, and bank only the
    // seconds that actually fit under the cap — the end card should not
    // promise time the clamp threw away.
    if (boostGap <= 0) boostBlocks++;
    boostGap = BOOST_ANNOUNCE;
    var room = BOOST_MAX - boostRemaining;
    if (seconds > room) seconds = room > 0 ? room : 0;
    boostRemaining += seconds;
    boostSeconds += seconds;
    // Restart the window on EVERY fragment, not just the first: it is a
    // gap-in-the-stream detector, so a cloud that trickles in over a second
    // still announces once, at the end, with the whole amount.
    if (!boostActive) boostAnnounce = BOOST_ANNOUNCE;
    return true;
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

    boostRemaining = 0;
    boostLevel = 0;
    boostActive = false;
    boostAnnounce = 0;
    boostBlocks = 0;
    boostSeconds = 0;
    boostGap = 0;

    gradSig = -1;                // force gradient rebuild

    advReset();
  }

  /* =====================================================================
   * ADVENTURE — SETUP
   * ================================================================== */

  function advMode() {
    return !!(SM.adv && SM.adv.isActive && SM.adv.isActive());
  }
  function advDriving() {
    return !!(SM.adv && SM.adv.isDriving && SM.adv.isDriving());
  }

  /** Guarded read of a positive SM.rig stat, with a classic-config fallback. */
  function rigStat(fn, dflt) {
    if (!SM.rig || typeof SM.rig[fn] !== 'function') return dflt;
    var v = SM.rig[fn]();
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : dflt;
  }

  /**
   * Park the machine at the lift station the descent starts from, facing DOWN
   * into the shaft, stopped. Called from the tail of reset(); everything it
   * touches is invisible to classic mode except the parkAtStation() call, which
   * returns immediately outside adventure.
   */
  function advReset() {
    heading = Math.PI;           // facing +y == deeper
    dvx = 0; dvy = 0;
    stalled = false;
    cutting = false;
    advLoad = 0;
    loadPeak = 0;
    stallFxTimer = 0;
    stallSay = 0;
    stallPrev = false;
    ramCool = 0;
    stallHold = 0;
    lurchCool = 0;
    blockedMat = -1;
    blockedHard = 0;
    driveBurn = 0;
    advDry = false;
    advTurning = 0;
    advTravel = 1;

    if (!advMode()) return;
    parkAtStation();
    syncRig();
  }

  /**
   * ADVENTURE ONLY: set the machine down in the cage of the lift station
   * SM.adv currently reports, stopped and pointing down the shaft.
   *
   * TWO CALLERS, ONE OFFSET. A descent gets here through reset(), and a LIFT
   * RIDE calls it directly — a ride cannot reset the whole machine, because
   * reset() would also throw away the rig sync, the deploy animations and the
   * hold. Keeping both on one function is what stops the spawn offset from
   * existing in two places: ADV_SPAWN_Y is how far INSIDE the stratum the cage
   * sets you down (120 units, well within ADV.EXIT_RADIUS's 200), so SM.adv's
   * getBoardable() still finds you standing in the station you arrived at.
   *
   * The station is asked for, never assumed: a build without the level ladder
   * (or a console call before a mine is in context) answers the mine mouth,
   * which is exactly what this used to hard-code.
   */
  function parkAtStation() {
    if (!advMode()) return false;
    x = advStationX();
    y = advStationY() + ADV_SPAWN_Y;
    speed = 0;
    vx = 0;
    dvx = 0; dvy = 0;
    heading = Math.PI;
    // A ride must not arrive mid-stall, mid-lurch or mid-cut: every one of those
    // is a statement about rock that is no longer in front of the bit.
    stalled = false;
    cutting = false;
    advLoad = 0;
    loadPeak = 0;
    stallHold = 0;
    stallFxTimer = 0;
    stallPrev = false;
    ramCool = 0;
    lurchCool = 0;
    blockedMat = -1;
    blockedHard = 0;
    driveBurn = 0;
    return true;
  }

  function advStationX() {
    if (SM.adv && SM.adv.getStationX) {
      var v = SM.adv.getStationX();
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return 0;
  }

  function advStationY() {
    if (SM.adv && SM.adv.getStationY) {
      var v = SM.adv.getStationY();
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return A.MINE_CEILING_Y;
  }

  /**
   * Adopt SM.rig's numbers and visible flags.
   *
   * The stats are ASSIGNED into the same live variables the classic upgrade
   * path animates, which is why no getter below needs an adventure branch: the
   * renderer, the camera, effects.js and sound.js all keep reading exactly what
   * they read before. The flags go through parts[] the same way an upgrade
   * would, so a purchase UNFOLDS in the garage instead of popping.
   */
  function syncRig() {
    if (!advMode()) return;

    miningPower = rigStat('getDrillPower', C.VEHICLE_MINING_POWER);
    collectRadius = rigStat('getCollectRadius', C.VEHICLE_COLLECT_RADIUS);
    if (collectRadius > MAX_COLLECT) collectRadius = MAX_COLLECT;
    valueMul = 1;                // adventure sells at the surface, not in flight

    var flags = (SM.rig && SM.rig.getPartFlags) ? SM.rig.getPartFlags() : null;
    var i, k, v, changed = false;
    if (flags) {
      for (i = 0; i < PART_KEYS.length; i++) {
        k = PART_KEYS[i];
        v = flags[k];
        // `magnets` is rig.js's name for what this renderer calls magnetArms.
        if (v === undefined && k === 'magnetArms') v = flags.magnets;
        if (typeof v !== 'number' || !isFinite(v) || v < 0) continue;
        v = v | 0;
        if (parts[k] === v) continue;
        parts[k] = v;
        deploy[k] = 0;           // unfold the new machinery
        deployActive = true;
        changed = true;
      }
    }

    var bw = ADV_BLADE_WIDTH + parts.bladeTier * ADV_BLADE_PER_TIER;
    if (bw > MAX_BLADE) bw = MAX_BLADE;
    var bd = C.VEHICLE_BODY_WIDTH + parts.armor * ADV_ARMOR_WIDTH;
    if (bd > MAX_BODY) bd = MAX_BODY;
    if (bw !== bladeWidthTarget || bd !== bodyWidthTarget) {
      bladeWidthFrom = bladeWidth;
      bodyWidthFrom = bodyWidth;
      bladeWidthTarget = bw;
      bodyWidthTarget = bd;
      // A fresh descent should not animate its own hull into existence, so the
      // morph only runs when the machine is already on screen.
      if (advDriving()) { morphT = 0; morphActive = true; }
      else { bladeWidth = bw; bodyWidth = bd; morphT = 1; morphActive = false; }
      changed = true;
    }
    if (changed) { upgradeVersion++; gradSig = -1; }
  }

  /** Hardness by material index. Cached: the table is rewritten only at load. */
  function ensureHardness() {
    var M = SM.materials;
    var n = (M && M.count) ? M.count : 0;
    if (n === advHardN && advHard) return;
    advHardN = n;
    advHard = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var m = M.get(i);
      advHard[i] = m ? (m.hardness || 0) : 0;
    }
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
   * SPEED BOOST
   * ================================================================== */
  function updateBoost(dt) {
    if (boostGap > 0) boostGap -= dt;
    if (halted && boostRemaining > 0) {
      boostRemaining = 0;
      boostAnnounce = 0;
    }

    // One 'boost:start' per block, not per fragment: the announce timer waits
    // out the rest of the cloud so the reported duration is the real total.
    if (boostAnnounce > 0) {
      boostAnnounce -= dt;
      if (boostAnnounce <= 0 && boostRemaining > 0) {
        boostActive = true;
        evBoost.duration = boostRemaining;
        SM.events.emit('boost:start', evBoost);
        if (SM.camera) SM.camera.shake(10);
      }
    }

    // Only ACTIVE boost burns down. This used to tick unconditionally, which
    // meant the clock started on the first fragment while the buff itself
    // waits for the announce (boostLevel only ramps when boostActive) — so
    // roughly 0.8s of a six-second surge was spent before the machine ever
    // went faster, and 'boost:start' then reported the smaller leftover as if
    // it were the whole prize. Measured: 6.0s collected, 5.19s announced.
    if (boostActive && boostRemaining > 0) {
      boostRemaining -= dt;
      if (boostRemaining <= 0) {
        boostRemaining = 0;
        boostActive = false;
        SM.events.emit('boost:end', null);
      }
    }

    // Ramp only once the block has been announced, so the surge and its sound
    // land on the same step.
    var target = (boostActive && boostRemaining > 0) ? 1 : 0;
    boostLevel += (target - boostLevel) * (1 - Math.exp(-BOOST_RAMP * dt));
    if (boostLevel < 0.001) boostLevel = 0;
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
    /* ADVENTURE MODE takes a completely different path: no auto-advance, no
     * gates, no overdrive, and a 2D stick instead of a steer axis. Everything
     * below this line is the time attack, untouched. */
    if (advDriving()) { updateAdv(dt); return; }

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
    animateMorph(dt);

    /* --- 3. periodic systems ------------------------------------------ */
    updateOverdrive(dt);
    updateBoost(dt);
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
      // Boost stacks MULTIPLICATIVELY with overdrive. Both at once is rare and
      // brief, and the point of catching a boost block mid-frenzy should be
      // that it feels ridiculous.
      var boostSpeed = 1 + (BOOST_SPEED - 1) * boostLevel;
      var targetSpeed = C.VEHICLE_SPEED * speedMul * odSpeed * boostSpeed * factor;
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
    animateMachinery(dt, damaged);
  }

  /**
   * The chassis/blade width morph and the per-part unfold. Lifted out of
   * update() verbatim; both modes install machinery and both must animate it.
   */
  function animateMorph(dt) {
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
  }

  /**
   * Drums, drills, treads, belts, pistons, lights and smoke. Lifted out of
   * update() verbatim so the adventure path can drive the same machinery with
   * the same numbers — a second copy would have drifted within a day.
   */
  function animateMachinery(dt, damaged) {
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
   * ADVENTURE — THE DRIVE
   * ---------------------------------------------------------------------
   * One step of free 2D driving. Read the tunables note above first; this is
   * the implementation of it and the order of the six blocks matters:
   *   stick -> heading -> CUT -> motion -> clamps -> handoff
   * The cut runs BEFORE the motion for the same reason classic does it — the
   * resistance the bit meets this step is what decides how far the machine gets
   * this step, so hitting rock slows you on the frame you hit it.
   * ================================================================== */
  function updateAdv(dt) {
    animateMorph(dt);
    ensureHardness();
    if (!PD) PD = SM.particles.data;
    if (ramCool > 0) ramCool -= dt;

    /* --- 1. the stick ------------------------------------------------
     * SM.input.getMove() is a REUSED object. Copy the three numbers out now;
     * never hold the reference.
     * ------------------------------------------------------------------ */
    var mv = SM.input.getMove();
    var mx = mv.x, my = mv.y, mag = mv.mag;
    if (mag < ADV_DEADZONE) { mx = 0; my = 0; mag = 0; }

    // A dry tank is a dead engine: no thrust, no drill, and the machine coasts
    // to a stop on its own drag while adv.js counts out the strand.
    advDry = !!(SM.adv.isDry && SM.adv.isDry());
    var powered = !halted && !advDry;
    if (!powered) { mx = 0; my = 0; mag = 0; }

    /* --- 2. heading ---------------------------------------------------
     * The hull swings toward the stick at a bounded rate — it is a tracked
     * machine, so turning takes time and is the reason a 180 is a decision.
     * ------------------------------------------------------------------ */
    var turnApplied = 0;
    if (mag > 0) {
      var want = Math.atan2(mx, -my);          // 0 = -y, matching local space
      var diff = want - heading;
      while (diff > Math.PI) diff -= TAU;
      while (diff < -Math.PI) diff += TAU;
      // SM.rig.getTurnRate() is quoted in rad/sec and its starting value is
      // ADV_TURN_REF, so it is read as a RATIO against that reference and
      // applied to the rate this drive is tuned around. That way Agent 2 can
      // re-scale the stat without re-tuning the feel, and a runaway value
      // cannot make the hull spin like a top.
      var rate = ADV_TURN * rigStat('getTurnRate', ADV_TURN_REF) / ADV_TURN_REF;
      if (rate > ADV_TURN * 2.2) rate = ADV_TURN * 2.2;
      var lim = rate * dt;
      if (diff > lim) diff = lim; else if (diff < -lim) diff = -lim;
      heading += diff;
      turnApplied = diff / dt;
      if (heading > Math.PI) heading -= TAU; else if (heading < -Math.PI) heading += TAU;
    }
    advTurning += (turnApplied - advTurning) * (1 - Math.exp(-10 * dt));
    // Visual roll: the hull leans into the swing.
    var bankTarget = -advTurning * ADV_BANK_GAIN;
    if (bankTarget > C.VEHICLE_BANK_MAX) bankTarget = C.VEHICLE_BANK_MAX;
    else if (bankTarget < -C.VEHICLE_BANK_MAX) bankTarget = -C.VEHICLE_BANK_MAX;
    bank += (bankTarget - bank) * (1 - Math.exp(-9 * dt));

    var fx = Math.sin(heading), fy = -Math.cos(heading);   // facing unit vector

    /* --- 3. CUT -------------------------------------------------------
     * A square damage box centred on the DRILL HEAD, which is where the round
     * bit is, and which makes the box rotation-invariant. Debris origin is the
     * bit centre so fragments erupt outward all round it.
     * ------------------------------------------------------------------ */
    var reach = drillReach();
    var hx = x + fx * reach, hy = y + fy * reach;
    var cutHalf = ADV_CUT_HALF + parts.bladeTier * ADV_CUT_PER_TIER;
    var power = powered ? getMiningPower() : 0;
    var cap = rigStat('getHardnessCap', 99);
    var damaged = 0, broke = 0;

    stalled = false;
    var kLoad = 1 - Math.exp(-ADV_LOAD_LERP * dt);
    if (power > 0) {
      scanBox(hx, hy, cutHalf, cap, fx, fy);
      // Blocked when the bit itself is on uncuttable rock, or when enough of
      // what lies IN THE PATH is uncuttable that a wall is clearly in the way.
      var frac = scPath > 0 ? scPathOver / scPath : 0;
      stalled = scPathOver > 0 && (scCoreOver > 0 || frac >= ADV_BLOCK_FRAC);
      blockedMat = stalled ? scHardestMat : -1;
      blockedHard = stalled ? scHardest : 0;

      /* SECONDS OF WORK AHEAD — see the tunables note. The pre-scan has already
       * totalled the hardness in the box for the gate, so this costs nothing.
       * `resistance` is fed from the same total rather than from the cut's
       * survivors: it stays in the 0-400 range camera.js, effects.js and
       * sound.js were tuned against, and it now means "how loaded is the
       * cutter" in open ground and against a wall alike. */
      advLoad += (scHardSum / power - advLoad) * kLoad;
      resistance += (scHardSum - resistance) * kLoad;
      if (advLoad > loadPeak) loadPeak = advLoad;
    } else {
      advLoad -= advLoad * kLoad;
      resistance -= resistance * kLoad;
    }

    if (power > 0 && !stalled) {
      var res = SM.particles.damageSolidInRect(
        hx - cutHalf, hy - cutHalf, hx + cutHalf, hy + cutHalf,
        power * dt, hx, hy
      );
      damaged = res.damaged;
      broke = res.broken;
      cutting = damaged > 0;

      // The hull's own janitor box (see the tunables note): stops the chassis
      // being drawn standing inside rock when it pivots.
      var hres = SM.particles.damageSolidInRect(
        x - ADV_HULL_HALF, y - ADV_HULL_HALF, x + ADV_HULL_HALF, y + ADV_HULL_HALF,
        power * ADV_HULL_GRIND * dt, x, y
      );
      damaged += hres.damaged;

      /* THE LURCH. Straining against something and then breaking through it
       * should throw the machine forward — the single most satisfying beat in
       * the drive, and it is free, because the load peak is already tracked. */
      if (lurchCool > 0) lurchCool -= dt;
      if (broke >= 2 && loadPeak > ADV_LURCH_LOAD &&
          advLoad < loadPeak * ADV_LURCH_FALL && lurchCool <= 0) {
        loadPeak = advLoad;
        lurchCool = ADV_LURCH_COOL;
        dvx += fx * ADV_LURCH_KICK;
        dvy += fy * ADV_LURCH_KICK;
        if (SM.camera) { SM.camera.shake(9); if (SM.camera.punch) SM.camera.punch(-0.05); }
        if (SM.sound) SM.sound.play('break');
      }
    } else if (stalled) {
      cutting = false;
      // Pinned. resistance and advLoad are already the whole wall (the scan
      // above fed them), so the engine note, the camera rumble and the blade
      // glow all read "loaded" without a single extra flag.
      advStallFeedback(dt, hx, hy);
    }
    if (!stalled) { stallHold = 0; stallFxTimer = 0; stallSay = 0; }

    /* --- 4. motion ----------------------------------------------------
     * Thrust is an ACCELERATION BUDGET. The stick sets a target velocity and the
     * machine walks toward it over ADV_SPINUP seconds (or brakes over
     * ADV_STOPTIME), so weight lives in the delay, not in a lerp constant.
     * ------------------------------------------------------------------ */
    var factor = 1 / (1 + ADV_LOAD_SCALE * Math.sqrt(advLoad > 0 ? advLoad : 0));
    if (factor < ADV_MIN_FACTOR) factor = ADV_MIN_FACTOR;

    /* TWO GEARS. See the ADV_TRAVEL_* note: clear air runs fast, rock does not,
     * and the smoothstep plus the ramp mean the change of pace is something the
     * machine DOES over a third of a second rather than a value that flips. */
    var u = (advLoad - ADV_TRAVEL_FREE) / (ADV_TRAVEL_LOAD - ADV_TRAVEL_FREE);
    if (u < 0) u = 0; else if (u > 1) u = 1;
    u = u * u * (3 - 2 * u);
    var gear = ADV_TRAVEL_MUL + (1 - ADV_TRAVEL_MUL) * u;
    if (stalled && gear > 1) gear = 1;
    advTravel += (gear - advTravel) * (1 - Math.exp(-ADV_TRAVEL_RAMP * dt));

    // The whole budget rides on the geared top speed, so winding up to travel
    // pace still takes ADV_SPINUP seconds and meeting rock still takes
    // ADV_STOPTIME to shed — the machine loads up instead of changing value.
    var top = rigStat('getSpeed', C.VEHICLE_SPEED) * advTravel;
    var tvx = 0, tvy = 0;
    if (mag > 0) {
      var ux = mx / mag, uy = my / mag;
      // Pointing where it faces is what the machine is GOOD at.
      var align = ux * fx + uy * fy;
      var thrust = ADV_ALIGN_MIN + (1 - ADV_ALIGN_MIN) * (align > 0 ? align : 0);
      var want2 = top * factor * thrust * mag;
      tvx = ux * want2; tvy = uy * want2;
    }
    var ddx = tvx - dvx, ddy = tvy - dvy;
    var dl = Math.sqrt(ddx * ddx + ddy * ddy);
    // getThrust() buys acceleration, getGrip() buys braking and cornering —
    // rig.js documents them as exactly that.
    var budget = (mag > 0
      ? top / ADV_SPINUP * rigStat('getThrust', 1)
      : top / ADV_STOPTIME * rigStat('getGrip', 1)) * dt;
    if (dl > budget && dl > 0.0001) { ddx = ddx / dl * budget; ddy = ddy / dl * budget; }
    dvx += ddx; dvy += ddy;

    /* Standing drag, so nothing coasts forever — but ONLY with the stick
     * centred, and that is not a detail. Applied while under power it fights
     * the acceleration budget and settles at an equilibrium instead of at the
     * top speed: measured, a rig whose engine says 110 units/sec was doing 67,
     * i.e. every engine tier was arriving 39% short and SM.rig.getSpeed() —
     * which the camera's lead and adv.js's reserve estimate both trust — was a
     * number nothing in the game could reach. Braking is the brake's job. */
    if (mag === 0) {
      var drag = Math.exp(-ADV_DRAG * dt);
      dvx *= drag; dvy *= drag;
    }

    // STALLED: bleed off everything pushing INTO the wall and leave the rest,
    // so the machine can still slither sideways along a face it cannot cut.
    if (stalled) {
      var into = dvx * fx + dvy * fy;
      if (into > 0) {
        // THE CRUNCH. One impact on the step contact is made, scaled by how fast
        // we arrived — see ADV_RAM_WEAR. Everything after it is free of charge.
        if (!stallPrev && into > ADV_RAM_SPEED && ramCool <= 0) {
          ramCool = ADV_RAM_COOL;
          SM.adv.damage(ADV_RAM_WEAR * into / (top > 1 ? top : 1), 'ram');
          if (SM.camera) SM.camera.shake(11);
          if (SM.sound) SM.sound.play('impact');
        }
        var kill = into * (1 - Math.exp(-ADV_STALL_DECAY * dt));
        var left = into - kill;
        if (left < ADV_STALL_CREEP) kill = into;   // no bulldozing (see tunables)
        dvx -= fx * kill; dvy -= fy * kill;
      }
    }
    stallPrev = stalled;

    // Speed clamp with headroom for the lurch.
    var sp = Math.sqrt(dvx * dvx + dvy * dvy);
    var spMax = top * 1.6;
    if (sp > spMax) { dvx = dvx / sp * spMax; dvy = dvy / sp * spMax; sp = spMax; }
    if (mag === 0 && sp < 4) { dvx = 0; dvy = 0; sp = 0; }

    x += dvx * dt;
    y += dvy * dt;
    speed = sp;
    vx = dvx;                    // getLateralSpeed() keeps its meaning

    /* --- 5. the shaft -------------------------------------------------
     * x is clamped to the shaft and the machine may not drive up out through
     * the roof of the mine. Both walls give a little back so a full-speed
     * impact reads as a collision rather than as a dead stop.
     * ------------------------------------------------------------------ */
    var rad = advRadius();
    var bound = A.MINE_HALF_WIDTH - rad;
    if (bound < 80) bound = 80;
    if (x < -bound) { x = -bound; if (dvx < 0) dvx = -dvx * ADV_WALL_BOUNCE; }
    else if (x > bound) { x = bound; if (dvx > 0) dvx = -dvx * ADV_WALL_BOUNCE; }
    var roof = A.MINE_CEILING_Y + ADV_CEIL_MARGIN;
    if (y < roof) { y = roof; if (dvy < 0) dvy = -dvy * ADV_WALL_BOUNCE; }

    /* --- 6. report the work, then hand our state to the particles ----- */
    advReportWork(dt, mag, damaged);
    advPushToParticles(dt, fx, fy);

    animateMachinery(dt, damaged);
  }

  /** Distance from the hull centre to the bit, along the facing. */
  function drillReach() {
    return C.VEHICLE_BODY_LENGTH * 0.5 + BLADE_ARM + bladeThick() * 0.5;
  }

  /** Circumscribed reach of the whole machine — it can point any way. */
  function advRadius() {
    var lat = hullHalf();
    var lon = C.VEHICLE_BODY_LENGTH * 0.5 + hopperLen();
    return lat > lon ? lat : lon;
  }

  /**
   * PRE-SCAN for the hardness gate. particles.damageSolidInRect() has no way to
   * exclude a material, so the only place the cap can be enforced is before the
   * cut: walk the box, total up what is there, and count what is over the cap.
   * Costs one queryRect over ~60 deposits — the same order as the cut itself.
   */
  function scanBox(cx, cy, half, cap, fx, fy) {
    scCap = cap;
    scBitX = cx; scBitY = cy; scFx = fx; scFy = fy;
    scCount = 0; scOver = 0; scCoreOver = 0;
    scPath = 0; scPathOver = 0;
    scHardSum = 0; scHardest = 0; scHardestMat = -1;
    SM.particles.queryRect(cx - half, cy - half, cx + half, cy + half, scanSolid);
  }

  /** queryRect callback. Hoisted, allocation-free, O(1) per deposit. */
  function scanSolid(i) {
    if (PD.state[i] !== SM.particles.SOLID) return;
    var m = PD.mat[i];
    var h = m < advHardN ? advHard[m] : 0;
    scCount++;
    scHardSum += h;
    if (h > scHardest) { scHardest = h; scHardestMat = m; }

    // Where does this deposit sit relative to the BIT and the direction we are
    // pushing? The box has to be axis-aligned; this classification does not.
    var dx = PD.x[i] - scBitX, dy = PD.y[i] - scBitY;
    var along = dx * scFx + dy * scFy;
    var inPath = along > -ADV_PATH_BEHIND;
    if (inPath) scPath++;
    if (h > scCap) {
      scOver++;
      if (inPath) scPathOver++;
      if (along > -ADV_CORE_HALF &&
          dx * dx + dy * dy <= ADV_CORE_HALF * ADV_CORE_HALF) scCoreOver++;
    }
  }

  /**
   * THE HARDNESS GATE, AS A FEELING. This is the emotional engine of the
   * progression — "there is something valuable behind that wall and I cannot
   * reach it yet" — so it must never read as nothing happening. Sparks off the
   * bit, a grinding hit, a trauma floor on the camera, heat, fuel and hull all
   * being eaten, and one rate-limited `drill:blocked` for the HUD to caption.
   * No error, no message from nowhere: the machine visibly fails.
   */
  function advStallFeedback(dt, hx, hy) {
    stallHold += dt;
    if (SM.camera && SM.camera.shakeFloor) SM.camera.shakeFloor(ADV_STALL_SHAKE);

    stallFxTimer -= dt;
    if (stallFxTimer <= 0) {
      stallFxTimer = ADV_STALL_FX;
      if (SM.effects) {
        var m = blockedMat >= 0 ? blockedMat : 0;
        SM.effects.sparks(hx, hy, m, 5, 210);
        SM.effects.flash(hx, hy, 16, m);
      }
      if (SM.sound) SM.sound.play('hit');
    }

    // One caption per ADV_STALL_SAY of grinding, not one per step. The timer
    // starts at zero (cleared the moment the machine is free) so the FIRST
    // contact announces immediately and a long grind then repeats slowly.
    stallSay -= dt;
    if (stallSay <= 0) {
      stallSay = ADV_STALL_SAY;
      evBlocked.x = hx; evBlocked.y = hy;
      evBlocked.matIndex = blockedMat;
      evBlocked.hardness = blockedHard;
      evBlocked.cap = scCap;
      SM.events.emit('drill:blocked', evBlocked);
    }
  }

  /**
   * Tell adv.js what this step cost. Driving is cheap, drilling is the expense,
   * and grinding on rock above the cap is the most expensive thing in the game.
   */
  function advReportWork(dt, mag, damaged) {
    var driveRate = rigStat('getDriveBurn', ADV_FALLBACK_DRIVE_BURN);
    var drillRate = rigStat('getDrillBurn', ADV_FALLBACK_DRILL_BURN);
    var load = damaged > 0 ? (damaged > 24 ? 1 : damaged / 24) : 0;

    /* FUEL PER METRE IS THE INVARIANT FOR THE GEAR. advTravel is a speed
     * multiplier, so the drive burn carries the same multiplier: the tank empties
     * at the same rate per metre of tunnel it always did and only the wall clock
     * gets shorter. Drilling burn is untouched — that is work, not distance.
     *
     * THE SLOWDOWN IS DELIBERATELY *NOT* COMPENSATED THE SAME WAY. Every burn
     * here is per SECOND, so cutting at 0.33x speed spends three times the fuel
     * per metre of rock, and that is the honest price of grinding: hard ground
     * costs range, a better drill buys it back. It does move rig.js's numbers —
     * MEASURED with ibal.js, the tier-0 rig now turns back at 166 m of Old
     * Creek's 480 instead of 247 m. If that is too tight, the lever is rig.js's
     * tank or burn rates (Agent 2's), or ADV_LOAD_SCALE above; multiplying the
     * drive term by `factor` here would restore the old range exactly, at the
     * cost of making rock free to drive through. */
    var drive = mag > 0 ? driveRate * mag * advTravel : 0;
    var drill = 0;
    if (stalled) drill = drillRate * ADV_HARD_BURN_MUL;
    else if (damaged > 0) drill = drillRate * (0.35 + 0.65 * load);

    var want = (drive + drill) * dt;
    if (want > 0) {
      var got = SM.adv.burnFuel(want);
      // Anything the tank could not supply is the moment the engine dies;
      // adv.js owns the strand, we just stop pretending we have power.
      if (got < want - 1e-6) advDry = true;
    }
    driveBurn += (drive + drill - driveBurn) * (1 - Math.exp(-3 * dt));

    // Ordinary drilling heat is SM.mines.heatGainRate()'s to give (adv.js reads
    // isCutting() for it). A JAMMED bit is ours: it is friction, not work. There
    // is deliberately no integrity term here — see ADV_RAM_WEAR.
    if (stalled) SM.adv.addHeat(ADV_STALL_HEAT * dt);
  }

  /**
   * Collector, chassis body and the rear belt, all rotated onto the heading.
   *
   * THE FULL HOLD. particles.js decides on its own what to swallow, so the only
   * lever is the collector RADIUS: setting it to zero stops new debris being
   * captured while leaving ore already in flight to arrive, and the ore we
   * refuse simply stays on the floor as loose debris — which is exactly the
   * pile the player comes back for after a dump().
   */
  function advPushToParticles(dt, fx, fy) {
    // 0.995 rather than 1: the last sliver of hold cannot take a fragment of
    // anything, and a collector that keeps swallowing ore it has to spit back
    // out reads as a glitch.
    var full = SM.adv.getCargoPct() >= 0.995;
    var off = C.VEHICLE_BODY_LENGTH * 0.22;          // local +y == behind
    var cx = x - fx * off, cy = y - fy * off;
    SM.particles.setCollectorTarget(cx, cy, full ? 0 : getCollectRadius());

    // A square body box: the hull can point any way, and a square is the only
    // axis-aligned shape that does not change size when it does.
    var hh = hullHalf();
    SM.particles.setVehicleBody(x, y, hh, hh, dvx, dvy);

    if (!full && parts.conveyor > 0) {
      var tr = TRAIL_RADIUS + (parts.conveyor - 1) * TRAIL_RADIUS_STEP;
      var rr = rearEdge() + tr * 0.35;
      SM.particles.collectInRadius(x - fx * rr, y - fy * rr, tr);
    }
  }

  /* =====================================================================
   * GEOMETRY HELPERS (shared by update, render and the public getters)
   * ================================================================== */
  function trackWidth() { return TRACK_WIDTH + parts.treads * TRACK_PER_LEVEL; }
  function hullHalf() { return bodyWidth * 0.5 + trackWidth() - TRACK_INSET; }
  /**
   * How far the rear cargo assembly reaches behind the chassis rear edge.
   * ADVENTURE returns the ore bed (bays + couplings, measured from ADV_BED_Y0);
   * classic returns exactly the hopper it always did. Everything downstream —
   * the ground shadow, rearEdge(), advRadius() and the trailing collector — is
   * therefore correct in both modes with no branch of its own.
   */
  function hopperLen() {
    if (advMode()) {
      var l = advBedTotal() - wallT();
      return l > 10 ? l : 10;
    }
    return HOPPER_LEN + parts.hopper * HOPPER_PER_LEVEL;
  }
  function conveyorLen() {
    // ADVENTURE: the belt is not a tail, it is the intake feeder on the deck
    // (drawIntake), so it adds no length. The `conveyor` flag still drives the
    // trailing pickup bubble in advPushToParticles() — that is gameplay.
    if (advMode()) return 0;
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
  /** Half-span reached by the magnet collector arms (0 if none, 0 in adventure). */
  function magnetHalf() {
    if (advMode() || parts.magnetArms <= 0) return 0;
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
    // ADVENTURE has no collector arms — the widest thing at the back is the ore
    // bed, which may overhang the tracks by a few units and nothing more. That
    // keeps getWidth() an honest hull width for the dust and the camera instead
    // of the 840-unit arm span the old geometry reported at full cargo.
    if (advMode()) {
      var b = hull * bedHalfFrac() * 2;
      if (b > s) s = b;
    } else if (parts.magnetArms > 0) {
      var m = (hull + ARM_REACH + parts.magnetArms * ARM_REACH_STEP) * 2;
      if (m > s) s = m;
    }
    // Safety net: nothing may reach past the blade cap, or the rig starts
    // grinding bedrock and the camera has no lane left to frame.
    if (s > MAX_BLADE) s = MAX_BLADE;
    return s;
  }

  /* --- ADVENTURE: the ore bed's dimensions -----------------------------
   * All of it derives from ONE number, the `hopper` flag out of
   * SM.rig.getPartFlags(), so a re-tier in rig.js needs nothing here. Written
   * as growth + thresholds rather than as a six-row table so that a seventh
   * cargo tier still gets a longer bed and a thicker wall for free.
   * ------------------------------------------------------------------ */
  function cargoFlag() {
    var t = parts.hopper | 0;
    return t > 0 ? t : 0;
  }
  function bayCount() {
    var t = cargoFlag();
    return 1 + (t >= ADV_BAY2 ? 1 : 0) + (t >= ADV_BAY3 ? 1 : 0);
  }
  function bedHalfFrac() {
    var f = ADV_BED_HALF + cargoFlag() * ADV_BED_HALF_STEP;
    return f > ADV_BED_HALF_MAX ? ADV_BED_HALF_MAX : f;
  }
  function bedHalf() { return hullHalf() * bedHalfFrac(); }
  function wallT() { return ADV_WALL + cargoFlag() * ADV_WALL_STEP; }
  /** Length of bay `i`, front to back. Bay 0 is the one on the chassis. */
  function bayLen(i) {
    var t = cargoFlag();
    var base = ADV_BED_LEN + (t < ADV_BAY2 ? t : ADV_BAY2) * ADV_BED_PER_TIER;
    if (t > ADV_BAY2) base += (t - ADV_BAY2) * ADV_BED_LEN_LATE;
    if (i <= 0) return base;
    if (i === 1) return base * ADV_BAY2_LEN;
    return base * ADV_BAY3_LEN;
  }
  /** Bays taper slightly as they trail, which is what makes them read as a set. */
  function bayScale(i) { return i <= 0 ? 1 : (i === 1 ? 0.95 : 0.90); }
  /** The bed SETTLES on install rather than inflating from nothing. */
  function bedGrow() { return 0.90 + 0.10 * depOf('hopper'); }
  /** The whole assembly, front wall to tailgate, measured from bedY0(). */
  function advBedTotal() {
    var n = bayCount(), total = 0;
    for (var i = 0; i < n; i++) total += bayLen(i);
    return total + (n - 1) * ADV_BAY_GAP;
  }
  /** How full the hold is, 0..1. Empty (and honest) outside a run. */
  function cargoFill() {
    if (!SM.adv || !SM.adv.getCargoPct) return 0;
    var f = SM.adv.getCargoPct();
    if (!(f > 0)) return 0;
    return f > 1 ? 1 : f;
  }
  /**
   * Unfold progress of a part, but SETTLED on every meta screen.
   * main.js zeroes the fixed step while the workshop is up, so update() — and
   * with it animateMorph() — does not run there. Reading deploy[] directly
   * would draw the machine you just paid for permanently half-built on the one
   * screen whose whole job is showing it to you. The four adventure-only
   * subassemblies below (lamps, radiators, armour, dish) were reading deploy[]
   * directly and had exactly that bug; they go through here now too. Classic is
   * unaffected either way — its flags never leave zero and advDriving() is false,
   * so this returns the settled 1 it always effectively had.
   */
  function depOf(k) {
    // Classic keeps its unfold exactly as it was — its clock never stops, so
    // there is no frozen screen to protect against and popping a part in
    // fully-formed would lose the transform beat.
    if (!advMode()) return easeOutBack(deploy[k]);
    return advDriving() ? easeOutBack(deploy[k]) : 1;
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
  var gBedWall = null, gBedFloor = null, gOre = null;
  var gAuger = null, gTipHeat = null, gAugerHeat = null;

  function ensureGradients(ctx, bw, bl) {
    var sig = ((bw * 2) | 0) * 100003 + ((bladeWidth * 2) | 0) * 31 + parts.hopper
            + parts.treads * 7919 + (advMode() ? 524287 : 0);
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

    /* --- the ore bed ---------------------------------------------------
     * Three gradients, cached exactly like the four above. The WALL one runs
     * across the machine so the plate tops catch light on the left and fall
     * away to the right — the same lighting the chassis uses, which is what
     * makes the bed read as part of the same machine rather than as cargo
     * bolted on. The FLOOR and ORE ones run along it so a long bed still has
     * depth down its length. */
    var bh = bedHalf();
    if (!(bh > 1)) bh = bw * 0.5;
    gBedWall = ctx.createLinearGradient(-bh, 0, bh, 0);
    gBedWall.addColorStop(0, '#6a7480');
    gBedWall.addColorStop(0.30, '#8b96a3');
    gBedWall.addColorStop(0.66, '#6f7883');
    gBedWall.addColorStop(1, '#464d55');

    /* --- ADVENTURE ONLY: the auger and the ore bed ----------------------
     * Guarded because the signature carries a mode bit, so entering or leaving
     * adventure always forces a rebuild and these can never be stale-null when
     * something wants them. The classic morph animates bladeWidth every frame
     * and therefore re-signs every frame; there is no reason for it to be
     * building five gradients it will not draw.
     *
     * The auger's is along its axis, so the root reads as lit steel and the point
     * as the far end of a cone. Two of them are radial/graded heat for the
     * THERMAL LANCE; building those per frame would be an allocation in the
     * render path, which is the whole reason this function exists. */
    if (!advMode()) return;

    var ayb = augerBaseY(), ayt = augerTipY();
    gAuger = ctx.createLinearGradient(0, ayb, 0, ayt);
    gAuger.addColorStop(0, '#98a3af');
    gAuger.addColorStop(0.42, '#79838f');
    gAuger.addColorStop(1, '#4f5761');

    var yh = ayb + (ayt - ayb) * 0.22;
    gAugerHeat = ctx.createLinearGradient(0, yh, 0, ayt);
    gAugerHeat.addColorStop(0, 'rgba(150,52,14,0)');
    gAugerHeat.addColorStop(0.45, 'rgba(186,66,18,0.60)');
    gAugerHeat.addColorStop(1, 'rgba(255,152,62,0.88)');

    gTipHeat = ctx.createRadialGradient(0, ayt + 6, 2, 0, ayt + 6, 58);
    gTipHeat.addColorStop(0, 'rgba(255,214,150,0.85)');
    gTipHeat.addColorStop(0.35, 'rgba(255,120,40,0.35)');
    gTipHeat.addColorStop(1, 'rgba(255,80,20,0)');

    var by0 = bl * 0.5 - ADV_WALL, by1 = by0 + advBedTotal();
    gBedFloor = ctx.createLinearGradient(0, by0, 0, by1);
    gBedFloor.addColorStop(0, '#20242a');
    gBedFloor.addColorStop(1, '#0f1216');

    gOre = ctx.createLinearGradient(0, by0, 0, by1);
    gOre.addColorStop(0, '#e2a94f');
    gOre.addColorStop(0.45, '#b8792c');
    gOre.addColorStop(1, '#8a5620');
  }

  /* =====================================================================
   * RENDER  (local space: -y is forward, origin is the chassis centre)
   * ================================================================== */
  function render(ctx) {
    ctx.save();
    ctx.translate(x, y);
    // ADVENTURE: the hull faces its heading. heading 0 is local -y, which is
    // the classic forward direction, so classic renders through the identical
    // path with the identical transform.
    ctx.rotate(advMode() ? heading + bank : bank);
    drawMachine(ctx);
    ctx.restore();
  }

  /**
   * Draw the machine into an arbitrary transform — the workshop's portrait.
   * Agent 4's garage screen wants the REAL renderer rather than a second
   * illustration that would drift from it, and the real renderer is anchored to
   * the world position, so this is the seam: give it a centre, a scale and a
   * rotation and it paints the current build there.
   */
  function renderPreview(ctx, cx, cy, scale, rot) {
    ctx.save();
    ctx.translate(cx, cy);
    if (scale && scale !== 1) ctx.scale(scale, scale);
    if (rot) ctx.rotate(rot);
    drawMachine(ctx);
    ctx.restore();
  }

  /** Local space: -y is forward, the origin is the chassis centre. */
  function drawMachine(ctx) {
    var bl = C.VEHICLE_BODY_LENGTH;
    var bw = bodyWidth;
    var morphFlash = morphActive ? (1 - morphT) : 0;

    ensureGradients(ctx, bw, bl);

    drawShadow(ctx, bw, bl);
    drawCollectorField(ctx, bl);
    /* THE SEAM. Adventure's cargo geometry is the ore bed; classic's is the
     * hopper, the tail conveyor and the collector arms its own upgrade path
     * installs. Neither knows about the other. */
    var adv = advMode();
    if (adv) {
      drawOreBed(ctx, bw, bl);
    } else {
      if (parts.conveyor > 0) drawConveyor(ctx, bw, bl);
      drawHopper(ctx, bw, bl);
      // Arms draw AFTER the hopper: behind it they were completely hidden.
      if (parts.magnetArms > 0) drawMagnetArms(ctx, bw, bl);
    }
    drawTracks(ctx, bw, bl);
    if (parts.radiators > 0) drawRadiators(ctx, bw, bl);
    drawChassis(ctx, bw, bl, morphFlash);
    // The intake sits ON the deck, so it draws over the chassis it is bolted to.
    if (adv) drawIntake(ctx, bw, bl);
    if (parts.armor > 0) drawArmor(ctx, bw, bl);
    /* THE SAME SEAM AT THE FRONT END. Adventure's drill is one auger that grows
     * (drawDrillRig, which folds the `drills` and `grinders` flags into the head
     * as collars and shoulder cutters); classic's is the wide blade plus the
     * separate rotary heads and outrigger grinders its own upgrades install. */
    if (adv) {
      drawDrillRig(ctx, bw, bl, morphFlash);
    } else {
      if (parts.grinders > 0) drawGrinders(ctx, bw, bl);
      drawBlade(ctx, bw, bl, morphFlash);
      if (parts.drills > 0) drawDrills(ctx, bw, bl);
    }
    if (parts.lamps > 0) drawLamps(ctx, bw, bl);
    if (parts.dish > 0) drawDish(ctx, bw, bl);
    drawExhaust(ctx, bw, bl);
    drawLights(ctx, bw, bl);
    if (odLevel > 0.01) drawOverdriveGlow(ctx, bw, bl);
  }

  /* --- ground shadow ---------------------------------------------------- */
  function drawShadow(ctx, bw, bl) {
    var hh = hullHalf();
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    /* ADVENTURE: the bed is its own object, narrower than the tracks at the low
     * tiers and split by couplings at the high ones. One slab down the whole
     * machine drew a black skirt around the tub and filled the gaps between the
     * bays in solid, which is exactly what killed the "separate wagons" read. */
    if (advMode()) {
      roundRect(ctx, -hh + 5, -bl * 0.5 + 7, hh * 2, bl, 12);
      ctx.fill();
      var n = bayCount(), y = bedY0(), hw = bedHalf(), grow = bedGrow();
      ctx.save();
      ctx.translate(5, 7);
      for (var i = 0; i < n; i++) {
        var len = bayLen(i) * grow, sc = hw * bayScale(i);
        bedPath(ctx, y, y + len, sc * 0.96, sc, 7);
        ctx.fill();
        y += len + ADV_BAY_GAP;
      }
      ctx.restore();
      return;
    }
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

  /* =====================================================================
   * ADVENTURE SUBASSEMBLIES
   * ---------------------------------------------------------------------
   * Three parts that only exist underground, switched on by the `lamps`,
   * `radiators` and `armor` flags out of SM.rig.getPartFlags(). Deliberately
   * modest: js/effects.js owns the darkness composite and the actual light, so
   * a lamp here is a FIXTURE plus a hint of spill — a second, brighter light
   * model drawn on the machine would fight the real one.
   * ================================================================== */

  /* ---------------------------------------------------------------------
   * THE DRILL — one bit that gets bigger, not a rack of discs
   * ---------------------------------------------------------------------
   * WORN AUGER BIT -> ... -> PLASMA CORE BREAKER is 8 to 84 power and a hardness
   * cap from 8.5 to 34. That escalation has to be one machine getting more
   * formidable, so the story is a single AUGER: it gets longer out front, thicker
   * at the root, gains flutes, gains stepped stages, grows teeth into cutters,
   * and finally runs hot and then energised.
   *
   * The wide toothed bar behind it stays, because the cut is honestly that wide
   * (ADV_CUT_HALF*2 is 168 at tier 0 and 248 at tier 5) — but it is demoted from
   * "the drill" to what it actually is, a REAMER that opens the pilot hole out to
   * the corridor. The rotary discs and side grinders the flags still carry are
   * folded into the head as collars and shoulder cutters instead of being bolted
   * on as separate machinery, which was the thing that read as "more discs".
   *
   *   yBase  the collar face, just in front of the reamer bar
   *   yTip   pinned to the front of the cut box, so the drawn bit reaches as far
   *          as the machine actually cuts — that is what makes it look honest
   *   R(t)   Rb * (1-t)^0.62, a slightly convex cone rather than a straight one
   * ------------------------------------------------------------------ */
  var AUG_N = 9;                          // samples along the auger axis
  var augY = new Float32Array(AUG_N);
  var augR = new Float32Array(AUG_N);

  function drillTier() {
    var t = parts.bladeTier | 0;
    return t > 0 ? t : 0;
  }
  function augerBaseY() {
    return -C.VEHICLE_BODY_LENGTH * 0.5 - BLADE_ARM - bladeThick() * 0.35;
  }
  function augerTipY() {
    var T = drillTier();
    var cutHalf = ADV_CUT_HALF + T * ADV_CUT_PER_TIER;
    return -(drillReach() + cutHalf * ADV_AUGER_REACH + T * ADV_AUGER_PER_TIER);
  }
  function augerRadius() {
    return bladeWidth * 0.5 * (ADV_AUGER_GIRTH + drillTier() * ADV_AUGER_GIRTH_STEP);
  }
  /**
   * Fill augY/augR for this frame's geometry. No allocation.
   *
   * The profile is a SHANK and then a POINT, not a cone. A cone drawn top-down
   * with symmetric flutes reads as a pyramid — it was tried, screenshotted, and
   * looked like a pagoda bolted to the nose. A near-cylindrical body with the
   * taper saved for the last third reads as a drill, and it also gives the
   * helical flutes a constant width to scroll across, which is what actually
   * sells the rotation (the same reason the reamer's diagonal stripes work).
   */
  function augerSamples() {
    var yb = augerBaseY(), yt = augerTipY(), Rb = augerRadius();
    for (var i = 0; i < AUG_N; i++) {
      var t = i / (AUG_N - 1);
      augY[i] = yb + (yt - yb) * t;
      if (t <= ADV_AUGER_SHANK) {
        // a barely-tapered shank, thickest at the root where the torque is
        augR[i] = Rb * (1 - 0.13 * (t / ADV_AUGER_SHANK));
      } else {
        var u = (t - ADV_AUGER_SHANK) / (1 - ADV_AUGER_SHANK);
        augR[i] = Rb * 0.92 * Math.pow(1 - u, 1.15);
      }
    }
  }
  function augerPath(ctx) {
    var i;
    ctx.beginPath();
    ctx.moveTo(-augR[0], augY[0]);
    for (i = 1; i < AUG_N; i++) ctx.lineTo(-augR[i], augY[i]);
    for (i = AUG_N - 1; i >= 0; i--) ctx.lineTo(augR[i], augY[i]);
    ctx.closePath();
  }
  /** Radius at an arbitrary 0..1 along the axis, from the sampled cone. */
  function augerAt(t) {
    var f = t * (AUG_N - 1), i = f | 0;
    if (i >= AUG_N - 1) return augR[AUG_N - 1];
    return augR[i] + (augR[i + 1] - augR[i]) * (f - i);
  }
  function augerYAt(t) { return augY[0] + (augY[AUG_N - 1] - augY[0]) * t; }

  /**
   * The whole front end. Replaces drawBlade + drawDrills + drawGrinders in
   * adventure mode; classic still calls all three, untouched.
   */
  function drawDrillRig(ctx, bw, bl, flash) {
    var T = drillTier();
    var thick = bladeThick();
    var frontY = -bl * 0.5 - BLADE_ARM;
    var halfW = bladeWidth * 0.5;
    var top = frontY - thick * 0.5;
    var dep = depOf('bladeTier');
    var s, i, k;

    augerSamples();

    /* JUDDER. Pinned against rock it cannot cut, the whole head shakes. This is
     * the moment the hardness gate has to sell, and the drill is what the player
     * is staring at while it happens. */
    var jud = stalled ? 1.6 + Math.min(1.4, resistance * 0.004) : 0;
    ctx.save();
    if (jud > 0) {
      ctx.translate(Math.sin(lightPhase * 120) * jud, Math.cos(lightPhase * 97) * jud);
    }

    /* --- mounts: heavy legs from the hull nose to the reamer ---------- */
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#2b3138';
    ctx.lineWidth = 13;
    for (s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.moveTo(s * bw * 0.30, -bl * 0.5 + 12);
      ctx.lineTo(s * Math.min(halfW - 12, bw * 0.34 + 26), frontY + 3);
      ctx.stroke();
    }
    ctx.strokeStyle = '#4a525c';
    ctx.lineWidth = 7;
    for (s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.moveTo(s * bw * 0.44, -bl * 0.28);
      ctx.lineTo(s * (halfW - 9), frontY + 4);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';

    /* --- the reamer bar ----------------------------------------------- */
    ctx.save();
    roundRect(ctx, -halfW, top, bladeWidth, thick, 7);
    ctx.clip();
    ctx.fillStyle = gDrum;
    ctx.fillRect(-halfW, top, bladeWidth, thick);
    var pitch = 20;
    var off = (drumPhase * 3.2) % pitch;
    ctx.fillStyle = 'rgba(255,205,70,0.34)';
    for (var sx = -halfW - pitch * 2; sx < halfW + pitch; sx += pitch) {
      ctx.beginPath();
      ctx.moveTo(sx + off, top);
      ctx.lineTo(sx + off + 5, top);
      ctx.lineTo(sx + off + 5 + thick, top + thick);
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

    // reamer teeth, biggest at the shoulders where the corridor gets its width
    var toothPitch = 16 - parts.teeth * 1.6;
    if (toothPitch < 10) toothPitch = 10;
    var n = Math.max(3, Math.round(bladeWidth / toothPitch));
    if (n > 70) n = 70;
    var step = bladeWidth / n;
    var toothLen = 8 + parts.teeth * 1.8;
    for (i = 0; i < n; i++) {
      var cx = -halfW + step * (i + 0.5);
      var edge = Math.abs(cx) / halfW;              // 0 centre .. 1 shoulder
      var wob = Math.sin(drumPhase * 2.4 + i * 0.9) * 2.2;
      var len = toothLen * (0.72 + edge * 0.5) + wob;
      ctx.beginPath();
      ctx.moveTo(cx - step * 0.40, top);
      ctx.lineTo(cx, top - len);
      ctx.lineTo(cx + step * 0.40, top);
      ctx.closePath();
      ctx.fillStyle = (i & 1) ? '#c8d2dc' : '#98a4b0';
      ctx.fill();
    }

    /* --- shoulder cutters: the `grinders` flag, folded into the head --- */
    if (parts.grinders > 0) drawShoulderCutters(ctx, halfW, frontY, thick);

    /* --- the auger ---------------------------------------------------- */
    var tipY = augY[AUG_N - 1];
    // seated shadow, so the bit reads as standing off the bar
    ctx.save();
    ctx.translate(4, 5);
    augerPath(ctx);
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fill();
    ctx.restore();

    augerPath(ctx);
    ctx.fillStyle = gAuger;
    ctx.fill();
    ctx.strokeStyle = '#14171b';
    ctx.lineWidth = 2.6;
    ctx.stroke();

    /* FLUTES. Helical grooves, drawn as diagonal bands travelling toward the tip
     * — the same trick the reamer drum uses to read as a spinning cylinder, and
     * the only one that survives being 90 px tall. Pitch tightens and the groove
     * deepens with the tier: a worn auger has a lazy coarse thread, the core
     * breaker is close-pitched and aggressive. */
    var Rb = augR[0];
    var pitch = ADV_FLUTE_PITCH - T * 1.7;
    if (pitch < 9) pitch = 9;
    var off = (drumPhase * 7) % pitch;
    var rise = Rb * 1.5;                        // helix angle across the body
    ctx.save();
    augerPath(ctx);
    ctx.clip();
    for (var fy = augY[0] + pitch * 2; fy > augY[AUG_N - 1] - rise; fy -= pitch) {
      var y0 = fy - off;
      ctx.strokeStyle = 'rgba(10,13,17,0.62)';
      ctx.lineWidth = pitch * 0.44 + T * 0.2;
      ctx.beginPath();
      ctx.moveTo(-Rb * 1.3, y0);
      ctx.lineTo(Rb * 1.3, y0 - rise);
      ctx.stroke();
      // the land: the lit edge of the thread, just ahead of the groove
      ctx.strokeStyle = 'rgba(228,238,248,0.26)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(-Rb * 1.3, y0 - pitch * 0.34);
      ctx.lineTo(Rb * 1.3, y0 - rise - pitch * 0.34);
      ctx.stroke();
    }
    ctx.restore();

    /* Gauge cutters where the thread meets the gauge — two pairs, chunky, at the
     * root and at the shoulder where the point begins. Rows of little spikes all
     * down the flanks were tried and read as a pinecone. */
    var tl = 4 + T * 1.6;
    for (k = 0; k < 2; k++) {
      var gt = k === 0 ? 0.16 : ADV_AUGER_SHANK - 0.04;
      var rr = augerAt(gt), yy = augerYAt(gt);
      if (rr < 4) continue;
      for (s = -1; s <= 1; s += 2) {
        ctx.beginPath();
        ctx.moveTo(s * (rr - 1), yy - 6 - T * 0.5);
        ctx.lineTo(s * (rr + tl), yy - 1);
        ctx.lineTo(s * (rr + tl * 0.6), yy + 5);
        ctx.lineTo(s * (rr - 1), yy + 6 + T * 0.5);
        ctx.closePath();
        ctx.fillStyle = k ? '#cdd6e0' : '#aeb9c4';
        ctx.fill();
        ctx.strokeStyle = 'rgba(10,13,16,0.6)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }

    /* --- stepped stages: the `drills` flag as collars on ONE bit ------ */
    var collars = parts.drills > 2 ? 2 : parts.drills;
    for (k = 0; k < collars; k++) {
      var ct = 0.26 + k * 0.26;
      var cr = augerAt(ct), cy = augerYAt(ct);
      var isNew = (k === collars - 1);
      var cw = cr * (1.30 + k * 0.06) * (isNew ? 0.55 + 0.45 * dep : 1);
      var chh = 9 + T * 0.7;
      ctx.fillStyle = '#4d5661';
      roundRect(ctx, -cw, cy - chh * 0.5, cw * 2, chh, 3);
      ctx.fill();
      ctx.strokeStyle = '#14171b';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(-cw + 3, cy - chh * 0.5 + 1.5, cw * 2 - 6, 1.6);
      // bolt heads round the collar, not cutters hanging off it
      ctx.fillStyle = 'rgba(20,24,29,0.55)';
      for (s = -1; s <= 1; s += 2) {
        ctx.beginPath();
        ctx.arc(s * cw * 0.72, cy, 1.8 + T * 0.12, 0, TAU);
        ctx.fill();
      }
    }

    /* --- the point ---------------------------------------------------- */
    var rt = augerAt(ADV_AUGER_SHANK + 0.02), ry = augerYAt(ADV_AUGER_SHANK + 0.02);
    ctx.beginPath();
    ctx.moveTo(-rt, ry);
    ctx.lineTo(-rt * 0.30, tipY + 6);
    ctx.lineTo(0, tipY - 4);
    ctx.lineTo(rt * 0.30, tipY + 6);
    ctx.lineTo(rt, ry);
    ctx.closePath();
    ctx.fillStyle = '#c6d0da';
    ctx.fill();
    ctx.strokeStyle = '#14171b';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    // chisel edge: two ground faces meeting at the point
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.beginPath();
    ctx.moveTo(-rt * 0.55, ry);
    ctx.lineTo(0, tipY - 3);
    ctx.lineTo(rt * 0.05, ry);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(12,15,19,0.55)';
    ctx.lineWidth = 1.4;
    for (k = 0; k < 2; k++) {
      var qy = ry + (tipY - ry) * (0.30 + k * 0.32);
      var qr = rt * (0.72 - k * 0.30);
      ctx.beginPath();
      ctx.moveTo(-qr, qy); ctx.lineTo(qr, qy - 3);
      ctx.stroke();
    }

    /* --- heat, then plasma -------------------------------------------- */
    var work = loadSmoothed;
    if (stalled) work = 1;
    if (T >= ADV_DRILL_THERMAL) drawDrillHeat(ctx, T, work, tipY);
    if (T >= ADV_DRILL_PLASMA) drawDrillPlasma(ctx, T, work, tipY);

    // Working glow at the cutting face in every tier, hotter under load.
    var glow = 0.16 + Math.min(0.46, resistance * 0.0035) + work * 0.22;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,150,40,' + glow.toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(0, tipY + 6, 9 + T * 2.2 + work * 6, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,150,40,' + (glow * 0.7).toFixed(3) + ')';
    ctx.fillRect(-halfW, top - 3, bladeWidth, 4);
    ctx.restore();

    /* --- morph flourish, exactly as the old blade had it -------------- */
    if (flash > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(255,255,255,' + (flash * 0.7).toFixed(3) + ')';
      augerPath(ctx);
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,220,255,' + (flash * 0.85).toFixed(3) + ')';
      ctx.lineWidth = 3;
      var rr2 = (1 - flash) * 70 + 10;
      for (k = -1; k <= 1; k += 2) {
        ctx.beginPath();
        ctx.arc(k * halfW, frontY, rr2, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();                        // judder
  }

  /**
   * The `grinders` flag: toothed wheels at the ends of the reamer bar, where a
   * real machine would put the gauge cutters. Inside the cut width on purpose —
   * outriggers hanging off the hull were the "more discs" problem.
   */
  function drawShoulderCutters(ctx, halfW, frontY, thick) {
    var n = parts.grinders > 3 ? 3 : parts.grinders;
    var dep = depOf('grinders');
    var top = frontY - thick * 0.5;
    for (var g = 0; g < n; g++) {
      var sc = (g === n - 1) ? 0.4 + 0.6 * dep : 1;
      var w = (9 - g * 1.2) * sc;
      var len = (15 - g * 2.5) * sc;
      if (w < 2) continue;
      // Chatter, so they read as machinery under load — the same travelling
      // wave the reamer teeth use, half a beat out of phase.
      var wob = Math.sin(grindPhase * 1.6 + g) * 1.8;
      var gx = halfW - 4 - g * (w * 2.2);
      for (var s = -1; s <= 1; s += 2) {
        ctx.beginPath();
        ctx.moveTo(s * (gx - w), top + 2);
        ctx.lineTo(s * (gx - w * 0.2), top - len - wob);
        ctx.lineTo(s * (gx + w * 0.9), top - len * 0.55 - wob);
        ctx.lineTo(s * (gx + w), top + 4);
        ctx.closePath();
        ctx.fillStyle = g ? '#aeb9c4' : '#cdd6e0';
        ctx.fill();
        ctx.strokeStyle = '#14171b';
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.moveTo(s * (gx - w * 0.7), top);
        ctx.lineTo(s * (gx - w * 0.25), top - len * 0.85 - wob);
        ctx.lineTo(s * (gx + w * 0.1), top - len * 0.45 - wob);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  /** THERMAL LANCE: nozzles round the collar and a bit that runs cherry-red. */
  function drawDrillHeat(ctx, T, work, tipY) {
    var heat = 0.45 + work * 0.55;
    /* The forward half runs cherry-red. NOT additive: 'lighter' orange over cool
     * steel comes out pink, which was screenshotted and looked like copper. A
     * plain warm fill tints it toward rust and keeps the metal reading as metal. */
    ctx.save();
    augerPath(ctx);
    ctx.clip();
    if (gAugerHeat) {
      ctx.globalAlpha = 0.55 + heat * 0.45;
      ctx.fillStyle = gAugerHeat;
      ctx.fillRect(-90, augerYAt(1) - 12, 180, (augerYAt(0) - augerYAt(1)) + 12);
    }
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // radiant halo at the point (cached radial — see ensureGradients)
    if (gTipHeat) {
      ctx.save();
      ctx.globalAlpha = 0.35 + heat * 0.5;
      ctx.fillStyle = gTipHeat;
      ctx.fillRect(-80, tipY - 60, 160, 130);
      ctx.restore();
    }
    ctx.restore();
    // lance nozzles: short stubs round the base, alight
    var rb = augR[1], yb = augY[1];
    for (var s = -1; s <= 1; s += 2) {
      ctx.fillStyle = '#39414b';
      roundRect(ctx, s * rb - (s > 0 ? 8 : 0), yb - 4, 8, 13, 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,190,90,' + (0.5 + work * 0.4).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(s * (rb - 4), yb - 3, 2.6, 0, TAU);
      ctx.fill();
    }
  }

  /** PLASMA CORE BREAKER: a lit core and arcs walking over the cutters. */
  function drawDrillPlasma(ctx, T, work, tipY) {
    var i;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    /* A field turning round the bit: two arcs sweeping with lightPhase. A full
      * ring was tried and read as a soap bubble stuck on the drill. */
    var cy = augerYAt(0.80), cr = augerAt(0.62) * 1.35;
    var pulse = 0.55 + 0.45 * Math.sin(lightPhase * 9);
    var spin = lightPhase * 5.5;
    ctx.strokeStyle = 'rgba(150,235,255,' + (0.40 + pulse * 0.35).toFixed(3) + ')';
    ctx.lineWidth = 2.5 + pulse * 2;
    for (i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.arc(0, cy, cr, spin + i * Math.PI, spin + i * Math.PI + 1.9);
      ctx.stroke();
    }
    // the lit core, at the root of the point where the energy is delivered
    var ky = augerYAt(0.88);
    ctx.fillStyle = 'rgba(210,248,255,' + (0.34 + pulse * 0.34).toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(0, ky, augerAt(0.88) * 1.5 + 2, 0, TAU);
    ctx.fill();

    // arcs: three, re-rolled ~14 times a second so they crackle
    ctx.strokeStyle = 'rgba(190,240,255,' + (0.5 + work * 0.4).toFixed(3) + ')';
    ctx.lineWidth = 1.8;
    var tick = (lightPhase * 14) | 0;
    for (i = 0; i < 3; i++) {
      var h1 = bump(tick + i * 7), h2 = bump(tick * 3 + i * 11);
      var t0 = 0.25 + h1 * 0.5, t1 = 0.72 + h2 * 0.24;
      var s0 = h1 > 0.5 ? 1 : -1;
      var x0 = s0 * augerAt(t0) * 0.9, y0 = augerYAt(t0);
      var x1 = -s0 * augerAt(t1) * 0.5, y1 = augerYAt(t1);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo((x0 + x1) * 0.5 + (h2 - 0.5) * 14, (y0 + y1) * 0.5);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------------
   * THE ORE BED — the CARGO ladder, drawn as volume
   * ---------------------------------------------------------------------
   * Read the ADV_BED_* note by the tunables first; this is the implementation.
   * One bay is a chamfered steel tub drawn as three concentric shapes:
   *
   *     shell   the plate, filled with the wall gradient      <- outer
   *     cavity  the hold, filled dark                         <- inset by wallT()
   *     load    the ore, filled from the intake end backwards <- clipped to it
   *
   * The visible ring of shell between those two IS the wall seen from above, so
   * its thickness is the only height cue this view can carry, and the two
   * offset strokes inside the cavity (shadow down-left, light up-right) are what
   * turn a dark rectangle into a hole. Everything else — ribs, hinges, the
   * tailgate, the ram, the couplings — is there to say what the thing is FOR.
   * ------------------------------------------------------------------ */

  /** y of the bed's front wall. Tucked under the chassis by its own thickness,
   *  so the tub looks welded to the hull and the whole cavity stays visible. */
  function bedY0() { return C.VEHICLE_BODY_LENGTH * 0.5 - wallT(); }

  /** Chamfered trapezoid — the plate silhouette of one bay. */
  function bedPath(ctx, y0, y1, hw0, hw1, ch) {
    var lim = (y1 - y0) * 0.45, lw = (hw0 < hw1 ? hw0 : hw1) * 0.5;
    if (ch > lim) ch = lim;
    if (ch > lw) ch = lw;
    if (!(ch > 0)) ch = 0;
    ctx.beginPath();
    ctx.moveTo(-hw0 + ch, y0);
    ctx.lineTo(hw0 - ch, y0);
    ctx.lineTo(hw0, y0 + ch);
    ctx.lineTo(hw1, y1 - ch);
    ctx.lineTo(hw1 - ch, y1);
    ctx.lineTo(-hw1 + ch, y1);
    ctx.lineTo(-hw1, y1 - ch);
    ctx.lineTo(-hw0, y0 + ch);
    ctx.closePath();
  }

  /** Deterministic 0..1 from an integer — heap bumps that do not jitter. */
  function bump(i) {
    var s = Math.sin(i * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  }

  function drawOreBed(ctx, bw, bl) {
    var T = cargoFlag();
    var n = bayCount();
    var grow = bedGrow();
    var wall = wallT();
    var hw = bedHalf();
    var fill = cargoFill();
    var i, len;

    // The load is ONE contiguous run from the intake end, so a small haul sits
    // in the front bay and the rest is visibly, expensively empty.
    var interior = 0;
    for (i = 0; i < n; i++) {
      len = bayLen(i) * grow - wall * 2;
      if (len > 0) interior += len;
    }
    var run = fill * interior;

    var y = bedY0();
    for (i = 0; i < n; i++) {
      len = bayLen(i) * grow;
      var hwR = hw * bayScale(i), hwF = hwR * 0.96;
      var inner = len - wall * 2;
      var f = inner > 0 ? run / inner : 0;
      if (f > 1) f = 1; else if (f < 0) f = 0;
      run -= inner;
      // Couplings draw BEFORE the bay behind them so the bay's plate overlaps
      // the drawbar, which is how a hitch actually sits.
      if (i > 0) drawCoupling(ctx, y - ADV_BAY_GAP, hwR, wall);
      drawBay(ctx, y, len, hwF, hwR, wall, f, T, i, i === n - 1);
      y += len + ADV_BAY_GAP;
    }
  }

  /**
   * One bay. `f` is how full THIS bay is, 0..1; `idx` 0 is the one on the hull.
   */
  function drawBay(ctx, y0, len, hwF, hwR, wall, f, T, idx, last) {
    var y1 = y0 + len;
    var ch = 6 + T * 0.7;
    var s, k;

    /* --- the plate ---------------------------------------------------- */
    bedPath(ctx, y0, y1, hwF, hwR, ch);
    ctx.fillStyle = gBedWall;
    ctx.fill();
    ctx.strokeStyle = '#14171b';
    ctx.lineWidth = 2.6;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';   // lit top edge of the plate
    ctx.lineWidth = 1.3;
    ctx.stroke();

    /* --- bolted side boards: the HIGH-SIDED tier's read --------------- */
    if (T >= ADV_HIGHSIDE) {
      var board = 3 + (T - ADV_HIGHSIDE) * 1.1;
      bedPath(ctx, y0 + wall * 0.5, y1 - wall * 0.5,
              hwF - wall * 0.42, hwR - wall * 0.42, ch * 0.7);
      ctx.strokeStyle = 'rgba(30,35,41,0.55)';    // the seam where they bolt on
      ctx.lineWidth = board;
      ctx.stroke();
    }

    /* --- the cavity --------------------------------------------------- */
    var iF = hwF - wall, iR = hwR - wall;
    var iy0 = y0 + wall, iy1 = y1 - wall;
    if (iF < 4) iF = 4;
    if (iR < 4) iR = 4;
    if (iy1 - iy0 < 6) iy1 = iy0 + 6;
    var ich = ch * 0.55;

    bedPath(ctx, iy0, iy1, iF, iR, ich);
    ctx.fillStyle = gBedFloor;
    ctx.fill();

    ctx.save();
    bedPath(ctx, iy0, iy1, iF, iR, ich);
    ctx.clip();

    /* --- the floor ----------------------------------------------------
     * An EMPTY bay has to read as a floor you could stand on, or a big unfilled
     * hold looks like a hole cut in the machine — which is the one thing that
     * would undo the whole "look how much room is left" story. Ribbed steel:
     * cross slats plus two rails, all of it under the load. */
    var slat = 15 + T;
    ctx.lineWidth = 1;
    for (k = 1; iy0 + k * slat < iy1; k++) {
      var sy = iy0 + k * slat;
      ctx.strokeStyle = 'rgba(255,255,255,0.055)';
      ctx.beginPath(); ctx.moveTo(-iR, sy); ctx.lineTo(iR, sy); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.moveTo(-iR, sy + 1.2); ctx.lineTo(iR, sy + 1.2); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.moveTo(s * iF * 0.52, iy0); ctx.lineTo(s * iR * 0.52, iy1);
      ctx.stroke();
    }

    /* --- the load ----------------------------------------------------- */
    if (f > 0.004) {
      // The compactor's ram stands in front of the load and pushes it back, so
      // the ore starts behind the plate rather than at the front wall.
      var oy0 = (idx === 0 && T >= ADV_RAM) ? ramStroke(iy0) + ramThick(wall) + 1 : iy0;
      var oy1 = oy0 + (iy1 - oy0) * f;
      ctx.fillStyle = gOre;
      ctx.fillRect(-iR, oy0 - 2, iR * 2, oy1 - oy0 + 2);
      // Heaped surface: bumps along the back edge, then a lit crest. The bump
      // radius is capped against the depth of the load, or a nearly empty
      // OPEN SKIP — a 40-unit tub — reads as brim-full on its own heap.
      var bumps = 4 + (iR / 22) | 0;
      var bmax = (oy1 - oy0) * 0.42 + 1.5;
      for (k = 0; k < bumps; k++) {
        var bx = -iR + (iR * 2) * ((k + 0.5) / bumps);
        var br = 4 + bump(k + idx * 7) * (wall * 0.8 + 4);
        if (br > bmax) br = bmax;
        ctx.beginPath();
        ctx.arc(bx, oy1 - br * 0.35, br, 0, TAU);
        ctx.fill();
      }
      // Chunk texture — a handful of darker lumps, fixed per bay.
      ctx.fillStyle = 'rgba(60,36,12,0.45)';
      for (k = 0; k < 5; k++) {
        var cxx = (bump(k * 3 + 1 + idx) - 0.5) * iR * 1.7;
        var cyy = oy0 + (oy1 - oy0) * bump(k * 5 + 2 + idx);
        ctx.beginPath();
        ctx.arc(cxx, cyy, 3.2 + bump(k * 7 + idx) * 3.4, 0, TAU);
        ctx.fill();
      }
      // The gulp: every collected fragment brightens the whole load for a beat.
      if (hopperPulse > 0.01) {
        ctx.fillStyle = 'rgba(255,214,120,' + (hopperPulse * 0.42).toFixed(3) + ')';
        ctx.fillRect(-iR, oy0 - 2, iR * 2, oy1 - oy0 + 2);
      }
      ctx.strokeStyle = 'rgba(255,226,160,0.40)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-iR * 0.92, oy1 - 1);
      ctx.lineTo(iR * 0.92, oy1 - 1);
      ctx.stroke();
    }

    /* --- depth: the walls seen from inside --------------------------- */
    ctx.save();
    ctx.translate(wall * 0.34, wall * 0.42);
    bedPath(ctx, iy0, iy1, iF, iR, ich);
    ctx.strokeStyle = 'rgba(0,0,0,0.62)';
    ctx.lineWidth = wall * 0.85;
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.translate(-wall * 0.30, -wall * 0.36);
    bedPath(ctx, iy0, iy1, iF, iR, ich);
    ctx.strokeStyle = 'rgba(190,205,220,0.13)';
    ctx.lineWidth = wall * 0.7;
    ctx.stroke();
    ctx.restore();

    /* --- the compactor ram -------------------------------------------- */
    if (idx === 0 && T >= ADV_RAM) drawRam(ctx, iy0, iF, iR, wall);
    ctx.restore();                      // end cavity clip

    /* --- ribs, and outboard bracing once the load is heavy ------------ */
    var ribs = 2 + T;
    ctx.lineWidth = 1;
    for (k = 0; k < ribs; k++) {
      var t = (k + 0.6) / (ribs + 0.2);
      var ry = y0 + len * t;
      var ro = hwF + (hwR - hwF) * t;
      for (s = -1; s <= 1; s += 2) {
        ctx.fillStyle = 'rgba(0,0,0,0.34)';
        ctx.fillRect(s > 0 ? ro - wall : -ro, ry - 1.4, wall, 2.8);
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(s > 0 ? ro - wall : -ro, ry - 2.4, wall, 1);
        // A brace every other rib once the sides are tall enough to need them.
        if (T >= ADV_HIGHSIDE && (k & 1) === 0) {
          var fl = 3 + T * 0.7;
          ctx.fillStyle = '#4b535d';
          ctx.beginPath();
          ctx.moveTo(s * ro, ry - 5);
          ctx.lineTo(s * (ro + fl), ry - 2.5);
          ctx.lineTo(s * (ro + fl), ry + 2.5);
          ctx.lineTo(s * ro, ry + 5);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = '#14171b';
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
      }
    }

    /* --- the back end ------------------------------------------------- */
    if (last && T >= ADV_TAILGATE) drawTailgate(ctx, y1, hwR, wall, T);
    else if (last) drawSkipLip(ctx, y1, hwR, wall);

    /* --- load straps once there is a train to secure ------------------ */
    if (T >= ADV_BAY3 && idx < 2) {
      ctx.strokeStyle = 'rgba(24,28,33,0.72)';
      ctx.lineWidth = 4.5;
      for (k = 0; k < 2; k++) {
        var sy = y0 + len * (0.30 + k * 0.34);
        var so = hwF + (hwR - hwF) * ((sy - y0) / len);
        ctx.beginPath();
        ctx.moveTo(-so - 2, sy); ctx.lineTo(so + 2, sy);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.13)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(-so - 2, sy - 2); ctx.lineTo(so + 2, sy - 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(24,28,33,0.72)';
        ctx.lineWidth = 4.5;
      }
    }
  }

  /** Where the ram plate currently sits, in world y. Slow, heavy, hydraulic. */
  function ramStroke(iy0) {
    return iy0 + 3 + (0.5 + 0.5 * Math.sin(armPhase * 0.45)) * 16;
  }
  function ramThick(wall) { return 7 + wall * 0.25; }

  /** Compactor ram: a striped plate on two cylinders, crushing the load back. */
  function drawRam(ctx, iy0, iF, iR, wall) {
    var ry = ramStroke(iy0);
    var half = iF - 1;
    var th = ramThick(wall);

    // cylinders back to the front wall
    for (var s = -1; s <= 1; s += 2) {
      var cx = s * half * 0.56;
      ctx.fillStyle = '#39414b';
      ctx.fillRect(cx - 3.5, iy0 - 4, 7, ry - iy0 + 4);
      ctx.fillStyle = '#9aa4b0';
      ctx.fillRect(cx - 1.5, iy0 + 2, 3, ry - iy0 - 2);
    }
    // the plate
    ctx.fillStyle = '#2a2f36';
    roundRect(ctx, -half, ry, half * 2, th, 2);
    ctx.fill();
    ctx.save();
    roundRect(ctx, -half, ry, half * 2, th, 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,190,40,0.85)';
    for (var sx = -half - th; sx < half + th; sx += 14) {
      ctx.beginPath();
      ctx.moveTo(sx, ry);
      ctx.lineTo(sx + 6, ry);
      ctx.lineTo(sx + 6 + th, ry + th);
      ctx.lineTo(sx + th, ry + th);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = '#14171b';
    ctx.lineWidth = 1.6;
    roundRect(ctx, -half, ry, half * 2, th, 2);
    ctx.stroke();
  }

  /** Hinged tailgate: hinges outboard, latch in the middle, hazard band. */
  function drawTailgate(ctx, y1, hwR, wall, T) {
    var w = hwR + 3;
    var th = wall * 1.15 + 5;
    var y = y1 - wall * 0.55;

    ctx.fillStyle = '#5c646f';
    roundRect(ctx, -w, y, w * 2, th, 3);
    ctx.fill();
    if (T >= ADV_HIGHSIDE) {
      ctx.save();
      roundRect(ctx, -w, y, w * 2, th, 3);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,190,40,0.80)';
      for (var sx = -w - th; sx < w + th; sx += 16) {
        ctx.beginPath();
        ctx.moveTo(sx, y);
        ctx.lineTo(sx + 7, y);
        ctx.lineTo(sx + 7 + th, y + th);
        ctx.lineTo(sx + th, y + th);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.strokeStyle = '#14171b';
    ctx.lineWidth = 2.2;
    roundRect(ctx, -w, y, w * 2, th, 3);
    ctx.stroke();

    // hinge knuckles and the centre latch
    ctx.fillStyle = '#2f353d';
    for (var s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.arc(s * (w - 3), y + th * 0.5, 3.4, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = '#9aa4b0';
    roundRect(ctx, -7, y + th * 0.5 - 2, 14, 4, 1.5);
    ctx.fill();
  }

  /** The OPEN SKIP's back end: no gate, a thin lip and two tipping pins. */
  function drawSkipLip(ctx, y1, hwR, wall) {
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-hwR + 4, y1 - wall * 0.5);
    ctx.lineTo(hwR - 4, y1 - wall * 0.5);
    ctx.stroke();
    ctx.fillStyle = '#2f353d';
    for (var s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.arc(s * (hwR - 2), y1 - 3, 3.6, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#14171b';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }

  /** Drawbar between two bays: a heavy bar, two plates and a pin. */
  function drawCoupling(ctx, y, hw, wall) {
    var dep = depOf('hopper');
    var g = ADV_BAY_GAP * (0.7 + 0.3 * dep);
    ctx.fillStyle = '#39414b';
    roundRect(ctx, -9, y - 2, 18, g + 4, 3);
    ctx.fill();
    ctx.strokeStyle = '#14171b';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    // side plates, so the bays read as coupled rather than merely adjacent
    ctx.fillStyle = '#4b535d';
    for (var s = -1; s <= 1; s += 2) {
      roundRect(ctx, s * (hw * 0.62) - 4, y, 8, g + 2, 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = '#9aa4b0';
    ctx.beginPath();
    ctx.arc(0, y + g * 0.5, 3, 0, TAU);
    ctx.fill();
  }

  /**
   * THE INTAKE. Where the magnet puts the ore: a funnel on the deck feeding the
   * front bay, with coil bars across its mouth that pulse as material comes in.
   * This is what the collector ARMS used to be, and it is deliberately flush
   * with the hull — the old arms were the widest thing on the machine and they
   * read as antennae, which is not what a cargo upgrade should look like.
   */
  function drawIntake(ctx, bw, bl) {
    var T = cargoFlag();
    var mg = parts.magnetArms > 0 ? parts.magnetArms : T;
    var dep = depOf('magnetArms');
    var y0 = bl * 0.32;
    var y1 = bl * 0.5 + 1;                    // right up to the chassis edge
    var deck = bw * 0.46;
    // A funnel has to CONVERGE or it is a box: the mouth grows with the tier but
    // is always narrower than the collecting end.
    var mouth = bedHalf() * 0.56;
    if (mouth > deck * 0.84) mouth = deck * 0.84;
    var lip = 5 + T * 0.5;
    var k, s;

    // chute plates
    bedPath(ctx, y0, y1, deck, mouth, 5);
    ctx.fillStyle = gBedWall;
    ctx.fill();
    ctx.strokeStyle = '#14171b';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // the throat itself, dark and open
    var iF = deck - lip, iR = mouth - lip * 0.4;
    ctx.save();
    bedPath(ctx, y0 + lip * 0.7, y1, iF, iR, 4);
    ctx.fillStyle = '#191d22';
    ctx.fill();
    bedPath(ctx, y0 + lip * 0.7, y1, iF, iR, 4);
    ctx.clip();

    // A powered feeder belt once the CARGO tier includes one.
    if (parts.conveyor > 0) {
      ctx.fillStyle = gBelt;
      ctx.fillRect(-iR, y0, iR * 2, y1 - y0);
      var pitch = 15;
      var off = (beltPhase * pitch) % pitch;
      ctx.strokeStyle = 'rgba(255,196,64,0.50)';
      ctx.lineWidth = 3;
      for (var cy = y0 - pitch; cy < y1 + pitch; cy += pitch) {
        var yy = cy + off;
        ctx.beginPath();
        ctx.moveTo(-iF + 3, yy - 6);
        ctx.lineTo(0, yy);
        ctx.lineTo(iF - 3, yy - 6);
        ctx.stroke();
      }
    }

    /* Magnet coils across the throat. Deliberately THIN and mostly dark iron
     * with a lit core: a solid block of cyan slats read as a radiator grille,
     * and the machine already has a cyan language (the collector rings) that
     * this only needs to echo. One more coil per magnet flag, capped at four. */
    var bars = 1 + (mg > 3 ? 3 : mg);
    var glowBase = 0.16 + hopperPulse * 0.42;
    for (k = 0; k < bars; k++) {
      var t = (k + 0.5) / bars;
      var by = y0 + lip * 0.7 + (y1 - y0 - lip * 0.7) * t;
      var bx = iF + (iR - iF) * t;
      var pulse = 0.5 + 0.5 * Math.sin(armPhase * 2.6 - k * 0.9);
      ctx.fillStyle = '#333b45';
      roundRect(ctx, -bx, by - 2.4, bx * 2, 4.8, 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(130,225,255,' +
                      ((glowBase + pulse * 0.24) * dep).toFixed(3) + ')';
      roundRect(ctx, -bx + 3, by - 0.9, (bx - 3) * 2, 1.9, 1);
      ctx.fill();
    }
    ctx.restore();

    // The gulp, at the mouth: material arriving is a flash where it goes in.
    if (hopperPulse > 0.02) {
      ctx.fillStyle = 'rgba(255,206,110,' + (hopperPulse * 0.45).toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse ? ctx.ellipse(0, y1 - 3, iR * 0.85, 7 + hopperPulse * 6, 0, 0, TAU)
                  : ctx.arc(0, y1 - 3, iR * 0.6, 0, TAU);
      ctx.fill();
    }

    // pole shoes: short blocks on the chute shoulders, flush with the hull
    ctx.fillStyle = '#4b535d';
    for (s = -1; s <= 1; s += 2) {
      roundRect(ctx, s * deck - (s > 0 ? 7 : 0), y0 + 2, 7, 12 + T, 2);
      ctx.fill();
      ctx.strokeStyle = '#14171b';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  /** Headlamp pods on the nose. One pair per lamps level, brightest outboard. */
  function drawLamps(ctx, bw, bl) {
    var dep = depOf('lamps');
    var noseY = -bl * 0.5 + 4;
    var n = parts.lamps;
    for (var i = 0; i < n; i++) {
      var pod = 7 - i;
      var px = bw * (0.20 + i * 0.14);
      var sc = (i === n - 1) ? dep : 1;
      if (sc < 0.05) continue;
      for (var s = -1; s <= 1; s += 2) {
        var lx = s * px;
        // housing
        ctx.fillStyle = '#2b3138';
        roundRect(ctx, lx - pod, noseY - 9 * sc, pod * 2, 11 * sc, 3);
        ctx.fill();
        // lens
        ctx.fillStyle = 'rgba(255,246,205,0.95)';
        ctx.beginPath();
        ctx.arc(lx, noseY - 6 * sc, (pod - 1.5) * sc, 0, TAU);
        ctx.fill();
        // spill, forward only — the real beam is the darkness composite's job
        ctx.fillStyle = 'rgba(255,240,190,0.10)';
        ctx.beginPath();
        ctx.moveTo(lx, noseY - 6 * sc);
        ctx.lineTo(lx - 22 * sc, noseY - 70 * sc);
        ctx.lineTo(lx + 22 * sc, noseY - 70 * sc);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  /**
   * Cooling fins down the flanks. They glow with SM.adv.getHeatPct(), so the
   * machine itself reports the pressure the HUD is also showing — at the cap
   * the rig is visibly cherry-red before the player has read a gauge.
   */
  function drawRadiators(ctx, bw, bl) {
    var dep = depOf('radiators');
    var heat = (SM.adv && SM.adv.getHeatPct) ? SM.adv.getHeatPct() : 0;
    if (heat < 0) heat = 0; else if (heat > 1) heat = 1;
    var hh = hullHalf();
    var n = 3 + parts.radiators;
    var finW = (10 + parts.radiators * 2) * dep;
    if (finW < 1) return;

    for (var s = -1; s <= 1; s += 2) {
      for (var i = 0; i < n; i++) {
        var fy = -bl * 0.18 + i * 15;
        ctx.fillStyle = '#39414b';
        roundRect(ctx, s > 0 ? hh - 2 : -hh - finW + 2, fy, finW, 10, 2);
        ctx.fill();
        if (heat > 0.02) {
          ctx.fillStyle = 'rgba(255,' + ((150 - heat * 110) | 0) + ',40,' +
                          (heat * 0.55).toFixed(3) + ')';
          roundRect(ctx, s > 0 ? hh - 2 : -hh - finW + 2, fy + 2, finW, 6, 2);
          ctx.fill();
        }
      }
    }
    if (heat > 0.55) {
      // Heat shimmer off the fins once cooling is losing.
      var a = (heat - 0.55) * 0.5;
      ctx.fillStyle = 'rgba(255,120,50,' + a.toFixed(3) + ')';
      for (var q = -1; q <= 1; q += 2) {
        ctx.beginPath();
        ctx.arc(q * (hh + finW * 0.5), -bl * 0.05 + Math.sin(lightPhase * 6 + q) * 6,
                12 + heat * 8, 0, TAU);
        ctx.fill();
      }
    }
  }

  /**
   * The scanner dish, on the cabin roof. Sweeps in time with the instrument when
   * one is fitted, so a bought scanner is visible on the machine and its cycle
   * is legible from the world view rather than only from the HUD.
   */
  function drawDish(ctx, bw, bl) {
    var dep = depOf('dish');
    var r = (9 + parts.dish * 2.5) * dep;
    if (r < 1) return;
    var cy = -bl * 0.06;
    var a = armPhase * (0.7 + parts.dish * 0.25);

    // mast
    ctx.strokeStyle = '#39414b';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, cy + 10); ctx.lineTo(0, cy);
    ctx.stroke();
    // dish, foreshortened as it turns — cheaper and clearer than a real ellipse
    var w = r * (0.35 + 0.65 * Math.abs(Math.cos(a)));
    ctx.fillStyle = '#8e99a6';
    ctx.beginPath();
    ctx.ellipse ? ctx.ellipse(0, cy, w, r, 0, 0, TAU)
                : ctx.arc(0, cy, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#20252b';
    ctx.lineWidth = 2;
    ctx.stroke();
    // return pulse: brightens on the sweep, and only while actually enabled
    var live = !!(SM.scanner && SM.scanner.isEnabled && SM.scanner.isEnabled());
    if (live) {
      var g = 0.35 + 0.45 * Math.abs(Math.sin(a * 2));
      ctx.fillStyle = 'rgba(120,255,210,' + g.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(0, cy, r * 0.30, 0, TAU);
      ctx.fill();
    }
  }

  /** Bolted-on hull plating. Thicker outline, visible rivets, chipped corners. */
  function drawArmor(ctx, bw, bl) {
    var dep = depOf('armor');
    var t = (3 + parts.armor * 2) * dep;
    if (t < 1) return;
    var integ = (SM.adv && SM.adv.getIntegrity) ? SM.adv.getIntegrity() : 1;

    ctx.strokeStyle = '#6f7a86';
    ctx.lineWidth = t;
    roundRect(ctx, -bw * 0.5 - t * 0.5, -bl * 0.5 - t * 0.5, bw + t, bl + t, 11);
    ctx.stroke();
    // rivets
    ctx.fillStyle = '#98a3af';
    for (var ry = -bl * 0.5 + 10; ry < bl * 0.5; ry += 26) {
      for (var s = -1; s <= 1; s += 2) {
        ctx.beginPath();
        ctx.arc(s * (bw * 0.5 + t * 0.2), ry, 2.2, 0, TAU);
        ctx.fill();
      }
    }
    // Damage reads as scorching on the plate, so a battered rig LOOKS battered.
    if (integ < 0.85) {
      ctx.fillStyle = 'rgba(20,14,12,' + ((0.85 - integ) * 0.7).toFixed(3) + ')';
      roundRect(ctx, -bw * 0.5, -bl * 0.5, bw, bl, 10);
      ctx.fill();
    }
  }

  /* --- exhaust stacks + smoke ------------------------------------------------ */
  function drawExhaust(ctx, bw, bl) {
    var n = 1 + parts.stacks;                 // per side
    var dep = depOf('stacks');
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

  /**
   * y of the cutting edge. In adventure mode the cutter is wherever the machine
   * happens to be pointing, so this returns the BIT's world y — which is the
   * honest analogue and keeps terrain streaming, dust and camera code that has
   * always asked "where is the front" answering correctly in both modes.
   */
  function getBladeFrontY() {
    if (advMode()) return y - Math.cos(heading) * drillReach();
    return y - C.VEHICLE_BODY_LENGTH * 0.5 - BLADE_ARM - bladeThick() * 0.5;
  }
  function getDrillX() {
    if (!advMode()) return x;
    return x + Math.sin(heading) * drillReach();
  }
  function getDrillY() { return getBladeFrontY(); }

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
    isHalted: function () { return halted; },

    /* --- ADVENTURE (Agent 1) ------------------------------------------
     * getHeading()      hull facing in radians; 0 = -y, the classic forward
     * getDrillX/Y()     world position of the bit — the light and the dust
     *                   both want it, and it is not derivable from x/y alone
     * getVelX/getVelY() the real 2D velocity, for a camera that has to lead in
     *                   a direction the player chose
     * isStalled()       the drill is against rock above its hardness cap
     * isCutting()       the bit removed hardness this step (adv.js's heat model
     *                   asks, because heatGainRate() takes a `drilling` flag)
     * getBlockedMat()   ...and this is what it is, or -1
     * getDriveBurnRate()fuel/sec the drive and drill are currently costing;
     *                   adv.js's reserve estimate needs it
     * getLoad()         seconds of work between the bit and open ground — the
     *                   readable version of "how hard is this rock for ME"
     * parkAtStation()   put the machine in the cage of SM.adv's current lift
     *                   station, stopped. Adventure only; a no-op (false) in
     *                   classic. SM.adv.rideTo() is the caller.
     * renderPreview()   draw the current build into a garage transform
     * ---------------------------------------------------------------- */
    getHeading: function () { return heading; },
    getDrillX: getDrillX,
    getDrillY: getDrillY,
    getVelX: function () { return dvx; },
    getVelY: function () { return dvy; },
    isStalled: function () { return stalled; },
    isCutting: function () { return cutting; },
    getBlockedMat: function () { return blockedMat; },
    getDriveBurnRate: function () { return driveBurn; },
    /** Seconds of drilling standing between the bit and open ground. */
    getLoad: function () { return advLoad; },
    /** 1 = drilling pace, up to ADV_TRAVEL_MUL in clear air. Fuel/metre is
     *  unchanged either way — see the ADV_TRAVEL_* note. */
    getTravelGear: function () { return advTravel; },
    parkAtStation: parkAtStation,
    renderPreview: renderPreview,

    /* --- speed boost (scattered 'boostcell' blocks) -------------------- */
    addBoost: addBoost,
    getBoost: function () { return boostLevel; },
    getBoostLeft: function () { return boostRemaining; },
    isBoostActive: function () { return boostActive; },
    // Run totals for the end card, in the units the player experiences.
    getBoostBlocks: function () { return boostBlocks; },
    getBoostSeconds: function () { return boostSeconds; }
  };
})();
