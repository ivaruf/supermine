/* =============================================================================
 * SUPERMINE — js/advui.js                          [OWNER: Agent 4 — INTERFACE]
 * -----------------------------------------------------------------------------
 * EVERYTHING THAT IS NOT THE MINE. Five screens, all DOM, all built at runtime
 * into #ui-root exactly the way js/ui.js builds the classic HUD.
 *
 * ---------------------------------------------------------------------------
 * THE SCREENS
 *
 * SLOTS — three mining companies.
 *     NEW GAME, or resume a slot showing company / day / cash / machine tier /
 *     mines owned. Erase needs a confirm. This is the first thing a player sees
 *     after tapping ADVENTURE, so it reads like a ledger, not a settings dialog.
 *
 * MAP — the interactive world map, and the heart of the meta game.
 *     Pins for every mine in SM.mines.getAll(), placed at mapX/mapY, over
 *     regions that reveal themselves as the company grows. A pin you own reads
 *     differently from one you can buy, and one you cannot afford differently
 *     again. Tapping a pin opens the mine card, which puts the player's ACTUAL
 *     drill power next to the recommendation — "you can enter, but it will
 *     hurt" is a more interesting message than a locked door. The map is also
 *     where the WORKSHOP door lives.
 *
 * GARAGE — the workshop, and it is not a list of stat lines.
 *     The machine is DRAWN, large, and the eight parts are hotspots ON it.
 *     The drawing is the REAL vehicle renderer (SM.vehicle.render) called into
 *     a garage transform, not a second illustration: js/vehicle.js already
 *     builds every part off SM.rig.getPartFlags(), so this screen cannot drift
 *     from the machine the player actually drives — and watching the pathetic
 *     starting drill become an industrial monster IS the progression.
 *
 * PREP — the last screen before the dark.
 *     Buy fuel on a slider, read the strata you are about to drive through,
 *     repair the hull, and commit. DESCEND is the point of no return.
 *
 * RESULTS — the payoff.
 *     The manifest, line by line, counting up into a total, because this is the
 *     screen that has to make a full hold feel good. And it is honest about a
 *     bad run: a strand shows what was lost and how deep, because that is what
 *     turns "I'll come back for it" into a plan.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS DRIVEN
 *   js/adv.js owns the state machine and emits `adv:state` {state, prev} on
 *   every transition. This module reacts to THAT and nothing else: a button
 *   calls a verb on SM.adv and the resulting `adv:state` is what opens the next
 *   screen. One direction of control, one source of truth.
 *
 *   THE ONE CONCESSION: a 4 Hz watchdog reconciles the visible screen against
 *   SM.adv.getState() while the campaign is active. It is not a second state
 *   machine — it holds no state of its own and only ever copies adv's — it is
 *   there because a missed or late event would otherwise leave the player
 *   looking at a black screen with no way back, which is the single worst
 *   failure this module can have.
 *
 *   Unlike advhud.js these screens are STATIC between clicks and main.js is not
 *   stepping the simulation behind them (SM.adv.holdsSim()), so they may
 *   measure and allocate freely. The results count-up runs its own rAF loop for
 *   exactly that reason.
 * ========================================================================== */

var SM = SM || {};

SM.advui = (function () {
  'use strict';

  /* ----- Agent-4 tunables live here ----------------------------------- */

  var TOAST_TIME     = 2.6;    // seconds a toast lingers
  var SYNC_MS        = 250;    // watchdog period (see "HOW IT IS DRIVEN")
  var GARAGE_VIEW_H  = 420;    // world units of machine framed by the garage
  var GARAGE_MIN_S   = 0.22;   // never shrink the machine past this scale
  var COUNT_ROW_MS   = 460;    // count-up duration for one manifest line
  var COUNT_STAGGER  = 105;    // ms between lines starting
  var CONFIRM_MS     = 3200;   // how long a two-tap confirm stays armed
  var PIN_INSET      = 0.07;   // map margin the 0..1 pin coordinates fold into
  /* How close to affording a region's cheapest rights counts as "surveyed".
   * Above 1 so the next region appears BEFORE it is affordable — the map has
   * to show the player what they are saving for. */
  var REVEAL_REACH   = 1.6;

  /* Fallbacks used ONLY when the module that owns the number is still a stub.
   * They keep the screens legible during the parallel build; every one of them
   * is shadowed the moment the real getter returns something sane. */
  var FALLBACK_FUEL_PRICE = 1;

  var COMPANY_NAMES = [
    'DEEP ROCK LTD', 'IRONMOUTH MINING', 'BLACKSEAM & CO',
    'HOLLOW HILL CO', 'GRANITE UNION', 'LOWLIGHT DIGGING'
  ];

  /* ---------------------------------------------------------------------
   * THE EIGHT PARTS, AS THE WORKSHOP DRAWS THEM
   *
   * `lx`/`ly` are the hotspot's position in the MACHINE'S OWN LOCAL SPACE, as
   * a multiple of its half-width and of its body length — not as a percentage
   * of the canvas. drawRig() converts them with the same transform it draws
   * the machine through, so a tag stays welded to its subassembly at any
   * canvas size AND as the hull grows: buy wider treads and the TRACKS tag
   * moves out with them. Orientation is vehicle.js's: -y is forward, so the
   * blade is at negative ly and the hopper at positive.
   *
   * `stat` is read through rig.js's derived getters, so the number under a
   * hotspot is the number the game actually uses.
   * ------------------------------------------------------------------ */
  var PARTS = [
    { key: 'drill',   title: 'DRILL',   lx: 0,     ly: -0.86, unit: '',
      blurb: 'Harder rock, faster. Every tier crosses a real hardness threshold.',
      stat: 'POWER',  get: function () { return rigNum('getDrillPower', 0); } },
    { key: 'lights',  title: 'LIGHTS',  lx: -1.28, ly: -0.50, unit: ' m',
      blurb: 'The cavern you cannot see is the cavern you drive into.',
      stat: 'REACH',  get: function () { return rigNum('getLightRadius', 0) * MPU; } },
    { key: 'scanner', title: 'SCANNER', lx: 1.28,  ly: -0.50, unit: ' m',
      blurb: 'Reads ore signatures through rock you have not touched yet.',
      stat: 'RANGE',  get: function () { return rigNum('getScanRange', 0) * MPU; } },
    { key: 'engine',  title: 'ENGINE',  lx: 0,     ly: 0.10,  unit: '',
      blurb: 'Speed, and the shove to push loose debris out of the way.',
      stat: 'SPEED',  get: function () { return rigNum('getSpeed', 0); } },
    { key: 'tracks',  title: 'TRACKS',  lx: -1.05, ly: 0.14,  unit: '',
      blurb: 'Grip and turn rate. A digger that cannot turn cannot come back.',
      stat: 'TURN',   get: function () { return rigNum('getTurnRate', 0); } },
    { key: 'cooling', title: 'COOLING', lx: 1.05,  ly: 0.14,  unit: '',
      blurb: 'The deep is hot. Cooling is what makes the bottom survivable.',
      stat: 'SHED',   get: function () { return rigNum('getHeatShed', 0); } },
    { key: 'fuel',    title: 'FUEL',    lx: -0.78, ly: 0.62,  unit: 'u',
      blurb: 'Every extra unit is another minute you can spend down there.',
      stat: 'TANK',   get: function () { return rigNum('getFuelCap', 0); } },
    { key: 'cargo',   title: 'CARGO',   lx: 0.78,  ly: 0.62,  unit: 'u',
      blurb: 'Fewer return trips. The hold is the whole reason to go down.',
      stat: 'HOLD',   get: function () { return rigNum('getCargoCap', 0); } }
  ];

  var MPU = (SM.config && SM.config.ADV) ? SM.config.ADV.METERS_PER_UNIT : 0.1;

  /* ------------------------------------------------------------------ */

  var els = {};
  var screens = {};
  var built = false;
  var subscribed = false;
  var current = '';          // the screen that is up, '' = none
  var toastTimer = 0;

  var slotRows = [];
  var pins = [];
  var regions = [];          // derived from the catalogue, see rebuildPins()
  var revealed = {};         // region key -> true, once surveyed it stays so
  var mapSeen = false;       // suppresses the reveal fanfare on the first paint
  var pinCount = -1;
  var selMine = null;        // mine id shown on the map card
  var selPart = 'drill';     // hotspot shown in the workshop
  var partTags = {};
  /* WHICH LIFT STATION THE DESCENT STARTS AT. -1 means "no choice made yet",
   * which paintPrepLift() resolves to the deepest station the company owns —
   * the one the player almost always wants, because it is the one they paid to
   * stop walking back to. It is reset whenever the mine changes. */
  var prepLevel = -1;
  var prepLevelMine = '';    // the mine prepLevel was chosen for
  var prepLevelOwned = -1;   // ...and how many levels were held at the time
  var countRaf = 0;
  var syncTimer = 0;
  var nameEditing = -1;
  var lastSale = 0;            // last banked gross, for the results note line      // slot index whose name field is open

  /* =====================================================================
   * DOM + FORMAT HELPERS
   * ================================================================== */
  function el(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  function fmt(n) {
    n = Math.round(n) | 0;
    var neg = n < 0;
    if (neg) n = -n;
    var s = '' + n, out = '', c = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      if (++c === 3 && i > 0) { out = ' ' + out; c = 0; }
    }
    return (neg ? '-' : '') + out;
  }

  function money(n) { return '$' + fmt(n); }

  function num(v, dflt) {
    return (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity) ? v : dflt;
  }

  function rigNum(fn, dflt) {
    if (SM.rig && SM.rig[fn]) return num(SM.rig[fn](), dflt);
    return dflt;
  }

  function advNum(fn, dflt) {
    if (SM.adv && SM.adv[fn]) return num(SM.adv[fn](), dflt);
    return dflt;
  }

  function button(parent, cls, label) {
    var b = el('button', 'sm-btn ' + (cls || ''), parent, label);
    b.setAttribute('type', 'button');
    return b;
  }

  function onTap(node, fn) {
    node.addEventListener('click', function (e) {
      e.preventDefault();
      if (node.blur) node.blur();
      if (node.disabled) return;
      if (SM.sound && SM.sound.play) SM.sound.play('ui');
      fn(e);
    }, false);
    return node;
  }

  /**
   * Two-tap confirm for anything that destroys progress. Same device as the
   * pause card's ABORT: the button relabels itself instead of stacking a modal,
   * and it disarms on a timer so a stale CONFIRM is never left sitting there.
   */
  function confirmTap(node, label, confirmLabel, fn) {
    var armed = false, t = 0;
    function disarm() {
      armed = false;
      if (t) { clearTimeout(t); t = 0; }
      node.classList.remove('sm-av-armed');
      node.textContent = label;
    }
    node.smDisarm = disarm;
    onTap(node, function () {
      if (!armed) {
        armed = true;
        node.classList.add('sm-av-armed');
        node.textContent = confirmLabel;
        t = setTimeout(disarm, CONFIRM_MS);
        return;
      }
      disarm();
      fn();
    });
    return node;
  }

  /** Material display, from whichever module can answer. */
  var dispOut = { name: '', color: '#8e9bab' };
  function displayOf(matId, matIndex) {
    dispOut.name = '';
    dispOut.color = '#8e9bab';
    var d = null;
    if (SM.mines && SM.mines.displayOf && matId) d = SM.mines.displayOf(matId);
    if (d) {
      dispOut.name = String(d.name || matId);
      dispOut.color = String(d.color || d.colour || dispOut.color);
      return dispOut;
    }
    var m = null;
    if (SM.materials) {
      if (matId && SM.materials.getById) m = SM.materials.getById(matId);
      if (!m && typeof matIndex === 'number' && SM.materials.get) m = SM.materials.get(matIndex);
    }
    if (m) {
      dispOut.name = String(m.name || m.id);
      dispOut.color = (m.colors && m.colors[0]) ? m.colors[0] : dispOut.color;
    } else {
      dispOut.name = String(matId === undefined ? 'UNKNOWN' : matId);
    }
    return dispOut;
  }

  function mineList() {
    var l = (SM.mines && SM.mines.getAll) ? SM.mines.getAll() : null;
    return (l && typeof l.length === 'number') ? l : [];
  }

  function ownsMine(m) {
    if (!m) return false;
    if (num(m.price, 0) <= 0) return true;                 // the starter mine
    if (SM.save && SM.save.isOwned) return !!SM.save.isOwned(m.id);
    return false;
  }

  function mineStateOf(id) {
    if (SM.save && SM.save.mineState) {
      var s = SM.save.mineState(id);
      if (s) return s;
    }
    return null;
  }

  /* =====================================================================
   * THE LIFT — READING THE STATION LIST ACROSS THE SEAM
   * ---------------------------------------------------------------------
   * SM.adv.getLevels() answers with the LIVE station table for the mine it has
   * IN CONTEXT: [{i, name, depthM, y, price, owned}], i = 0 being the surface,
   * always owned and always free. Its entry objects are reused and mutated in
   * place, so a picker built off it cannot show a stale price — which is why it
   * wins whenever it is about the right mine.
   *
   * The MAP CARD, though, asks about every pin on the chart, and only one of them
   * is ever in context. Two other exports cover the rest between them:
   * SM.mines.levelsOf(id) prices the levels of ANY mine (it is the catalogue's
   * own price list, excluding the surface) and SM.adv.ownedLevels(id) says how
   * many of them this company has bought. Assembling the same shape from those
   * two is honest — it is the same arithmetic adv.js does — and it means the
   * card can talk about a mine the player has never opened.
   * ================================================================== */
  function liftLevels(mineId) {
    var id = mineId || currentMineId();
    if (!id) return null;

    if (SM.adv && SM.adv.getLevels && id === currentMineId()) {
      var live = SM.adv.getLevels();
      if (live && typeof live.length === 'number' && live.length) return live;
    }

    var tbl = (SM.mines && SM.mines.levelsOf) ? SM.mines.levelsOf(id) : null;
    if (!tbl || !tbl.length) return null;
    var owned = (SM.adv && SM.adv.ownedLevels) ? num(SM.adv.ownedLevels(id), 0) : 0;
    // Freshly built rather than pooled: these screens are static between clicks
    // and a shared scratch array aliased between two painters is a bug waiting.
    var out = [{ i: 0, name: 'SURFACE', depthM: 0, y: 0, price: 0, owned: true }];
    for (var k = 0; k < tbl.length; k++) {
      var L = tbl[k] || {};
      out.push({ i: k + 1, name: L.name || ('LEVEL ' + (k + 1)),
                 depthM: num(L.depthM, 0), y: num(L.y, 0),
                 price: num(L.price, 0), owned: (k + 1) <= owned });
    }
    return out;
  }

  /** The mine adv.js is holding: the one being dug, or the one selected. */
  function currentMineId() {
    var m = (SM.adv && SM.adv.getMine) ? SM.adv.getMine() : null;
    return (m && m.id) ? m.id : (selMine || '');
  }

  /** Deepest station the company owns, or 0 (the mouth) when there are none. */
  function deepestOwned(levels) {
    var best = 0;
    if (!levels) return best;
    for (var i = 0; i < levels.length; i++) {
      if (levels[i] && levels[i].owned) best = num(levels[i].i, i);
    }
    return best;
  }

  /** Index of the one station that is purchasable: the first unowned one. */
  function nextUnowned(levels) {
    if (!levels) return -1;
    for (var i = 0; i < levels.length; i++) {
      if (levels[i] && !levels[i].owned) return i;
    }
    return -1;
  }

  function ownedCount(levels) {
    var n = 0;
    if (!levels) return 0;
    for (var i = 0; i < levels.length; i++) if (levels[i] && levels[i].owned) n++;
    return n;
  }

  /** 'LEVEL 3' / 'SURFACE', preferring whatever name adv.js gave the station. */
  function levelLabel(L) {
    if (!L) return '';
    var i = num(L.i, 0);
    if (L.name) return String(L.name).toUpperCase();
    return i === 0 ? 'SURFACE' : ('LEVEL ' + i);
  }

  /* =====================================================================
   * BUILD — one shell, five screens, built once
   * ================================================================== */
  function build() {
    var root = document.getElementById('ui-root');
    if (!root) return;
    built = true;

    els.wrap = el('div', 'sm-av', root);

    /* --- the ledger strip, common to every meta screen ------------------ */
    var led = el('div', 'sm-panel sm-av-ledger', els.wrap);
    el('div', 'sm-stripe', led);
    els.ledCompany = el('div', 'sm-av-led-co', led, 'SUPERMINE');
    var ledRight = el('div', 'sm-av-led-right', led);
    els.ledDay = el('div', 'sm-av-led-cell', ledRight, 'DAY 1');
    els.ledTier = el('div', 'sm-av-led-cell', ledRight, 'MK I');
    els.ledCash = el('div', 'sm-av-led-cash', ledRight, '$0');

    els.stage = el('div', 'sm-av-stage', els.wrap);

    buildSlots();
    buildMap();
    buildGarage();
    buildPrep();
    buildResults();

    els.toast = el('div', 'sm-av-toast', els.wrap);
    els.toastTitle = el('div', 'sm-av-toast-title', els.toast, '');
    els.toastSub = el('div', 'sm-av-toast-sub', els.toast, '');
  }

  /** A screen shell: header, scrolling body, and a footer that never scrolls. */
  function makeScreen(key, kicker, title) {
    var s = el('div', 'sm-av-screen sm-av-' + key, els.stage);
    var head = el('div', 'sm-av-head', s);
    var k = el('div', 'sm-av-kicker', head, kicker);
    var t = el('div', 'sm-av-title', head, title);
    var body = el('div', 'sm-av-body', s);
    var foot = el('div', 'sm-av-foot', s);
    screens[key] = { node: s, kicker: k, title: t, body: body, foot: foot };
    return screens[key];
  }

  /* ---------------------------------------------------------------------
   * SLOTS
   * ------------------------------------------------------------------ */
  function buildSlots() {
    var s = makeScreen('slots', 'THREE COMPANIES · ONE LEDGER EACH', 'MINING COMPANIES');
    var n = (SM.config && SM.config.ADV) ? SM.config.ADV.SAVE_SLOTS : 3;
    for (var i = 0; i < n; i++) slotRows.push(makeSlotRow(s.body, i));
    onTap(button(s.foot, '', 'BACK TO MAIN MENU'), function () {
      if (SM.adv && SM.adv.close) SM.adv.close();
    });
  }

  function makeSlotRow(parent, i) {
    var r = { index: i };
    r.node = el('div', 'sm-panel sm-av-slot', parent);
    el('div', 'sm-stripe', r.node);
    var top = el('div', 'sm-av-slot-top', r.node);
    r.no = el('div', 'sm-av-slot-no', top, 'SLOT ' + (i + 1));
    r.name = el('div', 'sm-av-slot-name', top, 'EMPTY');
    r.stats = el('div', 'sm-av-slot-stats', r.node);
    r.cash = statCell(r.stats, 'CASH', '$0');
    r.day = statCell(r.stats, 'DAY', '1');
    r.tier = statCell(r.stats, 'MACHINE', 'MK I');
    r.mines = statCell(r.stats, 'MINES', '0');

    /* The name editor. Its keydown is stopped from reaching window, because
     * js/input.js (frozen) restarts the run on 'r' and mutes on 'm' — typing
     * IRONMOUTH would otherwise restart the game mid-entry. preventDefault is
     * NOT called, so the character still lands in the field. */
    r.form = el('div', 'sm-av-slot-form', r.node);
    r.input = el('input', 'sm-av-input', r.form);
    r.input.setAttribute('type', 'text');
    r.input.setAttribute('maxlength', '18');
    r.input.setAttribute('placeholder', 'COMPANY NAME');
    r.input.setAttribute('autocomplete', 'off');
    r.input.setAttribute('spellcheck', 'false');
    r.input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); startCompany(r); }
    }, false);
    r.input.addEventListener('keyup', function (e) { e.stopPropagation(); }, false);
    r.input.addEventListener('keypress', function (e) { e.stopPropagation(); }, false);
    r.input.addEventListener('input', function () {
      var v = r.input.value.toUpperCase();
      if (v !== r.input.value) r.input.value = v;
    }, false);
    r.confirm = button(r.form, 'sm-btn-primary', 'SIGN THE PAPERS');
    onTap(r.confirm, function () { startCompany(r); });

    var acts = el('div', 'sm-av-slot-acts', r.node);
    r.primary = button(acts, 'sm-btn-primary', 'NEW COMPANY');
    onTap(r.primary, function () {
      var list = safeSlots();
      if (list[i] && !list[i].empty) {
        if (SM.save && SM.save.load) SM.save.load(i);
        enterCompany(i);
      } else {
        openNameEditor(i);
      }
    });
    r.erase = confirmTap(button(acts, 'sm-av-quiet', 'ERASE'), 'ERASE', 'ERASE FOR GOOD', function () {
      if (SM.save && SM.save.erase) SM.save.erase(i);
      if (SM.save && SM.save.flush) SM.save.flush();
      nameEditing = -1;
      paintSlots();
      toast('SLOT ERASED', 'Slot ' + (i + 1) + ' is empty again', 1.8);
    });
    return r;
  }

  function statCell(parent, label, value) {
    var cell = el('div', 'sm-cell', parent);
    el('div', 'sm-cell-label', cell, label);
    return el('div', 'sm-cell-value', cell, value);
  }

  function safeSlots() {
    var list = (SM.save && SM.save.listSlots) ? SM.save.listSlots() : null;
    if (!list || typeof list.length !== 'number') list = [];
    var n = (SM.config && SM.config.ADV) ? SM.config.ADV.SAVE_SLOTS : 3;
    while (list.length < n) list.push({ index: list.length, empty: true });
    return list;
  }

  function openNameEditor(i) {
    nameEditing = i;
    paintSlots();
    var r = slotRows[i];
    if (!r) return;
    if (!r.input.value) {
      r.input.value = COMPANY_NAMES[(Math.random() * COMPANY_NAMES.length) | 0];
    }
    try { r.input.focus(); r.input.select(); } catch (e) { /* focus is optional */ }
  }

  function startCompany(r) {
    var name = (r.input.value || '').trim() || COMPANY_NAMES[0];
    if (SM.save && SM.save.newGame) SM.save.newGame(r.index, name);
    if (SM.save && SM.save.flush) SM.save.flush();
    nameEditing = -1;
    enterCompany(r.index);
  }

  /**
   * The slot is loaded; hand over to the state machine. The index is passed as
   * well as being already loaded, so adv.js can use either — see the report.
   */
  function enterCompany(i) {
    if (SM.adv && SM.adv.startCompany) SM.adv.startCompany(i);
    // If adv.js has not moved us on (it is still a stub, or a load failed),
    // the watchdog will put the slot screen back rather than leave a blank.
  }

  function paintSlots() {
    var list = safeSlots();
    for (var i = 0; i < slotRows.length; i++) {
      var r = slotRows[i], d = list[i] || { empty: true };
      var empty = !!d.empty;
      r.node.classList[empty ? 'add' : 'remove']('sm-av-slot-empty');
      r.name.textContent = empty ? 'EMPTY' : String(d.company || 'UNNAMED CO');
      r.cash.textContent = money(num(d.cash, 0));
      r.day.textContent = fmt(num(d.day, 1));
      r.tier.textContent = 'MK ' + roman(num(d.tier, 1));
      r.mines.textContent = fmt(num(d.mines, 0));
      r.stats.style.display = empty ? 'none' : '';
      r.erase.style.display = empty ? 'none' : '';
      if (r.erase.smDisarm) r.erase.smDisarm();
      r.primary.textContent = empty ? 'NEW COMPANY' : 'CONTINUE';
      var editing = (nameEditing === i);
      r.form.style.display = editing ? '' : 'none';
      r.primary.style.display = editing ? 'none' : '';
    }
  }

  function roman(n) {
    var R = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
    n = Math.round(n) | 0;
    return R[n] || ('' + n);
  }

  /* ---------------------------------------------------------------------
   * MAP
   * ------------------------------------------------------------------ */
  function buildMap() {
    var s = makeScreen('map', 'MINING RIGHTS · CHOOSE YOUR GROUND', 'THE FIELD');
    els.map = el('div', 'sm-av-mapart', s.body);
    /* THE LAND IS DRAWN, not built out of divs. A canvas is what makes a
     * frozen shaft look frozen and a volcanic coast look volcanic — see
     * drawMapArt(). The pins stay DOM on top of it, because they are buttons
     * with labels and hit targets, which canvas is bad at. */
    els.mapCanvas = el('canvas', 'sm-av-map-canvas', els.map);
    els.mapRegions = el('div', 'sm-av-regions', els.map);
    els.mapPins = el('div', 'sm-av-pins', els.map);
    els.mapEmpty = el('div', 'sm-av-map-empty', els.map, 'NO SURVEY DATA');

    /* --- the mine card -------------------------------------------------- */
    var c = el('div', 'sm-panel sm-av-minecard', s.body);
    els.card = c;
    el('div', 'sm-stripe', c);
    var chead = el('div', 'sm-av-card-head', c);
    els.cardName = el('div', 'sm-av-card-name', chead, '');
    els.cardRegion = el('div', 'sm-av-card-region', chead, '');
    els.cardBlurb = el('div', 'sm-av-card-blurb', c, '');
    var grid = el('div', 'sm-av-card-grid', c);
    els.cardPrice = statCell(grid, 'MINING RIGHTS', '$0');
    els.cardDrill = statCell(grid, 'REC. DRILL', '0');
    els.cardDepth = statCell(grid, 'EST. DEPTH', '0 m');
    els.cardBest = statCell(grid, 'DEEPEST RUN', '—');
    /* THE PROFILE ROW. Two mines can cost nearly the same and be completely
     * different propositions — one with no heat in any layer and one that is a
     * gamble all the way down — and that difference is the most interesting
     * decision on this screen. It is read off the LAYER TABLE, so it cannot
     * disagree with what the mine actually does to the machine. */
    els.cardProfile = el('div', 'sm-av-profile', c);
    /* WHAT THE LIFT HAS REACHED. One line, off getLevels(): a mine you have cut
     * four stations into is a completely different proposition from one you have
     * only ever entered at the mouth, and that is the difference between a
     * twenty-second descent and a five-minute climb. */
    els.cardLift = el('div', 'sm-av-liftline', c, '');
    els.cardWarn = el('div', 'sm-av-warn', c, '');
    els.cardRes = el('div', 'sm-av-chips', c);
    els.cardHaz = el('div', 'sm-av-haz', c, '');

    /* The mine's own action lives in the FOOTER, not in the card: the card is
     * the read, and a read can be long enough to scroll. BUY RIGHTS must never
     * be the thing that scrolled away. */
    els.cardBtn = button(s.foot, 'sm-btn-primary sm-btn-big', 'BUY RIGHTS');
    onTap(els.cardBtn, onMineAction);

    onTap(button(s.foot, '', 'WORKSHOP'), function () {
      if (SM.adv && SM.adv.openGarage) SM.adv.openGarage();
    });
    onTap(button(s.foot, 'sm-av-quiet', 'MAIN MENU'), function () {
      if (SM.adv && SM.adv.close) SM.adv.close();
    });
  }

  function paintMap() {
    var list = mineList();
    els.mapEmpty.style.display = list.length ? 'none' : '';

    if (pinCount !== list.length) rebuildPins(list);

    var cash = advNum('getCash', 0);
    var i, p, m;

    /* --- which regions are on the chart at all --------------------------
     * The surveyed set is remembered in the SAVE RECORD, not just in this
     * module: without that, a company that surveyed Frostpeak and then spent
     * the money would find it fogged again after a reload, which reads as the
     * game forgetting something the player did. `seen` is an ADDITION to
     * save.js's schema (adv.js does the same with `integrity`); if a stricter
     * loader ever drops it, the worst case is the fog coming back, never a
     * broken company. */
    var rec = (SM.save && SM.save.get) ? SM.save.get() : null;
    if (rec && rec.seen) {
      for (var sk in rec.seen) if (rec.seen.hasOwnProperty(sk)) revealed[sk] = true;
    }
    var newly = [];
    for (i = 0; i < regions.length; i++) {
      var r = regions[i];
      var was = !!revealed[r.key];
      r.owned = 0;
      r.cheapest = Infinity;
      for (var j = 0; j < r.mines.length; j++) {
        var mm = r.mines[j];
        if (ownsMine(mm)) r.owned++;
        var pr = num(mm.price, 0);
        if (pr < r.cheapest) r.cheapest = pr;
      }
      /* A region joins the chart when the company can plausibly reach it: it
       * owns ground there, or the cheapest rights are within REVEAL_REACH of
       * the ledger. Once surveyed it STAYS surveyed — a bad run that empties
       * the account must not un-discover a mountain range. */
      if (!was && (r.owned > 0 || cash >= r.cheapest * REVEAL_REACH)) {
        revealed[r.key] = true;
        if (rec) {
          if (!rec.seen) rec.seen = {};
          rec.seen[r.key] = 1;
          if (SM.save && SM.save.markDirty) SM.save.markDirty();
        }
        if (mapSeen) newly.push(r);      // not on the very first paint
      }
      r.revealed = !!revealed[r.key];
      r.label.textContent = r.revealed ? r.name.toUpperCase() : 'UNSURVEYED';
      r.label.classList[r.revealed ? 'remove' : 'add']('sm-av-region-fog');
      r.label.classList[r.owned > 0 ? 'add' : 'remove']('sm-av-region-held');
    }

    /* --- the pins ------------------------------------------------------- */
    for (i = 0; i < pins.length; i++) {
      p = pins[i]; m = p.mine;
      var owned = ownsMine(m);
      var afford = cash >= num(m.price, 0);
      var known = !p.region || p.region.revealed;
      p.node.classList[owned ? 'add' : 'remove']('sm-av-pin-owned');
      p.node.classList[(!owned && afford) ? 'add' : 'remove']('sm-av-pin-buy');
      p.node.classList[(!owned && !afford) ? 'add' : 'remove']('sm-av-pin-far');
      p.node.classList[known ? 'remove' : 'add']('sm-av-pin-fog');
      p.node.classList[(selMine === m.id) ? 'add' : 'remove']('sm-av-pin-sel');
      p.tag.textContent = owned ? 'HELD' : (num(m.price, 0) > 0 ? money(m.price) : 'FREE');
      p.name.textContent = known ? String(m.name || m.id).toUpperCase() : 'UNCHARTED SITE';
    }

    if (!selMine && list.length) selMine = firstInteresting(list);
    drawMapArt();
    paintMineCard();

    /* --- and the achievement beat --------------------------------------- */
    for (i = 0; i < newly.length; i++) celebrateRegion(newly[i]);
    mapSeen = true;
  }

  /**
   * A new region joining the chart is the campaign's milestone, so it gets the
   * one piece of theatre on this screen: a survey sweep across the new ground
   * and a toast naming it. Unlocking a region should feel like something.
   */
  function celebrateRegion(r) {
    if (!r || !r.flash) return;
    retrigger(r.flash, 'sm-av-reveal-on');
    toast('REGION SURVEYED', String(r.name).toUpperCase() + ' is on the chart', 3.2);
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
  }

  function retrigger(node, cls) {
    if (!node) return;
    node.classList.remove(cls);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { node.classList.add(cls); });
    } else node.classList.add(cls);
  }

  /** The pin the player most likely wants: the deepest one they own. */
  function firstInteresting(list) {
    var best = list[0].id;
    for (var i = 0; i < list.length; i++) {
      if (ownsMine(list[i])) best = list[i].id;
    }
    return best;
  }

  function rebuildPins(list) {
    pinCount = list.length;
    pins.length = 0;
    regions.length = 0;
    els.mapPins.innerHTML = '';
    els.mapRegions.innerHTML = '';

    /* REGIONS ARE DERIVED FROM THE PINS, never authored twice: a region's land
     * spans the bounding box of its mines, so a mine added in mines.js grows
     * its region automatically and a re-tuned mapX/mapY moves the coastline
     * with it. `art` is matched on the region's NAME (see artFor) so the
     * terrain identity survives a rename or a new region entirely. */
    var byName = {};
    var i, m, r;
    for (i = 0; i < list.length; i++) {
      m = list[i];
      if (!m) continue;
      var name = String(m.region || 'Uncharted');
      r = byName[name];
      if (!r) {
        r = byName[name] = {
          name: name, key: name.toLowerCase(), mines: [],
          minX: 1, minY: 1, maxX: 0, maxY: 0,
          owned: 0, cheapest: Infinity, revealed: false,
          art: artFor(name), seed: hashStr(name)
        };
        regions.push(r);
      }
      var mx = clamp01(num(m.mapX, 0.5)), my = clamp01(num(m.mapY, 0.5));
      r.mines.push(m);
      if (mx < r.minX) r.minX = mx;
      if (mx > r.maxX) r.maxX = mx;
      if (my < r.minY) r.minY = my;
      if (my > r.maxY) r.maxY = my;
    }

    // Deepest region last, so the label of a big late region paints on top.
    for (i = 0; i < regions.length; i++) {
      r = regions[i];
      var pad = 0.055;
      r.x0 = insetX(Math.max(0, r.minX - pad));
      r.y0 = insetX(Math.max(0, r.minY - pad));
      r.x1 = insetX(Math.min(1, r.maxX + pad));
      r.y1 = insetX(Math.min(1, r.maxY + pad));

      var box = el('div', 'sm-av-region', els.mapRegions);
      box.style.left = (r.x0 * 100) + '%';
      box.style.top = (r.y0 * 100) + '%';
      box.style.width = ((r.x1 - r.x0) * 100) + '%';
      box.style.height = ((r.y1 - r.y0) * 100) + '%';
      r.box = box;
      r.label = el('div', 'sm-av-region-label', box, r.name.toUpperCase());
      r.label.title = r.name;
      // The survey sweep, parked and invisible until a region is revealed.
      r.flash = el('div', 'sm-av-reveal', box);
    }

    for (i = 0; i < list.length; i++) {
      m = list[i];
      if (!m) continue;
      pins.push(makePin(m, byName[String(m.region || 'Uncharted')]));
    }
  }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /** Fold a 0..1 map coordinate into the artwork's safe area. */
  function insetX(v) { return PIN_INSET + clamp01(v) * (1 - PIN_INSET * 2); }

  /** Cheap stable string hash — the coastline must not wobble between paints. */
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function makePin(m, region) {
    var node = el('button', 'sm-av-pin', els.mapPins);
    node.setAttribute('type', 'button');
    /* Inset the 0..1 map coordinates: a mine authored at mapX 0.93 would
     * otherwise hang its name label off the right edge of the artwork, which
     * on a phone clips it in half. */
    node.style.left = (insetX(num(m.mapX, 0.5)) * 100) + '%';
    node.style.top = (insetX(num(m.mapY, 0.5)) * 100) + '%';
    el('span', 'sm-av-pin-dot', node);
    var nameEl = el('span', 'sm-av-pin-name', node, String(m.name || m.id || '').toUpperCase());
    var tag = el('span', 'sm-av-pin-tag', node, '');
    var p = { node: node, tag: tag, name: nameEl, mine: m, region: region || null };
    onTap(node, function () {
      selMine = m.id;
      paintMap();
    });
    return p;
  }

  /* =====================================================================
   * THE MAP ARTWORK
   * ---------------------------------------------------------------------
   * The empire screen is the one the player sees most between runs, so the
   * regions get real character rather than a wireframe: each one is a drawn
   * landmass with its own palette and its own terrain marks — folded hills,
   * a terraced quarry, a snow-capped range, an ice shelf, sunken hollows, a
   * volcanic coast, and a rift that is not really land at all.
   *
   * Everything is procedural and deterministic (seeded off the region NAME),
   * so there are no assets to load, nothing to keep in sync with mines.js,
   * and a repaint always draws the same coastline.
   *
   * It repaints only when the map screen is painted — on open, on a purchase,
   * on a resize — never per frame.
   * ================================================================== */
  var REGION_ART = {
    hills:     { kind: 'hills',     land: ['#48562f', '#5d6f37', '#7d9147'], edge: '#94a55a', ink: '#dcecb4' },
    quarry:    { kind: 'quarry',    land: ['#5d3a22', '#7d4c2b', '#a2673a'], edge: '#c98a52', ink: '#ffd9a8' },
    mountains: { kind: 'mountains', land: ['#333b46', '#4b5563', '#6d7987'], edge: '#a9b5c5', ink: '#e2ecf8' },
    ice:       { kind: 'ice',       land: ['#28485a', '#3a7häa', '#66a9bf'], edge: '#c6ecf7', ink: '#eafdff' },
    lowland:   { kind: 'lowland',   land: ['#22321f', '#33482b', '#4a633b'], edge: '#6d8a4f', ink: '#c8dca6' },
    volcanic:  { kind: 'volcanic',  land: ['#2d1613', '#4d2016', '#712c18'], edge: '#ff7a2a', ink: '#ffc9a4' },
    rift:      { kind: 'rift',      land: ['#191024', '#2d1739', '#48235c'], edge: '#c46bff', ink: '#f5daff' },
    desert:    { kind: 'desert',    land: ['#6b5225', '#8f6d2f', '#b8903f'], edge: '#e0bb63', ink: '#ffeec0' }
  };
  // typo guard: the ice mid-tone above must be a valid colour
  REGION_ART.ice.land[1] = '#3a7d94';

  /**
   * Terrain identity from the region's NAME, by keyword. Matching on the name
   * rather than on an id means Agent 2 can add 'Ash Barrens' or 'The Salt Flats'
   * and it lands on plausible art instead of a grey box.
   */
  function artFor(name) {
    var n = String(name).toLowerCase();
    if (/rift|void|abyss|chasm/.test(n)) return REGION_ART.rift;
    if (/frost|ice|glacier|snow|winter|north/.test(n)) return REGION_ART.ice;
    if (/cinder|ash|volcan|ember|fell|fire|coast/.test(n)) return REGION_ART.volcanic;
    if (/hollow|marsh|fen|swamp|low|bog/.test(n)) return REGION_ART.lowland;
    if (/range|peak|mount|alp|crag|spine/.test(n)) return REGION_ART.mountains;
    if (/ridge|quarry|cut|pit|scarp/.test(n)) return REGION_ART.quarry;
    if (/dune|desert|sand|salt|flat|barren/.test(n)) return REGION_ART.desert;
    return REGION_ART.hills;
  }

  /** Deterministic 0..1 stream. One per region, re-seeded on every paint. */
  function rngFrom(seed) {
    var s = (seed || 1) >>> 0;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return (s >>> 8) / 16777216;
    };
  }

  function drawMapArt() {
    var c = els.mapCanvas;
    if (!c || !c.getContext) return;
    var w = c.clientWidth | 0, h = c.clientHeight | 0;
    if (w < 20 || h < 20) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    drawSea(ctx, w, h);
    var i;
    for (i = 0; i < regions.length; i++) drawRegion(ctx, regions[i], w, h);
    drawRoutes(ctx, w, h);
    drawGraticule(ctx, w, h);
    drawChartFurniture(ctx, w, h);
  }

  /**
   * A compass rose and a scale bar out in the water. The mines cluster in the
   * middle of the chart, so without these the outer thirds are empty sea; two
   * pieces of instrument furniture are what make that emptiness read as a
   * SURVEY rather than as unused space.
   */
  function drawChartFurniture(ctx, w, h) {
    if (w < 300) return;                       // no room on a phone
    var cx = w - 46, cy = 52, r = 20;
    ctx.save();
    ctx.strokeStyle = 'rgba(200, 224, 245, 0.30)';
    ctx.fillStyle = 'rgba(200, 224, 245, 0.30)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    // the needle: north filled, south hollow
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.92);
    ctx.lineTo(cx - r * 0.24, cy);
    ctx.lineTo(cx + r * 0.24, cy);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 194, 31, 0.75)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, cy + r * 0.92);
    ctx.lineTo(cx - r * 0.24, cy);
    ctx.lineTo(cx + r * 0.24, cy);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(200, 224, 245, 0.45)';
    ctx.stroke();
    ctx.font = '800 8px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(222, 236, 250, 0.55)';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, cy - r - 4);
    ctx.textAlign = 'start';

    // scale bar, bottom left
    var bx = 22, by = h - 22, bl = Math.min(120, w * 0.16);
    ctx.strokeStyle = 'rgba(222, 236, 250, 0.35)';
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + bl, by);
    ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4);
    ctx.moveTo(bx + bl * 0.5, by - 3); ctx.lineTo(bx + bl * 0.5, by + 3);
    ctx.moveTo(bx + bl, by - 4); ctx.lineTo(bx + bl, by + 4);
    ctx.stroke();
    ctx.font = '800 7.5px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(222, 236, 250, 0.45)';
    ctx.fillText('50 km', bx + bl + 6, by + 3);
    ctx.restore();
  }

  /** Deep water, a warm shelf near the coast, and a compass rose. */
  function drawSea(ctx, w, h) {
    var g = ctx.createLinearGradient(0, 0, w * 0.6, h);
    g.addColorStop(0, '#0a1420');
    g.addColorStop(0.55, '#0b1a26');
    g.addColorStop(1, '#07101a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // depth contours: a few long, lazy strokes so the water is not flat
    ctx.strokeStyle = 'rgba(120, 190, 220, 0.055)';
    ctx.lineWidth = 1;
    var rnd = rngFrom(9001);
    for (var i = 0; i < 7; i++) {
      var y0 = h * (0.08 + i * 0.13) + rnd() * 12;
      ctx.beginPath();
      ctx.moveTo(-10, y0);
      for (var x = 0; x <= w + 10; x += 42) {
        ctx.lineTo(x, y0 + Math.sin((x / w) * 6.2 + i) * (7 + i * 1.6));
      }
      ctx.stroke();
    }
  }

  function drawGraticule(ctx, w, h) {
    ctx.strokeStyle = 'rgba(150, 190, 220, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = w * 0.1; x < w; x += w * 0.1) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (var y = h * 0.125; y < h; y += h * 0.125) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }

  /** Dashed haulage routes between neighbouring revealed regions. */
  function drawRoutes(ctx, w, h) {
    var pts = [];
    for (var i = 0; i < regions.length; i++) {
      var r = regions[i];
      if (!r.revealed) continue;
      pts.push([(r.x0 + r.x1) * 0.5 * w, (r.y0 + r.y1) * 0.5 * h]);
    }
    if (pts.length < 2) return;
    pts.sort(function (a, b) { return a[0] - b[0]; });
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 194, 31, 0.20)';
    ctx.lineWidth = 1.4;
    if (ctx.setLineDash) ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var k = 1; k < pts.length; k++) {
      var a = pts[k - 1], b = pts[k];
      var mx = (a[0] + b[0]) * 0.5, my = (a[1] + b[1]) * 0.5 - Math.abs(b[0] - a[0]) * 0.12;
      ctx.quadraticCurveTo(mx, my, b[0], b[1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** One landmass: a jittered blob, then terrain marks clipped inside it. */
  function drawRegion(ctx, r, w, h) {
    var x = r.x0 * w, y = r.y0 * h;
    var bw = (r.x1 - r.x0) * w, bh = (r.y1 - r.y0) * h;
    // Small regions still need to read as land, not as a dot.
    var minW = Math.min(w * 0.22, 150), minH = Math.min(h * 0.24, 120);
    if (bw < minW) { x -= (minW - bw) * 0.5; bw = minW; }
    if (bh < minH) { y -= (minH - bh) * 0.5; bh = minH; }
    var cx = x + bw * 0.5, cy = y + bh * 0.5;
    var art = r.art;
    var rnd = rngFrom(r.seed);

    ctx.save();
    coastPath(ctx, cx, cy, bw * 0.62, bh * 0.62, rnd);

    // A soft halo outside the coast so the land sits IN the water.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.75)';
    ctx.shadowBlur = 16;
    ctx.fillStyle = art.land[0];
    ctx.fill();
    ctx.restore();

    var g = ctx.createLinearGradient(x, y, x + bw * 0.35, y + bh);
    g.addColorStop(0, art.land[2]);
    g.addColorStop(0.5, art.land[1]);
    g.addColorStop(1, art.land[0]);
    ctx.fillStyle = g;
    ctx.fill();

    ctx.clip();
    drawTerrain(ctx, art.kind, x, y, bw, bh, art, rnd);
    ctx.restore();

    // Coastline, brighter when the ground is held.
    ctx.save();
    coastPath(ctx, cx, cy, bw * 0.62, bh * 0.62, rngFrom(r.seed));
    ctx.strokeStyle = r.owned > 0 ? 'rgba(255, 194, 31, 0.75)' : 'rgba(210, 232, 250, 0.28)';
    ctx.lineWidth = r.owned > 0 ? 2 : 1.2;
    ctx.stroke();
    ctx.restore();

    /* UNSURVEYED GROUND. The land is still drawn underneath — a shape in the
     * fog is an invitation, a blank rectangle is not — but it is veiled, and
     * the pins on it read as UNCHARTED SITE until the company can reach them. */
    if (!r.revealed) {
      ctx.save();
      coastPath(ctx, cx, cy, bw * 0.66, bh * 0.66, rngFrom(r.seed));
      ctx.fillStyle = 'rgba(7, 10, 16, 0.74)';
      ctx.fill();
      if (ctx.setLineDash) ctx.setLineDash([3, 5]);
      ctx.strokeStyle = 'rgba(150, 170, 200, 0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  /** A closed, jittered coastline through 14 points around an ellipse. */
  function coastPath(ctx, cx, cy, rx, ry, rnd) {
    var N = 14, i, a, jr, px, py;
    var first = true;
    var pxs = [], pys = [];
    for (i = 0; i < N; i++) {
      a = (i / N) * Math.PI * 2;
      jr = 0.78 + rnd() * 0.34;
      pxs.push(cx + Math.cos(a) * rx * jr);
      pys.push(cy + Math.sin(a) * ry * jr);
    }
    ctx.beginPath();
    for (i = 0; i <= N; i++) {
      var i0 = i % N, i1 = (i + 1) % N;
      px = (pxs[i0] + pxs[i1]) * 0.5;
      py = (pys[i0] + pys[i1]) * 0.5;
      if (first) { ctx.moveTo(px, py); first = false; }
      else ctx.quadraticCurveTo(pxs[i0], pys[i0], px, py);
    }
    ctx.closePath();
  }

  function drawTerrain(ctx, kind, x, y, w, h, art, rnd) {
    var i, n, px, py, s;
    if (kind === 'mountains' || kind === 'ice') {
      // Ridges: back row hazy, front row sharp, snow on the caps.
      for (var row = 0; row < 2; row++) {
        n = 4 + (row === 0 ? 2 : 0);
        for (i = 0; i < n; i++) {
          var bx = x + w * (0.12 + (i / n) * 0.78) + rnd() * 10;
          var by = y + h * (row === 0 ? 0.46 : 0.68);
          s = h * (row === 0 ? 0.20 : 0.30) * (0.7 + rnd() * 0.6);
          ctx.beginPath();
          ctx.moveTo(bx - s * 0.9, by);
          ctx.lineTo(bx, by - s);
          ctx.lineTo(bx + s * 0.9, by);
          ctx.closePath();
          ctx.fillStyle = row === 0 ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.13)';
          ctx.fill();
          // cap
          ctx.beginPath();
          ctx.moveTo(bx - s * 0.30, by - s * 0.66);
          ctx.lineTo(bx, by - s);
          ctx.lineTo(bx + s * 0.30, by - s * 0.66);
          ctx.closePath();
          ctx.fillStyle = kind === 'ice' ? 'rgba(232,253,255,0.72)' : 'rgba(226,236,248,0.5)';
          ctx.fill();
        }
      }
      if (kind === 'ice') {
        ctx.strokeStyle = 'rgba(198,236,247,0.35)';
        ctx.lineWidth = 1;
        for (i = 0; i < 6; i++) {
          px = x + rnd() * w; py = y + h * (0.55 + rnd() * 0.4);
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px + w * 0.10 * (rnd() - 0.5), py + h * 0.10);
          ctx.stroke();
        }
      }
      return;
    }
    if (kind === 'quarry') {
      // Terraces: concentric steps cut into the hill.
      for (i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.ellipse(x + w * 0.5, y + h * (0.62 + i * 0.03),
                    w * (0.34 - i * 0.07), h * (0.20 - i * 0.04), 0, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.32)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255, 220, 170, 0.045)';
        ctx.fill();
      }
      return;
    }
    if (kind === 'volcanic') {
      // A cone with a hot throat, then glowing fissures across the ground.
      var vx = x + w * 0.5, vy = y + h * 0.66, vs = h * 0.34;
      ctx.beginPath();
      ctx.moveTo(vx - vs, vy);
      ctx.lineTo(vx - vs * 0.22, vy - vs);
      ctx.lineTo(vx + vs * 0.22, vy - vs);
      ctx.lineTo(vx + vs, vy);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(vx - vs * 0.22, vy - vs);
      ctx.lineTo(vx + vs * 0.22, vy - vs);
      ctx.lineTo(vx, vy - vs * 0.78);
      ctx.closePath();
      ctx.fillStyle = art.edge;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 122, 42, 0.55)';
      ctx.lineWidth = 1.6;
      for (i = 0; i < 5; i++) {
        px = x + w * (0.18 + rnd() * 0.64);
        py = y + h * (0.62 + rnd() * 0.3);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + w * 0.09 * (rnd() - 0.5), py + h * 0.09);
        ctx.lineTo(px + w * 0.16 * (rnd() - 0.5), py + h * 0.16);
        ctx.stroke();
      }
      return;
    }
    if (kind === 'rift') {
      // Not land: a tear, with light coming out of it.
      ctx.save();
      var rg = ctx.createLinearGradient(x, y, x + w, y + h);
      rg.addColorStop(0, 'rgba(196,107,255,0)');
      rg.addColorStop(0.5, 'rgba(196,107,255,0.34)');
      rg.addColorStop(1, 'rgba(196,107,255,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(245, 218, 255, 0.85)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.24, y + h * 0.26);
      for (i = 1; i <= 6; i++) {
        ctx.lineTo(x + w * (0.24 + i * 0.085) + (rnd() - 0.5) * w * 0.05,
                   y + h * (0.26 + i * 0.085) + (rnd() - 0.5) * h * 0.05);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (kind === 'lowland') {
      // Sunken ground: standing water and reed dabs.
      for (i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.ellipse(x + w * (0.2 + rnd() * 0.6), y + h * (0.45 + rnd() * 0.42),
                    w * (0.06 + rnd() * 0.10), h * (0.03 + rnd() * 0.05), 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(90, 150, 165, 0.30)';
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(0,0,0,0.20)';
      for (i = 0; i < 26; i++) {
        ctx.fillRect(x + rnd() * w, y + h * (0.4 + rnd() * 0.55), 2, 3);
      }
      return;
    }
    if (kind === 'desert') {
      ctx.strokeStyle = 'rgba(255, 238, 192, 0.20)';
      ctx.lineWidth = 1.4;
      for (i = 0; i < 6; i++) {
        py = y + h * (0.40 + i * 0.09);
        ctx.beginPath();
        ctx.moveTo(x + w * 0.10, py);
        ctx.quadraticCurveTo(x + w * 0.5, py - h * 0.06, x + w * 0.9, py);
        ctx.stroke();
      }
      return;
    }
    // hills: folded arcs, lightest at the top
    for (i = 0; i < 5; i++) {
      py = y + h * (0.40 + i * 0.10);
      ctx.beginPath();
      ctx.moveTo(x + w * 0.08, py);
      ctx.quadraticCurveTo(x + w * (0.3 + rnd() * 0.4), py - h * 0.13, x + w * 0.92, py);
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.10 - i * 0.014).toFixed(3) + ')';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    for (i = 0; i < 14; i++) {
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(x + rnd() * w, y + h * (0.35 + rnd() * 0.55), 2, 2);
    }
  }

  function paintMineCard() {
    var m = (SM.mines && SM.mines.get) ? SM.mines.get(selMine) : null;
    if (!m) {
      els.card.classList.remove('sm-av-minecard-on');
      return;
    }
    els.card.classList.add('sm-av-minecard-on');

    var owned = ownsMine(m);
    var price = num(m.price, 0);
    var cash = advNum('getCash', 0);
    var rec = num(m.recDrill, 0);
    var mine = mineStateOf(m.id);
    var yours = rigNum('getDrillPower', 0);

    els.cardName.textContent = String(m.name || m.id).toUpperCase();
    els.cardRegion.textContent = String(m.region || '').toUpperCase();
    els.cardBlurb.textContent = String(m.blurb || '');
    els.cardPrice.textContent = owned ? 'HELD' : money(price);
    els.cardPrice.className = 'sm-cell-value' + (owned ? ' sm-av-good' : '');
    els.cardDrill.textContent = rec > 0 ? (fmt(rec) + '+   YOURS ' + fmt(yours)) : ('YOURS ' + fmt(yours));
    els.cardDrill.className = 'sm-cell-value' + ((rec > 0 && yours < rec) ? ' sm-av-bad' : '');
    els.cardDepth.textContent = fmt(num(m.depth, 0)) + ' m';
    els.cardBest.textContent = (mine && num(mine.deepestM, 0) > 0)
      ? (fmt(mine.deepestM) + ' m' + (num(mine.visits, 0) ? ('  ·  ' + fmt(mine.visits) + ' RUNS') : ''))
      : '—';

    paintProfile(m);

    var levels = liftLevels(m.id);
    if (levels) {
      var lo = ownedCount(levels), lt = levels.length;
      var deep = levels[deepestOwned(levels)];
      els.cardLift.textContent = 'LIFT   ' + fmt(lo) + ' OF ' + fmt(lt) + ' LEVELS' +
        (deep && num(deep.depthM, 0) > 0 ? ('   ·   DEEPEST STATION ' + fmt(deep.depthM) + ' m') : '');
      els.cardLift.style.display = '';
    } else {
      els.cardLift.textContent = '';
      els.cardLift.style.display = 'none';
    }

    /* "You can enter, but it will hurt" — the honest message, not a locked
     * door. Under-gunned is slow and expensive, never refused. */
    var warn = '';
    if (rec > 0 && yours < rec * 0.7) warn = 'Your drill will stall in this rock. Expect to burn fuel for every metre.';
    else if (rec > 0 && yours < rec) warn = 'Under-gunned for this ground. Workable, but slow and thirsty.';
    // Endurance against depth: the other half of "can I get home from here?",
    // and the thing that actually separates two mines at the same price.
    var end = rigNum('getEndurance', 0);
    if (!warn && end > 0 && num(m.depth, 0) > 0) {
      var climb = num(m.depth, 0) / (rigNum('getSpeed', 200) * MPU);   // seconds, straight up
      if (climb * 2.6 > end) warn = 'A full tank barely covers the round trip at this depth. Fit a bigger tank first.';
    }
    els.cardWarn.textContent = warn;
    els.cardWarn.style.display = warn ? '' : 'none';

    els.cardRes.innerHTML = '';
    chipRow(els.cardRes, 'COMMON', m.common);
    chipRow(els.cardRes, 'RARE', m.rare);
    var haz = (m.hazards && m.hazards.length) ? m.hazards.join('  ·  ') : '';
    els.cardHaz.textContent = haz ? ('HAZARDS   ' + haz.toUpperCase()) : '';
    els.cardHaz.style.display = haz ? '' : 'none';

    var b = els.cardBtn;
    b.disabled = false;
    b.classList.remove('sm-av-cant');
    if (owned) {
      b.textContent = 'PREPARE DESCENT';
    } else if (cash >= price) {
      b.textContent = 'BUY RIGHTS  ' + money(price);
    } else {
      b.textContent = 'NEED ' + money(price - cash) + ' MORE';
      b.disabled = true;
      b.classList.add('sm-av-cant');
    }
  }

  /**
   * HEAT · GROUND · PAY, straight off the layer table.
   *
   * This is the row that makes a fork in the catalogue legible: two mines can
   * be within a few thousand dollars of each other and be a safe bet and a
   * gamble respectively, and the only honest way to say so is to read the
   * layers the player is about to drive through. A mine with no `layers` (or a
   * catalogue that has not landed yet) simply gets no row.
   */
  function paintProfile(m) {
    var box = els.cardProfile;
    box.innerHTML = '';
    var layers = (m && m.layers && m.layers.length) ? m.layers : null;
    if (!layers) { box.style.display = 'none'; return; }
    box.style.display = '';

    var heat = 0, hard = 0, i, L;
    for (i = 0; i < layers.length; i++) {
      L = layers[i];
      if (!L) continue;
      if (num(L.heat, 0) > heat) heat = num(L.heat, 0);
      if (num(L.hardnessScale, 1) > hard) hard = num(L.hardnessScale, 1);
    }

    var heatWord = heat <= 0.001 ? 'NONE' : (heat < 0.35 ? 'MILD' : (heat < 0.7 ? 'HOT' : 'SEVERE'));
    var heatTone = heat <= 0.001 ? 'good' : (heat < 0.7 ? 'warn' : 'bad');
    var groundWord = hard <= 1.0 ? 'SOFT' : (hard < 1.12 ? 'FIRM' : 'HARD');
    var groundTone = hard <= 1.0 ? 'good' : (hard < 1.12 ? 'warn' : 'bad');

    // The best thing in the ground, by price — what the trip is actually for.
    var payId = '', payVal = -1;
    var pool = (m.rare && m.rare.length) ? m.rare : m.common;
    if (pool) {
      for (i = 0; i < pool.length; i++) {
        var v = (SM.mines && SM.mines.priceOf) ? num(SM.mines.priceOf(pool[i]), 0) : 0;
        if (v > payVal) { payVal = v; payId = pool[i]; }
      }
    }

    profileCell(box, 'HEAT', heatWord, heatTone);
    profileCell(box, 'GROUND', groundWord, groundTone);
    if (payId) {
      var d = displayOf(payId);
      var c = profileCell(box, 'PAYS FOR', d.name.toUpperCase(), '');
      c.style.setProperty('--sm-av-chip', d.color);
      c.classList.add('sm-av-prof-ore');
    }
  }

  function profileCell(parent, label, value, tone) {
    var cell = el('div', 'sm-av-prof' + (tone ? (' sm-av-prof-' + tone) : ''), parent);
    el('span', 'sm-av-prof-label', cell, label);
    el('span', 'sm-av-prof-value', cell, value);
    return cell;
  }

  function chipRow(parent, label, ids) {
    if (!ids || !ids.length) return;
    var row = el('div', 'sm-av-chiprow', parent);
    el('span', 'sm-av-chiplabel', row, label);
    for (var i = 0; i < ids.length; i++) {
      var d = displayOf(ids[i]);
      var chip = el('span', 'sm-av-chip', row, d.name.toUpperCase());
      chip.style.setProperty('--sm-av-chip', d.color);
    }
  }

  function onMineAction() {
    var m = (SM.mines && SM.mines.get) ? SM.mines.get(selMine) : null;
    if (!m) return;
    if (ownsMine(m)) {
      if (SM.adv && SM.adv.selectMine) SM.adv.selectMine(m.id);
      return;
    }
    var ok = !!(SM.adv && SM.adv.buyRights && SM.adv.buyRights(m.id));
    if (ok) {
      toast('RIGHTS ACQUIRED', String(m.name || m.id).toUpperCase() + ' is yours to dig', 2.4);
      refresh();
    } else {
      toast('PURCHASE REFUSED', 'The ledger will not cover it', 2.0);
    }
  }

  /* ---------------------------------------------------------------------
   * GARAGE
   * ------------------------------------------------------------------ */
  function buildGarage() {
    var s = makeScreen('garage', 'THE WORKSHOP · EIGHT SUBASSEMBLIES', 'YOUR MACHINE');

    var stage = el('div', 'sm-av-rig', s.body);
    els.rigStage = stage;
    els.rigCanvas = el('canvas', 'sm-av-rig-canvas', stage);
    els.rigHots = el('div', 'sm-av-hots', stage);
    for (var i = 0; i < PARTS.length; i++) partTags[PARTS[i].key] = makeHotspot(PARTS[i]);

    var d = el('div', 'sm-panel sm-av-part', s.body);
    els.part = d;
    el('div', 'sm-stripe', d);
    var head = el('div', 'sm-av-card-head', d);
    els.partName = el('div', 'sm-av-card-name', head, '');
    els.partTier = el('div', 'sm-av-card-region', head, '');
    els.partBlurb = el('div', 'sm-av-card-blurb', d, '');
    els.partPips = el('div', 'sm-av-pips', d);
    var grid = el('div', 'sm-av-card-grid', d);
    els.partStat = statCell(grid, 'FITTED', '0');
    els.partNext = statCell(grid, 'NEXT TIER', '—');
    /* WHAT THE NEXT TIER LETS YOU DO. rig.js writes one line of sales copy per
     * tier and that line is the only thing the workshop should ever be
     * selling — a stat delta says "12% more drill", this says "the Rift locks
     * open". Shown in the warn slot's styling because it is the pitch. */
    els.partSell = el('div', 'sm-av-warn sm-av-sell', d, '');
    els.partDelta = el('div', 'sm-av-sub sm-av-delta', d, '');

    els.partBtn = button(s.foot, 'sm-btn-primary sm-btn-big', 'INSTALL');
    onTap(els.partBtn, onBuyPart);

    /* STRAIGHT BACK DOWN FROM HERE TOO.
     * Fitting a part is something you do BETWEEN descents, on the mine you are
     * already working — so making the workshop a dead end that only exits to the
     * world map put the same detour back in that the extraction screen just
     * lost. Only offered when there is a mine to go back to. */
    els.garageDive = button(s.foot, '', 'BACK TO MINE');
    onTap(els.garageDive, onBackToMine);

    onTap(button(s.foot, '', 'BACK TO THE MAP'), function () {
      if (SM.adv && SM.adv.backToMap) SM.adv.backToMap();
      else if (SM.adv && SM.adv.openMap) SM.adv.openMap();
    });
  }

  /** The mine a BACK TO MINE button would descend into, or '' if there is none. */
  function lastMineId() {
    var r = (SM.adv && SM.adv.getResults) ? SM.adv.getResults() : null;
    if (r && r.mineId) return r.mineId;
    var m = (SM.adv && SM.adv.getMine) ? SM.adv.getMine() : null;
    if (m && m.id) return m.id;
    return selMine || '';
  }

  function makeHotspot(part) {
    var node = el('button', 'sm-av-hot', els.rigHots);
    node.setAttribute('type', 'button');
    node.setAttribute('title', part.title);
    // Position is written by drawRig(), which is the only place that knows the
    // garage transform. A sane default keeps them on-screen before the first
    // paint (e.g. if the canvas has no size yet).
    node.style.left = '50%';
    node.style.top = '50%';
    el('span', 'sm-av-hot-dot', node);
    var lbl = el('span', 'sm-av-hot-lbl', node, part.title);
    var lv = el('span', 'sm-av-hot-lv', node, '');
    onTap(node, function () {
      selPart = part.key;
      paintGarage();
    });
    return { node: node, label: lbl, lv: lv, part: part };
  }

  function paintGarage() {
    var i, t, p;
    for (i = 0; i < PARTS.length; i++) {
      p = PARTS[i];
      t = partTags[p.key];
      var tier = rigTier(p.key);
      var maxed = rigMaxed(p.key);
      t.lv.textContent = tier > 0 ? ('MK ' + roman(tier + 1)) : '';
      t.node.classList[selPart === p.key ? 'add' : 'remove']('sm-av-hot-sel');
      t.node.classList[maxed ? 'add' : 'remove']('sm-av-hot-max');
      var cost = rigCost(p.key);
      var can = cost >= 0 && advNum('getCash', 0) >= cost;
      t.node.classList[can ? 'add' : 'remove']('sm-av-hot-buy');
    }
    paintPart();
    drawRig();

    /* BACK TO MINE only exists when there is somewhere to go back to, and it
     * says whether the tank can actually do it — the alternative is a button
     * that drops you into a shaft on an empty tank and ends the run instantly. */
    if (els.garageDive) {
      var id = lastMineId();
      var aboard = advNum('getTank', 0);
      els.garageDive.style.display = id ? '' : 'none';
      if (id) {
        // Label stays put; an empty tank just greys it out. See paintResFooter().
        els.garageDive.textContent = 'BACK TO MINE';
        if (aboard < 1) els.garageDive.setAttribute('disabled', 'disabled');
        else els.garageDive.removeAttribute('disabled');
      }
    }
  }

  function rigTier(key) { return (SM.rig && SM.rig.getTier) ? num(SM.rig.getTier(key), 0) : 0; }
  function rigMaxed(key) { return !!(SM.rig && SM.rig.isMaxed && SM.rig.isMaxed(key)); }
  function rigCost(key) { return (SM.rig && SM.rig.nextCost) ? num(SM.rig.nextCost(key), -1) : -1; }
  function rigMax(key) { return (SM.rig && SM.rig.maxTier) ? num(SM.rig.maxTier(key), 0) : 0; }

  function partMeta(key) {
    for (var i = 0; i < PARTS.length; i++) if (PARTS[i].key === key) return PARTS[i];
    return PARTS[0];
  }

  /** The tier descriptor at an absolute index, however rig.js exposes it. */
  function tierInfo(key, n) {
    if (SM.rig && SM.rig.getTierInfo) {
      var t = SM.rig.getTierInfo(key, n);
      if (t) return t;
    }
    var rec = (SM.rig && SM.rig.getPart) ? SM.rig.getPart(key) : null;
    if (rec && rec.tiers && rec.tiers[n]) return rec.tiers[n];
    return null;
  }

  /**
   * 'POWER 21 -> 35   ·   CAP 14 -> 20'.
   * rig.js names the fields that matter for a part in `stats`, and each tier
   * descriptor carries them, so the delta is read off the real table rather
   * than guessed at — and a part table without `stats` simply prints nothing
   * instead of inventing numbers.
   */
  function statDelta(key, rec, tier, maxed) {
    if (!rec || !rec.stats || !rec.stats.length) return '';
    var a = tierInfo(key, tier);
    var b = maxed ? null : tierInfo(key, tier + 1);
    if (!a) return '';
    var out = [];
    for (var i = 0; i < rec.stats.length; i++) {
      var s = rec.stats[i];
      var av = a[s];
      if (typeof av !== 'number') continue;
      var line = String(s).toUpperCase() + ' ' + trim1(av);
      if (b && typeof b[s] === 'number' && b[s] !== av) line += ' → ' + trim1(b[s]);
      out.push(line);
    }
    return out.join('   ·   ');
  }

  /** One decimal, but only when there is one — 8.5 stays 8.5, 21.0 reads 21. */
  function trim1(v) {
    var r = Math.round(v * 10) / 10;
    return (r === (r | 0)) ? ('' + (r | 0)) : r.toFixed(1);
  }

  function paintPart() {
    var p = partMeta(selPart);
    var tier = rigTier(p.key);
    var cost = rigCost(p.key);
    var maxed = rigMaxed(p.key);
    var nextName = (SM.rig && SM.rig.nextName) ? SM.rig.nextName(p.key) : null;

    /* rig.js may or may not have a rich part record yet. Whatever it has is
     * preferred over the local copy; the local copy is what keeps the screen
     * readable while Agent 2 is still building the table. */
    var rec = (SM.rig && SM.rig.getPart) ? SM.rig.getPart(p.key) : null;
    var title = (rec && rec.title) ? rec.title : p.title;
    var blurb = (rec && rec.blurb) ? rec.blurb : p.blurb;

    /* The FITTED tier's own name, when rig.js has one — 'WORN AUGER BIT' tells
     * the player what is bolted to their machine; 'MK I' tells them nothing. */
    var cur = tierInfo(p.key, tier);
    els.partName.textContent = String(title).toUpperCase();
    els.partTier.textContent = 'FITTED: ' + (cur && cur.name ? String(cur.name).toUpperCase()
                                                            : ('MK ' + roman(tier + 1)));
    els.partBlurb.textContent = blurb;

    els.partStat.textContent = p.stat + '  ' + fmt(p.get()) + p.unit;
    els.partNext.textContent = maxed ? 'FULLY UPGRADED' : (nextName ? String(nextName).toUpperCase() : 'NEXT TIER');

    // The pitch, and then the arithmetic under it.
    var sell = (!maxed && SM.rig && SM.rig.nextBlurb) ? SM.rig.nextBlurb(p.key) : null;
    els.partSell.textContent = sell ? String(sell) : '';
    els.partSell.style.display = sell ? '' : 'none';
    els.partDelta.textContent = statDelta(p.key, rec, tier, maxed);

    // Tier pips: the progression at a glance, and the only place the machine's
    // remaining headroom is visible.
    var max = rigMax(p.key);
    var want = max + 1;
    if (want < 1) want = 1;
    if (els.partPips.childNodes.length !== want) {
      els.partPips.innerHTML = '';
      for (var i = 0; i < want; i++) el('span', 'sm-av-pip', els.partPips);
    }
    for (var j = 0; j < els.partPips.childNodes.length; j++) {
      els.partPips.childNodes[j].className = 'sm-av-pip' + (j <= tier ? ' sm-av-pip-on' : '');
    }

    /* THE BUTTON KEEPS ITS NAME AND GREYS OUT; the REASON goes in the panel.
     * A control that renames itself to "NOTHING LEFT TO FIT" or "NEED $2 000
     * MORE" is a status readout wearing a button's clothes, and the label moves
     * under the player's thumb. INSTALL always says INSTALL and what it costs;
     * why it is unavailable is written above it, where there is room to say it
     * properly. */
    var fit = (SM.rig && SM.rig.fitCheck) ? SM.rig.fitCheck(p.key) : { ok: true };
    var short = cost >= 0 ? (cost - advNum('getCash', 0)) : 0;
    var b = els.partBtn;
    b.disabled = false;
    b.classList.remove('sm-av-cant');
    b.textContent = (!maxed && cost >= 0) ? ('INSTALL  ' + money(cost)) : 'INSTALL';

    var block = '';
    if (maxed || cost < 0) {
      block = '';                                  // the pips already say it
      b.disabled = true;
      b.classList.add('sm-av-cant');
    } else if (!fit.ok) {
      /* RUNNING GEAR BEFORE POWER. Name the actual part the player has to buy,
       * not the rule — "REQUIRES WIDE STEEL TRACKS" is a shopping instruction,
       * "prerequisite not met" is a error message. */
      var needTitle = fit.needKey ? String(fit.needKey).toUpperCase() : 'RUNNING GEAR';
      block = 'REQUIRES ' + needTitle +
              (fit.needName ? (': ' + String(fit.needName).toUpperCase()) : '') +
              ' — the tracks cannot carry this engine yet.';
      b.disabled = true;
      b.classList.add('sm-av-cant');
    } else if (short > 0) {
      block = 'NEED ' + money(short) + ' MORE IN THE ACCOUNT.';
      b.disabled = true;
      b.classList.add('sm-av-cant');
    }
    if (block) {
      els.partSell.textContent = block;
      els.partSell.style.display = '';
    }
  }

  function onBuyPart() {
    var p = partMeta(selPart);
    var before = rigTier(p.key);
    var ok = !!(SM.adv && SM.adv.buyPart && SM.adv.buyPart(p.key));
    if (ok || rigTier(p.key) !== before) {
      toast(String(p.title) + ' UPGRADED', 'MK ' + roman(rigTier(p.key) + 1) + ' fitted and bolted down', 2.4);
      if (SM.effects && SM.effects.screenFlash) SM.effects.screenFlash(0.10, 255, 210, 120);
      refresh();
    } else {
      toast('INSTALL REFUSED', 'The ledger will not cover it', 2.0);
    }
  }

  /**
   * THE MACHINE, DRAWN BY THE REAL RENDERER.
   * vehicle.render() draws in world space around SM.vehicle.getX/getY with -y
   * forward, so the garage transform is: centre the canvas, scale to frame
   * GARAGE_VIEW_H world units, then translate the machine's own position back
   * to the origin. No second illustration to drift out of step, and every part
   * flag rig.js sets shows up here the moment it is bought.
   */
  function drawRig() {
    var c = els.rigCanvas;
    if (!c || !c.getContext) return;
    var w = c.clientWidth | 0;
    var h = c.clientHeight | 0;
    if (w < 20 || h < 20) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }

    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    /* --- the shop floor: a plate, a grid and a pool of work light -------- */
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(24,27,33,0.92)');
    g.addColorStop(1, 'rgba(10,11,14,0.96)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(120,140,165,0.09)';
    ctx.lineWidth = 1;
    var step = 34;
    ctx.beginPath();
    for (var gx = (w * 0.5) % step; gx < w; gx += step) { ctx.moveTo(gx, 0); ctx.lineTo(gx, h); }
    for (var gy = (h * 0.5) % step; gy < h; gy += step) { ctx.moveTo(0, gy); ctx.lineTo(w, gy); }
    ctx.stroke();
    var lamp = ctx.createRadialGradient(w * 0.5, h * 0.42, 10, w * 0.5, h * 0.42, Math.max(w, h) * 0.62);
    lamp.addColorStop(0, 'rgba(255,214,140,0.16)');
    lamp.addColorStop(1, 'rgba(255,214,140,0)');
    ctx.fillStyle = lamp;
    ctx.fillRect(0, 0, w, h);

    /* THE GARAGE TRANSFORM. GARAGE_VIEW_H is how many world units of machine
     * fill the frame's height; the width term keeps a very wide blade inside a
     * narrow canvas. Everything below — the machine and the eight hotspots —
     * goes through these same three numbers, which is why a tag cannot drift
     * off its subassembly. */
    var cx = w * 0.5, cy = h * 0.52;
    var s = h / GARAGE_VIEW_H;
    var sw = w / (GARAGE_VIEW_H * 1.15);
    if (sw < s) s = sw;
    if (s < GARAGE_MIN_S) s = GARAGE_MIN_S;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    var vx = 0, vy = 0;
    if (SM.vehicle && SM.vehicle.getX) { vx = num(SM.vehicle.getX(), 0); vy = num(SM.vehicle.getY(), 0); }
    ctx.translate(-vx, -vy);
    placeHotspots(cx, cy, s);
    try {
      if (SM.vehicle && SM.vehicle.render) SM.vehicle.render(ctx);
    } catch (e) {
      // The renderer belongs to another agent and may be mid-edit. A workshop
      // that cannot draw the machine is a bad screen; one that throws takes
      // the whole campaign down with it.
      ctx.restore();
      ctx.fillStyle = 'rgba(255,90,72,0.65)';
      ctx.font = '600 12px ' + 'ui-monospace, monospace';
      ctx.fillText('MACHINE PREVIEW UNAVAILABLE', 14, h - 14);
      return;
    }
    ctx.restore();
  }

  /**
   * Put the eight tags on the machine, in canvas pixels, using the garage
   * transform and the machine's CURRENT geometry. vehicle.js publishes the two
   * numbers that matter (getWidth() is the hull's full width, getBladeFrontY()
   * the nose in local space); both grow with upgrades, so the tags spread out
   * as the machine does instead of being authored once against the starter rig.
   */
  function placeHotspots(cx, cy, s) {
    var bl = (SM.config && SM.config.VEHICLE_BODY_LENGTH) ? SM.config.VEHICLE_BODY_LENGTH : 158;
    var hw = 48;
    if (SM.vehicle && SM.vehicle.getWidth) {
      var wd = num(SM.vehicle.getWidth(), 96);
      if (wd > 10) hw = wd * 0.5;
    }
    var nose = -bl * 0.5 - 40;
    if (SM.vehicle && SM.vehicle.getBladeFrontY) {
      var f = num(SM.vehicle.getBladeFrontY(), nose);
      if (f < 0) nose = f;
    }
    /* Keep every tag inside the frame. A fully upgraded hull with the magnet
     * arms deployed is wide enough to push the LIGHTS and SCANNER tags off a
     * 372 px phone canvas, and half a clipped word names nothing. */
    var w = els.rigCanvas ? (els.rigCanvas.clientWidth | 0) : 0;
    var h = els.rigCanvas ? (els.rigCanvas.clientHeight | 0) : 0;
    var mx = 34, my = 18;
    for (var i = 0; i < PARTS.length; i++) {
      var p = PARTS[i], t = partTags[p.key];
      if (!t) continue;
      // ly is in body lengths, except the drill, which rides the actual nose.
      var ly = (p.key === 'drill') ? (nose * 1.02) : (p.ly * bl * 0.5);
      var lx = p.lx * hw;
      var px = cx + lx * s, py = cy + ly * s;
      if (w > mx * 2) px = Math.max(mx, Math.min(w - mx, px));
      if (h > my * 2) py = Math.max(my, Math.min(h - my, py));
      t.node.style.left = Math.round(px) + 'px';
      t.node.style.top = Math.round(py) + 'px';
    }
  }

  /* ---------------------------------------------------------------------
   * PREP
   * ------------------------------------------------------------------ */
  function buildPrep() {
    var s = makeScreen('prep', 'LAST CHECKS BEFORE THE DARK', 'PREPARE DESCENT');

    var top = el('div', 'sm-panel sm-av-prep-mine', s.body);
    el('div', 'sm-stripe', top);
    els.prepName = el('div', 'sm-av-card-name', top, '');
    els.prepMeta = el('div', 'sm-av-card-region', top, '');
    els.prepStrata = el('div', 'sm-av-strata', top);

    /* NO FUEL WIDGET. There used to be a slider here, with EMPTY / HALF / FILL
     * THE TANK under it and a line of arithmetic under that — four controls and
     * a readout for a decision nobody was ever really making. Descending on a
     * part tank is not a strategy, it is a way to lose a run, and the one number
     * that mattered (what the trip costs) is on the DESCEND button anyway.
     *
     * So the descent buys the tank out, adv.enterMine() does the buying, and the
     * screen went from three panels to two. What is left here is the two things
     * a player genuinely chooses between runs: WHERE THE LIFT DROPS THEM, and
     * whether to weld the hull up first. */
    buildPrepLift(s);

    /* THE HULL IS ONE ROW, AND ONLY WHEN IT IS BROKEN.
     * A full panel — heading, percentage, bar, button — for a gauge that reads
     * 100% on most visits is furniture. Damaged, it is a decision; intact, it is
     * not even a sentence. So it collapses to a single line that is simply
     * absent at full integrity, and the HUD carries the reading underground. */
    els.repairRow = el('div', 'sm-panel sm-av-repair', s.body);
    el('div', 'sm-stripe', els.repairRow);
    el('div', 'sm-av-repair-lbl', els.repairRow, 'HULL');
    els.hullPct = el('div', 'sm-av-repair-pct', els.repairRow, '100%');
    var hbar = el('div', 'sm-av-bar sm-av-repair-bar', els.repairRow);
    els.hullFill = el('div', 'sm-av-bar-fill', hbar);
    els.repairBtn = button(els.repairRow, 'sm-av-repair-btn', 'REPAIR');
    onTap(els.repairBtn, function () {
      var ok = !!(SM.adv && SM.adv.buyRepair && SM.adv.buyRepair());
      toast(ok ? 'HULL REPAIRED' : 'REPAIR REFUSED',
            ok ? 'Plates welded, seams checked' : 'The ledger will not cover it', 2.0);
      refresh();
    });

    els.descend = button(s.foot, 'sm-btn-primary sm-btn-big sm-av-descend', 'DESCEND');
    onTap(els.descend, onDescend);
    onTap(button(s.foot, 'sm-av-quiet', 'BACK'), function () {
      if (SM.adv && SM.adv.backToMap) SM.adv.backToMap();
    });
  }

  function fuelPrice() {
    var p = (SM.mines && SM.mines.fuelPrice) ? num(SM.mines.fuelPrice(), FALLBACK_FUEL_PRICE) : FALLBACK_FUEL_PRICE;
    return p > 0 ? p : FALLBACK_FUEL_PRICE;
  }

  /**
   * How much fuel the descent is about to buy: the room left in the tank,
   * clamped by what the company can actually pay for.
   *
   * The clamp is what keeps DESCEND honest. adv.buyFuel() already buys what the
   * money reaches rather than refusing outright, so quoting the price of a FULL
   * tank to a player who cannot afford one would put a number on the button that
   * the ledger never charges.
   *
   * getTANK, not getFuel: what is bought and aboard, NOT the in-run gauge.
   * getFuel() still reads the level the last descent ended on, so sizing the
   * purchase against it would top up only what the previous run had burnt.
   */
  function fuelMax() {
    var cap = rigNum('getFuelCap', 100);
    var have = advNum('getTank', 0);
    var room = cap - have;
    if (room < 0) room = 0;
    var afford = Math.floor(advNum('getCash', 0) / fuelPrice());
    return Math.min(room, afford);
  }

  /** What the tank costs to fill. mines.fuelCost() owns the rounding. */
  function descendCost() {
    var u = fuelMax();
    if (u <= 0) return 0;
    return (SM.mines && SM.mines.fuelCost) ? num(SM.mines.fuelCost(u), u * fuelPrice())
                                           : u * fuelPrice();
  }

  /* ---------------------------------------------------------------------
   * THE LEVEL PICKER
   * ---------------------------------------------------------------------
   * The mine entrance is a LIFT, and the levels are the stations cut into it at
   * the geological boundaries. Buying one is the campaign's real progression:
   * it is not a stat, it is 200 m of climbing you never have to do again.
   *
   * So this panel does two jobs and keeps them visibly separate. The rows a
   * company OWNS are a choice — tap one and the descent starts there. The first
   * row it does NOT own is a purchase, with its price and a BUY beside it, and
   * nothing past it is offered at all: a lift is dug downwards, so skipping a
   * station is not a thing you can pay for.
   * ------------------------------------------------------------------ */
  function buildPrepLift(s) {
    els.prepLift = el('div', 'sm-panel sm-av-prep-lift', s.body);
    el('div', 'sm-stripe', els.prepLift);
    var head = el('div', 'sm-av-card-head', els.prepLift);
    el('div', 'sm-av-card-name', head, 'THE LIFT');
    els.liftCount = el('div', 'sm-av-card-region', head, '');
    els.liftList = el('div', 'sm-av-levels', els.prepLift);
    /* THE PANEL TEXT, WHICH IS WHERE EVERY REASON GOES.
     * Where the descent starts, and — when BUY is greyed — why. The button keeps
     * its name and dims; it never renames itself into a status message. */
    els.liftNote = el('div', 'sm-av-sub sm-av-lift-note', els.prepLift, '');
  }

  function paintPrepLift(m) {
    var id = (m && m.id) ? m.id : selMine;
    var levels = liftLevels(id);
    els.liftList.innerHTML = '';

    /* NO LIFT TABLE, NO PANEL. adv.js may not have levels for this mine yet (or
     * at all, while the lift is still being built), and an empty box that says
     * nothing is worse than no box. The descent still works: enterMine() with no
     * level starts at the mouth, exactly as it always did. */
    if (!levels) {
      els.prepLift.style.display = 'none';
      els.liftNote.textContent = '';
      return;
    }
    els.prepLift.style.display = '';

    var owned = ownedCount(levels);
    var deepest = deepestOwned(levels);
    var nextI = nextUnowned(levels);

    /* WHEN THE SELECTION GOES BACK TO THE DEEPEST STATION.
     *
     * A choice the player made by hand is worth keeping between visits — but only
     * while it still means the same thing. Two events invalidate it:
     *
     *   THE MINE CHANGED. Level 3 of Old Creek is not level 3 of The Rift, and
     *   carrying the index across would silently descend into the wrong hole.
     *
     *   A LEVEL WAS BOUGHT OR LOST. Somebody who has just paid for a station
     *   at 1 140 m wants to start there, not at whatever they picked last time;
     *   and a slot switch or a reload can take a level away again. Comparing the
     *   OWNED COUNT catches both, and it catches purchases made anywhere — the
     *   BUY on this screen, a future one on the map — without either caller
     *   having to remember to reset anything.
     */
    if (prepLevelMine !== id || prepLevelOwned !== owned) {
      prepLevelMine = id;
      prepLevelOwned = owned;
      prepLevel = deepest;
    }
    // Belt and braces: never leave the selection on ground that is not held.
    if (prepLevel < 0 || !levels[prepLevel] || !levels[prepLevel].owned) prepLevel = deepest;

    els.liftCount.textContent = fmt(owned) + ' OF ' + fmt(levels.length) + ' LEVELS';

    var cash = advNum('getCash', 0);
    var blocked = '';
    for (var i = 0; i < levels.length; i++) {
      var L = levels[i];
      if (!L) continue;
      var state = L.owned ? 'owned' : (i === nextI ? 'next' : 'locked');
      var short = makeLevelRow(L, i, state, cash);
      if (short) blocked = short;
    }

    var selL = levels[prepLevel] || levels[0];
    // "START AT SURFACE · 0 m DOWN" is a sentence with nothing in it. The mouth
    // gets its own wording, because starting there means the whole shaft on tracks.
    var line = (prepLevel === 0)
      ? 'START AT THE MOUTH   ·   THE WHOLE SHAFT ON TRACKS'
      : ('START AT ' + levelLabel(selL) + '   ·   ' + fmt(num(selL.depthM, 0)) + ' m DOWN');
    if (nextI < 0) line += '   ·   THE SHAFT IS FULLY CUT';
    els.liftNote.textContent = blocked ? (line + '\n' + blocked) : line;
  }

  /**
   * One station. Returns the blocking reason when its BUY had to be greyed out,
   * so the caller can put it in the panel text rather than on the button.
   */
  function makeLevelRow(L, i, state, cash) {
    var row = el('div', 'sm-av-level sm-av-level-' + state, els.liftList);
    if (state === 'owned' && i === prepLevel) row.classList.add('sm-av-level-sel');

    var go = el('button', 'sm-av-level-go', row);
    go.setAttribute('type', 'button');
    el('span', 'sm-av-level-i', go, i === 0 ? 'SURF' : ('L' + i));
    el('span', 'sm-av-level-name', go, levelLabel(L));
    el('span', 'sm-av-level-depth', go, fmt(num(L.depthM, 0)) + ' m');
    var tag = el('span', 'sm-av-level-tag', go, '');

    if (state === 'owned') {
      tag.textContent = (i === prepLevel) ? 'START' : 'HELD';
      onTap(go, function () {
        prepLevel = i;
        paintPrep();
      });
      return '';
    }

    // Not owned: the row is a read, not a control. Only its BUY takes a tap.
    go.disabled = true;
    var price = num(L.price, 0);
    if (state === 'locked') {
      tag.textContent = 'SEALED';
      return '';
    }
    tag.textContent = money(price);

    /* BUY keeps its name and greys out; the shortfall goes in the panel text.
     * :disabled does the greying (see the stylesheet's UNAVAILABLE rule), so the
     * older sm-av-cant class is deliberately not used here — one mechanism. */
    var b = button(row, 'sm-av-level-buy', 'BUY');
    onTap(b, function () { onBuyLevel(i, L); });
    var short = price - cash;
    if (short > 0) {
      b.disabled = true;
      return 'NEED ' + money(short) + ' MORE TO CUT ' + levelLabel(L) + '.';
    }
    return '';
  }

  function onBuyLevel(i, L) {
    var ok = !!(SM.adv && SM.adv.buyLevel && SM.adv.buyLevel(i));
    if (ok) {
      toast('LEVEL CUT', levelLabel(L) + ' at ' + fmt(num(L.depthM, 0)) + ' m is open', 2.6);
      if (SM.effects && SM.effects.screenFlash) SM.effects.screenFlash(0.10, 255, 210, 120);
      // The new station is almost certainly where the player now wants to start.
      prepLevel = i;
    } else {
      toast('THE CUT WAS REFUSED', 'The ledger will not cover it', 2.0);
    }
    refresh();
  }

  function paintPrep() {
    var m = (SM.adv && SM.adv.getMine) ? SM.adv.getMine() : null;
    if (!m && SM.mines && SM.mines.get) m = SM.mines.get(selMine);
    var name = m ? String(m.name || m.id) : 'THE MINE';
    els.prepName.textContent = name.toUpperCase();
    els.prepMeta.textContent = m
      ? (String(m.region || '').toUpperCase() + '   ·   EST. ' + fmt(num(m.depth, 0)) + ' m   ·   REC. DRILL ' +
         fmt(num(m.recDrill, 0)) + '   ·   YOURS ' + fmt(rigNum('getDrillPower', 0)))
      : '';

    /* THE GEOLOGICAL REPORT. The layer table is the honest version of "what am
     * I driving into": one band per layer, deepest last, in the bulk material's
     * own colour, with the ore that band can pay out. */
    els.prepStrata.innerHTML = '';
    var layers = (m && m.layers && m.layers.length) ? m.layers : null;
    if (layers) {
      var from = 0;
      for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        if (!L) continue;
        var row = el('div', 'sm-av-stratum', els.prepStrata);
        var d = displayOf(L.fill);
        row.style.setProperty('--sm-av-chip', d.color);
        el('span', 'sm-av-stratum-sw', row);
        el('span', 'sm-av-stratum-name', row, String(L.name || d.name).toUpperCase());
        el('span', 'sm-av-stratum-depth', row, fmt(from) + '–' + fmt(num(L.toDepth, 0)) + ' m');
        var ores = [];
        if (L.weights) for (var k in L.weights) if (L.weights.hasOwnProperty(k)) ores.push(displayOf(k).name);
        el('span', 'sm-av-stratum-ore', row, ores.length ? ores.join(', ').toUpperCase() : '—');
        from = num(L.toDepth, from);
      }
    } else if (m) {
      var line = el('div', 'sm-av-sub', els.prepStrata, '');
      var bits = [];
      if (m.common && m.common.length) bits.push('COMMON ' + m.common.join(', ').toUpperCase());
      if (m.rare && m.rare.length) bits.push('RARE ' + m.rare.join(', ').toUpperCase());
      if (m.hazards && m.hazards.length) bits.push('HAZARDS ' + m.hazards.join(', ').toUpperCase());
      line.textContent = bits.join('   ·   ') || 'NO SURVEY ON FILE';
    }

    paintPrepLift(m);

    /* THE HULL ROW, WHICH IS ABSENT AT FULL INTEGRITY.
     * mines.repairCost() takes the 0..1 fraction adv.js reports and returns the
     * dollars for a FULL repair — the units are easy to get wrong by hand
     * (integrity is 0..100 points inside mines.js), so let it do it. */
    var integ = advNum('getIntegrity', 1);
    var needsRepair = integ < 0.999;
    els.repairRow.style.display = needsRepair ? '' : 'none';
    if (needsRepair) {
      els.hullPct.textContent = Math.round(integ * 100) + '%';
      els.hullFill.style.setProperty('--sm-av-fill', integ.toFixed(3));
      els.hullFill.className = 'sm-av-bar-fill' + (integ < 0.4 ? ' sm-av-bar-bad' : '');
      els.repairRow.classList[integ < 0.4 ? 'add' : 'remove']('sm-av-repair-bad');
      var full = (SM.mines && SM.mines.repairCost) ? num(SM.mines.repairCost(integ), 0)
        : Math.round((1 - integ) * 100 * ((SM.mines && SM.mines.repairPrice) ? num(SM.mines.repairPrice(), 0) : 0));
      els.repairBtn.textContent = full > 0 ? ('REPAIR  ' + money(full)) : 'REPAIR';
      // Label stays, the plate greys: the reason is the percentage next to it.
      if (full > advNum('getCash', 0)) els.repairBtn.setAttribute('disabled', 'disabled');
      else els.repairBtn.removeAttribute('disabled');
    }

    /* DESCEND CARRIES THE WHOLE BILL, because there is nothing else left to
     * price: the tank is bought out on the way down, so this is the entire cost
     * of the expedition and the player commits to it with one tap. */
    var cost = descendCost();
    els.descend.textContent = cost > 0 ? ('DESCEND  ·  ' + money(cost)) : 'DESCEND';
  }

  function onDescend() {
    var m = (SM.adv && SM.adv.getMine) ? SM.adv.getMine() : null;
    var id = (m && m.id) ? m.id : selMine;
    /* THE TANK IS FILLED BY THE DESCENT, not by this screen.
     * `fuel` is passed anyway and adv.enterMine() clamps it to the room left, so
     * whichever side of the seam does the topping up, the money moves exactly
     * once — and the descent is never launched on the empty tank a part-built
     * enterMine() would have given it.
     *
     * The order is snapshotted BEFORE the call because buying moves money, which
     * emits `adv:cash`, which repaints this very screen and re-clamps fuelMax()
     * against a tank that is now full. */
    var units = fuelMax();
    /* `level` IS ALWAYS SENT, INCLUDING ZERO.
     * enterMine() defaults an absent level to the DEEPEST station the company
     * owns, which is the right default for BACK TO MINE — but on this screen the
     * player has just picked one, and a player who picked the mouth on purpose
     * (to work the shallow layers, or because the hold fills before the lift is
     * worth it) must not be dropped 300 m down instead. Omitting a legitimate 0
     * would have been indistinguishable from not choosing. */
    var opts = { fuel: units, level: (prepLevel > 0 ? prepLevel : 0) };
    if (SM.adv && SM.adv.enterMine) SM.adv.enterMine(id, opts);
  }

  /* ---------------------------------------------------------------------
   * RESULTS
   * ------------------------------------------------------------------ */
  function buildResults() {
    var s = makeScreen('results', 'EXTRACTION', 'THE HAUL');
    var card = el('div', 'sm-panel sm-av-res', s.body);
    el('div', 'sm-stripe', card);
    els.resHeadline = el('div', 'sm-av-res-headline', card, '');
    var hero = el('div', 'sm-av-res-hero', card);
    el('div', 'sm-av-res-hero-label', hero, 'HOLD VALUE');
    els.resTotal = el('div', 'sm-av-res-total', hero, '$0');
    els.resLines = el('div', 'sm-av-res-lines', card);
    els.resNote = el('div', 'sm-av-warn', card, '');
    var grid = el('div', 'sm-av-card-grid', card);
    els.resDepth = statCell(grid, 'DEPTH REACHED', '0 m');
    els.resTime = statCell(grid, 'TIME UNDER', '0:00');
    els.resFuel = statCell(grid, 'FUEL LEFT', '0%');
    els.resDay = statCell(grid, 'DAY', '1');

    /* FOUR BUTTONS, ONE JOB EACH.
     * What a player does at the surface is: bank the load, top the tank up, and
     * go back down. Selling used to also walk you out to the world map, so the
     * common case cost a detour through a screen you did not want. Each of these
     * now does exactly the one thing it is named after, and SELL does not
     * navigate at all — you stay here and choose. */
    els.resBtn = button(s.foot, 'sm-btn-primary sm-btn-big', 'SELL THE HAUL');
    onTap(els.resBtn, onSell);
    /* REFUEL HAPPENS HERE, not on the prep screen.
     * Sending the player to prep to buy fuel and press DESCEND put a whole
     * screen in the middle of the one loop they repeat all game: come up, sell,
     * fill up, go back down. It buys a full tank in place and says what it cost. */
    els.resFuel2 = button(s.foot, '', 'REFUEL');
    onTap(els.resFuel2, onRefuelHere);

    /* ...and BACK TO MINE descends straight from here. */
    els.resDive = button(s.foot, '', 'BACK TO MINE');
    onTap(els.resDive, onBackToMine);
    els.resShop = button(s.foot, '', 'WORKSHOP');
    onTap(els.resShop, function () {
      if (SM.adv && SM.adv.openGarage) SM.adv.openGarage();
    });
    els.resMap = button(s.foot, '', 'MAP');
    onTap(els.resMap, function () {
      if (SM.adv && SM.adv.backToMap) SM.adv.backToMap();
    });
  }

  /**
   * Normalise whatever adv.js hands back into one shape:
   *   { stranded, gross, lines:[{name,color,units,value}], depthM, reason }
   * getResults() is the documented source; the live manifest is the fallback so
   * the screen is never empty just because the payload shape moved.
   */
  function readResults() {
    var r = (SM.adv && SM.adv.getResults) ? SM.adv.getResults() : null;
    var out = { stranded: false, gross: 0, lines: [], depthM: 0, reason: '',
                mineName: '', runTime: -1, fuelPct: -1, day: -1 };
    var raw = null, i, ln;

    if (r) {
      out.reason = String(r.reason || '');
      /* adv.js reports `kind` ('extracted' | 'stranded'); the reason strings and
       * a `lost` figure are the fallbacks, so an older or partial payload still
       * lands on the right treatment. */
      out.stranded = (r.kind === 'stranded') || !!(r.stranded) ||
                     out.reason === 'stranded' || out.reason === 'fuel' ||
                     out.reason === 'hull' || out.reason === 'abort' ||
                     (r.kind === undefined && !!r.lost);
      out.gross = num(r.gross, 0);
      out.depthM = num(r.depthM, num(r.maxDepthM, 0));
      out.mineName = String(r.mineName || '');
      out.runTime = num(r.runTime, -1);
      out.day = num(r.day, -1);
      // The run is already torn down by the time this screen opens, so the
      // record's own numbers are the truthful ones — the live getters have
      // been reset.
      if (typeof r.fuelLeft === 'number') {
        var cap = advNum('getFuelCap', 0);
        out.fuelPct = cap > 0 ? (r.fuelLeft / cap) : -1;
      }
      raw = r.lines || r.cargo || r.manifest;
      if (raw && typeof raw.length !== 'number') raw = null;
    }
    if (!raw) {
      var man = (SM.adv && SM.adv.getManifest) ? SM.adv.getManifest() : null;
      raw = (man && typeof man.length === 'number') ? man : [];
    }
    if (!out.depthM) out.depthM = advNum('getMaxDepthM', advNum('getDepthM', 0));

    for (i = 0; i < raw.length; i++) {
      ln = raw[i];
      if (!ln) continue;
      var d = displayOf(ln.matId, ln.matIndex);
      var v = num(ln.value, 0);
      if (!v && SM.mines && SM.mines.priceOf && ln.matId) v = num(SM.mines.priceOf(ln.matId), 0) * num(ln.units, 0);
      out.lines.push({ name: d.name.toUpperCase(), color: d.color, units: num(ln.units, 0), value: v });
    }
    // Richest first: the line that made the run should be the one at the top.
    out.lines.sort(function (a, b) { return b.value - a.value; });
    if (!out.gross) {
      for (i = 0; i < out.lines.length; i++) out.gross += out.lines[i].value;
    }
    return out;
  }

  function paintResults() {
    var r = readResults();
    var sc = screens.results;
    var strand = r.stranded;

    /* ONCE IT IS SOLD, THE HOLD IS EMPTY — so show an empty hold.
     * This screen used to stay up displaying the pre-sale manifest and total,
     * because sell() no longer navigates away and the repaint reads the run's
     * stored payload, which still lists everything that WAS aboard. Leaving the
     * hold value sitting there after the money had moved read as the sale not
     * having happened. The figure is not lost: it moves to the note line as the
     * amount banked, which is the thing worth remembering anyway. */
    var sold = !strand && !!(SM.adv && SM.adv.isSold && SM.adv.isSold());
    if (sold) {
      r.gross = 0;
      r.lines = [];
    }

    sc.node.classList[strand ? 'add' : 'remove']('sm-av-res-strand');
    sc.kicker.textContent = (strand ? 'THE MINE KEPT IT' : 'EXTRACTION COMPLETE') +
                            (r.mineName ? ('  ·  ' + r.mineName.toUpperCase()) : '');
    sc.title.textContent = strand ? 'STRANDED' : 'THE HAUL';
    els.resHeadline.textContent = strand
      ? reasonLine(r.reason, r.depthM)
      : (sold ? 'Sold. The hold is empty and the money is in the account.'
              : (r.lines.length ? 'Back at the surface with the hold intact.'
                                : 'Back at the surface. The hold is empty.'));
    els.resNote.textContent = strand
      ? 'The load is still down there at ' + fmt(r.depthM) + ' m. Go back for it.'
      : (sold ? ('BANKED ' + money(lastSale) + ' into the company account.') : '');
    els.resNote.style.display = (strand || sold) ? '' : 'none';

    els.resDepth.textContent = fmt(r.depthM) + ' m';
    els.resTime.textContent = clock(r.runTime >= 0 ? r.runTime : advNum('getRunTime', 0));
    els.resFuel.textContent = Math.round((r.fuelPct >= 0 ? r.fuelPct : advNum('getFuelPct', 0)) * 100) + '%';
    els.resDay.textContent = fmt(r.day >= 0 ? r.day : advNum('getDay', 1));

    /* A strand has nothing to sell, so SELL steps aside and the footer promotes
     * REFUEL — going straight back down is the whole point of one, because the
     * load is still lying on the floor where the tank ran dry. */
    paintResFooter();

    buildResultLines(r);
    startCountUp(r);
  }

  function reasonLine(reason, depth) {
    if (reason === 'fuel') return 'The tank ran dry at ' + fmt(depth) + ' m.';
    if (reason === 'hull') return 'The hull gave out at ' + fmt(depth) + ' m.';
    if (reason === 'abort') return 'You walked away from the dig at ' + fmt(depth) + ' m.';
    return 'The machine stopped at ' + fmt(depth) + ' m.';
  }

  function clock(t) {
    t = Math.max(0, Math.round(num(t, 0)));
    var m = (t / 60) | 0, s = t - m * 60;
    return m + ':' + (s < 10 ? '0' + s : '' + s);
  }

  function buildResultLines(r) {
    els.resLines.innerHTML = '';
    if (!r.lines.length) {
      el('div', 'sm-av-res-empty', els.resLines, 'NOTHING IN THE HOLD');
      return;
    }
    for (var i = 0; i < r.lines.length; i++) {
      var L = r.lines[i];
      var row = el('div', 'sm-av-res-row', els.resLines);
      row.style.setProperty('--sm-av-chip', L.color);
      el('span', 'sm-av-res-sw', row);
      el('span', 'sm-av-res-name', row, L.name);
      el('span', 'sm-av-res-units', row, fmt(L.units) + 'u');
      L.node = el('span', 'sm-av-res-val', row, '$0');
      L.row = row;
    }
  }

  /**
   * THE COUNT-UP. This is the screen that has to make a full hold feel good, so
   * it gets the only animation loop in the module: each line lands in turn with
   * its value rolling up, and the total rolls with them. The simulation is held
   * while this screen is up, so a rAF loop here costs nothing that matters.
   */
  function startCountUp(r) {
    stopCountUp();
    var t0 = (typeof performance === 'object' && performance.now) ? performance.now() : +new Date();
    var span = COUNT_ROW_MS + COUNT_STAGGER * Math.max(0, r.lines.length - 1);

    function frame() {
      var now = (typeof performance === 'object' && performance.now) ? performance.now() : +new Date();
      var t = now - t0;
      var i, done = true;
      for (i = 0; i < r.lines.length; i++) {
        var L = r.lines[i];
        var lt = (t - i * COUNT_STAGGER) / COUNT_ROW_MS;
        if (lt < 0) { lt = 0; done = false; }
        else if (lt < 1) { done = false; }
        else lt = 1;
        var e = 1 - (1 - lt) * (1 - lt) * (1 - lt);      // ease-out cubic
        if (L.node) L.node.textContent = money(L.value * e);
        if (L.row && lt > 0) L.row.classList.add('sm-av-res-row-in');
      }
      var gt = Math.min(1, t / Math.max(1, span));
      var ge = 1 - (1 - gt) * (1 - gt) * (1 - gt);
      els.resTotal.textContent = money(r.gross * ge);
      if (done && gt >= 1) {
        countRaf = 0;
        els.resTotal.classList.remove('sm-av-res-total-pop');
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(function () { els.resTotal.classList.add('sm-av-res-total-pop'); });
        }
        return;
      }
      countRaf = requestAnimationFrame(frame);
    }
    if (typeof requestAnimationFrame === 'function') countRaf = requestAnimationFrame(frame);
    else els.resTotal.textContent = money(r.gross);
  }

  function stopCountUp() {
    if (countRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(countRaf);
    countRaf = 0;
    if (els.resTotal) els.resTotal.classList.remove('sm-av-res-total-pop');
  }

  function onSell() {
    var before = advNum('getCash', 0);
    var res = (SM.adv && SM.adv.sell) ? SM.adv.sell() : null;
    var gained = advNum('getCash', 0) - before;
    if (res && num(res.gross, 0) > 0) gained = num(res.gross, gained);
    // Remembered for the note line, because the hold itself is zeroed on repaint.
    if (gained > 0) lastSale = gained;
    if (gained > 0) toast('BANKED', money(gained) + ' into the company account', 2.6);
    // sell() deliberately does NOT navigate any more, so repaint in place: the
    // ledger in the header has moved and SELL has nothing left to sell.
    paintSold();
    refresh();
  }

  /** Units of fuel needed to top the tank right up, from what is aboard. */
  function refuelUnits() {
    var cap = rigNum('getFuelCap', 100);
    var have = advNum('getTank', 0);
    var room = cap - have;
    return room > 0.5 ? Math.floor(room) : 0;
  }

  /** Buy a full tank without leaving the extraction screen. */
  function onRefuelHere() {
    var want = refuelUnits();
    if (want <= 0) { toast('TANK FULL', 'Nothing to top up', 1.8); paintResFooter(); return; }
    var quoted = (SM.mines && SM.mines.fuelCost) ? num(SM.mines.fuelCost(want), 0) : 0;
    var before = advNum('getCash', 0);
    var ok = !!(SM.adv && SM.adv.buyFuel && SM.adv.buyFuel(want));
    var spent = before - advNum('getCash', 0);
    if (!ok || spent <= 0) {
      toast('CANNOT REFUEL', 'Not enough in the account for ' + money(quoted), 2.4);
    } else {
      // Partial fills are legitimate: adv.buyFuel() buys what the cash reaches.
      toast('REFUELLED', money(spent) + ' of diesel', 2.2);
    }
    paintResFooter();
    refresh();
  }

  /**
   * Straight back down the same shaft, with no screen in between.
   *
   * The tank is checked FIRST and the descent refused if it is dry, because
   * enterMine() will happily launch on nothing and the run would be over before
   * the player's thumb left the glass — the failure needs to happen up here,
   * next to the REFUEL button that fixes it.
   */
  function onBackToMine() {
    var id = lastMineId();
    if (!id) { if (SM.adv && SM.adv.backToMap) SM.adv.backToMap(); return; }

    var aboard = advNum('getTank', 0);
    if (aboard < 1) {
      toast('TANK IS EMPTY', 'Refuel before you go back down', 2.6);
      return;
    }
    if (SM.adv && SM.adv.enterMine && SM.adv.enterMine(id, {})) return;
    toast('CANNOT DESCEND', 'Check the mining rights for this site', 2.4);
    if (SM.adv && SM.adv.backToMap) SM.adv.backToMap();
  }

  /**
   * The footer follows the loop: SELL leads, then REFUEL, then BACK TO MINE.
   * Whichever step you have not done yet is the one wearing the bright plate, so
   * the screen always has exactly one obvious next tap.
   */
  function paintResFooter() {
    var sold = !!(SM.adv && SM.adv.isSold && SM.adv.isSold());
    var r = (SM.adv && SM.adv.getResults) ? SM.adv.getResults() : null;
    var strand = !!(r && r.kind === 'stranded');
    var need = refuelUnits();
    var cost = (need > 0 && SM.mines && SM.mines.fuelCost) ? num(SM.mines.fuelCost(need), 0) : 0;

    function primary(node, on) {
      if (!node) return;
      if (on) node.classList.add('sm-btn-primary'); else node.classList.remove('sm-btn-primary');
    }

    /* A BUTTON KEEPS ITS NAME. An action that is unavailable greys out; it does
     * not rename itself to a status message. "BANKED" and "TANK FULL" made the
     * footer's labels move around under the player's thumb, and a control that
     * says something different every time you look at it is harder to learn than
     * one that is simply dim. The greying is done in style-adventure.css against
     * :disabled, so the state lives in one place. */
    if (els.resBtn) {
      els.resBtn.textContent = 'SELL THE HAUL';
      if (sold || strand) els.resBtn.setAttribute('disabled', 'disabled');
      else els.resBtn.removeAttribute('disabled');
    }
    if (els.resFuel2) {
      els.resFuel2.textContent = need > 0 ? ('REFUEL  ·  ' + money(cost)) : 'REFUEL';
      if (need > 0) els.resFuel2.removeAttribute('disabled');
      else els.resFuel2.setAttribute('disabled', 'disabled');
    }

    var canSell = !sold && !strand;
    primary(els.resBtn, canSell);
    primary(els.resFuel2, !canSell && need > 0);
    primary(els.resDive, !canSell && need <= 0);
  }

  /** Kept as the old name so existing call sites stay valid. */
  function paintSold() { paintResFooter(); }

  /* =====================================================================
   * SCREEN SWITCHING — driven by adv:state
   * ================================================================== */
  function onState(p) {
    var st = (p && p.state) || (SM.adv && SM.adv.getState ? SM.adv.getState() : 'off');
    sync(st);
  }

  function sync(st) {
    if (st === current) return;

    if (!screens[st]) {                     // 'off', 'mine', anything unknown
      current = '';
      closeAll();
      return;
    }
    current = st;
    stopCountUp();
    els.wrap.classList.add('sm-av-on');
    for (var k in screens) {
      if (!screens.hasOwnProperty(k)) continue;
      screens[k].node.classList[k === st ? 'add' : 'remove']('sm-av-screen-on');
    }
    // The ledger strip is meaningless before a company exists.
    els.wrap.classList[st === 'slots' ? 'add' : 'remove']('sm-av-noledger');
    if (SM.joystick && SM.joystick.hide) SM.joystick.hide();
    refresh();
  }

  /** Hide everything this module owns. Called when a descent begins. */
  function closeAll() {
    if (!built) return;
    current = '';
    stopCountUp();
    nameEditing = -1;
    els.wrap.classList.remove('sm-av-on');
    for (var k in screens) {
      if (screens.hasOwnProperty(k)) screens[k].node.classList.remove('sm-av-screen-on');
    }
  }

  /** Re-read the ledger and repaint whatever screen is currently up. */
  function refresh() {
    if (!built || !current) return;
    paintLedger();
    if (current === 'slots') paintSlots();
    else if (current === 'map') paintMap();
    else if (current === 'garage') paintGarage();
    else if (current === 'prep') paintPrep();
    else if (current === 'results') paintResults();
  }

  function paintLedger() {
    var rec = (SM.save && SM.save.get) ? SM.save.get() : null;
    els.ledCompany.textContent = (rec && rec.company) ? String(rec.company).toUpperCase() : 'NO COMPANY';
    els.ledDay.textContent = 'DAY ' + fmt(advNum('getDay', 1));
    els.ledCash.textContent = money(advNum('getCash', 0));
    els.ledTier.textContent = 'MK ' + roman(rigNum('getMachineTier', 1));
  }

  /* =====================================================================
   * TOAST + LIFECYCLE
   * ================================================================== */
  function toast(title, sub, seconds) {
    if (!els.toast) return;
    els.toastTitle.textContent = title || '';
    els.toastSub.textContent = sub || '';
    els.toast.classList.remove('sm-av-toast-on');
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { els.toast.classList.add('sm-av-toast-on'); });
    } else els.toast.classList.add('sm-av-toast-on');
    toastTimer = (seconds || TOAST_TIME) * 1000;
    if (els.toast.smTimer) clearTimeout(els.toast.smTimer);
    els.toast.smTimer = setTimeout(function () {
      els.toast.smTimer = 0;
      els.toast.classList.remove('sm-av-toast-on');
    }, toastTimer);
  }

  function init() {
    if (!built) build();
    if (!subscribed) {
      subscribed = true;
      SM.events.on('adv:state', onState);
      // Anything that moves the ledger repaints the screen that is showing it.
      SM.events.on('adv:cash', refresh);
      SM.events.on('adv:rig', refresh);
      SM.events.on('adv:rights', refresh);
      SM.events.on('adv:day', refresh);
      /* A LEVEL BOUGHT ANYWHERE REPAINTS EVERY SCREEN THAT COUNTS THEM.
       * The purchase can come from this screen's own BUY or from the in-mine lift
       * panel, and the map card and the prep picker both show a count — so the
       * event is what keeps them in step rather than either caller remembering to
       * ask for a repaint. */
      SM.events.on('lift:bought', refresh);
      window.addEventListener('resize', onResize, false);
      window.addEventListener('orientationchange', onResize, false);

      /* THE WATCHDOG. See "HOW IT IS DRIVEN" at the top of the file: this is
       * not a second state machine, it is a copy of adv.js's own answer, and
       * it exists so a missed transition cannot leave the player staring at a
       * blank screen with no way back to the menu. */
      if (!syncTimer) {
        syncTimer = setInterval(function () {
          if (!(SM.adv && SM.adv.isActive && SM.adv.isActive())) {
            if (current) sync('off');
            return;
          }
          var st = SM.adv.getState ? SM.adv.getState() : '';
          if (st && st !== current) sync(st);
        }, SYNC_MS);
      }
    }
  }

  function onResize() {
    if (current === 'garage') drawRig();
    else if (current === 'map') drawMapArt();
  }

  /** Any adventure screen is up. */
  function isOpen() { return !!current; }
  function getScreen() { return current; }

  return {
    init: init,
    isOpen: isOpen,
    closeAll: closeAll,
    refresh: refresh,
    toast: toast,
    /* --- additions ---------------------------------------------------- */
    getScreen: getScreen,
    /** Repaint the workshop canvas (adv.js may call it after a morph). */
    redrawRig: drawRig
  };
})();
