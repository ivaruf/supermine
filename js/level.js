/* =============================================================================
 * SUPERMINE — js/level.js                          [OWNER: Agent 2 — gameplay]
 * -----------------------------------------------------------------------------
 * THE RUN DIRECTOR. Owns three things:
 *
 *   1. THE SECTION MAP — an ordered list of zones with the generation knobs
 *      terrain.js reads through SM.level.zoneAt(depth). This is the whole
 *      3-5 minute shape of the run: easy opening -> resource lanes -> granite
 *      barriers -> narrow passages -> crystal caverns -> the final core.
 *   2. THE GATE PLAN — where every paired route gate and upgrade station sits.
 *      Gates must exist BEFORE terrain generates their band, which is why
 *      main.js calls level.init() before terrain.init().
 *   3. THRESHOLD TRANSFORMS — "you have banked N -> the machine grows",
 *      applied with no gate and no interruption.
 *
 * Public API
 *   SM.level.init() / update(dt) / reset()
 *   SM.level.getProgress()   0..1 over the whole run
 *   SM.level.getDistance()   world units travelled
 *   SM.level.isComplete()
 * Phase-2 additions (terrain.js and presentation may use these):
 *   SM.level.getZones() zoneAt(depth) getZone() getZoneIndex()
 *   SM.level.getZoneProgress() getCollected() getLength()
 *
 * Events emitted
 *   level:started    null
 *   level:complete   {distance}
 *   zone:entered     {name, kind}     kind: opening|rich|barrier|narrow|final
 * ========================================================================== */

var SM = SM || {};

SM.level = (function () {
  'use strict';

  var C = SM.config;

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
   * ================================================================== */
  var ZONES = [
    {
      name: 'SURFACE CUT', kind: 'opening', len: 2600,
      stoneW: 0.12, graniteW: 0, pocketRate: 0.75,
      ores: [['iron', 5], ['gold', 2]],
      bigChance: 0, voidChance: 0.14, rubble: 0.10,
      veins: 0, veinOre: 'iron', veinWidth: 0
    },
    {
      name: 'IRON LANES', kind: 'rich', len: 4200,
      stoneW: 0.34, graniteW: 0, pocketRate: 1.15,
      ores: [['iron', 6], ['gold', 3], ['stone', 2]],
      bigChance: 0.05, voidChance: 0.10, rubble: 0.12,
      veins: 2, veinOre: 'iron', veinWidth: 78
    },
    {
      name: 'THE GRANITE WALL', kind: 'barrier', len: 3200,
      stoneW: 0.58, graniteW: 0.22, pocketRate: 0.85,
      ores: [['gold', 4], ['iron', 3], ['gem', 2]],
      bigChance: 0.06, voidChance: 0.08, rubble: 0.18,
      veins: 0, veinOre: 'gold', veinWidth: 0
    },
    {
      name: 'GOLDFIELDS', kind: 'rich', len: 4600,
      stoneW: 0.40, graniteW: 0, pocketRate: 1.45,
      ores: [['gold', 7], ['iron', 3], ['gem', 3]],
      bigChance: 0.14, voidChance: 0.10, rubble: 0.12,
      veins: 2, veinOre: 'gold', veinWidth: 88
    },
    {
      name: 'THE THROAT', kind: 'narrow', len: 2600,
      stoneW: 0.55, graniteW: 0.30, pocketRate: 0.6,
      ores: [['gem', 4], ['gold', 3], ['crystal', 2]],
      bigChance: 0.05, voidChance: 0.05, rubble: 0.30,
      veins: 0, veinOre: 'gem', veinWidth: 0,
      // corridorHalf + corridorWave + 1.32*corridorDrift must stay under
      // LANE_HALF_WIDTH or the passage opens straight into the bedrock wall.
      corridorHalf: 300, corridorWave: 70, corridorDrift: 190
    },
    {
      name: 'GEM HOLLOWS', kind: 'rich', len: 5000,
      stoneW: 0.42, graniteW: 0.05, pocketRate: 1.55,
      ores: [['gem', 6], ['gold', 3], ['crystal', 3], ['iron', 2]],
      bigChance: 0.18, voidChance: 0.18, rubble: 0.14,
      veins: 2, veinOre: 'gem', veinWidth: 84
    },
    {
      name: 'DEEP BARRIER', kind: 'barrier', len: 3400,
      stoneW: 0.50, graniteW: 0.34, pocketRate: 0.95,
      ores: [['crystal', 4], ['gem', 3], ['rare', 1]],
      bigChance: 0.10, voidChance: 0.07, rubble: 0.20,
      veins: 0, veinOre: 'crystal', veinWidth: 0,
      // Obsidian is 3x granite hardness: by this depth the rig is strong
      // enough that granite alone would no longer register as a barrier.
      wallMat: 'obsidian'
    },
    {
      name: 'CRYSTAL CAVERNS', kind: 'rich', len: 6000,
      stoneW: 0.35, graniteW: 0.04, pocketRate: 1.75,
      ores: [['crystal', 8], ['gem', 4], ['rare', 2], ['gold', 2]],
      bigChance: 0.34, voidChance: 0.18, rubble: 0.16,
      veins: 1, veinOre: 'crystal', veinWidth: 100
    },
    {
      name: 'PRESSURE LOCK', kind: 'narrow', len: 2400,
      stoneW: 0.45, graniteW: 0.40, pocketRate: 0.7,
      ores: [['crystal', 4], ['rare', 2], ['gem', 2]],
      bigChance: 0.06, voidChance: 0.04, rubble: 0.34,
      veins: 0, veinOre: 'crystal', veinWidth: 0,
      corridorHalf: 270, corridorWave: 66, corridorDrift: 200,
      wallMat: 'obsidian'
    },
    {
      name: 'THE MOTHERLODE', kind: 'rich', len: 6600,
      stoneW: 0.28, graniteW: 0.03, pocketRate: 2.0,
      ores: [['crystal', 6], ['gem', 5], ['gold', 5], ['rare', 4]],
      bigChance: 0.30, voidChance: 0.09, rubble: 0.12,
      veins: 3, veinOre: 'rare', veinWidth: 74
    },
    {
      // THE FINAL SPECTACLE. No dirt at all: the base rock IS treasure, and
      // starcore formations are stacked on top of it. A maxed machine deletes
      // a wall of this per second.
      name: 'THE CORE', kind: 'final', len: 9000,
      stoneW: 0, graniteW: 0, pocketRate: 2.4,
      baseOres: [['gold', 3], ['gem', 3], ['crystal', 4], ['rare', 2]],
      ores: [['starcore', 6], ['rare', 6], ['crystal', 5], ['gem', 3]],
      bigChance: 0.45, voidChance: 0.04, rubble: 0.0,
      veins: 2, veinOre: 'starcore', veinWidth: 120
    }
  ];

  /* =====================================================================
   * THE GATE PLAN
   * ---------------------------------------------------------------------
   * pair    -> two arches at the same depth. left is the SAFE route, right is
   *            the HARD route (denser rock on that side, stronger upgrade).
   * station -> full-lane gantry, cannot be missed. These carry the guaranteed
   *            beats of the power curve so a run can never stall out.
   * Distances are deliberately placed OUTSIDE barrier and narrow sections so
   * the terrain carve never punches a hole in a structural wall.
   * ================================================================== */
  var GATE_PLAN = [
    /* zone boundaries: 2600 | 6800 | 10000 | 14600 | 17200 | 22200 | 25600 |
     *                  31600 | 34000 | 40600 | 49600                        */
    { at: 1000,  kind: 'pair',    left: 'wider_blade',   right: 'drill_heads' },
    { at: 3100,  kind: 'pair',    left: 'magnet',        right: 'mining_power' },
    { at: 5000,  kind: 'station', up: 'speed_up' },
    { at: 6400,  kind: 'pair',    left: 'side_grinders', right: 'multiplier' },
    { at: 10200, kind: 'station', up: 'wider_blade' },
    { at: 12000, kind: 'pair',    left: 'explosive_pulse', right: 'rear_conveyor' },
    { at: 14100, kind: 'station', up: 'mining_power' },
    { at: 17600, kind: 'pair',    left: 'magnet',        right: 'drill_heads' },
    { at: 20000, kind: 'station', up: 'speed_up' },
    { at: 21700, kind: 'pair',    left: 'multiplier',    right: 'side_grinders' },
    { at: 25900, kind: 'station', up: 'wider_blade' },
    { at: 28500, kind: 'pair',    left: 'overdrive',     right: 'explosive_pulse' },
    // Pulse lives on a STATION as well as on pair gates, so even a player who
    // never steers still gets the explosive toy before the final stretch.
    { at: 31100, kind: 'station', up: 'explosive_pulse' },
    { at: 34600, kind: 'pair',    left: 'rear_conveyor', right: 'magnet' },
    { at: 37600, kind: 'station', up: 'overdrive' },
    { at: 40100, kind: 'station', up: 'final_overhaul' }
  ];

  var PAIR_X = 320;              // lateral offset of each half of a pair
  var PAIR_X_LATE = 250;         // pairs get closer to the centre once the
  var PAIR_LATE_FROM = 20000;    // machine is too wide to swing far sideways

  /* --- automatic threshold transformations ----------------------------
   * Trigger on banked value, so a greedy player transforms sooner. Both are
   * guaranteed by a distance fallback so no run can miss them entirely.
   * ------------------------------------------------------------------ */
  var AUTO_PLAN = [
    { id: 'auto_hopper', value: 12000,   byDistance: 7500,  done: false },
    { id: 'mega_treads', value: 260000,  byDistance: 23000, done: false }
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

  var evComplete = { distance: 0 };
  var evZone = { name: '', kind: '' };

  /* ------------------------------------------------------------------ */

  function init() {
    SM.events.on('resource:collected', onCollected);
    reset();
  }

  /** HOT: fires up to ~30x per step. O(1), no allocation, no strings. */
  function onCollected(p) {
    collected += p.value * SM.vehicle.getValueMultiplier();
  }

  function placeGates() {
    SM.upgrades.clearGates();
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
        SM.upgrades.addGate({
          id: pid + '_L', upgradeId: g.left, pairId: pid, tone: 'safe',
          x: -off, y: y
        });
        SM.upgrades.addGate({
          id: pid + '_R', upgradeId: g.right, pairId: pid, tone: 'risk',
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
    for (var i = 0; i < AUTO_PLAN.length; i++) AUTO_PLAN[i].done = false;

    placeGates();
    SM.events.emit('level:started', null);
  }

  function update(dt) {
    distance = C.START_Y - SM.vehicle.getY();
    if (distance < 0) distance = 0;
    progress = distance / RUN_LENGTH;
    if (progress > 1) progress = 1;

    /* --- zone transitions --------------------------------------------- */
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

    /* --- automatic threshold transformations --------------------------- */
    for (var i = 0; i < AUTO_PLAN.length; i++) {
      var a = AUTO_PLAN[i];
      if (a.done) continue;
      if (collected >= a.value || distance >= a.byDistance) {
        a.done = true;
        SM.upgrades.trigger(a.id);
      }
    }

    if (!complete && progress >= 1) {
      complete = true;
      evComplete.distance = distance;
      SM.events.emit('level:complete', evComplete);
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

    /* --- Phase 2 additions -------------------------------------------- */
    getZones: function () { return ZONES; },
    zoneAt: zoneAt,
    getZone: function () { return ZONES[zoneIndex < 0 ? 0 : zoneIndex]; },
    getZoneIndex: function () { return zoneIndex < 0 ? 0 : zoneIndex; },
    getZoneProgress: getZoneProgress,
    getCollected: function () { return collected; },
    getLength: function () { return RUN_LENGTH; }
  };
})();
