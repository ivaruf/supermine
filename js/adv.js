/* =============================================================================
 * SUPERMINE — js/adv.js                            [OWNER: Agent 1 — RUN & FEEL]
 * -----------------------------------------------------------------------------
 * THE EXPEDITION DIRECTOR. adv.js is to adventure mode what level.js is to the
 * time attack, and main.js runs exactly one of the two. It owns:
 *
 *   1. THE STATE MACHINE. Which screen the campaign is on, and therefore
 *      whether the simulation is running at all.
 *   2. THE RUN. Fuel, cargo, heat, hull integrity, depth, elapsed time — every
 *      pressure that makes "do I push deeper or go home" a real question.
 *   3. THE LEDGER. Cash, mining rights, workshop purchases, the day counter.
 *      adv.js is the ONLY module that moves money.
 *
 * ---------------------------------------------------------------------------
 * THE STATE MACHINE
 *
 *   off  --open()-->  slots  --startCompany()-->  map
 *                                                 |  ^
 *                              openGarage() ------+  |
 *                                     garage ---------+
 *                                                 |
 *                              selectMine() ------+
 *                                     prep
 *                                       | enterMine()
 *                                     MINE  <-- the only state where time passes
 *                                       | escape() / strand()
 *                                     results
 *                                       | sell() -> map
 *
 *   Only 'mine' runs the simulation. Every other state returns true from
 *   holdsSim(), which makes main.js zero its fixed-step accumulator — the world
 *   still RENDERS behind the map and the workshop, it just does not advance.
 *
 *   Announce every transition with `adv:state` and let js/advui.js decide what
 *   to draw. Do not reach into advui.js to open a specific screen; the whole
 *   point of the split is that this file never touches the DOM.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR PRESSURES — get the FEEL of these right and the mode works
 *
 *   FUEL      Bought before the descent, at a price. Burned by driving, and
 *             much harder by DRILLING, and continuously by lights, cooling and
 *             the scanner. Running dry underground is the failure state: the
 *             player is STRANDED and loses the cargo (recoverable as a pile on
 *             the next visit — see below — so it stings without being cruel).
 *   CARGO     Volume, not money. Coal is bulky and cheap; gold is dense and
 *             worth a fortune. A full hold in front of a fresh gold seam is the
 *             single best decision the game offers, and dump() is the answer.
 *   HEAT      Rises with depth and with drilling, shed by cooling. At the cap
 *             the machine takes integrity damage. This is the soft depth gate.
 *   INTEGRITY Hull condition. Cave-ins and overheating chew it; repairs cost
 *             money at the surface. At zero the machine is stranded.
 *
 *   DUMPED AND LOST CARGO PERSISTS. dump() drops a pile at the machine's
 *   position; a strand() drops the whole hold. Piles live in the save record
 *   and js/advterrain.js re-spawns them when their band streams in, which is
 *   what makes "I'll come back for the coal" true.
 *
 * ---------------------------------------------------------------------------
 * CROSS-MODULE SEAMS
 *   vehicle.js  asks isDriving() every step and, when true, drives the free-roam
 *               2D path off SM.input.getMove() instead of auto-advancing. It
 *               reports work back through burnFuel() / addHeat() / offerCargo().
 *   advterrain  asks getMine() for the definition and getPiles() for the drops.
 *   advhud      polls the getters below. It must never mutate anything here.
 *   advui       drives the machine through the verbs (buyRights, buyFuel,
 *               buyPart, selectMine, enterMine, sell, openGarage, backToMap).
 *
 * ---------------------------------------------------------------------------
 * EVERY SEAM IS FEATURE-DETECTED, ON PURPOSE
 * The other three agents' modules come up as stubs that return zeros and nulls.
 * Nothing in here may throw on that, so every cross-module read goes through a
 * small `??`-shaped guard with a documented default, and the mine catalogue
 * falls back to FALLBACK_MINE (below) when SM.mines is still empty. That is
 * what keeps the build runnable — and testable from the console — at every
 * point during the parallel phase.
 *
 * EVENTS EMITTED (payload objects are REUSED — read them inside the handler)
 *   adv:state     {state, prev}
 *   adv:entered   {mineId, depth}
 *   adv:extracted {gross, cargo, depthM, reason}
 *   adv:stranded  {reason, depthM, lost}
 *   adv:cash      {cash, delta, reason}
 *   adv:fuellow   {pct}
 *   adv:cargofull  null
 *   adv:dumped    {matIndex, units, x, y}
 *   adv:rig       {partKey, tier}
 *   adv:rights    {mineId, price}
 *   adv:day       {day}
 *   adv:heat      {pct}
 *   adv:damage    {integrity, source}
 *   adv:sold      {gross, cash, day}          <- ADDITION: the results screen's
 *                                                "money has actually moved" beat
 * ========================================================================== */

var SM = SM || {};

SM.adv = (function () {
  'use strict';

  /* =====================================================================
   * AGENT-1 TUNABLES
   * ================================================================== */

  // --- the ledger a brand-new company starts with ----------------------
  // SM.mines.startingCash() is authoritative — Agent 2 balanced it against the
  // first tank and the cheapest upgrade. This is only the answer for a build
  // where the catalogue has not landed.
  var START_CASH = 900;

  // --- hull ------------------------------------------------------------
  // Integrity is carried in POINTS, not in 0..1, because SM.mines.repairPrice()
  // is documented as "dollars to repair ONE POINT of hull integrity" — so the
  // point has to be the unit money is quoted in. getIntegrity() still returns
  // 0..1 as the contract says.
  var HULL_POINTS = 100;
  // Armour soaks damage. The stub calls it "damage soaked per impact", but
  // adv.js is fed continuous wear as well as discrete hits, and subtracting a
  // flat soak from a 0.01-point tick would make armour absolute immunity. So it
  // is applied as a divisor: 10 points of armour halves incoming damage.
  var ARMOR_DIV = 0.10;

  // --- fuel ------------------------------------------------------------
  // THE BUDGET IS SM.rig's, NOT OURS. rig.js publishes the whole fuel model —
  // getIdleBurn/getLightBurn/getCoolBurn/getDriveBurn/getDrillBurn — and sizes
  // its tanks from a target ENDURANCE computed off exactly those numbers. So
  // adv.js draws the STANDING part of that budget (idle + lights + cooling +
  // scanner) and vehicle.js draws the duty-cycle part; inventing a coefficient
  // here would silently invalidate every tank size in the game.
  // These two are the fallbacks for a build where rig.js is still a stub.
  var FALLBACK_LIGHT_BURN = 0.05;
  var FALLBACK_IDLE_BURN = 0.35;
  // Warning thresholds, high to low. Each fires `adv:fuellow` once as it is
  // crossed downward, and re-arms only on a new descent.
  var FUEL_WARN = [0.35, 0.20, 0.10, 0.05];
  // How long the machine coasts on an empty tank before the run is called.
  // Without this the strand lands on the same frame the needle hits zero and
  // reads as a bug; with it, the engine dies, the machine rolls to a stop, and
  // THEN the screen comes up.
  var DRY_GRACE = 1.8;
  // Getting home is never a straight line, and the reserve warning has to be
  // pessimistic or it is worse than useless.
  var RESERVE_PATH = 1.45;       // multiplier on the straight-line distance
  var RESERVE_SAFETY = 1.20;     // ...and then a margin on top of the estimate

  // --- heat ------------------------------------------------------------
  // Same division of labour as fuel: SM.mines.heatGainRate(layerHeat, drilling)
  // is the GAINING side of the balance and SM.rig.getHeatShed() is the shedding
  // side, and the two were tuned against each other. adv.js only integrates
  // them. The constants below are the fallback model for a build with no layer
  // tables: a flat ramp with depth, so the deep gate exists either way.
  var HEAT_AMBIENT_MAX = 12;     // points/sec at layer heat 1.0
  var HEAT_PER_KM = 8;           // points/sec per 1000 m of depth
  var OVERHEAT_DPS = 3;          // integrity points/sec while pinned at the cap
  var FALLBACK_HEAT_CAP = 100;
  var FALLBACK_HEAT_SHED = 6;

  // --- cargo -----------------------------------------------------------
  // Spoil (anything nobody will buy) is thrown out the back rather than stored.
  // Without this rule the hold fills with dirt in ten seconds and the volume
  // decision the mode is built around never happens.
  var STORE_WORTHLESS = false;
  var FALLBACK_CARGO_CAP = 40;

  // --- results ---------------------------------------------------------
  // A strand does not lose the ore, it LEAVES it: one pile per material, at the
  // wreck. This is the number that decides whether coming back is a plan or a
  // consolation prize. 1.0 = every unit is still there.
  var STRAND_RECOVERY = 1.0;

  /* ================================================================== */

  var A = SM.config.ADV;

  var state = 'off';

  /* --- the ledger (persists across runs) ------------------------------ */
  var cash = 0;
  var day = 1;
  var hull = HULL_POINTS;              // integrity in points, survives a run
  var rightsHeld = Object.create(null); // mineId -> true. Mirrored into save.js.
  var companyName = '';

  /* --- selection / loadout -------------------------------------------- */
  var selectedId = null;               // the mine the prep screen is about
  var tank = 0;                        // fuel bought and waiting in the tank
  var tankPaid = 0;                    // what the last descent launched with

  /* --- run state ------------------------------------------------------ */
  var runMineId = null;
  var mineDef = null;
  var runTime = 0;
  var depthM = 0, maxDepthM = 0;
  var fuel = 0, fuelCap = 1;
  var heat = 0, heatCap = FALLBACK_HEAT_CAP;
  var cargo = 0, cargoCap = 1;
  var exitArmed = false;               // must LEAVE the mouth before it counts
  var dryTimer = -1;                   // >= 0 once the tank has run dry
  var warnIndex = 0;                   // next FUEL_WARN threshold to fire
  var cargoFullSent = false;
  var burnRate = 0, burnAccum = 0;     // smoothed fuel draw, for the HUD needle
  var fuelAtEntry = 0;
  var results = null;

  /* --- the hold -------------------------------------------------------
   * Per-material rows in preallocated typed arrays, because offerCargo() is
   * called once per collected FRAGMENT — up to ~30 times a step. `manifest` is
   * a live array of entry objects that are mutated in place; entries are only
   * created the first time a material is seen and only removed when its holding
   * is dumped, so the HUD can hold the array reference forever.
   * ------------------------------------------------------------------ */
  var manifest = [];
  var matCount = 0;
  var slotOf = null;        // Int16Array: matIndex -> manifest slot, -1 = none
  var fragUnits = null;     // Float32Array: cargo units ONE FRAGMENT occupies
  var unitPrice = null;     // Float32Array: dollars per cargo unit
  var matHard = null;       // Float32Array: hardness, for vehicle.js's cap gate

  /* --- dropped cargo --------------------------------------------------
   * [x, y, matIndex, units] per pile. LIVE array; js/advterrain.js walks it and
   * calls consumePile(i) once it has re-spawned one as particles.
   * ------------------------------------------------------------------ */
  var piles = [];

  /* --- reused event payloads (never stashed) -------------------------- */
  var evState = { state: '', prev: '' };
  var evEntered = { mineId: '', depth: 0 };
  var evExtracted = { gross: 0, cargo: 0, depthM: 0, reason: '' };
  var evStranded = { reason: '', depthM: 0, lost: 0 };
  var evCash = { cash: 0, delta: 0, reason: '' };
  var evFuelLow = { pct: 0 };
  var evDumped = { matIndex: 0, units: 0, x: 0, y: 0 };
  var evRig = { partKey: '', tier: 0 };
  var evRights = { mineId: '', price: 0 };
  var evDay = { day: 1 };
  var evHeat = { pct: 0 };
  var evDamage = { integrity: 1, source: '' };
  var evSold = { gross: 0, cash: 0, day: 1 };

  var heatPctSent = -1;                // 1% granularity gate on adv:heat
  var dmgPctSent = -1;                 // ...and on adv:damage

  /* =====================================================================
   * THE FALLBACK MINE
   * ---------------------------------------------------------------------
   * SM.mines comes up as an empty catalogue, and a director with nothing to
   * descend into cannot be played or tested. This definition stands in until
   * Agent 2's table exists — resolveMine() prefers the catalogue in every case,
   * so it disappears the moment there is one entry to find.
   * ================================================================== */
  var FALLBACK_MINE = {
    id: 'shakedown',
    name: 'SHAKEDOWN SHAFT',
    region: 'Test Ground',
    mapX: 0.5, mapY: 0.5,
    price: 0,
    recDrill: 8,
    depth: 240,
    seed: 1337,
    common: ['dirt', 'stone'],
    rare: ['iron'],
    hazards: ['Unsurveyed'],
    blurb: 'A shaft nobody bothered to name. Good enough to shake the rig down.',
    layers: []
  };

  /* =====================================================================
   * SMALL GUARDED READS ACROSS THE SEAMS
   * ================================================================== */
  function rigNum(fn, dflt) {
    if (!SM.rig || typeof SM.rig[fn] !== 'function') return dflt;
    var v = SM.rig[fn]();
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : dflt;
  }

  function resolveMine(id) {
    if (SM.mines && SM.mines.get) {
      var m = SM.mines.get(id);
      if (m) return m;
    }
    // No catalogue yet (or an id from a save this build does not have): the
    // shakedown shaft keeps the mode playable instead of dead.
    if (SM.mines && SM.mines.count && SM.mines.count() > 0) return null;
    return FALLBACK_MINE;
  }

  function firstMineId() {
    if (SM.mines && SM.mines.getStarterId) {
      var id = SM.mines.getStarterId();
      if (id) return id;
    }
    return FALLBACK_MINE.id;
  }

  /** The layer covering the machine right now, or null while tables are empty. */
  function currentLayer() {
    if (!mineDef) return null;
    if (SM.mines && SM.mines.layerAt) {
      var l = SM.mines.layerAt(mineDef, depthM);
      if (l) return l;
    }
    if (SM.advterrain && SM.advterrain.layerAtY && SM.vehicle) {
      return SM.advterrain.layerAtY(SM.vehicle.getY());
    }
    return null;
  }

  function saveRecord() {
    return (SM.save && SM.save.get) ? SM.save.get() : null;
  }

  function mineRecord(id) {
    if (!id || !SM.save || !SM.save.mineState) return null;
    return SM.save.mineState(id);
  }

  function markDirty() {
    if (SM.save && SM.save.markDirty) SM.save.markDirty();
  }

  function flushSave() {
    if (SM.save && SM.save.flush) SM.save.flush();
  }

  /* =====================================================================
   * MATERIAL TABLES
   * ---------------------------------------------------------------------
   * Built on first use inside a mine — NOT in init(), because Agent 3 owns
   * materials.js and camera.js re-scales every hardness and value at load
   * (applyWorldDensity), so the numbers are only final once the page has
   * finished parsing. Rebuilt if the table ever grows underneath us.
   * ================================================================== */
  function ensureMatTables() {
    var M = SM.materials;
    var n = (M && M.count) ? M.count : 0;
    if (n === matCount && slotOf) return;

    matCount = n;
    slotOf = new Int16Array(n);
    fragUnits = new Float32Array(n);
    unitPrice = new Float32Array(n);
    matHard = new Float32Array(n);

    /* THE CATALOGUE'S ZEROS ARE MEANINGFUL. SM.mines quotes volume 0 / price 0
     * for SPOIL — dirt, stone, granite, obsidian — and that is the whole reason
     * a hold does not fill with topsoil in the first ten seconds. So the
     * material table is only consulted when there is no catalogue at all; the
     * moment there is one, its zeros are the answer. (Measured before this
     * split: dirt at a fallback $1/unit took 38 of the 48-unit starting hold.)
     */
    var haveEconomy = !!(SM.mines && SM.mines.count && SM.mines.count() > 0);

    for (var i = 0; i < n; i++) {
      slotOf[i] = -1;
      var mat = M.get(i);
      if (!mat) continue;
      matHard[i] = mat.hardness || 0;

      var vol, p;
      if (haveEconomy) {
        // Index-keyed fast paths exist precisely because offerCargo() runs on
        // the collection hot path; the string lookups are for the UI.
        vol = SM.mines.volumeOfIndex ? SM.mines.volumeOfIndex(i)
                                     : SM.mines.volumeOf(mat.id);
        p = SM.mines.priceOfIndex ? SM.mines.priceOfIndex(i)
                                  : SM.mines.priceOf(mat.id);
      } else {
        vol = 1;
        p = mat.value || 0;
      }
      if (!(vol > 0) || !(p > 0)) { fragUnits[i] = 0; unitPrice[i] = 0; continue; }

      // Volume is quoted PER DEPOSIT and cargo arrives as fragments, so one
      // fragment is one deposit's volume split over its debris count. Coal
      // being bulky therefore costs more hold per fragment, exactly as the
      // brief wants, with no per-fragment division on the hot path.
      var frags = mat.debrisCount > 0 ? mat.debrisCount : 1;
      fragUnits[i] = vol / frags;
      unitPrice[i] = p;
    }
  }

  /* =====================================================================
   * MODE + STATE
   * ================================================================== */
  /** True from open() until close(). main.js and ui.js branch on this. */
  function isActive() { return state !== 'off'; }
  /** True only during a descent — the one state where the world simulates. */
  function isInMine() { return state === 'mine'; }
  /** main.js: freeze the fixed step. True on every meta screen. */
  function holdsSim() { return isActive() && state !== 'mine'; }
  function getState() { return state; }

  function setState(next) {
    if (next === state) return;
    var prev = state;
    state = next;
    evState.state = next;
    evState.prev = prev;
    SM.events.emit('adv:state', evState);
  }

  function init() {
    // Nothing to build: adv.js owns no DOM and no pool. The only wiring is the
    // collection hook, and it is armed for the whole session because
    // `resource:collected` is far too hot to be subscribing and unsubscribing
    // around it — offerCargo() returns immediately when no run is live.
    SM.events.on('resource:collected', onCollected);
  }

  /* --- collection ------------------------------------------------------
   * HOT: up to ~30 calls per step. O(1), no allocation, no strings.
   * ------------------------------------------------------------------ */
  function onCollected(p) {
    if (state !== 'mine' || !p) return;
    if (offerCargo(p.matIndex)) return;

    /* THE HOLD IS FULL AND THIS FRAGMENT HAD ALREADY BEEN SWALLOWED.
     * vehicle.js drops the collector radius to zero the moment the hold fills,
     * so nothing NEW is captured — but ore that was already in flight arrives
     * anyway, and particles.js recycles the slot the instant it announces. Ore
     * must not evaporate, so the hopper spits it back onto the floor as loose
     * debris. COLLECT_DELAY plus a zero-radius collector means it cannot be
     * re-captured, and it is then simply lying there for after the dump. */
    if (SM.particles.spawnLoose) {
      var mat = SM.materials ? SM.materials.get(p.matIndex) : null;
      var r = (mat && mat.radius) ? mat.radius[0] * 0.55 : 4;
      SM.particles.spawnLoose(p.x, p.y, p.matIndex,
        (Math.random() * 2 - 1) * 110, (Math.random() * 2 - 1) * 110, r);
    }
  }

  /** Enter the campaign from the classic main menu. ui.js is the only caller. */
  function open() {
    if (state !== 'off') return;
    ensureMatTables();
    clearPause();
    setState('slots');
  }

  /**
   * Release main.js's pause gate.
   *
   * A campaign can be opened from a MENU THAT WAS REACHED FROM A PAUSED RUN —
   * ui.js's pause card has a MAIN MENU button and does not unpause on the way
   * out, because the classic path self-heals (a mode card calls main.restart(),
   * which clears it). Adventure never calls main.restart(), so it inherits the
   * stuck pause: measured, a descent entered that way sat at depth 0 with the
   * machine frozen and no on-screen reason why. Cheap to assert, impossible to
   * debug from the outside.
   */
  function clearPause() {
    if (SM.main && SM.main.isPaused && SM.main.isPaused()) SM.main.setPaused(false);
  }

  /** Leave the campaign. MUST call SM.ui.leaveAdventure() to restore the menu. */
  function close() {
    if (state === 'off') return;
    if (state === 'mine') teardownRun();
    hideRunChrome();
    setState('off');
    flushSave();
    // The classic world is still sitting where the expedition left it, so put
    // the menu back over a rebuilt time-attack lane rather than over a mine.
    if (SM.ui && SM.ui.leaveAdventure) SM.ui.leaveAdventure();
    if (SM.main && SM.main.restart) SM.main.restart();
  }

  /* --- screen transitions (js/advui.js drives these) ------------------- */

  /** A slot is loaded -> adopt its ledger and go to the map. */
  function startCompany() {
    var r = saveRecord();
    if (r) {
      cash = typeof r.cash === 'number' ? r.cash : START_CASH;
      day = typeof r.day === 'number' && r.day > 0 ? r.day : 1;
      companyName = r.company || '';
      // `integrity` is not in save.js's documented schema; it is written back
      // as an addition and read defensively, so an older or stricter record
      // simply starts with a sound hull.
      hull = typeof r.integrity === 'number'
        ? Math.max(0, Math.min(1, r.integrity)) * HULL_POINTS : HULL_POINTS;
      if (r.mines) {
        for (var id in r.mines) {
          if (r.mines[id] && r.mines[id].owned) rightsHeld[id] = true;
        }
      }
    } else {
      // No save module yet: a playable default company.
      cash = (SM.mines && SM.mines.startingCash) ? SM.mines.startingCash() : START_CASH;
      day = 1;
      hull = HULL_POINTS;
      companyName = companyName || 'SHAKEDOWN CO';
    }
    // Anything that costs nothing is yours by definition.
    var all = (SM.mines && SM.mines.getAll) ? SM.mines.getAll() : null;
    if (all && all.length) {
      for (var i = 0; i < all.length; i++) {
        if (!all[i].price) rightsHeld[all[i].id] = true;
      }
    } else {
      rightsHeld[FALLBACK_MINE.id] = true;
    }
    clearHold();
    tank = 0;
    setState('map');
  }

  function openMap() { if (isActive() && state !== 'mine') setState('map'); }
  function openGarage() { if (isActive() && state !== 'mine') setState('garage'); }
  function backToMap() { openMap(); }

  /** -> prep, if the rights are held. */
  function selectMine(mineId) {
    if (state === 'mine') return false;
    var def = resolveMine(mineId);
    if (!def) return false;
    if (!ownsRights(def.id)) return false;      // the map buys them first
    selectedId = def.id;
    tank = 0;                                   // the prep screen fills the tank
    setState('prep');
    return true;
  }

  function ownsRights(id) {
    if (rightsHeld[id]) return true;
    if (SM.save && SM.save.isOwned && SM.save.isOwned(id)) return true;
    var def = resolveMine(id);
    return !!(def && !def.price);
  }

  /* =====================================================================
   * THE DESCENT
   * ================================================================== */

  /**
   * Begin a run. `loadout` is {fuel:units} paid for on the prep screen — it is
   * OPTIONAL: buyFuel() has normally already filled the tank, and the argument
   * exists so a caller (or a console) can top up in the same breath.
   */
  function enterMine(mineId, loadout) {
    if (state === 'mine') return false;
    var def = resolveMine(mineId || selectedId);
    if (!def) return false;
    if (!ownsRights(def.id)) return false;
    if (loadout && loadout.fuel > 0) buyFuel(loadout.fuel);

    ensureMatTables();

    runMineId = def.id;
    selectedId = def.id;
    mineDef = def;

    fuelCap = rigNum('getFuelCap', 100);
    cargoCap = rigNum('getCargoCap', FALLBACK_CARGO_CAP);
    heatCap = rigNum('getHeatCap', FALLBACK_HEAT_CAP);

    fuel = tank > fuelCap ? fuelCap : tank;
    fuelAtEntry = fuel;
    tankPaid = fuel;
    tank = 0;

    runTime = 0;
    depthM = 0;
    maxDepthM = 0;
    heat = 0;
    exitArmed = false;
    dryTimer = -1;
    warnIndex = 0;
    cargoFullSent = false;
    burnRate = 0;
    burnAccum = 0;
    heatPctSent = -1;
    dmgPctSent = -1;
    results = null;
    clearHold();

    // Piles left in THIS mine on a previous visit. The array identity is kept
    // because js/advterrain.js holds the reference.
    piles.length = 0;
    var ms = mineRecord(def.id);
    if (ms && ms.piles && ms.piles.length) {
      for (var i = 0; i < ms.piles.length; i++) {
        var p = ms.piles[i];
        if (p && p.length >= 4) piles.push([p[0], p[1], p[2], p[3]]);
      }
    }

    /* --- rebuild the world -------------------------------------------
     * main.restart()'s order, for the same reasons it documents: the vehicle
     * and the camera first so the streamer sizes its window from the real
     * view, then an empty pool, then the geology, then the presentation
     * layers. advterrain.beginMine() lands between the two so terrain.reset()
     * already knows which mine it is generating.
     * ------------------------------------------------------------------ */
    SM.vehicle.reset();
    SM.camera.reset();
    SM.particles.reset();
    if (SM.advterrain && SM.advterrain.beginMine) SM.advterrain.beginMine(def, ms);
    SM.terrain.reset();
    SM.effects.reset();
    SM.sound.reset();
    SM.input.reset();
    if (SM.scanner && SM.scanner.reset) SM.scanner.reset();
    if (SM.advhud && SM.advhud.reset) SM.advhud.reset();
    clearPause();                  // see clearPause(): a descent must not open frozen

    setState('mine');

    evEntered.mineId = def.id;
    evEntered.depth = def.depth || 0;
    SM.events.emit('adv:entered', evEntered);

    // Chrome comes up AFTER the state event, so an Agent-4 handler that opens
    // its own HUD off `adv:state` has already run and these are no-ops.
    showRunChrome();
    return true;
  }

  function showRunChrome() {
    if (SM.advui && SM.advui.closeAll) SM.advui.closeAll();
    if (SM.advhud && SM.advhud.show) SM.advhud.show();
    if (SM.joystick && SM.joystick.show) SM.joystick.show();
  }

  function hideRunChrome() {
    if (SM.joystick && SM.joystick.hide) SM.joystick.hide();
    if (SM.advhud && SM.advhud.hide) SM.advhud.hide();
  }

  /** Close the mine down and hand the carve mask back to the save record. */
  function teardownRun() {
    clearPause();
    var ms = mineRecord(runMineId);
    if (SM.advterrain && SM.advterrain.endMine) {
      var mask = SM.advterrain.endMine();
      if (ms && typeof mask === 'string' && mask) ms.mask = mask;
    }
    if (ms) {
      ms.visits = (ms.visits || 0) + 1;
      if (maxDepthM > (ms.deepestM || 0)) ms.deepestM = Math.round(maxDepthM);
      ms.piles = pilesForSave();
      markDirty();
    }
    if (SM.particles.clearCollectorTarget) SM.particles.clearCollectorTarget();
    hideRunChrome();
  }

  function pilesForSave() {
    var out = [];
    for (var i = 0; i < piles.length; i++) {
      var p = piles[i];
      out.push([Math.round(p[0]), Math.round(p[1]), p[2], p[3]]);
    }
    return out;
  }

  /** Build the results record. Allocation is fine: this runs once per descent. */
  function buildResults(kind, reason, gross) {
    var lines = [];
    for (var i = 0; i < manifest.length; i++) {
      var e = manifest[i];
      if (e.units <= 0) continue;
      lines.push({ matId: e.matId, matIndex: e.matIndex, units: e.units, value: e.value });
    }
    results = {
      kind: kind,
      reason: reason || '',
      mineId: runMineId,
      mineName: mineDef ? mineDef.name : '',
      depthM: depthM,
      maxDepthM: maxDepthM,
      runTime: runTime,
      gross: gross,
      cargoUnits: cargo,
      cargoCap: cargoCap,
      fuelLeft: fuel,
      fuelUsed: fuelAtEntry - fuel,
      integrity: hull / HULL_POINTS,
      day: day,
      lines: lines
    };
    return results;
  }

  /** Reached the mine mouth with the hold intact: bank it. -> results. */
  function escape() {
    if (state !== 'mine') return false;
    var gross = holdValue();
    teardownRun();
    buildResults('extracted', 'mouth', gross);
    setState('results');

    evExtracted.gross = gross;
    evExtracted.cargo = cargo;
    evExtracted.depthM = maxDepthM;
    evExtracted.reason = 'mouth';
    SM.events.emit('adv:extracted', evExtracted);
    flushSave();
    return true;
  }

  /**
   * Out of fuel or hull: the cargo is left where it stands. -> results.
   * It is DROPPED, not deleted — one pile per material at the wreck — which is
   * what turns a bad run into a reason to come back rather than a punishment.
   */
  function strand(reason) {
    if (state !== 'mine') return false;
    var lost = holdValue();
    var vx = SM.vehicle.getX(), vy = SM.vehicle.getY();

    /* BUILD THE RESULTS FIRST, while the manifest still exists. The extraction
     * screen has to be able to say exactly what was left behind and where —
     * that itemised list is what turns a lost run into a plan to come back —
     * and buildResults() reads the hold, which the next two lines empty. */
    buildResults('stranded', reason || 'unknown', 0);
    results.lost = lost;

    for (var i = 0; i < manifest.length; i++) {
      var e = manifest[i];
      if (e.units <= 0) continue;
      dropPile(e.matIndex, e.units * STRAND_RECOVERY, vx, vy);
    }
    clearHold();

    // AFTER the piles are dropped: teardownRun() is what writes them into the
    // save record, so it has to see the full set.
    teardownRun();
    setState('results');

    evStranded.reason = reason || 'unknown';
    evStranded.depthM = depthM;
    evStranded.lost = lost;
    SM.events.emit('adv:stranded', evStranded);
    flushSave();
    return true;
  }

  /** Give up the descent from the pause menu; same cost as a strand. */
  function abort() {
    if (state !== 'mine') return false;
    return strand('abort');
  }

  /**
   * main.js hands R / input:restart here.
   *
   * A DO-OVER, NOT A STRAND. The tank goes back to what the player paid for,
   * the hold is emptied without dropping piles and the day does not advance —
   * an accidental R must not cost a company money, and a deliberate one is the
   * "that descent went wrong immediately" reset every arcade build needs.
   * Refused outside a run, because on a meta screen R would otherwise rebuild
   * the classic time-attack world under the world map.
   */
  function restart() {
    if (state !== 'mine' && state !== 'results') return false;
    var id = runMineId;
    var refill = tankPaid;
    if (state === 'mine') teardownRun();
    clearHold();
    piles.length = 0;
    setState('prep');
    tank = refill;
    return enterMine(id, null);
  }

  /* =====================================================================
   * UPDATE
   * ================================================================== */
  function update(dt) {
    if (state !== 'mine') return;

    runTime += dt;

    /* --- depth ------------------------------------------------------- */
    var vy = SM.vehicle.getY();
    depthM = (vy - A.MINE_CEILING_Y) * A.METERS_PER_UNIT;
    if (depthM < 0) depthM = 0;
    if (depthM > maxDepthM) maxDepthM = depthM;

    /* --- the scanner --------------------------------------------------
     * main.js's step order has no slot for it — adv.js is the adventure
     * director, so the instrument runs from here and pays for itself out of
     * the same tank as everything else.
     * ------------------------------------------------------------------ */
    var scanDraw = 0;
    if (SM.scanner && SM.scanner.update) {
      SM.scanner.update(dt);
      if (SM.scanner.getDraw) {
        var d = SM.scanner.getDraw();
        if (d > 0) scanDraw = d;
      }
    }
    // A fitted scanner that reports no draw is a scanner module that has not
    // implemented getDraw() yet — charge rig.js's rate for it so the fuel
    // budget stays honest, and defer to the instrument the moment it speaks.
    if (scanDraw <= 0 && rigNum('getScanRange', 0) > 0) {
      scanDraw = rigNum('getScanBurn', 0);
    }

    /* --- standing fuel draw ------------------------------------------
     * The always-on part of rig.js's published budget. Driving and drilling are
     * vehicle.js's to report, because it is the only module that knows the duty
     * cycle it actually ran this step.
     * ------------------------------------------------------------------ */
    var standing = rigNum('getIdleBurn', FALLBACK_IDLE_BURN)
                 + rigNum('getLightBurn', FALLBACK_LIGHT_BURN)
                 + rigNum('getCoolBurn', 0)
                 + scanDraw;
    burnFuel(standing * dt);

    // Smoothed needle. burnAccum is filled by every burnFuel() call this step,
    // including the ones vehicle.js made for driving and drilling.
    var inst = burnAccum / dt;
    burnRate += (inst - burnRate) * (1 - Math.exp(-4 * dt));
    burnAccum = 0;

    /* --- heat --------------------------------------------------------
     * Ambient is the soft depth gate; drilling heat arrives through addHeat().
     * ------------------------------------------------------------------ */
    var layer = currentLayer();
    var cutting = !!(SM.vehicle.isCutting && SM.vehicle.isCutting());
    var ambient;
    if (SM.mines && SM.mines.heatGainRate && layer) {
      // The shared model: ambient for the layer, plus the drill's own
      // contribution while it is removing hardness.
      ambient = SM.mines.heatGainRate(layer.heat, cutting);
    } else {
      ambient = (depthM / 1000) * HEAT_PER_KM;
      if (layer && typeof layer.heat === 'number') {
        var la = layer.heat * HEAT_AMBIENT_MAX;
        if (la > ambient) ambient = la;
      }
    }
    heat += (ambient - rigNum('getHeatShed', FALLBACK_HEAT_SHED)) * dt;
    if (heat < 0) heat = 0;
    /* AT the cap, not PAST it. addHeat() already clamps, so a machine pinned at
     * the ceiling by drilling heat would otherwise sit there taking no damage
     * at all whenever ambient happened to be below what cooling sheds — which
     * is most of the game. `>=` is what makes "at the cap the hull burns" true. */
    if (heat >= heatCap) {
      heat = heatCap;
      damage(OVERHEAT_DPS * dt, 'heat');
      // damage() can end the run outright (hull 0 -> strand), and everything
      // below this line is run bookkeeping that has no meaning once it has.
      if (state !== 'mine') return;
    }
    var hp = (heatCap > 0 ? heat / heatCap : 0) * 100 | 0;
    if (hp !== heatPctSent) {
      heatPctSent = hp;
      evHeat.pct = heatCap > 0 ? heat / heatCap : 0;
      SM.events.emit('adv:heat', evHeat);
    }

    /* --- fuel warnings and the dry strand ---------------------------- */
    var pct = getFuelPct();
    while (warnIndex < FUEL_WARN.length && pct <= FUEL_WARN[warnIndex]) {
      warnIndex++;
      evFuelLow.pct = pct;
      SM.events.emit('adv:fuellow', evFuelLow);
    }
    if (fuel <= 0) {
      if (dryTimer < 0) dryTimer = 0;
      dryTimer += dt;
      // The machine is already limp — vehicle.js sees an empty tank — so this
      // is purely the beat between the engine dying and the screen coming up.
      if (dryTimer >= DRY_GRACE) { strand('fuel'); return; }
    } else if (dryTimer >= 0) {
      dryTimer = -1;                    // a dump-and-refuel is not a thing, but
    }                                   // a fuel pile pickup could be one day

    /* --- the mouth ---------------------------------------------------
     * Auto-extraction, ARMED only once the machine has actually left. Without
     * the arming step every descent would end on the frame it began.
     * ------------------------------------------------------------------ */
    var dist = getDistanceToExit();
    if (!exitArmed) {
      if (dist > A.EXIT_RADIUS * 1.6) exitArmed = true;
    } else if (dist <= A.EXIT_RADIUS) {
      escape();
      return;
    }
  }

  /** Inside the world transform, AFTER effects: scanner marks, then darkness. */
  function renderWorld(ctx) {
    if (SM.scanner && SM.scanner.render) SM.scanner.render(ctx);
    // LAST. The darkness composite has to fall on the terrain, the machine, the
    // debris AND the scanner overlay, so nothing may draw after it.
    if (SM.effects && SM.effects.renderDarkness) SM.effects.renderDarkness(ctx);
  }

  /* =====================================================================
   * RUN STATE — read by advhud.js, written by vehicle.js and update()
   * ================================================================== */
  function getMine() { return mineDef; }
  function getRunTime() { return runTime; }
  function getDepthM() { return depthM; }
  function getMaxDepthM() { return maxDepthM; }

  /** World units back to the mine mouth, in a straight line. */
  function getDistanceToExit() {
    if (!SM.vehicle) return 0;
    var dx = SM.vehicle.getX();
    var dy = SM.vehicle.getY() - A.MINE_CEILING_Y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function getFuel() { return fuel; }
  function getFuelCap() { return fuelCap > 0 ? fuelCap : 1; }
  function getFuelPct() { return fuelCap > 0 ? fuel / fuelCap : 0; }
  function getBurnRate() { return burnRate; }

  /**
   * Rough fuel needed to get home from here. Deliberately pessimistic: the
   * straight line is multiplied out for the tunnel you actually have to drive,
   * and the whole estimate carries a safety margin, because a reserve gauge
   * that is optimistic is worse than no gauge at all.
   */
  function getReserveNeeded() {
    if (state !== 'mine') return 0;
    var speed = rigNum('getSpeed', SM.config.VEHICLE_SPEED);
    var seconds = (getDistanceToExit() * RESERVE_PATH) / (speed > 1 ? speed : 1);
    // rig.js exports getBurnEstimate() so that this warning and the prep
    // screen's fuel slider agree with the tank sizes instead of each inventing
    // its own coefficients. Coming home is mostly DRIVING, with the odd cut
    // through a collapsed stretch of your own tunnel: 0.25 drill / 0.95 drive.
    var draw;
    if (SM.rig && SM.rig.getBurnEstimate) draw = SM.rig.getBurnEstimate(0.25, 0.95);
    else {
      draw = rigNum('getIdleBurn', FALLBACK_IDLE_BURN)
           + rigNum('getLightBurn', FALLBACK_LIGHT_BURN);
      if (SM.vehicle && SM.vehicle.getDriveBurnRate) draw += SM.vehicle.getDriveBurnRate();
    }
    return seconds * draw * RESERVE_SAFETY;
  }

  function getCargo() { return cargo; }
  function getCargoCap() { return cargoCap > 0 ? cargoCap : 1; }
  function getCargoPct() { return cargoCap > 0 ? cargo / cargoCap : 0; }
  /** LIVE array [{matIndex, matId, units, value}], richest last. REUSED. */
  function getManifest() { return manifest; }

  function getHeat() { return heat; }
  function getHeatPct() { return heatCap > 0 ? heat / heatCap : 0; }
  function getIntegrity() { return hull / HULL_POINTS; }
  function getHullPoints() { return hull; }

  function getCash() { return cash; }
  function getDay() { return day; }
  function getCompany() { return companyName; }
  /** True while the tank is empty and the machine is coasting to its grave. */
  function isDry() { return dryTimer >= 0; }

  /* =====================================================================
   * WRITES — vehicle.js is the only caller of these
   * ================================================================== */

  /** Draw fuel. Returns the amount ACTUALLY drawn (0 when the tank is dry). */
  function burnFuel(units) {
    if (state !== 'mine' || !(units > 0)) return 0;
    var got = units < fuel ? units : fuel;
    if (got <= 0) { fuel = 0; return 0; }
    fuel -= got;
    if (fuel < 0) fuel = 0;
    burnAccum += got;
    return got;
  }

  function addHeat(points) {
    if (state !== 'mine' || !(points > 0)) return;
    heat += points;
    if (heat > heatCap) heat = heatCap;
  }

  /**
   * Chew the hull. `source` is optional and only travels in the event, so
   * advhud.js can say WHAT hit you ('heat', 'grind', 'cavein').
   */
  function damage(points, source) {
    if (!(points > 0) || hull <= 0) return;
    var soak = 1 + rigNum('getArmor', 0) * ARMOR_DIV;
    hull -= points / soak;
    if (hull < 0) hull = 0;

    // Rate gate: this is called every step by continuous wear. Announce on a
    // 1% change or on a real hit, never per tick.
    var pctI = (hull / HULL_POINTS * 100) | 0;
    if (pctI !== dmgPctSent || points >= 1) {
      dmgPctSent = pctI;
      evDamage.integrity = hull / HULL_POINTS;
      evDamage.source = source || '';
      SM.events.emit('adv:damage', evDamage);
    }
    if (hull <= 0 && state === 'mine') strand('hull');
  }

  /**
   * Offer a collected deposit. -> true if it fit, false if the hold is full.
   * HOT: called once per collected fragment. O(1), no allocation.
   */
  function offerCargo(mi) {
    if (state !== 'mine') return false;
    if (!slotOf || mi < 0 || mi >= matCount) return false;

    var price = unitPrice[mi];
    if (price <= 0 && !STORE_WORTHLESS) return true;   // spoil: out the back

    var u = fragUnits[mi];
    if (!(u > 0)) return true;
    if (cargo + u > cargoCap) {
      if (!cargoFullSent) {
        cargoFullSent = true;
        SM.events.emit('adv:cargofull', null);
      }
      return false;
    }
    cargo += u;

    var s = slotOf[mi];
    if (s < 0) s = addManifestEntry(mi);
    var e = manifest[s];
    e.units += u;
    e.value = e.units * price;
    return true;
  }

  /**
   * Create the manifest row for a material. Rare (once per material per run),
   * so it may allocate and re-sort. Sorted by price so the HUD's "richest last"
   * ordering is stable no matter what order the ore arrived in.
   */
  function addManifestEntry(mi) {
    var mat = SM.materials ? SM.materials.get(mi) : null;
    manifest.push({
      matIndex: mi,
      matId: mat ? mat.id : ('mat' + mi),
      units: 0,
      value: 0,
      price: unitPrice[mi]
    });
    manifest.sort(function (a, b) { return a.price - b.price; });
    reindexManifest();
    return slotOf[mi];
  }

  function reindexManifest() {
    var i;
    for (i = 0; i < matCount; i++) slotOf[i] = -1;
    for (i = 0; i < manifest.length; i++) slotOf[manifest[i].matIndex] = i;
  }

  function clearHold() {
    manifest.length = 0;
    cargo = 0;
    cargoFullSent = false;
    if (slotOf) for (var i = 0; i < matCount; i++) slotOf[i] = -1;
  }

  function holdValue() {
    var v = 0;
    for (var i = 0; i < manifest.length; i++) v += manifest[i].value;
    return v;
  }

  /* --- cargo piles ---------------------------------------------------- */
  /** LIVE array of [x, y, matIndex, units]. advterrain.js reads this. */
  function getPiles() { return piles; }

  /** Tip the whole holding of one material onto the floor, here. */
  function dump(matIndex) {
    if (state !== 'mine' || !slotOf) return false;
    if (matIndex < 0 || matIndex >= matCount) return false;
    var s = slotOf[matIndex];
    if (s < 0) return false;
    var e = manifest[s];
    var units = e.units;
    if (units <= 0) return false;

    cargo -= units;
    if (cargo < 0) cargo = 0;
    manifest.splice(s, 1);
    reindexManifest();
    // Space again: re-arm the full warning so the next fill still announces.
    cargoFullSent = false;

    dropPile(matIndex, units, SM.vehicle.getX(), SM.vehicle.getY());
    return true;
  }

  function dropPile(matIndex, units, x, y) {
    piles.push([x, y, matIndex, units]);
    evDumped.matIndex = matIndex;
    evDumped.units = units;
    evDumped.x = x;
    evDumped.y = y;
    SM.events.emit('adv:dumped', evDumped);
    markDirty();
  }

  /** advterrain.js: this pile has been re-spawned as particles, forget it. */
  function consumePile(i) {
    if (i < 0 || i >= piles.length) return false;
    piles.splice(i, 1);
    markDirty();
    return true;
  }

  /* =====================================================================
   * THE LEDGER — advui.js drives these; nothing else moves money
   * ================================================================== */
  function canAfford(amount) { return cash >= amount; }

  function moveCash(delta, reason) {
    cash += delta;
    if (cash < 0) cash = 0;
    var r = saveRecord();
    if (r) { r.cash = cash; markDirty(); }
    evCash.cash = cash;
    evCash.delta = delta;
    evCash.reason = reason || '';
    SM.events.emit('adv:cash', evCash);
  }

  function buyRights(mineId) {
    if (state === 'mine') return false;
    var def = resolveMine(mineId);
    if (!def) return false;
    if (ownsRights(def.id)) return false;
    var price = def.price || 0;
    if (!canAfford(price)) return false;

    moveCash(-price, 'rights');
    rightsHeld[def.id] = true;
    if (SM.save && SM.save.setOwned) SM.save.setOwned(def.id, true);
    evRights.mineId = def.id;
    evRights.price = price;
    SM.events.emit('adv:rights', evRights);
    flushSave();
    return true;
  }

  /**
   * Buy fuel into the tank. Charges only for what actually FITS — a slider
   * that lets you pay for litres the tank cannot hold is a bug, not a lesson.
   */
  function buyFuel(units) {
    if (state === 'mine' || !(units > 0)) return false;
    var cap = rigNum('getFuelCap', 100);
    fuelCap = cap;
    var room = cap - tank;
    if (room <= 0) return false;
    if (units > room) units = room;

    var price = 1;
    if (SM.mines && SM.mines.fuelPrice) {
      var p = SM.mines.fuelPrice();
      if (typeof p === 'number' && p > 0) price = p;
    }
    /* ASK SM.mines FOR THE COST; never multiply it out here. fuelCost() rounds
     * UP, and 100 * 0.55 is 55.000000000000006 in binary floating point, so a
     * price computed independently of the one the prep screen quoted can differ
     * from it by a dollar — in the direction of overcharging the player. One
     * function, one answer. */
    var cost = quoteFuel(units, price);
    if (!canAfford(cost)) {
      // Buy what the money reaches rather than refusing outright: the prep
      // screen's slider is allowed to be optimistic. Whole units, so the
      // rounding-up in fuelCost() can never land above the cash on hand.
      units = Math.floor(cash / price);
      if (units < 1) return false;
      cost = quoteFuel(units, price);
      // Cash can be fractional after a sale; shave one unit if the ceil bit.
      if (cost > cash) { units -= 1; cost = quoteFuel(units, price); }
      if (units < 1 || cost > cash) return false;
    }
    tank += units;
    moveCash(-cost, 'fuel');
    return true;
  }

  /** Dollars for `units` of fuel, exactly as the prep screen quotes it. */
  function quoteFuel(units, price) {
    if (SM.mines && SM.mines.fuelCost) return SM.mines.fuelCost(units);
    return Math.ceil(units * price);
  }

  function getTank() { return tank; }

  function buyPart(partKey) {
    if (state === 'mine' || !SM.rig) return false;
    var cost = SM.rig.nextCost ? SM.rig.nextCost(partKey) : -1;
    if (!(cost >= 0)) return false;
    if (!canAfford(cost)) return false;
    var tier = (SM.rig.getTier ? SM.rig.getTier(partKey) : 0) + 1;
    if (SM.rig.setTier) SM.rig.setTier(partKey, tier);

    moveCash(-cost, 'part');
    // NOT r.rig = SM.rig.getState() — js/save.js snapshots the rig itself in
    // flush(), and installs it in load()/newGame(). Two writers, one field, is
    // how a machine ends up half a tier behind its own save.
    markDirty();
    evRig.partKey = partKey;
    evRig.tier = tier;
    SM.events.emit('adv:rig', evRig);
    flushSave();
    return true;
  }

  /**
   * Repair the hull. Buys as many POINTS as the money reaches rather than
   * refusing a partial job — a broke player with a wrecked machine must always
   * have a way forward, even if it is a bad one.
   */
  function buyRepair() {
    if (state === 'mine') return false;
    var missing = HULL_POINTS - hull;
    if (missing <= 0.01) return false;
    var price = 1;
    if (SM.mines && SM.mines.repairPrice) {
      var p = SM.mines.repairPrice();
      if (typeof p === 'number' && p > 0) price = p;
    }
    /* UNITS TRAP: repairPrice() is dollars per point on a 0..100 scale while
     * getIntegrity() reports 0..1, so anything that multiplies the fraction by
     * the price is out by 100x. repairCost(frac) is the quoted price of the
     * whole job and is what the workshop shows, so a full repair is charged
     * exactly that; a partial one falls back to the per-POINT price. */
    var full = (SM.mines && SM.mines.repairCost)
      ? SM.mines.repairCost(hull / HULL_POINTS) : Math.ceil(missing * price);
    var points, cost;
    if (canAfford(full)) {
      points = missing;
      cost = full;
    } else {
      points = Math.floor(cash / price);
      if (points < 1) return false;
      cost = points * price;
      if (cost > cash) { points -= 1; cost = points * price; }
      if (points < 1) return false;
    }

    hull += points;
    if (hull > HULL_POINTS) hull = HULL_POINTS;
    moveCash(-cost, 'repair');
    var r = saveRecord();
    if (r) { r.integrity = hull / HULL_POINTS; markDirty(); }
    evDamage.integrity = hull / HULL_POINTS;
    evDamage.source = 'repair';
    SM.events.emit('adv:damage', evDamage);
    return true;
  }

  /**
   * Sell the extracted hold and step back to the map. Also the DAY ROLLOVER:
   * one expedition is one day, and it ticks when the company banks the run
   * rather than when it starts one, so an aborted descent is not a lost day on
   * top of a lost hold.
   */
  function sell() {
    if (state !== 'results') return null;
    var lines = [];
    var gross = 0;
    for (var i = 0; i < manifest.length; i++) {
      var e = manifest[i];
      if (e.units <= 0) continue;
      lines.push({ matId: e.matId, units: e.units, value: e.value });
      gross += e.value;
    }
    clearHold();

    // Cargo units are fractional (a fragment of a deposit is a fraction of its
    // volume) but MONEY is not, and js/save.js floors `cash` on load — so the
    // gross is rounded here, once, at the moment it becomes money. Otherwise
    // the ledger drifts from the saved one and every screen prints $1705.4000007.
    gross = Math.round(gross);
    if (gross > 0) moveCash(gross, 'sale');

    var r = saveRecord();
    if (r) {
      r.integrity = hull / HULL_POINTS;
      if (!r.stats) r.stats = { hauled: 0, bestHaul: 0, runs: 0 };
      r.stats.hauled = (r.stats.hauled || 0) + gross;
      if (gross > (r.stats.bestHaul || 0)) r.stats.bestHaul = gross;
      r.stats.runs = (r.stats.runs || 0) + 1;
    }

    day++;
    if (r) r.day = day;
    evDay.day = day;
    SM.events.emit('adv:day', evDay);

    evSold.gross = gross;
    evSold.cash = cash;
    evSold.day = day;
    SM.events.emit('adv:sold', evSold);

    flushSave();
    setState('map');
    return { gross: gross, lines: lines };
  }

  /** The results payload for the extraction screen. Set by escape()/strand(). */
  function getResults() { return results; }

  /** vehicle.js: use free-roam 2D driving instead of the classic auto-advance. */
  function isDriving() { return state === 'mine'; }

  return {
    init: init,
    isActive: isActive,
    isInMine: isInMine,
    holdsSim: holdsSim,
    getState: getState,
    open: open,
    close: close,
    startCompany: startCompany,
    openMap: openMap,
    openGarage: openGarage,
    selectMine: selectMine,
    backToMap: backToMap,
    enterMine: enterMine,
    escape: escape,
    strand: strand,
    abort: abort,
    restart: restart,
    update: update,
    renderWorld: renderWorld,
    getMine: getMine,
    getRunTime: getRunTime,
    getDepthM: getDepthM,
    getMaxDepthM: getMaxDepthM,
    getDistanceToExit: getDistanceToExit,
    getFuel: getFuel,
    getFuelCap: getFuelCap,
    getFuelPct: getFuelPct,
    getBurnRate: getBurnRate,
    getReserveNeeded: getReserveNeeded,
    getCargo: getCargo,
    getCargoCap: getCargoCap,
    getCargoPct: getCargoPct,
    getManifest: getManifest,
    getHeat: getHeat,
    getHeatPct: getHeatPct,
    getIntegrity: getIntegrity,
    getCash: getCash,
    getDay: getDay,
    burnFuel: burnFuel,
    addHeat: addHeat,
    damage: damage,
    offerCargo: offerCargo,
    getPiles: getPiles,
    dump: dump,
    consumePile: consumePile,
    canAfford: canAfford,
    buyRights: buyRights,
    buyFuel: buyFuel,
    buyPart: buyPart,
    buyRepair: buyRepair,
    sell: sell,
    getResults: getResults,
    isDriving: isDriving,

    /* --- Agent-1 additions (safe to call; nothing above depends on them) --
     * getTank()       fuel bought but not yet descended with — the prep gauge
     * getHullPoints() integrity in the same points repairPrice() is quoted in
     * getCompany()    the company name, for the map header
     * isDry()         the tank is empty and the machine is coasting
     * ownsRights()    has this company bought into that mine
     * getFirstMineId() the starter mine, catalogue or fallback
     */
    getTank: getTank,
    getHullPoints: getHullPoints,
    getCompany: getCompany,
    isDry: isDry,
    ownsRights: ownsRights,
    getFirstMineId: firstMineId
  };
})();
