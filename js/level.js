/* =============================================================================
 * SUPERMINE — js/level.js                          [OWNER: Agent 2 — gameplay]
 * -----------------------------------------------------------------------------
 * THE RUN DIRECTOR. Owns four things:
 *
 *   1. THE COUNTDOWN — SUPERMINE is a TIME ATTACK. A clock runs from the first
 *      gesture to zero; when it expires the machine halts and whatever is in
 *      the hopper is the score. Some gates pay +10 SECONDS instead of an
 *      upgrade, which is the central tension of the whole game: more time in
 *      the mine, or a machine that digs faster while you are down there.
 *   2. THE SECTION MAP — an ordered list of zones with the generation knobs
 *      terrain.js reads through SM.level.zoneAt(depth): easy opening ->
 *      resource lanes -> granite barriers -> narrow passages -> crystal
 *      caverns -> the final core.
 *   3. THE GATE PLAN — where every paired route gate and upgrade station sits.
 *      Gates must exist BEFORE terrain generates their band, which is why
 *      main.js calls level.init() before terrain.init().
 *   4. THRESHOLD TRANSFORMS — "you have banked N -> the machine grows",
 *      applied with no gate and no interruption.
 *
 * Public API
 *   SM.level.init() / update(dt) / reset()
 *   SM.level.getProgress()   0..1 over the whole run
 *   SM.level.getDistance()   world units travelled
 *   SM.level.isComplete()    reached 100% — a MILESTONE, not an ending; the
 *                            run continues into the core until the clock stops
 *   SM.level.getOvertime()   world units dug past the end of the map, else 0
 * Phase-2 additions (terrain.js and presentation may use these):
 *   SM.level.getZones() zoneAt(depth) getZone() getZoneIndex()
 *   SM.level.getZoneProgress() getCollected() getLength()
 * Time-attack additions (the HUD is built against exactly these):
 *   SM.level.getTimeLeft()   seconds remaining, always >= 0
 *   SM.level.getTimeStart()  seconds the run begins with
 *   SM.level.getTimeCap()    ceiling the clock can ever hold (bar scaling)
 *   SM.level.getTimeBonus()  seconds one +time gate is worth
 *   SM.level.isRunOver()
 *   SM.level.addTime(seconds [, source])  -> true if it was banked
 *   SM.level.getCellBlocks() getCellSeconds()   run totals for TIME CELLS, in
 *                            blocks and seconds — the units the player
 *                            experiences, not the fragment count
 *
 * Events emitted
 *   level:started    null
 *   level:complete   {distance}       100% reached. A MILESTONE — the run does
 *                                     NOT end here, it carries on into the
 *                                     core. Fires exactly once per run.
 *   zone:entered     {name, kind}     kind: opening|rich|barrier|narrow|final
 *   time:granted     {seconds, left, source}   seconds went on the clock.
 *                                     source: 'gate' (a +10 SECONDS arch, the
 *                                     default) | 'cell' (a shattered time-cell
 *                                     block, flushed as one grant). The two
 *                                     get different HUD treatment; see addTime.
 *   time:low         {left}           ONCE per run, first drop below LOW_TIME
 *   run:over         {reason, distance, timeLeft}   emitted EXACTLY ONCE per
 *                                     run. `reason` is always 'time' now that
 *                                     the clock is the only exit; the field is
 *                                     kept because handlers branch on it.
 * ========================================================================== */

var SM = SM || {};

SM.level = (function () {
  'use strict';

  var C = SM.config;

  /* ----- Agent-2 tunables ---------------------------------------------
   * TIME_START is the whole design budget. 60s is short enough that the very
   * first paired gate is already a real decision (you can feel the clock),
   * and long enough to reach the first barrier without any bonuses at all.
   * TIME_CAP exists so hoarding time has a ceiling: a player who takes every
   * single +10 SECONDS gate cannot bank an unbounded reserve and simply
   * out-wait the level. It also gives the HUD a fixed denominator for a bar.
   * LOW_TIME is the panic threshold — one warning, once, near the end.
   * ------------------------------------------------------------------ */
  var TIME_START = 60;           // seconds the run begins with
  var TIME_CAP = 120;            // clock ceiling; 2x start = "one full refill"
  var TIME_BONUS = 10;           // paid by a `time_10` gate
                                 // (mirrored by TIME_REWARDS in upgrades.js)
  var LOW_TIME = 10;             // seconds left when `time:low` fires

  /* --- scattered time cells (terrain 'timecell' blocks) -----------------
   * These pay PER COLLECTED FRAGMENT. terrain.js seeds a block as a 40-unit
   * hard-edged disc, which fills with 15 deposits (measured over five blocks:
   * 13-18, mean 15.4), and materials.js breaks each into 5 fragments: ~77
   * fragments for a whole block. At 0.070 that is FIVE SECONDS for taking one
   * cleanly, which is the number the HUD splash announces, so it had better be
   * the honest typical result rather than a lucky one — hence the fixed block
   * radius over in terrain.js and the low-drag, high-backBias `prize` break
   * style in materials.js, which was measured collecting every single fragment
   * of five separate blocks (65/65, 80/80, 70/70, 65/65, 55/55).
   *
   * 0.070 rather than the 0.066 the mean deposit count alone would suggest,
   * because the displayed number is ROUNDED: it puts the whole 13-16 deposit
   * band on "+5 SEC" instead of splitting it between +4 and +5, so the figure
   * the player learns to expect is the figure they usually see. Only a block
   * that rolled unusually large reads +6, and only a real clip reads less.
   *
   * Per FRAGMENT, not per block, because that is the whole skill in them:
   * clipping the edge of a block at speed breaks a third of it and leaves half
   * of that behind, and the splash reports the smaller number it actually paid.
   *
   * The grants are ACCUMULATED and flushed on a short timer instead of being
   * emitted per fragment: seventy separate "+0.07s" pops would read as a
   * stutter where one "+5s" reads as a pickup. The flush window is a
   * gap-in-the-stream detector, not a fixed delay — every fragment restarts
   * it — so it has to be longer than the interval between two arrivals of one
   * cloud (measured ~0.1s) and short enough that the reward still feels like
   * it belongs to the thing you just hit.
   * ------------------------------------------------------------------ */
  var TIME_PER_PIECE = 0.070;    // seconds per collected time-cell fragment
  var TIME_FLUSH = 0.22;         // seconds to wait for the rest of the cloud

  /* ----- RUN MODES ------------------------------------------------------
   *   'time'      the default. A countdown, and the haul when it hits zero.
   *   'freestyle' no clock at all, no ending. Dig until you have had enough.
   *
   * Freestyle is NOT merely "the countdown switched off". Half the design
   * hangs off the clock, so everything that pays in SECONDS becomes dead
   * weight the moment there is no clock to pay into:
   *   - every paired gate offers an upgrade against +10 SECONDS, which in
   *     freestyle would be a choice between something and nothing.
   *     placeGates() substitutes a real upgrade on the time side.
   *   - terrain.js stops seeding time cells and seeds only boost blocks.
   * The mode SURVIVES reset(), so RESTART re-runs the mode you chose instead
   * of dropping you back at the menu between attempts.
   * ------------------------------------------------------------------ */
  var MODE_TIME = 'time';
  var MODE_FREESTYLE = 'freestyle';
  var mode = MODE_TIME;

  // Rotated through wherever a `time_10` gate would have stood. Deliberately
  // the cheaper utility upgrades — freestyle already has unlimited runway, so
  // handing out the big multipliers here too would flatten it.
  var FREESTYLE_SUBS = ['magnet', 'speed_up', 'rear_conveyor', 'side_grinders',
                        'drill_heads', 'wider_blade'];

  /* =====================================================================
   * THE SECTION MAP
   * ---------------------------------------------------------------------
   * Fields consumed by terrain.js:
   *   kind       opening | rich | barrier | narrow | final  (drives structure)
   *   len        length of the section in world units
   *   stoneW     0..1 fraction of BASE rock that is stone (remainder dirt)
   *   graniteW   0..1 fraction of BASE rock that is granite (taken first)
   *   baseOres   optional weighted list that REPLACES the dirt/stone base
   *   pocketRate expected ore pockets per generation band
   *   ores       weighted [[materialId, weight], ...] for pockets
   *   bigChance  0..1 chance a pocket is a huge formation
   *   voidChance 0..1 chance a pocket is an empty cavern instead
   *   rubble     0..1 chance an empty cell is backfilled with loose rubble
   *   veins      number of long vertical ore lanes (route-choice read)
   *   veinOre    material of those lanes
   *   veinWidth  half-width of a lane in world units
   *   wallMat    optional material for barrier slabs / corridor walls
   *              (default 'granite')
   *   corridorHalf/Wave/Drift  ('narrow' only) passage geometry
   *
   * >>> LENGTHS ARE TIME-ATTACK SCALED (~0.68x the original 3.5-minute map).
   * The measured Phase-1 run covered 49 600 units in 282 seconds — an average
   * of ~176 units/sec once barriers, corridors and resistance are paid for.
   * A time attack tops out around 140 seconds of driving, so the old map put
   * everything past GEM HOLLOWS permanently out of reach. Rescaled, the whole
   * 33 500-unit map reads like this:
   *
   *   60s, no bonuses (10-13.5k u)   SURFACE CUT -> GEM HOLLOWS     5-6 zones
   *   ~100s, some bonuses (18-22k)   into CRYSTAL CAVERNS           8 zones
   *   ~130s+, a great run (26-33.5k) THE CORE, and 100% is possible all 11
   *
   * Only `len` changed. The generation knobs are untouched, so every zone
   * still reads with exactly the character it was tuned for — the run is
   * denser, not different. <<<
   * ================================================================== */
  var ZONES = [
    {
      name: 'SURFACE CUT', kind: 'opening', len: 1800,
      stoneW: 0.12, graniteW: 0, pocketRate: 0.75,
      ores: [['iron', 5], ['gold', 2]],
      bigChance: 0, voidChance: 0.14, rubble: 0.10,
      veins: 0, veinOre: 'iron', veinWidth: 0
    },
    {
      name: 'IRON LANES', kind: 'rich', len: 2900,
      stoneW: 0.34, graniteW: 0, pocketRate: 1.15,
      ores: [['iron', 6], ['gold', 3], ['stone', 2]],
      bigChance: 0.05, voidChance: 0.10, rubble: 0.12,
      veins: 2, veinOre: 'iron', veinWidth: 78
    },
    {
      name: 'THE GRANITE WALL', kind: 'barrier', len: 2100,
      stoneW: 0.58, graniteW: 0.22, pocketRate: 0.85,
      ores: [['gold', 4], ['iron', 3], ['gem', 2]],
      bigChance: 0.06, voidChance: 0.08, rubble: 0.18,
      veins: 0, veinOre: 'gold', veinWidth: 0
    },
    {
      name: 'GOLDFIELDS', kind: 'rich', len: 3100,
      stoneW: 0.40, graniteW: 0, pocketRate: 1.45,
      ores: [['gold', 7], ['iron', 3], ['gem', 3]],
      bigChance: 0.14, voidChance: 0.10, rubble: 0.12,
      veins: 2, veinOre: 'gold', veinWidth: 88
    },
    {
      name: 'THE THROAT', kind: 'narrow', len: 1700,
      stoneW: 0.55, graniteW: 0.30, pocketRate: 0.6,
      ores: [['gem', 4], ['gold', 3], ['crystal', 2]],
      bigChance: 0.05, voidChance: 0.05, rubble: 0.30,
      veins: 0, veinOre: 'gem', veinWidth: 0,
      // corridorHalf + corridorWave + 1.32*corridorDrift must stay under
      // LANE_HALF_WIDTH or the passage opens straight into the bedrock wall.
      corridorHalf: 300, corridorWave: 70, corridorDrift: 190
    },
    {
      name: 'GEM HOLLOWS', kind: 'rich', len: 3300,
      stoneW: 0.42, graniteW: 0.05, pocketRate: 1.55,
      ores: [['gem', 6], ['gold', 3], ['crystal', 3], ['iron', 2]],
      bigChance: 0.18, voidChance: 0.18, rubble: 0.14,
      veins: 2, veinOre: 'gem', veinWidth: 84
    },
    {
      name: 'DEEP BARRIER', kind: 'barrier', len: 2300,
      stoneW: 0.50, graniteW: 0.34, pocketRate: 0.95,
      ores: [['crystal', 4], ['gem', 3], ['rare', 1]],
      bigChance: 0.10, voidChance: 0.07, rubble: 0.20,
      veins: 0, veinOre: 'crystal', veinWidth: 0,
      // Obsidian is 3x granite hardness: by this depth the rig is strong
      // enough that granite alone would no longer register as a barrier.
      wallMat: 'obsidian'
    },
    {
      name: 'CRYSTAL CAVERNS', kind: 'rich', len: 3900,
      stoneW: 0.35, graniteW: 0.04, pocketRate: 1.75,
      ores: [['crystal', 8], ['gem', 4], ['rare', 2], ['gold', 2]],
      bigChance: 0.34, voidChance: 0.18, rubble: 0.16,
      veins: 1, veinOre: 'crystal', veinWidth: 100
    },
    {
      name: 'PRESSURE LOCK', kind: 'narrow', len: 1600,
      stoneW: 0.45, graniteW: 0.40, pocketRate: 0.7,
      ores: [['crystal', 4], ['rare', 2], ['gem', 2]],
      bigChance: 0.06, voidChance: 0.04, rubble: 0.34,
      veins: 0, veinOre: 'crystal', veinWidth: 0,
      corridorHalf: 270, corridorWave: 66, corridorDrift: 200,
      wallMat: 'obsidian'
    },
    {
      name: 'THE MOTHERLODE', kind: 'rich', len: 4400,
      stoneW: 0.28, graniteW: 0.03, pocketRate: 2.0,
      ores: [['crystal', 6], ['gem', 5], ['gold', 5], ['rare', 4]],
      bigChance: 0.30, voidChance: 0.09, rubble: 0.12,
      veins: 3, veinOre: 'rare', veinWidth: 74
    },
    {
      // THE FINAL SPECTACLE. No dirt at all: the base rock IS treasure, and
      // starcore formations are stacked on top of it. A maxed machine deletes
      // a wall of this per second.
      name: 'THE CORE', kind: 'final', len: 6400,
      stoneW: 0, graniteW: 0, pocketRate: 2.4,
      baseOres: [['gold', 3], ['gem', 3], ['crystal', 4], ['rare', 2]],
      ores: [['starcore', 6], ['rare', 6], ['crystal', 5], ['gem', 3]],
      bigChance: 0.45, voidChance: 0.04, rubble: 0.0,
      veins: 2, veinOre: 'starcore', veinWidth: 120
    }
  ];

  /* =====================================================================
   * THE GATE PLAN  —  a time attack is a chain of decisions
   * ---------------------------------------------------------------------
   * pair    -> two arches at the same depth. ONE SIDE IS ALWAYS `time_10`
   *            (+10 SECONDS), the other is a machine upgrade. That is the
   *            whole game: buy time in the mine, or buy the machine that
   *            makes the time you already have worth more.
   * station -> full-lane gantry, cannot be missed. Stations are UPGRADES
   *            ONLY — they are the guaranteed power curve, so a player who
   *            takes time at every single pair still ends up with a machine
   *            and a run that never stalls out.
   *
   * SPACING / PACING
   *   Pairs sit 2 100-3 600 units apart inside a region, and up to ~5 000
   *   when a granite barrier sits between two of them. At the realistic
   *   175-280 units/sec of a mid run that is a decision every 9-20 seconds.
   *   That is THE number to get right: +10 SECONDS must cost roughly the
   *   time it takes to reach the NEXT +10 SECONDS, or the clock either
   *   collapses (decisions stop mattering) or turns into a perpetual-motion
   *   machine — a greedy player banking time faster than they spend it, and
   *   a run that never ends. At this spacing pure greed is break-even at
   *   best, and the punishment compounds: skipping every upgrade leaves the
   *   rig crawling at the VEHICLE_MIN_SPEED_FACTOR floor through THE GRANITE
   *   WALL and THE THROAT, so the next gate takes twice as long to reach.
   *   A station is dropped BETWEEN pairs, so *some* gate arrives every
   *   900-1 400 units (roughly 5 seconds) and the run never feels empty.
   *
   * WHICH SIDE CARRIES THE TIME
   *   R L R L L R R L R R L — deliberately NOT alternating. If time were
   *   always on one side, or strictly alternating, it would be memorised
   *   after two runs and the arch would stop being read. You have to look.
   *
   * SAFETY RULE (unchanged): distances stay OUTSIDE every barrier and narrow
   * section. GATE_CARVE_DEPTH is 140, so a gate carves +-70 units of y; punch
   * that through a granite slab or a corridor wall and the structure that the
   * whole zone exists for gets a free door in it. Every entry below keeps at
   * least ~200 units of clearance from a structural zone boundary.
   * ================================================================== */
  var GATE_PLAN = [
    /* zone boundaries: 1800 | 4700 | 6800 | 9900 | 11600 | 14900 | 17200 |
     *                  21100 | 22700 | 27100 | 33500
     * NO-GATE spans (barrier / narrow):
     *   4700-6800   THE GRANITE WALL      9900-11600  THE THROAT
     *   14900-17200 DEEP BARRIER         21100-22700  PRESSURE LOCK       */

    /* --- SURFACE CUT + IRON LANES  (0-4700) --------------------------- *
     * The first pair lands at 900, about 5 seconds in. Teaching the choice
     * before the player has any upgrades at all is the point: with 60s on
     * the clock and nothing on the rig, both sides are genuinely tempting. */
    { at: 900,   kind: 'pair',    left: 'wider_blade',   right: 'time_10' },
    { at: 2000,  kind: 'station', up: 'speed_up' },
    { at: 3100,  kind: 'pair',    left: 'time_10',       right: 'drill_heads' },
    // Power before the granite: a rig that skipped every upgrade so far still
    // gets REINFORCED CUTTERS handed to it right before the wall.
    { at: 4200,  kind: 'station', up: 'mining_power' },

    /* --- GOLDFIELDS  (6800-9900) -------------------------------------- */
    { at: 7200,  kind: 'station', up: 'magnet' },
    { at: 8400,  kind: 'pair',    left: 'multiplier',    right: 'time_10' },
    // Pulse on a STATION as well as on pair gates, so even a player who never
    // steers still owns the explosive toy before THE THROAT.
    { at: 9500,  kind: 'station', up: 'explosive_pulse' },

    /* --- GEM HOLLOWS  (11600-14900) ----------------------------------- *
     * Two pairs back to back either side of a station: this is where a run
     * commits to being a "long run" or a "strong run". */
    { at: 12000, kind: 'pair',    left: 'time_10',       right: 'side_grinders' },
    { at: 13200, kind: 'station', up: 'wider_blade' },
    { at: 14400, kind: 'pair',    left: 'time_10',       right: 'rear_conveyor' },

    /* --- CRYSTAL CAVERNS  (17200-21100) ------------------------------- */
    { at: 17500, kind: 'station', up: 'mining_power' },
    { at: 18600, kind: 'pair',    left: 'magnet',        right: 'time_10' },
    { at: 19800, kind: 'station', up: 'multiplier' },
    { at: 20700, kind: 'pair',    left: 'overdrive',     right: 'time_10' },

    /* --- THE MOTHERLODE  (22700-27100) -------------------------------- *
     * Only reachable past ~110 seconds of driving. The final overhaul sits
     * just before the core so anyone who gets this far arrives armed. */
    { at: 23100, kind: 'station', up: 'side_grinders' },
    { at: 24300, kind: 'pair',    left: 'time_10',       right: 'explosive_pulse' },
    { at: 25600, kind: 'station', up: 'speed_up' },
    { at: 26500, kind: 'station', up: 'final_overhaul' },

    /* --- THE CORE  (27100+) ------------------------------------------- *
     * Kept fully populated even though almost nobody sees it: an excellent
     * run must never out-drive the plan and coast through empty world. */
    { at: 27900, kind: 'pair',    left: 'drill_heads',   right: 'time_10' },
    { at: 29200, kind: 'station', up: 'wider_blade' },
    { at: 30400, kind: 'pair',    left: 'mining_power',  right: 'time_10' },
    { at: 31700, kind: 'station', up: 'overdrive' },
    { at: 32900, kind: 'pair',    left: 'time_10',       right: 'multiplier' }
  ];

  var PAIR_X = 320;              // lateral offset of each half of a pair
  var PAIR_X_LATE = 250;         // pairs get closer to the centre once the
  var PAIR_LATE_FROM = 12500;    // machine is too wide to swing far sideways
                                 // (~37% into the rescaled map, same fraction
                                 //  of the run as the old 20000-of-49600)

  /* --- automatic threshold transformations ----------------------------
   * Trigger on banked value, so a greedy player transforms sooner. Both are
   * guaranteed by a distance fallback so no run can miss them entirely.
   * The fallbacks are rescaled with the map (7500 -> 5000, 23000 -> 15500)
   * so they sit at the same fraction of the run as before — otherwise a
   * 60-second run would never see either transform.
   * ------------------------------------------------------------------ */
  var AUTO_PLAN = [
    { id: 'auto_hopper', value: 12000,   byDistance: 5000,  done: false },
    { id: 'mega_treads', value: 260000,  byDistance: 15500, done: false }
  ];

  /* ----- state --------------------------------------------------------- */
  var RUN_LENGTH = 0;
  for (var zi = 0; zi < ZONES.length; zi++) {
    ZONES[zi].start = RUN_LENGTH;
    RUN_LENGTH += ZONES[zi].len;
    ZONES[zi].end = RUN_LENGTH;
    ZONES[zi].index = zi;
    ZONES[zi].seed = 1013 + zi * 7919;
  }

  var distance = 0;
  var progress = 0;
  var complete = false;
  var collected = 0;
  var zoneIndex = -1;

  /* --- the clock ------------------------------------------------------ */
  var timeLeft = TIME_START;
  var runOver = false;
  var lowFired = false;          // `time:low` is once per run, not once per dip

  var evComplete = { distance: 0 };
  var evZone = { name: '', kind: '' };
  // Reused like evZone / evGate: emitted several times a run, never stashed.
  var evTimeGranted = { seconds: 0, left: 0, source: '' };
  var MI_TIME = -1;              // 'timecell' material index, resolved in init()
  var pendingTime = 0;           // accumulated grants awaiting a flush
  var timeFlush = 0;             // countdown to that flush
  // Run totals for the end card. Counted in BLOCKS and SECONDS, never in
  // fragments: a time cell is a discrete object you aimed at and hit maybe
  // eight times in a run, so the summary reporting the ~400 collected chips
  // told the player they picked up four hundred of something. Seconds are
  // what they were actually buying, and one flush is exactly one block.
  var cellBlocks = 0;
  var cellSeconds = 0;
  var evTimeLow = { left: 0 };
  var evRunOver = { reason: '', distance: 0, timeLeft: 0 };

  /* --- pause ------------------------------------------------------------
   * main.js pins its step accumulator while paused, so update() is not being
   * called at all and the clock could not tick if it wanted to. This flag is
   * a SECOND LINE OF DEFENCE on the one number nobody may ever farm: the
   * countdown IS the score in a time attack, so "pause is free seconds" is
   * the single worst bug this feature could ship with. Cost is one boolean
   * test per step, which is worth it to make the guarantee local to the file
   * that owns the clock instead of an assumption about someone else's loop.
   * ------------------------------------------------------------------ */
  var paused = false;

  /* ------------------------------------------------------------------ */

  function init() {
    SM.events.on('resource:collected', onCollected);
    SM.events.on('game:paused', function (p) { paused = !!(p && p.paused); });
    MI_TIME = SM.materials ? SM.materials.indexOf('timecell') : -1;
    reset();
  }

  /** HOT: fires up to ~30x per step. O(1), no allocation, no strings. */
  function onCollected(p) {
    collected += p.value * SM.vehicle.getValueMultiplier();
    // Time cells are worth 0 currency; their whole payload is the clock.
    if (p.matIndex === MI_TIME && !runOver) {
      pendingTime += TIME_PER_PIECE;
      timeFlush = TIME_FLUSH;
    }
  }

  /** Emit one 'time:granted' for a whole block, once its cloud has landed. */
  function flushPendingTime() {
    var secs = pendingTime;
    pendingTime = 0;
    timeFlush = 0;
    if (secs <= 0) return;
    if (addTime(secs, 'cell')) {
      cellBlocks++;
      cellSeconds += secs;
    }
  }

  /** In freestyle a `time_10` reward is worthless — hand out an upgrade. */
  function rewardFor(upgradeId, subIndex) {
    if (mode !== MODE_FREESTYLE || upgradeId !== 'time_10') return upgradeId;
    return FREESTYLE_SUBS[subIndex % FREESTYLE_SUBS.length];
  }

  function placeGates() {
    SM.upgrades.clearGates();
    var sub = 0;
    for (var i = 0; i < GATE_PLAN.length; i++) {
      var g = GATE_PLAN[i];
      var y = C.START_Y - g.at;
      if (g.kind === 'station') {
        SM.upgrades.addGate({
          id: 'st_' + g.at,
          upgradeId: g.up,
          kind: 'station',
          x: 0,
          y: y
        });
      } else {
        var off = g.at >= PAIR_LATE_FROM ? PAIR_X_LATE : PAIR_X;
        var pid = 'pair_' + g.at;
        var left = rewardFor(g.left, sub);
        if (left !== g.left) sub++;
        var right = rewardFor(g.right, sub);
        if (right !== g.right) sub++;
        SM.upgrades.addGate({
          id: pid + '_L', upgradeId: left, pairId: pid, tone: 'safe',
          x: -off, y: y
        });
        SM.upgrades.addGate({
          id: pid + '_R', upgradeId: right, pairId: pid, tone: 'risk',
          x: off, y: y
        });
      }
    }
  }

  function reset() {
    distance = 0;
    progress = 0;
    complete = false;
    collected = 0;
    zoneIndex = -1;
    timeLeft = TIME_START;
    runOver = false;
    pendingTime = 0;
    timeFlush = 0;
    cellBlocks = 0;
    cellSeconds = 0;
    lowFired = false;
    for (var i = 0; i < AUTO_PLAN.length; i++) AUTO_PLAN[i].done = false;

    placeGates();
    SM.events.emit('level:started', null);
  }

  /* =====================================================================
   * THE CLOCK
   * ================================================================== */

  /**
   * Bank seconds. Clamped to TIME_CAP so hoarding has a ceiling, and refused
   * once the run is over — upgrades.update() runs AFTER level.update(), so the
   * halting machine can still coast across a gate on the very step the clock
   * expired, and that must not resurrect it.
   *
   * @param source  where the seconds came from, and therefore how the HUD is
   *                allowed to announce them. 'gate' (the default, so the
   *                existing single-argument call in upgrades.js is unchanged)
   *                already owns a whole presentation — arch flash, upgrade
   *                toast, the "+10s" float off the clock — while 'cell' has
   *                nothing but the splash ui.js puts up for it. Presentation
   *                cannot tell them apart from the number alone, so it is
   *                stated here rather than guessed there.
   * @return true if the seconds were actually banked.
   */
  function addTime(seconds, source) {
    if (runOver) return false;
    timeLeft += seconds;
    if (timeLeft > TIME_CAP) timeLeft = TIME_CAP;
    evTimeGranted.seconds = seconds;
    evTimeGranted.left = timeLeft;
    evTimeGranted.source = source || 'gate';
    SM.events.emit('time:granted', evTimeGranted);
    return true;
  }

  /** The single door out of a run. Guarded so `run:over` can only ever
   *  fire once — reset() is the only thing that reopens it. */
  function endRun(reason) {
    if (runOver) return;
    runOver = true;
    if (timeLeft < 0) timeLeft = 0;
    if (SM.vehicle && SM.vehicle.halt) SM.vehicle.halt();
    evRunOver.reason = reason;
    evRunOver.distance = distance;
    evRunOver.timeLeft = timeLeft;
    SM.events.emit('run:over', evRunOver);
  }

  function update(dt) {
    // Frozen wholesale rather than just around the countdown: the pending
    // time-cell flush, the zone fanfares and the auto-transforms are all
    // timers or edge tests too, and none of them should fire at a rig that is
    // standing still behind a menu. Nothing here is derived from anything that
    // moves while paused, so there is nothing to keep up to date either.
    if (paused) return;

    distance = C.START_Y - SM.vehicle.getY();
    if (distance < 0) distance = 0;
    progress = distance / RUN_LENGTH;
    if (progress > 1) progress = 1;

    /* --- zone transitions --------------------------------------------- *
     * Frozen once the run is over: the machine is still coasting to a stop
     * and must not trip a fresh zone fanfare (or an overdrive frenzy) on the
     * way down. terrain.js reads zoneAt(depth) directly, so streaming is
     * unaffected.
     * ------------------------------------------------------------------ */
    if (!runOver) {
      var zi2 = indexAt(distance);
      if (zi2 !== zoneIndex) {
        zoneIndex = zi2;
        var z = ZONES[zi2];
        evZone.name = z.name;
        evZone.kind = z.kind;
        SM.events.emit('zone:entered', evZone);
        // Entering the final zone kicks the machine into a long frenzy — the
        // whole point of the section is to watch it eat the field.
        if (z.kind === 'final') SM.vehicle.startOverdrive(14);
        if (SM.camera) SM.camera.shake(z.kind === 'final' ? 20 : 8);
      }

      /* --- automatic threshold transformations ------------------------- */
      for (var i = 0; i < AUTO_PLAN.length; i++) {
        var a = AUTO_PLAN[i];
        if (a.done) continue;
        if (collected >= a.value || distance >= a.byDistance) {
          a.done = true;
          SM.upgrades.trigger(a.id);
        }
      }
    }

    /* --- banked time-cell fragments ------------------------------------ *
     * Flushed BEFORE the expiry check below, so the last block you scraped
     * together on the final step still counts. */
    if (timeFlush > 0) {
      timeFlush -= dt;
      if (timeFlush <= 0) flushPendingTime();
    }

    /* --- reaching the bottom is a MILESTONE, not an ending -------------- *
     * It used to call endRun('depth'), and that was backwards. THE CORE is
     * where the base rock IS the treasure and the score curve goes vertical,
     * so ending the run at the moment you arrive took the payoff away as a
     * reward for earning it. Now 100% fires `level:complete` — fanfare,
     * banner, camera punch, the gauge flipping to OVERTIME — and the run
     * carries on into the core until the clock runs out.
     *
     * The clock is therefore the ONLY exit. `run:over` still carries a
     * `reason`, and it is now always 'time'; the field stays because the
     * summary card and sound.js both branch on it and a silently-removed
     * field is a worse trap than a field with one value.
     *
     * indexAt() clamps past the end of the map ("stay in the final zone"), so
     * terrain keeps generating core indefinitely, and `progress` is already
     * clamped to 1 — see getOvertime() for what the HUD shows instead.
     * ------------------------------------------------------------------ */
    if (!runOver && !complete && progress >= 1) {
      complete = true;
      evComplete.distance = distance;
      SM.events.emit('level:complete', evComplete);
    }

    /* --- the countdown ------------------------------------------------- *
     * update() runs inside main.js's fixed step, and main.js pins the step
     * accumulator at zero until `input:firstgesture` — so the clock cannot
     * tick behind the start overlay and no extra "armed" flag is needed here.
     * ------------------------------------------------------------------ */
    if (!runOver && mode !== MODE_FREESTYLE) {
      timeLeft -= dt;
      if (!lowFired && timeLeft < LOW_TIME) {
        lowFired = true;
        evTimeLow.left = timeLeft < 0 ? 0 : timeLeft;
        SM.events.emit('time:low', evTimeLow);
      }
      if (timeLeft <= 0) {
        timeLeft = 0;
        endRun('time');
      }
    }
  }

  /* =====================================================================
   * ZONE LOOKUP (terrain.js calls zoneAt() once per generated band)
   * ================================================================== */
  function indexAt(depth) {
    if (depth <= 0) return 0;
    for (var i = 0; i < ZONES.length; i++) {
      if (depth < ZONES[i].end) return i;
    }
    return ZONES.length - 1;      // past the end: stay in the final zone
  }

  function zoneAt(depth) { return ZONES[indexAt(depth)]; }

  function getZoneProgress() {
    var z = ZONES[zoneIndex < 0 ? 0 : zoneIndex];
    var t = (distance - z.start) / z.len;
    return t < 0 ? 0 : (t > 1 ? 1 : t);
  }

  return {
    init: init,
    update: update,
    reset: reset,
    getProgress: function () { return progress; },
    getDistance: function () { return distance; },
    isComplete: function () { return complete; },
    /** World units dug PAST the end of the map, 0 until then. `progress` is
     *  pinned at 1 in the core, so this is the only thing left that still
     *  moves — the HUD gauge switches to reporting it. */
    getOvertime: function () {
      var o = distance - RUN_LENGTH;
      return o > 0 ? o : 0;
    },

    /* --- Phase 2 additions -------------------------------------------- */
    getZones: function () { return ZONES; },
    zoneAt: zoneAt,
    getZone: function () { return ZONES[zoneIndex < 0 ? 0 : zoneIndex]; },
    getZoneIndex: function () { return zoneIndex < 0 ? 0 : zoneIndex; },
    getZoneProgress: getZoneProgress,
    getCollected: function () { return collected; },
    getLength: function () { return RUN_LENGTH; },

    /* --- TIME ATTACK (the HUD contract) -------------------------------- */
    getTimeLeft: function () { return timeLeft < 0 ? 0 : timeLeft; },
    getTimeStart: function () { return TIME_START; },
    getTimeCap: function () { return TIME_CAP; },
    getTimeBonus: function () { return TIME_BONUS; },
    isRunOver: function () { return runOver; },
    addTime: addTime,

    /* --- run mode ------------------------------------------------------
     * Set from the menu BEFORE the first reset that should honour it. It is
     * deliberately not cleared by reset(), so RESTART repeats the same mode. */
    setMode: function (m) {
      mode = (m === MODE_FREESTYLE) ? MODE_FREESTYLE : MODE_TIME;
      return mode;
    },
    getMode: function () { return mode; },
    isFreestyle: function () { return mode === MODE_FREESTYLE; },

    /* --- time-cell run totals (the end-card footnote) ------------------ */
    getCellBlocks: function () { return cellBlocks; },
    getCellSeconds: function () { return cellSeconds; },
  };
})();
