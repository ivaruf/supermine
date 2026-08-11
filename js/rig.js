/* =============================================================================
 * SUPERMINE — js/rig.js                          [OWNER: Agent 2 — PROGRESSION]
 * -----------------------------------------------------------------------------
 * THE MACHINE, AS NUMBERS. rig.js owns the eight upgrade categories, their
 * tiers, their prices, and the derived stats every other module reads. It holds
 * NO run state: fuel LEVEL is the run's business (js/adv.js), fuel CAPACITY is
 * the machine's and lives here.
 *
 * ---------------------------------------------------------------------------
 * THE EIGHT PARTS — the workshop draws exactly these, in this order
 *   drill    penetrate harder rock, faster           -> power, hardnessCap
 *   engine   move faster, shove through debris       -> speed, thrust
 *   tracks   grip and turn rate                      -> turn, climb
 *   fuel     stay under longer                       -> fuelCap
 *   cargo    fewer return trips                      -> cargoCap
 *   lights   see more of the cavern                  -> lightRadius
 *   scanner  read ore through walls                  -> scanRange
 *   cooling  survive the deep heat                   -> heatCap, heatShed
 *
 * DESIGN RULE FROM THE BRIEF: an upgrade should CHANGE WHAT YOU CAN DO, not
 * just add a number. Tier a drill so that each step crosses a real hardness
 * threshold from js/mines.js, so the player's thought is "now I can get into
 * Blackstone", not "now I have 12% more drill".
 *
 * VISUAL CONTRACT WITH js/vehicle.js (Agent 1)
 *   getPartFlags() returns a flat object of small integers, one per visible
 *   subassembly. vehicle.js switches geometry on those and NEVER reads tiers
 *   directly, so Agent 2 can re-tier freely without touching the renderer:
 *     { bladeTier, drills, grinders, treads, hopper, conveyor, magnets,
 *       lamps, stacks, radiators, armor }
 *
 * =============================================================================
 * ================  AGENT-2 DESIGN NOTES — READ BEFORE TUNING  ================
 * =============================================================================
 *
 * A. THE DRILL LADDER IS THE GAME'S SPINE
 *
 *    Read js/mines.js design notes 1 and 2 first; this table is the other half
 *    of that argument. Advance rate through solid rock is
 *        v = min(engineSpeed, ADV.SPACING * power / hardness)
 *    and each drill tier is chosen so that a NAMED material crosses from
 *    "grinding" to "cutting", and so that hardnessCap crosses a named wall.
 *
 *    Speeds below are units/second through that material, paired with the engine
 *    tier a player realistically owns at the same time, and measured with
 *    SM.mines.advanceRate(). "full" means the rock is not the limit any more.
 *
 *      tier 0  WORN AUGER BIT       power  8  cap  8.5   dirt/clay/coal/sandstone
 *              at full speed, stone 73%, limestone 65%, copper 56%, iron 45%,
 *              granite a miserable 25%. Cannot touch ancient rock, obsidian or
 *              bedrock.
 *      tier 1  TUNGSTEN BIT         power 13  cap 11.5   stone and limestone
 *              free, copper 91%, silver 69%, iron 58% -> RED RIDGE's bench
 *              limestone stops being the reason a run is slow. Cap clears the
 *              ANCIENT FORMATION (9.5, and 10.45 under the Rift's 1.10 scale).
 *      tier 2  COMPOSITE ROTARY     power 21  cap 14.0   copper, silver, gold
 *              and emerald all free, crystal 90%, granite 42%.
 *      tier 3  POLYCRYSTALLINE      power 35  cap 20.0   granite 59%, crystal
 *              full -> BLACKSTONE and DEEP HOLLOW stop eating whole tanks. Cap
 *              clears OBSIDIAN even under the Rift's 1.20 scale (19.2) ->
 *              the pressure locks and the Cinder Fell magma skin open.
 *      tier 4  THERMAL LANCE ARRAY  power 55  cap 25.0   granite 79%, starcore
 *              61%, ancient full, obsidian 31%.
 *      tier 5  PLASMA CORE BREAKER  power 84  cap 34.0   granite full, starcore
 *              80%, obsidian 40% and BEDROCK 25% of a 275 u/s machine — which
 *              is still faster than the STARTER moves through stone.
 *              Deliberately never 100% on either: those two stay the rocks that
 *              are always felt.
 *
 *    NOTE ON WHERE THESE HARDNESSES COME FROM. They are Agent 3's, read live out
 *    of SM.materials, and three of them landed a long way from what this file
 *    originally assumed: sandstone is 1.7 and not 2.8 (it is the FAST bed, not
 *    the barrier), limestone is 2.6 and not 1.7 (so IT is the barrier), and
 *    uranium is 4.4 and not 7.6 (so uranium is gated by HEAT, not by the drill).
 *    js/mines.js was re-cut around the real numbers; nothing here reads a
 *    hardness literal, so re-run SM.mines.audit() after any change on their side
 *    rather than trusting this comment.
 *
 *    Note what this makes true: nothing is ever locked. A tier-0 auger can
 *    physically reach the bottom of The Rift; it will take four tanks it cannot
 *    carry. That is the brief's "slow and burn fuel, not told no".
 *
 * B. FUEL IS TUNED AS ENDURANCE, NOT AS A NUMBER
 *
 *    Bigger machines burn more, so a tank that only grew with the tank would go
 *    backwards. The tanks are sized from a target ENDURANCE — seconds of
 *    ordinary working, meaning getBurnEstimate(0.6, 0.9) — checked against the
 *    modelled round trip of every mine (SM.mines.audit()):
 *
 *      tier   burn u/s   tank   endurance   modelled round trip it just covered
 *        0      1.07      175      164 s    Old Creek 43 u,  Red Ridge 86 u
 *        1      1.71      340      199 s    Red Ridge 94 u,  Blackstone 249 u
 *        2      2.54      620      245 s    Blackstone 251,  Frostpeak 286
 *        3      3.72     1100      296 s    Deep Hollow 429, Cinder Fell 547
 *        4      5.29     1850      350 s    The Rift 812
 *        5      7.43     3100      417 s    The Rift with the hold filled twice
 *
 *    Each mine STRANDS one tier below its recommendation and needs 40-50% of the
 *    tank at it. That remaining half is not slack — see the fuel tier table's
 *    own note for why, and for which number to move once real playtest figures
 *    exist. getBurnEstimate() is exported so js/adv.js's "reserve needed"
 *    warning and the prep screen's fuel slider agree with this table instead of
 *    inventing their own coefficients.
 *
 * C. WHY COLLECT RADIUS AND ARMOUR ARE NOT THEIR OWN CATEGORIES
 *
 *    Eight categories is the contract, and two derived stats still need a home:
 *      collect radius  rides on CARGO   — a bigger hopper has a bigger intake,
 *                      and it keeps "the hold" as one idea in the workshop.
 *      armour          rides on TRACKS  — tracks are the undercarriage, and the
 *                      heaviest visible part of the machine's silhouette. The
 *                      `armor` visual flag and getArmor() therefore always agree.
 *
 * D. DEVICE HARDNESS COMPENSATION
 *
 *    js/materials.js rewrites `hardness` upward on coarse-grid devices (see its
 *    tunables note) while adventure's grid is a fixed ADV.SPACING. Drill power
 *    and hardness cap are therefore multiplied by SM.mines.deviceHardnessK() so
 *    that what the drill can cut is identical on every screen. NOTHING ELSE is
 *    scaled — speeds, tanks, holds, prices and radii are all geometry or money.
 *
 * E. PRICES
 *
 *    A per-part multiplier over one shared geometric ladder
 *    (700 / 3 200 / 14 000 / 58 000 / 330 000), so the shape of every part's
 *    cost curve is the same and only its weight differs:
 *      drill 1.4 (the gate, and it should hurt)   engine 1.0   cargo 0.9
 *      cooling 0.8   fuel 0.7   tracks 0.6   scanner 0.55   lights 0.45
 *    Fully maxing the machine costs ~$2.60M; all seven sets of mining rights
 *    cost ~$0.77M. See js/mines.js design note 4 for the income side.
 *
 *    The tier-5 rung is 5.7x the tier-4 rung rather than the ladder's usual
 *    ~4.2x, and that is deliberate: a simulated greedy player finishes the map
 *    with The Rift paying ~$550k a run, so at the original 220 000 rung the
 *    entire final act was three runs long. At 330 000 it is five or six, which
 *    is about as long as an endgame should be when the player is already rich.
 * ========================================================================== */

var SM = SM || {};

SM.rig = (function () {
  'use strict';

  /* ----- Agent-2 tunables live here -----------------------------------
   *
   * THE PART TABLE. One entry per category, tiers shallow -> deep. `cost` is the
   * price of INSTALLING that tier (tier 0 is the battered starter and is free).
   * Every tier's `blurb` is written as WHAT IT LETS YOU DO, because that is the
   * only thing the workshop should ever be selling.
   * ------------------------------------------------------------------ */

  var PART_TABLE = [
    {
      key: 'drill', title: 'DRILL', icon: 'drill', glyph: '><',
      blurb: 'Hardness you can cut, and how fast you cut it.',
      stats: ['power', 'cap'],
      /* CAPS. Two constraints fix this ladder, and they pull opposite ways:
       *
       *   FLOOR  The hardest layer FILL in the catalogue is granite (6.2) under
       *          Frostpeak's and the Rift's hardnessScale 1.20 = 7.44. Tier 0
       *          must clear that or a mine becomes physically unenterable, which
       *          mines.js design note 2 forbids.
       *   ROOF   Tier 0 must NOT clear the ancient formation (9.5), or the
       *          richest material in the game is free from the first minute.
       *
       * 8.5 is the middle of that window, and the rest of the ladder then falls
       * out of the three materials that exist to be walls. Three named crossings,
       * one every other tier, which is exactly the cadence the brief asks for:
       *
       *   tier 1 (11.5)  ANCIENT FORMATION — 9.5, or 10.45 under the Rift
       *                  floor's 1.10 scale. The Deep Hollow floor pays out.
       *   tier 3 (20.0)  OBSIDIAN — 16.0, or 19.2 under the Rift's 1.20 scale.
       *                  The pressure locks and the Cinder Fell magma skin open.
       *   tier 5 (34.0)  BEDROCK — 26.0, the floor of the mine itself. Cut at
       *                  25% of free speed, so it stays a decision about fuel
       *                  rather than a door, which is what Agent 3 designed that
       *                  material to be.
       *
       * hardnessScale multiplies POCKET materials as well as the fill, which is
       * why the obsidian crossing needs 20 and not 17. Tiers 2 and 4 are pure
       * power steps and are sold as such. */
      tiers: [
        { name: 'WORN AUGER BIT', cost: 0, power: 8, cap: 8.5, burn: 0.60,
          blurb: 'Soft ground only. Granite is a suggestion you cannot afford.' },
        { name: 'TUNGSTEN BIT', cost: 1000, power: 13, cap: 11.5, burn: 0.95,
          blurb: 'Limestone benches stop fighting back. Cuts the ANCIENT FORMATION.' },
        { name: 'COMPOSITE ROTARY HEAD', cost: 4500, power: 21, cap: 14.0, burn: 1.50,
          blurb: 'Copper, silver, gold and emerald at full speed. Granite at 42%.' },
        { name: 'POLYCRYSTALLINE CUTTER', cost: 20000, power: 35, cap: 20.0, burn: 2.40,
          blurb: 'Granite at sixty per cent. Cuts OBSIDIAN — the Rift locks open.' },
        { name: 'THERMAL LANCE ARRAY', cost: 82000, power: 55, cap: 25.0, burn: 3.70,
          blurb: 'Nothing but obsidian and bedrock is in the way any more.' },
        { name: 'PLASMA CORE BREAKER', cost: 465000, power: 84, cap: 34.0, burn: 5.60,
          blurb: 'Cuts BEDROCK — the floor of the mine itself. Slowly, but it cuts.' }
      ]
    },
    {
      key: 'engine', title: 'ENGINE', icon: 'engine', glyph: '=',
      blurb: 'Ground speed, and the shove that clears loose debris.',
      stats: ['speed', 'thrust'],
      tiers: [
        { name: 'TIRED DIESEL', cost: 0, speed: 110, thrust: 1.00, idle: 0.35, burn: 0.30,
          blurb: 'It starts most mornings.' },
        { name: 'REBUILT DIESEL', cost: 700, speed: 138, thrust: 1.15, idle: 0.45, burn: 0.40,
          blurb: 'A quarter faster everywhere, and it pushes rubble instead of stopping.' },
        { name: 'TURBO DIESEL', cost: 3200, speed: 168, thrust: 1.32, idle: 0.60, burn: 0.55,
          blurb: 'Long hauls back up the shaft stop costing you the run.' },
        { name: 'TWIN TURBINE', cost: 14000, speed: 200, thrust: 1.52, idle: 0.80, burn: 0.75,
          blurb: 'Classic-rig pace, underground, in the dark.' },
        { name: 'HYDROGEN TURBINE', cost: 58000, speed: 236, thrust: 1.75, idle: 1.05, burn: 1.00,
          blurb: 'Six hundred metres of climb becomes a minute and a half.' },
        { name: 'FUSION DRIVE', cost: 330000, speed: 275, thrust: 2.00, idle: 1.35, burn: 1.30,
          blurb: 'The Rift floor to daylight on one tank.' }
      ]
    },
    {
      key: 'tracks', title: 'TRACKS', icon: 'tracks', glyph: '#',
      blurb: 'How sharply the hull turns, and how much of a cave-in it shrugs off.',
      stats: ['turn', 'grip', 'armor'],
      tiers: [
        { name: 'PATCHED RUBBER', cost: 0, turn: 2.2, grip: 1.00, armor: 0,
          blurb: 'Turns like a barge. Every falling rock lands on the hull.' },
        { name: 'STEEL LINKED', cost: 420, turn: 2.8, grip: 1.15, armor: 1,
          blurb: 'Tighter cornering in narrow seams, and the first real plating.' },
        { name: 'WIDE STEEL', cost: 1900, turn: 3.4, grip: 1.32, armor: 2,
          blurb: 'Holds a line across a cavern floor instead of skating.' },
        { name: 'HARDENED CLEAT', cost: 8400, turn: 4.1, grip: 1.52, armor: 4,
          blurb: 'You can pick your way through an obsidian field without stopping.' },
        { name: 'GYRO-STABILISED', cost: 35000, turn: 5.0, grip: 1.74, armor: 7,
          blurb: 'Turn on the spot. Cave-ins cost a scratch instead of a run.' },
        { name: 'MAGLEV CRAWLER', cost: 198000, turn: 6.2, grip: 2.00, armor: 11,
          blurb: 'The hull stops caring what the floor is made of.' }
      ]
    },
    {
      key: 'fuel', title: 'FUEL', icon: 'fuel', glyph: '[]',
      blurb: 'How long you can stay down there. See design note B.',
      stats: ['cap'],
      /* Sized so that at the tier a mine is designed for, the modelled
       * round-trip needs 40-50% of the tank, and one tier below it strands.
       * The 2x headroom is not slack: the model in mines.js's audit assumes the
       * player drives down, prospects laterally for about half the vertical
       * distance and drives back. Real play wanders two or three times that, so
       * "40% of the tank" on paper is "most of the tank" in the mine. If you
       * ever measure the real figure, THIS is the number to move. */
      tiers: [
        { name: 'DENTED TANK', cost: 0, cap: 175,
          blurb: 'Old Creek and back with a margin. Red Ridge, only just.' },
        { name: 'WELDED TANK', cost: 500, cap: 340,
          blurb: 'Doubled. Red Ridge becomes comfortable, Blackstone possible.' },
        { name: 'TWIN TANKS', cost: 2200, cap: 620,
          blurb: 'Blackstone and Frostpeak, there and back, with fuel to spare.' },
        { name: 'PRESSURE BLADDER', cost: 9800, cap: 1100,
          blurb: 'Enough to reach the Deep Hollow floor and still climb out.' },
        { name: 'LONG-RANGE CELLS', cost: 41000, cap: 1850,
          blurb: 'Cinder Fell at eight hundred and eighty metres, twice over.' },
        { name: 'DEEP EXPEDITION RESERVE', cost: 231000, cap: 3100,
          blurb: 'Twelve hundred metres. The Rift stops being a suicide run.' }
      ]
    },
    {
      key: 'cargo', title: 'CARGO', icon: 'cargo', glyph: 'U',
      blurb: 'Hold volume — and the intake radius that fills it.',
      stats: ['cap', 'collect'],
      tiers: [
        { name: 'OPEN SKIP', cost: 0, cap: 48, collect: 215,
          blurb: 'Twelve deposits of coal. You will learn to hate coal.' },
        { name: 'STEEL HOPPER', cost: 650, cap: 80, collect: 250,
          blurb: 'Two thirds more per trip, and a wider magnet to fill it.' },
        { name: 'HIGH-SIDED HOPPER', cost: 2900, cap: 130, collect: 290,
          blurb: 'A silver vein no longer fills you up halfway along it.' },
        { name: 'COMPACTING HOPPER', cost: 12600, cap: 210, collect: 340,
          blurb: 'The whole Deep Hollow floor in one load.' },
        { name: 'DUAL HOPPER RIG', cost: 52000, cap: 330, collect: 400,
          blurb: 'You can afford to carry the cheap ore as well as the good.' },
        { name: 'ORE TRAIN', cost: 297000, cap: 520, collect: 470,
          blurb: 'Five hundred units. Dumping anything becomes a choice, not a tax.' }
      ]
    },
    {
      key: 'lights', title: 'LIGHTS', icon: 'lights', glyph: '*',
      blurb: 'How much of the cavern exists.',
      stats: ['radius'],
      tiers: [
        { name: 'CRACKED HEADLAMP', cost: 0, radius: 380, burn: 0.05,
          blurb: 'You see the rock you are already touching.' },
        { name: 'TWIN HALOGEN', cost: 320, radius: 520, burn: 0.08,
          blurb: 'Far enough ahead to steer instead of react.' },
        { name: 'ARC FLOODS', cost: 1400, radius: 680, burn: 0.14,
          blurb: 'Cavern walls resolve before you are inside them.' },
        { name: 'MAST ARRAY', cost: 6300, radius: 860, burn: 0.22,
          blurb: 'You can read a whole chamber and pick the richest wall.' },
        { name: 'XENON BATTERY', cost: 26000, radius: 1080, burn: 0.32,
          blurb: 'Most of the screen is lit. Ore glints at you from range.' },
        { name: 'DAYLIGHT RIG', cost: 148000, radius: 1400, burn: 0.45,
          blurb: 'The dark stops being a mechanic.' }
      ]
    },
    {
      key: 'scanner', title: 'SCANNER', icon: 'scanner', glyph: '(',
      blurb: 'Ore signatures through rock you have not touched.',
      stats: ['range'],
      tiers: [
        { name: 'NO SCANNER', cost: 0, range: 0, burn: 0,
          blurb: 'You dig where the rock looks promising and hope.' },
        { name: 'PROSPECTOR COIL', cost: 400, range: 420, burn: 0.15,
          blurb: 'Forty metres of warning. Enough to stop digging the wrong way.' },
        { name: 'PULSE SOUNDER', cost: 1800, range: 700, burn: 0.22,
          blurb: 'Seventy metres. You start choosing seams instead of finding them.' },
        { name: 'SEISMIC ARRAY', cost: 7700, range: 1100, burn: 0.30,
          blurb: 'A hundred and ten metres, with a bearing you can trust.' },
        { name: 'DEEP RESONANCE', cost: 32000, range: 1700, burn: 0.40,
          blurb: 'Reads the far wall of a cavern you have not entered.' },
        { name: 'ORE ORACLE', cost: 181000, range: 2600, burn: 0.55,
          blurb: 'Two hundred and sixty metres. You plan the whole descent.' }
      ]
    },
    {
      key: 'cooling', title: 'COOLING', icon: 'cooling', glyph: '~',
      blurb: 'Depth. Heat is the soft floor under every deep mine.',
      stats: ['heatCap', 'shed'],
      /* TWO numbers, doing two different jobs, which is what keeps all six tiers
       * worth buying:
       *   shed     the EQUILIBRIUM. mines.js's heatGainRate() peaks at 11.7/s
       *            (a heat-1.0 layer while drilling), so tier 4 is the first that
       *            breaks even down there and tier 5 is the first that is
       *            comfortable. Deliberately a shallow ladder — if tier 3 could
       *            already out-shed the worst layer in the game, tiers 4 and 5
       *            would be dead purchases.
       *   heatCap  the BUFFER, and therefore how many seconds you may spend in a
       *            layer you cannot out-shed. That is the texture of a deep mine:
       *            dive, work the seam, climb out before the needle tops. It
       *            keeps Cinder Fell playable one cooling tier early. */
      tiers: [
        { name: 'BLED RADIATOR', cost: 0, heatCap: 100, shed: 3.5, burn: 0.04,
          blurb: 'Breaks even to about 0.13 heat. Anything deeper is a stopwatch.' },
        { name: 'FLUSHED RADIATOR', cost: 560, heatCap: 130, shed: 5.0, burn: 0.10,
          blurb: 'The Blackstone silver veins stop being a countdown.' },
        { name: 'TWIN FANS', cost: 2600, heatCap: 175, shed: 7.0, burn: 0.18,
          blurb: 'Holds station on the Deep Hollow floor. Cinder Fell still cooks you.' },
        { name: 'GLYCOL LOOP', cost: 11200, heatCap: 240, shed: 9.5, burn: 0.28,
          blurb: 'The magma skin becomes a place you can work in bursts.' },
        { name: 'CRYO EXCHANGER', cost: 46000, heatCap: 330, shed: 13.0, burn: 0.40,
          blurb: 'Breaks even in a geothermal vent. Cinder Fell opens properly.' },
        { name: 'PHASE-CHANGE CORE', cost: 264000, heatCap: 460, shed: 18.0, burn: 0.55,
          blurb: 'The Rift floor at a thousand degrees, indefinitely.' }
      ]
    }
  ];

  var C0 = SM.config;

  var PART_KEYS = ['drill', 'engine', 'tracks', 'fuel', 'cargo', 'lights', 'scanner', 'cooling'];
  var tiers = {};          // partKey -> owned tier index (0 = the battered starter)
  var BY_KEY = {};

  /* Device hardness compensation — see design note D. Resolved in init(). */
  var hardK = 1;

  /* getPartFlags() is called from vehicle.js's render path, so the object is
   * allocated ONCE and mutated. Every key is declared up front to keep one
   * hidden class, exactly as vehicle.js does with its own `parts`. `flagsDirty`
   * means "a tier changed since the last call", so the common case is a return. */
  var flags = {
    bladeTier: 0, drills: 0, grinders: 0, treads: 0, hopper: 0, conveyor: 0,
    magnets: 0, lamps: 0, stacks: 0, radiators: 0, armor: 0,
    /* --- ALIASES / ADDITIONS, documented in the report -------------------
     * `magnetArms` and `teeth` are the names js/vehicle.js's EXISTING classic
     * part table already uses, so a naive `for (k in flags) parts[k] = ...`
     * lights up real geometry today. `dish` is the scanner, which the contract
     * list omits. All three are additive; the eleven above are the contract. */
    magnetArms: 0, teeth: 0, dish: 0
  };
  var flagsDirty = true;

  function init() {
    var i;
    BY_KEY = {};
    for (i = 0; i < PART_TABLE.length; i++) BY_KEY[PART_TABLE[i].key] = PART_TABLE[i];
    hardK = (SM.mines && SM.mines.deviceHardnessK) ? SM.mines.deviceHardnessK() : 1;
    if (!(hardK > 0.2) || !(hardK < 5)) hardK = 1;
    reset();
  }

  /** Back to the starting machine. Called when a new company is created. */
  function reset() {
    for (var i = 0; i < PART_KEYS.length; i++) tiers[PART_KEYS[i]] = 0;
    flagsDirty = true;
  }

  /* =====================================================================
   * PARTS & TIERS
   * ================================================================== */
  function getParts() { return PART_TABLE; }         // LIVE array, read-only
  function getPart(key) { return BY_KEY[key] || null; }
  function getTier(key) { var t = tiers[key]; return t > 0 ? t : 0; }
  function maxTier(key) {
    var p = BY_KEY[key];
    return p ? p.tiers.length - 1 : 0;
  }
  function isMaxed(key) { return getTier(key) >= maxTier(key); }

  /** The tier descriptor at an absolute index, or null. */
  function getTierInfo(key, n) {
    var p = BY_KEY[key];
    if (!p || !(n >= 0) || n >= p.tiers.length) return null;
    return p.tiers[n];
  }
  /** The tier descriptor currently installed. Never null for a valid key. */
  function currentTierInfo(key) { return getTierInfo(key, getTier(key)); }
  /** The tier descriptor of the NEXT purchase, or null when maxed. */
  function nextTierInfo(key) { return getTierInfo(key, getTier(key) + 1); }

  /** Price of the NEXT tier of `key`, or -1 when maxed. */
  function nextCost(key) {
    var t = nextTierInfo(key);
    return t ? t.cost : -1;
  }
  /** Human label of the next tier ('HARDENED CARBIDE BIT'), or null. */
  function nextName(key) {
    var t = nextTierInfo(key);
    return t ? t.name : null;
  }
  /** What the next tier lets you DO, or null. The workshop's real sales copy. */
  function nextBlurb(key) {
    var t = nextTierInfo(key);
    return t ? t.blurb : null;
  }

  /** Install a tier with no payment or validation. adv.js handles the money. */
  function setTier(key, n) {
    if (BY_KEY[key] === undefined) return;
    var m = maxTier(key);
    var v = Math.floor(n);
    if (!(v >= 0)) v = 0;
    if (v > m) v = m;
    if (tiers[key] === v) return;
    tiers[key] = v;
    flagsDirty = true;
  }

  /* Field read off the installed tier, with a default. Every derived stat below
   * funnels through this so a half-written tier table degrades instead of
   * returning NaN into the physics. */
  function statOf(key, field, dflt) {
    var t = currentTierInfo(key);
    if (!t) return dflt;
    var v = t[field];
    return (typeof v === 'number' && v === v) ? v : dflt;
  }

  /* =====================================================================
   * DERIVED STATS
   * ================================================================== */
  function getDrillPower() { return statOf('drill', 'power', 8) * hardK; }
  /** Hardness this drill simply cannot chew. See mines.js design note 2. */
  function getHardnessCap() { return statOf('drill', 'cap', 7) * hardK; }
  function getSpeed() { return statOf('engine', 'speed', 110); }
  /** Multiplier on acceleration / shove through loose debris. */
  function getThrust() { return statOf('engine', 'thrust', 1); }
  function getTurnRate() { return statOf('tracks', 'turn', 2.2); }
  /** Lateral grip: multiplier on steering authority and stopping. */
  function getGrip() { return statOf('tracks', 'grip', 1); }
  function getFuelCap() { return statOf('fuel', 'cap', 200); }
  function getCargoCap() { return statOf('cargo', 'cap', 48); }
  function getLightRadius() { return statOf('lights', 'radius', 380); }
  function getScanRange() { return statOf('scanner', 'range', 0); }
  function getHeatCap() { return statOf('cooling', 'heatCap', 100); }
  function getHeatShed() { return statOf('cooling', 'shed', 3.5); }
  /** Damage soaked per impact. Rides on TRACKS — see design note C. */
  function getArmor() { return statOf('tracks', 'armor', 0); }
  /** Magnet radius. Rides on CARGO — see design note C. */
  function getCollectRadius() { return statOf('cargo', 'collect', C0.VEHICLE_COLLECT_RADIUS); }

  /* --- the fuel budget, in one place ----------------------------------
   * js/adv.js should build its per-step draw out of these rather than inventing
   * coefficients, so the tank sizes in design note B stay true.
   *   idle     always drawn while the machine is running
   *   drive    added, scaled by stick magnitude
   *   drill    added while the blade is removing hardness
   *   light    always drawn
   *   scan     drawn while the scanner is sweeping (0 with no scanner fitted)
   *   cool     drawn while cooling is actively shedding
   * ------------------------------------------------------------------ */
  function getIdleBurn() { return statOf('engine', 'idle', 0.35); }
  function getDriveBurn() { return statOf('engine', 'burn', 0.30); }
  function getDrillBurn() { return statOf('drill', 'burn', 0.60); }
  function getLightBurn() { return statOf('lights', 'burn', 0.05); }
  function getScanBurn() { return statOf('scanner', 'burn', 0); }
  function getCoolBurn() { return statOf('cooling', 'burn', 0.04); }

  /**
   * Fuel units per second at a given duty cycle. `drillFrac` and `driveFrac` are
   * 0..1. The endurance table in design note B is exactly
   * getBurnEstimate(0.6, 0.9), so if you retune a burn number, re-read that
   * table before you retune a tank.
   */
  function getBurnEstimate(drillFrac, driveFrac) {
    var df = drillFrac >= 0 ? (drillFrac <= 1 ? drillFrac : 1) : 0;
    var vf = driveFrac >= 0 ? (driveFrac <= 1 ? driveFrac : 1) : 0;
    return getIdleBurn() + getLightBurn() + getCoolBurn() + getScanBurn() +
           getDriveBurn() * vf + getDrillBurn() * df;
  }
  /** Seconds of ordinary working a full tank buys. The prep screen's real number. */
  function getEndurance() {
    var b = getBurnEstimate(0.6, 0.9);
    return b > 0 ? getFuelCap() / b : 0;
  }

  /** Overall machine tier, 1..6. Shown on the save slot and the map. */
  function getMachineTier() {
    var sum = 0;
    for (var i = 0; i < PART_KEYS.length; i++) sum += getTier(PART_KEYS[i]);
    return 1 + Math.floor(sum / PART_KEYS.length);
  }
  /** Total tiers installed, 0..40. The garage's progress readout. */
  function getTierPoints() {
    var sum = 0;
    for (var i = 0; i < PART_KEYS.length; i++) sum += getTier(PART_KEYS[i]);
    return sum;
  }
  /** What has been sunk into the machine so far, in dollars. */
  function getInvested() {
    var total = 0, i, j, p;
    for (i = 0; i < PART_TABLE.length; i++) {
      p = PART_TABLE[i];
      for (j = 1; j <= getTier(p.key); j++) total += p.tiers[j].cost;
    }
    return total;
  }

  function getStat(name) {
    switch (name) {
      case 'power': return getDrillPower();
      case 'cap':
      case 'hardness': return getHardnessCap();
      case 'speed': return getSpeed();
      case 'thrust': return getThrust();
      case 'turn': return getTurnRate();
      case 'grip': return getGrip();
      case 'fuel': return getFuelCap();
      case 'cargo': return getCargoCap();
      case 'light': return getLightRadius();
      case 'scan': return getScanRange();
      case 'heatcap': return getHeatCap();
      case 'heatshed': return getHeatShed();
      case 'armor': return getArmor();
      case 'collect': return getCollectRadius();
      case 'burn': return getBurnEstimate(0.6, 0.9);
      case 'endurance': return getEndurance();
      case 'tier': return getMachineTier();
      case 'invested': return getInvested();
      default:
        // A part key returns its installed tier, which is what the workshop wants.
        if (BY_KEY[name] !== undefined) return getTier(name);
        return 0;
    }
  }

  /**
   * Flat visual flags for vehicle.js. See the header.
   * >> REUSED OBJECT, in the style of SM.camera.getViewBounds(). Read the fields
   * >> you need; do not stash the reference expecting a snapshot.
   *
   * The escalation is deliberate: every category adds visible mass, and three of
   * them add a SECOND subassembly partway up so the silhouette keeps changing
   * after the obvious slot is full.
   */
  function getPartFlags() {
    if (!flagsDirty) return flags;
    var drill = getTier('drill');
    var cargo = getTier('cargo');

    flags.bladeTier = drill;                          // 0..5 blade generations
    flags.drills = drill >= 2 ? drill - 1 : 0;        // rotary heads from tier 2
    flags.grinders = drill >= 3 ? drill - 2 : 0;      // side grinders from tier 3
    flags.treads = getTier('tracks');
    flags.hopper = cargo;
    flags.conveyor = cargo >= 2 ? cargo - 1 : 0;      // rear belt from tier 2
    flags.magnets = cargo;
    flags.lamps = getTier('lights');
    flags.stacks = getTier('engine');
    flags.radiators = getTier('cooling');
    flags.armor = getTier('tracks');                  // agrees with getArmor()

    flags.magnetArms = flags.magnets;
    flags.teeth = drill;
    flags.dish = getTier('scanner');

    flagsDirty = false;
    return flags;
  }

  /* =====================================================================
   * PERSISTENCE (js/save.js is the only caller)
   * ================================================================== */
  function getState() {
    var o = {}, i;
    for (i = 0; i < PART_KEYS.length; i++) o[PART_KEYS[i]] = tiers[PART_KEYS[i]] || 0;
    return o;
  }
  function applyState(o) {
    if (!o) return;
    for (var i = 0; i < PART_KEYS.length; i++) {
      var k = PART_KEYS[i];
      if (typeof o[k] === 'number') setTier(k, o[k]);
      else setTier(k, 0);
    }
    flagsDirty = true;
  }

  return {
    init: init,
    reset: reset,
    PART_KEYS: PART_KEYS,
    getParts: getParts,
    getPart: getPart,
    getTier: getTier,
    maxTier: maxTier,
    isMaxed: isMaxed,
    nextCost: nextCost,
    nextName: nextName,
    setTier: setTier,
    getDrillPower: getDrillPower,
    getHardnessCap: getHardnessCap,
    getSpeed: getSpeed,
    getTurnRate: getTurnRate,
    getFuelCap: getFuelCap,
    getCargoCap: getCargoCap,
    getLightRadius: getLightRadius,
    getScanRange: getScanRange,
    getHeatCap: getHeatCap,
    getHeatShed: getHeatShed,
    getArmor: getArmor,
    getCollectRadius: getCollectRadius,
    getIdleBurn: getIdleBurn,
    getMachineTier: getMachineTier,
    getStat: getStat,
    getPartFlags: getPartFlags,
    getState: getState,
    applyState: applyState,

    /* --- Agent-2 additions (documented in the report) ------------------- */
    getTierInfo: getTierInfo,
    currentTierInfo: currentTierInfo,
    nextTierInfo: nextTierInfo,
    nextBlurb: nextBlurb,
    getThrust: getThrust,
    getGrip: getGrip,
    getDriveBurn: getDriveBurn,
    getDrillBurn: getDrillBurn,
    getLightBurn: getLightBurn,
    getScanBurn: getScanBurn,
    getCoolBurn: getCoolBurn,
    getBurnEstimate: getBurnEstimate,
    getEndurance: getEndurance,
    getTierPoints: getTierPoints,
    getInvested: getInvested
  };
})();
